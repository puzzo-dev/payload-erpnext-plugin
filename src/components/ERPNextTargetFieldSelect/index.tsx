'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, type SelectOption } from '../shared'

interface Option {
  value: string
  label: string
}

export const ERPNextTargetFieldSelect: React.FC<{ path: string }> = ({ path }) => {
  const { value, setValue } = useField<string>({ path })

  // Resolve the doctype this field belongs to. Two layouts are supported:
  //  - Workflows: path is `steps.N.field_mapping.M.target_field` → doctype at `steps.N.doctype`
  //  - ERPNext Sync Rules: path is `field_mappings.M.erp_field` → doctype at root `doctype`
  // `path` is a static prop for a mounted field instance, so this is safe to
  // compute once rather than needing to be part of the reactive dependency.
  const parts = path.split('.')
  const stepsIndex = parts.findIndex(p => p === 'steps')
  const doctypePath = stepsIndex !== -1 ? `steps.${parts[stepsIndex + 1]}.doctype` : 'doctype'

  // Reactive, not read-once-on-mount via getData() (deps: [getData, path] —
  // neither ever changes after mount, so picking a site/doctype after the
  // component first rendered — always true, since neither is set yet when a
  // brand-new document's form first loads — never re-triggered the fetch,
  // and the "select a site/doctype first" message just sat there forever).
  const { value: siteValue } = useField<string | number | { id: string | number } | null>({ path: 'site' })
  const { value: doctypeValue } = useField<string | null>({ path: doctypePath })

  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const siteId = typeof siteValue === 'object' && siteValue !== null ? siteValue.id : siteValue
    const doctype = doctypeValue

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
  }, [siteValue, doctypeValue])

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
