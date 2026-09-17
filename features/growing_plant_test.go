// growing_plant_test.go exercises GrowingPlantFeature's RNG draw sequence
// explicitly (method + count, per random.Tracer), the per-layer walk's
// confirmed skip/fail asymmetry, and age state derivation -- not just
// final block counts. No golden regression scene exercises this type, so
// these tests are the only thing standing between a wrong port and a caller relying on this
// type. See growing_plant.go's header for the algorithm this is checking.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// newGrowingPlantTestVolume builds a tall, all-air volume centered on origin
// (0,63,0) with enough headroom in both directions for multi-layer columns.
func newGrowingPlantTestVolume(t *testing.T) (*volume.Volume, *block.Palette, wgen.BlockPos) {
	t.Helper()
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -2, MinY: 50, MinZ: -2, SizeX: 5, SizeY: 30, SizeZ: 5}
	v := volume.New(bounds, pal, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	return v, pal, origin
}

func buildTestGrowingPlant(t *testing.T, pal *block.Palette, extra map[string]any) wgen.IFeature {
	t.Helper()
	body := map[string]any{
		"height_distribution": []any{[]any{float64(3), float64(1)}},
		"growth_direction":    "up",
		"body_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
		"head_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
	}
	for k, v := range extra {
		body[k] = v
	}
	ctx := &BuildContext{Palette: pal, Identifier: "test:growing_plant", FileID: "test:growing_plant", Warn: func(string) {}}
	f, err := buildGrowingPlantFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildGrowingPlantFeature: %v", err)
	}
	return f
}

func placeTestGrowingPlant(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) (*wgen.BlockPos, []string) {
	var failures []string
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {
			failures = append(failures, message)
		},
	}
	return f.Place(ctx), failures
}

// TestGrowingPlantFeature_DrawSequence_AllDegenerate pins the FULL draw
// sequence for height=3 (a single, degenerate height_distribution entry) and
// single-entry body_blocks/head_blocks: height_distribution's own weighted
// pick (1 draw, since its total is nonzero), then the height and age
// int-range draws (both degenerate, 0 draws each -- see
// growing_plant.go header steps 2-3), then one weighted-pick draw per
// body layer placed (i=0,1) and one more for the head (i=2, the final
// layer) -- 4 draws total, in that exact order.
//
// Every one of them is a bounded integer draw of the total, NOT a float draw:
// that is what the weighted-pick shape does (see shared.go's WeightedPick
// doc comment).
func TestGrowingPlantFeature_DrawSequence_AllDegenerate(t *testing.T) {
	v, pal, origin := newGrowingPlantTestVolume(t)
	f := buildTestGrowingPlant(t, pal, nil) // height_distribution: [[3,1]] -> height always 3

	tracer := random.NewTracer(random.New(1))
	got, failures := placeTestGrowingPlant(f, v, origin, tracer)
	if got == nil {
		t.Fatalf("Place() = nil, want success (failures: %v)", failures)
	}
	if len(tracer.Draws) != 4 {
		t.Fatalf("draws = %v (%d), want exactly 4", tracer.Draws, len(tracer.Draws))
	}
	for i, d := range tracer.Draws {
		if d.Method != random.MethodNextIntBound {
			t.Errorf("draw[%d].Method = %v, want NextIntBound (weighted pick = nextInt(total))", i, d.Method)
		}
	}

	// Head must land at the top layer (origin.Y+2), body at the two layers
	// below it.
	vinesName := "minecraft:weeping_vines"
	for y := 0; y <= 2; y++ {
		pos := wgen.BlockPos{X: origin.X, Y: origin.Y + y, Z: origin.Z}
		if name := pal.NameOf(v.GetBlock(pos)); name != vinesName {
			t.Errorf("block at y=+%d = %q, want %q", y, name, vinesName)
		}
	}
	if got.Y != origin.Y+2 {
		t.Errorf("Place() returned Y=%d, want %d (the head position)", got.Y, origin.Y+2)
	}
}

// TestGrowingPlantFeature_HeightDraw_NonDegenerate_DrawsNextIntBound proves
// a non-degenerate height_distribution entry (min < max-1) makes the height
// draw take treeIntRangeValue's NextIntBound branch, with bound == max-min
// exactly (the SAME int-range draw formula tree.go uses -- see
// growing_plant.go's header).
func TestGrowingPlantFeature_HeightDraw_NonDegenerate_DrawsNextIntBound(t *testing.T) {
	v, pal, origin := newGrowingPlantTestVolume(t)
	f := buildTestGrowingPlant(t, pal, map[string]any{
		"height_distribution": []any{[]any{[]any{float64(1), float64(6)}, float64(1)}}, // range {1,6}
	})

	tracer := random.NewTracer(random.New(1))
	got, failures := placeTestGrowingPlant(f, v, origin, tracer)
	if got == nil {
		t.Fatalf("Place() = nil, want success (failures: %v)", failures)
	}
	if len(tracer.Draws) < 2 {
		t.Fatalf("draws = %v, want at least 2 (height_distribution pick + height value)", tracer.Draws)
	}
	if tracer.Draws[0].Method != random.MethodNextIntBound {
		t.Errorf("draw[0].Method = %v, want NextIntBound (height_distribution weighted pick)", tracer.Draws[0].Method)
	}
	if tracer.Draws[1].Method != random.MethodNextIntBound {
		t.Errorf("draw[1].Method = %v, want NextIntBound (height value, non-degenerate range {1,6})", tracer.Draws[1].Method)
	}
	if tracer.Draws[1].Bound != 5 { // max-min = 6-1 = 5
		t.Errorf("draw[1].Bound = %d, want 5 (max-min for range {1,6})", tracer.Draws[1].Bound)
	}
}

// TestGrowingPlantFeature_HeightBelowOne_FailsWithOneDraw proves a height<1
// result fails immediately with the correct message, having drawn only the
// height_distribution pick (the degenerate height and age int-range draws
// contribute zero) -- no per-layer work happens at all.
func TestGrowingPlantFeature_HeightBelowOne_FailsWithOneDraw(t *testing.T) {
	v, pal, origin := newGrowingPlantTestVolume(t)
	f := buildTestGrowingPlant(t, pal, map[string]any{
		"height_distribution": []any{[]any{float64(0), float64(1)}}, // height always 0
	})

	tracer := random.NewTracer(random.New(1))
	got, failures := placeTestGrowingPlant(f, v, origin, tracer)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (height 0 must fail)", got)
	}
	if len(tracer.Draws) != 1 {
		t.Fatalf("draws = %v, want exactly 1 (only the height_distribution pick)", tracer.Draws)
	}
	if len(failures) != 1 || failures[0] != "No air blocks at target location" {
		t.Errorf("failures = %v, want [\"No air blocks at target location\"]", failures)
	}
}

// TestGrowingPlantFeature_OriginObstruction_SilentlySkipped: a solid block
// AT THE ORIGIN LAYER (i=0) -- the one layer no earlier iteration's peek
// (step 5c) could have already caught -- is silently skipped rather than
// failing the call outright, and growth still succeeds using the clear
// layers above it. This is the only layer where the "skip, don't break"
// path (step 5b) is directly observable in isolation: for any i>0, the
// PRECEDING iteration's own peek (5c) already examined that exact position,
// so an obstruction there converts into an early successful break one layer
// sooner, rather than ever reaching that layer's own positionOk check as a
// skip. See growing_plant.go header step 6 for the full derivation of why a
// single valid layer anywhere guarantees eventual success.
func TestGrowingPlantFeature_OriginObstruction_SilentlySkipped(t *testing.T) {
	v, pal, origin := newGrowingPlantTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(origin, stone) // obstructs layer i=0 only; layers 1,2 stay air

	f := buildTestGrowingPlant(t, pal, nil) // height always 3

	got, failures := placeTestGrowingPlant(f, v, origin, random.New(1))
	if got == nil {
		t.Fatalf("Place() = nil, want success (origin obstruction must not fail the call); failures: %v", failures)
	}
	if len(failures) != 0 {
		t.Errorf("failures = %v, want none", failures)
	}
	// The origin (the obstruction) must remain stone, untouched.
	if name := pal.NameOf(v.GetBlock(origin)); name != "minecraft:stone" {
		t.Errorf("block at origin = %q, want unchanged minecraft:stone", name)
	}
	// Layer 1 (body) and layer 2 (head) must both be placed, having grown
	// past the skipped origin layer.
	vinesName := "minecraft:weeping_vines"
	for _, y := range []int{1, 2} {
		pos := wgen.BlockPos{X: origin.X, Y: origin.Y + y, Z: origin.Z}
		if name := pal.NameOf(v.GetBlock(pos)); name != vinesName {
			t.Errorf("block at y=+%d = %q, want %q", y, name, vinesName)
		}
	}
}

// TestGrowingPlantFeature_EntireColumnObstructed_Fails: per growing_plant.go
// header step 6, failure requires EVERY configured layer to be unplaceable
// -- a single clear layer anywhere always leads to eventual success (caught
// by that layer's own break-check). This test obstructs all three
// configured layers to exercise the one genuine failure path, and confirms
// nothing gets placed anywhere in the column.
func TestGrowingPlantFeature_EntireColumnObstructed_Fails(t *testing.T) {
	v, pal, origin := newGrowingPlantTestVolume(t)
	stone := pal.Get("minecraft:stone", nil)
	for _, y := range []int{0, 1, 2} {
		v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y + y, Z: origin.Z}, stone)
	}

	f := buildTestGrowingPlant(t, pal, nil) // height always 3

	got, failures := placeTestGrowingPlant(f, v, origin, random.New(1))
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (every configured layer is obstructed)", got)
	}
	if len(failures) != 1 || failures[0] != "No air blocks at target location" {
		t.Errorf("failures = %v, want [\"No air blocks at target location\"]", failures)
	}
	// Every layer must remain stone, never overwritten.
	for _, y := range []int{0, 1, 2} {
		pos := wgen.BlockPos{X: origin.X, Y: origin.Y + y, Z: origin.Z}
		if name := pal.NameOf(v.GetBlock(pos)); name != "minecraft:stone" {
			t.Errorf("block at y=+%d = %q, want unchanged minecraft:stone", y, name)
		}
	}
}

// TestGrowingPlantFeature_GrowthDirectionDown proves growth_direction="down"
// grows in -Y, not +Y.
func TestGrowingPlantFeature_GrowthDirectionDown(t *testing.T) {
	v, pal, origin := newGrowingPlantTestVolume(t)
	f := buildTestGrowingPlant(t, pal, map[string]any{"growth_direction": "down"})

	got, failures := placeTestGrowingPlant(f, v, origin, random.New(1))
	if got == nil {
		t.Fatalf("Place() = nil, want success (failures: %v)", failures)
	}
	if got.Y != origin.Y-2 {
		t.Errorf("Place() returned Y=%d, want %d (head 2 layers below origin)", got.Y, origin.Y-2)
	}
	vinesName := "minecraft:weeping_vines"
	for y := 0; y >= -2; y-- {
		pos := wgen.BlockPos{X: origin.X, Y: origin.Y + y, Z: origin.Z}
		if name := pal.NameOf(v.GetBlock(pos)); name != vinesName {
			t.Errorf("block at y=%+d = %q, want %q", y, name, vinesName)
		}
	}
}

// TestGrowingPlantFeature_AllowWater_PermitsWaterPositions: with
// allow_water=true, a water-filled position is treated as valid (matching
// air); with allow_water=false (default), the same water position fails the
// column outright.
func TestGrowingPlantFeature_AllowWater_PermitsWaterPositions(t *testing.T) {
	pal := block.NewPalette()
	water := pal.Get("minecraft:water", nil)

	waterColumn := func(t *testing.T) (*volume.Volume, wgen.BlockPos) {
		t.Helper()
		bounds := volume.Bounds{MinX: -2, MinY: 50, MinZ: -2, SizeX: 5, SizeY: 30, SizeZ: 5}
		v := volume.New(bounds, pal, block.AirID)
		origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
		for _, y := range []int{0, 1, 2} { // every layer of the (always height=3) column
			v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y + y, Z: origin.Z}, water)
		}
		return v, origin
	}

	t.Run("allow_water=true succeeds through water", func(t *testing.T) {
		v, origin := waterColumn(t)
		f := buildTestGrowingPlant(t, pal, map[string]any{"allow_water": true})

		got, failures := placeTestGrowingPlant(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("Place() = nil, want success through water (failures: %v)", failures)
		}
	})

	t.Run("allow_water=false fails through water", func(t *testing.T) {
		v, origin := waterColumn(t)
		f := buildTestGrowingPlant(t, pal, nil) // allow_water defaults false

		got, failures := placeTestGrowingPlant(f, v, origin, random.New(1))
		if got != nil {
			t.Fatalf("Place() = %+v, want nil (water is not air and allow_water is false)", got)
		}
		if len(failures) != 1 || failures[0] != "No air blocks at target location" {
			t.Errorf("failures = %v, want [\"No air blocks at target location\"] (allow_water=false message)", failures)
		}
	})
}

// TestGrowingPlantFeature_AcceptsNonZeroAgeForAnyHead pins removal of the
// stale build-time block-name gate. State derivation is a runtime attempt;
// configuration acceptance does not depend on a cave-vines allowlist.
func TestGrowingPlantFeature_AcceptsNonZeroAgeForAnyHead(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:growing_plant", FileID: "test:growing_plant", Warn: func(string) {}}
	base := func() map[string]any {
		return map[string]any{
			"height_distribution": []any{[]any{float64(3), float64(1)}},
			"growth_direction":    "up",
			"body_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
			"head_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
		}
	}

	t.Run("age with nonzero max and non-cave-vines head builds", func(t *testing.T) {
		b := base()
		b["age"] = []any{float64(0), float64(25)}
		if _, err := buildGrowingPlantFeature(b, ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})

	t.Run("age with nonzero max and cave-vines head builds", func(t *testing.T) {
		b := base()
		b["age"] = []any{float64(0), float64(25)}
		b["head_blocks"] = []any{[]any{"minecraft:cave_vines", float64(1)}}
		if _, err := buildGrowingPlantFeature(b, ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})

	t.Run("age with zero max builds", func(t *testing.T) {
		b := base()
		b["age"] = []any{float64(0), float64(0)}
		if _, err := buildGrowingPlantFeature(b, ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})

	t.Run("age absent builds", func(t *testing.T) {
		if _, err := buildGrowingPlantFeature(base(), ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
}

// TestGrowingPlantFeature_AgeInjection pins the age-injection semantics --
// see growing_plant.go's "Age injection" header section:
//
//   - a degenerate nonzero age {N,N} (0 draws) with a cave-vines head
//     places the head block with growing_plant_age=N (N < 26 splices);
//   - a degenerate age {30,30} -- >= ValueCount 26 -- places the head
//     block UNCHANGED (the game's state-write-fails -> use-picked-block path);
//   - a non-degenerate age {2,7} consumes exactly one extra NextIntBound(5)
//     draw between the height draw and the layer walk (step 3,
//     the int-range draw's bound = max-min).
func TestGrowingPlantFeature_AgeInjection(t *testing.T) {
	head := []any{[]any{"minecraft:cave_vines", float64(1)}}

	t.Run("in-range age splices state onto head block", func(t *testing.T) {
		v, pal, origin := newGrowingPlantTestVolume(t)
		f := buildTestGrowingPlant(t, pal, map[string]any{
			"age":         []any{float64(5), float64(5)},
			"head_blocks": head,
		})
		got, failures := placeTestGrowingPlant(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("place failed: %v", failures)
		}
		id := v.GetBlock(*got)
		if name := pal.Entry(id).Name; name != "minecraft:cave_vines" {
			t.Fatalf("head block = %q, want minecraft:cave_vines", name)
		}
		age, ok := pal.StateInt(id, block.GrowingPlantAge)
		if !ok || age != 5 {
			t.Errorf("growing_plant_age = %d (present=%v), want 5", age, ok)
		}
	})

	t.Run("out-of-range age places head block unchanged", func(t *testing.T) {
		v, pal, origin := newGrowingPlantTestVolume(t)
		f := buildTestGrowingPlant(t, pal, map[string]any{
			"age":         []any{float64(30), float64(30)}, // >= ValueCount 26
			"head_blocks": head,
		})
		got, failures := placeTestGrowingPlant(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("place failed: %v", failures)
		}
		id := v.GetBlock(*got)
		if _, ok := pal.StateInt(id, block.GrowingPlantAge); ok {
			t.Errorf("growing_plant_age unexpectedly present -- the game rejects value >= 26 and keeps the picked block unchanged")
		}
	})

	t.Run("non-degenerate age pins the complete draw sequence", func(t *testing.T) {
		v, pal, origin := newGrowingPlantTestVolume(t)
		f := buildTestGrowingPlant(t, pal, map[string]any{
			"age":         []any{float64(2), float64(7)},
			"head_blocks": head,
		})
		tracer := random.NewTracer(random.New(1))
		if got, failures := placeTestGrowingPlant(f, v, origin, tracer); got == nil {
			t.Fatalf("place failed: %v", failures)
		}
		wantMethods := []random.Method{
			random.MethodNextIntBound, // height_distribution weighted pick
			random.MethodNextIntBound, // age range {2,7}
			random.MethodNextIntBound, // body i=0 weighted pick
			random.MethodNextIntBound, // body i=1 weighted pick
			random.MethodNextIntBound, // head weighted pick
		}
		if len(tracer.Draws) != len(wantMethods) {
			t.Fatalf("draws = %v (%d), want exactly %d", tracer.Draws, len(tracer.Draws), len(wantMethods))
		}
		for i, want := range wantMethods {
			if got := tracer.Draws[i].Method; got != want {
				t.Errorf("draw[%d].Method = %v, want %v; full draws: %v", i, got, want, tracer.Draws)
			}
		}
		if got := tracer.Draws[1].Bound; got != 5 {
			t.Errorf("draw[1].Bound = %d, want 5 (age max-min)", got)
		}
	})
}

// TestGrowingPlantFeature_SchemaValidation exercises required-ness and
// minimum-entry-count validation at build time.
func TestGrowingPlantFeature_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:growing_plant", FileID: "test:growing_plant", Warn: func(string) {}}
	base := func() map[string]any {
		return map[string]any{
			"height_distribution": []any{[]any{float64(3), float64(1)}},
			"growth_direction":    "up",
			"body_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
			"head_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
		}
	}

	t.Run("height_distribution required", func(t *testing.T) {
		b := base()
		delete(b, "height_distribution")
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("height_distribution must be non-empty", func(t *testing.T) {
		b := base()
		b["height_distribution"] = []any{}
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("growth_direction required", func(t *testing.T) {
		b := base()
		delete(b, "growth_direction")
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("growth_direction must be up or down", func(t *testing.T) {
		b := base()
		b["growth_direction"] = "sideways"
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("body_blocks required", func(t *testing.T) {
		b := base()
		delete(b, "body_blocks")
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("body_blocks must be non-empty", func(t *testing.T) {
		b := base()
		b["body_blocks"] = []any{}
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("head_blocks required", func(t *testing.T) {
		b := base()
		delete(b, "head_blocks")
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("head_blocks must be non-empty", func(t *testing.T) {
		b := base()
		b["head_blocks"] = []any{}
		if _, err := buildGrowingPlantFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("valid body builds", func(t *testing.T) {
		if _, err := buildGrowingPlantFeature(base(), ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
}

// TestBuildGrowingPlant_GrowthDirectionIsCaseInsensitive pins that a capitalised spelling loads.
// How the game parses this field's string is not confirmed, but the sibling single-byte face field
// (multipart_block_column's `direction`) goes through the game's enum-string parse,
// which lowercases -- so "Down" almost certainly loads in game, and refusing it here sent the
// author hunting for a problem the game does not have. A genuinely unrecognised value is still
// refused, and the error now says what the game would most likely do instead.
func TestBuildGrowingPlant_GrowthDirectionIsCaseInsensitive(t *testing.T) {
	pal := block.NewPalette()
	for _, spelling := range []string{"up", "Up", "UP", "down", "Down", "DOWN", "dOwN"} {
		f := buildTestGrowingPlant(t, pal, map[string]any{"growth_direction": spelling}).(*GrowingPlantFeature)
		wantUp := strings.EqualFold(spelling, "up")
		if f.isUp != wantUp {
			t.Errorf("growth_direction %q -> isUp %v, want %v", spelling, f.isUp, wantUp)
		}
	}

	ctx := &BuildContext{Palette: pal, Identifier: "t", FileID: "t", Warn: func(string) {}}
	_, err := buildGrowingPlantFeature(map[string]any{
		"height_distribution": []any{[]any{float64(3), float64(1)}},
		"growth_direction":    "sideways",
		"body_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
		"head_blocks":         []any{[]any{"minecraft:weeping_vines", float64(1)}},
	}, ctx)
	if err == nil {
		t.Fatal("an unrecognised growth_direction was accepted")
	}
	if !strings.Contains(err.Error(), "case-insensitive") {
		t.Errorf("error does not tell the author the match is case-insensitive: %v", err)
	}
}
