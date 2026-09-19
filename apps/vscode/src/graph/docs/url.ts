// url.ts -- a deep link into the published documentation, built from a type id and a JSON path
// and nothing else.
//
// WHY THERE IS NO LOOKUP TABLE. The site keeps a route contract (docs/site/authoring.md, "The
// route contract") that exists precisely so this file can be twenty lines:
//
//   a page's route IS its type id, minus `minecraft:`      minecraft:ore_feature -> /features/ore_feature
//   a field's anchor IS its JSON path                      distribution.scatter_chance -> #distribution-scatter_chance
//
// with every character outside [A-Za-z0-9_-] replaced by a hyphen. The generated field reference
// writes that anchor as an explicit `{#id}` on each heading, so rewording a heading cannot break
// a link built here, and docs/site/tools/check-product-links.mjs fails the docs build if a type
// id this function could be handed has no page and if a URL the product ships names an anchor no
// page defines. That checker is the other half of this file: without it, this is a guess.
//
// KEPT FREE OF IMPORTS ON PURPOSE. Both sides need it -- the `?` panel, which runs in the
// webview, and the diagnostics projection, which runs in the extension host and can reach
// `vscode` -- so this module depends on neither.

/** Where the site is published. Derived from, and required to agree with, the GitHub Pages
 * deployment in .github/workflows/docs.yml and `base` in docs/site/.vitepress/config.mts: a
 * project site is served under /<repo>/, hence the path segment. Trailing slash included so a
 * route can be appended without a join. */
export const DOCS_ORIGIN = 'https://stirante.github.io/featurelab/'

/** The one type id whose page is named after a different id, spelled out in
 * docs/site/tools/extract-catalog.mjs and check-product-links.mjs as well. A rule file's root key
 * is `minecraft:feature_rules`; the editor calls a single rule `minecraft:feature_rule`, and both
 * are documented on the one page. */
const TYPE_ALIASES: Readonly<Record<string, string>> = { 'minecraft:feature_rule': 'minecraft:feature_rules' }

/** The site route for a type id, with no origin and no leading slash. */
export function docsRoute(typeId: string): string {
  return 'features/' + (TYPE_ALIASES[typeId] ?? typeId).replace(/^minecraft:/, '')
}

/** The anchor a field's heading carries on its type's page, or '' for a path that names no field.
 *
 * `jsonPath` may be given in any of the spellings the product already has:
 *
 *   distribution.scatter_chance                                 the inspector's relative path
 *   $.minecraft:scatter_feature.distribution.scatter_chance     a diagnostic's full path
 *   distribution.x.extent[0]                                    either, with an array index
 *
 * The leading `$.` and the root-key segment are stripped (the anchors are relative to the type's
 * body, because the page is already the type), array subscripts are dropped (the generated
 * reference documents the array field, not its anonymous elements), and what is left goes through
 * the anchor rule. Note that only the LEADING `minecraft:` is special: a key like
 * `conditions.minecraft:biome_filter` keeps its own, and hyphenates to
 * `conditions-minecraft-biome_filter` exactly as the generated heading does. */
export function docsAnchor(typeId: string, jsonPath: string): string {
  let path = jsonPath.trim().replace(/^\$\.?/, '')
  const root = TYPE_ALIASES[typeId] ?? typeId
  for (const head of [root, typeId]) {
    if (path === head) return ''
    if (path.startsWith(head + '.')) {
      path = path.slice(head.length + 1)
      break
    }
  }
  return path
    .replace(/\[\d+\]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The published page for `typeId`, and -- given a JSON path -- the field's own heading on it.
 *
 * ```
 * docsUrl('minecraft:ore_feature')
 *   -> https://stirante.github.io/featurelab/features/ore_feature
 * docsUrl('minecraft:scatter_feature', '$.minecraft:scatter_feature.distribution.x.extent')
 *   -> https://stirante.github.io/featurelab/features/scatter_feature#distribution-x-extent
 * ```
 */
export function docsUrl(typeId: string, jsonPath?: string): string {
  const url = DOCS_ORIGIN + docsRoute(typeId)
  if (jsonPath === undefined || jsonPath.length === 0) return url
  const anchor = docsAnchor(typeId, jsonPath)
  return anchor === '' ? url : `${url}#${anchor}`
}
