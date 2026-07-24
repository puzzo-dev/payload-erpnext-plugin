import type { Endpoint, CollectionSlug } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';
import { getUserSiteId, type UserWithRole } from '../types';
import { getCredentials, authHeaders } from './erpnextProxy';
import { validateErpUrl } from '../utils/ssrfGuard';

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
// Page size for a single ERPNext request, not a hard cap on the total list — the
// endpoint accepts `limitStart` to page through everything via repeated calls (see
// ERPNextDocTypeSelect's "Load more" button). A fixed one-shot limit_page_length with no
// pagination was the original bug: any ERPNext instance with more DocTypes than this
// constant (very common — stock ERPNext + a few installed apps easily exceeds 500) had
// doctypes silently missing from the dropdown with no way to reach them, e.g. "Item"
// landing outside whatever order ERPNext returned within the first batch.
const DOCTYPES_PAGE_SIZE = 500

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
            const limitStart = Math.max(0, Number(req.query?.limitStart) || 0)

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

            // Fetch DocTypes from ERPNext. order_by is essential once paging is involved —
            // without an explicit, stable order, ERPNext's default ordering isn't
            // guaranteed between requests, so a second page fetched via limit_start could
            // repeat or skip records relative to the first.
            const safeUrl = await validateErpUrl(creds.url)
            if (!safeUrl) {
                return Response.json({ error: 'ERPNext URL failed security validation' }, { status: 400 })
            }

            const doctypesUrl = `${safeUrl}/api/resource/DocType?fields=["name","module","istable","issingle"]&order_by=${encodeURIComponent('name asc')}&limit_page_length=${DOCTYPES_PAGE_SIZE}&limit_start=${limitStart}`

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

            const rawRecords = result.data ?? []

            const doctypes = rawRecords
                .filter((d) => d.issingle !== 1 && d.istable !== 1)
                .map((d) => ({
                    value: d.name,
                    label: d.name,
                    module: d.module,
                }))
                .sort((a, b) => a.label.localeCompare(b.label))

            // A full page of RAW records (before the istable/issingle filter, which can
            // otherwise make a full page look short) means there's likely another page
            // beyond this one. Not a precise total-count check — if the real total happens
            // to be an exact multiple of the page size, one extra "Load more" click just
            // returns an empty page and hasMore correctly flips to false — but it never
            // hides real results the way a fixed one-shot limit did.
            const hasMore = rawRecords.length === DOCTYPES_PAGE_SIZE

            return Response.json({
                connected: true,
                doctypes,
                hasMore,
                nextLimitStart: limitStart + DOCTYPES_PAGE_SIZE,
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
