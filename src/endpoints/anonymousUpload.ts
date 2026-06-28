import type { Endpoint, CollectionSlug } from 'payload'
import { checkRateLimit, getClientIp } from '../utils/rateLimit';

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

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

    try {
        const formData = await req.formData?.()
        if (!formData) {
            return Response.json({ error: 'Expected multipart/form-data' }, { status: 400 })
        }

        const file = formData.get('file') as File | null
        const site = formData.get('site') as string | null

        if (!file || !(file instanceof File) || file.size === 0) {
            return Response.json({ error: 'No file provided' }, { status: 400 })
        }

        if (file.size > MAX_FILE_SIZE) {
            return Response.json({ error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit` }, { status: 413 })
        }

        if (!ALLOWED_MIME_TYPES.includes(file.type)) {
            return Response.json({ error: 'Unsupported file type' }, { status: 415 })
        }

        const arrayBuffer = await file.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

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
