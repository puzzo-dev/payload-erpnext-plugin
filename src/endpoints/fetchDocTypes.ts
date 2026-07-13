import type { Endpoint, CollectionSlug } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';
import { getUserSiteId, type UserWithRole } from '../types';
import { getCredentials, authHeaders } from './erpnextProxy';

/**
 * GET /api/erpnext-doctypes?siteId={siteId}&siteSlug={siteSlug}
 *
 * Fetches the list of DocTypes from the ERPNext instance connected to a site.
 * Used by the ERPNext Form Workflow builder to ensure only valid DocTypes are
 * selected for each workflow request.
 *
 * Security:
 *   - Requires authenticated admin/super-admin user
 *   - Rate limited: 20 requests per IP per minute
 *   - TLS enforcement: only HTTPS ERPNext URLs allowed
 */

const FETCH_DOCTYPES_RATE_LIMIT_MAX = 20
const FETCH_DOCTYPES_RATE_LIMIT_WINDOW_MS = 60_000

export const fetchDocTypesEndpoint: Endpoint = {
    path: '/erpnext-doctypes',
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
                `fetch-doctypes:${ip}`,
                FETCH_DOCTYPES_RATE_LIMIT_MAX,
                FETCH_DOCTYPES_RATE_LIMIT_WINDOW_MS,
            )
            if (!rateCheck.allowed) {
                return Response.json(
                    { error: 'Too many requests. Try again later.' },
                    { status: 429, headers: { 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) } },
                )
            }

            const siteId = req.query?.siteId as string | number | undefined
            const siteSlug = req.query?.siteSlug as string | undefined

            if (!siteId && !siteSlug) {
                return Response.json({ error: 'Provide siteId or siteSlug' }, { status: 400 })
            }

            if (user.role !== 'super-admin' && userSiteId) {
                if (siteSlug) {
                    return Response.json(
                        { error: 'Scoped admins must use siteId, not siteSlug' },
                        { status: 403 },
                    )
                }
                if (siteId && String(siteId) !== String(userSiteId)) {
                    return Response.json({ error: 'Not authorized to access this site' }, { status: 403 })
                }
            }

            const sites = await req.payload.find({
                collection: 'sites' as unknown as CollectionSlug,
                where: siteId ? { id: { equals: siteId } } : { slug: { equals: siteSlug } } as any,
                limit: 1,
                depth: 0,
                overrideAccess: true,
            })

            const site = sites.docs[0] as unknown as { id: string | number; slug?: string } | undefined
            if (!site) {
                return Response.json({ error: 'Site not found' }, { status: 404 })
            }

            // getCredentials() correctly branches between api_key and oauth
            // authMethod (and transparently refreshes an expired OAuth
            // token) — the previous direct apiKey/apiSecret read here
            // predated OAuth support and hardcoded the api_key path, so
            // this endpoint (the DocType picker used throughout the
            // sync-rules admin UI) always 400'd for any OAuth-connected site.
            const creds = await getCredentials(req.payload, site.slug)
            if (!creds) {
                return Response.json({ error: 'No active ERPNext config, or credentials are missing, for this site' }, { status: 400 })
            }

            // Fetch DocTypes from ERPNext
            const doctypesUrl = `${creds.url}/api/resource/DocType?fields=["name","module","istable","issingle"]&limit_page_length=500`

            const response = await fetch(doctypesUrl, {
                method: 'GET',
                headers: authHeaders(creds),
                signal: AbortSignal.timeout(15_000),
            })

            if (!response.ok) {
                const status = response.status
                let errorMsg = `ERPNext returned HTTP ${status}`
                if (status === 401 || status === 403) errorMsg = 'Authentication failed — check your API Key and Secret'
                return Response.json({ error: errorMsg }, { status: 502 })
            }

            const result = await response.json() as {
                data?: Array<{ name: string; module?: string; istable?: 0 | 1; issingle?: 0 | 1 }>
            }

            const doctypes = (result.data ?? [])
                .filter((d) => d.issingle !== 1 && d.istable !== 1)
                .map((d) => ({
                    value: d.name,
                    label: d.name,
                    module: d.module,
                }))
                .sort((a, b) => a.label.localeCompare(b.label))

            return Response.json({
                connected: true,
                doctypes,
                fetchedAt: new Date().toISOString(),
            })
        } catch (err) {
            req.payload.logger.error(`[fetch-doctypes] Error: ${err}`)
            return Response.json(
                { error: err instanceof Error ? err.message : 'Failed to fetch DocTypes' },
                { status: 500 },
            )
        }
    },
}
