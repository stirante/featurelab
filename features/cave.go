// cave.go implements minecraft:cave_carver_feature -- the dry overworld cave carver. The whole family
// lives here: the per-block carve, the ellipsoid and the volume it fills, rooms, tunnels, the
// per-chunk feature loop and the placement entry point, plus the six draw functions the carver
// configuration dispatches through. minecraft:underwater_cave_carver_feature reuses almost all of
// it and ships in features/underwater_cave.go; minecraft:nether_cave_carver_feature does not --
// it owns its own room, tunnel and feature steps, with a different draw cadence, and ships in
// features/nether_cave.go.
//
// ---------------------------------------------------------------------------------------------
// BLOCK NAMES: TWO PLACES BEDROCK DIVERGES FROM JAVA NAMING
// ---------------------------------------------------------------------------------------------
//
// Every block id this file names is the Bedrock block name, not the Java name, and two of them
// diverge in ways a guess from Java would get wrong:
//
//   - the block Java calls "rooted_dirt" is literally "minecraft:dirt_with_roots" here;
//   - the glazed-terracotta colour Java calls "light_gray" is
//     "minecraft:silver_glazed_terracotta", and there is a SEPARATE, also-real
//     "minecraft:gray_glazed_terracotta". The carveable-block test checks BOTH of them, so this
//     is not one slot under another name.
//
// ---------------------------------------------------------------------------------------------
// LEGACY IS ALWAYS FALSE UNDER THE 1.18 CONFIGURATION, WHICH SIMPLIFIES THE PER-BLOCK CARVE
// ---------------------------------------------------------------------------------------------
//
// The carver configuration carries a "legacy" flag -- true in the 1.16-shaped configuration,
// false in the 1.18-shaped one. It changes two things in the per-block carve:
// the ocean-abort special case (with legacy set and no underwater carve yet, abort if the
// biome is ocean) and the lava placement at low Y (with legacy set and y <= 9, place lava, else
// thin-sand + fill). This file implements ONLY the 1.18 configuration, so both branches are
// provably dead: no ocean-abort, and the lava special case never fires -- the carve always takes
// the thin-sand+fill path. CaveCarverConfig keeps a `Legacy bool` and CaveCarveBlock still
// implements both branches faithfully (and is tested with Legacy:true, not merely documented as
// unreachable) so a future 1.16 configuration is a pure data change rather than a rewrite -- but
// CaveConfiguration1_18, the only configuration this file exposes, always sets Legacy: false.
//
// ---------------------------------------------------------------------------------------------
// WHICH CONFIGURATION THE GAME SELECTS
// ---------------------------------------------------------------------------------------------
//
// The carve-shape step picks between the two configurations with a single check: is the world's
// base game version compatible with the Caves & Cliffs update? If it is, the 1.18 configuration;
// otherwise the 1.16 one. Nothing chunk- or position-dependent enters the decision. This bench
// has no world/game-version concept, so it hardcodes the 1.18 configuration, which is what any
// modern world selects. Supporting the 1.16 shape would mean threading a version flag
// through wgen.PlacementContext.
//
// ---------------------------------------------------------------------------------------------
// GRASS RELOCATION: THE SURFACE TEST READS THE BLOCK BEING CARVED AWAY
// ---------------------------------------------------------------------------------------------
//
// The surface test in the per-block carve is evaluated against the ORIGINAL block state AT THE
// CARVE POSITION ITSELF, captured before anything is overwritten -- not against the block one Y
// above. So: if the block about to be carved away was itself a surface block (grass or mycelium)
// and the block one Y BELOW the carve position is dirt or coarse dirt, the carve overwrites that
// position-below with the original pre-carve block state. Digging straight down through a patch
// of grass relocates that exact grass block one layer down onto the dirt underneath it rather
// than deleting it -- grass-path preservation where a tunnel breaches the surface. (A test
// against "the block one Y above is a surface block" would instead fire for any carve anywhere
// below an unrelated distant surface block, which is not what vanilla cave carving looks like.)
package features

import (
	"fmt"
	"math"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"

	molang "github.com/stirante/molang-go"
	"github.com/stirante/molang-go/ast"
	"github.com/stirante/molang-go/eval"
)

// caveNameSet is a set of canonical (minecraft:-prefixed) block names, used both for the
// individually-named checks inside the carveable-block and surface tests and for the four
// block-id group membership tests. At the block-identity level these
// tests are the same kind of check, so this code
// collapses them onto one representation rather than modelling a block-set test
// as something separate.
type caveNameSet map[string]struct{}

func newCaveNameSet(names ...string) caveNameSet {
	s := make(caveNameSet, len(names))
	for _, n := range names {
		s[n] = struct{}{}
	}
	return s
}

func (s caveNameSet) has(pal wgen.PaletteView, id block.ID) bool {
	_, ok := s[pal.NameOf(id)]
	return ok
}

// The four block-id groups the carveable-block test and the sand-thinning pass consult.
// Every member is the Bedrock block name, not a Java name -- see this file's header.
var (
	caveGroupDirt = newCaveNameSet(
		"minecraft:dirt", "minecraft:coarse_dirt",
	)
	caveGroupSandstone = newCaveNameSet(
		"minecraft:sandstone", "minecraft:chiseled_sandstone",
		"minecraft:cut_sandstone", "minecraft:smooth_sandstone",
	)
	caveGroupRedSandstone = newCaveNameSet(
		"minecraft:red_sandstone", "minecraft:chiseled_red_sandstone",
		"minecraft:cut_red_sandstone", "minecraft:smooth_red_sandstone",
	)
	caveGroupSand = newCaveNameSet(
		"minecraft:sand", "minecraft:red_sand", "minecraft:suspicious_sand",
	)
)

// caveDiggableNamed is the individually-name-checked blocks in the 1.18 carveable-block test:
// THIRTY-TWO of them, 16 non-terracotta plus 16 terracotta; with stone that makes 33 names.
// (Stone is checked separately, first, in CaveIsDiggable1_18 below.)
// Every string is a Bedrock block name.
//
// THE TERRACOTTA HERE IS GLAZED, AND THAT IS CORRECT. Do not "fix" it. All sixteen entries carry
// the `_glazed_` infix. Hardened clay and the plain-terracotta block-id group both exist in the
// game and neither is referenced anywhere in this test.
//
// This looks like a mistake, and there are three good arguments for that: glazed terracotta
// never occurs in generated terrain so these entries can never fire, badlands terrain IS plain
// terracotta at carve time, and Java's shared carvable-block set is terracotta plus the 16
// coloured, with no glazed. All three are true and the conclusion was still wrong.
//
// The piece that dissolves it: the 1.16 carveable-block test DOES consult the plain-terracotta
// group, and the underwater carver's carveable-block test checks hardened clay AND the
// plain-terracotta group and no glazed id at all. So there is a legacy variant that carves plain
// terracotta and a 1.18 variant that carves glazed, and the three predicates genuinely disagree
// in the game. The apparent inversion between this code's dry and underwater lists is vanilla
// behaviour.
//
// Whether the 1.18 glazed list is a Mojang authoring slip is a different question and not this
// code's to answer. A pack author previewing a dry carver over badlands SHOULD see nothing carved,
// because that is what the game does.
var caveDiggableNamed = newCaveNameSet(
	"minecraft:podzol", "minecraft:grass_block", "minecraft:mycelium",
	"minecraft:snow_layer", "minecraft:packed_ice", "minecraft:deepslate",
	"minecraft:calcite", "minecraft:gravel", "minecraft:dirt_with_roots",
	"minecraft:tuff", "minecraft:iron_ore", "minecraft:deepslate_iron_ore",
	"minecraft:raw_iron_block", "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
	"minecraft:raw_copper_block",
	// 16 glazed-terracotta colours: gray and silver are BOTH real, separate Bedrock blocks
	// and the carveable-block test checks both -- this is NOT a Java "light_gray"
	// rename, see this file's header.
	"minecraft:white_glazed_terracotta", "minecraft:orange_glazed_terracotta",
	"minecraft:magenta_glazed_terracotta", "minecraft:light_blue_glazed_terracotta",
	"minecraft:yellow_glazed_terracotta", "minecraft:lime_glazed_terracotta",
	"minecraft:pink_glazed_terracotta", "minecraft:gray_glazed_terracotta",
	"minecraft:silver_glazed_terracotta", "minecraft:cyan_glazed_terracotta",
	"minecraft:purple_glazed_terracotta", "minecraft:blue_glazed_terracotta",
	"minecraft:brown_glazed_terracotta", "minecraft:green_glazed_terracotta",
	"minecraft:red_glazed_terracotta", "minecraft:black_glazed_terracotta",
)

// CaveIsDiggable1_18 implements the carver's carveable-block test (1.18 shape), which takes two
// blocks: true iff blockAt is stone, OR a member of one of the four block-id groups, OR one of 32
// individually-named blocks (see caveDiggableNamed). blockAbove is accepted to match the
// signature of CaveCarverConfig.IsDiggable, shared with the surface
// test's -- but the test NEVER reads it, which is not what a two-argument "is this diggable" name
// suggests.
func CaveIsDiggable1_18(pal wgen.PaletteView, blockAt, blockAbove block.ID) bool {
	_ = blockAbove
	name := pal.NameOf(blockAt)
	if name == "minecraft:stone" {
		return true
	}
	if caveGroupDirt.has(pal, blockAt) {
		return true
	}
	if _, ok := caveDiggableNamed[name]; ok {
		return true
	}
	if caveGroupSandstone.has(pal, blockAt) || caveGroupRedSandstone.has(pal, blockAt) || caveGroupSand.has(pal, blockAt) {
		return true
	}
	return false
}

// CaveIsSurface1_18 implements the surface test (1.18 shape): true
// iff the block is a grass block or mycelium, nothing else.
func CaveIsSurface1_18(pal wgen.PaletteView, id block.ID) bool {
	name := pal.NameOf(id)
	return name == "minecraft:grass_block" || name == "minecraft:mycelium"
}

// CaveThinSand implements the cave carver's sand-thinning pass: true iff MaxY()-3 > y AND the blocks
// at the argument itself, argument+(0,1,0) and argument+(0,2,0) are ALL members of the sand
// block-id group.
//
// The three reads are at offsets +0, +1 and +2 FROM THE ARGUMENT -- not +1, +2 and +3. The
// distinction is easy to miss because the single caller passes `above` (the carve position
// shifted up one), which makes the two readings agree for that caller and disagree for any other.
//
// Groups: the sand group ONLY. Neither sandstone group is consulted anywhere in the pass.
//
// The two arguments come from different places in the caller: the position is the carve
// position SHIFTED UP ONE, while the trailing int is the ELLIPSOID-TEST row, which is the carve
// position's y MINUS ONE (see NewCaveEllipsoidVolumeWithGate). CaveCarveBlock passes pos.Y-1 here
// accordingly.
func CaveThinSand(api wgen.BlockWorld, pos wgen.BlockPos, y int) bool {
	if api.MaxY()-3 <= y {
		return false
	}
	pal := api.Palette()
	for dy := 0; dy < 3; dy++ {
		p := wgen.BlockPos{X: pos.X, Y: pos.Y + dy, Z: pos.Z}
		if !caveGroupSand.has(pal, api.GetBlock(p)) {
			return false
		}
	}
	return true
}

// CaveCarverConfig holds the carver configuration's values: Legacy plus the five
// functions it dispatches through -- TunnelThickness, Distance, IsDiggable, IsSurface and
// RandomY. See this file's "THE CARVER CONFIGURATION'S SIX DRAW FUNCTIONS" section for the draw
// sequence each of them takes. CaveConfiguration1_18 (below) is the only value this file builds.
type CaveCarverConfig struct {
	// Legacy is the configuration's own legacy flag: true in the 1.16 configuration, false in the
	// 1.18 one -- see this file's header ("LEGACY IS ALWAYS FALSE").
	Legacy bool
	// TunnelThickness is the tunnel-thickness draw, in whichever shape the configuration selects.
	TunnelThickness func(rnd random.RandomSource) float32
	// Distance is the tunnel-length draw.
	Distance   func(rnd random.RandomSource) int
	IsDiggable func(pal wgen.PaletteView, blockAt, blockAbove block.ID) bool
	IsSurface  func(pal wgen.PaletteView, id block.ID) bool
	// RandomY is the vertical-position draw. The 1.16 and 1.18 shapes are different ALGORITHMS,
	// not one algorithm with two sets of numbers -- see the section named above.
	RandomY func(rnd random.RandomSource, bound int) int
}

// CaveConfiguration1_18 implements the carver configuration in its 1.18 shape -- the only complete
// configuration this file implements. The 1.16 carveable-block and surface tests remain unimplemented.
var CaveConfiguration1_18 = CaveCarverConfig{
	Legacy:          false,
	TunnelThickness: CaveTunnelThickness1_18,
	Distance:        CaveDistance1_18,
	IsDiggable:      CaveIsDiggable1_18,
	IsSurface:       CaveIsSurface1_18,
	RandomY:         CaveUniformRandomY1_18,
}

// ---------------------------------------------------------------------------------------------
// THE ELLIPSOID VOLUME CARVE
// ---------------------------------------------------------------------------------------------
//
// The ellipsoid carve takes no draws of its own. It accepts a generator and forwards it to the
// volume carve, which differs per carver: the dry carver's implementation never draws from it, but
// the underwater carver's does (features/underwater_cave.go), so the generator is live
// and must be threaded rather than substituted.
//
// CaveCarveBlock leaves out two inputs that have no effect on this bench: a
// float position used only
// by the ocean-abort check's biome lookup (dead under the 1.18 configuration and under
// this bench's one-biome-per-placement model), and a block
// position used only for the fill-block choice's aquifer sampling, which the
// no-aquifer path this bench takes never reads. Both are inert here, not unmodelled.
//
// The volume carve's core algorithm, given the bounding box the ellipsoid carve computes
// (chunk-local X/Z, absolute-world Y, all exclusive upper bounds) and setting its opening water
// gate aside (see CaveWaterGate below):
//
// The carve scans x ascending, then z ascending, then y descending. A column outside the horizontal
// ellipse is skipped, as is a row at or below the drawn floor_level or outside the full ellipsoid.
// A surviving row carves the cell one above the tested row, so carved rows span MinY+1 to MaxY. The
// carved-any flag starts false for the whole volume and is never reset: once one carve succeeds,
// every later carve in the box sees true. The volume carve always returns true.
//
// The carving parameters' floor_level is an RNG-drawn sample from a float range, taken by
// whichever of the room, tunnel or carve-shape step builds the record this function receives; see
// CaveCarvingParameters. One more value in that record has no effect
// in this bench, and is not
// modelled.
//
// ---------------------------------------------------------------------------------------------

// oceanBiomeTag is the ocean biome tag: the literal "ocean", with no "minecraft:" namespace --
// biome tags are not namespaced the way block ids are.
const oceanBiomeTag = "ocean"

// CaveNoFill is the sentinel CaveCarveBlock/NewCaveEllipsoidVolume use for an omitted "fill_with"
// JSON field. In the game an omitted fill_with means "no fill block", and the per-block carve
// skips the write when there is none. So a genuinely omitted fill_with is NOT a crash, it is
// vanilla behaviour: every OTHER effect of the carve (thin-sand capping, grass-onto-dirt
// relocation) still happens, and only the position itself is never overwritten.
//
// No real block.ID is ever negative (see block.ID's own doc comment: an interned, zero-based
// palette handle), so -1 can never collide with a genuinely resolved block, without changing
// CaveCarveBlock's block.ID parameter type.
const CaveNoFill block.ID = -1

// CaveCarveBlock implements the cave carver's single-block carve. It takes NO draws at all.
//
// fillWith is the resolved "fill_with" JSON field; CaveNoFill (see above) stands in for the field
// omitted, matching the game's no-fill-block behaviour exactly.
//
// Returns false when the carveable-block test rejects blockAt (the carve does nothing) or --
// legacy configurations only, see "LEGACY IS ALWAYS FALSE" in this file's header -- the
// ocean-abort special case fires; true otherwise, which is every call through
// CaveConfiguration1_18, since both of those exits are unreachable when config.Legacy is false.
func CaveCarveBlock(ctx *wgen.PlacementContext, config CaveCarverConfig, fillWith block.ID, pos wgen.BlockPos, carvedAny bool) bool {
	api := ctx.API
	pal := api.Palette()

	above := wgen.BlockPos{X: pos.X, Y: pos.Y + 1, Z: pos.Z}
	blockAt := api.GetBlock(pos)      // also the "restore" value the surface branch below writes
	blockAbove := api.GetBlock(above) // passed to IsDiggable but never read by it

	if !config.IsDiggable(pal, blockAt, blockAbove) {
		return false
	}

	legacy := config.Legacy
	if legacy && !carvedAny {
		// Dead under CaveConfiguration1_18 -- see this file's header. Ocean-floor
		// protection: abort the whole carve if the biome at the position one Y above is
		// tagged "ocean". This bench models one PlacementContext-wide biome, not a
		// per-position query, the same simplification the fill-block choice's no-aquifer
		// bench model already carries.
		if ctx.Biome != nil {
			if _, ok := ctx.Biome.Tags[oceanBiomeTag]; ok {
				return false
			}
		}
	}

	// BOTH of the next two checks read the ELLIPSOID-TEST row, which is always pos.Y-1 (see
	// NewCaveEllipsoidVolumeWithGate). This code derives it from pos rather than widening the
	// signature.
	unshiftedY := pos.Y - 1

	if unshiftedY <= 9 && legacy {
		// Dead under CaveConfiguration1_18 -- see this file's header. The comparison is
		// against 9 on the TEST row, i.e. carve positions up to Y=10 get lava under a legacy
		// configuration.
		lava := pal.Resolve(block.NameDescriptor("minecraft:lava"))
		api.SetBlock(pos, lava)
		return true
	}

	if CaveThinSand(api, above, unshiftedY) {
		// The thin-sandstone cap (see CaveThinSand's own doc comment) is written at
		// pos+(0,1,0) -- the first of the three sand layers the sand-thinning pass just
		// checked -- not at pos itself. This is what holds the sand column above the new
		// tunnel ceiling up; pos itself is overwritten with fillWith unconditionally two
		// lines below regardless of this branch.
		sandstone := pal.Resolve(block.NameDescriptor("minecraft:sandstone"))
		api.SetBlock(above, sandstone)
	}
	// The game skips the write when there is no fill block -- CaveNoFill (see above) reproduces
	// that exactly: an omitted "fill_with" carves everything else (thin-sand cap, grass
	// relocation) but never overwrites pos itself.
	if fillWith != CaveNoFill {
		api.SetBlock(pos, fillWith)
	}

	// The surface test reads the ORIGINAL block that occupied pos (blockAt), not the block
	// one Y above -- see this file's header.
	if config.IsSurface(pal, blockAt) {
		below := wgen.BlockPos{X: pos.X, Y: pos.Y - 1, Z: pos.Z}
		if caveGroupDirt.has(pal, api.GetBlock(below)) {
			api.SetBlock(below, blockAt)
		}
	}
	return true
}

// CaveVec3 is a float vector of three components -- the ellipsoid carve's centre. This bench had no existing float-vector type; introduced here rather than reusing
// wgen.BlockPos (int-valued) or inventing per-caller ad-hoc float triples.
type CaveVec3 struct {
	X, Y, Z float32
}

// CaveChunkPos is a chunk position: X and Z.
type CaveChunkPos struct {
	X, Z int
}

// CaveBoundingBox is the carve's bounding box: MinX, MinY, MinZ, MaxX, MaxY,
// MaxZ. MinX/MinZ/MaxX/MaxZ are CHUNK-LOCAL (0..16, since only X/Z are chunked into 16-block
// columns); MinY/MaxY are ABSOLUTE WORLD Y, because no such chunking exists on the Y axis. All
// three Max* fields are EXCLUSIVE upper bounds, matching the volume carve's own loop conditions:
// `x < MaxX`, and descending `y` from `MaxY-1` down to `MinY` inclusive.
type CaveBoundingBox struct {
	MinX, MinY, MinZ int
	MaxX, MaxY, MaxZ int
}

// CaveEllipsoidConfig holds the one instance-level value the ellipsoid carve reads: HeightLimit,
// the "height_limit" JSON int field, which clamps the ellipsoid's Y upper bound to
// min(api.MaxY()-2, height_limit). The field is optional, and its default is 0 -- a degenerate
// clamp (every carve's ceiling pinned near Y=0), but the game's real behaviour for an omitted
// height_limit.
type CaveEllipsoidConfig struct {
	HeightLimit int
}

// CaveCarvingParameters holds the carving parameters this bench uses, as far as its
// dependency chain reaches. One further value is deliberately NOT modelled: it
// affects neither the per-block carve nor the room step's
// computation.
type CaveCarvingParameters struct {
	// HorizontalRadiusMultiplier is the "horizontal_radius_multiplier" float-range JSON field,
	// drawn once per carve-shape iteration (see CaveCarveChunk).
	HorizontalRadiusMultiplier float32
	// VerticalRadiusMultiplier is the "vertical_radius_multiplier" field, same shape.
	VerticalRadiusMultiplier float32
	// FloorLevel is the "floor_level" field, compared directly against the computed per-block dy
	// in the volume carve's inside-test. Drawn once per carve-shape iteration like the two above,
	// so this file supplies no default of its own; callers decide.
	FloorLevel float32
}

// CaveEllipsoidVolumeFunc is the ellipsoid volume carve the ellipsoid carve dispatches through --
// it varies by carver type, unlike the carver configuration's carveable-block and surface tests,
// which vary by configuration. There are two implementations, sharing an identical parameter list: the dry carver's, which ships below as
// NewCaveEllipsoidVolume, and the underwater carver's, which ships as
// NewUnderwaterCaveEllipsoidVolume in features/underwater_cave.go. Parameterising the seam here
// is what makes the second one a data change rather than a rewrite.
type CaveEllipsoidVolumeFunc func(
	ctx *wgen.PlacementContext,
	config CaveCarverConfig,
	rnd random.RandomSource,
	chunk CaveChunkPos,
	center CaveVec3,
	bounds CaveBoundingBox,
	radiusXZ, radiusY float32,
	params CaveCarvingParameters,
) bool

// CaveEllipsoid implements the cave carver's ellipsoid carve. It takes no draws of its own; the
// generator it accepts is FORWARDED to carveVolume, and whether it is drawn from depends on which
// volume carve carveVolume holds -- the dry carver's never draws, the underwater carver's does.
// Callers must therefore pass the generator the game uses here (the room and tunnel steps' local
// generator), not the placement stream.
//
// Two things this function does, in order:
//
//  1. A broad-phase test: does the ellipsoid's horizontal (X/Z) footprint come anywhere near
//     `chunk`'s own 16x16 column? Uses a generous square (not circular) padding of
//     16+2*radiusXZ around the chunk's own center. If not, returns true immediately WITHOUT
//     calling carveVolume at all -- a true no-op success, not a failure.
//  2. Otherwise, computes the exact chunk-local X/Z (0..16) and absolute-world Y bounding box the
//     ellipsoid occupies within this one chunk (clamped to the chunk's own 0..16 span and, for Y,
//     to [1, min(api.MaxY()-2, ellipsoidCfg.HeightLimit)]), and calls carveVolume with it,
//     returning carveVolume's own result unchanged.
//
// THE Y CLAMP, which has two details an algebraic check against the Java lineage would NOT have
// caught:
//
// With limit the smaller of MaxY-2 and height_limit, the top bound is limit when floor(y+r) reaches
// it and otherwise max(floor(y+r), 0)+1. The bottom bound is the top bound when floor(y-r)-1 exceeds
// it and otherwise max(floor(y-r)-1, 1).
//
// The two details: the clamp-to-0 on the raw upper floor only bites when `floor(y+r) < 0` (giving
// maxY = 1), and the last line is a degenerate-range collapse whose strict `>` is why this code's
// `<=` is right. Note also the deliberate asymmetry -- Y clamps against 1, while X and Z clamp
// against 0.
func CaveEllipsoid(
	ctx *wgen.PlacementContext,
	config CaveCarverConfig,
	ellipsoidCfg CaveEllipsoidConfig,
	carveVolume CaveEllipsoidVolumeFunc,
	rnd random.RandomSource,
	chunk CaveChunkPos,
	center CaveVec3,
	radiusXZ, radiusY float32,
	params CaveCarvingParameters,
) bool {
	api := ctx.API

	worldOriginX := chunk.X * 16
	worldOriginZ := chunk.Z * 16

	// Broad-phase test. Building a block position from a float vector floors each component
	// (see caveFloor32) -- only X/Z are needed here.
	centerBlockX := caveFloor32(center.X)
	centerBlockZ := caveFloor32(center.Z)
	chunkCenterX := float32(worldOriginX + 8)
	chunkCenterZ := float32(worldOriginZ + 8)
	padding := float32(16) + radiusXZ*2
	if !(centerBlockX >= chunkCenterX-padding && centerBlockX <= chunkCenterX+padding &&
		centerBlockZ >= chunkCenterZ-padding && centerBlockZ <= chunkCenterZ+padding) {
		return true // ellipsoid's footprint is nowhere near this chunk -- no-op success
	}

	// Y bounds: absolute world coordinates, clamped against BOTH api.MaxY()-2 and the
	// CaveFeature-instance-level HeightLimit (whichever is smaller wins), with a degenerate-range
	// guard identical in shape to the X/Z clamps below.
	maxYLimit := api.MaxY() - 2
	if maxYLimit > ellipsoidCfg.HeightLimit {
		maxYLimit = ellipsoidCfg.HeightLimit
	}
	rawYUpper := int(caveFloor32(center.Y + radiusY))
	yUpperClamped := rawYUpper
	if yUpperClamped < 0 {
		yUpperClamped = 0
	}
	var maxY int
	if rawYUpper < maxYLimit {
		maxY = yUpperClamped + 1
	} else {
		maxY = maxYLimit
	}

	rawYLowerMinus1 := int(caveFloor32(center.Y-radiusY)) - 1
	yLowerCandidate := rawYLowerMinus1
	if yLowerCandidate < 1 {
		yLowerCandidate = 1
	}
	var minY int
	if rawYLowerMinus1 <= maxY {
		minY = yLowerCandidate
	} else {
		minY = maxY
	}

	// X bounds: chunk-local (0..16).
	maxX := int(caveFloor32(center.X+radiusXZ)) - worldOriginX
	if maxX >= 15 {
		maxX = 15
	}
	maxX++
	minX := int(caveFloor32(center.X-radiusXZ)) - worldOriginX - 1
	if minX < 0 {
		minX = 0
	}

	// Z bounds: chunk-local (0..16), same shape as X.
	maxZ := int(caveFloor32(center.Z+radiusXZ)) - worldOriginZ
	if maxZ >= 15 {
		maxZ = 15
	}
	maxZ++
	minZ := int(caveFloor32(center.Z-radiusXZ)) - worldOriginZ - 1
	if minZ < 0 {
		minZ = 0
	}

	bounds := CaveBoundingBox{MinX: minX, MinY: minY, MinZ: minZ, MaxX: maxX, MaxY: maxY, MaxZ: maxZ}
	// rnd is FORWARDED, not replaced with ctx.Random. The game passes the room or tunnel step's
	// own throwaway generator here, and the underwater carver's volume carve DOES draw from it
	// (features/underwater_cave.go, the magma/obsidian band's single float draw).
	// Substituting ctx.Random would both feed the shared placement stream draws the game never
	// takes there and starve the local generator of the ones it should have taken.
	return carveVolume(ctx, config, rnd, chunk, center, bounds, radiusXZ, radiusY, params)
}

// caveFloor32 is what building a block position from a float vector does to each component:
// round toward negative infinity. Not nearest, and not truncation toward zero.
func caveFloor32(v float32) float32 {
	return float32(math.Floor(float64(v)))
}

// ---------------------------------------------------------------------------------------------
// THE WATER GATE
// ---------------------------------------------------------------------------------------------
//
// The volume carve's whole triple-nested loop sits behind one opening gate:
//
//	carve iff an aquifer is present or !CaveDetectWater(bounds)
//	the result is true either way
//
// The first half asks whether the world-generation context has an aquifer for the chunk. Only
// the 1.18+ density-function pipeline ever builds one: the classic overworld generator has no
// aquifer, and neither does the nether generator. So for every generator this bench models the
// first half is always false and the gate collapses to exactly `!CaveDetectWater(bounds)`.
//
// The water detection itself is a pure, self-contained block scan over the given API and bounds.
// Everything it reads comes through the world API or the bounding box, so it works on a bench
// with no aquifer concept without loss. Its exact shape is in CaveDetectWater's own doc comment.
//
// CaveWaterGate survives as an explicit seam for the one case the default does not cover, a caller
// modelling an aquifer as present; NewCaveEllipsoidVolume supplies the correct no-aquifer default
// itself.
//
// ---------------------------------------------------------------------------------------------

// caveTypeID is minecraft:cave_carver_feature's own TypeID, used for this file's LogWarning call
// sites.
const caveTypeID = "minecraft:cave_carver_feature"

// caveWaterNames are the two block ids the water detection looks for.
var caveWaterNames = newCaveNameSet("minecraft:water", "minecraft:flowing_water")

// CaveWaterGate is the volume carve's opening gate (aquifer present, or !CaveDetectWater(bounds)) --
// see this file's "THE WATER GATE" section. NewCaveEllipsoidVolume supplies the correct no-aquifer
// default (CaveScanForWaterGate) itself; this type and the explicit NewCaveEllipsoidVolumeWithGate
// constructor remain as the seam an aquifer-modelling caller would use. Returns true iff the carve
// should proceed.
type CaveWaterGate func(ctx *wgen.PlacementContext, chunk CaveChunkPos, bounds CaveBoundingBox) bool

// CaveNoWaterGate always permits the carve. What it models is the game's aquifer-present
// short-circuit, which only the density-function pipeline ever reaches:
// once an aquifer exists, water detection is skipped entirely and fluid placement is delegated to
// it (the fill-block choice's aquifer branch, not implemented here). It is NOT this file's stand-in for
// "this bench has no water" -- NewCaveEllipsoidVolume's built-in default, CaveScanForWaterGate, is
// that case. Pass this explicitly, via NewCaveEllipsoidVolumeWithGate, only when modelling an
// aquifer as present for the carve.
func CaveNoWaterGate(_ *wgen.PlacementContext, _ CaveChunkPos, _ CaveBoundingBox) bool {
	return true
}

// CaveDetectWater implements the cave carver's water detection, pinned exactly:
//
//   - Y range: bounds.MinY-1 .. bounds.MaxY+1, clamped to [api.MinY(), api.MaxY()-1].
//   - X/Z traversal: FULL descending-y column scans over the ENTIRE padded X/Z box, with exactly
//     ONE exception: the single corner column (MaxX-1, MaxZ-1) of a box at least 2 wide and 2
//     deep, which checks only y = hiY and -- when that second point is distinct and in-world,
//     i.e. MinY-1 >= api.MinY() -- y = MinY-1. The condition is
//     `fullColumnX = (x==MinX) || (x != MaxX-1)`, OR'd with `z==MinZ`, with `z != MaxZ-1` also
//     forcing a full column. It is NOT a shell scan: interior columns are scanned in full, and
//     only that one corner column is (mostly) skipped.
//
// chunk supplies the chunk-to-world X/Z origin this bench's own api.GetBlock needs, because the
// bounding box's X/Z fields are chunk-local -- see CaveBoundingBox's own doc comment.
func CaveDetectWater(ctx *wgen.PlacementContext, chunk CaveChunkPos, bounds CaveBoundingBox) bool {
	api := ctx.API
	pal := api.Palette()

	loY := bounds.MinY - 1
	if minY := api.MinY(); loY < minY {
		loY = minY
	}
	hiY := bounds.MaxY + 1
	if maxY := api.MaxY() - 1; hiY > maxY {
		hiY = maxY
	}

	worldOriginX := chunk.X * 16
	worldOriginZ := chunk.Z * 16
	isWater := func(x, y, z int) bool {
		id := api.GetBlock(wgen.BlockPos{X: x + worldOriginX, Y: y, Z: z + worldOriginZ})
		return caveWaterNames.has(pal, id)
	}
	for x := bounds.MinX; x < bounds.MaxX; x++ {
		// A column is full when (x == MinX) || (x != MaxX-1) --
		// i.e. every x EXCEPT the last column of a >=2-wide box.
		fullColumnX := x == bounds.MinX || x != bounds.MaxX-1
		for z := bounds.MinZ; z < bounds.MaxZ; z++ {
			if fullColumnX || z == bounds.MinZ || z != bounds.MaxZ-1 {
				// Full descending column scan, hiY down to loY inclusive.
				// Descending order, even though a
				// boolean short-circuit makes it unobservable.
				for y := hiY; y >= loY; y-- {
					if isWater(x, y, z) {
						return true
					}
				}
				continue
			}
			// The single corner column (MaxX-1, MaxZ-1) of a box that is at
			// least 2 wide and 2 deep: check y = hiY, then
			// y = bounds.MinY-1 only when that second point is distinct and
			// in-world (MinY-1 == loY, i.e. MinY-1 >= world MinY).
			if isWater(x, hiY, z) {
				return true
			}
			if hiY != loY && bounds.MinY-1 == loY && isWater(x, bounds.MinY-1, z) {
				return true
			}
		}
	}
	return false
}

// CaveScanForWaterGate is a CaveWaterGate backed by CaveDetectWater -- proceeds with the carve iff
// no water was found. It is NewCaveEllipsoidVolume's own built-in default, and it is not an
// approximation on either half of the game's two-part gate: both generators this bench models have no aquifer, so the gate reduces
// to exactly this. See this file's "THE WATER GATE" section.
func CaveScanForWaterGate(ctx *wgen.PlacementContext, chunk CaveChunkPos, bounds CaveBoundingBox) bool {
	return !CaveDetectWater(ctx, chunk, bounds)
}

// NewCaveEllipsoidVolume returns a CaveEllipsoidVolumeFunc implementing the dry cave carver's own
// ellipsoid volume carve -- see this file's "THE ELLIPSOID VOLUME CARVE" section for the algorithm.
// It uses the game's default water gate, CaveScanForWaterGate, which is the real behaviour
// for every generator this bench models rather than an injected stand-in. Use
// NewCaveEllipsoidVolumeWithGate to model an aquifer as present instead -- the one case this
// default does not cover, see CaveNoWaterGate's own doc comment.
//
// fillWith is the resolved "fill_with" value (or CaveNoFill when the JSON field was omitted),
// threaded straight through to every CaveCarveBlock call this makes.
func NewCaveEllipsoidVolume(fillWith block.ID) CaveEllipsoidVolumeFunc {
	return NewCaveEllipsoidVolumeWithGate(fillWith, CaveScanForWaterGate)
}

// NewCaveEllipsoidVolumeWithGate is NewCaveEllipsoidVolume with an explicit CaveWaterGate override.
// It is the seam for the one genuine remaining use: a caller modelling an aquifer as present for
// this carve, i.e. the game's aquifer-present short-circuit -- pass CaveNoWaterGate for
// that. Faithful fluid placement under it would additionally need the fill-block choice's aquifer
// branch, which is not implemented. waterGate is REQUIRED here (a nil gate panics immediately) so a
// caller reaching for this constructor by name cannot silently get a no-op gate by omission.
func NewCaveEllipsoidVolumeWithGate(fillWith block.ID, waterGate CaveWaterGate) CaveEllipsoidVolumeFunc {
	if waterGate == nil {
		panic("cave.go: NewCaveEllipsoidVolumeWithGate requires a non-nil CaveWaterGate -- call " +
			"NewCaveEllipsoidVolume(fillWith) for the game's default (no-aquifer) behavior, or " +
			"pass CaveNoWaterGate here to model an aquifer as present, or CaveScanForWaterGate " +
			"explicitly (same as the default) -- see cave.go's \"THE WATER GATE\" section")
	}
	return func(
		ctx *wgen.PlacementContext,
		config CaveCarverConfig,
		rnd random.RandomSource,
		chunk CaveChunkPos,
		center CaveVec3,
		bounds CaveBoundingBox,
		radiusXZ, radiusY float32,
		params CaveCarvingParameters,
	) bool {
		if waterGate(ctx, chunk, bounds) {
			// Core algorithm (see this file's "THE ELLIPSOID VOLUME CARVE" section): X ascending,
			// Z ascending (inner), Y DESCENDING (innermost, MaxY-1 down to MinY inclusive);
			// carvedAny persists across the WHOLE call, not per row.
			worldOriginX := chunk.X * 16
			worldOriginZ := chunk.Z * 16
			carvedAny := false
			for x := bounds.MinX; x < bounds.MaxX; x++ {
				worldX := x + worldOriginX
				dx := (float32(worldX) + 0.5 - center.X) / radiusXZ
				for z := bounds.MinZ; z < bounds.MaxZ; z++ {
					worldZ := z + worldOriginZ
					dz := (float32(worldZ) + 0.5 - center.Z) / radiusXZ
					// float32() per product: FMA barriers. Unparenthesised, gc
					// contracts dx*dx+dz*dz into one FMADDS on arm64 -- see
					// CaveFloatRangeValue's note.
					if float32(dx*dx)+float32(dz*dz) >= 1 {
						continue
					}
					// y here is the ELLIPSOID-TEST row; the block actually carved is ONE ABOVE it
					// (y+1). The game starts the carve position at y = bounds.MaxY BEFORE the
					// test row first decrements, and decrements it again only AFTER each
					// carve, so the carve row trails the test row by one iteration
					// throughout. Carved rows therefore span [MinY+1 .. MaxY] -- the "exclusive"
					// MaxY bound IS carved, and MinY itself never is.
					for y := bounds.MaxY - 1; y >= bounds.MinY; y-- {
						dy := (float32(y) + 0.5 - center.Y) / radiusY
						if dy <= params.FloorLevel {
							continue
						}
						// float32() per product: FMA barriers, as above.
						if float32(dx*dx)+float32(dy*dy)+float32(dz*dz) >= 1 {
							continue
						}
						pos := wgen.BlockPos{X: worldX, Y: y + 1, Z: worldZ}
						ok := CaveCarveBlock(ctx, config, fillWith, pos, carvedAny)
						carvedAny = carvedAny || ok
					}
				}
			}
		}
		// BOTH exit paths return the constant true -- see this file's "THE WATER GATE" section.
		return true
	}
}

// ---------------------------------------------------------------------------------------------
// THE CARVER CONFIGURATION'S SIX DRAW FUNCTIONS
// ---------------------------------------------------------------------------------------------
//
// Three of the carver configuration's five functions take draws: tunnel thickness, tunnel
// length and the vertical position. Each exists in a 1.16 and a 1.18 shape, so six functions in
// all. The two vertical-position shapes are different ALGORITHMS, not one algorithm with two sets
// of numbers -- the 1.16 one is biased, the 1.18 one is
// uniform.
//
// ALL SIX DRAW SEQUENCES:
//
// Tunnel thickness, 1.18 shape: two floats give d1*2+d2, then a bound-10 integer. Only when that
// lands on 0 do two more floats multiply the result by d3*d4*3+1. So 3 or 5 draws. The 1.16 shape
// takes the same two floats and stops there. Distance, 1.18 shape: 112 minus a bound-28 integer, one
// draw. The 1.16 shape draws nothing and gives 0. Random Y, 1.18 shape: a bounded integer on the
// caller's bound, plus 8, one draw. The 1.16 shape draws on the caller's bound, then draws again
// with that result plus 8 as the bound, two dependent draws.
//
// Every one of these six draws is a plain bounded integer draw or a plain float draw -- the same
// no-elision shape the per-block carve's draws already use, and NOT the int-range draw or the
// inclusive two-argument integer draw, which skip their draw under different conditions. The
// bounded integer draw only skips when bound==0, which is dead here: every bound above is either
// a positive literal or unconditionally >0 by construction (10, 28, the caller's own
// height_limit-derived bound, or a prior draw's result+8, which is always >=8).
// random.RandomSource.NextIntBound already models the bound==0 non-draw contract exactly, so no
// per-draw guard is needed.
//
// CaveTunnelThickness1_18/1_16, CaveDistance1_18/1_16, CaveUniformRandomY1_18 and
// CaveBiasRandomY1_16 below implement all six. The 1_16 trio ships even though no complete 1.16
// configuration value exists yet -- the 1.16 carveable-block and surface tests remain unimplemented, so
// building one would be half-real; these three are exposed standalone.
//
// ---------------------------------------------------------------------------------------------

// CaveTunnelThickness1_18 is the tunnel-thickness draw in its 1.18 shape: 2 or 4 NextFloat draws
// plus 1 NextIntBound(10), in the sequence this file's "THE CARVER CONFIGURATION'S SIX DRAW
// FUNCTIONS" section spells out.
//
// EVERY VALUE HERE IS float32, DRAWS INCLUDED -- and that is two separate facts:
//
//  1. The game's arithmetic is a chain of single-precision operations, one rounding each, with
//     no fused multiply-add anywhere.
//  2. The game's float draw itself yields a float32: an exact double from the raw 32-bit draw
//     (a u32 times a power of two needs no rounding), narrowed once. So the value the carver
//     sees has 24 significant bits, not 32.
//
// random.RandomSource.NextFloat returns a float64 carrying all 32, which is why each draw is narrowed
// at its own site here. Narrowing only the arithmetic would leave the double rounding in place:
// measured over 200,000 seeds, 47,995 of them produce a different float32 from this code
// than the all-float64 one did (43,406 for the _1_16 sibling below). The float32() around each
// product is load-bearing, not decoration -- Go permits fusing `a*b + c` into a single FMA on
// arm64 and elsewhere, and an explicit conversion is what forbids it, matching the game's
// separate multiply and add.
func CaveTunnelThickness1_18(rnd random.RandomSource) float32 {
	d1 := float32(rnd.NextFloat())
	d2 := float32(rnd.NextFloat())
	thickness := float32(d1*2) + d2
	if rnd.NextIntBound(10) != 0 {
		return thickness
	}
	d3 := float32(rnd.NextFloat())
	d4 := float32(rnd.NextFloat())
	bias := float32(float32(d3*d4)*3) + 1
	return thickness * bias
}

// CaveTunnelThickness1_16 is the tunnel-thickness draw in its 1.16 shape: always exactly 2
// NextFloat draws, no bias branch (unlike the 1_18 sibling). float32 draws and float32 arithmetic
// for the same two reasons its 1_18 sibling above spells out.
func CaveTunnelThickness1_16(rnd random.RandomSource) float32 {
	d1 := float32(rnd.NextFloat())
	d2 := float32(rnd.NextFloat())
	return float32(d1*2) + d2
}

// CaveDistance1_18 is the tunnel-length draw in its 1.18 shape: one NextIntBound(28) draw.
func CaveDistance1_18(rnd random.RandomSource) int {
	return 112 - rnd.NextIntBound(28)
}

// CaveDistance1_16 is the tunnel-length draw in its 1.16 shape: a hardcoded constant zero, and NO
// draw at all -- the game never touches the generator here.
func CaveDistance1_16(rnd random.RandomSource) int {
	_ = rnd
	return 0
}

// CaveUniformRandomY1_18 is the vertical-position draw in its 1.18 shape: one
// NextIntBound(bound) draw, plus 8.
func CaveUniformRandomY1_18(rnd random.RandomSource, bound int) int {
	return rnd.NextIntBound(bound) + 8
}

// CaveBiasRandomY1_16 is the vertical-position draw in its 1.16 shape -- a BIASED algorithm, not
// the uniform one under different numbers. Two draws, the second's bound depending on the first's
// own result: d1 := rnd.NextIntBound(bound); return rnd.NextIntBound(d1 + 8).
func CaveBiasRandomY1_16(rnd random.RandomSource, bound int) int {
	d1 := rnd.NextIntBound(bound)
	return rnd.NextIntBound(d1 + 8)
}

// ---------------------------------------------------------------------------------------------
// ROOMS
// ---------------------------------------------------------------------------------------------
//
// THE CENTRAL FACT: the room step draws exactly TWO values from the caller's generator -- one
// float, then one unbounded integer -- constructs a BRAND NEW, throwaway generator seeded from
// that second draw, and takes every subsequent draw in the whole function from THAT local object.
// The construction is a real Mersenne twister seeding: the local generator's state is filled with
// the standard 1812433253 recurrence from the just-drawn value.
// A lazy fill gives the same result, which molang-go's own mtrand
// SetSeed documents as equivalent to the simpler bulk regeneration -- so CaveCarveRoom
// below builds the local generator with a plain `random.New(seed)` rather than a copy
// of the fill loop, relying on that already-established equivalence.
//
// The room step takes no separate radius parameters, unlike the ellipsoid carve: it computes its
// own from the carving parameter record's horizontal and vertical radius multipliers times a
// locally derived base size.
//
// A FLOAT RANGE'S VALUE DRAW, which the room step uses for y_scale: ONE plain, boundless float
// draw, then `min + draw*(max-min)`. CaveFloatRangeValue below implements exactly that -- and the
// room step gates it like every other degenerate-range check in this codebase (geodeIntRange,
// treeIntRangeValue): NO draw at all when min == max.
//
// THE ROOM STEP'S OWN DRAW SEQUENCE, in order:
//
// Two draws come from the caller's generator: a float for the size factor (1+d1*6), and an integer
// that seeds a local generator. Everything after that comes from the local one: the y_scale float
// when its range is not fixed, then a bound-28 integer that gives distance 112 minus the result. The
// radius base is sinf(half*pi/distance) with half = distance>>1, times (size factor + width modifier),
// plus 1.5, and y_scale scales the vertical one. A legacy configuration discards 8 raw draws and
// moves the centre +1 on X. With caching on, an ellipsoid record is appended. When the broad-phase
// test below passes, the ellipsoid carves using the local generator.
//
// THE HALVED VALUE: the value the room step halves is `112 - d20`.
// The tunnel-length draw uses bound=28, so
// d20 can only ever be [0,27], making the halved value
// PROVABLY IDENTICAL to `distance` for every possible draw. CaveCarveRoom below implements the
// simple `half := distance>>1` --
// unlike CaveCarverConfig.Legacy's own branches, which stay live because Legacy is a REAL,
// externally supplied bool that can actually vary at runtime. This one cannot, by construction of
// the literal bound.
//
// THE CACHE-LIST APPEND is gated on a per-carver caching flag. Its effect is to build and push one
// cached ellipsoid-parameter record into the list the caller passed. No JSON field sets it -- it
// is the same flag the placement's cached-vs-uncached split uses, a link assumed rather
// than established. CaveRoomConfig.CachingEnabled carries it with that caveat disclosed. Memory
// management of the list is not part of the observable carve algorithm, and Go's `append()` is
// equivalent for every purpose this code needs. The one carving-parameter field with no live use
// is copied into the cache record too, but is not modelled here, for the same reason it was
// dropped from CaveCarvingParameters itself.
//
// THE BROAD-PHASE GEOMETRY TEST:
//
// With dx and dz the offsets from the chunk centre (chunk*16+8), it carves when
// dx*dx + dz*dz - (distance-half)^2 is at most (sizeFactor+2+16)^2.
//
// THE ELLIPSOID CARVE IS CALLED WITH THE LOCAL GENERATOR, NOT THE CALLER'S. This matters even
// though the dry carver's own volume carve never draws: the volume carve varies by carver, and
// the underwater carver's draws one float per carved position. Passing the wrong object
// is measurable in both directions at once -- with the underwater volume, CaveCarveRoom took 258
// draws from the caller instead of its documented 2, and the local generator that should have
// supplied those 258 never saw them. CaveEllipsoid takes an explicit generator and forwards it;
// CaveCarveRoom and CaveCarveTunnel pass localRnd.
//
// WIDTH_MODIFIER: the "width_modifier" JSON field is either a plain constant, in which case the
// room step reads it directly with no evaluation and no draw, or a full Molang expression. Both
// are supported here -- see this file's "WIDTH_MODIFIER" section for the one disclosed
// approximation involved. CaveEvalContext ships as a deliberately opaque placeholder type purely
// so CaveCarveRoom has a place for the Molang evaluation context the
// room, tunnel and carve-shape steps all share, not because this code reads its contents.
//
// ---------------------------------------------------------------------------------------------

// CaveFloatRangeValue is a float range's value draw: ONE NextFloat draw, then
// min + draw*(max-min) computed by the range itself.
//
// THE INNER float32() IS A FUSION BARRIER, NOT NOISE. `min + d*(max-min)` is the
// canonical shape Go is permitted to contract into a single FMA -- one rounding
// where the game has two -- and gc does exactly that on arm64. Verified, not
// assumed: before this conversion existed, `GOARCH=arm64 go build -gcflags=-S`
// emitted FMADDS here (three times over, once per copy Go's inliner made in
// netherCaveCarveFeatureWith's siblings). An explicit conversion rounds and so
// forbids the contraction, matching the game's separate multiply and add -- see
// CaveTunnelThickness1_18 above for why the game never fuses.
// TestCarversHaveNoFusedMultiplyAdd pins it; do not "simplify" the conversion
// away.
func CaveFloatRangeValue(min, max float32, rnd random.RandomSource) float32 {
	d := rnd.NextFloat()
	return min + float32(float32(d)*(max-min))
}

// caveWidthModifierUsesRandom reports whether prog's own AST can reach one of Molang's four
// RNG-drawing math.* functions -- reuses molang-go's own exported eval.RandomFnNames table
// (random/random_integer/die_roll/die_roll_integer) rather than a second, hand-maintained copy of
// "which functions draw". See this file's "WIDTH_MODIFIER" section for where this boundary comes
// from and why it now gates a build-time warning (buildCaveFeature, below) rather than a
// refusal.
func caveWidthModifierUsesRandom(prog *molang.Program) bool {
	found := false
	ast.Walk(prog.AST, func(n ast.Node) bool {
		if found {
			return false
		}
		if call, ok := n.(*ast.CallExpr); ok && call.Callee != nil && call.Callee.Namespace == ast.Math {
			if eval.RandomFnNames[strings.ToLower(call.Callee.Member)] {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

// caveMolangContext builds width_modifier's own evaluation context -- see this file's
// "WIDTH_MODIFIER" section for why ctx.MolangScope/ctx.Biome/ctx.API (the SAME
// wgen.NewMolangContext bridge every other Molang-consuming feature type in this project already
// uses) is this code's answer, and what that answer does NOT reproduce of the game's
// Molang evaluation context. ctx.MolangScope is created lazily and reused, exactly
// like scatter.go's identical lazy-create -- a shared, by-reference scope every composite feature
// in one placement operation sees identically.
//
// localSeed seeds width_modifier's own math.random/math.random_integer/math.die_roll/
// math.die_roll_integer source. It is a value the caller (CaveCarveRoom/CaveCarveTunnel) already
// derived deterministically from the master feature seed -- their own local generator's stored
// seed, read without drawing -- mixed here through random.DeriveSeed and random.DomainCaveWidthModifier
// (random/derive.go, this project's one documented seed-derivation scheme) into a seed for a
// BRAND-NEW, throwaway random.Rand private to this one *molang.Context. Never ctx.Random, and
// never the caller's own localRnd object, so this function cannot perturb either one's draw
// sequence no matter what the compiled expression draws.
func caveMolangContext(ctx *wgen.PlacementContext, localSeed uint32) *molang.Context {
	if ctx.MolangScope == nil {
		ctx.MolangScope = wgen.NewScope()
	}
	widthRnd := random.New(random.DeriveSeed(localSeed, random.DomainCaveWidthModifier))
	// An unresolved read inside width_modifier is swallowed and reported like
	// every other one in this tool (wgen.UnresolvedReadWarning) -- naming the
	// carver's own type, which this site, unlike the generic bridge, knows.
	return wgen.NewMolangContext(widthRnd, ctx.MolangScope, ctx.Biome, ctx.API, func(name string) {
		LogWarning(ctx, caveTypeID, wgen.UnresolvedReadWarning(name), nil)
	})
}

// caveWidthModifier evaluates width_modifier, building the Molang context ONLY when the
// expression will actually read it.
//
// MolangExpr.Evaluate returns before touching its context when the value is constant, which is
// the default and by far the common case. Building one anyway costs a fresh MT19937 seeding --
// measured at 3.95 microseconds -- and one carve of the wiki's own fixture reaches at least 2148
// room and tunnel calls, so roughly TEN PERCENT of an 84ms carve was spent constructing
// contexts that nothing ever read.
//
// Behaviour-preserving in both directions: a constant expression never observed the context, and
// a real expression still gets exactly the one it got before, seeded identically from the same
// local seed. The RNG stream is untouched either way -- the context's generator is derived and
// private, never ctx.Random.
func caveWidthModifier(expr *MolangExpr, ctx *wgen.PlacementContext, localSeed uint32) float32 {
	if expr.IsConstant() {
		return float32(expr.Evaluate(nil))
	}
	return float32(expr.Evaluate(caveMolangContext(ctx, localSeed)))
}

// CaveRoomConfig holds the instance-level values the room step reads -- see this file's "ROOMS"
// section.
type CaveRoomConfig struct {
	// WidthModifier is the "width_modifier" JSON field -- a constant (fast path, no molang-go call
	// at all, MolangExpr.Evaluate's own isConstant branch) OR a compiled Molang program for any
	// real JSON expression string, EVALUATED FOR REAL either way: nothing about width_modifier
	// refuses at build time. An expression whose own AST can reach an RNG-drawing math.* function
	// (math.random/math.random_integer/math.die_roll/math.die_roll_integer) is still compiled and
	// evaluated, against a deterministic stand-in generator private to this evaluation
	// (random/derive.go's DomainCaveWidthModifier) rather than the game's process-global,
	// unseeded source -- disclosed via a build-time ctx.Warn, not a refusal (see
	// caveWidthModifierUsesRandom/caveMolangContext below and this file's "WIDTH_MODIFIER"
	// section). Optional in the schema; its default is the constant 0.0.
	WidthModifier *MolangExpr
	// YScaleMin/YScaleMax are the "y_scale" float range.
	YScaleMin, YScaleMax float32
	// CachingEnabled is the carver's caching flag -- whether the room step appends a
	// CaveEllipsoidRecord record instead of carving; no JSON field sets it -- see this file's
	// "ROOMS" section ("THE CACHE-LIST APPEND").
	CachingEnabled bool
}

// CaveEvalContext is a deliberately opaque placeholder for the game's Molang evaluation context. In the
// game the room step uses that context (shared with the carve-shape and tunnel steps) purely as
// the evaluation context for a Molang width_modifier, which this code supplies its own bridge
// for instead -- see this file's "WIDTH_MODIFIER" section. Kept as an explicit parameter for
// a uniform signature across the room/tunnel/carve-shape family rather than silently dropped.
type CaveEvalContext struct{}

// CaveEllipsoidRecord holds the cached ellipsoid parameters -- the room step's own
// per-room cache-replay record. The one carving-parameter field with no live use is NOT modelled
// here -- see CaveCarvingParameters.
type CaveEllipsoidRecord struct {
	Center       CaveVec3
	RadiusXZ     float32
	RadiusY      float32
	Params       CaveCarvingParameters
	HalfDistance int
	Distance     int
	SizeFactor   float32
}

// CaveCarveRoom implements the cave carver's room step -- see this file's "ROOMS" section for the full
// derivation.
//
// ellipsoidCfg/carveVolume are threaded straight through to CaveEllipsoid exactly like any other
// caller of that function. out receives one appended CaveEllipsoidRecord record iff
// roomConfig.CachingEnabled is set (out may be nil when it is not).
//
// rnd draws exactly 2 values (NextFloat, then NextInt) -- see the section named above for why
// every later draw in this function comes from a throwaway LOCAL generator seeded from that second
// draw, not from rnd itself.
func CaveCarveRoom(
	ctx *wgen.PlacementContext,
	config CaveCarverConfig,
	ellipsoidCfg CaveEllipsoidConfig,
	roomConfig CaveRoomConfig,
	rnd random.RandomSource,
	chunk CaveChunkPos,
	center CaveVec3,
	evalCtx *CaveEvalContext,
	params CaveCarvingParameters,
	carveVolume CaveEllipsoidVolumeFunc,
	out *[]CaveEllipsoidRecord,
) {
	_ = evalCtx // unused -- see CaveEvalContext

	// One room is one ellipsoid carve -- see this file's TickDeadline note above CaveCarveTunnel's
	// own walk for why the tick sits here and per tunnel STEP, and not inside the ellipsoid's own
	// block loop.
	TickDeadline("carving a carver room")

	d1 := rnd.NextFloat()                             // *** RNG CALL 1, caller's rnd ***
	sizeFactor := float32(1) + float32(float32(d1)*6) // inner float32(): FMA barrier

	seed := uint32(rnd.NextInt()) // *** RNG CALL 2, caller's rnd -- the LAST draw taken from it ***
	localRnd := random.New(seed)  // the room step's own throwaway generator -- see "ROOMS"

	yScale := roomConfig.YScaleMin
	if roomConfig.YScaleMin != roomConfig.YScaleMax {
		yScale = CaveFloatRangeValue(roomConfig.YScaleMin, roomConfig.YScaleMax, localRnd) // *** RNG CALL, localRnd, CONDITIONAL ***
	}

	d20 := localRnd.NextIntBound(28) // *** RNG CALL, localRnd, ALWAYS *** -- the room step's own
	// copy of the 1.18 tunnel-length formula (see "ROOMS" for why it is not dispatched through the
	// configuration).
	distance := 112 - d20
	half := distance >> 1 // == (112-d20)>>1 always -- see "ROOMS"

	// The angle constant is FULL-PRECISION float32 pi, not a truncated 3.1416, and the arithmetic
	// is float32 throughout: sinf((f32(half) * pi_f32) / f32(distance)), multiply first, then
	// divide.
	//
	// math.Sin, NOT EngineSin -- deliberately, not an omission. The room step's one trig call is
	// plain libm sine. The nether carver's structurally identical walk uses the game's sine table
	// at the same point; this one does not. The split is per carver and follows no general
	// rule -- see enginemath.go's table of which routines use which.
	angle := float32(math.Sin(float64(float32(half) * float32(math.Pi) / float32(distance))))

	// width_modifier is evaluated EXACTLY ONCE per room, at exactly this point -- see this file's
	// "WIDTH_MODIFIER" section. Its own RNG source is localRnd's stored seed, read without drawing
	// (see caveMolangContext), so it can never perturb localRnd's OWN draw sequence -- which is why
	// this evaluation's position relative to the draws around it is provably irrelevant regardless
	// of what the expression contains.
	widthModifier := caveWidthModifier(roomConfig.WidthModifier, ctx, localRnd.GetSeed())
	horizBase := float32(angle*(sizeFactor+widthModifier)) + 1.5 // float32(): FMA barrier
	vertBase := horizBase * yScale

	centerLocal := center
	if config.Legacy {
		// The game burns 8 raw draws here, discarding every result. NextInt consumes the same
		// single underlying draw per call, so 8 NextInt calls advance localRnd's state
		// identically; only the state advance matters here, not any output.
		for i := 0; i < 8; i++ {
			localRnd.NextInt() // *** RNG CALL x8, localRnd, LEGACY ONLY -- outputs discarded ***
		}
		centerLocal.X += 1
	}

	radiusXZ := horizBase * params.HorizontalRadiusMultiplier
	radiusY := vertBase * params.VerticalRadiusMultiplier

	// THE CACHE-VS-CARVE BRANCH IS if/else, NOT BOTH. The cache-append path skips the
	// broad-phase-test-and-carve code entirely; it never falls through into it. So
	// when CachingEnabled, the room step ONLY builds the cache record -- the placement step
	// does the target-chunk broad-phase test and the carve later, from the cached list -- and when
	// not, it does its own broad-phase test and carves immediately, exactly like CaveCarveTunnel
	// below.
	if roomConfig.CachingEnabled {
		if out != nil {
			*out = append(*out, CaveEllipsoidRecord{
				Center:       centerLocal,
				RadiusXZ:     radiusXZ,
				RadiusY:      radiusY,
				Params:       params,
				HalfDistance: half,
				Distance:     distance,
				SizeFactor:   sizeFactor,
			})
		}
		return
	}

	chunkCenterX := float32(chunk.X*16 + 8) // see "ROOMS", THE BROAD-PHASE GEOMETRY TEST
	chunkCenterZ := float32(chunk.Z*16 + 8)
	dx := centerLocal.X - chunkCenterX
	dz := centerLocal.Z - chunkCenterZ
	distHalfDiff := float32(distance - half)
	threshold := (sizeFactor + 2 + 16) * (sizeFactor + 2 + 16)
	// float32() per product: FMA barriers -- gc fuses this into FMADDS+FMSUBS.
	if float32(dx*dx)+float32(dz*dz)-float32(distHalfDiff*distHalfDiff) <= threshold {
		// The game carves with the room step's throwaway local generator, NOT the caller's. It matters even though the dry carver's volume carve never draws from it:
		// the underwater carver's volume carve does. See "ROOMS".
		CaveEllipsoid(ctx, config, ellipsoidCfg, carveVolume, localRnd, chunk, centerLocal, radiusXZ, radiusY, params)
	}
}

// ---------------------------------------------------------------------------------------------
// THE CARVE-SHAPE STEP
// ---------------------------------------------------------------------------------------------
//
// The carve-shape step is the per-chunk loop that decides how many rooms and tunnels one
// neighbouring chunk contributes and where they start. It draws ONLY from the caller's generator
// and constructs no local generator of its own, unlike the room and tunnel steps it calls.
//
// TWO FIELDS THAT ARE EASY TO CONFLATE. skip_carve_chance is a JSON field and gates the WHOLE
// call; the room-skip bound is a different, hardcoded value and gates one outer iteration's
// room. This code keeps them apart as CaveFeatureConfig.SkipCarveChance and
// caveFeatureRoomSkipBound.
//
// THE SCHEMA IS EXHAUSTIVE. The carver's JSON schema has exactly eight fields, in this order:
// fill_with, width_modifier, skip_carve_chance, height_limit, y_scale,
// horizontal_radius_multiplier, vertical_radius_multiplier, floor_level. All eight are optional,
// with the defaults listed on buildCaveFeature.
//
// That exhaustiveness is what makes a second category of value possible. The carve-shape and
// tunnel steps use several more per-carver values that the schema does not expose, so no pack can
// ever write them: they are HARDCODED CONSTANTS, permanently fixed at their default value for
// every carver the game can construct. That is a
// DIFFERENT kind of "required" from fill_with or height_limit, which are fields a real value could
// exist for; these are constants because no other value is reachable at all. They ship below as
// plain named Go constants (caveFeatureCountBound and friends).
//
// THE CARVE-SHAPE STEP'S OWN DRAW SEQUENCE, in order, ALL from the caller's rnd -- see CaveCarveRoom
// and CaveCarveTunnel for what EACH OF THOSE does to rnd once called from inside this sequence:
//
// Always, in order: a bound-40 integer, a second integer bounded by that plus 1, the count bounded
// by that plus 1, then one on skip_carve_chance. A non-zero skip or a count below 1 ends here, with
// those four draws spent. Each system then draws Z (bound 16), Y through the configuration, X (bound
// 16), the three float ranges where they are not fixed, and a bound-4 room roll. On 0 the room runs
// and a bound-4 draw plus 1 gives the tunnel count, otherwise the count is 1. Then a yaw float, a
// pitch float, the thickness (2 to 5 draws by configuration) and the distance (0 or 1). Every tunnel
// shares those values and draws its own fresh seed, so repeats still diverge.
//
// The tunnel length passed into each tunnel step is a REAL, already-drawn value from the carver
// configuration's tunnel-length function -- not discarded. This matters because the tunnel
// step re-rolls its own length when it is passed a non-positive one, and that branch is therefore
// provably dead for every call made from here (see "TUNNELS", "A LEGACY-BLIND REROLL").
//
// Both angle constants here are full-precision float32 pi, not a truncated 3.1416.
//
// ---------------------------------------------------------------------------------------------

// Hardcoded constants the carve-shape and tunnel steps use that are NOT part of the carver's JSON
// schema at all -- see this file's "THE CARVE-SHAPE STEP" section for why: the schema is
// EXHAUSTIVE at the eight fields this file already models, so these values can only ever hold
// their defaults.
const (
	// caveFeatureCountBound is the default 40 -- the bound for the first of the
	// carve-shape step's three chained bounded integer draws (`bound(bound(bound(40)+1)+1)`,
	// the same vanilla "skewed toward small counts" idiom this project already implements elsewhere).
	caveFeatureCountBound = 40
	// caveFeatureRoomSkipBound is the default 4 -- gates, PER OUTER ITERATION, whether
	// that iteration's own CaveCarveRoom call happens at all. A DIFFERENT value from SkipCarveChance,
	// which is a JSON field and gates the WHOLE call.
	caveFeatureRoomSkipBound = 4
	// caveFeatureTunnelRepeatBound is the default 4 -- ONLY drawn when
	// caveFeatureRoomSkipBound's own draw was 0 (i.e. CaveCarveRoom was actually called); +1 gives
	// how many CaveCarveTunnel calls follow that same round.
	caveFeatureTunnelRepeatBound = 4
	// caveTunnelVerticalDecayBound is the default 6 -- the tunnel step's one-time (per
	// call, not per step) selector between two hardcoded vertical-decay constants.
	caveTunnelVerticalDecayBound = 6
	// caveTunnelVerticalDecayA is the default 0.92 -- selected when
	// caveTunnelVerticalDecayBound's draw is exactly 0.
	caveTunnelVerticalDecayA = float32(0.92)
	// caveTunnelVerticalDecayB is the default 0.7 -- selected otherwise.
	caveTunnelVerticalDecayB = float32(0.7)
	// caveTunnelMomentumRetentionA is the default 0.9 -- the decay factor applied to
	// the "turnA" momentum accumulator each step. turnA feeds PITCH.
	//
	// Named for the accumulator, not the angle, on purpose: turnA (decayed by 0.9) is added into
	// pitch and turnB (decayed by 0.75) into yaw, matching nether_cave.go's copy and Java's
	// `pitchChange *= 0.9F` / `yawChange *= 0.75F`. Names keyed to the wrong angle invite a
	// "fix" that swaps the two constants and desyncs every tunnel walk.
	caveTunnelMomentumRetentionA = float32(0.9)
	// caveTunnelMomentumRetentionB is the default 0.75 -- the same, for the "turnB"
	// accumulator. turnB feeds YAW.
	caveTunnelMomentumRetentionB = float32(0.75)
	// caveTunnelContinueWalkingBound is the default 4 -- drawn once PER STEP; a draw of
	// exactly 0 (1-in-4 with the default) means "take another step before carving",
	// any other value means "stop walking here and carve/cache now".
	caveTunnelContinueWalkingBound = 4
)

// CaveFeatureConfig holds the instance-level values the carve-shape step reads -- optional JSON
// fields with vanilla defaults, as distinct from the hardcoded constants above. SkipCarveChance is "skip_carve_chance", default 0. The three
// Min/Max pairs are "horizontal_radius_multiplier", "vertical_radius_multiplier" and "floor_level",
// all float ranges defaulting to {0,0}, and all drawn once PER OUTER ITERATION (not once per call)
// to build that round's own CaveCarvingParameters, via the same degenerate-range-skips-the-draw
// contract CaveFloatRangeValue and the room step's y_scale already establish.
type CaveFeatureConfig struct {
	SkipCarveChance                                              int
	HorizontalRadiusMultiplierMin, HorizontalRadiusMultiplierMax float32
	VerticalRadiusMultiplierMin, VerticalRadiusMultiplierMax     float32
	FloorLevelMin, FloorLevelMax                                 float32
}

// CaveCarveChunk implements the cave carver's carve-shape step -- see this file's "THE CARVE-SHAPE
// STEP" section. There is NO local generator reseed anywhere in this function, unlike CaveCarveRoom
// and CaveCarveTunnel, both of which it calls.
//
// targetChunk is the CURRENT chunk being generated, forwarded verbatim to CaveCarveRoom and
// CaveCarveTunnel for their own broad-phase tests. sourceChunk is the NEIGHBOUR chunk this specific
// call originates from -- its own X/Z, times 16 plus a fresh 0..15 draw, picks this round's random
// world position. These are usually DIFFERENT chunks: the placement step's 17x17-neighbourhood
// loop calls the carve-shape step once per neighbour, with that neighbour as sourceChunk and the
// chunk actually being generated as targetChunk, every single time. Both are caller-supplied here
// rather than derived from a shared loop.
func CaveCarveChunk(
	ctx *wgen.PlacementContext,
	config CaveCarverConfig,
	ellipsoidCfg CaveEllipsoidConfig,
	roomConfig CaveRoomConfig,
	featureCfg CaveFeatureConfig,
	rnd random.RandomSource,
	targetChunk CaveChunkPos,
	sourceChunk CaveChunkPos,
	evalCtx *CaveEvalContext,
	carveVolume CaveEllipsoidVolumeFunc,
	out *[]CaveEllipsoidRecord,
) {
	attemptBound := rnd.NextIntBound(caveFeatureCountBound) // *** DRAW 1 ***
	countBound := rnd.NextIntBound(attemptBound + 1)        // *** DRAW 2 ***
	count := rnd.NextIntBound(countBound + 1)               // *** DRAW 3 ***
	skip := rnd.NextIntBound(featureCfg.SkipCarveChance)    // *** DRAW 4 ***
	if skip != 0 || count < 1 {
		return
	}

	for i := 0; i < count; i++ {
		TickDeadline("carving one chunk's worth of carver rooms and tunnels")
		// Center position: Z, then Y (RandomY), then X, IN THAT EXACT ORDER -- NOT the intuitive
		// X, Y, Z order.
		zDraw := rnd.NextIntBound(16) // *** DRAW ***
		centerZ := float32(sourceChunk.Z*16 + zDraw)
		centerY := float32(config.RandomY(rnd, ellipsoidCfg.HeightLimit)) // *** DRAW(S) ***
		xDraw := rnd.NextIntBound(16)                                     // *** DRAW ***
		centerX := float32(sourceChunk.X*16 + xDraw)
		center := CaveVec3{X: centerX, Y: centerY, Z: centerZ}

		// Carving parameters for this round: horizontal, then vertical, then floor_level, each via
		// CaveFloatRangeValue's own degenerate-range-skips-the-draw contract.
		horizMult := featureCfg.HorizontalRadiusMultiplierMin
		if featureCfg.HorizontalRadiusMultiplierMin != featureCfg.HorizontalRadiusMultiplierMax {
			horizMult = CaveFloatRangeValue(featureCfg.HorizontalRadiusMultiplierMin, featureCfg.HorizontalRadiusMultiplierMax, rnd) // *** DRAW (conditional) ***
		}
		vertMult := featureCfg.VerticalRadiusMultiplierMin
		if featureCfg.VerticalRadiusMultiplierMin != featureCfg.VerticalRadiusMultiplierMax {
			vertMult = CaveFloatRangeValue(featureCfg.VerticalRadiusMultiplierMin, featureCfg.VerticalRadiusMultiplierMax, rnd) // *** DRAW (conditional) ***
		}
		floorLvl := featureCfg.FloorLevelMin
		if featureCfg.FloorLevelMin != featureCfg.FloorLevelMax {
			floorLvl = CaveFloatRangeValue(featureCfg.FloorLevelMin, featureCfg.FloorLevelMax, rnd) // *** DRAW (conditional) ***
		}
		params := CaveCarvingParameters{HorizontalRadiusMultiplier: horizMult, VerticalRadiusMultiplier: vertMult, FloorLevel: floorLvl}

		roomSkip := rnd.NextIntBound(caveFeatureRoomSkipBound) // *** DRAW ***
		tunnelIterCount := 1
		if roomSkip == 0 {
			CaveCarveRoom(ctx, config, ellipsoidCfg, roomConfig, rnd, targetChunk, center, evalCtx, params, carveVolume, out)
			tunnelRepeat := rnd.NextIntBound(caveFeatureTunnelRepeatBound) // *** DRAW (conditional on roomSkip==0) ***
			tunnelIterCount = tunnelRepeat + 1
		}

		d1 := rnd.NextFloat() // *** DRAW ***
		// float32(): FMA barrier. `x*pi*2` looks unfusable -- it is all
		// multiplies -- but gc strength-reduces the *2 to an add and then
		// contracts the pi multiply INTO it, emitting FMADDS. Read out of
		// `GOARCH=arm64 go build -gcflags=-S`, not reasoned about.
		yaw := float32(float32(d1)*float32(math.Pi)) * 2
		d2 := rnd.NextFloat() // *** DRAW ***
		pitch := (float32(d2) - 0.5) * 2 / 8
		thickness := config.TunnelThickness(rnd) // *** DRAW(S) ***
		distance := config.Distance(rnd)         // *** DRAW (0 or 1, config-dependent) ***

		for j := 0; j < tunnelIterCount; j++ {
			CaveCarveTunnel(ctx, config, ellipsoidCfg, roomConfig, rnd, targetChunk, center,
				thickness, yaw, pitch, 0, distance, 1.0, evalCtx, params, carveVolume, out)
		}
	}
}

// ---------------------------------------------------------------------------------------------
// TUNNELS
// ---------------------------------------------------------------------------------------------
//
// The tunnel step is the largest and most structurally intricate function in this family. It
// shares the room step's local-generator reseed architecture, but with two real, load-bearing
// differences from it -- getting either backwards desyncs every draw after it:
//
//  1. The tunnel step seeds from EXACTLY ONE caller-generator draw, a plain boundless integer
//     draw -- NOT the room step's float-then-integer PAIR. That is its ONLY read of the caller's
//     generator anywhere in the function.
//  2. Every recursive tunnel call it makes (see "THE BRANCH" below) passes its OWN already-seeded
//     local generator straight through as the child's generator argument -- the same object, not a
//     fresh one -- so the child's own seed draw comes from the PARENT's local generator, chaining
//     the reseed one level deeper rather than branching off the original caller a second time.
//     CaveCarveTunnel recurses with `localRnd` accordingly.
//
// THE PER-STEP "GAUSSIAN" IS THREE PLAIN FLOAT DRAWS. Six of the per-step draws are nominally
// gaussian, which sounds like a distinct Box-Muller generator. It is not: all six are the ordinary
// boundless float draw, the same as the other float draws in the walk. The "gaussian" value is
// SYNTHESIZED by hand from three of them,
// `(draw1-draw2)*draw3`, an Irwin-Hall-style approximation. The draw COUNT is what matters here,
// and it is three per accumulator per step.
//
// THE TUNNEL STEP'S OWN DRAW SEQUENCE, in order (all via localRnd once seeded, except the one
// caller-generator seed draw itself):
//
// The only draw from the caller's generator is one integer, which seeds the local one. A distance
// at or below 0 redraws as 112 minus a bound-28 local integer. Then always a bound of distance>>1 for
// the branch step (plus distance>>2) and a bound-6 decay selector, and those draws stand even if the
// distance is at or below startStep and the tunnel ends. Every step of the walk takes six floats for
// the two turn values. At the branch step with thickness above 1, one more float and a left branch,
// one more float and a right branch, and it returns. Otherwise a bound-4 integer decides whether it
// stops walking to carve or cache at the current position. It ends when the step reaches distance.
//
// A LEGACY-BLIND REROLL: the `distance<=0` fixup above is a HARDCODED `112-NextIntBound(28)`, matching
// the 1.18 tunnel-length formula exactly -- but it does NOT go through the carver
// configuration's tunnel-length function the way the carve-shape step's own length draw does. So the
// re-roll ALWAYS uses the 1.18 formula regardless of config.Legacy, even when called through a
// 1.16 configuration: a real asymmetry, handled here by calling CaveDistance1_18(localRnd) directly
// rather than config.Distance(localRnd). This branch is provably UNREACHABLE from any call
// CaveCarveChunk makes, since the carve-shape step always supplies a real, already-positive length,
// but it is preserved faithfully for a hypothetical direct caller rather than silently dropped.
//
// THE BRANCH: at MOST ONE branch point per tunnel call (branchStep, computed once at the top, NOT
// per step), and ONLY when the CURRENT call's own `thickness` parameter exceeds 1. Since every
// recursive child call passes a NEW thickness in [0.5,1.0) -- drawn fresh, not scaled from the
// parent's -- children can never re-trigger this check, capping real branching recursion at exactly
// one extra level for the whole call tree. That cap comes from this shape, not from any explicit
// depth counter. Reaching the branch step ends the PARENT's walk immediately: no further steps, and
// no carve at the branch position itself. The two children carry the walk forward instead, from
// `branchStep` at the CURRENT walked position, continuing to the SAME overall `distance` endpoint,
// with pitch divided by 3 and yaw rotated a full quarter turn either direction.
//
// THE PER-STEP TAPER is `sinf(step*pi/distance)`, with full-precision float32 pi.
//
// THE CACHE RECORD: the tunnel step uses the exact SAME cached ellipsoid parameters
// the room step's CaveEllipsoidRecord already models. Two int
// fields hold DIFFERENT quantities in the two uses -- the room step's are half-distance and total
// distance, the tunnel step's are the CURRENT walked step and the total distance -- and both are
// reused as CaveEllipsoidRecord.HalfDistance/.Distance here rather than adding a parallel,
// field-identical type, with that dual meaning disclosed rather than silently assumed to match.
// SizeFactor holds the tunnel step's own `thickness` parameter, unchanged across the whole call,
// unlike the per-step-varying radii, in both cases.
//
// WIDTH_MODIFIER, EVALUATED EVERY STEP: the tunnel step reads width_modifier in the same
// constant-vs-expression shape the room step does, but INSIDE its own per-step loop rather than
// once per call -- see this file's "WIDTH_MODIFIER" section for why a per-step evaluation is still
// safe against this code's RNG-order contract. The cache list uses Go's `append()`, as the room
// step's cache-list append does.
//
// ---------------------------------------------------------------------------------------------

// CaveCarveTunnel implements the cave carver's tunnel step -- see this file's "TUNNELS" section for the
// full derivation.
//
// thickness/yaw/pitch/scale are the walk's own starting parameters (yaw/pitch mutate as the walk
// progresses; thickness/scale do not). startStep/distance bound the walk in step units -- callers
// (CaveCarveChunk, or a recursive CaveCarveTunnel branch) always supply startStep=0 or =branchStep
// and a positive distance; a non-positive distance triggers this function's own internal reroll
// (see "TUNNELS", "A LEGACY-BLIND REROLL").
//
// chunk is the broad-phase/target chunk (forwarded to CaveEllipsoid's own broad-phase test exactly
// like CaveCarveRoom's own "chunk" parameter); center is the walk's own starting world position.
//
// rnd draws EXACTLY ONE value (a plain NextInt, no bound) before seeding its own throwaway local
// generator -- see "TUNNELS" for how this differs from CaveCarveRoom's two-draw reseed, and for why
// recursive branch calls pass this call's OWN local generator onward rather than a fresh draw from
// some outer rnd.
func CaveCarveTunnel(
	ctx *wgen.PlacementContext,
	config CaveCarverConfig,
	ellipsoidCfg CaveEllipsoidConfig,
	roomConfig CaveRoomConfig,
	rnd random.RandomSource,
	chunk CaveChunkPos,
	center CaveVec3,
	thickness, yaw, pitch float32,
	startStep, distance int,
	scale float32,
	evalCtx *CaveEvalContext,
	params CaveCarvingParameters,
	carveVolume CaveEllipsoidVolumeFunc,
	out *[]CaveEllipsoidRecord,
) {
	seed := uint32(rnd.NextInt()) // *** RNG CALL, caller's rnd -- the ONLY draw taken from it ***
	localRnd := random.New(seed)  // the tunnel step's own throwaway generator -- see "TUNNELS"

	// The Molang context is built ONCE for the whole walk and reused every step, matching the
	// game's single call-wide Molang context; molang-go's own Program.Run is cheap to
	// call repeatedly against the same *molang.Context. Built once means width_modifier's own
	// private generator (see caveMolangContext) is ALSO built once and reused across every step, so
	// successive per-step math.random draws advance through one stream, the shape a real generator
	// has, rather than each step re-reading an identical value.
	//
	// And built only when the expression will read it: a constant width_modifier, the common
	// case, never touches the context, and seeding a generator per walk for nothing was
	// measurably a tenth of a carve.
	var molangCtx *molang.Context
	if !roomConfig.WidthModifier.IsConstant() {
		molangCtx = caveMolangContext(ctx, localRnd.GetSeed())
	}

	if distance <= 0 {
		// LEGACY-BLIND -- see "TUNNELS". A hardcoded 112-NextIntBound(28), NOT dispatched
		// through config.Distance / the carver configuration's own tunnel-length function.
		distance = CaveDistance1_18(localRnd) // *** RNG CALL, localRnd, CONDITIONAL ***
	}

	branchBase := localRnd.NextIntBound(distance >> 1) // *** RNG CALL, localRnd, ALWAYS ***
	branchStep := branchBase + (distance >> 2)

	decaySelector := localRnd.NextIntBound(caveTunnelVerticalDecayBound) // *** RNG CALL, localRnd, ALWAYS ***
	if distance <= startStep {
		return
	}
	verticalDecay := caveTunnelVerticalDecayB
	if decaySelector == 0 {
		verticalDecay = caveTunnelVerticalDecayA
	}

	pos := center
	var turnA, turnB float32 // the two momentum accumulators, both start at 0
	step := startStep

	for {
		var radiusXZ, radiusY float32
		for {
			// WHERE THE DEADLINE SEES A CARVE, AND WHY HERE. One step of this walk is at most one
			// CaveEllipsoid call, and one CaveEllipsoid is bounded by construction -- its X and Z
			// are clamped to the 17-wide chunk footprint and its Y to the volume's own height --
			// so a step costs on the order of the deadline's own sampling target and nothing here
			// can run away. What CAN get long is the number of steps: 289 neighbouring chunks,
			// each with several rooms and tunnels, each tunnel walking up to 112 of these. That is
			// the thing to bound, and this is the level to bound it at. Deliberately NOT ticked
			// inside the volume carve's own X/Z/Y block loop, which is the hottest loop in
			// this project: it would buy no extra coverage (that loop cannot exceed the volume)
			// and would tax every ordinary carve for it.
			TickDeadline("walking a carver tunnel")
			// math.Sin/math.Cos through this whole block, NOT EngineSin --
			// deliberately. This tunnel step's five trig calls are all plain
			// libm. The nether carver's tunnel step does the identical walk
			// and uses the game's sine and cosine tables at all five. Do not
			// "make these consistent"; the game is not.
			taper := float32(math.Sin(float64(step) * math.Pi / float64(distance)))
			// width_modifier is evaluated EVERY STEP, immediately after the taper computed above
			// and immediately before radiusXZ -- see this file's "WIDTH_MODIFIER" section.
			widthMod := float32(roomConfig.WidthModifier.Evaluate(molangCtx))
			// float32(): FMA barrier, as everywhere in this walk.
			radiusXZ = float32(taper*(thickness+widthMod)) + 1.5
			radiusY = radiusXZ * scale

			cosPitch := float32(math.Cos(float64(pitch)))
			sinPitch := float32(math.Sin(float64(pitch)))
			cosYaw := float32(math.Cos(float64(yaw)))
			sinYaw := float32(math.Sin(float64(yaw)))
			// Every float32() below is an FMA barrier: `pos += a*b` and
			// `pitch = pitch*k + turnA*0.1` are the fusible shape and gc
			// contracts all four on arm64. See CaveFloatRangeValue's note.
			pos.X += float32(cosYaw * cosPitch)
			pos.Z += float32(sinYaw * cosPitch)
			pos.Y += sinPitch

			yaw += float32(turnB * 0.1)
			pitch = float32(pitch*verticalDecay) + float32(turnA*0.1)

			d1 := float32(localRnd.NextFloat()) // *** RNG CALL, localRnd, ALWAYS, EVERY STEP ***
			d2 := float32(localRnd.NextFloat()) // ***
			d3 := float32(localRnd.NextFloat()) // ***
			// float32() around EVERY product: FMA barriers. Both the (d1-d2)*d3
			// product and the *2 that follows it need one -- the sibling turnB
			// line below is the proof: with the barrier only on the inner
			// product, gc fused the *4 straight into the outer add and emitted
			// FMADDS anyway. Rounding at each step is what the game's chain of
			// separate multiplies and adds does.
			turnA = float32(turnA*caveTunnelMomentumRetentionA) + float32(float32((d1-d2)*d3)*2)

			d4 := float32(localRnd.NextFloat()) // *** RNG CALL, localRnd, ALWAYS, EVERY STEP ***
			d5 := float32(localRnd.NextFloat()) // ***
			d6 := float32(localRnd.NextFloat()) // ***
			// float32() around every product: FMA barriers, exactly as for turnA above.
			turnB = float32(turnB*caveTunnelMomentumRetentionB) + float32(float32((d4-d5)*d6)*4)

			if step == branchStep && thickness > 1 {
				d7 := float32(localRnd.NextFloat()) // *** RNG CALL, localRnd ***
				CaveCarveTunnel(ctx, config, ellipsoidCfg, roomConfig, localRnd, chunk, pos,
					float32(d7*0.5)+0.5, yaw-float32(math.Pi/2), pitch/3, branchStep, distance, 1.0, // float32(): FMA barrier
					evalCtx, params, carveVolume, out)
				d8 := float32(localRnd.NextFloat()) // *** RNG CALL, localRnd ***
				CaveCarveTunnel(ctx, config, ellipsoidCfg, roomConfig, localRnd, chunk, pos,
					float32(d8*0.5)+0.5, yaw+float32(math.Pi/2), pitch/3, branchStep, distance, 1.0, // float32(): FMA barrier
					evalCtx, params, carveVolume, out)
				return
			}

			keepWalking := localRnd.NextIntBound(caveTunnelContinueWalkingBound) == 0 // *** RNG CALL ***
			if !keepWalking {
				break
			}
			step++
			if step == distance {
				return
			}
		}

		if roomConfig.CachingEnabled {
			if out != nil {
				*out = append(*out, CaveEllipsoidRecord{
					Center: pos, RadiusXZ: radiusXZ, RadiusY: radiusY, Params: params,
					HalfDistance: step, Distance: distance, SizeFactor: thickness,
				})
			}
		} else {
			chunkCenterX := float32(chunk.X*16 + 8)
			chunkCenterZ := float32(chunk.Z*16 + 8)
			dx := pos.X - chunkCenterX
			dz := pos.Z - chunkCenterZ
			remaining := float32(distance - step)
			threshold := (thickness + 2 + 16) * (thickness + 2 + 16)
			// float32() per product: FMA barriers -- gc fuses this into FMADDS+FMSUBS.
			if float32(dx*dx)+float32(dz*dz)-float32(remaining*remaining) > threshold {
				return
			}
			// localRnd, not ctx.Random -- see CaveEllipsoid's own forwarding note.
			if !CaveEllipsoid(ctx, config, ellipsoidCfg, carveVolume, localRnd, chunk, pos, radiusXZ, radiusY, params) {
				return
			}
		}

		step++
		if step == distance {
			return
		}
	}
}

// ---------------------------------------------------------------------------------------------
// PLACEMENT, AND THE CACHE THIS CODE DOES NOT MODEL
// ---------------------------------------------------------------------------------------------
//
// ARCHITECTURE DECISION: THE UNCACHED PATH, DELIBERATELY, AND WHY.
//
// The game's placement has a cached and an uncached form, chosen per carver.
// The game's default for every carver is CACHED,
// not uncached, and the schema is exhaustive at eight fields, none of which can change it. A
// literal reimplementation would default to the cached path. This code does not, for a
// reason specific to what this bench IS rather than a disagreement with the game's choice:
//
//   - The cached path exists to amortize ONE neighbour chunk's RNG-drawn room and tunnel list
//     across MANY different target-chunk generations that all fall within that neighbour's
//     17-chunk reach. It persists
//     ACROSS placement calls for
//     many different chunks sharing one carver instance over a running world's lifetime.
//   - This bench has no such lifetime: featurelab's model is one Place() call producing one finite
//     volume, never a second call reusing the first's cache. A cache
//     has no meaning without a second call to benefit from it, and building one
//     would add real complexity, with room for
//     subtle mistakes,
//     purely to reproduce a cross-call optimisation this bench structurally cannot exercise.
//   - The two paths are OBSERVATIONALLY IDENTICAL for a single target
//     chunk: both derive the SAME per-neighbour reseed, both call the carve-shape, room and tunnel
//     steps with the exact same per-neighbour local draw sequence, and the broad-phase "does this
//     candidate ellipsoid overlap the target chunk" test is the IDENTICAL formula whether it runs
//     inline inside the room and tunnel steps (uncached) or in the placement step's own
//     cache-replay loop (cached, from a record those steps populated earlier). The only real
//     difference is WHERE that same test and that same carve happen -- immediately inline, or
//     deferred through a cached record -- which is invisible to a caller that only ever asks for
//     one target chunk. Given that equivalence, the uncached path is not a lesser approximation of
//     the cached one for this bench's purposes; it is the SAME algorithm with the cross-call
//     optimisation correctly recognised as inapplicable and left out.
//   - A concrete, load-bearing bug this decision surfaced and fixed: CaveCarveRoom once had the
//     cache-append and the broad-phase-test-and-carve as two unconditional statements, both always
//     running. The game does one or the other: append when caching, else
//     broad-phase test and carve -- not "always both". CaveCarveTunnel already had this
//     right. The bug would have been silent under a cached-path default, where CaveCarveRoom would
//     have double-acted: cached AND carved immediately against a neighbour-chunk placeholder
//     position that the target-vs-source note below shows is NOT the real target chunk in the
//     cached call shape. TestCaveCarveRoom_CachingEnabled_NeverCarvesDirectly pins the fix.
//
// TARGET-VS-SOURCE CHUNK, CACHED VS UNCACHED (why the uncached call shape is simpler to trust).
// The carve-shape step takes TWO chunk positions, and they carry
// different values on the two paths:
//
//   - CACHED path: the carve-shape step receives the neighbour chunk position for both its
//     "target" and "source" parameters. That is harmless there only because the room and
//     tunnel steps' broad-phase-test-and-carve code is unreachable when caching is enabled (per
//     the bug above): the "target" argument is a placeholder never used for geometry, and the
//     placement step's OWN post-call loop, walking the returned cached list and testing against
//     the TRUE current chunk, is where the real target-chunk broad-phase test happens.
//   - UNCACHED path: the FIRST is the ORIGINAL chunk position, from the placement context's
//     origin, and the SECOND is the neighbour pair. That is
//     exactly targetChunk=current, sourceChunk=neighbour, matching CaveCarveChunk's parameter order
//     and doc comment. Here the room and tunnel steps' inline broad-phase test runs directly
//     against the real target chunk -- no deferred replay, no second broad-phase formula to keep in
//     sync.
//
// So the uncached path's carve-shape call is the whole story by itself, while the
// cached path's correctness depends on machinery split across two functions agreeing on a
// broad-phase formula neither of them shares code for. One more reason the uncached path is the
// more directly verifiable choice for this bench.
//
// THE SEED MIX IS (ncx*a + ncz*b), NOT (ncz*a + ncx*b). The OUTER, X-loop variable multiplies
// against `a` -- the FIRST of the two draws -- and the INNER, Z-loop variable against `b`, the
// second. Both branches compute it identically, which is what makes the pairing safe to state.
// This is exactly the kind of subtle, load-bearing detail that is easy to get backwards: an
// earlier version of this file had the two operands swapped.
//
// THE PLACEMENT'S DRAW SEQUENCE AND STEPS, as implemented by CaveFeature.Place:
//
// It reads the stored seed with no draw, then makes two integer draws, each made odd, as a and b.
// Origin coordinates shift right by 4 to give the chunk, flooring for negatives. All 289 neighbours
// within 8 chunks run in ascending x then z order: the same generator is reseeded with
// (uint32(x)*a + uint32(z)*b) ^ seed, with 32-bit wraparound, and CaveCarveChunk runs for that source
// chunk. It always reports success at the origin.
//
// The placement step also runs the same Caves & Cliffs game-version check the carve-shape step
// does, and the result selects which configuration its CACHED-branch replay loop uses for its
// direct volume carves. This bench's uncached architecture never runs that replay loop, the
// uncached branch's carve-shape call performs its own independent selection, and for any modern
// world both selections resolve to the same 1.18 configuration this code hardcodes -- so
// CaveFeature.Place passes CaveConfiguration1_18 once, from the builder.
//
// ---------------------------------------------------------------------------------------------

const caveCarverTypeID = "minecraft:cave_carver_feature"

// CaveFeature is minecraft:cave_carver_feature -- see this file's "PLACEMENT, AND THE CACHE THIS
// CODE DOES NOT MODEL" section for the placement derivation and the uncached-architecture
// decision. A leaf type: no feature delegation, so (like GeodeFeature) it needs no
// WithRecursionGuard.
type CaveFeature struct {
	identifier string

	fillWith     block.ID
	config       CaveCarverConfig
	ellipsoidCfg CaveEllipsoidConfig
	roomCfg      CaveRoomConfig
	featureCfg   CaveFeatureConfig
	carveVolume  CaveEllipsoidVolumeFunc
}

func (f *CaveFeature) TypeID() string     { return caveCarverTypeID }
func (f *CaveFeature) Identifier() string { return f.identifier }

// Place implements the cave carver's placement step -- see this file's "PLACEMENT, AND THE CACHE
// THIS CODE DOES NOT MODEL" section. Always succeeds, because in the game this placement has no
// failure path at all, returning ctx.Origin unchanged.
func (f *CaveFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, caveCarverTypeID)
	defer profiler.PopFeatureFrame()

	rnd := ctx.Random
	baseSeed := rnd.GetSeed() // the stored seed -- a stored scalar, no draw
	// Both multipliers go through the SAME Java odd-maker form -- round-toward-zero halving parity,
	// then set the low bit -- that the nether carver's placement step uses, not a bare `|1`.
	// OBSERVABILITY CAVEAT: this is a FORM-ONLY distinction. The unbounded integer draw is an
	// unsigned right shift of one raw draw, so every value the negative adjustment could
	// touch is provably non-negative and carverOddMaker(v) == uint32(v)|1 for every reachable
	// input; a bare `|1` produces identical seeds today. This form is kept because it is what the
	// game computes, and because a future RandomSource whose NextInt could go negative would otherwise
	// silently diverge.
	a := carverOddMaker(rnd.NextInt()) // *** RNG CALL 1 ***
	b := carverOddMaker(rnd.NextInt()) // *** RNG CALL 2 ***

	chunkX := ctx.Origin.X >> 4 // building a chunk position from a block position -- see above
	chunkZ := ctx.Origin.Z >> 4
	target := CaveChunkPos{X: chunkX, Z: chunkZ}

	for ncx := chunkX - 8; ncx <= chunkX+8; ncx++ {
		for ncz := chunkZ - 8; ncz <= chunkZ+8; ncz++ {
			// 32-bit wraparound multiply-add-xor, matching the game's 32-bit arithmetic
			// exactly -- see "THE SEED MIX" above.
			TickDeadline("carving the 17x17 chunk neighbourhood a carver reaches into")
			neighbourSeed := uint32(int32(ncx))*a + uint32(int32(ncz))*b
			neighbourSeed ^= baseSeed
			rnd.SetSeed(neighbourSeed) // *** RNG CALL, reseeds the SAME object, every neighbour ***

			CaveCarveChunk(ctx, f.config, f.ellipsoidCfg, f.roomCfg, f.featureCfg, rnd,
				target, CaveChunkPos{X: ncx, Z: ncz}, nil, f.carveVolume, nil)
		}
	}

	origin := ctx.Origin
	return &origin
}

// WarnExplicitZeroSkipCarveChance is the explicit-zero diagnostic for the skip_carve_chance field,
// shared by ALL THREE carver builders. It used to live inline in the overworld builder only, while
// the nether and underwater builders accepted the same field with the same 0-vs-1 draw asymmetry
// and said nothing -- the same file was diagnosed or not purely by which carver id it named.
//
// 0 and 1 both mean "never skip" -- NextIntBound's return is 0 either way, and 0 is the only
// value that does not skip -- and they still do not produce the same cave. NextIntBound(0)
// short-circuits WITHOUT consuming a draw (mtrand.Rand's own contract); NextIntBound(1) draws
// and takes it modulo 1. So the two spellings leave the generator at different positions, and
// every later draw in the carve -- radii, angles, the walk itself -- comes out differently.
// Measured on the wiki's own carver fixture: 3,683 carved cells with 0, 3,229 with 1, from
// the same seed, with nothing else changed.
//
// On top of that, 0 is reported to fail the loader's own minimum of 1, so a file that writes
// it is refused by the real game while the same behaviour written as an omission is not. A
// default is never validated, because validation only sees keys the file actually contains.
//
// Deliberately a warning and not an error: the minimum is EXTERNALLY REPORTED and the schema's
// own minimum has not been independently confirmed here. Refusing a file on a number nobody here
// has seen would be this tool asserting more than it knows. The draw asymmetry, by
// contrast, is this code's own observable behaviour and is stated as fact.
func WarnExplicitZeroSkipCarveChance(body map[string]any, skipCarveChance int, ctx *BuildContext) {
	if ctx == nil || ctx.Warn == nil || skipCarveChance != 0 {
		return
	}
	raw, ok := body["skip_carve_chance"]
	if !ok || raw == nil {
		return
	}
	ctx.Warn("skip_carve_chance: an explicit 0 is reported to fail the schema's own minimum of 1, so " +
		"the real game would refuse this file. Omit the field or write 1 instead -- but note that " +
		"those two are not interchangeable either: 0 and 1 both mean \"never skip\", yet a bound of 0 " +
		"returns without consuming a draw while a bound of 1 consumes one, so the whole rest of the " +
		"carve draws from a different position in the stream and a visibly different cave comes out. " +
		"This is a warning rather than an error because the schema minimum comes from an external " +
		"report; this tool has not independently confirmed it.")
}

// buildCaveFeature parses minecraft:cave_carver_feature's JSON body -- the eight fields the
// carver's schema has, and it has no others: fill_with, width_modifier,
// skip_carve_chance, height_limit, y_scale, horizontal_radius_multiplier,
// vertical_radius_multiplier, floor_level. All eight are optional in the game's schema, with these
// vanilla defaults:
//
//	fill_with                      none (CaveNoFill) -- the per-block carve skips the write, so
//	                               this means "carve everything else, never overwrite the
//	                               position", not a crash
//	width_modifier                 the constant 0.0
//	skip_carve_chance              0
//	height_limit                   0
//	y_scale                        {0, 0}
//	horizontal_radius_multiplier   {0, 0}
//	vertical_radius_multiplier     {0, 0}
//	floor_level                    {0, 0}
//
// Each of these eight is the game's own default.
//
// The water gate is not a JSON field at all -- it has no counterpart in the game's schema, and
// NewCaveEllipsoidVolume's built-in default is the correct vanilla behaviour for every generator
// this bench models, so this builder just calls the plain constructor and never needs to
// name a gate. See this file's "THE WATER GATE" section.
func buildCaveFeature(body map[string]any, ctx *BuildContext) (wgen.PlaceableFeature, error) {
	fillWith := CaveNoFill
	if fillRaw, ok := body["fill_with"]; ok {
		fillDesc, err := AsBlockDescriptor(fillRaw, "fill_with")
		if err != nil {
			return nil, err
		}
		fillWith = ctx.Palette.Resolve(fillDesc)
	}

	// widthModifier: a plain number OR a Molang expression string, matching the game's
	// expression-valued field -- ParseMolangValue (distribution.go) is the SAME parser every other Molang-
	// typed field in this codebase uses, reused here rather than hand-rolled a second time. Every
	// expression is ACCEPTED and evaluated for real -- see this file's "WIDTH_MODIFIER" section for
	// the policy: determinism from this code's own master seed wins over imitating the game
	// wherever the game's own output is non-reproducible. An expression whose own AST can reach an
	// RNG-drawing math.* function still gets a diagnostic, but as a build warning rather than a
	// refusal, disclosing that the game's random draws for those functions here are process-global
	// and unseeded, so this code's value is a deliberate deterministic stand-in and will not match
	// the game.
	widthModifier := constMolang(0)
	if widthRaw, ok := body["width_modifier"]; ok {
		expr, err := ParseMolangValue(widthRaw)
		if err != nil {
			return nil, fmt.Errorf("width_modifier: %w", err)
		}
		if expr.program != nil && caveWidthModifierUsesRandom(expr.program) && ctx.Warn != nil {
			ctx.Warn("width_modifier: this expression contains math.random/math.random_integer/" +
				"math.die_roll/math.die_roll_integer. In the game, those functions in THIS field do " +
				"not draw from the world seed at all -- they draw from a generator shared across the " +
				"whole game that is never seeded, so the same world and the same seed give a " +
				"different width_modifier every time it is generated. There is nothing stable there " +
				"to reproduce. This tool instead evaluates the expression against a generator derived " +
				"from your master seed, so the same seed always previews the same cave -- which is " +
				"what makes an edit visible as an edit rather than as noise. The consequence to know: " +
				"the shape you see here is a faithful example of what this expression produces, but " +
				"it is not the specific shape the game will produce for this seed, because the game " +
				"has no specific shape for it. Use a constant width_modifier if you need the preview " +
				"and the game to agree.")
		}
		widthModifier = expr
	}

	intField := func(key string) (int, error) {
		raw, ok := body[key]
		if !ok {
			return 0, nil // vanilla default -- see buildCaveFeature's own doc comment
		}
		f, ok := toFloat(raw)
		// A value that does not fit in an int is refused here too, and that is not a second check --
		// it closes the only hole in the one above. `f != float64(int(f))` is meant to reject
		// anything that does not survive the conversion, and math.MinInt64 is the single
		// out-of-range value that converts to itself and round-trips back, so it sails through.
		// It is also what Go's implementation-defined float64->int conversion produces on amd64
		// for EVERY number outside int64's range, so `1e300` arrives here as exactly that.
		//
		// What it did then depended on the field. As `skip_carve_chance` or `height_limit` it
		// reached the bounded integer draw as a bound whose low 32 bits are zero and divided by
		// zero, panicking the process (random.Rand.NextIntBound has since narrowed that test to
		// 32 bits, so it no longer panics -- it produces a carve whose Y bounds are nonsense and
		// which grinds indefinitely instead). Neither outcome is worth reproducing, and neither is
		// anything the game can do: its field is a 32-bit int that could never hold this value in
		// the first place.
		if !ok || f != float64(int(f)) || int(f) == math.MinInt64 {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		return int(f), nil
	}
	skipCarveChance, err := intField("skip_carve_chance")
	if err != nil {
		return nil, err
	}
	// 0 and 1 both mean "never skip" -- NextIntBound's return is 0 either way, and 0 is the only
	// value that does not skip -- and they still do not produce the same cave. NextIntBound(0)
	// short-circuits WITHOUT consuming a draw (mtrand.Rand's own contract); NextIntBound(1) draws
	// and takes it modulo 1. So the two spellings leave the generator at different positions, and
	// every later draw in the carve -- radii, angles, the walk itself -- comes out differently.
	// Measured on the wiki's own carver fixture: 3,683 carved cells with 0, 3,229 with 1, from
	// the same seed, with nothing else changed.
	//
	// On top of that, 0 is reported to fail the loader's own minimum of 1, so a file that writes
	// it is refused by the real game while the same behaviour written as an omission is not. A
	// default is never validated, because validation only sees keys the file actually contains.
	//
	// Deliberately a warning and not an error: the minimum is EXTERNALLY REPORTED and the schema's
	// own minimum has not been independently confirmed here. Refusing a file on a number nobody
	// here has seen would be this tool asserting more than it knows. The draw asymmetry, by
	// contrast, is this code's own observable behaviour and is stated as fact.
	WarnExplicitZeroSkipCarveChance(body, skipCarveChance, ctx)
	heightLimit, err := intField("height_limit")
	if err != nil {
		return nil, err
	}

	floatRange := func(key string) (min, max float32, err error) {
		raw, ok := body[key]
		if !ok {
			return 0, 0, nil // vanilla default {0,0} -- see buildCaveFeature's own doc comment
		}
		lo, hi, err := parseCaveFloatRange(raw, key)
		if err != nil {
			return 0, 0, err
		}
		return lo, hi, nil
	}
	yScaleMin, yScaleMax, err := floatRange("y_scale")
	if err != nil {
		return nil, err
	}
	horizMin, horizMax, err := floatRange("horizontal_radius_multiplier")
	if err != nil {
		return nil, err
	}
	vertMin, vertMax, err := floatRange("vertical_radius_multiplier")
	if err != nil {
		return nil, err
	}
	floorMin, floorMax, err := floatRange("floor_level")
	if err != nil {
		return nil, err
	}

	fillWithCopy := fillWith // captured by the volume func below
	carveVolume := NewCaveEllipsoidVolume(fillWithCopy)

	return &CaveFeature{
		identifier:   ctx.Identifier,
		fillWith:     fillWith,
		config:       CaveConfiguration1_18,
		ellipsoidCfg: CaveEllipsoidConfig{HeightLimit: heightLimit},
		roomCfg: CaveRoomConfig{
			WidthModifier: widthModifier,
			YScaleMin:     yScaleMin,
			YScaleMax:     yScaleMax,
			// CachingEnabled is deliberately always false -- see this file's "PLACEMENT, AND THE
			// CACHE THIS CODE DOES NOT MODEL" section for why the uncached path is this bench's
			// honest choice.
			CachingEnabled: false,
		},
		featureCfg: CaveFeatureConfig{
			SkipCarveChance:               skipCarveChance,
			HorizontalRadiusMultiplierMin: horizMin,
			HorizontalRadiusMultiplierMax: horizMax,
			VerticalRadiusMultiplierMin:   vertMin,
			VerticalRadiusMultiplierMax:   vertMax,
			FloorLevelMin:                 floorMin,
			FloorLevelMax:                 floorMax,
		},
		carveVolume: carveVolume,
	}, nil
}

// parseCaveFloatRange accepts a bare number (min==max), a [min,max] array, or a
// {range_min, range_max} object -- whatever parseEngineRange accepts, which is the point of
// delegating to it. It does NOT accept a {min, max} object: the game reads only range_min/
// range_max on a range-typed field and silently zeroes the value given min/max, so parseEngineRange
// refuses that spelling by name rather than let it look accepted. This comment used to advertise
// {min,max} as supported; that stopped being true when the range parsing was consolidated.
func parseCaveFloatRange(raw any, jsonPath string) (min, max float32, err error) {
	lo, hi, err := parseEngineRange(raw, jsonPath)
	if err != nil {
		return 0, 0, err
	}
	return float32(lo), float32(hi), nil
}

func init() {
	RegisterType(caveCarverTypeID, buildCaveFeature)
}

var _ wgen.PlaceableFeature = (*CaveFeature)(nil)

// ---------------------------------------------------------------------------------------------
// WIDTH_MODIFIER
// ---------------------------------------------------------------------------------------------
//
// width_modifier is the one JSON field on this feature that can be a Molang expression rather than
// a number, and it is where this code makes its one deliberate, disclosed substitution. Three
// questions shape it.
//
// (1) WHAT CONTEXT IS THE EXPRESSION EVALUATED AGAINST?
//
// A constant width_modifier is used as-is. An omitted one evaluates to Molang's default return
// value, 0.0. A real expression is evaluated against the game's Molang evaluation context.
//
// WHICH context: the carver does not create its own. It uses the one supplied
// by the world-generation driver above the placement -- a single context SHARED across the whole
// placement operation. That matches wgen.PlacementContext.MolangScope, the only architecture this
// bench already has for that shape (already threaded identically by reference through every
// composite feature, per scatter.go's own doc comment), far more closely than anything
// carver-private. The room step never writes into that context before reading width_modifier, so
// there is no carver-specific variable binding for this code to reproduce.
//
// A DISCLOSED GAP, not an assertion: that context is also the generic Molang
// evaluation context for renderer components, and this code does not model everything it can
// expose. This code binds width_modifier's query.* and variable.* resolution through the SAME
// wgen.NewMolangContext bridge every other Molang-consuming feature type in this project uses
// (ctx.Biome/ctx.API for query.has_biome_tag/has_any_biome_tags/has_all_biome_tags/heightmap/above_top_solid/noise,
// ctx.MolangScope for variable.*/temp.*). If a pack's width_modifier reads a query this bridge
// does not register, or a variable.* this bench's shared scope was never populated with by an
// ancestor feature, this code evaluates it as 0, which is molang-go's documented unresolved-lookup
// behaviour, rather than whatever the game would have bound there. That is the same category of
// gap every other Molang-consuming feature type in this project already carries, not a new one.
//
// (2) HOW MANY TIMES, AND WHERE RELATIVE TO THE RNG SEQUENCE?
//
// The room step evaluates width_modifier EXACTLY ONCE per call, immediately before the arithmetic
// that computes horizBase, with nothing -- RNG or otherwise -- in between.
//
// The tunnel step evaluates it ONCE PER STEP of its walk, immediately after the per-step taper and
// immediately before the same radius arithmetic, with that iteration's own local draws (the six
// float draws feeding the two momentum accumulators, and the branch and continue-walking draws)
// all coming AFTER this point in the same iteration.
//
// Neither has an RNG-capable step between reading the field and using the value. So evaluating
// either can only perturb the draw SEQUENCE if the Molang expression ITSELF draws -- which is (3).
//
// (3) FLOAT OR TRUNCATED, AND THE RNG SOURCE THAT DECIDES THE WHOLE DESIGN.
//
// Both sites use the value as a 32-bit float directly -- never truncated, never read as an int.
// That matches this code's float32 WidthModifier field exactly.
//
// THE RNG SOURCE. Molang's math.random, math.random_integer, math.die_roll and
// math.die_roll_integer are the only four functions that draw, and a real expression could contain
// one. In this context the game draws them from its default non-deterministic 0..1 source:
// a PRNG with ONE PROCESS-GLOBAL state, shared and advanced by every
// Molang evaluation across the ENTIRE game (rendering, particles, every other consumer), with no
// connection whatsoever to the world's own RNG, no per-world seed and no per-chunk determinism.
//
// (Counterpart: the scatter path DOES install a seeded source -- the scatter feature's Molang setup
// binds math.random to its own generator. So math.random is deterministic inside a distribution and
// non-deterministic here, and the difference is which path installed a source, not which function
// was called. The wiki pages say so on both sides.)
//
// This is a GENUINE residual gap, not a modelling convenience: even a bit-exact copy of that
// generator could not reproduce its output, because its value depends on global call order
// across every OTHER consumer running in the same process -- state this bench structurally cannot
// observe, let alone replay.
//
// THE POLICY, and it is standing policy rather than a per-case judgement call: determinism from
// this code's own single master seed wins over imitating the game wherever the game's own output is
// non-reproducible. Refusing to model a process-global unseeded generator buys this code nothing
// the real game has either. A user iterating on a pack's width_modifier wants to see their OWN
// EDITS change the preview, not a build-time refusal that makes the field unusable, and wants the
// SAME seed to keep reproducing the SAME preview -- session.go's own single-master-seed contract.
//
// THE SUBSTITUTION. width_modifier's RNG source is DomainCaveWidthModifier (random/derive.go), a
// brand-new generator private to ONE *molang.Context, seeded via random.DeriveSeed from a value
// already deterministically derived from the master feature seed by the time either caller reaches
// caveMolangContext: the room and tunnel steps' own localRnd.GetSeed(), itself the product of a
// real draw off ctx.Random or an ancestor call's own local generator, all the way back to
// Config.FeatureSeed. Same master seed in, same width_modifier draws out, every time; a different
// master seed reaches this point with a different local seed and therefore different draws --
// exactly the "changing the master seed is the one thing that changes a preview" contract
// random/derive.go documents. It is DISCLOSED at build time by a warning, not hidden: see
// buildCaveFeature.
//
// WHY THIS CANNOT PERTURB ctx.Random'S OWN DRAW SEQUENCE -- the hard, non-negotiable constraint
// every feature file in this project states as its correctness contract. caveMolangContext's
// generator is a COMPLETELY SEPARATE random.New instance, never ctx.Random and never the caller's
// own localRnd object. Only localRnd.GetSeed() is read to build the derived seed, and that is a
// stored-scalar read, not a draw; it does not advance the twister state by so much as one step.
// Every RNG-order fact this file carries (the room step draws exactly 2 from its caller then hands
// off to its local generator; the tunnel step draws exactly 1; every "*** RNG CALL ***" annotation
// through both) is undisturbed, because width_modifier's evaluation was never IN that sequence.
//
// Feeding ctx.Random or a caller's own localRnd DIRECTLY into the evaluation would be a different
// matter, and would indeed corrupt their draw order -- which is exactly why this code does not do
// that. But that rules out those two OBJECTS, not every stand-in: a generator that is its own
// separate object cannot perturb their sequence no matter what it draws or how often, because RNG
// order is a property of a SPECIFIC shared object's call sequence, not of the wall-clock or
// call-graph moment at which some evaluation happens to run.
// ---------------------------------------------------------------------------------------------
