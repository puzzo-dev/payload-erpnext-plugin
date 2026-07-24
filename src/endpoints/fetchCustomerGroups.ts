import type { Endpoint, CollectionSlug } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';
import { getUserSiteId, type UserWithRole } from '../types';
import { getCredentials, authHeaders } from './erpnextProxy';
import { validateErpUrl } from '../utils/ssrfGuard';

/**
 * GET /api/erpnext-customer-groups?siteId={siteId}
 *
 * Fetches ERPNext's "Customer Group" list (a tree doctype — see
 * frappe/apps/erpnext/erpnext/setup/doctype/customer_group/customer_group.json,
 * autoname is field:customer_group_name, so `name` IS the group's display
 * name). Used by the ERPNext Sync Rules "promote customer to group" picker
 * so an admin selects a real, currently-existing ERPNext group instead of
 * hand-typing a name that has to match exactly.
 *
 * Security: mirrors fetch-doctypes.ts — admin/super-admin only, rate limited,
 * HTTPS-only in production.
 */

const FETCH_CUSTOMER_GROUPS_RATE_LIMIT_MAX = 20
const FETCH_CUSTOMER_GROUPS_RATE_LIMIT_WINDOW_MS = 60_000

export const fetchCustomerGroupsEndpoint: Endpoint = {
    path: '/erpnext-customer-groups',
    method: 'get',
    handler: async (req) => {
        try {
            const user = req.user as UserWithRole | null
            if (!user || !['super-admin', 'admin'].includes(user.role || '')) {
                return Response.json(
                    { error: 'Authentication required — admin or super-admin only' },
                    { status: 401 },
                )
            }
            const userSiteId = getUserSiteId(user)

            const ip = getClientIp(req)
            const rateCheck = await checkRateLimit(
                `fetch-customer-groups:${ip}`,
                FETCH_CUSTOMER_GROUPS_RATE_LIMIT_MAX,
                FETCH_CUSTOMER_GROUPS_RATE_LIMIT_WINDOW_MS,
            )
            if (!rateCheck.allowed) {
                return Response.json(
                    { error: 'Too many requests. Try again later.' },
                    { status: 429, headers: { 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) } },
                )
            }

            const siteId = req.query?.siteId as string | number | undefined
            if (!siteId) {
                return Response.json({ error: 'Provide siteId' }, { status: 400 })
            }

            if (user.role !== 'super-admin' && userSiteId && String(siteId) !== String(userSiteId)) {
                return Response.json({ error: 'Not authorized to access this site' }, { status: 403 })
            }

            const sites = await req.payload.find({
                collection: 'sites' as unknown as CollectionSlug,
                where: { id: { equals: siteId } },
                limit: 1,
                depth: 0,
                overrideAccess: true,
            })
            const site = sites.docs[0] as unknown as { id: string | number; slug?: string } | undefined
            if (!site) {
                return Response.json({ error: 'Site not found' }, { status: 404 })
            }

            const creds = await getCredentials(req.payload, site.slug)
            if (!creds) {
                return Response.json({ error: 'No active ERPNext config, or credentials are missing, for this site' }, { status: 400 })
            }

            const safeUrl = await validateErpUrl(creds.url)
            if (!safeUrl) {
                return Response.json({ error: 'ERPNext URL failed security validation' }, { status: 400 })
            }

            const groupsUrl = `${safeUrl}/api/resource/Customer Group?fields=["name","is_group"]&limit_page_length=500`

            const response = await fetch(groupsUrl, {
                method: 'GET',
                headers: authHeaders(creds),
                signal: AbortSignal.timeout(15_000),
            })

            if (!response.ok) {
                const status = response.status
                let errorMsg = `ERPNext returned HTTP ${status}`
                if (status === 401 || status === 403) errorMsg = 'Authentication failed — check your ERPNext connection'
                return Response.json({ error: errorMsg }, { status: 502 })
            }

            const result = await response.json() as { data?: Array<{ name: string; is_group?: 0 | 1 }> }

            const groups = (result.data ?? [])
                .map((g) => ({ value: g.name, label: g.name }))
                .sort((a, b) => a.label.localeCompare(b.label))

            return Response.json({ connected: true, groups, fetchedAt: new Date().toISOString() })
        } catch (err) {
            req.payload.logger.error(`[fetch-customer-groups] Error: ${err}`)
            return Response.json(
                { error: err instanceof Error ? err.message : 'Failed to fetch Customer Groups' },
                { status: 500 },
            )
        }
    },
}
