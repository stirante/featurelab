// snap_to_surface_support_test.go pins the 2026-08-21 change to
// minecraft:snap_to_surface_feature's no-allowed-list surface confirmation:
// the game asks the block's support test about the opposite face of the
// walk direction, with the any-support-type argument -- not "is this block
// solid".
// block/support_test.go pins the answers themselves; this file pins the two
// things only the feature can get wrong -- that the FACE handed to that
// question is the one the walk arrived from, and that a non-empty
// allowed_surface_blocks still bypasses the whole question.
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// snapSupportVolume builds a column with a single surface block of the caller's
// choosing at y=62 (below the y=63 origin) or y=64 (above it), everything else
// air, and no allowed_surface_blocks -- so the confirm step is the
// support-test branch.
func snapSupportVolume(t *testing.T, name string, states map[string]block.StateValue, y int) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	id := pal.Get(name, states)
	bounds := volume.Bounds{MinX: -1, MinY: 60, MinZ: -1, SizeX: 3, SizeY: 8, SizeZ: 3}
	v := volume.New(bounds, pal, block.AirID)
	v.SetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}, id)
	return v, pal
}

func buildFaceTestSnap(t *testing.T, pal *block.Palette, resolver wgen.IFeatureResolver, body map[string]any) wgen.IFeature {
	t.Helper()
	ctx := &BuildContext{
		Palette: pal, Resolver: resolver,
		Identifier: "test:snap", FileID: "test:snap", Warn: func(string) {},
	}
	f, err := buildSnapToSurfaceFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildSnapToSurfaceFeature: %v", err)
	}
	return f
}

func placeFaceTestSnap(f wgen.IFeature, v *volume.Volume) *wgen.BlockPos {
	return f.Place(&wgen.PlacementContext{
		API:         v,
		Origin:      wgen.BlockPos{X: 0, Y: 63, Z: 0},
		Random:      random.New(1),
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	})
}

// TestSnapToSurface_ConfirmAsksTheFaceTheWalkArrivedFrom is the whole point of
// the change: the same block accepts a floor scan and rejects a ceiling scan
// (or the reverse) purely because the two scans ask about different faces.
func TestSnapToSurface_ConfirmAsksTheFaceTheWalkArrivedFrom(t *testing.T) {
	cases := []struct {
		label     string
		name      string
		states    map[string]block.StateValue
		surfaceY  int
		surface   string
		wantSnapY int // 0 means "expect no snap"
	}{
		// A BOTTOM slab supports its DOWN face only. A floor scan walks down and
		// asks about UP -> no surface. A ceiling scan walks up and asks about
		// DOWN -> confirmed, land in the cell below it.
		{"bottom slab is not a floor", "minecraft:oak_slab",
			map[string]block.StateValue{block.VerticalHalfState: "bottom"}, 62, "floor", 0},
		{"bottom slab IS a ceiling", "minecraft:oak_slab",
			map[string]block.StateValue{block.VerticalHalfState: "bottom"}, 64, "ceiling", 63},
		// ...and a TOP slab is the mirror image.
		{"top slab IS a floor", "minecraft:oak_slab",
			map[string]block.StateValue{block.VerticalHalfState: "top"}, 62, "floor", 63},
		{"top slab is not a ceiling", "minecraft:oak_slab",
			map[string]block.StateValue{block.VerticalHalfState: "top"}, 64, "ceiling", 0},
		// Farmland is DOWN-only: never a floor, always a ceiling.
		{"farmland is not a floor", "minecraft:farmland", nil, 62, "floor", 0},
		{"farmland IS a ceiling", "minecraft:farmland", nil, 64, "ceiling", 63},
		// A fence supports both vertical faces, so it works either way.
		{"fence is a floor", "minecraft:oak_fence", nil, 62, "floor", 63},
		{"fence is a ceiling", "minecraft:oak_fence", nil, 64, "ceiling", 63},
		// Glass is the case that goes the OTHER way from the old IsSolid test:
		// this bench classifies it as a non-solid KIND, but the block
		// type's default leaves it supporting every face.
		{"glass is a floor even though it is not a solid kind", "minecraft:glass", nil, 62, "floor", 63},
		// Leaves are the reverse: a solid-ish looking block the game refuses.
		{"leaves support nothing", "minecraft:oak_leaves", nil, 62, "floor", 0},
		// A torch supports no face at all.
		{"torch supports nothing", "minecraft:torch", nil, 62, "floor", 0},
	}

	for _, tc := range cases {
		v, pal := snapSupportVolume(t, tc.name, tc.states, tc.surfaceY)
		d := &stubDelegate{}
		f := buildFaceTestSnap(t, pal, stubResolver{d}, map[string]any{
			"feature_to_snap":       "test:delegate",
			"vertical_search_range": float64(4),
			"surface":               tc.surface,
		})
		got := placeFaceTestSnap(f, v)
		if tc.wantSnapY == 0 {
			if got != nil {
				t.Errorf("%s: expected no snap, got %v", tc.label, *got)
			}
			continue
		}
		if got == nil {
			t.Errorf("%s: expected a snap to y=%d, got none", tc.label, tc.wantSnapY)
			continue
		}
		if got.Y != tc.wantSnapY {
			t.Errorf("%s: snapped to y=%d, want y=%d", tc.label, got.Y, tc.wantSnapY)
		}
	}
}

// TestSnapToSurface_WallAsksTheOppositeHorizontalFace pins the horizontal half
// of the same mapping. The only candidate block sits due EAST of the origin, so
// the only direction that can confirm is the eastward walk -- and that walk asks
// the block about its WEST face (the opposite of east). A right-side-up
// stair with weirdo_direction 1 backs onto west
// (stair direction to facing: 5 - 1 = 4 = WEST) and confirms;
// weirdo_direction 0 backs onto east (5 - 0 = 5) and does not, leaving the whole
// four-direction search with nothing. The shuffle order cannot change either
// outcome, because the other three directions run into air.
func TestSnapToSurface_WallAsksTheOppositeHorizontalFace(t *testing.T) {
	for _, tc := range []struct {
		weirdo float64
		want   bool
	}{
		{1, true},  // backs onto WEST -- the face the eastward walk asks about
		{0, false}, // backs onto EAST -- the far side, not the one being asked
	} {
		pal := block.NewPalette()
		stair := pal.Get("minecraft:oak_stairs", map[string]block.StateValue{
			"upside_down_bit":  false,
			"weirdo_direction": tc.weirdo,
		})
		bounds := volume.Bounds{MinX: -4, MinY: 60, MinZ: -4, SizeX: 9, SizeY: 8, SizeZ: 9}
		v := volume.New(bounds, pal, block.AirID)
		v.SetBlock(wgen.BlockPos{X: 1, Y: 63, Z: 0}, stair)
		d := &stubDelegate{}
		f := buildFaceTestSnap(t, pal, stubResolver{d}, map[string]any{
			"feature_to_snap":       "test:delegate",
			"vertical_search_range": float64(2),
			"surface":               "wall",
		})
		got := placeFaceTestSnap(f, v)
		if tc.want && got == nil {
			t.Errorf("weirdo_direction %v: expected a wall snap, got none", tc.weirdo)
		}
		if !tc.want && got != nil {
			t.Errorf("weirdo_direction %v: expected no wall snap, got %v", tc.weirdo, *got)
		}
	}
}

// TestSnapToSurface_AllowedSurfaceBlocksStillBypassesTheSupportTest guards the
// half of confirm() that did NOT change: with a non-empty
// allowed_surface_blocks the game runs a plain match-set test, and
// never asks about support at all. Torch supports no face, so if the support
// test were reachable here this would fail.
func TestSnapToSurface_AllowedSurfaceBlocksStillBypassesTheSupportTest(t *testing.T) {
	v, pal := snapSupportVolume(t, "minecraft:torch", nil, 62)
	d := &stubDelegate{}
	f := buildFaceTestSnap(t, pal, stubResolver{d}, map[string]any{
		"feature_to_snap":        "test:delegate",
		"vertical_search_range":  float64(4),
		"surface":                "floor",
		"allowed_surface_blocks": []any{"minecraft:torch"},
	})
	got := placeFaceTestSnap(f, v)
	if got == nil || got.Y != 63 {
		t.Fatalf("an explicit allowed_surface_blocks must still match a torch floor; got %v", got)
	}

	// ...and conversely still REJECTS a block that would have passed the
	// support test, so the allow-list is genuinely the only thing consulted.
	v2, pal2 := snapSupportVolume(t, "minecraft:stone", nil, 62)
	d2 := &stubDelegate{}
	f2 := buildFaceTestSnap(t, pal2, stubResolver{d2}, map[string]any{
		"feature_to_snap":        "test:delegate",
		"vertical_search_range":  float64(4),
		"surface":                "floor",
		"allowed_surface_blocks": []any{"minecraft:sand"},
	})
	if got := placeFaceTestSnap(f2, v2); got != nil {
		t.Fatalf("stone is not in allowed_surface_blocks but snapped to %v", *got)
	}
}

// TestSnapToSurface_AddOnBlocksKeepTheBlockTypeDefault records a vanilla
// behaviour: an add-on block named like a vanilla family (say
// "example:custom_stairs") is NOT given that family's rule, because the game
// attaches no block support component to a JSON-defined block. Applying the
// "_stairs" family by name alone would make a bottom-half add-on stair reject
// a floor scan.
func TestSnapToSurface_AddOnBlocksKeepTheBlockTypeDefault(t *testing.T) {
	states := map[string]block.StateValue{
		block.CardinalDirectionState: "west",
		block.VerticalHalfState:      "bottom",
	}
	v, pal := snapSupportVolume(t, "example:custom_stairs", states, 62)
	d := &stubDelegate{}
	f := buildFaceTestSnap(t, pal, stubResolver{d}, map[string]any{
		"feature_to_snap":       "test:delegate",
		"vertical_search_range": float64(4),
		"surface":               "floor",
	})
	got := placeFaceTestSnap(f, v)
	if got == nil || got.Y != 63 {
		t.Fatalf("an add-on block must keep the block-type default (supports every face); got %v", got)
	}
}
