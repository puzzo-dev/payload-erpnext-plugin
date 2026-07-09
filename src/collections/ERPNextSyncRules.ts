import type { CollectionConfig, CollectionAfterChangeHook, CollectionSlug } from 'payload'
import {
    siteScopedCreate, siteScopedDelete, siteScopedRead, siteScopedUpdate
} from '../access/roles'
import { organizationField } from '../fields/organizationField'
import { getCredentials } from '../endpoints/erpnextProxy'
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
                const stats = await backfillSyncRule(req, rule, creds, log)
                await payload.update({
                    collection: SYNC_RULES_SLUG,
                    id: rule.id,
                    data: { lastBackfillAt: new Date().toISOString(), lastBackfillStats: stats } as never,
                    overrideAccess: true,
                    context: { skipBackfill: true },
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
            type: 'row',
            fields: [
                {
                    name: 'doctype',
                    type: 'text',
                    required: true,
                    admin: {
                        description: 'ERPNext DocType to sync from (e.g. Item, Pricing Rule).',
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
                    admin: {
                        description: 'Payload collection to sync into (e.g. catalogue-items, insights).',
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
        {
            type: 'row',
            fields: [
                {
                    name: 'upsert_erp_field',
                    type: 'text',
                    required: true,
                    defaultValue: 'name',
                    admin: {
                        description: 'ERPNext field used as the unique key (e.g. name, item_code).',
                        width: '50%',
                        components: {
                            Field: {
                                path: 'payload-erpnext-plugin/components/ERPNextTargetFieldSelect',
                                exportName: 'ERPNextTargetFieldSelect',
                            },
                        },
                    },
                },
                {
                    name: 'upsert_payload_field',
                    type: 'text',
                    required: true,
                    admin: {
                        description: 'Payload field that stores the ERPNext key (e.g. erp_item_code). Used to match existing docs.',
                        width: '50%',
                        components: {
                            Field: {
                                path: 'payload-erpnext-plugin/components/CmsCollectionFieldSelect',
                                exportName: 'CmsCollectionFieldSelect',
                            },
                        },
                    },
                },
            ],
        },
        {
            name: 'filters',
            type: 'json',
            admin: {
                description: 'Optional ERPNext filter (raw REST filter JSON) applied to the backfill query — controls WHICH records sync. e.g. [["has_variants","=",0]] pulls only sellable items (skips variant templates); [["disabled","=",0]] skips disabled. Leave empty to sync all. For the live webhook, set the matching Condition on the ERPNext Webhook.',
            },
        },
        {
            name: 'field_mappings',
            type: 'array',
            required: true,
            minRows: 1,
            labels: { singular: 'Field Mapping', plural: 'Field Mappings' },
            admin: { description: 'ERPNext field → Payload field. Values are copied verbatim (HTML is preserved).' },
            fields: [
                {
                    type: 'row',
                    fields: [
                        {
                            name: 'erp_field',
                            type: 'text',
                            required: true,
                            admin: {
                                width: '50%',
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
                            admin: {
                                width: '50%',
                                description: 'Payload field name in the target collection.',
                                components: {
                                    Field: {
                                        path: 'payload-erpnext-plugin/components/CmsCollectionFieldSelect',
                                        exportName: 'CmsCollectionFieldSelect',
                                    },
                                },
                            },
                        },
                    ],
                },
            ],
        },
        {
            name: 'constant_values',
            type: 'array',
            labels: { singular: 'Constant Value', plural: 'Constant Values' },
            admin: {
                description: 'Literal values set on every synced record for required target fields the ERP does not carry (e.g. category, item_type). Applied after field mappings. For relationship fields use the related document ID.',
            },
            fields: [
                {
                    type: 'row',
                    fields: [
                        {
                            name: 'payload_field',
                            type: 'text',
                            required: true,
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
                            admin: { width: '50%', description: 'Literal value (relationship → the related document ID).' },
                        },
                    ],
                },
            ],
        },
        {
            type: 'row',
            fields: [
                {
                    name: 'backfillOnSave',
                    type: 'checkbox',
                    defaultValue: true,
                    admin: {
                        description: 'Pull all existing ERPNext records of this DocType when this rule is saved.',
                        width: '50%',
                    },
                },
                {
                    name: 'lastBackfillAt',
                    type: 'date',
                    admin: {
                        readOnly: true,
                        width: '50%',
                        date: { pickerAppearance: 'dayAndTime' },
                    },
                },
            ],
        },
        { name: 'lastBackfillStats', type: 'json', admin: { readOnly: true, description: 'Result of the last backfill run.' } },
    ],
    timestamps: true,
}
