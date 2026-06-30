import type { Plugin } from 'payload'
import { ERPNextConfig } from './collections/ERPNextConfig'
import { ERPNextDeadLetter } from './collections/ERPNextDeadLetter'
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
import { retryDeadLettersEndpoint } from './endpoints/retryDeadLetters'
import { erpGetHandler, erpPostHandler, erpPatchHandler, erpDeleteHandler } from './actions/erpActions'

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
     * External afterChange hooks to be appended to the erpnext-config collection.
     * Use this from the CMS to add connection monitoring without creating a circular
     * dependency (e.g. pass `erpnextConnectionMonitorHook` from the CMS).
     */
    erpnextConfigHooks?: {
        afterChange?: ((args: any) => any)[]
    }
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
            retryDeadLettersEndpoint,
        ]

        if (enableAnonymousUpload) {
            endpoints.push(anonymousUploadEndpoint)
        }

        // Inject external afterChange hooks into ERPNextConfig (e.g. connection monitor)
        const erpnextConfigCollection = options.erpnextConfigHooks?.afterChange?.length
            ? {
                ...ERPNextConfig,
                hooks: {
                    ...ERPNextConfig.hooks,
                    afterChange: [
                        ...(ERPNextConfig.hooks?.afterChange ?? []),
                        ...options.erpnextConfigHooks.afterChange,
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
            collections: [...modifiedCollections, erpnextConfigCollection, ERPNextDeadLetter],
            endpoints,
        }
    }
}

export { getCredentials, authHeaders } from './endpoints/erpnextProxy'
export type { ERPNextCredentials } from './types'

/**
 * Verify an ERPNext HMAC-SHA256 webhook signature in constant time.
 *
 * ERPNext/Frappe sends:
 *   - `X-ERPNext-Signature`: hex digest  (standard ERPNext webhook)
 *   - `X-Frappe-Webhook-Signature`: base64 digest  (OpsCloud / custom Frappe apps)
 *
 * @param rawBody   - raw request body string (before JSON.parse)
 * @param signature - value of the signature header (hex or base64)
 * @param secret    - shared HMAC secret
 * @param encoding  - 'hex' (default) or 'base64'
 */
export function verifyERPNextWebhookSignature(
    rawBody: string,
    signature: string,
    secret: string,
    encoding: 'hex' | 'base64' = 'hex',
): boolean {
    // Import is deferred to avoid forcing a crypto import at module init time.
    const { createHmac, timingSafeEqual } = require('node:crypto') as typeof import('node:crypto')
    const expected = createHmac('sha256', secret).update(rawBody).digest(encoding)
    if (expected.length !== signature.length) return false
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}
