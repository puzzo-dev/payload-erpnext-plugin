'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, StyledTextInput } from '../shared'

interface Option {
  value: string
  label: string
}

/**
 * Field component listing Payload collections (from /api/cms-collections) so a sync
 * rule's target collection is picked, not typed. Falls back to a plain text input if
 * the fetch fails.
 */
export const CmsCollectionSelect: React.FC<{ path: string }> = ({ path }) => {
  const { value, setValue } = useField<string>({ path })
  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch('/api/cms-collections')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ collections?: Option[] }>
      })
      .then((json) => setOptions(json.collections ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load collections'))
      .finally(() => setLoading(false))
  }, [])

  const selectOptions = useMemo(() =>
    options.map((opt) => ({
      label: `${opt.label} (${opt.value})`,
      value: opt.value,
    })),
  [options])

  const showFallback = error && options.length === 0
  const showEmpty = !loading && options.length === 0 && !error

  return (
    <FieldWrapper path={path} label="Target Collection" description="Payload collection that incoming ERPNext data will sync into.">
      {loading && <LoadingState message="Loading collections…" />}
      {!loading && options.length > 0 && (
        <StyledSelect
          path={path}
          value={value || ''}
          options={selectOptions}
          placeholder="Select a Collection"
          onChange={(selected) => setValue(selected)}
        />
      )}
      {showFallback && (
        <>
          <ErrorState message={`${error} Type the collection slug manually.`} />
          <div style={{ marginTop: '0.5rem' }}>
            <StyledTextInput
              path={path}
              value={value || ''}
              onChange={(val) => setValue(val)}
              placeholder="e.g. catalogue-items"
            />
          </div>
        </>
      )}
      {showEmpty && <EmptyState message="No collections available." />}
    </FieldWrapper>
  )
}

export default CmsCollectionSelect
