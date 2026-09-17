// scatter_semantics_test.go pins three vanilla scatter behaviours (the
// reasoning lives in distribution.go's own comments), each of which is easy
// to get wrong in a way a regression digest cannot catch, being internally
// consistent:
//
//  1. The iteration index counts DOWN -- the scatter position generator
//     passes its post-decrement counter -- which reverses the visit order of
//     every grid distribution.
//  2. The grid index handed to the next axis is (index*stepSize + gridOffset)
//     / modulus -- with NO min term, in unsigned arithmetic.
//  3. variable.originx/y/z are seeded once from the scatter origin, and
//     variable.worldx/y/z are written per axis with that axis's ABSOLUTE
//     coordinate -- so a later axis reads an earlier axis's result, and
//     `iterations` / `scatter_chance` see whatever world* already held.
//
// All three hold in both supported game versions, with identical draw kinds,
// bounds and order.
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"

	molang "github.com/stirante/molang-go"
)

// recordingDelegate records every origin it is placed at, in order.
type recordingDelegate struct{ origins []wgen.BlockPos }

func (r *recordingDelegate) TypeID() string     { return "test:recorder" }
func (r *recordingDelegate) Identifier() string { return "test:recorder" }
func (r *recordingDelegate) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	r.origins = append(r.origins, ctx.Origin)
	pos := ctx.Origin
	return &pos
}

type recordingResolver struct{ d *recordingDelegate }

func (r recordingResolver) Resolve(id string) wgen.IFeature {
	if id == "test:recorder" {
		return r.d
	}
	return nil
}

// runScatter builds a scatter_feature from body and places it at origin,
// returning the delegate's recorded origins and the final Molang scope.
func runScatter(t *testing.T, body map[string]any, origin wgen.BlockPos, presetVars map[string]float64) ([]wgen.BlockPos, *molang.Scope) {
	t.Helper()
	pal := block.NewPalette()
	rec := &recordingDelegate{}
	bctx := &BuildContext{Palette: pal, Resolver: recordingResolver{rec}, Identifier: "test:scatter", FileID: "test:scatter", Warn: func(string) {}}
	f, err := buildScatterFeature(body, bctx)
	if err != nil {
		t.Fatalf("buildScatterFeature: %v", err)
	}
	v := volume.New(volume.Bounds{MinX: -32, MinY: -32, MinZ: -32, SizeX: 64, SizeY: 64, SizeZ: 64}, pal, block.AirID)
	scope := wgen.NewScope()
	for k, val := range presetVars {
		scope.Variable[k] = val
	}
	ctx := &wgen.PlacementContext{
		API: v, Origin: origin, Random: random.New(1), MolangScope: scope,
		Biome:      &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {},
		LogWarning: func(featureType, message string, pos *wgen.BlockPos) {},
	}
	f.Place(ctx)
	return rec.origins, scope
}

func TestScatter_GridIterationIndexCountsDown(t *testing.T) {
	// A 3-iteration fixed_grid over extent [0,2], step 1: the engine's index
	// runs 2,1,0, so the visited x offsets are 2,1,0 -- not 0,1,2.
	origins, _ := runScatter(t, map[string]any{
		"places_feature": "test:recorder",
		"distribution": map[string]any{
			"iterations": float64(3),
			"x": map[string]any{
				"distribution": "fixed_grid",
				"extent":       []any{float64(0), float64(2)},
			},
			"y": float64(0),
			"z": float64(0),
		},
	}, wgen.BlockPos{}, nil)
	if len(origins) != 3 {
		t.Fatalf("expected 3 placements, got %d", len(origins))
	}
	want := []int{2, 1, 0}
	for i, w := range want {
		if origins[i].X != w {
			t.Fatalf("placement %d at x=%d, want x=%d (engine index counts down); got sequence %v", i, origins[i].X, w, origins)
		}
	}
}

func TestGridIndexNext_ExcludesMinAndIsUnsigned(t *testing.T) {
	// index' = (index*stepSize + gridOffset) / modulus, unsigned, no min.
	cases := []struct{ index, step, offset, modulus, want int }{
		{index: 5, step: 1, offset: 0, modulus: 3, want: 1},  // 5/3
		{index: 5, step: 2, offset: 0, modulus: 3, want: 3},  // 10/3
		{index: 5, step: 1, offset: 4, modulus: 3, want: 3},  // 9/3
		{index: 0, step: 1, offset: 0, modulus: 17, want: 0}, // the negative-min case that used to skew
		{index: 8, step: 1, offset: 0, modulus: 17, want: 0}, // (8+0)/17 -- min=-8 must NOT enter here
		{index: 5, step: 1, offset: 0, modulus: 0, want: 0},  // guard, engine would divide by zero
	}
	for _, c := range cases {
		if got := gridIndexNext(c.index, c.step, c.offset, c.modulus); got != c.want {
			t.Errorf("gridIndexNext(%d,%d,%d,%d) = %d, want %d", c.index, c.step, c.offset, c.modulus, got, c.want)
		}
	}
}

func TestScatter_SeedsOriginVarsNotWorldVars(t *testing.T) {
	// The Molang parameter setup writes origin* only. `iterations` must therefore see
	// origin* set and world* untouched -- here a preset world* survives into
	// the iterations expression, which the old port overwrote with the origin.
	origins, scope := runScatter(t, map[string]any{
		"places_feature": "test:recorder",
		"distribution": map[string]any{
			// one iteration if the preset world* is still visible, zero otherwise
			"iterations": "v.worldx == 777 ? 1 : 0",
			"x":          float64(0),
			"y":          float64(0),
			"z":          float64(0),
		},
	}, wgen.BlockPos{X: 5, Y: 63, Z: -3}, map[string]float64{"worldx": 777})
	if len(origins) != 1 {
		t.Fatalf("iterations expression did not see the pre-existing variable.worldx (got %d placements); the engine does not seed world* at init", len(origins))
	}
	if scope.Variable["originx"] != 5 || scope.Variable["originy"] != 63 || scope.Variable["originz"] != -3 {
		t.Fatalf("origin* not seeded from the scatter origin: got (%v,%v,%v)",
			scope.Variable["originx"], scope.Variable["originy"], scope.Variable["originz"])
	}
}

func TestScatter_WritesWorldVarsPerAxisWithAbsoluteCoordinate(t *testing.T) {
	// eval order xyz: x returns 4 (absolute 10+4 = 14 -> variable.worldx),
	// then y's expression reads v.worldx and must see 14, so y = 14 - 10 = 4.
	origins, scope := runScatter(t, map[string]any{
		"places_feature": "test:recorder",
		"distribution": map[string]any{
			"iterations":            float64(1),
			"x":                     float64(4),
			"y":                     "v.worldx - 10",
			"z":                     float64(0),
			"coordinate_eval_order": "xyz",
		},
	}, wgen.BlockPos{X: 10, Y: 0, Z: 0}, nil)
	if len(origins) != 1 {
		t.Fatalf("expected 1 placement, got %d", len(origins))
	}
	if origins[0].X != 14 {
		t.Fatalf("x offset applied wrong: origin.X = %d, want 14", origins[0].X)
	}
	if origins[0].Y != 4 {
		t.Fatalf("y expression read variable.worldx = %v, expected the absolute x (14) written by the x axis; placement Y = %d, want 4",
			scope.Variable["worldx"], origins[0].Y)
	}
	// After the run, world* holds the last iteration's absolute coordinates --
	// what a delegated feature's own Molang sees.
	if scope.Variable["worldx"] != 14 || scope.Variable["worldy"] != 4 || scope.Variable["worldz"] != 0 {
		t.Fatalf("world* after the run = (%v,%v,%v), want (14,4,0)",
			scope.Variable["worldx"], scope.Variable["worldy"], scope.Variable["worldz"])
	}
}

// TestScatter_AbsentEvalOrderDefaultsToXZY pins the default for an ABSENT
// coordinate_eval_order: xzy, not xyz (features/distribution.go's
// ParseEvalOrder carries the full reasoning).
//
// The expression discriminates all three candidate defaults in one placement,
// which is the point of writing it this way rather than asserting the constant:
// y reads BOTH of the other axes, so where y sits in the order decides what it
// can see. x = 3 and z = 5 are constants, origin is 0, so
//
//	xzy (order x, z, y) -> y sees worldx AND worldz -> 3 + 5 = 8   <- expected
//	xyz (order x, y, z) -> y sees worldx only       -> 3 + 0 = 3
//	zyx (order z, y, x) -> y sees worldz only       -> 0 + 5 = 5
//
// A wrong default therefore fails with a Y that names which order it actually
// ran, instead of a bare "not equal".
func TestScatter_AbsentEvalOrderDefaultsToXZY(t *testing.T) {
	origins, _ := runScatter(t, map[string]any{
		"places_feature": "test:recorder",
		"distribution": map[string]any{
			"iterations": float64(1),
			"x":          float64(3),
			"y":          "v.worldx + v.worldz",
			"z":          float64(5),
		},
	}, wgen.BlockPos{}, nil)
	if len(origins) != 1 {
		t.Fatalf("expected 1 placement, got %d", len(origins))
	}
	switch origins[0].Y {
	case 8:
		// xzy -- the default this pins.
	case 3:
		t.Fatalf("absent coordinate_eval_order evaluated as xyz (y saw only worldx); want xzy")
	case 5:
		t.Fatalf("absent coordinate_eval_order evaluated as zyx (y saw only worldz); want xzy")
	default:
		t.Fatalf("absent coordinate_eval_order gave y=%d, which matches none of xzy(8)/xyz(3)/zyx(5)",
			origins[0].Y)
	}
}

func TestScatter_EvalOrderDecidesWhichAxisSeesWhich(t *testing.T) {
	// Same JSON as above but zyx: z is evaluated first, so x's expression
	// reading v.worldz sees z's absolute value, and y (last) sees both.
	origins, _ := runScatter(t, map[string]any{
		"places_feature": "test:recorder",
		"distribution": map[string]any{
			"iterations":            float64(1),
			"x":                     "v.worldz",
			"y":                     float64(0),
			"z":                     float64(7),
			"coordinate_eval_order": "zyx",
		},
	}, wgen.BlockPos{}, nil)
	if len(origins) != 1 {
		t.Fatalf("expected 1 placement, got %d", len(origins))
	}
	if origins[0].Z != 7 || origins[0].X != 7 {
		t.Fatalf("expected z=7 evaluated first and x to read it back (7,_,7), got (%d,%d,%d)",
			origins[0].X, origins[0].Y, origins[0].Z)
	}
}

// ---------------------------------------------------------------------------
// The game's weighted pick and the per-axis distribution draws.
// ---------------------------------------------------------------------------

func TestWeightedPick_DrawsBoundedIntNotFloat(t *testing.T) {
	tr := random.NewTracer(random.New(1))
	if idx := WeightedPick([]float64{3, 1}, tr); idx < 0 {
		t.Fatalf("expected a pick, got %d", idx)
	}
	if len(tr.Draws) != 1 {
		t.Fatalf("expected exactly one draw, got %v", tr.Draws)
	}
	if tr.Draws[0].Method != random.MethodNextIntBound {
		t.Errorf("weighted pick used method %v, want NextIntBound (the engine's bounded integer draw)", tr.Draws[0].Method)
	}
	if tr.Draws[0].Bound != 4 {
		t.Errorf("weighted pick drew with bound %d, want 4 (the accumulated total)", tr.Draws[0].Bound)
	}
}

func TestWeightedPick_FractionalWeightsTruncateToZeroTotal(t *testing.T) {
	// The engine accumulates `total = (int)(float)(total + weight)` per entry,
	// so two 0.5 weights total 0 -> no draw, and the subtraction (same
	// truncation) never goes negative -> nothing is picked. A float
	// accumulator would have picked one of them.
	//
	// The game skips the draw entirely when the truncated total is zero.
	// It matters beyond this feature: a spurious draw here would shift every
	// subsequent draw in the run.
	tr := random.NewTracer(random.New(1))
	if idx := WeightedPick([]float64{0.5, 0.5}, tr); idx != -1 {
		t.Errorf("fractional weights summing to 0 after truncation picked index %d, want -1 (no pick)", idx)
	}
	if len(tr.Draws) != 0 {
		t.Errorf("a zero total must draw nothing, got %v", tr.Draws)
	}
}

func TestWeightedPick_TruncationIsPerEntryNotAtTheEnd(t *testing.T) {
	// Weights 1, 2, 0.5. Truncating once at the end would give a bound of 3 as well, so this
	// case is chosen for a different reason: it pins that the FINAL fractional entry cannot
	// raise the bound (3 + 0.5 -> 3), while still leaving a real pick to make. Together with
	// the 0.5/0.5 case above -- which only truncation PER ENTRY can turn into a zero total --
	// the accumulator's shape is pinned from both sides.
	tr := random.NewTracer(random.New(1))
	idx := WeightedPick([]float64{1, 2, 0.5}, tr)
	if idx < 0 || idx > 2 {
		t.Fatalf("WeightedPick returned %d, want one of the three entries", idx)
	}
	if len(tr.Draws) != 1 || tr.Draws[0].Bound != 3 {
		t.Errorf("draws = %v, want exactly one draw bounded by the truncated total 3", tr.Draws)
	}
}

func TestWeightedPick_EmptyListPicksNothingWithoutDrawing(t *testing.T) {
	// The game skips the accumulate-and-draw step entirely for an empty
	// list, so an empty list costs no RNG either.
	tr := random.NewTracer(random.New(1))
	if idx := WeightedPick(nil, tr); idx != -1 {
		t.Errorf("WeightedPick(nil) = %d, want -1", idx)
	}
	if len(tr.Draws) != 0 {
		t.Errorf("an empty candidate list drew %v, want no draw", tr.Draws)
	}
}

func TestWeightedPick_ZeroWeightEntriesAreNeverPicked(t *testing.T) {
	// [0, 1]: total 1, the only draw is a bounded draw of 1, which is 0, and entry 0's weight
	// leaves the remainder at 0 (not negative), so entry 1 wins every time.
	for seed := uint32(1); seed <= 5; seed++ {
		if idx := WeightedPick([]float64{0, 1}, random.New(seed)); idx != 1 {
			t.Fatalf("seed %d: picked %d, want 1 (a zero weight can never win)", seed, idx)
		}
	}
}

func TestScatter_TriangleDrawsAreInclusive(t *testing.T) {
	// triangle over extent [0,4]: half1 = 4>>1 = 2, half2 = 4-2 = 2, and each
	// draw is the inclusive bounded draw over 0..half, i.e. a bounded draw of half+1. So the bounds seen
	// must be 3 and 3 -- with the old exclusive NextIntBound(half) they were
	// 2 and 2, and the axis could never reach its extent's top.
	tr := random.NewTracer(random.New(1))
	grid := &GridState{}
	rng := CoordinateRange{Kind: DistTriangle, Min: constMolang(0), Max: constMolang(4)}
	EvalCoordinateRange(rng, 0, 4, grid, tr)
	if len(tr.Draws) != 2 {
		t.Fatalf("triangle must draw exactly twice, got %v", tr.Draws)
	}
	for i, d := range tr.Draws {
		if d.Method != random.MethodNextIntBound || d.Bound != 3 {
			t.Errorf("triangle draw[%d] = method %v bound %d, want NextIntBound bound 3 (nextIntInclusive(0,2))",
				i, d.Method, d.Bound)
		}
	}
}

func TestScatter_JitteredGridJitterIsBoundedByStepSize(t *testing.T) {
	// The jitter draw is a bounded draw with the step size as its bound, not an unbounded
	// integer draw.
	tr := random.NewTracer(random.New(1))
	grid := &GridState{Value: 1}
	rng := CoordinateRange{Kind: DistJitteredGrid, Min: constMolang(0), Max: constMolang(15), StepSize: 4}
	EvalCoordinateRange(rng, 0, 15, grid, tr)
	if len(tr.Draws) != 1 {
		t.Fatalf("jittered_grid with step 4 must draw exactly once, got %v", tr.Draws)
	}
	if tr.Draws[0].Method != random.MethodNextIntBound || tr.Draws[0].Bound != 4 {
		t.Errorf("jitter draw = method %v bound %d, want NextIntBound bound 4 (the step size)",
			tr.Draws[0].Method, tr.Draws[0].Bound)
	}
}
