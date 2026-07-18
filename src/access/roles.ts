import type { Access } from 'payload'
import { getUserOrgId, getUserSiteId, isInternalAuth, UserWithRole } from '../types'

export const authenticated: Access = ({ req: { user } }) => Boolean(user)

export const superAdminOnly: Access = ({ req: { user } }) => {
    if (!user) return false
    return (user as unknown as UserWithRole).role === 'super-admin'
}

export const adminOrAbove: Access = ({ req: { user } }) => {
    if (!user) return false
    return ['super-admin', 'admin'].includes((user as unknown as UserWithRole).role)
}

export const siteScopedRead = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        const siteId = getUserSiteId(u)
        if (!siteId) return false
        return { [siteField]: { equals: siteId } }
    }
}

export const siteScopedCreate = (siteField = 'site'): Access => {
    return ({ req, data }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        if (!['admin', 'editor'].includes(u.role)) return false
        const siteId = getUserSiteId(u)
        if (!siteId) return false
        const rawDocSite =
            data && typeof (data as Record<string, unknown>)[siteField] === 'object'
                ? ((data as Record<string, unknown>)[siteField] as { id?: string | number })?.id
                : (data as Record<string, unknown>)[siteField]
        if (rawDocSite === undefined || rawDocSite === null || rawDocSite === '') return false
        return String(rawDocSite) === String(siteId)
    }
}

export const siteScopedUpdate = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        const siteId = getUserSiteId(u)
        if (!siteId) return false
        return { [siteField]: { equals: siteId } }
    }
}

export const siteScopedDelete = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = req.user as unknown as UserWithRole
        if (u.role === 'super-admin') return true
        if (u.role === 'admin') {
            const siteId = getUserSiteId(u)
            if (!siteId) return false
            return { [siteField]: { equals: siteId } }
        }
        return false
    }
}
