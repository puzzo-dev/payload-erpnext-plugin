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
 *  - `strip_html` flatten ERPNext rich text to plain text. Frappe Text Editor fields
 *               come back as HTML (`<div><p>…</p></div>`) even when the Payload target
 *               is a plain textarea, so an un-transformed copy stores markup that every
 *               consumer then has to strip at render. Normalising here means the CMS
 *               holds prose an editor can actually read and edit.
 *  - `slugify`  URL-safe slug of the ERP value. Exists because required Payload `slug`
 *               fields have no ERPNext counterpart — Frappe doctypes carry a display
 *               name only, so an un-transformed map left `slug` empty and every create
 *               failed validation.
 *  - `link`     the same resolution as `lookup`, but with both settings DERIVED from
 *               Payload's own config instead of typed in: the target collection comes
 *               from the relationship field's `relationTo`, and the field to match on
 *               from that collection's `admin.useAsTitle`. Prefer this. Asking an
 *               operator to restate what Payload already declares is how a rule ends
 *               up matching against `parent` — a value that cannot ever resolve.
 *  - `lookup`   the manual form: name the collection and field yourself. Kept for
 *               polymorphic relationships and for matching on something other than
 *               the title field.
 *
 * Both link forms exist because copying a raw ERP string into a `relationship` field
 * is always invalid — the field wants a document ID, and Frappe's foreign key is the
 * docname.
 */
export type MappingTransform = 'none' | 'strip_html' | 'slugify' | 'link' | 'lookup'

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
 * Named entities that survive tag removal in ERPNext prose. `&amp;` is decoded
 * separately and last, so "&amp;lt;" yields the visible text "&lt;" rather than "<".
 */
const HTML_ENTITIES: Record<string, string> = {
    '&nbsp;': ' ',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&mdash;': '\u2014',
    '&ndash;': '\u2013',
    '&hellip;': '\u2026',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&ldquo;': '\u201c',
    '&rdquo;': '\u201d',
}

/** Numeric entities (&#8212; and &#x2014;), which rich-text editors emit freely. */
const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);/gi

/**
 * Flatten HTML to plain text.
 *
 * Deliberately a copy of @ivarse/shared-cms's stripHtml rather than an import: this
 * package is published to npm on its own and cannot depend on a workspace package.
 * The duplication is the cost of that boundary.
 *
 * Block-level boundaries become spaces so "</p><p>" does not weld two sentences
 * together, and runs of whitespace collapse.
 */
export function stripHtml(value: string): string {
    if (!value) return ''
    const text = value
        // Drop script/style bodies outright — their contents are not prose.
        .replace(/<(script|style)[\s>][\s\S]*?<\/\1>/gi, '')
        // Block and line-break boundaries carry a word gap; inline tags do not.
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '')
    const decoded = Object.entries(HTML_ENTITIES)
        .reduce((acc, [entity, char]) => acc.split(entity).join(char), text)
        .replace(NUMERIC_ENTITY, (match, code: string) => {
            const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10)
            return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
        })
    return decoded.split('&amp;').join('&').replace(/\s+/g, ' ').trim()
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

/**
 * Field types an ERPNext display name can be matched against.
 *
 * Anything else fails destructively rather than simply missing: Payload coerces the
 * string to the column's type before querying, so matching against a relationship,
 * id, number or date turns "Cocktails" into NaN and Postgres rejects the whole query.
 */
export const MATCHABLE_TYPES = new Set(['text', 'textarea', 'email', 'code', 'select', 'radio'])

export interface FieldConfigShape {
    type?: string
    name?: string
    relationTo?: string | string[]
    hasMany?: boolean
    fields?: unknown[]
    tabs?: Array<{ name?: string; fields?: unknown[] }>
}

/** A named top-level field's config, descending only through presentational wrappers. */
export function findFieldConfig(fields: unknown[] | undefined, name: string): FieldConfigShape | undefined {
    for (const f of fields ?? []) {
        const field = f as FieldConfigShape
        if (field.type === 'row' || field.type === 'collapsible') {
            const found = findFieldConfig(field.fields, name)
            if (found) return found
        } else if (field.type === 'tabs') {
            for (const tab of field.tabs ?? []) {
                const found = findFieldConfig(tab.fields, name)
                if (found) return found
            }
        } else if (field.name === name) {
            return field
        }
    }
    return undefined
}

/**
 * Which collection a `link` transform should search, read from the relationship field
 * itself. `relationTo` is Payload's own declaration of the link target, so there is
 * nothing for an operator to restate — and nothing for them to get wrong.
 */
export function describeRelationship(
    targetFields: unknown[] | undefined,
    payloadField: string,
    targetCollection: string,
): { collection: string; hasMany: boolean } | { reason: string } {
    const fieldConfig = findFieldConfig(targetFields, payloadField)
    if (!fieldConfig) return { reason: `"${payloadField}" is not a field on ${targetCollection}` }
    if (fieldConfig.type !== 'relationship') {
        return { reason: `"${payloadField}" is a ${fieldConfig.type} field, not a relationship — use "Copy as-is" or "Convert to slug" instead` }
    }
    if (Array.isArray(fieldConfig.relationTo)) {
        return { reason: `"${payloadField}" is polymorphic (${fieldConfig.relationTo.join(', ')}) — use the manual variant and name the collection explicitly` }
    }
    if (!fieldConfig.relationTo) return { reason: `"${payloadField}" declares no relationTo` }
    return { collection: fieldConfig.relationTo, hasMany: Boolean(fieldConfig.hasMany) }
}

/**
 * Which field of the related collection to match on: an explicit override if given,
 * otherwise `admin.useAsTitle` — Payload's own answer to "what identifies this document
 * to a human", which is exactly what a Frappe Link field stores.
 *
 * useAsTitle falls back to `id` when a collection does not set it, and an id match is
 * the NaN failure this transform exists to prevent, so the choice is always verified
 * against the actual field config rather than trusted.
 */
export function chooseMatchField(
    relatedFields: unknown[] | undefined,
    useAsTitle: string | undefined,
    override: string | null | undefined,
    collection: string,
): { field: string } | { reason: string } {
    const candidate = override || useAsTitle
    if (!candidate) {
        return { reason: `${collection} sets no admin.useAsTitle — set a "Match Against Field" override on this row` }
    }
    const candidateConfig = findFieldConfig(relatedFields, candidate)
    if (candidate === 'id' || !candidateConfig || !MATCHABLE_TYPES.has(candidateConfig.type ?? '')) {
        return { reason: `${collection}.${candidate} cannot hold an ERPNext display name — set a "Match Against Field" override naming a text field` }
    }
    return { field: candidate }
}
