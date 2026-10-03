# Changelog

## 2.4.4

### Fixed

- An organization admin can configure ERPNext for every site in their organization.
  Their account has no single site, and the previous check rejected that account.

## 2.4.3

### Fixed
- ERP-synced records were not being published. The sync wrote `_status`, Payload's
  draft/publish flag, but the `20260824_100500_remove_versioning` migration removed
  versioning from these collections — so `_status` no longer exists and the write did
  nothing. It now sets the plain `status` field the collections actually have.
- Dropped `draft: true` from the upsert and lookup queries for the same reason: with
  versioning gone the option is meaningless.

### Changed
- Hardened `rateLimit` and `ssrfGuard`, with tests for both.
- Export `getUpsertKeyMapping` and `erpFetchFields` so callers can assert a rule is
  configured before running a sync.
- Documented the canonical sources for the mirrored `organizationField` and
  credential-crypto helpers.

## 2.4.0

### Added

- **Source values in a Trigger ERP Action step are now picked, not typed.** The target
  side of the mapping already had a picker; the source side was a bare text input, so
  Payload field names had to be recalled and typed as `{{doc.whatever}}`, with a typo
  surfacing only later at run time as an unresolved variable.

  Options come from the workflow's own trigger collections — the root-level `collections`
  field, read reactively so choosing a collection repopulates the list immediately — via
  `/api/cms-collection-fields`, an endpoint this plugin already ships. Nothing has to be
  injected by the host.

  A free-text input sits alongside the select deliberately: a source is often a literal,
  or a variable produced by an earlier step (`{{erp_name}}`, `{{created_id}}`), neither
  of which the list can know about.

## 2.3.0

### Added

- **`create it if missing` on a link row.** A `link`/`lookup` that resolved to nothing
  left the field unset, so a required relationship failed the whole record. That made
  rule ORDER load-bearing and undocumented: on a fresh site the Item Group rule had to
  be saved before the Item rule, or all 17 items failed with "Category invalid" and
  nothing said why. The live webhook had a permanent version of it — an Item arriving
  before its Item Group had ever synced failed and stayed failed, with no retry.

  Ticked, the missing target is created from the ERPNext value. Frappe's Link field
  guarantees that document exists upstream, so its absence in Payload is a gap in what
  has been synced rather than bad data.

  Only derivable fields are filled: the matched field (the ERPNext value by
  definition), a required `slug` (always a function of the name), and the site, plus the
  site's organization for tenant-scoped collections. Anything else the collection
  requires is left for Payload to reject, and the error names it so a Constant Value can
  be added — inventing values would produce records that validate and mean nothing.

  Off by default. Creating records nobody asked for is how a catalogue ends up holding
  ERPNext scaffolding like "All Item Groups" and "Raw Material".

### Migration required

- `erpnext_sync_rules_field_mappings.create_if_missing` (boolean, default false). See
  `payload-cms/src/migrations/20260804_090000_erpnext_sync_rules_create_if_missing.ts`.

## 2.2.0

### Added

- **`strip_html` transform.** Frappe Text Editor fields come back from the REST API as
  HTML, so an Item's description arrives as `<div><p>…</p></div>` even when the Payload
  target is a plain `textarea`. Copying it verbatim stored markup in a plain-text field,
  which rendered as literal tags on the storefront and left every consumer to strip it at
  render time. Normalising at sync means the CMS holds prose an editor can read and edit,
  and each consumer stops re-deriving the same cleanup.

  Block boundaries become spaces so `</p><p>` does not weld two sentences together,
  script and style bodies are dropped, and named plus numeric entities are decoded —
  with `&amp;` decoded last so `&amp;lt;` reads as visible text rather than becoming
  markup.

  Opt-in per mapping row: a field whose Payload target genuinely is rich text keeps its
  markup by leaving the row on "Copy as-is".

### Migration required

- `erpnext_sync_rules_field_mappings.transform` gains the enum value `strip_html`. See
  `payload-cms/src/migrations/20260803_210000_erpnext_sync_rules_strip_html_transform.ts`.

## 2.1.0

### Added

- **`link` transform — relationships resolve themselves.** Pick the Payload field and
  nothing else. The plugin reads `relationTo` off the relationship field to learn which
  collection to search, and that collection's `admin.useAsTitle` to learn which field
  holds the human-readable identifier — which is exactly what a Frappe Link field
  stores. Both were already declared in Payload's config; `lookup` merely asked an
  operator to restate them, which is how a rule ends up matching against a relationship
  field and failing every record.

  ```
  before (lookup)                        after (link)
    Payload Field:  category               Payload Field: category
    Look Up In:     catalogue-categories     (from relationTo)
    Match Against:  name                     (from useAsTitle)
  ```

  `hasMany` relationships receive an array. An optional **Match Against Field** override
  remains for when the ERPNext value lives somewhere other than the title field.

  Cases `link` refuses rather than guesses, each naming the rule and field in the log:
  a polymorphic `relationTo`, a non-relationship target, a collection with no
  `useAsTitle`, and a `useAsTitle` resolving to `id` or any non-text field — Payload
  defaults `useAsTitle` to `id`, which is the very failure this transform prevents.

### Changed

- `lookup` is retained unchanged, for polymorphic relationships and for matching on a
  field other than the title. Existing rules are untouched — `link` is opt-in.

### Migration required

- `erpnext_sync_rules_field_mappings.transform` gains the enum value `link`. See
  `payload-cms/src/migrations/20260803_180000_erpnext_sync_rules_link_transform.ts`.
  `ALTER TYPE ... ADD VALUE` is transaction-safe on Postgres 12+ as long as the value
  is not used in the same transaction, which it is not.

## 2.0.2

### Fixed

- **`CmsCollectionSelect` showed the wrong label when reused for a lookup.** It
  hardcoded "Target Collection — Payload collection that incoming ERPNext data will sync
  into", so a Field Mapping row's **Look Up In Collection** rendered with that text. An
  Item rule with a lookup into `catalogue-categories` therefore read as though items
  synced *into* the category collection — the exact opposite of what the setting does.
  2.0.1 fixed this for `CmsCollectionFieldSelect` but missed its sibling.
- All three collection/field pickers now take label and description from the field they
  are attached to, via a shared `fieldChrome` helper, with the previous hardcoded strings
  as fallbacks.

## 2.0.1

### Fixed

- **A `lookup` transform pointed at a non-text field no longer fails destructively.**
  Payload coerces the compared value to the target column's type before querying, so
  matching an ERPNext display name against a `relationship`, `upload`, `number`, `date`
  or `id` field turned e.g. `"Cocktails"` into `NaN` and Postgres rejected the whole
  query — surfacing as a raw SQL string logged once per record for an entire backfill,
  with no indication of which setting caused it. Three layers now prevent that:
  - `resolveLookup` catches query failures and logs which collection, field and value
    were involved, then treats the row as unresolved like any other miss.
  - The **Match Against Field** picker only offers field types that can hold a display
    name (`text`, `textarea`, `email`, `code`, `select`, `radio`).
  - Saving a rule whose lookup field cannot hold text is rejected with a message naming
    the offending row, which also catches rows saved by an earlier version.

- **Field pickers show their own label and description again.** `CmsCollectionFieldSelect`
  hardcoded "Payload Field" and one generic description, so every use rendered
  identically. On the Advanced tab that left **Sync Timestamp** and **Status Sync** as
  two indistinguishable "Payload Field" pickers with no way to tell which was which.
  Both now come from the field's own config, falling back to the generic pair.

### Changed

- `GET /api/cms-collection-fields` returns a `type` alongside each field's `value` and
  `label`, so callers can filter by what a field is able to hold. Existing consumers
  ignoring the extra key are unaffected.

## 2.0.0

### Breaking

- **`mapErpRecord` is now async and takes different arguments.** Resolving a `lookup`
  transform requires a database query, so the signature changed from
  `mapErpRecord(rule, erpRecord)` to
  `await mapErpRecord(req, rule, erpRecord, siteId, log?)`. Callers outside this package
  must be updated. `upsertErpRecord`, `deleteErpRecord` and `backfillSyncRule` are
  unchanged.
- **`backfillSyncRule` returns a new shape.** `{ pulled, created, updated, skipped }`
  became `{ pulled, created, updated, skipped, failed, errors }`. Records rejected by
  the target collection now count as `failed`, not `skipped` — anything reading the old
  `skipped` count to mean "went wrong" will under-report, and anything persisting the
  result (`lastBackfillStats`) will start seeing two extra keys.

### Added

- **Value transforms on field mappings.** Each mapping row has a `transform`:
  - `slugify` — writes a URL-safe slug of the ERPNext display name, for required `slug`
    fields that have no ERPNext counterpart.
  - `lookup` — resolves an ERPNext display value to a related document's ID via
    `lookup_collection` / `lookup_field`, so `relationship` fields can be synced.
    Site-scoped when the looked-up collection has a `site` field; an unmatched lookup
    leaves the field unset and warns instead of writing a bad reference.

  `none` is the default, so existing rules are unaffected. Transforms apply to the
  upsert key as well, since the stored value is the transformed one.
- **`syncedAtField`** on a rule — a Payload date field stamped with the time of every
  successful upsert, updates included, so an already-linked record still shows when it
  last synced. Distinct from ERPNext's own `modified` date.
- **`CmsLookupFieldSelect`** admin component, listing the fields of the row's
  `lookup_collection` rather than the rule's `targetCollection`.
- **`errors`** in the backfill stats — up to five distinct failure reasons, surfaced in
  the admin's "Last Backfill Result" instead of only in the server log.

### Changed

- Pure mapping logic moved to `src/sync/transforms.ts`. `runSyncRule.ts` re-exports all
  of it, so imports are unaffected. The split exists because `runSyncRule`'s import
  chain starts a rate-limiter cleanup interval at module load, which kept any test
  process that imported it alive indefinitely.

### Migration required

Consumers must add these columns — see
`payload-cms/src/migrations/20260803_120000_erpnext_sync_rules_transforms_and_synced_at.ts`
for a reference implementation:

- `erpnext_sync_rules_field_mappings.transform` (enum `none`/`slugify`/`lookup`, default `none`)
- `erpnext_sync_rules_field_mappings.lookup_collection` (varchar, nullable)
- `erpnext_sync_rules_field_mappings.lookup_field` (varchar, nullable)
- `erpnext_sync_rules.synced_at_field` (varchar, nullable)
