import type { Endpoint, CollectionSlug } from 'payload'
import { randomUUID } from 'crypto'
import { encryptCredential } from '../utils/erpnextCrypto'
import { getUserSiteId, getUserOrgId, type UserWithRole } from '../types'
import { checkRateLimit, getClientIp } from '../utils/rateLimit'

/**
 * ERPNext OAuth2 "Connect via login" flow.
 *
 * No pre-existing ERPNext OAuth Client is required. The admin enters their
 * ERPNext username/password once (never stored — used only for this one
 * login call); we use the resulting session server-side to:
 *
 *   1. Find or create an "OAuth Client" record in ERPNext via its own REST
 *      API (`/api/resource/OAuth Client`) — Frappe auto-generates
 *      client_id/client_secret on creation (see oauth_client.py's
 *      validate(): `self.client_id = self.name`,
 *      `self.client_secret = frappe.generate_hash(...)`). Lookup is by a
 *      deterministic `app_name` (derived from the site slug) so
 *      reconnecting — including after this Payload config was deleted and
 *      recreated — reuses the same ERPNext OAuth Client instead of
 *      accumulating orphaned ones.
 *   2. Drive the standard authorization-code grant server-side by hitting
 *      Frappe's real OAuth2 provider endpoints
 *      (frappe.integrations.oauth2.authorize / .approve) with the session
 *      cookie. The client is created with skip_authorization=1, so ERPNext
 *      auto-approves instead of showing a "Confirm Access" page — the whole
 *      thing happens inside this one request, nothing for the admin to
 *      click through.
 *   3. Exchange the resulting code for an access/refresh token exactly like
 *      a normal OAuth2 authorization-code flow.
 *
 * Manual API Key/Secret entry (erpnextProxy.ts's existing
 * getCredentials()/authHeaders()) stays fully functional as an alternative;
 * this endpoint only sets authMethod + the oauth* fields.
 *
 * IMPORTANT: implemented strictly against Frappe's documented OAuth2
 * provider contract and the actual `OAuth Client` doctype schema/controller
 * (verified against the Frappe source, not guessed). Not yet exercised
 * against a real ERPNext instance in this environment — do a manual test
 * connect before relying on this in production.
 */

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = (req.user as unknown as UserWithRole | undefined)?.role
    return role === 'super-admin' || role === 'admin'
}

/**
 * isAdminOrAbove only checks the caller's ROLE — it never checks whether
 * their site/org actually matches the target config's tenant. Without this,
 * an admin for Tenant A could pass Tenant B's configId and this endpoint
 * would happily load and later mutate Tenant B's ERPNext connection (an
 * IDOR: cross-tenant credential hijack). super-admin bypasses this check
 * (matches every other access-control helper in the platform).
 */
function callerOwnsConfigSite(req: { user?: unknown }, config: Record<string, unknown>): boolean {
    const user = req.user as unknown as UserWithRole | undefined
    if (!user) return false
    if (user.role === 'super-admin') return true
    const configSite = typeof config.site === 'object' && config.site !== null
        ? (config.site as Record<string, unknown>).id
        : config.site
    const configOrg = typeof config.organization === 'object' && config.organization !== null
        ? (config.organization as Record<string, unknown>).id
        : config.organization
    const callerSiteId = getUserSiteId(user)
    const callerOrgId = getUserOrgId(user)
    const siteMatches = callerSiteId != null && configSite != null && String(configSite) === String(callerSiteId)
    const orgMatches = callerOrgId != null && configOrg != null && String(configOrg) === String(callerOrgId)
    return siteMatches || orgMatches
}

function serverUrl(): string {
    return (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
}

function callbackRedirectUri(): string {
    return `${serverUrl()}/api/erpnext-oauth/callback`
}

async function loadConfig(payload: Parameters<Endpoint['handler']>[0]['payload'], configId: string) {
    return payload.findByID({
        collection: 'erpnext-config' as unknown as CollectionSlug,
        id: configId,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true, skipAutoFetch: true },
    }) as unknown as Record<string, unknown>
}

/** Extract the `sid=...` session cookie from a Frappe /api/method/login response. */
function extractSessionCookie(res: Response): string | null {
    const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
    const setCookies = typeof getSetCookie === 'function'
        ? getSetCookie.call(res.headers)
        : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : [])
    for (const raw of setCookies) {
        const match = raw.match(/^sid=([^;]+)/)
        if (match?.[1] && match[1] !== 'Guest') return `sid=${match[1]}`
    }
    return null
}

/** Follow exactly one redirect with the given session cookie, returning the Location header. */
async function followRedirect(url: string, sessionCookie: string): Promise<string> {
    const res = await fetch(url, {
        method: 'GET',
        headers: { Cookie: sessionCookie },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
    })
    const location = res.headers.get('location')
    if (!location || res.status < 300 || res.status >= 400) {
        throw new Error(`Expected a redirect from ${url}, got HTTP ${res.status}`)
    }
    return location
}

async function exchangeCodeForToken(
    erpnextUrl: string,
    code: string,
    redirectUri: string,
    clientId: string,
    clientSecret: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const tokenRes = await fetch(`${erpnextUrl}/api/method/frappe.integrations.oauth2.get_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(20000),
    })
    if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '')
        throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${body}`)
    }
    const body = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!body.access_token) throw new Error('ERPNext did not return an access token')
    return body as { access_token: string; refresh_token?: string; expires_in?: number }
}

const AUTO_CONNECT_RATE_LIMIT_MAX = 5
const AUTO_CONNECT_RATE_LIMIT_WINDOW_MS = 60_000

// ── POST /erpnext-oauth/auto-connect ────────────────────────────────────────
export const erpnextOAuthAutoConnectEndpoint: Endpoint = {
    path: '/erpnext-oauth/auto-connect',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const ip = getClientIp(req)
        const rateCheck = await checkRateLimit(
            `erpnext-oauth-auto-connect:${ip}`,
            AUTO_CONNECT_RATE_LIMIT_MAX,
            AUTO_CONNECT_RATE_LIMIT_WINDOW_MS,
        )
        if (!rateCheck.allowed) {
            return Response.json(
                { error: 'Too many attempts. Try again later.' },
                { status: 429, headers: { 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) } },
            )
        }

        let body: Record<string, unknown>
        try {
            body = await req.json!()
        } catch {
            return Response.json({ error: 'Invalid request body' }, { status: 400 })
        }
        const { configId, username, password } = body as { configId?: string; username?: string; password?: string }
        if (!configId || !username || !password) {
            return Response.json({ error: 'configId, username, and password are required' }, { status: 400 })
        }

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.json({ error: 'Config not found' }, { status: 404 })
        }
        if (!callerOwnsConfigSite(req, config)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
        }

        const erpnextUrl = (config.erpnextUrl as string | undefined)?.replace(/\/+$/, '')
        if (!erpnextUrl) {
            return Response.json({ error: 'Set the ERPNext instance URL first.' }, { status: 400 })
        }
        if (process.env.NODE_ENV === 'production' && !erpnextUrl.startsWith('https://')) {
            return Response.json({ error: 'Only HTTPS ERPNext URLs are allowed' }, { status: 400 })
        }

        // ── 1. Log in ────────────────────────────────────────────────────
        let sessionCookie: string
        try {
            const loginRes = await fetch(`${erpnextUrl}/api/method/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usr: username, pwd: password }),
                signal: AbortSignal.timeout(15000),
            })
            const cookie = extractSessionCookie(loginRes)
            if (!loginRes.ok || !cookie) {
                return Response.json({ error: 'Invalid ERPNext username or password' }, { status: 400 })
            }
            sessionCookie = cookie
        } catch (err) {
            req.payload.logger.error(`[ERPNextOAuth] auto-connect login failed: ${err}`)
            return Response.json({ error: 'Could not reach the ERPNext instance to log in' }, { status: 502 })
        }

        // ── 2. Find or create the OAuth Client (idempotent by app_name) ───
        const siteRelation = config.site as { id?: string | number } | string | number | null | undefined
        const siteId = typeof siteRelation === 'object' && siteRelation !== null ? siteRelation.id : siteRelation
        let siteSlug = String(siteId ?? configId)
        try {
            const siteDoc = siteId
                ? await req.payload.findByID({ collection: 'sites' as unknown as CollectionSlug, id: siteId, depth: 0, overrideAccess: true })
                : null
            const slug = (siteDoc as unknown as { slug?: string } | null)?.slug
            if (slug) siteSlug = slug
        } catch {
            // fall back to the id-based slug above
        }
        const appName = `IVarse Integration (${siteSlug})`
        const redirectUri = callbackRedirectUri()

        let clientId: string
        let clientSecret: string
        try {
            const lookupRes = await fetch(
                `${erpnextUrl}/api/resource/OAuth Client?filters=${encodeURIComponent(JSON.stringify([['app_name', '=', appName]]))}&limit_page_length=1`,
                { headers: { Cookie: sessionCookie }, signal: AbortSignal.timeout(15000) },
            )
            if (!lookupRes.ok) throw new Error(`OAuth Client lookup failed (HTTP ${lookupRes.status})`)
            const lookupBody = await lookupRes.json() as { data?: Array<{ name: string }> }
            const existingName = lookupBody.data?.[0]?.name

            if (existingName) {
                const getRes = await fetch(`${erpnextUrl}/api/resource/OAuth Client/${encodeURIComponent(existingName)}`, {
                    headers: { Cookie: sessionCookie },
                    signal: AbortSignal.timeout(15000),
                })
                if (!getRes.ok) throw new Error(`Failed to load existing OAuth Client (HTTP ${getRes.status})`)
                const getBody = await getRes.json() as { data?: { client_id?: string; client_secret?: string; redirect_uris?: string } }
                if (!getBody.data?.client_id || !getBody.data?.client_secret) {
                    throw new Error('Existing OAuth Client is missing client_id/client_secret')
                }
                clientId = getBody.data.client_id
                clientSecret = getBody.data.client_secret
                // Keep the redirect URI current in case PAYLOAD_PUBLIC_SERVER_URL changed since this client was first created.
                if (getBody.data.redirect_uris !== redirectUri) {
                    await fetch(`${erpnextUrl}/api/resource/OAuth Client/${encodeURIComponent(existingName)}`, {
                        method: 'PUT',
                        headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ redirect_uris: redirectUri, default_redirect_uri: redirectUri }),
                        signal: AbortSignal.timeout(15000),
                    }).catch(() => { /* non-fatal — the client still works with its original redirect URI */ })
                }
            } else {
                const createRes = await fetch(`${erpnextUrl}/api/resource/OAuth Client`, {
                    method: 'POST',
                    headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        app_name: appName,
                        scopes: 'all openid',
                        redirect_uris: redirectUri,
                        default_redirect_uri: redirectUri,
                        grant_type: 'Authorization Code',
                        response_type: 'Code',
                        token_endpoint_auth_method: 'Client Secret Post',
                        skip_authorization: 1,
                    }),
                    signal: AbortSignal.timeout(15000),
                })
                if (!createRes.ok) {
                    const errBody = await createRes.text().catch(() => '')
                    throw new Error(`Failed to create OAuth Client (HTTP ${createRes.status}): ${errBody}`)
                }
                const createBody = await createRes.json() as { data?: { client_id?: string; client_secret?: string } }
                if (!createBody.data?.client_id || !createBody.data?.client_secret) {
                    throw new Error('ERPNext did not return client_id/client_secret for the new OAuth Client')
                }
                clientId = createBody.data.client_id
                clientSecret = createBody.data.client_secret
            }
        } catch (err) {
            req.payload.logger.error(`[ERPNextOAuth] auto-connect OAuth Client setup failed: ${err}`)
            return Response.json(
                { error: `Could not set up the OAuth Client in ERPNext — the user you logged in with needs the System Manager role. (${err instanceof Error ? err.message : 'unknown error'})` },
                { status: 502 },
            )
        }

        // ── 3. Drive the authorization-code grant server-side ─────────────
        // skip_authorization on the client means ERPNext auto-approves — the
        // admin never sees a "Confirm Access" page, it all happens in this request.
        let code: string
        try {
            const state = randomUUID()
            const authorizeUrl = `${erpnextUrl}/api/method/frappe.integrations.oauth2.authorize?${new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                state,
            })}`
            const approveLocation = await followRedirect(authorizeUrl, sessionCookie)
            const finalLocation = await followRedirect(
                approveLocation.startsWith('http') ? approveLocation : `${erpnextUrl}${approveLocation}`,
                sessionCookie,
            )
            const finalUrl = new URL(finalLocation.startsWith('http') ? finalLocation : `${erpnextUrl}${finalLocation}`)
            const returnedCode = finalUrl.searchParams.get('code')
            const returnedState = finalUrl.searchParams.get('state')
            if (!returnedCode || returnedState !== state) {
                throw new Error('ERPNext did not return a valid authorization code')
            }
            code = returnedCode
        } catch (err) {
            req.payload.logger.error(`[ERPNextOAuth] auto-connect authorization step failed: ${err}`)
            return Response.json({ error: `Authorization step failed: ${err instanceof Error ? err.message : 'unknown error'}` }, { status: 502 })
        }

        // ── 4. Exchange the code for tokens ────────────────────────────────
        try {
            const tokenBody = await exchangeCodeForToken(erpnextUrl, code, redirectUri, clientId, clientSecret)
            const expiresAt = new Date(Date.now() + (tokenBody.expires_in ?? 3600) * 1000).toISOString()

            await req.payload.update({
                collection: 'erpnext-config' as unknown as CollectionSlug,
                id: configId,
                data: {
                    authMethod: 'oauth',
                    oauthClientId: clientId,
                    oauthClientSecret: encryptCredential(clientSecret),
                    oauthAccessToken: encryptCredential(tokenBody.access_token),
                    oauthRefreshToken: tokenBody.refresh_token ? encryptCredential(tokenBody.refresh_token) : undefined,
                    oauthExpiresAt: expiresAt,
                    connectionStatus: 'connected',
                } as any,
                overrideAccess: true,
                // Deliberately NOT skipAutoFetch — a successful connect should
                // trigger the existing background company auto-fetch, same as
                // it does after a manual API Key/Secret save.
            })
        } catch (err) {
            req.payload.logger.error(`[ERPNextOAuth] auto-connect token exchange failed: ${err}`)
            return Response.json({ error: `Token exchange failed: ${err instanceof Error ? err.message : 'unknown error'}` }, { status: 502 })
        }

        return Response.json({ success: true })
    },
}

/**
 * Refresh an expired OAuth access token using the stored refresh token.
 * Called internally by getCredentials() in erpnextProxy.ts when
 * oauthExpiresAt has passed — callers never need to invoke this directly.
 */
export async function refreshOAuthToken(
    payload: Parameters<Endpoint['handler']>[0]['payload'],
    configId: string | number,
    erpnextUrl: string,
    clientId: string,
    clientSecret: string,
    refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string } | null> {
    try {
        const res = await fetch(`${erpnextUrl.replace(/\/+$/, '')}/api/method/frappe.integrations.oauth2.get_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: clientSecret,
            }).toString(),
            signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) return null

        const body = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
        if (!body.access_token) return null

        const expiresAt = new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString()

        await payload.update({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            id: configId,
            data: {
                oauthAccessToken: encryptCredential(body.access_token),
                // Frappe may or may not rotate the refresh token — keep the existing one if it doesn't return a new one.
                ...(body.refresh_token ? { oauthRefreshToken: encryptCredential(body.refresh_token) } : {}),
                oauthExpiresAt: expiresAt,
            } as any,
            overrideAccess: true,
            context: { skipAutoFetch: true },
        })

        return { accessToken: body.access_token, expiresAt }
    } catch (err) {
        payload.logger.warn(`[ERPNextOAuth] Token refresh failed for config ${configId}: ${err}`)
        return null
    }
}
