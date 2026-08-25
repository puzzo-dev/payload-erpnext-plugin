/**
 * SSRF guard for outbound ERPNext requests.
 *
 * CANONICAL SOURCE: `@ivarse/shared-cms/ssrf-guard` holds the authoritative
 * implementation; this file is a byte-identical copy kept because this plugin
 * is a separately published package and cannot depend on the workspace-only
 * `@ivarse/shared-cms`. When the rule changes, update the shared-cms version
 * first, then mirror it here. The CMS's `src/lib/ssrfGuard.ts` is a thin
 * re-export from shared-cms and needs no manual sync.
 *
 * Blocks outbound requests to loopback, link-local (incl. the cloud metadata
 * address 169.254.169.254), and RFC1918 private ranges. `erpnextUrl` is only
 * writable by admin/super-admin roles (see ERPNextConfig.ts), but in a
 * multi-tenant deployment a site's own admin is not necessarily trusted with
 * server-infrastructure access — without this, they could point it at
 * internal services and have the server fetch them on their behalf (SSRF).
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import net from 'node:net'

// ── IPv4 range checks ─────────────────────────────────────────────────

function ipv4ToLong(ip: string): number {
    const parts = ip.split('.').map(Number)
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function inIpv4Range(ip: string, base: string, maskBits: number): boolean {
    const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0
    return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask)
}

/**
 * Comprehensive private/reserved IPv4 check. Covers all ranges both the CMS
 * and the plugin versions blocked — the superset, so merging cannot drop a
 * check that either caller relied on.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
    // Validate parseability first — unparseable is treated as unsafe.
    const p = ip.split('.').map((n) => parseInt(n, 10))
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
    return (
        inIpv4Range(ip, '0.0.0.0', 8) ||        // 0.0.0.0/8
        inIpv4Range(ip, '10.0.0.0', 8) ||       // 10.0.0.0/8
        inIpv4Range(ip, '100.64.0.0', 10) ||    // 100.64.0.0/10 CGNAT
        inIpv4Range(ip, '127.0.0.0', 8) ||      // loopback
        inIpv4Range(ip, '169.254.0.0', 16) ||   // link-local + cloud metadata
        inIpv4Range(ip, '172.16.0.0', 12) ||    // 172.16.0.0/12
        inIpv4Range(ip, '192.0.0.0', 24) ||     // 192.0.0.0/24 (IETF protocol assignments)
        inIpv4Range(ip, '192.168.0.0', 16) ||   // 192.168.0.0/16
        inIpv4Range(ip, '198.18.0.0', 15) ||    // 198.18.0.0/15 benchmarking
        inIpv4Range(ip, '224.0.0.0', 4) ||      // multicast 224.0.0.0/4
        inIpv4Range(ip, '240.0.0.0', 4)         // reserved 240.0.0.0/4
    )
}

// ── IPv6 range checks ─────────────────────────────────────────────────

/**
 * Comprehensive private/reserved IPv6 check. Superset of both versions:
 * loopback, unspecified, link-local, unique local, multicast, documentation,
 * and both IPv4-mapped forms (dotted-decimal and hex).
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
    const norm = ip.toLowerCase()
    if (norm === '::1' || norm === '::') return true          // loopback / unspecified
    if (norm.startsWith('fe80:')) return true                 // link-local
    if (norm.startsWith('fc') || norm.startsWith('fd')) return true  // unique local fc00::/7
    if (norm.startsWith('ff')) return true                    // multicast ff00::/8
    if (norm.startsWith('2001:db8:')) return true             // documentation 2001:db8::/32
    // IPv4-mapped IPv6 in dotted-decimal form: ::ffff:127.0.0.1
    const mappedDotted = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mappedDotted) return isPrivateOrReservedIpv4(mappedDotted[1])
    // IPv4-mapped IPv6 in hex form: ::ffff:7f00:1 (== 127.0.0.1)
    // Also matches full-form: 0:0:0:0:0:ffff:7f00:1
    const mappedHex = norm.match(/^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16)
        const lo = parseInt(mappedHex[2], 16)
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
        return isPrivateOrReservedIpv4(ipv4)
    }
    return false
}

function ipIsPrivate(ip: string): boolean {
    const type = net.isIP(ip)
    if (type === 4) return isPrivateOrReservedIpv4(ip)
    if (type === 6) return isPrivateOrReservedIpv6(ip)
    return true // unparseable → treat as unsafe
}

// ── Hostname resolution ───────────────────────────────────────────────

/** Internal hostnames that should never be fetched outbound. */
const INTERNAL_HOST_SUFFIXES = ['.localhost', '.internal', '.local']

/**
 * Resolves `hostname` (DNS name or literal IP) and returns true only if every
 * resolved address is a public, routable address. Fails closed on any DNS
 * error. Checks ALL resolved addresses so a DNS-rebinding attack (a public
 * name that resolves to 169.254.169.254) is blocked.
 */
export async function isSafeOutboundHost(hostname: string): Promise<boolean> {
    const host = hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets

    // Literal IP → check directly (no DNS).
    if (net.isIP(host)) {
        return !ipIsPrivate(host)
    }

    if (host === 'localhost' || INTERNAL_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
        return false
    }

    try {
        const results = await dnsLookup(host, { all: true, verbatim: true })
        if (results.length === 0) return false
        return results.every(({ address, family }) =>
            family === 4 ? !isPrivateOrReservedIpv4(address) : !isPrivateOrReservedIpv6(address),
        )
    } catch {
        return false
    }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Throws an Error if the URL is not a safe public http(s) target.
 * Used by the CMS webhook notification channel.
 */
export async function assertSafePublicUrl(rawUrl: string): Promise<void> {
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch {
        throw new Error('invalid URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`blocked URL scheme "${url.protocol}"`)
    }
    if (!(await isSafeOutboundHost(url.hostname))) {
        const host = url.hostname.replace(/^\[|\]$/g, '')
        if (net.isIP(host) && ipIsPrivate(host)) {
            throw new Error('blocked private/loopback IP')
        }
        if (host === 'localhost' || INTERNAL_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
            throw new Error('blocked internal hostname')
        }
        try {
            const addrs = await dnsLookup(host, { all: true })
            if (addrs.length === 0) throw new Error('host did not resolve')
            throw new Error('host resolves to a private/loopback address')
        } catch (e) {
            if (e instanceof Error && e.message.startsWith('host ')) throw e
            throw new Error('DNS resolution failed')
        }
    }
}

/**
 * Full URL validation for ERPNext outbound fetches. Combines protocol
 * enforcement (HTTPS-only in production) with the SSRF hostname guard.
 * Returns the validated, normalized URL (trailing slashes stripped) or
 * null if the URL is unsafe.
 */
export async function validateErpUrl(rawUrl: string): Promise<string | null> {
    let parsed: URL
    try {
        parsed = new URL(rawUrl)
    } catch {
        return null
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (parsed.protocol === 'http:' && process.env.NODE_ENV === 'production') return null
    if (!(await isSafeOutboundHost(parsed.hostname))) return null
    return rawUrl.replace(/\/+$/, '')
}
