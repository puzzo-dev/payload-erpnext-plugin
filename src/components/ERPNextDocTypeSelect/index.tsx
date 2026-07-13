'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, useForm } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, type SelectOption } from '../shared'

interface DocTypeOption {
    value: string
    label: string
    module?: string
}

/**
 * Custom field component that lists ERPNext DocTypes from the site connection.
 *
 * Reads the `site` relationship on the current workflow document and fetches
 * available DocTypes from `/api/erpnext-doctypes`. Falls back to a plain text
 * input if no site is selected or the fetch fails.
 */
export const ERPNextDocTypeSelect: React.FC<{ path: string }> = ({ path }) => {
    const { value, setValue } = useField<string>({ path })
    const { getData } = useForm()
    const [options, setOptions] = useState<DocTypeOption[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const data = getData() as { site?: string | number | { id: string | number } | null }
        const siteId = typeof data.site === 'object' && data.site !== null
            ? (data.site as { id: string | number }).id
            : data.site

        if (!siteId) {
            setOptions([])
            setError('Select a site to load DocTypes from ERPNext.')
            return
        }

        setLoading(true)
        setError(null)

        fetch(`/api/erpnext-doctypes?siteId=${siteId}`)
            .then(async (res) => {
                if (!res.ok) {
                    const body = (await res.json().catch(() => ({}))) as { error?: string }
                    throw new Error(body.error || `HTTP ${res.status}`)
                }
                return res.json() as { doctypes?: DocTypeOption[] }
            })
            .then((json) => {
                setOptions(json.doctypes ?? [])
            })
            .catch((err) => {
                setError(err instanceof Error ? err.message : 'Failed to load DocTypes')
                setOptions([])
            })
            .finally(() => setLoading(false))
    }, [getData])

    const selectOptions = useMemo<SelectOption[]>(() =>
        options.map((opt) => ({
            label: `${opt.label}${opt.module ? ` — ${opt.module}` : ''}`,
            value: opt.value,
        })),
    [options])

    const showEmpty = !loading && options.length === 0

    return (
        <FieldWrapper path={path} label="ERPNext DocType" description="DocType to create or read in ERPNext.">
            {error && !options.length && <ErrorState message={error} />}
            {loading && <LoadingState message="Loading DocTypes…" />}
            {!loading && options.length > 0 && (
                <StyledSelect
                    path={path}
                    value={value || ''}
                    options={selectOptions}
                    placeholder="Select a DocType"
                    onChange={(selected) => setValue(selected)}
                />
            )}
            {showEmpty && !error && <EmptyState message="No DocTypes available. Select a site first." />}
        </FieldWrapper>
    )
}

export default ERPNextDocTypeSelect
