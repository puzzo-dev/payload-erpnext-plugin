'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, useDocumentInfo, FieldLabel, SelectInput } from '@payloadcms/ui'

import type { ERPNextLeadSourceOption } from '../../types'

/**
 * Custom Field component for `leadSource`.
 *
 * Fetches the available lead sources directly from the document API,
 * bypassing the need for the JSON field to be in form state.
 */
export const LeadSourceSelectField: React.FC<{ path: string; field: { name: string; label?: string; admin?: { description?: string } } }> = ({ path, field }) => {
    const { value, setValue } = useField<string>({ path })
    const { id } = useDocumentInfo()
    const [sources, setSources] = useState<ERPNextLeadSourceOption[]>([])
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!id) return

        setLoading(true)
        fetch(`/api/erpnext-config/${id}?depth=0`)
            .then((res) => res.json())
            .then((doc) => {
                const fetched = doc?.availableLeadSources
                if (Array.isArray(fetched)) {
                    setSources(fetched as ERPNextLeadSourceOption[])
                } else if (typeof fetched === 'string') {
                    try { setSources(JSON.parse(fetched)) } catch { /* ignore */ }
                }
            })
            .catch(() => { /* ignore fetch errors */ })
            .finally(() => setLoading(false))
    }, [id])

    const options = useMemo(() => [
        { label: '— Select a lead source —', value: '' },
        ...sources.map((ls) => ({
            label: ls.source_name,
            value: ls.name,
        })),
    ], [sources])

    const hasSources = sources.length > 0

    return (
        <div style={{ marginBottom: '1.5rem' }}>
            <FieldLabel label={field.label || 'Lead Source'} path={path} />
            {loading ? (
                <div style={{
                    padding: '12px 16px',
                    borderRadius: '4px',
                    border: '1px solid var(--theme-elevation-150)',
                    backgroundColor: 'var(--theme-elevation-50)',
                    color: 'var(--theme-elevation-500)',
                    fontSize: '13px',
                }}>
                    ⏳ Loading lead sources...
                </div>
            ) : hasSources ? (
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
                        ? '⏳ No lead sources loaded yet. Save your API credentials, then refresh this page.'
                        : '💡 Save the document first, then lead sources will be fetched automatically.'}
                </div>
            )}
        </div>
    )
}
