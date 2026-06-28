import type { CollectionConfig, CollectionAfterChangeHook, CollectionSlug } from 'payload'
import {
    siteScopedCreate, siteScopedDelete, siteScopedRead, siteScopedUpdate
} from '../access/roles';
import { organizationField } from '../fields/organizationField';
import { encryptCredential, decryptCredential } from '../utils/erpnextCrypto';
import type { ERPNextCompany, ERPNextLeadSource } from '../types';

// ── Credential encryption hooks (reused by apiKey, apiSecret, webhookSecret) ──

async function encryptBeforeChange({ value, previousDoc, field, req }: { value: unknown; previousDoc?: Record<string, unknown>; field: { name: string }, req: any }) {
    if (typeof value === 'string' && value && !value.startsWith('••••')) {
        return encryptCredential(value)
    }
    if (typeof value === 'string' && value.startsWith('••••')) {
        if (!previousDoc?.id) {
            throw new Error(`Cannot save masked credential for ${field.name}. Please re-enter the API Key/Secret.`)
        }
        // previousDoc has already passed through afterRead hooks and is masked.
        // We must fetch the raw document from the database to restore the encrypted value.
        const rawConfig = await req.payload.findByID({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            id: previousDoc.id,
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

// ── afterChange: auto-fetch companies + lead sources when creds are saved ──

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

    // CRITICAL: The `doc` passed to afterChange has already been through afterRead
    // hooks, which MASK apiKey/apiSecret for logged-in users (e.g. "••••xxxx").
    // We must re-fetch with preventMasking to get the real credentials.
    const rawConfig = await req.payload.findByID({
        collection: 'erpnext-config' as unknown as CollectionSlug,
        id: doc.id,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true, skipAutoFetch: true },
    }) as unknown as Record<string, unknown>

    const apiKey = rawConfig.apiKey as string | undefined
    const apiSecret = rawConfig.apiSecret as string | undefined

    if (!apiKey || !apiSecret) return doc

    // Decrypt credentials (stored encrypted in DB)
    const decryptedKey = decryptCredential(apiKey)
    const decryptedSecret = decryptCredential(apiSecret)

    if (!decryptedKey || !decryptedSecret) return doc

    const normalizedUrl = erpnextUrl.replace(/\/+$/, '')
    if (!normalizedUrl.startsWith('https://')) return doc

    const headers = {
        'Content-Type': 'application/json',
        Authorization: `token ${decryptedKey}:${decryptedSecret}`,
    }

    let companies: ERPNextCompany[] = []
    let leadSources: ERPNextLeadSource[] = []
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

        // ── Fetch lead sources ─────────────────────────────────────
        const leadSourcesRes = await fetch(
            `${normalizedUrl}/api/resource/Lead%20Source?fields=["name","source_name"]&limit_page_length=100`,
            { method: 'GET', headers, signal: AbortSignal.timeout(15000) },
        )

        if (leadSourcesRes.ok) {
            const result = await leadSourcesRes.json() as { data?: ERPNextLeadSource[] }
            leadSources = (result.data ?? []).map((ls) => ({
                name: ls.name,
                source_name: ls.source_name,
            }))
        }

        // ── Persist fetched data on the document ───────────────────
        const now = new Date().toISOString()
        await req.payload.update({
            collection: 'erpnext-config' as unknown as CollectionSlug,
            id: doc.id,
            data: {
                availableCompanies: companies,
                lastCompanyFetchAt: now,
                availableLeadSources: leadSources,
                lastLeadSourceFetchAt: now,
                connectionStatus: connected ? 'connected' : 'disconnected',
            } as any,
            overrideAccess: true,
            // CRITICAL: prevent infinite loop — this update must NOT trigger afterChange again
            context: { skipAutoFetch: true },
        })

        req.payload.logger.info(
            `[ERPNextConfig] Auto-fetched ${companies.length} companies and ${leadSources.length} lead sources from ${normalizedUrl}`,
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
 *   2. afterChange hook auto-fetches companies & lead sources from ERPNext
 *   3. Tab "ERPNext Settings" → select company & lead source from dropdowns → Save
 *   4. All form submissions auto-inject company + source fields into ERPNext docs
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
        create: siteScopedCreate,
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
                    description: 'Enter your ERPNext API credentials and save. Companies and Lead Sources will be fetched automatically.',
                    fields: [
                        {
                            name: 'erpnextUrl',
                            type: 'text',
                            required: true,
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
                                    required: true,
                                    admin: {
                                        description: 'ERPNext API Key (from User → API Access)',
                                        width: '50%',
                                    },
                                    hooks: {
                                        beforeChange: [
                                            async ({ value, previousDoc, req }) =>
                                                await encryptBeforeChange({ value, previousDoc, field: { name: 'apiKey' }, req }),
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
                                    required: true,
                                    admin: {
                                        description: 'ERPNext API Secret',
                                        width: '50%',
                                    },
                                    hooks: {
                                        beforeChange: [
                                            async ({ value, previousDoc, req }) =>
                                                await encryptBeforeChange({ value, previousDoc, field: { name: 'apiSecret' }, req }),
                                        ],
                                        afterRead: [
                                            ({ value, req, context }) =>
                                                decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                        ],
                                    },
                                },
                            ],
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
                    description: 'Select the company and lead source for this site. These lists are auto-populated from ERPNext after saving credentials.',
                    fields: [
                        // Company dropdown — custom component fetches data from API
                        {
                            name: 'erpnextCompany',
                            type: 'text',
                            admin: {
                                description: 'Auto-injected into submissions for company-aware doctypes.',
                                components: {
                                    Field: {
                                        path: './components/CompanySelect/index',
                                        exportName: 'CompanySelectField',
                                    },
                                },
                            },
                        },
                        // Lead source dropdown — custom component fetches data from API
                        {
                            name: 'leadSource',
                            type: 'text',
                            admin: {
                                description: 'Auto-injected into Lead submissions as the "source" field.',
                                components: {
                                    Field: {
                                        path: './components/LeadSourceSelect/index',
                                        exportName: 'LeadSourceSelectField',
                                    },
                                },
                            },
                        },
                        // Hidden data stores — not shown in UI, used by API only
                        { name: 'availableCompanies', type: 'json', admin: { hidden: true } },
                        { name: 'lastCompanyFetchAt', type: 'date', admin: { hidden: true } },
                        { name: 'availableLeadSources', type: 'json', admin: { hidden: true } },
                        { name: 'lastLeadSourceFetchAt', type: 'date', admin: { hidden: true } },
                    ],
                },

                // ── Tab 3: DocType Mapping ───────────────────────────
                {
                    label: '🗂 Mapping',
                    description: 'Configure how Payload form submissions map to ERPNext document types.',
                    fields: [
                        {
                            name: 'defaultDocType',
                            type: 'text',
                            defaultValue: 'Lead',
                            admin: {
                                description: 'Default ERPNext DocType to create from form submissions. Fetched live from the connected ERPNext site.',
                                components: {
                                    Field: {
                                        path: './components/ERPNextDocTypeSelect/index',
                                        exportName: 'ERPNextDocTypeSelectField',
                                    },
                                },
                            },
                        },
                        {
                            name: 'customDocType',
                            type: 'text',
                            admin: {
                                description: 'Custom DocType name (use when the desired DocType is not in the fetched list)',
                                condition: (_data, siblingData) => !siblingData?.defaultDocType,
                            },
                        },
                        {
                            name: 'fieldMappings',
                            type: 'array',
                            admin: {
                                description: 'Map Payload form field names → ERPNext field names. Leave empty to send raw submission data.',
                            },
                            fields: [
                                {
                                    name: 'formFieldName',
                                    type: 'text',
                                    required: true,
                                    admin: { description: 'Payload form field name (e.g. "email", "name", "message")' },
                                },
                                {
                                    name: 'erpnextFieldName',
                                    type: 'text',
                                    required: true,
                                    admin: { description: 'ERPNext field name (e.g. "email_id", "lead_name", "notes")' },
                                },
                            ],
                        },
                    ],
                },

                // ── Tab 4: Inbound Webhooks ──────────────────────────
                {
                    label: '🔔 Webhooks',
                    description: 'Configure inbound webhooks from ERPNext to Payload.',
                    fields: [
                        {
                            name: 'webhookSecret',
                            type: 'text',
                            admin: {
                                description: 'HMAC-SHA256 secret for verifying inbound ERPNext webhooks. Set in ERPNext → Webhook → Secret.',
                            },
                            hooks: {
                                beforeChange: [
                                    async ({ value, previousDoc, req }) =>
                                        await encryptBeforeChange({ value, previousDoc, field: { name: 'webhookSecret' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                        {
                            name: 'syncCollections',
                            type: 'select',
                            hasMany: true,
                            defaultValue: ['insights'],
                            options: [
                                { label: 'Insights (Blog Posts)', value: 'insights' },
                            ],
                            admin: { description: 'Which Payload collections should accept data from ERPNext webhooks (Jobs are fetched directly via proxy)' },
                        },
                    ],
                },
            ],
        },
    ],
    timestamps: true,
}
