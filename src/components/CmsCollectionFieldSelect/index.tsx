'use client'

import React, { useEffect, useState } from 'react'
import { useField, useForm } from '@payloadcms/ui'

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

  return (
    <div style={{ marginBottom: '1rem' }}>
      <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}>
        Payload Field
      </label>
      {error && !options.length ? (
        <input
          type="text"
          value={value || ''}
          onChange={(e) => setValue(e.target.value)}
          placeholder="payload field name"
          style={inputStyle}
        />
      ) : (
        <select
          value={value || ''}
          onChange={(e) => setValue(e.target.value)}
          disabled={loading || options.length === 0}
          style={inputStyle}
        >
          <option value="">{loading ? 'Loading fields…' : 'Select a Field'}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
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

export default CmsCollectionFieldSelect
