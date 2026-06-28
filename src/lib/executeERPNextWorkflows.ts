import type { Payload, CollectionSlug } from 'payload'
import { randomUUID } from 'crypto'
import type { ERPNextConfigDoc, RuntimeCollectionSlug } from '../types'

const MAX_RETRIES = 3
const BASE_TIMEOUT_MS = 10_000
const RETRY_BACKOFF_MS = [0, 2_000, 8_000]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function extractERPNextErrorMessage(body: string): string | null {
    try {
        const parsed = JSON.parse(body)
        if (typeof parsed.message === 'string' && parsed.message) return parsed.message
        if (typeof parsed.exception === 'string' && parsed.exception) return parsed.exception
        if (Array.isArray(parsed._server_messages) && parsed._server_messages.length > 0) {
            return parsed._server_messages.join('; ')
        }
        if (typeof parsed.exc === 'string' && parsed.exc) {
            return parsed.exc.split('\n').slice(-2)[0] || parsed.exc
        }
    } catch {
        // not JSON
    }
    return null
}

function categorizeError(status: number | undefined, err: unknown): { category: string; detail: string } {
    if (err instanceof Error && err.name === 'AbortError') {
        return { category: 'timeout', detail: 'Request aborted after timeout' }
    }
    if (err instanceof TypeError) {
        return { category: 'tls-error', detail: String(err) }
    }
    if (status === undefined) {
        return { category: 'exception', detail: String(err) }
    }
    if (status >= 400 && status < 500) {
        return { category: 'client-error', detail: `HTTP ${status}` }
    }
    if (status >= 500) {
        return { category: 'server-error', detail: `HTTP ${status}` }
    }
    return { category: 'exception', detail: `HTTP ${status}` }
}

function getByPath(obj: unknown, path: string): unknown {
    if (!path || !obj) return undefined
    return path.split('.').reduce((acc: unknown, key) => {
        if (acc && typeof acc === 'object' && key in acc) {
            return (acc as Record<string, unknown>)[key]
        }
        return undefined
    }, obj)
}

function buildSubmissionMap(submissionData: Array<{ field: string; value: string }>): Record<string, string> {
    const map: Record<string, string> = {}
    for (const entry of submissionData ?? []) {
        if (entry.field && entry.value !== undefined && !entry.field.startsWith('_')) {
            map[entry.field] = entry.value
        }
    }
    return map
}

function evaluateCondition(condition: string | undefined, values: Record<string, string>, references: Record<string, unknown>): boolean {
    if (!condition || !condition.trim()) return true
    try {
        const fn = new Function('values', 'references', `return Boolean(${condition})`)
        return fn(values, references) === true
    } catch (err) {
        return true
    }
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
    enabled: boolean
    requests: ERPNextWorkflowRequest[]
}

export interface WorkflowResult {
    ok: boolean
    requestLabel: string
    doctype: string
    action: string
    referenceKey?: string
    referenceValue?: string
    erpName?: string
    status?: number
    error?: string
}

export interface ExecuteWorkflowsOptions {
    payload: Payload
    formId: string | number
    siteId: string | number
    submissionId: string | number
    submissionData: Array<{ field: string; value: string }>
    correlationId: string
    log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
}

export async function executeERPNextWorkflows(options: ExecuteWorkflowsOptions): Promise<WorkflowResult[]> {
    const { payload, formId, siteId, submissionId, submissionData, correlationId, log } = options
    const results: WorkflowResult[] = []

    try {
        const resolvedSiteId = typeof siteId === 'object' ? (siteId as { id: string | number }).id : siteId

        // 1. Find active ERPNext config for this site
        const erpConfigs = await payload.find({
            collection: 'erpnext-config',
            where: {
                site: { equals: resolvedSiteId },
                isActive: { equals: true },
            },
            limit: 1,
            depth: 0,
            overrideAccess: true,
            context: { preventMasking: true },
        })

        if (erpConfigs.totalDocs === 0) {
            log('info', 'No active ERPNext config for site — skipping workflows', { siteId: resolvedSiteId })
            return results
        }

        const erpConfig = erpConfigs.docs[0] as unknown as ERPNextConfigDoc
        const normalizedUrl = (erpConfig.erpnextUrl || '').replace(/\/+$/, '')
        if (!normalizedUrl.startsWith('https://')) {
            log('error', 'Refusing to forward to non-HTTPS ERPNext URL', { url: normalizedUrl })
            return results
        }

        const apiKey = erpConfig.apiKey || ''
        const apiSecret = erpConfig.apiSecret || ''
        if (!apiKey || !apiSecret || apiKey.startsWith('••••') || apiSecret.startsWith('••••')) {
            log('error', 'ERPNext credentials are missing or masked')
            return results
        }

        const erpnextCompany = erpConfig.erpnextCompany || undefined
        const leadSource = erpConfig.leadSource || undefined
        const authHeader = `token ${apiKey}:${apiSecret}`

        // 2. Find workflows for this form
        const workflows = await payload.find({
            collection: 'erpnext-form-workflows' as unknown as CollectionSlug,
            where: {
                form: { equals: formId },
                site: { equals: resolvedSiteId },
                enabled: { equals: true },
            },
            limit: 10,
            depth: 0,
            overrideAccess: true,
        })

        if (workflows.totalDocs === 0) {
            log('info', 'No ERPNext workflows for form — using legacy single-DocType fallback', { formId })
            const legacyResult = await executeLegacyForward({
                payload,
                erpConfig,
                siteId: resolvedSiteId,
                submissionId: String(submissionId),
                submissionData,
                correlationId,
                log,
            })
            if (legacyResult) results.push(legacyResult)
            return results
        }

        const values = buildSubmissionMap(submissionData)
        const references: Record<string, unknown> = {}

        for (const workflow of workflows.docs as unknown as ERPNextWorkflow[]) {
            const requests = [...(workflow.requests || [])].sort((a, b) => (a.position || 0) - (b.position || 0))

            for (const request of requests) {
                if (request.enabled === false) continue

                if (!evaluateCondition(request.condition, values, references)) {
                    log('info', `Skipping request "${request.label}" — condition falsy`, { requestLabel: request.label })
                    continue
                }

                const result: WorkflowResult = {
                    ok: false,
                    requestLabel: request.label,
                    doctype: request.doctype,
                    action: request.action,
                    referenceKey: request.referenceKey || undefined,
                }

                try {
                    const body: Record<string, unknown> = {}

                    // Apply field mappings from form submission
                    for (const mapping of request.fieldMappings || []) {
                        const value = values[mapping.formFieldName]
                        if (value !== undefined) {
                            body[mapping.erpFieldName] = value
                        }
                    }

                    // Apply static values
                    for (const staticValue of request.staticValues || []) {
                        body[staticValue.field] = staticValue.value
                    }

                    // Apply reference mappings from previous requests
                    for (const refMapping of request.referenceMappings || []) {
                        const refValue = getByPath(references[refMapping.referenceKey], refMapping.referencePath || 'name')
                        if (refValue !== undefined) {
                            body[refMapping.erpFieldName] = refValue
                        }
                    }

                    // Auto-inject company for company-aware doctypes
                    if (erpnextCompany && !body.company) {
                        body.company = erpnextCompany
                    }

                    // Auto-inject lead source for Lead doctype
                    if (leadSource && request.doctype === 'Lead' && !body.source) {
                        body.source = leadSource
                    }

                    let url: string
                    let method: 'POST' | 'GET' | 'PUT'

                    if (request.action === 'create') {
                        url = `${normalizedUrl}/api/resource/${encodeURIComponent(request.doctype)}`
                        method = 'POST'
                    } else if (request.action === 'get') {
                        const filters = (request.filters || [])
                            .filter((f) => f.erpFieldName)
                            .map((f) => {
                                const value = f.formFieldName ? values[f.formFieldName] : f.staticValue
                                return [request.doctype, f.erpFieldName, f.operator || '=', value]
                            })
                        const qs = new URLSearchParams()
                        qs.set('fields', JSON.stringify(['name']))
                        if (filters.length > 0) qs.set('filters', JSON.stringify(filters))
                        qs.set('limit_page_length', '1')
                        url = `${normalizedUrl}/api/resource/${encodeURIComponent(request.doctype)}?${qs.toString()}`
                        method = 'GET'
                    } else {
                        // update: need a document name from filters or references
                        const filterName = (request.filters || [])
                            .map((f) => {
                                const value = f.formFieldName ? values[f.formFieldName] : f.staticValue
                                return { field: f.erpFieldName, value }
                            })
                            .find((f) => f.field === 'name')?.value
                        const refName = request.referenceKey ? getByPath(references[request.referenceKey], request.referencePath || 'name') : undefined
                        const docName = filterName || refName
                        if (!docName) {
                            throw new Error('Update action requires a document name via filters or referenceKey')
                        }
                        url = `${normalizedUrl}/api/resource/${encodeURIComponent(request.doctype)}/${encodeURIComponent(String(docName))}`
                        method = 'PUT'
                    }

                    log('info', `Executing ERPNext request`, {
                        workflow: workflow.label,
                        requestLabel: request.label,
                        doctype: request.doctype,
                        action: request.action,
                        url: url.replace(apiSecret, '***').replace(apiKey, '***'),
                    })

                    let lastStatus: number | undefined
                    let lastError: unknown
                    let lastBody = ''
                    let responseData: unknown

                    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                        const controller = new AbortController()
                        const timeout = setTimeout(() => controller.abort(), BASE_TIMEOUT_MS)

                        try {
                            if (attempt > 0) {
                                log('info', `Retry attempt ${attempt + 1}/${MAX_RETRIES}`, { backoffMs: RETRY_BACKOFF_MS[attempt] })
                                await sleep(RETRY_BACKOFF_MS[attempt])
                            }

                            const response = await fetch(url, {
                                method,
                                headers: {
                                    'Content-Type': 'application/json',
                                    Authorization: authHeader,
                                    'X-Correlation-ID': correlationId,
                                },
                                body: method === 'GET' ? undefined : JSON.stringify(body),
                                signal: controller.signal,
                            })

                            lastStatus = response.status
                            lastBody = await response.text().catch(() => '(no body)')

                            if (response.ok) {
                                responseData = lastBody ? JSON.parse(lastBody) : {}

                                // For get/update, an empty result may mean "not found".
                                // If the request is optional, treat that as success so later
                                // requests can decide whether to create the record.
                                if (request.action === 'get' || request.action === 'update') {
                                    const list = Array.isArray((responseData as { data?: unknown[] })?.data)
                                        ? (responseData as { data: unknown[] }).data
                                        : undefined
                                    const found = list ? list.length > 0 : responseData !== null && responseData !== undefined
                                    if (!found && request.optional) {
                                        log('info', `Optional ${request.action} returned no match — treating as success`, {
                                            requestLabel: request.label,
                                        })
                                        result.ok = true
                                        result.status = response.status
                                        break
                                    }
                                    if (!found && !request.optional) {
                                        log('warn', `${request.action} returned no match`, { requestLabel: request.label })
                                        lastStatus = 404
                                        lastBody = JSON.stringify({ message: 'Document not found' })
                                        break
                                    }
                                }

                                result.ok = true
                                result.status = response.status
                                break
                            }

                            log('warn', `HTTP ${response.status} from ERPNext`, {
                                status: response.status,
                                bodyPreview: lastBody.slice(0, 500),
                                attempt: attempt + 1,
                            })

                            if (response.status >= 400 && response.status < 500) break
                        } catch (err) {
                            lastError = err
                            log('warn', `Network exception on attempt ${attempt + 1}`, { error: String(err) })
                        } finally {
                            clearTimeout(timeout)
                        }
                    }

                    if (!result.ok) {
                        const { category, detail } = categorizeError(lastStatus, lastError)
                        const erpMessage = extractERPNextErrorMessage(lastBody)
                        result.error = erpMessage || `${category}: ${detail}`
                        await writeDeadLetter(payload, {
                            submissionId: String(submissionId),
                            site: resolvedSiteId,
                            erpnextUrl: normalizedUrl,
                            docType: request.doctype,
                            payload: body,
                            errorCategory: category,
                            errorDetail: `${detail}\n\nLast body:\n${lastBody.slice(0, 2000)}`,
                            httpStatus: lastStatus ?? null,
                            retryCount: MAX_RETRIES,
                            status: 'pending',
                            correlationId,
                            workflow: workflow.label,
                            requestLabel: request.label,
                        })
                    } else {
                        // Extract reference value for subsequent requests
                        if (request.referenceKey) {
                            // For get requests, normalize the list response to the first document
                            const listData = Array.isArray((responseData as { data?: unknown[] })?.data)
                                ? (responseData as { data: unknown[] }).data
                                : undefined
                            const normalized = (request.action === 'get' && listData && listData.length > 0)
                                ? listData[0]
                                : responseData

                            const path = request.referencePath || (request.action === 'get' ? 'name' : 'data.name')
                            const extracted = getByPath(normalized, path)
                            references[request.referenceKey] = normalized
                            result.referenceValue = extracted !== undefined ? String(extracted) : undefined
                            result.erpName = extracted !== undefined ? String(extracted) : undefined
                            log('info', `Stored reference`, { referenceKey: request.referenceKey, value: result.referenceValue })
                        }
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    result.error = msg
                    log('error', `Request "${request.label}" failed with exception`, { error: msg })
                    await writeDeadLetter(payload, {
                        submissionId: String(submissionId),
                        site: resolvedSiteId,
                        erpnextUrl: normalizedUrl,
                        docType: request.doctype,
                        payload: {},
                        errorCategory: 'exception',
                        errorDetail: msg,
                        httpStatus: null,
                        retryCount: 0,
                        status: 'pending',
                        correlationId,
                        workflow: workflow.label,
                        requestLabel: request.label,
                    })
                }

                results.push(result)
            }
        }
    } catch (err) {
        log('error', 'Unexpected error executing ERPNext workflows', { error: err instanceof Error ? err.message : String(err) })
    }

    return results
}

async function executeLegacyForward(args: {
    payload: Payload
    erpConfig: ERPNextConfigDoc
    siteId: string | number
    submissionId: string
    submissionData: Array<{ field: string; value: string }>
    correlationId: string
    log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
}): Promise<WorkflowResult | null> {
    const { payload, erpConfig, siteId, submissionId, submissionData, correlationId, log } = args

    const normalizedUrl = (erpConfig.erpnextUrl || '').replace(/\/+$/, '')
    if (!normalizedUrl.startsWith('https://')) {
        log('error', 'Refusing to forward to non-HTTPS ERPNext URL', { url: normalizedUrl })
        return null
    }

    const apiKey = erpConfig.apiKey || ''
    const apiSecret = erpConfig.apiSecret || ''
    if (apiKey.startsWith('••••') || apiSecret.startsWith('••••')) {
        log('error', 'ERPNext credentials are masked or invalid in database.')
        return null
    }

    const docType = erpConfig.defaultDocType === 'Custom' ? erpConfig.customDocType : erpConfig.defaultDocType
    if (!docType) {
        log('warn', 'No legacy DocType configured — skipping forward')
        return null
    }

    const values = buildSubmissionMap(submissionData)
    let erpPayload: Record<string, string> = {}
    const fieldMappings = erpConfig.fieldMappings as Array<{ formFieldName: string; erpnextFieldName: string }> | undefined

    if (fieldMappings && fieldMappings.length > 0) {
        for (const mapping of fieldMappings) {
            const value = values[mapping.formFieldName]
            if (value !== undefined) {
                erpPayload[mapping.erpnextFieldName] = value
            }
        }
    } else {
        log('warn', 'No field mappings configured — forwarding raw field names', { formFields: Object.keys(values) })
        erpPayload = { ...values }
    }

    if (erpConfig.erpnextCompany && !erpPayload.company) {
        erpPayload.company = erpConfig.erpnextCompany
    }
    if (erpConfig.leadSource && docType === 'Lead' && !erpPayload.source) {
        erpPayload.source = erpConfig.leadSource
    }

    const url = `${normalizedUrl}/api/resource/${encodeURIComponent(docType)}`
    const authHeader = `token ${apiKey}:${apiSecret}`
    log('info', 'Forwarding submission (legacy fallback)', { url, docType, submissionId })

    let lastStatus: number | undefined
    let lastError: unknown
    let lastBody = ''

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), BASE_TIMEOUT_MS)

        try {
            if (attempt > 0) {
                log('info', `Retry attempt ${attempt + 1}/${MAX_RETRIES}`, { backoffMs: RETRY_BACKOFF_MS[attempt] })
                await sleep(RETRY_BACKOFF_MS[attempt])
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: authHeader,
                    'X-Correlation-ID': correlationId,
                },
                body: JSON.stringify(erpPayload),
                signal: controller.signal,
            })

            lastStatus = response.status

            if (response.ok) {
                const result = await response.json().catch(() => ({}))
                log('info', `Created ${docType} successfully`, {
                    name: (result as { data?: { name?: string } })?.data?.name || 'ok',
                    attempt: attempt + 1,
                })
                return {
                    ok: true,
                    requestLabel: 'Legacy forward',
                    doctype: docType,
                    action: 'create',
                    status: response.status,
                }
            }

            lastBody = await response.text().catch(() => '(no body)')
            log('warn', `HTTP ${response.status} from ERPNext`, {
                status: response.status,
                bodyPreview: lastBody.slice(0, 500),
                attempt: attempt + 1,
            })

            if (response.status >= 400 && response.status < 500) break
        } catch (err) {
            lastError = err
            log('warn', `Network exception on attempt ${attempt + 1}`, { error: String(err) })
        } finally {
            clearTimeout(timeout)
        }
    }

    const { category, detail } = categorizeError(lastStatus, lastError)
    const erpMessage = extractERPNextErrorMessage(lastBody)
    log('error', 'All legacy retry attempts exhausted — writing dead letter', { category, detail })

    await writeDeadLetter(payload, {
        submissionId,
        site: siteId,
        erpnextUrl: normalizedUrl,
        docType,
        payload: erpPayload,
        errorCategory: category,
        errorDetail: `${detail}\n\nLast body:\n${lastBody.slice(0, 2000)}`,
        httpStatus: lastStatus ?? null,
        retryCount: MAX_RETRIES,
        status: 'pending',
        correlationId,
        workflow: 'Legacy fallback',
        requestLabel: 'Legacy forward',
    })

    return {
        ok: false,
        requestLabel: 'Legacy forward',
        doctype: docType,
        action: 'create',
        status: lastStatus,
        error: erpMessage || `${category}: ${detail}`,
    }
}

async function writeDeadLetter(
    payload: Payload,
    data: Record<string, unknown>,
): Promise<void> {
    try {
        await payload.create({
            collection: 'erpnext-dead-letters' as unknown as CollectionSlug,
            overrideAccess: true,
            data: data as any,
        })
    } catch (err) {
        payload.logger.error(`[ERPNext] Failed to create dead-letter record: ${err instanceof Error ? err.message : String(err)}`)
    }
}
