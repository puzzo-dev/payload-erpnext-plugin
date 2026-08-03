# Changelog

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
