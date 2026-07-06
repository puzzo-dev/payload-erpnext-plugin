import type { Endpoint } from 'payload'

/**
 * GET /api/cms-collections
 *
 * Lists the Payload collections a sync rule can target (slug + friendly label).
 * Used by the CmsCollectionSelect field on ERPNextSyncRules so owners pick a real
 * collection instead of typing a slug. Admin/super-admin only.
 *
 * Payload-internal collections (migrations, preferences, jobs, locked docs) and the
 * ERP plumbing collections are hidden — they are never sync targets.
 */

const HIDDEN_SLUGS = new Set([
    'payload-migrations',
    'payload-preferences',
    'payload-locked-documents',
    'payload-jobs',
    'erpnext-config',
    'erpnext-sync-rules',
    'erpnext-dead-letters',
])

function labelFor(collection: { slug: string; labels?: { singular?: unknown; plural?: unknown } }): string {
    const plural = collection.labels?.plural
    if (typeof plural === 'string' && plural) return plural
    return collection.slug
}

export const fetchCmsCollectionsEndpoint: Endpoint = {
    path: '/cms-collections',
    method: 'get',
    handler: async (req) => {
        const user = req.user as unknown as { role?: string } | null
        if (!user || !['super-admin', 'admin'].includes(user.role || '')) {
            return Response.json({ error: 'Authentication required — admin or super-admin only' }, { status: 401 })
        }

        const collections = (req.payload.config.collections ?? [])
            .filter((c) => !HIDDEN_SLUGS.has(c.slug))
            .map((c) => ({ value: c.slug, label: labelFor(c as { slug: string; labels?: { plural?: unknown } }) }))
            .sort((a, b) => a.label.localeCompare(b.label))

        return Response.json({ collections })
    },
}
