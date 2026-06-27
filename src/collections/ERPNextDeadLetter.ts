import type { CollectionConfig } from 'payload'
import { superAdminOnly } from '../access/roles';

/**
 * ERPNext Dead Letter Queue
 *
 * Stores form submissions that failed to forward to ERPNext.
 * Enables manual inspection, replay, and audit of integration failures.
 */
export const ERPNextDeadLetter: CollectionConfig = {
    slug: 'erpnext-dead-letters',
    admin: {
        useAsTitle: 'submissionId',
        defaultColumns: ['submissionId', 'docType', 'errorCategory', 'retryCount', 'status', 'createdAt'],
        group: 'Integrations',
        description: 'Failed ERPNext forwards awaiting retry or manual resolution',
    },
    access: {
        read: superAdminOnly,
        create: superAdminOnly,
        update: superAdminOnly,
        delete: superAdminOnly,
    },
    fields: [
        {
            name: 'submissionId',
            type: 'text',
            required: true,
            admin: { description: 'Original form-submission document ID' },
        },
        {
            name: 'site',
            type: 'relationship',
            relationTo: 'sites',
            required: true,
        },
        {
            name: 'erpnextUrl',
            type: 'text',
            required: true,
        },
        {
            name: 'docType',
            type: 'text',
            required: true,
        },
        {
            name: 'payload',
            type: 'json',
            required: true,
            admin: { description: 'The JSON payload that was sent (or attempted)' },
        },
        {
            name: 'errorCategory',
            type: 'select',
            required: true,
            options: [
                { label: 'Network Timeout', value: 'timeout' },
                { label: 'HTTP 4xx (Client Error)', value: 'client-error' },
                { label: 'HTTP 5xx (Server Error)', value: 'server-error' },
                { label: 'TLS / Connection Refused', value: 'tls-error' },
                { label: 'Unexpected Exception', value: 'exception' },
            ],
        },
        {
            name: 'errorDetail',
            type: 'textarea',
            admin: { description: 'Full error message or response body' },
        },
        {
            name: 'httpStatus',
            type: 'number',
            admin: { description: 'HTTP status code returned by ERPNext (if any)' },
        },
        {
            name: 'retryCount',
            type: 'number',
            defaultValue: 0,
            admin: { description: 'How many automatic retries have been attempted' },
        },
        {
            name: 'lastRetryAt',
            type: 'date',
            admin: { description: 'Timestamp of the last retry attempt' },
        },
        {
            name: 'status',
            type: 'select',
            defaultValue: 'pending',
            options: [
                { label: 'Pending Retry', value: 'pending' },
                { label: 'Replayed (Success)', value: 'success' },
                { label: 'Replayed (Failed)', value: 'failed' },
                { label: 'Archived (Manual)', value: 'archived' },
            ],
        },
        {
            name: 'correlationId',
            type: 'text',
            admin: { description: 'Trace ID for cross-reference with application logs' },
        },
        {
            name: 'workflow',
            type: 'text',
            admin: { description: 'Workflow label that produced this failure' },
        },
        {
            name: 'requestLabel',
            type: 'text',
            admin: { description: 'Request label within the workflow' },
        },
    ],
    timestamps: true,
}
