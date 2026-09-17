// multiface_test.go exercises MultifaceFeature's RNG draw sequence explicitly (method + count, per
// random.Tracer, including the "success but zero draws" no-op case), the deterministic spreader's
// strict separation from ctx.Random and same-seed reproducibility, the state-bit
// read-modify-write actually OR-ing a new face bit into an existing block's bits, the per-direction
// fallback path, and build-time schema validation -- not just final block counts. There is no golden
// -dump differential coverage for this type, so these tests are
// the only thing standing between a wrong implementation and a caller relying on this type. See
// multiface.go's header for the algorithm this is checking against.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// newMultifaceTestVolume builds an all-air volume centered on origin (0,63,0) with room in every
// direction for neighbor/fallback geometry.
func newMultifaceTestVolume(t *testing.T) (*volume.Volume, *block.Palette, wgen.BlockPos) {
	t.Helper()
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -5, MinY: 58, MinZ: -5, SizeX: 11, SizeY: 11, SizeZ: 11}
	v := volume.New(bounds, pal, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	return v, pal, origin
}

func buildTestMultiface(t *testing.T, pal *block.Palette, extra map[string]any) wgen.IFeature {
	t.Helper()
	body := map[string]any{
		"places_block":         "minecraft:glow_lichen",
		"search_range":         float64(4),
		"can_place_on_floor":   false,
		"can_place_on_ceiling": false,
		"can_place_on_wall":    true,
		"chance_of_spreading":  float64(0.5),
	}
	for k, v := range extra {
		body[k] = v
	}
	ctx := &BuildContext{Palette: pal, Identifier: "test:multiface", FileID: "test:multiface", Warn: func(string) {}}
	f, err := buildMultifaceFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildMultifaceFeature: %v", err)
	}
	return f
}

func placeTestMultiface(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) (*wgen.BlockPos, []string, []string) {
	var failures []string
	var warnings []string
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {
			failures = append(failures, message)
		},
		LogWarning: func(featureType, message string, pos *wgen.BlockPos) {
			warnings = append(warnings, message)
		},
	}
	pos := f.Place(ctx)
	return pos, failures, warnings
}

// prepareMultifaceSpreadCase gives the direct origin placement a Down support and gives every
// horizontal neighbor its own Down support. Same-position horizontal spreading cannot succeed
// (the horizontal neighbor itself is air), so a successful spread must create a SECOND block in
// one horizontal neighbor rather than merely adding a face to the origin block.
func prepareMultifaceSpreadCase(t *testing.T, chance float64) (*volume.Volume, *block.Palette, wgen.BlockPos, wgen.IFeature) {
	t.Helper()
	v, pal, origin := newMultifaceTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)
	for z := origin.Z - 1; z <= origin.Z+1; z++ {
		for x := origin.X - 1; x <= origin.X+1; x++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: origin.Y - 1, Z: z}, stone)
		}
	}
	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on_floor":  true,
		"can_place_on_wall":   false,
		"can_place_on":        []any{"minecraft:stone"},
		"chance_of_spreading": chance,
	})
	return v, pal, origin, f
}

func countMultifaceBlocks(v *volume.Volume, pal *block.Palette) int {
	count := 0
	for _, id := range v.Data() {
		if pal.NameOf(id) == "minecraft:glow_lichen" {
			count++
		}
	}
	return count
}

// TestMultifaceFeature_SpreadConsumesZeroCtxRandomDraws proves the central RNG contract: both runs
// consume the one on-stream chance_of_spreading NextFloat, while the enabled run additionally
// creates a spread block using only its derived generator. Every subsequent ctx.Random value must
// therefore remain bit-identical to the disabled run.
func TestMultifaceFeature_SpreadConsumesZeroCtxRandomDraws(t *testing.T) {
	enabledV, enabledPal, origin, enabled := prepareMultifaceSpreadCase(t, 1)
	disabledV, disabledPal, _, disabled := prepareMultifaceSpreadCase(t, 0)
	enabledRnd := random.New(73)
	disabledRnd := random.New(73)

	if got, failures, _ := placeTestMultiface(enabled, enabledV, origin, enabledRnd); got == nil {
		t.Fatalf("enabled Place() = nil (failures: %v)", failures)
	}
	if got, failures, _ := placeTestMultiface(disabled, disabledV, origin, disabledRnd); got == nil {
		t.Fatalf("disabled Place() = nil (failures: %v)", failures)
	}
	if got := countMultifaceBlocks(enabledV, enabledPal); got != 2 {
		t.Fatalf("enabled multiface block count = %d, want 2 (origin plus spread)", got)
	}
	if got := countMultifaceBlocks(disabledV, disabledPal); got != 1 {
		t.Fatalf("disabled multiface block count = %d, want 1 (origin only)", got)
	}
	for i := 0; i < 16; i++ {
		got, want := enabledRnd.NextInt(), disabledRnd.NextInt()
		if got != want {
			t.Fatalf("ctx.Random draw %d after placement: spreading enabled=%d disabled=%d", i, got, want)
		}
	}
}

// TestMultifaceFeature_SpreadIsReproducibleAtSameSeed proves the deliberate deviation from the
// engine's OS-entropy shuffle: identical inputs and identical seeds choose the same spread cell and
// produce byte-identical volume data.
func TestMultifaceFeature_SpreadIsReproducibleAtSameSeed(t *testing.T) {
	v1, pal, origin, f := prepareMultifaceSpreadCase(t, 1)
	v2 := volume.New(volume.Bounds{MinX: -5, MinY: 58, MinZ: -5, SizeX: 11, SizeY: 11, SizeZ: 11}, pal, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	for z := origin.Z - 1; z <= origin.Z+1; z++ {
		for x := origin.X - 1; x <= origin.X+1; x++ {
			v2.SetBlock(wgen.BlockPos{X: x, Y: origin.Y - 1, Z: z}, stone)
		}
	}

	if got, failures, _ := placeTestMultiface(f, v1, origin, random.New(991)); got == nil {
		t.Fatalf("first Place() = nil (failures: %v)", failures)
	}
	if got, failures, _ := placeTestMultiface(f, v2, origin, random.New(991)); got == nil {
		t.Fatalf("second Place() = nil (failures: %v)", failures)
	}
	data1, data2 := v1.Data(), v2.Data()
	if len(data1) != len(data2) {
		t.Fatalf("volume lengths differ: %d vs %d", len(data1), len(data2))
	}
	for i := range data1 {
		if data1[i] != data2[i] {
			t.Fatalf("volume data differs at index %d: first=%d second=%d", i, data1[i], data2[i])
		}
	}
	if got := countMultifaceBlocks(v1, pal); got != 2 {
		t.Fatalf("multiface block count = %d, want 2 so reproducibility test exercises a real spread", got)
	}
}

// TestMultifaceFeature_WrapAroundMode_FiresWhenModes0And1Fail proves the third spread mode of
// getSpreadFromFaceTowardDirection (the multiface spreader's wrap-around lookup -- see
// multiface.go's header, "The spreader" point 2): when the same-position mode (add toward
// at pos itself) and the move-to-neighbor mode (step toward, retain fromFace) both find no support,
// wrapping around a corner still can. Support exists ONLY directly below origin -- exactly enough to
// hold a wrap-around spread toward North (landing one step North AND one step down, with a South
// face reattaching to that same support block), but not enough for a flat same-position or
// move-to-neighbor attempt toward North.
func TestMultifaceFeature_WrapAroundMode_FiresWhenModes0And1Fail(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, stone) // support directly below origin ONLY

	existingLichen := pal.Get("minecraft:glow_lichen", map[string]block.StateValue{"multi_face_direction_bits": float64(1)}) // DOWN
	v.SetBlock(origin, existingLichen)

	f := buildTestMultiface(t, pal, nil).(*MultifaceFeature)

	const down, north, south = 0, 2, 3

	// Sanity first: modes 0 and 1 alone must NOT find anything at this geometry, or this test
	// wouldn't actually isolate wrap-around.
	if newID, ok := f.multifaceBlockForPlacement(v, origin, north); ok && newID != v.GetBlock(origin) {
		t.Fatalf("mode 0 (same position) unexpectedly succeeded -- test setup doesn't isolate wrap-around")
	}
	neighborPos := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 1}
	if newID, ok := f.multifaceBlockForPlacement(v, neighborPos, down); ok && newID != v.GetBlock(neighborPos) {
		t.Fatalf("mode 1 (move to neighbor) unexpectedly succeeded -- test setup doesn't isolate wrap-around")
	}

	spread, ok := f.getSpreadFromFaceTowardDirection(v, origin, down, north)
	if !ok {
		t.Fatalf("getSpreadFromFaceTowardDirection = false, want wrap-around success")
	}
	wantPos := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z - 1}
	if spread.pos != wantPos {
		t.Errorf("spread.pos = %+v, want %+v (wrap-around target)", spread.pos, wantPos)
	}
	if spread.face != south {
		t.Errorf("spread.face = %d, want %d (South, toward's opposite)", spread.face, south)
	}
}

// TestMultifaceSpreadSeed_VariesByPosition guards against seeding spreadRnd from position-free
// state (multiface.go's header, "spreadRnd's own seed is POSITION-DEPENDENT"): seeding
// spreadRnd from ctx.Random.GetSeed() ALONE, which is constant for an entire session
// (session.go constructs ctx.Random exactly once and shares it across every placement) -- so every
// successful spread anywhere in a whole generation run would have drawn the IDENTICAL six-facing
// permutation, regardless of where in the world it fired. multifaceSpreadSeed must differ across
// positions while remaining a pure function of (base, pos) (so a given position is
// still reproducible, the property TestMultifaceFeature_SpreadIsReproducibleAtSameSeed depends on).
func TestMultifaceSpreadSeed_VariesByPosition(t *testing.T) {
	base := uint32(73)
	a := multifaceSpreadSeed(base, wgen.BlockPos{X: 0, Y: 63, Z: 0})
	b := multifaceSpreadSeed(base, wgen.BlockPos{X: 1, Y: 63, Z: 0})
	if a == b {
		t.Fatalf("multifaceSpreadSeed(%d, ...) = %d for two different positions, want different seeds", base, a)
	}
	again := multifaceSpreadSeed(base, wgen.BlockPos{X: 0, Y: 63, Z: 0})
	if again != a {
		t.Fatalf("multifaceSpreadSeed is not a pure function of (base, pos): got %d then %d for identical inputs", a, again)
	}
}

// TestMultifaceFeature_OriginSuccess_OneDrawOnActualChange pins the simplest success path: origin
// is air, can_place_on_floor is the only enabled direction, and the Down neighbor is solid (matches
// the default empty can_place_on, i.e. "anything counts as support"). This must succeed AT ORIGIN
// (place()'s own step 3), write glow lichen with just the Down bit, and draw EXACTLY one NextFloat -- the
// chance_of_spreading roll, made only because the write actually changed the world (multiface.go's
// header step 4).
func TestMultifaceFeature_OriginSuccess_OneDrawOnActualChange(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, stone)

	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on_floor": true,
		"can_place_on_wall":  false,
	})

	tracer := random.NewTracer(random.New(1))
	got, failures, warnings := placeTestMultiface(f, v, origin, tracer)
	if got == nil {
		t.Fatalf("Place() = nil, want success (failures: %v)", failures)
	}
	if got.X != origin.X || got.Y != origin.Y || got.Z != origin.Z {
		t.Errorf("Place() returned %+v, want origin %+v", *got, origin)
	}
	if len(tracer.Draws) != 1 {
		t.Fatalf("draws = %v, want exactly 1", tracer.Draws)
	}
	if tracer.Draws[0].Method != random.MethodNextFloat {
		t.Errorf("draw[0].Method = %v, want NextFloat", tracer.Draws[0].Method)
	}

	id := v.GetBlock(origin)
	if name := pal.NameOf(id); name != "minecraft:glow_lichen" {
		t.Fatalf("block at origin = %q, want minecraft:glow_lichen", name)
	}
	bits, ok := pal.StateInt(id, block.MultiFaceDirectionBits)
	if !ok || bits != 1 { // MULTIFACE_DOWN = 1
		t.Errorf("multi_face_direction_bits = (%v, %v), want (1, true)", bits, ok)
	}
	if len(failures) != 0 {
		t.Errorf("failures = %v, want none", failures)
	}
	// Roll of 0.417022... (random.New(1)'s first NextFloat) is below chance_of_spreading=0.5, so
	// the deterministic-spread deviation warning must fire exactly once.
	if len(warnings) != 1 || !strings.Contains(warnings[0], "chance_of_spreading") {
		t.Errorf("warnings = %v, want exactly one naming chance_of_spreading", warnings)
	}
}

// TestMultifaceFeature_OriginFails_NoSupport_FallsBackToDirectionLoop proves that when the origin's
// own candidate faces all fail can_place_on, place() falls through to the per-direction growth loop
// (step 5) rather than failing outright, and that the eventual write happens at the NEIGHBOR
// position, not the origin.
func TestMultifaceFeature_OriginFails_NoSupport_FallsBackToDirectionLoop(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)

	// Origin's own North/East/South/West neighbors are all air -- no support for a direct
	// placement at origin. Two steps North of origin is stone -- the support for growing INTO the
	// (air) North neighbor.
	twoNorth := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 2}
	v.SetBlock(twoNorth, stone)

	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on": []any{"minecraft:stone"}, // air neighbors must NOT count as their own support
	})

	got, failures, _ := placeTestMultiface(f, v, origin, random.New(1))
	if got == nil {
		t.Fatalf("Place() = nil, want success via fallback (failures: %v)", failures)
	}
	oneNorth := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 1}
	if *got != oneNorth {
		t.Errorf("Place() returned %+v, want the North neighbor %+v", *got, oneNorth)
	}
	if name := pal.NameOf(v.GetBlock(origin)); name != "minecraft:air" {
		t.Errorf("origin block = %q, want unchanged air (nothing placed AT origin)", name)
	}
	id := v.GetBlock(oneNorth)
	if name := pal.NameOf(id); name != "minecraft:glow_lichen" {
		t.Fatalf("block at %+v = %q, want minecraft:glow_lichen", oneNorth, name)
	}
	bits, ok := pal.StateInt(id, block.MultiFaceDirectionBits)
	if !ok || bits != 16 { // MULTIFACE_NORTH = 16
		t.Errorf("multi_face_direction_bits = (%v, %v), want (16, true)", bits, ok)
	}
}

// TestMultifaceFeature_ExceptDirection_ExcludesTheWayCameFrom proves the game's
// candidate-face-list-minus-one-face rule precisely: growing North from origin into an
// already-existing glow lichen at oneNorth must NOT
// consider oneNorth's own SOUTH neighbor (= origin) as a candidate support face, even though origin
// (air) WOULD satisfy this test's deliberately reflexive can_place_on=["minecraft:air"] if it were
// checked. Every other candidate face (at oneNorth: North, East, West; at origin: East, South, West
// as alternate growth directions) is deliberately blocked with dirt, so success is possible ONLY if
// the excluded South face is wrongly consulted -- this is not observable by face-pick order alone
// (an earlier, weaker version of this test placed the real support before the excluded one in pool
// order, so it passed even with the exclusion broken; this version isolates the excluded face as the
// ONLY possible source of success).
func TestMultifaceFeature_ExceptDirection_ExcludesTheWayCameFrom(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	dirt := pal.Get("minecraft:dirt", nil)

	oneNorth := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 1}
	// oneNorth is already glow lichen (UP only) -- passes the neighbor-validity gate (step 5b) via
	// "same block type as places_block", and is NOT air, so it does not itself satisfy
	// can_place_on=[air] from origin's own top-level attempt (forcing the fallback to run at all).
	existingLichen := pal.Get("minecraft:glow_lichen", map[string]block.StateValue{"multi_face_direction_bits": float64(2)}) // UP
	v.SetBlock(oneNorth, existingLichen)

	// Block every candidate EXCEPT the excluded South (=origin) with dirt (not air, not water, not
	// glow lichen -- fails can_place_on=[air] and fails the neighbor-validity gate alike).
	v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 2}, dirt)     // North of oneNorth
	v.SetBlock(wgen.BlockPos{X: origin.X + 1, Y: origin.Y, Z: origin.Z - 1}, dirt) // East of oneNorth
	v.SetBlock(wgen.BlockPos{X: origin.X - 1, Y: origin.Y, Z: origin.Z - 1}, dirt) // West of oneNorth
	v.SetBlock(wgen.BlockPos{X: origin.X + 1, Y: origin.Y, Z: origin.Z}, dirt)     // East of origin
	v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z + 1}, dirt)     // South of origin
	v.SetBlock(wgen.BlockPos{X: origin.X - 1, Y: origin.Y, Z: origin.Z}, dirt)     // West of origin

	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on": []any{"minecraft:air"},
	})

	tracer := random.NewTracer(random.New(1))
	got, failures, _ := placeTestMultiface(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil -- the only 'match' available is origin itself via the "+
			"excluded South face, which must not be consulted", *got)
	}
	if len(failures) != 1 || failures[0] != "No adjacent locations contain air or water" {
		t.Errorf("failures = %v, want [\"No adjacent locations contain air or water\"]", failures)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want none -- every candidate must fail deterministically", tracer.Draws)
	}
	// oneNorth's bits must be untouched -- if the excluded South face were wrongly accepted, this
	// would be 2|4=6 instead.
	bits, ok := pal.StateInt(v.GetBlock(oneNorth), block.MultiFaceDirectionBits)
	if !ok || bits != 2 {
		t.Errorf("oneNorth's multi_face_direction_bits = (%v, %v), want (2, true) -- unchanged", bits, ok)
	}
}

// TestMultifaceFeature_ORsNewFaceBitIntoExistingBlock is the state-bit read-modify-write assertion: growing onto a position that is ALREADY a glow lichen block (not air) must OR the
// new face bit into its EXISTING bits, not replace them -- mirrors
// the multiface block's worldgen placement derivation (block/state.go), which the live placement
// derivation behaves identically to (multiface.go's header).
func TestMultifaceFeature_ORsNewFaceBitIntoExistingBlock(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)

	oneNorth := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 1}
	// oneNorth is ALREADY a glow lichen block with SOUTH(4) set -- the "same block type as places_block"
	// branch of place()'s own neighbor-validity gate (step 5b), not air/water.
	existingLichen := pal.Get("minecraft:glow_lichen", map[string]block.StateValue{"multi_face_direction_bits": float64(4)})
	v.SetBlock(oneNorth, existingLichen)
	// Support for growing INTO oneNorth further North:
	twoNorth := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 2}
	v.SetBlock(twoNorth, stone)

	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on": []any{"minecraft:stone"},
	})

	tracer := random.NewTracer(random.New(1))
	got, failures, _ := placeTestMultiface(f, v, origin, tracer)
	if got == nil {
		t.Fatalf("Place() = nil, want success (failures: %v)", failures)
	}
	if *got != oneNorth {
		t.Fatalf("Place() returned %+v, want %+v", *got, oneNorth)
	}

	id := v.GetBlock(oneNorth)
	if name := pal.NameOf(id); name != "minecraft:glow_lichen" {
		t.Fatalf("block at %+v = %q, want minecraft:glow_lichen", oneNorth, name)
	}
	bits, ok := pal.StateInt(id, block.MultiFaceDirectionBits)
	if !ok || bits != (4|16) { // SOUTH(4) preserved, OR'd with the new NORTH(16)
		t.Fatalf("multi_face_direction_bits = (%v, %v), want (%d, true) -- SOUTH preserved, NORTH added", bits, ok, 4|16)
	}
	// Exactly one draw: origin's own attempt found no valid face (0 draws), the successful write at
	// oneNorth draws exactly once.
	if len(tracer.Draws) != 1 || tracer.Draws[0].Method != random.MethodNextFloat {
		t.Fatalf("draws = %v, want exactly one NextFloat", tracer.Draws)
	}
}

// TestMultifaceFeature_NoOpWhenFaceAlreadySet_ZeroDraws proves the "success but zero draws" branch:
// when the accepted face's bit is ALREADY set on the existing block, WithIntState re-derives the
// SAME id (interning determinism), so place() must report success (a valid face was found) WITHOUT
// writing anything new and WITHOUT drawing the chance_of_spreading roll at all -- multiface.go's
// header step 4/5 ("success means found an attach face, not changed the world").
func TestMultifaceFeature_NoOpWhenFaceAlreadySet_ZeroDraws(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)

	oneNorth := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 1}
	// Already has NORTH(16) set -- the exact bit this config's only reachable face would add.
	existingLichen := pal.Get("minecraft:glow_lichen", map[string]block.StateValue{"multi_face_direction_bits": float64(16)})
	v.SetBlock(oneNorth, existingLichen)
	twoNorth := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 2}
	v.SetBlock(twoNorth, stone)

	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on": []any{"minecraft:stone"},
	})

	tracer := random.NewTracer(random.New(1))
	got, failures, _ := placeTestMultiface(f, v, origin, tracer)
	if got == nil {
		t.Fatalf("Place() = nil, want success (failures: %v)", failures)
	}
	if *got != oneNorth {
		t.Fatalf("Place() returned %+v, want %+v", *got, oneNorth)
	}
	if len(tracer.Draws) != 0 {
		t.Fatalf("draws = %v, want NONE -- no-op placement must not roll chance_of_spreading", tracer.Draws)
	}
	// The block must be byte-for-byte unchanged (same id, same bits).
	id := v.GetBlock(oneNorth)
	bits, ok := pal.StateInt(id, block.MultiFaceDirectionBits)
	if !ok || bits != 16 {
		t.Fatalf("multi_face_direction_bits = (%v, %v), want (16, true) -- unchanged", bits, ok)
	}
}

// TestMultifaceFeature_OriginNotAirOrWater_FailsImmediately_NoRNG pins place()'s own step 1: a
// solid origin fails before any direction pool is even built, with zero draws.
func TestMultifaceFeature_OriginNotAirOrWater_FailsImmediately_NoRNG(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(origin, stone)

	f := buildTestMultiface(t, pal, nil)
	tracer := random.NewTracer(random.New(1))
	got, failures, _ := placeTestMultiface(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (origin is solid)", *got)
	}
	if len(failures) != 1 || failures[0] != "Location does not contain air or water" {
		t.Errorf("failures = %v, want [\"Location does not contain air or water\"]", failures)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want none", tracer.Draws)
	}
}

// TestMultifaceFeature_EmptyPool_FailsWithNoAdjacentMessage proves that when all three
// can_place_on_* flags are false (a schema-legal, if useless, config), place() fails with the
// "No adjacent locations" message once origin's own air/water gate passes -- matching the
// game's own empty-pool short-circuit (multiface.go's header, the guarded block write step 2/
// place() step 4).
func TestMultifaceFeature_EmptyPool_FailsWithNoAdjacentMessage(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	f := buildTestMultiface(t, pal, map[string]any{"can_place_on_wall": false})

	tracer := random.NewTracer(random.New(1))
	got, failures, _ := placeTestMultiface(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (empty direction pool)", *got)
	}
	if len(failures) != 1 || failures[0] != "No adjacent locations contain air or water" {
		t.Errorf("failures = %v, want [\"No adjacent locations contain air or water\"]", failures)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want none", tracer.Draws)
	}
}

// TestMultifaceFeature_AllDirectionsFail_NoSupportAnywhere proves total failure when every pool
// direction's neighbor is neither air/water/same-type NOR (for a hypothetically-valid neighbor)
// finds a matching support -- the whole call makes zero draws and zero writes.
func TestMultifaceFeature_AllDirectionsFail_NoSupportAnywhere(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	// Fill every immediate neighbor of origin with a non-matching, non-air, non-glow lichen block so
	// BOTH the origin attempt AND every fallback direction's own neighbor-validity gate fail.
	dirt := pal.Get("minecraft:dirt", nil)
	for _, off := range multifaceFacingOffsets {
		v.SetBlock(wgen.BlockPos{X: origin.X + off.X, Y: origin.Y + off.Y, Z: origin.Z + off.Z}, dirt)
	}

	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on_floor":   true,
		"can_place_on_ceiling": true,
		"can_place_on_wall":    true,
		"can_place_on":         []any{"minecraft:stone"},
	})

	tracer := random.NewTracer(random.New(1))
	got, failures, _ := placeTestMultiface(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil", *got)
	}
	if len(failures) != 1 || failures[0] != "No adjacent locations contain air or water" {
		t.Errorf("failures = %v, want [\"No adjacent locations contain air or water\"]", failures)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want none -- every path failed deterministically", tracer.Draws)
	}
}

// TestMultifaceFeature_SchemaValidation exercises required-ness, range bounds, and the can_place_on
// min-1-entry-when-present rule at build time.
func TestMultifaceFeature_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:multiface", FileID: "test:multiface", Warn: func(string) {}}
	base := func() map[string]any {
		return map[string]any{
			"places_block":         "minecraft:glow_lichen",
			"search_range":         float64(4),
			"can_place_on_floor":   true,
			"can_place_on_ceiling": false,
			"can_place_on_wall":    false,
			"chance_of_spreading":  float64(0.5),
		}
	}

	t.Run("places_block required", func(t *testing.T) {
		b := base()
		delete(b, "places_block")
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("search_range required", func(t *testing.T) {
		b := base()
		delete(b, "search_range")
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("search_range must be in [1,64]", func(t *testing.T) {
		for _, bad := range []float64{0, -1, 65, 1000} {
			b := base()
			b["search_range"] = bad
			if _, err := buildMultifaceFeature(b, ctx); err == nil {
				t.Errorf("search_range=%v: want error, got nil", bad)
			}
		}
		for _, ok := range []float64{1, 64, 32} {
			b := base()
			b["search_range"] = ok
			if _, err := buildMultifaceFeature(b, ctx); err != nil {
				t.Errorf("search_range=%v: want success, got %v", ok, err)
			}
		}
	})
	t.Run("can_place_on_floor required", func(t *testing.T) {
		b := base()
		delete(b, "can_place_on_floor")
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("can_place_on_ceiling required", func(t *testing.T) {
		b := base()
		delete(b, "can_place_on_ceiling")
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("can_place_on_wall required", func(t *testing.T) {
		b := base()
		delete(b, "can_place_on_wall")
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("can_place_on_wall must be a boolean", func(t *testing.T) {
		b := base()
		b["can_place_on_wall"] = "yes"
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("chance_of_spreading required", func(t *testing.T) {
		b := base()
		delete(b, "chance_of_spreading")
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("chance_of_spreading must be in [0,1]", func(t *testing.T) {
		for _, bad := range []float64{-0.1, 1.1, 2} {
			b := base()
			b["chance_of_spreading"] = bad
			if _, err := buildMultifaceFeature(b, ctx); err == nil {
				t.Errorf("chance_of_spreading=%v: want error, got nil", bad)
			}
		}
	})
	t.Run("can_place_on omitted builds (defaults to unrestricted)", func(t *testing.T) {
		if _, err := buildMultifaceFeature(base(), ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
	t.Run("can_place_on must be non-empty when present", func(t *testing.T) {
		b := base()
		b["can_place_on"] = []any{}
		if _, err := buildMultifaceFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("can_place_on with entries builds", func(t *testing.T) {
		b := base()
		b["can_place_on"] = []any{"minecraft:stone", "minecraft:dirt"}
		if _, err := buildMultifaceFeature(b, ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
	t.Run("all three placement flags false builds (a legal, if useless, config)", func(t *testing.T) {
		b := base()
		b["can_place_on_floor"] = false
		if _, err := buildMultifaceFeature(b, ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
}

// TestMultifaceFeature_DirectionPoolOrder pins the exact schema push order this file's header
// documents: Down (floor), Up (ceiling), then North/East/South/West (wall).
func TestMultifaceFeature_DirectionPoolOrder(t *testing.T) {
	pal := block.NewPalette()
	f := buildTestMultiface(t, pal, map[string]any{
		"can_place_on_floor":   true,
		"can_place_on_ceiling": true,
		"can_place_on_wall":    true,
	})
	mf := f.(*MultifaceFeature)
	want := []int{0, 1, 2, 5, 3, 4} // Down, Up, North, East, South, West
	if len(mf.directionPool) != len(want) {
		t.Fatalf("directionPool = %v, want %v", mf.directionPool, want)
	}
	for i, w := range want {
		if mf.directionPool[i] != w {
			t.Errorf("directionPool[%d] = %d, want %d (full: %v)", i, mf.directionPool[i], w, mf.directionPool)
		}
	}
}

// TestMultifaceGetOpposite pins the game's opposite-face lookup (face^1).
func TestMultifaceGetOpposite(t *testing.T) {
	cases := map[int]int{0: 1, 1: 0, 2: 3, 3: 2, 4: 5, 5: 4}
	for face, want := range cases {
		if got := multifaceGetOpposite(face); got != want {
			t.Errorf("multifaceGetOpposite(%d) = %d, want %d", face, got, want)
		}
	}
}

// TestMultifaceShuffledDirectionsExcept pins the filter shape (order-preserving, removes only the
// exact excepted value).
func TestMultifaceShuffledDirectionsExcept(t *testing.T) {
	pool := []int{2, 5, 3, 4}
	got := multifaceShuffledDirectionsExcept(pool, 3)
	want := []int{2, 5, 4}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %d, want %d (full: %v)", i, got[i], want[i], got)
		}
	}
}

// TestMultifaceFeature_BothPlacementPathsShareTheSupportGate pins the fix for a disagreement
// between this type's two placement paths. can_place_on is schema-OPTIONAL and gates nothing when
// omitted, but the worldgen placement derivation has its OWN canProvideMultifaceSupport check
// (block/state.go) that both paths reach. Only the spread path modelled it. With can_place_on
// omitted and all six neighbours air, multifaceBlockForPlacement refused while placeBlockIfPossible
// wrote minecraft:glow_lichen into open air, spent one NextFloat the game would not, and emitted a
// spurious chance_of_spreading warning.
func TestMultifaceFeature_BothPlacementPathsShareTheSupportGate(t *testing.T) {
	v, pal, origin := newMultifaceTestVolume(t)
	f := buildTestMultiface(t, pal, nil).(*MultifaceFeature) // NO can_place_on

	const north = 2 // Facing index for North -- see multifaceFacingOffsets
	if _, ok := f.multifaceBlockForPlacement(v, origin, north); ok {
		t.Fatal("spread path accepted an all-air support neighbour; the harness, not the gate, is broken")
	}

	var warnings []string
	rnd := &multifaceDrawCounter{inner: random.New(1)}
	ctx := &wgen.PlacementContext{
		API: v, Origin: origin, Random: rnd, MolangScope: wgen.NewScope(),
		Biome:      &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogWarning: func(featureType, message string, pos *wgen.BlockPos) { warnings = append(warnings, message) },
	}
	f.placeBlockIfPossible(ctx, v, origin, rnd, []int{north})

	if name := pal.NameOf(v.GetBlock(origin)); name != "minecraft:air" {
		t.Errorf("block at origin = %q, want unchanged air: the support gate must refuse an "+
			"all-air neighbour on the main path exactly as it does on the spread path", name)
	}
	if rnd.draws != 0 {
		t.Errorf("draws = %d, want 0: the chance_of_spreading NextFloat happens only after a real change", rnd.draws)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none", warnings)
	}

	// The same face WITH a solid support block still places, so the gate is not simply refusing
	// everything.
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 1}, stone)
	if _, ok := f.multifaceBlockForPlacement(v, origin, north); !ok {
		t.Fatal("spread path refused a solid support neighbour")
	}
	f.placeBlockIfPossible(ctx, v, origin, rnd, []int{north})
	if name := pal.NameOf(v.GetBlock(origin)); name != "minecraft:glow_lichen" {
		t.Errorf("block at origin = %q, want minecraft:glow_lichen once the face has real support", name)
	}
}

type multifaceDrawCounter struct {
	inner random.IRandom
	draws int
}

func (c *multifaceDrawCounter) NextInt() int32         { c.draws++; return c.inner.NextInt() }
func (c *multifaceDrawCounter) NextIntBound(b int) int { c.draws++; return c.inner.NextIntBound(b) }
func (c *multifaceDrawCounter) NextFloat() float64     { c.draws++; return c.inner.NextFloat() }
func (c *multifaceDrawCounter) NextDouble() float64    { c.draws++; return c.inner.NextDouble() }
func (c *multifaceDrawCounter) NextBoolean() bool      { c.draws++; return c.inner.NextBoolean() }
func (c *multifaceDrawCounter) NextUnsignedInt(n uint32) uint32 {
	c.draws++
	return c.inner.NextUnsignedInt(n)
}
func (c *multifaceDrawCounter) SetSeed(s uint32) { c.inner.SetSeed(s) }
func (c *multifaceDrawCounter) GetSeed() uint32  { return c.inner.GetSeed() }

var _ random.IRandom = (*multifaceDrawCounter)(nil)
