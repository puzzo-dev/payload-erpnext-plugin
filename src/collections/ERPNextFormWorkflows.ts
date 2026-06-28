import type { CollectionConfig } from 'payload'
import {
    siteScopedCreate, siteScopedDelete, siteScopedRead, siteScopedUpdate
} from '../access/roles';
import { organizationField } from '../fields/organizationField';

/**
 * ERPNext Form Workflows
 *
 * Per-form, multi-doctype ERPNext automation.
 *
 * A workflow attaches to one Payload form and executes one or more
 * ERPNext requests in sequence when a submission is created. Each
 * request can create, get, or update a different ERPNext DocType and
 * can reference values from the form submission or from the result of
 * a previous request in the same workflow.
 */
export const ERPNextFormWorkflows: CollectionConfig = {
    slug: 'erpnext-form-workflows',
    admin: {
        useAsTitle: 'label',
        defaultColumns: ['label', 'form', 'site', 'enabled', 'updatedAt'],
        group: 'Integrations',
    },
    access: {
        read: siteScopedRead(),
        create: siteScopedCreate,
        update: siteScopedUpdate(),
        delete: siteScopedDelete(),
    },
    fields: [
        {
            name: 'label',
            type: 'text',
            required: true,
            admin: { description: 'e.g. "Avril Booking → Lead + Event Booking"' },
        },
        {
            name: 'form',
            type: 'relationship',
            relationTo: 'forms',
            required: true,
            admin: { description: 'The Payload form that triggers this workflow' },
        },
        {
            type: 'row',
            fields: [
                {
                    name: 'site',
                    type: 'relationship',
                    relationTo: 'sites',
                    required: true,
                    admin: { width: '70%' },
                },
                {
                    name: 'enabled',
                    type: 'checkbox',
                    defaultValue: true,
                    admin: { width: '30%' },
                },
            ],
        },
        organizationField(),
        {
            name: 'requests',
            type: 'array',
            required: true,
            admin: {
                description: 'Requests run in ascending position order. A later request can use values produced by an earlier request by referencing its Reference Key.',
            },
            fields: [
                {
                    type: 'row',
                    fields: [
                        {
                            name: 'position',
                            type: 'number',
                            required: true,
                            defaultValue: 1,
                            admin: { width: '15%', description: 'Execution order' },
                        },
                        {
                            name: 'label',
                            type: 'text',
                            required: true,
                            admin: { width: '35%', description: 'e.g. "Create Lead"' },
                        },
                        {
                            name: 'doctype',
                            type: 'text',
                            required: true,
                            admin: {
                                width: '25%',
                                description: 'ERPNext DocType fetched from the site connection.',
                                components: {
                                    Field: {
                                        path: './components/ERPNextDocTypeSelect/index',
                                        exportName: 'ERPNextDocTypeSelectField',
                                    },
                                },
                            },
                        },
                        {
                            name: 'action',
                            type: 'select',
                            required: true,
                            defaultValue: 'create',
                            options: [
                                { label: 'Create', value: 'create' },
                                { label: 'Get', value: 'get' },
                                { label: 'Update', value: 'update' },
                            ],
                            admin: { width: '25%' },
                        },
                    ],
                },
                {
                    name: 'enabled',
                    type: 'checkbox',
                    defaultValue: true,
                    admin: { description: 'Uncheck to skip this request without removing it' },
                },
                {
                    name: 'referenceKey',
                    type: 'text',
                    admin: {
                        description: 'Key used to store this request\'s result so later requests can reference it (e.g. "lead"). Leave blank to ignore the result.',
                    },
                },
                {
                    name: 'referencePath',
                    type: 'text',
                    defaultValue: 'data.name',
                    admin: {
                        description: 'Path to the value extracted from the ERPNext response and stored under Reference Key (e.g. data.name, message.name).',
                    },
                },
                {
                    name: 'condition',
                    type: 'text',
                    admin: {
                        description: 'Optional JS expression evaluated against the submission and prior results. Skip request if falsy. Example: values.event_date && values.guest_count',
                    },
                },
                {
                    name: 'optional',
                    type: 'checkbox',
                    defaultValue: false,
                    admin: {
                        description: 'For get/update: a "not found" response is treated as success and does not create a dead letter. Later requests can test references.{referenceKey} to decide whether to create the record.',
                    },
                },
                {
                    name: 'fieldMappings',
                    type: 'array',
                    admin: { description: 'Map form submission values to ERPNext fields' },
                    fields: [
                        {
                            name: 'formFieldName',
                            type: 'text',
                            required: true,
                            admin: { description: 'Payload form field name (e.g. email, name)' },
                        },
                        {
                            name: 'erpFieldName',
                            type: 'text',
                            required: true,
                            admin: { description: 'ERPNext field name (e.g. email_id, lead_name)' },
                        },
                    ],
                },
                {
                    name: 'staticValues',
                    type: 'array',
                    admin: { description: 'Hard-coded ERPNext fields added to every request' },
                    fields: [
                        {
                            name: 'field',
                            type: 'text',
                            required: true,
                            admin: { description: 'ERPNext field name' },
                        },
                        {
                            name: 'value',
                            type: 'text',
                            required: true,
                            admin: { description: 'Static value' },
                        },
                    ],
                },
                {
                    name: 'referenceMappings',
                    type: 'array',
                    admin: { description: 'Map values from earlier requests (by Reference Key) into ERPNext fields' },
                    fields: [
                        {
                            name: 'referenceKey',
                            type: 'text',
                            required: true,
                            admin: { description: 'Reference key of an earlier request' },
                        },
                        {
                            name: 'referencePath',
                            type: 'text',
                            defaultValue: 'name',
                            admin: { description: 'Path within the stored result (e.g. name, data.name)' },
                        },
                        {
                            name: 'erpFieldName',
                            type: 'text',
                            required: true,
                            admin: { description: 'ERPNext field name to receive the value' },
                        },
                    ],
                },
                {
                    name: 'filters',
                    type: 'array',
                    admin: { description: 'For get/update: filters used to find the ERPNext document. Mapped like field mappings.' },
                    fields: [
                        {
                            name: 'formFieldName',
                            type: 'text',
                            admin: { description: 'Payload form field name (leave blank to use static value)' },
                        },
                        {
                            name: 'staticValue',
                            type: 'text',
                            admin: { description: 'Static filter value' },
                        },
                        {
                            name: 'erpFieldName',
                            type: 'text',
                            required: true,
                            admin: { description: 'ERPNext filter field' },
                        },
                        {
                            name: 'operator',
                            type: 'select',
                            defaultValue: '=',
                            options: [
                                { label: 'Equals', value: '=' },
                                { label: 'Like', value: 'like' },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
    timestamps: true,
}
