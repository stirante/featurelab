// docsUrl.test.ts -- the product -> documentation deep link, from both ends.
//
// The helper is small because the site's route contract does the work (docs/site/authoring.md,
// "The route contract"): a page's route IS its type id and a field's anchor IS its JSON path. The
// risk is therefore not in the code, it is in the CONTRACT drifting -- a base URL changed in the
// VitePress config, or an anchor rule changed in the generator -- while this file keeps happily
// building URLs nobody has clicked. So two of the suites below do not test the helper against
// hand-written expectations at all: they test it against the site's own committed files.
//
//   - the base URL is asserted against docs/site/.vitepress/config.mts (its `base` and the
//     sitemap hostname it advertises), because guessing it is exactly how a whole product's
//     worth of links 404s at once;
//   - every anchor is asserted against docs/site/generated/fields/*.json, which the generator
//     writes from the same catalogue the editor renders, so a change to the anchor rule breaks
//     here rather than in a reader's browser.
//
// docs/site/tools/check-product-links.mjs is the third guard and runs in the docs workflow; it
// cannot see a URL this module builds at runtime, which is what these two suites are for.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOCS_ORIGIN, docsAnchor, docsRoute, docsUrl } from '../src/graph/docs/url.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const siteDir = path.join(repoRoot, 'docs', 'site')

describe('the page a type id resolves to', () => {
  it('is the type id minus its namespace, under /features/', () => {
    expect(docsRoute('minecraft:ore_feature')).toBe('features/ore_feature')
    expect(docsUrl('minecraft:ore_feature')).toBe('https://stirante.github.io/featurelab/features/ore_feature')
  })

  it('keeps an id that carries no "_feature" suffix exactly as it is', () => {
    // The page is /features/conditional_list, not /features/conditional_list_feature: the route
    // is the id, and inventing a suffix the id does not have is the mistake the contract exists
    // to make impossible.
    expect(docsUrl('minecraft:conditional_list')).toBe('https://stirante.github.io/featurelab/features/conditional_list')
    expect(docsUrl('minecraft:scan_surface')).toBe('https://stirante.github.io/featurelab/features/scan_surface')
  })

  it('sends the one alias to the page that documents both spellings', () => {
    expect(docsUrl('minecraft:feature_rule')).toBe(docsUrl('minecraft:feature_rules'))
    expect(docsRoute('minecraft:feature_rule')).toBe('features/feature_rules')
  })

  it('leaves an id with no namespace alone rather than mangling it', () => {
    expect(docsRoute('scatter_feature')).toBe('features/scatter_feature')
  })
})

describe('the anchor a field path resolves to', () => {
  const scatter = 'minecraft:scatter_feature'

  it('is the path with every character outside [A-Za-z0-9_-] hyphenated', () => {
    expect(docsAnchor(scatter, 'distribution.scatter_chance')).toBe('distribution-scatter_chance')
    expect(docsUrl(scatter, 'distribution.scatter_chance')).toBe(
      'https://stirante.github.io/featurelab/features/scatter_feature#distribution-scatter_chance',
    )
  })

  it('handles a nested path the same way, one hyphen per level', () => {
    expect(docsAnchor(scatter, 'distribution.x.extent')).toBe('distribution-x-extent')
    expect(docsUrl(scatter, 'distribution.x.step_size')).toBe(
      'https://stirante.github.io/featurelab/features/scatter_feature#distribution-x-step_size',
    )
  })

  it('accepts the full JSON path a diagnostic carries, root key and all', () => {
    expect(docsUrl(scatter, '$.minecraft:scatter_feature.distribution.x.extent')).toBe(
      'https://stirante.github.io/featurelab/features/scatter_feature#distribution-x-extent',
    )
    // A rule's body key is the plural, while the editor calls the node the singular. Both forms
    // of the leading segment are stripped, so neither leaks into the anchor.
    expect(docsUrl('minecraft:feature_rule', '$.minecraft:feature_rules.description.places_feature')).toBe(
      'https://stirante.github.io/featurelab/features/feature_rules#description-places_feature',
    )
  })

  it('only treats the LEADING segment as the type, so a namespaced key keeps its own colon', () => {
    // conditions.minecraft:biome_filter is a real key, and its heading id hyphenates the colon
    // like any other character outside the set. Stripping "minecraft:" wherever it appeared
    // would have produced conditions-biome_filter, which is not an anchor on any page.
    expect(docsAnchor('minecraft:feature_rules', 'conditions.minecraft:biome_filter')).toBe('conditions-minecraft-biome_filter')
  })

  it('drops array subscripts, because the reference documents the array field, not its elements', () => {
    expect(docsAnchor(scatter, 'distribution.x.extent[0]')).toBe('distribution-x-extent')
    expect(docsAnchor('minecraft:tree_feature', 'trunk.trunk_block.replace_rules[2].may_replace')).toBe('trunk-trunk_block-replace_rules-may_replace')
  })

  it('gives the bare page for an empty path, or one that names only the type itself', () => {
    expect(docsUrl(scatter)).toBe('https://stirante.github.io/featurelab/features/scatter_feature')
    expect(docsUrl(scatter, '')).toBe('https://stirante.github.io/featurelab/features/scatter_feature')
    expect(docsUrl(scatter, '$')).toBe('https://stirante.github.io/featurelab/features/scatter_feature')
    expect(docsUrl(scatter, '$.minecraft:scatter_feature')).toBe('https://stirante.github.io/featurelab/features/scatter_feature')
  })
})

describe('the contract with the site, read from the site', () => {
  it('builds the base URL the VitePress config publishes under', () => {
    const config = fs.readFileSync(path.join(siteDir, '.vitepress', 'config.mts'), 'utf-8')
    const base = /DOCS_BASE \?\? '([^']+)'/.exec(config)?.[1]
    const hostname = /sitemap: \{ hostname: '([^']+)'/.exec(config)?.[1]
    expect(base, 'the config no longer declares a default base the way this test reads it').toBeTypeOf('string')
    expect(hostname, 'the config no longer declares a sitemap hostname the way this test reads it').toBeTypeOf('string')
    expect(DOCS_ORIGIN).toBe(`${hostname}${base}`)
  })

  it('reproduces every anchor the generated field reference actually wrote', () => {
    const dir = path.join(siteDir, 'generated', 'fields')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
    expect(files.length).toBeGreaterThan(20)
    let checked = 0
    for (const file of files) {
      const { typeId, slug, anchors } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as {
        typeId: string
        slug: string
        anchors: { path: string; anchor: string }[]
      }
      expect(docsRoute(typeId), `${typeId} does not route to the page the generator wrote`).toBe(`features/${slug}`)
      for (const { path: fieldPath, anchor } of anchors) {
        expect(docsAnchor(typeId, fieldPath), `${typeId} ${fieldPath}`).toBe(anchor)
        expect(docsUrl(typeId, `$.${typeId}.${fieldPath}`), `${typeId} ${fieldPath}, as a full JSON path`).toBe(
          `${DOCS_ORIGIN}features/${slug}#${anchor}`,
        )
        checked++
      }
    }
    expect(checked).toBeGreaterThan(400)
  })
})
