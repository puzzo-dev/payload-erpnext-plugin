'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, useFormFields } from '@payloadcms/ui'

import {
  FieldWrapper,
  LoadingState,
  EmptyState,
  ErrorState,
  StyledSelect,
  StyledTextInput,
  fieldChrome,
  type ClientFieldConfig,
} from '../shared'

interface Option {
  value: string
  label: string
}

/**
 * Field component for a `Trigger ERP Action` step's **source** value.
 *
 * The target side of the mapping already had a picker (ERPNextTargetFieldSelect), but
 * the source side was a bare text input, so the Payload field names had to be recalled
 * and typed by hand as `{{doc.whatever}}` — with a typo surfacing only later, at run
 * time, as an unresolved variable.
 *
 * The options come from the workflow's own trigger collections: the root-level
 * `collections` field, read reactively so picking a collection repopulates this
 * immediately. Field names are fetched from /api/cms-collection-fields, an endpoint
 * this plugin already ships, so nothing has to be injected by the host.
 *
 * A free-text input sits alongside the select on purpose. A source is not always a
 * collection field — it is just as often a literal ("Open"), or a variable produced by
 * an earlier step ({{erp_name}}, {{created_id}}), neither of which this list can know
 * about. The select fills in the common case; the input keeps the uncommon one possible.
 */
export const WorkflowSourceSelect: React.FC<{ path: string; field?: ClientFieldConfig }> = ({ path, field }) => {
  const { label, description } = fieldChrome(
    field,
    'Source Value',
    'A collection field, a literal value, or a variable from an earlier step (e.g. {{erp_name}}).',
  )
  const { value, setValue } = useField<string>({ path })

  // Selector form, not the whole form object: subscribing to every field would re-run
  // the fetch below on each keystroke anywhere in the workflow.
  const rawCollections = useFormFields(([fields]) => fields?.collections?.value)
  const collections: string[] = useMemo(() => {
    if (Array.isArray(rawCollections)) return rawCollections.filter((c): c is string => typeof c === 'string')
    return typeof rawCollections === 'string' && rawCollections ? [rawCollections] : []
  }, [rawCollections])

  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    if (collections.length === 0) {
      setOptions([])
      setFetchError(null)
      return
    }
    setLoading(true)
    setFetchError(null)
    Promise.all(
      collections.map(async (collection) => {
        const res = await fetch(`/api/cms-collection-fields?collection=${encodeURIComponent(collection)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${collection}`)
        const json = (await res.json()) as { fields?: Array<{ value: string; label: string }> }
        // Prefixed with the collection when a workflow watches more than one, so two
        // collections sharing a field name stay tellable apart in the list.
        return (json.fields ?? []).map((f) => ({
          value: `{{doc.${f.value}}}`,
          label: collections.length > 1 ? `${collection} → ${f.label}` : f.label,
        }))
      }),
    )
      .then((results) => {
        const merged = results.flat()
        merged.sort((a, b) => a.label.localeCompare(b.label))
        setOptions(merged)
      })
      .catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load fields')
        setOptions([])
      })
      .finally(() => setLoading(false))
  }, [collections])

  // The select only shows a selection when the current value is one of its options;
  // anything hand-typed leaves it blank rather than misreporting an unrelated field.
  const isKnownOption = options.some((o) => o.value === value)

  return (
    <FieldWrapper path={path} label={label} description={description}>
      {loading && <LoadingState message="Loading fields…" />}
      {!loading && collections.length === 0 && (
        <EmptyState message="Select the workflow's trigger collection first to list its fields." />
      )}
      {!loading && fetchError && <ErrorState message={`${fetchError}. Type the value manually.`} />}
      {!loading && options.length > 0 && (
        <StyledSelect
          path={path}
          value={isKnownOption ? value : ''}
          options={options}
          placeholder="Insert a collection field…"
          onChange={(selected) => setValue(selected)}
        />
      )}
      <div style={{ marginTop: options.length > 0 ? '0.5rem' : 0 }}>
        <StyledTextInput
          path={path}
          value={value || ''}
          onChange={(val) => setValue(val)}
          placeholder="{{doc.email}}, {{erp_name}}, or a literal value"
        />
      </div>
    </FieldWrapper>
  )
}

export default WorkflowSourceSelect
