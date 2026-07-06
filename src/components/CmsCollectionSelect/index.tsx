'use client'

import React, { useEffect, useState } from 'react'
import { useField } from '@payloadcms/ui'

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

  return (
    <div style={{ marginBottom: '1rem' }}>
      <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}>
        Target Collection
      </label>
      {error && !options.length ? (
        <input
          type="text"
          value={value || ''}
          onChange={(e) => setValue(e.target.value)}
          placeholder="collection slug (e.g. catalogue-items)"
          style={inputStyle}
        />
      ) : (
        <select
          value={value || ''}
          onChange={(e) => setValue(e.target.value)}
          disabled={loading || options.length === 0}
          style={inputStyle}
        >
          <option value="">{loading ? 'Loading collections…' : 'Select a Collection'}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} ({opt.value})
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--theme-elevation-150, #d1d5db)',
  background: 'var(--theme-input-bg, #fff)',
  color: 'var(--theme-text, #111)',
}

export default CmsCollectionSelect
