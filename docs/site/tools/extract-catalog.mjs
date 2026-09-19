#!/usr/bin/env node
// extract-catalog.mjs -- generates the site's per-type "Field reference" sections from the VS
// Code extension's own catalogue modules, so the site never carries a third hand-written copy of
// what each key is.
//
// THE SOURCE OF TRUTH IS THE EXTENSION'S CATALOGUE, NOT THIS SCRIPT AND NOT THE PAGES.
//
//   apps/vscode/src/graph/typeCatalog.ts   -- the schema facts: which keys exist, at which
//                                             format_version bands, required or optional, bounds,
//                                             the absent-key default, enum values in engine order.
//                                             Pinned to the Go builders by
//                                             apps/vscode/test/catalogueAgainstEngine.test.ts.
//   apps/vscode/src/graph/docs/catalog.ts  -- the prose: one summary line and a detail paragraph
//                                             per key and per enum value, the text the editor's
//                                             hover card shows. Pinned for completeness by
//                                             docsCatalog.test.ts and for language (no engine
//                                             internals, nothing outside what ships) by
//                                             docsLanguage.test.ts.
//
// Those two files are already data -- plain object literals with no side effects and no VS Code
// import -- and they are already tested against the engine. Moving them into YAML for the site's
// benefit would move them away from the tests that keep them honest. So this script goes the
// other way: it bundles the two modules with esbuild, imports the bundle, walks every catalogued
// type through the SAME lookup functions the editor's hover uses (lookupFieldDoc /
// lookupValueDoc), and writes one markdown fragment per type under generated/fields/. A page
// includes its fragment with VitePress's `<!--@include: ../generated/fields/<type>.md-->`.
//
// What a page keeps for itself: everything that is NOT "what is this key" -- the worked example,
// the measured tables, the reproduction commands, the common-mistakes block, the version notes.
// The hover card is terse and contextual by design; the page is long-form by design; the field
// reference is the one block they genuinely share, and after this script it is shared rather
// than duplicated.
//
// ANCHORS ARE PART OF THE CONTRACT. Every field heading gets an explicit id: the field's JSON
// path from the type body, with `.` replaced by `-` (`distribution-scatter_chance`,
// `conditions-placement_pass`). A diagnostic or the editor's `?` pane can therefore build a
// deep link from a type id and a JSON path alone, with no lookup table:
//
//   /features/<typeId minus "minecraft:">/#<path with . -> ->
//
// generated/fields/<type>.json lists the anchors each fragment defines, which is what
// check-product-links.mjs verifies a product-side link against.
//
// Usage (from anywhere; paths resolve from this file):
//   node docs/site/tools/extract-catalog.mjs
//
// Requirements: `npm install` under docs/site (esbuild). No Go toolchain, no VS Code.
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(toolsDir, '..')
const repoRoot = path.resolve(siteDir, '..', '..')
const graphDir = path.join(repoRoot, 'apps', 'vscode', 'src', 'graph')
const outDir = path.join(siteDir, 'generated', 'fields')
const cacheDir = path.join(siteDir, '.cache')

/** The synthetic node type the graph gives a rule, and the JSON root key a rule file actually
 * has. The catalogue models the former; the site's URL scheme is keyed by the latter, because the
 * root key is what an author sees in the file and what a diagnostic's JSONPath starts with. This
 * is the ONE alias in the URL scheme, and it is written here and in check-product-links.mjs. */
const TYPE_ALIASES = { 'minecraft:feature_rule': 'minecraft:feature_rules' }

async function loadCatalogue() {
  // One entry module re-exporting exactly what this script needs from the two catalogue files.
  // Bundled rather than imported directly because the sources are TypeScript with `.js`-suffixed
  // relative imports (the extension's own convention), which Node will not load unaided.
  const entry = [
    `export { typeSpec, catalogedTypeIds } from ${JSON.stringify(path.join(graphDir, 'typeCatalog.ts'))}`,
    `export { lookupFieldDoc, lookupValueDoc } from ${JSON.stringify(path.join(graphDir, 'docs', 'catalog.ts'))}`,
  ].join('\n')
  fs.mkdirSync(cacheDir, { recursive: true })
  const bundlePath = path.join(cacheDir, 'catalog.bundle.mjs')
  await esbuild.build({
    stdin: { contents: entry, resolveDir: graphDir, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundlePath,
    logLevel: 'silent',
  })
  return import(pathToFileURL(bundlePath).href + `?t=${Date.now()}`)
}

const slugOf = (typeId) => (TYPE_ALIASES[typeId] ?? typeId).replace(/^minecraft:/, '')

/** THE ONE PART OF THE FIELD REFERENCE THAT IS NOT IN THE CATALOGUE. The editor draws a
 * delegation -- `places_feature`, and scatter's `iterations`, which rides on the same
 * connection -- as an edge on the canvas, not as a form field, so typeCatalog.ts deliberately
 * leaves those keys out (its DELEGATION_KEYS set exists only to reject a stray one). A page's
 * field reference has to list them: they are the keys an author writes first. Until the
 * catalogue grows a way to describe an edge-carried key (authoring.md lists that as the product-side
 * follow-up), the entries live here, one type at a time, added as each page migrates and
 * verified against the type's builder the way the page's own claims are. A type with no entry
 * here gets its field reference without them, and the page's author is expected to notice. */
const EDGE_KEYS = {
  'minecraft:scatter_feature': [
    {
      path: 'places_feature',
      facts: ['required', 'feature identifier', 'edited on the connection, not in the form'],
      summary: 'The feature placed at every offset the distribution produces.',
      detail: 'A `namespace:id` that some file in the pack defines. Unresolved -- no loaded file defines it -- and the whole call fails before any random draw; `featurelab check` reports that as an error, with a near-match suggestion, without running anything.',
    },
    {
      path: 'distribution.iterations',
      facts: ['required', 'number or Molang string', 'a negative constant is reported and becomes 1', 'edited on the connection, not in the form'],
      summary: 'How many rounds to run -- offsets to sample and hand to `places_feature`.',
      detail: 'Evaluated once, before any axis, so a Molang expression here reads whatever `variable.world*` an enclosing feature left; use `variable.origin*` for this scatter\'s own origin. Every round runs whether or not earlier rounds succeeded. Zero rounds is the one honest way to switch a scatter off.',
    },
  ],
  'minecraft:tree_feature': [
    {
      path: 'fallen_trunk.log_decoration_feature',
      facts: ['optional', 'feature identifier', 'absent: nothing is run over the logs', 'edited on the connection, not in the form'],
      summary: 'A feature run once at every log of the fallen log itself.',
      detail: 'Placed at the log\'s own position, immediately after the log is written, and never at the stump. Unlike the delegation every Proxy feature does, this one is not subject to the internal-feature permission check -- a fallen trunk runs it whenever the reference resolves. An unresolved reference is not an error: nothing is run and the log is laid bare.',
    },
    {
      path: 'poplar_trunk.log_decoration_feature',
      facts: ['optional', 'feature identifier', 'absent: nothing is run over the column', 'edited on the connection, not in the form'],
      summary: 'A feature run once at every cell of the poplar\'s own column.',
      detail: 'Every cell the column walks, including a cell whose own log was refused by `may_replace` -- so the count of runs follows the sampled height, not the number of logs that actually went down. An unresolved reference is not an error: nothing is run.',
    },
  ],
  'minecraft:aggregate_feature': [
    {
      path: 'features',
      facts: ['required', 'array of feature identifiers, at least one', 'edited on the connections, not in the form'],
      summary: 'The features this aggregate runs, in order, every call.',
      detail: 'Each one is placed at the aggregate\'s OWN origin -- the same, unmodified position for every entry -- so two entries that do not offset themselves internally contend for the same cell, and the later one wins it. An entry no loaded file defines is skipped and the walk carries on to the next; an empty array is refused when the file loads rather than at placement.',
    },
  ],
  'minecraft:sequence_feature': [
    {
      path: 'features',
      facts: ['required', 'array of feature identifiers, at least one', 'edited on the connections, not in the form'],
      summary: 'The features this sequence runs, in order, each one starting where the last one finished.',
      detail: 'The first entry runs at the sequence\'s own origin. Every entry after a success runs at the position the previous successful entry RETURNED, which for a snap-to-surface or a scatter is not the position it was asked to start from. Until something succeeds -- and again after an entry is refused outright -- the original origin is used. Because a sequence always stops while nothing has succeeded yet, an entry no loaded file defines ends the list there instead of being skipped.',
    },
  ],
  'minecraft:weighted_random_feature': [
    {
      path: 'features',
      facts: ['required', 'array of [feature, weight] entries', 'at least one entry', 'edited on the connections, not in the form'],
      summary: 'The candidates, and the weight each one is picked by.',
      detail: 'Exactly one entry is placed per call, chosen by weight, at this feature\'s own origin unchanged; the entries that were not chosen are not tried, even when the chosen one fails. Each entry is a two-element `[featureReference, weight]` array -- both elements required, the weight a number that is not negative. Weights are compared as whole numbers, cut down at every entry, so `0.5` and `0.5` come to nothing at all and `1.6` and `1.6` come to the same thing as `1` and `1`. An entry weighted `0` can never be picked. An empty array is refused when the file loads (the schema wants at least one entry), as is a negative weight.',
    },
  ],
  'minecraft:conditional_list': [
    {
      path: 'conditional_features',
      facts: ['required', 'array of {places_feature, condition} entries', 'edited on the connections, not in the form'],
      summary: 'The entries, walked in the order they are written.',
      detail: 'How far the walk goes is `early_out_scheme`\'s decision, and under the default `none` it goes all the way: every entry whose condition holds places, at this feature\'s own origin unchanged. An entry whose reference does not resolve -- or that the internal-feature check refuses -- ends the whole walk there, and whatever earlier entries already placed stays placed.',
    },
    {
      path: 'conditional_features.places_feature',
      facts: ['required', 'feature identifier', 'drawn as the connection from the entry'],
      summary: 'The feature this entry places when its condition holds.',
      detail: 'Unresolved -- no loaded file defines it -- and the game reports `Feature not found!` and ends the list at that entry rather than skipping it. `featurelab check` reports the same reference as an error, with a near-match suggestion, without running anything.',
    },
    {
      path: 'conditional_features.condition',
      facts: ['optional', 'number, boolean or Molang string', 'absent: always true', 'written on the connection, not in the form'],
      summary: 'What decides whether this entry places.',
      detail: 'Evaluated in the `world_gen` Molang namespace against the scope the chain shares, with `variable.originx`/`originy`/`originz` and `variable.worldx`/`worldy`/`worldz` holding this feature\'s own origin. Anything other than exactly zero counts as true. A plain number or boolean in the JSON is a constant, not an expression. Leaving the key out is not the same edit as writing `1`: it is the shape a file takes when the entry is meant to be unconditional.',
    },
  ],
  'minecraft:search_feature': [
    {
      path: 'places_feature',
      facts: ['required', 'feature identifier', 'edited on the connection, not in the form'],
      summary: 'The feature tried at every position in the search volume.',
      detail: 'A `namespace:id` that some file in the pack defines. Unresolved, the search fails before it visits a single position, and it says the same thing a search that ran out of positions says. Every attempt this feature makes is held back rather than written, so a delegate that succeeded at one position and was then thrown away when the search ran out leaves nothing behind at all.',
    },
  ],
  'minecraft:snap_to_surface_feature': [
    {
      path: 'feature_to_snap',
      facts: ['required', 'feature identifier', 'edited on the connection, not in the form'],
      summary: 'The feature placed at the surface the scan found.',
      detail: 'A `namespace:id` that some file in the pack defines. It is placed at the snapped position, not at this feature\'s own origin, and the name is looked up only once a surface has been found -- so a file naming a feature nothing defines reports that on the runs where the scan worked, and reports the scan\'s own failure on the runs where it did not.',
    },
  ],
  'minecraft:vegetation_patch_feature': [
    {
      path: 'vegetation_feature',
      facts: ['required', 'feature identifier', 'edited on the connection, not in the form'],
      summary: 'The feature grown on every column the patch keeps.',
      detail: 'A `namespace:id` that some file in the pack defines. It is placed in the open cell next to the ground the patch just laid -- above it for `floor`, below it for `ceiling` -- never at this feature\'s own origin, and it runs its own attachment checks there like any other delegate. The reference is resolved once, after the ground layer has already been written, so a file naming a feature nothing defines still lays its whole patch of `ground_block` and simply grows nothing on it; `featurelab check` reports the reference itself, with a near-match suggestion, without running anything. The internal-feature check is different again: when it refuses, the ground layer has been written and the call reports failure anyway.',
    },
  ],
  'minecraft:scan_surface': [
    {
      path: 'places_feature',
      facts: ['required', 'feature identifier', 'the field name itself is not confirmed', 'edited on the connection, not in the form'],
      summary: 'The feature run once at the surface of every column of the chunk.',
      detail: 'A `namespace:id` that some file in the pack defines. It is the only field this type has: the area is always one whole 16x16 chunk, every column in it is always attempted, and nothing can narrow that from here -- a delegate that refuses is how a cover is narrowed. Unresolved, the whole call fails before a single column is visited. The KEY NAME is the one uncertain thing about this type: `places_feature` is used because that is what a scatter calls the field of the identical purpose, and this tool additionally accepts `feature` and `feature_to_scan` defensively, where the game accepts exactly one of the three.',
    },
  ],
  'minecraft:surface_relative_threshold_feature': [
    {
      path: 'feature_to_place',
      facts: ['required', 'feature identifier', 'edited on the connection, not in the form'],
      summary: 'The feature placed when the position is deep enough below the surface.',
      detail: 'A `namespace:id` that some file in the pack defines, placed at this feature\'s own position, unchanged. Note the spelling: it is NOT `places_feature`, the name every other gate uses, and `feature`, `wrapped_feature` and `min_distance_below_surface` are not aliases either -- a file using one of them does not load in the game, and this tool refuses it with an error naming the real key. The reference is resolved only AFTER the depth test has passed, and an unresolved one is reported with the depth test\'s own message rather than a message of its own.',
    },
  ],
  'minecraft:height_difference_filter_feature': [
    {
      path: 'places_feature',
      facts: ['required', 'feature identifier', 'edited on the connection, not in the form'],
      summary: 'The feature placed when the terrain around the position has the shape you asked for.',
      detail: 'A `namespace:id` that some file in the pack defines, placed at this feature\'s own position, unchanged. It is resolved BEFORE the ground is looked at, so a name nothing defines is reported at every attempt rather than only at the ones the gate would have passed. A gate that refuses, by contrast, reports nothing at all.',
    },
  ],
  'minecraft:feature_rules': [
    {
      path: 'description.identifier',
      facts: ['required', 'string'],
      summary: 'This rule\'s own name, and an input to its seed.',
      detail: 'Not a feature reference: nothing can name a rule. The name is hashed into the seed the rule\'s distribution draws from, so renaming a rule moves everything it places, while renaming the feature it points at moves nothing. Two rules may share a name if their passes differ; two in the same pass keep only the first loaded.',
    },
    {
      path: 'description.places_feature',
      facts: ['required', 'feature identifier', 'drawn as the connection from the rule card'],
      summary: 'The feature this rule attaches to every matching chunk.',
      detail: 'Sits under `description`, unlike a scatter\'s, which sits on the feature body. Unresolved, the rule places nothing at any seed in any biome; `featurelab check` reports it as an error against the rule file, naming `$.minecraft:feature_rules.description.places_feature`.',
    },
  ],
}
/** The anchor contract: the JSON path with every character outside [A-Za-z0-9_-] replaced by a
 * hyphen, so `distribution.scatter_chance` -> `distribution-scatter_chance` and
 * `conditions.minecraft:biome_filter` -> `conditions-minecraft-biome_filter`. Duplicated in
 * check-product-links.mjs (which verifies product-side links against it) and stated in authoring.md. */
const anchorOf = (fieldPath) => fieldPath.replace(/[^A-Za-z0-9_-]+/g, '-')

/** Every field of a type as (path, [specs]) in catalogue order, nested fields included, with the
 * anonymous elements of positional arrays (key '') skipped -- the array field that owns them is
 * what gets documented, exactly as docsCatalog.test.ts decides. A key catalogued twice for two
 * format_version bands (single_block's `places_block`, scatter's flat keys) lands once, with both
 * specs, so the fragment shows one entry with both version facts rather than two entries. */
function walk(spec) {
  const order = []
  const byPath = new Map()
  const sameAs = new Map()
  // A sub-field set shared by reference between siblings (scatter's x/y/z all carry the one
  // COORDINATE_ENTRY array) is walked once and cross-referenced from the others, so a type with
  // three identical axes documents the axis keys three times in the editor's data and once here.
  const seenEntry = new Map()
  const recurse = (fields, prefix) => {
    for (const f of fields) {
      if (f.key === '') {
        if (f.entry) recurse(f.entry, prefix)
        continue
      }
      const p = prefix ? `${prefix}.${f.key}` : f.key
      if (!byPath.has(p)) {
        byPath.set(p, [])
        order.push(p)
      }
      byPath.get(p).push(f)
      if (f.entry && f.entry.length > 0) {
        const first = seenEntry.get(f.entry)
        if (first !== undefined && first !== p) {
          sameAs.set(p, first)
        } else {
          seenEntry.set(f.entry, p)
          recurse(f.entry, p)
        }
      }
    }
  }
  recurse(spec.fields, '')
  return order.map((p) => ({ path: p, specs: byPath.get(p), sameAs: sameAs.get(p) }))
}

/** Whether every catalogued spec for a field is a superseded spelling with no rename partner --
 * scatter's five flat keys below format_version 1.21.10. Those are folded into a collapsed block
 * at the end of the reference; a rename pair (snap_to_surface's `vertical_search_range`) stays
 * inline beside its new spelling, because a reader on an older format_version needs it there. */
const isLegacyOnly = (specs) => specs.every((s) => s.until !== undefined && s.renamedTo === undefined && s.since === undefined)

function facts(spec) {
  const out = [spec.required ? 'required' : 'optional', spec.kind]
  if (spec.default !== undefined) out.push(`absent: ${spec.default}`)
  if (spec.min !== undefined || spec.max !== undefined) out.push(`range [${spec.min ?? '−'}, ${spec.max ?? '−'}]`)
  if (spec.length !== undefined) out.push(`exactly ${spec.length} elements`)
  if (spec.acceptsSingle) out.push('a single descriptor is accepted as a one-element list')
  if (spec.since !== undefined) out.push(`from format_version ${spec.since}`)
  if (spec.until !== undefined) out.push(`dropped at format_version ${spec.until}`)
  if (spec.renamedTo !== undefined) out.push(`renamed to \`${spec.renamedTo}\``)
  if (spec.renamedFrom !== undefined) out.push(`was \`${spec.renamedFrom}\``)
  if (spec.introducedInBuild !== undefined) out.push(spec.introducedInBuild)
  return out
}

/** Plain prose from the catalogue is markdown-safe as written -- it uses backticks for keys and
 * `--` dashes -- except that a `{` at the start of a line would be read by Vue. None does today;
 * the escape is belt and braces. */
// Catalogue prose is prose, not HTML, and VitePress compiles every page as a Vue template: a
// bare `<word>` in it reaches the compiler as an unclosed element and fails the build outright
// (`growing_plant_feature`'s height_distribution says "[<int range>, <weight>] pairs", which is
// the only one today). Escaped OUTSIDE code spans only -- inside one, `&lt;` would be shown
// literally instead of as `<`, which would break the `{tags: "<Molang query>"}` line every block
// descriptor carries.
const md = (s) =>
  s
    .replace(/^\{/gm, '\\{')
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;')))
    .join('')

function renderType(cat, typeId) {
  const spec = cat.typeSpec(typeId)
  const slug = slugOf(typeId)
  const lines = [
    `<!-- GENERATED by docs/site/tools/extract-catalog.mjs from apps/vscode/src/graph/typeCatalog.ts and`,
    `     apps/vscode/src/graph/docs/catalog.ts. Do not edit: edit those, re-run \`npm run generate\` here.`,
    `     Type: ${typeId} -->`,
    '',
  ]
  const anchors = []
  if (spec.exclusiveGroups) {
    for (const g of spec.exclusiveGroups) {
      lines.push(`::: info Exactly-one group: \`${g.name}\``, md(g.doc), ':::', '')
    }
  }
  const fields = walk(spec)
  if (fields.length === 0) {
    lines.push('_This type has no fields of its own beyond its delegation keys: everything it accepts is a reference to another feature, drawn on the graph as a connection rather than a form field._', '')
  }
  // Legacy-only keys (and everything nested under them) are rendered last, collapsed.
  const legacyRoots = new Set(fields.filter((f) => !f.path.includes('.') && isLegacyOnly(f.specs)).map((f) => f.path))
  const isLegacy = (p) => legacyRoots.has(p.split('.')[0])
  const current = fields.filter((f) => !isLegacy(f.path))
  const legacy = fields.filter((f) => isLegacy(f.path))

  const renderField = ({ path: fieldPath, specs, sameAs }) => {
    const anchor = anchorOf(fieldPath)
    anchors.push({ path: fieldPath, anchor })
    lines.push(`#### \`${fieldPath}\` {#${anchor}}`, '')
    for (const s of specs) lines.push(`<p class="fl-facts">${facts(s).map((f) => md(f)).join(' · ')}</p>`, '')
    const doc = cat.lookupFieldDoc(typeId, fieldPath)
    if (doc?.entry) {
      lines.push(doc.entry.unestablished ? `**Not established.** ${md(doc.entry.summary)}` : `**${md(doc.entry.summary)}**`, '')
      if (doc.entry.detail) lines.push(md(doc.entry.detail), '')
    }
    // FieldSpec.doc, once even when two version variants both carry it.
    const specDocs = [...new Set(specs.map((s) => s.doc).filter(Boolean))]
    for (const d of specDocs) lines.push(md(d), '')
    const unsourced = [...new Set(specs.map((s) => s.unsourced).filter(Boolean))]
    for (const u of unsourced) lines.push(`::: warning Free-text field`, md(u), ':::', '')
    const values = specs.find((s) => s.values)?.values
    if (values) {
      lines.push('Values, in the order the engine lists them:', '')
      for (const v of values) {
        const vd = cat.lookupValueDoc(typeId, fieldPath, v)
        if (vd?.entry) {
          lines.push(`- \`${v}\` — ${md(vd.entry.summary)}${vd.entry.detail ? ' ' + md(vd.entry.detail) : ''}`)
        } else {
          lines.push(`- \`${v}\``)
        }
      }
      lines.push('')
    }
    if (sameAs !== undefined) {
      const subs = fields.filter((f) => f.path.startsWith(sameAs + '.')).map((f) => `[\`${f.path.slice(sameAs.length + 1)}\`](#${anchorOf(f.path)})`)
      lines.push(`Sub-keys: the same as [\`${sameAs}\`](#${anchorOf(sameAs)}) — ${subs.join(', ')}.`, '')
    }
  }

  const edgeKeys = EDGE_KEYS[TYPE_ALIASES[typeId] ?? typeId] ?? []
  for (const e of edgeKeys) {
    const anchor = anchorOf(e.path)
    anchors.push({ path: e.path, anchor })
    lines.push(`#### \`${e.path}\` {#${anchor}}`, '', `<p class="fl-facts">${e.facts.map(md).join(' · ')}</p>`, '', `**${md(e.summary)}**`, '', md(e.detail), '')
  }
  // A type big enough that one flat list is not a reference but a wall: fold each top-level key
  // that has sub-keys of its own into a `::: details` block, in catalogue order, so a reader opens
  // the one variant their file uses. `minecraft:tree_feature` is why this exists -- it is not one
  // schema but twenty sub-schemas (eight trunk keys, twelve canopy keys) and 233 fields, where the
  // next largest type has 31 -- and the threshold is set so that it is the only type folded today.
  // Same mechanism as the legacy fold below; a key with no sub-keys stays inline, because folding a
  // single heading hides it for nothing.
  const FOLD_ABOVE = 40
  const childrenOf = (root) => current.filter((f) => f.path.startsWith(root + '.'))
  const fold = current.length > FOLD_ABOVE
  const done = new Set()
  for (const f of current) {
    if (done.has(f.path)) continue
    const kids = fold && !f.path.includes('.') ? childrenOf(f.path) : []
    if (kids.length === 0) {
      renderField(f)
      continue
    }
    // FOUR colons, not three: a folded group contains fields that carry their own `::: warning`
    // blocks, and markdown-it-container closes a container at the first fence at least as long as
    // the one that opened it -- so a three-colon fold would end at the first inner warning and
    // spill the rest of the group out of the block. The longer marker is the plugin's own nesting
    // idiom, and VitePress's `details` container reads it unchanged.
    lines.push(`:::: details \`${f.path}\` — ${kids.length + 1} keys`, '')
    renderField(f)
    for (const k of kids) {
      renderField(k)
      done.add(k.path)
    }
    lines.push('::::', '')
  }
  if (legacy.length > 0) {
    const until = legacy[0].specs[0].until
    lines.push(`::: details Keys accepted only below format_version ${until}`, '')
    lines.push(`A file declaring a \`format_version\` older than ${until} writes these keys instead of the ones above; the two spellings are mutually exclusive, and the engine drops the wrong one for the declared version with a log line naming it.`, '')
    for (const f of legacy) renderField(f)
    lines.push(':::', '')
  }
  return { slug, markdown: lines.join('\n'), anchors }
}

async function main() {
  const cat = await loadCatalogue()
  fs.mkdirSync(outDir, { recursive: true })
  const index = {}
  let fieldCount = 0
  for (const typeId of cat.catalogedTypeIds()) {
    const { slug, markdown, anchors } = renderType(cat, typeId)
    fs.writeFileSync(path.join(outDir, `${slug}.md`), markdown)
    fs.writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify({ typeId, slug, anchors }, null, 2) + '\n')
    index[typeId] = { slug, fields: anchors.length }
    fieldCount += anchors.length
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  console.log(`docs/site: generated field references for ${Object.keys(index).length} types, ${fieldCount} fields, under ${path.relative(repoRoot, outDir)}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
