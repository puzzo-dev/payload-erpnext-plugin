# payload-erpnext-plugin

A self-contained **Payload CMS 3.x plugin** for secure, multi-tenant ERPNext integrations.

It provides:

- **ERPNext Connection Configuration** per site (multi-tenant) with encrypted credentials.
- **Generic ERP Action Handlers** (`erp-get`, `erp-post`, `erp-patch`, `erp-delete`) registered directly into the CMS workflow engine's action registry.
- **Workflow Step Integration** — injects a `trigger_erp` (Trigger ERP Action) block into the CMS `workflows` collection steps, with custom field components for live DocType and target field selection.
- **Dead-Letter Queue** (`erpnext-dead-letters` collection) for permanently failed ERPNext requests.
- **Anonymous File Upload** endpoint for form attachments (e.g., resumes).
- **Secure ERPNext Proxy Endpoints** (`/api/erpnext-proxy/...`) with rate-limiting, origin validation, and cross-tenant data isolation.
- **Webhook Signature Verification** helper for validating incoming ERPNext notifications.

> [!NOTE]
> Form-submission-to-ERPNext forwarding is handled by the host application's general **Workflows** collection (e.g., triggered on `collection_change` for `form-submissions`) rather than a dedicated parallel engine.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [ERPNext Workflow Steps](#erpnext-workflow-steps)
- [Security & Access Control](#security--access-control)
- [Dead-Letter Queue](#dead-letter-queue)
- [Endpoints](#endpoints)
- [Architecture](#architecture)
- [License](#license)

---

## Installation

```bash
npm install payload-erpnext-plugin
# or
pnpm add payload-erpnext-plugin
```

---

## Quick Start

### 1. Add the plugin to `payload.config.ts`

Import and register `erpnextPlugin`, passing the host application's action registry to enable workflow execution:

```typescript
import { buildConfig } from 'payload'
import { erpnextPlugin } from 'payload-erpnext-plugin'
import { actionRegistry } from './lib/actionRegistry' // your host application's registry

export default buildConfig({
  // ... your config
  plugins: [
    erpnextPlugin({
      registry: actionRegistry,
    }),
  ],
})
```

### 2. Create an `ERPNext Config` in the Payload Admin

Go to **Integrations → ERPNext Config**:

- Select the site/tenant.
- Enter the ERPNext URL (HTTPS only).
- Enter API Key and Secret.
- Fetch companies / lead sources.
- Mark as Active and Save.

### 3. Build a Workflow Step

Go to **Settings → Workflows**:

- Create or edit a workflow.
- In **Steps**, add a **Trigger ERP Action** (`trigger_erp`) block.
- Select the DocType and Action (e.g., `POST` to create, `GET` to search).
- Map fields from the CMS document context using `{{doc.fieldName}}` variables.

---

## Configuration

### Plugin Options

```typescript
import { erpnextPlugin } from 'payload-erpnext-plugin'

erpnextPlugin({
  registry: actionRegistry, // ActionRegistryRef
  enableAnonymousUpload: false, // optional, defaults to true
  erpnextConfigHooks: {
    afterChange: [myConnectionMonitorHook], // optional connection monitors
  },
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `registry` | `ActionRegistryRef` | `undefined` | **Recommended**. The action registry to register `erp-get`, `erp-post`, `erp-patch`, and `erp-delete` handlers. |
| `enableAnonymousUpload` | `boolean` | `true` | Registers `/api/anonymous-upload` for form file attachments. |
| `erpnextConfigHooks` | `object` | `undefined` | Appends custom `afterChange` hooks to the `erpnext-config` collection. |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ERPNEXT_ENCRYPTION_KEY` | **Required** | 32-byte hex AES-256-GCM key for encrypting credentials at rest. Generate with `openssl rand -hex 32`. |
| `REDIS_URL` | Optional | Enables Redis-backed rate limiting. Recommended for horizontal scaling. |

---

## ERPNext Workflow Steps

The plugin automatically extends the host's `workflows` collection steps with the **Trigger ERP Action** (`trigger_erp`) block.

### Step Fields

| Field | Description |
|-------|-------------|
| **DocType** | ERPNext DocType (fetched live using a custom `ERPNextDocTypeSelect` component). |
| **Action** | `Read / Search (GET)`, `Create (POST)`, `Update (PUT)`, or `Delete (DELETE)`. |
| **Result Key** | The namespace prefix for output variables (e.g. `erp` → `{{erp_name}}`, `{{erp_result}}`). Prevents overwriting earlier step contexts. |
| **Field Mappings** | Map target fields to source values. The target field input uses `ERPNextTargetFieldSelect` to display fields fetched dynamically from the selected DocType. |

### Field Mapping Rules

* **For GET Actions**: Map source expressions into `filters` and `fields` target keys. E.g.
  * `filters` → `[["phone", "=", "{{doc.phone}}"]]`
  * `fields` → `["name", "customer_name", "status"]`
* **For POST/PUT Actions**: Map target ERPNext field names to values or variables (e.g. `customer_name` → `{{doc.fullName}}`).

---

## Security & Access Control

- **HTTPS Mandatory**: The plugin refuses to forward credentials or request payloads to non-HTTPS endpoints.
- **Credential Encryption**: Secrets and keys are encrypted using AES-256-GCM before writing to the database. They are only decrypted in memory during execution.
- **Cross-Tenant Isolation**: In multi-tenant environments, the proxy restricts list fetches and single resource requests to the `company` configured on the tenant's active `ERPNext Config`. Any attempt to request cross-tenant data is blocked.
- **Doctype Whitelisting**: Frontend clients accessing the proxy can only query whitelisted, non-sensitive doctypes (e.g., `Job Opening`, `Blog Category`).
- **Origin Validation**: Proxy endpoints reject browser requests unless the origin matches a domain registered in the `sites` collection or configured in `TRUSTED_ORIGINS`.

---

## Dead-Letter Queue

Failed ERPNext calls from workflows are written to the `erpnext-dead-letters` collection:

- **Original Context**: Submission ID, site, URL, DocType, and the request payload.
- **Diagnostics**: Error category (validation, connection, timeout), details, HTTP status code, retry count, and workflow correlation ID.
- **Recovery**: Administrators can review, debug, and trigger manual retries via the **Retry Dead Letters** endpoint.

---

## Endpoints

All admin endpoints require `super-admin` or `admin` authentication.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/erpnext-proxy/submit` | Proxies creation of whitelisted DocTypes (e.g. Leads) from frontends. |
| `GET`  | `/api/erpnext-proxy/resource` | Proxies reading/filtering of whitelisted DocTypes. |
| `GET`  | `/api/erpnext-proxy/health` | Verifies ERPNext API credentials and connection. |
| `POST` | `/api/erpnext-proxy/upload` | Proxies file uploads to ERPNext. |
| `POST` | `/api/erpnext-config/fetch-companies` | Live dropdown population: fetches ERPNext Company list. |
| `POST` | `/api/erpnext-config/fetch-lead-sources` | Live dropdown population: fetches ERPNext Lead Source list. |
| `GET`  | `/api/erpnext-doctypes` | Live dropdown population: fetches ERPNext DocType list. |
| `GET`  | `/api/erpnext-doctype-fields` | Live dropdown population: fetches fields for a selected DocType. |
| `POST` | `/api/erpnext/retry-dead-letters` | Retries dead-letter queue items. |
| `POST` | `/api/anonymous-upload` | Anonymous file upload to Payload Media. |

---

## Architecture

```
                 Workflow Trigger (e.g. collection change)
                                   │
                                   ▼
                       Action Registry Lookup
                                   │
                        ┌──────────┴──────────┐
                        ▼                     ▼
                 Action Executed       Action Fails (Transient)
                 (API Call Ok)                │
                        │                     ▼
                        │             Enqueue retry job
                        │                     │
                        │            ┌────────┴────────┐
                        │            ▼                 ▼
                        │       Retry Ok          Exhausted (All retries fail)
                        │            │                 │
                        ▼            ▼                 ▼
                 ┌──────────────────────┐     ┌──────────────────────┐
                 │  Execution Completed │     │  Write to Dead Letter│
                 └──────────────────────┘     └──────────────────────┘
```

---

## License

MIT
