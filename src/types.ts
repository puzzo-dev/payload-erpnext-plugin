import type { Access, PayloadRequest } from 'payload'

/**
 * Minimal access control helpers used by the plugin.
 * A full CMS can override these via the plugin options in the future.
 */

export type UserWithRole = {
    id: string | number
    role: 'super-admin' | 'admin' | 'editor' | string
    email?: string
    organization?: string | number | { id: string | number } | null
    site?: string | number | { id: string | number } | null
}

export const anyone: Access = () => true

export const authenticated: Access = ({ req: { user } }) => Boolean(user)

export const superAdminOnly: Access = ({ req: { user } }) => {
    if (!user) return false
    return (user as unknown as UserWithRole).role === 'super-admin'
}

export const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET

export function isInternalAuth(req: { headers?: { get: (name: string) => string | null } } | PayloadRequest): boolean {
    if (!INTERNAL_API_SECRET) return false
    const authSecret = req.headers?.get('x-internal-auth')
    return Boolean(authSecret && authSecret === INTERNAL_API_SECRET)
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

export interface ERPNextLeadSource {
    name: string
    source_name?: string
}

export interface ERPNextCredentials {
    url: string
    apiKey: string
    apiSecret: string
    company?: string
    leadSource?: string
}

export interface ERPNextConfigDoc {
    id: string | number
    erpnextUrl: string
    apiKey: string
    apiSecret: string
    erpnextCompany: string
    availableCompanies?: ERPNextCompany[]
    lastCompanyFetchAt?: string
    leadSource?: string
    availableLeadSources?: ERPNextLeadSource[]
    lastLeadSourceFetchAt?: string
    connectionStatus?: 'connected' | 'disconnected' | 'untested'
    defaultDocType: 'Lead' | 'Contact' | 'Customer' | 'Web Form Submission' | 'Custom'
    customDocType?: string
    fieldMappings?: Array<{ formFieldName: string; erpnextFieldName: string }>
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
