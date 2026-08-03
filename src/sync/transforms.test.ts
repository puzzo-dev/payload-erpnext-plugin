import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { slugify, stripHtml, getUpsertKeyMapping, erpFetchFields, describeRelationship, chooseMatchField, type ERPNextSyncRule } from './transforms'

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

describe('describeRelationship', () => {
    // Mirrors payload-cms: catalogue-items.category is a required relationship to
    // catalogue-categories, which is exactly what `link` reads instead of asking.
    const catalogueItemFields = [
        { name: 'title', type: 'text' },
        { name: 'category', type: 'relationship', relationTo: 'catalogue-categories', required: true },
        { type: 'row', fields: [{ name: 'price', type: 'number' }] },
    ]

    it('derives the collection from relationTo', () => {
        assert.deepEqual(
            describeRelationship(catalogueItemFields, 'category', 'catalogue-items'),
            { collection: 'catalogue-categories', hasMany: false },
        )
    })

    it('finds a relationship nested inside a presentational row', () => {
        const fields = [{ type: 'row', fields: [{ name: 'brand', type: 'relationship', relationTo: 'brands' }] }]
        assert.deepEqual(describeRelationship(fields, 'brand', 'x'), { collection: 'brands', hasMany: false })
    })

    it('reports hasMany so the caller writes an array', () => {
        const fields = [{ name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true }]
        assert.deepEqual(describeRelationship(fields, 'tags', 'x'), { collection: 'tags', hasMany: true })
    })

    it('refuses a non-relationship field instead of guessing', () => {
        const result = describeRelationship(catalogueItemFields, 'title', 'catalogue-items')
        assert.ok('reason' in result && result.reason.includes('not a relationship'))
    })

    it('refuses a polymorphic relationship, which has no single target', () => {
        const fields = [{ name: 'owner', type: 'relationship', relationTo: ['users', 'teams'] }]
        const result = describeRelationship(fields, 'owner', 'x')
        assert.ok('reason' in result && result.reason.includes('polymorphic'))
    })

    it('reports an unknown field rather than resolving nothing', () => {
        const result = describeRelationship(catalogueItemFields, 'nope', 'catalogue-items')
        assert.ok('reason' in result && result.reason.includes('not a field'))
    })
})

describe('chooseMatchField', () => {
    const categoryFields = [
        { name: 'name', type: 'text' },
        { name: 'slug', type: 'text' },
        { name: 'parent', type: 'relationship', relationTo: 'catalogue-categories' },
        { name: 'sort_order', type: 'number' },
    ]

    it('uses useAsTitle when no override is given', () => {
        assert.deepEqual(chooseMatchField(categoryFields, 'name', null, 'catalogue-categories'), { field: 'name' })
    })

    it('lets an explicit override win over useAsTitle', () => {
        assert.deepEqual(chooseMatchField(categoryFields, 'name', 'slug', 'catalogue-categories'), { field: 'slug' })
    })

    // The exact production failure: matching against `parent` coerced "Cocktails" to
    // NaN and Postgres rejected the query for all 17 records.
    it('refuses a relationship field', () => {
        const result = chooseMatchField(categoryFields, 'name', 'parent', 'catalogue-categories')
        assert.ok('reason' in result && result.reason.includes('cannot hold an ERPNext display name'))
    })

    it('refuses id, which is what useAsTitle silently defaults to', () => {
        const result = chooseMatchField(categoryFields, 'id', null, 'catalogue-categories')
        assert.ok('reason' in result && result.reason.includes('cannot hold an ERPNext display name'))
    })

    it('refuses a numeric field', () => {
        const result = chooseMatchField(categoryFields, 'name', 'sort_order', 'catalogue-categories')
        assert.ok('reason' in result && result.reason.includes('cannot hold an ERPNext display name'))
    })

    it('asks for an override when the collection sets no useAsTitle', () => {
        const result = chooseMatchField(categoryFields, undefined, null, 'catalogue-categories')
        assert.ok('reason' in result && result.reason.includes('no admin.useAsTitle'))
    })
})

describe('stripHtml', () => {
    // The literal value that appeared on the live menu, tags and all.
    it('flattens the HTML ERPNext actually sends', () => {
        assert.equal(
            stripHtml('<div><p>A timeless classic elevated with hand-muddled fresh strawberries.</p></div>'),
            'A timeless classic elevated with hand-muddled fresh strawberries.',
        )
    })

    it('does not weld sentences together across block boundaries', () => {
        assert.equal(stripHtml('<p>One.</p><p>Two.</p>'), 'One. Two.')
    })

    it('treats <br> as a word gap', () => {
        assert.equal(stripHtml('<p>A<br>B</p>'), 'A B')
    })

    it('decodes named and numeric entities', () => {
        assert.equal(stripHtml('<p>Gin &amp; Tonic&nbsp;&mdash; 5&#39;s</p>'), "Gin & Tonic — 5's")
        assert.equal(stripHtml('<p>&#8212; and &#x2014;</p>'), '— and —')
    })

    it('decodes &amp; last, so double-escaped markup stays visible text', () => {
        assert.equal(stripHtml('&amp;lt;not markup&amp;gt;'), '&lt;not markup&gt;')
    })

    it('drops script bodies rather than inlining their source', () => {
        assert.equal(stripHtml('<p>hi</p><script>alert(1)</script>'), 'hi')
    })

    it('is idempotent — already-plain text is unchanged', () => {
        assert.equal(stripHtml('Just prose.'), 'Just prose.')
    })

    it('handles an empty value', () => {
        assert.equal(stripHtml(''), '')
    })
})
