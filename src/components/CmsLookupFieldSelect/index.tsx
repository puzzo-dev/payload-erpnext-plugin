'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, StyledTextInput } from '../shared'

interface Option {
  value: string
  label: string
}

/**
 * Field component for a `lookup` mapping row's "Match Against Field".
 *
 * Deliberately NOT CmsCollectionFieldSelect: that one always lists the fields of the
 * rule's root-level `targetCollection`, which is the wrong collection here. A lookup
 * searches a DIFFERENT collection (the relationship's target, e.g. catalogue-categories
 * for an item's category), named by `lookup_collection` on the same array row. So the
 * sibling path is derived from this component's own path —
 * `field_mappings.2.lookup_field` → `field_mappings.2.lookup_collection` — which keeps
 * it working at any row index without needing the row index passed in.
 */
export const CmsLookupFieldSelect: React.FC<{ path: string }> = ({ path }) => {
  const { value, setValue } = useField<string>({ path })
  const siblingPath = useMemo(() => {
    const segments = path.split('.')
    segments[segments.length - 1] = 'lookup_collection'
    return segments.join('.')
  }, [path])
  const { value: lookupCollection } = useField<string | null>({ path: siblingPath })
  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    if (!lookupCollection) {
      setOptions([])
      setFetchError(null)
      return
    }
    setLoading(true)
    setFetchError(null)
    fetch(`/api/cms-collection-fields?collection=${encodeURIComponent(lookupCollection)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ fields?: Option[] }>
      })
      .then((json) => setOptions(json.fields ?? []))
      .catch((err) => setFetchError(err instanceof Error ? err.message : 'Failed to load fields'))
      .finally(() => setLoading(false))
  }, [lookupCollection])

  const selectOptions = useMemo(() =>
    options.map((opt) => ({
      label: opt.label,
      value: opt.value,
    })),
  [options])

  const label = 'Match Against Field'
  const description = 'Field in the lookup collection compared to the ERPNext value (e.g. name).'

  if (!lookupCollection) {
    return (
      <FieldWrapper path={path} label={label} description={description}>
        <EmptyState message="Select a lookup collection first." />
      </FieldWrapper>
    )
  }

  return (
    <FieldWrapper path={path} label={label} description={description}>
      {loading && <LoadingState message="Loading fields…" />}
      {!loading && options.length > 0 && (
        <StyledSelect
          path={path}
          value={value || ''}
          options={selectOptions}
          placeholder="Select a Field"
          onChange={(selected) => setValue(selected)}
        />
      )}
      {!loading && options.length === 0 && fetchError && (
        <>
          <ErrorState message={`${fetchError}. Type the field name manually.`} />
          <div style={{ marginTop: '0.5rem' }}>
            <StyledTextInput
              path={path}
              value={value || ''}
              onChange={(val) => setValue(val)}
              placeholder="field name"
            />
          </div>
        </>
      )}
      {!loading && options.length === 0 && !fetchError && <EmptyState message="No fields found on this collection." />}
    </FieldWrapper>
  )
}

export default CmsLookupFieldSelect
