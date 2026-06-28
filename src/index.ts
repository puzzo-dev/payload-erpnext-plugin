import type { Plugin } from 'payload'
import { ERPNextConfig } from './collections/ERPNextConfig'
import { ERPNextDeadLetter } from './collections/ERPNextDeadLetter'
import { ERPNextFormWorkflows } from './collections/ERPNextFormWorkflows'
import { anonymousUploadEndpoint } from './endpoints/anonymousUpload'
import {
    erpnextProxySubmit,
    erpnextProxyResource,
    erpnextProxyHealth,
    erpnextProxyUpload,
} from './endpoints/erpnextProxy'
import { fetchCompaniesEndpoint } from './endpoints/fetchCompanies'
import { fetchDocTypesEndpoint } from './endpoints/fetchDocTypes'
import { fetchLeadSourcesEndpoint } from './endpoints/fetchLeadSources'
import { retryDeadLettersEndpoint } from './endpoints/retryDeadLetters'
import { forwardToERPNext } from './jobs/forwardToERPNext'

export interface ERPNextPluginOptions {
    /** Disable the anonymous file upload endpoint if you handle files elsewhere */
    enableAnonymousUpload?: boolean
}

/**
 * ERPNext Plugin for Payload CMS
 *
 * Provides:
 *  - ERPNext connection configuration (per site)
 *  - Multi-doctype form workflows
 *  - Dead-letter queue for failed forwards
 *  - Background Payload Job for async ERPNext forwarding
 *  - Anonymous file upload endpoint for form attachments
 *  - ERPNext proxy endpoints
 *
 * To enable automatic forwarding on form submissions, import the exported
 * `forwardToERPNext` hook and add it to your form-submission collection's
 * `afterChange` hooks. The plugin does not modify the form-submission
 * collection directly to avoid coupling with any specific form builder.
 */
export function erpnextPlugin(options: ERPNextPluginOptions = {}): Plugin {
    const enableAnonymousUpload = options.enableAnonymousUpload !== false

    return (config) => {
        const endpoints = [
            ...(config.endpoints || []),
            erpnextProxySubmit,
            erpnextProxyResource,
            erpnextProxyHealth,
            erpnextProxyUpload,
            fetchCompaniesEndpoint,
            fetchDocTypesEndpoint,
            fetchLeadSourcesEndpoint,
            retryDeadLettersEndpoint,
        ]

        if (enableAnonymousUpload) {
            endpoints.push(anonymousUploadEndpoint)
        }

        return {
            ...config,
            collections: [...(config.collections || []), ERPNextConfig, ERPNextFormWorkflows, ERPNextDeadLetter],
            endpoints,
            jobs: {
                ...(config.jobs || {}),
                tasks: [...(config.jobs?.tasks || []), forwardToERPNext as any],
            },
        }
    }
}

export { forwardToERPNext } from './hooks/forwardToERPNext'
export { executeERPNextWorkflows } from './lib/executeERPNextWorkflows'
export { forwardToERPNext as forwardToERPNextJob } from './jobs/forwardToERPNext'
export { enqueueForwardToERPNext } from './hooks/enqueueForwardToERPNext'
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
