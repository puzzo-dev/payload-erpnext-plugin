/**
 * Rate Limiter — In-Memory with optional Redis
 *
 * Default: in-memory Map (zero external dependencies). Suitable for
 * single-instance deployments.
 *
 * Optional: set REDIS_URL to enable Redis-backed rate limiting.
 * REQUIRED if you ever scale the CMS horizontally (multiple containers),
 * because in-memory state is not shared across processes.
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
            const pipeline = redisClient.pipeline()
            pipeline.zremrangebyscore(key, 0, now - windowMs)
            pipeline.zcard(key)
            pipeline.zadd(key, now, `${now}-${Math.random()}`)
            pipeline.pexpire(key, windowMs)

            const results = await pipeline.exec()
            const count = (results?.[1]?.[1] as number) || 0

            if (count >= maxRequests) {
                return { allowed: false, retryAfterMs: windowMs }
            }
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

/**
 * Extract client IP from a Payload request.
 *
 * Priority (proxy headers only trusted when TRUSTED_PROXY_COUNT > 0):
 *   1. x-real-ip / x-forwarded-for — ONLY behind a trusted proxy
 *   2. Underlying socket remote address (direct connection)
 *   3. Random per-request key (prevents shared bucket exhaustion)
 */
export function getClientIp(req: { headers: Headers; connection?: { remoteAddress?: string } }): string {
    // x-forwarded-for / x-real-ip are client-settable; trust them only when an
    // explicit trusted-proxy count says a proxy in front overwrites them. Otherwise
    // an attacker rotates the header to bypass rate limiting.
    const proxyCount = parseInt(process.env.TRUSTED_PROXY_COUNT ?? '0', 10)
    if (proxyCount > 0) {
        const realIp = req.headers.get('x-real-ip')
        if (realIp) return realIp

        const parts = req.headers.get('x-forwarded-for')?.split(',').map(s => s.trim()).filter(Boolean)
        if (parts && parts.length > 0) {
            const idx = parts.length - proxyCount
            const ip = parts[Math.max(0, idx)]
            if (ip) return ip
        }
    }

    // Node.js IncomingMessage exposes the underlying socket
    const socketIp = (req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress
        ?? req.connection?.remoteAddress
    if (socketIp) return socketIp

    // Last resort: random key per request to avoid all unknown clients sharing one bucket
    return `anon-${Math.random().toString(36).slice(2, 10)}`
}
