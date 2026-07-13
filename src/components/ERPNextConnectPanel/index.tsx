'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useDocumentInfo } from '@payloadcms/ui'
import {
    FieldWrapper, LoadingState, EmptyState, ErrorState, SuccessState,
    ConnectButton, useOAuthRedirectMessage,
} from '../shared'

interface DocSnapshot {
    authMethod?: string
    erpnextUrl?: string
    oauthClientId?: string
}

/**
 * Custom Field component: "Connect via OAuth" — an alternative to manually
 * pasting an API Key/Secret. Frappe/ERPNext already has a real OAuth2
 * provider (Settings → OAuth Client); this just walks the admin through
 * using it. Manual API Key/Secret entry (the fields above this one) stays
 * fully functional either way — this only sets authMethod + the oauth*
 * fields, it never removes or requires clearing apiKey/apiSecret.
 */
export const ERPNextConnectPanelField: React.FC = () => {
    const { id } = useDocumentInfo()
    const redirectMsg = useOAuthRedirectMessage('erpnext_oauth_success', 'erpnext_oauth_error')

    const [doc, setDoc] = useState<DocSnapshot | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(false)

    const loadDoc = useCallback(() => {
        if (!id) return
        setLoadingDoc(true)
        fetch(`/api/erpnext-config/${id}?depth=0`)
            .then((res) => res.json())
            .then((data) => setDoc(data))
            .catch(() => { /* ignore */ })
            .finally(() => setLoadingDoc(false))
    }, [id])

    useEffect(() => { loadDoc() }, [loadDoc, redirectMsg.success])

    const startConnect = () => {
        if (!id) return
        window.location.href = `/api/erpnext-oauth/start?configId=${id}`
    }

    if (!id) {
        return (
            <FieldWrapper path="erpnextConnectPanel" label="Connect via OAuth">
                <EmptyState message="Save the document first (with at least the ERPNext URL and an OAuth Client ID), then Connect will be available." />
            </FieldWrapper>
        )
    }

    const isConnected = doc?.authMethod === 'oauth'
    const canConnect = Boolean(doc?.erpnextUrl && doc?.oauthClientId)

    return (
        <FieldWrapper path="erpnextConnectPanel" label="Connect via OAuth">
            {redirectMsg.error && <ErrorState message={redirectMsg.error} />}

            {loadingDoc ? (
                <LoadingState message="Loading connection status…" />
            ) : isConnected ? (
                <>
                    <SuccessState message="Connected via OAuth2. API calls now use a Bearer token, refreshed automatically when it expires." />
                    <ConnectButton onClick={startConnect}>Reconnect</ConnectButton>
                </>
            ) : (
                <>
                    {!canConnect && (
                        <EmptyState message="Set the ERPNext instance URL and an OAuth Client ID above first (create the Client in ERPNext under Settings → OAuth Client)." />
                    )}
                    <ConnectButton onClick={startConnect} disabled={!canConnect}>
                        Connect via OAuth
                    </ConnectButton>
                </>
            )}
        </FieldWrapper>
    )
}
