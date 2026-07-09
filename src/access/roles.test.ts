import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import {
    superAdminOnly,
    adminOrAbove,
    siteScopedRead,
    siteScopedCreate,
    siteScopedUpdate,
    siteScopedDelete,
} from './roles'

function makeReq(user?: { role: string; site?: string | number | { id: string | number } }, internalAuth = false) {
    return {
        req: {
            user: user as any,
            headers: {
                get(_name: string) {
                    return internalAuth ? 'internal-secret' : null
                },
            },
        },
    } as any
}

describe('access helpers', () => {
    before(() => {
        process.env.INTERNAL_API_SECRET = 'internal-secret'
    })

    after(() => {
        delete process.env.INTERNAL_API_SECRET
    })

    it('superAdminOnly allows only super-admins', () => {
        assert.strictEqual(superAdminOnly(makeReq({ role: 'super-admin' })), true)
        assert.strictEqual(superAdminOnly(makeReq({ role: 'admin' })), false)
        assert.strictEqual(superAdminOnly(makeReq(undefined)), false)
    })

    it('adminOrAbove allows super-admin and admin', () => {
        assert.strictEqual(adminOrAbove(makeReq({ role: 'super-admin' })), true)
        assert.strictEqual(adminOrAbove(makeReq({ role: 'admin' })), true)
        assert.strictEqual(adminOrAbove(makeReq({ role: 'editor' })), false)
    })

    it('siteScopedRead returns tenant query for scoped users', () => {
        const result = siteScopedRead()(
            makeReq({ role: 'admin', site: 'site-123' }),
        )
        assert.deepStrictEqual(result, { site: { equals: 'site-123' } })
    })

    it('siteScopedCreate allows matching site and denies foreign site', () => {
        const access = siteScopedCreate()
        assert.strictEqual(
            access({ req: makeReq({ role: 'admin', site: 'site-123' }).req, data: { site: 'site-123' } } as any),
            true,
        )
        assert.strictEqual(
            access({ req: makeReq({ role: 'admin', site: 'site-123' }).req, data: { site: 'site-456' } } as any),
            false,
        )
        assert.strictEqual(
            access({ req: makeReq({ role: 'super-admin' }).req, data: { site: 'site-456' } } as any),
            true,
        )
    })

    it('siteScopedUpdate and siteScopedDelete behave like siteScopedRead', () => {
        assert.deepStrictEqual(
            siteScopedUpdate()(makeReq({ role: 'admin', site: 'site-123' })),
            { site: { equals: 'site-123' } },
        )
        assert.deepStrictEqual(
            siteScopedDelete()(makeReq({ role: 'admin', site: 'site-123' })),
            { site: { equals: 'site-123' } },
        )
    })
})
