'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, ReactSelect, type ReactSelectOption } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState } from '../shared'

interface DocTypeOption {
    value: string
    label: string
    module?: string
}

interface DocTypesResponse {
    doctypes?: DocTypeOption[]
    hasMore?: boolean
    nextLimitStart?: number
    error?: string
}

const loadMoreRowStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem',
    fontSize: '0.8125rem',
    fontWeight: 600,
    color: 'var(--theme-elevation-800, #1f2937)',
    borderTop: '1px solid var(--theme-elevation-100, #f3f4f6)',
    cursor: 'pointer',
    userSelect: 'none',
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
    // Reactive, not just read-once-on-mount: on the Create form `site` is
    // always empty on first render (nothing to pick yet), and the previous
    // implementation read it via getData() inside a mount-only effect
    // (deps: [getData], a stable reference that never changes) — so
    // selecting a site afterward never re-triggered the fetch, and the
    // "Select a site to load DocTypes from ERPNext" message just sat there
    // forever even after a site was chosen. useField subscribes to the
    // field's actual value, so this effect now re-runs when it changes.
    const { value: siteValue } = useField<string | number | { id: string | number } | null>({ path: 'site' })
    const [options, setOptions] = useState<DocTypeOption[]>([])
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [hasMore, setHasMore] = useState(false)
    const [nextLimitStart, setNextLimitStart] = useState(0)

    const siteId = typeof siteValue === 'object' && siteValue !== null
        ? (siteValue as { id: string | number }).id
        : siteValue

    const fetchPage = (limitStart: number) => {
        if (!siteId) return Promise.resolve<DocTypesResponse>({})
        return fetch(`/api/erpnext-doctypes?siteId=${siteId}&limitStart=${limitStart}`)
            .then(async (res) => {
                if (!res.ok) {
                    const body = (await res.json().catch(() => ({}))) as { error?: string }
                    throw new Error(body.error || `HTTP ${res.status}`)
                }
                return res.json() as Promise<DocTypesResponse>
            })
    }

    // Reactive, not just read-once-on-mount: on the Create form `site` is always empty on
    // first render (nothing to pick yet). Resets to page 1 whenever the site changes.
    useEffect(() => {
        if (!siteId) {
            setOptions([])
            setHasMore(false)
            setError('Select a site to load DocTypes from ERPNext.')
            return
        }

        setLoading(true)
        setError(null)

        fetchPage(0)
            .then((json) => {
                setOptions(json.doctypes ?? [])
                setHasMore(json.hasMore ?? false)
                setNextLimitStart(json.nextLimitStart ?? 0)
            })
            .catch((err) => {
                setError(err instanceof Error ? err.message : 'Failed to load DocTypes')
                setOptions([])
                setHasMore(false)
            })
            .finally(() => setLoading(false))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [siteValue])

    const loadMore = () => {
        setLoadingMore((already) => {
            if (already) return already
            fetchPage(nextLimitStart)
                .then((json) => {
                    setOptions((prev) => [...prev, ...(json.doctypes ?? [])])
                    setHasMore(json.hasMore ?? false)
                    setNextLimitStart(json.nextLimitStart ?? nextLimitStart)
                })
                .catch((err) => {
                    setError(err instanceof Error ? err.message : 'Failed to load more DocTypes')
                })
                .finally(() => setLoadingMore(false))
            return true
        })
    }

    // Custom MenuList: renders react-select's own option rows (menuProps.children) exactly
    // as normal, then appends a "Load more" row inside the same scrollable dropdown — the
    // pattern the user asked for instead of a separate button below the field. onMouseDown
    // (not onClick) with preventDefault/stopPropagation is the standard react-select trick
    // for interactive footer rows: it fires before react-select's own mousedown-triggered
    // blur/close handling, so clicking "Load more" fetches the next page without collapsing
    // the dropdown, letting a user page through several batches in one open menu.
    const MenuListWithLoadMore = useMemo(() => {
        const Component: React.FC<{ children?: React.ReactNode; maxHeight?: number }> = (menuProps) => (
            <div style={{ maxHeight: menuProps.maxHeight ?? 300, overflowY: 'auto' }}>
                {menuProps.children}
                {hasMore && (
                    <div
                        style={loadMoreRowStyle}
                        onMouseDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            loadMore()
                        }}
                    >
                        {loadingMore ? 'Loading more…' : '+ Load more DocTypes'}
                    </div>
                )}
            </div>
        )
        return Component
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasMore, loadingMore, nextLimitStart])

    // If the field already has a value that hasn't been paged in yet (e.g. an existing
    // sync rule set to a DocType that just isn't in the first batch loaded), keep it
    // visible in the dropdown instead of it silently rendering as unselected until
    // "Load more" happens to reach it.
    const selectOptions = useMemo<ReactSelectOption[]>(() => {
        const mapped = options.map((opt) => ({
            label: `${opt.label}${opt.module ? ` — ${opt.module}` : ''}`,
            value: opt.value,
        }))
        if (value && !options.some((opt) => opt.value === value)) {
            mapped.unshift({ label: value, value })
        }
        return mapped
    }, [options, value])

    const selectedOption = value
        ? selectOptions.find((opt) => opt.value === value) ?? { label: value, value }
        : undefined

    const showEmpty = !loading && options.length === 0

    return (
        <FieldWrapper path={path} label="ERPNext DocType" description="DocType to create or read in ERPNext.">
            {error && !options.length && <ErrorState message={error} />}
            {loading && <LoadingState message="Loading DocTypes…" />}
            {!loading && options.length > 0 && (
                <>
                    <ReactSelect
                        options={selectOptions}
                        value={selectedOption}
                        placeholder="Select a DocType"
                        isClearable
                        onChange={(selected) => {
                            const opt = Array.isArray(selected) ? selected[0] : selected
                            setValue(opt?.value != null ? String(opt.value) : '')
                        }}
                        onMenuScrollToBottom={loadMore}
                        components={{ MenuList: MenuListWithLoadMore }}
                    />
                    {error && <ErrorState message={error} />}
                </>
            )}
            {showEmpty && !error && <EmptyState message="No DocTypes available. Select a site first." />}
        </FieldWrapper>
    )
}

export default ERPNextDocTypeSelect
