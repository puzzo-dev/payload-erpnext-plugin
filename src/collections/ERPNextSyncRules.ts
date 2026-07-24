import type { CollectionConfig, CollectionAfterChangeHook, CollectionSlug } from 'payload'
import {
    siteScopedCreate, siteScopedDelete, siteScopedRead, siteScopedUpdate
} from '../access/roles'
import { organizationField } from '../fields/organizationField'
import { getCredentials } from '../endpoints/erpnextProxy'
import { validateErpUrl } from '../utils/ssrfGuard'
import { backfillSyncRule, type ERPNextSyncRule } from '../sync/runSyncRule'

const SYNC_RULES_SLUG = 'erpnext-sync-rules' as unknown as CollectionSlug

/**
 * afterChange: when an active rule is saved with "backfill on save" ticked, pull all
 * existing records of its DocType from ERPNext and upsert them into the target
 * collection. Fire-and-forget (like ERPNextConfig's auto-fetch) so the save isn't
 * blocked, and guarded against re-entry via `context.skipBackfill`.
 */
const backfillOnSaveHook: CollectionAfterChangeHook = async ({ doc, req, context }) => {
    if ((context as Record<string, unknown>)?.skipBackfill) return doc
    const rule = doc as unknown as ERPNextSyncRule
    if (!rule.isActive || !rule.backfillOnSave) return doc

    const payload = req.payload
    setTimeout(() => {
        void (async () => {
            const log = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
                const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
                payload.logger[level](`[ERPNext-SyncRule] ${msg}${metaStr}`)
            }
            try {
                const siteId = typeof rule.site === 'object' && rule.site !== null ? rule.site.id : rule.site
                const siteDoc = await payload.findByID({ collection: 'sites', id: siteId, depth: 0, overrideAccess: true })
                const siteSlug = (siteDoc as Record<string, unknown>)?.slug as string | undefined
                const creds = await getCredentials(payload, siteSlug, req)
                if (!creds) {
                    log('warn', 'No active ERPNext credentials for site — skipping backfill', { siteSlug })
                    return
                }
                const safeUrl = await validateErpUrl(creds.url)
                if (!safeUrl) {
                    log('warn', 'ERPNext URL failed SSRF validation — skipping backfill', { siteSlug })
                    return
                }
                creds.url = safeUrl
                const stats = await backfillSyncRule(req, rule, creds, log)
                await payload.update({
                    collection: SYNC_RULES_SLUG,
                    id: rule.id,
                    data: { lastBackfillAt: new Date().toISOString(), lastBackfillStats: stats } as never,
                    overrideAccess: true,
                    context: { skipBackfill: true },
                    req,
                })
            } catch (err) {
                log('error', `Backfill failed: ${err}`)
            }
        })()
    }, 2000)

    return doc
}

/**
 * ERPNextSyncRules
 *
 * Owner-declared inbound sync configuration. Each rule maps ONE ERPNext DocType to
 * ONE Payload collection with a field map and an upsert key. This is the ONLY place
 * that decides what ERPNext data flows into Payload — the plugin ships no hardcoded
 * doctype handlers. Two mechanisms feed the same mapping logic:
 *   1. ERPNext-side webhooks (fire on save) → POST /api/erpnext-sync?site=<slug>
 *   2. Backfill on save (pulls pre-existing ERPNext records — no trigger needed)
 */
export const ERPNextSyncRules: CollectionConfig = {
    slug: 'erpnext-sync-rules',
    admin: {
        useAsTitle: 'label',
        defaultColumns: ['label', 'doctype', 'targetCollection', 'isActive', 'lastBackfillAt'],
        group: 'Integrations',
        description: 'Map ERPNext DocTypes to Payload collections. Inbound sync is driven entirely by these rules.',
    },
    access: {
        read: siteScopedRead(),
        create: siteScopedCreate(),
        update: siteScopedUpdate(),
        delete: siteScopedDelete(),
    },
    hooks: {
        afterChange: [backfillOnSaveHook],
    },
    fields: [
        {
            name: 'label',
            type: 'text',
            required: true,
            admin: { description: 'Friendly name, e.g. "Items → Catalogue"' },
        },
        {
            type: 'row',
            fields: [
                {
                    name: 'site',
                    type: 'relationship',
                    relationTo: 'sites',
                    required: true,
                    admin: { description: 'The site this rule belongs to.', width: '70%' },
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
        {
            type: 'tabs',
            tabs: [
                // ── Tab 1: what syncs, and how one ERPNext record is matched to one Payload doc ──
                {
                    label: '🔗 Mapping',
                    description: 'Which ERPNext DocType feeds which Payload collection. The unique key used to match an incoming ERPNext record to an existing Payload document is set on the Field Mappings tab — tick "Use as unique key" on the row for whichever field should identify a record.',
                    fields: [
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'doctype',
                                    type: 'text',
                                    required: true,
                                    label: 'ERPNext DocType',
                                    admin: {
                                        description: 'Source DocType in ERPNext (e.g. Item, Pricing Rule).',
                                        width: '50%',
                                        components: {
                                            Field: {
                                                path: 'payload-erpnext-plugin/components/ERPNextDocTypeSelect',
                                                exportName: 'ERPNextDocTypeSelect',
                                            },
                                        },
                                    },
                                },
                                {
                                    name: 'targetCollection',
                                    type: 'text',
                                    required: true,
                                    label: 'Payload Collection',
                                    admin: {
                                        description: 'Destination collection in Payload (e.g. catalogue-items, insights).',
                                        width: '50%',
                                        components: {
                                            Field: {
                                                path: 'payload-erpnext-plugin/components/CmsCollectionSelect',
                                                exportName: 'CmsCollectionSelect',
                                            },
                                        },
                                    },
                                },
                            ],
                        },
                    ],
                },
                // ── Tab 2: the actual per-field data copy, separate from the one-time identity/key setup above ──
                {
                    label: '🗺️ Field Mappings',
                    description: 'For every ERPNext field listed here, its value is copied verbatim into the paired Payload field (HTML is preserved). Add one row per field you want synced.',
                    fields: [
                        {
                            name: 'field_mappings',
                            type: 'array',
                            required: true,
                            minRows: 1,
                            label: 'Field Mappings',
                            labels: { singular: 'Field Mapping', plural: 'Field Mappings' },
                            admin: { description: 'ERPNext field (left) → Payload field (right). Tick "Use as unique key" on exactly one row — that field identifies a record, so re-syncing it updates the same Payload document instead of creating a duplicate.' },
                            validate: (rows: unknown) => {
                                const arr = (rows as Array<{ isUpsertKey?: boolean | null }> | undefined) ?? []
                                const keyRows = arr.filter((r) => r?.isUpsertKey)
                                if (keyRows.length === 0) return 'Exactly one row must be marked "Use as unique key".'
                                if (keyRows.length > 1) return `Only one row can be marked "Use as unique key" — found ${keyRows.length}.`
                                return true
                            },
                            fields: [
                                {
                                    type: 'row',
                                    fields: [
                                        {
                                            name: 'erp_field',
                                            type: 'text',
                                            required: true,
                                            label: 'ERPNext Field',
                                            admin: {
                                                width: '40%',
                                                components: {
                                                    Field: {
                                                        path: 'payload-erpnext-plugin/components/ERPNextTargetFieldSelect',
                                                        exportName: 'ERPNextTargetFieldSelect',
                                                    },
                                                },
                                            },
                                        },
                                        {
                                            name: 'payload_field',
                                            type: 'text',
                                            required: true,
                                            label: 'Payload Field',
                                            admin: {
                                                width: '40%',
                                                description: 'Payload field name in the target collection.',
                                                components: {
                                                    Field: {
                                                        path: 'payload-erpnext-plugin/components/CmsCollectionFieldSelect',
                                                        exportName: 'CmsCollectionFieldSelect',
                                                    },
                                                },
                                            },
                                        },
                                        {
                                            name: 'isUpsertKey',
                                            type: 'checkbox',
                                            defaultValue: false,
                                            label: 'Unique key',
                                            admin: {
                                                width: '20%',
                                                description: 'This field identifies a record.',
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            name: 'constant_values',
                            type: 'array',
                            label: 'Constant Values',
                            labels: { singular: 'Constant Value', plural: 'Constant Values' },
                            admin: {
                                description: 'Literal values written on every synced record, for required Payload fields ERPNext has no equivalent for (e.g. category, item_type). Applied after the field mappings above. For relationship fields, use the related document\'s ID as the value.',
                            },
                            fields: [
                                {
                                    type: 'row',
                                    fields: [
                                        {
                                            name: 'payload_field',
                                            type: 'text',
                                            required: true,
                                            label: 'Payload Field',
                                            admin: {
                                                width: '50%',
                                                components: {
                                                    Field: {
                                                        path: 'payload-erpnext-plugin/components/CmsCollectionFieldSelect',
                                                        exportName: 'CmsCollectionFieldSelect',
                                                    },
                                                },
                                            },
                                        },
                                        {
                                            name: 'value',
                                            type: 'text',
                                            required: true,
                                            label: 'Literal Value',
                                            admin: { width: '50%', description: 'Fixed value (relationship field → the related document ID).' },
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                // ── Tab 3: everything optional — filtering, status sync, customer-group promotion ──
                {
                    label: '⚙️ Advanced',
                    description: 'Optional: restrict which records sync, mirror an ERPNext status onto a Payload field, and promote customers to an ERPNext group on specific statuses.',
                    fields: [
                        {
                            name: 'filters',
                            type: 'json',
                            label: 'Backfill Filter (ERPNext REST filter JSON)',
                            admin: {
                                description: 'Controls which records the backfill pulls. Example: [["has_variants","=",0]] — only sellable items, skips variant templates. [["disabled","=",0]] — skips disabled records. Leave empty to sync everything. This does not affect the live webhook — set a matching Condition on the ERPNext Webhook for that.',
                            },
                        },
                        {
                            name: 'statusField',
                            type: 'text',
                            label: 'Status Sync — Payload Field',
                            admin: {
                                description: 'Payload field on the target collection to write the mapped status to (e.g. erp_sync_status). Leave blank to turn off status sync for this rule — the fields below only apply once this is set.',
                                components: {
                                    Field: {
                                        path: 'payload-erpnext-plugin/components/CmsCollectionFieldSelect',
                                        exportName: 'CmsCollectionFieldSelect',
                                    },
                                },
                            },
                        },
                        {
                            name: 'customerGroupField',
                            type: 'text',
                            label: 'Customer-Group Promotion — ERPNext Field',
                            admin: {
                                description: 'ERPNext field used to look up which customer to promote. Leave blank to turn off group promotion for every status mapping below.',
                                condition: (_data, siblingData) => Boolean(siblingData?.statusField),
                            },
                        },
                        {
                            name: 'statusMappings',
                            type: 'array',
                            label: 'Status Mappings',
                            labels: { singular: 'Status Mapping', plural: 'Status Mappings' },
                            admin: {
                                description: 'ERPNext status value → Payload status value, applied on every sync (webhook and backfill) when the record\'s "status" field matches one of these. Each row can optionally promote the customer to a different ERPNext group — it is not one fixed group for the whole rule.',
                                condition: (_data, siblingData) => Boolean(siblingData?.statusField),
                            },
                            fields: [
                                {
                                    type: 'row',
                                    fields: [
                                        {
                                            name: 'erpStatus',
                                            type: 'text',
                                            required: true,
                                            label: 'ERPNext Status',
                                            admin: { width: '34%', description: 'e.g. Completed' },
                                        },
                                        {
                                            name: 'payloadStatus',
                                            type: 'text',
                                            required: true,
                                            label: 'Payload Status',
                                            admin: { width: '33%', description: 'e.g. synced' },
                                        },
                                        {
                                            name: 'customerGroup',
                                            type: 'text',
                                            label: 'Promote To Group',
                                            admin: {
                                                width: '33%',
                                                description: 'Optional. Leave blank for no promotion on this status.',
                                                condition: (data) => Boolean((data as Record<string, unknown>)?.customerGroupField),
                                                components: {
                                                    Field: {
                                                        path: 'payload-erpnext-plugin/components/ERPNextCustomerGroupSelect',
                                                        exportName: 'ERPNextCustomerGroupSelect',
                                                    },
                                                },
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                // ── Tab 4: initial data pull + its results, separate from the ongoing mapping config ──
                {
                    label: '📥 Backfill',
                    description: 'One-time (or on-demand) pull of pre-existing ERPNext records — the live webhook only fires for future saves in ERPNext, so this is what populates Payload with what already exists.',
                    fields: [
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'backfillOnSave',
                                    type: 'checkbox',
                                    defaultValue: true,
                                    label: 'Run backfill when this rule is saved',
                                    admin: {
                                        description: 'Pulls every existing ERPNext record of this DocType and upserts it into the target collection.',
                                        width: '50%',
                                    },
                                },
                                {
                                    name: 'lastBackfillAt',
                                    type: 'date',
                                    label: 'Last Backfill Ran At',
                                    admin: {
                                        readOnly: true,
                                        width: '50%',
                                        date: { pickerAppearance: 'dayAndTime' },
                                    },
                                },
                            ],
                        },
                        {
                            name: 'lastBackfillStats',
                            type: 'json',
                            label: 'Last Backfill Result',
                            admin: { readOnly: true, description: 'Counts and any errors from the most recent backfill run.' },
                        },
                    ],
                },
            ],
        },
    ],
    timestamps: true,
}
