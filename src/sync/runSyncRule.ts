import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'
import type { ERPNextCredentials, LogFn } from '../types'
import { authHeaders } from '../endpoints/erpnextProxy'
import {
    chooseMatchField,
    describeRelationship,
    findFieldConfig,
    coerceConstant,
    erpFetchFields,
    getUpsertKeyMapping,
    resolveSiteId,
    slugify,
    stripHtml,
    type ERPNextFieldMapping,
    type ERPNextSyncRule,
} from './transforms'

// Re-exported so importers keep a single entry point for the sync engine — the
// transforms.ts split is about testability, not about a second public module.
export {
    coerceConstant,
    erpFetchFields,
    getUpsertKeyMapping,
    resolveSiteId,
    slugify,
    stripHtml,
    type ERPNextFieldMapping,
    type ERPNextSyncRule,
    type MappingTransform,
} from './transforms'

/** Timeout for ancillary ERPNext API calls (status-mapped customer group promotion). */
const CUSTOMER_PROMOTION_TIMEOUT_MS = 15000

/**
 * Look up an ERPNext Customer by an arbitrary field (e.g. the Sales Order's customer
 * link value) and promote it to a target customer_group if it isn't already there.
 * Moved here from the retired erpnextWebhook.ts — both the live webhook and backfill
 * paths need the identical promotion logic, so it lives alongside upsertErpRecord.
 */
async function promoteCustomerToGroup(
    creds: ERPNextCredentials,
    lookupValue: string,
    lookupField: string,
    customerGroup: string,
): Promise<boolean> {
    const qs = new URLSearchParams({
        filters: JSON.stringify([[lookupField, '=', lookupValue]]),
        fields: JSON.stringify(['name', 'customer_group']),
    })
    const res = await fetch(`${creds.url}/api/resource/Customer?${qs}`, {
        method: 'GET',
        headers: authHeaders(creds),
        signal: AbortSignal.timeout(CUSTOMER_PROMOTION_TIMEOUT_MS),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { data?: Array<{ name: string; customer_group?: string }> }
    const customer = body.data?.[0]
    if (!customer) return false
    if (customer.customer_group === customerGroup) return true
    const putRes = await fetch(`${creds.url}/api/resource/Customer/${encodeURIComponent(customer.name)}`, {
        method: 'PUT',
        headers: authHeaders(creds),
        body: JSON.stringify({ customer_group: customerGroup }),
        signal: AbortSignal.timeout(CUSTOMER_PROMOTION_TIMEOUT_MS),
    })
    return putRes.ok
}

/**
 * Data-driven ERPNext → Payload inbound sync.
 *
 * Nothing here is doctype-specific. What gets synced is entirely owner-declared in
 * the `erpnext-sync-rules` collection: each rule names one ERPNext DocType, the
 * target Payload collection, a field map (ERP field → Payload field) and an upsert
 * key. Both the inbound webhook (event-driven, one record) and the backfill (pull
 * all existing records when a rule is saved) run through the same mapping + upsert
 * logic below.
 */

const SYNC_RULES_SLUG = 'erpnext-sync-rules' as unknown as CollectionSlug

/** Timeout for backfill pulls from ERPNext. */
const BACKFILL_TIMEOUT_MS = 30000

/**
 * Work out what a `link` transform should search, from Payload's config alone.
 *
 * The rule author picks only the Payload field; everything else is already declared.
 * Returns a reason instead of a target when the config cannot be trusted, so the
 * caller can log something actionable rather than issuing a doomed query.
 */
function resolveLinkTarget(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    mapping: ERPNextFieldMapping,
): { collection: string; field: string; hasMany: boolean } | { reason: string } {
    const targetConfig = req.payload.collections?.[rule.targetCollection]?.config
    const rel = describeRelationship(targetConfig?.fields as unknown[] | undefined, mapping.payload_field ?? '', rule.targetCollection)
    if ('reason' in rel) return rel

    const relatedConfig = req.payload.collections?.[rel.collection]?.config
    const useAsTitle = (relatedConfig?.admin as { useAsTitle?: string } | undefined)?.useAsTitle
    const match = chooseMatchField(relatedConfig?.fields as unknown[] | undefined, useAsTitle, mapping.lookup_field, rel.collection)
    if ('reason' in match) return match

    return { collection: rel.collection, field: match.field, hasMany: rel.hasMany }
}

/** Does a collection declare a top-level field with this name? */
function collectionHasField(req: PayloadRequest, slug: string, fieldName: string): boolean {
    const config = req.payload.collections?.[slug]?.config
    if (!config) return false
    const walk = (fields: unknown[]): boolean =>
        fields.some((f) => {
            const field = f as { type?: string; name?: string; fields?: unknown[]; tabs?: Array<{ name?: string; fields?: unknown[] }> }
            if (field.type === 'row' || field.type === 'collapsible') return walk(field.fields ?? [])
            if (field.type === 'tabs') return (field.tabs ?? []).some((t) => (t.name ? t.name === fieldName : walk(t.fields ?? [])))
            return field.name === fieldName
        })
    return walk(config.fields as unknown[])
}

/**
 * Resolve an ERP display value to a related Payload document's ID, for `relationship`
 * fields. Scoped to the same site when the looked-up collection is site-scoped, so one
 * tenant's "Cocktails" category can never be linked from another tenant's records.
 * Returns undefined when nothing matches — the caller leaves the field unset rather
 * than writing a bad reference, and Payload's own required-field validation then
 * reports it (surfacing as a skipped record with a readable error).
 */
async function resolveRelated(
    req: PayloadRequest,
    mapping: ERPNextFieldMapping,
    target: { collection: string; field: string; hasMany: boolean },
    rawValue: unknown,
    siteId: string | number,
    log?: LogFn,
): Promise<unknown> {
    const { collection, field } = target
    const conditions: Where[] = [{ [field]: { equals: rawValue } }]
    if (collectionHasField(req, collection, 'site')) conditions.push({ site: { equals: siteId } })

    // A mis-picked match field is a configuration mistake, not a data problem, and it
    // must not escape as a raw driver error repeated once per record. Matching an ERP
    // display name against a numeric column is the common case: Payload coerces the
    // value first, so `id = "Cocktails"` becomes `version_parent_id = NaN` and Postgres
    // rejects the whole query. Catch it, name the collection/field/value that caused it,
    // and fall through to "unresolved" like any other miss.
    let res
    try {
        res = await req.payload.find({
            collection: collection as CollectionSlug,
            where: conditions.length > 1 ? { and: conditions } : conditions[0],
            limit: 1,
            depth: 0,
            overrideAccess: true,
            // Same reason as findExisting: a draft-only related doc must still be matchable,
            // otherwise the lookup misses and the parent record fails to validate.
            draft: true,
        })
    } catch (err) {
        log?.('error', `Lookup query failed on ${collection}.${field} for value "${String(rawValue)}" — check that "Match Against Field" names a field holding this kind of value (leaving ${mapping.payload_field} unset)`, {
            error: err instanceof Error ? err.message : String(err),
        })
        return undefined
    }

    if (res.totalDocs === 0) {
        log?.('warn', `Lookup found no ${collection} with ${field} = "${String(rawValue)}" — leaving ${mapping.payload_field} unset`)
        return undefined
    }
    const id = (res.docs[0] as { id: string | number }).id
    // A hasMany relationship stores an array. One ERPNext Link field yields one target,
    // so wrap it rather than writing a bare id the field will reject.
    return target.hasMany ? [id] : id
}

/**
 * Apply a mapping row's transform to one raw ERPNext value. Null/empty passes through
 * untouched — an absent source value should stay absent, not become the slug "" or
 * trigger a lookup for nothing.
 */
export async function applyMappingTransform(
    req: PayloadRequest,
    mapping: ERPNextFieldMapping,
    rawValue: unknown,
    siteId: string | number,
    log?: LogFn,
    // Appended rather than inserted next to `mapping`, where it belongs, so the 2.0.x
    // signature keeps working. Only the `link` transform needs it — it reads
    // rule.targetCollection to find the field config declaring relationTo.
    rule?: ERPNextSyncRule,
): Promise<unknown> {
    if (rawValue === undefined || rawValue === null || rawValue === '') return rawValue
    switch (mapping.transform) {
        case 'strip_html':
            return stripHtml(String(rawValue))
        case 'slugify':
            return slugify(String(rawValue))
        case 'link': {
            if (!rule) {
                log?.('error', 'Link transform needs the sync rule to resolve the relationship — leaving unset', { payload_field: mapping.payload_field })
                return undefined
            }
            // Everything the query needs is already declared in Payload's config.
            const target = resolveLinkTarget(req, rule, mapping)
            if ('reason' in target) {
                log?.('error', `Cannot link ${rule.targetCollection}.${mapping.payload_field}: ${target.reason} (leaving it unset)`)
                return undefined
            }
            return resolveRelated(req, mapping, target, rawValue, siteId, log)
        }
        case 'lookup': {
            const { lookup_collection: collection, lookup_field: field } = mapping
            if (!collection || !field) {
                log?.('warn', 'Lookup transform missing collection/field — leaving unset', { payload_field: mapping.payload_field })
                return undefined
            }
            const hasMany = Boolean(
                rule && findFieldConfig(req.payload.collections?.[rule.targetCollection]?.config?.fields as unknown[] | undefined, mapping.payload_field ?? '')?.hasMany,
            )
            return resolveRelated(req, mapping, { collection, field, hasMany }, rawValue, siteId, log)
        }
        default:
            return rawValue
    }
}

/**
 * Map one ERPNext record onto Payload field names using the rule's field map,
 * running each row's transform (slugify / relationship lookup) on the way.
 */
export async function mapErpRecord(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    erpRecord: Record<string, unknown>,
    siteId: string | number,
    log?: LogFn,
): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    // The upsert-key row is itself a normal field_mappings row (isUpsertKey just marks
    // which one it is), so this loop already copies it — no separate assignment needed.
    for (const m of rule.field_mappings ?? []) {
        if (m.erp_field && m.payload_field) {
            const value = await applyMappingTransform(req, m, erpRecord[m.erp_field], siteId, log, rule)
            // An unresolved lookup must not write `undefined` over an existing value on
            // update — omit the key entirely and leave whatever the document already has.
            if (value === undefined && m.transform === 'lookup') continue
            out[m.payload_field] = value
        }
    }
    // Owner-declared constant/default values for required target fields the ERP does
    // not carry (e.g. category, item_type). Applied last so they always win.
    for (const c of rule.constant_values ?? []) {
        if (c.payload_field && c.value !== undefined && c.value !== null && c.value !== '') {
            out[c.payload_field] = coerceConstant(c.value)
        }
    }
    return out
}

/** Find the Payload doc a given ERP record maps to (by upsert key + site), if any. */
async function findExisting(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    keyMapping: { erp_field: string; payload_field: string },
    keyValue: unknown,
    siteId: string | number,
): Promise<{ id: string | number } | null> {
    const res = await req.payload.find({
        collection: rule.targetCollection as CollectionSlug,
        where: {
            and: [
                { [keyMapping.payload_field]: { equals: keyValue } },
                { site: { equals: siteId } },
            ],
        },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        // CRITICAL for idempotency on draft-enabled collections (e.g. catalogue-items):
        // without draft:true, find() ignores draft-only docs, so a re-sync fails to match
        // an existing record by its upsert key and CREATES A DUPLICATE. draft:true matches
        // the latest version (draft or published) so upsert stays one-record-per-ERP-key.
        draft: true,
    })
    return res.totalDocs > 0 ? (res.docs[0] as { id: string | number }) : null
}

/**
 * Upsert a single ERPNext record into the rule's target collection.
 * Returns the action taken for logging/response.
 */
/**
 * If the rule has statusField+statusMappings configured, look up the ERP record's own
 * "status" field in the mapping and write the matched payloadStatus onto the just-upserted
 * doc. If that mapping entry also names a customerGroup (and the rule has
 * customerGroupField set), promote the customer via the ERP-side lookup — reading the
 * lookup value directly off erpRecord rather than an extra ERPNext fetch, since erpRecord
 * already IS the source doctype's current data (live webhook payload or fresh backfill
 * pull). Runs identically for both paths since both call upsertErpRecord.
 */
async function applyStatusSync(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    erpRecord: Record<string, unknown>,
    docId: string | number,
    creds: ERPNextCredentials | undefined,
    log?: LogFn,
): Promise<void> {
    if (!rule.statusField || !rule.statusMappings?.length) return
    const erpStatus = erpRecord.status
    if (typeof erpStatus !== 'string') return
    const mapping = rule.statusMappings.find((m) => m.erpStatus === erpStatus)
    if (!mapping?.payloadStatus) return

    try {
        await req.payload.update({
            collection: rule.targetCollection as CollectionSlug,
            id: docId,
            data: { [rule.statusField]: mapping.payloadStatus } as never,
            overrideAccess: true,
        })
        log?.('info', `Status synced ${rule.targetCollection}`, { id: docId, erpStatus, payloadStatus: mapping.payloadStatus })
    } catch (err) {
        log?.('error', 'Status sync failed', { id: docId, error: String(err) })
    }

    if (mapping.customerGroup && rule.customerGroupField && creds) {
        const lookupValue = erpRecord[rule.customerGroupField]
        if (typeof lookupValue === 'string' && lookupValue) {
            try {
                const promoted = await promoteCustomerToGroup(creds, lookupValue, rule.customerGroupField, mapping.customerGroup)
                log?.('info', `Customer group promotion ${promoted ? 'applied' : 'skipped (no match)'}`, { lookupValue, group: mapping.customerGroup })
            } catch (err) {
                log?.('error', 'Customer group promotion failed', { error: String(err) })
            }
        }
    }
}

export async function upsertErpRecord(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    erpRecord: Record<string, unknown>,
    siteId: string | number,
    creds?: ERPNextCredentials,
    log?: LogFn,
): Promise<{ action: 'created' | 'updated' | 'skipped'; id?: string | number; key?: unknown }> {
    const keyMapping = getUpsertKeyMapping(rule)
    if (!keyMapping) {
        log?.('warn', 'No field mapping marked as the unique key — skipping', { doctype: rule.doctype })
        return { action: 'skipped' }
    }
    const keyValue = await applyMappingTransform(req, keyMapping, erpRecord[keyMapping.erp_field], siteId, log, rule)
    if (keyValue === undefined || keyValue === null || keyValue === '') {
        log?.('warn', `Record missing upsert key "${keyMapping.erp_field}" — skipping`, { doctype: rule.doctype })
        return { action: 'skipped' }
    }

    const data = await mapErpRecord(req, rule, erpRecord, siteId, log)
    // ERP is the source of truth, so synced records go live immediately. On collections
    // with drafts enabled, `_status: 'published'` publishes them (otherwise they'd land as
    // drafts and never appear); on non-draft collections Payload ignores the extra key.
    data._status = 'published'
    // Stamp when THIS system last pulled the record, on updates as well as creates —
    // an already-existing document is exactly the case where the operator needs to see
    // that the ERPNext link is live and when it last ran.
    if (rule.syncedAtField) data[rule.syncedAtField] = new Date().toISOString()
    const existing = await findExisting(req, rule, keyMapping, keyValue, siteId)

    if (existing) {
        await req.payload.update({
            collection: rule.targetCollection as CollectionSlug,
            id: existing.id,
            data: data as never,
            overrideAccess: true,
        })
        log?.('info', `Updated ${rule.targetCollection}`, { key: keyValue, id: existing.id })
        await applyStatusSync(req, rule, erpRecord, existing.id, creds, log)
        return { action: 'updated', id: existing.id, key: keyValue }
    }

    // Create — inject tenant fields (site + organization) so tenant-scoped collections
    // validate. Collections without these fields ignore the extra keys.
    const createData: Record<string, unknown> = { ...data, site: siteId }
    try {
        const siteDoc = await req.payload.findByID({ collection: 'sites', id: siteId, depth: 0, overrideAccess: true })
        const org = (siteDoc as Record<string, unknown>)?.organization
        if (org) createData.organization = typeof org === 'object' ? (org as { id: unknown }).id : org
    } catch { /* site without organization — non-fatal */ }

    // findExisting + create is not atomic: if ERPNext resends the same
    // webhook (a documented Frappe retry behavior) or a backfill runs
    // concurrently with a live webhook for the same record, two calls can
    // both find nothing and both create — a duplicate Payload document for
    // the same ERP key. If the target collection has a unique index
    // covering the upsert key (recommended, but not enforced here since
    // targetCollection is admin-configurable to any collection), Postgres
    // rejects the second insert; treat that as "someone else just created
    // it" and fall back to an update instead of surfacing an error.
    let created
    try {
        created = await req.payload.create({
            collection: rule.targetCollection as CollectionSlug,
            data: createData as never,
            overrideAccess: true,
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isDuplicateKey = /duplicate key|unique constraint|already exists/i.test(msg)
        if (!isDuplicateKey) throw err
        const raceWinner = await findExisting(req, rule, keyMapping, keyValue, siteId)
        if (!raceWinner) throw err // Genuinely not a dedup-able race — surface the original error.
        await req.payload.update({
            collection: rule.targetCollection as CollectionSlug,
            id: raceWinner.id,
            data: data as never,
            overrideAccess: true,
        })
        log?.('info', `Updated ${rule.targetCollection} (lost create race, fell back to update)`, { key: keyValue, id: raceWinner.id })
        await applyStatusSync(req, rule, erpRecord, raceWinner.id, creds, log)
        return { action: 'updated', id: raceWinner.id, key: keyValue }
    }
    log?.('info', `Created ${rule.targetCollection}`, { key: keyValue, id: created.id })
    await applyStatusSync(req, rule, erpRecord, created.id, creds, log)
    return { action: 'created', id: created.id, key: keyValue }
}

/** Delete the Payload doc mapped from an ERP record (used on ERPNext trash/delete events). */
export async function deleteErpRecord(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    erpRecord: Record<string, unknown>,
    siteId: string | number,
    log?: LogFn,
): Promise<{ action: 'deleted' | 'skipped'; id?: string | number }> {
    const keyMapping = getUpsertKeyMapping(rule)
    if (!keyMapping) return { action: 'skipped' }
    // Same transform as the upsert path — the stored value is the transformed one, so
    // an un-transformed key would fail to find the document and silently skip the delete.
    const keyValue = await applyMappingTransform(req, keyMapping, erpRecord[keyMapping.erp_field], siteId, log, rule)
    if (keyValue === undefined || keyValue === null || keyValue === '') return { action: 'skipped' }

    const existing = await findExisting(req, rule, keyMapping, keyValue, siteId)
    if (!existing) return { action: 'skipped' }

    await req.payload.delete({
        collection: rule.targetCollection as CollectionSlug,
        id: existing.id,
        overrideAccess: true,
    })
    log?.('info', `Deleted ${rule.targetCollection}`, { key: keyValue, id: existing.id })
    return { action: 'deleted', id: existing.id }
}

/** Active sync rules for a (site, doctype) pair. Multiple rules per doctype are allowed. */
export async function findRulesForDoctype(
    payload: Payload,
    siteId: string | number,
    doctype: string,
): Promise<ERPNextSyncRule[]> {
    const res = await payload.find({
        collection: SYNC_RULES_SLUG,
        where: {
            and: [
                { site: { equals: siteId } },
                { doctype: { equals: doctype } },
                { isActive: { equals: true } },
            ],
        },
        limit: 100,
        depth: 0,
        overrideAccess: true,
    })
    return res.docs as unknown as ERPNextSyncRule[]
}

/** Distinct error messages kept in the stats, so one bad mapping doesn't store 500 identical strings. */
const MAX_REPORTED_ERRORS = 5

export interface BackfillStats {
    pulled: number
    created: number
    updated: number
    /** Deliberately not synced: no upsert key configured, or the record has no value for it. */
    skipped: number
    /** Tried to sync and errored — almost always target-collection validation. */
    failed: number
    /** Up to MAX_REPORTED_ERRORS distinct messages behind `failed`, newest last. */
    errors: string[]
}

/**
 * Backfill: pull every existing record of the rule's DocType from ERPNext and upsert
 * them. Data often pre-exists in ERPNext long before the Payload deployment, so this
 * runs when a rule is saved (or on demand) with no ERPNext-side trigger required.
 */
export async function backfillSyncRule(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    creds: ERPNextCredentials,
    log?: LogFn,
): Promise<BackfillStats> {
    const siteId = resolveSiteId(rule.site)
    const fields = erpFetchFields(rule)
    // limit_page_length=0 returns all rows in Frappe/ERPNext.
    const qs = new URLSearchParams({
        fields: JSON.stringify(fields),
        limit_page_length: '0',
    })
    // Optional owner-declared filter (e.g. [["has_variants","=",0]] to skip variant
    // templates). Accepts a JSON array or a pre-stringified filter.
    if (rule.filters !== undefined && rule.filters !== null && rule.filters !== '') {
        const filterStr = typeof rule.filters === 'string' ? rule.filters : JSON.stringify(rule.filters)
        if (filterStr && filterStr !== '[]' && filterStr !== '{}') {
            qs.set('filters', filterStr)
        }
    }
    const url = `${creds.url}/api/resource/${encodeURIComponent(rule.doctype)}?${qs}`

    const res = await fetch(url, {
        method: 'GET',
        headers: authHeaders(creds),
        signal: AbortSignal.timeout(BACKFILL_TIMEOUT_MS),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`ERPNext GET ${rule.doctype} → ${res.status}: ${text.slice(0, 200)}`)
    }

    const body = (await res.json()) as { data?: Record<string, unknown>[] }
    const records = body.data ?? []
    // `failed` is tracked separately from `skipped` on purpose. They used to share one
    // counter, which made a rule that could not write a single record ("17 skipped")
    // read like a rule that had correctly decided there was nothing to do. A non-zero
    // `failed` always means something is misconfigured; a non-zero `skipped` may not be.
    const stats: BackfillStats = { pulled: records.length, created: 0, updated: 0, skipped: 0, failed: 0, errors: [] }

    for (const record of records) {
        try {
            const result = await upsertErpRecord(req, rule, record, siteId, creds, log)
            stats[result.action] += 1
        } catch (err) {
            stats.failed += 1
            const message = err instanceof Error ? err.message : String(err)
            // Store the distinct reasons, not one line per record — the same broken
            // mapping produces the identical message for every record it touches.
            if (!stats.errors.includes(message) && stats.errors.length < MAX_REPORTED_ERRORS) {
                stats.errors.push(message)
            }
            log?.('error', `Backfill upsert failed`, { doctype: rule.doctype, error: String(err) })
        }
    }

    log?.('info', `Backfill complete for ${rule.doctype} → ${rule.targetCollection}`, { ...stats })
    return stats
}
