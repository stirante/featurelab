// vegetation_patch_waterlogged_test.go pins waterlogged: true -- the ground
// patch is built as usual, then only its unexposed cells are kept and turned
// to water, and the vegetation grows from those, one block lower.
package features

import (
	"testing"

	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

func countFloats(tr *random.Tracer) int {
	n := 0
	for _, d := range tr.Draws {
		if d.Method == random.MethodNextFloat {
			n++
		}
	}
	return n
}

// A buried floor patch: every ground cell is unexposed, so each becomes
// water with ground_block under it, and the vegetation grows in the water.
func TestVegetationPatchFeature_Waterlogged_FloodsTheGroundAndGrowsInTheWater(t *testing.T) {
	v, pal := newVegFloorVolume(t)
	podzol := pal.Get("minecraft:podzol", nil)
	water := pal.Get("minecraft:water", nil)
	torch := pal.Get("minecraft:torch", nil)
	marker := &vegMarkerDelegate{v: v, marker: torch}
	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{"waterlogged": true})

	got := f.Place(vegTestCtx(v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(1)))
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}
	// radius 1 -> span 2 with the edge ring dropped: the 3x3 interior.
	if len(marker.origins) != 9 {
		t.Fatalf("delegations = %d, want 9", len(marker.origins))
	}
	for _, o := range marker.origins {
		if o.Y != 9 {
			t.Errorf("vegetation at %+v, want Y=9 (the water cell, not the air above it)", o)
		}
	}
	for x := -1; x <= 1; x++ {
		for z := -1; z <= 1; z++ {
			// the marker overwrote the water in the test's delegate; the
			// ground block below it is the fill's second cell.
			if b := v.GetBlock(wgen.BlockPos{X: x, Y: 8, Z: z}); b != podzol {
				t.Errorf("(%d,8,%d) = %v, want podzol", x, z, pal.Entry(b))
			}
			if b := v.GetBlock(wgen.BlockPos{X: x, Y: 10, Z: z}); b == water || b == torch {
				t.Errorf("(%d,10,%d) = %v, want the air above left alone", x, z, pal.Entry(b))
			}
		}
	}

	// With vegetation_chance 0 the water itself stays visible.
	v2, pal2 := newVegFloorVolume(t)
	f2 := buildTestVegPatch(t, pal2, vegMarkerResolver{&vegMarkerDelegate{v: v2}}, map[string]any{
		"waterlogged": true, "vegetation_chance": float64(0),
	})
	if f2.Place(vegTestCtx(v2, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(1))) == nil {
		t.Fatal("Place() = nil with vegetation_chance 0, want success")
	}
	water2 := pal2.Get("minecraft:water", nil)
	for x := -1; x <= 1; x++ {
		for z := -1; z <= 1; z++ {
			if b := v2.GetBlock(wgen.BlockPos{X: x, Y: 9, Z: z}); b != water2 {
				t.Errorf("(%d,9,%d) = %v, want water", x, z, pal2.Entry(b))
			}
		}
	}
}

// An exposed cell (air beside it) stays ground_block, gets no water, and
// spends no vegetation draw.
func TestVegetationPatchFeature_Waterlogged_ExposedCellIsDropped(t *testing.T) {
	run := func(hole bool) (*random.Tracer, *vegMarkerDelegate, func(wgen.BlockPos) string) {
		v, pal := newVegFloorVolume(t)
		if hole {
			v.SetBlock(wgen.BlockPos{X: 2, Y: 9, Z: 0}, pal.Get("minecraft:air", nil))
		}
		marker := &vegMarkerDelegate{v: v, marker: pal.Get("minecraft:torch", nil)}
		f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{"waterlogged": true})
		tr := random.NewTracer(random.New(1))
		if f.Place(vegTestCtx(v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, tr)) == nil {
			t.Fatal("Place() = nil, want success")
		}
		return tr, marker, func(p wgen.BlockPos) string { return pal.NameOf(v.GetBlock(p)) }
	}
	trFull, _, _ := run(false)
	trHole, marker, at := run(true)
	if len(marker.origins) != 8 {
		t.Fatalf("delegations = %d, want 8 (the cell beside the hole is exposed)", len(marker.origins))
	}
	for _, o := range marker.origins {
		if o.X == 1 && o.Z == 0 {
			t.Errorf("vegetation grew on the exposed cell at %+v", o)
		}
	}
	if got := at(wgen.BlockPos{X: 1, Y: 9, Z: 0}); got != "minecraft:podzol" {
		t.Errorf("exposed cell = %q, want minecraft:podzol (no water)", got)
	}
	if a, b := countFloats(trFull), countFloats(trHole); a-b != 1 {
		t.Errorf("float draws %d vs %d, want exactly one fewer (no vegetation draw for the dropped cell)", a, b)
	}
}

// A ceiling patch over an air pocket: every ground cell has air below it, so
// every cell is exposed. The ground is still written and the patch fails.
func TestVegetationPatchFeature_Waterlogged_AllExposedFailsAfterWritingGround(t *testing.T) {
	v, pal := newVegCeilingVolume(t)
	marker := &vegMarkerDelegate{v: v, marker: pal.Get("minecraft:torch", nil)}
	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"waterlogged": true, "surface": "ceiling",
	})
	if got := f.Place(vegTestCtx(v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(1))); got != nil {
		t.Fatalf("Place() = %+v, want nil (every cell exposed)", got)
	}
	if len(marker.origins) != 0 {
		t.Fatalf("delegations = %d, want 0", len(marker.origins))
	}
	if got := pal.NameOf(v.GetBlock(wgen.BlockPos{X: 0, Y: 11, Z: 0})); got != "minecraft:podzol" {
		t.Errorf("ceiling ground = %q, want minecraft:podzol (written before the filter)", got)
	}
}

// vegIsExposed's neighbour set: the four sides and below, never above.
func TestVegIsExposed_FiveNeighboursNotAbove(t *testing.T) {
	v, pal := newVegFloorVolume(t)
	air := pal.Get("minecraft:air", nil)
	p := wgen.BlockPos{X: 0, Y: 8, Z: 0} // buried in dirt, dirt above at Y=9
	if vegIsExposed(v, p) {
		t.Fatal("buried cell reported exposed")
	}
	v.SetBlock(wgen.BlockPos{X: 0, Y: 9, Z: 0}, air)
	if vegIsExposed(v, p) {
		t.Error("air ABOVE made the cell exposed; above is never checked")
	}
	for _, off := range []wgen.BlockPos{{Z: -1}, {X: 1}, {Z: 1}, {X: -1}, {Y: -1}} {
		v2, pal2 := newVegFloorVolume(t)
		v2.SetBlock(wgen.BlockPos{X: p.X + off.X, Y: p.Y + off.Y, Z: p.Z + off.Z}, pal2.Get("minecraft:air", nil))
		if !vegIsExposed(v2, p) {
			t.Errorf("air at offset %+v: not exposed, want exposed", off)
		}
	}
}
