import type { Endpoint, CollectionSlug } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit'
import { getUserSiteId, type UserWithRole } from '../types'
import { getCredentials, authHeaders } from './erpnextProxy'

const FETCH_FIELDS_RATE_LIMIT_MAX = 30
const FETCH_FIELDS_RATE_LIMIT_WINDOW_MS = 60_000

export const fetchDocTypeFieldsEndpoint: Endpoint = {
    path: '/erpnext-doctype-fields',
    method: 'get',
    handler: async (req) => {
        try {
            const user = req.user as UserWithRole | null
            if (!user || !['super-admin', 'admin'].includes(user.role || '')) {
                return Response.json(
                    { error: 'Authentication required' },
                    { status: 401 },
                )
            }
            const userSiteId = getUserSiteId(user)

            const ip = getClientIp(req)
            const rateCheck = await checkRateLimit(
                `fetch-doctype-fields:${ip}`,
                FETCH_FIELDS_RATE_LIMIT_MAX,
                FETCH_FIELDS_RATE_LIMIT_WINDOW_MS,
            )
            if (!rateCheck.allowed) {
                return Response.json(
                    { error: 'Too many requests' },
                    { status: 429, headers: { 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) } },
                )
            }

            const siteId = req.query?.siteId as string | number | undefined
            const doctype = req.query?.doctype as string | undefined

            if (!siteId || !doctype) {
                return Response.json({ error: 'Provide siteId and doctype' }, { status: 400 })
            }

            if (user.role !== 'super-admin' && userSiteId && String(siteId) !== String(userSiteId)) {
                return Response.json({ error: 'Not authorized to access this site' }, { status: 403 })
            }

            const sites = await req.payload.find({
                collection: 'sites' as unknown as CollectionSlug,
                where: { id: { equals: siteId } } as any,
                limit: 1,
                depth: 0,
                overrideAccess: true,
            })

            const site = sites.docs[0] as unknown as { id: string | number; slug?: string } | undefined
            if (!site) return Response.json({ error: 'Site not found' }, { status: 404 })

            // getCredentials() correctly branches between api_key and oauth
            // authMethod (and transparently refreshes an expired OAuth
            // token) — see the identical fix in fetchDocTypes.ts.
            const creds = await getCredentials(req.payload, site.slug)
            if (!creds) return Response.json({ error: 'No active ERPNext config, or credentials are missing' }, { status: 400 })

            // Fetch the DocType document itself rather than querying DocField directly.
            // DocField is a child-table doctype (istable: 1) of DocType's own "fields"
            // table field — Frappe's REST API generally denies direct list access to
            // child-table doctypes for anything but System Manager-equivalent roles
            // (a bare `/api/resource/DocField?filters=...` 403s/500s for typical
            // Integration/API-key roles), which is what was producing the 502 here.
            // Fetching the parent DocType document sidesteps that: its `fields` array
            // is returned as part of the document itself, no separate DocField
            // permission needed.
            const encodedDoctype = encodeURIComponent(doctype)
            const fieldsUrl = `${creds.url}/api/resource/DocType/${encodedDoctype}`

            const response = await fetch(fieldsUrl, {
                method: 'GET',
                headers: authHeaders(creds),
                signal: AbortSignal.timeout(15_000),
            })

            if (!response.ok) {
                const body = await response.text().catch(() => '')
                req.payload.logger.error(
                    `[fetch-doctype-fields] ERPNext returned HTTP ${response.status} for DocType "${doctype}": ${body.slice(0, 500)}`,
                )
                return Response.json({ error: `ERPNext returned HTTP ${response.status}` }, { status: 502 })
            }

            const result = await response.json() as {
                data?: { fields?: Array<{ fieldname: string; label?: string; fieldtype?: string }> }
            }

            const fields = (result.data?.fields ?? [])
                .filter(f => f.fieldname && f.fieldtype !== 'Section Break' && f.fieldtype !== 'Column Break')
                .map((f) => ({
                    value: f.fieldname,
                    label: f.label || f.fieldname,
                    type: f.fieldtype,
                }))
                .sort((a, b) => a.label.localeCompare(b.label))

            return Response.json({ fields })
        } catch (err) {
            req.payload.logger.error(`[fetch-doctype-fields] Error: ${err}`)
            return Response.json(
                { error: err instanceof Error ? err.message : 'Failed to fetch fields' },
                { status: 500 },
            )
        }
    },
}
