// multipart_block_column_test.go exercises MultipartBlockColumnFeature's RNG
// draw sequence explicitly (method + bound + count, per random.Tracer), the
// role layout for every degenerate short-column height, both mutual-exclusion
// diagnostics, the may_place_on/may_replace gates, and the engine's
// place-nothing-successfully quirk. There is no golden coverage for
// this type (it is new in 1.26.50.24), so these tests are the only thing
// standing between a wrong implementation and a caller relying on it. See
// multipart_block_column.go's header for the algorithm these assertions pin.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// newMultipartTestVolume builds an all-air volume with headroom on every side
// of origin (0,63,0): 13 cells above, 13 below, 2 on each horizontal side.
func newMultipartTestVolume(t *testing.T) (*volume.Volume, *block.Palette, wgen.BlockPos) {
	t.Helper()
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -2, MinY: 50, MinZ: -2, SizeX: 5, SizeY: 30, SizeZ: 5}
	v := volume.New(bounds, pal, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 63, Z: 0}
	return v, pal, origin
}

// multipartBaseBody returns a minimal valid body: the four required roles as
// four DISTINCT blocks (so layout assertions can tell them apart) and a
// degenerate height_range (0 draws) of the given height.
func multipartBaseBody(height int) map[string]any {
	return map[string]any{
		"tip_block":     "minecraft:diamond_block",
		"frustum_block": "minecraft:gold_block",
		"middle_block":  "minecraft:iron_block",
		"base_block":    "minecraft:emerald_block",
		"height_range":  []any{float64(height), float64(height)},
	}
}

func buildTestMultipart(t *testing.T, pal *block.Palette, body map[string]any) (wgen.IFeature, []string) {
	t.Helper()
	var warnings []string
	ctx := &BuildContext{
		Palette:    pal,
		Identifier: "test:multipart",
		FileID:     "test:multipart",
		Warn:       func(m string) { warnings = append(warnings, m) },
	}
	f, err := buildMultipartBlockColumnFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildMultipartBlockColumnFeature: %v", err)
	}
	return f, warnings
}

func placeTestMultipart(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) (*wgen.BlockPos, []string) {
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

// multipartRoleNames maps the four distinct role blocks back to role names
// for readable layout assertions.
var multipartRoleNames = map[string]string{
	"minecraft:diamond_block": "tip",
	"minecraft:gold_block":    "frustum",
	"minecraft:iron_block":    "middle",
	"minecraft:emerald_block": "base",
	"minecraft:air":           "air",
}

// TestMultipartBlockColumn_RequiredKeys: all four block roles are REQUIRED
// schema keys (see module header),
// even though a short column places only some of them.
func TestMultipartBlockColumn_RequiredKeys(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:multipart", FileID: "test:multipart", Warn: func(string) {}}
	for _, key := range []string{"tip_block", "frustum_block", "middle_block", "base_block"} {
		t.Run(key+" required", func(t *testing.T) {
			body := multipartBaseBody(3)
			delete(body, key)
			_, err := buildMultipartBlockColumnFeature(body, ctx)
			if err == nil {
				t.Fatal("want error, got nil")
			}
			if !strings.Contains(err.Error(), key) {
				t.Errorf("error %q does not name the missing key %q", err, key)
			}
		})
	}
}

// TestMultipartBlockColumn_MutualExclusion pins the post-parse validation:
// VALUE-based (the {-1,-1} default sentinel means
// "not given", an empty weighted_heights list means "not given"), both
// diagnostics verbatim, and -- critically -- the feature still BUILDS in
// every case, because the engine's check only content-logs and the feature
// registers and places anyway.
func TestMultipartBlockColumn_MutualExclusion(t *testing.T) {
	pal := block.NewPalette()

	build := func(t *testing.T, mutate func(map[string]any)) (wgen.IFeature, []string) {
		t.Helper()
		body := multipartBaseBody(3)
		delete(body, "height_range")
		mutate(body)
		return buildTestMultipart(t, pal, body)
	}

	t.Run("neither given warns and still builds", func(t *testing.T) {
		f, warnings := build(t, func(map[string]any) {})
		if f == nil {
			t.Fatal("feature must still build (the engine only logs)")
		}
		if len(warnings) != 1 || warnings[0] != "height_range or weighted_heights has to be given" {
			t.Errorf("warnings = %v, want exactly [\"height_range or weighted_heights has to be given\"]", warnings)
		}
	})

	t.Run("both given warns and still builds", func(t *testing.T) {
		f, warnings := build(t, func(b map[string]any) {
			b["height_range"] = []any{float64(2), float64(4)}
			b["weighted_heights"] = []any{map[string]any{"value": float64(3), "weight": float64(1)}}
		})
		if f == nil {
			t.Fatal("feature must still build (the engine only logs)")
		}
		if len(warnings) != 1 || warnings[0] != "height_range and weighted_heights can't be given at the same time" {
			t.Errorf("warnings = %v, want exactly [\"height_range and weighted_heights can't be given at the same time\"]", warnings)
		}
	})

	t.Run("only height_range given: no warning", func(t *testing.T) {
		_, warnings := build(t, func(b map[string]any) {
			b["height_range"] = []any{float64(2), float64(4)}
		})
		if len(warnings) != 0 {
			t.Errorf("warnings = %v, want none", warnings)
		}
	})

	t.Run("only weighted_heights given: no warning", func(t *testing.T) {
		_, warnings := build(t, func(b map[string]any) {
			b["weighted_heights"] = []any{map[string]any{"value": float64(3), "weight": float64(1)}}
		})
		if len(warnings) != 0 {
			t.Errorf("warnings = %v, want none", warnings)
		}
	})

	t.Run("explicit height_range [-1,-1] reads as not given (value-based check)", func(t *testing.T) {
		_, warnings := build(t, func(b map[string]any) {
			b["height_range"] = []any{float64(-1), float64(-1)}
		})
		if len(warnings) != 1 || warnings[0] != "height_range or weighted_heights has to be given" {
			t.Errorf("warnings = %v, want the \"has to be given\" diagnostic (the game tests the stored values, not key presence)", warnings)
		}
	})

	t.Run("height_range with only one -1 does not count as given alongside weighted_heights", func(t *testing.T) {
		// $_9's "both given" arm requires min != -1 AND max != -1.
		_, warnings := build(t, func(b map[string]any) {
			b["height_range"] = []any{float64(5), float64(-1)}
			b["weighted_heights"] = []any{map[string]any{"value": float64(3), "weight": float64(1)}}
		})
		if len(warnings) != 0 {
			t.Errorf("warnings = %v, want none (min=5,max=-1 fails the min!=-1&&max!=-1 test)", warnings)
		}
	})
}

// TestMultipartBlockColumn_Layouts pins the role layout for every distinct
// column shape the engine's own two role selections produce,
// including all four cases the engine changelog
// documents: 1 -> tip; 2 -> frustum+tip; 3 -> base+frustum+tip;
// 4+ -> base + middle(s) + frustum + tip. Degenerate height_range = zero
// draws, so the layout is the ONLY variable.
func TestMultipartBlockColumn_Layouts(t *testing.T) {
	cases := []struct {
		height int
		want   []string // roles bottom (origin) upward
	}{
		{1, []string{"tip"}},
		{2, []string{"frustum", "tip"}},
		{3, []string{"base", "frustum", "tip"}},
		{4, []string{"base", "middle", "frustum", "tip"}},
		{6, []string{"base", "middle", "middle", "middle", "frustum", "tip"}},
	}
	for _, tc := range cases {
		t.Run(strings.Repeat("I", tc.height), func(t *testing.T) {
			v, pal, origin := newMultipartTestVolume(t)
			f, _ := buildTestMultipart(t, pal, multipartBaseBody(tc.height))

			tracer := random.NewTracer(random.New(1))
			got, failures := placeTestMultipart(f, v, origin, tracer)
			if got == nil {
				t.Fatalf("Place() = nil, want success (failures: %v)", failures)
			}
			if len(tracer.Draws) != 0 {
				t.Errorf("draws = %v, want none (degenerate height_range)", tracer.Draws)
			}
			for i, wantRole := range tc.want {
				pos := wgen.BlockPos{X: origin.X, Y: origin.Y + i, Z: origin.Z}
				gotRole := multipartRoleNames[pal.NameOf(v.GetBlock(pos))]
				if gotRole != wantRole {
					t.Errorf("cell %d = %s, want %s", i, gotRole, wantRole)
				}
			}
			// Nothing above the column.
			above := wgen.BlockPos{X: origin.X, Y: origin.Y + tc.height, Z: origin.Z}
			if !pal.IsAir(v.GetBlock(above)) {
				t.Errorf("cell %d = %q, want air (column must stop at height)", tc.height, pal.NameOf(v.GetBlock(above)))
			}
			// Success position is the tip cell.
			if want := origin.Y + tc.height - 1; got.Y != want {
				t.Errorf("Place() returned Y=%d, want %d (the tip cell)", got.Y, want)
			}
		})
	}
}

// TestMultipartBlockColumn_DrawSequence pins the complete RNG contract: at
// most ONE bounded int draw per placement, with the exact bound.
func TestMultipartBlockColumn_DrawSequence(t *testing.T) {
	t.Run("non-degenerate height_range: one NextIntBound(max-min)", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(0)
		body["height_range"] = []any{float64(2), float64(7)}
		f, _ := buildTestMultipart(t, pal, body)

		tracer := random.NewTracer(random.New(1))
		got, failures := placeTestMultipart(f, v, origin, tracer)
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if len(tracer.Draws) != 1 {
			t.Fatalf("draws = %v, want exactly 1", tracer.Draws)
		}
		if tracer.Draws[0].Method != random.MethodNextIntBound {
			t.Errorf("draw method = %v, want NextIntBound", tracer.Draws[0].Method)
		}
		if tracer.Draws[0].Bound != 5 {
			t.Errorf("draw bound = %d, want 5 (max-min for the int range 2..7 -- the engine's int-range draw)", tracer.Draws[0].Bound)
		}
	})

	t.Run("degenerate height_range: zero draws", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		f, _ := buildTestMultipart(t, pal, multipartBaseBody(3))

		tracer := random.NewTracer(random.New(1))
		if got, failures := placeTestMultipart(f, v, origin, tracer); got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if len(tracer.Draws) != 0 {
			t.Errorf("draws = %v, want none", tracer.Draws)
		}
	})

	t.Run("weighted_heights: one NextIntBound(sum of weights)", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(0)
		delete(body, "height_range")
		body["weighted_heights"] = []any{
			map[string]any{"value": float64(4), "weight": float64(2)},
			map[string]any{"value": float64(2), "weight": float64(4)},
		}
		f, _ := buildTestMultipart(t, pal, body)

		tracer := random.NewTracer(random.New(1))
		got, failures := placeTestMultipart(f, v, origin, tracer)
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if len(tracer.Draws) != 1 {
			t.Fatalf("draws = %v, want exactly 1", tracer.Draws)
		}
		if tracer.Draws[0].Method != random.MethodNextIntBound {
			t.Errorf("draw method = %v, want NextIntBound (the engine's weighted pick takes a bounded integer draw)", tracer.Draws[0].Method)
		}
		if tracer.Draws[0].Bound != 6 {
			t.Errorf("draw bound = %d, want 6 (2+4, the engine's plain integer weight sum)", tracer.Draws[0].Bound)
		}
	})

	t.Run("weighted_heights zero weight sum: zero draws, clean failure for the engine-UB walk", func(t *testing.T) {
		// sum == 0 skips the draw entirely and runs the
		// walk as if the draw were 0; with the single weight 0 the walk
		// never goes negative, which in the engine reads past the list
		// (UB). The port fails cleanly instead -- disclosed divergence.
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(0)
		delete(body, "height_range")
		body["weighted_heights"] = []any{map[string]any{"value": float64(3), "weight": float64(0)}}
		f, _ := buildTestMultipart(t, pal, body)

		tracer := random.NewTracer(random.New(1))
		got, failures := placeTestMultipart(f, v, origin, tracer)
		if got != nil {
			t.Fatalf("Place() = %+v, want nil", got)
		}
		if len(tracer.Draws) != 0 {
			t.Errorf("draws = %v, want none (sum == 0 skips the draw)", tracer.Draws)
		}
		if len(failures) != 1 || !strings.Contains(failures[0], "weighted_heights") {
			t.Errorf("failures = %v, want the weighted_heights walk diagnostic", failures)
		}
	})
}

// TestMultipartBlockColumn_MayPlaceOn pins the surface gate: checked at
// one step from the origin along the OPPOSITE of direction -- i.e. BEHIND it --
// BEFORE any RNG draw, with an empty list passing anything.
func TestMultipartBlockColumn_MayPlaceOn(t *testing.T) {
	t.Run("matching surface below passes (direction up)", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, pal.Get("minecraft:stone", nil))
		body := multipartBaseBody(3)
		body["may_place_on"] = []any{"minecraft:stone"}
		f, _ := buildTestMultipart(t, pal, body)

		if got, failures := placeTestMultipart(f, v, origin, random.New(1)); got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
	})

	t.Run("non-matching surface fails with zero draws", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, pal.Get("minecraft:dirt", nil))
		body := multipartBaseBody(0)
		body["height_range"] = []any{float64(2), float64(7)} // non-degenerate: WOULD draw if reached
		body["may_place_on"] = []any{"minecraft:stone"}
		f, _ := buildTestMultipart(t, pal, body)

		tracer := random.NewTracer(random.New(1))
		got, failures := placeTestMultipart(f, v, origin, tracer)
		if got != nil {
			t.Fatalf("Place() = %+v, want nil", got)
		}
		if len(tracer.Draws) != 0 {
			t.Errorf("draws = %v, want none (the gate runs BEFORE the height draw)", tracer.Draws)
		}
		if len(failures) != 1 || failures[0] != "Placement surface is not in may_place_on" {
			t.Errorf("failures = %v, want [\"Placement surface is not in may_place_on\"]", failures)
		}
	})

	t.Run("omitted may_place_on allows any surface", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}, pal.Get("minecraft:dirt", nil))
		f, _ := buildTestMultipart(t, pal, multipartBaseBody(3))
		if got, failures := placeTestMultipart(f, v, origin, random.New(1)); got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
	})

	t.Run("direction down anchors ABOVE the origin", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y + 1, Z: origin.Z}, pal.Get("minecraft:stone", nil))
		body := multipartBaseBody(2)
		body["direction"] = "down"
		body["may_place_on"] = []any{"minecraft:stone"}
		f, _ := buildTestMultipart(t, pal, body)

		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		// n=2 growing down: frustum at origin, tip one BELOW it.
		if gotRole := multipartRoleNames[pal.NameOf(v.GetBlock(origin))]; gotRole != "frustum" {
			t.Errorf("origin cell = %s, want frustum", gotRole)
		}
		below := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
		if gotRole := multipartRoleNames[pal.NameOf(v.GetBlock(below))]; gotRole != "tip" {
			t.Errorf("cell below origin = %s, want tip", gotRole)
		}
		if got.Y != origin.Y-1 {
			t.Errorf("Place() returned Y=%d, want %d (the tip cell, downward)", got.Y, origin.Y-1)
		}
	})
}

// TestMultipartBlockColumn_MayReplaceTruncation pins the scan/truncation
// pipeline: the may_replace scan counts consecutive passing cells from the
// origin (i=0), the column truncates to that count, and the minimum-height
// gate compares the truncated height against height_range.min or -- on the
// weighted path -- the MINIMUM value across all entries, not the picked one.
func TestMultipartBlockColumn_MayReplaceTruncation(t *testing.T) {
	// obstructedAt returns a volume whose cells are air except stone at
	// origin.Y + at.
	obstructedAt := func(t *testing.T, at int) (*volume.Volume, *block.Palette, wgen.BlockPos) {
		t.Helper()
		v, pal, origin := newMultipartTestVolume(t)
		v.SetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y + at, Z: origin.Z}, pal.Get("minecraft:stone", nil))
		return v, pal, origin
	}

	t.Run("height_range: truncated below min fails", func(t *testing.T) {
		v, pal, origin := obstructedAt(t, 2)
		body := multipartBaseBody(5) // degenerate [5,5]: min 5
		body["may_replace"] = []any{"minecraft:air"}
		f, _ := buildTestMultipart(t, pal, body)

		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got != nil {
			t.Fatalf("Place() = %+v, want nil (n=2 < min 5)", got)
		}
		if len(failures) != 1 || failures[0] != "Column is blocked before reaching the height_range minimum" {
			t.Errorf("failures = %v, want the height_range minimum diagnostic", failures)
		}
		// Nothing placed at all -- the gate runs before any write.
		for i := 0; i < 2; i++ {
			pos := wgen.BlockPos{X: origin.X, Y: origin.Y + i, Z: origin.Z}
			if !pal.IsAir(v.GetBlock(pos)) {
				t.Errorf("cell %d = %q, want air (no partial column on failure)", i, pal.NameOf(v.GetBlock(pos)))
			}
		}
	})

	t.Run("weighted: min gate uses the smallest configured VALUE, not the picked one", func(t *testing.T) {
		// Entries {5, w:1} and {1, w:0}: sum=1 so the single NextIntBound(1)
		// draw returns 0 and the walk picks value 5. The obstruction at cell
		// 2 truncates to n=2 -- BELOW the picked 5 but ABOVE the smallest
		// configured value 1 (the SMIN reduction),
		// so placement SUCCEEDS as a 2-cell column: frustum + tip.
		v, pal, origin := obstructedAt(t, 2)
		body := multipartBaseBody(0)
		delete(body, "height_range")
		body["weighted_heights"] = []any{
			map[string]any{"value": float64(5), "weight": float64(1)},
			map[string]any{"value": float64(1), "weight": float64(0)},
		}
		body["may_replace"] = []any{"minecraft:air"}
		f, _ := buildTestMultipart(t, pal, body)

		tracer := random.NewTracer(random.New(1))
		got, failures := placeTestMultipart(f, v, origin, tracer)
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if len(tracer.Draws) != 1 || tracer.Draws[0].Bound != 1 {
			t.Fatalf("draws = %v, want exactly one NextIntBound(1)", tracer.Draws)
		}
		wantRoles := []string{"frustum", "tip"} // n=2 layout after truncation
		for i, want := range wantRoles {
			pos := wgen.BlockPos{X: origin.X, Y: origin.Y + i, Z: origin.Z}
			if gotRole := multipartRoleNames[pal.NameOf(v.GetBlock(pos))]; gotRole != want {
				t.Errorf("cell %d = %s, want %s", i, gotRole, want)
			}
		}
		// The obstruction itself is never overwritten.
		if name := pal.NameOf(v.GetBlock(wgen.BlockPos{X: origin.X, Y: origin.Y + 2, Z: origin.Z})); name != "minecraft:stone" {
			t.Errorf("obstruction cell = %q, want unchanged minecraft:stone", name)
		}
		if got.Y != origin.Y+1 {
			t.Errorf("Place() returned Y=%d, want %d (tip of the TRUNCATED column)", got.Y, origin.Y+1)
		}
	})

	t.Run("weighted: truncated below the smallest value fails", func(t *testing.T) {
		v, pal, origin := obstructedAt(t, 1) // n = 1
		body := multipartBaseBody(0)
		delete(body, "height_range")
		body["weighted_heights"] = []any{
			map[string]any{"value": float64(5), "weight": float64(1)},
			map[string]any{"value": float64(2), "weight": float64(0)}, // smallest value: 2
		}
		body["may_replace"] = []any{"minecraft:air"}
		f, _ := buildTestMultipart(t, pal, body)

		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got != nil {
			t.Fatalf("Place() = %+v, want nil (n=1 < smallest configured value 2)", got)
		}
		if len(failures) != 1 || failures[0] != "Column is blocked before reaching the smallest weighted_heights value" {
			t.Errorf("failures = %v, want the weighted minimum diagnostic", failures)
		}
	})

	t.Run("scan starts AT the origin cell", func(t *testing.T) {
		v, pal, origin := obstructedAt(t, 0) // origin itself blocked -> n = 0
		body := multipartBaseBody(3)         // min 3
		body["may_replace"] = []any{"minecraft:air"}
		f, _ := buildTestMultipart(t, pal, body)

		if got, _ := placeTestMultipart(f, v, origin, random.New(1)); got != nil {
			t.Fatalf("Place() = %+v, want nil (the scan includes i=0, so a blocked origin truncates to 0)", got)
		}
	})
}

// TestMultipartBlockColumn_Direction pins the direction parse (the engine's
// enum-string parse): default up, case-insensitive, all six facings, silent
// fallback to up for unrecognized strings, and horizontal growth actually
// moving on the horizontal axis.
func TestMultipartBlockColumn_Direction(t *testing.T) {
	t.Run("default is up", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		f, _ := buildTestMultipart(t, pal, multipartBaseBody(2))
		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if got.Y != origin.Y+1 {
			t.Errorf("Place() returned Y=%d, want %d (default direction must be up)", got.Y, origin.Y+1)
		}
	})

	t.Run("east grows along +X", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(2)
		body["direction"] = "east"
		f, _ := buildTestMultipart(t, pal, body)
		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if got.X != origin.X+1 || got.Y != origin.Y {
			t.Errorf("Place() returned %+v, want X=%d,Y=%d (east = +X)", got, origin.X+1, origin.Y)
		}
		if gotRole := multipartRoleNames[pal.NameOf(v.GetBlock(origin))]; gotRole != "frustum" {
			t.Errorf("origin cell = %s, want frustum", gotRole)
		}
		east := wgen.BlockPos{X: origin.X + 1, Y: origin.Y, Z: origin.Z}
		if gotRole := multipartRoleNames[pal.NameOf(v.GetBlock(east))]; gotRole != "tip" {
			t.Errorf("east cell = %s, want tip", gotRole)
		}
	})

	t.Run("case-insensitive", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(2)
		body["direction"] = "DOWN"
		f, warnings := buildTestMultipart(t, pal, body)
		if len(warnings) != 0 {
			t.Errorf("warnings = %v, want none (the engine lowercases before matching)", warnings)
		}
		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if got.Y != origin.Y-1 {
			t.Errorf("Place() returned Y=%d, want %d (\"DOWN\" must parse as down)", got.Y, origin.Y-1)
		}
	})

	t.Run("unrecognized string silently defaults to up, with a port-side warning", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(2)
		body["direction"] = "sideways"
		f, warnings := buildTestMultipart(t, pal, body)
		if len(warnings) != 1 || !strings.Contains(warnings[0], "sideways") {
			t.Errorf("warnings = %v, want one naming the bad value", warnings)
		}
		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		if got.Y != origin.Y+1 {
			t.Errorf("Place() returned Y=%d, want %d (fallback must be up)", got.Y, origin.Y+1)
		}
	})

	t.Run("non-string is a build error", func(t *testing.T) {
		pal := block.NewPalette()
		ctx := &BuildContext{Palette: pal, Identifier: "test:multipart", FileID: "test:multipart", Warn: func(string) {}}
		body := multipartBaseBody(2)
		body["direction"] = float64(1)
		if _, err := buildMultipartBlockColumnFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
}

// TestMultipartBlockColumn_ZeroHeightQuirk pins the engine's strangest
// behaviour: with neither height source given, height_range stays
// at the {-1,-1} sentinel, the engine's int-range draw returns -1 with zero draws,
// n = -1 passes the n >= min(-1) gate, the placement loop is skipped
// -- and place still RETURNS A SUCCESS POSITION
// at origin.relative(direction, -2), having placed nothing.
func TestMultipartBlockColumn_ZeroHeightQuirk(t *testing.T) {
	v, pal, origin := newMultipartTestVolume(t)
	body := multipartBaseBody(0)
	delete(body, "height_range")
	f, warnings := buildTestMultipart(t, pal, body)
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want the \"has to be given\" diagnostic", warnings)
	}

	tracer := random.NewTracer(random.New(1))
	got, failures := placeTestMultipart(f, v, origin, tracer)
	if got == nil {
		t.Fatalf("Place() = nil, want the quirky success (failures: %v)", failures)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want none", tracer.Draws)
	}
	if got.Y != origin.Y-2 {
		t.Errorf("Place() returned Y=%d, want %d (relative(direction, n-1) with n=-1)", got.Y, origin.Y-2)
	}
	// Nothing was placed anywhere near the origin.
	for dy := -2; dy <= 2; dy++ {
		pos := wgen.BlockPos{X: origin.X, Y: origin.Y + dy, Z: origin.Z}
		if !pal.IsAir(v.GetBlock(pos)) {
			t.Errorf("cell y%+d = %q, want air (nothing must be placed)", dy, pal.NameOf(v.GetBlock(pos)))
		}
	}
}

// TestMultipartBlockColumn_WeightedHeightsShapes pins the element parse:
// objects read
// value/weight with missing keys as 0; numeric and array elements silently
// become {value: 0, weight: 1}; anything else fails the schema.
func TestMultipartBlockColumn_WeightedHeightsShapes(t *testing.T) {
	t.Run("missing weight parses as 0", func(t *testing.T) {
		// {value:3} (weight 0) and {value:2, weight:1}: sum=1, draw=0,
		// rem = 0 - 0 = 0 stays >= 0, walk advances past the zero-weight
		// entry and picks {2,1} -- proving the missing weight became 0.
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(0)
		delete(body, "height_range")
		body["weighted_heights"] = []any{
			map[string]any{"value": float64(3)},
			map[string]any{"value": float64(2), "weight": float64(1)},
		}
		f, warnings := buildTestMultipart(t, pal, body)
		if len(warnings) != 0 {
			t.Errorf("warnings = %v, want none", warnings)
		}
		tracer := random.NewTracer(random.New(1))
		got, failures := placeTestMultipart(f, v, origin, tracer)
		if got == nil {
			t.Fatalf("Place() = nil, want success (failures: %v)", failures)
		}
		// The draw bound IS the weight sum: 0 (the defaulted missing weight)
		// + 1 = 1. A nonzero default would inflate it.
		if len(tracer.Draws) != 1 || tracer.Draws[0].Bound != 1 {
			t.Errorf("draws = %v, want exactly one NextIntBound(1) (missing weight must sum as 0)", tracer.Draws)
		}
		if got.Y != origin.Y+1 {
			t.Errorf("Place() returned Y=%d, want %d (picked height must be 2, the weighted entry)", got.Y, origin.Y+1)
		}
	})

	t.Run("numeric element becomes {value:0, weight:1} with a warning", func(t *testing.T) {
		v, pal, origin := newMultipartTestVolume(t)
		body := multipartBaseBody(0)
		delete(body, "height_range")
		body["weighted_heights"] = []any{float64(5)}
		f, warnings := buildTestMultipart(t, pal, body)
		if len(warnings) != 1 || !strings.Contains(warnings[0], "weighted_heights[0]") {
			t.Fatalf("warnings = %v, want one naming weighted_heights[0]", warnings)
		}
		// The lone entry is {0,1}: sum=1 -> one draw -> picks value 0 ->
		// n=0 >= min value 0 -> the place-nothing success at Y-1.
		got, failures := placeTestMultipart(f, v, origin, random.New(1))
		if got == nil {
			t.Fatalf("Place() = nil, want the place-nothing success (failures: %v)", failures)
		}
		if got.Y != origin.Y-1 {
			t.Errorf("Place() returned Y=%d, want %d (n=0 -> relative(direction, -1))", got.Y, origin.Y-1)
		}
		if !pal.IsAir(v.GetBlock(origin)) {
			t.Errorf("origin = %q, want air (height 0 places nothing)", pal.NameOf(v.GetBlock(origin)))
		}
	})

	t.Run("string element is a build error", func(t *testing.T) {
		pal := block.NewPalette()
		ctx := &BuildContext{Palette: pal, Identifier: "test:multipart", FileID: "test:multipart", Warn: func(string) {}}
		body := multipartBaseBody(0)
		delete(body, "height_range")
		body["weighted_heights"] = []any{"five"}
		if _, err := buildMultipartBlockColumnFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
}

// TestBuildMultipartBlockColumn_HalfSentinelHeightRangeIsNotGiven pins the negation of this
// type's own "given" rule. The header records it: "height_range given" means min != -1 AND
// max != -1, so "not given" is min == -1 OR max == -1. The check used to be `&&`, which made a
// half-sentinel range like [-1, 7] read as given and pass in silence -- the engine content-logs
// it. Diagnostic only; the engine keeps the feature either way and so does this port.
func TestBuildMultipartBlockColumn_HalfSentinelHeightRangeIsNotGiven(t *testing.T) {
	const wantMsg = "height_range or weighted_heights has to be given"
	cases := []struct {
		heightRange []any
		wantWarn    bool
	}{
		{[]any{float64(-1), float64(-1)}, true}, // both sentinel -- not given
		{[]any{float64(-1), float64(7)}, true},  // half sentinel -- ALSO not given
		{[]any{float64(2), float64(-1)}, true},  // the other half
		{[]any{float64(2), float64(7)}, false},  // genuinely given
	}
	for _, tc := range cases {
		var warnings []string
		pal := block.NewPalette()
		ctx := &BuildContext{Palette: pal, Identifier: "t", FileID: "t",
			Warn: func(m string) { warnings = append(warnings, m) }}
		body := map[string]any{
			"base_block":    "minecraft:dripstone_block",
			"frustum_block": "minecraft:dripstone_block",
			"middle_block":  "minecraft:dripstone_block",
			"tip_block":     "minecraft:pointed_dripstone",
			"height_range":  tc.heightRange,
		}
		if _, err := buildMultipartBlockColumnFeature(body, ctx); err != nil {
			t.Fatalf("height_range %v: build failed: %v", tc.heightRange, err)
		}
		got := false
		for _, w := range warnings {
			if w == wantMsg {
				got = true
			}
		}
		if got != tc.wantWarn {
			t.Errorf("height_range %v: %q warned = %v, want %v (warnings: %v)",
				tc.heightRange, wantMsg, got, tc.wantWarn, warnings)
		}
	}
}
