import { lookup as dnsLookup } from 'node:dns/promises'

/**
 * Blocks outbound requests to loopback, link-local (incl. the cloud metadata
 * address 169.254.169.254), and RFC1918 private ranges. `erpnextUrl` is only
 * writable by admin/super-admin roles (see ERPNextConfig.ts), but in a
 * multi-tenant deployment a site's own admin is not necessarily trusted with
 * server-infrastructure access — without this, they could point it at
 * internal services and have the server fetch them on their behalf (SSRF).
 */

function ipv4ToLong(ip: string): number {
    const parts = ip.split('.').map(Number)
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function inIpv4Range(ip: string, base: string, maskBits: number): boolean {
    const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0
    return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask)
}

function isPrivateOrReservedIpv4(ip: string): boolean {
    return (
        inIpv4Range(ip, '0.0.0.0', 8) ||
        inIpv4Range(ip, '10.0.0.0', 8) ||
        inIpv4Range(ip, '100.64.0.0', 10) ||
        inIpv4Range(ip, '127.0.0.0', 8) ||
        inIpv4Range(ip, '169.254.0.0', 16) ||
        inIpv4Range(ip, '172.16.0.0', 12) ||
        inIpv4Range(ip, '192.0.0.0', 24) ||
        inIpv4Range(ip, '192.168.0.0', 16) ||
        inIpv4Range(ip, '198.18.0.0', 15) ||
        inIpv4Range(ip, '224.0.0.0', 4) ||
        inIpv4Range(ip, '240.0.0.0', 4)
    )
}

function isPrivateOrReservedIpv6(ip: string): boolean {
    const norm = ip.toLowerCase()
    if (norm === '::1' || norm === '::') return true
    if (norm.startsWith('fe80:')) return true // link-local
    if (norm.startsWith('fc') || norm.startsWith('fd')) return true // unique local, fc00::/7
    const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateOrReservedIpv4(mapped[1])
    return false
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

/**
 * Resolves `hostname` (DNS name or literal IP) and returns true only if every
 * resolved address is a public, routable address. Fails closed on any DNS
 * error. Does not protect against DNS rebinding between this check and the
 * actual fetch — acceptable here since `erpnextUrl` changes rarely and is
 * admin-gated, not attacker-controlled per-request.
 */
export async function isSafeOutboundHost(hostname: string): Promise<boolean> {
    try {
        const results = await dnsLookup(hostname, { all: true, verbatim: true })
        if (results.length === 0) return false
        return results.every(({ address, family }) =>
            family === 4 ? !isPrivateOrReservedIpv4(address) : !isPrivateOrReservedIpv6(address),
        )
    } catch {
        return false
    }
}
