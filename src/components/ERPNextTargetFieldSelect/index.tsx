'use client'

import React, { useEffect, useState } from 'react'
import { useField, useForm } from '@payloadcms/ui'

interface Option {
  value: string
  label: string
}

export const ERPNextTargetFieldSelect: React.FC<{ path: string }> = ({ path }) => {
  const { value, setValue } = useField<string>({ path })
  const { getData } = useForm()
  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // path is e.g. steps.0.field_mapping.0.target_field
    // we need site (from root) and doctype (from steps.0.doctype)
    const parts = path.split('.')
    const blockIndex = parts.findIndex(p => p === 'steps') + 1
    const blockNum = parts[blockIndex]
    
    const data = getData() as any
    const siteObj = data?.site
    const siteId = typeof siteObj === 'object' && siteObj !== null ? siteObj.id : siteObj
    const doctype = data?.steps?.[blockNum]?.doctype

    if (!siteId) {
      setOptions([])
      setError('Select a site first.')
      return
    }

    if (!doctype) {
      setOptions([])
      setError('Select an ERPNext DocType first.')
      return
    }

    setLoading(true)
    setError(null)
    
    fetch(`/api/erpnext-doctype-fields?siteId=${siteId}&doctype=${doctype}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: { fields?: Option[] }) => {
        setOptions(json.fields ?? [])
      })
      .catch((err) => {
        setError(err.message)
      })
      .finally(() => setLoading(false))
  }, [getData, path])

  return (
    <div style={{ marginBottom: '1rem' }}>
      <label className="field-label" style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}>
        ERPNext Target Field
      </label>
      {error && !options.length && (
        <div style={{ color: 'var(--theme-warning-500, #f59e0b)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
          {error}
        </div>
      )}
      <select
        value={value || ''}
        onChange={(e) => setValue(e.target.value)}
        disabled={loading || options.length === 0}
        style={{
          width: '100%',
          padding: '0.5rem',
          borderRadius: '0.25rem',
          border: '1px solid var(--theme-elevation-150, #d1d5db)',
          background: 'var(--theme-input-bg, #fff)',
          color: 'var(--theme-text, #111)',
        }}
      >
        <option value="">{loading ? 'Loading fields…' : 'Select a Field'}</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label} ({opt.value})
          </option>
        ))}
      </select>
    </div>
  )
}

export default ERPNextTargetFieldSelect
