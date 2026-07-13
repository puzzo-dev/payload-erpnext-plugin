import type { Endpoint, PayloadRequest, CollectionSlug } from 'payload'
import { timingSafeEqual } from 'node:crypto'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';
import type { ERPNextCredentials } from '../types';
import { decryptCredential } from '../utils/erpnextCrypto';
import { refreshOAuthToken } from './erpnextOAuth';

/**
 * ERPNext Proxy Endpoints
 *
 * Proxies frontend form submissions to ERPNext API.
 * Credentials are resolved from the per-site erpnext-config collection.
 * This prevents exposing API keys to the browser.
 *
 * Security:
 *   - Rate limited: 30 requests per IP per minute
 *   - Origin validation: rejects requests without valid internal origin
 *   - Doctype whitelisting: only predefined doctypes can be accessed
 *
 * Endpoints:
 *   POST /api/erpnext-proxy/submit       — Create a doc in ERPNext
 *   GET  /api/erpnext-proxy/resource     — Fetch a doc from ERPNext
 *   GET  /api/erpnext-proxy/health       — Check ERPNext connectivity
 */

// ── Doctype whitelists for security ─────────────────────────────────────

const ALLOWED_SUBMIT_DOCTYPES = [
    'Lead', 'Job Applicant', 'Ticket', 'HD Ticket', 'Issue',
    'Blog Comment', 'Contact', 'Event', 'Email Group Member',
]

const ALLOWED_READ_DOCTYPES = [
    ...ALLOWED_SUBMIT_DOCTYPES,
    'Blog Category', 'Job Opening', 'Ticket Type', 'HD Ticket Type', 'User', 'Newsletter',
    'Company', 'Customer',
]

const PUBLIC_READ_DOCTYPES = [
    'Job Opening', 'Blog Category', 'Ticket Type', 'HD Ticket Type',
]

// ── Helpers ─────────────────────────────────────────────────────────────



/** Doctypes that support the `company` field in ERPNext */
const COMPANY_AWARE_DOCTYPES = new Set([
    'Lead', 'Contact', 'Customer', 'Job Applicant', 'Job Opening',
    'Ticket', 'HD Ticket', 'Issue',
])

/**
 * In-flight OAuth-refresh de-duplication, keyed by configId. Every proxy/sync
 * request calls getCredentials() independently, with no shared state — if two
 * requests for the same site arrive at (or after) token expiry, each would
 * otherwise call refreshOAuthToken() with the SAME stored refresh_token. If
 * Frappe rotates refresh tokens on use (standard OAuth2 practice), the loser
 * of that race gets an invalid refresh token and the DB write ordering could
 * leave a corrupted/stale token persisted, requiring a full manual reconnect.
 * Concurrent callers now await the one in-flight refresh instead of each
 * issuing their own.
 */
const inFlightRefreshes = new Map<string, Promise<{ accessToken: string; expiresAt: string } | null>>()

/** Best-effort — a failure here must never block the caller from getting its (null) credentials result. */
async function markDisconnected(
    payload: Parameters<Endpoint['handler']>[0]['payload'],
    configId: string | number,
): Promise<void> {
    try {
        await payload.update({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            id: configId,
            data: { connectionStatus: 'disconnected' } as any,
            overrideAccess: true,
            context: { skipAutoFetch: true },
        })
    } catch (err) {
        payload.logger.warn(`[ERPNext-Proxy] Failed to mark config ${configId} disconnected: ${err}`)
    }
}

/**
 * Resolve ERPNext credentials from the erpnext-config collection.
 * Looks up by site slug or site ID. Falls back to env vars for backward compatibility.
 */
export async function getCredentials(
    payload: Parameters<Endpoint['handler']>[0]['payload'],
    siteSlug?: string | null,
    req?: PayloadRequest,
): Promise<ERPNextCredentials | null> {
    const findConfig = async (where: Parameters<typeof payload.find>[0]['where']) => {
        return payload.find({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            where,
            limit: 1,
            depth: 0,
            overrideAccess: true,
            context: { preventMasking: true },
        })
    }

    const isMasked = (v: string) => v.includes('\u2022')

    const validateUrl = (url: string): boolean => {
        try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
            if (parsed.protocol === 'http:' && process.env.NODE_ENV === 'production') {
                payload.logger.error('[ERPNext-Proxy] Refusing to use non-HTTPS ERPNext URL in production')
                return false
            }
            return true
        } catch {
            return false
        }
    }

    /**
     * Build API-key credentials from a config document (authMethod: 'api_key', the default).
     * If masking leaked through (Payload bug), we log and fail closed instead of
     * falling back to raw SQL — raw SQL bypasses access control and breaks on schema changes.
     */
    const buildApiKeyCreds = (
        cfg: Record<string, unknown>,
    ): ERPNextCredentials | null => {
        const url = (cfg.erpnextUrl as string)?.replace(/\/+$/, '')
        const rawKey = cfg.apiKey as string
        const rawSecret = cfg.apiSecret as string
        const company = (cfg.erpnextCompany as string) || undefined
        const autoInjectCompany = cfg.autoInjectCompany !== false

        if (!url || !rawKey || !rawSecret) return null
        if (!validateUrl(url)) return null
        if (isMasked(rawKey) || isMasked(rawSecret)) {
            // The user-stripping approach should prevent this, but if masking still
            // leaks through for any reason, fail closed rather than using masked creds.
            payload.logger.error(
                `[ERPNext-Proxy] Credential masking leaked through for config ${cfg.id}. ` +
                `This indicates a Payload framework bug. Failing closed — do NOT fall back to raw SQL.`,
            )
            return null
        }
        // Safety net: if the value came back still encrypted (enc: prefix), decrypt it here.
        // This can happen if decryptAfterRead was bypassed entirely.
        const apiKey = rawKey.startsWith('enc:') ? decryptCredential(rawKey) : rawKey
        const apiSecret = rawSecret.startsWith('enc:') ? decryptCredential(rawSecret) : rawSecret
        if (!apiKey || !apiSecret || isMasked(apiKey) || isMasked(apiSecret)) return null
        return { url, apiKey, apiSecret, authMethod: 'api_key', company, autoInjectCompany }
    }

    /**
     * Build OAuth credentials from a config document (authMethod: 'oauth', set by the
     * ERPNext OAuth2 Connect flow — see endpoints/erpnextOAuth.ts). Transparently
     * refreshes the access token via the stored refresh token if it has expired,
     * so callers never need to know the token was stale.
     */
    const buildOAuthCreds = async (
        cfg: Record<string, unknown>,
    ): Promise<ERPNextCredentials | null> => {
        const url = (cfg.erpnextUrl as string)?.replace(/\/+$/, '')
        const company = (cfg.erpnextCompany as string) || undefined
        const autoInjectCompany = cfg.autoInjectCompany !== false
        if (!url || !validateUrl(url)) return null

        const rawToken = cfg.oauthAccessToken as string | undefined
        const expiresAt = cfg.oauthExpiresAt as string | undefined
        if (!rawToken) return null
        if (isMasked(rawToken)) {
            payload.logger.error(`[ERPNext-Proxy] OAuth token masking leaked through for config ${cfg.id}. Failing closed.`)
            return null
        }
        let accessToken = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken

        const isExpired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false
        if (isExpired) {
            const rawRefreshToken = cfg.oauthRefreshToken as string | undefined
            const rawClientId = cfg.oauthClientId as string | undefined
            const rawClientSecret = cfg.oauthClientSecret as string | undefined
            const clientSecret = rawClientSecret?.startsWith('enc:') ? decryptCredential(rawClientSecret) : rawClientSecret
            const refreshToken = rawRefreshToken?.startsWith('enc:') ? decryptCredential(rawRefreshToken) : rawRefreshToken
            const configKey = String(cfg.id)

            if (!refreshToken || !rawClientId || !clientSecret) {
                payload.logger.warn(`[ERPNext-Proxy] OAuth token expired for config ${cfg.id} and no refresh token/client credentials available`)
                await markDisconnected(payload, cfg.id as string | number)
                return null
            }

            // Serialize concurrent refresh attempts for the same config —
            // see inFlightRefreshes' comment above.
            let refreshPromise = inFlightRefreshes.get(configKey)
            if (!refreshPromise) {
                refreshPromise = refreshOAuthToken(payload, cfg.id as string | number, url, rawClientId, clientSecret, refreshToken)
                    .finally(() => inFlightRefreshes.delete(configKey))
                inFlightRefreshes.set(configKey, refreshPromise)
            }
            const refreshed = await refreshPromise
            if (!refreshed) {
                // Previously nothing ever marked a dead OAuth connection as
                // disconnected — autoFetchFromERPNext (the only other code
                // that re-tests connectionStatus) explicitly skips re-testing
                // once already connected, so the admin UI showed "Connected"
                // indefinitely after the real token had died.
                await markDisconnected(payload, cfg.id as string | number)
                return null
            }
            accessToken = refreshed.accessToken
        }

        if (!accessToken || isMasked(accessToken)) return null
        return { url, oauthAccessToken: accessToken, authMethod: 'oauth', company, autoInjectCompany }
    }

    // Try collection-based config first.
    // Each site/tenant has its own ERPNext instance; we NEVER fall back to
    // another site's config because that would leak data across tenants.
    if (siteSlug) {
        const sites = await payload.find({
            collection: 'sites',
            where: { slug: { equals: siteSlug } },
            limit: 1,
            depth: 0,
            overrideAccess: true,
        })

        if (sites.totalDocs > 0) {
            const siteId = sites.docs[0].id
            const configs = await findConfig({
                site: { equals: siteId },
                isActive: { equals: true },
            })

            if (configs.totalDocs > 0) {
                const cfg = configs.docs[0] as unknown as Record<string, unknown>
                const creds = cfg.authMethod === 'oauth'
                    ? await buildOAuthCreds(cfg)
                    : buildApiKeyCreds(cfg)
                if (creds) return creds
            }
        }
    }

    return null
}

export function authHeaders(creds: ERPNextCredentials) {
    return {
        'Content-Type': 'application/json',
        Authorization: creds.authMethod === 'oauth'
            ? `Bearer ${creds.oauthAccessToken}`
            : `token ${creds.apiKey}:${creds.apiSecret}`,
    }
}

async function parseERPNextError(response: Response): Promise<string> {
    let msg = `ERPNext API error: ${response.status}`
    try {
        const data = await response.json() as Record<string, unknown>
        if (data.exception) msg = String(data.exception)
        else if (data._server_messages) {
            const messages = JSON.parse(String(data._server_messages))
            if (messages.length > 0) {
                const parsed = JSON.parse(messages[0])
                msg = parsed.message || msg
            }
        } else if (data.message) msg = String(data.message)
    } catch { /* keep default */ }
    return msg
}

// ── Rate limiting & origin validation ──────────────────────────────────

const ERPNEXT_RATE_LIMIT_MAX = 30
const ERPNEXT_RATE_LIMIT_WINDOW_MS = 60_000

// The Origin/Referer used by validateProxyAccess is client-settable, so a non-browser
// caller can spoof a trusted origin and reach the "public" tier to spam ERPNext
// (Lead/Contact/Ticket/Email Group Member) using the business's own credentials.
// Two defences below, applied only to public-tier WRITES (submit/upload):
//   1. A much stricter per-IP rate limit than the read tier (always on).
//   2. Optional reCAPTCHA enforcement (ERPNEXT_PROXY_REQUIRE_CAPTCHA=true) — verified
//      against the site's own secret. Kept opt-in so existing public forms that do
//      not yet send a token are not broken until the frontend is updated.
const PUBLIC_WRITE_RATE_LIMIT_MAX = 5
const PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS = 60_000

/** Verify a reCAPTCHA token against the given site's configured secret. */
async function verifyProxyCaptcha(req: PayloadRequest, siteSlug: string | null | undefined, token: string | null | undefined): Promise<boolean> {
    if (!siteSlug) return false
    try {
        const sites = await req.payload.find({
            collection: 'sites',
            where: { slug: { equals: siteSlug } },
            limit: 1,
            depth: 0,
            overrideAccess: true,
        })
        const site = sites.docs[0] as unknown as { recaptcha?: { enabled?: boolean; secretKey?: string } } | undefined
        const recaptcha = site?.recaptcha
        // If the site has no reCAPTCHA configured, there is nothing to verify against
        // — treat as not-verifiable (caller decides whether that blocks the request).
        if (!recaptcha?.enabled || !recaptcha.secretKey) return false
        if (!token) return false
        const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret: recaptcha.secretKey, response: token }).toString(),
            signal: AbortSignal.timeout(8000),
        })
        const data = await resp.json() as { success?: boolean; score?: number }
        return data.success === true && (data.score === undefined || data.score >= 0.5)
    } catch (err) {
        req.payload.logger.warn(`[ERPNext-Proxy] captcha verification error: ${err}`)
        return false
    }
}

/**
 * Extra guards for public-tier writes: a strict rate limit and (optionally) a
 * verified reCAPTCHA token. Returns an error Response to short-circuit, or null.
 */
async function enforcePublicWriteGuards(
    req: PayloadRequest,
    accessLevel: 'internal' | 'admin' | 'public',
    siteSlug: string | null | undefined,
    token: string | null | undefined,
): Promise<Response | null> {
    if (accessLevel !== 'public') return null

    const ip = getClientIp(req)
    const strict = await checkRateLimit(`erpnext-proxy-write:${ip}`, PUBLIC_WRITE_RATE_LIMIT_MAX, PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS)
    if (!strict.allowed) {
        return Response.json(
            { error: 'Too many submissions, please try again later' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(strict.retryAfterMs! / 1000)) } },
        )
    }

    if (process.env.ERPNEXT_PROXY_REQUIRE_CAPTCHA === 'true') {
        if (!(await verifyProxyCaptcha(req, siteSlug, token))) {
            return Response.json({ error: 'Captcha verification required' }, { status: 403 })
        }
    }
    return null
}

/** Normalize an origin to `protocol://hostname:port`, omitting default ports. Returns null for invalid input. */
function normalizeOrigin(origin: string): string | null {
    try {
        const u = new URL(origin)
        const defaultPort = u.protocol === 'http:' ? '80' : u.protocol === 'https:' ? '443' : undefined
        const port = u.port && u.port !== defaultPort ? `:${u.port}` : ''
        return `${u.protocol}//${u.hostname}${port}`
    } catch {
        return null
    }
}

/**
 * Validate that the request originates from an internal service or trusted
 * frontend. Checks X-Internal-Key header (for server-to-server) or
 * Referer/Origin against known CMS host and trusted origins.
 *
 * Security model:
 *   1. X-Internal-Key header match → allowed (server-to-server)
 *   2. No origin + no cookies → allowed (server-side SSR fetch)
 *   2b. No origin + cookies + authenticated admin → allowed (direct browser navigation)
 *   3. Origin exactly matches CMS host or TRUSTED_ORIGINS → allowed
 *   4. Everything else → denied
 */
async function validateProxyAccess(req: PayloadRequest): Promise<{ error?: Response, accessLevel: 'internal' | 'admin' | 'public' }> {
    // 1. Server-to-server: check internal API key (constant-time)
    const internalKey = process.env.ERPNEXT_PROXY_KEY
    if (internalKey) {
        const provided = req.headers.get('x-internal-key') || ''
        if (provided.length === internalKey.length) {
            const a = Buffer.from(provided)
            const b = Buffer.from(internalKey)
            try {
                if (timingSafeEqual(a, b)) return { accessLevel: 'internal' } // Allowed
            } catch {
                /* lengths differ or other error — fall through to deny */
            }
        }
    }

    const origin = req.headers.get('origin') || req.headers.get('referer') || ''

    // 2. Direct browser navigation with cookies: allow if the user has a valid
    // Payload admin session (req.user is populated by Payload middleware).
    if (!origin && req.user) return { accessLevel: 'admin' } // Authenticated admin — allowed

    // 3. Browser with origin: validate against CMS host + trusted origins
    if (origin) {
        const trustedOrigins = new Set<string>()

        // In development, local origins are acceptable for testing.
        if (process.env.NODE_ENV !== 'production') {
            trustedOrigins.add('http://localhost')
            trustedOrigins.add('https://localhost')
            trustedOrigins.add('http://127.0.0.1')
            trustedOrigins.add('https://127.0.0.1')
        }

        // CMS's own origin (protocol + host + port)
        const cmsHost = process.env.PAYLOAD_PUBLIC_SERVER_URL || process.env.NEXT_PUBLIC_PAYLOAD_URL || ''
        if (cmsHost) {
            const normalized = normalizeOrigin(cmsHost)
            if (normalized) trustedOrigins.add(normalized)
        }

        // Additional trusted origins from env (comma-separated full URLs)
        const extra = process.env.TRUSTED_ORIGINS || process.env.CORS_ORIGINS || ''
        if (extra) {
            for (const o of extra.split(',')) {
                const normalized = normalizeOrigin(o.trim())
                if (normalized) trustedOrigins.add(normalized)
            }
        }

        // DB trusted origins from Sites collection
        try {
            const sites = await req.payload.find({
                collection: 'sites',
                limit: 100,
                depth: 0,
                overrideAccess: true,
            })
            for (const site of sites.docs) {
                const s = site as unknown as Record<string, any>;
                const addDomain = (raw: string) => {
                    const candidate = raw.startsWith('http') ? raw : `https://${raw}`
                    const normalized = normalizeOrigin(candidate)
                    if (normalized) trustedOrigins.add(normalized)
                }
                if (s.internalDomain) addDomain(s.internalDomain)
                if (Array.isArray(s.allowedDomains)) {
                    for (const d of s.allowedDomains) {
                        if (d.domain) addDomain(d.domain)
                    }
                }
            }
        } catch (err) {
            req.payload.logger.error(`[ERPNext-Proxy] Failed to fetch allowed domains: ${err}`)
        }

        // Compare full origin (protocol + hostname + port)
        const normalizedOrigin = normalizeOrigin(origin)
        if (normalizedOrigin && trustedOrigins.has(normalizedOrigin)) return { accessLevel: 'public' } // Allowed public access
    }

    return {
        error: Response.json(
            { error: 'Unauthorized: invalid origin or missing internal key' },
            { status: 403 },
        ),
        accessLevel: 'public'
    }
}

async function applyProxyRateLimit(req: PayloadRequest): Promise<Response | null> {
    const ip = getClientIp(req)
    const result = await checkRateLimit(`erpnext-proxy:${ip}`, ERPNEXT_RATE_LIMIT_MAX, ERPNEXT_RATE_LIMIT_WINDOW_MS)
    if (!result.allowed) {
        return Response.json(
            { error: 'Too many requests, please try again later' },
            {
                status: 429,
                headers: { 'Retry-After': String(Math.ceil(result.retryAfterMs! / 1000)) },
            },
        )
    }
    return null
}

// ── POST /api/erpnext-proxy/submit ──────────────────────────────────────

export const erpnextProxySubmit: Endpoint = {
    path: '/erpnext-proxy/submit',
    method: 'post',
    handler: async (req) => {
        try {
            const { error: accessDenied, accessLevel } = await validateProxyAccess(req)
            if (accessDenied) return accessDenied

            const rateLimited = await applyProxyRateLimit(req)
            if (rateLimited) return rateLimited

            const body = typeof req.body === 'string'
                ? JSON.parse(req.body)
                : await new Response(req.body as ReadableStream).text().then(t => JSON.parse(t))

            // Strict validation to prevent injection / malformed payloads
            if (!body || typeof body !== 'object') {
                return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
            }
            const { doctype, data, site, captchaToken } = body as { doctype?: unknown; data?: unknown; site?: unknown; captchaToken?: unknown }

            // Spoofable-origin abuse guard: strict rate limit + optional captcha for public writes.
            const writeGuard = await enforcePublicWriteGuards(req, accessLevel, typeof site === 'string' ? site : undefined, typeof captchaToken === 'string' ? captchaToken : undefined)
            if (writeGuard) return writeGuard

            if (typeof doctype !== 'string' || doctype.length === 0 || doctype.length > 120) {
                return Response.json({ error: 'Missing or invalid required field: doctype (string, 1-120 chars)' }, { status: 400 })
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                return Response.json({ error: 'Missing or invalid required field: data (object)' }, { status: 400 })
            }
            if (site !== undefined && (typeof site !== 'string' || site.length > 120)) {
                return Response.json({ error: 'Invalid field: site (string, max 120 chars)' }, { status: 400 })
            }

            if (!ALLOWED_SUBMIT_DOCTYPES.includes(doctype)) {
                return Response.json({ error: `Doctype "${doctype}" is not allowed` }, { status: 400 })
            }

            const creds = await getCredentials(req.payload, site, req)
            if (!creds) {
                req.payload.logger.error('[ERPNext-Proxy] No active ERPNext config found')
                return Response.json({ error: 'ERPNext integration not configured' }, { status: 500 })
            }

            // Narrow type after validation
            const submitData = { ...(data as Record<string, unknown>) }

            // Auto-inject company for company-aware doctypes when enabled on the site.
            if (creds.autoInjectCompany && creds.company && COMPANY_AWARE_DOCTYPES.has(doctype)) {
                submitData.company = creds.company
            }

            const encodedDoctype = encodeURIComponent(doctype)
            if (!/^https?:\/\//i.test(creds.url)) return Response.json({ error: 'ERPNext integration not configured' }, { status: 500 })
            const response = await fetch(`${creds.url}/api/resource/${encodedDoctype}`, {
                method: 'POST',
                headers: authHeaders(creds),
                body: JSON.stringify(submitData),
                signal: AbortSignal.timeout(15000),
            })

            if (!response.ok) {
                const msg = await parseERPNextError(response)
                req.payload.logger.warn(`[ERPNext-Proxy] Submit(${doctype}) failed: ${msg}`)
                return Response.json({ error: msg }, { status: response.status })
            }

            const result = await response.json()
            return Response.json(result)
        } catch (err) {
            req.payload.logger.error(`[ERPNext-Proxy] Submit error: ${err}`)
            return Response.json({ error: 'Failed to submit to ERPNext' }, { status: 500 })
        }
    },
}

// ── GET /api/erpnext-proxy/resource ─────────────────────────────────────

export const erpnextProxyResource: Endpoint = {
    path: '/erpnext-proxy/resource',
    method: 'get',
    handler: async (req) => {
        try {
            const { error: accessDenied, accessLevel } = await validateProxyAccess(req)
            if (accessDenied) return accessDenied

            const rateLimited = await applyProxyRateLimit(req)
            if (rateLimited) return rateLimited

            const url = new URL(req.url || '', 'http://localhost')
            const doctype = url.searchParams.get('doctype')
            const name = url.searchParams.get('name')
            const fields = url.searchParams.get('fields')
            const filters = url.searchParams.get('filters')
            const limitPageLength = url.searchParams.get('limit_page_length')
            const site = url.searchParams.get('site')

            if (!doctype) {
                return Response.json({ error: 'Missing doctype query param' }, { status: 400 })
            }

            if (!ALLOWED_READ_DOCTYPES.includes(doctype)) {
                return Response.json({ error: `Doctype "${doctype}" is not allowed` }, { status: 400 })
            }

            if (accessLevel === 'public' && !PUBLIC_READ_DOCTYPES.includes(doctype)) {
                return Response.json({ error: `Unauthorized: Public origin cannot read sensitive doctype "${doctype}"` }, { status: 403 })
            }

            const creds = await getCredentials(req.payload, site, req)
            if (!creds) {
                return Response.json({ error: 'ERPNext integration not configured' }, { status: 500 })
            }

            const params = new URLSearchParams()
            if (fields) params.append('fields', fields)
            if (limitPageLength) params.append('limit_page_length', limitPageLength)

            // Force override company filter for company-aware doctypes (list queries only)
            if (creds.company && COMPANY_AWARE_DOCTYPES.has(doctype) && !name) {
                let parsedFilters: unknown[][] = []
                if (filters) {
                    try { parsedFilters = JSON.parse(filters) as unknown[][] } catch { /* keep empty */ }
                }
                // Strip any user-provided company filter to prevent bypass
                parsedFilters = parsedFilters.filter(
                    (f) => !(Array.isArray(f) && f[0] === 'company')
                )
                parsedFilters.push(['company', '=', creds.company])
                params.set('filters', JSON.stringify(parsedFilters))
            } else if (filters) {
                params.append('filters', filters)
            }

            const encodedDoctype = encodeURIComponent(doctype)
            if (!/^https?:\/\//i.test(creds.url)) return Response.json({ error: 'ERPNext integration not configured' }, { status: 500 })
            const endpoint = name
                ? `${creds.url}/api/resource/${encodedDoctype}/${encodeURIComponent(name)}`
                : `${creds.url}/api/resource/${encodedDoctype}`

            const qs = params.toString() ? `?${params}` : ''

            const response = await fetch(`${endpoint}${qs}`, {
                method: 'GET',
                headers: authHeaders(creds),
                signal: AbortSignal.timeout(15000),
            })

            if (!response.ok) {
                return Response.json(
                    { error: `ERPNext API error: ${response.status}` },
                    { status: response.status },
                )
            }

            const result = await response.json()

            // Post-fetch validation: enforce company ownership for direct ID fetches
            if (name && creds.company && COMPANY_AWARE_DOCTYPES.has(doctype)) {
                const docCompany = result.data?.company
                if (docCompany && docCompany !== creds.company) {
                    req.payload.logger.warn(`[ERPNext-Proxy] Cross-tenant access blocked. User requested ${doctype} ${name} belonging to ${docCompany}, but config is mapped to ${creds.company}`)
                    return Response.json({ error: 'Unauthorized: Document belongs to a different company' }, { status: 403 })
                }
            }

            return Response.json(result)
        } catch (err) {
            req.payload.logger.error(`[ERPNext-Proxy] Resource error: ${err}`)
            return Response.json({ error: 'Failed to fetch from ERPNext' }, { status: 500 })
        }
    },
}

// ── GET /api/erpnext-proxy/health ───────────────────────────────────────

export const erpnextProxyHealth: Endpoint = {
    path: '/erpnext-proxy/health',
    method: 'get',
    handler: async (req) => {
        try {
            // Require a trusted origin / internal key + rate limit, same as the other
            // proxy endpoints. Without this, an unauthenticated caller can force the
            // server to make an outbound request carrying the ERPNext credentials to
            // whatever URL the config points at (SSRF + credential-probe surface).
            const { error: accessDenied } = await validateProxyAccess(req)
            if (accessDenied) return accessDenied

            const rateLimited = await applyProxyRateLimit(req)
            if (rateLimited) return rateLimited

            const url = new URL(req.url || '', 'http://localhost')
            const site = url.searchParams.get('site')

            const creds = await getCredentials(req.payload, site, req)
            if (!creds) {
                return Response.json({ healthy: false, reason: 'No active ERPNext config found' })
            }
            if (!/^https?:\/\//i.test(creds.url)) return Response.json({ healthy: false, reason: 'ERPNext integration not configured' })

            const response = await fetch(`${creds.url}/api/resource/User?limit_page_length=1`, {
                method: 'GET',
                headers: authHeaders(creds),
                signal: AbortSignal.timeout(10000),
            })

            return Response.json({ healthy: response.ok })
        } catch {
            return Response.json({ healthy: false, reason: 'connection failed' })
        }
    },
}

// ── POST /api/erpnext-proxy/upload ──────────────────────────────────────

export const erpnextProxyUpload: Endpoint = {
    path: '/erpnext-proxy/upload',
    method: 'post',
    handler: async (req) => {
        try {
            const { error: accessDenied, accessLevel } = await validateProxyAccess(req)
            if (accessDenied) return accessDenied

            const rateLimited = await applyProxyRateLimit(req)
            if (rateLimited) return rateLimited

            if (typeof req.formData !== 'function') {
                return Response.json({ error: 'Multipart form data not supported' }, { status: 400 });
            }
            const formData = await (req as any).formData();
            const doctype = formData.get('doctype') as string;
            const docname = formData.get('docname') as string;
            const site = formData.get('site') as string;
            const file = formData.get('file') as File;
            const captchaToken = formData.get('captchaToken') as string | null;

            // Spoofable-origin abuse guard: strict rate limit + optional captcha for public writes.
            const writeGuard = await enforcePublicWriteGuards(req, accessLevel, site, captchaToken);
            if (writeGuard) return writeGuard;

            if (!doctype || !docname || !file) {
                return Response.json({ error: 'Missing required fields' }, { status: 400 });
            }

            if (!ALLOWED_SUBMIT_DOCTYPES.includes(doctype)) {
                return Response.json({ error: `Doctype "${doctype}" is not allowed` }, { status: 400 })
            }

            const creds = await getCredentials(req.payload, site, req);
            if (!creds) {
                return Response.json({ error: 'ERPNext integration not configured' }, { status: 500 });
            }
            if (!/^https?:\/\//i.test(creds.url)) return Response.json({ error: 'ERPNext integration not configured' }, { status: 500 });

            const erpFormData = new FormData();
            erpFormData.append('file', file);
            erpFormData.append('doctype', doctype);
            erpFormData.append('docname', docname);
            erpFormData.append('is_private', '1');

            const response = await fetch(`${creds.url}/api/method/upload_file`, {
                method: 'POST',
                headers: {
                    Authorization: authHeaders(creds).Authorization,
                },
                body: erpFormData,
            });

            if (!response.ok) {
                const msg = await parseERPNextError(response);
                req.payload.logger.warn(`[ERPNext-Proxy] Upload failed: ${msg}`);
                return Response.json({ error: msg }, { status: response.status });
            }

            const result = await response.json();
            return Response.json(result);

        } catch (err) {
            req.payload.logger.error(`[ERPNext-Proxy] Upload error: ${err}`);
            return Response.json({ error: 'Failed to upload to ERPNext' }, { status: 500 });
        }
    }
}
