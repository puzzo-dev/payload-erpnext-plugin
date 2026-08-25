import type { Field } from 'payload'

/**
 * Reusable organization relationship field.
 *
 * CANONICAL SOURCE: `payload-cms/src/fields/organizationField.ts`. This plugin
 * is a separately published package and cannot import from the CMS, so the
 * field is mirrored here. When the field changes, update the CMS first, then
 * mirror it here and in `payload-meta-plugin/src/fields/organizationField.ts`.
 */
export const organizationField = (overrides?: Partial<Field>): Field => ({
    name: 'organization',
    type: 'relationship',
    relationTo: 'organizations',
    required: true,
    admin: {
        description: 'The organization this belongs to',
    },
    ...overrides,
} as Field)
