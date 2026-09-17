// cave_test.go exercises the cave carver's parts directly: CaveIsDiggable1_18, CaveIsSurface1_18,
// CaveThinSand, CaveCarveBlock, CaveEllipsoid, NewCaveEllipsoidVolume, the carver
// configuration's six draw functions, CaveAddRoom, CaveAddTunnel, CaveAddFeature and Place.
// Every assertion here checks a specific claim made in cave.go's own comments -- see that file
// for the derivation each one stands behind.
package features

import (
	"math"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// newCaveTestVolume builds a 9x20x9 volume and fills it uniformly with fillName (block.AirID's
// own name, "minecraft:air", if the test wants an empty starting bench) -- most tests below want
// a solid-stone bench, matching this project's own carve-verification standard.
func newCaveTestVolume(t *testing.T, fillName string) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	fill := pal.Get(fillName, nil)
	bounds := volume.Bounds{MinX: -4, MinY: 0, MinZ: -4, SizeX: 9, SizeY: 20, SizeZ: 9}
	v := volume.New(bounds, pal, block.AirID)
	for x := -4; x <= 4; x++ {
		for y := 0; y < 20; y++ {
			for z := -4; z <= 4; z++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, fill)
			}
		}
	}
	return v, pal
}

// --- CaveIsDiggable1_18 -----------------------------------------------------------------------

func TestCaveIsDiggable1_18(t *testing.T) {
	pal := block.NewPalette()
	cases := []struct {
		name string
		want bool
	}{
		{"minecraft:stone", true},
		{"minecraft:dirt", true},               // dirt group
		{"minecraft:coarse_dirt", true},        // dirt group
		{"minecraft:sandstone", true},          // sandstone group
		{"minecraft:chiseled_sandstone", true}, // sandstone group
		{"minecraft:red_sandstone", true},      // red sandstone group
		{"minecraft:sand", true},               // sand group
		{"minecraft:suspicious_sand", true},    // sand group
		{"minecraft:podzol", true},
		{"minecraft:grass_block", true},
		{"minecraft:mycelium", true},
		{"minecraft:snow_layer", true},
		{"minecraft:packed_ice", true},
		{"minecraft:deepslate", true},
		{"minecraft:calcite", true},
		{"minecraft:gravel", true},
		{"minecraft:dirt_with_roots", true},
		{"minecraft:tuff", true},
		{"minecraft:iron_ore", true},
		{"minecraft:deepslate_iron_ore", true},
		{"minecraft:raw_iron_block", true},
		{"minecraft:copper_ore", true},
		{"minecraft:deepslate_copper_ore", true},
		{"minecraft:raw_copper_block", true},
		{"minecraft:gray_glazed_terracotta", true},
		{"minecraft:silver_glazed_terracotta", true},
		{"minecraft:white_glazed_terracotta", true},
		{"minecraft:black_glazed_terracotta", true},
		// Not diggable: an ordinary, unlisted block.
		{"minecraft:oak_log", false},
		{"minecraft:air", false},
		{"minecraft:diamond_ore", false},
		// Bedrock's "light_gray" slot is spelled "silver", not "light_gray" -- confirm the
		// literal Java-style name is correctly NOT recognized.
		{"minecraft:light_gray_glazed_terracotta", false},
	}
	for _, c := range cases {
		id := pal.Get(c.name, nil)
		if got := CaveIsDiggable1_18(pal, id, block.AirID); got != c.want {
			t.Errorf("CaveIsDiggable1_18(%s) = %v, want %v", c.name, got, c.want)
		}
	}
}

// --- CaveIsSurface1_18 -------------------------------------------------------------------------

func TestCaveIsSurface1_18(t *testing.T) {
	pal := block.NewPalette()
	cases := []struct {
		name string
		want bool
	}{
		{"minecraft:grass_block", true},
		{"minecraft:mycelium", true},
		{"minecraft:dirt", false},
		{"minecraft:stone", false},
		{"minecraft:podzol", false}, // diggable, but NOT a surface block -- a real distinction
	}
	for _, c := range cases {
		id := pal.Get(c.name, nil)
		if got := CaveIsSurface1_18(pal, id); got != c.want {
			t.Errorf("CaveIsSurface1_18(%s) = %v, want %v", c.name, got, c.want)
		}
	}
}

// --- CaveThinSand --------------------------------------------------------------------------

func TestCaveThinSand(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:air")
	sand := pal.Get("minecraft:sand", nil)
	stone := pal.Get("minecraft:stone", nil)

	// Three sand layers at (0,5,0),(0,6,0),(0,7,0): CaveThinSand(checkOrigin=(0,5,0), y=4)
	// should see all three and report true (well within MaxY()-3 = 17).
	for dy := 0; dy < 3; dy++ {
		v.SetBlock(wgen.BlockPos{X: 0, Y: 5 + dy, Z: 0}, sand)
	}
	if !CaveThinSand(v, wgen.BlockPos{X: 0, Y: 5, Z: 0}, 4) {
		t.Fatal("expected CaveThinSand to see three sand layers and return true")
	}

	// Only two of the three layers are sand -> false.
	v.SetBlock(wgen.BlockPos{X: 0, Y: 7, Z: 0}, stone)
	if CaveThinSand(v, wgen.BlockPos{X: 0, Y: 5, Z: 0}, 4) {
		t.Fatal("expected CaveThinSand to return false when the third layer is not sand")
	}
	v.SetBlock(wgen.BlockPos{X: 0, Y: 7, Z: 0}, sand) // restore

	// Too close to MaxY (MaxY()-3 <= y must return false immediately -- MaxY()==20, so y=17
	// must already fail (20-3=17, and the check is strictly "> y", i.e. 17>17 is false).
	if CaveThinSand(v, wgen.BlockPos{X: 0, Y: 18, Z: 0}, 17) {
		t.Fatal("expected CaveThinSand to refuse near MaxY() regardless of sand layers")
	}
}

// --- CaveCarveBlock ------------------------------------------------------------------------

func caveCarveCtx(v *volume.Volume) *wgen.PlacementContext {
	return &wgen.PlacementContext{
		API:         v,
		Origin:      wgen.BlockPos{X: 0, Y: 10, Z: 0},
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
}

// TestCaveCarveBlock_NonDiggable_NoOp: a block outside the carveable-block list must be left
// completely untouched.
func TestCaveCarveBlock_NonDiggable_NoOp(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:air")
	oakLog := pal.Get("minecraft:oak_log", nil)
	pos := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	v.SetBlock(pos, oakLog)
	fill := pal.Get("minecraft:cave_air", nil)

	ctx := caveCarveCtx(v)
	ok := CaveCarveBlock(ctx, CaveConfiguration1_18, fill, pos, false)
	if ok {
		t.Fatal("expected CaveCarveBlock to return false for a non-diggable block")
	}
	if got := v.GetBlock(pos); got != oakLog {
		t.Fatalf("expected oak_log left untouched, got palette entry %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_Stone_FillsWithFillBlock: the standard "solid stone bench" case this
// project's own carve-verification standard calls for -- Stone is diggable (checked first, no
// group lookup needed), no sand ceiling above, so the position is simply overwritten with
// fillWith.
func TestCaveCarveBlock_Stone_FillsWithFillBlock(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	pos := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	fill := pal.Get("minecraft:cave_air", nil)

	ctx := caveCarveCtx(v)
	ok := CaveCarveBlock(ctx, CaveConfiguration1_18, fill, pos, false)
	if !ok {
		t.Fatal("expected CaveCarveBlock to succeed against solid stone")
	}
	if got := v.GetBlock(pos); got != fill {
		t.Fatalf("expected pos filled with cave_air, got %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_ThinSandCapsPosPlusOne_NotPos: the sand-thinning pass is called with
// pos+(0,1,0), and the resulting sandstone cap is written at pos+(0,1,0), NOT at pos itself
// (which is unconditionally overwritten by fillWith regardless).
func TestCaveCarveBlock_ThinSandCapsPosPlusOne_NotPos(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	sand := pal.Get("minecraft:sand", nil)
	pos := wgen.BlockPos{X: 0, Y: 5, Z: 0}
	// Sand column starting at pos+(0,1,0): (0,6,0),(0,7,0),(0,8,0).
	for dy := 1; dy <= 3; dy++ {
		v.SetBlock(wgen.BlockPos{X: 0, Y: 5 + dy, Z: 0}, sand)
	}
	fill := pal.Get("minecraft:cave_air", nil)
	sandstone := pal.Get("minecraft:sandstone", nil)

	ctx := caveCarveCtx(v)
	ok := CaveCarveBlock(ctx, CaveConfiguration1_18, fill, pos, false)
	if !ok {
		t.Fatal("expected CaveCarveBlock to succeed")
	}
	if got := v.GetBlock(pos); got != fill {
		t.Fatalf("expected pos itself filled with cave_air regardless of thin-sand, got %v", pal.Entry(got))
	}
	above := wgen.BlockPos{X: 0, Y: 6, Z: 0}
	if got := v.GetBlock(above); got != sandstone {
		t.Fatalf("expected pos+(0,1,0) capped with sandstone, got %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_GrassPreservation_MovesOriginalBlockDown: the per-block carve's surface
// gate tests the ORIGINAL block AT pos (not one Y above), and when true and the block one Y below
// is a dirt group member, that position-below is overwritten
// with the ORIGINAL pre-carve block state.
func TestCaveCarveBlock_GrassPreservation_MovesOriginalBlockDown(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	grass := pal.Get("minecraft:grass_block", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	pos := wgen.BlockPos{X: 0, Y: 5, Z: 0}
	below := wgen.BlockPos{X: 0, Y: 4, Z: 0}
	v.SetBlock(pos, grass)
	v.SetBlock(below, dirt)
	fill := pal.Get("minecraft:cave_air", nil)

	ctx := caveCarveCtx(v)
	ok := CaveCarveBlock(ctx, CaveConfiguration1_18, fill, pos, false)
	if !ok {
		t.Fatal("expected CaveCarveBlock to succeed")
	}
	if got := v.GetBlock(pos); got != fill {
		t.Fatalf("expected pos filled with cave_air, got %v", pal.Entry(got))
	}
	if got := v.GetBlock(below); got != grass {
		t.Fatalf("expected the original grass_block relocated onto the dirt below, got %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_GrassPreservation_RequiresDirtBelow: same setup, but the block below is
// NOT a dirt group member (plain stone) -- no relocation should happen.
func TestCaveCarveBlock_GrassPreservation_RequiresDirtBelow(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	grass := pal.Get("minecraft:grass_block", nil)
	stone := pal.Get("minecraft:stone", nil)
	pos := wgen.BlockPos{X: 0, Y: 5, Z: 0}
	below := wgen.BlockPos{X: 0, Y: 4, Z: 0}
	v.SetBlock(pos, grass)
	v.SetBlock(below, stone)
	fill := pal.Get("minecraft:cave_air", nil)

	ctx := caveCarveCtx(v)
	CaveCarveBlock(ctx, CaveConfiguration1_18, fill, pos, false)
	if got := v.GetBlock(below); got != stone {
		t.Fatalf("expected the stone below left untouched, got %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_Legacy_LavaAtOrBelowY9: NOT reachable through CaveConfiguration1_18 (see
// cave.go's header, "LEGACY IS ALWAYS FALSE"), but CaveCarveBlock still implements the branch
// faithfully -- exercise it directly with a synthetic Legacy:true config so the branch itself
// (not just its unreachability) is under test.
func TestCaveCarveBlock_Legacy_LavaAtOrBelowY9(t *testing.T) {
	// The game's legacy lava gate compares the ellipsoid-TEST row -- always pos.Y-1 -- against
	// 9, so carve positions up to Y=10 get lava, and
	// Y=11 is the first carve position that takes the ordinary fill path.
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	fill := pal.Get("minecraft:cave_air", nil)
	lava := pal.Get("minecraft:lava", nil)

	legacyConfig := CaveCarverConfig{Legacy: true, IsDiggable: CaveIsDiggable1_18, IsSurface: CaveIsSurface1_18}
	ctx := caveCarveCtx(v)

	posLava := wgen.BlockPos{X: 0, Y: 10, Z: 0} // test row 9 -- the gate's inclusive top
	if ok := CaveCarveBlock(ctx, legacyConfig, fill, posLava, false); !ok {
		t.Fatal("expected CaveCarveBlock to succeed")
	}
	if got := v.GetBlock(posLava); got != lava {
		t.Fatalf("expected legacy carve at Y=10 (test row 9) to place lava, got %v", pal.Entry(got))
	}

	posFill := wgen.BlockPos{X: 1, Y: 11, Z: 0} // test row 10 -- first row past the gate
	if ok := CaveCarveBlock(ctx, legacyConfig, fill, posFill, false); !ok {
		t.Fatal("expected CaveCarveBlock to succeed")
	}
	if got := v.GetBlock(posFill); got != fill {
		t.Fatalf("expected legacy carve at Y=11 (test row 10) to place fill, got %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_Legacy_OceanAbort: same legacy-only branch coverage for the ocean-biome
// abort.
func TestCaveCarveBlock_Legacy_OceanAbort(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	pos := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	fill := pal.Get("minecraft:cave_air", nil)

	legacyConfig := CaveCarverConfig{Legacy: true, IsDiggable: CaveIsDiggable1_18, IsSurface: CaveIsSurface1_18}
	ctx := caveCarveCtx(v)
	ctx.Biome = &wgen.MolangBiome{ID: "test:ocean", Tags: map[string]struct{}{"ocean": {}}}
	ok := CaveCarveBlock(ctx, legacyConfig, fill, pos, false)
	if ok {
		t.Fatal("expected CaveCarveBlock to abort (return false) for a legacy carve in an ocean biome")
	}
	stone := pal.Get("minecraft:stone", nil)
	if got := v.GetBlock(pos); got != stone {
		t.Fatalf("expected the ocean-abort to leave the block untouched, got %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_Legacy_IsUnderwaterCarve_SkipsOceanAbort: the ocean-abort only fires when
// isUnderwaterCarve is false -- an underwater carve must proceed even in an ocean biome.
func TestCaveCarveBlock_Legacy_IsUnderwaterCarve_SkipsOceanAbort(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	// Y=11 keeps this out of the legacy lava band (which now correctly covers carve positions up
	// to Y=10 -- the gate is on the test row pos.Y-1, see TestCaveCarveBlock_Legacy_LavaAtOrBelowY9)
	// so the assertion below still exercises the ocean-skip -> ordinary-fill path it always meant to.
	pos := wgen.BlockPos{X: 0, Y: 11, Z: 0}
	fill := pal.Get("minecraft:cave_air", nil)

	legacyConfig := CaveCarverConfig{Legacy: true, IsDiggable: CaveIsDiggable1_18, IsSurface: CaveIsSurface1_18}
	ctx := caveCarveCtx(v)
	ctx.Biome = &wgen.MolangBiome{ID: "test:ocean", Tags: map[string]struct{}{"ocean": {}}}
	ok := CaveCarveBlock(ctx, legacyConfig, fill, pos, true /* isUnderwaterCarve */)
	if !ok {
		t.Fatal("expected an underwater carve to skip the ocean-abort and succeed")
	}
	if got := v.GetBlock(pos); got != fill {
		t.Fatalf("expected pos filled despite ocean biome (isUnderwaterCarve=true), got %v", pal.Entry(got))
	}
}

// TestCaveCarveBlock_RealCarve_TunnelCrossSection is this project's own carve-verification
// standard ("a recognisable tunnel or chamber cross-section in a solid-stone environment")
// applied to CaveCarveBlock alone. It does not go through the CLI as a real
// minecraft:cave_carver_feature placement -- the end-to-end tests further down do that. What this
// one proves: CaveCarveBlock, called directly across a disc of positions the way the tunnel step
// and the volume carve drive it, removes a genuine,
// visible, solid-stone tunnel cross-section using nothing but the ported function -- not a stub
// that returns success without touching the volume.
func TestCaveCarveBlock_RealCarve_TunnelCrossSection(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	fill := pal.Get("minecraft:cave_air", nil)
	stone := pal.Get("minecraft:stone", nil)
	ctx := caveCarveCtx(v)

	// A circular tunnel cross-section, radius 3, centered at (0,10,0) in the X/Y plane at Z=0 --
	// exactly the kind of disc the volume carve iterates per Z-slice.
	const radius = 3
	center := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	carved := 0
	for dx := -radius; dx <= radius; dx++ {
		for dy := -radius; dy <= radius; dy++ {
			if dx*dx+dy*dy > radius*radius {
				continue
			}
			pos := wgen.BlockPos{X: center.X + dx, Y: center.Y + dy, Z: center.Z}
			if !CaveCarveBlock(ctx, CaveConfiguration1_18, fill, pos, false) {
				t.Fatalf("CaveCarveBlock refused a diggable stone position at %+v", pos)
			}
			carved++
		}
	}
	if carved == 0 {
		t.Fatal("expected a nonzero number of carved positions")
	}

	// Render and log the cross-section as ASCII art -- '#'=stone (untouched), '.'=carved air --
	// and assert it is actually circular (a wall position just outside the disc is untouched
	// stone, the center is carved air), i.e. a real, recognisable tunnel, not a formless blob.
	var art strings.Builder
	for dy := radius; dy >= -radius; dy-- {
		for dx := -radius; dx <= radius; dx++ {
			pos := wgen.BlockPos{X: center.X + dx, Y: center.Y + dy, Z: center.Z}
			if v.GetBlock(pos) == fill {
				art.WriteByte('.')
			} else {
				art.WriteByte('#')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("carved %d blocks; cross-section at Z=%d (# stone, . carved cave_air):\n%s", carved, center.Z, art.String())

	if got := v.GetBlock(center); got != fill {
		t.Fatal("expected the tunnel center to be carved air")
	}
	corner := wgen.BlockPos{X: center.X + radius, Y: center.Y + radius, Z: center.Z} // outside the disc
	if got := v.GetBlock(corner); got != stone {
		t.Fatal("expected a position outside the disc radius to remain untouched stone")
	}
}

// --- CaveEllipsoid -----------------------------------------------------------------------------
//
// See cave.go's "THE ELLIPSOID VOLUME CARVE" section for the derivation these tests stand
// behind. Every test below either pins CaveEllipsoid's own computed CaveBoundingBox exactly,
// recording it via an injected CaveEllipsoidVolumeFunc, or -- for the real-carve demonstration --
// supplies a LOCAL callback implementing the volume-carve algorithm exactly as derived there, so
// the shape CaveEllipsoid actually selects is visible end to end rather than only asserted as
// numbers.

// recordingEllipsoidVolume returns a CaveEllipsoidVolumeFunc that records its own bounds argument
// (and everything else it was called with) into *got, and returns retVal without touching the
// volume at all -- used by the bounding-box/broad-phase tests below, which check CaveEllipsoid's
// OWN arithmetic rather than any volume carve's behaviour.
func recordingEllipsoidVolume(called *bool, got *CaveBoundingBox, retVal bool) CaveEllipsoidVolumeFunc {
	return func(ctx *wgen.PlacementContext, config CaveCarverConfig, rnd random.IRandom, chunk CaveChunkPos, center CaveVec3, bounds CaveBoundingBox, radiusXZ, radiusY float32, params CaveCarvingParameters) bool {
		*called = true
		*got = bounds
		return retVal
	}
}

func caveEllipsoidTestCtx(v *volume.Volume) *wgen.PlacementContext {
	return &wgen.PlacementContext{
		API:    v,
		Origin: wgen.BlockPos{X: 0, Y: 10, Z: 0},
		Random: random.New(1),
	}
}

// TestCaveEllipsoid_BroadPhase_FarChunk_NoOp: a chunk far outside the ellipsoid's padded footprint
// must short-circuit to a true no-op -- carveVolume is never called at all.
func TestCaveEllipsoid_BroadPhase_FarChunk_NoOp(t *testing.T) {
	v, _ := newCaveTestVolume(t, "minecraft:stone")
	ctx := caveEllipsoidTestCtx(v)

	var called bool
	var got CaveBoundingBox
	carveVolume := recordingEllipsoidVolume(&called, &got, true)

	// Chunk (5,5) -> world origin (80,80), nowhere near a radius-5 ellipsoid centered at (8,20,8).
	ok := CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 100}, carveVolume,
		ctx.Random, CaveChunkPos{X: 5, Z: 5}, CaveVec3{X: 8, Y: 20, Z: 8}, 5, 5, CaveCarvingParameters{})
	if !ok {
		t.Fatal("expected CaveEllipsoid to return true (no-op success) for a far-away chunk")
	}
	if called {
		t.Fatal("expected carveVolume NOT to be called for a far-away chunk")
	}
}

// TestCaveEllipsoid_BroadPhase_NearChunk_Invokes: the mirror image -- a chunk actually under the
// ellipsoid must invoke carveVolume.
func TestCaveEllipsoid_BroadPhase_NearChunk_Invokes(t *testing.T) {
	v, _ := newCaveTestVolume(t, "minecraft:stone")
	ctx := caveEllipsoidTestCtx(v)

	var called bool
	var got CaveBoundingBox
	carveVolume := recordingEllipsoidVolume(&called, &got, true)

	ok := CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 100}, carveVolume,
		ctx.Random, CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, 5, 5, CaveCarvingParameters{})
	if !ok {
		t.Fatal("expected CaveEllipsoid to return carveVolume's own result (true)")
	}
	if !called {
		t.Fatal("expected carveVolume to be called for a chunk under the ellipsoid")
	}
}

// TestCaveEllipsoid_BoundingBox_Exact pins CaveEllipsoid's own computed CaveBoundingBox against
// hand-derived values -- see cave.go's header for the formula this is checking bit-for-bit
// (chunk-local X/Z clamped to 0..16, absolute-world Y clamped against MaxY()-2/HeightLimit, all
// three Max* fields exclusive). Volume MaxY()=40 (see newCaveEllipsoidTestVolume).
func TestCaveEllipsoid_BoundingBox_Exact(t *testing.T) {
	v, _ := newCaveEllipsoidTestVolume(t)
	ctx := caveEllipsoidTestCtx(v)

	var called bool
	var got CaveBoundingBox
	carveVolume := recordingEllipsoidVolume(&called, &got, true)

	// chunk (0,0) -> worldOrigin (0,0); center (8,20,8), radiusXZ=5, radiusY=6, HeightLimit=100
	// (non-binding: MaxY()-2 = 38 < 100).
	//   X: floor(8+5)-0=13 (<15, no clamp) -> maxX=14; floor(8-5)-0-1=2 (>=0) -> minX=2.
	//   Z: identical to X (center.Z=8 too)                              -> minZ=2, maxZ=14.
	//   Y: maxYLimit=min(38,100)=38; rawYUpper=floor(20+6)=26 (<38) -> maxY=max(26,0)+1=27.
	//      rawYLowerMinus1=floor(20-6)-1=13 (<=27) -> minY=max(13,1)=13.
	want := CaveBoundingBox{MinX: 2, MinY: 13, MinZ: 2, MaxX: 14, MaxY: 27, MaxZ: 14}

	ok := CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 100}, carveVolume,
		ctx.Random, CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, 5, 6, CaveCarvingParameters{})
	if !ok || !called {
		t.Fatal("expected carveVolume to be called and its result forwarded")
	}
	if got != want {
		t.Fatalf("CaveEllipsoid computed bounds = %+v, want %+v", got, want)
	}
}

// TestCaveEllipsoid_HeightLimitClamp_Binds: with a small HeightLimit, the Y-upper bound must come
// from HeightLimit, not api.MaxY()-2 -- the specific case CaveEllipsoidConfig exists to model.
func TestCaveEllipsoid_HeightLimitClamp_Binds(t *testing.T) {
	v, _ := newCaveEllipsoidTestVolume(t) // MaxY()=40, so MaxY()-2=38
	ctx := caveEllipsoidTestCtx(v)

	var called bool
	var got CaveBoundingBox
	carveVolume := recordingEllipsoidVolume(&called, &got, true)

	// radiusY=50 pushes rawYUpper (70) past every clamp, so maxY ends up AT the binding limit
	// exactly -- HeightLimit=25 here, well below api.MaxY()-2=38.
	CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 25}, carveVolume,
		ctx.Random, CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, 5, 50, CaveCarvingParameters{})
	if !called {
		t.Fatal("expected carveVolume to be called")
	}
	if got.MaxY != 25 {
		t.Fatalf("expected HeightLimit (25) to bind, got MaxY=%d", got.MaxY)
	}
}

// TestCaveEllipsoid_HeightLimitClamp_APIMaxYBinds is the mirror case: a generous HeightLimit
// leaves api.MaxY()-2 as the binding clamp.
func TestCaveEllipsoid_HeightLimitClamp_APIMaxYBinds(t *testing.T) {
	v, _ := newCaveEllipsoidTestVolume(t) // MaxY()=40, so MaxY()-2=38
	ctx := caveEllipsoidTestCtx(v)

	var called bool
	var got CaveBoundingBox
	carveVolume := recordingEllipsoidVolume(&called, &got, true)

	CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, carveVolume,
		ctx.Random, CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, 5, 50, CaveCarvingParameters{})
	if !called {
		t.Fatal("expected carveVolume to be called")
	}
	if got.MaxY != 38 {
		t.Fatalf("expected api.MaxY()-2 (38) to bind, got MaxY=%d", got.MaxY)
	}
}

// newCaveEllipsoidTestVolume builds a solid-stone, full-chunk-sized bench (X/Z: 0..15, i.e.
// exactly one 16-wide chunk at chunk (0,0); Y: 0..39) -- CaveEllipsoid's own chunk-local X/Z
// bounds only ever span 0..16, so newCaveTestVolume's smaller 9x9 footprint isn't enough for the
// ellipsoid tests above or the real-carve demonstration below.
func newCaveEllipsoidTestVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 16, SizeY: 40, SizeZ: 16}
	v := volume.New(bounds, pal, block.AirID)
	for x := 0; x < 16; x++ {
		for y := 0; y < 40; y++ {
			for z := 0; z < 16; z++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	return v, pal
}

// TestCaveEllipsoid_RealCarve_SphereCrossSection is this project's own carve-verification
// standard applied to CaveEllipsoid's real bounding-box selection,
// driven through the real, package-level NewCaveEllipsoidVolume's own built-in default gate
// (CaveScanForWaterGate -- this bench volume has no water anywhere, so the real engine's own
// no-aquifer behavior permits the carve honestly, not via an asserted-by-the-caller shortcut), carving
// a real, visible sphere into solid stone -- not a stub, not a count. This is this file's "water
// absent -> carved" pin for the default gate; TestNewCaveEllipsoidVolume_DefaultGate_WaterPresent_
// NotCarved is the "water present -> not carved" counterpart.
func TestCaveEllipsoid_RealCarve_SphereCrossSection(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	fill := pal.Get("minecraft:cave_air", nil)
	stone := pal.Get("minecraft:stone", nil)
	ctx := caveEllipsoidTestCtx(v)

	center := CaveVec3{X: 8, Y: 20, Z: 8}
	const radius = 5
	// FloorLevel far below any real dy so it never gates this demonstration -- this bench cannot
	// yet supply a real float-range-drawn value (see cave.go's header).
	params := CaveCarvingParameters{FloorLevel: -2}

	carveVolume := NewCaveEllipsoidVolume(fill)
	ok := CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000},
		carveVolume, ctx.Random, CaveChunkPos{X: 0, Z: 0}, center, radius, radius, params)
	if !ok {
		t.Fatal("expected CaveEllipsoid to succeed")
	}

	// Vertical (X/Y) cross-section through the sphere's own center Z -- should read as a circle.
	var art strings.Builder
	carved := 0
	for dy := radius; dy >= -radius; dy-- {
		for dx := -radius; dx <= radius; dx++ {
			pos := wgen.BlockPos{X: int(center.X) + dx, Y: int(center.Y) + dy, Z: int(center.Z)}
			if v.GetBlock(pos) == fill {
				art.WriteByte('.')
				carved++
			} else {
				art.WriteByte('#')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("CaveEllipsoid + volume carve, real carve -- %d blocks carved in this X/Y slice; "+
		"vertical cross-section at Z=%d (# stone, . carved cave_air):\n%s", carved, int(center.Z), art.String())

	if got := v.GetBlock(wgen.BlockPos{X: int(center.X), Y: int(center.Y), Z: int(center.Z)}); got != fill {
		t.Fatal("expected the sphere's own center to be carved air")
	}
	corner := wgen.BlockPos{X: int(center.X) + radius, Y: int(center.Y) + radius, Z: int(center.Z)}
	if got := v.GetBlock(corner); got != stone {
		t.Fatal("expected a position outside the sphere's radius to remain untouched stone")
	}
	if carved == 0 {
		t.Fatal("expected a nonzero number of carved positions")
	}
}

// --- CaveWaterGate / CaveDetectWater / NewCaveEllipsoidVolume ----------------------------------
//
// See cave.go's "THE WATER GATE" section for the derivation of the volume carve's opening gate
// and of why it is injectable. Every test below either
// pins CaveDetectWater's own Y-padding and target-block behaviour directly, or
// exercises the CaveWaterGate contract end to end through NewCaveEllipsoidVolume.

// caveWarning is one captured ctx.LogWarning call -- mirrors geode_test.go's own geodeWarning,
// this package's established pattern for asserting on disclosed-gap diagnostics.
type caveWarning struct {
	featureType string
	message     string
	pos         *wgen.BlockPos
}

// caveEllipsoidTestCtxCapturingWarnings is caveEllipsoidTestCtx plus a LogWarning capture.
func caveEllipsoidTestCtxCapturingWarnings(v *volume.Volume) (*wgen.PlacementContext, *[]caveWarning) {
	var warnings []caveWarning
	ctx := caveEllipsoidTestCtx(v)
	ctx.LogWarning = func(featureType, message string, pos *wgen.BlockPos) {
		warnings = append(warnings, caveWarning{featureType: featureType, message: message, pos: pos})
	}
	return ctx, &warnings
}

// TestCaveNoWaterGate_AlwaysTrue -- CaveNoWaterGate models "an aquifer is present", the real
// engine's own `aquifer != nil` short-circuit, and not "this bench asserts no water exists". See
// cave.go's "THE WATER GATE" section.
func TestCaveNoWaterGate_AlwaysTrue(t *testing.T) {
	v, _ := newCaveEllipsoidTestVolume(t)
	ctx := caveEllipsoidTestCtx(v)
	if !CaveNoWaterGate(ctx, CaveChunkPos{}, CaveBoundingBox{}) {
		t.Fatal("expected CaveNoWaterGate to always return true")
	}
}

// TestCaveDetectWater_NoWater_ReturnsFalse: the standard "solid stone bench" case -- no water
// anywhere, CaveDetectWater must report none found.
func TestCaveDetectWater_NoWater_ReturnsFalse(t *testing.T) {
	v, _ := newCaveEllipsoidTestVolume(t)
	ctx := caveEllipsoidTestCtx(v)
	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}
	if CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
		t.Fatal("expected CaveDetectWater to find no water in an all-stone volume")
	}
}

// TestCaveDetectWater_FindsWaterInsideBounds: a water block strictly inside the bounding box's own
// X/Z/Y span must be detected.
func TestCaveDetectWater_FindsWaterInsideBounds(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	water := pal.Get("minecraft:water", nil)
	v.SetBlock(wgen.BlockPos{X: 3, Y: 12, Z: 3}, water)
	ctx := caveEllipsoidTestCtx(v)

	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}
	if !CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
		t.Fatal("expected CaveDetectWater to find water strictly inside the bounds")
	}
}

// TestCaveDetectWater_FlowingWaterAlsoDetected: both target block ids (water and flowing water)
// are matched, not just one -- exercise the second one specifically.
func TestCaveDetectWater_FlowingWaterAlsoDetected(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	flowing := pal.Get("minecraft:flowing_water", nil)
	v.SetBlock(wgen.BlockPos{X: 3, Y: 12, Z: 3}, flowing)
	ctx := caveEllipsoidTestCtx(v)

	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}
	if !CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
		t.Fatal("expected CaveDetectWater to find minecraft:flowing_water too")
	}
}

// TestCaveDetectWater_YPadding_OneBlockAboveAndBelowIncluded pins the Y-padding exactly:
// water at bounds.MaxY (one above the exclusive upper Y bound used elsewhere, but within the
// water-detection-specific padded range bounds.MinY-1..bounds.MaxY+1) must still be found, and water
// one block further out (bounds.MaxY+2) must NOT be found.
func TestCaveDetectWater_YPadding_OneBlockAboveAndBelowIncluded(t *testing.T) {
	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}

	t.Run("one above MaxY is within the pad", func(t *testing.T) {
		v, pal := newCaveEllipsoidTestVolume(t)
		water := pal.Get("minecraft:water", nil)
		v.SetBlock(wgen.BlockPos{X: 3, Y: bounds.MaxY + 1, Z: 3}, water) // = 16, hiY = min(16,38) = 16
		ctx := caveEllipsoidTestCtx(v)
		if !CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
			t.Fatal("expected water at bounds.MaxY+1 (within the pad) to be found")
		}
	})

	t.Run("two above MaxY is outside the pad", func(t *testing.T) {
		v, pal := newCaveEllipsoidTestVolume(t)
		water := pal.Get("minecraft:water", nil)
		v.SetBlock(wgen.BlockPos{X: 3, Y: bounds.MaxY + 2, Z: 3}, water) // = 17, outside hiY = 16
		ctx := caveEllipsoidTestCtx(v)
		if CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
			t.Fatal("expected water at bounds.MaxY+2 (outside the pad) NOT to be found")
		}
	})

	t.Run("one below MinY is within the pad", func(t *testing.T) {
		v, pal := newCaveEllipsoidTestVolume(t)
		water := pal.Get("minecraft:water", nil)
		v.SetBlock(wgen.BlockPos{X: 3, Y: bounds.MinY - 1, Z: 3}, water) // = 9
		ctx := caveEllipsoidTestCtx(v)
		if !CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
			t.Fatal("expected water at bounds.MinY-1 (within the pad) to be found")
		}
	})

	t.Run("two below MinY is outside the pad", func(t *testing.T) {
		v, pal := newCaveEllipsoidTestVolume(t)
		water := pal.Get("minecraft:water", nil)
		v.SetBlock(wgen.BlockPos{X: 3, Y: bounds.MinY - 2, Z: 3}, water) // = 8
		ctx := caveEllipsoidTestCtx(v)
		if CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
			t.Fatal("expected water at bounds.MinY-2 (outside the pad) NOT to be found")
		}
	})
}

// TestCaveDetectWater_OutsideXZBoundsNotFound: water outside the bounding box's own chunk-local
// X/Z span (even at an in-range Y) must not be found -- CaveDetectWater's X/Z scan is
// exact (only its shell-vs-full-box shape is the disclosed over-approximation), so a position
// clean outside the box entirely is a real negative, not just an approximation edge case.
func TestCaveDetectWater_OutsideXZBoundsNotFound(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	water := pal.Get("minecraft:water", nil)
	v.SetBlock(wgen.BlockPos{X: 10, Y: 12, Z: 10}, water)
	ctx := caveEllipsoidTestCtx(v)

	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}
	if CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
		t.Fatal("expected water well outside bounds' own X/Z span not to be found")
	}
}

// TestCaveScanForWaterGate_NoWater_ProceedsSilently: no water anywhere -> the gate permits the
// carve and never calls LogWarning.
func TestCaveScanForWaterGate_NoWater_ProceedsSilently(t *testing.T) {
	v, _ := newCaveEllipsoidTestVolume(t)
	ctx, warnings := caveEllipsoidTestCtxCapturingWarnings(v)

	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}
	if !CaveScanForWaterGate(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
		t.Fatal("expected CaveScanForWaterGate to permit the carve when no water is present")
	}
	if len(*warnings) != 0 {
		t.Fatalf("expected no warnings when no water is present, got %+v", *warnings)
	}
}

// TestCaveScanForWaterGate_WaterPresent_Blocks: water present -> the gate refuses the carve.
// (This test previously also asserted an "over-approximated scan" LogWarning; that diagnostic was
// retired when CaveDetectWater became the faithful scan -- there is no
// approximation left to disclose, so blocking is now silent, exactly like the real engine.)
func TestCaveScanForWaterGate_WaterPresent_Blocks(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	water := pal.Get("minecraft:water", nil)
	v.SetBlock(wgen.BlockPos{X: 3, Y: 12, Z: 3}, water)
	ctx, warnings := caveEllipsoidTestCtxCapturingWarnings(v)

	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}
	if CaveScanForWaterGate(ctx, CaveChunkPos{X: 0, Z: 0}, bounds) {
		t.Fatal("expected CaveScanForWaterGate to block the carve when water is present")
	}
	if len(*warnings) != 0 {
		t.Fatalf("expected no warnings from the faithful scan, got %+v", *warnings)
	}
}

// TestCaveDetectWater_CornerColumnInterior_Skipped pins the one place the faithful scan differs
// from a full-box over-approximation: the single corner column (MaxX-1, MaxZ-1) of a >=2x2 box is
// checked ONLY at y = hiY (bounds.MaxY+1 clamped) and y = bounds.MinY-1 -- water strictly BETWEEN
// those two endpoints in that one column is invisible to the engine's scan, so the carve proceeds.
// Water at either checked endpoint of the same column, or anywhere in any other column, is found.
// Run red against a full-box implementation (it finds the interior corner water and refuses the
// carve) and green against the faithful scan.
func TestCaveDetectWater_CornerColumnInterior_Skipped(t *testing.T) {
	bounds := CaveBoundingBox{MinX: 2, MinY: 10, MinZ: 2, MaxX: 6, MaxY: 15, MaxZ: 6}
	cornerX, cornerZ := bounds.MaxX-1, bounds.MaxZ-1 // 5, 5
	// hiY = MaxY+1 = 16, loY = MinY-1 = 9 (both in-world for this bench).

	place := func(t *testing.T, pos wgen.BlockPos) (*wgen.PlacementContext, bool) {
		t.Helper()
		v, pal := newCaveEllipsoidTestVolume(t)
		v.SetBlock(pos, pal.Get("minecraft:water", nil))
		ctx, _ := caveEllipsoidTestCtxCapturingWarnings(v)
		return ctx, CaveDetectWater(ctx, CaveChunkPos{X: 0, Z: 0}, bounds)
	}

	if _, found := place(t, wgen.BlockPos{X: cornerX, Y: 12, Z: cornerZ}); found {
		t.Error("water strictly inside the corner column must be SKIPPED (engine checks only hiY and MinY-1 there)")
	}
	if _, found := place(t, wgen.BlockPos{X: cornerX, Y: 16, Z: cornerZ}); !found {
		t.Error("water at the corner column's hiY endpoint must be found")
	}
	if _, found := place(t, wgen.BlockPos{X: cornerX, Y: 9, Z: cornerZ}); !found {
		t.Error("water at the corner column's MinY-1 endpoint must be found")
	}
	if _, found := place(t, wgen.BlockPos{X: cornerX - 1, Y: 12, Z: cornerZ}); !found {
		t.Error("water in the neighboring (non-corner) column must be found by its full scan")
	}
	if _, found := place(t, wgen.BlockPos{X: cornerX, Y: 12, Z: cornerZ - 1}); !found {
		t.Error("water in the corner x column at z != MaxZ-1 must be found by its full scan")
	}
}

// TestNewCaveEllipsoidVolumeWithGate_NilGate_Panics: waterGate is REQUIRED on the explicit
// NewCaveEllipsoidVolumeWithGate constructor -- see cave.go's "THE WATER GATE" section for why
// this seam still exists (an aquifer-modelling caller) even though the plain
// NewCaveEllipsoidVolume neither takes nor needs a gate argument. A nil gate must fail loudly at construction time, not
// silently carve (or silently refuse) at call time.
func TestNewCaveEllipsoidVolumeWithGate_NilGate_Panics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected NewCaveEllipsoidVolumeWithGate(fill, nil) to panic")
		}
	}()
	pal := block.NewPalette()
	fill := pal.Get("minecraft:cave_air", nil)
	NewCaveEllipsoidVolumeWithGate(fill, nil)
}

// TestNewCaveEllipsoidVolume_DefaultGate_WaterPresent_NotCarved: NewCaveEllipsoidVolume's own
// built-in default gate (CaveScanForWaterGate) wired end-to-end -- when the ellipsoid's
// own bounding box contains water, NOT ONE block in the whole volume is carved (the gate is checked
// ONCE per volume carve, before the triple-nested loop starts -- not per-block), and no
// diagnostic fires (there is nothing approximate left to disclose -- see CaveScanForWaterGate's own
// doc comment). This is this file's "water present -> not carved" pin for the engine's own default
// (no-aquifer) behavior; TestCaveEllipsoid_RealCarve_SphereCrossSection is the "water absent ->
// carved" counterpart, through the exact same default constructor.
func TestNewCaveEllipsoidVolume_DefaultGate_WaterPresent_NotCarved(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	fill := pal.Get("minecraft:cave_air", nil)
	stone := pal.Get("minecraft:stone", nil)
	water := pal.Get("minecraft:water", nil)

	center := CaveVec3{X: 8, Y: 20, Z: 8}
	const radius = 5
	// Place water at the sphere's own center -- guaranteed inside the volume carve's own
	// bounding box for this ellipsoid.
	v.SetBlock(wgen.BlockPos{X: 8, Y: 20, Z: 8}, water)

	ctx, warnings := caveEllipsoidTestCtxCapturingWarnings(v)
	carveVolume := NewCaveEllipsoidVolume(fill) // no gate argument -- exercises the built-in default
	ok := CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000},
		carveVolume, ctx.Random, CaveChunkPos{X: 0, Z: 0}, center, radius, radius, CaveCarvingParameters{FloorLevel: -2})
	if !ok {
		t.Fatal("expected CaveEllipsoid to still report success (the volume carve always returns true)")
	}
	if len(*warnings) != 0 {
		t.Fatalf("expected no warnings (the faithful scan blocks silently, like the engine), got %+v", *warnings)
	}

	// Nothing carved anywhere in the sphere's own footprint -- not even positions far from the
	// water block itself, proving the gate is whole-volume, not per-block.
	for dx := -radius; dx <= radius; dx++ {
		for dy := -radius; dy <= radius; dy++ {
			for dz := -radius; dz <= radius; dz++ {
				if dx*dx+dy*dy+dz*dz > radius*radius {
					continue
				}
				pos := wgen.BlockPos{X: 8 + dx, Y: 20 + dy, Z: 8 + dz}
				if pos.X == 8 && pos.Y == 20 && pos.Z == 8 {
					continue // the water block itself, deliberately not stone
				}
				if got := v.GetBlock(pos); got != stone {
					t.Fatalf("expected %+v to remain untouched stone (water gate should have blocked "+
						"the whole volume), got %v", pos, pal.Entry(got))
				}
			}
		}
	}
}

// TestNewCaveEllipsoidVolumeWithGate_CaveNoWaterGate_ModelsAquiferPresent_CarvesThroughWater: the
// seam NewCaveEllipsoidVolumeWithGate is kept for -- a caller explicitly modelling an aquifer as
// present, mirroring the density-function pipeline (see cave.go), gets the real engine's own
// `aquifer != nil` short-circuit: water detection is skipped entirely and the carve proceeds even though
// water sits inside the bounding box. This is deliberately the OPPOSITE outcome from
// TestNewCaveEllipsoidVolume_DefaultGate_WaterPresent_NotCarved with the identical water placement,
// proving the seam is a real, live alternative, not dead code left behind by the default change.
func TestNewCaveEllipsoidVolumeWithGate_CaveNoWaterGate_ModelsAquiferPresent_CarvesThroughWater(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	fill := pal.Get("minecraft:cave_air", nil)
	water := pal.Get("minecraft:water", nil)

	center := CaveVec3{X: 8, Y: 20, Z: 8}
	const radius = 5
	// Water sitting inside the ellipsoid's own bounding box, but NOT at the exact carve center: water
	// is not a member of CaveIsDiggable1_18's own diggable set, so the per-block carve's own gate
	// (unrelated to the water gate) would leave that exact position untouched regardless of which
	// water gate is wired -- the water gate only controls whether the SURROUNDING stone gets carved.
	v.SetBlock(wgen.BlockPos{X: 8, Y: 20, Z: 8}, water)

	ctx := caveEllipsoidTestCtx(v)
	carveVolume := NewCaveEllipsoidVolumeWithGate(fill, CaveNoWaterGate)
	ok := CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000},
		carveVolume, ctx.Random, CaveChunkPos{X: 0, Z: 0}, center, radius, radius, CaveCarvingParameters{FloorLevel: -2})
	if !ok {
		t.Fatal("expected CaveEllipsoid to succeed")
	}
	// A stone position elsewhere inside the sphere (dx=2, well inside radius 5) must be carved
	// despite the water sitting in the same bounding box: CaveNoWaterGate models an aquifer as
	// present, which skips water detection entirely (the real engine's own `aquifer != nil`
	// short-circuit) -- the opposite outcome from the default gate with this identical water
	// placement (TestNewCaveEllipsoidVolume_DefaultGate_WaterPresent_NotCarved).
	probe := wgen.BlockPos{X: int(center.X) + 2, Y: int(center.Y), Z: int(center.Z)}
	if got := v.GetBlock(probe); got != fill {
		t.Fatalf("expected %+v (stone, inside the sphere) to be carved despite water present elsewhere "+
			"in the same bounding box, got %v", probe, pal.Entry(got))
	}
}

// TestNewCaveEllipsoidVolume_DefaultMatchesExplicitScanForWaterGate pins that
// NewCaveEllipsoidVolume(fill)'s own built-in default is EXACTLY
// NewCaveEllipsoidVolumeWithGate(fill, CaveScanForWaterGate) -- not merely similar. Runs the real
// CaveAddRoom pipeline (real RNG draws against a shared tracer, real carve against a shared-shape
// volume) through both constructors from the identical seed and asserts the caller-visible RNG draw
// sequence AND the resulting carved-volume state are bit-for-bit identical, directly proving this
// change moved no draw (per this project's own "RNG call order is the entire correctness contract"
// standard) and carved nothing differently.
func TestNewCaveEllipsoidVolume_DefaultMatchesExplicitScanForWaterGate(t *testing.T) {
	// run builds its OWN fresh volume/palette/fill id (never shared across the two calls below) and
	// constructs carveVolume from fillWith via makeVolume -- so each side's "carved" comparison is
	// against its own fill id, not an assumption that two independently-built palettes assign
	// "minecraft:cave_air" the identical block.ID.
	run := func(makeVolume func(fillWith block.ID) CaveEllipsoidVolumeFunc) ([]random.Method, *volume.Volume, block.ID) {
		v, pal := newCaveEllipsoidTestVolume(t)
		fill := pal.Get("minecraft:cave_air", nil)
		ctx := caveEllipsoidTestCtx(v)
		inner := random.New(2024)
		tr := random.NewTracer(inner)
		roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1.3}
		carveVolume := makeVolume(fill)

		CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, tr,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, nil)
		return drawSeq(tr), v, fill
	}

	defaultSeq, defaultVol, defaultFill := run(func(fillWith block.ID) CaveEllipsoidVolumeFunc {
		return NewCaveEllipsoidVolume(fillWith)
	})
	explicitSeq, explicitVol, explicitFill := run(func(fillWith block.ID) CaveEllipsoidVolumeFunc {
		return NewCaveEllipsoidVolumeWithGate(fillWith, CaveScanForWaterGate)
	})

	if !equalMethodSeq(defaultSeq, explicitSeq) {
		t.Fatalf("draw sequence diverged between the default gate and explicit CaveScanForWaterGate:\n"+
			"default:  %v\nexplicit: %v", defaultSeq, explicitSeq)
	}
	for x := 0; x < 16; x++ {
		for y := 0; y < 40; y++ {
			for z := 0; z < 16; z++ {
				pos := wgen.BlockPos{X: x, Y: y, Z: z}
				a := defaultVol.GetBlock(pos) == defaultFill
				b := explicitVol.GetBlock(pos) == explicitFill
				if a != b {
					t.Fatalf("carved-state diverged at %+v: default carved=%v explicit carved=%v", pos, a, b)
				}
			}
		}
	}
}

// --- The carver configuration's tunnel-thickness, tunnel-length and vertical-position draws -----
//
// Every test below pins the EXACT draw sequence via random.Tracer, per this project's own
// standard ("pin draw sequences explicitly, not just block counts") -- see cave.go's "THE CARVER
// CONFIGURATION'S SIX DRAW FUNCTIONS" section for what each assertion stands behind.

func drawSeq(tr *random.Tracer) []random.Method {
	methods := make([]random.Method, len(tr.Draws))
	for i, d := range tr.Draws {
		methods[i] = d.Method
	}
	return methods
}

// TestCaveTunnelThickness1_18_HighRoll: NextIntBound(10) != 0 -- exactly 3 draws (2 NextFloat, 1
// nextIntBound), the bias branch never taken.
func TestCaveTunnelThickness1_18_HighRoll(t *testing.T) {
	// seed 1: the first NextIntBound(10) draw must be nonzero for this case -- verified empirically below
	// via the actual recorded value, not assumed.
	inner := random.New(1)
	tr := random.NewTracer(inner)
	got := CaveTunnelThickness1_18(tr)

	if len(tr.Draws) != 3 {
		t.Fatalf("seed 1: expected 3 draws (high-roll path), got %d: %+v", len(tr.Draws), tr.Draws)
	}
	wantSeq := []random.Method{random.MethodNextFloat, random.MethodNextFloat, random.MethodNextIntBound}
	if seq := drawSeq(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("seed 1: draw sequence = %v, want %v", seq, wantSeq)
	}
	if tr.Draws[2].Value == 0 {
		t.Fatalf("seed 1: this test assumes the nextIntBound(10) draw is NONZERO (high-roll, no " +
			"bias branch) -- got 0, this seed no longer exercises that path, pick a different one")
	}
	// Recompute expected thickness directly from the two recorded NextFloat values -- NARROWING
	// EACH DRAW FIRST, which is what the game does (see
	// CaveTunnelThickness1_18's doc comment). This is a discriminating check, not a restatement:
	// on this seed the all-float64 spelling `float32(d1*2 + d2)` gives 1.8312289 where the
	// engine's `float32(d1)*2 + float32(d2)` gives 1.8312287, so a revert to double arithmetic
	// fails here.
	d1 := tr.Draws[0].Value
	d2 := tr.Draws[1].Value
	want := float32(float32(d1)*2) + float32(d2)
	if want == float32(d1*2+d2) {
		t.Fatalf("seed 1: this seed no longer distinguishes float32 from float64 arithmetic " +
			"(both give the same result) -- pick a different one, or this test proves nothing")
	}
	if got != want {
		t.Fatalf("seed 1: thickness = %v, want %v (from recorded draws d1=%v d2=%v)", got, want, d1, d2)
	}
}

// TestCaveTunnelThickness1_18_LowRoll_ExtraDraws: forces the nextIntBound(10)==0 branch via a
// scripted IRandom (not a real seed hunt) so the 5-draw path -- including the extra multiply --
// is under test too.
func TestCaveTunnelThickness1_18_LowRoll_ExtraDraws(t *testing.T) {
	// The four scripted values are real NextFloat outputs (32 significant bits, the shape
	// random.Rand actually produces), not round decimals -- round decimals would make the bias
	// branch agree in float32 and float64 and the test would stop proving anything.
	const f1, f2 = 0.4170219984371215, 0.99718480813317
	const f3, f4 = 0.7203244894742966, 0.00011437481269240379
	sc := &caveScriptedRandom{floats: []float64{f1, f2, f3, f4}, intBounds: []int{0}}
	tr := random.NewTracer(sc)
	got := CaveTunnelThickness1_18(tr)

	wantSeq := []random.Method{
		random.MethodNextFloat, random.MethodNextFloat, random.MethodNextIntBound,
		random.MethodNextFloat, random.MethodNextFloat,
	}
	if seq := drawSeq(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v, want %v (5-draw low-roll path)", seq, wantSeq)
	}
	// Every operation narrowed on its own, matching the game's separate single-precision
	// multiplies and adds.
	thickness := float32(float32(f1)*2) + float32(f2)
	bias := float32(float32(float32(f3)*float32(f4))*3) + 1
	want := thickness * bias
	if want == float32(float64(thickness)*(f3*f4*3+1)) {
		t.Fatalf("these scripted values no longer distinguish float32 from float64 arithmetic " +
			"on the bias branch -- pick different ones, or this test proves nothing")
	}
	if got != want {
		t.Fatalf("thickness = %v, want %v", got, want)
	}
}

// TestCaveTunnelThickness1_16_AlwaysTwoDraws: no bias branch at all, ever -- exactly 2 draws.
func TestCaveTunnelThickness1_16_AlwaysTwoDraws(t *testing.T) {
	inner := random.New(42)
	tr := random.NewTracer(inner)
	got := CaveTunnelThickness1_16(tr)

	wantSeq := []random.Method{random.MethodNextFloat, random.MethodNextFloat}
	if seq := drawSeq(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v, want %v", seq, wantSeq)
	}
	// Narrowed per draw and per operation -- see the 1_18 sibling test above. Discriminating on
	// this seed: the all-float64 spelling gives 1.5456232 and the engine's gives 1.5456233.
	want := float32(float32(tr.Draws[0].Value)*2) + float32(tr.Draws[1].Value)
	if want == float32(tr.Draws[0].Value*2+tr.Draws[1].Value) {
		t.Fatalf("seed 42 no longer distinguishes float32 from float64 arithmetic -- pick a " +
			"different one, or this test proves nothing")
	}
	if got != want {
		t.Fatalf("thickness = %v, want %v", got, want)
	}
}

// TestCaveDistance1_18_OneDraw: 112 - nextIntBound(28), exactly one draw with bound 28.
func TestCaveDistance1_18_OneDraw(t *testing.T) {
	inner := random.New(7)
	tr := random.NewTracer(inner)
	got := CaveDistance1_18(tr)

	if len(tr.Draws) != 1 || tr.Draws[0].Method != random.MethodNextIntBound || tr.Draws[0].Bound != 28 {
		t.Fatalf("expected exactly one NextIntBound(28) draw, got %+v", tr.Draws)
	}
	want := 112 - int(tr.Draws[0].Value)
	if got != want {
		t.Fatalf("distance = %d, want %d", got, want)
	}
}

// TestCaveDistance1_16_NoDraw: hardcoded 0, no draw at all.
func TestCaveDistance1_16_NoDraw(t *testing.T) {
	inner := random.New(7)
	tr := random.NewTracer(inner)
	got := CaveDistance1_16(tr)

	if len(tr.Draws) != 0 {
		t.Fatalf("expected NO draws (hardcoded constant), got %+v", tr.Draws)
	}
	if got != 0 {
		t.Fatalf("distance = %d, want 0", got)
	}
}

// TestCaveUniformRandomY1_18_OneDraw: nextIntBound(bound) + 8, bound is the caller's own
// parameter, threaded straight through (not a fixed literal).
func TestCaveUniformRandomY1_18_OneDraw(t *testing.T) {
	inner := random.New(3)
	tr := random.NewTracer(inner)
	got := CaveUniformRandomY1_18(tr, 37)

	if len(tr.Draws) != 1 || tr.Draws[0].Method != random.MethodNextIntBound || tr.Draws[0].Bound != 37 {
		t.Fatalf("expected exactly one NextIntBound(37) draw, got %+v", tr.Draws)
	}
	want := int(tr.Draws[0].Value) + 8
	if got != want {
		t.Fatalf("randomY = %d, want %d", got, want)
	}
}

// TestCaveBiasRandomY1_16_TwoDependentDraws: the second draw's OWN bound is the first draw's
// result + 8 -- a real data dependency between the two draws, not two independent calls sharing
// the caller's bound.
func TestCaveBiasRandomY1_16_TwoDependentDraws(t *testing.T) {
	inner := random.New(3)
	tr := random.NewTracer(inner)
	got := CaveBiasRandomY1_16(tr, 20)

	if len(tr.Draws) != 2 {
		t.Fatalf("expected exactly 2 draws, got %+v", tr.Draws)
	}
	if tr.Draws[0].Method != random.MethodNextIntBound || tr.Draws[0].Bound != 20 {
		t.Fatalf("draw 1 = %+v, want NextIntBound(20)", tr.Draws[0])
	}
	d1 := int(tr.Draws[0].Value)
	if tr.Draws[1].Method != random.MethodNextIntBound || tr.Draws[1].Bound != int32(d1+8) {
		t.Fatalf("draw 2 = %+v, want NextIntBound(%d) (draw 1's own result + 8)", tr.Draws[1], d1+8)
	}
	want := int(tr.Draws[1].Value)
	if got != want {
		t.Fatalf("biasRandomY = %d, want %d", got, want)
	}
}

func equalMethodSeq(a, b []random.Method) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// caveScriptedRandom is a minimal IRandom test double that returns pre-scripted values in call
// order. Its `ints` field means NextInt does not panic, so it can drive the
// CaveAddFeature/CaveAddTunnel scenarios that reach the tunnel step's single caller-rnd seed draw
// without needing a real, unpredictable-without-precomputation random.New(seed). It is also what
// forces CaveTunnelThickness1_18's NextIntBound(10)==0 branch, a 1-in-10 real roll that is not
// worth seed-hunting for.
type caveScriptedRandom struct {
	floats    []float64
	floatIdx  int
	intBounds []int
	intIdx    int
	ints      []int32
	intAllIdx int
}

func (s *caveScriptedRandom) NextInt() int32 {
	v := s.ints[s.intAllIdx]
	s.intAllIdx++
	return v
}
func (s *caveScriptedRandom) NextIntBound(bound int) int {
	v := s.intBounds[s.intIdx]
	s.intIdx++
	return v
}
func (s *caveScriptedRandom) NextFloat() float64 {
	v := s.floats[s.floatIdx]
	s.floatIdx++
	return v
}
func (s *caveScriptedRandom) NextDouble() float64           { panic("unused") }
func (s *caveScriptedRandom) NextBoolean() bool             { panic("unused") }
func (s *caveScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (s *caveScriptedRandom) SetSeed(seed uint32)           {}
func (s *caveScriptedRandom) GetSeed() uint32               { return 0 }

var _ random.IRandom = (*caveScriptedRandom)(nil)

// --- CaveFloatRangeValue / CaveAddRoom -------------------------------------------------------
//
// See cave.go's "ROOMS" section for the derivation these tests stand behind.

func TestCaveFloatRangeValue_OneDraw(t *testing.T) {
	inner := random.New(9)
	tr := random.NewTracer(inner)
	got := CaveFloatRangeValue(2, 10, tr)

	if len(tr.Draws) != 1 || tr.Draws[0].Method != random.MethodNextFloat {
		t.Fatalf("expected exactly one NextFloat draw, got %+v", tr.Draws)
	}
	want := float32(2) + float32(tr.Draws[0].Value)*(10-2)
	if got != want {
		t.Fatalf("value = %v, want %v", got, want)
	}
}

// caveAddRoomTestParams is the shared, generous carving parameters this file's own CaveAddRoom
// tests use -- multipliers of 1 (no extra scaling) and a FloorLevel far below anything these
// tests' own derived radii could reach, matching TestCaveEllipsoid_RealCarve_SphereCrossSection's
// own precedent (this bench cannot yet supply a real float-range-drawn FloorLevel -- see cave.go's
// header).
var caveAddRoomTestParams = CaveCarvingParameters{
	HorizontalRadiusMultiplier: 1,
	VerticalRadiusMultiplier:   1,
	FloorLevel:                 -100,
}

// TestCaveAddRoom_CallerRndDrawsExactlyTwo: no matter what roomConfig/config.Legacy is, the
// CALLER's own rnd is drawn from exactly twice (NextFloat, then NextInt) -- every further draw
// happens against the room step's own throwaway local generator, invisible to the caller's own tracer. This
// is the single most important, easy-to-get-backwards fact about the room step -- see cave.go's
// "ROOMS" section.
func TestCaveAddRoom_CallerRndDrawsExactlyTwo(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		v, pal := newCaveEllipsoidTestVolume(t)
		fill := pal.Get("minecraft:cave_air", nil)
		ctx := caveEllipsoidTestCtx(v)
		inner := random.New(123)
		tr := random.NewTracer(inner)

		cfg := CaveConfiguration1_18
		cfg.Legacy = legacy
		roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1}
		carveVolume := NewCaveEllipsoidVolume(fill)

		CaveAddRoom(ctx, cfg, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, tr,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, nil)

		wantSeq := []random.Method{random.MethodNextFloat, random.MethodNextInt}
		if seq := drawSeq(tr); !equalMethodSeq(seq, wantSeq) {
			t.Fatalf("legacy=%v: caller rnd draw sequence = %v, want %v", legacy, seq, wantSeq)
		}
	}
}

// TestCaveAddRoom_YScaleDegenerateRange_SkipsLocalDraw: YScaleMin==YScaleMax must draw nothing
// from the local Random for y_scale (mirrors this codebase's other degenerate-range precedents) --
// exercised indirectly: the caller's own rnd sequence must be UNCHANGED either way (already proven
// by TestCaveAddRoom_CallerRndDrawsExactlyTwo), and this test additionally proves CaveFloatRangeValue
// itself is only ever reached when the range is non-degenerate by checking the OTHER branch draws
// nothing extra from the caller either -- both are exercised via the shared harness above; this
// test instead pins the actual VALUE flowing through when YScaleMin==YScaleMax by checking the
// resulting radius scales exactly as if yScale had been fixed at that shared value (no draw noise).
func TestCaveAddRoom_YScaleDegenerateRange_UsesFixedValue(t *testing.T) {
	build := func() CaveCarveEllipsoidParams {
		v, pal := newCaveEllipsoidTestVolume(t)
		fill := pal.Get("minecraft:cave_air", nil)
		ctx := caveEllipsoidTestCtx(v)
		rnd := random.New(77)
		roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 3, YScaleMax: 3, CachingEnabled: true}
		carveVolume := NewCaveEllipsoidVolume(fill)
		var out []CaveCarveEllipsoidParams
		CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, rnd,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, &out)
		if len(out) != 1 {
			t.Fatalf("expected exactly one appended record, got %d", len(out))
		}
		return out[0]
	}

	rec := build()
	// RadiusY = vertBase*VerticalRadiusMultiplier = (horizBase*yScale)*1, and yScale is fixed at 3
	// (no draw) -- so RadiusY must be EXACTLY 3x RadiusXZ (multiplier=1 on both, horizBase shared).
	want := rec.RadiusXZ * 3
	if math.Abs(float64(rec.RadiusY-want)) > 1e-4 {
		t.Fatalf("RadiusY = %v, want %v (RadiusXZ * fixed yScale 3, no draw)", rec.RadiusY, want)
	}
}

// TestCaveAddRoom_WidthModifierExpression_MatchesEquivalentConstant pins the central claim of
// cave.go's "WIDTH_MODIFIER" section: a width_modifier Molang expression EVALUATES,
// producing the real value it's compiled to, and an expression evaluating to the SAME number as a
// constant carves IDENTICALLY (same RadiusXZ/RadiusY, same draw sequence from both the caller's rnd
// and CaveAddRoom's own local generator -- the expression itself draws nothing, so its position relative
// to those draws, pinned exactly in cave.go's header, cannot perturb them). The comparison against
// a DIFFERENT constant (0) additionally proves the value really flows through CaveAddRoom's own
// arithmetic rather than the call being a no-op that happens to carve the same regardless.
func TestCaveAddRoom_WidthModifierExpression_MatchesEquivalentConstant(t *testing.T) {
	build := func(t *testing.T, wm *MolangExpr) (CaveCarveEllipsoidParams, []random.Method) {
		t.Helper()
		v, pal := newCaveEllipsoidTestVolume(t)
		fill := pal.Get("minecraft:cave_air", nil)
		ctx := caveEllipsoidTestCtx(v)
		inner := random.New(2024)
		tr := random.NewTracer(inner)
		roomCfg := CaveRoomConfig{WidthModifier: wm, YScaleMin: 1, YScaleMax: 1.3, CachingEnabled: true}
		carveVolume := NewCaveEllipsoidVolume(fill)
		var out []CaveCarveEllipsoidParams
		CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, tr,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, &out)
		if len(out) != 1 {
			t.Fatalf("expected exactly one appended record, got %d", len(out))
		}
		return out[0], drawSeq(tr)
	}

	strExpr, err := ParseMolangValue("2 + 3")
	if err != nil {
		t.Fatalf("ParseMolangValue: %v", err)
	}
	if strExpr.isConstant {
		t.Fatal(`expected "2 + 3" to compile to a Molang program, not a constant`)
	}

	zeroRec, zeroSeq := build(t, constMolang(0))
	constRec, constSeq := build(t, constMolang(5))
	exprRec, exprSeq := build(t, strExpr)

	if !equalMethodSeq(zeroSeq, constSeq) || !equalMethodSeq(constSeq, exprSeq) {
		t.Fatalf("draw sequence differs across width_modifier values/forms:\nzero: %v\nconst5: %v\nexpr(2+3): %v",
			zeroSeq, constSeq, exprSeq)
	}
	if constRec != exprRec {
		t.Fatalf("carve output differs between the constant 5 and the equivalent expression \"2 + 3\": const=%+v, expr=%+v",
			constRec, exprRec)
	}
	if constRec == zeroRec {
		t.Fatalf("carve output identical between width_modifier=0 and width_modifier=5 -- the value is not "+
			"flowing through CaveAddRoom's own arithmetic: %+v", constRec)
	}
}

// TestCaveAddTunnel_WidthModifierExpression_MatchesEquivalentConstant is the per-step mirror of
// TestCaveAddRoom_WidthModifierExpression_MatchesEquivalentConstant -- the tunnel step evaluates
// width_modifier EVERY STEP of its own walk (cave.go's "WIDTH_MODIFIER" section),
// a single evaluation. An expression evaluating to the same number as a constant must carve the
// IDENTICAL volume, block for block, and draw IDENTICALLY from CaveAddTunnel's own local generator --
// proving the per-step evaluation never perturbs the walk's own turnA/turnB/branch/continue-walking
// draws. A visibly different constant (0 vs 1) additionally proves the value really reaches the
// per-step radius, not just that the call is inert.
func TestCaveAddTunnel_WidthModifierExpression_MatchesEquivalentConstant(t *testing.T) {
	run := func(t *testing.T, wm *MolangExpr) (*volume.Volume, block.ID, []random.Method) {
		t.Helper()
		v, pal := caveAddFeatureTestVolume(80, 40)
		fill := pal.Get("minecraft:cave_air", nil)
		ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: random.New(1)}
		carveVolume := NewCaveEllipsoidVolume(fill)
		roomCfg := CaveRoomConfig{WidthModifier: wm}
		params := CaveCarvingParameters{HorizontalRadiusMultiplier: 1, VerticalRadiusMultiplier: 1, FloorLevel: -100}

		inner := random.New(99)
		tr := random.NewTracer(inner)
		CaveAddTunnel(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, tr,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 0, Y: 20, Z: 0},
			2.5, 0.3, 0, 0, 60, 1.0, nil, params, carveVolume, nil)
		return v, fill, drawSeq(tr)
	}

	countCarved := func(v *volume.Volume, fill block.ID) int {
		const half = 40
		n := 0
		for x := -half; x < half; x++ {
			for y := 0; y < 40; y++ {
				for z := -half; z < half; z++ {
					if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == fill {
						n++
					}
				}
			}
		}
		return n
	}
	sameShape := func(a *volume.Volume, aFill block.ID, b *volume.Volume, bFill block.ID) bool {
		const half = 40
		for x := -half; x < half; x++ {
			for y := 0; y < 40; y++ {
				for z := -half; z < half; z++ {
					pos := wgen.BlockPos{X: x, Y: y, Z: z}
					if (a.GetBlock(pos) == aFill) != (b.GetBlock(pos) == bFill) {
						return false
					}
				}
			}
		}
		return true
	}

	strExpr, err := ParseMolangValue("0.5 + 0.5")
	if err != nil {
		t.Fatalf("ParseMolangValue: %v", err)
	}
	if strExpr.isConstant {
		t.Fatal(`expected "0.5 + 0.5" to compile to a Molang program, not a constant`)
	}

	zeroVol, zeroFill, zeroSeq := run(t, constMolang(0))
	constVol, constFill, constSeq := run(t, constMolang(1))
	exprVol, exprFill, exprSeq := run(t, strExpr)

	if !equalMethodSeq(zeroSeq, constSeq) || !equalMethodSeq(constSeq, exprSeq) {
		t.Fatalf("draw sequence differs across width_modifier values/forms:\nzero: %v\nconst1: %v\nexpr(0.5+0.5): %v",
			zeroSeq, constSeq, exprSeq)
	}
	if constCarved := countCarved(constVol, constFill); constCarved == 0 {
		t.Fatal("expected the constant=1 case to carve real blocks, carved none")
	}
	if !sameShape(constVol, constFill, exprVol, exprFill) {
		t.Fatal("carve volumes differ between width_modifier=1 (constant) and the equivalent expression " +
			"\"0.5 + 0.5\" -- an expression evaluating to the same number as a constant must carve identically")
	}
	if sameShape(zeroVol, zeroFill, constVol, constFill) {
		t.Fatal("carve volumes identical between width_modifier=0 and width_modifier=1 -- the value is not " +
			"flowing through CaveAddTunnel's own per-step arithmetic")
	}
}

// TestCaveAddTunnel_WidthModifierRandomExpression_DoesNotPerturbCallersRNGSequence pins the central
// RNG-safety claim of cave.go's "WIDTH_MODIFIER" section: a width_modifier expression
// that DOES draw RNG (math.random) must still leave the CALLER's own rnd draw sequence -- the
// stream that stands in for ctx.Random/localRnd here -- byte-identical to a run where
// width_modifier is a non-drawing constant. width_modifier's own math.random draws go to a
// completely separate generator (caveMolangContext, seeded via random.DeriveSeed from
// localRnd.GetSeed() -- a non-drawing read), so they must be invisible to anything tracing the
// caller's own rnd, no matter how many times CaveAddTunnel's per-step loop evaluates the expression.
func TestCaveAddTunnel_WidthModifierRandomExpression_DoesNotPerturbCallersRNGSequence(t *testing.T) {
	drawsFor := func(t *testing.T, wm *MolangExpr) []random.Method {
		t.Helper()
		v, pal := caveAddFeatureTestVolume(80, 40)
		fill := pal.Get("minecraft:cave_air", nil)

		// ctx.Random and the rnd argument passed to CaveAddTunnel are the SAME object here,
		// deliberately -- matching how CaveFeature.Place() actually wires them (`rnd := ctx.Random`,
		// then `rnd` is threaded down through CaveAddFeature/CaveAddRoom/CaveAddTunnel unchanged;
		// see cave.go's own Place() method). Tracing only the explicit `rnd` parameter (and leaving
		// ctx.Random a separate, untraced generator, as several of this file's OLDER helpers such as
		// caveEllipsoidTestCtx do for their own unrelated purposes) would silently fail to catch a
		// regression where width_modifier's own evaluation drew from ctx.Random directly instead of
		// its own derived stand-in -- exactly the mistake this project's "RNG call order is the
		// entire correctness contract" rule exists to rule out.
		inner := random.New(99)
		tr := random.NewTracer(inner)
		ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: tr}
		carveVolume := NewCaveEllipsoidVolume(fill)
		roomCfg := CaveRoomConfig{WidthModifier: wm}
		params := CaveCarvingParameters{HorizontalRadiusMultiplier: 1, VerticalRadiusMultiplier: 1, FloorLevel: -100}

		CaveAddTunnel(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, tr,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 0, Y: 20, Z: 0},
			2.5, 0.3, 0, 0, 60, 1.0, nil, params, carveVolume, nil)
		return drawSeq(tr)
	}

	randomExpr, err := ParseMolangValue("math.random(0, 1)")
	if err != nil {
		t.Fatalf("ParseMolangValue: %v", err)
	}
	if randomExpr.isConstant {
		t.Fatal(`expected "math.random(0, 1)" to compile to a Molang program, not a constant`)
	}

	constSeq := drawsFor(t, constMolang(0))
	randomSeq := drawsFor(t, randomExpr)

	if !equalMethodSeq(constSeq, randomSeq) {
		t.Fatalf("caller's own RNG draw sequence differs when width_modifier draws RNG internally:\n"+
			"constant width_modifier: %v\nmath.random width_modifier: %v", constSeq, randomSeq)
	}
}

// TestCaveMolangContext_WidthModifierRandomSeed_TracksLocalSeed isolates width_modifier's own RNG
// source from every OTHER draw a room or tunnel call makes (turnA/turnB, branch, keep-walking,
// ...) -- unlike the end-to-end carve-shape tests below, which are also true but do not, by
// themselves, prove width_modifier's OWN seed is what changed: a carve can differ between two
// master seeds purely from the walk's other localRnd draws, even if width_modifier's own generator
// were buggily pinned to one fixed seed. This test calls caveMolangContext directly (same package)
// and evaluates a wide-range math.random expression through it: the SAME localSeed must reproduce
// the SAME draw, and two DIFFERENT localSeeds (standing in for two different master seeds, since
// localSeed is itself derived from the master -- see CaveAddRoom/CaveAddTunnel's own
// localRnd.GetSeed()) must produce different draws.
func TestCaveMolangContext_WidthModifierRandomSeed_TracksLocalSeed(t *testing.T) {
	expr, err := ParseMolangValue("math.random(0, 1000000000)")
	if err != nil {
		t.Fatalf("ParseMolangValue: %v", err)
	}

	draw := func(localSeed uint32) float64 {
		ctx := &wgen.PlacementContext{}
		return expr.Evaluate(caveMolangContext(ctx, localSeed))
	}

	a1 := draw(7)
	a2 := draw(7)
	if a1 != a2 {
		t.Fatalf("caveMolangContext(ctx, 7) drew different math.random values across two calls: %v then %v -- "+
			"width_modifier's own RNG source must be a pure function of localSeed", a1, a2)
	}

	b := draw(8)
	if a1 == b {
		t.Fatalf("caveMolangContext(ctx, 7) and caveMolangContext(ctx, 8) drew the SAME math.random value (%v) -- "+
			"expected different localSeed inputs to produce different width_modifier draws", a1)
	}
}

// TestCaveAddTunnel_WidthModifierRandomExpression_MasterSeedDeterminism is this project's own
// single-master-seed determinism policy (see random/derive.go's header and cave.go's
// "WIDTH_MODIFIER" section), pinned end to end through a real math.random-drawing width_modifier:
// two runs seeded from
// the SAME master seed must carve byte-identical volumes, and a run from a DIFFERENT master seed
// must carve a genuinely different one. "Master seed" here is the top-level ctx.Random/rnd this
// call chain is rooted at -- exactly the role session.Config.FeatureSeed plays for a real
// generation run (session.go: `rnd := random.New(config.FeatureSeed)`).
func TestCaveAddTunnel_WidthModifierRandomExpression_MasterSeedDeterminism(t *testing.T) {
	randomExpr, err := ParseMolangValue("math.random(0, 1)")
	if err != nil {
		t.Fatalf("ParseMolangValue: %v", err)
	}

	run := func(masterSeed uint32) *volume.Volume {
		v, pal := caveAddFeatureTestVolume(80, 40)
		fill := pal.Get("minecraft:cave_air", nil)
		rnd := random.New(masterSeed)
		ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: rnd}
		carveVolume := NewCaveEllipsoidVolume(fill)
		roomCfg := CaveRoomConfig{WidthModifier: randomExpr}
		params := CaveCarvingParameters{HorizontalRadiusMultiplier: 1, VerticalRadiusMultiplier: 1, FloorLevel: -100}
		CaveAddTunnel(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, rnd,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 0, Y: 20, Z: 0},
			2.5, 0.3, 0, 0, 60, 1.0, nil, params, carveVolume, nil)
		return v
	}

	sameVolumes := func(a, b *volume.Volume) bool {
		const half = 40
		for x := -half; x < half; x++ {
			for y := 0; y < 40; y++ {
				for z := -half; z < half; z++ {
					pos := wgen.BlockPos{X: x, Y: y, Z: z}
					if a.GetBlock(pos) != b.GetBlock(pos) {
						return false
					}
				}
			}
		}
		return true
	}

	seed7a := run(7)
	seed7b := run(7)
	if !sameVolumes(seed7a, seed7b) {
		t.Fatal("two runs at the SAME master seed (7) produced DIFFERENT carved volumes -- " +
			"width_modifier's math.random draws must be deterministic for a given master seed")
	}

	seed8 := run(8)
	if sameVolumes(seed7a, seed8) {
		t.Fatal("runs at master seeds 7 and 8 produced IDENTICAL carved volumes -- expected changing " +
			"the master seed to change width_modifier's math.random draws (and therefore the carve)")
	}
}

// TestCaveAddRoom_LegacyShiftsCenterXInCacheRecord: the ONLY geometric effect of config.Legacy is
// +1 to the room's own center X -- see cave.go's "ROOMS" section. Distance/half/sizeFactor and
// must all be identical between legacy and non-legacy given the SAME caller seed, since the legacy
// branch runs strictly AFTER those are all already computed (it only burns local-Random draws and
// shifts X).
func TestCaveAddRoom_LegacyShiftsCenterXInCacheRecord(t *testing.T) {
	build := func(legacy bool) CaveCarveEllipsoidParams {
		v, pal := newCaveEllipsoidTestVolume(t)
		fill := pal.Get("minecraft:cave_air", nil)
		ctx := caveEllipsoidTestCtx(v)
		rnd := random.New(55) // SAME seed both times

		cfg := CaveConfiguration1_18
		cfg.Legacy = legacy
		roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1, CachingEnabled: true}
		carveVolume := NewCaveEllipsoidVolume(fill)

		var out []CaveCarveEllipsoidParams
		CaveAddRoom(ctx, cfg, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, rnd,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, &out)

		if len(out) != 1 {
			t.Fatalf("legacy=%v: expected exactly one appended record, got %d", legacy, len(out))
		}
		return out[0]
	}

	nonLegacy := build(false)
	legacy := build(true)

	if legacy.Center.X != nonLegacy.Center.X+1 {
		t.Fatalf("expected legacy center.X to be exactly 1 more than non-legacy (%v), got %v",
			nonLegacy.Center.X, legacy.Center.X)
	}
	if legacy.Center.Y != nonLegacy.Center.Y || legacy.Center.Z != nonLegacy.Center.Z {
		t.Fatalf("expected only X to shift under legacy, got nonLegacy=%+v legacy=%+v", nonLegacy.Center, legacy.Center)
	}
	if legacy.Distance != nonLegacy.Distance || legacy.HalfDistance != nonLegacy.HalfDistance {
		t.Fatalf("expected distance/half identical regardless of legacy, got nonLegacy=%+v legacy=%+v", nonLegacy, legacy)
	}
	if legacy.SizeFactor != nonLegacy.SizeFactor {
		t.Fatalf("expected sizeFactor identical regardless of legacy, got nonLegacy=%v legacy=%v",
			nonLegacy.SizeFactor, legacy.SizeFactor)
	}
	if legacy.RadiusXZ != nonLegacy.RadiusXZ || legacy.RadiusY != nonLegacy.RadiusY {
		t.Fatalf("expected radii identical regardless of legacy (computed before the legacy branch "+
			"runs), got nonLegacy=%+v legacy=%+v", nonLegacy, legacy)
	}
}

// TestCaveAddRoom_CachingDisabled_NoAppend: roomConfig.CachingEnabled=false must never touch out.
func TestCaveAddRoom_CachingDisabled_NoAppend(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	fill := pal.Get("minecraft:cave_air", nil)
	ctx := caveEllipsoidTestCtx(v)
	rnd := random.New(1)
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1, CachingEnabled: false}
	carveVolume := NewCaveEllipsoidVolume(fill)

	var out []CaveCarveEllipsoidParams
	CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, rnd,
		CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, &out)

	if len(out) != 0 {
		t.Fatalf("expected no appended records when CachingEnabled is false, got %+v", out)
	}
}

// TestCaveAddRoom_CachingEnabled_NeverCarvesDirectly is the regression test for cave.go's "THE
// CACHE-VS-CARVE BRANCH IS if/else, NOT BOTH": the cache-append path unconditionally jumps PAST
// the broad-phase-test-and-carve code, never falling through into it. Writing these
// as two independent, always-both statements is the mistake this test guards against, by using a carveVolume
// that panics if ever invoked, so CachingEnabled=true reaching the carve path (the old, wrong
// behaviour) fails loudly instead of silently double-carving.
func TestCaveAddRoom_CachingEnabled_NeverCarvesDirectly(t *testing.T) {
	v, _ := newCaveEllipsoidTestVolume(t)
	ctx := caveEllipsoidTestCtx(v)
	rnd := random.New(1)
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1, CachingEnabled: true}
	carveVolume := panicIfCalledEllipsoidVolume()

	var out []CaveCarveEllipsoidParams
	CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, rnd,
		CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, &out)

	if len(out) != 1 {
		t.Fatalf("expected exactly one appended cache record, got %d", len(out))
	}
}

// TestCaveAddRoom_NilOutWithCachingEnabled_DoesNotPanic: a nil out pointer must be tolerated even
// when CachingEnabled is true (a caller that doesn't care about the cache-replay list).
func TestCaveAddRoom_NilOutWithCachingEnabled_DoesNotPanic(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	fill := pal.Get("minecraft:cave_air", nil)
	ctx := caveEllipsoidTestCtx(v)
	rnd := random.New(1)
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1, CachingEnabled: true}
	carveVolume := NewCaveEllipsoidVolume(fill)

	CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, rnd,
		CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, nil)
}

// TestCaveAddRoom_RealCarve_RoomCrossSection is this project's own carve-verification standard
// applied to the room step: a real room, carved via CaveAddRoom's own RNG-driven size selection (not a
// caller-supplied radius like TestCaveEllipsoid_RealCarve_SphereCrossSection), through the actual
// shipped NewCaveEllipsoidVolume, rendered as ASCII art.
func TestCaveAddRoom_RealCarve_RoomCrossSection(t *testing.T) {
	// A bigger bench than newCaveEllipsoidTestVolume's 16x16 chunk-sized one -- CaveAddRoom's own
	// RNG-driven radius (unlike CaveEllipsoid's own tests, which pick a fixed caller-supplied
	// radius) needs headroom on every side to prove the carve is actually BOUNDED, not just
	// nonzero.
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -16, MinY: 0, MinZ: -16, SizeX: 48, SizeY: 40, SizeZ: 48}
	v := volume.New(bounds, pal, block.AirID)
	for x := -16; x < 32; x++ {
		for y := 0; y < 40; y++ {
			for z := -16; z < 32; z++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	fill := pal.Get("minecraft:cave_air", nil)
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: random.New(1)}

	carveVolume := NewCaveEllipsoidVolume(fill)
	center := CaveVec3{X: 8, Y: 20, Z: 8} // chunk (0,0)'s own mid-chunk center -- matches this file's
	// existing CaveEllipsoid sphere-carve test precedent, avoiding the chunk-local (0..16) X/Z
	// clamp CaveEllipsoid itself applies (see cave.go's header) from clipping the shape.

	// The cache-append and broad-phase-test-and-carve branches are if/else in the real engine
	// (see cave.go) -- a single CaveAddRoom call does EITHER, never both.
	// Run it twice from the SAME seed: once with CachingEnabled to recover the resolved geometry
	// for this test's own logging/radius bound (deterministic -- same seed, same draws), once
	// without to perform the actual carve this test verifies.
	metaRoomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1.5, CachingEnabled: true}
	var out []CaveCarveEllipsoidParams
	CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, metaRoomCfg, random.New(2024),
		CaveChunkPos{X: 0, Z: 0}, center, nil, caveAddRoomTestParams, carveVolume, &out)
	if len(out) != 1 {
		t.Fatalf("expected exactly one appended cache record, got %d", len(out))
	}
	rec := out[0]
	t.Logf("CaveAddRoom real carve -- resolved RadiusXZ=%v RadiusY=%v SizeFactor=%v Distance=%v HalfDistance=%v",
		rec.RadiusXZ, rec.RadiusY, rec.SizeFactor, rec.Distance, rec.HalfDistance)

	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1.5, CachingEnabled: false}
	CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, random.New(2024),
		CaveChunkPos{X: 0, Z: 0}, center, nil, caveAddRoomTestParams, carveVolume, nil)

	radius := int(rec.RadiusXZ) + 1
	if radius < 1 {
		t.Fatalf("expected a positive resolved radius, got RadiusXZ=%v", rec.RadiusXZ)
	}

	var art strings.Builder
	carved := 0
	for dy := radius; dy >= -radius; dy-- {
		for dx := -radius; dx <= radius; dx++ {
			pos := wgen.BlockPos{X: int(center.X) + dx, Y: int(center.Y) + dy, Z: int(center.Z)}
			if v.GetBlock(pos) == fill {
				art.WriteByte('.')
				carved++
			} else {
				art.WriteByte('#')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("cross-section at Z=%d (# stone, . carved cave_air):\n%s", int(center.Z), art.String())

	if got := v.GetBlock(wgen.BlockPos{X: int(center.X), Y: int(center.Y), Z: int(center.Z)}); got != fill {
		t.Fatal("expected the room's own center to be carved air")
	}
	if carved == 0 {
		t.Fatal("expected a nonzero number of carved positions")
	}
	far := wgen.BlockPos{X: int(center.X) + radius + 5, Y: int(center.Y), Z: int(center.Z)}
	if got := v.GetBlock(far); got != stone {
		t.Fatal("expected a position well outside the room's radius to remain untouched stone")
	}
}

// --- CaveAddFeature / CaveAddTunnel -----------------------------------------------------------
//
// See cave.go's "THE CARVE-SHAPE STEP" and "TUNNELS" sections for what these tests stand behind.

// caveAddFeatureTestVolume returns a bigger bench than newCaveEllipsoidTestVolume's 16x16 --
// the carve-shape step's own RNG-driven room/tunnel placement (like the room step's tests) needs real headroom
// on every side.
func caveAddFeatureTestVolume(sizeXZ, sizeY int) (*volume.Volume, *block.Palette) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	half := sizeXZ / 2
	bounds := volume.Bounds{MinX: -half, MinY: 0, MinZ: -half, SizeX: sizeXZ, SizeY: sizeY, SizeZ: sizeXZ}
	v := volume.New(bounds, pal, block.AirID)
	for x := -half; x < sizeXZ-half; x++ {
		for y := 0; y < sizeY; y++ {
			for z := -half; z < sizeXZ-half; z++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	return v, pal
}

func panicIfCalledEllipsoidVolume() CaveEllipsoidVolumeFunc {
	return func(ctx *wgen.PlacementContext, config CaveCarverConfig, rnd random.IRandom, chunk CaveChunkPos, center CaveVec3, bounds CaveBoundingBox, radiusXZ, radiusY float32, params CaveCarvingParameters) bool {
		panic("carveVolume must not be called on this path")
	}
}

// TestCaveAddFeature_SkipCarveChanceGate_StopsAfterFourDraws: a nonzero skip_carve_chance draw
// aborts the WHOLE call (no CaveAddRoom/CaveAddTunnel, no carve) but the four opening draws
// (attemptBound, countBound, count, skip) still happen -- see cave.go's "THE CARVE-SHAPE STEP" section and its
// own draw sequence.
func TestCaveAddFeature_SkipCarveChanceGate_StopsAfterFourDraws(t *testing.T) {
	sc := &caveScriptedRandom{intBounds: []int{5, 2, 1, 1}} // attemptBound=5, countBound=2, count=1, skip=1(!=0)
	tr := random.NewTracer(sc)

	v, pal := caveAddFeatureTestVolume(20, 30)
	_ = pal
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 15, Z: 0}, Random: random.New(1)}
	carveVolume := panicIfCalledEllipsoidVolume()
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1}
	featureCfg := CaveFeatureConfig{SkipCarveChance: 9,
		HorizontalRadiusMultiplierMin: 1, HorizontalRadiusMultiplierMax: 1,
		VerticalRadiusMultiplierMin: 1, VerticalRadiusMultiplierMax: 1,
		FloorLevelMin: -100, FloorLevelMax: -100}

	var out []CaveCarveEllipsoidParams
	CaveAddFeature(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, featureCfg, tr,
		CaveChunkPos{X: 0, Z: 0}, CaveChunkPos{X: 0, Z: 0}, nil, carveVolume, &out)

	wantSeq := []random.Method{random.MethodNextIntBound, random.MethodNextIntBound, random.MethodNextIntBound, random.MethodNextIntBound}
	if seq := drawSeq(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v, want exactly 4 NextIntBound draws, got %v", seq, tr.Draws)
	}
	wantBounds := []int32{40, 6, 3, 9} // 40, attemptBound+1=6, countBound+1=3, SkipCarveChance=9
	for i, want := range wantBounds {
		if tr.Draws[i].Bound != want {
			t.Fatalf("draw %d bound = %d, want %d (full draws: %+v)", i, tr.Draws[i].Bound, want, tr.Draws)
		}
	}
	if len(out) != 0 {
		t.Fatalf("expected no appended records, got %+v", out)
	}
}

// TestCaveAddFeature_DegenerateCount_StopsAfterFourDraws: the mirror image -- skip==0 but count<1
// ALSO aborts the whole call, still after exactly the same four draws.
func TestCaveAddFeature_DegenerateCount_StopsAfterFourDraws(t *testing.T) {
	sc := &caveScriptedRandom{intBounds: []int{0, 0, 0, 0}} // attemptBound=0, countBound=NextIntBound(1)=0, count=NextIntBound(1)=0, skip=0
	tr := random.NewTracer(sc)

	v, pal := caveAddFeatureTestVolume(20, 30)
	_ = pal
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 15, Z: 0}, Random: random.New(1)}
	carveVolume := panicIfCalledEllipsoidVolume()
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1}
	featureCfg := CaveFeatureConfig{SkipCarveChance: 1,
		HorizontalRadiusMultiplierMin: 1, HorizontalRadiusMultiplierMax: 1,
		VerticalRadiusMultiplierMin: 1, VerticalRadiusMultiplierMax: 1,
		FloorLevelMin: -100, FloorLevelMax: -100}

	var out []CaveCarveEllipsoidParams
	CaveAddFeature(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, featureCfg, tr,
		CaveChunkPos{X: 0, Z: 0}, CaveChunkPos{X: 0, Z: 0}, nil, carveVolume, &out)

	if len(tr.Draws) != 4 {
		t.Fatalf("expected exactly 4 draws even on the count<1 exit, got %+v", tr.Draws)
	}
	if len(out) != 0 {
		t.Fatalf("expected no appended records, got %+v", out)
	}
}

// TestCaveAddFeature_OneRound_DrawOrder pins the FULL per-iteration order for one outer round:
// center (Z, then RandomY, then X), then horizontal/vertical/floor_level (in that order, each
// drawing iff non-degenerate), then the roomSkip gate, then (roomSkip!=0 short-circuit, avoiding
// CaveAddRoom's own separately-tested internals here) yaw, pitch, tunnelThickness's own draws,
// distance, and finally CaveAddTunnel's own single caller-rnd seed draw -- the game's order,
// see cave.go.
func TestCaveAddFeature_OneRound_DrawOrder(t *testing.T) {
	sc := &caveScriptedRandom{
		intBounds: []int{
			5, 2, 1, 0, // attemptBound=5,countBound=2,count=1,skip=0 -- ONE round follows
			3,  // zDraw (bound 16)
			10, // RandomY draw (bound = HeightLimit = 1000) -- CaveUniformRandomY1_18
			7,  // xDraw (bound 16)
			1,  // roomSkip (bound 4) != 0 -- the room is skipped, tunnelRepeat NOT drawn
			9,  // tunnelThickness's own NextIntBound(10) draw -- nonzero -> short (3-draw) path
			15, // distance draw (bound 28) -- CaveDistance1_18
		},
		floats: []float64{
			0.4, 0.6, // horizontal_radius_multiplier, vertical_radius_multiplier (non-degenerate)
			0.2,      // floor_level (non-degenerate)
			0.1, 0.9, // yaw draw, pitch draw
			0.3, 0.7, // tunnelThickness's own two unconditional NextFloat draws
		},
		ints: []int32{42}, // CaveAddTunnel's own single seed draw
	}
	tr := random.NewTracer(sc)

	v, pal := caveAddFeatureTestVolume(20, 30)
	_ = pal
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 15, Z: 0}, Random: random.New(1)}
	carveVolume := panicIfCalledEllipsoidVolume() // roomSkip!=0 and CachingEnabled below avoid ever reaching this
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1, CachingEnabled: true}
	featureCfg := CaveFeatureConfig{SkipCarveChance: 6,
		HorizontalRadiusMultiplierMin: 1, HorizontalRadiusMultiplierMax: 3,
		VerticalRadiusMultiplierMin: 1, VerticalRadiusMultiplierMax: 3,
		FloorLevelMin: -100, FloorLevelMax: -50}

	var out []CaveCarveEllipsoidParams
	CaveAddFeature(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, featureCfg, tr,
		CaveChunkPos{X: 0, Z: 0}, CaveChunkPos{X: 2, Z: -1}, nil, carveVolume, &out)

	wantSeq := []random.Method{
		random.MethodNextIntBound, random.MethodNextIntBound, random.MethodNextIntBound, random.MethodNextIntBound, // opening 4
		random.MethodNextIntBound,                                              // zDraw
		random.MethodNextIntBound,                                              // RandomY
		random.MethodNextIntBound,                                              // xDraw
		random.MethodNextFloat, random.MethodNextFloat, random.MethodNextFloat, // horiz, vert, floor
		random.MethodNextIntBound,                      // roomSkip
		random.MethodNextFloat, random.MethodNextFloat, // yaw, pitch
		random.MethodNextFloat, random.MethodNextFloat, random.MethodNextIntBound, // tunnelThickness's own 3
		random.MethodNextIntBound, // distance
		random.MethodNextInt,      // CaveAddTunnel's own seed draw
	}
	if seq := drawSeq(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence mismatch.\ngot:  %v\nwant: %v\nfull draws: %+v", seq, wantSeq, tr.Draws)
	}
	// Confirm the two center draws and RandomY's own bound without re-deriving CaveAddFeature's
	// own internals a second time here.
	if tr.Draws[4].Bound != 16 || tr.Draws[6].Bound != 16 {
		t.Fatalf("expected the two center draws to both be NextIntBound(16), got %+v / %+v", tr.Draws[4], tr.Draws[6])
	}
	if tr.Draws[5].Bound != 1000 {
		t.Fatalf("expected RandomY's own draw to use HeightLimit=1000 as its bound, got %+v", tr.Draws[5])
	}
}

// TestCaveAddTunnel_CallerRndDrawsExactlyOne: no matter how long or short the resulting walk is,
// the CALLER's own rnd is read exactly once (a plain NextInt, no bound) to seed CaveAddTunnel's own
// throwaway local Random -- every further draw happens against that local generator, invisible to
// the caller's own tracer. Mirrors CaveAddRoom's two-draw caller contract, but with a
// genuinely different draw count and shape -- see cave.go's "TUNNELS" section.
func TestCaveAddTunnel_CallerRndDrawsExactlyOne(t *testing.T) {
	v, pal := caveAddFeatureTestVolume(60, 40)
	fill := pal.Get("minecraft:cave_air", nil)
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: random.New(1)}
	carveVolume := NewCaveEllipsoidVolume(fill)
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0)}

	inner := random.New(123)
	tr := random.NewTracer(inner)

	CaveAddTunnel(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, tr,
		CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 0, Y: 20, Z: 0},
		2.5, 0, 0, 0, 40, 1.0, nil, caveAddRoomTestParams, carveVolume, nil)

	if len(tr.Draws) != 1 {
		t.Fatalf("expected exactly one draw from the caller's rnd, got %+v", tr.Draws)
	}
	if tr.Draws[0].Method != random.MethodNextInt {
		t.Fatalf("expected the one draw to be a plain NextInt (no bound), got %+v", tr.Draws[0])
	}
}

// TestCaveAddTunnel_NonPositiveDistance_Rerolls: distance<=0 triggers an internal reroll
// (112-NextIntBound(28), hardcoded regardless of config.Legacy -- see cave.go, "A
// LEGACY-BLIND REROLL") rather than leaving distance non-positive (which would make the very next
// check, distance<=startStep, true and carve NOTHING). Proven behaviorally: passing distance=0
// must still carve real blocks.
func TestCaveAddTunnel_NonPositiveDistance_Rerolls(t *testing.T) {
	v, pal := caveAddFeatureTestVolume(80, 40)
	fill := pal.Get("minecraft:cave_air", nil)
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: random.New(1)}
	carveVolume := NewCaveEllipsoidVolume(fill)
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0)}

	CaveAddTunnel(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, random.New(7),
		CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 0, Y: 20, Z: 0},
		2.5, 0, 0, 0 /* distance */, 0, 1.0, nil, caveAddRoomTestParams, carveVolume, nil)

	carved := 0
	for x := -40; x < 40; x++ {
		for y := 0; y < 40; y++ {
			for z := -40; z < 40; z++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == fill {
					carved++
				}
			}
		}
	}
	if carved == 0 {
		t.Fatal("expected distance=0 to reroll to a positive value and carve real blocks, carved none")
	}
}

// TestCaveAddTunnel_RealCarve_TunnelCrossSection is this project's own carve-verification
// standard applied to the tunnel step: a real tunnel, walked and carved via CaveAddTunnel's own RNG-driven
// direction/thickness, through the actual shipped NewCaveEllipsoidVolume, rendered as ASCII art --
// a horizontal (X/Z) slice through the tunnel's own starting Y, which should read as a winding
// corridor rather than a single blob.
func TestCaveAddTunnel_RealCarve_TunnelCrossSection(t *testing.T) {
	v, pal := caveAddFeatureTestVolume(80, 40)
	fill := pal.Get("minecraft:cave_air", nil)
	stone := pal.Get("minecraft:stone", nil)
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: random.New(1)}
	carveVolume := NewCaveEllipsoidVolume(fill)
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0)}
	params := CaveCarvingParameters{HorizontalRadiusMultiplier: 1, VerticalRadiusMultiplier: 1, FloorLevel: -100}

	CaveAddTunnel(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, random.New(99),
		CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 0, Y: 20, Z: 0},
		2.5, 0.3, 0, 0, 60, 1.0, nil, params, carveVolume, nil)

	const half = 38
	var art strings.Builder
	carved := 0
	for z := -half; z <= half; z++ {
		for x := -half; x <= half; x++ {
			pos := wgen.BlockPos{X: x, Y: 20, Z: z}
			if v.GetBlock(pos) == fill {
				art.WriteByte('.')
				carved++
			} else {
				art.WriteByte('#')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("CaveAddTunnel real carve -- horizontal cross-section at Y=20 (# stone, . carved cave_air):\n%s", art.String())

	if carved == 0 {
		t.Fatal("expected a nonzero number of carved positions")
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 20, Z: 0}); got != fill {
		t.Fatal("expected the tunnel's own starting position to be carved air")
	}
	// caveAddFeatureTestVolume(80,40) spans X/Z in [-40,39] -- pick a corner well within those
	// bounds but on the OPPOSITE side from the tunnel's own starting yaw/pitch drift direction.
	far := wgen.BlockPos{X: -35, Y: 20, Z: -35}
	if got := v.GetBlock(far); got != stone {
		t.Fatal("expected a position well outside the tunnel's own reach to remain untouched stone")
	}
}

// TestCaveAddFeature_RealCarve_RoomsAndTunnels is this project's own carve-verification standard
// applied to the full carve-shape pipeline: real RNG-driven room placements AND branching tunnel
// walks, through the actual shipped CaveAddFeature/CaveAddRoom/CaveAddTunnel/NewCaveEllipsoidVolume
// chain, rendered as ASCII art -- the shape this whole phase makes possible, not a stand-in.
func TestCaveAddFeature_RealCarve_RoomsAndTunnels(t *testing.T) {
	v, pal := caveAddFeatureTestVolume(100, 40)
	fill := pal.Get("minecraft:cave_air", nil)
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 20, Z: 0}, Random: random.New(1)}
	carveVolume := NewCaveEllipsoidVolume(fill)
	roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1.3}
	featureCfg := CaveFeatureConfig{
		SkipCarveChance:               1, // NextIntBound(1) always 0 -- never skip the whole call
		HorizontalRadiusMultiplierMin: 1,
		HorizontalRadiusMultiplierMax: 1.4,
		VerticalRadiusMultiplierMin:   1,
		VerticalRadiusMultiplierMax:   1.2,
		FloorLevelMin:                 -100,
		FloorLevelMax:                 -80,
	}

	var out []CaveCarveEllipsoidParams
	rnd := random.New(2024)
	// HeightLimit must be realistic relative to THIS bench's own volume height (40) -- a real
	// caller would set this from the world's actual build height, not an arbitrary placeholder;
	// CaveUniformRandomY1_18's own draw (NextIntBound(HeightLimit)+8) is otherwise free to land
	// far above this test volume's own Y extent, carving nothing anywhere this slice can see.
	CaveAddFeature(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 30}, roomCfg, featureCfg, rnd,
		CaveChunkPos{X: 0, Z: 0}, CaveChunkPos{X: 0, Z: 0}, nil, carveVolume, &out)

	const half = 48
	var art strings.Builder
	carved := 0
	for z := -half; z <= half; z++ {
		for x := -half; x <= half; x++ {
			pos := wgen.BlockPos{X: x, Y: 20, Z: z}
			if v.GetBlock(pos) == fill {
				art.WriteByte('.')
				carved++
			} else {
				art.WriteByte('#')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("CaveAddFeature real carve -- horizontal cross-section at Y=20 (# stone, . carved cave_air), %d cells carved:\n%s", carved, art.String())

	if carved == 0 {
		t.Fatal("expected CaveAddFeature to carve a nonzero number of positions with a real seed")
	}
}

// --- CaveFeature.Place / minecraft:cave_carver_feature registration ---------------------------
//
// See cave.go's "PLACEMENT, AND THE CACHE THIS PORT DOES NOT MODEL" section for the derivation,
// the uncached-architecture decision, and the seed mix these tests stand behind.

func caveDemoFeatureBody() map[string]any {
	return map[string]any{
		"description":                  map[string]any{"identifier": "example:cave_demo"},
		"fill_with":                    "minecraft:cave_air",
		"width_modifier":               0.0,
		"height_limit":                 128.0,
		"skip_carve_chance":            0.0,
		"y_scale":                      map[string]any{"range_min": 1.0, "range_max": 1.0},
		"horizontal_radius_multiplier": map[string]any{"range_min": 1.0, "range_max": 1.0},
		"vertical_radius_multiplier":   map[string]any{"range_min": 0.7, "range_max": 1.4},
		"floor_level":                  map[string]any{"range_min": -1.0, "range_max": -0.7},
	}
}

func caveDemoBuildContext(pal *block.Palette) *BuildContext {
	return &BuildContext{Palette: pal, Identifier: "example:cave_demo", FileID: "cave_demo.json", Warn: func(string) {}}
}

func TestBuildCaveFeature_ValidBody_Succeeds(t *testing.T) {
	pal := block.NewPalette()
	f, err := buildCaveFeature(caveDemoFeatureBody(), caveDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.TypeID() != "minecraft:cave_carver_feature" {
		t.Fatalf("TypeID() = %q, want minecraft:cave_carver_feature", f.TypeID())
	}
	if f.Identifier() != "example:cave_demo" {
		t.Fatalf("Identifier() = %q, want example:cave_demo", f.Identifier())
	}
}

// TestBuildCaveFeature_OmittedFieldsUseGameDefaults: all eight JSON fields are optional both
// in the game's schema AND in this port, each with the game's own default. Dropping any one must
// SUCCEED and produce exactly that default, not refuse.
func TestBuildCaveFeature_OmittedFieldsUseGameDefaults(t *testing.T) {
	build := func(t *testing.T, drop string) *CaveFeature {
		t.Helper()
		body := caveDemoFeatureBody()
		delete(body, drop)
		pal := block.NewPalette()
		f, err := buildCaveFeature(body, caveDemoBuildContext(pal))
		if err != nil {
			t.Fatalf("%q missing: unexpected error: %v", drop, err)
		}
		cf, ok := f.(*CaveFeature)
		if !ok {
			t.Fatalf("buildCaveFeature returned %T, want *CaveFeature", f)
		}
		return cf
	}

	t.Run("fill_with", func(t *testing.T) {
		cf := build(t, "fill_with")
		if cf.fillWith != CaveNoFill {
			t.Fatalf("fillWith = %v, want CaveNoFill (%v)", cf.fillWith, CaveNoFill)
		}
	})
	t.Run("width_modifier", func(t *testing.T) {
		cf := build(t, "width_modifier")
		if !cf.roomCfg.WidthModifier.isConstant || cf.roomCfg.WidthModifier.constant != 0 {
			t.Fatalf("WidthModifier = %+v, want the constant 0", cf.roomCfg.WidthModifier)
		}
	})
	t.Run("skip_carve_chance", func(t *testing.T) {
		cf := build(t, "skip_carve_chance")
		if cf.featureCfg.SkipCarveChance != 0 {
			t.Fatalf("SkipCarveChance = %v, want 0", cf.featureCfg.SkipCarveChance)
		}
	})
	t.Run("height_limit", func(t *testing.T) {
		cf := build(t, "height_limit")
		if cf.ellipsoidCfg.HeightLimit != 0 {
			t.Fatalf("HeightLimit = %v, want 0", cf.ellipsoidCfg.HeightLimit)
		}
	})
	t.Run("y_scale", func(t *testing.T) {
		cf := build(t, "y_scale")
		if cf.roomCfg.YScaleMin != 0 || cf.roomCfg.YScaleMax != 0 {
			t.Fatalf("YScale = {%v,%v}, want {0,0}", cf.roomCfg.YScaleMin, cf.roomCfg.YScaleMax)
		}
	})
	t.Run("horizontal_radius_multiplier", func(t *testing.T) {
		cf := build(t, "horizontal_radius_multiplier")
		if cf.featureCfg.HorizontalRadiusMultiplierMin != 0 || cf.featureCfg.HorizontalRadiusMultiplierMax != 0 {
			t.Fatalf("HorizontalRadiusMultiplier = {%v,%v}, want {0,0}",
				cf.featureCfg.HorizontalRadiusMultiplierMin, cf.featureCfg.HorizontalRadiusMultiplierMax)
		}
	})
	t.Run("vertical_radius_multiplier", func(t *testing.T) {
		cf := build(t, "vertical_radius_multiplier")
		if cf.featureCfg.VerticalRadiusMultiplierMin != 0 || cf.featureCfg.VerticalRadiusMultiplierMax != 0 {
			t.Fatalf("VerticalRadiusMultiplier = {%v,%v}, want {0,0}",
				cf.featureCfg.VerticalRadiusMultiplierMin, cf.featureCfg.VerticalRadiusMultiplierMax)
		}
	})
	t.Run("floor_level", func(t *testing.T) {
		cf := build(t, "floor_level")
		if cf.featureCfg.FloorLevelMin != 0 || cf.featureCfg.FloorLevelMax != 0 {
			t.Fatalf("FloorLevel = {%v,%v}, want {0,0}", cf.featureCfg.FloorLevelMin, cf.featureCfg.FloorLevelMax)
		}
	})
}

// TestBuildCaveFeature_AllFieldsOmitted_StillBuilds: the extreme case -- an empty body (only
// "description") must still build successfully, with every one of the eight fields at its
// default simultaneously (not just one at a time).
func TestBuildCaveFeature_AllFieldsOmitted_StillBuilds(t *testing.T) {
	pal := block.NewPalette()
	body := map[string]any{"description": map[string]any{"identifier": "example:cave_empty"}}
	f, err := buildCaveFeature(body, caveDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("unexpected error with every field omitted: %v", err)
	}
	cf := f.(*CaveFeature)
	if cf.fillWith != CaveNoFill {
		t.Errorf("fillWith = %v, want CaveNoFill", cf.fillWith)
	}
	if !cf.roomCfg.WidthModifier.isConstant || cf.roomCfg.WidthModifier.constant != 0 {
		t.Errorf("WidthModifier = %+v, want the constant 0", cf.roomCfg.WidthModifier)
	}
	if cf.featureCfg.SkipCarveChance != 0 {
		t.Errorf("SkipCarveChance = %v, want 0", cf.featureCfg.SkipCarveChance)
	}
	if cf.ellipsoidCfg.HeightLimit != 0 {
		t.Errorf("HeightLimit = %v, want 0", cf.ellipsoidCfg.HeightLimit)
	}
}

// TestCaveCarveBlock_NoFill_SkipsWriteButDoesEverythingElse pins CaveNoFill's own
// semantics directly against CaveCarveBlock, independent of buildCaveFeature: an omitted fill_with
// must still run the carveable-block gate, thin-sand capping and grass-onto-dirt relocation, but never
// overwrite the carve position itself -- exactly the real engine's own null-checked fill block
// (see CaveNoFill).
func TestCaveCarveBlock_NoFill_SkipsWriteButDoesEverythingElse(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	pos := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	stone := pal.Get("minecraft:stone", nil)

	ctx := caveCarveCtx(v)
	ok := CaveCarveBlock(ctx, CaveConfiguration1_18, CaveNoFill, pos, false)
	if !ok {
		t.Fatal("expected CaveCarveBlock to still succeed (the carveable-block test passed) with CaveNoFill")
	}
	if got := v.GetBlock(pos); got != stone {
		t.Fatalf("expected pos left untouched (no fill configured), got %v", pal.Entry(got))
	}
}

// TestBuildCaveFeature_WidthModifierAcceptsNonRandomExpression: every expression string that
// cannot draw RNG (pure arithmetic, non-drawing math.* functions, query.*/variable.* lookups) must
// be ACCEPTED and compiled, not refused. See cave.go's "WIDTH_MODIFIER" section.
func TestBuildCaveFeature_WidthModifierAcceptsNonRandomExpression(t *testing.T) {
	for _, expr := range []string{
		"2.5",
		"1 + 1.5",
		"math.sin(0) + 2",
		"query.has_biome_tag('nonexistent')",
		"query.distance_from_camera", // an unresolved query -- legal Molang, resolves to 0, still not refused
	} {
		body := caveDemoFeatureBody()
		body["width_modifier"] = expr
		pal := block.NewPalette()
		f, err := buildCaveFeature(body, caveDemoBuildContext(pal))
		if err != nil {
			t.Fatalf("%q: unexpected error: %v", expr, err)
		}
		cf, ok := f.(*CaveFeature)
		if !ok {
			t.Fatalf("%q: buildCaveFeature returned %T, want *CaveFeature", expr, f)
		}
		if cf.roomCfg.WidthModifier.isConstant {
			t.Fatalf("%q: expected a compiled Molang program (isConstant=false), got a constant", expr)
		}
	}
}

// TestBuildCaveFeature_WidthModifierRandomExpression_AcceptsAndWarns: cave.go's "WIDTH_MODIFIER"
// section reverses an earlier build-time refusal for an expression whose AST can reach
// math.random/math.random_integer/math.die_roll/math.die_roll_integer, whether at top level or
// buried inside a larger expression -- determinism from this port's own master seed wins over
// imitating the engine's own process-global, unseeded source for those four functions. The
// expression must build successfully, compile to a real (non-constant) Molang program, AND fire
// exactly one ctx.Warn call disclosing that this port's value is a deterministic stand-in that
// will not match the game -- narrower than a refusal, but still an honest, non-silent disclosure
// of the same underlying engine gap.
func TestBuildCaveFeature_WidthModifierRandomExpression_AcceptsAndWarns(t *testing.T) {
	for _, expr := range []string{
		"math.random(0, 1)",
		"math.random_integer(0, 4)",
		"math.die_roll(1, 0, 1)",
		"math.die_roll_integer(1, 0, 4)",
		"1 + math.random(-2, 2)",
		"MATH.RANDOM(0, 1)", // Molang identifiers are case-insensitive -- must still be caught
	} {
		body := caveDemoFeatureBody()
		body["width_modifier"] = expr
		pal := block.NewPalette()
		var warnings []string
		ctx := caveDemoBuildContext(pal)
		ctx.Warn = func(message string) { warnings = append(warnings, message) }
		f, err := buildCaveFeature(body, ctx)
		if err != nil {
			t.Fatalf("%q: unexpected error: %v", expr, err)
		}
		cf, ok := f.(*CaveFeature)
		if !ok {
			t.Fatalf("%q: buildCaveFeature returned %T, want *CaveFeature", expr, f)
		}
		if cf.roomCfg.WidthModifier.isConstant {
			t.Fatalf("%q: expected a compiled Molang program (isConstant=false), got a constant", expr)
		}
		// The shared demo body also writes an explicit skip_carve_chance: 0, which earns its own
		// warning; this test is about width_modifier's, so pick that one out by name rather than
		// counting. Counting here is what made this test fail when the second warning was added.
		var widthWarnings []string
		for _, w := range warnings {
			if strings.HasPrefix(w, "width_modifier:") {
				widthWarnings = append(widthWarnings, w)
			}
		}
		if len(widthWarnings) != 1 {
			t.Fatalf("%q: expected exactly one width_modifier build warning, got %d (all warnings: %v)",
				expr, len(widthWarnings), warnings)
		}
		// Asserts the two things an AUTHOR has to get out of this warning, not the wording:
		// that the game's own value for this field is not reproducible, and that this tool
		// substitutes a seed-derived one. Deliberately phrased in the user's terms, not in terms
		// of the game's internals, which a pack author cannot look up.
		for _, want := range []string{"do not draw from the world seed", "derived from your master seed"} {
			if !strings.Contains(widthWarnings[0], want) {
				t.Fatalf("%q: warning does not tell the author %q: %q", expr, want, widthWarnings[0])
			}
		}
	}
}

// TestBuildCaveFeature_FloatRangeShapes pins the three shapes a float-range field accepts, and the
// one that looks like a fourth and is not.
//
// The game accepts three shapes. An OBJECT is read only for `range_min` and `range_max`; an ARRAY
// must have exactly 2 elements; anything else, a bare number included, is accepted as a single
// value.
//
// The case worth having a test for is `{min, max}`. The engine does NOT reject it -- it logs
// `Missing member(s): "range_min", "range_max" ... defaulting to min/max of 0.` and proceeds with a
// DEGENERATE {0,0} range, which for a carver means every multiplier collapses to zero and it
// silently digs nothing. This port used to accept min/max and quietly treat it as the range the
// author meant, so a body that does nothing in-game looked fine here. It is refused now, which is
// the whole point of the tool: report what the game will actually do.
func TestBuildCaveFeature_FloatRangeShapes(t *testing.T) {
	accepted := []any{
		2.5,             // bare number, min == max
		[]any{1.0, 3.0}, // 2-element array
		map[string]any{"range_min": 1.0, "range_max": 3.0}, // the object form
	}
	for _, shape := range accepted {
		body := caveDemoFeatureBody()
		body["y_scale"] = shape
		pal := block.NewPalette()
		if _, err := buildCaveFeature(body, caveDemoBuildContext(pal)); err != nil {
			t.Fatalf("y_scale=%#v: unexpected error: %v", shape, err)
		}
	}

	refused := map[string]any{
		"min/max object -- the engine ignores these keys and zero-widths the range": map[string]any{"min": 1.0, "max": 3.0},
		"array of the wrong size": []any{1.0, 2.0, 3.0},
	}
	for what, shape := range refused {
		body := caveDemoFeatureBody()
		body["y_scale"] = shape
		pal := block.NewPalette()
		if _, err := buildCaveFeature(body, caveDemoBuildContext(pal)); err == nil {
			t.Fatalf("y_scale=%#v (%s): expected an error, got none", shape, what)
		}
	}
}

// caveSetSeedRecorder wraps a real *random.Rand, forwarding every IRandom method to it (so actual
// draws/carving behave normally) while additionally recording every SetSeed call's argument, in
// order -- the only way to observe place()'s own per-neighbour reseed sequence from outside, since
// SetSeed itself produces no drawn value random.Tracer would capture.
type caveSetSeedRecorder struct {
	*random.Rand
	SetSeeds []uint32
}

func (r *caveSetSeedRecorder) SetSeed(seed uint32) {
	r.SetSeeds = append(r.SetSeeds, seed)
	r.Rand.SetSeed(seed)
}

// TestCaveFeaturePlace_ReseedSequence_MatchesFormula pins place()'s own full per-neighbour reseed
// sequence: 289 SetSeed calls (17x17, RANGE=8), in ascending (ncx,ncz) order (ncx outer, ncz inner),
// each value exactly `(ncx*a + ncz*b) ^ baseSeed` where a/b are the two opening
// carverOddMaker(NextInt()) draws. The game adjusts each draw toward zero before setting the
// low bit. baseSeed is the seed the generator held before Place touched it -- see
// cave.go's "THE SEED MIX" for the operand pairing and CaveFeature.Place for the odd-maker.
//
// carverOddMaker and a plain `|1` agree on every value NextInt can actually return (a 31-bit
// non-negative draw), so this test cannot distinguish the two through Place on real draws; the
// odd-maker's negative branch is pinned separately by TestCarverOddMaker_NegativeAdjustForm
// below.
func TestCaveFeaturePlace_ReseedSequence_MatchesFormula(t *testing.T) {
	pal := block.NewPalette()
	f, err := buildCaveFeature(caveDemoFeatureBody(), caveDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	for _, baseSeed := range []uint32{999, 7, 12345} {
		rec := &caveSetSeedRecorder{Rand: random.New(baseSeed)}

		v, _ := newCaveEllipsoidTestVolume(t) // small solid-stone bench, enough for a 289-iteration place() call
		ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 8, Y: 10, Z: 8}, Random: rec}

		// Independently re-derive a and b: place() draws them as the FIRST two NextInt() calls,
		// before any SetSeed -- reconstruct via a completely separate *random.Rand seeded
		// identically, rather than reading them back off rec (which would make this test
		// tautological).
		shadow := random.New(baseSeed)
		a := carverOddMaker(shadow.NextInt())
		b := carverOddMaker(shadow.NextInt())

		origin := f.Place(ctx)
		if origin == nil {
			t.Fatal("expected a non-nil origin")
		}

		chunkX, chunkZ := ctx.Origin.X>>4, ctx.Origin.Z>>4
		var want []uint32
		for ncx := chunkX - 8; ncx <= chunkX+8; ncx++ {
			for ncz := chunkZ - 8; ncz <= chunkZ+8; ncz++ {
				seed := uint32(int32(ncx))*a + uint32(int32(ncz))*b
				seed ^= baseSeed
				want = append(want, seed)
			}
		}

		if len(rec.SetSeeds) != 289 {
			t.Fatalf("baseSeed=%d: got %d SetSeed calls, want 289 (17x17 RANGE=8 neighbourhood)", baseSeed, len(rec.SetSeeds))
		}
		for i := range want {
			if rec.SetSeeds[i] != want[i] {
				t.Fatalf("baseSeed=%d: SetSeed call %d = %d, want %d (a=%d b=%d)", baseSeed, i, rec.SetSeeds[i], want[i], a, b)
			}
		}
	}
}

// TestCarverOddMaker_NegativeAdjustForm pins the odd-maker's exact arithmetic, including the
// toward-zero branch the engine carries for negative inputs. Real draws can never reach that
// branch, since the engine's unbounded integer draw is 31-bit non-negative, so this is a direct
// unit pin on the helper rather than an end-to-end one.
func TestCarverOddMaker_NegativeAdjustForm(t *testing.T) {
	cases := []struct {
		in   int32
		want uint32
	}{
		{0, 1}, {1, 1}, {2, 3}, {5, 5}, {6, 7},
		{-1, 1},                  // -1 -> adjust -> 0 -> |1 -> 1 (a bare |1 would give all ones)
		{-2, 0xFFFFFFFF},         // -2 -> -1 -> |1 -> -1
		{-3, 0xFFFFFFFF},         // -3 -> adjust -> -2 -> |1 -> -1 (a bare |1 would give -3)
		{-4, 0xFFFFFFFD},         // -4 -> -3 -> |1 -> -3
		{2147483647, 2147483647}, // the unbounded integer draw's actual maximum
	}
	for _, c := range cases {
		if got := carverOddMaker(c.in); got != c.want {
			t.Fatalf("carverOddMaker(%d) = %#x, want %#x", c.in, got, c.want)
		}
	}
}

// TestCaveFeaturePlace_AlwaysReturnsOrigin: the real place() has no failure path at all (see
// cave.go's header) -- even when nothing is diggable anywhere near the origin (an all-air bench,
// so CaveIsDiggable1_18 never matches), Place() must still return a non-nil pointer equal to
// ctx.Origin, never nil.
func TestCaveFeaturePlace_AlwaysReturnsOrigin(t *testing.T) {
	pal := block.NewPalette()
	f, err := buildCaveFeature(caveDemoFeatureBody(), caveDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	bounds := volume.Bounds{MinX: -16, MinY: 0, MinZ: -16, SizeX: 32, SizeY: 32, SizeZ: 32}
	v := volume.New(bounds, pal, block.AirID) // all-air: nothing is ever diggable
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 16, Z: 0}, Random: random.New(7)}

	got := f.Place(ctx)
	if got == nil {
		t.Fatal("expected a non-nil origin even when nothing could be carved")
	}
	if *got != ctx.Origin {
		t.Fatalf("returned origin = %+v, want %+v", *got, ctx.Origin)
	}
}

// TestCaveFeaturePlace_RealCarve_CaveSystem is this project's own carve-verification standard
// applied to the fully-registered minecraft:cave_carver_feature: a real cave system, carved
// end-to-end through CaveFeature.Place() (the SAME code path `featurelab generate` drives), in a
// solid-stone environment, rendered as ASCII art. It is the Go-level counterpart of the CLI
// demonstration (`featurelab generate --env underground_stone`).
func TestCaveFeaturePlace_RealCarve_CaveSystem(t *testing.T) {
	pal := block.NewPalette()
	f, err := buildCaveFeature(caveDemoFeatureBody(), caveDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	stone := pal.Get("minecraft:stone", nil)
	fill := pal.Get("minecraft:cave_air", nil)

	const half = 24
	bounds := volume.Bounds{MinX: -half, MinY: 8, MinZ: -half, SizeX: 2 * half, SizeY: 40, SizeZ: 2 * half}
	v := volume.New(bounds, pal, block.AirID)
	for x := -half; x < half; x++ {
		for y := 8; y < 48; y++ {
			for z := -half; z < half; z++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	ctx := &wgen.PlacementContext{API: v, Origin: wgen.BlockPos{X: 0, Y: 28, Z: 0}, Random: random.New(12345)}

	got := f.Place(ctx)
	if got == nil {
		t.Fatal("expected a non-nil origin")
	}

	var art strings.Builder
	carved := 0
	for z := -half; z < half; z++ {
		for x := -half; x < half; x++ {
			pos := wgen.BlockPos{X: x, Y: 28, Z: z}
			if v.GetBlock(pos) == fill {
				art.WriteByte('.')
				carved++
			} else {
				art.WriteByte('#')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("CaveFeature.Place() real carve -- horizontal cross-section at Y=28 (# stone, . carved cave_air), %d cells carved:\n%s", carved, art.String())

	if carved == 0 {
		t.Fatal("expected a nonzero number of carved positions from a real, fully-registered Place() call")
	}
}

// --- The carve row, the thin-sand test row, and the angle constant -----------------------------

// TestNewCaveEllipsoidVolume_CarveRowIsTestRowPlusOne pins that the carver
// writes ONE ROW ABOVE the row the ellipsoid/floor-level test evaluates -- carved rows span
// [MinY+1 .. MaxY], the "exclusive" MaxY bound included and MinY itself never touched. A
// single-candidate bounding box (one test row, testY) must therefore carve exactly (0, testY+1, 0)
// and leave (0, testY, 0) as stone.
func TestNewCaveEllipsoidVolume_CarveRowIsTestRowPlusOne(t *testing.T) {
	v, pal := newCaveEllipsoidTestVolume(t)
	fill := pal.Get("minecraft:cave_air", nil)
	stone := pal.Get("minecraft:stone", nil)
	ctx := caveEllipsoidTestCtx(v)

	const testY = 20
	chunk := CaveChunkPos{X: 0, Z: 0}
	center := CaveVec3{X: 0.5, Y: testY + 0.5, Z: 0.5}
	bounds := CaveBoundingBox{MinX: 0, MaxX: 1, MinY: testY, MaxY: testY + 1, MinZ: 0, MaxZ: 1}
	params := CaveCarvingParameters{FloorLevel: -10}

	carveVolume := NewCaveEllipsoidVolume(fill)
	carveVolume(ctx, CaveConfiguration1_18, ctx.Random, chunk, center, bounds, 1, 1, params)

	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: testY + 1, Z: 0}); got != fill {
		t.Fatalf("expected the carve at test row+1 (Y=%d), got %v", testY+1, pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: testY, Z: 0}); got != stone {
		t.Fatalf("expected the test row itself (Y=%d) untouched, got %v", testY, pal.Entry(got))
	}
}

// TestCaveAddRoom_AngleUsesFullPrecisionPi pins the room step's taper angle:
// sin(f32(half) * pi_f32 / f32(distance)) with the FULL-PRECISION float32 pi, not a truncated
// 3.1416 literal. The cached ellipsoid-parameter record exposes both the drawn distance/half AND
// the resulting RadiusXZ, so the test recomputes
// the radius bit-exactly from the record's own inputs -- and requires at least one seed where the
// pi and 3.1416 variants actually produce different float32 bits, so a regression cannot pass on
// seeds where they agree.
func TestCaveAddRoom_AngleUsesFullPrecisionPi(t *testing.T) {
	discriminating := false
	for _, seed := range []uint32{7, 11, 42, 77, 123, 500} {
		v, pal := newCaveEllipsoidTestVolume(t)
		fill := pal.Get("minecraft:cave_air", nil)
		ctx := caveEllipsoidTestCtx(v)
		rnd := random.New(seed)
		roomCfg := CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 1, YScaleMax: 1, CachingEnabled: true}
		carveVolume := NewCaveEllipsoidVolume(fill)
		var out []CaveCarveEllipsoidParams
		CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000}, roomCfg, rnd,
			CaveChunkPos{X: 0, Z: 0}, CaveVec3{X: 8, Y: 20, Z: 8}, nil, caveAddRoomTestParams, carveVolume, &out)
		if len(out) != 1 {
			t.Fatalf("seed %d: expected exactly one cached record, got %d", seed, len(out))
		}
		rec := out[0]

		// Recompute from the record's own inputs (HorizontalRadiusMultiplier is 1, widthModifier 0).
		angle := float32(math.Sin(float64(float32(rec.HalfDistance) * float32(math.Pi) / float32(rec.Distance))))
		want := angle*(rec.SizeFactor+0) + 1.5
		if rec.RadiusXZ != want {
			t.Fatalf("seed %d: RadiusXZ = %v (bits %#08x), want %v (bits %#08x) -- full-precision f32 pi",
				seed, rec.RadiusXZ, math.Float32bits(rec.RadiusXZ), want, math.Float32bits(want))
		}

		// The old (wrong) 3.1416/float64 arithmetic, exactly as previously shipped.
		oldAngle := float32(math.Sin(float64(float32(rec.HalfDistance)) * 3.1416 / float64(rec.Distance)))
		oldWant := oldAngle*(rec.SizeFactor+0) + 1.5
		if oldWant != want {
			discriminating = true
		}
	}
	if !discriminating {
		t.Fatal("test-coverage failure: every seed produced identical float32 bits for the pi and 3.1416 variants -- extend the seed list")
	}
}

// caveMaxYOverrideAPI wraps a real volume, overriding only MaxY -- lets a test place the thin-sand
// height threshold exactly at the boundary where the sand-thinning pass using the TEST row,
// pos.Y-1 rather than pos.Y, is observable.
type caveMaxYOverrideAPI struct {
	wgen.BlockWorld
	maxY int
}

func (a *caveMaxYOverrideAPI) MaxY() int { return a.maxY }

// TestCaveCarveBlock_ThinSandThresholdUsesTestRow: the sand-thinning pass refuses when MaxY()-3 <= y. The game
// uses y = pos.Y-1 (the ellipsoid-test row), so a carve position with pos.Y == MaxY()-3 is the
// exact boundary: with the corrected test-row argument the threshold check passes (MaxY-3 <= pos.Y-1
// is false) and the sandstone cap is placed; with the previously-shipped pos.Y it would refuse.
func TestCaveCarveBlock_ThinSandThresholdUsesTestRow(t *testing.T) {
	v, pal := newCaveTestVolume(t, "minecraft:stone")
	sand := pal.Get("minecraft:sand", nil)
	sandstone := pal.Get("minecraft:sandstone", nil)
	fill := pal.Get("minecraft:cave_air", nil)

	// Volume MaxY is 20; pick pos.Y = MaxY-3 = 17 and put the three sand layers directly above
	// (18, 19 in-volume; 20 is outside, so extend MaxY via the wrapper instead: use maxY = pos.Y+3
	// with pos.Y = 10 and sand at 11..13, making 13 = maxY-... ). Concretely: maxY = 13 makes
	// pos.Y = 10 the boundary (13-3 = 10): test row 9 passes, pos.Y itself would not.
	pos := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	for dy := 1; dy <= 3; dy++ {
		v.SetBlock(wgen.BlockPos{X: 0, Y: 10 + dy, Z: 0}, sand)
	}
	api := &caveMaxYOverrideAPI{BlockWorld: v, maxY: 13}
	ctx := caveCarveCtx(v)
	ctx.API = api

	if ok := CaveCarveBlock(ctx, CaveConfiguration1_18, fill, pos, false); !ok {
		t.Fatal("expected CaveCarveBlock to succeed")
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 11, Z: 0}); got != sandstone {
		t.Fatalf("expected the sandstone cap at pos+(0,1,0) -- the threshold must test the row pos.Y-1, got %v", pal.Entry(got))
	}
}

// TestBuildCaveFeature_ExplicitSkipCarveChanceZero_Warns pins the warning, and the reason it
// exists: 0 and 1 both mean "never skip" and still carve differently, because only one of them
// consumes a draw. The bug this guards against is somebody "simplifying" the warning away on the
// grounds that the two values are equivalent -- they are equivalent in what they return and not
// in what they leave behind.
func TestBuildCaveFeature_ExplicitSkipCarveChanceZero_Warns(t *testing.T) {
	collect := func(body map[string]any) []string {
		t.Helper()
		var warnings []string
		ctx := caveDemoBuildContext(block.NewPalette())
		ctx.Warn = func(message string) { warnings = append(warnings, message) }
		if _, err := buildCaveFeature(body, ctx); err != nil {
			t.Fatalf("buildCaveFeature: %v", err)
		}
		var skip []string
		for _, w := range warnings {
			if strings.HasPrefix(w, "skip_carve_chance:") {
				skip = append(skip, w)
			}
		}
		return skip
	}

	explicit := caveDemoFeatureBody() // already carries an explicit 0
	if got := collect(explicit); len(got) != 1 {
		t.Fatalf("explicit skip_carve_chance: 0: want exactly one warning, got %d: %v", len(got), got)
	} else if !strings.Contains(got[0], "without consuming a draw") {
		t.Errorf("the warning does not say WHY 0 and 1 differ: %q", got[0])
	}

	omitted := caveDemoFeatureBody()
	delete(omitted, "skip_carve_chance")
	if got := collect(omitted); len(got) != 0 {
		t.Errorf("omitted skip_carve_chance: want no warning (0 is the default and a default is "+
			"never validated), got %v", got)
	}

	one := caveDemoFeatureBody()
	one["skip_carve_chance"] = 1.0
	if got := collect(one); len(got) != 0 {
		t.Errorf("skip_carve_chance: 1 is the value the warning recommends and must not warn, got %v", got)
	}
}
