import type { Field } from 'payload'

/**
 * Reusable organization relationship field.
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
