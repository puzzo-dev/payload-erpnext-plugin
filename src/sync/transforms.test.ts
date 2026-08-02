import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { slugify, getUpsertKeyMapping, erpFetchFields, type ERPNextSyncRule } from './transforms'

describe('slugify', () => {
    it('lowercases and hyphenates a display name', () => {
        assert.equal(slugify('Exotic Signature Mixes'), 'exotic-signature-mixes')
    })

    it('strips diacritics rather than replacing them with hyphens', () => {
        assert.equal(slugify('Café Crème'), 'cafe-creme')
    })

    it('collapses runs of punctuation and whitespace into a single hyphen', () => {
        assert.equal(slugify('Gin & Tonic  --  Classic'), 'gin-tonic-classic')
    })

    it('trims leading and trailing separators', () => {
        assert.equal(slugify('  ...Mocktails!  '), 'mocktails')
    })

    it('is idempotent — re-slugifying an existing slug is a no-op', () => {
        assert.equal(slugify(slugify('Exotic Signature Mixes')), 'exotic-signature-mixes')
    })
})

describe('getUpsertKeyMapping', () => {
    const baseRule = (mappings: ERPNextSyncRule['field_mappings']): ERPNextSyncRule => ({
        id: 1,
        site: 1,
        doctype: 'Item',
        targetCollection: 'catalogue-items',
        field_mappings: mappings,
    })

    it('returns null when no row is marked as the key', () => {
        assert.equal(getUpsertKeyMapping(baseRule([{ erp_field: 'item_code', payload_field: 'erp_item_code' }])), null)
    })

    it('returns null when the marked row is missing one half of the pair', () => {
        assert.equal(getUpsertKeyMapping(baseRule([{ erp_field: 'item_code', isUpsertKey: true }])), null)
    })

    it('carries the transform through, so matching uses the transformed value', () => {
        const key = getUpsertKeyMapping(baseRule([
            { erp_field: 'item_name', payload_field: 'title' },
            { erp_field: 'name', payload_field: 'slug', isUpsertKey: true, transform: 'slugify' },
        ]))
        assert.deepEqual(key, { erp_field: 'name', payload_field: 'slug', isUpsertKey: true, transform: 'slugify' })
    })
})

describe('erpFetchFields', () => {
    it('collects every mapped ERP field, deduped', () => {
        const rule: ERPNextSyncRule = {
            id: 1,
            site: 1,
            doctype: 'Item',
            targetCollection: 'catalogue-items',
            field_mappings: [
                { erp_field: 'item_name', payload_field: 'title' },
                { erp_field: 'item_group', payload_field: 'category', transform: 'lookup', lookup_collection: 'catalogue-categories', lookup_field: 'name' },
                { erp_field: 'item_name', payload_field: 'description' },
            ],
        }
        assert.deepEqual(erpFetchFields(rule), ['item_name', 'item_group'])
    })
})
