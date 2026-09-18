package atlas

import (
	"fmt"
	"sort"
	"strings"

	"github.com/stirante/featurelab/internal/rptex"
)

// wildcardFace is the "every face not named individually" key the renderer's
// per-face lookups already understand (frontend/src/protocol.ts's
// AtlasFacesWire). Collapsing a block whose six faces share one cell into a
// single entry is not cosmetic at this size: 900-odd of the 1164 blocks with
// full face coverage are single-texture blocks, and writing all six out for
// each of them roughly triples the table, which travels the wire once per
// session.
const wildcardFace = "*"

// buildBlocks fills Table.Blocks: for every block ID, the atlas cell each of
// its six faces is drawn from, the terrain key each resolved through, and the
// tint channel each needs.
//
// Faces are resolved through rptex.TextureSet.Key, which handles every shape
// blocks.json actually uses -- the flat single-texture form, {up,down,side},
// {up,down,north,south,east,west}, and the two entries that declare a "side"
// AND cardinals. A block is emitted with as many faces as resolve; one that
// resolves none at all is recorded as a miss rather than emitted empty.
func (b *builder) buildBlocks(ids []string) {
	aliases := rptex.AliasResourceKeys()
	b.table.Blocks = make(map[string]Block, len(ids))
	b.table.Misses.Blocks = []BlockMiss{}
	all := withSuppliedBlocks(ids, b.opts.BlockFaces)
	for _, id := range all {
		if !isStatedID(id) {
			b.stats.Blocks++
		}
	}

	keyMisses := map[string]string{}
	for _, id := range all {
		entry, resourceKey, ok := b.suppliedEntry(id)
		if !ok {
			entry, resourceKey, ok = b.blocks.Lookup(id, aliases)
		}
		if !ok {
			b.blockMiss(id, "no blocks.json entry: not present directly, not the target of any alias in block.GeneratedAliases(), and not supplied through Options.BlockFaces")
			continue
		}
		if entry.Textures.Empty() {
			b.blockMiss(id, fmt.Sprintf("blocks.json entry %q declares no usable \"textures\"", resourceKey))
			continue
		}

		faces := map[string]int{}
		keys := map[string]string{}
		tint := map[string]string{}
		tintColor := map[string]string{}
		render := RenderOpaque
		for _, face := range rptex.CubeFaces {
			textureKey, ok := entry.Textures.Key(face)
			if !ok {
				continue
			}
			cellIdx, ok := b.table.Textures[textureKey]
			if !ok {
				if _, seen := keyMisses[textureKey]; !seen {
					keyMisses[textureKey] = b.keyMissReason(textureKey)
				}
				continue
			}
			faces[face] = cellIdx
			keys[face] = textureKey
			if renderRank(b.table.Cells[cellIdx].Render) > renderRank(render) {
				render = b.table.Cells[cellIdx].Render
			}
			channel, colour := b.tintFor(entry, face, textureKey, cellIdx)
			tint[face] = channel
			if colour != "" {
				tintColor[face] = colour
			}
			switch {
			case channel != TintNone:
				b.stats.TintedFaces++
			case b.table.Cells[cellIdx].Grey:
				b.stats.UntintedGrey++
			}
		}
		if len(faces) == 0 {
			b.blockMiss(id, "every declared face's texture key failed to resolve; see misses.textures")
			continue
		}
		promoteGrassFaces(tint)
		// A pack that declared a tint_method or a render_method has said
		// what it wants; a measurement of its pixels is not entitled to
		// disagree with it.
		for face, channel := range b.opts.BlockTint[id] {
			if _, drawn := faces[face]; drawn || face == wildcardFace {
				tint[face] = channel
			}
		}
		if declared, ok := b.opts.BlockRender[id]; ok && declared != "" {
			render = declared
		}

		blk := Block{
			Faces:       collapseInts(faces),
			Keys:        collapseStrings(keys),
			Tint:        collapseStrings(tint),
			Render:      render,
			ResourceKey: resourceKey,
		}
		if len(tintColor) > 0 {
			blk.TintColor = collapseStrings(tintColor)
		}
		if shape := b.opts.BlockShape[id]; shape != "" {
			blk.Shape = shape
		}
		if note := b.opts.BlockNote[id]; note != "" {
			blk.Note = note
		}
		b.table.Blocks[id] = blk
		// A state-specific row is not a block (see isStatedID): counting it
		// would make "N blocks, M fully textured" depend on how many
		// permutations a pack happens to use, which is not the number anyone
		// reading that line is asking about.
		if isStatedID(id) {
			continue
		}
		if len(faces) == len(rptex.CubeFaces) {
			b.stats.BlocksFull++
		} else {
			b.stats.BlocksPartial++
		}
	}

	for _, key := range sortedKeys(keyMisses) {
		b.stats.TextureKeysBad++
		b.table.Misses.Textures = append(b.table.Misses.Textures, TextureMiss{Key: key, Reason: keyMisses[key]})
	}
	sort.Slice(b.table.Misses.Textures, func(i, j int) bool {
		a, c := b.table.Misses.Textures[i], b.table.Misses.Textures[j]
		if a.Path != c.Path {
			return a.Path < c.Path
		}
		return a.Key < c.Key
	})
	b.buildTints()
}

// isStatedID reports whether id is a STATE-SPECIFIC row rather than a block:
// the canonical "name#k=v,k=v" spelling internal/packrender files a block's
// per-permutation faces under (see block.CanonicalKey). Such a row is an
// alternative appearance of a block already counted, not another block.
func isStatedID(id string) bool { return strings.Contains(id, "#") }

func (b *builder) blockMiss(id, reason string) {
	if isStatedID(id) {
		// A state row whose faces did not resolve is not a block the atlas is
		// missing: the block itself is present, drawn with its default faces,
		// and packrender has already reported the key that failed. Recording
		// it here too would put one line per state combination in front of a
		// reader looking for blocks with no binding at all.
		return
	}
	b.stats.BlocksMissing++
	b.table.Misses.Blocks = append(b.table.Misses.Blocks, BlockMiss{ID: id, Reason: reason})
}

func (b *builder) keyMissReason(key string) string {
	if _, ok := b.terrain.Keys[key]; !ok {
		return "texture key not present in terrain_texture.json"
	}
	return "texture key is present in terrain_texture.json but none of its paths could be packed; see the path-level misses"
}

// tintFor decides what a face has to be multiplied by, and returns the tint
// channel plus, when one could be measured, a concrete default multiplier.
//
// The order matters and each step is a measurement, not a guess:
//
//  1. The terrain entry declares overlay_color. That is vanilla's own marker
//     for a per-biome tint list and, in bedrock-samples v1.26.30.5, exactly
//     two keys carry it: grass_side and grass_carried.
//  2. The texture path ends in "_grey" and the pack also ships the same path
//     without that suffix. Again exactly two in vanilla -- water_still_grey
//     and water_flow_grey -- and the coloured twin is what the grey one is
//     meant to be multiplied INTO, so the ratio between their averages is the
//     multiplier.
//  3. The texture measures grey and the block declares a carried_textures
//     entry for the same face whose own average is not grey. Mojang bakes a
//     fixed default tint into the held-item art for exactly this class of
//     block (leaves, vines, tall grass, corals, sea pickles), so the ratio
//     between the two averages is again a measured multiplier rather than an
//     invented constant. This is the same signal block/vanilla/colors.json's
//     carried-texture fallback already uses; here it becomes a multiplier
//     instead of a replacement colour, which means the TEXTURED render's
//     average lands on the flat colour the preview already draws.
//  4. Nothing above applied, so no multiply: "none". A face that reaches here
//     over a texture that DOES measure grey -- stone, cobblestone, bedrock,
//     every genuinely grey material, plus the handful of grey foliage
//     textures whose block ships no carried art -- is counted in
//     Stats.UntintedGrey and is identifiable in the table itself by its
//     cell's "grey" flag. It is not given a channel of its own: the renderer
//     resolves an unknown channel to white anyway, so a made-up name would
//     buy nothing and would fail a consumer's channel check.
func (b *builder) tintFor(entry rptex.BlockEntry, face, textureKey string, cellIdx int) (channel, colour string) {
	variants := b.terrain.Keys[textureKey]
	if len(variants) > 0 && variants[0].Overlay != nil {
		return TintGrass, variants[0].Overlay.Hex()
	}
	if len(variants) > 0 {
		if twin, cut := strings.CutSuffix(variants[0].Path, "_grey"); cut {
			if twinIdx, ok := b.byPath[twin]; ok {
				return TintWater, rptex.TintFactor(b.avg[cellIdx], b.avg[twinIdx]).Hex()
			}
		}
	}
	if !b.table.Cells[cellIdx].Grey {
		return TintNone, ""
	}
	if carriedKey, ok := entry.Carried.Key(face); ok {
		if carriedIdx, ok := b.table.Textures[carriedKey]; ok && !b.avg[carriedIdx].Achromatic() {
			return TintFoliage, rptex.TintFactor(b.avg[cellIdx], b.avg[carriedIdx]).Hex()
		}
	}
	return TintNone, ""
}

// promoteGrassFaces renames a block's "foliage" faces to "grass" when the
// same block has a face vanilla explicitly marked as grass-tinted.
//
// This exists for one block shape and is worth the four lines: a grass block's
// SIDE resolves through grass_side, which carries overlay_color and is
// therefore unambiguously grass-tinted, while its TOP resolves through
// grass_top, which carries no overlay and is only recognisable as tinted at
// all through its carried texture. Left alone the top would ask for the
// foliage channel, and a renderer with real biome colours would paint the top
// of a grass block with the leaf colour. The measured multiplier in
// tint_color is untouched either way.
func promoteGrassFaces(tint map[string]string) {
	hasGrass := false
	for _, channel := range tint {
		if channel == TintGrass {
			hasGrass = true
			break
		}
	}
	if !hasGrass {
		return
	}
	for face, channel := range tint {
		if channel == TintFoliage {
			tint[face] = TintGrass
		}
	}
}

// buildTints documents every channel the blocks actually used, with a
// representative default for a renderer that ignores the per-face measured
// tint_color. The defaults are taken from the first block face (in sorted
// block-ID order, then fixed face order) that used the channel, so they are
// measured from this pack's own art and stable across runs.
func (b *builder) buildTints() {
	descriptions := map[string]string{
		TintNone:    "no multiply: either the texture is already the colour it should be drawn in, or it measures greyscale (see the cell's \"grey\" flag) and nothing in the pack says what to multiply it by",
		TintGrass:   "grass biome colour; marked in the pack by terrain_texture.json overlay_color",
		TintWater:   "water biome colour; marked in the pack by a _grey texture with a coloured twin",
		TintFoliage: "foliage biome colour; marked by a greyscale texture with a pre-tinted carried (held-item) texture",
	}
	defaults := map[string]string{}
	for _, id := range sortedBlockIDs(b.table.Blocks) {
		blk := b.table.Blocks[id]
		for _, face := range append([]string{wildcardFace}, rptex.CubeFaces...) {
			channel, ok := blk.Tint[face]
			if !ok || channel == TintNone {
				continue
			}
			if _, seen := defaults[channel]; seen {
				continue
			}
			if colour := blk.TintColor[face]; colour != "" {
				defaults[channel] = colour
			}
		}
	}
	b.table.Tints = map[string]Tint{}
	for _, blk := range b.table.Blocks {
		for _, channel := range blk.Tint {
			if _, done := b.table.Tints[channel]; done {
				continue
			}
			def, source := defaults[channel], "; default measured from this pack's own art, but see tint_color per face for the exact value"
			if def == "" {
				def, source = "#ffffff", ""
			}
			b.table.Tints[channel] = Tint{Default: def, Source: descriptions[channel] + source}
		}
	}
}

// collapseInts rewrites a six-face map whose values are all equal into a
// single wildcard entry, and leaves anything else alone.
func collapseInts(m map[string]int) map[string]int {
	if len(m) != len(rptex.CubeFaces) {
		return m
	}
	var first int
	seen := false
	for _, v := range m {
		if !seen {
			first, seen = v, true
			continue
		}
		if v != first {
			return m
		}
	}
	return map[string]int{wildcardFace: first}
}

// collapseStrings is collapseInts for string-valued face maps.
func collapseStrings(m map[string]string) map[string]string {
	if len(m) != len(rptex.CubeFaces) {
		return m
	}
	var first string
	seen := false
	for _, v := range m {
		if !seen {
			first, seen = v, true
			continue
		}
		if v != first {
			return m
		}
	}
	return map[string]string{wildcardFace: first}
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedBlockIDs(m map[string]Block) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// withSuppliedBlocks merges the caller's own block IDs into the catalogue
// list, sorted and deduplicated so the table is built in one deterministic
// pass whichever source an ID came from.
func withSuppliedBlocks(ids []string, supplied map[string]map[string]string) []string {
	if len(supplied) == 0 {
		return ids
	}
	seen := make(map[string]bool, len(ids)+len(supplied))
	out := make([]string, 0, len(ids)+len(supplied))
	for _, id := range ids {
		if !seen[id] {
			seen[id], out = true, append(out, id)
		}
	}
	for id := range supplied {
		if !seen[id] {
			seen[id], out = true, append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// suppliedEntry turns an Options.BlockFaces entry into the same TextureSet
// shape a blocks.json entry produces, so both take the identical face
// resolution path afterwards. A behaviour pack's custom block has no
// carried (held-item) texture, so nothing backs its greyscale faces up and
// they resolve to "none" -- which is correct: a pack that wants a tint says
// so in material_instances, and Options.BlockTint carries that.
func (b *builder) suppliedEntry(id string) (rptex.BlockEntry, string, bool) {
	m, ok := b.opts.BlockFaces[id]
	if !ok || len(m) == 0 {
		return rptex.BlockEntry{}, "", false
	}
	set := rptex.TextureSet{Faces: m}
	if len(m) == 1 {
		if flat, only := m[wildcardFace]; only {
			set = rptex.TextureSet{Flat: flat}
		}
	}
	return rptex.BlockEntry{Textures: set}, id, true
}
