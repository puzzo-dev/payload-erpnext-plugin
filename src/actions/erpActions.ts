import { getCredentials, authHeaders } from '../endpoints/erpnextProxy'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientError(err: unknown, status?: number): boolean {
  // Client errors (4xx) are not transient — they will fail the same way on retry.
  if (status != null && status >= 400 && status < 500) return false
  // Server errors (5xx), network errors, timeouts, and other unknown failures may be transient.
  return true
}

async function erpCall(creds: any, path: string, method = 'GET', body?: object): Promise<any> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${creds.url}${path}`, {
        method,
        headers: {
          ...authHeaders(creds),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) {
        let msg = `ERPNext ${method} ${path} → ${res.status}`
        try {
          const data = await res.json() as any
          if (data?.exception) msg = String(data.exception)
          else if (data?.message) msg = String(data.message)
        } catch { /* keep original */ }
        const error = new Error(msg)
        ;(error as any).status = res.status
        throw error
      }
      return res.json()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const status = (lastError as any).status as number | undefined
      if (attempt < MAX_RETRIES && isTransientError(err, status)) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt))
      } else {
        break
      }
    }
  }
  throw lastError!
}

// ── Shared value resolution ─────────────────────────────────────────────────
// Field mapping values and erp-get filters/fields support {{key}} / {{nested.path}}
// references into workflowContext. If the WHOLE value is exactly one {{path}},
// the raw (possibly non-string) value is returned. Otherwise any {{path}} occurrences
// inside the string are substituted (string result). Plain strings pass through as
// literals.
function dottedPathLookup(ctx: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o === undefined || o === null ? undefined : (o as Record<string, unknown>)[k]), ctx)
}

export function resolveValue(template: string, ctx: Record<string, unknown>): unknown {
  const wholeMatch = template.trim().match(/^\{\{\s*([\w.]+)\s*\}\}$/)
  if (wholeMatch) {
    const val = dottedPathLookup(ctx, wholeMatch[1])
    return val !== undefined ? val : template
  }
  if (template.includes('{{')) {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
      const val = dottedPathLookup(ctx, key)
      return val !== undefined && val !== null ? String(val) : ''
    })
  }
  return template
}

// ── erp-get ──────────────────────────────────────────────────────────────────
// Fetches a list of ERPNext documents and stores the first result in context.
//
// step.target_doctype — ERPNext DocType to query
// step.field_mapping.filters — JSON-encoded filters string (ERPNext filter format), supports {{var}}
// step.field_mapping.fields  — JSON-encoded fields array (default: ["name"]), supports {{var}}
//
// Writes to context: { erp_result_list, erp_result (first doc or null), erp_name, erp_company }
export async function erpGetHandler(ctx: any): Promise<any> {
  const { payload, workflowContext, step } = ctx
  const siteSlug = workflowContext.siteSlug as string
  const creds = await getCredentials(payload, siteSlug)
  if (!creds) return { success: false, error: 'Missing ERP credentials for site: ' + siteSlug }

  const doctype = step.target_doctype as string
  if (!doctype) return { success: false, error: 'erp-get requires target_doctype' }

  const mapping = (step.field_mapping ?? {}) as Record<string, unknown>
  const filters = mapping.filters ? String(resolveValue(String(mapping.filters), workflowContext)) : undefined
  const fields = mapping.fields ? String(resolveValue(String(mapping.fields), workflowContext)) : '["name"]'

  const qs = new URLSearchParams({ fields, limit_page_length: '10' })
  if (filters) qs.set('filters', filters)

  const res = await erpCall(creds, `/api/resource/${encodeURIComponent(doctype)}?${qs}`)
  const list = (res.data as any[]) ?? []
  const prefix = (step.result_key as string) || 'erp'

  return {
    success: true,
    data: {
      [`${prefix}_result_list`]: list,
      [`${prefix}_result`]: list[0] ?? null,
      [`${prefix}_name`]: list[0]?.name ?? null,
      erp_company: creds.company,
    },
  }
}

// ── erp-post ─────────────────────────────────────────────────────────────────
// Creates a new ERPNext document.
//
// step.target_doctype — DocType to create (e.g. Lead, Customer, Sales Order)
// step.field_mapping  — { "<erpField>": "<{{contextKey}} | literalValue>" }
//
// Writes to context: { erp_name (created doc name), erp_doctype, erp_company }
export async function erpPostHandler(ctx: any): Promise<any> {
  const { payload, workflowContext, step } = ctx
  const siteSlug = workflowContext.siteSlug as string
  const creds = await getCredentials(payload, siteSlug)
  if (!creds) return { success: false, error: 'Missing ERP credentials for site: ' + siteSlug }

  const doctype = step.target_doctype as string
  if (!doctype) return { success: false, error: 'erp-post requires target_doctype' }

  const mapping = (step.field_mapping ?? {}) as Record<string, string>
  const docData: Record<string, unknown> = { doctype }
  for (const [erpField, sourceTemplate] of Object.entries(mapping)) {
    docData[erpField] = resolveValue(sourceTemplate, workflowContext)
  }

  const res = await erpCall(creds, `/api/resource/${encodeURIComponent(doctype)}`, 'POST', docData)
  const createdName = res.data?.name as string
  const prefix = (step.result_key as string) || 'erp'

  return { success: true, data: { [`${prefix}_name`]: createdName, [`${prefix}_doctype`]: doctype, erp_company: creds.company } }
}

// ── erp-patch ────────────────────────────────────────────────────────────────
// Updates an existing ERPNext document.
//
// Reads context.erp_name for the document identifier (or step.field_mapping.doc_name_key to override).
// step.field_mapping  — { "<erpField>": "<{{contextKey}} | literalValue>", "doc_name_key"?: "<contextKey>" }
export async function erpPatchHandler(ctx: any): Promise<any> {
  const { payload, workflowContext, step } = ctx
  const siteSlug = workflowContext.siteSlug as string
  const creds = await getCredentials(payload, siteSlug)
  if (!creds) return { success: false, error: 'Missing ERP credentials for site: ' + siteSlug }

  const doctype = step.target_doctype as string
  if (!doctype) return { success: false, error: 'erp-patch requires target_doctype' }

  const mapping = (step.field_mapping ?? {}) as Record<string, string>
  const docNameKey = mapping.doc_name_key ?? 'erp_name'
  const docName = workflowContext[docNameKey] as string | undefined
  if (!docName) {
    return { success: false, error: `erp-patch requires context.${docNameKey} to identify the document` }
  }

  const docData: Record<string, unknown> = {}
  for (const [erpField, sourceTemplate] of Object.entries(mapping)) {
    if (erpField === 'doc_name_key') continue
    docData[erpField] = resolveValue(sourceTemplate, workflowContext)
  }

  await erpCall(
    creds,
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`,
    'PUT',
    docData,
  )

  return { success: true }
}

// ── erp-delete ───────────────────────────────────────────────────────────────
// Deletes an ERPNext document.
//
// Reads context.erp_name for the document to delete.
export async function erpDeleteHandler(ctx: any): Promise<any> {
  const { payload, workflowContext, step } = ctx
  const siteSlug = workflowContext.siteSlug as string
  const creds = await getCredentials(payload, siteSlug)
  if (!creds) return { success: false, error: 'Missing ERP credentials for site: ' + siteSlug }

  const doctype = step.target_doctype as string
  if (!doctype) return { success: false, error: 'erp-delete requires target_doctype' }

  const docName = workflowContext.erp_name as string | undefined
  if (!docName) return { success: false, error: 'erp-delete requires context.erp_name' }

  await erpCall(
    creds,
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`,
    'DELETE',
  )

  return { success: true }
}
