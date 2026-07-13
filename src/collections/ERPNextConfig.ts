import type { CollectionConfig, CollectionAfterChangeHook, CollectionSlug, FieldAccess } from 'payload'
import {
    siteScopedCreate, siteScopedDelete, siteScopedRead, siteScopedUpdate
} from '../access/roles';
import { organizationField } from '../fields/organizationField';
import { encryptCredential, decryptCredential } from '../utils/erpnextCrypto';
import { getCredentials, authHeaders } from '../endpoints/erpnextProxy';
import type { ERPNextCompany, UserWithRole } from '../types';

/**
 * Field-level guard: only admins/super-admins (or trusted server calls using
 * overrideAccess) may set the ERPNext instance URL and credentials. Editors can
 * still see the (masked) config, but must not be able to repoint `erpnextUrl` at
 * an attacker server — doing so would exfiltrate the decrypted apiKey/apiSecret via
 * the outbound Authorization header (defeating masking). Rotating credentials is
 * likewise an admin action.
 */
const adminOrAboveField: FieldAccess = ({ req }) =>
    ['super-admin', 'admin'].includes((req?.user as unknown as UserWithRole | undefined)?.role ?? '')

// ── Credential encryption hooks (reused by apiKey, apiSecret, webhookSecret) ──

async function encryptBeforeChange({ value, originalDoc, field, req }: { value: unknown; originalDoc?: Record<string, unknown>; field: { name: string }, req: any }) {
    if (typeof value === 'string' && value && !value.startsWith('••••')) {
        return encryptCredential(value)
    }
    if (typeof value === 'string' && value.startsWith('••••')) {
        // `previousDoc` is only ever populated in afterChange hooks — Payload's
        // own beforeChange field-hook invocation (fields/hooks/beforeChange/promise.js)
        // never passes it, only `originalDoc`. Using previousDoc here meant this
        // recovery path threw unconditionally on every resave of a document with
        // an already-encrypted field the admin didn't touch (e.g. re-saving after
        // OAuth connect populates oauthAccessToken/oauthClientSecret, then the
        // admin form resubmits their masked display values unchanged).
        if (!originalDoc?.id) {
            throw new Error(`Cannot save masked credential for ${field.name}. Please re-enter the API Key/Secret.`)
        }
        // originalDoc has already passed through afterRead hooks and is masked.
        // We must fetch the raw document from the database to restore the encrypted value.
        const rawConfig = await req.payload.findByID({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            id: originalDoc.id,
            depth: 0,
            overrideAccess: true,
            context: { preventMasking: true, skipAutoFetch: true },
        }) as Record<string, unknown>;
        
        // rawConfig has been decrypted by afterRead (due to preventMasking: true).
        // We must re-encrypt it to ensure it is stored encrypted.
        const decrypted = rawConfig[field.name];
        return decrypted && typeof decrypted === 'string' ? encryptCredential(decrypted) : value;
    }
    return value
}

function decryptAfterRead({ value, req, context }: { value: unknown; req: any; context?: Record<string, unknown> }) {
    if (typeof value !== 'string') return value
    const decrypted = decryptCredential(value)
    const ctx = req?.context || context || {}
    if (ctx.preventMasking) return decrypted
    if (req?.user && decrypted.length > 4) {
        return '••••' + decrypted.slice(-4)
    }
    return decrypted
}

// ── afterChange: auto-fetch companies when creds are saved ──

const autoFetchFromERPNext: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
    const erpnextUrl = doc.erpnextUrl as string | undefined
    if (!erpnextUrl) return doc

    // Skip auto-fetch when we already have data and are connected.
    // Always re-fetch on: create, disconnected/untested status, or empty company list.
    if (operation === 'update' && previousDoc) {
        const alreadyConnected = doc.connectionStatus === 'connected'
        const hasCompanies = Array.isArray(doc.availableCompanies)
            ? doc.availableCompanies.length > 0
            : false
        if (alreadyConnected && hasCompanies) {
            return doc // Already connected with data — skip re-fetch
        }
    }

    // getCredentials() branches correctly between api_key and oauth authMethod
    // (and transparently refreshes an expired OAuth token) — the previous
    // direct apiKey/apiSecret read here predated OAuth support and hardcoded
    // the api_key path, so a fresh OAuth-only connect silently never fetched
    // companies at all (no error, just a no-op return here, since apiKey/
    // apiSecret are never set for an OAuth connection).
    const siteRelation = doc.site as { id?: string | number; slug?: string } | string | number | null | undefined
    let siteSlug = typeof siteRelation === 'object' && siteRelation !== null ? siteRelation.slug : undefined
    if (!siteSlug) {
        const siteId = typeof siteRelation === 'object' && siteRelation !== null ? siteRelation.id : siteRelation
        if (siteId) {
            const siteDoc = await req.payload.findByID({
                collection: 'sites' as unknown as CollectionSlug,
                id: siteId,
                depth: 0,
                overrideAccess: true,
            }).catch(() => null)
            siteSlug = (siteDoc as unknown as { slug?: string } | null)?.slug
        }
    }
    if (!siteSlug) return doc

    const creds = await getCredentials(req.payload, siteSlug, req)
    if (!creds) return doc

    const normalizedUrl = creds.url
    if (process.env.NODE_ENV === 'production' && !normalizedUrl.startsWith('https://')) return doc

    const headers = authHeaders(creds)

    let companies: ERPNextCompany[] = []
    let connected = false

    try {
        // ── Fetch companies ────────────────────────────────────────
        const companiesRes = await fetch(
            `${normalizedUrl}/api/resource/Company?fields=["name","company_name","country","default_currency"]&limit_page_length=100`,
            { method: 'GET', headers, signal: AbortSignal.timeout(15000) },
        )

        if (companiesRes.ok) {
            const result = await companiesRes.json() as { data?: ERPNextCompany[] }
            companies = (result.data ?? []).map((c) => ({
                name: c.name,
                company_name: c.company_name,
                country: c.country || undefined,
                default_currency: c.default_currency || undefined,
            }))
            connected = true
        }

        // ── Persist fetched data on the document ───────────────────
        const now = new Date().toISOString()
        await req.payload.update({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            id: doc.id,
            data: {
                availableCompanies: companies,
                lastCompanyFetchAt: now,
                connectionStatus: connected ? 'connected' : 'disconnected',
            } as any,
            overrideAccess: true,
            // CRITICAL: prevent infinite loop — this update must NOT trigger afterChange again
            context: { skipAutoFetch: true },
        })

        req.payload.logger.info(
            `[ERPNextConfig] Auto-fetched ${companies.length} companies from ${normalizedUrl}`,
        )
    } catch (err) {
        req.payload.logger.warn(`[ERPNextConfig] Auto-fetch failed: ${err}`)

        // Mark as disconnected on failure
        try {
            await req.payload.update({
                collection: 'erpnext-config' as unknown as CollectionSlug,
                id: doc.id,
                data: { connectionStatus: 'disconnected' } as any,
                overrideAccess: true,
                context: { skipAutoFetch: true },
            })
        } catch { /* non-critical */ }
    }

    return doc
}

/**
 * ERPNextConfig
 *
 * Per-site ERPNext connection configuration.
 *
 * UX Flow:
 *   1. Tab "Connection" → enter URL + API Key + API Secret → Save
 *   2. afterChange hook auto-fetches companies from ERPNext
 *   3. Tab "ERPNext Settings" → select the company this site interacts with → Save
 *   4. Form submissions optionally auto-inject the selected company into ERPNext docs
 */
export const ERPNextConfig: CollectionConfig = {
    slug: 'erpnext-config',
    admin: {
        useAsTitle: 'label',
        defaultColumns: ['label', 'erpnextUrl', 'connectionStatus', 'erpnextCompany', 'isActive', 'createdAt'],
        group: 'Integrations',
    },
    access: {
        read: siteScopedRead(),
        create: siteScopedCreate(),
        update: siteScopedUpdate(),
        delete: siteScopedDelete(),
    },
    hooks: {
        afterChange: [
            (args) => {
                // Skip auto-fetch when the update itself is from auto-fetch (infinite loop guard)
                if ((args.context as Record<string, unknown>)?.skipAutoFetch) return args.doc

                // Fire-and-forget: don't block the save operation.
                // The fetch + update runs in the background; user refreshes to see results.
                // We intentionally do NOT await here to prevent PostgreSQL transaction deadlocks.
                // The 2s delay ensures the save transaction has fully committed before we
                // try to findByID the same document.
                const payload = args.req.payload
                const docRef = args.doc
                setTimeout(() => {
                    autoFetchFromERPNext({ ...args, doc: docRef }).catch((err: unknown) => {
                        payload.logger.error(`[ERPNextConfig] Background auto-fetch failed: ${err}`)
                    })
                }, 2000)

                return args.doc
            },
        ],
    },
    fields: [
        // ── Label + Site + Active (always visible, above tabs) ──────
        {
            name: 'label',
            type: 'text',
            required: true,
            admin: { description: 'Friendly name, e.g. "iVarse ERPNext"' },
        },
        {
            type: 'row',
            fields: [
                {
                    name: 'site',
                    type: 'relationship',
                    relationTo: 'sites',
                    required: true,
                    admin: {
                        description: 'The site this ERPNext config belongs to (one per site)',
                        width: '70%',
                    },
                },
                {
                    name: 'isActive',
                    type: 'checkbox',
                    defaultValue: true,
                    admin: { width: '30%' },
                },
            ],
        },
        organizationField(),

        // ═══════════════════════════════════════════════════════════
        //  TABS
        // ═══════════════════════════════════════════════════════════
        {
            type: 'tabs',
            tabs: [
                // ── Tab 1: Connection ────────────────────────────────
                {
                    label: '🔑 Connection',
                    description: 'Enter your ERPNext API credentials and save. Companies will be fetched automatically for tenant selection.',
                    fields: [
                        {
                            name: 'erpnextUrl',
                            type: 'text',
                            required: true,
                            access: {
                                create: adminOrAboveField,
                                update: adminOrAboveField,
                            },
                            admin: {
                                description: 'ERPNext instance URL (e.g. https://erp.ivarse.com)',
                            },
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'apiKey',
                                    type: 'text',
                                    // Deliberately optional, not just conditionally required. authMethod
                                    // is read-only and only ever flips to 'oauth' *after* a successful
                                    // OAuth callback — which itself requires this document to already
                                    // have an id (the Connect button only renders once saved). Gating
                                    // this field's requirement on authMethod === 'oauth' therefore made
                                    // the very first save of a brand-new OAuth-only config impossible:
                                    // authMethod could never be 'oauth' yet, so apiKey was always
                                    // required, so the document could never be saved, so Connect could
                                    // never appear. getCredentials() (erpnextProxy.ts) already fails
                                    // closed with a clear "not configured" error at USE time if neither
                                    // manual credentials nor a completed OAuth connection exist, so
                                    // nothing needs to be enforced here at save time.
                                    access: {
                                        create: adminOrAboveField,
                                        update: adminOrAboveField,
                                    },
                                    admin: {
                                        description: 'ERPNext API Key (from User → API Access) — only needed for manual authentication, see Connect via OAuth below.',
                                        width: '50%',
                                    },
                                    hooks: {
                                        beforeChange: [
                                            async ({ value, originalDoc, req }) =>
                                                await encryptBeforeChange({ value, originalDoc, field: { name: 'apiKey' }, req }),
                                        ],
                                        afterRead: [
                                            ({ value, req, context }) =>
                                                decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                        ],
                                    },
                                },
                                {
                                    name: 'apiSecret',
                                    type: 'text',
                                    // See apiKey's comment above — same deliberately-optional reasoning.
                                    access: {
                                        create: adminOrAboveField,
                                        update: adminOrAboveField,
                                    },
                                    admin: {
                                        description: 'ERPNext API Secret — only needed for manual authentication, see Connect via OAuth below.',
                                        width: '50%',
                                    },
                                    hooks: {
                                        beforeChange: [
                                            async ({ value, originalDoc, req }) =>
                                                await encryptBeforeChange({ value, originalDoc, field: { name: 'apiSecret' }, req }),
                                        ],
                                        afterRead: [
                                            ({ value, req, context }) =>
                                                decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            name: 'authMethod',
                            type: 'select',
                            defaultValue: 'api_key',
                            options: [
                                { label: 'Manual (API Key/Secret above)', value: 'api_key' },
                                { label: 'Connected via OAuth2', value: 'oauth' },
                            ],
                            admin: {
                                description: 'Set automatically by the Connect via OAuth flow below — informational only, does not change how credentials are used.',
                                readOnly: true,
                            },
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'oauthClientId',
                                    type: 'text',
                                    admin: {
                                        description: 'Set automatically by the Connect via OAuth flow below — no manual setup in ERPNext needed.',
                                        readOnly: true,
                                        width: '50%',
                                    },
                                },
                                {
                                    name: 'oauthClientSecret',
                                    type: 'text',
                                    access: { create: adminOrAboveField, update: adminOrAboveField },
                                    admin: { description: 'Set automatically by the Connect via OAuth flow below.', readOnly: true, width: '50%' },
                                    hooks: {
                                        beforeChange: [
                                            async ({ value, originalDoc, req }) =>
                                                await encryptBeforeChange({ value, originalDoc, field: { name: 'oauthClientSecret' }, req }),
                                        ],
                                        afterRead: [
                                            ({ value, req, context }) =>
                                                decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            name: 'erpnextConnectPanel',
                            type: 'ui',
                            admin: {
                                components: {
                                    Field: {
                                        path: 'payload-erpnext-plugin/components/ERPNextConnectPanel',
                                        exportName: 'ERPNextConnectPanelField',
                                    },
                                },
                            },
                        },
                        {
                            name: 'oauthAccessToken',
                            type: 'text',
                            admin: { hidden: true, description: 'Internal — OAuth2 access token, set by Connect via OAuth.' },
                            hooks: {
                                beforeChange: [
                                    async ({ value, originalDoc, req }) =>
                                        await encryptBeforeChange({ value, originalDoc, field: { name: 'oauthAccessToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                        {
                            name: 'oauthRefreshToken',
                            type: 'text',
                            admin: { hidden: true, description: 'Internal — OAuth2 refresh token, used to silently renew an expired access token.' },
                            hooks: {
                                beforeChange: [
                                    async ({ value, originalDoc, req }) =>
                                        await encryptBeforeChange({ value, originalDoc, field: { name: 'oauthRefreshToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                        {
                            name: 'oauthExpiresAt',
                            type: 'text',
                            admin: { hidden: true, description: 'Internal — ISO timestamp the current OAuth access token expires at.' },
                        },
                        // Connection status (read-only feedback)
                        {
                            name: 'connectionStatus',
                            type: 'select',
                            defaultValue: 'untested',
                            options: [
                                { label: '✅ Connected', value: 'connected' },
                                { label: '❌ Disconnected', value: 'disconnected' },
                                { label: '⏳ Untested', value: 'untested' },
                            ],
                            admin: {
                                description: 'Connection health — updated automatically when you save.',
                                readOnly: true,
                            },
                        },
                    ],
                },

                // ── Tab 2: ERPNext Settings ──────────────────────────
                {
                    label: '🏢 ERPNext Settings',
                    description: 'Select the ERPNext company this site interacts with. The company list is auto-populated after saving credentials.',
                    fields: [
                        // Company dropdown — custom component fetches data from API
                        {
                            name: 'erpnextCompany',
                            type: 'text',
                            admin: {
                                description: 'Company selected for this site.',
                                components: {
                                    Field: {
                                        path: 'payload-erpnext-plugin/components/CompanySelect',
                                        exportName: 'CompanySelectField',
                                    },
                                },
                            },
                        },
                        {
                            name: 'autoInjectCompany',
                            type: 'checkbox',
                            defaultValue: true,
                            admin: {
                                description: 'Automatically inject the selected company into company-aware ERPNext submissions from this site.',
                            },
                        },
                        // Hidden data stores — not shown in UI, used by API only
                        { name: 'availableCompanies', type: 'json', admin: { hidden: true } },
                        { name: 'lastCompanyFetchAt', type: 'date', admin: { hidden: true } },
                    ],
                },

                // ── Tab 3: Inbound Webhooks ──────────────────────────
                // (Formerly also had a "🗂 Mapping" tab for defaultDocType/customDocType/
                // fieldMappings — that entire tab only ever fed forwardToERPNext.ts, the old
                // outbound form-submission-to-ERPNext flow. That hook no longer exists in the
                // codebase and isn't wired into payload.config.ts; confirmed zero runtime
                // references to any of those three fields. Removed rather than left as dead
                // schema — see the matching migration dropping the orphaned columns.
                //
                // This tab also used to carry webhookDocType/webhookTargetCollection/
                // webhookTargetKeyField/webhookStatusField/webhookNotifyField/
                // webhookCustomerGroupField/webhookCompletedCustomerGroup/erpnextStatusMappings,
                // backing the now-deleted erpnextWebhook.ts endpoint. That design could only
                // express ONE DocType->collection mapping per site (single active config,
                // limit:1, no doctype check against the incoming payload) — a real site needs
                // several DocTypes syncing at once, which ERPNextSyncRules already supported
                // correctly (one row per DocType, all active rules applied). Confirmed unused
                // platform-wide (no seed path ever set these fields; the endpoint failed
                // closed 403 for every site) and its notification template/delay fields were
                // dead code even when "configured" (delayMinutes only stamped an unread
                // timestamp; template was captured but never dispatched). Status mapping and
                // customer-group promotion — the genuinely useful parts — now live as optional
                // per-rule fields on ERPNextSyncRules instead.
                {
                    label: '🔔 Webhooks',
                    description: 'Shared secret for inbound ERPNext webhooks. What gets synced (DocType, target collection, field mappings, status mapping, customer-group promotion) is defined entirely in the ERPNext Sync Rules collection — one or more rules per site, one per DocType.',
                    fields: [
                        {
                            name: 'webhookSecret',
                            type: 'text',
                            admin: {
                                description: 'HMAC-SHA256 secret for verifying inbound ERPNext webhooks. Set in ERPNext → Webhook → Secret. Point ERPNext webhooks at POST /api/erpnext-sync?site=<your-site-slug>.',
                            },
                            hooks: {
                                beforeChange: [
                                    async ({ value, originalDoc, req }) =>
                                        await encryptBeforeChange({ value, originalDoc, field: { name: 'webhookSecret' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                    ],
                },
            ],
        },
    ],
    timestamps: true,
}
