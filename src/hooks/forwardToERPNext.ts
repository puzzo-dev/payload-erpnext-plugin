import type { CollectionAfterChangeHook } from 'payload'
import { APIError } from 'payload'
import { randomUUID } from 'crypto'
import { executeERPNextWorkflows } from '../lib/executeERPNextWorkflows'

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

export const forwardToERPNext: CollectionAfterChangeHook = async ({
    doc,
    operation,
    req,
}) => {
    if (operation !== 'create') return doc

    const correlationId = randomUUID()
    const log = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
        const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
        req.payload.logger[level](`[ERPNext][${correlationId}] ${msg}${metaStr}`)
    }

    try {
        const formRef = doc.form
        if (!formRef) return doc

        const formId = typeof formRef === 'object' ? formRef.id : formRef
        const form = await req.payload.findByID({
            collection: 'forms',
            id: formId,
            depth: 0,
            req,
        }).catch(() => null)

        const siteId = form?.site
        if (!siteId) return doc

        const resolvedSiteId = typeof siteId === 'object' ? (siteId as { id: string | number }).id : siteId

        const results = await executeERPNextWorkflows({
            payload: req.payload,
            formId,
            siteId: resolvedSiteId,
            submissionId: doc.id,
            submissionData: doc.submissionData as Array<{ field: string; value: string }>,
            correlationId,
            log,
        })

        const failed = results.filter((r) => !r.ok)
        if (failed.length === 0) return doc

        const validationErrors = failed.filter((r) => r.status && r.status >= 400 && r.status < 500)
        const transientErrors = failed.filter((r) => !r.status || r.status >= 500 || r.error?.includes('timeout') || r.error?.includes('tls-error'))

        // 4xx validation errors are returned to the frontend immediately
        if (validationErrors.length > 0) {
            const messages = validationErrors.map((r) => `${r.requestLabel} (${r.doctype}): ${r.error}`).join('; ')
            log('warn', 'ERPNext validation errors — rejecting submission', { messages })
            throw new APIError(`ERPNext validation failed: ${messages}`, 400)
        }

        // Transient failures are queued for retry via Payload Jobs
        if (transientErrors.length > 0) {
            try {
                await req.payload.jobs.queue({
                    task: 'forwardToERPNext',
                    input: {
                        submissionId: String(doc.id),
                        formId: String(formId),
                        siteId: String(resolvedSiteId),
                    },
                    queue: 'default',
                    req,
                } as any)
                log('info', 'Queued ERPNext forward job for retry', { transientErrors })
            } catch (err) {
                log('error', 'Failed to enqueue ERPNext retry job', { error: String(err) })
            }
        }
    } catch (err) {
        if (err instanceof APIError) throw err
        req.payload.logger.error(`[ERPNext][${correlationId}] Unexpected outer error: ${err}`)
    }

    return doc
}
