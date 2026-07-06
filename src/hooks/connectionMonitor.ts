import type { CollectionAfterChangeHook } from 'payload'
import type { EmitSystemEventFn } from '../types'

/**
 * Monitors ERPNext connection status changes and emits system events.
 *
 * Built as a factory: the host injects its `emitSystemEvent` + the system-event
 * name constants (from the CMS automation engine) so the plugin never imports back
 * into payload-cms. The plugin appends the returned hook to the erpnext-config
 * collection's afterChange. Without the plugin, no ERP connection monitoring exists.
 */
export function createConnectionMonitorHook(
  emitSystemEvent: EmitSystemEventFn,
  events: { ERPNEXT_CONNECTION_FAILED: string; ERPNEXT_CONNECTION_RESTORED: string },
): CollectionAfterChangeHook {
  return async ({ doc, previousDoc, req }) => {
    const newStatus = (doc as any).connectionStatus as string | undefined
    const prevStatus = previousDoc ? (previousDoc as any).connectionStatus as string | undefined : undefined

    const siteSlug = typeof (doc as any).site === 'object'
      ? (doc as any).site?.slug as string | undefined
      : undefined

    // Connection lost
    if (newStatus === 'disconnected' && prevStatus !== 'disconnected') {
      emitSystemEvent(
        req.payload,
        events.ERPNEXT_CONNECTION_FAILED,
        { siteSlug, error: 'ERPNext connection status changed to disconnected', data: { erpnextUrl: (doc as any).erpnextUrl } },
        req,
      ).catch(() => { /* non-critical */ })
    }

    // Connection restored
    if (newStatus === 'connected' && prevStatus === 'disconnected') {
      emitSystemEvent(
        req.payload,
        events.ERPNEXT_CONNECTION_RESTORED,
        { siteSlug, data: { erpnextUrl: (doc as any).erpnextUrl } },
        req,
      ).catch(() => { /* non-critical */ })
    }

    return doc
  }
}
