import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { anonymousUploadEndpoint } from './anonymousUpload.js'

/**
 * The anonymous upload endpoint takes a file from an unauthenticated visitor —
 * it exists so a job applicant can attach a CV to an application form.
 *
 * Because anyone on the internet can reach it, four things have to hold:
 *
 *   1. Only requests from a site we trust are accepted, so the endpoint cannot
 *      be used as free file hosting from any third-party page.
 *   2. Only documents are accepted, and the file's actual bytes must match the
 *      type it claims. A caller controls the declared type, so without checking
 *      the real bytes someone could upload an HTML or SVG file labelled as a PDF
 *      and have the media route serve it back as active content.
 *   3. The site a file is attached to must be a real site, because the upload is
 *      written with access control bypassed.
 *   4. The whole thing is rate limited.
 */

/**
 * NODE_ENV is declared read-only by @types/node, but these tests must exercise
 * production-only branches (HTTPS enforcement, origin requirements). Assigning
 * through a widened view is the standard way to do that in a test.
 */
function setNodeEnv(value: string | undefined): void {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}


const ORIGINAL_ENV = { ...process.env }

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // "%PDF-1.7"
const DOC_BYTES = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const DOCX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
const HTML_BYTES = Buffer.from('<html><script>alert(1)</script></html>')

const PDF_MIME = 'application/pdf'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    setNodeEnv('test')
    process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.com'
    delete process.env.ERPNEXT_PROXY_KEY
    delete process.env.TRUSTED_ORIGINS
    delete process.env.CORS_ORIGINS
    process.env.TRUSTED_PROXY_COUNT = '1'
})

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

function realFile(bytes: Buffer, type: string, name = 'cv.pdf'): File {
    return new File([new Uint8Array(bytes)], name, { type })
}

let ipCounter = 0

function makeReq(opts: {
    file?: File | null
    site?: string | null
    headers?: Record<string, string>
    siteExists?: boolean
    created?: Record<string, unknown>
}) {
    ipCounter++
    const created: Array<Record<string, unknown>> = []
    const headers = new Headers({
        // A distinct client IP per request so the endpoint's own rate limit does
        // not bleed between tests.
        'x-forwarded-for': `203.0.113.${ipCounter % 250}`,
        ...(opts.headers ?? {}),
    })
    return {
        created,
        req: {
            headers,
            formData: async () => ({
                get: (key: string) => (key === 'file' ? (opts.file ?? null) : (opts.site ?? null)),
            }),
            payload: {
                find: async () => ({
                    totalDocs: opts.siteExists === false ? 0 : 1,
                    docs: opts.siteExists === false ? [] : [{ id: 7, slug: 'thatofadagirl' }],
                }),
                create: async (args: Record<string, unknown>) => {
                    created.push(args)
                    return { id: 'media-1', url: '/api/media/serve/cv.pdf', ...(opts.created ?? {}) }
                },
                logger: { info: () => {}, warn: () => {}, error: () => {} },
            },
        },
    }
}

const run = (r: unknown) =>
    (anonymousUploadEndpoint.handler as unknown as (req: unknown) => Promise<Response>)(r)

const TRUSTED = { origin: 'https://cms.example.com' }

describe('anonymousUpload — who may call it', () => {
    it('accepts a request from the CMS’s own origin', async () => {
        const { req } = makeReq({ file: realFile(PDF_BYTES, PDF_MIME), headers: TRUSTED })
        assert.equal((await run(req)).status, 200)
    })

    it('rejects a request from an untrusted site', async () => {
        const { req } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            headers: { origin: 'https://evil.example' },
        })
        assert.equal((await run(req)).status, 403)
    })

    it('accepts an origin listed in TRUSTED_ORIGINS', async () => {
        process.env.TRUSTED_ORIGINS = 'https://thatofadagirl.com'
        const { req } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            headers: { origin: 'https://thatofadagirl.com' },
        })
        assert.equal((await run(req)).status, 200)
    })

    it('ignores the port when it is the protocol default', async () => {
        const { req } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            headers: { origin: 'https://cms.example.com:443' },
        })
        assert.equal((await run(req)).status, 200)
    })

    it('accepts a server-to-server call presenting the internal key', async () => {
        // A Next.js Server Action's fetch sends no Origin header at all.
        process.env.ERPNEXT_PROXY_KEY = 'proxy-key-value-1234567890'
        const { req } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            headers: { 'x-internal-key': 'proxy-key-value-1234567890' },
        })
        assert.equal((await run(req)).status, 200)
    })

    it('rejects a wrong internal key, falling through to the origin check', async () => {
        // An untrusted Origin is supplied as well, so the request has no other
        // route to acceptance and the key is genuinely what is being tested.
        process.env.ERPNEXT_PROXY_KEY = 'proxy-key-value-1234567890'
        const { req } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            headers: {
                'x-internal-key': 'wrong-key-value-1234567890',
                origin: 'https://evil.example',
            },
        })
        assert.equal((await run(req)).status, 403)
    })

    it('rejects a key of a different length without throwing', async () => {
        process.env.ERPNEXT_PROXY_KEY = 'proxy-key-value-1234567890'
        const { req } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            headers: { 'x-internal-key': 'short', origin: 'https://evil.example' },
        })
        assert.equal((await run(req)).status, 403)
    })

    it('rejects a request with no origin in production', async () => {
        setNodeEnv('production')
        const { req } = makeReq({ file: realFile(PDF_BYTES, PDF_MIME) })
        assert.equal((await run(req)).status, 403)
    })
})

describe('anonymousUpload — what may be uploaded', () => {
    it('accepts a real PDF', async () => {
        const { req, created } = makeReq({ file: realFile(PDF_BYTES, PDF_MIME), headers: TRUSTED })
        assert.equal((await run(req)).status, 200)
        assert.equal(created.length, 1)
    })

    it('accepts a real .doc', async () => {
        const { req } = makeReq({
            file: realFile(DOC_BYTES, 'application/msword', 'cv.doc'),
            headers: TRUSTED,
        })
        assert.equal((await run(req)).status, 200)
    })

    it('accepts a real .docx', async () => {
        const { req } = makeReq({ file: realFile(DOCX_BYTES, DOCX_MIME, 'cv.docx'), headers: TRUSTED })
        assert.equal((await run(req)).status, 200)
    })

    it('rejects a file type that is not a document', async () => {
        const { req } = makeReq({
            file: realFile(PDF_BYTES, 'image/svg+xml', 'x.svg'),
            headers: TRUSTED,
        })
        assert.equal((await run(req)).status, 415)
    })

    it('rejects HTML disguised as a PDF — the declared type is not trusted', async () => {
        // This is the important one. The caller controls `type`, so the real
        // bytes decide. Without this check, active content could be uploaded and
        // later served back by the media route.
        const { req, created } = makeReq({
            file: realFile(HTML_BYTES, PDF_MIME, 'payload.pdf'),
            headers: TRUSTED,
        })
        const res = await run(req)
        assert.equal(res.status, 415)
        assert.match((await res.json()).error, /does not match its declared type/)
        assert.equal(created.length, 0, 'nothing should be written')
    })

    it('rejects a .docx whose bytes are not a zip archive', async () => {
        const { req } = makeReq({ file: realFile(HTML_BYTES, DOCX_MIME, 'x.docx'), headers: TRUSTED })
        assert.equal((await run(req)).status, 415)
    })

    it('rejects a file over the 5 MB limit', async () => {
        const big = Buffer.concat([PDF_BYTES, Buffer.alloc(5 * 1024 * 1024)])
        const { req } = makeReq({ file: realFile(big, PDF_MIME), headers: TRUSTED })
        assert.equal((await run(req)).status, 413)
    })

    it('rejects a request with no file', async () => {
        const { req } = makeReq({ file: null, headers: TRUSTED })
        assert.equal((await run(req)).status, 400)
    })

    it('rejects an empty file', async () => {
        const { req } = makeReq({ file: realFile(Buffer.alloc(0), PDF_MIME), headers: TRUSTED })
        assert.equal((await run(req)).status, 400)
    })
})

describe('anonymousUpload — which site a file is attached to', () => {
    it('attaches the upload to a site that exists', async () => {
        const { req, created } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            site: 'thatofadagirl',
            headers: TRUSTED,
        })
        assert.equal((await run(req)).status, 200)
        assert.equal((created[0].data as Record<string, unknown>).site, 'thatofadagirl')
    })

    it('rejects a site slug that does not exist', async () => {
        // The write uses overrideAccess, so an unchecked slug would let any
        // caller attach media to an arbitrary tenant.
        const { req, created } = makeReq({
            file: realFile(PDF_BYTES, PDF_MIME),
            site: 'not-a-real-site',
            siteExists: false,
            headers: TRUSTED,
        })
        const res = await run(req)
        assert.equal(res.status, 400)
        assert.match((await res.json()).error, /Invalid site/)
        assert.equal(created.length, 0)
    })

    it('allows an upload with no site at all', async () => {
        const { req, created } = makeReq({ file: realFile(PDF_BYTES, PDF_MIME), headers: TRUSTED })
        assert.equal((await run(req)).status, 200)
        assert.equal((created[0].data as Record<string, unknown>).site, undefined)
    })
})

describe('anonymousUpload — rate limiting', () => {
    it('blocks a burst from one client', async () => {
        const statuses: number[] = []
        for (let i = 0; i < 8; i++) {
            const { req } = makeReq({
                file: realFile(PDF_BYTES, PDF_MIME),
                headers: { ...TRUSTED, 'x-forwarded-for': '198.51.100.42' },
            })
            statuses.push((await run(req)).status)
        }
        assert.ok(statuses.includes(429), 'the limit of 5 per minute should be reached')
    })
})
