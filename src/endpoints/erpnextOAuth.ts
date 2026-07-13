import type { Endpoint, CollectionSlug } from 'payload'
import { encryptCredential, decryptCredential, signOAuthState, verifyOAuthState } from '../utils/erpnextCrypto'
import type { UserWithRole } from '../types'

/**
 * ERPNext OAuth2 Connect flow — an alternative to manually pasting an API
 * Key/Secret. Frappe (the framework ERPNext is built on) has a genuine,
 * documented OAuth2 *provider* built in (Settings → OAuth Client in the
 * Frappe/ERPNext admin) with standard authorization-code endpoints:
 *
 *   GET  /api/method/frappe.integrations.oauth2.authorize
 *   POST /api/method/frappe.integrations.oauth2.get_token
 *
 * This plugin only implements the OAuth *client* side — ERPNext itself is
 * already the provider. Manual API Key/Secret entry (erpnextProxy.ts's
 * existing getCredentials()/authHeaders()) stays fully functional; OAuth is
 * an additional authMethod, not a replacement — see ERPNextConfig.ts.
 *
 * IMPORTANT: implemented strictly against Frappe's documented OAuth2 provider
 * contract. Not yet exercised against a real ERPNext instance — that needs a
 * live OAuth Client registered in a real Frappe site and a browser to
 * complete the consent screen, neither of which exist in the environment
 * this was built in. Do a manual test connect before relying on this in
 * production.
 */

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = (req.user as unknown as UserWithRole | undefined)?.role
    return role === 'super-admin' || role === 'admin'
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

// ── GET /erpnext-oauth/start?configId=<id> ──────────────────────────────────
export const erpnextOAuthStartEndpoint: Endpoint = {
    path: '/erpnext-oauth/start',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.json({ error: 'Config not found' }, { status: 404 })
        }

        const erpnextUrl = (config.erpnextUrl as string | undefined)?.replace(/\/+$/, '')
        const rawClientId = config.oauthClientId as string | undefined
        if (!erpnextUrl) {
            return Response.json({ error: 'Set the ERPNext instance URL first.' }, { status: 400 })
        }
        if (!rawClientId) {
            return Response.json({ error: 'Set an OAuth Client ID on the Connection tab before connecting (create one in ERPNext under Settings → OAuth Client).' }, { status: 400 })
        }

        const state = signOAuthState(configId)
        const params = new URLSearchParams({
            client_id: rawClientId,
            response_type: 'code',
            redirect_uri: callbackRedirectUri(),
            state,
        })

        return Response.redirect(`${erpnextUrl}/api/method/frappe.integrations.oauth2.authorize?${params}`, 302)
    },
}

// ── GET /erpnext-oauth/callback?code=&state= ────────────────────────────────
export const erpnextOAuthCallbackEndpoint: Endpoint = {
    path: '/erpnext-oauth/callback',
    method: 'get',
    handler: async (req) => {
        const code = req.query?.code as string | undefined
        const state = req.query?.state as string | undefined
        const oauthError = req.query?.error_description as string | undefined

        const adminBase = `${serverUrl()}/admin/collections/erpnext-config`

        if (oauthError) {
            return Response.redirect(`${adminBase}?erpnext_oauth_error=${encodeURIComponent(oauthError)}`, 302)
        }
        if (!code || !state) {
            return Response.redirect(`${adminBase}?erpnext_oauth_error=${encodeURIComponent('Missing code or state')}`, 302)
        }

        const configId = verifyOAuthState(state)
        if (!configId) {
            return Response.redirect(`${adminBase}?erpnext_oauth_error=${encodeURIComponent('Invalid or expired connect request — try again')}`, 302)
        }

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.redirect(`${adminBase}?erpnext_oauth_error=${encodeURIComponent('Config not found')}`, 302)
        }

        const erpnextUrl = (config.erpnextUrl as string | undefined)?.replace(/\/+$/, '')
        const rawClientId = config.oauthClientId as string | undefined
        const rawClientSecret = config.oauthClientSecret as string | undefined
        const clientSecret = rawClientSecret?.startsWith('enc:') ? decryptCredential(rawClientSecret) : rawClientSecret
        if (!erpnextUrl || !rawClientId || !clientSecret) {
            return Response.redirect(`${adminBase}/${configId}?erpnext_oauth_error=${encodeURIComponent('OAuth Client ID/Secret not configured')}`, 302)
        }

        try {
            const tokenRes = await fetch(`${erpnextUrl}/api/method/frappe.integrations.oauth2.get_token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: callbackRedirectUri(),
                    client_id: rawClientId,
                    client_secret: clientSecret,
                }).toString(),
                signal: AbortSignal.timeout(20000),
            })

            if (!tokenRes.ok) {
                const body = await tokenRes.text().catch(() => '')
                req.payload.logger.error(`[ERPNextOAuth] Token exchange failed (${tokenRes.status}): ${body}`)
                return Response.redirect(`${adminBase}/${configId}?erpnext_oauth_error=${encodeURIComponent('Token exchange failed')}`, 302)
            }

            const tokenBody = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
            if (!tokenBody.access_token) {
                return Response.redirect(`${adminBase}/${configId}?erpnext_oauth_error=${encodeURIComponent('No access token returned')}`, 302)
            }

            const expiresAt = new Date(Date.now() + (tokenBody.expires_in ?? 3600) * 1000).toISOString()

            await req.payload.update({
                collection: 'erpnext-config' as unknown as CollectionSlug,
                id: configId,
                data: {
                    authMethod: 'oauth',
                    oauthAccessToken: encryptCredential(tokenBody.access_token),
                    oauthRefreshToken: tokenBody.refresh_token ? encryptCredential(tokenBody.refresh_token) : undefined,
                    oauthExpiresAt: expiresAt,
                    connectionStatus: 'connected',
                } as any,
                overrideAccess: true,
                context: { skipAutoFetch: true },
            })

            return Response.redirect(`${adminBase}/${configId}?erpnext_oauth_success=1`, 302)
        } catch (err) {
            req.payload.logger.error(`[ERPNextOAuth] Callback error: ${err}`)
            return Response.redirect(`${adminBase}/${configId}?erpnext_oauth_error=${encodeURIComponent('Token exchange failed')}`, 302)
        }
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
