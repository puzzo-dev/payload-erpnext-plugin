import { Endpoint, PayloadRequest, Plugin } from 'payload';

interface ERPNextCredentials {
    url: string;
    apiKey: string;
    apiSecret: string;
    company?: string;
    leadSource?: string;
}

/**
 * Resolve ERPNext credentials from the erpnext-config collection.
 * Looks up by site slug or site ID. Falls back to env vars for backward compatibility.
 */
declare function getCredentials(payload: Parameters<Endpoint['handler']>[0]['payload'], siteSlug?: string | null, req?: PayloadRequest): Promise<ERPNextCredentials | null>;
declare function authHeaders(creds: ERPNextCredentials): {
    'Content-Type': string;
    Authorization: string;
};

/** Minimal interface for the CMS action registry. The plugin registers into it without importing the full CMS type. */
interface ActionRegistryRef {
    register: (slug: string, handler: (ctx: any) => Promise<{
        success: boolean;
        data?: Record<string, unknown>;
        error?: string;
    }>) => void;
}
interface ERPNextPluginOptions {
    /** Disable the anonymous file upload endpoint if you handle files elsewhere */
    enableAnonymousUpload?: boolean;
    /**
     * CMS action registry — pass `actionRegistry` from `payload-cms/src/lib/actionRegistry`.
     * When provided, the plugin registers all ERP CRUD actions so they can be invoked by
     * the workflow engine.
     */
    registry?: ActionRegistryRef;
    /**
     * External afterChange hooks to be appended to the erpnext-config collection.
     * Use this from the CMS to add connection monitoring without creating a circular
     * dependency (e.g. pass `erpnextConnectionMonitorHook` from the CMS).
     */
    erpnextConfigHooks?: {
        afterChange?: ((args: any) => any)[];
    };
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
declare function erpnextPlugin(options?: ERPNextPluginOptions): Plugin;

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
declare function verifyERPNextWebhookSignature(rawBody: string, signature: string, secret: string, encoding?: 'hex' | 'base64'): boolean;

export { type ActionRegistryRef, type ERPNextCredentials, type ERPNextPluginOptions, authHeaders, erpnextPlugin, getCredentials, verifyERPNextWebhookSignature };
