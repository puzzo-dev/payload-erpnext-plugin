import { timingSafeEqual, createHmac } from 'node:crypto';
import type { Endpoint, CollectionSlug } from 'payload';
import type { ERPNextCredentials } from '../types';
import { getCredentials, authHeaders } from './erpnextProxy';

/**
 * POST /api/webhooks/erpnext?site=<site-slug>
 *
 * Per-site ERPNext → Payload webhook for order status changes.
 *
 * Security: the webhook secret is resolved per site from the active
 * erpnext-config document (`webhookSecret`). A missing secret fails closed
 * with 403. There is no global fallback secret.
 *
 * On status change:
 *   - Updates the Payload Orders collection status field
 *   - On 'Confirmed': promotes the customer to the configured "Completed" customer group in ERPNext
 *   - On 'Delivered': sets review_notify_after (future timestamp for WhatsApp review prompt)
 */

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
 * Thin ERPNext API caller with typed credentials.
 * Uses `authHeaders()` from the plugin to construct the token header.
 */
async function call(creds: ERPNextCredentials, path: string, method = 'GET', body?: object) {
  if (!/^https?:\/\//i.test(creds.url)) throw new Error('ERPNext URL is not configured')
  const res = await fetch(`${creds.url}${path}`, {
    method,
    headers: authHeaders(creds),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`ERPNext API Error: ${res.status}`);
  return res.json();
}

async function getOrderCustomer(creds: ERPNextCredentials, soName: string) {
  const encodedName = encodeURIComponent(soName);
  const so = await call(
    creds,
    `/api/resource/Sales Order/${encodedName}?fields=["customer","customer_name","custom_phone"]`
  );
  return so.data;
}

async function promoteCustomerToPaid(creds: ERPNextCredentials, phone: string, customerGroup: string) {
  const qs = new URLSearchParams({
    filters: JSON.stringify([['custom_phone', '=', phone]]),
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

      // Build per-site status mappings, falling back to defaults.
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
      }
      // Merge defaults for any statuses the site did not explicitly configure.
      for (const [status, tmpl] of Object.entries(DEFAULT_STATUS_TEMPLATES)) {
        if (!statusTemplates[status]) statusTemplates[status] = tmpl;
      }
      for (const [status, payloadStatus] of Object.entries(DEFAULT_ERP_TO_PAYLOAD_STATUS)) {
        if (!erpToPayloadStatus[status]) erpToPayloadStatus[status] = payloadStatus;
      }

      const completedCustomerGroup = (activeConfig?.erpnextCompletedCustomerGroup as string | undefined)
        || 'TOG Completed';

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

      const customer = await getOrderCustomer(creds, doc.name);
      if (!customer?.custom_phone) return Response.json({ status: 'no-phone' });

      const phone = customer.custom_phone;

      // Sync status back to Payload Orders collection
      if (payloadStatus) {
        try {
          const match = await req.payload.find({
            collection: 'orders' as never,
            where: { erpnext_so_name: { equals: doc.name } },
            limit: 1,
            depth: 0,
          });
          if (match.docs[0]) {
            const updateData: Record<string, unknown> = { status: payloadStatus };

            if (statusConfig?.delayMs) {
              updateData.review_notify_after = new Date(Date.now() + statusConfig.delayMs).toISOString();
            }

            await req.payload.update({
              collection: 'orders' as never,
              id: (match.docs[0] as Record<string, unknown>).id as string,
              data: updateData as never,
            });
          }
        } catch (syncErr) {
          req.payload.logger.error(`[erpnext-webhook] payload status sync failed for site "${siteSlug}": ${syncErr}`);
        }
      }

      // Promote customer to the configured "Completed" group when payment is confirmed
      if (doc.status === 'Confirmed') {
        try {
          await promoteCustomerToPaid(creds, phone, completedCustomerGroup);
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
