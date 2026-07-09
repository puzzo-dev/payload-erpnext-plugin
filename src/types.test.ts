import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { isInternalAuth } from './types'

function makeReq(header?: string) {
    return {
        headers: {
            get(name: string) {
                if (name.toLowerCase() === 'x-internal-auth') return header ?? null
                return null
            },
        },
    }
}

describe('isInternalAuth', () => {
    before(() => {
        process.env.INTERNAL_API_SECRET = 'correct-secret'
    })

    after(() => {
        delete process.env.INTERNAL_API_SECRET
    })

    it('returns true for the exact secret', () => {
        assert.strictEqual(isInternalAuth(makeReq('correct-secret')), true)
    })

    it('returns false for a wrong secret', () => {
        assert.strictEqual(isInternalAuth(makeReq('wrong-secret')), false)
    })

    it('returns false when the header is missing', () => {
        assert.strictEqual(isInternalAuth(makeReq()), false)
    })

    it('returns false when INTERNAL_API_SECRET is not configured', () => {
        delete process.env.INTERNAL_API_SECRET
        assert.strictEqual(isInternalAuth(makeReq('anything')), false)
    })
})
