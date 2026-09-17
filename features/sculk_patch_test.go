// sculk_patch_test.go exercises SculkPatchFeature's RNG draw sequence
// explicitly (method + bound, per random.Tracer), not just final block
// counts -- see sculk_patch.go's header for the algorithm this is checking
// against. There is no golden-dump differential coverage for this type,
// so these tests are the only thing standing between a wrong implementation
// and a caller relying on this type.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// newSculkTestVolume builds a 5x5x5 volume centered at origin (2,63,2) --
// large enough to hold the +-2 extra_growth_chance offset scan -- with
// everything air except a stone floor at y=62 directly below origin (the
// "the spread-source test needs a solid neighbor" / "central_block needs solid
// ground" position every test below relies on unless it says otherwise).
func newSculkTestVolume(t *testing.T) (*volume.Volume, *block.Palette, wgen.BlockPos) {
	t.Helper()
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -2, MinY: 58, MinZ: -2, SizeX: 9, SizeY: 9, SizeZ: 9}
	v := volume.New(bounds, pal, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, stone)
	return v, pal, origin
}

func buildTestSculkPatch(t *testing.T, pal *block.Palette, extra map[string]any) wgen.IFeature {
	t.Helper()
	body := map[string]any{
		"can_place_sculk_patch_on": []any{},
		"cursor_count":             float64(0),
		"charge_amount":            float64(1),
		"spread_attempts":          float64(1),
		"growth_rounds":            float64(0),
		"spread_rounds":            float64(0),
	}
	for k, v := range extra {
		body[k] = v
	}
	ctx := &BuildContext{Palette: pal, Identifier: "test:sculk", FileID: "test:sculk", Warn: func(string) {}}
	f, err := buildSculkPatchFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildSculkPatchFeature: %v", err)
	}
	return f
}

func placeTestSculkPatch(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) *wgen.BlockPos {
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
	return f.Place(ctx)
}

// TestSculkPatchFeature_GateRefusesSolidOrigin_ZeroDraws: the spread-source test's
// origin check is the FIRST thing place() does, before any RNG -- an origin
// that is neither air, water, nor sculk/sculk_vein must refuse without
// drawing anything, regardless of the six neighbors.
func TestSculkPatchFeature_GateRefusesSolidOrigin_ZeroDraws(t *testing.T) {
	v, pal, origin := newSculkTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(origin, stone) // origin itself solid, not air/water/sculk
	f := buildTestSculkPatch(t, pal, nil)

	tracer := random.NewTracer(random.New(1))
	got := placeTestSculkPatch(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (solid origin must refuse)", got)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want none -- the gate must fail before any RNG call", tracer.Draws)
	}
}

// TestSculkPatchFeature_GateRefusesWithNoSolidNeighbor_ZeroDraws: origin is
// air (passes the origin check) but every one of the six neighbors is also
// air -- with an empty can_place_sculk_patch_on list this falls back to
// "any neighbor solid", which none are, so the gate must still refuse before
// any RNG.
func TestSculkPatchFeature_GateRefusesWithNoSolidNeighbor_ZeroDraws(t *testing.T) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -2, MinY: 58, MinZ: -2, SizeX: 9, SizeY: 9, SizeZ: 9}
	v := volume.New(bounds, pal, block.AirID) // all air, no stone floor
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	f := buildTestSculkPatch(t, pal, nil)

	tracer := random.NewTracer(random.New(1))
	got := placeTestSculkPatch(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (no solid neighbor)", got)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want none", tracer.Draws)
	}
}

// TestSculkPatchFeature_NonEmptyCanPlaceOn_RequiresListMatch_NotJustSolid:
// once can_place_sculk_patch_on is non-empty, a merely-solid neighbor that
// is NOT in the list must not satisfy the gate (this is the branch
// the spread-source test's block-descriptor list match covers, distinct
// from the empty-list `isSolid` fallback).
func TestSculkPatchFeature_NonEmptyCanPlaceOn_RequiresListMatch_NotJustSolid(t *testing.T) {
	v, pal, origin := newSculkTestVolume(t) // stone floor below origin
	f := buildTestSculkPatch(t, pal, map[string]any{
		"can_place_sculk_patch_on": []any{"minecraft:dirt"}, // stone is NOT dirt
	})

	got := placeTestSculkPatch(f, v, origin, random.New(1))
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (stone floor does not match a can_place_sculk_patch_on=[dirt] list)", got)
	}

	// Now make the floor dirt -- same list, should now pass the gate.
	dirt := pal.Get("minecraft:dirt", nil)
	v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, dirt)
	if got := placeTestSculkPatch(f, v, origin, random.New(1)); got == nil {
		t.Fatal("Place() = nil, want success once the floor matches can_place_sculk_patch_on")
	}
}

// TestSculkPatchFeature_CentralBlockGate_AlwaysDrawsExactlyOneFloat proves
// the central_block_placement_chance roll is UNCONDITIONAL: even with no
// central_block configured and no extra_growth_chance, place() still draws
// exactly one NextFloat -- never zero, never more.
func TestSculkPatchFeature_CentralBlockGate_AlwaysDrawsExactlyOneFloat(t *testing.T) {
	v, pal, origin := newSculkTestVolume(t)
	f := buildTestSculkPatch(t, pal, nil) // no central_block, no extra_growth_chance

	tracer := random.NewTracer(random.New(1))
	got := placeTestSculkPatch(f, v, origin, tracer)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if len(tracer.Draws) != 1 {
		t.Fatalf("draws = %v, want exactly 1 (the unconditional central_block_placement_chance roll)", tracer.Draws)
	}
	if tracer.Draws[0].Method != random.MethodNextFloat {
		t.Errorf("draw[0].Method = %v, want NextFloat", tracer.Draws[0].Method)
	}
}

// TestSculkPatchFeature_CentralBlockPlaced_WhenRollSucceedsAndGroundSolid
// pins the roll's comparison direction (roll <= chance) and the exact
// position placed (origin, not origin-1) -- an explicit chance=1.0 makes any
// draw in [0,1) satisfy roll<=1.0, so this is deterministic regardless of
// seed. (chance must now be explicit: the schema default is 0.0, not 1.0
// -- see the default test below.)
func TestSculkPatchFeature_CentralBlockPlaced_WhenRollSucceedsAndGroundSolid(t *testing.T) {
	v, pal, origin := newSculkTestVolume(t)
	f := buildTestSculkPatch(t, pal, map[string]any{
		"central_block":                  "minecraft:amethyst_block",
		"central_block_placement_chance": float64(1.0),
	})

	got := placeTestSculkPatch(f, v, origin, random.New(1))
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if name := pal.NameOf(v.GetBlock(origin)); name != "minecraft:amethyst_block" {
		t.Errorf("block at origin = %q, want minecraft:amethyst_block", name)
	}
}

// TestSculkPatchFeature_CentralBlockChanceDefaultsToZero pins the
// schema default for central_block_placement_chance: 0.0, not 1.0. As
// sculk_patch.go's header sets out, the feature's chance float starts at 0.0
// and the schema declares no default to overwrite it. With
// chance=0.0 the unconditional roll still happens (pinned elsewhere), but
// roll <= 0.0 fails for every NextFloat() draw except an exact 0.0, so
// central_block must NOT be placed here despite being configured and the
// ground being solid.
func TestSculkPatchFeature_CentralBlockChanceDefaultsToZero(t *testing.T) {
	v, pal, origin := newSculkTestVolume(t)
	f := buildTestSculkPatch(t, pal, map[string]any{"central_block": "minecraft:amethyst_block"})

	// Find a seed whose first NextFloat() is nonzero (any sane seed; guard
	// against the astronomically unlikely exact-0.0 draw anyway).
	rnd := random.New(1)
	if probe := random.New(1); probe.NextFloat() == 0.0 {
		t.Skip("seed 1's first NextFloat() is exactly 0.0 -- pick another seed")
	}
	got := placeTestSculkPatch(f, v, origin, rnd)
	if got == nil {
		t.Fatal("Place() = nil, want success (the gate does not depend on the chance)")
	}
	if name := pal.NameOf(v.GetBlock(origin)); name == "minecraft:amethyst_block" {
		t.Errorf("central block WAS placed at origin with the field absent -- default must be 0.0 (roll <= 0.0 fails), not 1.0")
	}
}

// TestSculkPatchFeature_CentralBlockNotPlaced_WhenGroundNotSolid: even with
// an explicit chance 1.0 and central_block configured, an unsupported ground
// (air below origin) must skip the placement -- the solid-ground check gates
// the SAME unconditional roll, it does not skip the roll itself.
func TestSculkPatchFeature_CentralBlockNotPlaced_WhenGroundNotSolid(t *testing.T) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -2, MinY: 58, MinZ: -2, SizeX: 9, SizeY: 9, SizeZ: 9}
	v := volume.New(bounds, pal, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	// Gate needs a solid neighbor to pass at all -- use a non-empty
	// can_place_sculk_patch_on so a non-adjacent-to-central-block-check
	// neighbor (north) can satisfy it while the ground stays air.
	north := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z - 1}
	dirt := pal.Get("minecraft:dirt", nil)
	v.SetBlock(north, dirt)
	f := buildTestSculkPatch(t, pal, map[string]any{
		"can_place_sculk_patch_on":       []any{"minecraft:dirt"},
		"central_block":                  "minecraft:amethyst_block",
		"central_block_placement_chance": float64(1.0),
	})

	got := placeTestSculkPatch(f, v, origin, random.New(1))
	if got == nil {
		t.Fatal("Place() = nil, want success (gate passes via the north dirt neighbor)")
	}
	if !pal.IsAir(v.GetBlock(origin)) {
		t.Errorf("block at origin = %q, want unchanged (air) -- ground below origin is air, not solid", pal.NameOf(v.GetBlock(origin)))
	}
}

// TestSculkPatchFeature_ExtraGrowthChance_DrawSequence pins the FULL draw
// sequence for a non-degenerate extra_growth_chance: one NextIntBound(1)
// for the count draw (a two-argument integer draw of (2,3) -- bound =
// max-min = 1, so the drawn count is deterministically 2, matching
// sculkRandomNextInt's formula), then exactly 2 more draws (NextIntBound(5) for dx,
// dz) per iteration, in that order -- 1 + 2*2 = 5 extra-growth draws, plus
// the always-present central_block_placement_chance NextFloat = 6 total.
func TestSculkPatchFeature_ExtraGrowthChance_DrawSequence(t *testing.T) {
	v, pal, origin := newSculkTestVolume(t)
	f := buildTestSculkPatch(t, pal, map[string]any{
		"extra_growth_chance": []any{float64(2), float64(3)}, // [min,max) -> count always 2
	})

	tracer := random.NewTracer(random.New(1))
	got := placeTestSculkPatch(f, v, origin, tracer)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantMethods := []random.Method{
		random.MethodNextFloat,    // central_block_placement_chance roll
		random.MethodNextIntBound, // extra_growth_chance count draw
		random.MethodNextIntBound, // iteration 0 dx
		random.MethodNextIntBound, // iteration 0 dz
		random.MethodNextIntBound, // iteration 1 dx
		random.MethodNextIntBound, // iteration 1 dz
	}
	if len(tracer.Draws) != len(wantMethods) {
		t.Fatalf("draws = %v (%d), want %d draws matching %v", tracer.Draws, len(tracer.Draws), len(wantMethods), wantMethods)
	}
	for i, want := range wantMethods {
		if tracer.Draws[i].Method != want {
			t.Errorf("draw[%d].Method = %v, want %v", i, tracer.Draws[i].Method, want)
		}
	}
	// The count draw's bound must be exactly max-min=1 (the two-argument
	// integer draw's own formula -- see sculk_patch.go header), and each dx/dz draw's
	// bound must be exactly 5 (the fixed -2..2 jitter range).
	if tracer.Draws[1].Bound != 1 {
		t.Errorf("count draw bound = %d, want 1 (max-min for [2,3))", tracer.Draws[1].Bound)
	}
	for i := 2; i < 6; i++ {
		if tracer.Draws[i].Bound != 5 {
			t.Errorf("draw[%d] bound = %d, want 5", i, tracer.Draws[i].Bound)
		}
	}
}

// TestSculkPatchFeature_ExtraGrowthChance_PlacesAtExactPredictedOffsets
// independently replays the SAME seed-1 draw stream Place() itself would
// issue (NextFloat, then NextIntBound(1) for the count, then dx/dz pairs)
// to predict exactly which offsets a sculk_shrieker should land at, then
// checks the real world state against that prediction position-by-position.
// This is deliberately stronger than
// TestSculkPatchFeature_ExtraGrowthChance_DrawSequence's method/bound-only
// check: dx and dz share the same bound (5) and method
// (NextIntBound), so a bug that swapped their draw order would still pass
// that test's method/bound sequence but would place blocks at the wrong
// (transposed) offsets -- which this test catches by comparing actual
// positions, not just the shape of the draw log.
func TestSculkPatchFeature_ExtraGrowthChance_PlacesAtExactPredictedOffsets(t *testing.T) {
	// Predict: draw from a completely independent Rand instance, seeded
	// identically to the one Place() below will use, replaying the exact
	// same call sequence Place() is documented to make (see sculk_patch.go
	// header steps 3-4).
	predictor := random.New(1)
	predictor.NextFloat()                  // central_block_placement_chance roll (step 3)
	count := predictor.NextIntBound(1) + 2 // extra_growth_chance count draw, [2,3) -> 2 + {0} = 2
	type offset struct{ dx, dz int }
	predicted := make(map[offset]bool, count)
	for i := 0; i < count; i++ {
		dx := predictor.NextIntBound(5) - 2
		dz := predictor.NextIntBound(5) - 2
		predicted[offset{dx, dz}] = true
	}
	if len(predicted) == 0 {
		t.Fatal("test setup bug: predicted zero offsets")
	}

	// Build a volume with a FULL solid floor under the whole scan area (not
	// just below origin) so every predicted candidate cell is eligible for
	// placement regardless of which offset it lands on.
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -3, MinY: 58, MinZ: -3, SizeX: 9, SizeY: 9, SizeZ: 9}
	v := volume.New(bounds, pal, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	for dx := -2; dx <= 2; dx++ {
		for dz := -2; dz <= 2; dz++ {
			v.SetBlock(wgen.BlockPos{X: origin.X + dx, Y: origin.Y - 1, Z: origin.Z + dz}, stone)
		}
	}
	f := buildTestSculkPatch(t, pal, map[string]any{
		"extra_growth_chance": []any{float64(2), float64(3)},
	})

	if got := placeTestSculkPatch(f, v, origin, random.New(1)); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	shriekerName := "minecraft:sculk_shrieker"
	for dx := -2; dx <= 2; dx++ {
		for dz := -2; dz <= 2; dz++ {
			pos := wgen.BlockPos{X: origin.X + dx, Y: origin.Y, Z: origin.Z + dz}
			isShrieker := pal.NameOf(v.GetBlock(pos)) == shriekerName
			wantShrieker := predicted[offset{dx, dz}]
			if isShrieker != wantShrieker {
				t.Errorf("offset (%d,%d): shrieker placed = %v, want %v (predicted offsets: %v)", dx, dz, isShrieker, wantShrieker, predicted)
			}
		}
	}
}

// TestSculkPatchFeature_ExtraGrowthChance_AbsentDrawsNothingExtra: with no
// extra_growth_chance key at all, the field is {0,0} (zero iterations)
// (see sculk_patch.go's header) -- which per the two-argument integer draw's
// own contract (max <= min -> return min, NO draw) means the only
// extra draw beyond the mandatory central_block gate is none at all.
func TestSculkPatchFeature_ExtraGrowthChance_AbsentDrawsNothingExtra(t *testing.T) {
	v, pal, origin := newSculkTestVolume(t)
	f := buildTestSculkPatch(t, pal, nil)

	tracer := random.NewTracer(random.New(1))
	if got := placeTestSculkPatch(f, v, origin, tracer); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if len(tracer.Draws) != 1 {
		t.Fatalf("draws = %v, want exactly 1 (only the central_block gate)", tracer.Draws)
	}
}

// TestSculkPatchFeature_RefusesCursorDrivenSpread proves the build-time
// refusal fires exactly when growth_rounds+spread_rounds>=1 AND
// cursor_count>=1 AND spread_attempts>=1 -- the one combination where
// the sculk spreader's unimplemented cursor-movement simulation would
// actually run (see sculk_patch.go header).
func TestSculkPatchFeature_RefusesCursorDrivenSpread(t *testing.T) {
	pal := block.NewPalette()
	body := map[string]any{
		"can_place_sculk_patch_on": []any{},
		"cursor_count":             float64(1),
		"charge_amount":            float64(1),
		"spread_attempts":          float64(1),
		"growth_rounds":            float64(1),
		"spread_rounds":            float64(0),
	}
	ctx := &BuildContext{Palette: pal, Identifier: "test:sculk", FileID: "test:sculk", Warn: func(string) {}}
	_, err := buildSculkPatchFeature(body, ctx)
	if err == nil {
		t.Fatal("buildSculkPatchFeature succeeded, want a refusal (cursor_count/spread_attempts/growth_rounds all >= 1)")
	}
	// Checks that the refusal explains itself and offers the way out, in terms a pack author
	// can act on.
	for _, want := range []string{"not supported by this tool", "cursor_count=0"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to contain %q so the author knows what to do", err.Error(), want)
		}
	}

	// cursor_count=0 must let it build successfully (spread_attempts is
	// itself schema-required to be >= 1 -- see TestSculkPatchFeature_
	// SchemaValidation -- so it can never legitimately be the zeroed
	// factor in a valid body; only cursor_count and growth_rounds+
	// spread_rounds can).
	b2 := map[string]any{}
	for k, v := range body {
		b2[k] = v
	}
	b2["cursor_count"] = float64(0)
	if _, err := buildSculkPatchFeature(b2, ctx); err != nil {
		t.Errorf("buildSculkPatchFeature with cursor_count=0 failed: %v", err)
	}

	// growth_rounds=spread_rounds=0 must also let it build successfully.
	b3 := map[string]any{}
	for k, v := range body {
		b3[k] = v
	}
	b3["growth_rounds"] = float64(0)
	b3["spread_rounds"] = float64(0)
	if _, err := buildSculkPatchFeature(b3, ctx); err != nil {
		t.Errorf("buildSculkPatchFeature with growth_rounds=spread_rounds=0 failed: %v", err)
	}
}

// TestSculkPatchFeature_SchemaValidation exercises the game's own schema
// bounds (and required-ness) at build time.
func TestSculkPatchFeature_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:sculk", FileID: "test:sculk", Warn: func(string) {}}
	base := func() map[string]any {
		return map[string]any{
			"can_place_sculk_patch_on": []any{},
			"cursor_count":             float64(0),
			"charge_amount":            float64(1),
			"spread_attempts":          float64(1),
			"growth_rounds":            float64(0),
			"spread_rounds":            float64(0),
		}
	}

	t.Run("can_place_sculk_patch_on required", func(t *testing.T) {
		b := base()
		delete(b, "can_place_sculk_patch_on")
		if _, err := buildSculkPatchFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("cursor_count out of range", func(t *testing.T) {
		b := base()
		b["cursor_count"] = float64(33) // the game's own bound is [0,32]
		if _, err := buildSculkPatchFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("charge_amount out of range", func(t *testing.T) {
		b := base()
		b["charge_amount"] = float64(1001) // the game's own bound is [1,1000]
		if _, err := buildSculkPatchFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("spread_attempts out of range", func(t *testing.T) {
		b := base()
		b["spread_attempts"] = float64(5) // the game's own bound is [1,4]
		if _, err := buildSculkPatchFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("central_block_placement_chance out of range", func(t *testing.T) {
		b := base()
		b["central_block_placement_chance"] = float64(1.5)
		if _, err := buildSculkPatchFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("valid body builds", func(t *testing.T) {
		if _, err := buildSculkPatchFeature(base(), ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
}
