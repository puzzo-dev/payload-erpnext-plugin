import type { Endpoint, CollectionSlug } from 'payload'
import { getUserOrgId, getUserSiteId, type UserWithRole } from '../types'
import { getCredentials, authHeaders } from './erpnextProxy'

/**
 * POST /api/retry-dead-letters
 *
 * Admin-only endpoint to retry pending dead-letter records.
 * Can be called manually from admin UI or scheduled via cron.
 *
 * Query params:
 *   ?limit=20  — max records to process (default 20, max 100)
 *   ?site=slug — restrict to a specific site
 */
export const retryDeadLettersEndpoint: Endpoint = {
    path: '/retry-dead-letters',
    method: 'post',
    handler: async (req) => {
        const user = req.user as unknown as UserWithRole | undefined
        if (!user || !['super-admin', 'admin'].includes(user.role || '')) {
            return Response.json({ error: 'Unauthorized' }, { status: 403 })
        }

        const url = new URL(req.url || '', 'http://localhost')
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '20', 10), 100)
        const siteSlug = url.searchParams.get('site') ?? undefined

        try {
            // Resolve an optional ?site=slug into an ID (the `site` filter was previously a
            // documented no-op, so an admin could retry EVERY tenant's dead letters).
            let requestedSiteId: string | number | undefined
            if (siteSlug) {
                const s = await req.payload.find({
                    collection: 'sites' as unknown as CollectionSlug,
                    where: { slug: { equals: siteSlug } },
                    limit: 1, depth: 0, overrideAccess: true, req,
                })
                if (s.totalDocs === 0) return Response.json({ error: 'Unknown site' }, { status: 404 })
                requestedSiteId = (s.docs[0] as { id: string | number }).id
            }

            const andConditions: Record<string, unknown>[] = [{ status: { equals: 'pending' } }]

            // Tenant scoping: super-admins may target any/all sites; admins are confined
            // to the sites within their own organization.
            if (user.role !== 'super-admin') {
                const orgId = getUserOrgId(user)
                const ownSiteId = getUserSiteId(user)
                let allowedSiteIds: (string | number)[] = []
                if (ownSiteId != null) {
                    allowedSiteIds = [ownSiteId]
                } else if (orgId != null) {
                    const orgSites = await req.payload.find({
                        collection: 'sites' as unknown as CollectionSlug,
                        where: { organization: { equals: orgId } },
                        limit: 1000, depth: 0, overrideAccess: true, req,
                    })
                    allowedSiteIds = orgSites.docs.map((d) => (d as { id: string | number }).id)
                }
                if (allowedSiteIds.length === 0) {
                    return Response.json({ error: 'No sites in your scope' }, { status: 403 })
                }
                if (requestedSiteId != null && !allowedSiteIds.some((id) => String(id) === String(requestedSiteId))) {
                    return Response.json({ error: 'Site is outside your organization' }, { status: 403 })
                }
                andConditions.push({ site: { in: requestedSiteId != null ? [requestedSiteId] : allowedSiteIds } })
            } else if (requestedSiteId != null) {
                andConditions.push({ site: { equals: requestedSiteId } })
            }

            const pending = await req.payload.find({
                collection: 'erpnext-dead-letters' as unknown as CollectionSlug,
                where: { and: andConditions } as any,
                limit,
                depth: 0,
                req,
            })

            const results: Array<{ id: string | number; status: string; detail: string }> = []

            for (const letter of pending.docs) {
                const dl = letter as unknown as Record<string, unknown>
                const id = dl.id as string | number
                const erpnextUrl = dl.erpnextUrl as string
                const docType = dl.docType as string
                const payload = dl.payload as Record<string, string>
                const retryCount = (dl.retryCount as number) ?? 0

                try {
                    if (!erpnextUrl.startsWith('https://')) {
                        throw new Error('Non-HTTPS URL blocked by policy')
                    }

                    // We don't have apiKey/apiSecret stored in dead-letter for security;
                    // re-resolve from the site's active ERPNextConfig via
                    // getCredentials(), which correctly branches between
                    // api_key and oauth authMethod (and transparently
                    // refreshes an expired OAuth token). The previous direct
                    // `cfg.apiKey`/`cfg.apiSecret` read here had no guard at
                    // all for an OAuth-connected site (both undefined),
                    // building `Authorization: token undefined:undefined`
                    // and failing every retry forever for that site.
                    const siteId = dl.site as string | number
                    const siteDoc = await req.payload.findByID({
                        collection: 'sites' as unknown as CollectionSlug,
                        id: siteId,
                        depth: 0,
                        overrideAccess: true,
                    }).catch(() => null)
                    const siteSlug = (siteDoc as unknown as { slug?: string } | null)?.slug
                    const creds = siteSlug ? await getCredentials(req.payload, siteSlug) : null

                    if (!creds) {
                        results.push({ id, status: 'skipped', detail: 'No active ERPNext config, or credentials are missing, for site' })
                        continue
                    }

                    const url = `${erpnextUrl.replace(/\/+$/, '')}/api/resource/${encodeURIComponent(docType)}`

                    const controller = new AbortController()
                    const timeout = setTimeout(() => controller.abort(), 15_000)

                    const response = await fetch(url, {
                        method: 'POST',
                        headers: authHeaders(creds),
                        body: JSON.stringify(payload),
                        signal: controller.signal,
                    })

                    clearTimeout(timeout)

                    if (response.ok) {
                        await req.payload.update({
                            collection: 'erpnext-dead-letters' as unknown as CollectionSlug,
                            id,
                            req,
                            data: {
                                status: 'success',
                                retryCount: retryCount + 1,
                                lastRetryAt: new Date().toISOString(),
                            } as any,
                        })
                        results.push({ id, status: 'success', detail: 'Replayed successfully' })
                    } else {
                        const body = await response.text().catch(() => '(no body)')
                        await req.payload.update({
                            collection: 'erpnext-dead-letters' as unknown as CollectionSlug,
                            id,
                            req,
                            data: {
                                status: 'failed',
                                retryCount: retryCount + 1,
                                lastRetryAt: new Date().toISOString(),
                                errorDetail: `Replay failed: HTTP ${response.status} ${body.slice(0, 500)}`,
                            } as any,
                        })
                        results.push({ id, status: 'failed', detail: `HTTP ${response.status}` })
                    }
                } catch (err) {
                    await req.payload.update({
                        collection: 'erpnext-dead-letters' as unknown as CollectionSlug,
                        id,
                        req,
                        data: {
                            status: 'failed',
                            retryCount: retryCount + 1,
                            lastRetryAt: new Date().toISOString(),
                            errorDetail: `Replay exception: ${String(err)}`,
                        } as any,
                    })
                    results.push({ id, status: 'error', detail: String(err) })
                }
            }

            return Response.json({ processed: results.length, results })
        } catch (err) {
            req.payload.logger.error(`[retryDeadLetters] Unexpected error: ${err}`)
            return Response.json({ error: 'Internal server error' }, { status: 500 })
        }
    },
}
