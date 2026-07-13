import type { Endpoint, CollectionSlug } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';
import { getUserSiteId, type UserWithRole, type ERPNextCompany } from '../types';
import { getCredentials, authHeaders } from './erpnextProxy';
import type { ERPNextCredentials } from '../types';

/**
 * POST /api/erpnext-config/fetch-companies
 *
 * Authenticates with an ERPNext instance and fetches the list of companies.
 * Used by admins to populate the company selector when configuring ERPNext integration.
 *
 * Accepts either:
 *   - `configId`: ID of an existing erpnext-config document (uses stored credentials)
 *   - `erpnextUrl` + `apiKey` + `apiSecret`: raw credentials for testing before saving
 *
 * On success with `configId`, updates the document with:
 *   - `availableCompanies`: the fetched company list
 *   - `lastCompanyFetchAt`: current timestamp
 *   - `connectionStatus`: 'connected' or 'disconnected'
 *
 * Security:
 *   - Requires authenticated admin/super-admin user
 *   - Rate limited: 10 requests per IP per minute
 *   - TLS enforcement: only HTTPS ERPNext URLs allowed
 */

const FETCH_COMPANIES_RATE_LIMIT_MAX = 10
const FETCH_COMPANIES_RATE_LIMIT_WINDOW_MS = 60_000

export const fetchCompaniesEndpoint: Endpoint = {
    path: '/erpnext-config/fetch-companies',
    method: 'post',
    handler: async (req) => {
        try {
            // ── Auth: require logged-in admin ────────────────────────────
            const user = req.user as unknown as UserWithRole | null
            const userRole = user?.role ?? ''
            const isSuperAdmin = userRole === 'super-admin'
            const isAdmin = isSuperAdmin || userRole === 'admin'
            if (!user || !isAdmin) {
                return Response.json(
                    { error: 'Authentication required — admin or super-admin only' },
                    { status: 401 },
                )
            }

            // ── Rate limit ─────────────────────────────────────────────
            const ip = getClientIp(req)
            const rateCheck = await checkRateLimit(
                `fetch-companies:${ip}`,
                FETCH_COMPANIES_RATE_LIMIT_MAX,
                FETCH_COMPANIES_RATE_LIMIT_WINDOW_MS,
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

            let creds: ERPNextCredentials | null

            // ── Resolve credentials ────────────────────────────────────
            if (configId) {
                // Fetch from existing config document
                const config = await req.payload.findByID({
                    collection: 'erpnext-config' as unknown as CollectionSlug,
                    id: configId,
                    depth: 0,
                    overrideAccess: true,
                    context: { preventMasking: true },
                })

                const cfg = config as unknown as Record<string, unknown>

                // Enforce tenant scoping for non-super-admins.
                const cfgSite = cfg.site as string | number | { id?: string | number } | null | undefined
                const cfgSiteId = cfgSite && typeof cfgSite === 'object' ? cfgSite.id : cfgSite
                if (!isSuperAdmin) {
                    const userSiteId = getUserSiteId(user)
                    if (!userSiteId || String(cfgSiteId) !== String(userSiteId)) {
                        return Response.json(
                            { error: 'You can only fetch companies for your assigned site' },
                            { status: 403 },
                        )
                    }
                }

                // getCredentials() correctly branches between api_key and
                // oauth authMethod (and transparently refreshes an expired
                // OAuth token) — the previous direct apiKey/apiSecret read
                // here predated OAuth support and hardcoded the api_key
                // path, so this endpoint always failed for an OAuth-connected
                // site's config, marking it "disconnected" even when healthy.
                const siteDoc = cfgSiteId
                    ? await req.payload.findByID({
                        collection: 'sites' as unknown as CollectionSlug,
                        id: cfgSiteId,
                        depth: 0,
                        overrideAccess: true,
                    }).catch(() => null)
                    : null
                const siteSlug = (siteDoc as unknown as { slug?: string } | null)?.slug
                creds = siteSlug ? await getCredentials(req.payload, siteSlug) : null
            } else if (rawUrl && rawKey && rawSecret) {
                // Raw credentials are a testing convenience; restrict to super-admins
                // so a site admin cannot probe arbitrary ERPNext instances.
                if (!isSuperAdmin) {
                    return Response.json(
                        { error: 'Raw ERPNext credentials can only be used by super-admins' },
                        { status: 403 },
                    )
                }
                creds = { url: rawUrl.replace(/\/+$/, ''), apiKey: rawKey, apiSecret: rawSecret, authMethod: 'api_key' }
            } else {
                return Response.json(
                    { error: 'Provide either configId or (erpnextUrl + apiKey + apiSecret)' },
                    { status: 400 },
                )
            }

            if (!creds) {
                return Response.json({ error: 'No active ERPNext config, or credentials are missing, for this site' }, { status: 400 })
            }

            // ── TLS enforcement ────────────────────────────────────────
            const normalizedUrl = creds.url
            if (process.env.NODE_ENV === 'production' && !normalizedUrl.startsWith('https://')) {
                return Response.json(
                    { error: 'Only HTTPS ERPNext URLs are allowed' },
                    { status: 400 },
                )
            }

            // ── Fetch companies from ERPNext ───────────────────────────
            const companiesUrl = `${normalizedUrl}/api/resource/Company?fields=["name","company_name","country","default_currency"]&limit_page_length=100`

            const response = await fetch(companiesUrl, {
                method: 'GET',
                headers: authHeaders(creds),
                signal: AbortSignal.timeout(15000),
            })

            if (!response.ok) {
                const status = response.status
                let errorMsg = `ERPNext returned HTTP ${status}`

                if (status === 401 || status === 403) {
                    errorMsg = 'Authentication failed — check your API Key and Secret'
                }

                // Update config status to disconnected if we have a configId
                if (configId) {
                    await updateConfigStatus(req.payload, configId, 'disconnected')
                }

                req.payload.logger.warn(`[fetch-companies] ERPNext auth failed: ${status}`)
                return Response.json({ error: errorMsg, connected: false }, { status: 502 })
            }

            const result = await response.json() as { data?: ERPNextCompany[] }
            const companies = (result.data ?? []).map((c) => ({
                name: c.name,
                company_name: c.company_name,
                country: c.country || undefined,
                default_currency: c.default_currency || undefined,
            }))

            // ── Update the config document with results ────────────────
            if (configId) {
                await req.payload.update({
                    collection: 'erpnext-config' as unknown as CollectionSlug,
                    id: configId,
                    data: {
                        availableCompanies: companies,
                        lastCompanyFetchAt: new Date().toISOString(),
                        connectionStatus: 'connected',
                    } as any,
                    overrideAccess: true,
                })
            }

            req.payload.logger.info(
                `[fetch-companies] Fetched ${companies.length} companies from ${normalizedUrl}`,
            )

            return Response.json({
                connected: true,
                companies,
                fetchedAt: new Date().toISOString(),
            })
        } catch (err) {
            req.payload.logger.error(`[fetch-companies] Error: ${err}`)
            return Response.json(
                { error: err instanceof Error ? err.message : 'Failed to fetch companies' },
                { status: 500 },
            )
        }
    },
}

// ── Helper ─────────────────────────────────────────────────────────────

async function updateConfigStatus(
    payload: Parameters<Endpoint['handler']>[0]['payload'],
    configId: string | number,
    status: 'connected' | 'disconnected' | 'untested',
): Promise<void> {
    try {
        await payload.update({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            id: configId,
            data: { connectionStatus: status } as any,
            overrideAccess: true,
        })
    } catch {
        // Non-critical — don't fail the main operation
    }
}
