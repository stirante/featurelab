// featureReferences.test.ts -- covers the position -> is-this-a-feature-reference decision in
// src/featureReferences.ts. The key set and array shapes asserted here are the ones verified
// against featurelab's own loaders (see that file's header for the file-by-file derivation);
// the negative cases pin what must NOT light up as a link: property keys, the declaration
// itself, weights in weighted_random tuples, and identifier-shaped strings in JSON that isn't a
// feature/rule document at all.
import { describe, expect, it } from 'vitest'
import { featureReferenceAt, findIdentifierDeclaration } from '../src/featureReferences.js'

/** Offset INSIDE the first occurrence of `needle`'s content in `text` -- pointing a few chars
 * into the string literal, the way a real cursor sits mid-identifier on a ctrl+hover. */
function offsetIn(text: string, needle: string): number {
  const i = text.indexOf(needle)
  if (i === -1) throw new Error(`fixture does not contain ${needle}`)
  return i + Math.min(3, needle.length - 1)
}

const SCATTER = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:scatter_feature': {
    description: { identifier: 'wiki:pumpkin_patch' },
    places_feature: 'wiki:pumpkin_single',
    iterations: 4,
  },
})

const RULE = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:feature_rules': {
    description: { identifier: 'wiki:pumpkin_rule', places_feature: 'wiki:pumpkin_patch' },
  },
})

const AGGREGATE = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:aggregate_feature': {
    description: { identifier: 'wiki:oasis' },
    features: ['wiki:poplar_tree', 'wiki:pond'],
  },
})

const WEIGHTED = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:weighted_random_feature': {
    description: { identifier: 'wiki:tree_pick' },
    features: [
      ['wiki:oak_variant', 3],
      ['wiki:birch_variant', 1],
    ],
  },
})

const CONDITIONAL = JSON.stringify({
  format_version: '1.21.110',
  'minecraft:conditional_list': {
    description: { identifier: 'wiki:pick_one' },
    conditional_features: [{ places_feature: 'wiki:snow_layer', condition: '1' }],
    early_out_scheme: 'placement_success',
  },
})

describe('featureReferenceAt: positions that ARE references', () => {
  it.each([
    ['places_feature (scatter)', SCATTER, 'wiki:pumpkin_single'],
    ['description.places_feature (feature_rules)', RULE, 'wiki:pumpkin_patch'],
    ['conditional_features[i].places_feature', CONDITIONAL, 'wiki:snow_layer'],
    ['features[i] string element (aggregate/sequence)', AGGREGATE, 'wiki:pond'],
    ['features[i][0] tuple element (weighted_random)', WEIGHTED, 'wiki:birch_variant'],
  ])('%s', (_label, text, identifier) => {
    const hit = featureReferenceAt(text, offsetIn(text, identifier))
    expect(hit?.identifier).toBe(identifier)
    // The origin span is the string content exactly -- what the editor underlines.
    expect(text.slice(hit!.start, hit!.start + hit!.length)).toBe(identifier)
  })

  it.each([
    ['feature_to_snap (snap_to_surface)', 'minecraft:snap_to_surface_feature', 'feature_to_snap'],
    ['feature_to_place (surface_relative_threshold)', 'minecraft:surface_relative_threshold_feature', 'feature_to_place'],
    ['vegetation_feature (vegetation_patch)', 'minecraft:vegetation_patch_feature', 'vegetation_feature'],
    // scan_surface's REAL registered type id has no _feature suffix (scan_surface.go) -- these
    // two double as regression coverage for the document gate accepting it.
    ['feature (scan_surface alias)', 'minecraft:scan_surface', 'feature'],
    ['feature_to_scan (scan_surface alias)', 'minecraft:scan_surface', 'feature_to_scan'],
  ])('%s', (_label, typeKey, refKey) => {
    const text = JSON.stringify({
      format_version: '1.21.110',
      [typeKey]: { description: { identifier: 'wiki:wrapper' }, [refKey]: 'wiki:target' },
    })
    expect(featureReferenceAt(text, offsetIn(text, 'wiki:target'))?.identifier).toBe('wiki:target')
  })
})

describe('featureReferenceAt: positions that are NOT references', () => {
  it('the feature’s own declaration (description.identifier) is not a reference', () => {
    expect(featureReferenceAt(SCATTER, offsetIn(SCATTER, 'wiki:pumpkin_patch'))).toBeNull()
  })

  it('a property KEY is not a reference even when it is a reference key name', () => {
    const keyOffset = SCATTER.indexOf('places_feature') + 3
    expect(featureReferenceAt(SCATTER, keyOffset)).toBeNull()
  })

  it('a quoted WEIGHT in a weighted_random tuple is not a reference', () => {
    // A pack author quoting the weight: only element 0 of the tuple is the feature reference.
    const text = JSON.stringify({
      format_version: '1.21.110',
      'minecraft:weighted_random_feature': {
        description: { identifier: 'wiki:pick' },
        features: [['wiki:oak', '3']],
      },
    })
    const weightOffset = text.lastIndexOf('"3"') + 1
    expect(featureReferenceAt(text, weightOffset)).toBeNull()
  })

  it('a string under an unrelated key is not a reference', () => {
    const text = JSON.stringify({
      format_version: '1.21.110',
      'minecraft:single_block_feature': { description: { identifier: 'wiki:one' }, places_block: 'minecraft:stone' },
    })
    expect(featureReferenceAt(text, offsetIn(text, 'minecraft:stone'))).toBeNull()
  })

  it('reference-shaped keys in a NON-feature document (e.g. package.json-like) never match', () => {
    // "features" arrays and "feature" keys legally occur in arbitrary JSON; only a document
    // whose top-level type key is *_feature / feature_rules is in scope.
    const text = JSON.stringify({ name: 'x', features: ['not:a_feature'], feature: 'also:not' })
    expect(featureReferenceAt(text, offsetIn(text, 'not:a_feature'))).toBeNull()
    expect(featureReferenceAt(text, offsetIn(text, 'also:not'))).toBeNull()
  })

  it('tolerates comments and trailing commas (jsonc) around a real reference', () => {
    const text = `{
  "format_version": "1.21.110",
  // a comment
  "minecraft:scatter_feature": {
    "description": { "identifier": "wiki:patch" },
    "places_feature": "wiki:single",
  },
}`
    expect(featureReferenceAt(text, offsetIn(text, 'wiki:single'))?.identifier).toBe('wiki:single')
  })
})

describe('findIdentifierDeclaration', () => {
  it('locates the identifier value span in a declaring file', () => {
    const span = findIdentifierDeclaration(SCATTER, 'wiki:pumpkin_patch')
    expect(span).not.toBeNull()
    expect(SCATTER.slice(span!.start, span!.start + span!.length)).toBe('wiki:pumpkin_patch')
  })

  it('does not match a file that merely REFERENCES the identifier', () => {
    // RULE references wiki:pumpkin_patch via places_feature but declares a different id.
    expect(findIdentifierDeclaration(RULE, 'wiki:pumpkin_patch')).toBeNull()
  })

  it('is not fooled by the identifier appearing elsewhere in the same file (self-reference)', () => {
    const text = JSON.stringify({
      format_version: '1.21.110',
      'minecraft:scatter_feature': {
        places_feature: 'wiki:recursive', // appears BEFORE the declaration in the file
        description: { identifier: 'wiki:recursive' },
      },
    })
    const span = findIdentifierDeclaration(text, 'wiki:recursive')!
    // Must be the description.identifier occurrence (the LAST one here), not the reference.
    expect(span.start).toBeGreaterThan(text.indexOf('wiki:recursive'))
    expect(text.slice(span.start, span.start + span.length)).toBe('wiki:recursive')
  })
})
