// height_difference_filter_test.go exercises HeightDifferenceFilterFeature's
// gate logic (its placement decision) explicitly -- both the hard-fail downward-diff
// checks and the OR-accumulated upward-diff checks, across all four
// horizontal cardinal directions -- plus the places_feature resolve-failure
// path and confirms zero RNG draws happen anywhere in this type (neither
// the placement nor its placement decision makes any random calls in the
// game). No golden regression scene exercises this type, so these tests are
// the only thing standing between a wrong port and a caller relying on this
// type. See
// height_difference_filter.go's header for the algorithm this is checking
// against. stubDelegate/stubResolver are shared with snap_to_surface_test.go
// (same package).
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// newHDFTestVolume builds a wide, flat volume: solid ground with its top
// surface at floorY (so GetHeight(x,z) == floorY+1 for every column unless
// overridden), air above, centered so a search_radius up to 3 from origin
// (0, originY, 0) stays fully in-bounds.
func newHDFTestVolume(t *testing.T, floorY, originY int) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -6, MinY: floorY - 30, MinZ: -6, SizeX: 13, SizeY: (originY + 20) - (floorY - 30), SizeZ: 13}
	v := volume.New(bounds, pal, block.AirID)
	for x := bounds.MinX; x < bounds.MinX+bounds.SizeX; x++ {
		for z := bounds.MinZ; z < bounds.MinZ+bounds.SizeZ; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, stone)
		}
	}
	return v, pal
}

// raiseColumn stacks stone up to (and including) topY at (x,z), so
// GetHeight(x,z) == topY+1.
func raiseColumn(v *volume.Volume, pal *block.Palette, x, topY, z int) {
	stone := pal.Get("minecraft:stone", nil)
	for y := topY; y >= topY-1; y-- {
		v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
	}
}

// digColumn clears (x,z) down to (and including) belowY, then puts the
// floor back further down so GetHeight(x,z) == belowY+1... actually simplest:
// set the column's own floor block down at belowY-1 and clear everything
// above it up to some safe ceiling, and clear the original floorY block too.
func digColumn(v *volume.Volume, pal *block.Palette, x, belowY, z, origFloorY int) {
	v.SetBlock(wgen.BlockPos{X: x, Y: origFloorY, Z: z}, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(wgen.BlockPos{X: x, Y: belowY, Z: z}, stone)
}

func buildTestHDF(t *testing.T, pal *block.Palette, resolver wgen.IFeatureResolver, body map[string]any) wgen.IFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Resolver: resolver, Identifier: "test:hdf", FileID: "test:hdf", Warn: func(string) {}}
	f, err := buildHeightDifferenceFilterFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildHeightDifferenceFilterFeature: %v", err)
	}
	return f
}

func placeTestHDF(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) (*wgen.BlockPos, []string) {
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

// TestHeightDifferenceFilter_FlatTerrainNoConstraints_Delegates: with no
// diff fields configured at all, both accumulated flags start (and stay)
// true regardless of terrain, so the gate always passes and place()
// delegates unconditionally. Also pins: zero RNG draws.
func TestHeightDifferenceFilter_FlatTerrainNoConstraints_Delegates(t *testing.T) {
	origin := wgen.BlockPos{X: 0, Y: 70, Z: 0}
	v, pal := newHDFTestVolume(t, 69, origin.Y)
	delegate := &stubDelegate{}
	resolver := stubResolver{delegate: delegate}
	f := buildTestHDF(t, pal, resolver, map[string]any{
		"places_feature": "test:delegate",
		"search_radius":  float64(2),
	})

	tracer := random.NewTracer(random.New(1))
	got, failures := placeTestHDF(f, v, origin, tracer)
	if got == nil {
		t.Fatalf("Place() = nil, want success (failures: %v)", failures)
	}
	if !delegate.called {
		t.Error("delegate was never called -- gate should have passed unconditionally")
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("draws = %v, want 0 (neither placement nor the placement decision makes RNG calls)", tracer.Draws)
	}
}

// TestHeightDifferenceFilter_SearchRadiusZero pins the search_radius<1
// special case: result = (min_required_upward absent) AND
// (max_allowed_upward absent), independent of terrain.
func TestHeightDifferenceFilter_SearchRadiusZero(t *testing.T) {
	origin := wgen.BlockPos{X: 0, Y: 70, Z: 0}
	v, pal := newHDFTestVolume(t, 69, origin.Y)

	t.Run("neither upward field set -> passes", func(t *testing.T) {
		delegate := &stubDelegate{}
		resolver := stubResolver{delegate: delegate}
		f := buildTestHDF(t, pal, resolver, map[string]any{
			"places_feature": "test:delegate",
			"search_radius":  float64(0),
		})
		got, _ := placeTestHDF(f, v, origin, random.New(1))
		if got == nil || !delegate.called {
			t.Error("want gate to pass and delegate to fire when neither upward field is set")
		}
	})

	t.Run("min_required_upward_height_diff set -> fails", func(t *testing.T) {
		delegate := &stubDelegate{}
		resolver := stubResolver{delegate: delegate}
		f := buildTestHDF(t, pal, resolver, map[string]any{
			"places_feature":                  "test:delegate",
			"search_radius":                   float64(0),
			"min_required_upward_height_diff": float64(1),
		})
		got, _ := placeTestHDF(f, v, origin, random.New(1))
		if got != nil || delegate.called {
			t.Error("want gate to fail (search_radius<1 can never satisfy a configured min_required_upward_height_diff)")
		}
	})
}

// TestHeightDifferenceFilter_MinRequiredUpward exercises the OR-accumulated
// upward check across all four cardinal directions: it must scan every
// direction/step (not short-circuit on the first) since the satisfying
// column here is two steps West.
func TestHeightDifferenceFilter_MinRequiredUpward(t *testing.T) {
	origin := wgen.BlockPos{X: 0, Y: 70, Z: 0}

	t.Run("satisfied by a distant column -> delegates", func(t *testing.T) {
		v, pal := newHDFTestVolume(t, 69, origin.Y)
		raiseColumn(v, pal, -2, origin.Y+10, 0) // West, 2 steps out
		delegate := &stubDelegate{}
		resolver := stubResolver{delegate: delegate}
		f := buildTestHDF(t, pal, resolver, map[string]any{
			"places_feature":                  "test:delegate",
			"search_radius":                   float64(2),
			"min_required_upward_height_diff": float64(5),
		})
		got, failures := placeTestHDF(f, v, origin, random.New(1))
		if got == nil || !delegate.called {
			t.Fatalf("want gate to pass (failures: %v)", failures)
		}
	})

	t.Run("never satisfied on flat terrain -> refuses silently", func(t *testing.T) {
		v, pal := newHDFTestVolume(t, 69, origin.Y)
		delegate := &stubDelegate{}
		resolver := stubResolver{delegate: delegate}
		f := buildTestHDF(t, pal, resolver, map[string]any{
			"places_feature":                  "test:delegate",
			"search_radius":                   float64(2),
			"min_required_upward_height_diff": float64(5),
		})
		got, failures := placeTestHDF(f, v, origin, random.New(1))
		if got != nil || delegate.called {
			t.Error("want gate to fail on flat terrain")
		}
		if len(failures) != 0 {
			t.Errorf("failures = %v, want none -- a failed placement decision logs nothing in the engine", failures)
		}
	})
}

// TestHeightDifferenceFilter_MaxAllowedDownward_HardFails pins the
// hard-fail shape: a single step, in a single direction, that violates
// max_allowed_downward_height_diff aborts the ENTIRE scan immediately
// (returns false), even though every other direction/step would otherwise
// be fine.
func TestHeightDifferenceFilter_MaxAllowedDownward_HardFails(t *testing.T) {
	origin := wgen.BlockPos{X: 0, Y: 70, Z: 0}
	v, pal := newHDFTestVolume(t, 69, origin.Y)
	digColumn(v, pal, 1, origin.Y-10, 0, 69) // East, 1 step: a chasm well below the floor threshold
	delegate := &stubDelegate{}
	resolver := stubResolver{delegate: delegate}
	f := buildTestHDF(t, pal, resolver, map[string]any{
		"places_feature":                   "test:delegate",
		"search_radius":                    float64(2),
		"max_allowed_downward_height_diff": float64(3),
	})
	got, _ := placeTestHDF(f, v, origin, random.New(1))
	if got != nil || delegate.called {
		t.Error("want the chasm at East+1 to hard-fail the whole gate")
	}
}

// TestHeightDifferenceFilter_MissingFeature pins the game's exact
// content-log string for an unresolvable places_feature reference, and that
// the delegate (here: none exists) is never reached.
func TestHeightDifferenceFilter_MissingFeature(t *testing.T) {
	origin := wgen.BlockPos{X: 0, Y: 70, Z: 0}
	v, pal := newHDFTestVolume(t, 69, origin.Y)
	resolver := stubResolver{delegate: nil} // "test:delegate" resolves to nil below
	f := buildTestHDF(t, pal, resolver, map[string]any{
		"places_feature": "test:nonexistent",
		"search_radius":  float64(2),
	})
	got, failures := placeTestHDF(f, v, origin, random.New(1))
	if got != nil {
		t.Fatalf("Place() = %v, want nil", got)
	}
	want := "`height_difference_filter_feature` could not find feature `places_feature`."
	if len(failures) != 1 || failures[0] != want {
		t.Errorf("failures = %v, want [%q]", failures, want)
	}
}

func TestHeightDifferenceFilter_RequiresSearchRadius(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:hdf", FileID: "test:hdf", Warn: func(string) {}}
	_, err := buildHeightDifferenceFilterFeature(map[string]any{"places_feature": "test:delegate"}, ctx)
	if err == nil {
		t.Error("want an error when search_radius is missing")
	}
}
