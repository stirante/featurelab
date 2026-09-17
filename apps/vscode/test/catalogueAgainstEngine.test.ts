// Does typeCatalog.ts describe the keys the engine actually reads -- for every feature type?
//
// WHY THIS EXISTS AND WHY IT IS A TEST. Every form in this editor is built from
// src/graph/typeCatalog.ts. Both ways it can be wrong are SILENT:
//
//   * a key the engine reads but the catalogue omits simply does not appear in the panel. No
//     error, no note. The author cannot set it and has no way to learn it exists.
//   * a key the catalogue lists but the engine does not read invites someone to fill in a
//     control whose value the engine drops on the floor.
//
// Neither produces a diagnostic anywhere, which is why neither had been caught. `tree_feature`
// was audited by hand once and twenty variant sub-schemas turned out to be missing from the
// catalogue; the other twenty-six types had never been checked at all. A written-up audit
// would go stale the next time the engine changes. This fails instead.
//
// ---------------------------------------------------------------------------------------------
// HOW THE ENGINE SIDE IS EXTRACTED, AND HOW MUCH TO TRUST IT
// ---------------------------------------------------------------------------------------------
//
// The truth is featurelab-go's own `features/*.go` builders: the builder IS the parser, so a key
// it reads by name is a key a real pack can write. There is no Go toolchain at test time, so the
// builders are read AS TEXT. Two passes, deliberately different in character:
//
//   STRONG PASS (`readKeys`) -- the precise one, and the only one that can DEMAND a catalogue
//   entry. It recognises the four idioms the builders actually use to name a JSON key:
//     1. a map index with a string literal            -- `body["count"]`, `trunk["trunk_block"]`
//     2. a call to a local key-reading closure        -- `intField("skip_carve_chance")`, where
//        the closure was declared `x := func(key string ...)` and closes over `body`
//     3. a call to a package-level key-reading helper -- `optionalIntField(body, "min_...")`,
//        `FirstOf(body, "a", "b")`
//     4. an array-of-string key list                  -- `[]string{"trunk", "acacia_trunk", ...}`,
//        `[dirCount]string{"top", "bottom", ...}`. `map[...]string{...}` is EXCLUDED: those are
//        enum-value and direction-name tables, not key lists.
//
//   WEAK PASS (`allLiterals` + map-literal keys) -- every identifier-shaped string literal in the
//   file, plus the keys of every `map[string]...{ "k": ... }` literal. It cannot demand anything,
//   because most of what it finds is enum values and block-state names. Its job is the OPPOSITE:
//   nothing it finds may go unexplained. Each literal has to be matched by the strong pass, or be
//   a catalogued key, or be a catalogued enum value, or be a delegation key, or appear BY NAME in
//   this file's NOT_A_JSON_KEY table with a reason. That is what stops a new engine key read
//   through an idiom the strong pass does not recognise from sailing past unnoticed.
//
// WHERE THIS COULD STILL PRODUCE A FALSE CLEAN. Stated plainly, because a sweep in this repo has
// silently stopped matching and reported success before:
//
//   (a) The comparison is FLAT. Both sides are flattened to a bare set of key names, at any
//       nesting depth. A key the catalogue describes at the WRONG level -- offered on the body
//       when the engine reads it inside `constraints`, say -- still matches. Nesting was not
//       made part of the comparison because attributing a key to its parent object from text
//       alone is guesswork, and a guessy comparison that fails for the wrong reason is worse
//       than a shallow one that fails for the right one.
//   (b) A key the engine reads THROUGH A COMPUTED NAME (a string built at run time) is invisible
//       to both passes. No builder does this today; `snap_to_surface`'s rename pair comes
//       closest (two literals assigned to a variable, then `body[activeKey]`), and it is handled
//       by the CATALOGUE_KEY_NOT_MATCHED table rather than by pretending the scan saw it.
//   (c) A new engine key whose spelling COLLIDES with an existing catalogued enum value, an
//       existing NOT_A_JSON_KEY entry, or a delegation key is subtracted before it is counted.
//       Every one of those subtractions is listed by name below, so the blind spot is finite
//       and readable rather than open-ended.
//   (d) Several types share one Go file (aggregate/sequence) or reach into a shared one
//       (scatter -> distribution.go). The per-type source list over-approximates there; the one
//       case where that matters (`sequence_feature` has no `early_out`) is called out by name.
//
// The per-type confidence is recorded in ENGINE_SOURCES' `confidence` field -- 'exact' means the
// strong pass and the catalogue agree with no exceptions at all for that type.
//
// DELEGATIONS ARE NOT FIELDS. A key naming another feature is an edge in the graph, not a control
// in the form, and is correctly absent from the catalogue. Which keys those are is not written
// down here: it is READ OUT OF wire/graphbuild.go, whose `delegations` switch is the thing that
// actually removes them from GraphNode.Fields. Reading the authority beats copying it -- a key
// that stops being stripped there starts being demanded here, automatically.
//
// NOTHING IN THIS FILE MAY CHANGE src/. It is a read-only check; where it finds the catalogue
// wrong, it says so in a KNOWN_CATALOGUE_DEFECTS entry naming the file and line to fix.

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogedTypeIds, typeSpec, DELEGATION_KEYS, type FieldSpec } from '../src/graph/typeCatalog'

const here = path.dirname(fileURLToPath(import.meta.url))
/** apps/vscode/test -> apps/vscode -> apps -> the featurelab-go checkout. */
const repoRoot = path.resolve(here, '..', '..', '..')

/** A JSON key as every feature schema in this engine spells one: lower snake_case. Anything else
 * (a namespaced block name, a `-x` axis, a sentence) is not a key and is never compared. */
const KEYISH = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

// ---------------------------------------------------------------------------
// Reading Go as text
// ---------------------------------------------------------------------------

/** Strips everything from a Go source that would otherwise contribute string literals which are
 * not code: line and block comments (these builders carry MORE prose than code, and that prose
 * names keys constantly), backtick raw strings (struct tags -- `json:"min"` is a Go field name,
 * not a pack key), and the import block (`"fmt"`, `"math"`, `"strings"` are import paths). */
function stripGoNoise(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '`') {
      i++
      while (i < src.length && src[i] !== '`') i++
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      let s = '"'
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          s += String(src[j]) + String(src[j + 1])
          j += 2
          continue
        }
        s += String(src[j])
        j++
      }
      out += s + '"'
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out.replace(/\bimport\s*\(([\s\S]*?)\n\)/, '')
}

const sourceCache = new Map<string, string>()

/** The de-noised text of one repo-relative Go file. Throws rather than returning '' when the file
 * has moved: an extractor that quietly reads nothing is exactly the false clean this file is
 * written to prevent. */
function goSource(rel: string): string {
  const cached = sourceCache.get(rel)
  if (cached !== undefined) return cached
  const abs = path.join(repoRoot, rel)
  if (!fs.existsSync(abs)) {
    throw new Error(`${rel} is not where this test expects the engine to be (looked in ${repoRoot})`)
  }
  const text = stripGoNoise(fs.readFileSync(abs, 'utf8'))
  sourceCache.set(rel, text)
  return text
}

/** THE STRONG PASS. Key -> the idiom(s) it was recognised by, so a failure can say how the key
 * was found and not merely that it was. See this file's header for the four idioms. */
function readKeys(src: string): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>()
  const add = (key: string, idiom: string): void => {
    if (!KEYISH.test(key)) return
    let seen = hits.get(key)
    if (seen === undefined) {
      seen = new Set()
      hits.set(key, seen)
    }
    seen.add(idiom)
  }

  // 1. body["count"] / trunk["trunk_block"] / e["may_replace"]
  for (const m of src.matchAll(/\[\s*"([^"]+)"\s*\]/g)) add(m[1] ?? '', 'index')

  // 2 + 3. Key-reading closures and package-level helpers, found by their `key string` /
  // `field string` parameter rather than by a hand-kept list of names.
  const helpers = new Set<string>(['FirstOf'])
  for (const m of src.matchAll(/(\w+)\s*:=\s*func\(\s*(?:key|field)\s+string/g)) helpers.add(m[1] ?? '')
  for (const m of src.matchAll(/func\s+(\w+)\(body map\[string\]any,\s*(?:key|field)\s+string/g)) {
    helpers.add(m[1] ?? '')
  }
  for (const helper of helpers) {
    const call = new RegExp('\\b' + helper + '\\(\\s*(?:body\\s*,\\s*)?((?:"[^"]*"\\s*,?\\s*)+)', 'g')
    for (const m of src.matchAll(call)) {
      for (const lit of (m[1] ?? '').matchAll(/"([^"]*)"/g)) add(lit[1] ?? '', 'helper:' + helper)
    }
  }

  // 4. `[]string{...}` / `[dirCount]string{...}` key lists. `map[...]string{...}` is excluded on
  // purpose -- those are enum-value and direction-name tables (horizontal_tree_decoration.go's
  // `map[int]string{2: "north", ...}`), and reading them as keys would demand controls named
  // "north" on a feature that has none.
  for (const m of src.matchAll(/(?<!map)\[[A-Za-z0-9_.]*\]string\{([^}]*)\}/g)) {
    const parts = [...(m[1] ?? '').matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? '')
    if (parts.length > 1 && parts.every((p) => KEYISH.test(p))) for (const p of parts) add(p, 'keylist')
  }
  return hits
}

/** THE WEAK PASS. Every identifier-shaped literal, plus the keys of `map[string]...` literals
 * (which is how `cherry_trunk.branches.tree_type_weights`' three keys are written). Explained-or-
 * fail, never demanded. */
function allLiterals(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/"([^"]*)"/g)) if (KEYISH.test(m[1] ?? '')) out.add(m[1] ?? '')
  for (const m of src.matchAll(/map\[string\][^{]*\{([^}]*)\}/g)) {
    for (const lit of (m[1] ?? '').matchAll(/"([^"]*)"\s*:/g)) if (KEYISH.test(lit[1] ?? '')) out.add(lit[1] ?? '')
  }
  return out
}

// ---------------------------------------------------------------------------
// Which Go file is the authority for which type
// ---------------------------------------------------------------------------

interface EngineSource {
  files: readonly string[]
  /** 'exact'       -- strong pass and catalogue agree with no per-type exception at all.
   *  'exceptions'  -- they agree once the named exceptions below are applied.
   *  'over-broad'  -- the file is shared with another type or with a shared parser, so the
   *                   strong pass sees keys that are not this type's. Named individually. */
  confidence: 'exact' | 'exceptions' | 'over-broad'
}

const ENGINE_SOURCES: Readonly<Record<string, EngineSource>> = {
  // aggregate.go holds BOTH types; buildAggregateFeature(sequence bool) is one parser with one
  // branch. Over-broad for sequence by construction -- see aggregate.go:175-186.
  'minecraft:aggregate_feature': { files: ['features/aggregate.go'], confidence: 'exact' },
  'minecraft:sequence_feature': { files: ['features/aggregate.go'], confidence: 'over-broad' },
  'minecraft:conditional_list': { files: ['features/conditional_list.go'], confidence: 'exceptions' },
  'minecraft:weighted_random_feature': { files: ['features/weighted_random.go'], confidence: 'exceptions' },
  'minecraft:scan_surface': { files: ['features/scan_surface.go'], confidence: 'exact' },
  'minecraft:ore_feature': { files: ['features/ore.go'], confidence: 'exact' },
  // distribution.go is scatter's parameter parser (ParseScatterDistribution / ParseCoordinateRange
  // / ParseScatterChance) and nothing else reaches its key reads, so pairing it with scatter is
  // safe -- but it also holds the Molang variable names, which is why scatter has exceptions.
  'minecraft:scatter_feature': {
    files: ['features/scatter.go', 'features/distribution.go'],
    confidence: 'over-broad',
  },
  'minecraft:search_feature': { files: ['features/search_feature.go'], confidence: 'exceptions' },
  'minecraft:single_block_feature': { files: ['features/single_block.go'], confidence: 'exact' },
  'minecraft:snap_to_surface_feature': { files: ['features/snap_to_surface.go'], confidence: 'exceptions' },
  'minecraft:structure_template_feature': { files: ['features/structure_template.go'], confidence: 'exceptions' },
  'minecraft:surface_relative_threshold_feature': {
    files: ['features/surface_relative_threshold.go'],
    confidence: 'exceptions',
  },
  'minecraft:height_difference_filter_feature': {
    files: ['features/height_difference_filter.go'],
    confidence: 'exact',
  },
  'minecraft:partially_exposed_blob_feature': {
    files: ['features/partially_exposed_blob.go'],
    confidence: 'exact',
  },
  'minecraft:tree_feature': { files: ['features/tree.go'], confidence: 'exceptions' },
  'minecraft:vegetation_patch_feature': { files: ['features/vegetation_patch.go'], confidence: 'exact' },
  'minecraft:sculk_patch_feature': { files: ['features/sculk_patch.go'], confidence: 'exceptions' },
  'minecraft:growing_plant_feature': { files: ['features/growing_plant.go'], confidence: 'exceptions' },
  'minecraft:geode_feature': { files: ['features/geode.go'], confidence: 'exact' },
  'minecraft:cave_carver_feature': { files: ['features/cave.go'], confidence: 'exceptions' },
  'minecraft:nether_cave_carver_feature': { files: ['features/nether_cave.go'], confidence: 'exact' },
  'minecraft:underwater_cave_carver_feature': { files: ['features/underwater_cave.go'], confidence: 'exact' },
  'minecraft:multiface_feature': { files: ['features/multiface.go'], confidence: 'exact' },
  'minecraft:fossil_feature': { files: ['features/fossil.go'], confidence: 'exceptions' },
  'minecraft:horizontal_tree_decoration_feature': {
    files: ['features/horizontal_tree_decoration.go'],
    confidence: 'exceptions',
  },
  'minecraft:multi_block_feature': { files: ['features/multi_block.go'], confidence: 'exceptions' },
  'minecraft:multipart_block_column_feature': {
    files: ['features/multipart_block_column.go'],
    confidence: 'exact',
  },
}

// ---------------------------------------------------------------------------
// The three exception tables
//
// Every entry is a claim with a citation. A stale entry -- one that no longer describes anything
// real -- is itself a failure (see "no exception has gone stale"), because a table nobody prunes
// is a table that will one day excuse a real gap.
// ---------------------------------------------------------------------------

type KeyNotes = Readonly<Record<string, string>>

/** Keys the engine names but the form correctly does NOT offer as a control. */
const ENGINE_KEY_NOT_A_FORM_FIELD: Readonly<Record<string, KeyNotes>> = {
  'minecraft:sequence_feature': {
    early_out:
      'aggregate.go:181 reads early_out only on the aggregate branch (`if !sequence`); ' +
      'aggregate.go:175-179 states sequence_feature\'s schema has no such key and the engine ' +
      'hard-wires first_failure. Seen here only because both types share one file.',
  },
  'minecraft:conditional_list': {
    places_feature:
      'conditional_list.go:98 -- read from an ENTRY of conditional_features, which graphbuild.go:353 ' +
      'removes from Fields whole. The entry keys go with it.',
    condition: 'conditional_list.go:105 -- same, an entry key inside the removed conditional_features array.',
    conditional_list:
      'conditional_list.go:265 reads this name only to REFUSE the file and name the real key. ' +
      'Offering it as a control would offer a key that is guaranteed to fail the build.',
    originx: 'conditional_list.go:26 -- a Molang variable name (variable.originx), not a JSON key.',
    originy: 'conditional_list.go:26 -- a Molang variable name.',
    originz: 'conditional_list.go:26 -- a Molang variable name.',
    worldx: 'conditional_list.go -- a Molang variable name (variable.worldx), not a JSON key.',
    worldy: 'conditional_list.go -- a Molang variable name.',
    worldz: 'conditional_list.go -- a Molang variable name.',
  },
  'minecraft:weighted_random_feature': {
    weight:
      'weighted_random.go:57 -- read from an ENTRY of features, which graphbuild.go:326 removes from ' +
      'Fields whole. The weight itself lives on the edge (wire.GraphEdge.Weight).',
  },
  'minecraft:scatter_feature': {
    iterations:
      'KNOWN CATALOGUE DEFECT -- see KNOWN_CATALOGUE_DEFECTS. distribution.go:698 and ' +
      'scatter.go:210 read it; graphbuild.go:356-375 does NOT strip it, so it does arrive in Fields.',
    numerator:
      'KNOWN CATALOGUE DEFECT -- see KNOWN_CATALOGUE_DEFECTS. distribution.go:377-405 reads it inside ' +
      'scatter_chance; typeCatalog.ts declares CHANCE_ENTRY for exactly this and never attaches it.',
    denominator: 'KNOWN CATALOGUE DEFECT -- see KNOWN_CATALOGUE_DEFECTS, with numerator.',
    xzy: 'distribution.go:275 -- an enum VALUE looked up in evalOrders, the coordinate_eval_order default.',
    originx: 'scatter.go:105 -- a Molang variable name written into the scope, not a JSON key.',
    originy: 'scatter.go:105-107 -- a Molang variable name.',
    originz: 'scatter.go:105-107 -- a Molang variable name.',
    worldx: 'distribution.go:750 worldVarNames -- Molang variable names written per axis.',
    worldy: 'distribution.go:750 worldVarNames.',
    worldz: 'distribution.go:750 worldVarNames.',
  },
  'minecraft:structure_template_feature': {
    block_whitelist:
      'structure_template.go:572 -- the accepted ALIAS of block_allowlist. One control writes the ' +
      'canonical spelling; the alias is disclosed in that field\'s own doc (asserted below).',
  },
  'minecraft:surface_relative_threshold_feature': {
    feature:
      'surface_relative_threshold.go:99-104 reads this name only to REFUSE the file -- it is a ' +
      'spelling an earlier revision of this port invented. Same for wrapped_feature/places_feature.',
    wrapped_feature: 'surface_relative_threshold.go:99-104 -- read only to refuse.',
    places_feature: 'surface_relative_threshold.go:99-104 -- read only to refuse.',
    min_distance_below_surface:
      'surface_relative_threshold.go:106-109 -- read only to refuse, naming ' +
      'minimum_distance_below_surface as the real key. The catalogue says the same thing in prose.',
  },
  'minecraft:tree_feature': {
    // base_cluster and mangrove_roots WERE undescribed JSON boxes and are now catalogued in full,
    // so the twelve exceptions that used to sit here are gone. They were removed because this
    // file's own stale-exception test failed the moment the keys were described -- which is the
    // whole reason that test exists: an exception list nobody prunes stops meaning anything, and
    // the next real gap hides among the dead entries.
    pillar_axis: 'tree.go:7851, 8167, 8230 -- a BLOCK STATE written into a descriptor, not a pack key.',
  },
  'minecraft:fossil_feature': {
    axis: 'fossil.go:341 -- a property of an .mcstructure palette entry, not a key of the feature body.',
    x: 'fossil.go:595 `[3]string{"x", "y", "z"}` -- block-state axis VALUES for bone_block#pillar_axis.',
    y: 'fossil.go:595 -- a block-state axis value.',
    z: 'fossil.go:595 -- a block-state axis value.',
  },
  'minecraft:horizontal_tree_decoration_feature': {
    growth: 'horizontal_tree_decoration.go:356 (and the required-state list at :167) -- a BLOCK STATE name on the placed block.',
    pillar_axis: 'horizontal_tree_decoration.go:287 -- a block state read off the trunk it attaches to.',
  },
}

/** Keys the catalogue offers that the strong pass did not see the engine read. Each is either a
 * real read through an idiom the scan cannot follow, or a catalogue mistake -- the reason says
 * which. */
const CATALOGUE_KEY_NOT_MATCHED: Readonly<Record<string, KeyNotes>> = {
  'minecraft:snap_to_surface_feature': {
    search_range:
      'REAL. snap_to_surface.go:445-448 assigns the two spellings to `activeKey`/`droppedKey` and ' +
      'then reads `body[activeKey]` (line 469) -- a computed name, the one read idiom neither pass ' +
      'can follow. The catalogue is right, including the 1.26.50 gate.',
    vertical_search_range: 'REAL. snap_to_surface.go:445-448, the pre-1.26.50 spelling of the same field.',
  },
  'minecraft:tree_feature': {
    one_branch:
      'REAL. tree.go:8341 -- a key of cherry_trunk.branches.tree_type_weights, written as a ' +
      '`map[string]*int{...}` literal, which is a weak-pass idiom only.',
    two_branches: 'REAL. tree.go:8342, same map literal.',
    two_branches_and_trunk: 'REAL. tree.go:8343, same map literal.',
  },
  'minecraft:growing_plant_feature': {
    block:
      'CATALOGUE IS WRONG -- see KNOWN_CATALOGUE_DEFECTS. growing_plant.go:205-217 parses ' +
      'body_blocks/head_blocks entries as [descriptor, weight] TUPLES; there is no `block` member.',
    weight: 'CATALOGUE IS WRONG -- see KNOWN_CATALOGUE_DEFECTS, with `block`.',
  },
}

/** Literals the weak pass turns up that are not JSON keys at all. Without this table the weak
 * pass would be unusable; with it, anything NEW and unexplained fails. */
const NOT_A_JSON_KEY: Readonly<Record<string, KeyNotes>> = {
  'minecraft:sequence_feature': {
    first_success: 'aggregate.go -- an early_out enum value, on the aggregate branch this type never takes.',
    first_failure: 'aggregate.go -- an early_out enum value.',
    none: 'aggregate.go -- an early_out enum value.',
  },
  'minecraft:weighted_random_feature': {
    feature: 'weighted_random.go:51 -- an entry key inside the `features` array graphbuild.go:326 removes.',
    places_feature: 'weighted_random.go:51 -- the other spelling of the same entry key.',
  },
  'minecraft:scatter_feature': {
    tool: 'scatter.go:275 -- a fragment of a multi-line diagnostic string ("...and so does this " + "tool").',
    was: 'scatter.go:276 -- `plural(len(stray), "was", "were")`, an English word.',
    were: 'scatter.go:276 -- the other half of the same plural().',
  },
  'minecraft:search_feature': {
    x: 'search_feature.go:69-74 -- searchLoopRole axis letters naming a loop axis, not a pack key.',
    y: 'search_feature.go:69-74 -- a loop axis letter.',
    z: 'search_feature.go:69-74 -- a loop axis letter.',
  },
  'minecraft:snap_to_surface_feature': {
    above: 'snap_to_surface.go:357-365 -- snapDirectionWord, prose in the no_surface stop detail, not a pack key.',
    below: 'snap_to_surface.go:357-365 -- the same word list.',
  },
  'minecraft:tree_feature': {
    x: 'tree.go:7854-7855 -- a pillar_axis block-state VALUE for the cherry trunk\'s branch blocks.',
    z: 'tree.go:7854-7855 -- a pillar_axis block-state value.',
  },
  'minecraft:sculk_patch_feature': {
    can_summon: 'sculk_patch.go:379 -- a block state on minecraft:sculk_shrieker, not a pack key.',
  },
  'minecraft:cave_carver_feature': {
    ocean: 'cave.go:312 oceanBiomeTag -- a biome tag the carver hashes, not a pack key.',
  },
  'minecraft:horizontal_tree_decoration_feature': {
    north: 'horizontal_tree_decoration.go:191-197 -- a `map[int]string` of cardinal-direction NAMES.',
    south: 'horizontal_tree_decoration.go:191-197 -- a direction name.',
    east: 'horizontal_tree_decoration.go:191-197 -- a direction name.',
    west: 'horizontal_tree_decoration.go:191-197 -- a direction name.',
    x: 'horizontal_tree_decoration.go:321 -- a pillar_axis block-state value.',
    y: 'horizontal_tree_decoration.go:309 -- a pillar_axis block-state fallback value.',
    z: 'horizontal_tree_decoration.go:327 -- a pillar_axis block-state value.',
  },
  'minecraft:multi_block_feature': {
    south: 'multi_block.go:148 -- the cardinal-direction enum\'s zero value, used as a rotation seed.',
  },
  'minecraft:fossil_feature': {
    pillar_axis: 'fossil.go:598 -- a block state name on minecraft:bone_block.',
  },
}

/** Discrepancies where the CATALOGUE is the side that is wrong. They are pinned rather than
 * merely noted, so that the day one is fixed in src/graph/typeCatalog.ts this test fails and the
 * entry has to be deleted -- a defect nobody can quietly leave half-fixed.
 *
 * They are NOT failing assertions because this test may not edit src/; each entry names the file
 * and the line whoever picks it up has to change. */
const KNOWN_CATALOGUE_DEFECTS: readonly { id: string; what: string }[] = [
  {
    id: 'scatter.iterations is listed as a delegation key but graphbuild.go does not strip it',
    what:
      'typeCatalog.ts:87-97 puts `iterations` in DELEGATION_KEYS, and typeCatalog.ts:535-538 leaves it ' +
      'out of scatter\'s fields on that basis. But graphbuild.go:356-375 (scatterDelegation) returns ' +
      '`graphFields(doc.body, "places_feature")` -- places_feature and nothing else. `iterations` ' +
      'therefore DOES arrive in GraphNode.Fields, both flat and inside `distribution`, and is then ' +
      'reported as a contract violation rather than drawn. The edge mirrors it (GraphEdge.Iterations) ' +
      'but mirroring is not stripping. Either graphbuild must strip it or the catalogue must stop ' +
      'calling it a delegation key.',
  },
  {
    id: 'scatter_chance offers no numerator/denominator controls',
    what:
      'typeCatalog.ts:414-417 defines CHANCE_ENTRY ({numerator, denominator}) and nothing references it: ' +
      'SCATTER_CHANCE_FIELD (typeCatalog.ts:419-427) is kind \'chance\' with no `entry`. The engine ' +
      'reads both members at distribution.go:377-405, so the fraction spelling of scatter_chance has ' +
      'no sub-controls at all. Fix: attach `entry: CHANCE_ENTRY` to SCATTER_CHANCE_FIELD.',
  },
  {
    id: 'growing_plant body_blocks/head_blocks are tuples, not {block, weight} objects',
    what:
      'typeCatalog.ts:864-865 gives both keys `entry: WEIGHTED_BLOCK_ENTRY`, i.e. {block, weight} ' +
      'objects -- the shape single_block.go:389-391 really does use. growing_plant.go:205-217 parses ' +
      'these two as 2-element [blockDescriptor, weight] TUPLES and refuses anything else ' +
      '("must be a [blockDescriptor, weight] tuple"). An author who fills in the form as drawn writes ' +
      'a file the engine rejects. Fix: use the positional entry shape height_distribution already ' +
      'uses (typeCatalog.ts:849-855).',
  },
  {
    id: 'mangrove_roots.root_decoration is described as an edge; it is not one',
    what:
      'typeCatalog.ts:789-791 tells the author that mangrove_roots\' `root_decoration` "places another ' +
      'feature, so that key appears in the graph as an edge rather than here as a field". ' +
      'tree.go:9772-9777 parses it with parseAttachableDecorationObject -- a decoration BLOCK object, ' +
      'not a feature reference -- and graphbuild.go:406-432 (treeDelegations) makes an edge only for ' +
      '`log_decoration_feature` on fallen_trunk/poplar_trunk. The author is sent to look for a graph ' +
      'edge that does not exist.',
  },
]

// ---------------------------------------------------------------------------
// Delegation keys, read out of wire/graphbuild.go rather than written down here
// ---------------------------------------------------------------------------

/** typeId -> the keys graphbuild.go actually removes from GraphNode.Fields. A nested cut is
 * recorded as "parent.child" (tree's log_decoration_feature is the only one on a feature type).
 *
 * Extracted from two places, because graphbuild splits the decision between them: the `case` in
 * `delegations` names the handler and, for the filter/child handlers, passes the keys as literal
 * arguments; the handler itself names them in its own `graphFields(doc.body, ...)` call. */
function delegationKeysFromGraphbuild(): Map<string, Set<string>> {
  const src = goSource('wire/graphbuild.go')

  const byHandler = new Map<string, Set<string>>()
  for (const fn of src.matchAll(/func \(b \*graphBuilder\) (\w+)\(([\s\S]*?)\n}/g)) {
    const name = fn[1] ?? ''
    const body = fn[2] ?? ''
    const keys = new Set<string>()
    for (const g of body.matchAll(/graphFields\(doc\.body\s*,\s*((?:"[^"]*"\s*,?\s*)+)\)/g)) {
      for (const lit of (g[1] ?? '').matchAll(/"([^"]*)"/g)) keys.add(lit[1] ?? '')
    }
    // graphTrimNested cuts a NESTED key. Its two arguments are usually locals, so resolve the two
    // forms graphbuild uses: `const key = "..."` and `for _, x := range []string{...}`.
    const locals = new Map<string, string[]>()
    for (const c of body.matchAll(/const (\w+) = "([^"]*)"/g)) locals.set(c[1] ?? '', [c[2] ?? ''])
    for (const c of body.matchAll(/for _, (\w+) := range \[\]string\{([^}]*)\}/g)) {
      locals.set(c[1] ?? '', [...(c[2] ?? '').matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? ''))
    }
    const resolve = (tok: string): string[] => (tok.startsWith('"') ? [tok.slice(1, -1)] : (locals.get(tok) ?? []))
    for (const t of body.matchAll(/graphTrimNested\(fields,\s*("[^"]*"|\w+)\s*,\s*("[^"]*"|\w+)\)/g)) {
      for (const parent of resolve(t[1] ?? '')) for (const child of resolve(t[2] ?? '')) keys.add(parent + '.' + child)
    }
    byHandler.set(name, keys)
  }

  const out = new Map<string, Set<string>>()
  for (const c of src.matchAll(/case "(minecraft:[a-z_]+)":\s*\n\s*return b\.(\w+)\(doc([^)]*)\)/g)) {
    const keys = new Set<string>(byHandler.get(c[2] ?? '') ?? [])
    for (const lit of (c[3] ?? '').matchAll(/"([^"]*)"/g)) keys.add(lit[1] ?? '')
    out.set(c[1] ?? '', keys)
  }
  return out
}

// ---------------------------------------------------------------------------
// Flattening the catalogue
// ---------------------------------------------------------------------------

function walkFields(fields: readonly FieldSpec[], keys: Set<string>, values: Set<string>): void {
  for (const field of fields) {
    // '' is the catalogue's spelling for "this groupList's entries are bare values, not objects"
    // (scatter's `extent`, search_volume's `min`/`max` arrays). Not a key.
    if (field.key !== '') keys.add(field.key)
    for (const v of field.values ?? []) values.add(v)
    if (field.entry !== undefined) walkFields(field.entry, keys, values)
  }
}

function flattenCatalogue(typeId: string): { keys: Set<string>; values: Set<string> } {
  const keys = new Set<string>()
  const values = new Set<string>()
  const spec = typeSpec(typeId)
  if (spec !== undefined) walkFields(spec.fields, keys, values)
  return { keys, values }
}

// ---------------------------------------------------------------------------
// The comparison, computed once
// ---------------------------------------------------------------------------

interface Comparison {
  typeId: string
  engineKeys: Map<string, Set<string>>
  literals: Set<string>
  catalogue: Set<string>
  enumValues: Set<string>
  delegation: Set<string>
  /** Engine reads it; no control offers it; it is not a delegation. */
  engineOnly: string[]
  /** The form offers it; the strong pass never saw the engine read it. */
  catalogueOnly: string[]
  /** Weak-pass literals nothing above explains. */
  unexplained: string[]
}

function compare(typeId: string): Comparison {
  const source = ENGINE_SOURCES[typeId]
  if (source === undefined) throw new Error(`${typeId} has no engine source mapping in this test`)
  const engineKeys = new Map<string, Set<string>>()
  const literals = new Set<string>()
  for (const file of source.files) {
    const src = goSource(file)
    for (const [key, idioms] of readKeys(src)) {
      let seen = engineKeys.get(key)
      if (seen === undefined) {
        seen = new Set()
        engineKeys.set(key, seen)
      }
      for (const i of idioms) seen.add(i)
    }
    for (const lit of allLiterals(src)) literals.add(lit)
  }
  const { keys: catalogue, values: enumValues } = flattenCatalogue(typeId)
  const nested = delegationKeysFromGraphbuild().get(typeId) ?? new Set<string>()
  // Compared flat, so a nested cut ("fallen_trunk.log_decoration_feature") counts by its leaf.
  const delegation = new Set([...nested].map((k) => k.split('.').pop() ?? k))

  const engineOnly = [...engineKeys.keys()].filter((k) => !catalogue.has(k) && !delegation.has(k)).sort()
  const catalogueOnly = [...catalogue].filter((k) => KEYISH.test(k) && !engineKeys.has(k)).sort()
  const unexplained = [...literals]
    .filter((k) => !engineKeys.has(k) && !catalogue.has(k) && !enumValues.has(k) && !delegation.has(k))
    .sort()
  return { typeId, engineKeys, literals, catalogue, enumValues, delegation, engineOnly, catalogueOnly, unexplained }
}

/** The one catalogued id this sweep does not and cannot cover.
 *
 * Everything in this file is an argument about `features/*.go`: a feature type is registered by a
 * `RegisterType` call there, its keys are read by a builder there, and the whole extraction is
 * built to read those builders as text. `minecraft:feature_rule` is catalogued -- it is the other
 * half of a pack, and the property form needs its field set -- but it is none of those things. It
 * has no `RegisterType` call, no builder, and no row in the coverage table; its schema belongs to
 * the rule loader, which this file never reads.
 *
 * NOT AN EXEMPTION FROM BEING CHECKED, which is the shape this would be wrong in. It is checked,
 * against its own authority, in featureRuleCatalogue.test.ts -- key set, pass list and all. What
 * it is exempt from is being looked for among the 27 feature builders, where it is not.
 */
const RULE_TYPE_ID = 'minecraft:feature_rule'

const TYPE_IDS = catalogedTypeIds().filter((id) => id !== RULE_TYPE_ID)
const COMPARISONS = new Map<string, Comparison>(TYPE_IDS.map((t) => [t, compare(t)]))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('the extraction actually ran', () => {
  // A sweep in this repo has silently stopped matching and reported clean before. Everything below
  // is worthless if these four fail, so they come first and they are blunt.
  it('reads every engine source it names, and reads real content out of each', () => {
    const files = [...new Set(Object.values(ENGINE_SOURCES).flatMap((s) => s.files)), 'wire/graphbuild.go']
    expect(files.length).toBeGreaterThanOrEqual(28)
    for (const file of files) {
      const src = goSource(file)
      expect(src.length, `${file} came back empty after comment stripping`).toBeGreaterThan(500)
    }
  })

  it('finds keys in every builder that has any', () => {
    // A strong pass that degrades to matching nothing would turn every catalogued key into a
    // "catalogue offers a key the engine never reads" failure, so a total collapse is loud. What
    // is NOT loud is a partial collapse -- one idiom quietly ceasing to match. So: no builder in
    // the engine reads zero key names (even the pure-delegation types read their child key), and
    // three types get an exact count.
    const noKeysOfTheirOwn = [...COMPARISONS.values()].filter((c) => c.engineKeys.size === 0).map((c) => c.typeId)
    expect(
      noKeysOfTheirOwn,
      'every registered builder names at least one key (a delegation key at minimum); a type here means the scan stopped matching',
    ).toEqual([])
    // Counted by hand out of the three builders, so a scan that degrades to "a few lucky matches"
    // is caught even while it still finds something.
    expect(COMPARISONS.get('minecraft:geode_feature')?.engineKeys.size, 'geode.go:1035-1225 reads 21 keys').toBe(21)
    expect(COMPARISONS.get('minecraft:multiface_feature')?.engineKeys.size, 'multiface.go:634-749 reads 7 keys').toBe(7)
    expect(COMPARISONS.get('minecraft:sculk_patch_feature')?.engineKeys.size, 'sculk_patch.go:266-400 reads 9 keys').toBe(
      9,
    )
  })

  it('recognises all four read idioms, not just the easy one', () => {
    // If the helper/keylist rules ever stop matching, `index` alone still finds most keys and the
    // whole audit quietly narrows. Pin one witness per idiom.
    const idioms = (typeId: string, key: string): Set<string> =>
      COMPARISONS.get(typeId)?.engineKeys.get(key) ?? new Set()
    expect(idioms('minecraft:ore_feature', 'count')).toContain('index')
    expect(idioms('minecraft:geode_feature', 'filler')).toContain('helper:blockField')
    expect(idioms('minecraft:height_difference_filter_feature', 'min_required_upward_height_diff')).toContain(
      'helper:optionalIntField',
    )
    expect(idioms('minecraft:single_block_feature', 'top')).toContain('keylist')
  })

  it('reads the delegation keys out of wire/graphbuild.go', () => {
    const deleg = delegationKeysFromGraphbuild()
    // Exactly these twelve feature types delegate; graphbuild.go:205-237 is the switch that says
    // so. Pinned as an equality, not a size check: a `case` that stops being parsed would drop a
    // type's delegation keys and start DEMANDING them as form fields, which is a confusing way for
    // this file to fail and worth catching at the source.
    expect([...deleg.keys()].sort()).toEqual([
      'minecraft:aggregate_feature',
      'minecraft:conditional_list',
      'minecraft:height_difference_filter_feature',
      'minecraft:scan_surface',
      'minecraft:scatter_feature',
      'minecraft:search_feature',
      'minecraft:sequence_feature',
      'minecraft:snap_to_surface_feature',
      'minecraft:surface_relative_threshold_feature',
      'minecraft:tree_feature',
      'minecraft:vegetation_patch_feature',
      'minecraft:weighted_random_feature',
    ])
    expect([...(deleg.get('minecraft:scan_surface') ?? [])].sort()).toEqual([
      'feature',
      'feature_to_scan',
      'places_feature',
    ])
    // The nested cut, resolved through `const key = ...` and the trunk list at graphbuild.go:406-432.
    expect([...(deleg.get('minecraft:tree_feature') ?? [])].sort()).toEqual([
      'fallen_trunk.log_decoration_feature',
      'poplar_trunk.log_decoration_feature',
    ])
  })
})

describe('the catalogue covers what the engine registers', () => {
  it('models every feature type features/*.go registers, and no type it does not', () => {
    // features/registry.go:67 RegisterType is the whole registry. A new type added to the engine
    // and not to the catalogue lands here, before any key-level question is asked.
    const ids = new Map<string, string>()
    const registered = new Set<string>()
    for (const file of fs.readdirSync(path.join(repoRoot, 'features'))) {
      if (!file.endsWith('.go') || file.endsWith('_test.go')) continue
      const src = goSource(path.join('features', file).replace(/\\/g, '/'))
      for (const m of src.matchAll(/(\w+)\s*=\s*"(minecraft:[a-z_]+)"/g)) ids.set(m[1] ?? '', m[2] ?? '')
      for (const m of src.matchAll(/RegisterType\((\w+)\s*,/g)) {
        const typeId = ids.get(m[1] ?? '')
        if (typeId !== undefined) registered.add(typeId)
      }
    }
    expect(registered.size, 'no RegisterType calls found -- the scan broke, it did not find an empty engine').toBe(27)
    expect([...registered].sort()).toEqual([...TYPE_IDS].sort())
  })

  it('gives every catalogued type a Go source to be checked against', () => {
    expect(Object.keys(ENGINE_SOURCES).sort()).toEqual([...TYPE_IDS].sort())
  })

  it('never models `description`, which is the loader\'s key and not any type\'s', () => {
    // registry.go:169-175 reads description.identifier for every type, and graphbuild.go:723-738
    // does not strip it, so it reaches GraphNode.Fields on every node. It is deliberately not a
    // per-type field: it is the node's identity, and the graph shows it as such.
    for (const typeId of TYPE_IDS) {
      expect(flattenCatalogue(typeId).keys.has('description'), `${typeId} should not model description`).toBe(false)
    }
  })
})

describe.each(TYPE_IDS)('%s', (typeId) => {
  const cmp = COMPARISONS.get(typeId)!
  const notField = ENGINE_KEY_NOT_A_FORM_FIELD[typeId] ?? {}
  const notMatched = CATALOGUE_KEY_NOT_MATCHED[typeId] ?? {}
  const notKey = NOT_A_JSON_KEY[typeId] ?? {}

  it('offers a control for every key its builder reads', () => {
    const missing = cmp.engineOnly.filter((k) => notField[k] === undefined)
    expect(
      missing,
      `${typeId}: ${ENGINE_SOURCES[typeId]?.files.join(' + ')} reads ${missing.join(', ')}, and the ` +
        'catalogue has no field for it. The form will not show it at all, and the author has no way ' +
        'to learn it exists. Add a FieldSpec, or add an ENGINE_KEY_NOT_A_FORM_FIELD entry saying why not.',
    ).toEqual([])
  })

  it('offers no control for a key its builder never reads', () => {
    const invented = cmp.catalogueOnly.filter((k) => notMatched[k] === undefined)
    expect(
      invented,
      `${typeId}: the catalogue offers ${invented.join(', ')}, which ${ENGINE_SOURCES[typeId]?.files.join(' + ')} ` +
        'never reads. Either the engine reads it through an idiom this scan cannot follow (say so in ' +
        'CATALOGUE_KEY_NOT_MATCHED, with the line), or the form invites an author to write something ' +
        'that gets dropped.',
    ).toEqual([])
  })

  it('leaves no identifier-shaped literal in its builder unexplained', () => {
    // The false-clean guard. A new key read through an idiom the strong pass does not know still
    // shows up as a bare literal, and lands here.
    const unexplained = cmp.unexplained.filter((k) => notKey[k] === undefined)
    expect(
      unexplained,
      `${typeId}: ${unexplained.join(', ')} appears as a string literal in ` +
        `${ENGINE_SOURCES[typeId]?.files.join(' + ')} and nothing accounts for it. If it is a new JSON ` +
        'key, catalogue it. If it is an enum value, a block state or prose, add a NOT_A_JSON_KEY entry.',
    ).toEqual([])
  })

  it('has no exception entry that has gone stale', () => {
    // A table nobody prunes eventually excuses a real gap. Every entry must still describe
    // something the comparison actually produced.
    const stale = [
      ...Object.keys(notField).filter((k) => !cmp.engineOnly.includes(k)).map((k) => `ENGINE_KEY_NOT_A_FORM_FIELD.${k}`),
      ...Object.keys(notMatched).filter((k) => !cmp.catalogueOnly.includes(k)).map((k) => `CATALOGUE_KEY_NOT_MATCHED.${k}`),
      ...Object.keys(notKey).filter((k) => !cmp.unexplained.includes(k)).map((k) => `NOT_A_JSON_KEY.${k}`),
    ]
    expect(stale, `${typeId}: these exceptions no longer describe anything and should be deleted`).toEqual([])
  })

  it('is honest about how well its keys could be extracted', () => {
    const source = ENGINE_SOURCES[typeId]!
    const clean = cmp.engineOnly.length === 0 && cmp.catalogueOnly.length === 0 && cmp.unexplained.length === 0
    if (source.confidence === 'exact') {
      expect(
        clean,
        `${typeId} is recorded as 'exact' but needed exceptions: engine-only [${cmp.engineOnly.join(' ')}], ` +
          `catalogue-only [${cmp.catalogueOnly.join(' ')}], unexplained [${cmp.unexplained.join(' ')}]`,
      ).toBe(true)
    } else {
      expect(clean, `${typeId} is recorded as '${source.confidence}' but needs no exceptions -- promote it to 'exact'`).toBe(
        false,
      )
    }
  })
})
describe('claims this audit leans on that are not key-set comparisons', () => {
  it('keeps the two tree objects described, now that they are', () => {
    // This assertion used to say the opposite: base_cluster and mangrove_roots were deliberate
    // raw-JSON boxes, and thirteen key exceptions above were excused ONLY by that. It was written
    // to fail the day somebody described them, so those exceptions could not quietly outlive
    // their reason -- and it did exactly that. They are gone, and this guards the other direction
    // now: a description must not silently regress to a text box.
    const fields = typeSpec('minecraft:tree_feature')?.fields ?? []
    for (const key of ['base_cluster', 'mangrove_roots']) {
      const field = fields.find((f) => f.key === key)
      expect(field, `tree_feature.${key} has gone missing from the catalogue`).toBeDefined()
      expect(field?.kind, `tree_feature.${key} went back to being a raw-JSON box`).toBe('group')
      expect((field?.entry ?? []).length, `tree_feature.${key} is a group with no keys in it`).toBeGreaterThan(0)
    }
  })

  it('keeps telling the author about structure_template\'s block_whitelist alias', () => {
    // block_whitelist is excused as "the form writes the canonical spelling and the doc names the
    // alias". That excuse is only true while the doc actually names it.
    const constraints = typeSpec('minecraft:structure_template_feature')?.fields.find((f) => f.key === 'constraints')
    const intersection = constraints?.entry?.find((f) => f.key === 'block_intersection')
    const allowlist = intersection?.entry?.find((f) => f.key === 'block_allowlist')
    expect(allowlist?.doc ?? '').toContain('block_whitelist')
    expect(goSource('features/structure_template.go')).toContain('block_whitelist')
  })

  it('agrees with graphbuild.go about which keys are edges -- except where it does not', () => {
    // typeCatalog.ts's DELEGATION_KEYS is a hand-kept list; graphbuild.go is what actually strips.
    // Every entry in the list must be something graphbuild strips SOMEWHERE, or be a known defect.
    const stripped = new Set<string>()
    for (const keys of delegationKeysFromGraphbuild().values()) {
      for (const k of keys) stripped.add(k.split('.').pop() ?? k)
    }
    const notStripped = [...DELEGATION_KEYS].filter((k) => !stripped.has(k)).sort()
    expect(
      notStripped,
      'typeCatalog.ts DELEGATION_KEYS names keys that wire/graphbuild.go never removes from Fields. ' +
        'A key listed there arrives in Fields anyway and is then reported as a contract violation.',
    ).toEqual(['iterations'])
  })

  it('pins the catalogue defects this audit found, so none can be quietly half-fixed', () => {
    // These are REPORTED, not asserted-as-correct: this test may not edit src/. Each entry names
    // the file and line to change. When one is fixed, the matching exception above starts failing
    // as stale, and this entry must be deleted with it.
    expect(KNOWN_CATALOGUE_DEFECTS.map((d) => d.id)).toEqual([
      'scatter.iterations is listed as a delegation key but graphbuild.go does not strip it',
      'scatter_chance offers no numerator/denominator controls',
      'growing_plant body_blocks/head_blocks are tuples, not {block, weight} objects',
      'mangrove_roots.root_decoration is described as an edge; it is not one',
    ])
    for (const defect of KNOWN_CATALOGUE_DEFECTS) expect(defect.what.length).toBeGreaterThan(120)
  })
})
