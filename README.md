# payload-erpnext-plugin

A self-contained **Payload CMS 3.x plugin** for secure, multi-tenant ERPNext integrations.

It provides:

- **ERPNext Connection Configuration** per site (multi-tenant) with encrypted credentials.
- **Generic ERP Action Handlers** (`erp-get`, `erp-post`, `erp-patch`, `erp-delete`) registered directly into the CMS workflow engine's action registry.
- **Workflow Step Integration** — injects a `trigger_erp` (Trigger ERP Action) block into the CMS `workflows` collection steps, with custom field components for live DocType and target field selection.
- **Dead-Letter Queue** (`erpnext-dead-letters` collection) for permanently failed ERPNext requests.
- **Anonymous File Upload** endpoint for form attachments (e.g., resumes) with file-type and origin validation.
- **Secure ERPNext Proxy Endpoints** (`/api/erpnext-proxy/...`) with rate-limiting, origin validation, and cross-tenant data isolation.
- **Inbound Sync Rules** (`erpnext-sync-rules` collection) to map ERPNext DocTypes into Payload collections.
- **Inbound Webhook Receiver** (`/api/erpnext-sync`) with HMAC-SHA256 signature verification for ERPNext → Payload sync.
- **Webhook Signature Verification** helper for validating incoming ERPNext/Frappe notifications.

> [!NOTE]
> Form-submission-to-ERPNext forwarding is handled by the host application's general **Workflows** collection (e.g., triggered on `collection_change` for `form-submissions`) rather than a dedicated parallel engine.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [ERPNext Workflow Steps](#erpnext-workflow-steps)
- [Inbound Sync Rules](#inbound-sync-rules)
- [Security & Access Control](#security--access-control)
- [Dead-Letter Queue](#dead-letter-queue)
- [Endpoints](#endpoints)
- [Project-Specific Endpoints](#project-specific-endpoints)
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
import { buildConfig } from 'payload'
import { erpnextPlugin } from 'payload-erpnext-plugin'
import { actionRegistry, emitSystemEvent, systemEvents, isInternalAuth } from './lib/host' // your host app

export default buildConfig({
  // ... your config
  plugins: [
    erpnextPlugin({
      registry: actionRegistry, // required for workflow ERP actions
      host: {
        emitSystemEvent,        // optional: enables ERPNext connection monitoring
        systemEvents,           // optional: { ERPNEXT_CONNECTION_FAILED, ERPNEXT_CONNECTION_RESTORED }
        isInternalAuth,         // optional: enables /api/erpnext/link-customer
      },
      enableAnonymousUpload: true, // optional, defaults to true
    }),
  ],
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `registry` | `ActionRegistryRef` | `undefined` | **Required for workflow actions**. The action registry to register `erp-get`, `erp-post`, `erp-patch`, and `erp-delete` handlers. |
| `host` | `ERPNextHostBindings` | `undefined` | Host-injected automation primitives (`emitSystemEvent`, `systemEvents`, `isInternalAuth`). Keeps the plugin free of circular imports into the CMS. |
| `enableAnonymousUpload` | `boolean` | `true` | Registers `/api/anonymous-upload` for form file attachments. |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ERPNEXT_ENCRYPTION_KEY` | **Required** | 32-byte hex AES-256-GCM key for encrypting credentials at rest. Generate with `openssl rand -hex 32`. |
| `INTERNAL_API_SECRET` | **Recommended** | Shared secret for `isInternalAuth` checks (e.g. `/api/erpnext/link-customer`). Verified with constant-time comparison. |
| `ERPNEXT_PROXY_KEY` | **Recommended** | Shared secret for server-to-server proxy access (`x-internal-key` header). Verified with constant-time comparison. |
| `ERPNEXT_PROXY_REQUIRE_CAPTCHA` | Optional | Set to `true` to require a reCAPTCHA token on public write operations (`/api/erpnext-proxy/submit`). |
| `REDIS_URL` | Optional | Enables Redis-backed rate limiting. Recommended for horizontal scaling. |
| `TRUSTED_ORIGINS` | Optional | Comma-separated list of origins allowed for proxy and anonymous upload endpoints. |
| `CORS_ORIGINS` | Optional | Fallback origin allow-list for proxy and anonymous upload endpoints. |
| `PAYLOAD_PUBLIC_SERVER_URL` | Optional | The CMS public URL; used as a trusted origin for anonymous uploads. |
| `NEXT_PUBLIC_PAYLOAD_URL` | Optional | Fallback public URL for anonymous upload origin checks. |
| `TRUSTED_PROXY_COUNT` | Optional | Number of trusted proxies in front of the app, used for accurate IP extraction. |
| `ALLOW_PLAINTEXT_ERPNEXT_CREDS` | Optional | Dangerous opt-out: allows storing ERPNext credentials without encryption when no `ERPNEXT_ENCRYPTION_KEY` is set. Not recommended for production. |

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

## Inbound Sync Rules

The `erpnext-sync-rules` collection lets you map ERPNext DocType changes into Payload documents.

| Field | Description |
|-------|-------------|
| **Label** | Friendly name for the rule. |
| **DocType** | ERPNext DocType to watch (e.g., `Customer`). |
| **Target Collection** | Payload collection where incoming records should be created or updated. |
| **Field Mappings** | Map ERPNext fields to Payload collection fields. |
| **Deduplication** | Define a reference key + path so the same ERPNext record can be updated instead of duplicated. |
| **Backfill** | Triggered automatically on save to fetch all existing ERPNext records for the configured DocType. |

Use the **`/api/erpnext-sync`** endpoint as the webhook target in ERPNext/Frappe. The endpoint verifies the webhook signature using the configured `webhookSecret` on the `erpnext-config` document.

---

## Security & Access Control

- **HTTPS in Production**: The proxy and fetch endpoints refuse to forward credentials or request payloads to non-HTTPS ERPNext URLs when `NODE_ENV === 'production'`. Plain HTTP is allowed only in development.
- **Credential Encryption**: Secrets and keys are encrypted using AES-256-GCM before writing to the database. They are only decrypted in memory during execution. Set `ERPNEXT_ENCRYPTION_KEY` to a 32-byte hex key.
- **Constant-Time Secret Comparison**: Internal secrets (`INTERNAL_API_SECRET`, `ERPNEXT_PROXY_KEY`) are compared with `timingSafeEqual` to prevent timing-oracle attacks.
- **Cross-Tenant Isolation**: In multi-tenant environments, the proxy restricts list fetches and single resource requests to the `company` configured on the tenant's active `ERPNext Config`. Admin endpoints such as `/api/erpnext-doctypes`, `/api/erpnext-doctype-fields`, `/api/erpnext-config/fetch-companies`, and `/api/erpnext-config/fetch-lead-sources` further restrict non-super-admins to their assigned `site`.
- **Doctype Whitelisting**: Frontend clients accessing the proxy can only query whitelisted, non-sensitive doctypes (e.g., `Job Opening`, `Blog Category`).
- **Origin Validation**: Proxy and anonymous upload endpoints reject browser requests unless the origin matches a domain registered in the `sites` collection or configured in `TRUSTED_ORIGINS` / `CORS_ORIGINS`.
- **Rate Limiting**: Public endpoints are rate-limited per IP using Redis when `REDIS_URL` is set, with an in-memory fallback.
- **Least-Privilege Access Control**: Collection access helpers (`siteScopedRead`, `siteScopedCreate`, `siteScopedUpdate`, `siteScopedDelete`) ensure documents can only be read, created, updated, or deleted within the user's site unless the user is a super-admin.

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
| `GET`  | `/api/cms-collections` | Lists writable Payload CMS collections (admin). |
| `GET`  | `/api/cms-collection-fields` | Lists fields for a Payload CMS collection (admin). |
| `POST` | `/api/erpnext/retry-dead-letters` | Retries dead-letter queue items. |
| `POST` | `/api/anonymous-upload` | Anonymous file upload to Payload Media. |
| `POST` | `/api/erpnext-sync` | Inbound ERPNext webhook receiver; verifies Frappe signature. |
| `POST` | `/api/erpnext/link-customer/:id` | Internal-only link between Payload customer and ERPNext Customer. |

---

## Project-Specific Endpoints

The plugin source also includes project-specific endpoints such as `/api/webhooks/erpnext` and the `erpnext` webhook receiver. These are maintained for internal integrations and are **not considered part of the stable public API** of this package. If you are consuming the plugin from npm you can ignore these unless your project explicitly enables them.

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
