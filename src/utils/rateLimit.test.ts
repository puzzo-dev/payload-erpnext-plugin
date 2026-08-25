import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { checkRateLimit, getClientIp, __resetRateLimitStore } from './rateLimit'

function makeHeaders(init?: Record<string, string>): Headers {
    return new Headers(init)
}

describe('rateLimit', () => {
    before(() => {
        delete process.env.REDIS_URL
        __resetRateLimitStore?.()
    })

    after(() => {
        delete process.env.TRUSTED_PROXY_COUNT
    })

    it('allows requests up to the limit', async () => {
        const key = 'test:allow'
        const max = 3
        for (let i = 0; i < max; i++) {
            const result = await checkRateLimit(key, max, 60_000)
            assert.strictEqual(result.allowed, true)
        }
    })

    it('blocks requests over the limit', async () => {
        const key = 'test:block'
        const max = 2
        await checkRateLimit(key, max, 60_000)
        await checkRateLimit(key, max, 60_000)
        const over = await checkRateLimit(key, max, 60_000)
        assert.strictEqual(over.allowed, false)
        assert.ok('retryAfterMs' in over && over.retryAfterMs > 0)
    })

    it('resets the counter after the window expires', async () => {
        const key = 'test:window'
        const max = 1
        await checkRateLimit(key, max, 10)
        const blocked = await checkRateLimit(key, max, 10)
        assert.strictEqual(blocked.allowed, false)
        await new Promise((resolve) => setTimeout(resolve, 20))
        const allowed = await checkRateLimit(key, max, 10)
        assert.strictEqual(allowed.allowed, true)
    })

    it('falls back to one shared bucket when no proxy is trusted', () => {
        // This test used to assert that the socket address was used. That path
        // never actually ran: Payload v3 builds its request as
        // Object.assign(request, customRequest) over a Web Request, which has no
        // `socket` or `connection`. The real code therefore fell through to a
        // random per-request key, which silently disabled every rate limit in
        // this plugin — including the public /anonymous-upload endpoint.
        //
        // The correct behaviour is a single shared key: an unidentifiable client
        // is still subject to a limit, and a client cannot choose its own bucket.
        process.env.TRUSTED_PROXY_COUNT = '0'
        const req = { headers: makeHeaders({ 'x-forwarded-for': '1.2.3.4' }) }
        assert.strictEqual(getClientIp(req), 'unidentified')
    })

    it('never returns a unique key per request', () => {
        process.env.TRUSTED_PROXY_COUNT = '0'
        const a = getClientIp({ headers: makeHeaders() })
        const b = getClientIp({ headers: makeHeaders() })
        assert.strictEqual(a, b)
        assert.ok(!a.startsWith('anon-'), 'a random key would make every bucket empty')
    })

    it('reads x-forwarded-for from the right, so a prepended entry cannot spoof it', () => {
        process.env.TRUSTED_PROXY_COUNT = '1'
        const req = { headers: makeHeaders({ 'x-forwarded-for': '1.1.1.1, 198.51.100.9' }) }
        assert.strictEqual(getClientIp(req), '198.51.100.9')
    })

    it('extracts real-ip from trusted proxy', () => {
        process.env.TRUSTED_PROXY_COUNT = '1'
        const req = { headers: makeHeaders({ 'x-real-ip': '9.8.7.6' }), connection: { remoteAddress: '10.0.0.1' } }
        assert.strictEqual(getClientIp(req), '9.8.7.6')
    })

    it('extracts forwarded-for entry from trusted proxy chain', () => {
        process.env.TRUSTED_PROXY_COUNT = '2'
        const req = {
            headers: makeHeaders({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }),
            connection: { remoteAddress: '10.0.0.1' },
        }
        // parts.length=3, idx=3-2=1 => 2.2.2.2
        assert.strictEqual(getClientIp(req), '2.2.2.2')
    })
})
