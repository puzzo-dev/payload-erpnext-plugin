import type { PayloadRequest } from 'payload'
import { timingSafeEqual } from 'node:crypto'

export type UserWithRole = {
    id: string | number
    role: 'super-admin' | 'admin' | 'editor' | string
    email?: string
    organization?: string | number | { id: string | number } | null
    site?: string | number | { id: string | number } | null
}

export function isInternalAuth(req: { headers?: { get: (name: string) => string | null } } | PayloadRequest): boolean {
    const secret = process.env.INTERNAL_API_SECRET
    if (!secret) return false
    const authSecret = req.headers?.get('x-internal-auth')
    if (!authSecret) return false
    // Constant-time comparison to prevent timing oracle attacks.
    const a = Buffer.from(authSecret)
    const b = Buffer.from(secret)
    if (a.byteLength !== b.byteLength) return false
    return timingSafeEqual(a, b)
}

export const getUserOrgId = (user: UserWithRole): string | number | null => {
    if (!user.organization) return null
    if (typeof user.organization === 'object') return user.organization.id
    return user.organization
}

export const getUserSiteId = (user: UserWithRole): string | number | null => {
    if (!user.site) return null
    if (typeof user.site === 'object') return user.site.id
    return user.site
}

export interface RateLimitEntry {
    count: number
    resetAt: number
}

export interface ERPNextCompany {
    name: string
    company_name: string
    country?: string
    default_currency?: string
}

export interface ERPNextCredentials {
    url: string
    /** Present when authMethod is 'api_key' (the default) or unset. */
    apiKey?: string
    apiSecret?: string
    /** Present when authMethod is 'oauth' — already refreshed if it had expired. */
    oauthAccessToken?: string
    authMethod?: 'api_key' | 'oauth'
    company?: string
    autoInjectCompany?: boolean
}

export interface ERPNextConfigDoc {
    id: string | number
    erpnextUrl: string
    apiKey: string
    apiSecret: string
    authMethod?: 'api_key' | 'oauth'
    oauthClientId?: string
    oauthClientSecret?: string
    oauthAccessToken?: string
    oauthRefreshToken?: string
    oauthExpiresAt?: string
    erpnextCompany: string
    availableCompanies?: ERPNextCompany[]
    lastCompanyFetchAt?: string
    connectionStatus?: 'connected' | 'disconnected' | 'untested'
    isActive: boolean
    project: string | number | { id: string | number }
    organization: string | number | { id: string | number }
}

export interface ERPNextWorkflowRequest {
    position: number
    label: string
    doctype: string
    action: 'create' | 'get' | 'update'
    enabled?: boolean
    referenceKey?: string
    referencePath?: string
    condition?: string
    optional?: boolean
    fieldMappings?: Array<{ formFieldName: string; erpFieldName: string }>
    staticValues?: Array<{ field: string; value: string }>
    referenceMappings?: Array<{ referenceKey: string; referencePath?: string; erpFieldName: string }>
    filters?: Array<{ formFieldName?: string; staticValue?: string; erpFieldName: string; operator?: string }>
}

export interface ERPNextWorkflow {
    id: string | number
    label: string
    form: string | number | { id: string | number }
    site: string | number | { id: string | number }
    enabled?: boolean
    requests?: ERPNextWorkflowRequest[]
}

export interface WorkflowResult {
    ok: boolean
    requestLabel: string
    doctype: string
    action: 'create' | 'get' | 'update'
    referenceKey?: string
    referenceValue?: string
    erpName?: string
    status?: number
    error?: string
}

export interface ERPNextWebhookPayload {
    doctype?: string
    name?: string
    event?: string
    data?: Record<string, unknown>
    [key: string]: unknown
}

/** Structured logger signature used by ERPNext sync endpoints. */
export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void

/** Option shapes for the ERPNext admin select components. */
export interface ERPNextCompanyOption {
    name: string
    company_name: string
    country?: string
    default_currency?: string
}

/**
 * Host automation primitives injected into the plugin (dependency injection).
 * These live in the CMS workflow engine; the plugin receives them via
 * `erpnextPlugin({ host: { ... } })` so it never imports back into payload-cms.
 */
export type EmitSystemEventFn = (
    payload: any,
    eventName: string,
    data: Record<string, unknown>,
    req?: any,
) => Promise<unknown>

export interface ERPNextHostBindings {
    /** CMS system-event emitter — enables ERPNext connection monitoring. */
    emitSystemEvent?: EmitSystemEventFn
    /** System-event name constants from the CMS (must include the ERPNEXT_CONNECTION_* keys). */
    systemEvents?: Record<string, string>
    /** CMS internal-auth guard — enables the customer→ERPNext link endpoint. */
    isInternalAuth?: (req: any) => boolean
    /**
     * Site slug -> collection slugs the host considers "local" to that site
     * (its own admin-sidebar visibility map, typically). Enables the
     * /cms-collections endpoint to scope the ERPNext Sync Rules "target
     * collection" picker to the rule's own site instead of listing every
     * collection in the system. Optional — without it the picker falls back
     * to listing everything, ungrouped, same as before this binding existed.
     */
    siteCollectionsMap?: Record<string, string[]>
}

/**
 * Runtime collection slugs that may not yet be in generated payload-types.ts.
 * Cast through this when referencing collections that aren't in Config['collections'] yet.
 */
export type RuntimeCollectionSlug =
    | 'users'
    | 'media'
    | 'sites'
    | 'forms'
    | 'form-submissions'
    | 'organizations'
    | 'erpnext-config'
    | 'erpnext-dead-letters'
    | 'erpnext-form-workflows'
