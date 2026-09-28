// block_identity_test.go pins the width at which each feature compares a world
// cell against a block it was configured with, for the fields that do NOT go
// through a match list: the same block may be interned bare or with its
// default states written out, and each comparison has to treat those alike
// where the game does and apart where it does not.
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

func deepslateAxis(pal *block.Palette, axis string) block.ID {
	return pal.Get("minecraft:deepslate", map[string]block.StateValue{"pillar_axis": axis})
}

// allowed_surface_blocks compares the whole block: a bare entry means the
// type's default permutation. Deepslate placed with its default axis (y) and
// the axis written out is the same block and snaps; deepslate on its side is a
// different block and does not, even though the name is the same.
func TestSnapToSurface_BareAllowedEntryMeansTheDefaultPermutation(t *testing.T) {
	for _, tc := range []struct {
		axis string
		want bool
	}{{"y", true}, {"x", false}, {"z", false}} {
		pal := block.NewPalette()
		bounds := volume.Bounds{MinX: -1, MinY: 60, MinZ: -1, SizeX: 3, SizeY: 8, SizeZ: 3}
		v := volume.New(bounds, pal, block.AirID)
		v.SetBlock(wgen.BlockPos{X: 0, Y: 62, Z: 0}, deepslateAxis(pal, tc.axis))
		f := buildTestSnap(t, pal, stubResolver{&stubDelegate{}}, map[string]any{
			"allowed_surface_blocks": []any{"minecraft:deepslate"},
		})
		got := placeTestSnap(f, v) != nil
		if got != tc.want {
			t.Errorf("deepslate pillar_axis=%s under a bare allowed entry: snapped=%v, want %v", tc.axis, got, tc.want)
		}
	}
}

// A mangrove root landing on mud_block becomes muddy_root_block. The test is
// the whole block, so a cell holding the mud block with its default states
// written out is mud; one in another state is not.
func TestMangrovePlaceRoot_MudBlockComparesTheCompletedBlock(t *testing.T) {
	for _, tc := range []struct {
		axis  string
		muddy bool
	}{{"y", true}, {"x", false}} {
		pal := block.NewPalette()
		air := pal.Get("minecraft:air", nil)
		v := volume.New(volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}, pal, air)
		r := mangroveTestRoots(pal, 0, 3)
		r.mudBlock = pal.Get("minecraft:deepslate", nil)
		r.rootsMayGrowThrough = block.MatchSet{}
		pos := wgen.BlockPos{}
		v.SetBlock(pos, deepslateAxis(pal, tc.axis))
		mangrovePlaceRoot(v, pos, &mangroveScriptedRandom{}, r)
		want := r.rootBlock
		if tc.muddy {
			want = r.muddyRootBlock
		}
		if got := v.GetBlock(pos); got != want {
			t.Errorf("mud cell pillar_axis=%s: placed %v, want %v", tc.axis, pal.Entry(got), pal.Entry(want))
		}
	}
}

// An ore rule skips a cell that already IS its target. Stone-like deepslate
// with its default axis written out is the bare target, so the vein leaves it
// alone rather than rewriting it with a differently spelled copy of itself.
func TestOreFeature_AlreadyTargetComparesTheCompletedBlock(t *testing.T) {
	pal := block.NewPalette()
	stated := deepslateAxis(pal, "y")
	bare := pal.Get("minecraft:deepslate", nil)
	b := volume.Bounds{MinX: -32, MinY: 32, MinZ: -32, SizeX: 65, SizeY: 65, SizeZ: 65}
	v := volume.New(b, pal, stated)
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				v.SetBlockUnbudgeted(wgen.BlockPos{X: x, Y: y, Z: z}, stated)
			}
		}
	}
	f := buildTestOre(t, pal, oreTestBody(8, []any{map[string]any{
		"places_block": "minecraft:deepslate",
		"may_replace":  []any{"minecraft:deepslate"},
	}}))
	orePlace(f, v, wgen.BlockPos{X: 0, Y: 64, Z: 0}, random.New(3))
	for x := -24; x <= 24; x++ {
		for y := 40; y <= 88; y++ {
			for z := -24; z <= 24; z++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == bare {
					t.Fatalf("cell (%d,%d,%d) was rewritten although it already held the target block", x, y, z)
				}
			}
		}
	}
}

// vegetation_patch counts a cell as already ground by block TYPE: ground in
// any state is ground, so a floor of deepslate on its side under a bare
// ground_block keeps every column even though deepslate is not replaceable.
func TestVegetationPatch_AlreadyGroundComparesTheType(t *testing.T) {
	pal := block.NewPalette()
	sideways := deepslateAxis(pal, "x")
	v := volume.New(volume.Bounds{MinX: -2, MinY: 6, MinZ: -2, SizeX: 5, SizeY: 8, SizeZ: 5}, pal, block.AirID)
	for x := -2; x <= 2; x++ {
		for z := -2; z <= 2; z++ {
			for y := 7; y <= 9; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, sideways)
			}
		}
	}
	marker := &vegMarkerDelegate{v: v, marker: pal.Get("minecraft:torch", nil)}
	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"ground_block":             "minecraft:deepslate",
		"replaceable_blocks":       []any{"minecraft:air"},
		"extra_edge_column_chance": float64(1),
	})
	if got := f.Place(vegTestCtx(v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(1))); got == nil {
		t.Fatal("expected the patch to keep its columns: the floor is already ground_block")
	}
	if want := len(vegPatchColumns(2)); len(marker.origins) != want {
		t.Fatalf("expected %d vegetation delegations, got %d", want, len(marker.origins))
	}
	for _, c := range vegPatchColumns(2) {
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 9, Z: c.Z}); got != sideways {
			t.Errorf("column %+v: ground rewritten to %v", c, pal.Entry(got))
		}
	}
}
