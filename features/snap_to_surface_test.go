// snap_to_surface_test.go pins minecraft:snap_to_surface_feature's
// vanilla behaviours -- the allow_air_placement /
// allow_underwater_placement defaults, the surface enum and its FLOOR
// default, the directional column scan's reach, and the two 1.26.50
// additions (the `wall` surface mode and allow_non_air_placement) -- see
// snap_to_surface.go's header. A self-contained palette/volume is enough to
// pin each behaviour.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// stubDelegate is a minimal wgen.IFeature that records the origin it was
// placed at and always "succeeds" (returns that same origin) -- standing in
// for feature_to_snap so a test can tell whether SnapToSurfaceFeature ever
// got far enough to delegate at all.
type stubDelegate struct {
	called bool
	origin wgen.BlockPos
}

func (s *stubDelegate) TypeID() string     { return "test:stub_delegate" }
func (s *stubDelegate) Identifier() string { return "test:delegate" }
func (s *stubDelegate) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	s.called = true
	s.origin = ctx.Origin
	return &ctx.Origin
}

// stubResolver resolves exactly "test:delegate" to a given stubDelegate.
type stubResolver struct{ delegate *stubDelegate }

func (r stubResolver) Resolve(identifier string) wgen.IFeature {
	if identifier == "test:delegate" {
		return r.delegate
	}
	return nil
}

// newSnapTestVolume builds a 3x8x3 volume centered at x=0,z=0 with
// minecraft:sand at y=62 and air everywhere else -- the exact column the
// original bug report described (origin y=63 air, y=62 sand, range 2).
func newSnapTestVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	sand := pal.Get("minecraft:sand", nil)
	bounds := volume.Bounds{MinX: -1, MinY: 60, MinZ: -1, SizeX: 3, SizeY: 8, SizeZ: 3}
	v := volume.New(bounds, pal, block.AirID)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 62, Z: 0}, sand)
	return v, pal
}

// buildTestSnap builds a minecraft:snap_to_surface_feature (floor mode,
// vertical_search_range 2, allowed_surface_blocks [minecraft:sand],
// feature_to_snap "test:delegate") with extra passed straight through as
// additional/overriding JSON body keys -- e.g. {"allow_air_placement": true}.
func buildTestSnap(t *testing.T, pal *block.Palette, resolver wgen.IFeatureResolver, extra map[string]any) wgen.IFeature {
	t.Helper()
	body := map[string]any{
		"feature_to_snap":        "test:delegate",
		"vertical_search_range":  float64(2),
		"surface":                "floor",
		"allowed_surface_blocks": []any{"minecraft:sand"},
	}
	for k, v := range extra {
		body[k] = v
	}
	ctx := &BuildContext{
		Palette:    pal,
		Resolver:   resolver,
		Identifier: "test:snap",
		FileID:     "test:snap",
		Warn:       func(string) {},
	}
	f, err := buildSnapToSurfaceFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildSnapToSurfaceFeature: %v", err)
	}
	return f
}

func placeTestSnap(f wgen.IFeature, v *volume.Volume) *wgen.BlockPos {
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      wgen.BlockPos{X: 0, Y: 63, Z: 0},
		Random:      random.New(1),
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
	return f.Place(ctx)
}

// TestSnapToSurfaceFeature_AllowAirPlacementDefaultsToAllowed is the
// regression test for the original reported bug: a snap feature that doesn't
// set allow_air_placement must be able to scan down through air to reach an
// allowed floor (allow_air_placement defaults to true in the game).
// Before the fix this port defaulted allow_air_placement to false via
// jsonTruthy(nil), so this exact scenario (air origin directly above an
// allowed floor block, key absent) always failed.
func TestSnapToSurfaceFeature_AllowAirPlacementDefaultsToAllowed(t *testing.T) {
	v, pal := newSnapTestVolume(t)
	delegate := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{delegate}, nil) // no allow_air_placement key

	got := placeTestSnap(f, v)
	if got == nil {
		t.Fatal("Place returned nil (\"Could not find a surface snap position\") -- allow_air_placement must default to true")
	}
	if !delegate.called {
		t.Fatal("feature_to_snap was never delegated to -- snap position was never found")
	}
	want := wgen.BlockPos{X: 0, Y: 63, Z: 0} // adjacent cell above the sand at y=62
	if delegate.origin != want {
		t.Errorf("delegate placed at %+v, want %+v", delegate.origin, want)
	}
}

// TestSnapToSurfaceFeature_AllowAirPlacementExplicitTrue guards the
// explicit-true path against regressing while the default changes.
func TestSnapToSurfaceFeature_AllowAirPlacementExplicitTrue(t *testing.T) {
	v, pal := newSnapTestVolume(t)
	delegate := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{delegate}, map[string]any{"allow_air_placement": true})

	if got := placeTestSnap(f, v); got == nil {
		t.Fatal("Place returned nil with allow_air_placement: true -- explicit-true path regressed")
	}
	if !delegate.called {
		t.Fatal("feature_to_snap was never delegated to with allow_air_placement: true")
	}
}

// TestSnapToSurfaceFeature_AllowAirPlacementExplicitFalse guards the
// opposite explicit case -- vanilla behaviour: an explicit false refuses to
// scan through air, even with a floor in reach.
func TestSnapToSurfaceFeature_AllowAirPlacementExplicitFalse(t *testing.T) {
	v, pal := newSnapTestVolume(t)
	delegate := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{delegate}, map[string]any{"allow_air_placement": false})

	if got := placeTestSnap(f, v); got != nil {
		t.Errorf("Place returned %+v with allow_air_placement: false, want nil (air must not be scanned)", got)
	}
	if delegate.called {
		t.Error("feature_to_snap was delegated to with allow_air_placement: false -- should have failed before ever reaching it")
	}
}

// ---------------------------------------------------------------------------
// surface enum / embed_in_surface / passable-material semantics.
// ---------------------------------------------------------------------------

// snapColumnVolume builds a column with a sand FLOOR at y=60 and a sand
// CEILING at y=66, air in between; the origin used by placeTestSnap is y=63.
func snapColumnVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	sand := pal.Get("minecraft:sand", nil)
	v := volume.New(volume.Bounds{MinX: -1, MinY: 55, MinZ: -1, SizeX: 3, SizeY: 20, SizeZ: 3}, pal, block.AirID)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 60, Z: 0}, sand)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 66, Z: 0}, sand)
	return v, pal
}

func TestSnapToSurface_FloorAndCeilingLandOnTheAdjacentCell(t *testing.T) {
	// floor -> the cell ABOVE the floor surface block (61); ceiling -> the cell
	// BELOW the ceiling surface block (65). The range must be big enough to
	// reach both.
	for _, tc := range []struct {
		surface string
		wantY   int
	}{
		{"floor", 61},
		{"ceiling", 65},
	} {
		v, pal := snapColumnVolume(t)
		d := &stubDelegate{}
		f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
			"surface":               tc.surface,
			"vertical_search_range": float64(8),
		})
		got := placeTestSnap(f, v)
		if got == nil {
			t.Fatalf("surface %q: expected a snap, got none", tc.surface)
		}
		if got.Y != tc.wantY {
			t.Errorf("surface %q: snapped to y=%d, want y=%d", tc.surface, got.Y, tc.wantY)
		}
	}
}

func TestSnapToSurface_AbsentSurfaceKeyMeansFloor(t *testing.T) {
	// The surface mode defaults to 1 (= floor) -- in BOTH supported game
	// versions. An absent key therefore snaps DOWN. (This port defaulted to
	// ceiling until 2026-08-15, which was wrong.)
	v, pal := snapColumnVolume(t)
	d := &stubDelegate{}
	body := map[string]any{
		"feature_to_snap":        "test:delegate",
		"vertical_search_range":  float64(8),
		"allowed_surface_blocks": []any{"minecraft:sand"},
	}
	ctx := &BuildContext{Palette: pal, Resolver: stubResolver{d}, Identifier: "test:snap", FileID: "test:snap", Warn: func(string) {}}
	f, err := buildSnapToSurfaceFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildSnapToSurfaceFeature: %v", err)
	}
	got := placeTestSnap(f, v)
	if got == nil || got.Y != 61 {
		t.Fatalf("absent surface key snapped to %v, want y=61 (the cell above the floor)", got)
	}
}

func TestSnapToSurface_InvalidSurfaceValueWarnsAndDefaultsToFloor(t *testing.T) {
	// The game content-logs "Bad value for surface - ..." and leaves the
	// default (floor) in place; the file still loads.
	v, pal := snapColumnVolume(t)
	d := &stubDelegate{}
	body := map[string]any{
		"feature_to_snap":        "test:delegate",
		"vertical_search_range":  float64(8),
		"surface":                "sideways",
		"allowed_surface_blocks": []any{"minecraft:sand"},
	}
	var warned []string
	ctx := &BuildContext{Palette: pal, Resolver: stubResolver{d}, Identifier: "test:snap", FileID: "test:snap",
		Warn: func(m string) { warned = append(warned, m) }}
	f, err := buildSnapToSurfaceFeature(body, ctx)
	if err != nil {
		t.Fatalf("an invalid surface value must warn, not fail the build (the game keeps loading the file): %v", err)
	}
	if len(warned) == 0 || !strings.Contains(warned[0], "Bad value for surface") {
		t.Fatalf("expected a \"Bad value for surface\" warning, got %q", warned)
	}
	got := placeTestSnap(f, v)
	if got == nil || got.Y != 61 {
		t.Fatalf("invalid surface value snapped to %v, want y=61 (the floor default)", got)
	}
}

func TestSnapToSurface_EmbedInSurfaceLandsOnTheSurfaceBlock(t *testing.T) {
	for _, tc := range []struct {
		surface string
		wantY   int
	}{
		{"floor", 60},   // the floor block itself
		{"ceiling", 66}, // the ceiling block itself
	} {
		v, pal := snapColumnVolume(t)
		d := &stubDelegate{}
		f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
			"surface":               tc.surface,
			"vertical_search_range": float64(8),
			"embed_in_surface":      true,
		})
		got := placeTestSnap(f, v)
		if got == nil {
			t.Fatalf("surface %q with embed_in_surface: expected a snap, got none", tc.surface)
		}
		if got.Y != tc.wantY {
			t.Errorf("surface %q with embed_in_surface: snapped to y=%d, want y=%d (the surface block itself)", tc.surface, got.Y, tc.wantY)
		}
	}
}

func TestSnapToSurface_RandomHorizontalEvenDrawPicksFloor(t *testing.T) {
	// place() replaces the random_horizontal mode with `1 & ~draw`, i.e. a
	// false/"even" draw selects 1 = FLOOR. Drive both outcomes through a
	// scripted boolean source.
	for _, tc := range []struct {
		name  string
		draw  bool
		wantY int
	}{
		{"even draw -> floor", false, 61},
		{"odd draw -> ceiling", true, 65},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, pal := snapColumnVolume(t)
			d := &stubDelegate{}
			f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
				"surface":               "random_horizontal",
				"vertical_search_range": float64(8),
			})
			ctx := &wgen.PlacementContext{
				API: v, Origin: wgen.BlockPos{X: 0, Y: 63, Z: 0},
				Random:      &fixedBoolRandom{Rand: random.New(1), value: tc.draw},
				MolangScope: wgen.NewScope(),
				Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
			}
			got := f.Place(ctx)
			if got == nil || got.Y != tc.wantY {
				t.Fatalf("random_horizontal with NextBoolean()=%v snapped to %v, want y=%d", tc.draw, got, tc.wantY)
			}
		})
	}
}

// fixedBoolRandom returns a fixed NextBoolean value, everything else real.
type fixedBoolRandom struct {
	*random.Rand
	value bool
}

func (r *fixedBoolRandom) NextBoolean() bool { return r.value }

func TestSnapToSurface_LavaIsNotPassableEvenWithUnderwaterAllowed(t *testing.T) {
	// The passable predicate's liquid test is a WATER test
	// specifically; lava is not passable. (In 1.26.50.24 a lava origin now
	// takes the buried-start path instead, but without
	// allow_non_air_placement that path refuses just the same.)
	pal := block.NewPalette()
	sand := pal.Get("minecraft:sand", nil)
	lava := pal.Get("minecraft:lava", nil)
	water := pal.Get("minecraft:water", nil)

	newCol := func(fill block.ID) *volume.Volume {
		v := volume.New(volume.Bounds{MinX: -1, MinY: 55, MinZ: -1, SizeX: 3, SizeY: 20, SizeZ: 3}, pal, block.AirID)
		v.SetBlock(wgen.BlockPos{X: 0, Y: 60, Z: 0}, sand)
		for y := 61; y <= 63; y++ {
			v.SetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}, fill)
		}
		return v
	}
	build := func() wgen.IFeature {
		return buildTestSnap(t, pal, stubResolver{&stubDelegate{}}, map[string]any{
			"surface":                    "floor",
			"vertical_search_range":      float64(8),
			"allow_air_placement":        false,
			"allow_underwater_placement": true,
		})
	}
	if got := placeTestSnap(build(), newCol(water)); got == nil || got.Y != 61 {
		t.Fatalf("a water-filled column must be passable: snapped to %v, want y=61", got)
	}
	if got := placeTestSnap(build(), newCol(lava)); got != nil {
		t.Fatalf("a lava-filled column must NOT be passable, but it snapped to %v", got)
	}
}

// ---------------------------------------------------------------------------
// 1.26.50.24 changes: the search_range rename, the directional scan's
// extended reach, allow_non_air_placement, and the wall surface mode.
// ---------------------------------------------------------------------------

func TestSnapToSurface_SearchRangeRenameIsGatedOnFormatVersion(t *testing.T) {
	// 1.26.50.24 renamed vertical_search_range to search_range, gated on the
	// file's declared format_version against the 1.26.50 minimum: exactly ONE
	// of the two names is in the schema for any given file, the other is
	// dropped with a member-not-in-schema diagnostic -- there is no version
	// at which both are accepted. The columns below put the only floor at
	// distance 2 (sand at y=61, origin y=63), so a dropped range value
	// (default 0) demonstrably fails instead of silently still working.
	newVol := func() (*volume.Volume, *block.Palette) {
		pal := block.NewPalette()
		sand := pal.Get("minecraft:sand", nil)
		v := volume.New(volume.Bounds{MinX: -1, MinY: 55, MinZ: -1, SizeX: 3, SizeY: 20, SizeZ: 3}, pal, block.AirID)
		v.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, sand)
		return v, pal
	}
	build := func(t *testing.T, pal *block.Palette, fv FormatVersion, rangeKey string) (wgen.IFeature, *[]string) {
		t.Helper()
		body := map[string]any{
			"feature_to_snap":        "test:delegate",
			rangeKey:                 float64(8),
			"surface":                "floor",
			"allowed_surface_blocks": []any{"minecraft:sand"},
		}
		var warned []string
		ctx := &BuildContext{Palette: pal, Resolver: stubResolver{&stubDelegate{}},
			Identifier: "test:snap", FileID: "test:snap", FormatVersion: fv,
			Warn: func(m string) { warned = append(warned, m) }}
		f, err := buildSnapToSurfaceFeature(body, ctx)
		if err != nil {
			t.Fatalf("buildSnapToSurfaceFeature(%s, fv=%s): %v", rangeKey, fv, err)
		}
		return f, &warned
	}

	t.Run("1.26.50 file accepts search_range", func(t *testing.T) {
		v, pal := newVol()
		f, warned := build(t, pal, MustFormatVersion("1.26.50"), "search_range")
		if got := placeTestSnap(f, v); got == nil || got.Y != 62 {
			t.Fatalf("search_range at fv 1.26.50 snapped to %v, want y=62", got)
		}
		if len(*warned) != 0 {
			t.Errorf("unexpected warnings: %q", *warned)
		}
	})
	t.Run("1.26.50 file drops vertical_search_range", func(t *testing.T) {
		v, pal := newVol()
		f, warned := build(t, pal, MustFormatVersion("1.26.50"), "vertical_search_range")
		if got := placeTestSnap(f, v); got != nil {
			t.Fatalf("vertical_search_range at fv 1.26.50 must be dropped (leaving range 0), but snapped to %v", got)
		}
		if len(*warned) == 0 || !strings.Contains((*warned)[0], "not present in the schema") {
			t.Fatalf("expected a member-not-in-schema diagnostic for vertical_search_range, got %q", *warned)
		}
	})
	t.Run("pre-rename file accepts vertical_search_range", func(t *testing.T) {
		v, pal := newVol()
		f, warned := build(t, pal, MustFormatVersion("1.21.10"), "vertical_search_range")
		if got := placeTestSnap(f, v); got == nil || got.Y != 62 {
			t.Fatalf("vertical_search_range at fv 1.21.10 snapped to %v, want y=62", got)
		}
		if len(*warned) != 0 {
			t.Errorf("unexpected warnings: %q", *warned)
		}
	})
	t.Run("pre-rename file drops search_range", func(t *testing.T) {
		v, pal := newVol()
		f, warned := build(t, pal, MustFormatVersion("1.21.10"), "search_range")
		if got := placeTestSnap(f, v); got != nil {
			t.Fatalf("search_range at fv 1.21.10 must be dropped (leaving range 0), but snapped to %v", got)
		}
		if len(*warned) == 0 || !strings.Contains((*warned)[0], "not present in the schema") {
			t.Fatalf("expected a member-not-in-schema diagnostic for search_range, got %q", *warned)
		}
	})
	t.Run("absent format_version behaves as pre-rename", func(t *testing.T) {
		v, pal := newVol()
		f, warned := build(t, pal, FormatVersion{}, "vertical_search_range")
		if got := placeTestSnap(f, v); got == nil || got.Y != 62 {
			t.Fatalf("vertical_search_range with no declared format_version snapped to %v, want y=62", got)
		}
		if len(*warned) != 0 {
			t.Errorf("unexpected warnings: %q", *warned)
		}
	})
}

func TestSnapToSurface_ScanReachesTheFullSearchRange(t *testing.T) {
	// The 1.26.50 column scan starts its walk at the cell AFTER the origin,
	// so a surface at distance exactly search_range is found (the 1.26.40.26
	// scan wasted its first test re-testing the origin and only reached
	// range-1). Floor at distance 2 with range 2: y=61 sand, origin y=63.
	pal := block.NewPalette()
	sand := pal.Get("minecraft:sand", nil)
	v := volume.New(volume.Bounds{MinX: -1, MinY: 55, MinZ: -1, SizeX: 3, SizeY: 20, SizeZ: 3}, pal, block.AirID)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, sand)

	d := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
		"surface":               "floor",
		"vertical_search_range": float64(2),
	})
	got := placeTestSnap(f, v)
	if got == nil || got.Y != 62 {
		t.Fatalf("floor at distance 2 with range 2 snapped to %v, want y=62 (the cell above it)", got)
	}

	// ...and distance 3 with range 2 is still out of reach.
	v2 := volume.New(volume.Bounds{MinX: -1, MinY: 55, MinZ: -1, SizeX: 3, SizeY: 20, SizeZ: 3}, pal, block.AirID)
	v2.SetBlock(wgen.BlockPos{X: 0, Y: 60, Z: 0}, sand)
	if got := placeTestSnap(f, v2); got != nil {
		t.Fatalf("floor at distance 3 with range 2 must be out of reach, but snapped to %v", got)
	}
}

func TestSnapToSurface_RangeBelowTwoStillChecksTheAdjacentCell(t *testing.T) {
	// range < 2 skips the walk entirely but still confirms the immediate
	// neighbour (the 1.26.40.26 scan confirmed the ORIGIN itself instead).
	v, pal := newSnapTestVolume(t) // sand at y=62, origin y=63
	d := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
		"surface":               "floor",
		"vertical_search_range": float64(1),
	})
	if got := placeTestSnap(f, v); got == nil || got.Y != 63 {
		t.Fatalf("range 1 with the floor directly below snapped to %v, want y=63 (the origin)", got)
	}

	// With the floor one cell further down, range 1 cannot reach it.
	pal2 := block.NewPalette()
	sand := pal2.Get("minecraft:sand", nil)
	v2 := volume.New(volume.Bounds{MinX: -1, MinY: 55, MinZ: -1, SizeX: 3, SizeY: 20, SizeZ: 3}, pal2, block.AirID)
	v2.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, sand)
	d2 := &stubDelegate{}
	f2 := buildTestSnap(t, pal2, stubResolver{d2}, map[string]any{
		"surface":               "floor",
		"vertical_search_range": float64(1),
	})
	if got := placeTestSnap(f2, v2); got != nil {
		t.Fatalf("range 1 with the floor at distance 2 must fail, but snapped to %v", got)
	}
}

// buriedColumnVolume: sand at y=61..63, air everywhere else. The buried-start
// tests place from origin y=62, inside the sand.
func buriedColumnVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	sand := pal.Get("minecraft:sand", nil)
	v := volume.New(volume.Bounds{MinX: -1, MinY: 55, MinZ: -1, SizeX: 3, SizeY: 20, SizeZ: 3}, pal, block.AirID)
	for y := 61; y <= 63; y++ {
		v.SetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}, sand)
	}
	return v, pal
}

func placeSnapAt(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos) *wgen.BlockPos {
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      random.New(1),
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
	return f.Place(ctx)
}

func TestSnapToSurface_AllowNonAirPlacementSnapsOutOfASolid(t *testing.T) {
	// A start inside a non-air, non-water block walks the OPPOSITE direction
	// to exit the solid: floor + buried start walks UP and lands on the first
	// open cell above the ground; ceiling + buried start walks DOWN. The exit
	// cell must itself pass the air/water gates (allow_air defaults true).
	for _, tc := range []struct {
		surface string
		wantY   int
	}{
		{"floor", 64},   // first air cell above the sand run 61..63
		{"ceiling", 60}, // first air cell below it
	} {
		v, pal := buriedColumnVolume(t)
		d := &stubDelegate{}
		f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
			"surface":                 tc.surface,
			"vertical_search_range":   float64(8),
			"allow_non_air_placement": true,
			// The exit cell is air, not sand -- membership in
			// allowed_surface_blocks would veto it, so pass no list here.
			"allowed_surface_blocks": []any{},
		})
		got := placeSnapAt(f, v, wgen.BlockPos{X: 0, Y: 62, Z: 0})
		if got == nil {
			t.Fatalf("surface %q buried start with allow_non_air_placement: expected a snap, got none", tc.surface)
		}
		if got.Y != tc.wantY {
			t.Errorf("surface %q buried start snapped to y=%d, want y=%d", tc.surface, got.Y, tc.wantY)
		}
	}
}

func TestSnapToSurface_AllowNonAirPlacementDefaultsToFalse(t *testing.T) {
	// Without allow_non_air_placement, a buried start fails outright -- the
	// game's default for the flag is false.
	v, pal := buriedColumnVolume(t)
	d := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
		"surface":                "floor",
		"vertical_search_range":  float64(8),
		"allowed_surface_blocks": []any{},
	})
	if got := placeSnapAt(f, v, wgen.BlockPos{X: 0, Y: 62, Z: 0}); got != nil {
		t.Fatalf("buried start without allow_non_air_placement must fail, but snapped to %v", got)
	}
	if d.called {
		t.Error("feature_to_snap was delegated to from a buried start without allow_non_air_placement")
	}
}

func TestSnapToSurface_AllowNonAirPlacementEmbedLandsOnTheLastSolid(t *testing.T) {
	// Buried start + embed_in_surface: the snap stays on the surface side --
	// the LAST solid cell of the run, not the open exit cell.
	v, pal := buriedColumnVolume(t)
	d := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
		"surface":                 "floor",
		"vertical_search_range":   float64(8),
		"allow_non_air_placement": true,
		"embed_in_surface":        true,
		"allowed_surface_blocks":  []any{},
	})
	got := placeSnapAt(f, v, wgen.BlockPos{X: 0, Y: 62, Z: 0})
	if got == nil || got.Y != 63 {
		t.Fatalf("buried start with embed_in_surface snapped to %v, want y=63 (the last solid cell)", got)
	}
}

// ---------------------------------------------------------------------------
// wall mode
// ---------------------------------------------------------------------------

// scriptedIntRandom returns queued NextIntBound values (recording the bounds
// it was asked for), everything else real.
type scriptedIntRandom struct {
	*random.Rand
	values []int
	bounds []int
}

func (r *scriptedIntRandom) NextIntBound(bound int) int {
	r.bounds = append(r.bounds, bound)
	if len(r.values) == 0 {
		return 0
	}
	v := r.values[0]
	r.values = r.values[1:]
	return v
}

// wallTestVolume: an open room with a sand pillar at (2, 63, 0) -- one wall
// candidate to the EAST of the origin (0, 63, 0) -- plus, when westToo is
// set, a second pillar at (-2, 63, 0).
func wallTestVolume(t *testing.T, westToo bool) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	sand := pal.Get("minecraft:sand", nil)
	v := volume.New(volume.Bounds{MinX: -4, MinY: 60, MinZ: -4, SizeX: 9, SizeY: 8, SizeZ: 9}, pal, block.AirID)
	v.SetBlock(wgen.BlockPos{X: 2, Y: 63, Z: 0}, sand)
	if westToo {
		v.SetBlock(wgen.BlockPos{X: -2, Y: 63, Z: 0}, sand)
	}
	return v, pal
}

func placeWallSnap(f wgen.IFeature, v *volume.Volume, rnd random.IRandom) *wgen.BlockPos {
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      wgen.BlockPos{X: 0, Y: 63, Z: 0},
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
	return f.Place(ctx)
}

func TestSnapToSurface_WallSnapsToTheAdjacentOpenCell(t *testing.T) {
	// Identity shuffle (draws 1, 2, 3 leave [north, east, south, west]
	// untouched): north finds nothing, east finds the sand at x=2 and snaps
	// to the open cell beside it at x=1. Also pins the draw sequence: exactly
	// three bounded draws with bounds 2, 3, 4, before any searching.
	v, pal := wallTestVolume(t, false)
	d := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
		"surface":               "wall",
		"vertical_search_range": float64(3),
	})
	rnd := &scriptedIntRandom{Rand: random.New(1), values: []int{1, 2, 3}}
	got := placeWallSnap(f, v, rnd)
	if got == nil {
		t.Fatal("wall snap with a wall to the east: expected a snap, got none")
	}
	want := wgen.BlockPos{X: 1, Y: 63, Z: 0}
	if *got != want {
		t.Errorf("wall snap landed at %+v, want %+v (the open cell beside the wall)", *got, want)
	}
	wantBounds := []int{2, 3, 4}
	if len(rnd.bounds) != 3 || rnd.bounds[0] != 2 || rnd.bounds[1] != 3 || rnd.bounds[2] != 4 {
		t.Errorf("wall mode drew bounds %v, want %v (three bounded draws, always, in that order)", rnd.bounds, wantBounds)
	}
}

func TestSnapToSurface_WallShuffleControlsTheSearchOrder(t *testing.T) {
	// Two candidate walls, east and west. The game's ascending
	// Fisher-Yates over the initial [north, east, south, west]:
	//   draws {1,2,3} -> identity          -> east is tried before west
	//   draws {0,0,0} -> [west, north, east, south] -> west is tried first
	f := func(t *testing.T, draws []int, want wgen.BlockPos) {
		v, pal := wallTestVolume(t, true)
		d := &stubDelegate{}
		feat := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
			"surface":               "wall",
			"vertical_search_range": float64(3),
		})
		rnd := &scriptedIntRandom{Rand: random.New(1), values: draws}
		got := placeWallSnap(feat, v, rnd)
		if got == nil || *got != want {
			t.Fatalf("draws %v snapped to %v, want %+v", draws, got, want)
		}
	}
	t.Run("identity order tries east before west", func(t *testing.T) {
		f(t, []int{1, 2, 3}, wgen.BlockPos{X: 1, Y: 63, Z: 0})
	})
	t.Run("all-zero draws put west first", func(t *testing.T) {
		f(t, []int{0, 0, 0}, wgen.BlockPos{X: -1, Y: 63, Z: 0})
	})
}

func TestSnapToSurface_WallEmbedLandsOnTheWallBlock(t *testing.T) {
	v, pal := wallTestVolume(t, false)
	d := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
		"surface":               "wall",
		"vertical_search_range": float64(3),
		"embed_in_surface":      true,
	})
	rnd := &scriptedIntRandom{Rand: random.New(1), values: []int{1, 2, 3}}
	got := placeWallSnap(f, v, rnd)
	want := wgen.BlockPos{X: 2, Y: 63, Z: 0}
	if got == nil || *got != want {
		t.Fatalf("wall snap with embed_in_surface landed at %v, want %+v (the wall block itself)", got, want)
	}
}

func TestSnapToSurface_WallOutOfReachFails(t *testing.T) {
	// The wall is at distance 2 (x=2); range 1 confirms only the adjacent
	// cell in each direction, all of which are air and fail the allowed list.
	v, pal := wallTestVolume(t, false)
	d := &stubDelegate{}
	f := buildTestSnap(t, pal, stubResolver{d}, map[string]any{
		"surface":               "wall",
		"vertical_search_range": float64(1),
	})
	rnd := &scriptedIntRandom{Rand: random.New(1), values: []int{1, 2, 3}}
	if got := placeWallSnap(f, v, rnd); got != nil {
		t.Fatalf("wall at distance 2 with range 1 must be out of reach, but snapped to %v", got)
	}
	if d.called {
		t.Error("feature_to_snap was delegated to despite every wall direction failing")
	}
}

// TestBuildSnapToSurface_TagAllowedSurfaceBlocks_Warns pins the one divergence in this type that
// is invisible from the preview: a tag-form entry in allowed_surface_blocks works here and
// matches nothing in the real game, so the feature previews correctly and places nothing in the
// world. Without the warning there is no signal at all -- the file loads, the run succeeds, and
// the blocks appear.
func TestBuildSnapToSurface_TagAllowedSurfaceBlocks_Warns(t *testing.T) {
	build := func(allowed []any) []string {
		t.Helper()
		var warnings []string
		ctx := &BuildContext{
			Palette: block.NewPalette(), Identifier: "test:s", FileID: "s.json",
			Warn: func(m string) { warnings = append(warnings, m) },
		}
		body := map[string]any{
			"description":     map[string]any{"identifier": "test:s"},
			"feature_to_snap": "test:delegate",
			"search_range":    8.0,
		}
		if allowed != nil {
			body["allowed_surface_blocks"] = allowed
		}
		if _, err := buildSnapToSurfaceFeature(body, ctx); err != nil {
			t.Fatalf("buildSnapToSurfaceFeature: %v", err)
		}
		var out []string
		for _, w := range warnings {
			if strings.Contains(w, "allowed_surface_blocks") {
				out = append(out, w)
			}
		}
		return out
	}

	tagged := build([]any{map[string]any{"tags": "q.any_tag('stone')"}})
	if len(tagged) != 1 {
		t.Fatalf("a tag-form entry must warn: got %d warnings %v", len(tagged), tagged)
	}
	if !strings.Contains(tagged[0], "places nothing in the world") {
		t.Errorf("the warning does not say what actually happens in game: %q", tagged[0])
	}

	// A mixed list still warns once: one tag entry is enough to make every snap fail in game,
	// regardless of what else is listed beside it.
	mixed := build([]any{"minecraft:stone", map[string]any{"tags": "q.any_tag('dirt')"}})
	if len(mixed) != 1 {
		t.Errorf("a list with one tag entry among names must warn exactly once, got %v", mixed)
	}

	if got := build([]any{"minecraft:stone", "minecraft:grass_block"}); len(got) != 0 {
		t.Errorf("plain block names are the shape that works in game and must not warn, got %v", got)
	}
	if got := build(nil); len(got) != 0 {
		t.Errorf("no allowed_surface_blocks at all must not warn, got %v", got)
	}
}
