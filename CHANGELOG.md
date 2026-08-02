# Changelog

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
