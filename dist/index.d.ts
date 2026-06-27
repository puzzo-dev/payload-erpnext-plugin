import { CollectionAfterChangeHook, Payload, Endpoint, PayloadRequest, Plugin } from 'payload';

/**
 * ERPNext Form-Submission Forwarder (hybrid sync/async)
 *
 * For each new Payload form submission:
 *  1. Runs ERPNext workflows synchronously so validation errors (4xx) can be
 *     returned to the frontend immediately.
 *  2. On transient failures (timeout, 5xx, network), enqueues a Payload Job
 *     for retry instead of blocking the submission.
 *  3. Falls back to the legacy single-DocType behavior if no workflows exist.
 */
declare const forwardToERPNext$1: CollectionAfterChangeHook;

interface WorkflowResult {
    ok: boolean;
    requestLabel: string;
    doctype: string;
    action: string;
    referenceKey?: string;
    referenceValue?: string;
    erpName?: string;
    status?: number;
    error?: string;
}
interface ExecuteWorkflowsOptions {
    payload: Payload;
    formId: string | number;
    siteId: string | number;
    submissionId: string | number;
    submissionData: Array<{
        field: string;
        value: string;
    }>;
    correlationId: string;
    log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}
declare function executeERPNextWorkflows(options: ExecuteWorkflowsOptions): Promise<WorkflowResult[]>;

/**
 * Payload Job: forwardToERPNext
 *
 * Asynchronously executes ERPNext workflows for a form submission.
 * This job is queued by the form-submission afterChange hook so that ERPNext
 * forwarding does not block the HTTP response and can be retried independently.
 */
declare const forwardToERPNext: {
    slug: string;
    inputSchema: {
        name: string;
        type: string;
        required: boolean;
    }[];
    handler: ({ input, req }: any) => Promise<{
        output: {};
    }>;
};

/**
 * Enqueue ERPNext forwarding as a Payload Job.
 *
 * Instead of calling ERPNext synchronously in the form-submission hook,
 * we queue a background job. This keeps the submission response fast and
 * lets Payload retry failed forwards automatically via the jobs UI.
 */
declare const enqueueForwardToERPNext: CollectionAfterChangeHook;

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

interface ERPNextPluginOptions {
    /** Disable the anonymous file upload endpoint if you handle files elsewhere */
    enableAnonymousUpload?: boolean;
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
declare function erpnextPlugin(options?: ERPNextPluginOptions): Plugin;

export { type ERPNextPluginOptions, authHeaders, enqueueForwardToERPNext, erpnextPlugin, executeERPNextWorkflows, forwardToERPNext$1 as forwardToERPNext, forwardToERPNext as forwardToERPNextJob, getCredentials };
