import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { verifyERPNextWebhookSignature } from './webhookSignature'

describe('webhookSignature', () => {
    const secret = 'shh'
    const body = '{"event":"on_update","doctype":"Customer"}'

    it('accepts a valid hex signature', () => {
        const signature = createHmac('sha256', secret).update(body).digest('hex')
        assert.strictEqual(verifyERPNextWebhookSignature(body, signature, secret, 'hex'), true)
    })

    it('rejects an invalid hex signature', () => {
        const badSignature = createHmac('sha256', 'wrong-secret').update(body).digest('hex')
        assert.strictEqual(verifyERPNextWebhookSignature(body, badSignature, secret, 'hex'), false)
    })

    it('accepts a valid base64 signature', () => {
        const signature = createHmac('sha256', secret).update(body).digest('base64')
        assert.strictEqual(verifyERPNextWebhookSignature(body, signature, secret, 'base64'), true)
    })

    it('rejects a signature with mismatched length', () => {
        assert.strictEqual(verifyERPNextWebhookSignature(body, 'short', secret, 'hex'), false)
    })

    it('rejects an empty signature', () => {
        assert.strictEqual(verifyERPNextWebhookSignature(body, '', secret, 'hex'), false)
    })
})
