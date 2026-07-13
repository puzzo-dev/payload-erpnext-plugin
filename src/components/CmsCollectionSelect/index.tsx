'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField, ReactSelect } from '@payloadcms/ui'

import { FieldWrapper, LoadingState, EmptyState, ErrorState, StyledTextInput } from '../shared'

interface Option {
    value: string
    label: string
}

/**
 * Field component listing Payload collections (from /api/cms-collections),
 * scoped to the rule's own site and split into "This Site" (local) and
 * "Global (Shared)" (used by 2+ sites) groups — previously this listed every
 * collection in the whole system regardless of site, including collections
 * that belong to a completely different tenant. Reactive to the site field
 * (not read-once-on-mount), so picking a site after the form first loads
 * actually re-fetches instead of leaving a stale "select a site" message.
 */
export const CmsCollectionSelect: React.FC<{ path: string }> = ({ path }) => {
    const { value, setValue } = useField<string>({ path })
    const { value: siteValue } = useField<string | number | { id: string | number } | null>({ path: 'site' })
    const [local, setLocal] = useState<Option[]>([])
    const [global, setGlobal] = useState<Option[]>([])
    const [loading, setLoading] = useState(false)
    const [fetchError, setFetchError] = useState<string | null>(null)

    const siteId = typeof siteValue === 'object' && siteValue !== null ? siteValue.id : siteValue

    useEffect(() => {
        if (!siteId) {
            setLocal([])
            setGlobal([])
            setFetchError(null)
            return
        }
        setLoading(true)
        setFetchError(null)
        fetch(`/api/cms-collections?siteId=${siteId}`)
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.json() as Promise<{ local?: Option[]; global?: Option[] }>
            })
            .then((json) => {
                setLocal(json.local ?? [])
                setGlobal(json.global ?? [])
            })
            .catch((err) => {
                setFetchError(err instanceof Error ? err.message : 'Failed to load collections')
                setLocal([])
                setGlobal([])
            })
            .finally(() => setLoading(false))
    }, [siteId])

    const optionGroups = useMemo(() => {
        const groups: Array<{ label: string; options: Option[] }> = []
        if (local.length) groups.push({ label: 'This Site', options: local })
        if (global.length) groups.push({ label: 'Global (Shared)', options: global })
        return groups
    }, [local, global])

    const selectedOption = useMemo(
        () => [...local, ...global].find((o) => o.value === value) ?? null,
        [local, global, value],
    )

    const hasOptions = local.length > 0 || global.length > 0

    if (!siteId) {
        return (
            <FieldWrapper path={path} label="Target Collection" description="Payload collection that incoming ERPNext data will sync into.">
                <EmptyState message="Select a site first." />
            </FieldWrapper>
        )
    }

    return (
        <FieldWrapper path={path} label="Target Collection" description="Payload collection that incoming ERPNext data will sync into.">
            {loading && <LoadingState message="Loading collections…" />}
            {!loading && hasOptions && (
                <ReactSelect
                    // ReactSelect's own `OptionGroup` type isn't part of @payloadcms/ui's
                    // public export surface (only the flat `ReactSelectOption`/`ReactSelect`
                    // are), so the grouped-options shape it genuinely supports at runtime
                    // (verified against elements/ReactSelect/types.d.ts) can't be named here
                    // without a deep internal import — cast at this boundary instead.
                    options={optionGroups as unknown as { label: string; value: string }[]}
                    value={(selectedOption ?? undefined) as unknown as { label: string; value: string } | undefined}
                    onChange={(selected) => {
                        const opt = Array.isArray(selected) ? selected[0] : selected
                        setValue((opt?.value as string | undefined) ?? '')
                    }}
                    isClearable
                    placeholder="Select a Collection"
                />
            )}
            {!loading && !hasOptions && fetchError && (
                <>
                    <ErrorState message={`${fetchError}. Type the collection slug manually.`} />
                    <div style={{ marginTop: '0.5rem' }}>
                        <StyledTextInput
                            path={path}
                            value={value || ''}
                            onChange={(val) => setValue(val)}
                            placeholder="e.g. catalogue-items"
                        />
                    </div>
                </>
            )}
            {!loading && !hasOptions && !fetchError && <EmptyState message="No collections available for this site." />}
        </FieldWrapper>
    )
}

export default CmsCollectionSelect
