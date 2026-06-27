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

    constructor() {
        setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
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

/**
 * Extract client IP from a Payload request.
 *
 * Priority:
 *   1. x-forwarded-for (first entry, from reverse proxy)
 *   2. x-real-ip (nginx convention)
 *   3. Underlying socket remote address (direct connection)
 *   4. Random per-request key (prevents shared bucket exhaustion)
 */
export function getClientIp(req: { headers: Headers; connection?: { remoteAddress?: string } }): string {
    const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded

    const realIp = req.headers.get('x-real-ip')
    if (realIp) return realIp

    // Node.js IncomingMessage exposes the underlying socket
    const socketIp = (req as unknown as { socket?: { remoteAddress?: string } }).socket?.remoteAddress
        ?? req.connection?.remoteAddress
    if (socketIp) return socketIp

    // Last resort: random key per request to avoid all unknown clients sharing one bucket
    return `anon-${Math.random().toString(36).slice(2, 10)}`
}
