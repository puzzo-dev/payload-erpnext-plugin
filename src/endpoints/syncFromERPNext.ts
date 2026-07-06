import type { Endpoint, CollectionSlug } from 'payload'
import type { ERPNextWebhookPayload } from '../types'
import { verifyERPNextWebhookSignature } from '../utils/webhookSignature'
import { findRulesForDoctype, upsertErpRecord, deleteErpRecord, resolveSiteId } from '../sync/runSyncRule'

/**
 * POST /api/erpnext-sync?site=<slug>
 *
 * Inbound webhook receiver for ERPNext → Payload sync. Configure an ERPNext Webhook
 * (Setup → Webhook) on the DocType you want to sync, pointing here on save/trash.
 *
 * ERPNext sends:
 *   - X-ERPNext-Signature: HMAC-SHA256 of the request body (secret from erpnext-config)
 *   - Body: { event, doctype, data: { ...fields } }
 *
 * What gets synced is NOT hardcoded — it is entirely driven by the owner-declared
 * `erpnext-sync-rules` for this site. If no active rule matches the incoming DocType,
 * the webhook is rejected as unsupported.
 */

/** ERPNext delete-ish events. Everything else is treated as create/update (upsert). */
function isDeleteEvent(event: string): boolean {
    return /trash|delete|cancel/i.test(event)
}

export const syncFromERPNextEndpoint: Endpoint = {
    path: '/erpnext-sync',
    method: 'post',
    handler: async (req) => {
        const log = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
            const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
            req.payload.logger[level](`[ERPNext-Sync] ${msg}${metaStr}`)
        }

        try {
            // ── 1. Read raw body (needed for signature verification) ────
            const rawBody = typeof req.body === 'string'
                ? req.body
                : await new Response(req.body as ReadableStream).text()

            const signature = req.headers.get('x-erpnext-signature') || ''

            // ── 2. Identify the site from ?site=<slug> ─────────────────
            const url = new URL(req.url || '', 'http://localhost')
            const siteSlug = url.searchParams.get('site')
            if (!siteSlug) {
                return Response.json({ error: 'Missing ?site= query parameter' }, { status: 400 })
            }

            const sites = await req.payload.find({
                collection: 'sites',
                where: { slug: { equals: siteSlug } },
                limit: 1,
                depth: 0,
                overrideAccess: true,
            })
            if (sites.totalDocs === 0) {
                return Response.json({ error: 'Site not found' }, { status: 404 })
            }
            const siteId = sites.docs[0].id

            // ── 3. Get ERPNext config + webhook secret for this site ───
            const configs = await req.payload.find({
                collection: 'erpnext-config' as unknown as CollectionSlug,
                where: {
                    site: { equals: siteId },
                    isActive: { equals: true },
                },
                limit: 1,
                depth: 0,
                overrideAccess: true,
                context: { preventMasking: true },
            })
            if (configs.totalDocs === 0) {
                return Response.json({ error: 'No active ERPNext config for site' }, { status: 404 })
            }
            const webhookSecret = (configs.docs[0] as unknown as Record<string, unknown>).webhookSecret as string | undefined

            // ── 4. Verify signature (fail closed) ──────────────────────
            if (!webhookSecret) {
                log('error', 'Webhook secret not configured for site — rejecting webhook', { siteSlug })
                return Response.json({ error: 'Webhook secret not configured' }, { status: 403 })
            }
            if (!signature || !verifyERPNextWebhookSignature(rawBody, signature, webhookSecret)) {
                log('warn', 'Webhook signature verification failed', { siteSlug })
                return Response.json({ error: 'Invalid signature' }, { status: 401 })
            }

            // ── 5. Parse payload ───────────────────────────────────────
            let payload: ERPNextWebhookPayload
            try {
                payload = JSON.parse(rawBody) as ERPNextWebhookPayload
            } catch {
                return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
            }
            const { event = '', doctype, data = {} } = payload
            if (!doctype) {
                return Response.json({ error: 'Missing doctype' }, { status: 400 })
            }
            log('info', 'Received webhook', { event, doctype, name: (data as Record<string, unknown>)?.name })

            // ── 6. Route via owner-declared sync rules ─────────────────
            const rules = await findRulesForDoctype(req.payload, siteId, doctype)
            if (rules.length === 0) {
                log('warn', `No active sync rule for doctype "${doctype}"`, { siteSlug })
                return Response.json({ error: `No sync rule for doctype: ${doctype}` }, { status: 400 })
            }

            const deleting = isDeleteEvent(event)
            const results: Array<Record<string, unknown>> = []
            for (const rule of rules) {
                const ruleSiteId = resolveSiteId(rule.site)
                const result = deleting
                    ? await deleteErpRecord(req, rule, data as Record<string, unknown>, ruleSiteId, log)
                    : await upsertErpRecord(req, rule, data as Record<string, unknown>, ruleSiteId, log)
                results.push({ targetCollection: rule.targetCollection, ...result })
            }

            return Response.json({ doctype, event, results })
        } catch (err) {
            req.payload.logger.error(`[ERPNext-Sync] Unexpected error: ${err}`)
            return Response.json({ error: 'Internal server error' }, { status: 500 })
        }
    },
}
