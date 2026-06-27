import type { Endpoint } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';
import { decryptCredential } from '../utils/erpnextCrypto';
import type { ERPNextLeadSource } from '../types';

/**
 * POST /api/erpnext-config/fetch-lead-sources
 *
 * Authenticates with an ERPNext instance and fetches the list of Lead Sources.
 * Used by admins to populate the Lead Source selector when configuring ERPNext integration.
 *
 * Accepts either:
 *   - `configId`: ID of an existing erpnext-config document (uses stored credentials)
 *   - `erpnextUrl` + `apiKey` + `apiSecret`: raw credentials for testing before saving
 *
 * On success with `configId`, updates the document with:
 *   - `availableLeadSources`: the fetched lead source list
 *   - `lastLeadSourceFetchAt`: current timestamp
 *
 * Security:
 *   - Requires authenticated admin/super-admin user
 *   - Rate limited: 10 requests per IP per minute
 *   - TLS enforcement: only HTTPS ERPNext URLs allowed
 */

const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60_000

export const fetchLeadSourcesEndpoint: Endpoint = {
    path: '/erpnext-config/fetch-lead-sources',
    method: 'post',
    handler: async (req) => {
        try {
            // ── Auth: require logged-in admin ────────────────────────────
            const user = req.user as unknown as { role?: string } | null
            if (!user || !['super-admin', 'admin'].includes(user.role || '')) {
                return Response.json(
                    { error: 'Authentication required — admin or super-admin only' },
                    { status: 401 },
                )
            }

            // ── Rate limit ─────────────────────────────────────────────
            const ip = getClientIp(req)
            const rateCheck = await checkRateLimit(
                `fetch-lead-sources:${ip}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_MS,
            )
            if (!rateCheck.allowed) {
                return Response.json(
                    { error: 'Too many requests. Try again later.' },
                    { status: 429, headers: { 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) } },
                )
            }

            // ── Parse body ─────────────────────────────────────────────
            let body: Record<string, unknown>
            try {
                body = await req.json!()
            } catch {
                return Response.json({ error: 'Invalid request body' }, { status: 400 })
            }

            const { configId, erpnextUrl: rawUrl, apiKey: rawKey, apiSecret: rawSecret } = body as {
                configId?: string | number
                erpnextUrl?: string
                apiKey?: string
                apiSecret?: string
            }

            let erpnextUrl: string
            let apiKey: string
            let apiSecret: string

            // ── Resolve credentials ────────────────────────────────────
            if (configId) {
                const config = await req.payload.findByID({
                    collection: 'erpnext-config' as 'users',
                    id: configId,
                    depth: 0,
                    overrideAccess: true,
                    context: { preventMasking: true },
                })

                const cfg = config as unknown as Record<string, unknown>
                erpnextUrl = (cfg.erpnextUrl as string) || ''
                apiKey = (cfg.apiKey as string) || ''
                apiSecret = (cfg.apiSecret as string) || ''

                apiKey = decryptCredential(apiKey)
                apiSecret = decryptCredential(apiSecret)
            } else if (rawUrl && rawKey && rawSecret) {
                erpnextUrl = rawUrl
                apiKey = rawKey
                apiSecret = rawSecret
            } else {
                return Response.json(
                    { error: 'Provide either configId or (erpnextUrl + apiKey + apiSecret)' },
                    { status: 400 },
                )
            }

            // ── TLS enforcement ────────────────────────────────────────
            const normalizedUrl = erpnextUrl.replace(/\/+$/, '')
            if (!normalizedUrl.startsWith('https://')) {
                return Response.json(
                    { error: 'Only HTTPS ERPNext URLs are allowed' },
                    { status: 400 },
                )
            }

            // ── Fetch Lead Sources from ERPNext ────────────────────────
            const leadSourcesUrl = `${normalizedUrl}/api/resource/Lead%20Source?fields=["name","source_name"]&limit_page_length=100`

            const response = await fetch(leadSourcesUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `token ${apiKey}:${apiSecret}`,
                },
                signal: AbortSignal.timeout(15000),
            })

            if (!response.ok) {
                const status = response.status
                let errorMsg = `ERPNext returned HTTP ${status}`

                if (status === 401 || status === 403) {
                    errorMsg = 'Authentication failed — check your API Key and Secret'
                }

                req.payload.logger.warn(`[fetch-lead-sources] ERPNext request failed: ${status}`)
                return Response.json({ error: errorMsg }, { status: 502 })
            }

            const result = await response.json() as { data?: ERPNextLeadSource[] }
            const leadSources = (result.data ?? []).map((ls) => ({
                name: ls.name,
                source_name: ls.source_name,
            }))

            // ── Update the config document with results ────────────────
            if (configId) {
                await req.payload.update({
                    collection: 'erpnext-config' as 'users',
                    id: configId,
                    data: {
                        availableLeadSources: leadSources,
                        lastLeadSourceFetchAt: new Date().toISOString(),
                    } as any,
                    overrideAccess: true,
                })
            }

            req.payload.logger.info(
                `[fetch-lead-sources] Fetched ${leadSources.length} lead sources from ${normalizedUrl}`,
            )

            return Response.json({
                leadSources,
                fetchedAt: new Date().toISOString(),
            })
        } catch (err) {
            req.payload.logger.error(`[fetch-lead-sources] Error: ${err}`)
            return Response.json(
                { error: err instanceof Error ? err.message : 'Failed to fetch lead sources' },
                { status: 500 },
            )
        }
    },
}
