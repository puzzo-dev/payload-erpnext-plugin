import type { Endpoint, CollectionSlug } from 'payload'
import { timingSafeEqual } from 'node:crypto'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';

/** Normalize an origin to `protocol://hostname:port`, omitting default ports. */
function normalizeOrigin(origin: string): string | null {
    try {
        const u = new URL(origin)
        const defaultPort = u.protocol === 'http:' ? '80' : u.protocol === 'https:' ? '443' : undefined
        const port = u.port && u.port !== defaultPort ? `:${u.port}` : ''
        return `${u.protocol}//${u.hostname}${port}`
    } catch {
        return null
    }
}

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

/**
 * Validate the request origin against the CMS public URL and any explicitly
 * trusted origins. Anonymous uploads are intended for browser forms; requiring
 * an origin blocks abuse from arbitrary third-party sites.
 *
 * Also accepts a server-to-server caller presenting X-Internal-Key (reusing
 * ERPNEXT_PROXY_KEY, the secret already used for this plugin's other
 * server-to-server proxy endpoints, rather than introducing a new one).
 * A Next.js Server Action's own `fetch` carries no Origin/Referer header at
 * all — without this branch, every server-to-server call (e.g. a job-
 * application form's resume upload) always fell through to the "no origin"
 * check below, which unconditionally denies in production regardless of who
 * the caller actually is.
 */
function isTrustedOrigin(req: any): boolean {
    const internalKey = process.env.ERPNEXT_PROXY_KEY
    if (internalKey) {
        const provided = req.headers.get('x-internal-key') || ''
        if (provided.length === internalKey.length) {
            try {
                if (timingSafeEqual(Buffer.from(provided), Buffer.from(internalKey))) return true
            } catch {
                /* fall through to origin checks */
            }
        }
    }

    const origin = req.headers.get('origin') || req.headers.get('referer') || ''

    // No origin is unusual for a real browser form POST. In production, require
    // an explicit origin. In development, allow it only when no trusted-origin
    // list is configured (single-tenant / development mode).
    if (!origin) {
        if (process.env.NODE_ENV === 'production') return false
        return !process.env.TRUSTED_ORIGINS && !process.env.CORS_ORIGINS
    }

    const normalizedOrigin = normalizeOrigin(origin)
    if (!normalizedOrigin) return false

    const cmsHost =
        process.env.PAYLOAD_PUBLIC_SERVER_URL ||
        process.env.NEXT_PUBLIC_PAYLOAD_URL ||
        ''

    if (cmsHost) {
        const normalizedCms = normalizeOrigin(cmsHost)
        if (normalizedCms && normalizedOrigin === normalizedCms) {
            return true
        }
    }

    const trusted = [
        ...(process.env.TRUSTED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
        ...(process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
    ]

    return trusted.some((candidate) => {
        const normalizedCandidate = normalizeOrigin(candidate)
        return normalizedCandidate !== null && normalizedOrigin === normalizedCandidate
    })
}

/**
 * Verify the file's actual leading bytes match its declared MIME type. The client
 * `file.type` header is attacker-controlled, so a caller could declare
 * "application/pdf" while uploading active content (e.g. an SVG/HTML file named
 * *.svg) which mediaServe would later serve executable. Magic-byte checks close
 * that bypass.
 *   PDF  → "%PDF-"                      (25 50 44 46 2D)
 *   DOC  → OLE2 compound file           (D0 CF 11 E0 A1 B1 1A E1)
 *   DOCX → ZIP local file header "PK.." (50 4B 03 04 / 05 06 / 07 08)
 */
function magicMatchesMime(buffer: Buffer, mime: string): boolean {
    const startsWith = (sig: number[]) => sig.every((b, i) => buffer[i] === b)
    if (mime === 'application/pdf') return startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])
    if (mime === 'application/msword') return startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        return buffer[0] === 0x50 && buffer[1] === 0x4b &&
            (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
    }
    return false
}

/**
 * Anonymous file upload endpoint.
 *
 * Accepts a multipart file upload, validates size and type, and creates a
 * Media document in Payload. Returns the public URL of the uploaded file.
 *
 * Intended for frontend forms (e.g. job applications) where the file must be
 * referenced inside a form submission. This endpoint does NOT create an ERPNext
 * record; the ERPNext workflow is triggered later by the form submission.
 */
export const anonymousUploadEndpoint: Endpoint = {
    path: '/anonymous-upload',
    method: 'post',
    handler: async (req) => {
    const payload = req.payload
    const logger = payload.logger

    // Rate limit: 5 uploads per IP per minute
    const ip = getClientIp(req)
    const rateLimit = await checkRateLimit(`anonymous-upload:${ip}`, 5, 60 * 1000)
    if (!rateLimit.allowed) {
        return Response.json({ error: 'Rate limit exceeded. Please try again later.' }, { status: 429 })
    }

    if (!isTrustedOrigin(req)) {
        logger.warn(`[AnonymousUpload] Rejected upload from untrusted origin`)
        return Response.json({ error: 'Untrusted origin' }, { status: 403 })
    }

    try {
        const formData = await req.formData?.()
        if (!formData) {
            return Response.json({ error: 'Expected multipart/form-data' }, { status: 400 })
        }

        const file = formData.get('file') as File | null
        const siteRaw = formData.get('site') as string | null

        if (!file || !(file instanceof File) || file.size === 0) {
            return Response.json({ error: 'No file provided' }, { status: 400 })
        }

        // Validate that the provided site slug actually exists before using
        // overrideAccess:true — an unvalidated site would let any caller
        // attach media to an arbitrary tenant.
        let site: string | null = null
        if (siteRaw) {
            const siteCheck = await payload.find({
                collection: 'sites' as unknown as CollectionSlug,
                where: { slug: { equals: siteRaw } },
                limit: 1,
                overrideAccess: true,
            })
            if (siteCheck.totalDocs === 0) {
                return Response.json({ error: 'Invalid site' }, { status: 400 })
            }
            site = siteRaw
        }

        if (file.size > MAX_FILE_SIZE) {
            return Response.json({ error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit` }, { status: 413 })
        }

        if (!ALLOWED_MIME_TYPES.includes(file.type)) {
            return Response.json({ error: 'Unsupported file type' }, { status: 415 })
        }

        const arrayBuffer = await file.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        // Enforce that the actual bytes match the declared (allowlisted) type.
        if (!magicMatchesMime(buffer, file.type)) {
            return Response.json({ error: 'File content does not match its declared type' }, { status: 415 })
        }

        const mediaDoc = await payload.create({
            collection: 'media' as unknown as CollectionSlug,
            data: {
                alt: file.name,
                ...(site ? { site } : {}),
            } as any,
            file: {
                data: buffer,
                name: file.name,
                mimetype: file.type,
                size: file.size,
            },
            overrideAccess: true,
        })

        const url = (mediaDoc as unknown as { url?: string; filename?: string }).url
            || (mediaDoc as unknown as { url?: string; filename?: string }).filename

        logger.info(`[AnonymousUpload] Created media ${mediaDoc.id} for site ${site || 'none'}`)

        return Response.json({ ok: true, mediaId: mediaDoc.id, url })
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[AnonymousUpload] Failed: ${message}`)
        return Response.json({ error: 'Upload failed' }, { status: 500 })
    }
    },
}
