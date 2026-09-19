// fossil.go implements minecraft:fossil_feature.
//
// VERSION NOTE: behaviour is identical in 1.26.40.26 and 1.26.50.24 -- the same five draws
// and bounds (4, 8, 16-rotX, 16-rotZ, 10), the same pre-draw structure-overlap early-out,
// both post-draw failure paths (empty corners, ore block resolve), the 0.9/0.1 integrities,
// the "type-level bone match at probability 1.0 plus an always-true world test" rule on the
// ore pass only, one seed capture from the world RNG before both passes, and an unchanged
// schema (ore_block/max_empty_corners only). In 1.26.50.24 each pass's local generator is
// built as a seedable generator and seeded directly with the captured seed; setSeed always
// fully re-initialises the MT state from the seed (no zero special case), so
// localRand = random.New(rnd.GetSeed()) holds exactly in both versions.
//
// STRUCTURES: the eight fossil structures ship in every vanilla behaviour pack, 12 KB total,
// gzip + BIG-ENDIAN Java-style structure-block NBT (author/palette/size/entities/blocks tags --
// NOT the little-endian `.mcstructure` container nbt.go reads). See nbt/legacy.go (the gzip+BE
// reader, sharing nbt.go's own tag-payload logic) and structures/legacy.go (the loader,
// extending structures.BuildLibrary to recognize `.nbt` alongside `.mcstructure`). In all eight
// files (`structures/fossils/fossil_{spine,skull}_0{1-4}.nbt` in a vanilla behaviour pack)
// every palette entry is `{Name: "minecraft:bone_block", Properties: {axis: "x"|"y"|"z"}}`, and
// every `blocks` entry is `{pos: [x,y,z], state: <palette index>}` with no `nbt` key on any of
// the 567 total block entries -- see nbt/legacy.go's own header for the byte-level layout.
// Counted by parsing the eight files with nbt.ParseLegacyStructure: skull_01 86, skull_02 75,
// skull_03 58, skull_04 32, spine_01 37, spine_02 61, spine_03 97, spine_04 121. Byte-identical
// in every vanilla behaviour pack checked (1.18.30, 1.19.70, 1.20.50, 1.21.20); these templates
// have not moved in years. (This header used to say 313, which was simply wrong: no subset of
// the eight sums to it -- the four spine files, at 316, are the nearest thing -- and no other
// count of the data lands there either.)
//
// ============================================================================================
// RNG DRAW SEQUENCE -- exactly five draws from ctx.Random (the world-gen/chunk-decoration
// Random). PRESERVED EXACTLY, including the abort path that draws NOTHING: RNG call order is
// the entire correctness contract for a type like this.
// ============================================================================================
//
//  1. rnd.NextIntBound(4) -- rotation (0..3).
//  2. rnd.NextIntBound(8) -- structure index. 0-3 = fossils/fossil_spine_01..04,
//     4-7 = fossils/fossil_skull_01..04 (fossilStructureNames below).
//  3. rnd.NextIntBound(16 - rotSizeX) -- X offset. rotSizeX/rotSizeZ are the
//     structure's raw size with X/Z SWAPPED when rotation is 1 or 3 (the game asks the template
//     for its rotated size; this port reads size straight off the parsed structure instead).
//  4. rnd.NextIntBound(16 - rotSizeZ) -- Z offset.
//     -- THEN a draw-free height scan over the rotated footprint (GetAboveTopSolidAt, the port's
//     equivalent of the world's above-top-solid lookup) --
//  5. rnd.NextIntBound(10) -- burial-depth jitter, through the SAME Random.
//
// EARLY-OUT BEFORE ANY DRAW, deliberately NOT modeled -- a DOCUMENTED deviation, not a bug:
// the game asks the dimension's world generator whether a structure feature already claims
// origin, and if so placement fails having drawn ZERO times. This bench has no
// structure-feature/dimension model at all (nothing else in this codebase's
// wgen.BlockWorld surface represents "is there a structure feature here" either), so
// this port always proceeds as if the answer were false -- meaning it can draw and place where
// the game would have silently skipped. There is nothing to warn about per-call (every fossil
// placement in this bench is equally affected, the same "universal, not situational, mismatch"
// class multiface.go's own header already documents for its neighbour-chunk readiness test), so
// this is disclosed here rather than via a runtime LogWarning.
//
// FAILURE PATHS AFTER ALL FIVE DRAWS (both consume the full five draws -- downstream features in
// the same chunk see the shifted stream either way, as in the game):
//   - the empty-corner count (see fossilCountEmptyCorners below) > max_empty_corners.
//   - ore_block's block descriptor fails to resolve. NOT modeled as a runtime failure: ore_block is
//     resolved via ctx.Palette.Resolve at BUILD time (buildFossilFeature below), exactly like
//     every other producing-position block-descriptor field in this codebase (geode.go's filler/
//     inner_layer/etc., multiface.go's places_block) -- Palette.Resolve never fails, it always
//     interns SOMETHING (falling back to a representative block for an unresolved tag). So this
//     abort path is structurally unreachable in this port's own architecture, the same way it
//     already is for every sibling feature type's own block-descriptor fields; not a fossil-
//     specific approximation.
//
// A THIRD FAILURE PATH, ADDED BY THIS PORT -- "No blocks could be placed" (Place's tail). It is a
// DEVIATION, disclosed here rather than left to be discovered: the game has no equivalent. It
// places the structure twice and never looks at what either placement returned; its per-block
// chunk clip is disabled outright (see "DEAD BRANCHES" below), and the result of each block
// write is ignored. Those two post-draw failure paths above are the only ones. So the game
// reports the anchor position as a SUCCESS even when every block it wrote fell somewhere the
// world never kept.
//
// This port cannot do that honestly, because api.SetBlock has a meaning the game's block write does
// not: it returns false for a write outside the finite generated volume this bench works in. A
// fossil whose every block missed that volume has produced nothing, and reporting success would
// hand a parent aggregate/scatter a placement that is not there. So the guard stays -- but it is
// bench geometry talking, not the feature, and it is the same class of bench-only mismatch as
// the structure-overlap early-out above. It costs no draws (all five have already
// happened) and cannot desynchronise anything downstream.
//
// WHEN IT FIRES [measured, 30 seeds per configuration, synthetic structures, solid terrain]:
//
//   - A generated area 10 blocks tall or less: 30 of 30 seeds. The anchor is
//     y = max(MinY()+10, surface - nextInt(10) - 15), so it is never lower than MinY()+10; when
//     the area is 10 blocks tall that floor is at or above MaxY() and every write is out of
//     bounds. At 11 blocks tall, 0 of 30 fail. This threshold is exactly the game's
//     `min height + 10` clamp meeting a bench volume that a real dimension never is.
//   - A generated area narrower than about 32 blocks in X/Z, partially: offX and offZ are
//     nextInt(16 - rotatedSize) measured FROM THE ORIGIN, and that bound is EXCLUSIVE, so the
//     largest offset is 15 - rotatedSize, NOT 15. For the real vanilla templates that is 12 at
//     most (the smallest rotated footprint is 3, in fossil_spine_01's X) and it is 2 for the
//     13-long spines' own long axis; no template a structure file could hold can exceed 14,
//     since a size of 0 is not a structure. With the origin centred, 24 wide loses 5 of 30,
//     16 wide loses 16 of 30, 8 wide loses 24 of 30; 32 wide and up loses none.
//
// Both are reachable only when the corner check has already passed, which for thin terrain means
// max_empty_corners is 8 (or negative); otherwise "Too many empty corners" fires first. The
// message names the cause rather than repeating the bare sibling-feature wording, because
// "No blocks could be placed" on its own tells an author nothing about the size of the area they
// asked for -- and at 30 of 30 seeds this is not an edge case.
//
// ============================================================================================
// PLACEMENT -- the structure is placed TWICE (integrity 0.9/no rules, then integrity 0.1/one
// "type-level bone match at probability 1.0 -> ore_block" rule). NO further
// draws from ctx.Random -- both passes draw from a NEW, LOCAL Random.
// ============================================================================================
//
// Both passes' local Random is freshly constructed and seeded from THE SAME captured seed:
// the world RNG's seed is captured ONCE, before either pass -- that being the seed
// LAST PASSED to New/SetSeed (random.IRandom.GetSeed's own documented contract),
// NOT the twister's current advancing state. So: `localSeed := rnd.GetSeed()`, read ONCE,
// before either pass; each pass is `random.New(localSeed)`, a BRAND NEW generator, not a re-seed
// of one shared instance -- both passes therefore replay the IDENTICAL float-draw stream.
//
// Per pass, per template `blocks` entry, IN FILE ORDER (no reordering, no skip -- fossil templates
// have no ignoreBlock/structure_block/jigsaw entries to skip, and their per-entry integrity roll is
// the ONLY gate -- see the "DEAD BRANCHES" list below for what else structure placement
// handles that fossils never reach):
//
//  1. roll := localRand.NextFloat() -- ONE draw, unconditional (fossil entries are never
//     ignoreBlock/structure_block/jigsaw, so the skip-before-roll branches never fire).
//  2. Place iff roll <= integrity (INCLUSIVE). Pass 1: integrity 0.9. Pass 2: integrity 0.1.
//  3. Position: rotateXZ(entry.x, entry.z, rotation) -- the SAME rotation matrix
//     structure_template.go's own rotateXZ already implements (mirror is always None for fossils,
//     so no mirror term); world = P + (x', entry.y, z').
//  4. Block state (bone pass only -- see below for why the ore pass never needs this):
//     pillar axis Y unchanged; axis X/Z SWAP when rotation is 1 or 3
//     (fossilRotateAxis below; INFERRED in part, see "Residual" below). The legacy block-swap
//     lookup is assumed to be identity for bone_block/ore_block: every special case it
//     implements (doors/trapdoors/stripped logs/legacy wood groups) targets block names
//     bone_block/ore_block do not have, and its auxiliary swap map is empty on the fossil
//     path -- INFERRED.
//  5. Block rule (ore pass ONLY -- there is no rule list on the bone pass, so no rule
//     ever runs there): a structure block rule of {input test: bone_block default state matched at
//     probability 1.0; world test: always true; out: ore_block}. The input test matches the block
//     ABOUT TO BE PLACED at TYPE level
//     (ignoring axis) -- always true, since every fossil template entry is bone_block regardless of
//     rotation -- and its own probability roll at 1.0 returns true WITHOUT drawing (p>=1
//     short-circuit). The world test also never draws. So on the ore pass, EVERY entry
//     that survives its own integrity roll unconditionally becomes ore_block, never bone_block --
//     this port skips step 4's axis computation entirely for the ore pass (its result would be
//     immediately discarded by the rule's own `out: ore_block` regardless).
//  6. Write via api.SetBlock. Waterlogging/block-NBT/chunk-clip branches: all dead for
//     fossil inputs (see below) and not modeled.
//
// NET SEMANTICS: because both passes replay the identical seeded float-draw stream over the
// identical entry list, entries with roll<=0.1 place bone_block in pass 1 and are OVERWRITTEN
// with ore_block in pass 2; 0.1<roll<=0.9 stay bone_block; roll>0.9 place nothing in either
// pass. Ore therefore always ends up strictly inside the bone silhouette, matching the real
// fossil block art.
//
// DEAD BRANCHES, deliberately NOT modeled here (named, so a future reader can check them):
//   - Chunk clip (the fossil path never sets a chunk position for clipping, so the clip box is
//     an inverted INT_MAX/INT_MIN+1 sentinel and the per-block bounds test always passes; every
//     template block places unclipped). This port never computes or checks a clip box at all.
//   - Waterlogging (the "place water below sea level" setting defaults to false and the fossil
//     path never enables it).
//   - Block-entity/loot-seed machinery (needs a `nbt` key on a template entry; none of the
//     eight vanilla files' 567 total entries has one -- see nbt/legacy.go).
//   - ignoreBlock/structure_block/jigsaw per-entry skips (every fossil entry is plain bone_block).
//
// Residual (BOTH INFERRED, non-blocking, disclosed here rather than silently assumed correct):
//   - the block-swap lookup's bone/ore identity (argued above).
//   - the exact pillar-axis rotation rule for X/Z. If a rotated-axis test ever disagrees with
//     the game, start there.
//
// STRUCTURE SOURCING: this port does NOT vendor the eight `.nbt` files into this repository --
// they are Mojang's own game assets, not this project's to redistribute. A user who wants
// fossil_feature to place must point this tool's existing pack loader
// (--pack, or --structures directly) at a directory whose structures/ folder contains
// structures/fossils/fossil_spine_01..04.nbt and fossils/fossil_skull_01..04.nbt UNDER THAT EXACT
// relative path -- e.g. their own installed vanilla behaviour pack's structures/ directory, or
// just those 8 files copied out of it into an otherwise-empty structures/fossils/. pack.Load
// walks BOTH `.mcstructure` and legacy `.nbt` files out of the same
// structures/ tree (see pack/pack.go's walkBinary), so no new CLI flag exists or is needed.
// buildFossilFeature below REFUSES CLEARLY, BY NAME, at feature-BUILD time (not a silent
// place-time no-op) when even one of the eight is missing -- see resolveFossilStructures's own
// error message for exactly what it names and suggests.
package features

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wgen"
)

const (
	fossilTypeID = "minecraft:fossil_feature"

	// fossilBoneIntegrity/fossilOreIntegrity are the two hardcoded integrity values the game
	// uses for its two placement passes -- not schema fields, not configurable.
	fossilBoneIntegrity = 0.9
	fossilOreIntegrity  = 0.1

	// fossilOffsetBound is the nextInt(16 - size) draw's own literal 16 --
	// hardcoded in the game, not a schema field.
	fossilOffsetBound = 16
)

// fossilStructureNames is the fossil feature's structure-name table, in
// nextInt(8) index order -- see this file's header. UNNAMESPACED, matching
// structures.ILegacyResolver's own key domain exactly (legacy structures are looked up by
// an on-disk key that carries no namespace).
var fossilStructureNames = [8]string{
	"fossils/fossil_spine_01", "fossils/fossil_spine_02", "fossils/fossil_spine_03", "fossils/fossil_spine_04",
	"fossils/fossil_skull_01", "fossils/fossil_skull_02", "fossils/fossil_skull_03", "fossils/fossil_skull_04",
}

// isLavaBlock mirrors partially_exposed_blob.go's own isWaterBlock, for the Lava half of
// the empty-corner count's materialType(0|5|6) == Air|Water|Lava test -- see fossilCountEmptyCorners.
func isLavaBlock(pal wgen.IPaletteView, id block.ID) bool {
	name := pal.NameOf(id)
	return name == "minecraft:lava" || name == "minecraft:flowing_lava"
}

// fossilOverlapsWithStructureFeature mirrors the fossil feature's own structure-overlap test
// -- see this file's header, "EARLY-OUT BEFORE ANY DRAW". The game's check asks the
// active dimension's world generator whether a structure feature already
// claims origin; this bench has no structure-feature/dimension model anywhere to ask, so the
// PRODUCTION value of this var is an unconditional false -- fossils in this port are never
// suppressed by a structure feature the way they are in the real game.
//
// Kept as a package-level func var (not written into Place) so fossil_test.go can override it to
// prove the abort path this file's header promises is wired correctly: when it returns true,
// Place must return nil having drawn ZERO times from ctx.Random. This is the same "small
// substitutable seam for a capability this bench genuinely does not have" shape geode.go's
// geodeRandom/geodeStatePalette interfaces already use, via a func var instead of an interface
// since there is no real alternative implementation to type-assert toward, only a hook whose
// wiring needs proving.
var fossilOverlapsWithStructureFeature = func(ctx *wgen.PlacementContext, pos wgen.BlockPos) bool {
	return false
}

// fossilRotateAxis mirrors legacy structure placement's pillar-axis rotation -- see this file's
// header, "Residual". Y is always unchanged; X and Z swap
// when rotation is 1 or 3 (a 90-degree turn), matching rotateXZ's own X/Z-swapping rotations at
// those same two values.
func fossilRotateAxis(axis string, rotation int) string {
	if rotation == 1 || rotation == 3 {
		switch axis {
		case "x":
			return "z"
		case "z":
			return "x"
		}
	}
	return axis
}

// fossilStructure is one resolved, VALIDATED legacy structure -- axisByPaletteIndex[i] is
// raw.Palette[i]'s own "axis" property, pre-extracted and type-checked once at build time
// (newFossilStructure below) so Place() never needs to re-validate or type-assert per block.
type fossilStructure struct {
	key                string
	raw                *structures.ResolvedLegacyStructure
	axisByPaletteIndex []string
}

// newFossilStructure validates raw's palette is exactly what every real vanilla fossil template
// has -- minecraft:bone_block entries, each with an axis property in {x,y,z}, nothing else -- and
// that its size fits fossilOffsetBound's own nextInt(16-size) draw (size < 16 on both horizontal
// axes; every real vanilla fossil template's largest dimension is 13). Refuses by name rather than
// approximating an unrecognized palette entry: this port's legacy-palette mapping only ever needs
// to understand bone_block -- hardcoding the bone_block case is faithful, because the game's
// general legacy mapping for other block names is unreachable from
// fossil data. So anything else arriving here means the file at key is not a real fossil template.
func newFossilStructure(key string, raw *structures.ResolvedLegacyStructure) (*fossilStructure, error) {
	if raw.Size.X >= fossilOffsetBound || raw.Size.Z >= fossilOffsetBound {
		return nil, fmt.Errorf(
			"minecraft:fossil_feature: structure %q has size %dx%dx%d, but the engine's own offset "+
				"draw (nextInt(%d-size)) requires both X and Z under %d -- every real vanilla fossil "+
				"template satisfies this (largest is 13); refusing rather than drawing from an empty "+
				"or negative bound",
			key, raw.Size.X, raw.Size.Y, raw.Size.Z, fossilOffsetBound, fossilOffsetBound)
	}
	axisByPaletteIndex := make([]string, len(raw.Palette))
	for i, entry := range raw.Palette {
		if entry.Name != "minecraft:bone_block" {
			return nil, fmt.Errorf(
				"minecraft:fossil_feature: structure %q palette entry %d is %q, not minecraft:bone_block "+
					"-- this port's legacy-palette mapping only understands bone_block (every real vanilla "+
					"fossil template is bone_block-only; see nbt/legacy.go)", key, i, entry.Name)
		}
		axisRaw, ok := entry.Properties["axis"]
		if !ok {
			return nil, fmt.Errorf(
				"minecraft:fossil_feature: structure %q palette entry %d (minecraft:bone_block) has no "+
					"axis property", key, i)
		}
		axis, ok := axisRaw.(string)
		if !ok || (axis != "x" && axis != "y" && axis != "z") {
			return nil, fmt.Errorf(
				"minecraft:fossil_feature: structure %q palette entry %d has axis %#v, want one of "+
					"\"x\"/\"y\"/\"z\"", key, i, axisRaw)
		}
		axisByPaletteIndex[i] = axis
	}
	return &fossilStructure{key: key, raw: raw, axisByPaletteIndex: axisByPaletteIndex}, nil
}

// resolveFossilStructures resolves and validates all eight fossilStructureNames against
// ctx.LegacyStructures, in nextInt(8) index order. Returns a single combined error naming EVERY
// missing structure (not just the first) when one or more are absent -- see this file's header,
// "STRUCTURE SOURCING", for exactly what a user needs to supply and how.
func resolveFossilStructures(ctx *BuildContext) ([8]*fossilStructure, error) {
	var out [8]*fossilStructure
	var missing []string
	for i, name := range fossilStructureNames {
		raw := ctx.LegacyStructures.ResolveLegacy(name)
		if raw == nil {
			missing = append(missing, name)
			continue
		}
		st, err := newFossilStructure(name, raw)
		if err != nil {
			return out, err
		}
		out[i] = st
	}
	if len(missing) > 0 {
		return out, fmt.Errorf(
			"minecraft:fossil_feature requires all 8 vanilla legacy structures under structures/ "+
				"(unnamespaced -- e.g. structures/fossils/fossil_spine_01.nbt), but %d are missing: %s. "+
				"This tool does not vendor or ship them -- they are Mojang's own game assets. Supply "+
				"them yourself by pointing this tool's pack loader (--pack, or --structures) at a "+
				"directory whose structures/ folder contains these exact files -- e.g. your own "+
				"installed vanilla behaviour pack's structures/ directory, or just these 8 files "+
				"copied out of structures/fossils/ from it. Refusing to build rather than silently "+
				"placing nothing on every draw",
			len(missing), strings.Join(missing, ", "))
	}
	return out, nil
}

// fossilCountEmptyCorners mirrors the fossil feature's own empty-corner count: the 8 corners of
// the axis-aligned box spanning p..p+extent (extent depending on rotation -- see this file's
// header) each count if their world block is Air, Water, or Lava (material-type indices 0, 5 and
// 6). Corner ORDER doesn't matter -- only the count of 8 combinations meeting the
// predicate -- so this enumerates all 8 combinations of (p.X or maxC.X, p.Y or maxC.Y, p.Z or
// maxC.Z) directly, regardless of whether maxC is numerically greater than p on any axis (rotations
// 1-3 can make it "inverted" on X or Z -- the 4 per-rotation formulas are transcribed below).
func fossilCountEmptyCorners(api wgen.BlockWorld, pal wgen.IPaletteView, p wgen.BlockPos, sizeX, sizeY, sizeZ, rotation int) int {
	var maxC wgen.BlockPos
	switch rotation {
	case 1:
		maxC = wgen.BlockPos{X: p.X - (sizeZ - 1), Y: p.Y + (sizeY - 1), Z: p.Z + (sizeX - 1)}
	case 2:
		maxC = wgen.BlockPos{X: p.X - (sizeX - 1), Y: p.Y + (sizeY - 1), Z: p.Z - (sizeZ - 1)}
	case 3:
		maxC = wgen.BlockPos{X: p.X + (sizeZ - 1), Y: p.Y + (sizeY - 1), Z: p.Z - (sizeX - 1)}
	default: // rotation 0
		maxC = wgen.BlockPos{X: p.X + (sizeX - 1), Y: p.Y + (sizeY - 1), Z: p.Z + (sizeZ - 1)}
	}
	count := 0
	for _, cx := range [2]int{p.X, maxC.X} {
		for _, cy := range [2]int{p.Y, maxC.Y} {
			for _, cz := range [2]int{p.Z, maxC.Z} {
				id := api.GetBlock(wgen.BlockPos{X: cx, Y: cy, Z: cz})
				if pal.IsAir(id) || isWaterBlock(pal, id) || isLavaBlock(pal, id) {
					count++
				}
			}
		}
	}
	return count
}

// FossilFeature is minecraft:fossil_feature. A leaf type -- no feature delegation, so it is always
// in scope. See this file's header for the full derivation.
type FossilFeature struct {
	identifier string

	oreBlock        block.ID
	maxEmptyCorners int

	structures      [8]*fossilStructure
	boneBlockByAxis map[string]block.ID // "x"/"y"/"z" -> interned minecraft:bone_block#pillar_axis=<axis>
}

func (f *FossilFeature) TypeID() string     { return fossilTypeID }
func (f *FossilFeature) Identifier() string { return f.identifier }

// emptyCornersExceeded mirrors the game's `(uint64)count > (uint64)(int64)maxEmptyCorners`
// comparison EXACTLY, including its edge case: a negative max_empty_corners sign-extends to a huge
// uint64, so the check can never fail (always passes) for a negative config value.
func (f *FossilFeature) emptyCornersExceeded(count int) bool {
	if f.maxEmptyCorners < 0 {
		return false
	}
	return count > f.maxEmptyCorners
}

// Place mirrors the fossil feature's placement step-by-step -- see this file's header for
// the full description, every RNG draw, and every documented deviation/dead branch.
func (f *FossilFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, fossilTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random
	pal := api.Palette()

	// DEVIATION: fossilOverlapsWithStructureFeature is a constant false in production -- this
	// bench has no structure-feature/dimension model to query. See header, "EARLY-OUT BEFORE ANY
	// DRAW", and that var's own doc comment for the test seam. ZERO draws happen on this path,
	// matching the game's early-out exactly.
	if fossilOverlapsWithStructureFeature(ctx, origin) {
		LogFailure(ctx, fossilTypeID, "Location overlaps an existing structure feature")
		return nil
	}

	rotation := rnd.NextIntBound(4) // *** RNG CALL 1 *** -- nextInt(4), rotation
	idx := rnd.NextIntBound(8)      // *** RNG CALL 2 *** -- nextInt(8), structure index
	st := f.structures[idx]         // never nil -- buildFossilFeature required all 8 to resolve

	sizeX, sizeY, sizeZ := st.raw.Size.X, st.raw.Size.Y, st.raw.Size.Z
	rotSizeX, rotSizeZ := sizeX, sizeZ
	if rotation == 1 || rotation == 3 {
		rotSizeX, rotSizeZ = sizeZ, sizeX
	}

	offX := rnd.NextIntBound(fossilOffsetBound - rotSizeX) // *** RNG CALL 3 ***
	offZ := rnd.NextIntBound(fossilOffsetBound - rotSizeZ) // *** RNG CALL 4 ***

	// Draw-free height scan, X outer (ascending), Z inner (ascending) -- see header.
	minY := origin.Y
	for i := 0; i < rotSizeX; i++ {
		TickDeadline("scanning the ground under the structure its size covers")
		for j := 0; j < rotSizeZ; j++ {
			h := api.GetAboveTopSolidAt(origin.X+offX+i, origin.Z+offZ+j)
			if h < minY {
				minY = h
			}
		}
	}

	draw5 := rnd.NextIntBound(10) // *** RNG CALL 5 ***
	y := minY - draw5 - 15
	minAllowed := api.MinY() + 10
	if y < minAllowed {
		y = minAllowed
	}
	p := wgen.BlockPos{X: origin.X + offX, Y: y, Z: origin.Z + offZ}

	// Draw-free empty-corner check, using the UNROTATED size (rotation still selects which of the
	// 4 corner-box formulas applies -- see fossilCountEmptyCorners).
	if f.emptyCornersExceeded(fossilCountEmptyCorners(api, pal, p, sizeX, sizeY, sizeZ, rotation)) {
		LogFailure(ctx, fossilTypeID, "Too many empty corners")
		return nil
	}

	// Two-pass placement -- NO further draws from ctx.Random (rnd) below this point. Both passes
	// draw from a FRESH local Random seeded from the SAME captured seed -- see header.
	localSeed := rnd.GetSeed()
	placedAny := false

	bonePass := random.New(localSeed)
	for _, entry := range st.raw.Blocks {
		roll := bonePass.NextFloat() // *** LOCAL RNG draw, one per template block entry ***
		if roll > fossilBoneIntegrity {
			continue
		}
		wx, wz := rotateXZ(entry.Pos.X, entry.Pos.Z, rotation)
		axis := fossilRotateAxis(st.axisByPaletteIndex[entry.Palette], rotation)
		pos := wgen.BlockPos{X: p.X + wx, Y: p.Y + entry.Pos.Y, Z: p.Z + wz}
		if api.SetBlock(pos, f.boneBlockByAxis[axis]) {
			placedAny = true
		}
	}

	orePass := random.New(localSeed) // fresh generator, SAME seed -- replays pass 1's stream exactly
	for _, entry := range st.raw.Blocks {
		roll := orePass.NextFloat() // *** LOCAL RNG draw, replaying pass 1's positions exactly ***
		if roll > fossilOreIntegrity {
			continue
		}
		wx, wz := rotateXZ(entry.Pos.X, entry.Pos.Z, rotation)
		pos := wgen.BlockPos{X: p.X + wx, Y: p.Y + entry.Pos.Y, Z: p.Z + wz}
		// The rule's own input test (bone matched at probability 1.0) is always true at type level
		// and never draws (the float chance test short-circuits at p>=1) -- see header step 5 -- so
		// this loop always writes ore_block outright, never bone_block.
		if api.SetBlock(pos, f.oreBlock) {
			placedAny = true
		}
	}

	// PORT-LEVEL FAILURE PATH -- see this file's header, "A THIRD FAILURE PATH, ADDED BY THIS
	// PORT". The game has no equivalent: it never inspects what its structure placement
	// returned and its clip test is disabled, so the game reports
	// success here. What is
	// being detected is api.SetBlock's bench-only meaning -- every block of this fossil fell
	// outside the finite generated volume -- and the message says which geometry did it, because
	// the bare sibling-feature wording tells an author nothing actionable. No draws are consumed
	// on this path; all five have already happened, so nothing downstream shifts.
	if !placedAny {
		LogFailure(ctx, fossilTypeID, fmt.Sprintf(
			"No blocks could be placed: every block of %s fell outside the generated area "+
				"(anchor %d,%d,%d; rotation %d; structure %dx%dx%d; area y %d..%d). A fossil is buried "+
				"15 to 24 blocks below the surface and its anchor is never placed lower than min_y+10 "+
				"(=%d here), so an area 10 blocks tall or less can never hold one; the x/z offset is also "+
				"drawn over 0..%d east and 0..%d south of the origin (nextInt(16-size), EXCLUSIVE, over "+
				"this placement's rotated footprint %dx%d), so an area narrower than about 32 blocks "+
				"loses some placements to that alone. Generate a taller or wider area.",
			fossilStructureNames[idx], p.X, p.Y, p.Z, rotation, sizeX, sizeY, sizeZ,
			api.MinY(), api.MaxY(), minAllowed,
			fossilOffsetBound-1-rotSizeX, fossilOffsetBound-1-rotSizeZ, rotSizeX, rotSizeZ))
		return nil
	}
	result := p
	return &result
}

func buildFossilFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	oreRaw, ok := body["ore_block"]
	if !ok {
		return nil, fmt.Errorf("ore_block is required")
	}
	oreDesc, err := AsBlockDescriptor(oreRaw, "ore_block")
	if err != nil {
		return nil, err
	}
	oreBlock := ctx.Palette.Resolve(oreDesc)

	maxRaw, ok := body["max_empty_corners"]
	if !ok {
		return nil, fmt.Errorf("max_empty_corners is required")
	}
	maxF, ok := toFloat(maxRaw)
	if !ok || maxF != float64(int(maxF)) {
		return nil, fmt.Errorf("max_empty_corners must be an integer")
	}

	structs, err := resolveFossilStructures(ctx)
	if err != nil {
		return nil, err
	}

	boneBlockByAxis := make(map[string]block.ID, 3)
	for _, axis := range [3]string{"x", "y", "z"} {
		boneBlockByAxis[axis] = ctx.Palette.Resolve(block.Descriptor{
			Name:   "minecraft:bone_block",
			States: map[string]block.StateValue{"pillar_axis": axis},
		})
	}

	return &FossilFeature{
		identifier:      ctx.Identifier,
		oreBlock:        oreBlock,
		maxEmptyCorners: int(maxF),
		structures:      structs,
		boneBlockByAxis: boneBlockByAxis,
	}, nil
}

func init() {
	RegisterType(fossilTypeID, buildFossilFeature)
}

var _ wgen.IFeature = (*FossilFeature)(nil)
