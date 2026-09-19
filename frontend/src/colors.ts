// colors.ts assigns every palette entry a render colour by block name. The wire palette still
// carries no colour: internal/gencolors derives block/vanilla/colors.json on the Go side, and
// the frontend build turns that artifact into the static module imported below. The curated
// table remains first because texture averages cannot reproduce runtime or biome tinting (water
// is the concrete example). Generated colours then cover names absent from curated knowledge;
// hashColor keeps everything else visible and deterministic rather than black/blank.

import { GENERATED_BLOCK_COLORS } from './generated/blockColors.js'

const NAMED_COLORS: Readonly<Record<string, number>> = {
  'minecraft:air': 0x000000,
  'minecraft:cave_air': 0x000000,
  'minecraft:void_air': 0x000000,

  'minecraft:water': 0x3f76e4,
  'minecraft:flowing_water': 0x3f76e4,
  'minecraft:lava': 0xe25822,
  'minecraft:flowing_lava': 0xe25822,

  'minecraft:stone': 0x7d7d7d,
  'minecraft:granite': 0x9a6b58,
  'minecraft:polished_granite': 0x9c6e5c,
  'minecraft:diorite': 0xb8b8b8,
  'minecraft:polished_diorite': 0xbdbdbd,
  'minecraft:andesite': 0x888888,
  'minecraft:polished_andesite': 0x8b8b8b,
  'minecraft:tuff': 0x6b6d63,
  'minecraft:calcite': 0xe0e1dd,
  'minecraft:deepslate': 0x4a4a4e,
  'minecraft:cobbled_deepslate': 0x4d4d51,
  'minecraft:polished_deepslate': 0x454549,
  'minecraft:bedrock': 0x565656,
  'minecraft:gravel': 0x8a8580,
  'minecraft:stone_bricks': 0x7a7a7a,
  'minecraft:stonebrick': 0x7a7a7a,
  'minecraft:mossy_stone_bricks': 0x6d7a5c,
  'minecraft:cobblestone': 0x7a7a7a,
  'minecraft:mossy_cobblestone': 0x6d7a5c,

  'minecraft:dirt': 0x8a5a3c,
  'minecraft:coarse_dirt': 0x82563a,
  'minecraft:rooted_dirt': 0x8a6a4a,
  'minecraft:podzol': 0x5c3d21,
  'minecraft:mycelium': 0x6f6260,
  'minecraft:grass_block': 0x6a9451,
  'minecraft:grass': 0x6a9451,
  'minecraft:sand': 0xdbcd8b,
  'minecraft:red_sand': 0xa85a2c,
  'minecraft:sandstone': 0xd8c98a,
  'minecraft:red_sandstone': 0x9a5a2c,
  'minecraft:clay': 0x9fa6b0,
  'minecraft:mud': 0x3f3a37,
  'minecraft:packed_mud': 0x9c7b52,

  'minecraft:netherrack': 0x723232,
  'minecraft:basalt': 0x4b4854,
  'minecraft:smooth_basalt': 0x4b4854,
  'minecraft:blackstone': 0x2b262a,
  'minecraft:soul_sand': 0x574434,
  'minecraft:soul_soil': 0x4a3826,
  'minecraft:magma': 0x8c4a1e,
  'minecraft:nether_bricks': 0x2c1719,
  'minecraft:obsidian': 0x140d21,
  'minecraft:crying_obsidian': 0x230d3b,
  'minecraft:end_stone': 0xdcdca0,

  'minecraft:oak_log': 0x6b5638,
  'minecraft:oak_leaves': 0x4a7942,
  'minecraft:spruce_log': 0x4a3a26,
  'minecraft:spruce_leaves': 0x3f6b46,
  'minecraft:birch_log': 0xd9d3bf,
  'minecraft:birch_leaves': 0x6ba05c,
  'minecraft:acacia_log': 0x6b4a3a,
  'minecraft:acacia_leaves': 0x6da236,
  'minecraft:dark_oak_log': 0x3a2c1e,
  'minecraft:dark_oak_leaves': 0x3f5c33,
  'minecraft:jungle_log': 0x4d3722,
  'minecraft:jungle_leaves': 0x449e2e,
  'minecraft:cherry_log': 0x6b4a49,
  'minecraft:cherry_leaves': 0xe8a6c1,
  'minecraft:pale_oak_log': 0xa3998a,
  'minecraft:pale_oak_leaves': 0x7a9470,

  'minecraft:snow': 0xf5f5f5,
  'minecraft:snow_layer': 0xf5f5f5,
  'minecraft:ice': 0x9ab8e8,
  'minecraft:packed_ice': 0x8aaee0,
  'minecraft:glass': 0xd8f0f5,
  'minecraft:glowstone': 0xe8c26a,
  'minecraft:diamond_block': 0x63d9d0,
  'minecraft:emerald_block': 0x2fbf6e,
  'minecraft:gold_block': 0xf2c94c,
  'minecraft:iron_block': 0xd8d8d8,
  'minecraft:coal_ore': 0x3a3a3a,
  'minecraft:iron_ore': 0xc79a6b,
  'minecraft:gold_ore': 0xf2c94c,
  'minecraft:diamond_ore': 0x63d9d0,
  'minecraft:emerald_ore': 0x2fbf6e,
  'minecraft:lapis_ore': 0x2f5aa8,
  'minecraft:redstone_ore': 0xa82f2f,
  'minecraft:copper_ore': 0xc37b53,

  // Blocks the wiki's own example images place, which had no curated colour and no generated
  // one either -- the generated table is built from a bedrock-samples texture checkout that
  // predates several of these, and hashColor's job is to keep an unknown block VISIBLE, not to
  // make it look like itself. That is fine for an arbitrary pack block and wrong for a
  // documentation screenshot: leaf litter rendered violet and dripstone green, which teaches a
  // reader the wrong thing about a picture whose entire purpose is to show what a feature
  // places. Values are eyeballed vanilla texture averages, in the same spirit as the curated
  // entries above.
  'minecraft:leaf_litter': 0x8a6a3d,
  'minecraft:dripstone_block': 0x866a5b,
  'minecraft:pointed_dripstone': 0x7d6152,
  'minecraft:amethyst_block': 0x8867c9,
  'minecraft:amethyst_cluster': 0xa579d6,
  'minecraft:budding_amethyst': 0x9270c4,
  'minecraft:glow_lichen': 0x6b7d63,
  'minecraft:cave_vines': 0x6c7d40,
  'minecraft:cave_vines_head_with_berries': 0xc07a1e,
  'minecraft:cave_vines_body_with_berries': 0xb0761f,
  'minecraft:hanging_roots': 0x9a6a45,
  'minecraft:moss_block': 0x5a6f33,
  'minecraft:moss_carpet': 0x5a6f33,
  'minecraft:jack_o_lantern': 0xb9761f,
  'minecraft:pink_petals': 0xd18ec0,
  'minecraft:wildflowers': 0xc7a63f,

  // The pre-flattening aggregate ids, still what several vanilla feature JSONs name: one block
  // id per wood family with the species in a block state. One colour each, taken from the
  // family's most common member, since the mesher is state-blind.
  'minecraft:log': 0x6b5638,
  'minecraft:log2': 0x4a3a24,
  'minecraft:leaves': 0x4a7942,
  'minecraft:leaves2': 0x3f5c33,
}

/** FNV-1a over the string, folded into a hue -- deterministic, cheap, and stable across runs
 * (same block name always yields the same colour) so an unlisted block still renders as a
 * consistent, distinguishable material rather than a random flicker between regenerations. */
function hashColor(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const hue = (hash >>> 0) % 360
  return hslToPackedRgb(hue, 0.38, 0.5)
}

function hslToPackedRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const ri = Math.round((r + m) * 255)
  const gi = Math.round((g + m) * 255)
  const bi = Math.round((b + m) * 255)
  return (ri << 16) | (gi << 8) | bi
}

/** Packed 0xRRGGBB colour for a canonical (minecraft:-prefixed) block name. Curated values
 * win over generated texture averages. The current mesher accepts one colour per block, so a
 * generated per-face entry uses its `up` face as the documented representative; the generated
 * module retains every face for a future face-aware mesher. */
export function colorForBlockName(name: string): number {
  const named = NAMED_COLORS[name]
  if (named !== undefined) return named

  const generated = GENERATED_BLOCK_COLORS[name]
  if (generated?.color !== undefined) return generated.color
  if (generated?.faces?.up !== undefined) return generated.faces.up

  return hashColor(name)
}

// --- write-attribution series ----------------------------------------------------------------
//
// The colours the attribution overlay paints one WRITER each in (viewer.ts's
// setAttributionGroups). Until there was a legend there was only ever one of them, because a
// second unexplained colour on a voxel preview is a riddle rather than an answer; with a legend
// naming each one, telling two writers apart is the whole point -- "which of these blocks are
// mine" and "where do we overlap" are the two questions somebody clicks a node to ask.
//
// CHOSEN AGAINST THE OVERLAYS ALREADY ON SCREEN, not just against each other. This preview
// already spends the warm half of the wheel: carved is a warm orange (#ff5a3c), the captured
// out-of-bounds overlay is magenta (#ff26d9), the heatmap runs teal -> yellow -> red and
// highlightCell's marker is yellow. So every entry here lives in the blue/green corner nothing
// else occupies, and none of them is a red, an orange or a pink. The first is the exact
// blue-violet the single-writer overlay has always used, so a preview with one writer looks
// unchanged.
//
// AND CHOSEN AGAINST COLOUR VISION, which the first version of this series was not. Its violet
// (#b07bff) and its blue-violet were CIE76 ΔE 17.7 apart in normal vision and 10.3 apart under
// simulated protanopia -- and the blue-violet is not just any entry, it is always the node the
// user clicked, so the one row that has to be findable was the one row that dissolved. Two more
// pairs (cyan/slate under deuteranopia, blue/violet-vs-slate under tritanopia) sat under 20.
//
// Every pair here is at least ΔE 25 apart in normal vision AND under Machado 2009 severity-1.0
// protan, deutan and tritan simulation -- worst case 28.4 (tritan, #76e6f8 vs #1faa26); see
// test/colors.test.ts, which recomputes all four and fails if any pair drops under 25. The
// separation is bought with LIGHTNESS as much as hue, because a dichromat's remaining chromatic
// axis is roughly blue-yellow alone and six hues out of one corner cannot be told apart on it.
//
// THE ORDER IS PART OF THE ANSWER. Writers are coloured in list order with the selected node
// first (see previewPanel.ts's attributionGroupsFor), so the sequence is arranged so that the
// FIRST few are the furthest apart: two writers are 45.0 apart at worst, three 38.2, four 33.2,
// five 29.0. The common cases get the easiest picture, rather than every case getting the
// six-writer one.
const ATTRIBUTION_SERIES: readonly number[] = [
  0x6b73ff, // blue-violet -- the original, and what one writer alone still gets
  0xc9f294, // pale green
  0x76e6f8, // sky
  0x123f63, // deep navy
  0x8e9199, // slate
  0x1faa26, // green
]

/** How many writers can be told apart by colour before the series repeats. A host with more
 * than this to show should group the rest rather than hand over a seventh that looks like the
 * first -- see `attributionColor`. */
export const ATTRIBUTION_SERIES_LENGTH = ATTRIBUTION_SERIES.length

/** The packed 0xRRGGBB colour for writer `index`, cycling past the end of the series.
 *
 * Cycling rather than throwing, because the mesher asks this per cell and a bad index is a host
 * bug that should show up as two writers sharing a colour, not as a preview that fails to draw.
 * A negative index (which is what a cell with no writer would produce) answers with the first
 * entry for the same reason. */
export function attributionColorPacked(index: number): number {
  const n = ATTRIBUTION_SERIES.length
  const i = Number.isFinite(index) && index > 0 ? Math.trunc(index) % n : 0
  return ATTRIBUTION_SERIES[i] as number
}

/** `attributionColorPacked` as the 0..1 RGB triple the mesher's `colorOverride` wants. Cached,
 * because it is called once per meshed cell and allocating a fresh triple per call would be the
 * only allocation in that loop. */
const ATTRIBUTION_RGB: readonly (readonly [number, number, number])[] = ATTRIBUTION_SERIES.map((c) => [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255] as const)

export function attributionColor(index: number): readonly [number, number, number] {
  const n = ATTRIBUTION_RGB.length
  const i = Number.isFinite(index) && index > 0 ? Math.trunc(index) % n : 0
  return ATTRIBUTION_RGB[i] as readonly [number, number, number]
}

/** The series as CSS hex strings, for a legend that has to draw the same colours the geometry
 * is painted in. One source, so a swatch can never name a colour the overlay does not use. */
export function attributionColorCss(index: number): string {
  return `#${attributionColorPacked(index).toString(16).padStart(6, '0')}`
}

// --- runtime tint channels (textured rendering) ---------------------------------------------
//
// Vanilla bakes grass, foliage and water as GREYSCALE textures and multiplies them by a colour
// chosen at runtime from the biome the block sits in -- an untinted greyscale grass block renders
// grey, which is not a subtle inaccuracy but an obviously broken picture. The atlas table (see
// protocol.ts's AtlasBlockWire) therefore names a tint CHANNEL per face rather than baking a
// colour, and this table is where a channel name becomes an actual multiplier.
//
// This table is the LAST of three sources, not the first. The atlas table itself carries a
// measured per-face `tint_color` for most tinted faces (the builder samples the block's own
// pre-tinted carried texture and works out the multiplier that reproduces vanilla's default
// biome), and a documented `default` per channel behind that -- see mesher.ts's tintForChannel
// for the order. What is here answers for a table that carries neither, and for a channel this
// renderer knows about that the table does not document.
//
// These are fixed, biome-independent values. The preview bench has one biome at a time and no
// per-cell biome map to sample, so every tinted face in a run gets the same channel colour --
// the "plains-like" default below. That is a deliberate approximation and the one place this
// renderer knowingly differs from the game: real Bedrock samples a per-position biome colour.
// Making it biome-aware needs the engine to report the biome colour alongside the run, which is
// not part of the wire contract today.
//
// 'none' is the channel an untinted face carries and must multiply to exactly white, so that a
// face's sampled texel passes through unchanged. An UNKNOWN channel name (a table emitted by a
// newer atlas builder than this renderer) also resolves to white: a texture rendered untinted is
// wrong, but a texture rendered black or magenta is worse and harder to read.
const TINT_CHANNELS: Readonly<Record<string, number>> = {
  none: 0xffffff,
  // Plains grass/foliage, the values vanilla's own biome tables carry for the temperate middle
  // of the range -- what the bench's default environment presets look like.
  grass: 0x79c05a,
  foliage: 0x77ab2f,
  dry_foliage: 0xa2a373,
  // Bedrock's default water tint. The flat-colour table above carries 0x3f76e4 for water, which
  // is the colour of the FINISHED block (texture times tint); this is the multiplier, so the two
  // are deliberately different numbers for the same material.
  water: 0x44aff5,
  // Fixed (non-biome) leaf tints -- spruce and birch leaves ignore the biome and use a constant
  // in both editions, so they get their own channels rather than reusing 'foliage'.
  evergreen: 0x619961,
  birch: 0x80a755,
  // The atlas builder's "I measured a greyscale texture and nothing in the pack says what to
  // multiply it by" channel. There is no colour to use, so it draws untinted -- which is
  // exactly what happens today, and is recorded here rather than left to the unknown-channel
  // fallback so that a reader can see it was considered.
  grey: 0xffffff,
}

/** Packed 0xRRGGBB multiplier for an atlas tint-channel name. Unknown/absent channels resolve to
 * white (no tint) -- see TINT_CHANNELS' own comment for why that, and not a loud debug colour,
 * is the right failure mode here. */
export function tintColorForChannel(channel: string | undefined): number {
  if (channel === undefined) return 0xffffff
  return TINT_CHANNELS[channel] ?? 0xffffff
}

/** Every tint channel name this renderer knows how to multiply -- exported so a test (and a
 * future atlas builder) can check a table's channels against what the renderer actually
 * implements instead of discovering a silent white fallback in a screenshot. */
export function knownTintChannels(): string[] {
  return Object.keys(TINT_CHANNELS)
}
