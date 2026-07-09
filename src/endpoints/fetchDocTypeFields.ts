import type { Endpoint, CollectionSlug } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit'
import { decryptCredential } from '../utils/erpnextCrypto'
import { getUserSiteId, type UserWithRole } from '../types'

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

            const site = sites.docs[0] as unknown as { id: string | number } | undefined
            if (!site) return Response.json({ error: 'Site not found' }, { status: 404 })

            const configs = await req.payload.find({
                collection: 'erpnext-config' as unknown as CollectionSlug,
                where: { site: { equals: site.id }, isActive: { equals: true } },
                limit: 1,
                depth: 0,
                overrideAccess: true,
                context: { preventMasking: true },
            })

            const cfg = configs.docs[0] as unknown as {
                erpnextUrl?: string
                apiKey?: string
                apiSecret?: string
            } | undefined

            if (!cfg) return Response.json({ error: 'No active ERPNext config' }, { status: 400 })

            const erpnextUrl = (cfg.erpnextUrl || '').replace(/\/+$/, '')
            if (process.env.NODE_ENV === 'production' && !erpnextUrl.startsWith('https://')) {
                return Response.json({ error: 'Only HTTPS ERPNext URLs are allowed' }, { status: 400 })
            }
            const apiKey = decryptCredential(cfg.apiKey || '')
            const apiSecret = decryptCredential(cfg.apiSecret || '')
            if (!apiKey || !apiSecret) return Response.json({ error: 'Missing credentials' }, { status: 400 })

            // Query DocField table where parent = doctype
            const encodedDoctype = encodeURIComponent(doctype)
            const fieldsUrl = `${erpnextUrl}/api/resource/DocField?filters=[["parent","=","${encodedDoctype}"]]&fields=["fieldname","label","fieldtype"]&limit_page_length=500`

            const response = await fetch(fieldsUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `token ${apiKey}:${apiSecret}`,
                },
                signal: AbortSignal.timeout(15_000),
            })

            if (!response.ok) {
                return Response.json({ error: `ERPNext returned HTTP ${response.status}` }, { status: 502 })
            }

            const result = await response.json() as {
                data?: Array<{ fieldname: string; label?: string; fieldtype?: string }>
            }

            const fields = (result.data ?? [])
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
