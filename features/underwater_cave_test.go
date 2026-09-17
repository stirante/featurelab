// underwater_cave_test.go exercises UnderwaterCaveFeature (underwater_cave.go) -- see that file's
// header for the behaviour each assertion here stands behind. Every test name says which specific
// claim it pins.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// --- UnderwaterCaveIsDiggable -------------------------------------------------------------------

func TestUnderwaterCaveIsDiggable(t *testing.T) {
	pal := block.NewPalette()
	cases := []struct {
		name string
		want bool
	}{
		// Shared with the dry carver (unchanged).
		{"minecraft:stone", true},
		{"minecraft:dirt", true},            // dirt group
		{"minecraft:coarse_dirt", true},     // dirt group
		{"minecraft:sandstone", true},       // sandstone group
		{"minecraft:red_sandstone", true},   // red sandstone group
		{"minecraft:sand", true},            // sand group
		{"minecraft:suspicious_sand", true}, // sand group
		{"minecraft:podzol", true},
		{"minecraft:grass_block", true},
		{"minecraft:mycelium", true},
		{"minecraft:gravel", true},
		{"minecraft:dirt_with_roots", true},
		// Terracotta group -- plain colours only; glazed terracotta is not in any group checked
		// by this carver. The full 16-name set is pinned below.
		{"minecraft:white_terracotta", true},
		{"minecraft:black_terracotta", true},
		{"minecraft:white_glazed_terracotta", false},
		{"minecraft:black_glazed_terracotta", false},

		// ADDED relative to CaveIsDiggable1_18 (see underwater_cave.go's underwaterDiggableNamed).
		{"minecraft:hardened_clay", true},
		{"minecraft:water", true},
		{"minecraft:flowing_water", true},
		{"minecraft:lava", true},
		{"minecraft:flowing_lava", true},
		{"minecraft:obsidian", true},
		{"minecraft:air", true},

		// DROPPED relative to CaveIsDiggable1_18 -- the eleven ore/mineral names the underwater
		// carver's carveable-block test does not accept.
		{"minecraft:snow_layer", false},
		{"minecraft:packed_ice", false},
		{"minecraft:deepslate", false},
		{"minecraft:calcite", false},
		{"minecraft:tuff", false},
		{"minecraft:iron_ore", false},
		{"minecraft:deepslate_iron_ore", false},
		{"minecraft:raw_iron_block", false},
		{"minecraft:copper_ore", false},
		{"minecraft:deepslate_copper_ore", false},
		{"minecraft:raw_copper_block", false},

		// Never diggable by either carver.
		{"minecraft:bedrock", false},
		{"minecraft:diamond_ore", false},
	}
	for _, c := range cases {
		id := pal.Get(c.name, nil)
		if got := UnderwaterCaveIsDiggable(pal, id); got != c.want {
			t.Errorf("UnderwaterCaveIsDiggable(%s) = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestUnderwaterGroupTerracotta_AllSixteenPlainColours pins the terracotta group
// and proves the similarly named glazed blocks are not accidentally accepted.
func TestUnderwaterGroupTerracotta_AllSixteenPlainColours(t *testing.T) {
	pal := block.NewPalette()
	colours := []string{
		"white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
		"light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
	}
	if len(underwaterGroupTerracotta) != len(colours) {
		t.Fatalf("underwaterGroupTerracotta has %d entries, want %d", len(underwaterGroupTerracotta), len(colours))
	}
	for _, c := range colours {
		name := "minecraft:" + c + "_terracotta"
		id := pal.Get(name, nil)
		if !underwaterGroupTerracotta.has(pal, id) {
			t.Errorf("underwaterGroupTerracotta missing %s", name)
		}
		if !UnderwaterCaveIsDiggable(pal, id) {
			t.Errorf("UnderwaterCaveIsDiggable(%s) = false, want true (terracotta group)", name)
		}
		glazedName := "minecraft:" + c + "_glazed_terracotta"
		glazedID := pal.Get(glazedName, nil)
		if UnderwaterCaveIsDiggable(pal, glazedID) {
			t.Errorf("UnderwaterCaveIsDiggable(%s) = true, want false (not in the terracotta group)", glazedName)
		}
	}
}

// --- NewUnderwaterCaveEllipsoidVolume: single-candidate-position test rig ----------------------

// underwaterTestAPI is a minimal wgen.BlockWorld mock, letting a test control Contains
// (the bounds test, capability 2) independently of GetBlock/SetBlock -- needed to isolate the
// neighbour-axis tests below (a real volume.Volume's Contains is a single fixed rectangular
// bounds test, which cannot express "only north is in bounds" the way these tests need to).
type underwaterTestAPI struct {
	pal      *block.Palette
	blocks   map[wgen.BlockPos]block.ID
	fallback block.ID
	inBounds func(wgen.BlockPos) bool
	writes   []wgen.BlockPos // in SetBlock call order
	writeIDs []block.ID
}

func newUnderwaterTestAPI(pal *block.Palette, fallback block.ID) *underwaterTestAPI {
	return &underwaterTestAPI{pal: pal, blocks: map[wgen.BlockPos]block.ID{}, fallback: fallback, inBounds: func(wgen.BlockPos) bool { return true }}
}

func (a *underwaterTestAPI) GetBlock(p wgen.BlockPos) block.ID {
	if id, ok := a.blocks[p]; ok {
		return id
	}
	return a.fallback
}
func (a *underwaterTestAPI) SetBlock(p wgen.BlockPos, id block.ID) bool {
	a.blocks[p] = id
	a.writes = append(a.writes, p)
	a.writeIDs = append(a.writeIDs, id)
	return true
}
func (a *underwaterTestAPI) GetHeight(x, z int) int          { return 0 }
func (a *underwaterTestAPI) GetHeightmapAt(x, z int) int     { return 0 }
func (a *underwaterTestAPI) GetAboveTopSolidAt(x, z int) int { return 0 }
func (a *underwaterTestAPI) MinY() int                       { return -64 }
func (a *underwaterTestAPI) MaxY() int                       { return 320 }
func (a *underwaterTestAPI) Contains(p wgen.BlockPos) bool   { return a.inBounds(p) }
func (a *underwaterTestAPI) Palette() wgen.IPaletteView      { return a.pal }

var _ wgen.BlockWorld = (*underwaterTestAPI)(nil)

// underwaterSingleCellSetup makes the ellipsoid volume carve visit EXACTLY one candidate CARVE position,
// (0, carveY, 0). The game carves one row ABOVE the ellipsoid-test row (see underwater_cave.go's
// header), so the single test row here is carveY-1: bounds spanning
// [carveY-1, carveY) yield the one test row carveY-1, and center is offset by exactly
// (0.5, 0.5, 0.5) FROM THAT TEST ROW so dx=dy=dz=0 and the ellipsoid/floor-level tests pass
// trivially -- isolating this file's own per-position logic from the ellipsoid geometry cave_test.go
// already pins.
func underwaterSingleCellSetup(carveY int) (CaveChunkPos, CaveVec3, CaveBoundingBox, float32, float32, CaveCarvingParameters) {
	chunk := CaveChunkPos{X: 0, Z: 0}
	center := CaveVec3{X: 0.5, Y: float32(carveY-1) + 0.5, Z: 0.5}
	bounds := CaveBoundingBox{MinX: 0, MaxX: 1, MinY: carveY - 1, MaxY: carveY, MinZ: 0, MaxZ: 1}
	params := CaveCarvingParameters{FloorLevel: -10} // far below any real dy=0
	return chunk, center, bounds, 1, 1, params
}

func underwaterOceanCtx(api wgen.BlockWorld, rnd random.IRandom) *wgen.PlacementContext {
	return &wgen.PlacementContext{
		API:    api,
		Origin: wgen.BlockPos{X: 0, Y: 0, Z: 0},
		Random: rnd,
		Biome:  &wgen.MolangBiome{ID: "minecraft:ocean", Tags: map[string]struct{}{"ocean": {}}},
	}
}

// --- Y-band boundaries (capability 1: local water level collapsed to seaLevel) -----------------

// TestUnderwaterCaveEllipsoidVolume_SeaLevel63_YBands pins the exact production Y-band boundaries
// this file's header states: carve only y<63; y==10 -> Magma/Obsidian; y<=9 -> Lava; y in [11,62]
// -> ordinary digging. Four positions, one call each.
func TestUnderwaterCaveEllipsoidVolume_SeaLevel63_YBands(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)
	lava := pal.Get("minecraft:lava", nil)
	magma := pal.Get("minecraft:magma", nil)
	obsidian := pal.Get("minecraft:obsidian", nil)

	run := func(y int, floatDraw float64) *underwaterTestAPI {
		api := newUnderwaterTestAPI(pal, stone) // stone: diggable, non-air
		rnd := &underwaterFixedFloatRandom{Rand: random.New(1), fixed: floatDraw}
		ctx := underwaterOceanCtx(api, rnd)
		chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(y)
		carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)
		carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)
		return api
	}

	// y=63 (== seaLevel): never touched at all.
	api := run(63, 0.1)
	if len(api.writes) != 0 {
		t.Fatalf("y=63 (>=seaLevel): expected no writes, got %v", api.writes)
	}

	// y=62: ordinary digging band -- stone (non-air) -> fillWith.
	api = run(62, 0.1)
	if len(api.writes) != 1 || api.GetBlock(wgen.BlockPos{X: 0, Y: 62, Z: 0}) != fillWith {
		t.Fatalf("y=62: expected exactly one write of fillWith, got writes=%v ids=%v", api.writes, api.writeIDs)
	}

	// y=10 (seaLevel-53): Magma/Obsidian band, draw < 0.25 -> Magma.
	api = run(10, 0.1)
	if got := api.GetBlock(wgen.BlockPos{X: 0, Y: 10, Z: 0}); got != magma {
		t.Fatalf("y=10, draw=0.1: expected Magma, got id %v (magma=%v obsidian=%v)", got, magma, obsidian)
	}

	// y=10, draw >= 0.25 -> Obsidian.
	api = run(10, 0.5)
	if got := api.GetBlock(wgen.BlockPos{X: 0, Y: 10, Z: 0}); got != obsidian {
		t.Fatalf("y=10, draw=0.5: expected Obsidian, got id %v", got)
	}

	// y=9 (seaLevel-54): Lava band.
	api = run(9, 0.1)
	if got := api.GetBlock(wgen.BlockPos{X: 0, Y: 9, Z: 0}); got != lava {
		t.Fatalf("y=9: expected Lava, got id %v", got)
	}

	// y=0 (well below seaLevel-54): still Lava.
	api = run(0, 0.1)
	if got := api.GetBlock(wgen.BlockPos{X: 0, Y: 0, Z: 0}); got != lava {
		t.Fatalf("y=0: expected Lava, got id %v", got)
	}
}

// underwaterFixedFloatRandom wraps a real *random.Rand, overriding NextFloat to return a fixed
// value while counting how many times it was called -- lets a test both control the Magma/
// Obsidian roll AND assert the RNG cadence (exactly one NextFloat, only on that band).
type underwaterFixedFloatRandom struct {
	*random.Rand
	fixed      float64
	floatCalls int
}

func (r *underwaterFixedFloatRandom) NextFloat() float64 {
	r.floatCalls++
	return r.fixed
}

var _ random.IRandom = (*underwaterFixedFloatRandom)(nil)

// TestUnderwaterCaveEllipsoidVolume_RNGCadence_OnlyMagmaObsidianBandDraws pins this file's header
// claim verbatim: "EXACTLY ONE rnd.NextFloat() draw per candidate position, and ONLY on the
// y==seaLevel-53 band -- no other draws anywhere in this function."
func TestUnderwaterCaveEllipsoidVolume_RNGCadence_OnlyMagmaObsidianBandDraws(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)

	for _, tc := range []struct {
		name      string
		y         int
		wantCalls int
	}{
		{"skip_at_seaLevel", 63, 0},
		{"ordinary_dig_band", 62, 0},
		{"magma_obsidian_band", 10, 1},
		{"lava_band", 9, 0},
		{"lava_band_deep", 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newUnderwaterTestAPI(pal, stone)
			rnd := &underwaterFixedFloatRandom{Rand: random.New(1), fixed: 0.1}
			ctx := underwaterOceanCtx(api, rnd)
			chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(tc.y)
			carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)
			if rnd.floatCalls != tc.wantCalls {
				t.Fatalf("y=%d: NextFloat called %d times, want %d", tc.y, rnd.floatCalls, tc.wantCalls)
			}
		})
	}
}

func TestUnderwaterCaveEllipsoidVolume_TerracottaEligibilityPreservesRNGCadence(t *testing.T) {
	pal := block.NewPalette()
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)

	for _, tc := range []struct {
		name      string
		blockName string
		wantDraws int
		wantWrite bool
	}{
		{"plain_is_candidate", "minecraft:white_terracotta", 1, true},
		{"glazed_is_rejected", "minecraft:white_glazed_terracotta", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newUnderwaterTestAPI(pal, pal.Get(tc.blockName, nil))
			rnd := &underwaterFixedFloatRandom{Rand: random.New(1), fixed: 0.1}
			ctx := underwaterOceanCtx(api, rnd)
			chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(10)
			carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)
			if rnd.floatCalls != tc.wantDraws {
				t.Fatalf("NextFloat called %d times, want %d", rnd.floatCalls, tc.wantDraws)
			}
			if gotWrite := len(api.writes) != 0; gotWrite != tc.wantWrite {
				t.Fatalf("wrote=%v, want %v", gotWrite, tc.wantWrite)
			}
		})
	}
}

// --- Neighbour axes (capabilities 2+3: bounds/air tests collapsed to Contains/pal.IsAir) --------
//
// These three tests together prove the axis identity (north/south/west/east, Y never varied)
// rather than a plausible but wrong "down/up/west/east" reading: the first two show north/south and
// west/east alone are each sufficient, and the third shows nothing else (in particular no Y-axis
// neighbour) can substitute for them.

func underwaterAirAtOrigin(pal *block.Palette) block.ID { return pal.Get("minecraft:air", nil) }

func TestUnderwaterCaveEllipsoidVolume_NeighbourAxes_NorthSouthOnly_ReplacesAir(t *testing.T) {
	pal := block.NewPalette()
	air := underwaterAirAtOrigin(pal)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)

	const y = 62 // ordinary digging band under seaLevel=63
	api := newUnderwaterTestAPI(pal, air)
	api.inBounds = func(p wgen.BlockPos) bool {
		// Only the north (z-1) and south (z+1) neighbours of (0,y,0) are "in bounds" -- west/east
		// (and any hypothetical up/down) are not.
		return (p == wgen.BlockPos{X: 0, Y: y, Z: -1}) || (p == wgen.BlockPos{X: 0, Y: y, Z: 1})
	}
	rnd := random.New(1)
	ctx := underwaterOceanCtx(api, rnd)
	chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(y)
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)
	carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)

	if got := api.GetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}); got != replaceAirWith {
		t.Fatalf("north/south only in bounds: got id %v, want replaceAirWith (north/south must be checked)", got)
	}
}

func TestUnderwaterCaveEllipsoidVolume_NeighbourAxes_WestEastOnly_ReplacesAir(t *testing.T) {
	pal := block.NewPalette()
	air := underwaterAirAtOrigin(pal)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)

	const y = 62
	api := newUnderwaterTestAPI(pal, air)
	api.inBounds = func(p wgen.BlockPos) bool {
		return (p == wgen.BlockPos{X: -1, Y: y, Z: 0}) || (p == wgen.BlockPos{X: 1, Y: y, Z: 0})
	}
	rnd := random.New(1)
	ctx := underwaterOceanCtx(api, rnd)
	chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(y)
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)
	carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)

	if got := api.GetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}); got != replaceAirWith {
		t.Fatalf("west/east only in bounds: got id %v, want replaceAirWith (west/east must be checked)", got)
	}
}

// TestUnderwaterCaveEllipsoidVolume_NeighbourAxes_OnlyVerticalInBounds_UsesFillWith is the test
// that would catch a regression to the wrong "down (height-1), up (height+1), west, east" axis
// reading: it makes ONLY the two Y-shifted (vertical) positions register
// as "in bounds", with north/south/west/east all false. A west/east-plus-vertical implementation
// (the wrong reading) would find the vertical neighbours in bounds and fire; the CORRECT
// north/south/west/east implementation never even asks about a vertical position, so it must find
// nothing in bounds and fall back to fillWith.
func TestUnderwaterCaveEllipsoidVolume_NeighbourAxes_OnlyVerticalInBounds_UsesFillWith(t *testing.T) {
	pal := block.NewPalette()
	air := underwaterAirAtOrigin(pal)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)

	const y = 62
	api := newUnderwaterTestAPI(pal, air)
	api.inBounds = func(p wgen.BlockPos) bool {
		return (p == wgen.BlockPos{X: 0, Y: y - 1, Z: 0}) || (p == wgen.BlockPos{X: 0, Y: y + 1, Z: 0})
	}
	rnd := random.New(1)
	ctx := underwaterOceanCtx(api, rnd)
	chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(y)
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)
	carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)

	if got := api.GetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}); got != fillWith {
		t.Fatalf("only vertical neighbours in bounds: got id %v, want fillWith (Y must never be treated as a neighbour axis)", got)
	}
}

// --- Ocean biome column-abandon gate -------------------------------------------------------------

func TestUnderwaterCaveEllipsoidVolume_OceanBiome_Present_Carves(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)

	const y = 62
	api := newUnderwaterTestAPI(pal, stone)
	rnd := random.New(1)
	ctx := underwaterOceanCtx(api, rnd)
	chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(y)
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)
	carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)

	if len(api.writes) == 0 {
		t.Fatal("ocean-tagged biome: expected the column to be carved")
	}
}

func TestUnderwaterCaveEllipsoidVolume_OceanBiome_AbsentTag_AbandonsColumn(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)

	const y = 62
	api := newUnderwaterTestAPI(pal, stone)
	rnd := random.New(1)
	ctx := &wgen.PlacementContext{
		API: api, Origin: wgen.BlockPos{}, Random: rnd,
		Biome: &wgen.MolangBiome{ID: "minecraft:plains", Tags: map[string]struct{}{"overworld_generation": {}}},
	}
	chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(y)
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)
	carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)

	if len(api.writes) != 0 {
		t.Fatalf("non-ocean biome: expected the column to be abandoned (no writes), got %v", api.writes)
	}
}

func TestUnderwaterCaveEllipsoidVolume_NoBiome_WarnsOnceAndCarvesNothing(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	fillWith := pal.Get("minecraft:cave_air", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)

	// Two columns worth of ordinary-digging-band cells, to prove the warning fires ONCE for the
	// whole call, not once per column.
	api := newUnderwaterTestAPI(pal, stone)
	var warnings []caveWarning
	rnd := random.New(1)
	ctx := &wgen.PlacementContext{
		API: api, Origin: wgen.BlockPos{}, Random: rnd,
		LogWarning: func(featureType, message string, pos *wgen.BlockPos) {
			warnings = append(warnings, caveWarning{featureType: featureType, message: message, pos: pos})
		},
	}
	// carve row 62 (ordinary digging band) -- the ellipsoid-test row is one below it, so bounds
	// and center are built from y-1 (see underwaterSingleCellSetup's doc comment).
	const y = 62
	chunk := CaveChunkPos{X: 0, Z: 0}
	center := CaveVec3{X: 1, Y: float32(y-1) + 0.5, Z: 0.5}
	bounds := CaveBoundingBox{MinX: 0, MaxX: 2, MinY: y - 1, MaxY: y, MinZ: 0, MaxZ: 1}
	params := CaveCarvingParameters{FloorLevel: -10}
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)
	carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, 4, 1, params)

	if len(api.writes) != 0 {
		t.Fatalf("no biome supplied: expected no writes, got %v", api.writes)
	}
	if len(warnings) != 1 {
		t.Fatalf("expected exactly one LogWarning call, got %d: %v", len(warnings), warnings)
	}
	if warnings[0].featureType != underwaterCaveCarverTypeID {
		t.Fatalf("warning featureType = %q, want %q", warnings[0].featureType, underwaterCaveCarverTypeID)
	}
	if warnings[0].pos != nil {
		t.Fatalf("warning pos = %+v, want nil (whole-call diagnostic)", warnings[0].pos)
	}
}

// --- Real-carve verification (this project's own standard) --------------------------------------

// TestUnderwaterCaveEllipsoidVolume_RealCarve_CrossSection is this project's own carve-verification
// standard: a real ellipsoid, carved through the real (non-mocked) volume.Volume, in an ocean-
// tagged PlacementContext, rendered as ASCII art -- not a stub, not a count.
func TestUnderwaterCaveEllipsoidVolume_RealCarve_CrossSection(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	fillWith := pal.Get("minecraft:water", nil)
	replaceAirWith := pal.Get("minecraft:flowing_water", nil)

	bounds := volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 16, SizeY: 70, SizeZ: 16}
	v := volume.New(bounds, pal, block.AirID)
	for x := 0; x < 16; x++ {
		for y := 0; y < 70; y++ {
			for z := 0; z < 16; z++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}

	ctx := underwaterOceanCtx(v, random.New(42))
	center := CaveVec3{X: 8, Y: 30, Z: 8}
	const radius = 8
	params := CaveCarvingParameters{FloorLevel: -2}
	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)

	ok := CaveEllipsoid(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000},
		carveVolume, ctx.Random, CaveChunkPos{X: 0, Z: 0}, center, radius, radius, params)
	if !ok {
		t.Fatal("expected CaveEllipsoid to succeed")
	}

	var art strings.Builder
	carved, lavaCount, magmaObsidianCount := 0, 0, 0
	lava := pal.Get("minecraft:lava", nil)
	magma := pal.Get("minecraft:magma", nil)
	obsidian := pal.Get("minecraft:obsidian", nil)
	for dy := radius; dy >= -radius; dy-- {
		for dx := -radius; dx <= radius; dx++ {
			pos := wgen.BlockPos{X: int(center.X) + dx, Y: int(center.Y) + dy, Z: int(center.Z)}
			got := v.GetBlock(pos)
			switch got {
			case stone:
				art.WriteByte('#')
			case lava:
				art.WriteByte('L')
				lavaCount++
				carved++
			case magma, obsidian:
				art.WriteByte('M')
				magmaObsidianCount++
				carved++
			case fillWith, replaceAirWith:
				art.WriteByte('.')
				carved++
			default:
				art.WriteByte('?')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("UnderwaterCaveFeature real carve -- %d cells carved (%d lava, %d magma/obsidian) in this "+
		"X/Y slice; vertical cross-section at Z=%d (# stone, . water/flowing_water, L lava, M magma/obsidian):\n%s",
		carved, lavaCount, magmaObsidianCount, int(center.Z), art.String())

	if carved == 0 {
		t.Fatal("expected a nonzero number of carved positions")
	}
}

// --- UnderwaterCaveFeature.Place() ---------------------------------------------------------------

func underwaterDemoFeatureBody() map[string]any {
	return map[string]any{
		"description":                  map[string]any{"identifier": "example:underwater_cave_demo"},
		"fill_with":                    "minecraft:water",
		"replace_air_with":             "minecraft:flowing_water",
		"width_modifier":               0.0,
		"height_limit":                 128.0,
		"skip_carve_chance":            0.0,
		"y_scale":                      map[string]any{"range_min": 1.0, "range_max": 1.0},
		"horizontal_radius_multiplier": map[string]any{"range_min": 1.0, "range_max": 1.0},
		"vertical_radius_multiplier":   map[string]any{"range_min": 0.7, "range_max": 1.4},
		"floor_level":                  map[string]any{"range_min": -1.0, "range_max": -0.7},
	}
}

func underwaterDemoBuildContext(pal *block.Palette) *BuildContext {
	return &BuildContext{Palette: pal, Identifier: "example:underwater_cave_demo", FileID: "underwater_cave_demo.json", Warn: func(string) {}}
}

// TestUnderwaterCaveFeaturePlace_ReseedSequence_MatchesFormula pins the SAME reseed formula
// CaveFeature.Place uses -- see underwater_cave.go's Place doc comment for why that is a
// deliberate byte-identical copy, not an independent derivation. Like cave_test.go's own sibling
// test, the multipliers are carverOddMaker(NextInt()) (increment toward zero when negative, then
// |1), as of game version 1.26.50. The negative-adjust branch
// is unreachable through real draws (nextInt() is non-negative) and is pinned separately by
// cave_test.go's TestCarverOddMaker_NegativeAdjustForm.
func TestUnderwaterCaveFeaturePlace_ReseedSequence_MatchesFormula(t *testing.T) {
	pal := block.NewPalette()
	f, err := buildUnderwaterCaveFeature(underwaterDemoFeatureBody(), underwaterDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	stone := pal.Get("minecraft:stone", nil)
	for _, baseSeed := range []uint32{999, 12345} {
		rec := &caveSetSeedRecorder{Rand: random.New(baseSeed)}

		bounds := volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 16, SizeY: 70, SizeZ: 16}
		v := volume.New(bounds, pal, block.AirID)
		for x := 0; x < 16; x++ {
			for y := 0; y < 70; y++ {
				for z := 0; z < 16; z++ {
					v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
				}
			}
		}
		ctx := &wgen.PlacementContext{
			API: v, Origin: wgen.BlockPos{X: 8, Y: 30, Z: 8}, Random: rec,
			Biome: &wgen.MolangBiome{ID: "minecraft:ocean", Tags: map[string]struct{}{"ocean": {}}},
		}

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

func TestUnderwaterCaveFeaturePlace_AlwaysReturnsOrigin(t *testing.T) {
	pal := block.NewPalette()
	f, err := buildUnderwaterCaveFeature(underwaterDemoFeatureBody(), underwaterDemoBuildContext(pal))
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
	if f.TypeID() != underwaterCaveCarverTypeID {
		t.Fatalf("TypeID() = %q, want %q", f.TypeID(), underwaterCaveCarverTypeID)
	}
	if f.Identifier() != "example:underwater_cave_demo" {
		t.Fatalf("Identifier() = %q, want example:underwater_cave_demo", f.Identifier())
	}
}

// --- buildUnderwaterCaveFeature -------------------------------------------------------------------

func TestBuildUnderwaterCaveFeature_MissingReplaceAirWith_UsesNullDefault(t *testing.T) {
	pal := block.NewPalette()
	body := underwaterDemoFeatureBody()
	delete(body, "replace_air_with")
	built, err := buildUnderwaterCaveFeature(body, underwaterDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build without replace_air_with: %v", err)
	}
	f := built.(*UnderwaterCaveFeature)
	air := pal.Get("minecraft:air", nil)
	api := newUnderwaterTestAPI(pal, air)
	rnd := &underwaterFixedFloatRandom{Rand: random.New(1), fixed: 0.1}
	ctx := underwaterOceanCtx(api, rnd)
	chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(62)
	f.carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)
	// USED TO assert that the null sentinel was WRITTEN, and it passed only because this mock
	// accepts any id. Against the real palette that same write panicked -- "block id is not in
	// the palette" -- on a file the game's own loader accepts, which is how a test can pin a
	// crash and look green. The subject it was really covering, that an omitted field reaches
	// the write path as null rather than as some invented default, is unchanged and is what the
	// skip now demonstrates.
	if len(api.writeIDs) != 0 {
		t.Fatalf("omitted replace_air_with wrote %v, want NO write at all -- a null block "+
			"is null-checked before the write, exactly as CaveCarveBlock does for fill_with",
			api.writeIDs)
	}
	if rnd.floatCalls != 0 {
		t.Fatalf("omitted replace_air_with moved RNG cadence: NextFloat called %d times, want 0", rnd.floatCalls)
	}

	api = newUnderwaterTestAPI(pal, pal.Get("minecraft:stone", nil))
	rnd = &underwaterFixedFloatRandom{Rand: random.New(1), fixed: 0.1}
	ctx = underwaterOceanCtx(api, rnd)
	chunk, center, bounds, rXZ, rY, params = underwaterSingleCellSetup(10)
	f.carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)
	if rnd.floatCalls != 1 {
		t.Fatalf("omitted replace_air_with moved magma-band RNG cadence: NextFloat called %d times, want 1", rnd.floatCalls)
	}
}

func TestBuildUnderwaterCaveFeature_ValidBody_Succeeds(t *testing.T) {
	pal := block.NewPalette()
	f, err := buildUnderwaterCaveFeature(underwaterDemoFeatureBody(), underwaterDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if f == nil {
		t.Fatal("expected a non-nil feature")
	}
}

func TestBuildUnderwaterCaveFeature_DescriptionOnly_UsesDefaults(t *testing.T) {
	pal := block.NewPalette()
	body := map[string]any{
		"description": map[string]any{"identifier": "example:underwater_minimal"},
	}
	f, err := buildUnderwaterCaveFeature(body, underwaterDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build with only description set: %v", err)
	}
	if f == nil {
		t.Fatal("expected a non-nil feature")
	}
}

func TestBuildUnderwaterCaveFeature_TerracottaGapWarningRemoved(t *testing.T) {
	pal := block.NewPalette()
	var warnings []string
	ctx := &BuildContext{Palette: pal, Identifier: "example:underwater_cave_demo", FileID: "f.json",
		Warn: func(m string) { warnings = append(warnings, m) }}
	_, err := buildUnderwaterCaveFeature(underwaterDemoFeatureBody(), ctx)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	for _, w := range warnings {
		if strings.Contains(w, "terracotta") {
			t.Fatalf("the terracotta group must not emit the old disclosure warning: %q", w)
		}
	}
}

func TestUnderwaterCaveFeature_RegisteredInBuilderRegistry(t *testing.T) {
	found := false
	for _, id := range RegisteredTypes() {
		if id == underwaterCaveCarverTypeID {
			found = true
		}
	}
	if !found {
		t.Fatalf("%q is not registered", underwaterCaveCarverTypeID)
	}
}

// roomDrawCounter is a pass-through IRandom that counts every draw taken from it.
type roomDrawCounter struct {
	inner random.IRandom
	draws int
}

func (c *roomDrawCounter) NextInt() int32         { c.draws++; return c.inner.NextInt() }
func (c *roomDrawCounter) NextIntBound(b int) int { c.draws++; return c.inner.NextIntBound(b) }
func (c *roomDrawCounter) NextFloat() float64     { c.draws++; return c.inner.NextFloat() }
func (c *roomDrawCounter) NextDouble() float64    { c.draws++; return c.inner.NextDouble() }
func (c *roomDrawCounter) NextBoolean() bool      { c.draws++; return c.inner.NextBoolean() }
func (c *roomDrawCounter) NextUnsignedInt(n uint32) uint32 {
	c.draws++
	return c.inner.NextUnsignedInt(n)
}
func (c *roomDrawCounter) SetSeed(s uint32) { c.inner.SetSeed(s) }
func (c *roomDrawCounter) GetSeed() uint32  { return c.inner.GetSeed() }

var _ random.IRandom = (*roomDrawCounter)(nil)

// TestCaveAddRoom_CallerDrawsDoNotDependOnCarveVolume pins which generator CaveEllipsoid hands
// to the carve volume.
// CaveAddRoom's documented cadence is exactly TWO draws from the caller's generator (a NextFloat
// for sizeFactor and a NextInt to seed its throwaway local Random); everything after that belongs
// to the local generator. The ellipsoid volume carve differs per carver type, and the underwater
// carver's draws one NextFloat per carved position in the magma/obsidian band. While CaveEllipsoid
// substituted ctx.Random for the generator it was handed, installing the underwater volume pushed
// those draws onto the CALLER instead: 2 draws with the base volume, 258 with the underwater one,
// from an otherwise identical call. Which carve volume is installed must not be observable in the
// caller's stream at all.
func TestCaveAddRoom_CallerDrawsDoNotDependOnCarveVolume(t *testing.T) {
	build := func(carveVolume CaveEllipsoidVolumeFunc) int {
		pal := block.NewPalette()
		stone := pal.Get("minecraft:stone", nil)
		v := volume.New(volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 16, SizeY: 70, SizeZ: 16}, pal, block.AirID)
		for x := 0; x < 16; x++ {
			for y := 0; y < 70; y++ {
				for z := 0; z < 16; z++ {
					v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
				}
			}
		}
		counter := &roomDrawCounter{inner: random.New(42)}
		ctx := underwaterOceanCtx(v, counter)
		CaveAddRoom(ctx, CaveConfiguration1_18, CaveEllipsoidConfig{HeightLimit: 1000},
			CaveRoomConfig{WidthModifier: constMolang(0), YScaleMin: 0.5, YScaleMax: 0.5},
			counter, CaveChunkPos{}, CaveVec3{X: 8, Y: 12, Z: 8}, nil,
			// Deliberately sized and positioned so the ellipsoid crosses the underwater
			// carver's magma/obsidian band -- the only band that draws.
			CaveCarvingParameters{FloorLevel: -2, HorizontalRadiusMultiplier: 3, VerticalRadiusMultiplier: 3},
			carveVolume, nil)
		return counter.draws
	}

	pal := block.NewPalette()
	base := build(NewCaveEllipsoidVolume(pal.Get("minecraft:air", nil)))
	underwater := build(NewUnderwaterCaveEllipsoidVolume(
		pal.Get("minecraft:water", nil), pal.Get("minecraft:flowing_water", nil),
		UnderwaterCaveOverworldSeaLevel))

	if base != 2 {
		t.Errorf("base carve volume: caller draws = %d, want 2 (NextFloat sizeFactor + NextInt local seed)", base)
	}
	if underwater != base {
		t.Errorf("underwater carve volume: caller draws = %d, base carve volume: %d; the carve "+
			"volume's own draws must come from addRoom's local generator, never from the caller's",
			underwater, base)
	}
}

// TestUnderwaterCaveFeature_OmittedFillFieldsDoNotPanicAgainstARealPalette is the regression test
// for the crash, and the thing that makes it a regression test rather than a restatement is that
// it runs against a REAL block.Palette instead of this file's mock.
//
// The mock accepts any id, including block.ID(-1). The real palette does not, and that difference
// is the entire bug: `featurelab generate` on an underwater carver with `replace_air_with` and
// `fill_with` omitted -- a file the game's own loader accepts, since both fields are optional with
// a null default -- panicked with "block id is not in the palette".
func TestUnderwaterCaveFeature_OmittedFillFieldsDoNotPanicAgainstARealPalette(t *testing.T) {
	pal := block.NewPalette()
	body := underwaterDemoFeatureBody()
	delete(body, "replace_air_with")
	delete(body, "fill_with")
	built, err := buildUnderwaterCaveFeature(body, underwaterDemoBuildContext(pal))
	if err != nil {
		t.Fatalf("build with both block fields omitted: %v", err)
	}
	f := built.(*UnderwaterCaveFeature)

	// A real palette, and a volume the writes actually land in -- newUnderwaterTestAPI's mock is
	// what hid this, so using it here would reproduce the hiding rather than the bug.
	volBounds := volume.Bounds{MinX: -4, MinY: 56, MinZ: -4, SizeX: 9, SizeY: 12, SizeZ: 9}
	api := volume.New(volBounds, pal, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	for x := -4; x <= 4; x++ {
		for y := 56; y < 68; y++ {
			for z := -4; z <= 4; z++ {
				api.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	rnd := &underwaterFixedFloatRandom{Rand: random.New(1), fixed: 0.1}
	ctx := underwaterOceanCtx(api, rnd)
	chunk, center, bounds, rXZ, rY, params := underwaterSingleCellSetup(62)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("carving with both block fields omitted panicked: %v -- the null sentinel "+
				"reached SetBlock instead of being null-checked before it", r)
		}
	}()
	f.carveVolume(ctx, CaveConfiguration1_18, rnd, chunk, center, bounds, rXZ, rY, params)
}
