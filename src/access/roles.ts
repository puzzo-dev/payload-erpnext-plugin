import type { Access } from 'payload'
import { getUserOrgId, getUserSiteId, isInternalAuth, UserWithRole } from '../types'

export const anyone: Access = () => true

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

export const siteScopedCreate: Access = ({ req }) => {
    if (isInternalAuth(req)) return true
    if (!req.user) return false
    const role = (req.user as unknown as UserWithRole).role
    return ['super-admin', 'admin', 'editor'].includes(role)
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
