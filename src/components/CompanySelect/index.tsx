'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, useDocumentInfo } from '@payloadcms/ui'

import type { ERPNextCompanyOption } from '../../types'
import { FieldWrapper, LoadingState, EmptyState, StyledSelect } from '../shared'

/**
 * Custom Field component for `erpnextCompany`.
 *
 * Fetches the available companies directly from the document API,
 * bypassing the need for the JSON field to be in form state.
 */
export const CompanySelectField: React.FC<{ path: string; field: { name: string; label?: string; admin?: { description?: string } } }> = ({ path, field }) => {
    const { value, setValue } = useField<string>({ path })
    const { id } = useDocumentInfo()
    const [companies, setCompanies] = useState<ERPNextCompanyOption[]>([])
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!id) return

        setLoading(true)
        fetch(`/api/erpnext-config/${id}?depth=0`)
            .then((res) => res.json())
            .then((doc) => {
                const fetched = doc?.availableCompanies
                if (Array.isArray(fetched)) {
                    setCompanies(fetched as ERPNextCompanyOption[])
                } else if (typeof fetched === 'string') {
                    try { setCompanies(JSON.parse(fetched)) } catch { /* ignore */ }
                }
            })
            .catch(() => { /* ignore fetch errors */ })
            .finally(() => setLoading(false))
    }, [id])

    const options = useMemo(() =>
        companies.map((c) => ({
            label: `${c.company_name}${c.country ? ` (${c.country})` : ''}`,
            value: c.name,
        })),
    [companies])

    const hasCompanies = companies.length > 0

    return (
        <FieldWrapper path={path} label={field.label || 'ERPNext Company'} description={field.admin?.description}>
            {loading ? (
                <LoadingState message="Loading companies…" />
            ) : hasCompanies ? (
                <StyledSelect
                    path={path}
                    value={value || ''}
                    options={options}
                    placeholder="Select a company"
                    onChange={(selected) => setValue(selected)}
                />
            ) : (
                <EmptyState
                    message={
                        id
                            ? 'No companies loaded yet. Save your API credentials, then refresh this page.'
                            : 'Save the document first, then companies will be fetched automatically.'
                    }
                />
            )}
        </FieldWrapper>
    )
}

