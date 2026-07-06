import type { Endpoint, PayloadRequest } from 'payload'

/**
 * POST /api/customers/:id/link-erpnext
 *
 * Internal-only endpoint that links a Payload customer to its ERPNext Customer id.
 * Built as a factory so the plugin receives the host's `isInternalAuth` guard via DI
 * rather than importing CMS access utilities. Registered only when the host provides it.
 */
export function createLinkErpnextCustomerEndpoint(isInternalAuth: (req: any) => boolean): Endpoint {
    return {
        path: '/api/customers/:id/link-erpnext',
        method: 'post',
        handler: async (req: PayloadRequest) => {
            try {
                if (!isInternalAuth(req)) {
                    return Response.json({ error: 'Unauthorized internal API access' }, { status: 403 })
                }

                const { id } = req.routeParams as { id: string }
                const body = req.json ? await req.json() : (req as unknown as { body: Record<string, unknown> }).body
                const { erpnextCustomer } = body as { erpnextCustomer?: string }

                if (!erpnextCustomer) {
                    return Response.json({ error: 'erpnextCustomer is required' }, { status: 400 })
                }

                await req.payload.update({
                    collection: 'customers' as never,
                    id,
                    data: { erpnextCustomer, erpnextSyncedAt: new Date().toISOString() } as never,
                    overrideAccess: true,
                })

                return Response.json({ success: true })
            } catch (error) {
                req.payload.logger.error({ err: error, msg: 'Error linking erpnext customer' })
                return Response.json({ error: 'Internal server error' }, { status: 500 })
            }
        },
    }
}
