'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, useForm } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, type SelectOption } from '../shared'

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
    // Resolve the doctype this field belongs to. Two layouts are supported:
    //  - Workflows: path is `steps.N.field_mapping.M.target_field` → doctype at `steps.N.doctype`
    //  - ERPNext Sync Rules: path is `field_mappings.M.erp_field` (or `upsert_erp_field`) → doctype at root `doctype`
    const parts = path.split('.')
    const data = getData() as any
    const siteObj = data?.site
    const siteId = typeof siteObj === 'object' && siteObj !== null ? siteObj.id : siteObj

    const stepsIndex = parts.findIndex(p => p === 'steps')
    const doctype = stepsIndex !== -1
      ? data?.steps?.[parts[stepsIndex + 1]]?.doctype
      : data?.doctype

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

  const selectOptions = useMemo<SelectOption[]>(() =>
    options.map((opt) => ({
      label: `${opt.label} (${opt.value})`,
      value: opt.value,
    })),
  [options])

  const showEmpty = !loading && options.length === 0

  return (
    <FieldWrapper path={path} label="ERPNext Target Field" description="Field on the selected DocType to map data into.">
      {error && !options.length && <ErrorState message={error} />}
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
      {showEmpty && !error && <EmptyState message="No fields available. Select a DocType first." />}
    </FieldWrapper>
  )
}

export default ERPNextTargetFieldSelect
