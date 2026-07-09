/**
 * ERPNext Credential Encryption
 *
 * Provides AES-256-GCM encryption for ERPNext API credentials stored in the
 * database. Credentials are encrypted before save and decrypted after read.
 *
 * Requires ERPNEXT_ENCRYPTION_KEY env var (32-byte hex string).
 * If the key is not set, credentials are stored/read in plain text (backward compatible).
 *
 * Key generation: openssl rand -hex 32
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard
const TAG_LENGTH = 16
const PREFIX = 'enc:' // Marker to detect already-encrypted values

let cachedKey: Buffer | null = null
let initialized = false

function getEncryptionKey(): Buffer | null {
    if (initialized) return cachedKey

    const hex = process.env.ERPNEXT_ENCRYPTION_KEY
    if (!hex) {
        // Fail-fast in production: storing ERPNext API credentials in plain text means
        // any DB dump/backup leaks every tenant's ERPNext keys. Require an explicit
        // opt-out for the rare legitimate case (e.g. throwaway dev-like environments).
        if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PLAINTEXT_ERPNEXT_CREDS !== 'true') {
            throw new Error(
                '[erpnext-crypto] FATAL: ERPNEXT_ENCRYPTION_KEY is required in production ' +
                '(generate with `openssl rand -hex 32`). Set ALLOW_PLAINTEXT_ERPNEXT_CREDS=true to knowingly store credentials in plain text.',
            )
        }
        if (process.env.NODE_ENV === 'production') {
            console.warn('[erpnext-crypto] ERPNEXT_ENCRYPTION_KEY not set — ERPNext credentials will be stored in plain text (ALLOW_PLAINTEXT_ERPNEXT_CREDS=true).')
        }
        initialized = true
        return null
    }

    const buf = Buffer.from(hex, 'hex')
    if (buf.length !== 32) {
        throw new Error('[erpnext-crypto] FATAL: ERPNEXT_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars).')
    }

    cachedKey = buf
    initialized = true
    return cachedKey
}

// Invoke immediately on module load to fail-fast if misconfigured.
// Tests can call __resetEncryptionKey() to force re-initialization.
getEncryptionKey()

/** Test-only helper to reset the cached encryption key state. */
export function __resetEncryptionKey(): void {
    cachedKey = null
    initialized = false
}

/**
 * Encrypt a plain-text credential. Returns a string prefixed with "enc:".
 * If encryption key is not configured, returns the value as-is.
 */
export function encryptCredential(plaintext: string): string {
    const key = getEncryptionKey()
    if (!key) return plaintext
    if (plaintext.startsWith(PREFIX)) return plaintext // Already encrypted

    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    // Format: enc:<iv_hex>:<tag_hex>:<ciphertext_hex>
    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypt an encrypted credential. If the value doesn't have the "enc:" prefix,
 * it's assumed to be plain text (backward compatible).
 */
export function decryptCredential(stored: string): string {
    const key = getEncryptionKey()
    if (!key) return stored
    if (!stored.startsWith(PREFIX)) return stored // Plain text (pre-encryption)

    try {
        const payload = stored.slice(PREFIX.length)
        const [ivHex, tagHex, ciphertextHex] = payload.split(':')
        if (!ivHex || !tagHex || !ciphertextHex) return stored

        const iv = Buffer.from(ivHex, 'hex')
        const tag = Buffer.from(tagHex, 'hex')
        const ciphertext = Buffer.from(ciphertextHex, 'hex')

        const decipher = createDecipheriv(ALGORITHM, key, iv)
        decipher.setAuthTag(tag)
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        return decrypted.toString('utf8')
    } catch (err) {
        console.error('[erpnext-crypto] Failed to decrypt credential:', err)
        return stored // Return raw value on failure — don't break the system
    }
}
