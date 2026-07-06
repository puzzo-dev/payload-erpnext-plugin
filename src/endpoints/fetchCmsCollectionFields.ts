import type { Endpoint, Field } from 'payload'

/**
 * GET /api/cms-collection-fields?collection={slug}
 *
 * Lists the writable top-level field names of a Payload collection, so a sync rule's
 * "Payload field" pickers offer real fields. Descends through presentational wrappers
 * (row, collapsible, unnamed tabs); does not descend into groups/arrays/blocks (those
 * are nested paths, not simple upsert targets). Skips presentational `ui` fields.
 * Admin/super-admin only.
 */

function collectFieldNames(fields: Field[], out: Array<{ value: string; label: string }>): void {
    for (const field of fields) {
        switch (field.type) {
            case 'row':
            case 'collapsible':
                collectFieldNames(field.fields, out)
                break
            case 'tabs':
                for (const tab of field.tabs) {
                    if ('name' in tab && tab.name) {
                        out.push({ value: tab.name, label: tab.name })
                    } else {
                        collectFieldNames(tab.fields, out)
                    }
                }
                break
            case 'ui':
                break
            default:
                if ('name' in field && field.name) {
                    out.push({ value: field.name, label: field.name })
                }
        }
    }
}

export const fetchCmsCollectionFieldsEndpoint: Endpoint = {
    path: '/cms-collection-fields',
    method: 'get',
    handler: async (req) => {
        const user = req.user as unknown as { role?: string } | null
        if (!user || !['super-admin', 'admin'].includes(user.role || '')) {
            return Response.json({ error: 'Authentication required — admin or super-admin only' }, { status: 401 })
        }

        const slug = req.query?.collection as string | undefined
        if (!slug) {
            return Response.json({ error: 'Provide ?collection=<slug>' }, { status: 400 })
        }

        const collection = (req.payload.config.collections ?? []).find((c) => c.slug === slug)
        if (!collection) {
            return Response.json({ error: `Collection not found: ${slug}` }, { status: 404 })
        }

        const fields: Array<{ value: string; label: string }> = []
        collectFieldNames(collection.fields as Field[], fields)
        // Dedupe (row/tab nesting can repeat) and sort.
        const seen = new Set<string>()
        const unique = fields.filter((f) => (seen.has(f.value) ? false : (seen.add(f.value), true)))
        unique.sort((a, b) => a.label.localeCompare(b.label))

        return Response.json({ collection: slug, fields: unique })
    },
}
