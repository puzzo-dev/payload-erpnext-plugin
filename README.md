# @ivarse/payload-erpnext-plugin

A self-contained **Payload CMS 3.x plugin** for bidirectional ERPNext integration.

It provides:

- **ERPNext connection configuration** per site (multi-tenant)
- **Multi-DocType form workflows** — define multiple ERPNext requests per form submission
- **Hybrid sync/async forwarding** — validation errors returned immediately, transient failures retried via Payload Jobs
- **Dead-letter queue** for permanently failed ERPNext requests
- **Anonymous file upload** endpoint for form attachments (resumes, etc.)
- **ERPNext proxy endpoints** for frontend use
- **Live DocType picker** in the workflow builder, fetched from the site's ERPNext connection

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [ERPNext Form Workflows](#erpnext-form-workflows)
- [How Forwarding Works](#how-forwarding-works)
- [Error Handling](#error-handling)
- [Dead-Letter Queue](#dead-letter-queue)
- [Endpoints](#endpoints)
- [Security](#security)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

```bash
npm install @ivarse/payload-erpnext-plugin
# or
pnpm add @ivarse/payload-erpnext-plugin
```

---

## Quick Start

### 1. Add the plugin to `payload.config.ts`

```typescript
import { buildConfig } from 'payload'
import { erpnextPlugin, forwardToERPNext } from '@ivarse/payload-erpnext-plugin'
import { formBuilderPlugin } from '@payloadcms/plugin-form-builder'

export default buildConfig({
  // ... your config
  plugins: [
    formBuilderPlugin({
      // ... your form builder options
      formSubmissionOverrides: {
        hooks: {
          afterChange: [forwardToERPNext],
        },
      },
    }),
    erpnextPlugin(),
  ],
})
```

### 2. Create an `ERPNext Config` in the Payload admin

Go to **Integrations → ERPNext Config**:

- Select the site
- Enter the ERPNext URL (HTTPS only)
- Enter API Key and Secret
- Fetch companies / lead sources
- Save

### 3. Create an `ERPNext Form Workflow`

Go to **Integrations → ERPNext Form Workflows**:

- Select the form
- Select the site
- Add requests (DocType, action, field mappings)

### 4. Submit a form

The form submission will be forwarded to ERPNext according to the workflow.

---

## Configuration

### Plugin options

```typescript
import { erpnextPlugin } from '@ivarse/payload-erpnext-plugin'

erpnextPlugin({
  // Disable the anonymous file upload endpoint if you handle uploads elsewhere
  enableAnonymousUpload: false,
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableAnonymousUpload` | `boolean` | `true` | Register `/api/anonymous-upload` for form file attachments. |

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ERPNEXT_ENCRYPTION_KEY` | Recommended | 32-byte hex AES-256-GCM key for credential encryption. Generate with `openssl rand -hex 32`. |
| `REDIS_URL` | Optional | Enables Redis-backed rate limiting. Recommended for horizontal scaling. |

---

## ERPNext Form Workflows

A workflow is a sequence of ERPNext requests that run when a form submission is created.

### Workflow fields

- **Label**: Friendly name
- **Form**: Triggering Payload form
- **Site**: ERPNext site connection to use
- **Enabled**: Turn the workflow on/off

### Request fields

| Field | Description |
|-------|-------------|
| Position | Execution order (ascending) |
| Label | e.g. "Create Lead" |
| DocType | ERPNext DocType (fetched live from the site connection) |
| Action | `create`, `get`, or `update` |
| Reference Key | Store the result so later requests can reference it |
| Reference Path | Path to extract from the ERPNext response (default `data.name`) |
| Condition | Optional JS expression; request runs only if truthy |
| Optional | For `get`/`update`: treat "not found" as success |
| Field Mappings | Map Payload form fields to ERPNext fields |
| Static Values | Hard-coded ERPNext field values |
| Reference Mappings | Map values from earlier Reference Keys into ERPNext fields |
| Filters | For `get`/`update`: query filters to find the ERPNext document |

### Example: e-commerce order

1. **Get Customer** by phone (optional, reference key `customer`)
2. **Get Lead** by phone (optional, reference key `lead`)
3. **Create Lead** if `!references.lead`
4. **Create Customer** if `!references.customer`
5. **Create Sales Order** with `customer` mapped from `references.customer`

This prevents duplicate customer records and dead customers.

---

## How Forwarding Works

The `forwardToERPNext` hook runs **synchronously** on every new `form-submission` create:

1. Resolves the parent form and site.
2. Loads active ERPNext workflows for that form + site.
3. Runs the workflow executor.
4. If **all requests succeed**, the submission returns normally.
5. If a request fails with **4xx validation error**, the submission is rejected and the ERPNext error message is returned to the frontend.
6. If a request fails with **transient error** (5xx, timeout, network), a Payload Job is queued for retry and the submission still returns success.

### Payload Jobs

The plugin registers a `forwardToERPNext` task in Payload Jobs. On transient failure, the hook enqueues:

```json
{
  "task": "forwardToERPNext",
  "input": {
    "submissionId": "...",
    "formId": "...",
    "siteId": "..."
  }
}
```

Failed jobs appear in the Payload admin under **Jobs**, where they can be retried or inspected.

### Legacy fallback

If no workflow exists for a form, the plugin falls back to the legacy single-DocType behavior defined on the site's `ERPNext Config` (`defaultDocType` + field mappings).

---

## Error Handling

ERPNext error responses are parsed to extract the real message:

- `message`
- `exception`
- `_server_messages`
- `exc`

If the response body is JSON and contains one of these, the frontend receives that exact message. Otherwise, the HTTP category is returned.

Example frontend error:

```json
{
  "message": "ERPNext validation failed: Create Lead (Lead): Mobile Number is not a valid Indian mobile number"
}
```

---

## Dead-Letter Queue

Permanently failed ERPNext requests (after retries) are written to the `erpnext-dead-letters` collection with:

- Original submission ID
- Site
- ERPNext URL and DocType
- Payload sent
- Error category and detail
- HTTP status
- Retry count
- Correlation ID
- Workflow / request label

Admins can review dead letters and retry them manually via the **Retry Dead Letters** endpoint.

---

## Endpoints

The plugin registers the following endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/erpnext/submit` | Proxy to create an ERPNext document |
| `GET`  | `/api/erpnext/resource/:doctype/:name` | Proxy to read an ERPNext document |
| `GET`  | `/api/erpnext/health` | ERPNext connection health check |
| `POST` | `/api/erpnext/upload` | Proxy file upload to ERPNext |
| `POST` | `/api/erpnext-config/fetch-companies` | Fetch companies from ERPNext |
| `GET`  | `/api/erpnext-doctypes` | Fetch DocTypes from ERPNext for a site |
| `POST` | `/api/erpnext-config/fetch-lead-sources` | Fetch lead sources from ERPNext |
| `POST` | `/api/erpnext/retry-dead-letters` | Retry failed dead letters |
| `POST` | `/api/anonymous-upload` | Anonymous file upload to Payload Media |

All admin endpoints require a logged-in user with `super-admin` or `admin` role.

---

## Security

- **HTTPS only**: ERPNext URLs must start with `https://`.
- **Credential encryption**: API keys and secrets are encrypted at rest with `ERPNEXT_ENCRYPTION_KEY`.
- **Rate limiting**: Admin endpoints are rate-limited per IP.
- **Access control**: ERPNext collections default to `super-admin`/`admin`/`editor` site-scoped access. Override via your own access functions if needed.
- **TLS errors**: Network/TLS failures are written to the dead-letter queue instead of leaking details.

---

## Architecture

```
Payload Form Submission
        │
        ▼
forwardToERPNext hook (sync)
        │
        ├─ 4xx validation error ──► reject submission, return to frontend
        │
        ├─ 5xx/timeout/network ──► enqueue Payload Job
        │
        └─ success ──► submission saved
        │
        ▼
executeERPNextWorkflows
        │
        ├─ find workflows for form + site
        │
        ├─ run each request in position order
        │   ├─ field mappings
        │   ├─ static values
        │   ├─ reference mappings
        │   └─ store reference result
        │
        └─ write dead letter on permanent failure
```

---

## Troubleshooting

### "No active ERPNext config for site"

Create an ERPNext Config for the site and set it to active.

### "ERPNext credentials are masked or invalid"

The credentials read from the database are masked. Ensure `ERPNEXT_ENCRYPTION_KEY` matches the key used to encrypt them. If the key changed, re-save the credentials in the admin.

### DocType dropdown is empty

- Select a site in the workflow document first.
- Ensure the site has an active ERPNext Config.
- Check the ERPNext URL is HTTPS and reachable.
- Check the browser network tab for `/api/erpnext-doctypes` errors.

### Jobs are not retrying

Ensure Payload Jobs are enabled in your `payload.config.ts`:

```typescript
jobs: {
  tasks: [],
}
```

The plugin adds its task automatically.

---

## License

MIT
