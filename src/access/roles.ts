import type { Access, CollectionSlug } from 'payload'
import { getUserOrgId, getUserSiteId, isInternalAuth, UserWithRole } from '../types'

/**
 * Tenant scope for this plugin. Mirrors payload-cms/src/access/roles.ts.
 *
 * An organization admin is the site owner. Users.ts clears their `site`, so
 * they are not pinned to one row — they manage every site in their
 * organization. An editor stays pinned to the one site on their account.
 * A missing site on anyone else grants nothing.
 */

export const authenticated: Access = ({ req: { user } }) => Boolean(user)

export const superAdminOnly: Access = ({ req: { user } }) => {
    if (!user) return false
    return (user as unknown as UserWithRole).role === 'super-admin'
}

export const adminOrAbove: Access = ({ req: { user } }) => {
    if (!user) return false
    return ['super-admin', 'admin'].includes((user as unknown as UserWithRole).role)
}

type SiteLookup = {
    payload?: {
        find: (args: {
            collection: CollectionSlug
            where: { organization: { equals: string | number } }
            limit: number
            pagination: boolean
            depth: number
            overrideAccess: boolean
        }) => Promise<{ docs: Array<{ id: string | number }> }>
    }
}

const orgSiteIdsCache = new WeakMap<object, Map<string, (string | number)[]>>()

async function getOrgSiteIds(req: SiteLookup, orgId: string | number): Promise<(string | number)[]> {
    let byOrg = orgSiteIdsCache.get(req)
    if (!byOrg) {
        byOrg = new Map()
        orgSiteIdsCache.set(req, byOrg)
    }
    const key = String(orgId)
    const cached = byOrg.get(key)
    if (cached) return cached
    if (!req.payload) return []
    const res = await req.payload.find({
        collection: 'sites' as CollectionSlug,
        where: { organization: { equals: orgId } },
        limit: 0,
        pagination: false,
        depth: 0,
        overrideAccess: true,
    })
    const ids = res.docs.map((doc) => doc.id)
    byOrg.set(key, ids)
    return ids
}

async function orgScopeFor(req: SiteLookup, orgId: string | number, siteField: string) {
    const siteIds = await getOrgSiteIds(req, orgId)
    if (siteIds.length === 0) return false
    return { [siteField]: { in: siteIds } }
}

function submittedSiteId(data: Record<string, unknown> | undefined, siteField: string): unknown {
    if (!data) return undefined
    const raw = data[siteField]
    if (raw && typeof raw === 'object') return (raw as { id?: string | number }).id
    return raw
}

/**
 * Whether this user may act on `siteId` from an endpoint that loads the row
 * with overrideAccess. Same rule as the collection helpers: super-admin,
 * the editor's one site, or any site in an organization admin's org.
 */
export async function userMayAccessSite(
    req: SiteLookup & { user?: unknown },
    siteId: string | number | null | undefined,
): Promise<boolean> {
    if (siteId === null || siteId === undefined || siteId === '') return false
    const u = req.user as unknown as UserWithRole | undefined
    if (!u) return false
    if (u.role === 'super-admin') return true
    const ownSite = getUserSiteId(u)
    if (ownSite != null) return String(ownSite) === String(siteId)
    if (u.role !== 'admin') return false
    const orgId = getUserOrgId(u)
    if (orgId == null) return false
    const siteIds = await getOrgSiteIds(req, orgId)
    return siteIds.some((id) => String(id) === String(siteId))
}

function ownerScope(req: { user?: unknown } & SiteLookup, siteField: string) {
    const u = req.user as unknown as UserWithRole
    const siteId = getUserSiteId(u)
    if (siteId) return { [siteField]: { equals: siteId } }
    if (u.role === 'admin') {
        const orgId = getUserOrgId(u)
        if (orgId) return orgScopeFor(req, orgId, siteField)
    }
    return false
}

export const siteScopedRead = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        return ownerScope(req, siteField)
    }
}

export const siteScopedCreate = (siteField = 'site'): Access => {
    return ({ req, data }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        if (!['admin', 'editor'].includes(u.role)) return false
        const rawDocSite = submittedSiteId(data as Record<string, unknown> | undefined, siteField)
        if (rawDocSite === undefined || rawDocSite === null || rawDocSite === '') return false
        const siteId = getUserSiteId(u)
        if (siteId) return String(rawDocSite) === String(siteId)
        if (u.role !== 'admin') return false
        const orgId = getUserOrgId(u)
        if (orgId == null) return false
        return getOrgSiteIds(req, orgId).then((ids) => ids.some((id) => String(id) === String(rawDocSite)))
    }
}

export const siteScopedUpdate = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        return ownerScope(req, siteField)
    }
}

export const siteScopedDelete = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        if (u.role === 'admin') return ownerScope(req, siteField)
        return false
    }
}

/** Site dropdown: an editor sees their site, an organization admin sees their org's sites. */
export function ownerSiteFilter(
    user: unknown,
    organizationOnForm: unknown,
): boolean | { id: { equals: string | number } } | { organization: { equals: string | number } } {
    const account = user as UserWithRole | undefined
    const formOrg = organizationOnForm && typeof organizationOnForm === 'object'
        ? (organizationOnForm as { id?: string | number }).id
        : organizationOnForm
    if (!account || account.role === 'super-admin') {
        if (typeof formOrg === 'string' || typeof formOrg === 'number') {
            return { organization: { equals: formOrg } }
        }
        return true
    }
    const ownSite = getUserSiteId(account)
    if (ownSite != null) return { id: { equals: ownSite } }
    const orgId = getUserOrgId(account)
    if (orgId == null) return false
    return { organization: { equals: orgId } }
}

/** Non-super-admins keep the organization on their account. */
export function pinnedOwnerOrganization(user: unknown, submitted: unknown): unknown {
    const account = user as UserWithRole | undefined
    if (!account || account.role === 'super-admin') return submitted
    const orgId = getUserOrgId(account)
    return orgId ?? submitted
}
