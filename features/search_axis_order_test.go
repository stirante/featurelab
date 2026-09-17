// search_axis_order_test.go pins minecraft:search_feature's per-axis loop
// nesting (see search_feature.go's searchAxisPlans for the table). A search
// with a FULLY DEGENERATE volume (min == max on all three axes, i.e. a single
// candidate cell) cannot observe the nesting at all, so these tests are the
// only thing standing between a wrong table and a pack that actually searches
// a volume.
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// visitRecorder records the origin of every Place call and never succeeds, so
// the search exhausts its whole volume and the full visit order is observable.
type visitRecorder struct{ visited []wgen.BlockPos }

func (r *visitRecorder) TypeID() string     { return "test:visit" }
func (r *visitRecorder) Identifier() string { return "test:visit" }
func (r *visitRecorder) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	r.visited = append(r.visited, ctx.Origin)
	return nil
}

type visitResolver struct{ d *visitRecorder }

func (v visitResolver) Resolve(id string) wgen.IFeature {
	if id == "test:visit" {
		return v.d
	}
	return nil
}

// searchVisitOrder runs a search_feature over the volume [0..1]^3 with the
// given axis and returns the visited offsets, in order.
func searchVisitOrder(t *testing.T, axis string) []wgen.BlockPos {
	t.Helper()
	pal := block.NewPalette()
	rec := &visitRecorder{}
	bctx := &BuildContext{Palette: pal, Resolver: visitResolver{rec}, Identifier: "test:search", FileID: "test:search", Warn: func(string) {}}
	f, err := buildSearchFeature(map[string]any{
		"places_feature": "test:visit",
		"search_volume": map[string]any{
			"min": []any{float64(0), float64(0), float64(0)},
			"max": []any{float64(1), float64(1), float64(1)},
		},
		"search_axis":        axis,
		"required_successes": float64(1),
	}, bctx)
	if err != nil {
		t.Fatalf("buildSearchFeature(%s): %v", axis, err)
	}
	v := volume.New(volume.Bounds{MinX: -4, MinY: -4, MinZ: -4, SizeX: 12, SizeY: 12, SizeZ: 12}, pal, block.AirID)
	f.Place(&wgen.PlacementContext{
		API: v, Origin: wgen.BlockPos{}, Random: random.New(1), MolangScope: wgen.NewScope(),
		Biome:      &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {},
	})
	return rec.visited
}

func TestSearchFeature_VisitOrderPerAxis(t *testing.T) {
	// Expected order, straight from the table:
	//
	//	axis    outer  mid  inner        (inner is always ascending)
	//	-x      x-     z-   y+
	//	+x      x+     z+   y+
	//	-y      y-     x-   z+
	//	+y      y+     x+   z+
	//	-z      z-     x+   y+
	//	+z      z+     x-   y+
	//
	// Over [0..1]^3 each axis yields all 8 cells; the ORDER is the assertion.
	type step struct {
		axis string
		sign int
	}
	plans := map[string][3]step{
		"-x": {{"x", -1}, {"z", -1}, {"y", 1}},
		"+x": {{"x", 1}, {"z", 1}, {"y", 1}},
		"-y": {{"y", -1}, {"x", -1}, {"z", 1}},
		"+y": {{"y", 1}, {"x", 1}, {"z", 1}},
		"-z": {{"z", -1}, {"x", 1}, {"y", 1}},
		"+z": {{"z", 1}, {"x", -1}, {"y", 1}},
	}
	values := func(sign int) []int {
		if sign < 0 {
			return []int{1, 0}
		}
		return []int{0, 1}
	}
	set := func(p *wgen.BlockPos, axis string, v int) {
		switch axis {
		case "x":
			p.X = v
		case "y":
			p.Y = v
		default:
			p.Z = v
		}
	}

	for axis, plan := range plans {
		t.Run(axis, func(t *testing.T) {
			var want []wgen.BlockPos
			for _, o := range values(plan[0].sign) {
				for _, m := range values(plan[1].sign) {
					for _, i := range values(plan[2].sign) {
						var p wgen.BlockPos
						set(&p, plan[0].axis, o)
						set(&p, plan[1].axis, m)
						set(&p, plan[2].axis, i)
						want = append(want, p)
					}
				}
			}
			got := searchVisitOrder(t, axis)
			if len(got) != len(want) {
				t.Fatalf("visited %d cells, want %d: %v", len(got), len(want), got)
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("visit %d = %v, want %v\n got: %v\nwant: %v", i, got[i], want[i], got, want)
				}
			}
		})
	}
}

func TestSearchFeature_InnerLoopIsAlwaysAscending(t *testing.T) {
	// A property the table has to keep: whichever axis ends up innermost, its
	// two values are visited low-then-high for every one of the six axes.
	inner := map[string]string{"-x": "y", "+x": "y", "-y": "z", "+y": "z", "-z": "y", "+z": "y"}
	get := func(p wgen.BlockPos, axis string) int {
		switch axis {
		case "x":
			return p.X
		case "y":
			return p.Y
		default:
			return p.Z
		}
	}
	for axis, innerAxis := range inner {
		got := searchVisitOrder(t, axis)
		if len(got) < 2 {
			t.Fatalf("%s: visited %d cells", axis, len(got))
		}
		if a, b := get(got[0], innerAxis), get(got[1], innerAxis); !(a == 0 && b == 1) {
			t.Errorf("%s: inner axis %s went %d then %d, want 0 then 1", axis, innerAxis, a, b)
		}
	}
}

func TestSearchFeature_RequiredSuccessesStopsAtTheNthHit(t *testing.T) {
	// required_successes is optional with a default of 1. With a
	// delegate that always succeeds, the search must stop after exactly N
	// candidate visits.
	pal := block.NewPalette()
	for _, n := range []int{1, 3, 8} {
		rec := &countingSucceeder{}
		bctx := &BuildContext{Palette: pal, Resolver: countingResolver{rec}, Identifier: "test:search", FileID: "test:search", Warn: func(string) {}}
		body := map[string]any{
			"places_feature": "test:count",
			"search_volume": map[string]any{
				"min": []any{float64(0), float64(0), float64(0)},
				"max": []any{float64(1), float64(1), float64(1)},
			},
			"search_axis": "+y",
		}
		if n != 1 {
			body["required_successes"] = float64(n)
		}
		f, err := buildSearchFeature(body, bctx)
		if err != nil {
			t.Fatalf("buildSearchFeature: %v", err)
		}
		v := volume.New(volume.Bounds{MinX: -4, MinY: -4, MinZ: -4, SizeX: 12, SizeY: 12, SizeZ: 12}, pal, block.AirID)
		got := f.Place(&wgen.PlacementContext{
			API: v, Origin: wgen.BlockPos{}, Random: random.New(1), MolangScope: wgen.NewScope(),
			Biome:      &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
			LogFailure: func(featureType, message string, pos wgen.BlockPos) {},
		})
		if got == nil {
			t.Fatalf("required_successes %d: expected success", n)
		}
		if rec.calls != n {
			t.Errorf("required_successes %d: delegate called %d times, want %d", n, rec.calls, n)
		}
	}
}

type countingSucceeder struct{ calls int }

func (c *countingSucceeder) TypeID() string     { return "test:count" }
func (c *countingSucceeder) Identifier() string { return "test:count" }
func (c *countingSucceeder) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	c.calls++
	pos := ctx.Origin
	return &pos
}

type countingResolver struct{ d *countingSucceeder }

func (r countingResolver) Resolve(id string) wgen.IFeature {
	if id == "test:count" {
		return r.d
	}
	return nil
}
