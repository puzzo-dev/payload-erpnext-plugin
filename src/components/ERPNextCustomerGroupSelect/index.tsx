'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledSelect, type SelectOption } from '../shared'

interface GroupOption {
    value: string
    label: string
}

/**
 * Field component listing ERPNext's real Customer Groups (fetched live from
 * the connected site), so "promote to group" picks an existing group instead
 * of hand-typing a name that has to match ERPNext exactly. Genuinely
 * optional — the field itself may be left blank (no promotion for that
 * status), so an empty selection is a normal, valid state, not an error.
 */
export const ERPNextCustomerGroupSelect: React.FC<{ path: string }> = ({ path }) => {
    const { value, setValue } = useField<string>({ path })
    const { value: siteValue } = useField<string | number | { id: string | number } | null>({ path: 'site' })
    const [options, setOptions] = useState<GroupOption[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const siteId = typeof siteValue === 'object' && siteValue !== null ? siteValue.id : siteValue

        if (!siteId) {
            setOptions([])
            setError('Select a site to load Customer Groups from ERPNext.')
            return
        }

        setLoading(true)
        setError(null)

        fetch(`/api/erpnext-customer-groups?siteId=${siteId}`)
            .then(async (res) => {
                if (!res.ok) {
                    const body = (await res.json().catch(() => ({}))) as { error?: string }
                    throw new Error(body.error || `HTTP ${res.status}`)
                }
                return res.json() as Promise<{ groups?: GroupOption[] }>
            })
            .then((json) => setOptions(json.groups ?? []))
            .catch((err) => {
                setError(err instanceof Error ? err.message : 'Failed to load Customer Groups')
                setOptions([])
            })
            .finally(() => setLoading(false))
    }, [siteValue])

    const selectOptions = useMemo<SelectOption[]>(() =>
        options.map((opt) => ({ label: opt.label, value: opt.value })),
    [options])

    return (
        <FieldWrapper path={path} label="Promote To Group" description="Optional — promote the customer to this ERPNext group when this status is reached. Leave blank for no promotion on this status.">
            {loading && <LoadingState message="Loading Customer Groups…" />}
            {!loading && options.length > 0 && (
                <StyledSelect
                    path={path}
                    value={value || ''}
                    options={selectOptions}
                    placeholder="No promotion"
                    onChange={(selected) => setValue(selected)}
                />
            )}
            {!loading && options.length === 0 && error && <ErrorState message={error} />}
            {!loading && options.length === 0 && !error && <EmptyState message="No Customer Groups found in ERPNext." />}
        </FieldWrapper>
    )
}

export default ERPNextCustomerGroupSelect
