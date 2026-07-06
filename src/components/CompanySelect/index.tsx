'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, useDocumentInfo, FieldLabel, SelectInput } from '@payloadcms/ui'

import type { ERPNextCompanyOption } from '../../types'

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

    const options = useMemo(() => [
        { label: '— Select a company —', value: '' },
        ...companies.map((c) => ({
            label: `${c.company_name}${c.country ? ` (${c.country})` : ''}`,
            value: c.name,
        })),
    ], [companies])

    const hasCompanies = companies.length > 0

    return (
        <div style={{ marginBottom: '1.5rem' }}>
            <FieldLabel label={field.label || 'ERPNext Company'} path={path} />
            {loading ? (
                <div style={{
                    padding: '12px 16px',
                    borderRadius: '4px',
                    border: '1px solid var(--theme-elevation-150)',
                    backgroundColor: 'var(--theme-elevation-50)',
                    color: 'var(--theme-elevation-500)',
                    fontSize: '13px',
                }}>
                    ⏳ Loading companies...
                </div>
            ) : hasCompanies ? (
                <SelectInput
                    path={path}
                    name={path}
                    value={value || ''}
                    onChange={(option: any) => {
                        const selected = Array.isArray(option) ? option[0] : option
                        setValue(selected?.value != null ? String(selected.value) : '')
                    }}
                    options={options}
                />
            ) : (
                <div style={{
                    padding: '12px 16px',
                    borderRadius: '4px',
                    border: '1px solid var(--theme-elevation-150)',
                    backgroundColor: 'var(--theme-elevation-50)',
                    color: 'var(--theme-elevation-500)',
                    fontSize: '13px',
                }}>
                    {id
                        ? '⏳ No companies loaded yet. Save your API credentials, then refresh this page.'
                        : '💡 Save the document first, then companies will be fetched automatically.'}
                </div>
            )}
        </div>
    )
}
