import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify an ERPNext HMAC-SHA256 webhook signature in constant time.
 *
 * ERPNext/Frappe sends:
 *   - `X-ERPNext-Signature`: hex digest  (standard ERPNext webhook)
 *   - `X-Frappe-Webhook-Signature`: base64 digest  (ERPNext / custom Frappe apps)
 *
 * @param rawBody   - raw request body string (before JSON.parse)
 * @param signature - value of the signature header (hex or base64)
 * @param secret    - shared HMAC secret
 * @param encoding  - 'hex' (default) or 'base64'
 */
export function verifyERPNextWebhookSignature(
    rawBody: string,
    signature: string,
    secret: string,
    encoding: 'hex' | 'base64' = 'hex',
): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest(encoding)
    if (expected.length !== signature.length) return false
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}
