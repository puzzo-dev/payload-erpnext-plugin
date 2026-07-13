import type { Endpoint, CollectionSlug } from 'payload'

/**
 * GET /api/cms-collections?siteId={siteId}
 *
 * Lists the Payload collections a sync rule can target (slug + friendly label),
 * scoped to the requested site and split into "local" (only this site uses it)
 * vs "global" (shared across 2+ sites). Used by the CmsCollectionSelect field on
 * ERPNextSyncRules so owners pick a real collection instead of typing a slug —
 * previously this listed every collection in the system regardless of the rule's
 * own site, including collections that belong to a completely different tenant.
 *
 * `siteCollectionsMap` (site slug -> collection slugs) is a host binding — see
 * ERPNextHostBindings in types.ts. This plugin has no built-in concept of "which
 * site uses which collection" (that's entirely host-application business data),
 * so the host injects its own map at plugin-init time rather than this endpoint
 * reaching into the host app's source tree, which would break the moment this
 * plugin is consumed as a published package instead of a workspace-local one.
 * A collection counts as "global" once it appears under 2+ sites in that map
 * (e.g. pages, media — every site has them); exactly 1 site means it's local.
 *
 * `siteId` is optional for backward compatibility with any caller that predates
 * site-scoping — omitting it returns every non-hidden collection, ungrouped.
 * Same fallback applies if the host never provided siteCollectionsMap at all.
 *
 * Payload-internal collections (migrations, preferences, jobs, locked docs) and
 * the ERP plumbing collections are always hidden — they are never sync targets.
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

export function createFetchCmsCollectionsEndpoint(siteCollectionsMap?: Record<string, string[]>): Endpoint {
    return {
        path: '/cms-collections',
        method: 'get',
        handler: async (req) => {
            const user = req.user as unknown as { role?: string } | null
            if (!user || !['super-admin', 'admin'].includes(user.role || '')) {
                return Response.json({ error: 'Authentication required — admin or super-admin only' }, { status: 401 })
            }

            const allCollections = (req.payload.config.collections ?? [])
                .filter((c) => !HIDDEN_SLUGS.has(c.slug))
                .map((c) => ({ value: c.slug, label: labelFor(c as { slug: string; labels?: { plural?: unknown } }) }))
                .sort((a, b) => a.label.localeCompare(b.label))

            const siteId = req.query?.siteId as string | number | undefined
            if (!siteId || !siteCollectionsMap) {
                return Response.json({ collections: allCollections })
            }

            const sites = await req.payload.find({
                collection: 'sites' as unknown as CollectionSlug,
                where: { id: { equals: siteId } },
                limit: 1,
                depth: 0,
                overrideAccess: true,
            })
            const siteSlug = (sites.docs[0] as unknown as { slug?: string } | undefined)?.slug
            if (!siteSlug) {
                return Response.json({ error: 'Site not found' }, { status: 404 })
            }

            const siteSlugCollections = new Set(siteCollectionsMap[siteSlug] ?? [])
            const usageCount = new Map<string, number>()
            for (const slugs of Object.values(siteCollectionsMap)) {
                for (const slug of slugs) {
                    usageCount.set(slug, (usageCount.get(slug) ?? 0) + 1)
                }
            }

            const relevant = allCollections.filter((c) => siteSlugCollections.has(c.value))
            const global = relevant.filter((c) => (usageCount.get(c.value) ?? 0) >= 2)
            const local = relevant.filter((c) => (usageCount.get(c.value) ?? 0) < 2)

            return Response.json({ global, local })
        },
    }
}
