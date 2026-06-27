import type { CollectionAfterChangeHook } from 'payload'

/**
 * Enqueue ERPNext forwarding as a Payload Job.
 *
 * Instead of calling ERPNext synchronously in the form-submission hook,
 * we queue a background job. This keeps the submission response fast and
 * lets Payload retry failed forwards automatically via the jobs UI.
 */
export const enqueueForwardToERPNext: CollectionAfterChangeHook = async ({
    doc,
    operation,
    req,
}) => {
    if (operation !== 'create') return doc

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
    } catch (err) {
        req.payload.logger.error(`[ERPNext] Failed to enqueue forward job: ${err instanceof Error ? err.message : String(err)}`)
    }

    return doc
}
