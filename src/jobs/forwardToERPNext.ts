import type { TaskConfig } from 'payload'
import { executeERPNextWorkflows } from '../lib/executeERPNextWorkflows'
import { randomUUID } from 'crypto'

/**
 * Payload Job: forwardToERPNext
 *
 * Asynchronously executes ERPNext workflows for a form submission.
 * This job is queued by the form-submission afterChange hook so that ERPNext
 * forwarding does not block the HTTP response and can be retried independently.
 */
export const forwardToERPNext = {
    slug: 'forwardToERPNext',
    inputSchema: [
        { name: 'submissionId', type: 'text', required: true },
        { name: 'formId', type: 'text', required: true },
        { name: 'siteId', type: 'text', required: true },
    ],
    handler: async ({ input, req }: any) => {
        const correlationId = randomUUID()
        const log = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => {
            const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
            req.payload.logger[level](`[ERPNext][${correlationId}] ${msg}${metaStr}`)
        }

        // Fetch the submission and its data
        const submission = await req.payload.findByID({
            collection: 'form-submissions' as 'users',
            id: input.submissionId,
            depth: 0,
            overrideAccess: true,
        }).catch((err: unknown) => {
            log('error', 'Failed to fetch form submission', { error: String(err) })
            return null
        })

        if (!submission) {
            throw new Error(`Form submission ${input.submissionId} not found`)
        }

        const results = await executeERPNextWorkflows({
            payload: req.payload,
            formId: input.formId,
            siteId: input.siteId,
            submissionId: input.submissionId,
            submissionData: submission.submissionData as Array<{ field: string; value: string }>,
            correlationId,
            log,
        })

        const failed = results.filter((r) => !r.ok)
        if (failed.length > 0) {
            log('error', 'One or more ERPNext workflow requests failed', { failed })
            throw new Error(`ERPNext workflow failed: ${failed.map((f) => f.requestLabel).join(', ')}`)
        }

        return {
            output: {},
        }
    },
}
