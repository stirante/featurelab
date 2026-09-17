// palette.ts -- the node-creation menu: right-click the canvas, pick a category, pick a node.
//
// TWO LAYERS, and the split is the point.
//
//   1. A DESCRIBED MODEL (`buildPaletteModel`, `filterPalette`, `creationRequest`). Categories,
//      entries, why an entry is disabled and what clicking one asks the host to do are all
//      plain data computed from the engine's own coverage table and the pack's declared
//      `format_version`. No DOM, no globals, no I/O -- so the interesting questions ("is a
//      version-gated type still listed?", "does the reason name the version to declare?") are
//      answerable in plain node, which is where most of this file's tests live.
//   2. A THIN RENDERER (`createPaletteMenu`) over that model. It owns focus, arrow keys,
//      type-ahead and the drag gesture, and nothing else. Every string it draws came out of
//      layer 1.
//
// This is the same shape as every other module in src/graph/, and for the same reason: a menu
// whose contents can only be inspected by opening a browser is a menu whose contents nobody
// inspects.
//
// WHAT THIS MODULE DOES NOT DO. It never writes a file, never mutates a graph and never invents
// an identifier. Picking an entry produces a `NodeCreationRequest` -- a described intent the
// host fulfils -- exactly as idioms.ts returns an EditPlan rather than performing the edit.
// The host owns naming, writing and undo; this module owns "the author asked for a scatter, at
// this point on the canvas, and here are the fields it must start with".
//
// THE FIVE COMPOUNDS COME FIRST, on purpose. They are the whole reason a menu beats writing the
// JSON by hand: each one is several features wired together that nobody would discover from the
// type list. Sorting them in among 29 vanilla types alphabetically would bury the only entries
// that are not already in the schema documentation. So they are their own category and that
// category is first. (COMPOUND_KIND_NOTES is deliberately NOT surfaced here: those notes are
// written for whoever might delete a compound, not for the author choosing one. The title and
// summary on each CompoundSpec are the fields marked as what the palette shows.)
//
// NOTHING IS EVER HIDDEN FOR BEING UNUSABLE. A type the engine does not build here, one that
// Minecraft classes as internal, and one the pack's `format_version` is too old to name are
// three genuinely different situations, and all three are listed and DISABLED with the reason
// rather than dropped. Someone hunting for a type they know exists learns which of the three it
// is; an empty space where it should be teaches them the editor is broken. Note that
// forms.ts's `createPalette` deliberately drops the unbuildable ones -- it answers "what may be
// created", which is a different question -- so the disabled half is rebuilt here from the same
// coverage rows.
//
// EVERY POSITION THIS MODULE PRODUCES IS IN GRAPH COORDINATES. A node created while the camera
// is panned or zoomed has to land where the author pointed, not where the pointer happened to
// be over the window. See `screenToGraph`.
import { COMPOUND_KINDS, RULE_TYPE_ID, type CompoundKind, type CompoundSpec } from './compounds/spec.js'
import { columnCompound } from './compounds/column.js'
import { loopCompound } from './compounds/loop.js'
import { placementGuardSpec } from './compounds/placementGuard.js'
import { stepsCompound } from './compounds/steps.js'
import { createPalette, seedNewNodeFields } from './forms.js'
import {
  ABSENT_FORMAT_VERSION,
  FEATURE_SCHEMA_BANDS,
  type CoverageRow,
  type CoverageStatus,
  type FormatVersion,
  minFormatVersionForType,
  parseFormatVersion,
  typeAvailableAt,
} from './typeCatalog.js'
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, type GraphCamera, type GraphPoint } from './render.js'

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** The categories, in menu order.
 *
 * Grouped by WHAT A TYPE DOES rather than by what it is called, because the identifier is the
 * one thing an author already has when they go looking. `minecraft:scan_surface`,
 * `minecraft:scatter_feature` and `minecraft:vegetation_patch_feature` share no prefix and do
 * the same kind of job; `minecraft:multiface_feature` and `minecraft:multi_block_feature` share
 * a prefix and do nothing alike. An alphabetical list gets both of those backwards. */
export type PaletteCategoryId = 'patterns' | 'rules' | 'place' | 'choose' | 'spread' | 'position' | 'grow' | 'carve' | 'other'

export interface PaletteCategoryInfo {
  id: PaletteCategoryId
  title: string
  /** One line, shown under the category name in the first level of the menu. */
  summary: string
}

export const PALETTE_CATEGORIES: readonly PaletteCategoryInfo[] = [
  {
    id: 'patterns',
    title: 'Patterns',
    summary: 'Several features wired together in one step, for shapes the type list has no single entry for.',
  },
  {
    id: 'rules',
    title: 'Generate in the world',
    summary: 'The other half of a pack: what attaches a feature to a biome and a stage of chunk generation.',
  },
  {
    id: 'place',
    title: 'Place blocks',
    summary: 'Types that write blocks into the world themselves, rather than handing the job to another feature.',
  },
  {
    id: 'choose',
    title: 'Choose and combine',
    summary: 'Types that place other features: all of them, in order, by weight, or by condition.',
  },
  {
    id: 'spread',
    title: 'Scatter and spread',
    summary: 'Types that run another feature at many positions instead of one.',
  },
  {
    id: 'position',
    title: 'Find and filter positions',
    summary: 'Types that move or veto the position before handing it on. They place no blocks of their own.',
  },
  {
    id: 'grow',
    title: 'Grow plants and trees',
    summary: 'Types that build a trunk, a canopy or a stem from the origin upward or downward.',
  },
  {
    id: 'carve',
    title: 'Carve terrain',
    summary: 'Types that remove or reshape terrain rather than adding to it.',
  },
  {
    id: 'other',
    title: 'Other',
    summary: 'Types this menu has no description for yet. They are offered anyway rather than dropped.',
  },
]

// ---------------------------------------------------------------------------
// What each vanilla type does
// ---------------------------------------------------------------------------

/** How one feature type is presented: a short name, one sentence of what it DOES, and the extra
 * words type-ahead should match on.
 *
 * Every summary below describes behaviour an author can observe by generating a chunk. That is
 * the rule the whole user-facing surface of this project follows and graphPalette.test.ts
 * enforces it here the same way the documentation catalogue is guarded. */
interface TypePresentation {
  title: string
  summary: string
  category: PaletteCategoryId
  keywords: readonly string[]
}

/** The feature rule's own row. Not in TYPE_PRESENTATION: that table is keyed by the ids of the
 * engine's coverage table, and every entry in it is checked against that table. A rule is not in
 * it, so an entry there would read as a type the engine had dropped.
 *
 * The summary says what a rule DOES, in the same terms as every other row -- and in particular it
 * says it in terms the author already has ("where this generates"), because somebody who has only
 * ever made features does not yet know that the word for the missing half is "rule". */
const RULE_PRESENTATION: TypePresentation = {
  title: 'Feature rule',
  summary: 'Decides where a feature generates: which biomes, which stage of chunk generation, and how often per chunk.',
  category: 'rules',
  keywords: ['rule', 'placement', 'pass', 'biome', 'where', 'generate', 'chunk', 'world'],
}

/** The table. Keyed by the `minecraft:*` id exactly as the engine registers it; the order within
 * a category is the order the menu lists them in, most reached-for first.
 *
 * The behaviour in each summary is read off the engine's own coverage table and the field sets
 * in typeCatalog, never guessed from the identifier -- which is why
 * `minecraft:partially_exposed_blob_feature` is described in terms of a floor radius and an
 * exposed face rather than in terms of the word "blob". */
const TYPE_PRESENTATION: Readonly<Record<string, TypePresentation>> = {
  // ---- place blocks ----
  'minecraft:single_block_feature': {
    title: 'Single block',
    summary: 'Places one block, subject to the attachment and rotation rules you give it.',
    category: 'place',
    keywords: ['one', 'attach', 'rotate', 'survivability'],
  },
  'minecraft:ore_feature': {
    title: 'Ore vein',
    summary: 'Places a vein of blocks, replacing only what each rule allows it to replace.',
    category: 'place',
    keywords: ['vein', 'replace', 'count', 'discard'],
  },
  'minecraft:multiface_feature': {
    title: 'Multiface growth',
    summary: 'Puts a face block on the sides of nearby blocks and spreads from each one it manages to place.',
    category: 'place',
    keywords: ['vine', 'lichen', 'face', 'spread', 'glow'],
  },
  'minecraft:partially_exposed_blob_feature': {
    title: 'Partly exposed blob',
    summary: 'Places a block at positions within a radius of the floor, keeping only the ones whose chosen face is exposed.',
    category: 'place',
    keywords: ['blob', 'exposed', 'floor', 'radius', 'magma'],
  },
  'minecraft:geode_feature': {
    title: 'Geode',
    summary: 'Builds concentric shells around a randomised blob, with an optional crack through them and blocks budded onto the inner walls.',
    category: 'place',
    keywords: ['amethyst', 'shell', 'crack', 'budding', 'layer'],
  },
  'minecraft:structure_template_feature': {
    title: 'Structure template',
    summary: 'Stamps a structure file into the world, subject to the constraints you set on it.',
    category: 'place',
    keywords: ['template', 'nbt', 'constraint', 'grounded', 'rotate'],
  },
  'minecraft:fossil_feature': {
    title: 'Fossil',
    summary: 'Buries one of the built-in fossil shapes in stone, with a proportion of its bone blocks swapped for a block you choose.',
    category: 'place',
    keywords: ['bone', 'skull', 'spine', 'buried'],
  },
  'minecraft:multi_block_feature': {
    title: 'Multi-block',
    summary: 'Places a multi-block as its complete line of parts or not at all: one cell that fails the replace check rejects the whole placement.',
    category: 'place',
    keywords: ['parts', 'line', 'trait', 'custom'],
  },
  'minecraft:multipart_block_column_feature': {
    title: 'Multipart column',
    summary: 'Places an ordered column of base, middle, frustum and tip blocks along any of the six directions.',
    category: 'place',
    keywords: ['base', 'frustum', 'tip', 'direction', 'stack'],
  },
  'minecraft:horizontal_tree_decoration_feature': {
    title: 'Horizontal decoration',
    summary: 'Places one decoration block against a randomly chosen horizontal side of the origin block.',
    category: 'place',
    keywords: ['leaf litter', 'flower bed', 'side', 'bark'],
  },

  // ---- choose and combine ----
  'minecraft:aggregate_feature': {
    title: 'All of these',
    summary: 'Places every listed feature at the same position, with an optional rule for whether the first success or the first failure stops the rest.',
    category: 'choose',
    keywords: ['aggregate', 'every', 'group', 'early out', 'all'],
  },
  'minecraft:sequence_feature': {
    title: 'In sequence',
    summary: 'Places each listed feature in turn, each one aimed at the position the previous one succeeded at. One failure stops the rest.',
    category: 'choose',
    keywords: ['sequence', 'order', 'chain', 'after'],
  },
  'minecraft:weighted_random_feature': {
    title: 'Weighted choice',
    summary: 'Picks exactly one of the listed features by weight, and places nothing when the pick fails.',
    category: 'choose',
    keywords: ['weight', 'random', 'chance', 'one of'],
  },
  'minecraft:conditional_list': {
    title: 'Conditional list',
    summary: 'Chooses between features by Molang condition. An entry with no condition written always passes.',
    category: 'choose',
    keywords: ['condition', 'molang', 'if', 'else', 'case', 'branch', 'fallback', 'switch'],
  },

  // ---- scatter and spread ----
  'minecraft:scatter_feature': {
    title: 'Scatter',
    summary: 'Runs another feature repeatedly over a volume, with a Molang distribution for each axis.',
    category: 'spread',
    keywords: ['iterations', 'distribution', 'volume', 'random', 'molang'],
  },
  'minecraft:scan_surface': {
    title: 'Scan the surface',
    summary: 'Runs another feature once at the surface of every column in the chunk.',
    category: 'spread',
    keywords: ['surface', 'column', 'chunk', 'every'],
  },
  'minecraft:vegetation_patch_feature': {
    title: 'Vegetation patch',
    summary: 'Lays a patch of one ground or ceiling block and grows another feature out of it.',
    category: 'spread',
    keywords: ['patch', 'ground', 'ceiling', 'moss', 'waterlogged'],
  },
  'minecraft:sculk_patch_feature': {
    title: 'Sculk patch',
    summary: 'Places a central block, then spreads sculk outward from it with a cursor-driven growth.',
    category: 'spread',
    keywords: ['sculk', 'growth', 'cursor', 'spread', 'charge'],
  },
  'minecraft:rect_layout': {
    title: 'Rect layout',
    summary: 'Lays other features out on a 16 by 16 chunk-local grid, budgeting how much of the grid is left empty.',
    category: 'spread',
    keywords: ['grid', 'layout', 'area', 'chunk'],
  },

  // ---- find and filter positions ----
  'minecraft:snap_to_surface_feature': {
    title: 'Snap to surface',
    summary: 'Searches up or down for a surface and places the feature it wraps at the position it lands on.',
    category: 'position',
    keywords: ['snap', 'surface', 'search range', 'ceiling', 'floor'],
  },
  'minecraft:search_feature': {
    title: 'Search a volume',
    summary: 'Sweeps a volume along one axis and commits only once the feature it wraps has succeeded the required number of times.',
    category: 'position',
    keywords: ['search', 'volume', 'axis', 'successes'],
  },
  'minecraft:surface_relative_threshold_feature': {
    title: 'Below the surface',
    summary: 'Places the feature it wraps only where the origin sits strictly deeper than the distance you give below the surface.',
    category: 'position',
    keywords: ['depth', 'threshold', 'underground', 'below'],
  },
  'minecraft:height_difference_filter_feature': {
    title: 'Height difference',
    summary: 'Places the feature it wraps only where the ground within the search radius rises or falls within the limits you set.',
    category: 'position',
    keywords: ['slope', 'cliff', 'flat', 'radius', 'height'],
  },

  // ---- grow ----
  'minecraft:tree_feature': {
    title: 'Tree',
    summary: 'Pairs one trunk shape with one canopy shape.',
    category: 'grow',
    keywords: ['trunk', 'canopy', 'log', 'leaves', 'branch'],
  },
  'minecraft:growing_plant_feature': {
    title: 'Growing plant',
    summary: 'Grows a plant up or down from the origin, with weighted body and head blocks and a height drawn from a distribution.',
    category: 'grow',
    keywords: ['vine', 'stem', 'body', 'head', 'age', 'height'],
  },

  // ---- carve ----
  'minecraft:cave_carver_feature': {
    title: 'Cave carver',
    summary: 'Digs rooms and branching tunnels through solid terrain, removing blocks rather than placing them.',
    category: 'carve',
    keywords: ['cave', 'tunnel', 'room', 'carve', 'dig'],
  },
  'minecraft:nether_cave_carver_feature': {
    title: 'Nether cave carver',
    summary: 'The Nether variant of the cave carver: the same keys, its own tunnel and room shapes.',
    category: 'carve',
    keywords: ['nether', 'cave', 'tunnel', 'carve'],
  },
  'minecraft:underwater_cave_carver_feature': {
    title: 'Underwater cave carver',
    summary: 'The cave carver plus a block to fill what would otherwise be air below the water line.',
    category: 'carve',
    keywords: ['underwater', 'aquifer', 'cave', 'carve', 'water'],
  },
  'minecraft:beards_and_shavers': {
    title: 'Beards and shavers',
    summary: "Smooths the terrain around another feature's footprint, raising or lowering the ground in a shell around it.",
    category: 'carve',
    keywords: ['beard', 'shave', 'smooth', 'terrain', 'village'],
  },
}

// ---------------------------------------------------------------------------
// The compounds
// ---------------------------------------------------------------------------

/** What the menu needs off a compound, and nothing more. `CompoundSpec` is invariant in its
 * parameter type -- `validate` returns one and `expand` takes one -- so the four specs have no
 * common supertype to store them under; narrowing to the three fields the palette reads gives a
 * type they all genuinely satisfy, with no cast and no pretending a `LoopParams` is a
 * `StepsParams`. Expanding a compound is the host's job and it reaches the real spec to do it. */
type CompoundBlurb = Pick<CompoundSpec<unknown>, 'kind' | 'title' | 'summary'>

/** Every compound, in menu order. A `CompoundKind` with no entry here is a compound that would
 * be unreachable from the menu, which is exactly the mistake the exhaustive `Record` type and
 * graphPalette.test.ts exist to make impossible. */
const COMPOUND_SPECS: Readonly<Record<CompoundKind, CompoundBlurb>> = {
  loop: loopCompound,
  steps: stepsCompound,
  'placement-guard': placementGuardSpec,
  column: columnCompound,
}

/** Search words for each compound, beyond its own title and summary. The words an author
 * reaches for are the ones from the language they already know ("if", "for", "repeat"), not the
 * names this project picked. */
const COMPOUND_KEYWORDS: Readonly<Record<CompoundKind, readonly string[]>> = {
  loop: ['for', 'repeat', 'times', 'iterate', 'setup', 'script'],
  steps: ['then', 'after', 'in order', 'stack', 'continue'],
  'placement-guard': ['if', 'test', 'predicate', 'may attach to', 'check', 'guard'],
  column: ['stack', 'tower', 'height', 'levels', 'top down', 'bottom up'],
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** Why an entry cannot be created. Three genuinely different situations, kept apart because the
 * thing the author should do next differs for each: nothing (`unimplemented`), nothing
 * (`internal`), or change one line of the file (`version-gated`). */
export type PaletteBlockReason = 'unimplemented' | 'internal' | 'version-gated'

export interface PaletteBlock {
  reason: PaletteBlockReason
  /** Shown verbatim next to the entry. Says what is true of the entry, and where there is
   * something to do about it, what. */
  message: string
}

export interface PaletteItem {
  /** Stable, DOM-safe identity, prefixed by kind: `compound:loop`,
   * `type:minecraft:ore_feature`, `rule:minecraft:feature_rule`. */
  id: string
  /** `rule` is its own kind rather than a `type` with a special id, because a feature rule is not
   * a feature type: it has no row in the engine's coverage table, it is never something another
   * feature can delegate to, and it is created as a different file under a different root key.
   * Folding it in with the types would make every "is this the whole type list" check here and in
   * the tests quietly wrong by one. */
  kind: 'compound' | 'type' | 'rule'
  title: string
  summary: string
  category: PaletteCategoryId
  /** Set for `kind: 'type'` and for `kind: 'rule'`. The `minecraft:*` id as it appears on a
   * node -- for a rule that is the synthetic singular the graph gives it, not the plural key its
   * file is rooted at. */
  typeId?: string
  /** Set for `kind: 'compound'`. */
  compound?: CompoundKind
  /** The engine's coverage status, for a type. Absent for a compound, which is built out of
   * other types and carries no status of its own. */
  status?: CoverageStatus
  /** The coverage note verbatim, when there is one. Always shown alongside `approximations`
   * rather than replaced by it. */
  note?: string
  /** For a `partial` type: the sentences of its note that state a gap. This is what the author
   * is signing up for, offered at the one moment when picking something else is free. */
  approximations: readonly string[]
  /** Empty when the entry can be created. Non-empty entries are LISTED AND DISABLED, never
   * dropped -- see this file's header. Ordered most fundamental first. */
  blocks: readonly PaletteBlock[]
  enabled: boolean
  /** Whether the property form has a modelled field set for this type. False means editing it
   * falls back to raw JSON, which is worth knowing before creating one. */
  modelled: boolean
  /** The oldest `format_version` that may name this type. */
  minFormatVersion?: string
  /** Extra words type-ahead matches on, beyond the title and summary. */
  keywords: readonly string[]
}

export interface PaletteCategory extends PaletteCategoryInfo {
  items: readonly PaletteItem[]
  /** How many of `items` can actually be created right now. A category showing 0 of 4 is a
   * meaningful thing to see at the first level of the menu. */
  enabledCount: number
}

export interface PaletteModel {
  /** The pack's declared version, parsed. `present: false` means the file declared none, which
   * opens every version gate rather than closing them -- the same reading the property form
   * takes. */
  formatVersion: FormatVersion
  /** Non-empty categories, in menu order. */
  categories: readonly PaletteCategory[]
  /** Every item, flattened in menu order. */
  items: readonly PaletteItem[]
  byId: ReadonlyMap<string, PaletteItem>
  /** Type ids present in `coverage` that this file has no description for. They still appear,
   * under `Other`, because a type the engine gained since this table was written must not
   * silently vanish from the menu. Empty is the healthy state and the test asserts it. */
  undescribed: readonly string[]
}

export interface PaletteModelInput {
  /** The engine's coverage table, exactly as `featurelab types --json` and the `types` JSON-RPC
   * method produce it. Passed in rather than fetched: this module describes, it does not talk
   * to the engine. */
  coverage: readonly CoverageRow[]
  /** The pack file's own `format_version`, as a string or the array spelling. */
  formatVersion?: string | readonly number[]
}

/** The lowest schema band at or above `min`, so a version-gated entry can tell the author a
 * value that is actually a band rather than an arbitrary number. Falls back to `min` itself if
 * the bands ever stop covering it. */
function bandAtOrAbove(min: string): string {
  for (const band of FEATURE_SCHEMA_BANDS) {
    if (compareDotted(band, min) >= 0) return band
  }
  return min
}

function compareDotted(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n))
  const pb = b.split('.').map((n) => Number(n))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function versionBlock(typeId: string, declared: FormatVersion): PaletteBlock | null {
  if (typeAvailableAt(typeId, declared)) return null
  const min = minFormatVersionForType(typeId)
  const band = bandAtOrAbove(min)
  const declaredText = declared.present ? `"${declared.raw}"` : 'no format_version at all'
  return {
    reason: 'version-gated',
    message:
      `This file declares ${declaredText}, and the game only recognises ${typeId} from ${min} upward. ` +
      `Raise the file's format_version to ${band} to use it.`,
  }
}

function coverageBlock(status: string, typeId: string): PaletteBlock | null {
  if (status === 'missing') {
    return {
      reason: 'unimplemented',
      message: `Feature Lab does not build ${typeId} yet, so a node using it would preview as empty. The game still places it.`,
    }
  }
  if (status === 'out_of_scope') {
    return {
      reason: 'internal',
      message:
        `Minecraft's own feature-type reference lists ${typeId} as internal and not usable in custom content, ` +
        'so it is listed here only so a pack that already uses one can be recognised.',
    }
  }
  return null
}

/** Builds the whole menu.
 *
 * The offerable half comes straight from forms.ts's `createPalette`, so the coverage reading,
 * the gap extraction and the version gate are computed in exactly one place. That function
 * answers "what may be created" and therefore drops the unbuildable types entirely; this one
 * answers "what is there", so the dropped rows are rebuilt from the same `coverage` array and
 * marked with why they cannot be picked. */
export function buildPaletteModel(input: PaletteModelInput): PaletteModel {
  let formatVersion: FormatVersion = ABSENT_FORMAT_VERSION
  try {
    formatVersion = parseFormatVersion(input.formatVersion ?? null)
  } catch {
    // An unreadable version is the property form's to report; here it reads as absent, which
    // opens every gate. Offering everything beats offering nothing over a typo.
  }

  const offerable = new Map(createPalette(input.coverage, input.formatVersion).map((entry) => [entry.typeId, entry]))
  const undescribed: string[] = []
  const byCategory = new Map<PaletteCategoryId, PaletteItem[]>()
  const push = (item: PaletteItem): void => {
    const list = byCategory.get(item.category)
    if (list === undefined) byCategory.set(item.category, [item])
    else list.push(item)
  }

  // 1. The compounds, first and in their own category.
  for (const kind of COMPOUND_KINDS) {
    const spec = COMPOUND_SPECS[kind]
    push({
      id: `compound:${kind}`,
      kind: 'compound',
      title: spec.title,
      summary: spec.summary,
      category: 'patterns',
      compound: kind,
      approximations: [],
      blocks: [],
      enabled: true,
      modelled: true,
      keywords: COMPOUND_KEYWORDS[kind],
    })
  }

  // 2. The feature rule, in its own category and second only to the compounds.
  //
  // IT IS ADDED BY HAND, like the compounds, because it cannot come from the loop below: that
  // loop walks the engine's coverage table, and the coverage table is a table of FEATURE types.
  // A rule has no row there and correctly never will. Before this entry existed the menu offered
  // no way to make one at all, which meant the shortest path to a pack that generates ANYTHING
  // was to leave the editor and write a rule file by hand -- a pack of fifty features and no
  // rules produces nothing in game.
  //
  // Never blocked. A rule is not built by this tool's feature port, so it has no coverage status
  // to be blocked by, and its schema has no version bands, so there is no version to gate it on.
  push({
    id: `rule:${RULE_TYPE_ID}`,
    kind: 'rule',
    title: RULE_PRESENTATION.title,
    summary: RULE_PRESENTATION.summary,
    category: RULE_PRESENTATION.category,
    typeId: RULE_TYPE_ID,
    approximations: [],
    blocks: [],
    enabled: true,
    modelled: true,
    keywords: RULE_PRESENTATION.keywords,
  })

  // 3. Every type the engine knows about, described or not.
  for (const row of input.coverage) {
    const described = TYPE_PRESENTATION[row.typeId]
    if (described === undefined) undescribed.push(row.typeId)
    const entry = offerable.get(row.typeId)
    const blocks: PaletteBlock[] = []
    // Coverage first: when a type will never be buildable here, telling the author to raise
    // their format_version would send them to change a line that changes nothing.
    const coverage = coverageBlock(row.status, row.typeId)
    if (coverage !== null) blocks.push(coverage)
    const version = versionBlock(row.typeId, formatVersion)
    if (version !== null) blocks.push(version)

    push({
      id: `type:${row.typeId}`,
      kind: 'type',
      title: described?.title ?? humanizeTypeId(row.typeId),
      summary: described?.summary ?? row.note ?? 'No description written for this type yet.',
      category: described?.category ?? 'other',
      typeId: row.typeId,
      status: entry?.status ?? (row.status as CoverageStatus),
      note: row.note !== undefined && row.note.length > 0 ? row.note : undefined,
      approximations: entry?.approximations ?? [],
      blocks,
      enabled: blocks.length === 0,
      modelled: entry?.modelled ?? false,
      minFormatVersion: entry?.minFormatVersion ?? minFormatVersionForType(row.typeId),
      keywords: described?.keywords ?? [],
    })
  }

  const categories: PaletteCategory[] = []
  const items: PaletteItem[] = []
  for (const info of PALETTE_CATEGORIES) {
    const list = byCategory.get(info.id)
    if (list === undefined || list.length === 0) continue
    categories.push({ ...info, items: list, enabledCount: list.filter((i) => i.enabled).length })
    items.push(...list)
  }

  return {
    formatVersion,
    categories,
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    undescribed,
  }
}

/** A last-resort title for a type this table has never heard of: `minecraft:sculk_patch_feature`
 * becomes "Sculk patch". Better than printing the raw id twice, and worse than a written one --
 * which is why `undescribed` reports it rather than letting it pass unnoticed. */
function humanizeTypeId(typeId: string): string {
  const bare = typeId.includes(':') ? typeId.slice(typeId.indexOf(':') + 1) : typeId
  const words = bare.replace(/_feature$/, '').split('_').filter((w) => w.length > 0)
  if (words.length === 0) return typeId
  const first = words[0] as string
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ')
}

// ---------------------------------------------------------------------------
// Type-ahead
// ---------------------------------------------------------------------------

/** One item matched by a query, with the rank that ordered it.
 *
 * Lower `rank` sorts first. The ranks are: an exact type-id match, a title that starts with the
 * query, a title that contains it, a keyword, and finally the summary. Matching the summary is
 * worth keeping (it is how "remove blocks" finds the carvers) but it must never outrank a title,
 * or typing "tree" puts `minecraft:horizontal_tree_decoration_feature` above `Tree`. */
export interface PaletteMatch {
  item: PaletteItem
  rank: number
  /** Where the match was found, for a renderer that wants to say so. */
  field: 'id' | 'title' | 'keyword' | 'summary' | 'category'
}

export interface PaletteFilterResult {
  query: string
  /** In rank order, then menu order. Includes DISABLED items: someone typing the name of a type
   * they cannot use is precisely the person the reason was written for. */
  matches: readonly PaletteMatch[]
  /** The matches grouped under their category, so the grouping still teaches while filtering.
   * Categories with no match are omitted. */
  groups: readonly { category: PaletteCategoryInfo; matches: readonly PaletteMatch[] }[]
}

/** Filters the menu.
 *
 * TYPE-AHEAD IS ALWAYS ON and always searches EVERYTHING, not just the category you are
 * standing in. With 29 types plus four compounds, a category drill-down alone means knowing
 * which category a type was filed under before you can find it -- and the whole reason the
 * categories are useful (they group by behaviour, not by name) is that the filing is not
 * obvious from the name. A search that only searched the open category would punish exactly the
 * person the grouping was meant to help. An empty query returns every item, which is what
 * restores the drill-down. */
export function filterPalette(model: PaletteModel, query: string): PaletteFilterResult {
  const q = query.trim().toLowerCase()
  if (q.length === 0) {
    const matches = model.items.map((item) => ({ item, rank: 0, field: 'title' as const }))
    return { query: '', matches, groups: groupMatches(matches) }
  }

  const bare = q.startsWith('minecraft:') ? q.slice('minecraft:'.length) : q
  const categoryTitle = new Map(PALETTE_CATEGORIES.map((c) => [c.id, c.title.toLowerCase()]))
  const matches: PaletteMatch[] = []

  for (const [order, item] of model.items.entries()) {
    const title = item.title.toLowerCase()
    const id = (item.typeId ?? item.compound ?? '').toLowerCase()
    const idBare = id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id

    let rank: number | null = null
    let field: PaletteMatch['field'] = 'title'
    if (id === q || idBare === bare) {
      rank = 0
      field = 'id'
    } else if (title.startsWith(q)) {
      rank = 1
    } else if (title.includes(q)) {
      rank = 2
    } else if (idBare.includes(bare)) {
      rank = 3
      field = 'id'
    } else if (item.keywords.some((k) => k.toLowerCase().includes(q))) {
      rank = 4
      field = 'keyword'
    } else if (item.summary.toLowerCase().includes(q)) {
      rank = 5
      field = 'summary'
    } else if ((categoryTitle.get(item.category) ?? '').includes(q)) {
      rank = 6
      field = 'category'
    }

    // Menu order breaks rank ties, which keeps the compounds above the vanilla types whenever
    // they matched equally well -- the same argument that puts their category first.
    if (rank !== null) matches.push({ item, rank: rank * 1000 + order, field })
  }

  matches.sort((a, b) => a.rank - b.rank)
  return { query, matches, groups: groupMatches(matches) }
}

/** Buckets matches under their category, in menu order, dropping the empty ones. Rank order is
 * preserved inside each bucket, so the best match in a category is the first one under its
 * heading. */
function groupMatches(matches: readonly PaletteMatch[]): PaletteFilterResult['groups'] {
  const out: { category: PaletteCategoryInfo; matches: PaletteMatch[] }[] = []
  for (const info of PALETTE_CATEGORIES) {
    const mine = matches.filter((m) => m.item.category === info.id)
    if (mine.length > 0) out.push({ category: info, matches: mine })
  }
  return out
}

// ---------------------------------------------------------------------------
// Screen -> graph coordinates
// ---------------------------------------------------------------------------

/** The part of the canvas element a pointer position is measured against: its top-left in the
 * same client coordinates a PointerEvent reports. `DOMRect` satisfies this, so a caller normally
 * passes `view.element.getBoundingClientRect()` straight in. */
export interface ViewportOrigin {
  left: number
  top: number
}

/** Turns a pointer position into a point in GRAPH coordinates.
 *
 * The camera says which world point is drawn at the host's top-left and how many world units
 * one CSS pixel covers, so the inverse of the canvas transform is exactly this. It matters
 * because every other way of doing it is wrong the moment the camera is not at the identity: a
 * node created from a right-click while panned three screens to the right lands three screens
 * away from the click if the pointer position is used as-is.
 *
 * render.ts does NOT export this conversion -- it keeps the transform private and exposes
 * `getCamera()` and its `element` instead -- so this is written against those two public
 * values rather than reaching into the view. `paletteCamera` is the adapter that reads them. */
export function screenToGraph(screen: GraphPoint, camera: GraphCamera, origin: ViewportOrigin): GraphPoint {
  return {
    x: camera.x + (screen.x - origin.left) / camera.zoom,
    y: camera.y + (screen.y - origin.top) / camera.zoom,
  }
}

/** Where the new node's position value should be, so the node BOX lands centred on `point`.
 *
 * `anchor` is render.ts's own `GraphViewOptions.positionAnchor` and must match whatever the
 * host passed to `createGraphView`: with `'topLeft'` (the default) a position names the box's
 * corner, so the corner has to be half a box up and to the left of where the author pointed;
 * with `'center'` the point IS the position. Getting this wrong offsets every created node by
 * half a box, consistently, which is the kind of wrong nobody reports and everybody works
 * around. */
export function nodePositionAt(point: GraphPoint, anchor: 'topLeft' | 'center' = 'topLeft'): GraphPoint {
  if (anchor === 'center') return { x: point.x, y: point.y }
  return { x: point.x - GRAPH_NODE_WIDTH / 2, y: point.y - GRAPH_NODE_HEIGHT / 2 }
}

/** What `createPaletteMenu` needs to know about the canvas: where it is on screen, and where its
 * camera is. Both are read fresh on every gesture rather than captured once, because the author
 * can pan and zoom between opening the menu and dropping an entry. */
export interface PaletteViewport {
  camera(): GraphCamera
  origin(): ViewportOrigin
  /** The element a drop must land inside to count. */
  element: HTMLElement
}

/** Builds a `PaletteViewport` from anything shaped like a `GraphView` -- which `GraphView`
 * itself is, so `paletteCamera(view)` is the normal call. Typed structurally rather than
 * against `GraphView` so a test harness can pass a stub without constructing a whole canvas. */
export function paletteCamera(view: { element: HTMLElement; getCamera(): GraphCamera }): PaletteViewport {
  return {
    element: view.element,
    camera: () => view.getCamera(),
    origin: () => {
      const box = view.element.getBoundingClientRect()
      return { left: box.left, top: box.top }
    },
  }
}

// ---------------------------------------------------------------------------
// The creation request
// ---------------------------------------------------------------------------

/** How the author asked for the node. Not decoration: a drop carries a position the author
 * chose and a click carries one the menu chose, and a host that wants to nudge an overlapping
 * click out of the way must not nudge a deliberate drop. */
export type PaletteGesture = 'click' | 'drop'

/** Create one vanilla feature node. */
export interface TypeCreationRequest {
  kind: 'type'
  typeId: string
  /** Exactly what a new node's `Fields` must start as: every key this type REQUIRES at this
   * format_version and nothing else, each with a placeholder of the right shape. Straight from
   * forms.ts's `seedNewNodeFields`, so a node created here is not born failing a validation
   * rule the property form would have seeded past. */
  fields: Record<string, unknown>
  /** The version the fields were seeded for, echoed back exactly as it was declared, so the
   * host writes the same value into the new file rather than normalising it. */
  formatVersion?: string
  /** Top-left of the node box, in GRAPH coordinates, ready to hand to the layout sidecar. */
  position: GraphPoint
  gesture: PaletteGesture
  /** The menu entry this came from, for a host that wants to echo the title in an undo label. */
  item: PaletteItem
}

/** Create one compound -- several features wired together.
 *
 * Carries NO parameters. A compound's parameters are a Molang script, a case list or a pair of
 * bounds; none of them has a defensible default and inventing one would write a feature nobody
 * asked for. So the request says which compound and where, and the host collects the parameters
 * and runs the compound's own `expand`. */
export interface CompoundCreationRequest {
  kind: 'compound'
  compound: CompoundKind
  position: GraphPoint
  gesture: PaletteGesture
  item: PaletteItem
}

/** Create one feature rule -- the file that decides where a feature generates.
 *
 * Deliberately the same shape as a TypeCreationRequest, minus nothing, so that a host which has
 * not been taught about rules yet still compiles and still writes A file. What it must be taught
 * is the two calls that differ, and they are both exported from compounds/spec.ts:
 * `ruleFilePath(identifier)` instead of `featureFilePath`, and `ruleFileContents(identifier,
 * formatVersion)` instead of `featureFileContents` -- a rule's file lives in `feature_rules/` and
 * is rooted at the PLURAL `minecraft:feature_rules`, neither of which can be derived from
 * `typeId` by a host that assumes every node is a feature. */
export interface RuleCreationRequest {
  kind: 'rule'
  /** The synthetic singular a rule NODE carries. NOT the key the file is rooted at. */
  typeId: string
  /** The rule's own settings, seeded exactly as a type's are -- `conditions.placement_pass` and
   * nothing else, because that is the only thing the schema requires that the file's own body
   * does not already carry. `description` is not here: its `identifier` is the node's name and
   * its `places_feature` is an edge, and `ruleFileContents` writes both. */
  fields: Record<string, unknown>
  formatVersion?: string
  position: GraphPoint
  gesture: PaletteGesture
  item: PaletteItem
}

export type NodeCreationRequest = TypeCreationRequest | CompoundCreationRequest | RuleCreationRequest

export interface CreationRequestOptions {
  /** In GRAPH coordinates: the point the author indicated. Converted with `screenToGraph`. */
  point: GraphPoint
  gesture: PaletteGesture
  /** Matches `GraphViewOptions.positionAnchor`; see `nodePositionAt`. */
  anchor?: 'topLeft' | 'center'
  formatVersion?: string | readonly number[]
}

/** Describes what creating `item` would mean. Returns null for a disabled entry -- a click that
 * reached one is a renderer bug, and producing a request anyway would let it through. */
export function creationRequest(item: PaletteItem, options: CreationRequestOptions): NodeCreationRequest | null {
  if (!item.enabled) return null
  const position = nodePositionAt(options.point, options.anchor ?? 'topLeft')
  if (item.kind === 'compound') {
    const compound = item.compound
    if (compound === undefined) return null
    return { kind: 'compound', compound, position, gesture: options.gesture, item }
  }
  const typeId = item.typeId
  if (typeId === undefined) return null
  const declared = options.formatVersion
  if (item.kind === 'rule') {
    return {
      kind: 'rule',
      typeId,
      fields: seedNewNodeFields(typeId, declared),
      formatVersion: typeof declared === 'string' ? declared : Array.isArray(declared) ? declared.join('.') : undefined,
      position,
      gesture: options.gesture,
      item,
    }
  }
  return {
    kind: 'type',
    typeId,
    fields: seedNewNodeFields(typeId, declared),
    formatVersion: typeof declared === 'string' ? declared : Array.isArray(declared) ? declared.join('.') : undefined,
    position,
    gesture: options.gesture,
    item,
  }
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

/** The menu's stylesheet.
 *
 * IT LIVES HERE RATHER THAN IN media/graph.css because that file styles the canvas and this
 * module ships the menu; keeping them together means the renderer and its styling cannot drift
 * apart in a review. The RULES are graph.css's, unchanged, because the menu is drawn over that
 * canvas and a second convention would show:
 *
 *   1. Every `--flp-*` variable is declared ONCE, as `var(--vscode-<name>, <fallback>)`. Inside
 *      a webview the host injects every `--vscode-*` property and updates them live on a theme
 *      switch, so the menu follows the theme with no JavaScript. Outside one, the fallback
 *      applies.
 *   2. Every rule below the variable block reads only `--flp-*`.
 *   3. NO RAW COLOUR BELOW THE VARIABLE BLOCK. `transparent`, `none` and `currentColor` are
 *      keywords, not colours. graphPalette.test.ts scans this string for the same reason
 *      graphRender.test.ts scans graph.css: a hard-coded colour looks right in exactly the one
 *      theme its author was using.
 *
 * A DISABLED ENTRY IS NEVER DIMMED AND NOTHING ELSE. Dimming alone is invisible in a
 * high-contrast theme and unreadable to anyone who cannot separate the two greys, and the
 * consequence here is not cosmetic -- it is believing a type is available. So a blocked entry
 * also gets a visible reason line and `aria-disabled`, and the reason is what the screen reader
 * announces. */
export const PALETTE_STYLESHEET = `
.flp-menu {
  --flp-bg: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
  --flp-fg: var(--vscode-menu-foreground, var(--vscode-editor-foreground, #cccccc));
  --flp-fg-muted: var(--vscode-descriptionForeground, rgba(204, 204, 204, 0.7));
  --flp-border: var(--vscode-menu-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  --flp-sep: var(--vscode-menu-separatorBackground, rgba(128, 128, 128, 0.35));
  --flp-active-bg: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #04395e));
  --flp-active-fg: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, #ffffff));
  --flp-hover-bg: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
  --flp-focus: var(--vscode-focusBorder, #007fd4);
  --flp-input-bg: var(--vscode-input-background, #3c3c3c);
  --flp-input-fg: var(--vscode-input-foreground, #cccccc);
  --flp-input-border: var(--vscode-input-border, rgba(128, 128, 128, 0.35));
  --flp-placeholder: var(--vscode-input-placeholderForeground, rgba(204, 204, 204, 0.5));
  --flp-blocked-fg: var(--vscode-disabledForeground, rgba(204, 204, 204, 0.5));
  --flp-warning-fg: var(--vscode-editorWarning-foreground, #cca700);
  --flp-error-fg: var(--vscode-editorError-foreground, #f14c4c);
  --flp-badge-bg: var(--vscode-badge-background, #4d4d4d);
  --flp-badge-fg: var(--vscode-badge-foreground, #ffffff);
  --flp-code-fg: var(--vscode-textPreformat-foreground, #ce9178);
  --flp-shadow: var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
  --flp-font: var(--vscode-font-family, -apple-system, 'Segoe UI', system-ui, sans-serif);
  --flp-mono: var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Consolas, monospace);
  --flp-font-size: var(--vscode-font-size, 13px);

  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: 360px;
  max-height: 60vh;
  font-family: var(--flp-font);
  font-size: var(--flp-font-size);
  line-height: 1.35;
  color: var(--flp-fg);
  background-color: var(--flp-bg);
  border: 1px solid var(--flp-border);
  border-radius: 4px;
  box-shadow: 0 4px 14px var(--flp-shadow);
  overflow: hidden;
}

.flp-menu[hidden] {
  display: none;
}

.flp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--flp-sep);
}

.flp-back {
  flex: none;
  padding: 2px 6px;
  font: inherit;
  color: var(--flp-fg);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}

.flp-back:hover {
  background-color: var(--flp-hover-bg);
}

.flp-back[hidden] {
  display: none;
}

.flp-filter {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 6px;
  font: inherit;
  color: var(--flp-input-fg);
  background-color: var(--flp-input-bg);
  border: 1px solid var(--flp-input-border);
  border-radius: 3px;
  outline: none;
}

.flp-filter:focus {
  border-color: var(--flp-focus);
}

.flp-filter::placeholder {
  color: var(--flp-placeholder);
}

.flp-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}

.flp-group {
  padding: 6px 10px 2px;
  font-size: 0.85em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--flp-fg-muted);
}

.flp-row {
  display: block;
  padding: 5px 10px;
  cursor: pointer;
  border-left: 2px solid transparent;
  touch-action: none;
}

.flp-row:hover {
  background-color: var(--flp-hover-bg);
}

.flp-row.flp-active {
  background-color: var(--flp-active-bg);
  color: var(--flp-active-fg);
  border-left-color: var(--flp-focus);
}

.flp-row.flp-active .flp-row-summary,
.flp-row.flp-active .flp-row-id {
  color: var(--flp-active-fg);
}

.flp-row-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.flp-row-name {
  font-weight: 600;
}

.flp-row-count,
.flp-row-chevron {
  margin-left: auto;
  color: var(--flp-fg-muted);
}

.flp-row.flp-active .flp-row-count,
.flp-row.flp-active .flp-row-chevron {
  color: var(--flp-active-fg);
}

.flp-row-summary {
  color: var(--flp-fg-muted);
  font-size: 0.92em;
}

.flp-row-id {
  font-family: var(--flp-mono);
  font-size: 0.85em;
  color: var(--flp-code-fg);
}

.flp-tag {
  flex: none;
  padding: 0 5px;
  font-size: 0.8em;
  border-radius: 8px;
  background-color: var(--flp-badge-bg);
  color: var(--flp-badge-fg);
}

.flp-tag-partial {
  background-color: transparent;
  color: var(--flp-warning-fg);
  border: 1px solid var(--flp-warning-fg);
}

.flp-row[aria-disabled='true'] {
  cursor: default;
  color: var(--flp-blocked-fg);
}

.flp-row[aria-disabled='true'] .flp-row-name,
.flp-row[aria-disabled='true'] .flp-row-summary {
  color: var(--flp-blocked-fg);
}

/* The reason a blocked entry cannot be picked. Always drawn -- see this constant's header for
   why dimming on its own is not an answer. */
.flp-row-blocked {
  margin-top: 2px;
  font-size: 0.88em;
  color: var(--flp-warning-fg);
}

.flp-row-blocked-internal,
.flp-row-blocked-unimplemented {
  color: var(--flp-error-fg);
}

.flp-note {
  margin-top: 2px;
  font-size: 0.88em;
  color: var(--flp-warning-fg);
}

.flp-empty {
  padding: 10px;
  color: var(--flp-fg-muted);
}

.flp-foot {
  flex: none;
  padding: 4px 10px;
  font-size: 0.85em;
  color: var(--flp-fg-muted);
  border-top: 1px solid var(--flp-sep);
}

/* The entry riding under the pointer during a drag. Follows the cursor on a layer of its own so
   nothing has to be re-laid-out per frame.

   It declares its own variables rather than reading the menu's: it is appended beside the menu,
   not inside it, so it is not a descendant of .flp-menu and none of that block's --flp-* values
   reach it. Same three rules, its own copy of the values it needs. */
.flp-ghost {
  --flp-ghost-fg: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, #ffffff));
  --flp-ghost-bg: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #04395e));
  --flp-ghost-border: var(--vscode-focusBorder, #007fd4);
  --flp-ghost-font: var(--vscode-font-family, -apple-system, 'Segoe UI', system-ui, sans-serif);
  --flp-ghost-font-size: var(--vscode-font-size, 13px);

  position: fixed;
  z-index: 50;
  pointer-events: none;
  padding: 4px 8px;
  font-family: var(--flp-ghost-font);
  font-size: var(--flp-ghost-font-size);
  color: var(--flp-ghost-fg);
  background-color: var(--flp-ghost-bg);
  border: 1px solid var(--flp-ghost-border);
  border-radius: 3px;
  opacity: 0.9;
}
`

/** Injects `PALETTE_STYLESHEET` into `doc` once. Idempotent -- a second menu on the same
 * document reuses the first one's <style>. */
export function installPaletteStyles(doc: Document = document): void {
  const id = 'flp-palette-styles'
  if (doc.getElementById(id) !== null) return
  const style = doc.createElement('style')
  style.id = id
  // A webview serves this page under a Content-Security-Policy whose style-src is a nonce, and
  // a <style> created at runtime carries none -- so it is refused, nothing is logged where the
  // author would look, and the menu renders as unstyled text. The nonce is copied off a style
  // element the document was SERVED with, which is the only element here that legitimately has
  // one. (The content attribute is blanked by the browser after load, but the element keeps the
  // value and hands it back through the IDL property, which is what this reads.)
  //
  // When there is no nonce to copy -- a plain page, a test harness -- the element is appended
  // anyway, because such a page has no policy to violate.
  const served = doc.querySelector('style[nonce]') as HTMLStyleElement | null
  const nonce = served?.nonce ?? ''
  if (nonce !== '') style.nonce = nonce
  style.textContent = PALETTE_STYLESHEET
  doc.head.append(style)
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export interface PaletteMenuOptions {
  model: PaletteModel
  viewport: PaletteViewport
  /** Called with the described request. This module never acts on it. */
  onCreate: (request: NodeCreationRequest) => void
  /** Where the menu appends itself. Defaults to the viewport element's own document body, so
   * the menu is not clipped by the canvas's `overflow: hidden`. */
  container?: HTMLElement
  /** Must match the `positionAnchor` the host passed to `createGraphView`. */
  anchor?: 'topLeft' | 'center'
  /** The pack's declared `format_version`, forwarded into every request so a new node is seeded
   * for the file it is going into. */
  formatVersion?: string | readonly number[]
  onClose?: () => void
}

export interface PaletteMenu {
  readonly element: HTMLElement
  /** Opens at a point in CLIENT coordinates -- a PointerEvent's `clientX`/`clientY`. A click on
   * an entry creates the node at the graph point this maps to, so a right-click and a click
   * land in the same place. */
  openAt(screen: GraphPoint): void
  close(): void
  isOpen(): boolean
  /** Replaces the model in place, keeping the menu open. For a host that reloaded the pack. */
  setModel(model: PaletteModel): void
  dispose(): void
}

/** How far the pointer must travel before a press becomes a drag rather than a click. Small
 * enough that a deliberate drag is recognised immediately, large enough that the shake in a
 * click does not turn one into a drop somewhere the author was not pointing. */
const DRAG_THRESHOLD_PX = 5

interface Row {
  element: HTMLElement
  /** A category row at the first level, or an item row. */
  target: { kind: 'category'; id: PaletteCategoryId } | { kind: 'item'; item: PaletteItem }
  selectable: boolean
}

export function createPaletteMenu(options: PaletteMenuOptions): PaletteMenu {
  const doc = options.viewport.element.ownerDocument
  installPaletteStyles(doc)
  const container = options.container ?? doc.body
  const anchor = options.anchor ?? 'topLeft'

  let model = options.model
  let open = false
  /** null = the category list; otherwise the category being shown. Ignored while filtering,
   * which flattens across every category on purpose. */
  let level: PaletteCategoryId | null = null
  let activeIndex = 0
  let rows: Row[] = []
  /** Where the menu was opened, in client coordinates. A click creates here. */
  let openPoint: GraphPoint = { x: 0, y: 0 }
  let disposed = false

  const root = doc.createElement('div')
  root.className = 'flp-menu'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Add a node')

  const head = doc.createElement('div')
  head.className = 'flp-head'
  const back = doc.createElement('button')
  back.className = 'flp-back'
  back.type = 'button'
  back.textContent = '‹ Categories'
  back.hidden = true
  const filter = doc.createElement('input')
  filter.className = 'flp-filter'
  filter.type = 'text'
  filter.placeholder = 'Filter'
  // A combobox rather than a search box: focus stays in the text field so typing always filters,
  // while `aria-activedescendant` moves the announced row. Moving real DOM focus onto each row
  // instead would mean every arrow key steals focus out of the box and the next keystroke goes
  // nowhere.
  filter.setAttribute('role', 'combobox')
  filter.setAttribute('aria-expanded', 'true')
  filter.setAttribute('aria-autocomplete', 'list')
  filter.setAttribute('aria-label', 'Filter nodes')
  head.append(back, filter)

  const list = doc.createElement('div')
  list.className = 'flp-list'
  list.id = `flp-list-${Math.random().toString(36).slice(2, 8)}`
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Nodes')
  filter.setAttribute('aria-controls', list.id)

  const foot = doc.createElement('div')
  foot.className = 'flp-foot'

  root.append(head, list, foot)
  container.append(root)

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function rowShell(id: string, selectable: boolean): HTMLElement {
    const el = doc.createElement('div')
    el.className = 'flp-row'
    el.id = id
    el.setAttribute('role', 'option')
    el.setAttribute('aria-selected', 'false')
    if (!selectable) el.setAttribute('aria-disabled', 'true')
    // The browser's own text/image drag would fight the pointer drag below.
    el.draggable = false
    return el
  }

  function drawCategoryRow(category: PaletteCategory, index: number): Row {
    const el = rowShell(`${list.id}-r${index}`, true)
    el.dataset.categoryId = category.id
    el.setAttribute('aria-haspopup', 'listbox')
    const title = doc.createElement('div')
    title.className = 'flp-row-title'
    const name = doc.createElement('span')
    name.className = 'flp-row-name'
    name.textContent = category.title
    const count = doc.createElement('span')
    count.className = 'flp-row-count'
    // "3 of 4" rather than "4": a category where most entries are blocked is worth seeing before
    // opening it, not after.
    count.textContent =
      category.enabledCount === category.items.length
        ? `${category.items.length}`
        : `${category.enabledCount} of ${category.items.length}`
    const chevron = doc.createElement('span')
    chevron.className = 'flp-row-chevron'
    chevron.textContent = '›'
    chevron.setAttribute('aria-hidden', 'true')
    title.append(name, count, chevron)
    const summary = doc.createElement('div')
    summary.className = 'flp-row-summary'
    summary.textContent = category.summary
    el.append(title, summary)
    el.setAttribute(
      'aria-label',
      `${category.title}. ${category.summary} ${category.enabledCount} of ${category.items.length} available.`,
    )
    return { element: el, target: { kind: 'category', id: category.id }, selectable: true }
  }

  function drawItemRow(item: PaletteItem, index: number): Row {
    const el = rowShell(`${list.id}-r${index}`, item.enabled)
    el.dataset.itemId = item.id
    el.dataset.kind = item.kind
    if (item.typeId !== undefined) el.dataset.typeId = item.typeId

    const title = doc.createElement('div')
    title.className = 'flp-row-title'
    const name = doc.createElement('span')
    name.className = 'flp-row-name'
    name.textContent = item.title
    title.append(name)
    if (item.kind === 'compound') {
      const tag = doc.createElement('span')
      tag.className = 'flp-tag'
      tag.textContent = 'pattern'
      title.append(tag)
    }
    if (item.status === 'partial') {
      const tag = doc.createElement('span')
      tag.className = 'flp-tag flp-tag-partial'
      tag.textContent = 'partial'
      title.append(tag)
    }
    el.append(title)

    const summary = doc.createElement('div')
    summary.className = 'flp-row-summary'
    summary.textContent = item.summary
    el.append(summary)

    if (item.typeId !== undefined) {
      const id = doc.createElement('div')
      id.className = 'flp-row-id'
      id.textContent = item.typeId
      el.append(id)
    }

    // The gaps a partial type is asking the author to accept, at the one moment picking
    // something else is free.
    if (item.enabled && item.approximations.length > 0) {
      const note = doc.createElement('div')
      note.className = 'flp-note'
      note.textContent = item.approximations[0] as string
      el.append(note)
    }

    const announced: string[] = [item.title, item.summary]
    for (const block of item.blocks) {
      const reason = doc.createElement('div')
      reason.className = `flp-row-blocked flp-row-blocked-${block.reason}`
      reason.textContent = block.message
      el.append(reason)
      announced.push(block.message)
    }
    el.setAttribute('aria-label', announced.join(' '))

    return { element: el, target: { kind: 'item', item }, selectable: item.enabled }
  }

  function draw(): void {
    list.textContent = ''
    rows = []
    const query = filter.value

    if (query.trim().length > 0) {
      const result = filterPalette(model, query)
      let index = 0
      for (const group of result.groups) {
        const heading = doc.createElement('div')
        heading.className = 'flp-group'
        heading.setAttribute('role', 'presentation')
        heading.textContent = group.category.title
        list.append(heading)
        for (const match of group.matches) {
          const row = drawItemRow(match.item, index++)
          rows.push(row)
          list.append(row.element)
        }
      }
      if (rows.length === 0) {
        const empty = doc.createElement('div')
        empty.className = 'flp-empty'
        empty.textContent = `Nothing matches ${JSON.stringify(query)}.`
        list.append(empty)
      }
      back.hidden = true
      foot.textContent = `${rows.filter((r) => r.selectable).length} of ${rows.length} shown can be added.`
    } else if (level === null) {
      let index = 0
      for (const category of model.categories) {
        const row = drawCategoryRow(category, index++)
        rows.push(row)
        list.append(row.element)
      }
      back.hidden = true
      foot.textContent = 'Type to search every category. Enter opens one.'
    } else {
      const category = model.categories.find((c) => c.id === level)
      let index = 0
      for (const item of category?.items ?? []) {
        const row = drawItemRow(item, index++)
        rows.push(row)
        list.append(row.element)
      }
      back.hidden = false
      foot.textContent = 'Enter adds here. Drag an entry onto the canvas to place it.'
    }

    if (activeIndex >= rows.length) activeIndex = Math.max(0, rows.length - 1)
    applyActive()
  }

  function applyActive(): void {
    for (const [i, row] of rows.entries()) {
      const on = i === activeIndex
      row.element.classList.toggle('flp-active', on)
      row.element.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    const active = rows[activeIndex]
    if (active === undefined) {
      filter.removeAttribute('aria-activedescendant')
      return
    }
    filter.setAttribute('aria-activedescendant', active.element.id)
    active.element.scrollIntoView({ block: 'nearest' })
  }

  function move(delta: number): void {
    if (rows.length === 0) return
    // Wrapping, and NOT skipping blocked rows: a blocked row carries the reason, and arrowing
    // straight past it is the same as hiding it.
    activeIndex = (activeIndex + delta + rows.length) % rows.length
    applyActive()
  }

  // -------------------------------------------------------------------------
  // Activating
  // -------------------------------------------------------------------------

  function graphPointFor(screen: GraphPoint): GraphPoint {
    return screenToGraph(screen, options.viewport.camera(), options.viewport.origin())
  }

  function emit(item: PaletteItem, screen: GraphPoint, gesture: PaletteGesture): void {
    const request = creationRequest(item, {
      point: graphPointFor(screen),
      gesture,
      anchor,
      formatVersion: options.formatVersion,
    })
    if (request === null) return
    options.onCreate(request)
  }

  function activate(row: Row, screen: GraphPoint, gesture: PaletteGesture): void {
    if (row.target.kind === 'category') {
      level = row.target.id
      activeIndex = 0
      draw()
      filter.focus()
      return
    }
    if (!row.selectable) return
    emit(row.target.item, screen, gesture)
    close()
  }

  function goBack(): void {
    if (filter.value.length > 0) {
      filter.value = ''
      activeIndex = 0
      draw()
      return
    }
    if (level === null) return
    const wasLevel = level
    level = null
    draw()
    const idx = rows.findIndex((r) => r.target.kind === 'category' && r.target.id === wasLevel)
    activeIndex = idx >= 0 ? idx : 0
    applyActive()
  }

  // -------------------------------------------------------------------------
  // Dragging an entry onto a spot
  // -------------------------------------------------------------------------
  //
  // Pointer events, not HTML5 drag-and-drop. Three reasons, in order: a webview is a hostile
  // place for native drag-and-drop and always has been; the drop target here is a canvas whose
  // coordinates only this module knows how to convert, so a `dataTransfer` round-trip buys
  // nothing; and a gesture built from pointerdown/move/up is drivable -- and therefore testable
  // -- with ordinary mouse input.
  //
  // The move and release are tracked on the DOCUMENT rather than through `setPointerCapture`,
  // because the panel hides itself once a drag starts and a capture held by a hidden element is
  // exactly the sort of thing browsers disagree about. Listening on the document needs no such
  // agreement: the pointer is over the canvas by then anyway.

  let drag: {
    item: PaletteItem
    row: Row
    pointerId: number
    startX: number
    startY: number
    ghost: HTMLElement | null
  } | null = null

  function onRowPointerDown(row: Row, event: PointerEvent): void {
    if (event.button !== 0) return
    activeIndex = rows.indexOf(row)
    applyActive()
    // A CATEGORY opens on click, which is the only thing a click on it can mean. The guard above
    // used to reject anything that was not an item before reaching here, so a category row --
    // which carries a chevron, hover styling and aria-haspopup, and opens perfectly well from the
    // keyboard -- did nothing at all when clicked. `activate` has handled both kinds all along;
    // it was simply unreachable from a pointer.
    //
    // Handled on pointerdown rather than on click for the same reason the rest of this menu is:
    // the panel closes itself as a drag begins, and a click event arriving after that has no row
    // left to land on.
    if (row.target.kind === 'category') {
      activate(row, { x: event.clientX, y: event.clientY }, 'click')
      return
    }
    if (row.target.kind !== 'item') return
    // A BLOCKED row is still pressable and still moves the active row onto itself: that is how
    // its reason gets announced. It just never becomes a drag and never creates anything.
    if (!row.selectable) return
    drag = {
      item: row.target.item,
      row,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ghost: null,
    }
    doc.addEventListener('pointermove', onDocumentPointerMove)
    doc.addEventListener('pointerup', onDocumentPointerUp)
    doc.addEventListener('pointercancel', onDocumentPointerCancel)
    // Stops the press selecting the row's text, which would otherwise turn every drag into a
    // text selection halfway across the menu.
    event.preventDefault()
  }

  function onDocumentPointerMove(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (drag.ghost === null) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      // Past the threshold: this is a drag. Hide the panel so the author can see the spot they
      // are dropping onto, but keep the menu "open" so Escape still cancels.
      const ghost = doc.createElement('div')
      ghost.className = 'flp-ghost'
      ghost.textContent = drag.item.title
      container.append(ghost)
      drag.ghost = ghost
      root.hidden = true
    }
    drag.ghost.style.left = `${event.clientX + 12}px`
    drag.ghost.style.top = `${event.clientY + 12}px`
  }

  function onDocumentPointerUp(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return
    const dragged = drag.ghost !== null
    const item = drag.item
    const row = drag.row
    endDrag()
    if (!dragged) {
      // Never travelled far enough to be a drag: a plain click, which creates at the point the
      // MENU was opened rather than wherever the pointer drifted to inside it. Panning the
      // camera between opening and clicking still lands it correctly, because the conversion
      // reads the camera now, not then.
      activate(row, openPoint, 'click')
      return
    }
    const point = { x: event.clientX, y: event.clientY }
    // A release outside the canvas is a cancelled drag, not a node dropped at the nearest edge.
    if (!withinViewport(point)) {
      close()
      return
    }
    emit(item, point, 'drop')
    close()
  }

  function onDocumentPointerCancel(): void {
    endDrag()
  }

  function withinViewport(point: GraphPoint): boolean {
    const box = options.viewport.element.getBoundingClientRect()
    return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
  }

  function endDrag(): void {
    doc.removeEventListener('pointermove', onDocumentPointerMove)
    doc.removeEventListener('pointerup', onDocumentPointerUp)
    doc.removeEventListener('pointercancel', onDocumentPointerCancel)
    if (drag === null) return
    drag.ghost?.remove()
    drag = null
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function onListPointerDown(event: PointerEvent): void {
    const row = rowFromEvent(event)
    if (row !== undefined) onRowPointerDown(row, event)
  }

  function rowFromEvent(event: Event): Row | undefined {
    const target = event.target
    if (!(target instanceof Element)) return undefined
    const el = target.closest('.flp-row')
    if (el === null) return undefined
    return rows.find((r) => r.element === el)
  }

  function onKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        move(1)
        event.preventDefault()
        return
      case 'ArrowUp':
        move(-1)
        event.preventDefault()
        return
      case 'Home':
        activeIndex = 0
        applyActive()
        event.preventDefault()
        return
      case 'End':
        activeIndex = Math.max(0, rows.length - 1)
        applyActive()
        event.preventDefault()
        return
      case 'ArrowRight':
      case 'Enter': {
        const row = rows[activeIndex]
        if (row !== undefined) {
          // ArrowRight only opens a category; on an entry it belongs to the text box's caret.
          if (event.key === 'ArrowRight' && row.target.kind !== 'category') return
          activate(row, openPoint, 'click')
          event.preventDefault()
        }
        return
      }
      case 'ArrowLeft':
        // Only when the caret is at the start, or ArrowLeft could never move through typed text.
        if (filter.selectionStart !== 0 || filter.selectionEnd !== 0) return
        goBack()
        event.preventDefault()
        return
      case 'Backspace':
        if (filter.value.length > 0) return
        goBack()
        event.preventDefault()
        return
      case 'Escape':
        close()
        event.preventDefault()
        return
      default:
        return
    }
  }

  function onInput(): void {
    activeIndex = 0
    draw()
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    if (!open || drag !== null) return
    const target = event.target
    if (target instanceof Node && root.contains(target)) return
    close()
  }

  list.addEventListener('pointerdown', onListPointerDown)
  filter.addEventListener('keydown', onKeyDown)
  filter.addEventListener('input', onInput)
  back.addEventListener('click', goBack)
  doc.addEventListener('pointerdown', onDocumentPointerDown, true)

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  function position(screen: GraphPoint): void {
    // Measured, then flipped if it would run off. A menu opened near the bottom of a short
    // webview that renders half off-screen is a menu whose last category cannot be reached.
    root.style.left = '0px'
    root.style.top = '0px'
    const box = root.getBoundingClientRect()
    const view = { w: doc.documentElement.clientWidth, h: doc.documentElement.clientHeight }
    const x = screen.x + box.width > view.w ? Math.max(0, screen.x - box.width) : screen.x
    const y = screen.y + box.height > view.h ? Math.max(0, screen.y - box.height) : screen.y
    root.style.left = `${x}px`
    root.style.top = `${y}px`
  }

  function openAt(screen: GraphPoint): void {
    if (disposed) return
    openPoint = { x: screen.x, y: screen.y }
    open = true
    level = null
    activeIndex = 0
    filter.value = ''
    root.hidden = false
    draw()
    position(screen)
    filter.focus()
  }

  function close(): void {
    if (!open) return
    endDrag()
    open = false
    root.hidden = true
    options.onClose?.()
  }

  return {
    element: root,
    openAt,
    close,
    isOpen: () => open,
    setModel(next: PaletteModel): void {
      model = next
      level = null
      activeIndex = 0
      if (open) draw()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      endDrag()
      open = false
      doc.removeEventListener('pointerdown', onDocumentPointerDown, true)
      root.remove()
    },
  }
}
