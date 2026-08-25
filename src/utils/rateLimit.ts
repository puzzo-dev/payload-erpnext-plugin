/**
 * Rate Limiter — In-Memory with optional Redis
 *
 * Default: in-memory Map (zero external dependencies). Suitable for
 * single-instance deployments.
 *
 * Optional: set REDIS_URL to enable Redis-backed rate limiting.
 * REQUIRED if you ever scale the CMS horizontally (multiple containers),
 * because in-memory state is not shared across processes.
 *
 * CANONICAL SOURCE: `@ivarse/shared-cms/rate-limit` holds the authoritative
 * `getClientIp` / `UNIDENTIFIED_CLIENT_KEY`. This plugin is a separately
 * published package and cannot import from the workspace-only shared-cms,
 * so the client-IP logic is mirrored here. When the rule changes, update
 * shared-cms first, then mirror it here. The CMS's `src/utils/rateLimit.ts`
 * imports directly from shared-cms and needs no manual sync.
 */

import type { RateLimitEntry } from '../types'
import Redis from 'ioredis'

const MAX_STORE_SIZE = 50_000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

let redisClient: Redis | null = null
let redisChecked = false

function ensureRedisInProduction(): void {
    if (redisChecked) return
    redisChecked = true

    const isProduction = process.env.NODE_ENV === 'production'
    if (isProduction && !process.env.REDIS_URL) {
        console.warn(
            '[rateLimit] REDIS_URL not set in production. Falling back to in-memory rate limiting. ' +
            'This is safe for single-container deployments but will not share state across multiple instances.',
        )
    }

    if (process.env.REDIS_URL && !redisClient) {
        redisClient = new Redis(process.env.REDIS_URL)
    }
}

class InMemoryRateLimiter {
    private store = new Map<string, RateLimitEntry>()
    private cleanupInterval: ReturnType<typeof setInterval> | null = null

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
        // A library module must not keep its host process alive just to run a
        // housekeeping sweep. Without this, any process that merely touches the
        // rate limiter — including a test run — hangs instead of exiting.
        this.cleanupInterval.unref?.()
    }

    stopCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
            this.cleanupInterval = null
        }
    }

    check(
        key: string,
        maxRequests: number,
        windowMs: number,
    ): { allowed: true } | { allowed: false; retryAfterMs: number } {
        const now = Date.now()
        const entry = this.store.get(key)

        if (!entry || entry.resetAt < now) {
            this.store.set(key, { count: 1, resetAt: now + windowMs })
            return { allowed: true }
        }

        if (entry.count >= maxRequests) {
            return { allowed: false, retryAfterMs: entry.resetAt - now }
        }

        entry.count++
        return { allowed: true }
    }

    reset(key: string): void {
        this.store.delete(key)
    }

    resetAll(): void {
        this.store.clear()
    }

    private cleanup(): void {
        const now = Date.now()
        for (const [key, entry] of this.store) {
            if (entry.resetAt < now) this.store.delete(key)
        }
        if (this.store.size > MAX_STORE_SIZE) {
            const sorted = Array.from(this.store.entries()).sort((a, b) => a[1].resetAt - b[1].resetAt)
            const toDelete = sorted.slice(0, this.store.size - MAX_STORE_SIZE)
            for (const [key] of toDelete) this.store.delete(key)
        }
    }
}

const limiter = new InMemoryRateLimiter()

export async function checkRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    ensureRedisInProduction()

    if (redisClient) {
        try {
            const now = Date.now()

            // Evict expired members, then read the count — WITHOUT recording
            // this request yet.
            //
            // The previous pipeline issued the zadd unconditionally, alongside
            // the zcard, so a request that was about to be REJECTED still wrote
            // a member and still refreshed the key's TTL. A client that kept
            // retrying therefore kept pushing its own window forward and could
            // never come back under the limit, however long it waited — the
            // block became permanent rather than expiring. The in-memory
            // limiter below has never behaved that way, so the two backends
            // disagreed about what the limit means.
            const readPipeline = redisClient.pipeline()
            readPipeline.zremrangebyscore(key, 0, now - windowMs)
            readPipeline.zcard(key)
            const readResults = await readPipeline.exec()
            const count = (readResults?.[1]?.[1] as number) || 0

            if (count >= maxRequests) {
                // Retry after the OLDEST member in the window expires, which is
                // when a slot actually frees up. Reporting the full window was
                // always an over-estimate and told a well-behaved client to wait
                // far longer than necessary.
                const oldest = await redisClient.zrange(key, 0, 0, 'WITHSCORES')
                const oldestScore = oldest.length > 1 ? Number(oldest[1]) : now
                const retryAfterMs = Number.isFinite(oldestScore)
                    ? Math.max(0, oldestScore + windowMs - now)
                    : windowMs
                return { allowed: false, retryAfterMs }
            }

            // Allowed — now record it.
            const writePipeline = redisClient.pipeline()
            writePipeline.zadd(key, now, `${now}-${Math.random()}`)
            writePipeline.pexpire(key, windowMs)
            await writePipeline.exec()
            return { allowed: true }
        } catch (error) {
            console.error('[rateLimit] Redis error, falling back to memory', error)
        }
    }
    return limiter.check(key, maxRequests, windowMs)
}

/** Test-only helper to clear the in-memory rate limit store and stop its cleanup interval. */
export function __resetRateLimitStore(): void {
    limiter.resetAll()
    limiter.stopCleanup()
}

/** Key used when the client cannot be identified — see getClientIp. */
export const UNIDENTIFIED_CLIENT_KEY = 'unidentified'

/**
 * Extract a rate-limit key identifying the client of a Payload request.
 *
 * Priority (proxy headers are only trusted when TRUSTED_PROXY_COUNT > 0):
 *   1. x-forwarded-for, indexed from the right by the trusted hop count
 *   2. x-real-ip
 *   3. A single shared bucket — NEVER a per-request unique key
 *
 * x-forwarded-for is read FIRST and indexed from the RIGHT because a client can
 * prepend entries to that header but cannot remove the ones the trusted proxies
 * append. Reading x-real-ip first meant a single client-supplied header won
 * outright.
 *
 * The previous fallback chain ended in `anon-${Math.random()}`, which silently
 * disabled the rate limit on every endpoint in this plugin — including
 * /anonymous-upload, which is a public, unauthenticated file upload. Two facts
 * made that unavoidable rather than exceptional: Payload v3 builds its request as
 * `Object.assign(request, customRequest)` over a Web `Request`, so `socket` and
 * `connection` never exist on this path; and TRUSTED_PROXY_COUNT was set nowhere,
 * so the header branch never ran either. Every request therefore produced a fresh
 * random key, and a bucket keyed on a fresh random string is empty every time.
 *
 * A shared bucket for unidentifiable clients can be exhausted by one bad actor,
 * which degrades service. A unique key per request cannot be exhausted at all,
 * which removes the protection entirely. Degraded beats absent.
 *
 * This mirrors payload-cms/src/utils/rateLimit.ts, which had the identical
 * defect — the two copies must not drift apart again.
 */
export function getClientIp(req: { headers: Headers }): string {
    const proxyCount = parseInt(process.env.TRUSTED_PROXY_COUNT ?? '0', 10)
    if (Number.isFinite(proxyCount) && proxyCount > 0) {
        const parts = req.headers.get('x-forwarded-for')?.split(',').map(s => s.trim()).filter(Boolean)
        if (parts && parts.length > 0) {
            const ip = parts[Math.max(0, parts.length - proxyCount)]
            if (ip) return ip
        }

        const realIp = req.headers.get('x-real-ip')?.trim()
        if (realIp) return realIp
    }

    return UNIDENTIFIED_CLIENT_KEY
}
