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
 *
 * When the workflow watches form-submissions, a form picker appears alongside: a
 * submission doc's own columns (id, form, submissionData) are just the container — the
 * data worth mapping lives in submissionData rows keyed by the PARENT FORM's field
 * names, which the workflow engine flattens to {{doc.values.<name>}} at run time. So
 * mapping submission data into ERPNext requires picking the form first; its fields then
 * appear here as {{doc.values.<field>}} options. Other collections are their own schema
 * and keep the plain {{doc.<field>}} listing.
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

  const watchesFormSubmissions = collections.includes('form-submissions')
  const [forms, setForms] = useState<Array<{ id: string | number; title: string }>>([])
  const [selectedFormId, setSelectedFormId] = useState('')
  const [formValueOptions, setFormValueOptions] = useState<Option[]>([])

  // Form list — only fetched when the workflow watches form submissions.
  useEffect(() => {
    if (!watchesFormSubmissions) {
      setForms([])
      setSelectedFormId('')
      return
    }
    fetch('/api/forms?limit=200&depth=0&sort=title')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: { docs?: Array<{ id: string | number; title?: string; slug?: string }> }) => {
        const list = (json.docs ?? []).map((d) => ({ id: d.id, title: d.title ?? d.slug ?? String(d.id) }))
        list.sort((a, b) => a.title.localeCompare(b.title))
        setForms(list)
        if (list.length === 1) setSelectedFormId(String(list[0].id))
      })
      .catch(() => setForms([]))
  }, [watchesFormSubmissions])

  // Field names of the chosen form → {{doc.values.<name>}}.
  useEffect(() => {
    if (!selectedFormId) {
      setFormValueOptions([])
      return
    }
    const formTitle = forms.find((f) => String(f.id) === selectedFormId)?.title ?? 'form'
    fetch(`/api/forms/${encodeURIComponent(selectedFormId)}?depth=0`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: { fields?: Array<{ blockType?: string; name?: string; label?: string | null }> }) => {
        setFormValueOptions(
          (json.fields ?? [])
            .filter((b) => typeof b?.name === 'string' && b.name && b.blockType !== 'message')
            .map((b) => ({
              value: `{{doc.values.${b.name}}}`,
              label: `${formTitle} → ${b.label || b.name}`,
            })),
        )
      })
      .catch(() => setFormValueOptions([]))
  }, [selectedFormId, forms])

  const mergedOptions = useMemo(() => {
    const merged = [...options, ...formValueOptions]
    merged.sort((a, b) => a.label.localeCompare(b.label))
    return merged
  }, [options, formValueOptions])

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
  const isKnownOption = mergedOptions.some((o) => o.value === value)

  return (
    <FieldWrapper path={path} label={label} description={description}>
      {loading && <LoadingState message="Loading fields…" />}
      {!loading && collections.length === 0 && (
        <EmptyState message="Select the workflow's trigger collection first to list its fields." />
      )}
      {!loading && fetchError && <ErrorState message={`${fetchError}. Type the value manually.`} />}
      {watchesFormSubmissions && forms.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <StyledSelect
            path={`${path}-form-picker`}
            value={selectedFormId}
            options={forms.map((f) => ({ label: f.title, value: String(f.id) }))}
            placeholder="Form submission fields — pick a form to list its fields"
            onChange={setSelectedFormId}
          />
        </div>
      )}
      {!loading && mergedOptions.length > 0 && (
        <StyledSelect
          path={path}
          value={isKnownOption ? value : ''}
          options={mergedOptions}
          placeholder="Insert a collection field…"
          onChange={(selected) => setValue(selected)}
        />
      )}
      <div style={{ marginTop: mergedOptions.length > 0 ? '0.5rem' : 0 }}>
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
