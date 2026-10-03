import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import {
    superAdminOnly,
    adminOrAbove,
    siteScopedRead,
    siteScopedCreate,
    siteScopedUpdate,
    siteScopedDelete,
    userMayAccessSite,
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

    it('lets an organization admin manage every site in their organization', async () => {
        const payload = {
            find: async () => ({ docs: [{ id: 'site-a' }, { id: 'site-b' }] }),
        }
        const owner = { role: 'admin', organization: 'org-1' }
        const req = { user: owner, headers: { get: () => null }, payload }
        assert.deepStrictEqual(await siteScopedRead()({ req } as any), { site: { in: ['site-a', 'site-b'] } })
        assert.deepStrictEqual(await siteScopedUpdate()({ req } as any), { site: { in: ['site-a', 'site-b'] } })
        assert.deepStrictEqual(await siteScopedDelete()({ req } as any), { site: { in: ['site-a', 'site-b'] } })
        assert.strictEqual(await siteScopedCreate()({ req, data: { site: 'site-b' } } as any), true)
        assert.strictEqual(await siteScopedCreate()({ req, data: { site: 'site-z' } } as any), false)
    })

    it('denies an editor who has no site', () => {
        assert.strictEqual(siteScopedRead()(makeReq({ role: 'editor' })), false)
        assert.strictEqual(siteScopedCreate()({ req: makeReq({ role: 'editor' }).req, data: { site: 'site-a' } } as any), false)
    })

    it('denies an organization admin when their sites cannot be resolved', async () => {
        const req = { user: { role: 'admin', organization: 'org-1' }, headers: { get: () => null } }
        assert.strictEqual(await siteScopedRead()({ req } as any), false)
        assert.strictEqual(await siteScopedCreate()({ req, data: { site: 'site-a' } } as any), false)
    })

    it('lets an organization admin use an endpoint only for their sites', async () => {
        const payload = {
            find: async () => ({ docs: [{ id: 'site-a' }] }),
        }
        const req = { user: { role: 'admin', organization: 'org-1' }, payload }
        assert.strictEqual(await userMayAccessSite(req, 'site-a'), true)
        assert.strictEqual(await userMayAccessSite(req, 'site-z'), false)
        assert.strictEqual(await userMayAccessSite({ user: { role: 'editor', site: 'site-a' } }, 'site-a'), true)
        assert.strictEqual(await userMayAccessSite({ user: { role: 'editor' } }, 'site-a'), false)
    })
})
