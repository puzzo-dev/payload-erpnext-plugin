import type { CollectionSlug, Payload, PayloadRequest } from 'payload'
import type { ERPNextCredentials, LogFn } from '../types'
import { authHeaders } from '../endpoints/erpnextProxy'

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

/** A row from the `erpnext-sync-rules` collection (shape only — not in generated types). */
export interface ERPNextSyncRule {
    id: string | number
    site: string | number | { id: string | number }
    doctype: string
    targetCollection: string
    upsert_erp_field: string
    upsert_payload_field: string
    field_mappings?: Array<{ erp_field?: string | null; payload_field?: string | null }>
    constant_values?: Array<{ payload_field?: string | null; value?: string | null }>
    /** Raw ERPNext REST filter (e.g. [["has_variants","=",0]]) applied to the backfill query. */
    filters?: unknown
    isActive?: boolean
    backfillOnSave?: boolean
}

/** Coerce an all-digit constant to a number so relationship (int id) fields validate. */
function coerceConstant(value: string): string | number {
    return /^\d+$/.test(value) ? Number(value) : value
}

const SYNC_RULES_SLUG = 'erpnext-sync-rules' as unknown as CollectionSlug

/** Timeout for backfill pulls from ERPNext. */
const BACKFILL_TIMEOUT_MS = 30000

export function resolveSiteId(site: ERPNextSyncRule['site']): string | number {
    return typeof site === 'object' && site !== null ? site.id : site
}

/** Map one ERPNext record onto Payload field names using the rule's field map. */
export function mapErpRecord(rule: ERPNextSyncRule, erpRecord: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const m of rule.field_mappings ?? []) {
        if (m.erp_field && m.payload_field) {
            out[m.payload_field] = erpRecord[m.erp_field]
        }
    }
    // Always persist the upsert key so future syncs can find this doc again.
    out[rule.upsert_payload_field] = erpRecord[rule.upsert_erp_field]
    // Owner-declared constant/default values for required target fields the ERP does
    // not carry (e.g. category, item_type). Applied last so they always win.
    for (const c of rule.constant_values ?? []) {
        if (c.payload_field && c.value !== undefined && c.value !== null && c.value !== '') {
            out[c.payload_field] = coerceConstant(c.value)
        }
    }
    return out
}

/** The ERPNext field names a rule needs fetched (mapped fields + the upsert key). */
export function erpFetchFields(rule: ERPNextSyncRule): string[] {
    const fields = new Set<string>()
    fields.add(rule.upsert_erp_field)
    for (const m of rule.field_mappings ?? []) {
        if (m.erp_field) fields.add(m.erp_field)
    }
    return [...fields]
}

/** Find the Payload doc a given ERP record maps to (by upsert key + site), if any. */
async function findExisting(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    keyValue: unknown,
    siteId: string | number,
): Promise<{ id: string | number } | null> {
    const res = await req.payload.find({
        collection: rule.targetCollection as CollectionSlug,
        where: {
            and: [
                { [rule.upsert_payload_field]: { equals: keyValue } },
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
export async function upsertErpRecord(
    req: PayloadRequest,
    rule: ERPNextSyncRule,
    erpRecord: Record<string, unknown>,
    siteId: string | number,
    log?: LogFn,
): Promise<{ action: 'created' | 'updated' | 'skipped'; id?: string | number; key?: unknown }> {
    const keyValue = erpRecord[rule.upsert_erp_field]
    if (keyValue === undefined || keyValue === null || keyValue === '') {
        log?.('warn', `Record missing upsert key "${rule.upsert_erp_field}" — skipping`, { doctype: rule.doctype })
        return { action: 'skipped' }
    }

    const data = mapErpRecord(rule, erpRecord)
    // ERP is the source of truth, so synced records go live immediately. On collections
    // with drafts enabled, `_status: 'published'` publishes them (otherwise they'd land as
    // drafts and never appear); on non-draft collections Payload ignores the extra key.
    data._status = 'published'
    const existing = await findExisting(req, rule, keyValue, siteId)

    if (existing) {
        await req.payload.update({
            collection: rule.targetCollection as CollectionSlug,
            id: existing.id,
            data: data as never,
            overrideAccess: true,
        })
        log?.('info', `Updated ${rule.targetCollection}`, { key: keyValue, id: existing.id })
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

    const created = await req.payload.create({
        collection: rule.targetCollection as CollectionSlug,
        data: createData as never,
        overrideAccess: true,
    })
    log?.('info', `Created ${rule.targetCollection}`, { key: keyValue, id: created.id })
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
    const keyValue = erpRecord[rule.upsert_erp_field]
    if (keyValue === undefined || keyValue === null || keyValue === '') return { action: 'skipped' }

    const existing = await findExisting(req, rule, keyValue, siteId)
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
): Promise<{ pulled: number; created: number; updated: number; skipped: number }> {
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
    const stats = { pulled: records.length, created: 0, updated: 0, skipped: 0 }

    for (const record of records) {
        try {
            const result = await upsertErpRecord(req, rule, record, siteId, log)
            stats[result.action] += 1
        } catch (err) {
            stats.skipped += 1
            log?.('error', `Backfill upsert failed`, { doctype: rule.doctype, error: String(err) })
        }
    }

    log?.('info', `Backfill complete for ${rule.doctype} → ${rule.targetCollection}`, stats)
    return stats
}
