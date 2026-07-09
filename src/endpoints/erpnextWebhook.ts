import { timingSafeEqual, createHmac } from 'node:crypto';
import type { Endpoint, CollectionSlug } from 'payload';
import type { ERPNextCredentials } from '../types';
import { getCredentials, authHeaders } from './erpnextProxy';

/**
 * POST /api/webhooks/erpnext?site=<site-slug>
 *
 * Per-site ERPNext → Payload webhook for status-aware document updates.
 *
 * Fully generic: each site configures the source ERPNext DocType, the target
 * Payload collection, the fields to match and update, and optional customer
 * group promotion. Defaults keep the original Sales Order → Orders behavior.
 *
 * Security: the webhook secret is resolved per site from the active
 * erpnext-config document (`webhookSecret`). A missing secret fails closed
 * with 403. There is no global fallback secret.
 */

/**
 * Thin ERPNext API caller with typed credentials.
 * Uses `authHeaders()` from the plugin to construct the token header.
 */
async function call(creds: ERPNextCredentials, path: string, method = 'GET', body?: object) {
  if (!/^https?:\/\//i.test(creds.url)) throw new Error('ERPNext URL is not configured')
  const res = await fetch(`${creds.url}${path}`, {
    method,
    headers: authHeaders(creds),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ERPNext API Error: ${res.status}`);
  return res.json();
}

async function getSourceRecord(
  creds: ERPNextCredentials,
  doctype: string,
  name: string,
  fields: string[],
): Promise<Record<string, unknown> | undefined> {
  const encodedName = encodeURIComponent(name);
  const encodedDoctype = encodeURIComponent(doctype);
  const encodedFields = encodeURIComponent(JSON.stringify(fields));
  const result = await call(
    creds,
    `/api/resource/${encodedDoctype}/${encodedName}?fields=${encodedFields}`,
  );
  return result.data as Record<string, unknown> | undefined;
}

async function promoteCustomerToGroup(
  creds: ERPNextCredentials,
  lookupValue: string,
  lookupField: string,
  customerGroup: string,
): Promise<boolean> {
  const qs = new URLSearchParams({
    filters: JSON.stringify([[lookupField, '=', lookupValue]]),
    fields: JSON.stringify(['name', 'customer_group']),
  });
  const res = await call(creds, `/api/resource/Customer?${qs.toString()}`);
  if (!res.data?.length) return false;
  const customer = res.data[0];
  if (customer.customer_group === customerGroup) return true;
  await call(creds, `/api/resource/Customer/${encodeURIComponent(customer.name)}`, 'PUT', {
    customer_group: customerGroup,
  });
  return true;
}

// Defaults for sites without per-site mappings in erpnext-config.
// Each site can override these in CMS admin → erpnext-config → Webhooks tab.
const DEFAULT_STATUS_TEMPLATES: Record<string, { template?: string; delayMs?: number }> = {
  Confirmed: { template: 'tog_order_confirmed' },
  Dispatched: { template: 'tog_out_for_delivery' },
  Delivered: { template: 'tog_review_request', delayMs: 30 * 60 * 1000 },
};

const DEFAULT_ERP_TO_PAYLOAD_STATUS: Record<string, string> = {
  Confirmed: 'confirmed',
  Dispatched: 'dispatched',
  Delivered: 'delivered',
  Cancelled: 'cancelled',
};

/**
 * Verify the Frappe/ERPNext webhook HMAC-SHA256 signature.
 * Frappe encodes the signature as base64 (not hex).
 */
function verifyFrappeSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export const erpnextWebhookEndpoint: Endpoint = {
  path: '/webhooks/erpnext',
  method: 'post',
  handler: async (req) => {
    let siteSlug: string | null = null;
    try {
      const rawBody = typeof req.body === 'string'
        ? req.body
        : await new Response(req.body as ReadableStream).text();

      // ── 1. Identify the site from ?site=<slug> ─────────────────────────────
      const url = new URL(req.url || '', 'http://localhost');
      siteSlug = url.searchParams.get('site');
      if (!siteSlug) {
        return Response.json({ error: 'Missing ?site= query parameter' }, { status: 400 });
      }

      const sites = await req.payload.find({
        collection: 'sites',
        where: { slug: { equals: siteSlug } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      });
      if (sites.totalDocs === 0) {
        return Response.json({ error: 'Site not found' }, { status: 404 });
      }
      const siteId = sites.docs[0].id;

      // ── 2. Resolve the webhook secret for this site ──────────────────────
      const configs = await req.payload.find({
        collection: 'erpnext-config' as unknown as CollectionSlug,
        where: {
          site: { equals: siteId },
          isActive: { equals: true },
        },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
      });

      const activeConfig = configs.totalDocs > 0
        ? (configs.docs[0] as unknown as Record<string, unknown>)
        : null;

      const secret: string | undefined = activeConfig?.webhookSecret as string | undefined;

      // Fail-closed: a missing secret must NEVER grant open access.
      if (!secret) {
        req.payload.logger.error(
          `[erpnext-webhook] No webhook secret for site "${siteSlug}". ` +
          'Configure webhookSecret in the site\'s erpnext-config.',
        );
        return Response.json(
          { error: 'Webhook endpoint is not configured for this site.' },
          { status: 403 },
        );
      }

      // Build per-site status mappings. If the site has configured any mappings,
      // those win outright; otherwise fall back to the built-in defaults.
      const rawMappings = activeConfig?.erpnextStatusMappings as Array<{
        erpStatus: string
        payloadStatus: string
        template?: string
        delayMinutes?: number
      }> | undefined;

      const statusTemplates: Record<string, { template?: string; delayMs?: number }> = {};
      const erpToPayloadStatus: Record<string, string> = {};
      if (rawMappings && rawMappings.length > 0) {
        for (const m of rawMappings) {
          if (!m.erpStatus) continue;
          if (m.template) statusTemplates[m.erpStatus] = { template: m.template };
          if (typeof m.delayMinutes === 'number' && m.delayMinutes >= 0) {
            statusTemplates[m.erpStatus] = statusTemplates[m.erpStatus] || {};
            statusTemplates[m.erpStatus].delayMs = m.delayMinutes * 60 * 1000;
          }
          if (m.payloadStatus) erpToPayloadStatus[m.erpStatus] = m.payloadStatus;
        }
      } else {
        for (const [status, tmpl] of Object.entries(DEFAULT_STATUS_TEMPLATES)) {
          statusTemplates[status] = tmpl;
        }
        for (const [status, payloadStatus] of Object.entries(DEFAULT_ERP_TO_PAYLOAD_STATUS)) {
          erpToPayloadStatus[status] = payloadStatus;
        }
      }

      const webhookConfig = {
        doctype: String(activeConfig?.webhookDocType ?? 'Sales Order'),
        targetCollection: String(activeConfig?.webhookTargetCollection ?? 'orders'),
        targetKeyField: String(activeConfig?.webhookTargetKeyField ?? 'erpnext_so_name'),
        statusField: String(activeConfig?.webhookStatusField ?? 'status'),
        notifyField: String(activeConfig?.webhookNotifyField ?? 'review_notify_after'),
        customerGroupField: String(activeConfig?.webhookCustomerGroupField ?? 'custom_phone'),
        completedCustomerGroup: String(activeConfig?.webhookCompletedCustomerGroup ?? 'TOG Completed'),
      };

      // ── 3. Verify HMAC before parsing body ───────────────────────────────
      const sig = req.headers.get('x-frappe-webhook-signature') ?? '';
      if (!sig || !verifyFrappeSignature(rawBody, sig, secret)) {
        req.payload.logger.warn(`[erpnext-webhook] Signature verification failed for site "${siteSlug}"`);
        return Response.json({ error: 'Invalid signature' }, { status: 401 });
      }

      // ── 4. Resolve per-site ERPNext credentials ──────────────────────────
      const creds = await getCredentials(req.payload, siteSlug, req);
      if (!creds) {
        return Response.json({ error: 'ERPNext integration is not configured for this site' }, { status: 501 });
      }

      const { doc } = JSON.parse(rawBody);

      if (!doc?.name || !doc.status) {
        return Response.json({ error: 'Invalid payload' }, { status: 400 });
      }
      if (typeof doc.name !== 'string' || !/^[A-Za-z0-9 ./_-]+$/.test(doc.name)) {
        return Response.json({ error: 'Invalid document name' }, { status: 400 });
      }

      const statusConfig = statusTemplates[doc.status];
      const payloadStatus = erpToPayloadStatus[doc.status];

      // No mapping means explicitly ignore this status.
      if (!statusConfig && !payloadStatus) {
        return Response.json({ status: 'no-action' });
      }

      // Optional: fetch the source record to get the configured customer lookup value.
      let customerLookupValue: string | undefined;
      if (webhookConfig.customerGroupField) {
        try {
          const sourceRecord = await getSourceRecord(
            creds,
            webhookConfig.doctype,
            doc.name,
            [webhookConfig.customerGroupField],
          );
          const value = sourceRecord?.[webhookConfig.customerGroupField];
          if (typeof value === 'string') customerLookupValue = value;
        } catch (fetchErr) {
          req.payload.logger.warn(`[erpnext-webhook] Could not fetch source record: ${fetchErr}`);
        }
      }

      // Sync status back to the configured Payload collection.
      if (payloadStatus) {
        try {
          const match = await req.payload.find({
            collection: webhookConfig.targetCollection as never,
            where: { [webhookConfig.targetKeyField]: { equals: doc.name } },
            limit: 1,
            depth: 0,
          });
          if (match.docs[0]) {
            const updateData: Record<string, unknown> = { [webhookConfig.statusField]: payloadStatus };

            if (statusConfig?.delayMs && webhookConfig.notifyField) {
              updateData[webhookConfig.notifyField] = new Date(Date.now() + statusConfig.delayMs).toISOString();
            }

            await req.payload.update({
              collection: webhookConfig.targetCollection as never,
              id: (match.docs[0] as Record<string, unknown>).id as string,
              data: updateData as never,
            });
          }
        } catch (syncErr) {
          req.payload.logger.error(`[erpnext-webhook] payload status sync failed for site "${siteSlug}": ${syncErr}`);
        }
      }

      // Optional customer group promotion.
      if (customerLookupValue && webhookConfig.completedCustomerGroup) {
        try {
          await promoteCustomerToGroup(
            creds,
            customerLookupValue,
            webhookConfig.customerGroupField,
            webhookConfig.completedCustomerGroup,
          );
        } catch (promoErr) {
          req.payload.logger.error(`[erpnext-webhook] customer promotion failed for site "${siteSlug}": ${promoErr}`);
        }
      }

      return Response.json({ status: 'dispatched', template: statusConfig?.template });
    } catch (err) {
      req.payload.logger.error(`[erpnext-webhook] unexpected error for site "${siteSlug ?? 'unknown'}": ${err}`);
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }
  },
};
