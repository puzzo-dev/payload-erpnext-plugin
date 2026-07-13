'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, StyledTextInput } from '../shared'

interface Option {
  value: string
  label: string
}

/**
 * Field component listing the writable fields of the rule's target collection
 * (from /api/cms-collection-fields). Reads the root-level `targetCollection`
 * field reactively (useField, not a mount-only getData() read), so it works
 * wherever it's used — field_mappings rows, constant_values rows, or the
 * standalone statusField — and actually re-fetches once a collection is
 * picked instead of only checking it once on first render.
 */
export const CmsCollectionFieldSelect: React.FC<{ path: string }> = ({ path }) => {
  const { value, setValue } = useField<string>({ path })
  const { value: targetCollection } = useField<string | null>({ path: 'targetCollection' })
  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    if (!targetCollection) {
      setOptions([])
      setFetchError(null)
      return
    }
    setLoading(true)
    setFetchError(null)
    fetch(`/api/cms-collection-fields?collection=${encodeURIComponent(targetCollection)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ fields?: Option[] }>
      })
      .then((json) => setOptions(json.fields ?? []))
      .catch((err) => setFetchError(err instanceof Error ? err.message : 'Failed to load fields'))
      .finally(() => setLoading(false))
  }, [targetCollection])

  const selectOptions = useMemo(() =>
    options.map((opt) => ({
      label: opt.label,
      value: opt.value,
    })),
  [options])

  // Nothing to pick yet — a plain info message, no error styling and no
  // free-typing escape hatch (typing a field name before a collection is
  // even chosen isn't meaningful, since there's nothing to validate against).
  if (!targetCollection) {
    return (
      <FieldWrapper path={path} label="Payload Field" description="Field on the target Payload collection to map data into.">
        <EmptyState message="Select a target collection first." />
      </FieldWrapper>
    )
  }

  return (
    <FieldWrapper path={path} label="Payload Field" description="Field on the target Payload collection to map data into.">
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
              placeholder="payload field name"
            />
          </div>
        </>
      )}
      {!loading && options.length === 0 && !fetchError && <EmptyState message="No fields found on this collection." />}
    </FieldWrapper>
  )
}

export default CmsCollectionFieldSelect
