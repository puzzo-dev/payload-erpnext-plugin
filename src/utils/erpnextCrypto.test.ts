import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert'
import { encryptCredential, decryptCredential, __resetEncryptionKey } from './erpnextCrypto'

const TEST_KEY = 'a'.repeat(64)

describe('erpnextCrypto', () => {
    beforeEach(() => {
        process.env.ERPNEXT_ENCRYPTION_KEY = TEST_KEY
        __resetEncryptionKey()
    })

    after(() => {
        delete process.env.ERPNEXT_ENCRYPTION_KEY
        __resetEncryptionKey()
    })

    it('round-trips a plain credential', () => {
        const original = 'my-api-secret'
        const encrypted = encryptCredential(original)
        assert.ok(encrypted.startsWith('enc:'), 'encrypted value should have enc: prefix')
        assert.notStrictEqual(encrypted, original)
        const decrypted = decryptCredential(encrypted)
        assert.strictEqual(decrypted, original)
    })

    it('does not double-encrypt an already encrypted value', () => {
        const original = 'another-secret'
        const once = encryptCredential(original)
        const twice = encryptCredential(once)
        assert.strictEqual(once, twice)
        assert.strictEqual(decryptCredential(twice), original)
    })

    it('passes through plain text when no key is set', () => {
        delete process.env.ERPNEXT_ENCRYPTION_KEY
        __resetEncryptionKey()
        const value = 'plain-text-secret'
        assert.strictEqual(encryptCredential(value), value)
        assert.strictEqual(decryptCredential(value), value)
    })

    it('returns raw value on tampered ciphertext', () => {
        const encrypted = encryptCredential('secret')
        // Flip the final hex digit to a DIFFERENT one. Replacing it with a fixed
        // '0' was a ~1-in-16 flake: when the ciphertext already ended in '0' the
        // "tampered" value was byte-identical, so it decrypted cleanly and the
        // assertion below compared 'secret' against the untouched ciphertext.
        const tampered = encrypted.replace(/[0-9a-f]$/, (c) => (c === '0' ? '1' : '0'))
        // Decrypt should not throw; it should return the raw stored value.
        assert.doesNotThrow(() => decryptCredential(tampered))
        assert.strictEqual(decryptCredential(tampered), tampered)
    })
})
