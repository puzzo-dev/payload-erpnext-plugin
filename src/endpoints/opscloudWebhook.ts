import { timingSafeEqual, createHmac } from 'node:crypto';
import type { Endpoint } from 'payload';
import type { ERPNextCredentials } from '../types';
import { getCredentials, authHeaders } from './erpnextProxy';

/**
 * POST /api/webhooks/opscloud
 *
 * OpsCloud (ERPNext) → Payload webhook for That Ofada Girl order status changes.
 *
 * Security: OPSCLOUD_WEBHOOK_SECRET is REQUIRED. If not set the endpoint
 * returns 503 (fail-closed). A missing secret must never allow open access.
 *
 * On status change:
 *   - Updates the Payload Orders collection status field
 *   - On 'Confirmed': promotes the customer from "TOG Unpaid" → "TOG Completed" in ERPNext
 *   - On 'Delivered': sets review_notify_after (30-min future timestamp for WhatsApp review prompt)
 */

const STATUS_TEMPLATES: Record<string, { template: string; delay?: number }> = {
  Confirmed: { template: 'tog_order_confirmed' },
  Dispatched: { template: 'tog_out_for_delivery' },
  Delivered: { template: 'tog_review_request', delay: 30 * 60 * 1000 },
};

const ERP_TO_PAYLOAD_STATUS: Record<string, string> = {
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

async function promoteCustomerToPaid(creds: ERPNextCredentials, phone: string) {
  const qs = new URLSearchParams({
    filters: JSON.stringify([['custom_phone', '=', phone]]),
    fields: JSON.stringify(['name', 'customer_group']),
  });
  const res = await call(creds, `/api/resource/Customer?${qs.toString()}`);
  if (!res.data?.length) return false;
  const customer = res.data[0];
  if (customer.customer_group === 'TOG Completed') return true;
  await call(creds, `/api/resource/Customer/${encodeURIComponent(customer.name)}`, 'PUT', {
    customer_group: 'TOG Completed',
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

export const opscloudWebhookEndpoint: Endpoint = {
  path: '/webhooks/opscloud',
  method: 'post',
  handler: async (req) => {
    try {
      // ── Security gate: OPSCLOUD_WEBHOOK_SECRET is REQUIRED ────────────────
      // Fail-closed: if the secret is not configured, reject all requests.
      // An unconfigured secret must NEVER grant open access to this endpoint.
      const secret = process.env.OPSCLOUD_WEBHOOK_SECRET;
      if (!secret) {
        req.payload.logger.error(
          '[tog-integration] OPSCLOUD_WEBHOOK_SECRET is not set. Rejecting webhook. ' +
          'Set this env var to the secret configured in ERPNext → Webhooks → Secret.',
        );
        return Response.json(
          { error: 'Webhook endpoint is not configured. Contact the administrator.' },
          { status: 503 },
        );
      }

      const rawBody = typeof req.body === 'string'
        ? req.body
        : await new Response(req.body as ReadableStream).text();

      // Verify HMAC before parsing body
      const sig = req.headers.get('x-frappe-webhook-signature') ?? '';
      if (!sig || !verifyFrappeSignature(rawBody, sig, secret)) {
        req.payload.logger.warn('[tog-integration] Webhook signature verification failed');
        return Response.json({ error: 'Invalid signature' }, { status: 401 });
      }

      const creds = await getCredentials(req.payload, 'thatofadagirl', req);
      if (!creds) {
        return Response.json({ error: 'ERPNext integration is not configured' }, { status: 501 });
      }

      const { doc } = JSON.parse(rawBody);

      if (!doc?.name || !doc.status) {
        return Response.json({ error: 'Invalid payload' }, { status: 400 });
      }
      if (typeof doc.name !== 'string' || !/^[A-Za-z0-9 ./_-]+$/.test(doc.name)) {
        return Response.json({ error: 'Invalid document name' }, { status: 400 });
      }

      const config = STATUS_TEMPLATES[doc.status];
      if (!config) return Response.json({ status: 'no-action' });

      const customer = await getOrderCustomer(creds, doc.name);
      if (!customer?.custom_phone) return Response.json({ status: 'no-phone' });

      const phone = customer.custom_phone;

      // Sync status back to Payload Orders collection
      const payloadStatus = ERP_TO_PAYLOAD_STATUS[doc.status];
      if (payloadStatus) {
        try {
          const match = await req.payload.find({
            collection: 'orders' as never,
            where: { opscloud_so_name: { equals: doc.name } },
            limit: 1,
            depth: 0,
          });
          if (match.docs[0]) {
            const updateData: Record<string, unknown> = { status: payloadStatus };

            if (config.delay) {
              updateData.review_notify_after = new Date(Date.now() + config.delay).toISOString();
            }

            await req.payload.update({
              collection: 'orders' as never,
              id: (match.docs[0] as Record<string, unknown>).id as string,
              data: updateData as never,
            });
          }
        } catch (syncErr) {
          req.payload.logger.error(`[tog-integration] payload status sync failed: ${syncErr}`);
        }
      }

      // Promote customer from "TOG Unpaid" → "TOG Completed" when payment is confirmed
      if (doc.status === 'Confirmed') {
        try {
          await promoteCustomerToPaid(creds, phone);
        } catch (promoErr) {
          req.payload.logger.error(`[tog-integration] customer promotion failed: ${promoErr}`);
        }
      }

      return Response.json({ status: 'dispatched', template: config.template });
    } catch (err) {
      req.payload.logger.error(`[tog-integration] opscloud webhook error: ${err}`);
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }
  },
};
