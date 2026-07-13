'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useDocumentInfo } from '@payloadcms/ui'
import {
    FieldWrapper, LoadingState, EmptyState, ErrorState, SuccessState, ConnectButton,
} from '../shared'

interface DocSnapshot {
    authMethod?: string
    erpnextUrl?: string
    erpnextCompany?: string
}

const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.5rem 0.75rem',
    borderRadius: 'var(--style-radius, 0.25rem)',
    border: '1px solid var(--theme-elevation-150, #e5e7eb)',
    background: 'var(--theme-input-bg, var(--theme-elevation-0, #fff))',
    color: 'var(--theme-elevation-800, #1f2937)',
    fontSize: '0.875rem',
}

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.8125rem',
    fontWeight: 600,
    marginBottom: '0.25rem',
    color: 'var(--theme-elevation-600, #4b5563)',
}

/**
 * Custom Field component: "Connect via OAuth" — logs in with an ERPNext
 * username/password (used only for this one request, never stored) and
 * drives the whole OAuth Client setup + authorization-code grant server-side
 * (see endpoints/erpnextOAuth.ts's auto-connect endpoint). No pre-existing
 * ERPNext OAuth Client is needed — nothing to create by hand in ERPNext
 * first. Manual API Key/Secret entry (the fields above this one) stays
 * fully functional either way — this only sets authMethod + the oauth*
 * fields, it never removes or requires clearing apiKey/apiSecret.
 */
export const ERPNextConnectPanelField: React.FC = () => {
    const { id } = useDocumentInfo()

    const [doc, setDoc] = useState<DocSnapshot | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(false)
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [connecting, setConnecting] = useState(false)
    const [connectError, setConnectError] = useState<string | null>(null)
    const [connected, setConnected] = useState(false)

    const loadDoc = useCallback(() => {
        if (!id) return
        setLoadingDoc(true)
        fetch(`/api/erpnext-config/${id}?depth=0`)
            .then((res) => res.json())
            .then((data) => setDoc(data))
            .catch(() => { /* ignore */ })
            .finally(() => setLoadingDoc(false))
    }, [id])

    useEffect(() => { loadDoc() }, [loadDoc])

    if (!id) {
        return (
            <FieldWrapper path="erpnextConnectPanel" label="Connect via OAuth">
                <EmptyState message="Save the document first (with at least the ERPNext URL), then Connect will be available." />
            </FieldWrapper>
        )
    }

    const isConnected = doc?.authMethod === 'oauth'
    const canConnect = Boolean(doc?.erpnextUrl)

    const submitConnect = () => {
        if (!id || !username || !password) return
        setConnecting(true)
        setConnectError(null)
        fetch('/api/erpnext-oauth/auto-connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configId: id, username, password }),
        })
            .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
            .then(({ ok, data }) => {
                if (!ok || data.error) {
                    setConnectError(data.error || 'Connect failed')
                    return
                }
                setUsername('')
                setPassword('')
                setConnected(true)
                loadDoc()
            })
            .catch(() => setConnectError('Connect failed — could not reach the server'))
            .finally(() => setConnecting(false))
    }

    return (
        <FieldWrapper path="erpnextConnectPanel" label="Connect via OAuth">
            {connectError && <ErrorState message={connectError} />}
            {connected && !isConnected && <SuccessState message="Connected! Fetching your companies…" />}

            {loadingDoc ? (
                <LoadingState message="Loading connection status…" />
            ) : isConnected ? (
                <>
                    <SuccessState message="Connected via OAuth2. API calls now use a Bearer token, refreshed automatically when it expires." />
                    <p style={{ fontSize: '0.8125rem', color: 'var(--theme-elevation-500, #6b7280)', marginBottom: '0.75rem' }}>
                        To reconnect (e.g. after rotating your ERPNext password), log in again below.
                    </p>
                </>
            ) : null}

            {!canConnect && (
                <EmptyState message="Set the ERPNext instance URL above first." />
            )}

            {canConnect && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '360px' }}>
                    <div>
                        <label style={labelStyle} htmlFor="erpnextConnectPanel_username">ERPNext Username</label>
                        <input
                            id="erpnextConnectPanel_username"
                            type="text"
                            autoComplete="off"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            style={inputStyle}
                            placeholder="you@example.com"
                        />
                    </div>
                    <div>
                        <label style={labelStyle} htmlFor="erpnextConnectPanel_password">ERPNext Password</label>
                        <input
                            id="erpnextConnectPanel_password"
                            type="password"
                            autoComplete="off"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            style={inputStyle}
                            placeholder="••••••••"
                        />
                    </div>
                    <div>
                        <ConnectButton onClick={submitConnect} disabled={!username || !password || connecting}>
                            {connecting ? 'Connecting…' : isConnected ? 'Reconnect' : 'Log In & Connect'}
                        </ConnectButton>
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--theme-elevation-400, #9ca3af)', margin: 0 }}>
                        Needs a System Manager account. Used once to set up the connection — never stored.
                    </p>
                </div>
            )}
        </FieldWrapper>
    )
}
