'use client'

import React, { useEffect, useState } from 'react'
import { useField, useForm } from '@payloadcms/ui'

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

    return (
        <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}>
                ERPNext DocType
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
                <option value="">{loading ? 'Loading DocTypes…' : 'Select a DocType'}</option>
                {options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label} {opt.module ? `— ${opt.module}` : ''}
                    </option>
                ))}
            </select>
        </div>
    )
}

export default ERPNextDocTypeSelect
