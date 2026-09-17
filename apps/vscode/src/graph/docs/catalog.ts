// catalog.ts -- the hover documentation for the visual feature editor: what a parameter IS, and
// what each of its values DOES.
//
// WHY THIS IS A SEPARATE MODULE FROM typeCatalog.ts. That file is a fact sheet about the schema:
// which keys exist, at which format_version, with which bounds and which absent-key default. It
// carries a sparse `doc?: string` for the handful of keys where a schema fact alone would mislead,
// and its `values?: readonly string[]` is a bare list of strings with nowhere to hang an
// explanation. So `fixed_grid` appears in the editor as a word in a dropdown and nothing tells an
// author what it does.
//
// This module fills that gap without touching the fact sheet. It is keyed by (typeId, fieldPath)
// and (typeId, fieldPath, value), and joined to typeCatalog at lookup time. Two things fall out of
// that split and both are worth having:
//
//   - prose and schema facts stay separable. A correction to a bound is a data edit over there; a
//     correction to an explanation is a data edit here, and neither touches the other.
//   - a field shared by many types is documented ONCE. `may_replace` is a key on five types and
//     `places_block` on six; the shared table below holds one entry each and the lookup resolves
//     it, rather than the same paragraph being pasted twenty-nine times and then drifting.
//
// NOTHING HERE DUPLICATES typeCatalog. `FieldSpec.doc` and `FieldSpec.default` already say several
// things well -- and several of the defaults are the opposite of the obvious guess, which is
// exactly when they earn their keep. A lookup returns BOTH this module's entry and the FieldSpec,
// so a hover can render the fact sheet and the explanation together and neither has to restate the
// other. Where the fact sheet already answers "what is this and what would I write", there is no
// entry here at all, and the coverage test accepts that.
//
// THE LANGUAGE RULE, which is a release constraint and not a style note. This is a user-facing
// surface: every string below is rendered into a hover card a pack author reads. It may say what
// the engine DOES. It may not say how that behaviour came to be known, name an engine symbol, an
// address, an offset or a tool, or point at anything outside what ships. docsLanguage.test.ts
// enforces exactly that, mirroring the guard the Go side already applies to its own user-facing
// strings.
//
// "NOT ESTABLISHED" IS A REAL ANSWER. An entry may set `unestablished: true` and say what is not
// known. The coverage test accepts one, deliberately: a documented gap tells an author to go and
// check, where an invented explanation tells them to stop checking. What the test does NOT accept
// is silence, and what this file must never contain is filler -- "The distribution field." is not
// documentation, it is the counter being gamed.

import type { FieldSpec, TypeSpec } from '../typeCatalog'
import { TREE_TRUNK_DOCS, TREE_TRUNK_VALUE_DOCS } from '../treeTrunks.js'
import { TREE_CANOPY_DOCS, TREE_CANOPY_VALUE_DOCS } from '../treeCanopies.js'
import { TREE_GROUND_DOCS } from '../treeGroundAndRoots.js'
import { typeSpec } from '../typeCatalog'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One piece of documentation: a line, then optionally more.
 *
 * `summary` is the first line of the hover and has to stand alone -- it is what the author reads
 * before deciding whether to read further. `detail` is where the consequence goes: what moves, what
 * the surprising case is, what to write instead. */
export interface DocEntry {
  /** One line, no trailing context needed. */
  readonly summary: string
  /** Optional further detail. Rendered under the summary. */
  readonly detail?: string
  /** Set when this entry records that the behaviour is NOT established, rather than explaining it.
   * `summary` then says what is unknown and what an author should do about it. */
  readonly unestablished?: true
}

/** Where a resolved entry was found. 'none' means this module has nothing and the caller is looking
 * at typeCatalog's own `doc` (or at no prose at all). */
export type DocSource = 'type' | 'shared' | 'none'

/** The answer to "what is this parameter". Carries both halves: this module's prose and the
 * FieldSpec it belongs to, so a hover can show the explanation next to the schema facts (kind,
 * required, bounds, default, version gates) without either restating the other. */
export interface FieldDoc {
  readonly typeId: string
  /** The dotted path asked for, normalised -- array indices dropped. */
  readonly path: string
  /** The last segment of `path`. */
  readonly key: string
  readonly entry?: DocEntry
  /** The FieldSpec this path names, when typeCatalog models it. A key gated by format_version is
   * catalogued twice (the old spelling and the new); this resolves to the FIRST, because the two
   * share one explanation -- a caller that needs the version-appropriate spec has
   * typeCatalog.resolveFields for that. */
  readonly spec?: FieldSpec
  readonly source: DocSource
  /** True when a reader gets a real explanation from somewhere: an entry here, or the FieldSpec's
   * own `doc`. This is what the coverage test counts. */
  readonly documented: boolean
}

/** The answer to "what does THIS value mean". */
export interface ValueDoc {
  readonly typeId: string
  readonly path: string
  readonly key: string
  readonly value: string
  readonly entry?: DocEntry
  readonly source: DocSource
  readonly documented: boolean
}

// ---------------------------------------------------------------------------
// Small builders -- shared text, generated once, never pasted
// ---------------------------------------------------------------------------

/** One value of `coordinate_eval_order`. The six differ only in which axis goes where, and every
 * consequence follows from that, so they are generated from the order string itself. */
function evalOrderDoc(order: string): DocEntry {
  const first = order[0] as string
  const second = order[1] as string
  const third = order[2] as string
  return {
    summary: `Evaluates ${first}, then ${second}, then ${third}.`,
    detail:
      `Each axis draws when its turn comes, so the order decides which draw feeds which axis and ` +
      `placements MOVE when you change it -- this is not a cosmetic setting. The engine also writes ` +
      `variable.world${first} as soon as ${first} is known, so ${second} and ${third} can read it while ` +
      `${first}'s own expression can read neither of theirs. For grid distributions the cell index is ` +
      `handed on in this same order, which is what makes two or three grid axes walk a lattice ` +
      `together rather than repeat the same row.`,
  }
}

/** One direction key of `may_attach_to` / `may_not_attach_to`. The two maps run the same ten
 * neighbours through opposite tests, so both sets are generated from one description of the
 * neighbour and one description of the test. */
function attachDirectionDoc(
  map: 'may_attach_to' | 'may_not_attach_to',
  what: string,
  role: 'hard' | 'counted' | 'group-all' | 'group-sides',
): DocEntry {
  const allow = map === 'may_attach_to'
  const head = allow
    ? `Blocks that count as something to attach to ${what}.`
    : `Blocks that BLOCK placement when found ${what}.`
  const tail = allow
    ? {
        hard: 'This is a hard gate: if the list is configured and the neighbour does not match, the block is not placed at all.',
        counted:
          'This is one of the four counted sides. It is not a gate on its own -- north, east, south and west each match or not, and the number that match has to reach min_sides_must_attach. A side with no list configured counts as matching for free.',
        'group-all':
          'A group key, not a direction: it applies to all ten neighbours at once -- the six faces plus the four horizontal diagonals. It is consulted in addition to whatever the specific direction key says.',
        'group-sides':
          'A group key covering the four cardinal sides only -- north, east, south and west. It is consulted in addition to each of those four keys, and does not touch top, bottom or the diagonals.',
      }[role]
    : {
        hard: 'One match here is enough on its own: the placement is refused the moment any configured deny list matches its neighbour.',
        counted:
          'One match here is enough on its own. Unlike may_attach_to, nothing is counted -- there is no minimum to reach and no free pass for an unconfigured side.',
        'group-all':
          'A group key, not a direction: it denies against all ten neighbours at once -- the six faces plus the four horizontal diagonals.',
        'group-sides':
          'A group key covering the four cardinal sides only -- north, east, south and west.',
      }[role]
  return { summary: head, detail: tail }
}

/** One value of search_feature's `search_axis`. Every value is the same triple-nested scan with a
 * different (outer, middle, inner) assignment, and the assignment is the whole content. */
function searchAxisDoc(outer: string, middle: string, inner: string): DocEntry {
  return {
    summary: `Scans ${outer} on the outside, ${middle} in the middle and ${inner} innermost.`,
    detail:
      `The scan stops at the first position that satisfies the wrapped feature (or at the ` +
      `required_successes-th one), so this order is what decides WHICH of several workable ` +
      `positions gets used. Two patterns are worth knowing because neither is guessable from the ` +
      `value name: the innermost loop always counts upward whatever the axis sign says, and for ` +
      `the two z values the middle loop runs opposite to the outer one.`,
  }
}

/** Both of single_block_feature's attach maps, as (path -> entry).
 *
 * The two objects carry the same ten neighbour keys under opposite tests, so the eighteen entries
 * are generated from one table of neighbours rather than written out as the same paragraph eighteen
 * times with two words changed. */
function attachMapDocs(): Record<string, DocEntry> {
  const rows: readonly (readonly [string, string, 'hard' | 'counted' | 'group-all' | 'group-sides'])[] = [
    ['top', 'directly above', 'hard'],
    ['bottom', 'directly below', 'hard'],
    ['north', 'to the north', 'counted'],
    ['east', 'to the east', 'counted'],
    ['south', 'to the south', 'counted'],
    ['west', 'to the west', 'counted'],
    ['all', 'in any direction', 'group-all'],
    ['sides', 'to any side', 'group-sides'],
    ['diagonal', 'at a horizontal diagonal', 'hard'],
  ]
  const out: Record<string, DocEntry> = {}
  for (const map of ['may_attach_to', 'may_not_attach_to'] as const) {
    for (const [key, where, role] of rows) {
      out[`${map}.${key}`] = attachDirectionDoc(map, where, role)
    }
  }
  return out
}

/** One value of partially_exposed_blob_feature's `exposed_face`. */
function exposedFaceDoc(face: string): DocEntry {
  return {
    summary: `Leaves the ${face} neighbour out of the water test.`,
    detail:
      `The position itself and its other five neighbours must each NOT be water, or nothing is ` +
      `placed there. The named face is simply skipped -- it is neither required to be water nor ` +
      `required not to be -- which is what "exposed" means here: the blob may legitimately touch ` +
      `water in this one direction and nowhere else.`,
  }
}

/** One value of multipart_block_column_feature's `direction`. */
function columnDirectionDoc(direction: string, support: string): DocEntry {
  return {
    summary: `Builds the column ${direction} from the origin.`,
    detail:
      `Every part is written one step further along that line: the base first, then any middle ` +
      `parts, then the frustum, then the tip at the far end. The block that has to support the ` +
      `column is the one ${support} -- one step BEHIND the origin, against the build direction.`,
  }
}

// ---------------------------------------------------------------------------
// Field documentation -- shared across types
// ---------------------------------------------------------------------------

/** Keyed by a dotted path or, where the key means the same thing wherever it appears, by the bare
 * key. A bare key matches that key at ANY depth, which is what lets one `weight` entry serve every
 * weighted list. Type-specific entries below win over anything here. */
const SHARED_FIELD_DOCS: Readonly<Record<string, DocEntry>> = {
  // ---- block descriptors and lists, shared by most types ----
  may_replace: {
    summary: 'The blocks this feature is allowed to overwrite.',
    detail:
      'An empty list, and an absent key, both mean NO constraint -- the feature overwrites whatever ' +
      'it lands on. Listing blocks narrows it; there is no way to spell "replace nothing" here.',
  },
  may_place_on: {
    summary: 'The blocks this feature will accept as the thing it stands on.',
    detail: 'Absent or empty means no constraint on what is underneath.',
  },

  // ---- weighted lists ----
  block: {
    summary: 'One block of a weighted choice.',
    detail:
      'Accepted as a bare name string, as `{name, states}`, or as `{tags: "<Molang query>"}`. All ' +
      'three spellings are legal wherever a block descriptor is asked for.',
  },
  weight: {
    summary: 'This entry\'s share of the weighted draw.',
    detail:
      'Relative, not a percentage: an entry is picked with its weight divided by the total of all ' +
      'the weights in the list. Weights need not add to anything in particular.',
  },

  // ---- the scatter distribution axes, reached at several paths ----
  distribution: {
    summary: 'How this axis turns the iteration into a coordinate.',
    detail:
      'Six kinds, and they differ in how many random draws they spend as well as in where they put ' +
      'things: uniform takes one, gaussian / inverse_gaussian / triangle take two (plus one more for ' +
      'inverse_gaussian on an exact tie), fixed_grid takes none, and jittered_grid takes one only ' +
      'when step_size is 2 or more. Each kind is described below.',
  },
  extent: {
    summary: 'The low and high ends this axis works between, as an offset from the scatter origin.',
    detail:
      'Both ends are Molang-or-number and both are rounded to whole blocks before the distribution ' +
      'sees them. The two ends are NOT treated alike by every kind -- uniform excludes the top end, ' +
      'triangle includes it, and the grid kinds use `max - min + 1` as a wrap width -- so hover the ' +
      'distribution value before assuming an extent of [0, 4] means five positions.',
  },
  step_size: {
    summary: 'The gap between consecutive cells on a grid axis.',
    detail:
      'Read only by fixed_grid and jittered_grid; the other four kinds ignore it. On jittered_grid ' +
      'it is also the jitter bound, and a value below 2 turns the jitter off entirely, which makes ' +
      'that axis behave exactly like fixed_grid. Note the caveat on the default: it is NOT ' +
      'established, so write the value you mean rather than relying on it.',
  },
  grid_offset: {
    summary: 'Shifts a grid axis along by a fixed amount before it wraps.',
    detail:
      'Added to the cell position, and also carried into the index handed to the next axis, so it ' +
      'shifts the whole lattice rather than just the first placement. Read only by fixed_grid and ' +
      'jittered_grid. A negative value wraps around rather than producing a negative cell.',
  },

  // ---- carver fields, shared by the three carver types ----
  fill_with: {
    summary: 'The block written into each carved cell.',
    detail:
      'Leaving it out does NOT stop the carve: the cave is still shaped, sand is still capped and ' +
      'grass is still relocated onto the dirt below -- only the write itself is skipped, so the ' +
      'carved cells keep whatever was already there.',
  },
  width_modifier: {
    summary: 'Widens or narrows the tunnel.',
    detail:
      'A plain number is used as-is. A Molang string is evaluated for real -- once per room, and ' +
      'again at every step of a tunnel -- against a generator that is not tied to the world seed, ' +
      'so a non-constant expression previews a faithful EXAMPLE of the shape rather than the shape ' +
      'this seed will produce in game.',
  },
  skip_carve_chance: {
    summary: 'A one-in-N gate on the whole carve, not a percentage.',
    detail:
      'The carver draws a number below this value and proceeds only when that draw is zero, so the ' +
      'carve runs about one chunk-attempt in N and is skipped the rest of the time. Bigger means ' +
      'RARER. An explicit 0 is reported as failing the schema\'s own minimum of 1.',
  },
  height_limit: {
    summary: 'Caps how high a carve may reach.',
    detail:
      'The carved volume\'s ceiling is the lower of this and two below the world top. Mind the ' +
      'default: an absent height_limit is 0, not "unlimited", which pins every carve near Y=0.',
  },
  y_scale: {
    summary: 'Scales a room\'s vertical size, drawn once per room from this range.',
    detail: 'A zero-width range contributes nothing and costs no draw.',
  },
  horizontal_radius_multiplier: {
    summary: 'Multiplies the horizontal radius of each carve, drawn once per carve from this range.',
    detail: 'A zero-width range contributes nothing and costs no draw.',
  },
  vertical_radius_multiplier: {
    summary: 'Multiplies the vertical radius of each carve, drawn once per carve from this range.',
    detail: 'A zero-width range contributes nothing and costs no draw.',
  },
  floor_level: {
    summary: 'Flattens the bottom off each carved ellipsoid.',
    detail:
      'Measured as a fraction of the ellipsoid\'s own vertical radius, from -1 at the very bottom to ' +
      '+1 at the top: every cell at or below this height is left uncarved. The default of 0 is not ' +
      'neutral -- it removes the entire lower half of every carve. Write -1 for a full ellipsoid.',
  },
}

// ---------------------------------------------------------------------------
// Field documentation -- per type
// ---------------------------------------------------------------------------

/** Keyed by typeId, then by the field's exact dotted path within that type's body. An exact path
 * wins over anything in SHARED_FIELD_DOCS -- which is how `distribution` the scatter parameter
 * OBJECT and `distribution` the per-axis kind can both be documented without colliding. */
const TYPE_FIELD_DOCS: Readonly<Record<string, Readonly<Record<string, DocEntry>>>> = {
  'minecraft:aggregate_feature': {
    early_out: {
      summary: 'Whether the list stops before running every child.',
      detail:
        'With the default `none` every child runs and the aggregate reports the LAST one that ' +
        'succeeded. Each child is placed at the aggregate\'s own origin -- unlike ' +
        'minecraft:sequence_feature, which re-targets each child at the previous child\'s result.',
    },
  },

  'minecraft:conditional_list': {
    early_out_scheme: {
      summary: 'What ends the walk through the entries.',
      detail:
        'This is the switch between "a selector" and "an aggregate": under condition_success or ' +
        'placement_success at most one entry\'s placement is ever returned, while under the default ' +
        '`none` every entry whose condition passes places. An entry with no condition is always ' +
        'true, and a reference that does not resolve ends the whole list.',
    },
  },

  'minecraft:ore_feature': {
    count: {
      summary: 'How many ore blobs are strung along the vein.',
      detail:
        'The vein is a line between two endpoints, and this many spheres are spaced evenly along it ' +
        'and then merged. It is a count of BLOBS, not of blocks placed: overlapping spheres and ' +
        'rules that match nothing both mean fewer blocks than this number.',
    },
    discard_chance_on_air_exposure: {
      summary: 'Chance to skip a block that would sit next to air.',
      detail:
        'Rolled per position and per matching replace rule, not once for the vein. At 0 (the ' +
        'absent value) the exposure test never runs at all; at 1 it runs for every candidate and ' +
        'every air-touching block is dropped. Between the two, the roll decides whether the ' +
        'exposure test is even consulted for that block.',
    },
    'replace_rules.places_block': {
      summary: 'The ore block this rule writes.',
      detail: 'Written only where the position already holds one of the rule\'s own may_replace blocks.',
    },
    'replace_rules.may_replace': {
      summary: 'Which existing blocks this rule is willing to convert.',
      detail:
        'Rules are tried in order at each position and the first one whose list matches wins, so a ' +
        'broad rule listed first hides the narrower ones after it. A rule whose list is absent ' +
        'matches nothing and places nothing.',
    },
  },

  'minecraft:scatter_feature': {
    project_input_to_floor: {
      summary: 'Drops the scatter origin straight down onto the first block under it.',
      detail:
        'The origin moves down while the cell below it is air, stopping on the first block that is ' +
        'not -- or at the bottom of the world. Every offset the distribution then produces is ' +
        'measured from there, not from the position the scatter was handed.',
    },
    distribution: {
      summary: 'The parameter object holding the chance gate, the axis order and the three axes.',
      detail:
        'Everything about WHERE and HOW OFTEN lives in here, and so does the count: `iterations` ' +
        'belongs to the connection to the placed feature, where it can also carry the setup script ' +
        'real packs write into it, and the same box is drawn in this section so the value is ' +
        'reachable from the place the file keeps it.',
    },
    'distribution.x': {
      summary: 'How far east/west of the origin each iteration lands.',
      detail:
        'A bare number or Molang string pins the axis to that offset with no draw at all. The object ' +
        'form `{distribution, extent, ...}` is what makes it vary.',
    },
    'distribution.y': {
      summary: 'How far above/below the origin each iteration lands.',
      detail:
        'A bare number or Molang string pins the axis to that offset with no draw at all. The object ' +
        'form `{distribution, extent, ...}` is what makes it vary.',
    },
    'distribution.z': {
      summary: 'How far north/south of the origin each iteration lands.',
      detail:
        'A bare number or Molang string pins the axis to that offset with no draw at all. The object ' +
        'form `{distribution, extent, ...}` is what makes it vary.',
    },
    x: {
      summary: 'How far east/west of the origin each iteration lands (the pre-1.21.10 flat spelling).',
      detail: 'Identical in meaning to `distribution.x`; only the place it is written differs.',
    },
    y: {
      summary: 'How far above/below the origin each iteration lands (the pre-1.21.10 flat spelling).',
      detail: 'Identical in meaning to `distribution.y`; only the place it is written differs.',
    },
    z: {
      summary: 'How far north/south of the origin each iteration lands (the pre-1.21.10 flat spelling).',
      detail: 'Identical in meaning to `distribution.z`; only the place it is written differs.',
    },
  },

  'minecraft:search_feature': {
    search_volume: {
      summary: 'The box of positions to try, relative to the origin.',
      detail:
        'Both corners are offsets, so negative numbers are normal and are how you search below or ' +
        'behind the origin. Every position in the box is tried unless the search finishes early.',
    },
    'search_volume.min': {
      summary: 'The low corner of the search box, as [x, y, z] offsets.',
      detail: 'Not a minimum in the sense of a bound to satisfy -- it is one corner of the volume walked.',
    },
    'search_volume.max': {
      summary: 'The high corner of the search box, as [x, y, z] offsets.',
      detail: 'Not a maximum in the sense of a bound to satisfy -- it is the other corner of the volume walked.',
    },
    search_axis: {
      summary: 'The order positions inside the volume are tried in.',
      detail:
        'It does not restrict the search to one axis: every position in the volume is still visited. ' +
        'What it picks is which axis is the outermost loop and which way each loop counts -- and ' +
        'because the search stops at the first position that works, that is what decides which ' +
        'position gets used.',
    },
    required_successes: {
      summary: 'How many positions have to work before the search commits.',
      detail:
        'Everything the wrapped feature writes is held back until the target is reached; a search ' +
        'that runs out of positions first throws all of it away, so a partly-finished result is ' +
        'never left in the world.',
    },
  },

  'minecraft:single_block_feature': {
    // The eighteen direction keys of the two attach maps, generated. They come first so that the
    // two hand-written entries below can still override what lands on a key of their own.
    ...attachMapDocs(),
    places_block: {
      summary: 'The block this feature writes at the position it is given.',
      detail:
        'Any rotation this feature applies -- from auto_rotate or randomize_rotation -- is applied ' +
        'to this block, which only works if the block type carries a direction state to write.',
    },
    randomize_rotation: {
      summary: 'Turns the block a random quarter-turn before placing it.',
      detail:
        'It also turns auto_rotate OFF: attach-driven rotation only happens when randomize_rotation ' +
        'is not set. A block type with no direction state cannot be rotated and the flag is dropped.',
    },
    may_replace: {
      summary: 'The blocks this feature is allowed to overwrite.',
      detail: 'An empty list, and an absent key, both mean no constraint at all.',
    },
    may_attach_to: {
      summary: 'Neighbour blocks that make this a valid position to place in.',
      detail:
        'Writing the key at all -- even as `{}` -- switches the whole attach test on, and with it ' +
        'auto_rotate. Top, bottom and the four diagonals are hard gates; north, east, south and west ' +
        'are counted against min_sides_must_attach instead.',
    },
    may_not_attach_to: {
      summary: 'Neighbour blocks that make this an invalid position.',
      detail:
        'The mirror image of may_attach_to and much blunter: there is no counting and no minimum. ' +
        'One configured list matching its neighbour refuses the placement outright. Note that this ' +
        'key only exists from format_version 1.21.40; in an older file it is dropped, and dropped ' +
        'with it is its power to switch the attach test on at all.',
    },
    // The schema puts min_sides_must_attach and auto_rotate on BOTH attach objects, because both
    // are built from the same node shape. What the copies under may_not_attach_to do is a real
    // question with no answer here, and guessing either way would be worse than saying so: guessing
    // "ignored" invites an author to leave a broken file alone, guessing "the same setting" invites
    // them to write it in a place that may do nothing.
    'may_not_attach_to.min_sides_must_attach': {
      summary: 'Accepted here, but what it does in this object is NOT established.',
      detail:
        'Side counting belongs to the attach test, and the only copy of this setting that is ' +
        'certainly read is the one inside may_attach_to. Whether a value written here reaches the ' +
        'same setting, or is simply accepted and ignored, has not been established. Write it under ' +
        'may_attach_to, where its effect is known.',
      unestablished: true,
    },
    'may_not_attach_to.auto_rotate': {
      summary: 'Accepted here, but what it does in this object is NOT established.',
      detail:
        'The rotation it controls belongs to the attach test, and the only copy of this setting ' +
        'that is certainly read is the one inside may_attach_to. Whether a value written here ' +
        'reaches the same setting, or is simply accepted and ignored, has not been established. ' +
        'Write it under may_attach_to, where its effect is known.',
      unestablished: true,
    },
  },

  'minecraft:snap_to_surface_feature': {
    search_range: {
      summary: 'How many blocks the scan may travel looking for a surface.',
      detail:
        'Counted in blocks from the starting position along the chosen direction. The scan gives up ' +
        'once it has gone this far and the feature then places nothing.',
    },
    vertical_search_range: {
      summary: 'How many blocks the scan may travel looking for a surface (the pre-1.26.50 spelling).',
      detail: 'The same setting as `search_range`; only the key name differs by version.',
    },
    surface: {
      summary: 'Which surface the scan is looking for.',
      detail:
        'This picks the direction the scan walks as well as which side of the surface the feature ' +
        'ends up on. `random_horizontal` is the odd one -- see its own description.',
    },
    allowed_surface_blocks: {
      summary: 'Restricts which blocks count as the surface to snap to.',
      detail: 'Leave it out to accept any block that can genuinely support something on the face the scan arrived at.',
    },
    allow_air_placement: {
      summary: 'Whether the scan may start from a position that is open air.',
      detail:
        'On by default when the key is absent. Turning it off makes a scan that begins in the open ' +
        'fail at once, before it takes a single step.',
    },
    allow_underwater_placement: {
      summary: 'Whether water counts as open space the scan may pass through.',
      detail:
        'Off by default. It means WATER specifically -- lava is never passable to this scan, whatever ' +
        'this is set to.',
    },
    embed_in_surface: {
      summary: 'Places into the surface block itself instead of the open cell beside it.',
      detail: 'Off by default, which leaves the feature sitting on the surface rather than sunk into it.',
    },
  },

  'minecraft:structure_template_feature': {
    structure_name: {
      summary: 'Which saved structure to stamp down.',
      detail: 'Named the way the structure is stored in the pack, without a file extension.',
    },
    facing_direction: {
      summary: 'Which way the structure is turned before it is placed.',
      detail:
        '`south` is the stored, unrotated orientation; the other three are quarter turns from it. ' +
        '`random` is the only value that costs a random draw, and it is taken before the position ' +
        'search and before any constraint is checked.',
    },
    rotate_around_center: {
      summary: 'Turns the structure about its own centre rather than about its corner.',
      detail:
        'With it on, the structure is shifted by half its horizontal size before being turned, so ' +
        'it ends up centred on the position. With it off the position IS the structure\'s corner, ' +
        'and a rotation swings the whole body around that corner.',
    },
    constraints: {
      summary: 'Tests the candidate position has to pass before anything is stamped down.',
      detail:
        'Each one you write is an extra requirement; all of them must hold. Adding none means the ' +
        'structure is placed wherever it is asked for.',
    },
    ground_level: {
      summary: 'Which row of the structure counts as its ground row.',
      detail:
        'Used by the `grounded` and `leveled` constraints, which sample this row of the structure ' +
        'and test the world one row below it. It does not move the structure, and it is clamped to ' +
        'the structure\'s own height, so a value past the top simply means the top row.',
    },
    adjustment_radius: {
      summary: 'How far sideways the placement may shift to find a spot the constraints accept.',
      detail:
        'The asked-for position is tried first and then cells around it, out to this radius, until ' +
        'one passes. At 0 there is no search: the position either works or the feature places nothing.',
    },
    'constraints.grounded': {
      summary: 'Requires solid ground directly under the structure.',
      detail:
        'Every column that has a block on the structure\'s ground row is checked one row below the ' +
        'structure, and every one of those has to be a block that blocks movement. One column ' +
        'hanging over a hole refuses the whole placement.',
    },
    'constraints.unburied': {
      summary: 'Requires open air directly above the structure.',
      detail:
        'Every column that has a block on the structure\'s top row is checked one row above the ' +
        'structure, and every one of those has to be air. It is a fixed row, so a structure whose ' +
        'top row is mostly empty is barely constrained by it.',
    },
    'constraints.block_intersection': {
      summary: 'Requires every cell the structure would occupy to hold an allowed block.',
      detail: 'The only constraint that looks at the whole volume rather than at one row of it.',
    },
    'constraints.block_intersection.only_check_intersection_for_motion_blocking_blocks': {
      summary: 'Narrows the intersection test to the cells that would block movement.',
      detail:
        'The structure\'s cells are split in two: the ones that block movement, and every other ' +
        'non-empty cell, explicitly-written air included. This flag picks which half is tested ' +
        'against the allow list -- and it defaults to the narrow half, so a decorative overhang ' +
        'passes a test you may have expected it to fail.',
    },
    'constraints.leveled': {
      summary: 'Requires the ground under the structure to be flat enough.',
      detail:
        'Checked per column at the same row `grounded` samples: each one has to have solid ground ' +
        'with open space above it within max_steepness, and one bad column refuses the whole placement.',
    },
  },

  'minecraft:surface_relative_threshold_feature': {
    minimum_distance_below_surface: {
      summary: 'How far under the surface the position has to be before the wrapped feature runs.',
      detail:
        'The test is strict: the origin must be MORE than this many blocks below the surface, so a ' +
        'value of 0 still requires the position to be at least one block under it. The surface ' +
        'height is sampled on a coarse grid -- one value per four-by-four column of the world -- so ' +
        'a position near a cliff edge is measured against the whole cell rather than against the ' +
        'column it is standing in.',
    },
  },

  'minecraft:height_difference_filter_feature': {
    search_radius: {
      summary: 'How far out to sample the terrain height, in blocks.',
      detail:
        'The four horizontal compass directions are walked one step at a time out to this distance, ' +
        'and the height at every step is tested. Below 1 nothing is sampled: the gate then passes ' +
        'unless one of the upward requirements was configured, in which case it can never pass.',
    },
    min_required_upward_height_diff: {
      summary: 'Requires the ground to rise at least this far somewhere within the radius.',
      detail:
        'Satisfied by any ONE sampled position, not by all of them -- it is a "somewhere nearby" ' +
        'test. Leaving it out satisfies it automatically.',
    },
    min_required_downward_height_diff: {
      summary: 'Refuses the position if the ground anywhere within the radius sits higher than this allows.',
      detail:
        'Unlike the two `min_required_upward` / `max_allowed_upward` keys, this one fails HARD on the ' +
        'first sample that breaks it, aborting the rest of the scan. Leaving it out disables it.',
    },
    max_allowed_upward_height_diff: {
      summary: 'Requires the ground to stay at or below this height somewhere within the radius.',
      detail:
        'Like its `min_required_upward` counterpart it only has to hold at one sampled position, and ' +
        'leaving it out satisfies it automatically.',
    },
    max_allowed_downward_height_diff: {
      summary: 'Refuses the position if the ground anywhere within the radius drops further than this.',
      detail: 'Another hard fail: the first sample that breaks it ends the scan. Leaving it out disables it.',
    },
  },

  'minecraft:partially_exposed_blob_feature': {
    places_block: {
      summary: 'The block the blob is made of.',
      detail: 'Every position that passes the water test is written with it; there is no second block.',
    },
    placement_radius_around_floor: {
      summary: 'How wide the blob spreads, measured from one below the origin.',
      detail:
        'The blob is grown around the cell directly BELOW the placement origin -- the floor -- not ' +
        'around the origin itself, so it sits under the position it is asked for.',
    },
    placement_probability_per_valid_position: {
      summary: 'Chance that any one position inside the radius is actually filled.',
      detail: 'Rolled independently per position, which is what makes the blob ragged instead of a solid ball.',
    },
    exposed_face: {
      summary: 'The one direction the blob is allowed to touch water in.',
      detail:
        'Every other neighbour, and the position itself, must not be water. So this is not a facing ' +
        'or an orientation -- it is the single exemption from an otherwise all-round water test.',
    },
  },

  'minecraft:tree_feature': {
    base_block: {
      summary: 'The block laid under the trunk once the tree is built.',
      detail:
        'A finishing touch applied after the trunk and canopy are in place, so it overwrites ' +
        'whatever the ground turned out to be rather than deciding where the tree may grow -- that ' +
        'is may_grow_on.',
    },
    may_grow_on: {
      summary: 'Blocks the tree is willing to root on.',
      detail:
        'Tested at the ground under the trunk. If the ground does not pass, the first entry in this ' +
        'list is placed there to make it pass -- so this list also decides what a tree stands on ' +
        'when it lands somewhere unsuitable.',
    },
    may_grow_through: {
      summary: 'Blocks the trunk may push through on its way up.',
      detail:
        'Applies BELOW the tree\'s own origin. At and above the origin the trunk is governed by ' +
        'may_replace instead, which is the distinction that catches people out when a trunk stops ' +
        'short in undergrowth.',
    },
    may_replace: {
      summary: 'Blocks the tree may overwrite at and above its origin.',
      detail: 'Below the origin it is may_grow_through that decides instead.',
    },
    base_cluster: {
      summary: 'A patch of base blocks laid around the foot of the trunk.',
      detail:
        'Takes `may_replace`, plus `num_clusters` and `cluster_radius` as plain whole numbers (not ' +
        'ranges). Only the mega trunk builds it -- written alongside any other trunk shape it is ' +
        'parsed and then never used.',
    },
    mangrove_roots: {
      summary: 'The stilt roots under a mangrove, built before the trunk and able to move its base.',
      detail:
        'Its own keys are `max_root_width`, `max_root_length`, `root_block`, `muddy_root_block`, ' +
        '`mud_block`, `y_offset` and `roots_may_grow_through` (all required), plus the optional ' +
        '`above_root` and `root_decoration` objects. The roots grow outward in the four horizontal ' +
        'directions in a fixed order.',
    },
    trunk: {
      summary: 'The plain trunk: a straight column, optionally able to start below water.',
      detail:
        'The bare key is the SIMPLE trunk shape -- not a default that becomes something else. Its ' +
        'own keys are `trunk_height` (a required range), `trunk_block` (required), and the optional ' +
        '`height_modifier`, `can_be_submerged` and `trunk_decoration`.',
    },
    acacia_trunk: {
      summary: 'The leaning, branching acacia trunk shape.',
      detail:
        'A different key set from the plain trunk: it requires `trunk_width`, an OBJECT-form ' +
        '`trunk_height` and `trunk_lean`, and has no `can_be_submerged` at all. The remaining ' +
        'sub-keys are not catalogued here.',
    },
    cherry_trunk: { summary: 'The cherry trunk shape, which forks into weighted branch variants.', detail: 'Its own sub-keys are not catalogued here.' },
    fallen_trunk: { summary: 'A trunk lying on its side instead of standing up.', detail: 'Its own sub-keys are not catalogued here.' },
    fancy_trunk: { summary: 'The large branching "fancy" oak trunk shape.', detail: 'Its own sub-keys are not catalogued here.' },
    mega_trunk: {
      summary: 'The wide multi-column trunk shape.',
      detail: 'The only shape that builds `base_cluster`. Its own sub-keys are not catalogued here.',
    },
    mangrove_trunk: { summary: 'The mangrove trunk shape, the one that pairs with mangrove_roots.', detail: 'Its own sub-keys are not catalogued here.' },
    poplar_trunk: { summary: 'The poplar trunk shape, added in game version 1.26.50.', detail: 'Its own sub-keys are not catalogued here.' },
    canopy: { summary: 'The generic canopy: a blob of leaves over the top of the trunk.', detail: 'The bare key is the default shape. Its own sub-keys are not catalogued here.' },
    acacia_canopy: { summary: 'The flat, spreading acacia canopy shape.', detail: 'Its own sub-keys are not catalogued here.' },
    cherry_canopy: { summary: 'The cherry canopy shape.', detail: 'Its own sub-keys are not catalogued here.' },
    fancy_canopy: { summary: 'The canopy shape that pairs with the fancy trunk\'s branches.', detail: 'Its own sub-keys are not catalogued here.' },
    mangrove_canopy: { summary: 'The mangrove canopy shape, which can carry its own decoration.', detail: 'Its own sub-keys are not catalogued here.' },
    mega_canopy: { summary: 'The broad canopy shape for a wide trunk.', detail: 'Its own sub-keys are not catalogued here.' },
    mega_pine_canopy: { summary: 'The tall conical canopy shape for a wide trunk.', detail: 'Its own sub-keys are not catalogued here.' },
    pine_canopy: { summary: 'The narrow conical pine canopy shape.', detail: 'Its own sub-keys are not catalogued here.' },
    poplar_canopy: { summary: 'The poplar canopy shape, added in game version 1.26.50.', detail: 'Its own sub-keys are not catalogued here.' },
    roofed_canopy: { summary: 'The thick flat-topped canopy shape of a dark forest.', detail: 'Its own sub-keys are not catalogued here.' },
    spruce_canopy: { summary: 'The layered spruce canopy shape.', detail: 'Its own sub-keys are not catalogued here.' },
    random_spread_canopy: { summary: 'A canopy of leaves scattered around the top rather than shaped.', detail: 'Its own sub-keys are not catalogued here.' },
    // The eight trunk variants' own keys, from treeTrunks.ts. Spread LAST so the entries
    // above -- which say each variant's sub-keys are not catalogued -- are replaced rather than
    // merged on top of. That sentence stopped being true.
    ...TREE_TRUNK_DOCS,
    ...TREE_CANOPY_DOCS,
    ...TREE_GROUND_DOCS,
  },

  'minecraft:vegetation_patch_feature': {
    replaceable_blocks: {
      summary: 'The blocks the patch may dig its ground layer into.',
      detail:
        'A column stops filling at the first block that is neither ground_block nor in this list. ' +
        'A column that could not fill even one cell is dropped, so an over-narrow list quietly ' +
        'shrinks the patch.',
    },
    ground_block: {
      summary: 'The block the patch\'s ground layer is made of.',
      detail: 'Written downward from the supporting cell, `depth` cells deep.',
    },
    depth: {
      summary: 'How many cells of ground_block each column lays down.',
      detail:
        'Drawn per column from this range. A depth of 0 still keeps the column and still grows ' +
        'vegetation on it -- it just writes no ground.',
    },
    horizontal_radius: {
      summary: 'How wide the patch is, drawn separately for x and z.',
      detail:
        'The patch is wider than this number suggests: each drawn radius is used plus one, so a ' +
        'horizontal_radius of 0 is still a 3x3 patch. The extra outermost ring is the one ' +
        'extra_edge_column_chance gates, and the corners are always trimmed.',
    },
    vertical_range: {
      summary: 'How far a column may search up or down for the ground.',
      detail:
        'Used twice: first descending while the cells are open, then climbing back out if that ' +
        'landed inside solid ground. A column that is still buried after that many steps is dropped.',
    },
    surface: {
      summary: 'Whether the patch grows from the floor or hangs from the ceiling.',
      detail: 'It flips the direction of the search, of the ground fill and of the vegetation together.',
    },
    vegetation_chance: {
      summary: 'Chance to grow the attached feature on any one ground cell.',
      detail:
        'Mind the default: 0 means NO vegetation at all -- the patch lays its ground layer and ' +
        'nothing else. Rolled per cell.',
    },
    extra_deep_block_chance: {
      summary: 'Chance for a column to dig one cell deeper than `depth`.',
      detail: 'Rolled per column, and adds exactly one cell when it hits.',
    },
    extra_edge_column_chance: {
      summary: 'Chance for a column on the patch\'s outer ring to be kept.',
      detail:
        'Only the single-edge columns are gated -- corners are always dropped and the interior is ' +
        'always kept. At 0 the patch is its interior only, with a clean square edge.',
    },
    waterlogged: {
      summary: 'Intended to mark the patch as underwater. Avoid it.',
      detail:
        'With it on, the patch is walked and its ground blocks are written, and then the collected ' +
        'columns are discarded -- the vegetation never runs and the feature has no defined result ' +
        'to report. The preview reports the placement as failed. Leave it off.',
    },
  },

  'minecraft:sculk_patch_feature': {
    can_place_sculk_patch_on: {
      summary: 'The blocks a neighbour has to be for the patch to take hold.',
      detail:
        'Checked against the six neighbours of the origin, and at least one must match. An EMPTY ' +
        'array is not the same as an absent key: empty means "any solid neighbour will do", and the ' +
        'key itself is required either way.',
    },
    central_block: {
      summary: 'An optional single block placed at the centre of the patch.',
      detail: 'Absent means no central block, and the roll that would have placed it still happens.',
    },
    central_block_placement_chance: {
      summary: 'Chance the central block is placed.',
      detail: 'It also needs a solid block below the origin. Note the default -- it is 0, so the central block is off unless you ask for it.',
    },
    charge_amount: {
      summary: 'How much spread charge each cursor starts with.',
      detail: 'More charge means the patch can travel further from where each cursor was seeded.',
    },
    cursor_count: {
      summary: 'How many spread cursors are seeded per round.',
      detail: 'Seeded fresh each round and cleared at the end of it, so this is a per-round number, not a total.',
    },
    spread_attempts: {
      summary: 'How many times the spread pass runs within each round.',
      detail: 'Each attempt moves the round\'s cursors on once more, so more attempts means a patch that reaches further per round.',
    },
    growth_rounds: {
      summary: 'How many of the rounds are growth rounds.',
      detail: 'Growth and spread rounds run back to back; the total number of rounds is the two added together.',
    },
    spread_rounds: {
      summary: 'How many of the rounds are spread rounds.',
      detail: 'Growth and spread rounds run back to back; the total number of rounds is the two added together.',
    },
    extra_growth_chance: {
      summary: 'An extra amount of growth, drawn once from this range.',
      detail: 'A zero-width range adds nothing and costs no draw, which is what an absent key gives you.',
    },
  },

  'minecraft:growing_plant_feature': {
    height_distribution: {
      summary: 'The plant\'s possible heights, as weighted ranges.',
      detail:
        'One entry is picked by weight, then a height is drawn from that entry\'s range. Two stages, ' +
        'so a broad range with a big weight is not the same as several narrow ones.',
    },
    'height_distribution.0': {
      summary: 'The range of heights this entry covers.',
      detail: 'Written as an int range; a zero-width one is a single fixed height.',
    },
    'height_distribution.1': {
      summary: 'This entry\'s share of the weighted pick.',
      detail: 'Relative to the other entries\' weights, not a percentage.',
    },
    growth_direction: {
      summary: 'Whether the plant grows up from the origin or hangs down from it.',
      detail: 'It sets the direction of every layer, and with it which end of the plant the head block goes on.',
    },
    body_blocks: {
      summary: 'The weighted blocks that make up the stem.',
      detail: 'Drawn independently per layer, so one plant can mix entries up its length.',
    },
    head_blocks: {
      summary: 'The weighted blocks used for the last layer -- the tip.',
      detail:
        'The tip is where the plant stops, which is either the height that was drawn or the first ' +
        'layer that has nowhere to continue.',
    },
    age: {
      summary: 'An age value written into the head block, drawn once from this range.',
      detail:
        'Only written when the range\'s top end is non-zero, and only onto a block type that carries ' +
        'a growing-plant age state. Values at or above the state\'s own limit are dropped rather than ' +
        'wrapped, so an over-wide range quietly loses the top of itself.',
    },
    allow_water: {
      summary: 'Lets the plant grow through water as well as air.',
      detail:
        'It applies to the layers themselves, not to the look-ahead: the check for whether there is ' +
        'room to keep growing is always air-only, so a plant in water stops one layer sooner than you ' +
        'might expect.',
    },
  },

  'minecraft:geode_feature': {
    filler: {
      summary: 'The block filling the hollow core of the geode.',
      detail: 'Usually air, which is what makes the geode hollow.',
    },
    inner_layer: {
      summary: 'The block lining the inside of the shell.',
      detail: 'Each lining cell is either this or alternate_inner_layer, decided per cell by use_alternate_layer0_chance.',
    },
    alternate_inner_layer: {
      summary: 'The second lining block, mixed into the inner layer.',
      detail: 'It is also the layer inner_placements can grow on when placements_require_layer0_alternate is set.',
    },
    middle_layer: { summary: 'The block of the shell\'s middle band.', detail: 'Sits between the lining and the outer skin.' },
    outer_layer: { summary: 'The block of the shell\'s outermost band.', detail: 'This is the surface the geode presents to the surrounding stone.' },
    inner_placements: {
      summary: 'Blocks scattered on the inside of the lining -- the crystals.',
      detail: 'One entry is picked at random per chosen position, and the position still has to be able to hold it.',
    },
    min_outer_wall_distance: {
      summary: 'The smallest offset a lump may take from the geode\'s centre.',
      detail: 'Each lump is offset by a value drawn between this and max_outer_wall_distance, drawn separately for x, y and z.',
    },
    max_outer_wall_distance: {
      summary: 'The largest offset a lump may take from the geode\'s centre.',
      detail:
        'It does double duty: it also divides into the number of lumps to set the shell thresholds, ' +
        'so raising it changes the thickness of the shell as well as how far the lumps spread.',
    },
    min_distribution_points: { summary: 'The fewest lumps the geode is built from.', detail: 'The actual count is drawn between this and max_distribution_points, once per geode.' },
    max_distribution_points: { summary: 'The most lumps the geode is built from.', detail: 'More points make a lumpier, less spherical geode.' },
    min_point_offset: {
      summary: 'The low end of a per-lump value that varies how strongly each lump shapes the geode.',
      detail: 'Drawn once per lump between this and max_point_offset, and skipped entirely -- no draw, no variation -- unless max is strictly above min.',
    },
    max_point_offset: {
      summary: 'The high end of a per-lump value that varies how strongly each lump shapes the geode.',
      detail: 'Drawn once per lump between min_point_offset and this, and skipped entirely -- no draw, no variation -- unless it is strictly above min.',
    },
    max_radius: {
      summary: 'How far from the origin the geode is allowed to reach.',
      detail:
        'It is the size of the box that gets examined, not the size of the geode: every column ' +
        'within it is tested and most of them come out empty. Raising it costs work whether or not ' +
        'the geode gets any bigger.',
    },
    crack_point_offset: {
      summary: 'Widens the opening cracked into the geode\'s shell.',
      detail: 'Added to the distance test that decides which cells the crack carves away.',
    },
    noise_multiplier: {
      summary: 'How strongly noise distorts the shell.',
      detail: 'At 0 the geode is a smooth set of merged spheres; raising it makes the boundary between the layers ragged.',
    },
    use_potential_placements_chance: {
      summary: 'Chance that a lining cell is put forward as somewhere to grow inner_placements.',
      detail: 'Rolled per lining cell, and only within the lining band.',
    },
    use_alternate_layer0_chance: {
      summary: 'Chance that a lining cell uses alternate_inner_layer instead of inner_layer.',
      detail: 'Rolled per lining cell, which is what mixes the two blocks through the lining.',
    },
    placements_require_layer0_alternate: {
      summary: 'Restricts inner_placements to cells that came out as the alternate lining block.',
      detail: 'With it off, both lining blocks can carry them.',
    },
    invalid_blocks_threshold: {
      summary: 'How many unusable distribution points to tolerate before abandoning the geode.',
      detail:
        'Reaching it stops the whole placement on the spot -- nothing is built. Staying below it is ' +
        'harmless: an unusable point is still kept and still shapes the geode.',
    },
  },

  'minecraft:underwater_cave_carver_feature': {
    replace_air_with: {
      summary: 'The block written into carved cells that end up open to air.',
      detail:
        'The key only this carver has, and like fill_with it may be left out -- in which case those ' +
        'cells are simply left alone.',
    },
  },

  'minecraft:multiface_feature': {
    places_block: {
      summary: 'The block spread across the faces.',
      detail:
        'Its direction states are written as it goes, so it must be a block type that can face ' +
        'several ways at once.',
    },
    search_range: {
      summary: 'How many attempts a candidate position gets before the feature moves on.',
      detail:
        'Nothing to do with snap_to_surface\'s key of the same name, and not a distance: the feature ' +
        'tries the origin first and then its neighbours one step away, and this is how many times ' +
        'one position is attempted. Nothing about the attempt changes between tries, so raising it ' +
        'does not widen anything -- the key that grows a patch is chance_of_spreading.',
    },
    can_place_on_floor: { summary: 'Allows the block to attach to the top of a block below it.', detail: 'At least one of the three can_place_on_* flags must be on or nothing can ever attach.' },
    can_place_on_ceiling: { summary: 'Allows the block to attach to the underside of a block above it.', detail: 'At least one of the three can_place_on_* flags must be on or nothing can ever attach.' },
    can_place_on_wall: { summary: 'Allows the block to attach to the four vertical sides.', detail: 'All four horizontal directions are covered by this single flag.' },
    chance_of_spreading: {
      summary: 'Chance that a block just written goes on to spread further.',
      detail:
        'Rolled only when the write actually CHANGED something -- adding a face to a block that ' +
        'already had it costs no roll and cannot spread. On a hit the block grows on from that face ' +
        'in a random direction, which is what makes patches rather than single blocks.',
    },
    can_place_on: {
      summary: 'Restricts which blocks the spread is willing to attach to.',
      detail:
        'Leaving the key out puts no constraint on the supporting block at all -- the three ' +
        'can_place_on_* flags then decide everything. Written, it must not be empty.',
    },
  },

  'minecraft:fossil_feature': {
    ore_block: {
      summary: 'The block that replaces some of the fossil\'s bones.',
      detail:
        'Roughly one bone in ten becomes this, which is what makes a fossil worth digging out. The ' +
        'rest stay bone.',
    },
    max_empty_corners: {
      summary: 'How much of the fossil may stick out into open space before the placement is refused.',
      detail:
        'Counted over the corners of the chosen structure\'s box. Raising it lets fossils appear in ' +
        'caves and cliffsides rather than only fully buried.',
    },
  },

  'minecraft:horizontal_tree_decoration_feature': {
    places_block: {
      summary: 'The block hung on the side of a trunk.',
      detail:
        'It must be a block type that carries both a cardinal-direction state and a growth state; ' +
        'without them nothing is placed. The direction written is the compass direction of the face ' +
        'the engine picked.',
    },
    allow_adjacent: {
      summary: 'Lets a decoration be placed next to one that is already there.',
      detail: 'Off by default, which keeps decorations spaced out along a trunk.',
    },
    bark_side_only: {
      summary: 'Restricts placement to the bark faces of the log.',
      detail: 'Off by default, so the cut ends of a log are fair game unless you say otherwise.',
    },
  },

  'minecraft:multi_block_feature': {
    places_block: {
      summary: 'The starting part of a multi-block structure.',
      detail:
        'It has to be a block type that is genuinely a multi-block, AND the part it names has to be ' +
        'the FIRST part. Anything else is rejected when the file is read and the feature then fails ' +
        'every placement.',
    },
    enforce_placement_rules: {
      summary: 'Asks the world to apply its own placement rules to the write.',
      detail: 'Off by default here, unlike single_block where the key is required.',
    },
    randomize_rotation: {
      summary: 'Turns the structure a random quarter-turn before placing it.',
      detail: 'Requires the block to carry a cardinal-direction state; without one the flag is quietly dropped when the file is read.',
    },
  },

  'minecraft:multipart_block_column_feature': {
    tip_block: { summary: 'The block at the far end of the column.', detail: 'Always present: a column of height 1 is a tip and nothing else.' },
    frustum_block: {
      summary: 'The block one step before the tip.',
      detail: 'Appears from a height of 2 upward; at height 1 there is only a tip and this block is never written.',
    },
    middle_block: {
      summary: 'The block filling everything between the base and the frustum.',
      detail: 'Appears only from a height of 4 upward -- shorter columns skip straight from base to frustum.',
    },
    base_block: {
      summary: 'The block at the origin end of the column.',
      detail: 'Appears from a height of 3 upward; shorter columns are frustum-and-tip, or tip alone.',
    },
    height_range: {
      summary: 'The column height, drawn from this range.',
      detail:
        'Mutually exclusive with weighted_heights: exactly one of the two must be given, and the ' +
        'test is on the VALUE, not on whether the key is present -- writing `[-1, -1]` counts as not ' +
        'giving it, which is also what its default is.',
    },
    weighted_heights: {
      summary: 'The column height, picked from an explicit weighted list instead of a range.',
      detail:
        'Mutually exclusive with height_range, and an empty list counts as not given. The shortest ' +
        'height in the list also becomes the minimum amount of clear space the column needs.',
    },
    'weighted_heights.value': {
      summary: 'The height this entry stands for.',
      detail:
        'A whole number of blocks, counted along `direction`. An entry written as a bare number or ' +
        'an array rather than an object silently becomes a height of 0 with a weight of 1.',
    },
    'weighted_heights.weight': { summary: 'This entry\'s share of the pick.', detail: 'Relative to the other entries\' weights. If every weight is zero nothing can be picked and the column is not built.' },
    direction: {
      summary: 'Which way the column is built from the origin.',
      detail:
        'It is a direction of travel, not a facing: the parts are laid out along it in order, and ' +
        'the support the column needs is on the OPPOSITE side of the origin.',
    },
  },

  // The one catalogued type that is not a feature. A rule's `description` is deliberately not
  // modelled -- its identifier belongs to the rename control and its places_feature is an edge --
  // so what is left to document is the two objects that decide WHEN and WHERE the rule runs.
  'minecraft:feature_rule': {
    conditions: {
      summary: 'When in a chunk\'s generation the rule runs, and in which biomes.',
      detail:
        'Required: a rule without it fails a required field and the game refuses the whole file, ' +
        'so the rule is never inserted and nothing it would place appears. The two members are a ' +
        'stage of chunk generation and, optionally, a biome test.',
    },
    'conditions.placement_pass': {
      summary: 'Which stage of chunk generation places this rule\'s feature.',
      detail:
        'The passes run in the order they are listed, so this is also "how much of the world is ' +
        'already there when my feature arrives" -- a decoration that needs ground under it cannot ' +
        'run before the ground exists. Required, and there is no default to fall back on.',
    },
    'conditions.minecraft:biome_filter': {
      summary: 'Which biomes the rule applies in.',
      detail:
        'Left out, the rule applies in every biome the pass reaches. A rejection is not silent: ' +
        'the rule is still attached and still consulted, and the filter is what decides each time.',
    },
    distribution: {
      summary: 'How many times per chunk the rule places its feature, and where in the chunk.',
      detail:
        'The engine treats this whole object as optional, and a rule without one is the quietest ' +
        'failure this file format has: it loads, attaches to its pass and its biomes, and then ' +
        'places nothing in every chunk forever, because the parameters it falls back on have an ' +
        'iteration count of zero.',
    },
    'distribution.iterations': {
      summary: 'How many placements the rule attempts in each chunk it applies to.',
      detail:
        'Every other setting on the rule is moot until this is above zero, which is what makes it ' +
        'the first thing to check on a rule that appears to do nothing. An attempt is not a ' +
        'guarantee: the feature it places can still refuse the position it is handed.',
    },
    'distribution.x': {
      summary: 'How far east/west of the chunk position each iteration lands.',
      detail:
        'A bare number or Molang string pins the axis to that offset with no draw at all. The object ' +
        'form `{distribution, extent, ...}` is what spreads placements across the chunk.',
    },
    'distribution.y': {
      summary: 'The height each iteration is placed at.',
      detail:
        'Usually the axis that matters most on a rule: it is what puts ore underground and a tree ' +
        'on the surface. A bare number pins every iteration to that height with no draw at all.',
    },
    'distribution.z': {
      summary: 'How far north/south of the chunk position each iteration lands.',
      detail:
        'A bare number or Molang string pins the axis to that offset with no draw at all. The object ' +
        'form `{distribution, extent, ...}` is what spreads placements across the chunk.',
    },
    'distribution.scatter_chance': {
      summary: 'A gate on the whole rule, rolled before any iteration runs.',
      detail:
        'It decides whether this chunk gets the feature at all -- it is not a per-iteration roll. ' +
        'Use it for "roughly one chunk in twenty"; use iterations for how many appear once a chunk ' +
        'has been chosen.',
    },
    'distribution.coordinate_eval_order': {
      summary: 'Which axis is drawn first when the three are evaluated.',
      detail:
        'It changes results rather than tidiness: it permutes which random draw feeds which axis, ' +
        'so the placements move, and it decides which axes are already known when a later one is ' +
        'evaluated against them.',
    },
  },
}

// ---------------------------------------------------------------------------
// Value documentation
// ---------------------------------------------------------------------------

/** Value docs for enum fields whose meaning does not depend on the type. Keyed by field key, then
 * by value. As with the field tables, a type-specific entry wins. */
const SHARED_VALUE_DOCS: Readonly<Record<string, Readonly<Record<string, DocEntry>>>> = {
  distribution: {
    uniform: {
      summary: 'One draw, flat across the extent -- and the TOP END IS EXCLUDED.',
      detail:
        'The result is the low end plus a draw over (high - low), so an extent of [0, 4] produces ' +
        '0, 1, 2 or 3 and never 4. An extent whose high end is not above its low end returns the low ' +
        'end and costs no draw at all.',
    },
    gaussian: {
      summary: 'Two draws that cancel out, so positions bunch towards the MIDDLE of the extent.',
      detail:
        'The engine takes half the extent\'s width, draws twice under that half, and adds the ' +
        'difference to the middle. Neither end is ever reached exactly, and an extent narrower than ' +
        'two collapses to the low end with no draws at all. Use it for a soft cluster around a point.',
    },
    inverse_gaussian: {
      summary: 'The same two draws, arranged so positions bunch at BOTH ENDS and thin out in the middle.',
      detail:
        'The difference between the two draws is measured inward from one end or the other, so small ' +
        'differences land near an end and large ones near the centre -- the exact opposite of ' +
        'gaussian. When the two draws tie, one further draw picks the low end or the high end ' +
        'outright, which is why the extreme ends are the single most likely results.',
    },
    fixed_grid: {
      summary: 'Even, completely unrandom spacing: cell = grid_offset + low end + iteration index x step_size, wrapped.',
      detail:
        'No draw is ever made on this axis. The wrap is by the extent\'s width plus one (high - low + 1), ' +
        'so a step_size that does not divide that width walks a rotating set of cells instead of ' +
        'repeating the same few. What is handed to the next axis evaluated is that same sum divided ' +
        'by the wrap width, which is what makes two or three grid axes cover a 2-D or 3-D lattice ' +
        'between them rather than all moving together. Use it for rows, columns and regular fills; ' +
        'note that step_size\'s default is not established, so write it out.',
    },
    jittered_grid: {
      summary: 'fixed_grid plus one random offset within each cell -- but ONLY when step_size is 2 or more.',
      detail:
        'The jitter is a single draw under step_size, added before the wrap, so a placement never ' +
        'leaves its own step. Below a step_size of 2 there is no room to jitter into: no draw is ' +
        'made and the axis behaves exactly like fixed_grid. Use it for a scattered look that still ' +
        'covers the extent evenly.',
    },
    triangle: {
      summary: 'Two draws ADDED, so positions bunch in the middle while both ends stay reachable.',
      detail:
        'The extent is split in two and one draw is taken over each half, both ends INCLUDED, and ' +
        'the two are added to the low end. That is the difference from gaussian worth knowing: ' +
        'gaussian never quite reaches either end, triangle does.',
    },
  },

  coordinate_eval_order: {
    xyz: evalOrderDoc('xyz'),
    xzy: evalOrderDoc('xzy'),
    yxz: evalOrderDoc('yxz'),
    yzx: evalOrderDoc('yzx'),
    zxy: evalOrderDoc('zxy'),
    zyx: evalOrderDoc('zyx'),
  },
}

/** Value docs keyed by typeId, then field path, then value. */
const TYPE_VALUE_DOCS: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, DocEntry>>>>>
> = {
  // The trunk and canopy variants' enum values, catalogued alongside their keys.
  'minecraft:tree_feature': {
    ...TREE_TRUNK_VALUE_DOCS,
    ...TREE_CANOPY_VALUE_DOCS,
  },
  'minecraft:aggregate_feature': {
    early_out: {
      none: {
        summary: 'Run every child, whatever each one does.',
        detail:
          'The aggregate reports the LAST child that succeeded, so a failure in the middle costs ' +
          'nothing and a failure at the end does not hide an earlier success.',
      },
      first_success: {
        summary: 'Stop at the first child that places something.',
        detail: 'Children after it are never asked. This is how you write "try these in order until one works".',
      },
      first_failure: {
        summary: 'Stop as soon as a child has failed AND nothing has succeeded yet.',
        detail:
          'The test is on the running result, which is sticky: once any child has succeeded, a later ' +
          'failure no longer stops the list. So this reads as "everything up to the first success ' +
          'must work", not "every child must work". A child that is refused outright -- an internal ' +
          'feature -- does clear the running result and does stop it.',
      },
    },
  },

  'minecraft:conditional_list': {
    early_out_scheme: {
      condition_success: {
        summary: 'The first entry whose condition is TRUE ends the list.',
        detail:
          'Its child\'s result is the list\'s result whether that child placed anything or not -- so a ' +
          'true condition over a feature that fails ends the list with nothing placed, and the entries ' +
          'below it are never considered.',
      },
      placement_success: {
        summary: 'Entries are tried in order until one actually PLACES something.',
        detail:
          'A true condition whose child fails falls through to the next entry, which is the ' +
          'difference from condition_success and usually the one people want from a fallback chain.',
      },
      none: {
        summary: 'Nothing stops the walk: every entry whose condition is true places.',
        detail:
          'This is the default, and it makes the type an aggregate rather than a selector. The list ' +
          'reports the last placement that succeeded.',
      },
    },
  },

  'minecraft:search_feature': {
    search_axis: {
      '-x': searchAxisDoc('x descending', 'z descending', 'y ascending'),
      '+x': searchAxisDoc('x ascending', 'z ascending', 'y ascending'),
      '-y': searchAxisDoc('y descending', 'x descending', 'z ascending'),
      '+y': searchAxisDoc('y ascending', 'x ascending', 'z ascending'),
      '-z': searchAxisDoc('z descending', 'x ascending', 'y ascending'),
      '+z': searchAxisDoc('z ascending', 'x descending', 'y ascending'),
    },
  },

  'minecraft:snap_to_surface_feature': {
    surface: {
      floor: {
        summary: 'Walk downward and place on top of the first surface found.',
        detail:
          'This is the default when the key is absent. A start that is already buried walks the ' +
          'other way instead, out of the solid, and lands on the same surface from underneath.',
      },
      ceiling: {
        summary: 'Walk upward and place underneath the first surface found.',
        detail: 'The mirror of floor, and what hanging features want.',
      },
      wall: {
        summary: 'Try the four horizontal directions in a random order and take the first that works.',
        detail: 'New in game version 1.26.50. Unlike floor and ceiling it costs random draws, because the order is shuffled.',
      },
      random_horizontal: {
        summary: 'Take one random draw and use it to pick FLOOR or CEILING.',
        detail:
          'Despite the name, nothing horizontal happens: the result is always a floor snap or a ' +
          'ceiling snap, one or the other, decided per placement. If you want the four side ' +
          'directions, that is `wall`.',
      },
    },
  },

  'minecraft:structure_template_feature': {
    facing_direction: {
      south: { summary: 'Place the structure exactly as it was saved.', detail: 'The unrotated orientation, and the default when the key is absent.' },
      west: { summary: 'Turn the structure one quarter turn from how it was saved.', detail: 'No random draw is taken for an explicit direction.' },
      north: { summary: 'Turn the structure a half turn from how it was saved.', detail: 'No random draw is taken for an explicit direction.' },
      east: { summary: 'Turn the structure three quarter turns from how it was saved.', detail: 'No random draw is taken for an explicit direction.' },
      random: {
        summary: 'Pick one of the four orientations at random.',
        detail:
          'The only value here that costs a random draw, and the draw happens before the position ' +
          'search and before any constraint is checked -- so it is spent even on a placement that ' +
          'then fails.',
      },
    },
  },

  'minecraft:partially_exposed_blob_feature': {
    exposed_face: {
      up: exposedFaceDoc('upward'),
      down: exposedFaceDoc('downward'),
      north: exposedFaceDoc('north'),
      south: exposedFaceDoc('south'),
      east: exposedFaceDoc('east'),
      west: exposedFaceDoc('west'),
    },
  },

  'minecraft:vegetation_patch_feature': {
    surface: {
      floor: {
        summary: 'The patch sits on the ground and its vegetation grows upward.',
        detail: 'Columns search downward for something that can support the patch, and the ground layer fills downward into it.',
      },
      ceiling: {
        summary: 'The patch clings to a ceiling and its vegetation hangs downward.',
        detail: 'Every direction is mirrored: columns search upward, the ground layer fills upward, and the vegetation grows down.',
      },
    },
  },

  'minecraft:growing_plant_feature': {
    growth_direction: {
      up: {
        summary: 'Layers are stacked upward from the origin, with the head block on top.',
        detail: 'The plant needs clear space above the origin, not below it.',
      },
      down: {
        summary: 'Layers hang downward from the origin, with the head block at the bottom.',
        detail: 'The plant needs clear space below the origin. This is what vines and dripping plants use.',
      },
    },
  },

  'minecraft:multipart_block_column_feature': {
    direction: {
      up: columnDirectionDoc('upward', 'directly below the origin'),
      down: columnDirectionDoc('downward', 'directly above the origin'),
      north: columnDirectionDoc('north', 'one block south of the origin'),
      south: columnDirectionDoc('south', 'one block north of the origin'),
      west: columnDirectionDoc('west', 'one block east of the origin'),
      east: columnDirectionDoc('east', 'one block west of the origin'),
    },
  },

  // The twelve placement passes. Chunk decoration walks the first eleven in exactly this order,
  // so each entry says what has and has not happened by the time the pass is reached -- which is
  // the question somebody picking one actually has ("will there be ground under my tree?").
  'minecraft:feature_rule': {
    'conditions.placement_pass': {
      first_pass: {
        summary: 'The earliest decoration pass, before anything else has been added to the chunk.',
        detail:
          'Nothing another rule places is there yet, so this is where something has to run if ' +
          'everything else is meant to sit on top of it -- and the wrong choice for a decoration ' +
          'that needs a finished surface, which does not exist this early.',
      },
      before_underground_pass: {
        summary: 'Runs immediately before the underground pass, for anything that must precede it.',
        detail:
          'The three underground passes are a group: this one exists so a rule can prepare the ' +
          'ground that the underground pass proper then works on.',
      },
      underground_pass: {
        summary: 'The main pass for everything below the surface -- ores, veins and cave dressing.',
        detail:
          'This is where the great majority of subsurface rules belong. The carving of caves ' +
          'themselves happens earlier still, in pregeneration_pass.',
      },
      after_underground_pass: {
        summary: 'Runs immediately after the underground pass, for anything that builds on it.',
        detail:
          'Everything the underground pass placed is in the chunk by now, so a rule that has to ' +
          'react to an ore or a cave decoration goes here rather than beside it.',
      },
      before_surface_pass: {
        summary: 'Runs immediately before the surface pass, while the surface is still bare.',
        detail:
          'Useful for anything that has to claim its space before the surface fills up -- a large ' +
          'structure that would otherwise be competing with grass and trees for the same columns.',
      },
      surface_pass: {
        summary: 'The main pass for everything that sits on the ground: plants, trees and scatter.',
        detail:
          'The terrain is shaped and the underground passes are finished, so a feature placed here ' +
          'can rely on there being ground to stand on. Most new rules belong here.',
      },
      after_surface_pass: {
        summary: 'Runs immediately after the surface pass, once the ground cover is in place.',
        detail:
          'The right home for anything that decorates what the surface pass placed -- vines on the ' +
          'trees it grew, rather than the trees themselves.',
      },
      before_sky_pass: {
        summary: 'Runs immediately before the sky pass, after everything on the ground is done.',
        detail:
          'The ground is finished by this point, so it and the two after it are about the space above ' +
          'the ground rather than about the terrain.',
      },
      sky_pass: {
        summary: 'The main pass for anything placed in open air rather than on the ground.',
        detail:
          'Floating and hanging features belong here. A feature placed this late still has to find its ' +
          'own position: a pass decides when a rule runs, never where.',
      },
      after_sky_pass: {
        summary: 'Runs immediately after the sky pass, for anything that decorates it.',
        detail:
          'The last pass before final_pass, and the place for something that has to react to what ' +
          'the sky pass produced.',
      },
      final_pass: {
        summary: 'The last decoration pass: everything every other rule places is already there.',
        detail:
          'Use it for anything that has to see the finished chunk -- a cleanup or an overlay. It is ' +
          'also the only pass where a rule can be sure nothing will be placed over its work.',
      },
      pregeneration_pass: {
        summary: 'Runs before the decoration passes, and accepts ONE kind of feature.',
        detail:
          'Only a cave carver may run here. Every other type is refused at placement time with a ' +
          'log line and nothing placed, so a rule that names it over anything else loads, attaches to ' +
          'its biomes, and then quietly never produces anything.',
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Splits a hover path into segments, dropping nothing yet -- the walk below decides what an
 * all-digits segment means, because it means different things at different depths. */
function segmentsOf(path: string): string[] {
  return path.split('.').filter((s) => s.length > 0)
}

function isIndex(segment: string): boolean {
  return /^[0-9]+$/.test(segment)
}

/** The FieldSpec a dotted path names, walking into `entry` as it goes.
 *
 * Array indices are handled rather than banned, because a hover provider's path comes from the JSON
 * document and a document has indices in it. The rule: at a groupList / weightedBlockList / blockList
 * field, one numeric segment is consumed as the index BEFORE matching resumes. That is what keeps
 * `height_distribution.0.0` (index, then the tuple slot named "0") distinct from
 * `replace_rules.0.places_block` while both resolve. */
export function fieldSpecAt(typeId: string, path: string): FieldSpec | undefined {
  const spec: TypeSpec | undefined = typeSpec(typeId)
  if (spec === undefined) return undefined
  let fields: readonly FieldSpec[] | undefined = spec.fields
  let current: FieldSpec | undefined
  for (const segment of segmentsOf(path)) {
    if (fields === undefined) return undefined
    const match: FieldSpec | undefined = fields.find((f) => f.key === segment)
    if (match !== undefined) {
      current = match
      fields = match.entry
      continue
    }
    if (isIndex(segment) && current !== undefined) {
      // An array index under a list-shaped field: stay where we are and keep the same sub-fields.
      continue
    }
    return undefined
  }
  return current
}

/** The path as the doc tables key it: array indices dropped, so one entry covers every element. */
function normalisePath(typeId: string, path: string): string {
  const spec = typeSpec(typeId)
  const kept: string[] = []
  let fields: readonly FieldSpec[] | undefined = spec?.fields
  for (const segment of segmentsOf(path)) {
    const match = fields?.find((f) => f.key === segment)
    if (match !== undefined) {
      kept.push(segment)
      fields = match.entry
      continue
    }
    if (isIndex(segment)) continue
    kept.push(segment)
    fields = undefined
  }
  return kept.join('.')
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** What this catalogue says about a field.
 *
 * Resolution order, and the reason it is this order rather than "most specific wins" all the way
 * down: an exact path inside a type is the only key that can tell `distribution` the scatter
 * parameter object from `distribution` the per-axis kind, so the exact path has to be tried first
 * at both scopes. A bare key is only ever consulted in the SHARED table, where it means "this key
 * means the same thing wherever it appears" -- which is true of `weight` and `may_replace` and
 * false of `search_range`, and that is exactly why type-specific entries are never matched by bare
 * key.
 *
 * 1. TYPE_FIELD_DOCS[typeId][path]
 * 2. SHARED_FIELD_DOCS[path]
 * 3. SHARED_FIELD_DOCS[last segment of path]
 *
 * Returns undefined only when the path names nothing at all -- neither an entry here nor a field
 * typeCatalog models. A resolved field with no prose anywhere still comes back, carrying its spec,
 * because a hover showing kind and bounds beats a hover showing nothing. */
export function lookupFieldDoc(typeId: string, path: string): FieldDoc | undefined {
  const normalised = normalisePath(typeId, path)
  const segments = segmentsOf(normalised)
  const key = segments.length > 0 ? (segments[segments.length - 1] as string) : ''
  const spec = fieldSpecAt(typeId, normalised)

  const byType = TYPE_FIELD_DOCS[typeId]?.[normalised]
  const shared = SHARED_FIELD_DOCS[normalised] ?? SHARED_FIELD_DOCS[key]
  const entry = byType ?? shared
  const source: DocSource = byType !== undefined ? 'type' : shared !== undefined ? 'shared' : 'none'

  if (entry === undefined && spec === undefined) return undefined
  return {
    typeId,
    path: normalised,
    key,
    ...(entry !== undefined ? { entry } : {}),
    ...(spec !== undefined ? { spec } : {}),
    source,
    documented: entry !== undefined || spec?.doc !== undefined,
  }
}

/** What this catalogue says about one VALUE of an enum field. Same resolution order as
 * lookupFieldDoc, one level deeper. */
export function lookupValueDoc(typeId: string, path: string, value: string): ValueDoc | undefined {
  const normalised = normalisePath(typeId, path)
  const segments = segmentsOf(normalised)
  const key = segments.length > 0 ? (segments[segments.length - 1] as string) : ''

  const byType = TYPE_VALUE_DOCS[typeId]?.[normalised]?.[value]
  const shared = SHARED_VALUE_DOCS[normalised]?.[value] ?? SHARED_VALUE_DOCS[key]?.[value]
  const entry = byType ?? shared
  if (entry === undefined) {
    const spec = fieldSpecAt(typeId, normalised)
    if (spec === undefined) return undefined
    return { typeId, path: normalised, key, value, source: 'none', documented: false }
  }
  return {
    typeId,
    path: normalised,
    key,
    value,
    entry,
    source: byType !== undefined ? 'type' : 'shared',
    documented: true,
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEntry(entry: DocEntry): string[] {
  const lines = [entry.unestablished === true ? `**Not established.** ${entry.summary}` : entry.summary]
  if (entry.detail !== undefined) lines.push('', entry.detail)
  return lines
}

/** Markdown for a field hover: this catalogue's prose, then the schema facts typeCatalog holds.
 * Both halves, never one restating the other -- which is the whole reason the two are separate. */
export function renderFieldDoc(doc: FieldDoc): string {
  const lines: string[] = [`\`${doc.key}\``]
  if (doc.entry !== undefined) lines.push('', ...renderEntry(doc.entry))
  const spec = doc.spec
  if (spec !== undefined) {
    if (spec.doc !== undefined) lines.push('', spec.doc)
    const facts: string[] = [spec.required ? 'required' : 'optional']
    if (spec.default !== undefined) facts.push(`absent: ${spec.default}`)
    if (spec.min !== undefined || spec.max !== undefined) {
      facts.push(`range: [${spec.min ?? '-'}, ${spec.max ?? '-'}]`)
    }
    if (spec.since !== undefined) facts.push(`from format_version ${spec.since}`)
    if (spec.until !== undefined) facts.push(`dropped at format_version ${spec.until}`)
    lines.push('', `_${facts.join(' -- ')}_`)
    if (spec.unsourced !== undefined) lines.push('', spec.unsourced)
  }
  return lines.join('\n')
}

/** Markdown for a value hover. */
export function renderValueDoc(doc: ValueDoc): string {
  const lines: string[] = [`\`${doc.value}\``]
  if (doc.entry !== undefined) lines.push('', ...renderEntry(doc.entry))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Introspection, for the guards
// ---------------------------------------------------------------------------

/** Every entry this module can put in front of a user, with a location for a failure message.
 * docsLanguage.test.ts walks this: a guard that cannot enumerate the surface it guards is a guard
 * that silently passes. */
export function allDocEntries(): { location: string; entry: DocEntry }[] {
  const out: { location: string; entry: DocEntry }[] = []
  for (const [path, entry] of Object.entries(SHARED_FIELD_DOCS)) {
    out.push({ location: `shared field ${path}`, entry })
  }
  for (const [typeId, table] of Object.entries(TYPE_FIELD_DOCS)) {
    for (const [path, entry] of Object.entries(table)) {
      out.push({ location: `${typeId} field ${path}`, entry })
    }
  }
  for (const [path, values] of Object.entries(SHARED_VALUE_DOCS)) {
    for (const [value, entry] of Object.entries(values)) {
      out.push({ location: `shared value ${path}=${value}`, entry })
    }
  }
  for (const [typeId, table] of Object.entries(TYPE_VALUE_DOCS)) {
    for (const [path, values] of Object.entries(table)) {
      for (const [value, entry] of Object.entries(values)) {
        out.push({ location: `${typeId} value ${path}=${value}`, entry })
      }
    }
  }
  return out
}
