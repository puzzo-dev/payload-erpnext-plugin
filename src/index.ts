import type { Plugin } from 'payload'
import { ERPNextConfig } from './collections/ERPNextConfig'
import { ERPNextDeadLetter } from './collections/ERPNextDeadLetter'
import { ERPNextSyncRules } from './collections/ERPNextSyncRules'
import { anonymousUploadEndpoint } from './endpoints/anonymousUpload'
import {
    erpnextProxySubmit,
    erpnextProxyResource,
    erpnextProxyHealth,
    erpnextProxyUpload,
} from './endpoints/erpnextProxy'
import { fetchCompaniesEndpoint } from './endpoints/fetchCompanies'
import { fetchDocTypesEndpoint } from './endpoints/fetchDocTypes'
import { fetchDocTypeFieldsEndpoint } from './endpoints/fetchDocTypeFields'
import { fetchLeadSourcesEndpoint } from './endpoints/fetchLeadSources'
import { fetchCmsCollectionsEndpoint } from './endpoints/fetchCmsCollections'
import { fetchCmsCollectionFieldsEndpoint } from './endpoints/fetchCmsCollectionFields'
import { retryDeadLettersEndpoint } from './endpoints/retryDeadLetters'
import { syncFromERPNextEndpoint } from './endpoints/syncFromERPNext'
import { opscloudWebhookEndpoint } from './endpoints/opscloudWebhook'
import { erpGetHandler, erpPostHandler, erpPatchHandler, erpDeleteHandler } from './actions/erpActions'
import { createConnectionMonitorHook } from './hooks/connectionMonitor'
import { createLinkErpnextCustomerEndpoint } from './endpoints/linkErpnextCustomer'
import type { ERPNextHostBindings } from './types'

/** Minimal interface for the CMS action registry. The plugin registers into it without importing the full CMS type. */
export interface ActionRegistryRef {
    register: (slug: string, handler: (ctx: any) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>) => void
}

export interface ERPNextPluginOptions {
    /** Disable the anonymous file upload endpoint if you handle files elsewhere */
    enableAnonymousUpload?: boolean
    /**
     * CMS action registry — pass `actionRegistry` from `payload-cms/src/lib/actionRegistry`.
     * When provided, the plugin registers all ERP CRUD actions so they can be invoked by
     * the workflow engine.
     */
    registry?: ActionRegistryRef
    /**
     * Host automation primitives (dependency injection). The plugin owns all ERP
     * code but the automation engine lives in the CMS, so the host passes in the
     * functions the plugin needs — keeping the plugin free of any back-import into
     * payload-cms and the workflow engine fully functional with ERP absent.
     *  - `emitSystemEvent` + `systemEvents` → enables ERPNext connection monitoring
     *  - `isInternalAuth` → enables the customer→ERPNext link endpoint
     */
    host?: ERPNextHostBindings
}

/**
 * ERPNext Plugin for Payload CMS
 *
 * Provides:
 *  - ERPNext connection configuration (per site)
 *  - generic erp-get/erp-post/erp-patch/erp-delete actions for the CMS
 *    automation engine's Workflows collection (trigger_erp blocks)
 *  - Dead-letter queue for failed forwards
 *  - Anonymous file upload endpoint for form attachments
 *  - ERPNext proxy endpoints
 *
 * Form-submission-to-ERPNext forwarding is handled by the host app's own
 * Workflows (trigger: collection_change, collections: ['form-submissions']) —
 * not by this plugin. The plugin previously shipped a parallel form-workflow
 * forwarder (forwardToERPNext/ERPNextFormWorkflows); it was removed since it
 * duplicated the CMS automation engine.
 */
export function erpnextPlugin(options: ERPNextPluginOptions = {}): Plugin {
    const enableAnonymousUpload = options.enableAnonymousUpload !== false

    // Register all ERP actions into the CMS workflow engine's action registry.
    // This runs at plugin load time (before any requests), so all handlers are
    // available before the first dispatchWebhook job fires.
    if (options.registry) {
        const r = options.registry
        r.register('erp-get', erpGetHandler)
        r.register('erp-post', erpPostHandler)
        r.register('erp-patch', erpPatchHandler)
        r.register('erp-delete', erpDeleteHandler)
    }

    return (config) => {
        const endpoints = [
            ...(config.endpoints || []),
            erpnextProxySubmit,
            erpnextProxyResource,
            erpnextProxyHealth,
            erpnextProxyUpload,
            fetchCompaniesEndpoint,
            fetchDocTypesEndpoint,
            fetchDocTypeFieldsEndpoint,
            fetchLeadSourcesEndpoint,
            // CMS introspection for sync-rule dropdowns (target collection + its fields).
            fetchCmsCollectionsEndpoint,
            fetchCmsCollectionFieldsEndpoint,
            retryDeadLettersEndpoint,
            // Inbound ERPNext/Frappe webhooks — the plugin owns all ERP ingress.
            syncFromERPNextEndpoint,
            opscloudWebhookEndpoint,
        ]

        if (enableAnonymousUpload) {
            endpoints.push(anonymousUploadEndpoint)
        }

        // customer→ERPNext link endpoint — needs the host internal-auth guard.
        if (options.host?.isInternalAuth) {
            endpoints.push(createLinkErpnextCustomerEndpoint(options.host.isInternalAuth))
        }

        // ERPNext connection monitoring — built from injected host primitives and
        // appended to the erpnext-config collection's afterChange. Enabled only when
        // the host provides emitSystemEvent + the ERPNEXT_CONNECTION_* event names.
        const emit = options.host?.emitSystemEvent
        const evts = options.host?.systemEvents
        const connectionMonitorHook = (emit && evts?.ERPNEXT_CONNECTION_FAILED && evts?.ERPNEXT_CONNECTION_RESTORED)
            ? createConnectionMonitorHook(emit, {
                ERPNEXT_CONNECTION_FAILED: evts.ERPNEXT_CONNECTION_FAILED,
                ERPNEXT_CONNECTION_RESTORED: evts.ERPNEXT_CONNECTION_RESTORED,
            })
            : null
        const erpnextConfigCollection = connectionMonitorHook
            ? {
                ...ERPNextConfig,
                hooks: {
                    ...ERPNextConfig.hooks,
                    afterChange: [
                        ...(ERPNextConfig.hooks?.afterChange ?? []),
                        connectionMonitorHook,
                    ],
                },
            }
            : ERPNextConfig

        const modifiedCollections = (config.collections || []).map((collection) => {
            if (collection.slug === 'workflows') {
                const systemEventField = collection.fields.find((f: any) => f.name === 'system_event_name') as any
                if (systemEventField && systemEventField.type === 'select') {
                    systemEventField.options = [
                        ...(systemEventField.options || []),
                        { label: 'ERPNext Connection Failed', value: 'erpnext.connection.failed' },
                        { label: 'ERPNext Sync Failed', value: 'erpnext.sync.failed' },
                    ]
                }

                const stepsField = collection.fields.find((f: any) => f.name === 'steps') as any
                if (stepsField && stepsField.type === 'blocks') {
                    stepsField.blocks = [
                        ...(stepsField.blocks || []),
                        {
                            slug: 'trigger_erp',
                            labels: { singular: 'Trigger ERP Action', plural: 'Trigger ERP Actions' },
                            fields: [
                                { 
                                    name: 'doctype', 
                                    type: 'text', 
                                    required: true, 
                                    admin: { 
                                        description: 'ERPNext DocType (e.g. Customer, Sales Order)',
                                        components: { Field: 'payload-erpnext-plugin/components/ERPNextDocTypeSelect' }
                                    } 
                                },
                                { 
                                    name: 'action', 
                                    type: 'select', 
                                    required: true, 
                                    options: [
                                        { label: 'Read / Search (GET)', value: 'GET' },
                                        { label: 'Create (POST)', value: 'POST' },
                                        { label: 'Update (PUT)', value: 'PUT' },
                                        { label: 'Delete (DELETE)', value: 'DELETE' }
                                    ]
                                },
                                {
                                    name: 'result_key',
                                    type: 'text',
                                    defaultValue: 'erp',
                                    admin: {
                                        description: 'Prefix for this step\'s output context keys (e.g. "erp" → {{erp_name}}, {{erp_result}}). Use a distinct prefix per step when a workflow calls ERPNext more than once, so a later step doesn\'t overwrite an earlier one\'s result.',
                                    },
                                },
                                {
                                    name: 'field_mapping',
                                    type: 'array',
                                    labels: { singular: 'Field Mapping', plural: 'Field Mappings' },
                                    admin: {
                                        description: 'For GET: use "filters" and "fields" as the field names (ERPNext filter/fields JSON, supports {{var}}). For POST/PUT: ERPNext field name → value.',
                                    },
                                    fields: [
                                        {
                                            name: 'target_field',
                                            type: 'text',
                                            required: true,
                                            admin: {
                                                components: { Field: 'payload-erpnext-plugin/components/ERPNextTargetFieldSelect' }
                                            }
                                        },
                                        {
                                            name: 'source_field',
                                            type: 'text',
                                            required: true,
                                            admin: { description: 'Static value or variable (e.g. {{doc.status}})' }
                                        }
                                    ]
                                },
                            ],
                        }
                    ]
                }
            }
            return collection
        })

        return {
            ...config,
            collections: [...modifiedCollections, erpnextConfigCollection, ERPNextSyncRules, ERPNextDeadLetter],
            endpoints,
        }
    }
}

export { getCredentials, authHeaders } from './endpoints/erpnextProxy'
export { verifyERPNextWebhookSignature } from './utils/webhookSignature'
// Programmatic inbound-sync API (for scripts / manual "sync now" tooling).
export {
    backfillSyncRule,
    upsertErpRecord,
    deleteErpRecord,
    findRulesForDoctype,
    mapErpRecord,
    type ERPNextSyncRule,
} from './sync/runSyncRule'
export type { ERPNextCredentials } from './types'
