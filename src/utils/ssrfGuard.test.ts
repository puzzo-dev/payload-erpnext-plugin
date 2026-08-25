import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { validateErpUrl, isSafeOutboundHost } from './ssrfGuard.js'

/**
 * Server-Side Request Forgery guard for outbound ERPNext calls.
 *
 * The ERPNext server URL is set per site by that site's own admin. In a
 * multi-tenant platform, a tenant's admin is not automatically trusted with
 * access to the server's internal network — without this guard they could point
 * the URL at an internal service (a database, an admin panel, or the cloud
 * metadata endpoint at 169.254.169.254 that hands out cloud credentials) and
 * have this server fetch it on their behalf.
 *
 * The rule is: resolve the hostname, and allow it only if every address it
 * resolves to is a public, routable one. Anything else, including a DNS failure,
 * is refused.
 */

/**
 * NODE_ENV is declared read-only by @types/node, but these tests must exercise
 * production-only branches (HTTPS enforcement, origin requirements). Assigning
 * through a widened view is the standard way to do that in a test.
 */
function setNodeEnv(value: string | undefined): void {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}


const ORIGINAL_NODE_ENV = process.env.NODE_ENV

beforeEach(() => {
    setNodeEnv('test')
})

afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV)
})

describe('isSafeOutboundHost — addresses that must be refused', () => {
    const blocked: Array<[string, string]> = [
        ['127.0.0.1', 'IPv4 loopback'],
        ['127.1.1.1', 'anywhere in the loopback range'],
        ['0.0.0.0', 'the unspecified address'],
        ['10.0.0.5', 'private class A'],
        ['172.16.0.1', 'private class B, low end'],
        ['172.31.255.254', 'private class B, high end'],
        ['192.168.1.1', 'private class C'],
        ['169.254.169.254', 'the cloud metadata endpoint'],
        ['169.254.0.1', 'link-local'],
        ['100.64.0.1', 'carrier-grade NAT'],
        ['198.18.0.1', 'benchmarking range'],
        ['224.0.0.1', 'multicast'],
        ['240.0.0.1', 'reserved'],
        ['192.0.0.1', 'IETF protocol assignments'],
        ['::1', 'IPv6 loopback'],
        ['fe80::1', 'IPv6 link-local'],
        ['fd00::1', 'IPv6 unique local'],
        ['fc00::1', 'IPv6 unique local, low end'],
        ['ff02::1', 'IPv6 multicast'],
        ['::ffff:127.0.0.1', 'IPv4 loopback written as IPv6'],
        ['::ffff:192.168.0.1', 'private IPv4 written as IPv6'],
        ['0:0:0:0:0:ffff:7f00:1', 'IPv4 loopback as full-form IPv6 hex'],
    ]

    for (const [address, description] of blocked) {
        it(`refuses ${address} (${description})`, async () => {
            assert.equal(await isSafeOutboundHost(address), false)
        })
    }
})

describe('isSafeOutboundHost — addresses that are allowed', () => {
    const allowed: Array<[string, string]> = [
        ['8.8.8.8', 'a public IPv4 address'],
        ['1.1.1.1', 'another public IPv4 address'],
        ['172.32.0.1', 'just outside the private class B range'],
        ['172.15.255.255', 'just below the private class B range'],
        ['192.169.0.1', 'just outside the private class C range'],
        ['100.63.255.255', 'just below the carrier-grade NAT range'],
        ['2606:4700:4700::1111', 'a public IPv6 address'],
    ]

    for (const [address, description] of allowed) {
        it(`allows ${address} (${description})`, async () => {
            assert.equal(await isSafeOutboundHost(address), true)
        })
    }
})

describe('isSafeOutboundHost — failure behaviour', () => {
    it('refuses a hostname that cannot be resolved', async () => {
        // Failing closed matters: a DNS outage must not turn into "allow
        // everything".
        assert.equal(await isSafeOutboundHost('this-host-does-not-exist.invalid'), false)
    })

    it('refuses an empty hostname', async () => {
        assert.equal(await isSafeOutboundHost(''), false)
    })
})

describe('validateErpUrl', () => {
    it('accepts an https URL pointing at a public host', async () => {
        assert.equal(await validateErpUrl('https://8.8.8.8'), 'https://8.8.8.8')
    })

    it('strips trailing slashes so callers can append paths safely', async () => {
        assert.equal(await validateErpUrl('https://8.8.8.8///'), 'https://8.8.8.8')
    })

    it('refuses a URL pointing at loopback', async () => {
        assert.equal(await validateErpUrl('https://127.0.0.1'), null)
    })

    it('refuses a URL pointing at the cloud metadata endpoint', async () => {
        assert.equal(await validateErpUrl('http://169.254.169.254/latest/meta-data/'), null)
    })

    it('refuses a non-HTTP protocol', async () => {
        for (const url of ['file:///etc/passwd', 'ftp://8.8.8.8', 'gopher://8.8.8.8']) {
            assert.equal(await validateErpUrl(url), null, `should refuse ${url}`)
        }
    })

    it('refuses a malformed URL instead of throwing', async () => {
        assert.equal(await validateErpUrl('not a url'), null)
        assert.equal(await validateErpUrl(''), null)
    })

    it('allows plain http outside production, for local ERPNext instances', async () => {
        setNodeEnv('development')
        assert.equal(await validateErpUrl('http://8.8.8.8'), 'http://8.8.8.8')
    })

    it('refuses plain http in production, so credentials are never sent unencrypted', async () => {
        setNodeEnv('production')
        assert.equal(await validateErpUrl('http://8.8.8.8'), null)
    })

    it('still allows https in production', async () => {
        setNodeEnv('production')
        assert.equal(await validateErpUrl('https://8.8.8.8'), 'https://8.8.8.8')
    })

    it('refuses a URL whose port points at a local service', async () => {
        // The port is irrelevant — the host is what is checked.
        assert.equal(await validateErpUrl('https://127.0.0.1:9200'), null)
    })
})
