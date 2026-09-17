// surface_relative_threshold_test.go pins the schema surface and threshold
// semantics. No golden regression scene exercises this type, so these tests
// are its only coverage.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// srtVolume builds a volume whose terrain top is at y=63 for every column in
// the 4x4 cell anchored at (0,0), and at y=70 for the cell anchored at (4,0),
// so the quarter-resolution sampling is observable.
func srtVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	v := volume.New(volume.Bounds{MinX: -8, MinY: 0, MinZ: -8, SizeX: 24, SizeY: 96, SizeZ: 24}, pal, block.AirID)
	for x := -8; x < 16; x++ {
		for z := -8; z < 16; z++ {
			top := 63
			if x >= 4 && x < 8 {
				top = 70
			}
			for y := 0; y <= top; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	return v, pal
}

func buildSRT(t *testing.T, pal *block.Palette, resolver wgen.IFeatureResolver, body map[string]any) (wgen.IFeature, error) {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Resolver: resolver, Identifier: "test:srt", FileID: "test:srt", Warn: func(string) {}}
	return buildSurfaceRelativeThresholdFeature(body, ctx)
}

func placeSRT(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos) *wgen.BlockPos {
	return f.Place(&wgen.PlacementContext{
		API: v, Origin: origin, Random: random.New(1), MolangScope: wgen.NewScope(),
		Biome:      &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {},
	})
}

func TestSurfaceRelativeThreshold_GateIsStrictlyBelow(t *testing.T) {
	// Terrain top y=63 -> GetHeight == 64 (first free cell). With
	// minimum_distance_below_surface 10 the threshold is 54: an origin at 53
	// passes, 54 fails (the test is `surface - min <= origin.y -> FAIL`).
	v, pal := srtVolume(t)
	d := &stubDelegate{}
	f, err := buildSRT(t, pal, stubResolver{d}, map[string]any{
		"feature_to_place":               "test:delegate",
		"minimum_distance_below_surface": float64(10),
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if got := placeSRT(f, v, wgen.BlockPos{X: 0, Y: 53, Z: 0}); got == nil {
		t.Error("origin y=53 is 11 below the surface and must pass")
	}
	if got := placeSRT(f, v, wgen.BlockPos{X: 0, Y: 54, Z: 0}); got != nil {
		t.Error("origin y=54 is exactly at the threshold and must FAIL (the comparison is <=)")
	}
}

func TestSurfaceRelativeThreshold_SurfaceIsSampledPerQuarterResolutionCell(t *testing.T) {
	// The game queries its surface provider at (x>>2, z>>2), so one value
	// covers each 4x4 cell. x=4..7 share the anchor at x=4, where the terrain
	// is 7 blocks higher than in the cell at x=0..3. An origin at y=64 must
	// therefore fail in the low cell and pass in the high one, even though
	// x=5's own column would give the same answer as x=4's here.
	v, pal := srtVolume(t)
	d := &stubDelegate{}
	f, err := buildSRT(t, pal, stubResolver{d}, map[string]any{
		"feature_to_place":               "test:delegate",
		"minimum_distance_below_surface": float64(1),
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// low cell: surface 64, threshold 63 -> y=64 fails
	if got := placeSRT(f, v, wgen.BlockPos{X: 1, Y: 64, Z: 1}); got != nil {
		t.Error("x=1 (cell anchored at 0, surface 64): y=64 must fail")
	}
	// high cell: surface 71, threshold 70 -> y=64 passes
	if got := placeSRT(f, v, wgen.BlockPos{X: 5, Y: 64, Z: 1}); got == nil {
		t.Error("x=5 (cell anchored at 4, surface 71): y=64 must pass")
	}
	// negative coordinates must use the arithmetic-shift anchor (-1 -> -4)
	if got := placeSRT(f, v, wgen.BlockPos{X: -1, Y: 64, Z: -1}); got != nil {
		t.Error("x=-1 (cell anchored at -4, surface 64): y=64 must fail")
	}
}

func TestSurfaceRelativeThreshold_OnlyRealSchemaKeysAccepted(t *testing.T) {
	pal := block.NewPalette()
	// The two real keys build fine.
	if _, err := buildSRT(t, pal, stubResolver{&stubDelegate{}}, map[string]any{
		"feature_to_place":               "test:delegate",
		"minimum_distance_below_surface": float64(3),
	}); err != nil {
		t.Fatalf("the real keys must build: %v", err)
	}
	// Every invented alias must be rejected, naming the real key.
	for alias, realKey := range map[string]string{
		"feature":                    "feature_to_place",
		"wrapped_feature":            "feature_to_place",
		"places_feature":             "feature_to_place",
		"min_distance_below_surface": "minimum_distance_below_surface",
	} {
		body := map[string]any{"feature_to_place": "test:delegate", alias: "test:delegate"}
		if alias == "min_distance_below_surface" {
			body[alias] = float64(3)
		}
		_, err := buildSRT(t, pal, stubResolver{&stubDelegate{}}, body)
		if err == nil {
			t.Errorf("%q must be rejected -- it is not a field of this feature type", alias)
			continue
		}
		if !strings.Contains(err.Error(), realKey) {
			t.Errorf("the error for %q should name %q, got: %v", alias, realKey, err)
		}
	}
}

func TestSurfaceRelativeThreshold_FractionalDistanceTruncates(t *testing.T) {
	// The game's field is an int32, so 10.9 behaves as 10: with surface 64
	// the threshold is 54, and y=54 fails while y=53 passes.
	v, pal := srtVolume(t)
	f, err := buildSRT(t, pal, stubResolver{&stubDelegate{}}, map[string]any{
		"feature_to_place":               "test:delegate",
		"minimum_distance_below_surface": 10.9,
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if got := placeSRT(f, v, wgen.BlockPos{X: 0, Y: 54, Z: 0}); got != nil {
		t.Error("10.9 must truncate to 10, so y=54 fails")
	}
	if got := placeSRT(f, v, wgen.BlockPos{X: 0, Y: 53, Z: 0}); got == nil {
		t.Error("10.9 must truncate to 10, so y=53 passes")
	}
}
