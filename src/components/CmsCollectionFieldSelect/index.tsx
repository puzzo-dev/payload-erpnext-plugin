'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, useForm } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, StyledTextInput } from '../shared'

interface Option {
  value: string
  label: string
}

/**
 * Field component listing the writable fields of the rule's target collection
 * (from /api/cms-collection-fields). Reads the root-level `targetCollection` from the
 * form so it works both at the top level (upsert_payload_field) and inside the
 * field_mappings array rows (payload_field). Falls back to a plain text input.
 */
export const CmsCollectionFieldSelect: React.FC<{ path: string }> = ({ path }) => {
  const { value, setValue } = useField<string>({ path })
  const { getData } = useForm()
  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const data = getData() as { targetCollection?: string }
  const targetCollection = data?.targetCollection

  useEffect(() => {
    if (!targetCollection) {
      setOptions([])
      setError('Select a target collection first.')
      return
    }
    setLoading(true)
    setError(null)
    fetch(`/api/cms-collection-fields?collection=${encodeURIComponent(targetCollection)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ fields?: Option[] }>
      })
      .then((json) => setOptions(json.fields ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load fields'))
      .finally(() => setLoading(false))
  }, [targetCollection])

  const selectOptions = useMemo(() =>
    options.map((opt) => ({
      label: opt.label,
      value: opt.value,
    })),
  [options])

  const showFallback = error && options.length === 0
  const showEmpty = !loading && options.length === 0 && !error

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
      {showFallback && (
        <>
          <ErrorState message={`${error} Type the field name manually.`} />
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
      {showEmpty && <EmptyState message="No fields available. Select a target collection first." />}
    </FieldWrapper>
  )
}

export default CmsCollectionFieldSelect
