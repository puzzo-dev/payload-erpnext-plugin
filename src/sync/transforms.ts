/**
 * Pure mapping logic for the ERPNext → Payload inbound sync.
 *
 * Split out of runSyncRule.ts deliberately: everything here is a plain function over
 * plain data, with no Payload/network imports. runSyncRule.ts reaches the ERPNext REST
 * API and the Payload local API, and its import chain starts a rate-limiter cleanup
 * interval at module load — importing it from a unit test keeps the test process alive
 * forever. Keeping the pure half here means the mapping rules are directly testable.
 */

/**
 * How a mapped ERPNext value is converted before it is written to the Payload field.
 *
 *  - `none`     copy verbatim (the original, and still the default) behaviour.
 *  - `slugify`  URL-safe slug of the ERP value. Exists because required Payload `slug`
 *               fields have no ERPNext counterpart — Frappe doctypes carry a display
 *               name only, so an un-transformed map left `slug` empty and every create
 *               failed validation.
 *  - `lookup`   resolve the ERP value (a display name such as an Item Group's
 *               "Cocktails") to the ID of a document in another Payload collection, so
 *               it can populate a `relationship` field. Copying the raw string into a
 *               relationship field is always invalid — the field wants an ID.
 */
export type MappingTransform = 'none' | 'slugify' | 'lookup'

export interface ERPNextFieldMapping {
    erp_field?: string | null
    payload_field?: string | null
    isUpsertKey?: boolean | null
    transform?: MappingTransform | null
    /** `lookup` only: collection whose documents are searched. */
    lookup_collection?: string | null
    /** `lookup` only: field in that collection the ERP value is matched against. */
    lookup_field?: string | null
}

/** A row from the `erpnext-sync-rules` collection (shape only — not in generated types). */
export interface ERPNextSyncRule {
    id: string | number
    site: string | number | { id: string | number }
    doctype: string
    targetCollection: string
    /**
     * Exactly one row must have isUpsertKey: true — that row's erp_field/payload_field
     * pair IS the unique key used to match an incoming ERP record to an existing Payload
     * document. There used to be a separate standalone upsert_erp_field/upsert_payload_field
     * pair, which meant an admin configuring "this field is both mapped AND the key" had to
     * enter the same field twice. field_mappings is now the single source of truth — see
     * getUpsertKeyMapping().
     */
    field_mappings?: ERPNextFieldMapping[]
    constant_values?: Array<{ payload_field?: string | null; value?: string | null }>
    /**
     * Payload date field on targetCollection stamped with the time of each successful
     * upsert (create AND update). Unset disables the stamp. Distinct from any mapped
     * ERPNext `modified` field: that is when ERPNext last changed the record, this is
     * when this system last pulled it.
     */
    syncedAtField?: string | null
    /** Raw ERPNext REST filter (e.g. [["has_variants","=",0]]) applied to the backfill query. */
    filters?: unknown
    /** Payload field on targetCollection to write the mapped status to. Unset disables status sync. */
    statusField?: string | null
    /** ERPNext status value -> Payload status value, with an optional per-status customer group promotion. */
    statusMappings?: Array<{ erpStatus?: string | null; payloadStatus?: string | null; customerGroup?: string | null }>
    /** ERPNext field used to look up the customer for group promotion. Unset disables promotion for every status mapping. */
    customerGroupField?: string | null
    isActive?: boolean
    backfillOnSave?: boolean
}

/** Coerce an all-digit constant to a number so relationship (int id) fields validate. */
export function coerceConstant(value: string): string | number {
    return /^\d+$/.test(value) ? Number(value) : value
}

export function resolveSiteId(site: ERPNextSyncRule['site']): string | number {
    return typeof site === 'object' && site !== null ? site.id : site
}

/**
 * URL-safe slug of an arbitrary ERPNext display name.
 * Diacritics are decomposed and stripped first so "Café Crème" → "cafe-creme"
 * rather than "caf-cr-me".
 */
export function slugify(value: string): string {
    return value
        .normalize('NFKD')
        // Explicit combining-marks range rather than \p{Diacritic}: NFKD above turns every
        // accent into a combining mark, so this is exactly the set to drop, and it avoids
        // Unicode property escapes entirely (see the \p{hexDigit} regression in a36b4ba).
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

/**
 * The field_mappings row marked as the unique key. Returns null if no row is
 * marked (the collection's own validation should prevent saving that state,
 * but callers still fail closed — skip rather than guess — if it happens).
 */
export function getUpsertKeyMapping(rule: ERPNextSyncRule): (ERPNextFieldMapping & { erp_field: string; payload_field: string }) | null {
    const found = rule.field_mappings?.find((m) => m.isUpsertKey && m.erp_field && m.payload_field)
    if (!found?.erp_field || !found?.payload_field) return null
    // Spread the whole row, not just the two names: the key row can carry a transform
    // too (e.g. name → slug with slugify), and matching must then be done on the
    // TRANSFORMED value — the stored Payload field holds the slug, not the raw name.
    return { ...found, erp_field: found.erp_field, payload_field: found.payload_field }
}

/** The ERPNext field names a rule needs fetched — just the field_mappings, the upsert key is one of them. */
export function erpFetchFields(rule: ERPNextSyncRule): string[] {
    const fields = new Set<string>()
    for (const m of rule.field_mappings ?? []) {
        if (m.erp_field) fields.add(m.erp_field)
    }
    return [...fields]
}
