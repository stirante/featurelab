// tree_test.go exercises TreeFeature and its canopyPlacer implementations directly. Most canopy
// shapes (e.g. simpleCanopy, the bare "canopy" key) have no golden-digest coverage -- exactly
// geode_test.go's own situation, and this file follows the same standard: pin the RNG draw sequence explicitly, render an ASCII
// cross-section of the actual placed silhouette (not just a block count), and exercise the
// schema-level refusals (variation_chance, canopy_decoration) as real diagnostics, not just
// documented gaps.
package features

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// --- simpleCanopy: slopeAt formula -------------------------------------------------------------

// TestSimpleCanopySlopeAt_DefaultSlope pins the formula (int-multiply,
// float32-cast, float32-multiply by 1/run, truncate toward zero) for the default rise=1/run=1
// case, where it must reduce to the identity (slopeAt(dy) == dy).
func TestSimpleCanopySlopeAt_DefaultSlope(t *testing.T) {
	c := &simpleCanopy{rise: 1, run: 1}
	for _, dy := range []int{-5, -1, 0, 1, 5} {
		if got := c.slopeAt(dy); got != dy {
			t.Errorf("slopeAt(%d) = %d, want %d (rise=run=1 must be the identity)", dy, got, dy)
		}
	}
}

// TestSimpleCanopySlopeAt_TruncatesTowardZero pins the truncation direction specifically (the
// game's float-to-int conversion rounds toward zero -- see tree.go header) for a case where floor() and
// trunc-toward-zero disagree: rise=2, run=3, dy=-1 -> raw = -2/3 = -0.667; floor=-1, trunc=0.
func TestSimpleCanopySlopeAt_TruncatesTowardZero(t *testing.T) {
	c := &simpleCanopy{rise: 2, run: 3}
	if got := c.slopeAt(-1); got != 0 {
		t.Fatalf("slopeAt(-1) with rise=2/run=3 = %d, want 0 (trunc-toward-zero of -0.667, NOT floor's -1)", got)
	}
	if got := c.slopeAt(1); got != 0 {
		t.Fatalf("slopeAt(1) with rise=2/run=3 = %d, want 0 (trunc-toward-zero of 0.667)", got)
	}
	if got := c.slopeAt(3); got != 2 {
		t.Fatalf("slopeAt(3) with rise=2/run=3 = %d, want 2 (trunc-toward-zero of 2.0)", got)
	}
}

// --- treeIntRangeValue: the game's int-range draw formula ---------------------------------------

// TestTreeIntRangeValue_DegenerateDrawsNothing pins the int-range draw's degenerate
// branch (see tree.go's header): min >=
// max-1 returns min with ZERO draws. Covers the exact-boundary case (min == max-1, e.g. the acacia
// trunk's own hardcoded {1,4} would NOT hit this -- see the non-degenerate test below for that one)
// plus a genuinely equal and a reversed range.
func TestTreeIntRangeValue_DegenerateDrawsNothing(t *testing.T) {
	cases := []struct{ min, max int }{
		{3, 3}, // equal
		{3, 4}, // min == max-1: still degenerate
		{5, 2}, // reversed
	}
	for _, c := range cases {
		tracer := random.NewTracer(random.New(1))
		got := treeIntRangeValue(c.min, c.max, tracer)
		if got != c.min {
			t.Errorf("treeIntRangeValue(%d,%d) = %d, want %d", c.min, c.max, got, c.min)
		}
		if len(tracer.Draws) != 0 {
			t.Errorf("treeIntRangeValue(%d,%d) drew %v, want zero draws", c.min, c.max, tracer.Draws)
		}
	}
}

// TestTreeIntRangeValue_NonDegenerateFormula pins the non-degenerate branch: exactly ONE
// NextIntBound draw with bound = max-min (NOT max-1-min, which would miss the inclusive draw's
// `+1`), so the result is uniform over [min, max-1] -- max EXCLUSIVE.
// Uses the int range {1,4}, the fixed default the acacia trunk uses for both
// lean_offset and lean_steps -- i.e. the draw every acacia tree makes: NextIntBound(3), not
// NextIntBound(2). The int-range draw is an inclusive bounded draw over (min, max-1), and that
// inclusive draw is `a + nextIntBound(b-a+1)`; composed with (a=min, b=max-1):
// min + nextIntBound(max-min).
func TestTreeIntRangeValue_NonDegenerateFormula(t *testing.T) {
	const min, max = 1, 4 // the acacia trunk's own hardcoded lean_offset/lean_steps int range
	for seed := uint32(1); seed <= 20; seed++ {
		tracer := random.NewTracer(random.New(seed))
		got := treeIntRangeValue(min, max, tracer)
		if len(tracer.Draws) != 1 {
			t.Fatalf("seed %d: drew %v, want exactly one draw", seed, tracer.Draws)
		}
		d := tracer.Draws[0]
		if d.Method != random.MethodNextIntBound {
			t.Fatalf("seed %d: draw method = %v, want NextIntBound", seed, d.Method)
		}
		if d.Bound != 3 { // max-min = 4-1 = 3 (NOT max-1-min = 2, the previously-shipped bug)
			t.Fatalf("seed %d: bound = %d, want 3 (max-min, corrected formula)", seed, d.Bound)
		}
		if got < min || got > max-1 {
			t.Fatalf("seed %d: value = %d, want in [%d,%d] (max EXCLUSIVE)", seed, got, min, max-1)
		}
	}
}

// --- simpleCanopy: schema validation (buildTreeFeature, "canopy" key) --------------------------

func simpleTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"leaf_block":    "minecraft:oak_leaves",
		"canopy_offset": map[string]any{"min": float64(-2), "max": float64(0)},
		"min_width":     float64(1),
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:oak_log",
			"trunk_height": float64(5),
		},
		"canopy": canopy,
	}
}

func buildTestSimpleTree(t *testing.T, pal *block.Palette, canopyExtra map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(simpleTreeBody(canopyExtra), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf, ok := f.(*TreeFeature)
	if !ok {
		t.Fatalf("builder returned %T, want *TreeFeature", f)
	}
	return tf
}

func TestBuildTreeFeature_CanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		if _, err := buildTreeFeature(simpleTreeBody(nil), ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
	t.Run("leaf_block required", func(t *testing.T) {
		body := simpleTreeBody(nil)
		delete(body["canopy"].(map[string]any), "leaf_block")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_offset required", func(t *testing.T) {
		body := simpleTreeBody(nil)
		delete(body["canopy"].(map[string]any), "canopy_offset")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_offset.min required", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["canopy"].(map[string]any)["canopy_offset"] = map[string]any{"max": float64(0)}
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("min_width optional, defaults to 0", func(t *testing.T) {
		body := simpleTreeBody(nil)
		delete(body["canopy"].(map[string]any), "min_width")
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		sc := f.(*TreeFeature).canopy.(*simpleCanopy)
		if sc.minWidth != 0 {
			t.Errorf("minWidth = %d, want 0", sc.minWidth)
		}
	})
	t.Run("canopy_slope optional, defaults to rise=run=1", func(t *testing.T) {
		f, err := buildTreeFeature(simpleTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		sc := f.(*TreeFeature).canopy.(*simpleCanopy)
		if sc.rise != 1 || sc.run != 1 {
			t.Errorf("rise=%d run=%d, want 1,1", sc.rise, sc.run)
		}
	})
	t.Run("canopy_slope.run=0 rejected", func(t *testing.T) {
		body := simpleTreeBody(map[string]any{"canopy_slope": map[string]any{"rise": float64(1), "run": float64(0)}})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("variation_chance refused", func(t *testing.T) {
		body := simpleTreeBody(map[string]any{"variation_chance": []any{}})
		_, err := buildTreeFeature(body, ctx)
		if err == nil {
			t.Fatal("want error, got nil")
		}
		if !strings.Contains(err.Error(), "variation_chance") {
			t.Errorf("error %q does not name variation_chance", err.Error())
		}
	})
	t.Run("canopy_decoration refused", func(t *testing.T) {
		body := simpleTreeBody(map[string]any{"canopy_decoration": map[string]any{}})
		_, err := buildTreeFeature(body, ctx)
		if err == nil {
			t.Fatal("want error, got nil")
		}
		if !strings.Contains(err.Error(), "canopy_decoration") {
			t.Errorf("error %q does not name canopy_decoration", err.Error())
		}
	})
	// mangrove_roots is the real root-variant JSON key ("mangrove_roots", not
	// bare "roots" -- see tree.go's header). A bare "roots" key is not a real schema key at
	// all and must NOT be refused -- only mangrove_roots is. mangrove_roots itself
	// is now PORTED (see mangroveRootsPlace) -- an EMPTY object still errors, but
	// now because its own required fields (max_root_width etc.) are missing, not
	// because the key is unsupported. See TestBuildTreeFeature_MangroveRootsKey_
	// SchemaValidation below for the full schema coverage.
	t.Run("mangrove_roots empty object errors on its own missing required fields", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["mangrove_roots"] = map[string]any{}
		_, err := buildTreeFeature(body, ctx)
		if err == nil {
			t.Fatal("want error, got nil")
		}
		if !strings.Contains(err.Error(), "mangrove_roots") {
			t.Errorf("error %q does not name mangrove_roots", err.Error())
		}
	})
	t.Run("bare roots key is not a schema key -- ignored, not refused", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["roots"] = map[string]any{"anything": true}
		if _, err := buildTreeFeature(body, ctx); err != nil {
			t.Errorf("want success (bare \"roots\" is not a real key), got %v", err)
		}
	})
	// can_be_submerged is a simple-trunk field, a plain bool in typical JSON --
	// see tree.go header.
	//
	// can_be_submerged is NOT a trunk-shape discriminator: the bare "trunk" key
	// always binds the simple trunk, and can_be_submerged only sets the maximum
	// submerged depth. So these pin the DEPTH, and that the shape is the same
	// either way.
	t.Run("trunk.can_be_submerged=true sets maxDepth 255", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["trunk"].(map[string]any)["can_be_submerged"] = true
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		tf := f.(*TreeFeature)
		if tf.submergedTrunk == nil {
			t.Fatal("want submergedTrunk set")
		}
		if tf.submergedTrunk.maxDepth != 255 {
			t.Errorf("maxDepth = %d, want 255 (bool true -> 0xFF, module header)", tf.submergedTrunk.maxDepth)
		}
	})
	t.Run("trunk.can_be_submerged=false is still the simple trunk, just maxDepth 0", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["trunk"].(map[string]any)["can_be_submerged"] = false
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		tf := f.(*TreeFeature)
		if tf.submergedTrunk == nil {
			t.Fatal("can_be_submerged=false must NOT change the trunk shape -- the bare `trunk` key is the simple trunk either way")
		}
		if tf.submergedTrunk.maxDepth != 0 {
			t.Errorf("maxDepth = %d, want 0 (false -> no descent)", tf.submergedTrunk.maxDepth)
		}
	})
	t.Run("trunk.can_be_submerged absent is the simple trunk with maxDepth 0", func(t *testing.T) {
		f, err := buildTreeFeature(simpleTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		tf := f.(*TreeFeature)
		if tf.submergedTrunk == nil {
			t.Fatal("the bare `trunk` key binds the simple trunk even with no can_be_submerged at all")
		}
		if tf.submergedTrunk.maxDepth != 0 {
			t.Errorf("maxDepth = %d, want 0 (absent -> no descent)", tf.submergedTrunk.maxDepth)
		}
	})
	t.Run("trunk.can_be_submerged object form, max_depth required", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["trunk"].(map[string]any)["can_be_submerged"] = map[string]any{}
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error (max_depth missing), got nil")
		}
	})
	t.Run("trunk.can_be_submerged object form, max_depth honored", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["trunk"].(map[string]any)["can_be_submerged"] = map[string]any{"max_depth": float64(3)}
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if got := f.(*TreeFeature).submergedTrunk.maxDepth; got != 3 {
			t.Errorf("maxDepth = %d, want 3", got)
		}
	})
	t.Run("trunk.can_be_submerged + top-level base_block accepted", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["trunk"].(map[string]any)["can_be_submerged"] = true
		body["base_block"] = []any{"minecraft:dirt"}
		got, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		f := got.(*TreeFeature)
		if f.baseBlock.Empty() || f.baseBlockFallback == block.AirID {
			t.Fatal("base_block was not resolved for the simple trunk's post-canopy ground fixup")
		}
	})
	t.Run("trunk.can_be_submerged switches trunk_height to int-range vocabulary", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["trunk"].(map[string]any)["can_be_submerged"] = true
		body["trunk"].(map[string]any)["trunk_height"] = []any{float64(5), float64(8)}
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		st := f.(*TreeFeature).submergedTrunk
		if st.trunkHeightMin != 5 || st.trunkHeightMax != 8 {
			t.Errorf("trunk_height = [%d,%d], want [5,8]", st.trunkHeightMin, st.trunkHeightMax)
		}
	})
}

// --- simpleCanopy: RNG draw sequence (must be ZERO for every JSON this port accepts) -----------

func drawSeqRandom(tr *random.Tracer) []random.Method {
	methods := make([]random.Method, len(tr.Draws))
	for i, d := range tr.Draws {
		methods[i] = d.Method
	}
	return methods
}

func newTreeTestVolume(t *testing.T, radius int) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	bounds := volume.Bounds{MinX: -radius, MinY: 0, MinZ: -radius, SizeX: 2*radius + 1, SizeY: 30, SizeZ: 2*radius + 1}
	v := volume.New(bounds, pal, air)
	for x := -radius; x <= radius; x++ {
		for z := -radius; z <= radius; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: 9, Z: z}, dirt)
		}
	}
	return v, pal
}

// countBlocksOfID counts every cell of the bench volume built by
// newTreeTestVolume(radius) that holds id.
//
// It exists for the canopy tests whose expected draw sequence is EMPTY because
// the bare `trunk` key is the simple trunk: once "the sequence
// matched" means "nothing was drawn", the sequence alone no longer proves the
// canopy ran at all, so those tests assert it actually wrote its leaves too.
func countBlocksOfID(v *volume.Volume, radius int, id block.ID) int {
	n := 0
	for x := -radius; x <= radius; x++ {
		for z := -radius; z <= radius; z++ {
			for y := 0; y < 30; y++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == id {
					n++
				}
			}
		}
	}
	return n
}

// withAcaciaTrunkForCandidates rewrites a test body's bare "trunk" key into an "acacia_trunk" that
// places exactly `logs` trunk cells and collects EVERY one of them as a canopy candidate.
//
// random_spread_canopy and mangrove_canopy are the only two shapes that read the candidates list,
// and they early-return with ZERO draws when it is empty (both placements begin with a
// begin==end test -- see tree.go). The simple trunk
// hands the canopy an EMPTY candidates list, so a bare
// `trunk` cannot exercise either canopy at all: in the game as much as here, `{"trunk": ...}` +
// `{"random_spread_canopy": ...}` grows a bare pole. Those two tests therefore need a trunk that
// actually produces candidates, and the acacia trunk is the shape whose pushes built the list in
// the first place.
//
// The trunk contributes exactly TWO draws and they bracket the canopy: NextIntBound(4) for the lean
// direction before it, and placeAcaciaLeaningBranches' own unconditional NextIntBound(4) after it.
// lean_height and lean_steps are pinned degenerate ({0,0}) so they draw nothing, and trunk_height
// has no intervals, so nothing else in the trunk draws either.
func withAcaciaTrunkForCandidates(body map[string]any, logs int) map[string]any {
	trunk := body["trunk"].(map[string]any)
	delete(body, "trunk")
	body["acacia_trunk"] = map[string]any{
		"trunk_block": trunk["trunk_block"],
		"trunk_width": float64(1),
		"trunk_height": map[string]any{
			"base":                  float64(logs),
			"min_height_for_canopy": float64(0), // collect every log, not just those above index 3
		},
		"trunk_lean": map[string]any{
			"allow_diagonal_growth": true,
			"lean_height":           map[string]any{"range_min": float64(0), "range_max": float64(0)},
			"lean_steps":            map[string]any{"range_min": float64(0), "range_max": float64(0)},
		},
	}
	return body
}

func placeTestTree(f *TreeFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) *wgen.BlockPos {
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
	return f.Place(ctx)
}

// TestTreeFeature_CanopyKey_RNGDrawSequence_CanopyItselfDrawsNothing pins the EXACT draw sequence
// for a whole TreeFeature.Place() call using the "canopy" (the simple canopy) shape. That sequence
// is EMPTY: the bare `trunk` key is the simple trunk (see tree.go's header), whose
// only two draws are trunk_height and height_modifier -- a scalar trunk_height parses to a
// degenerate int range and an absent height_modifier defaults to {0,0}, so both draw nothing -- and
// simpleCanopy.place is genuinely zero-RNG. (The acacia trunk's lean draws do not apply: the
// bare key never binds that trunk.)
//
// An empty expected sequence cannot on its own show the canopy ran, so the leaf count is asserted
// too. Without it this test would still pass if placeCanopies were never called at all.
func TestTreeFeature_CanopyKey_RNGDrawSequence_CanopyItselfDrawsNothing(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	tf := buildTestSimpleTree(t, pal, nil)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	if seq := drawSeqRandom(tr); len(seq) != 0 {
		t.Fatalf("draw sequence = %v, want none at all (the simple trunk draws nothing for this body, and the canopy draws nothing ever)", seq)
	}
	if leaves := countBlocksOfID(v, 10, pal.Get("minecraft:oak_leaves", nil)); leaves == 0 {
		t.Fatal("canopy placed no leaves -- the zero-draw expectation above is only meaningful if the canopy actually ran")
	}
}

// --- simpleCanopy: real geometry, ASCII cross-sections ------------------------------------------

// TestSimpleCanopy_Place_StepPyramid_CrossSections places a canopy directly (bypassing the trunk,
// same pattern acacia/pine canopy testing would use) with canopy_offset{min:-2,max:0},
// min_width=1, default rise=run=1 -- by the pinned slopeAt formula this must produce EXACTLY a
// 3-layer step pyramid: radius 3 (7x7) at dy=-2, radius 2 (5x5) at dy=-1, radius 1 (3x3) at dy=0.
// Renders both a horizontal cross-section per layer and a vertical (X/Y) cross-section through the
// center, so the silhouette itself is checked, not just a block count.
func TestSimpleCanopy_Place_StepPyramid_CrossSections(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &simpleCanopy{leafID: leaf, offsetMin: -2, offsetMax: 0, minWidth: 1, rise: 1, run: 1}

	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	c.place(v, anchor, random.New(1), treeParamsLists{}, nil)

	wantRadius := map[int]int{-2: 3, -1: 2, 0: 1}
	for dy, r := range wantRadius {
		y := anchor.Y + dy
		var art strings.Builder
		for dz := -3; dz <= 3; dz++ {
			for dx := -3; dx <= 3; dx++ {
				pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z + dz}
				if v.GetBlock(pos) == leaf {
					art.WriteByte('#')
				} else {
					art.WriteByte('.')
				}
			}
			art.WriteByte('\n')
		}
		t.Logf("layer dy=%d (want radius %d), horizontal cross-section at y=%d (# leaves, . empty):\n%s", dy, r, y, art.String())

		for dx := -3; dx <= 3; dx++ {
			for dz := -3; dz <= 3; dz++ {
				pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z + dz}
				want := abs(dx) <= r && abs(dz) <= r
				got := v.GetBlock(pos) == leaf
				if got != want {
					t.Errorf("layer dy=%d pos(dx=%d,dz=%d): leaf=%v, want %v (radius %d)", dy, dx, dz, got, want, r)
				}
			}
		}
	}

	// Vertical (X/Y) cross-section through the center Z -- the step-pyramid silhouette.
	var art strings.Builder
	for y := anchor.Y; y >= anchor.Y-2; y-- {
		for dx := -3; dx <= 3; dx++ {
			pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z}
			if v.GetBlock(pos) == leaf {
				art.WriteByte('#')
			} else {
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("vertical (X/Y) cross-section through anchor, top to bottom (# leaves, . empty):\n%s", art.String())

	// Sanity: the exact wide-base-narrow-top shape, not merely "some leaves somewhere".
	wantLines := []string{
		"..###..\n", // dy=0, radius 1 (3x3, min_width=1 -- never a single block)
		".#####.\n", // dy=-1, radius 2 (5x5)
		"#######\n", // dy=-2, radius 3 (7x7)
	}
	if art.String() != strings.Join(wantLines, "") {
		t.Fatalf("vertical cross-section =\n%s\nwant\n%s", art.String(), strings.Join(wantLines, ""))
	}
}

// TestSimpleCanopy_Place_RespectsMayReplace proves the leaf gate is real: with a NON-empty
// may_replace list (an empty list means "no restriction" in this codebase's passesAllowList
// convention -- see tree.go's own doc comment), a position pre-filled with a block NOT in
// may_replace and not air must be left untouched.
func TestSimpleCanopy_Place_RespectsMayReplace(t *testing.T) {
	v, pal := newTreeTestVolume(t, 4)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	stone := pal.Get("minecraft:stone", nil)
	c := &simpleCanopy{leafID: leaf, offsetMin: 0, offsetMax: 0, minWidth: 1, rise: 1, run: 1}
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:short_grass")}, nil, nil, nil)

	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	blocked := wgen.BlockPos{X: 1, Y: 15, Z: 0}
	v.SetBlock(blocked, stone)

	c.place(v, anchor, random.New(1), treeParamsLists{mayReplace: mayReplace}, nil)

	if got := v.GetBlock(blocked); got != stone {
		t.Fatalf("expected the pre-placed stone to be left untouched (not in may_replace, not air), got %v", pal.Entry(got))
	}
	if got := v.GetBlock(anchor); got != leaf {
		t.Fatalf("expected the anchor itself to be leafed (starts as air, passes the IsAir fallback), got %v", pal.Entry(got))
	}
}

// --- fancyCanopy: schema validation (buildTreeFeature, "fancy_canopy" key) ----------------------

func fancyTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"leaf_block": "minecraft:oak_leaves",
		"height":     float64(4),
		"radius":     float64(3),
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:oak_log",
			"trunk_height": float64(5),
		},
		"fancy_canopy": canopy,
	}
}

func TestBuildTreeFeature_FancyCanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		f, err := buildTreeFeature(fancyTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		fc := f.(*TreeFeature).canopy.(*fancyCanopy)
		if fc.height != 4 || fc.radius != 3 {
			t.Errorf("height=%d radius=%d, want 4,3", fc.height, fc.radius)
		}
	})
	t.Run("leaf_block required", func(t *testing.T) {
		body := fancyTreeBody(nil)
		delete(body["fancy_canopy"].(map[string]any), "leaf_block")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("height required", func(t *testing.T) {
		body := fancyTreeBody(nil)
		delete(body["fancy_canopy"].(map[string]any), "height")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("height<0 rejected", func(t *testing.T) {
		body := fancyTreeBody(map[string]any{"height": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("height==0 accepted (places nothing, per module header)", func(t *testing.T) {
		body := fancyTreeBody(map[string]any{"height": float64(0)})
		if _, err := buildTreeFeature(body, ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
	t.Run("radius required by this port (vanilla treats it as optional)", func(t *testing.T) {
		body := fancyTreeBody(nil)
		delete(body["fancy_canopy"].(map[string]any), "radius")
		_, err := buildTreeFeature(body, ctx)
		if err == nil {
			t.Fatal("want error, got nil")
		}
		if !strings.Contains(err.Error(), "radius") {
			t.Errorf("error %q does not name radius", err.Error())
		}
	})
	t.Run("radius<1 rejected", func(t *testing.T) {
		body := fancyTreeBody(map[string]any{"radius": float64(0)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
}

// --- fancyCanopy: RNG draw sequence (must be ZERO -- neither the placement nor the layer fill draws) --

// TestTreeFeature_FancyCanopyKey_RNGDrawSequence_CanopyItselfDrawsNothing mirrors the "canopy" key's
// own RNG-sequence test: the whole Place() draws NOTHING. See tree.go's header: neither
// the fancy canopy's placement nor its layer fill ever draws, and the bare `trunk` key's simple
// trunk draws nothing for this body (degenerate trunk_height, no height_modifier).
//
// Leaf count asserted for the same reason as the "canopy" test: an empty sequence alone would also pass if the canopy never ran.
func TestTreeFeature_FancyCanopyKey_RNGDrawSequence_CanopyItselfDrawsNothing(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(fancyTreeBody(nil), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := f.(*TreeFeature)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	if seq := drawSeqRandom(tr); len(seq) != 0 {
		t.Fatalf("draw sequence = %v, want none at all (the simple trunk draws nothing for this body, and fancy_canopy draws nothing ever)", seq)
	}
	if leaves := countBlocksOfID(v, 10, pal.Get("minecraft:oak_leaves", nil)); leaves == 0 {
		t.Fatal("fancy_canopy placed no leaves -- the zero-draw expectation above is only meaningful if the canopy actually ran")
	}
}

// --- fancyCanopy: real geometry, ASCII cross-sections --------------------------------------------

// TestFancyCanopy_Place_TaperedDiscStack_CrossSections places a fancyCanopy directly with
// height=4/radius=3. By the pinned formula (module header) this must produce EXACTLY:
// dy=0 and dy=3 (the caps) at radius-1=2 (a 5-cell "plus" disc), dy=1 and dy=2 (the middle) at the
// full radius=3 (a 21-cell rounded disc, 7x7 bounding box minus the far corners). Renders both
// horizontal cross-sections (one cap layer, one middle layer) and a vertical (X/Y) cross-section
// through the center, so the actual silhouette is checked, not just a block count.
func TestFancyCanopy_Place_TaperedDiscStack_CrossSections(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &fancyCanopy{leafID: leaf, height: 4, radius: 3}

	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	c.place(v, anchor, random.New(1), treeParamsLists{}, nil)

	// The exact mask, reimplemented independently (float64, not float32, and
	// direct squaring instead of pow() calls -- see fillLayer's own doc comment for
	// why that's equivalent) so this test does not just call fancyCanopy's own formula back at itself.
	wantMask := func(dx, dz, r int) bool {
		fx := float64(abs(dx)) + 0.5
		fz := float64(abs(dz)) + 0.5
		return fx*fx+fz*fz <= float64(r*r)
	}
	radiusForLayer := map[int]int{0: 2, 1: 3, 2: 3, 3: 2}

	renderAndCheck := func(dy int) string {
		r := radiusForLayer[dy]
		y := anchor.Y + dy
		var art strings.Builder
		for dz := -3; dz <= 3; dz++ {
			for dx := -3; dx <= 3; dx++ {
				pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z + dz}
				got := v.GetBlock(pos) == leaf
				want := wantMask(dx, dz, r)
				if got != want {
					t.Errorf("layer dy=%d (r=%d) pos(dx=%d,dz=%d): leaf=%v, want %v", dy, r, dx, dz, got, want)
				}
				if got {
					art.WriteByte('#')
				} else {
					art.WriteByte('.')
				}
			}
			art.WriteByte('\n')
		}
		return art.String()
	}

	capArt := renderAndCheck(0)
	t.Logf("layer dy=0 (cap, r=2), horizontal cross-section at y=%d (# leaves, . empty):\n%s", anchor.Y, capArt)
	wantCapExact := "" +
		".......\n" + // dz=-3
		".......\n" + // dz=-2
		"...#...\n" + // dz=-1 (dx=0 only)
		"..###..\n" + // dz=0  (dx=-1,0,1)
		"...#...\n" + // dz=1  (dx=0 only)
		".......\n" + // dz=2
		".......\n" // dz=3
	if capArt != wantCapExact {
		t.Fatalf("dy=0 cross-section =\n%s\nwant\n%s", capArt, wantCapExact)
	}

	midArt := renderAndCheck(1)
	t.Logf("layer dy=1 (middle, r=3), horizontal cross-section at y=%d (# leaves, . empty):\n%s", anchor.Y+1, midArt)
	wantMidExact := "" +
		".......\n" +
		"..###..\n" +
		".#####.\n" +
		".#####.\n" +
		".#####.\n" +
		"..###..\n" +
		".......\n"
	if midArt != wantMidExact {
		t.Fatalf("dy=1 cross-section =\n%s\nwant\n%s", midArt, wantMidExact)
	}

	renderAndCheck(2)
	renderAndCheck(3)

	// Vertical (X/Y) cross-section through the center Z -- the tapered-blob silhouette, cap to cap.
	var vart strings.Builder
	for y := anchor.Y + 3; y >= anchor.Y; y-- {
		for dx := -3; dx <= 3; dx++ {
			pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z}
			if v.GetBlock(pos) == leaf {
				vart.WriteByte('#')
			} else {
				vart.WriteByte('.')
			}
		}
		vart.WriteByte('\n')
	}
	t.Logf("vertical (X/Y) cross-section through anchor, top (dy=3) to bottom (dy=0) (# leaves, . empty):\n%s", vart.String())
	wantVert := "" +
		"..###..\n" + // dy=3, cap r=2, dz=0 row of the plus shape
		".#####.\n" + // dy=2, middle r=3
		".#####.\n" + // dy=1, middle r=3
		"..###..\n" // dy=0, cap r=2
	if vart.String() != wantVert {
		t.Fatalf("vertical cross-section =\n%s\nwant\n%s", vart.String(), wantVert)
	}
}

// TestFancyCanopy_Place_HeightZero_PlacesNothing pins the height==0 edge case: the fancy
// canopy returns early and places nothing (see tree.go's header).
func TestFancyCanopy_Place_HeightZero_PlacesNothing(t *testing.T) {
	v, pal := newTreeTestVolume(t, 4)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &fancyCanopy{leafID: leaf, height: 0, radius: 3}
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	c.place(v, anchor, random.New(1), treeParamsLists{}, nil)

	for dx := -4; dx <= 4; dx++ {
		for dy := -1; dy <= 1; dy++ {
			for dz := -4; dz <= 4; dz++ {
				pos := wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}
				if v.GetBlock(pos) == leaf {
					t.Fatalf("height=0 placed a leaf at (%d,%d,%d), want nothing placed anywhere", dx, dy, dz)
				}
			}
		}
	}
}

// TestFancyCanopy_Place_RespectsMayReplace_NoAirFallback proves fancyCanopy's leaf gate is the SAME
// raw placement allow-list check the acacia/pine canopies use -- NOT the simple canopy's more
// lenient "OR IsAir" approximation (see module header: the fancy canopy's own gate needs no such
// stand-in). With a NON-empty may_replace list that omits air, even the anchor cell itself (which
// starts as air) must be left untouched -- the opposite of simpleCanopy's own precedent test.
func TestFancyCanopy_Place_RespectsMayReplace_NoAirFallback(t *testing.T) {
	v, pal := newTreeTestVolume(t, 8)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &fancyCanopy{leafID: leaf, height: 1, radius: 1}
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:short_grass")}, nil, nil, nil)

	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	c.place(v, anchor, random.New(1), treeParamsLists{mayReplace: mayReplace}, nil)

	if got := v.GetBlock(anchor); got == leaf {
		t.Fatalf("anchor (starts as air, not in may_replace) got leafed -- fancyCanopy must NOT have an IsAir fallback")
	}

	// A NON-empty may_replace still permits an actual matching block through. radius=2/height=1
	// gives a single-cell layer (r=radius-1=1 places only the center cell -- see the cross-section
	// test's own r=1 boundary case) so the target cell itself is the one under test.
	c2 := &fancyCanopy{leafID: leaf, height: 1, radius: 2}
	grass := pal.Get("minecraft:short_grass", nil)
	target := wgen.BlockPos{X: 5, Y: 15, Z: 5}
	v.SetBlock(target, grass)
	c2.place(v, target, random.New(1), treeParamsLists{mayReplace: mayReplace}, nil)
	if got := v.GetBlock(target); got != leaf {
		t.Fatalf("expected short_grass (in may_replace) to be replaced with a leaf, got %v", pal.Entry(got))
	}
}

// --- spruceCanopy: schema validation (buildTreeFeature, "spruce_canopy" key) --------------------

func spruceTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"leaf_block":   "minecraft:oak_leaves",
		"lower_offset": map[string]any{"range_min": float64(-7), "range_max": float64(-2)},
		"upper_offset": map[string]any{"range_min": float64(0), "range_max": float64(5)},
		"max_radius":   map[string]any{"range_min": float64(2), "range_max": float64(5)},
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:oak_log",
			"trunk_height": float64(5),
		},
		"spruce_canopy": canopy,
	}
}

func TestBuildTreeFeature_SpruceCanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		f, err := buildTreeFeature(spruceTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		sc := f.(*TreeFeature).canopy.(*spruceCanopy)
		if sc.lowerMin != -7 || sc.lowerMax != -2 || sc.upperMin != 0 || sc.upperMax != 5 || sc.radiusMin != 2 || sc.radiusMax != 5 {
			t.Errorf("got %+v, want lowerMin=-7 lowerMax=-2 upperMin=0 upperMax=5 radiusMin=2 radiusMax=5", sc)
		}
	})
	t.Run("leaf_block required", func(t *testing.T) {
		body := spruceTreeBody(nil)
		delete(body["spruce_canopy"].(map[string]any), "leaf_block")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("lower_offset required", func(t *testing.T) {
		body := spruceTreeBody(nil)
		delete(body["spruce_canopy"].(map[string]any), "lower_offset")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("upper_offset required by this port (vanilla treats it as optional)", func(t *testing.T) {
		body := spruceTreeBody(nil)
		delete(body["spruce_canopy"].(map[string]any), "upper_offset")
		_, err := buildTreeFeature(body, ctx)
		if err == nil {
			t.Fatal("want error, got nil")
		}
		if !strings.Contains(err.Error(), "upper_offset") {
			t.Errorf("error %q does not name upper_offset", err.Error())
		}
	})
	t.Run("max_radius required", func(t *testing.T) {
		body := spruceTreeBody(nil)
		delete(body["spruce_canopy"].(map[string]any), "max_radius")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("lower_offset accepts plain number shorthand", func(t *testing.T) {
		body := spruceTreeBody(map[string]any{"lower_offset": float64(-3)})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		sc := f.(*TreeFeature).canopy.(*spruceCanopy)
		if sc.lowerMin != -3 || sc.lowerMax != -3 {
			t.Errorf("lowerMin=%d lowerMax=%d, want -3,-3", sc.lowerMin, sc.lowerMax)
		}
	})
	t.Run("max_radius accepts [min,max] array shorthand", func(t *testing.T) {
		body := spruceTreeBody(map[string]any{"max_radius": []any{float64(1), float64(4)}})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		sc := f.(*TreeFeature).canopy.(*spruceCanopy)
		if sc.radiusMin != 1 || sc.radiusMax != 4 {
			t.Errorf("radiusMin=%d radiusMax=%d, want 1,4", sc.radiusMin, sc.radiusMax)
		}
	})
}

// --- spruceCanopy: RNG draw sequence -------------------------------------------------------------

// TestTreeFeature_SpruceCanopyKey_RNGDrawSequence pins the full sequence through a real
// TreeFeature.Place: the trunk draws NOTHING, so the whole sequence is spruce_canopy's own 4 draws
// (3 int-range draws plus one direct NextIntBound -- see tree.go's header). All 4 are
// MethodNextIntBound at the IRandom-interface level (the int-range draw and the direct draw both
// bottom out in NextIntBound).
//
// The bare `trunk` key this body uses is the simple trunk, not the acacia trunk, and a scalar
// trunk_height plus an absent height_modifier make the simple trunk itself draw nothing, so only the canopy's own
// draws remain. The canopy is still genuinely exercised: the draws below are all its own.
func TestTreeFeature_SpruceCanopyKey_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	tf := buildTestSpruceTree(t, pal, nil)
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantSeq := []random.Method{
		random.MethodNextIntBound, // lower_offset.getValue
		random.MethodNextIntBound, // upper_offset.getValue
		random.MethodNextIntBound, // max_radius.getValue
		random.MethodNextIntBound, // direct jitter draw
	}
	if seq := drawSeqRandom(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v, want %v", seq, wantSeq)
	}
}

func buildTestSpruceTree(t *testing.T, pal *block.Palette, canopyExtra map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(spruceTreeBody(canopyExtra), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf, ok := f.(*TreeFeature)
	if !ok {
		t.Fatalf("builder returned %T, want *TreeFeature", f)
	}
	return tf
}

// --- spruceCanopy: real geometry, ASCII cross-sections -------------------------------------------

// spruceScriptedRandom scripts NextIntBound's return values in call order -- spruceCanopy's own 4
// draws (lower_offset/upper_offset/max_radius/jitter) all flow through NextIntBound, whose real
// output for an arbitrary seed is not worth hand-deriving; same rationale as cave_test.go's own
// caveScriptedRandom.
type spruceScriptedRandom struct {
	bounds []int
	ints   []int32
	floats []float64
	idx    int
	intIdx int
	fltIdx int
}

func (s *spruceScriptedRandom) NextIntBound(bound int) int {
	v := s.bounds[s.idx]
	s.idx++
	return v
}
func (s *spruceScriptedRandom) NextInt() int32 {
	v := s.ints[s.intIdx]
	s.intIdx++
	return v
}
func (s *spruceScriptedRandom) NextFloat() float64 {
	v := s.floats[s.fltIdx]
	s.fltIdx++
	return v
}
func (s *spruceScriptedRandom) NextDouble() float64           { panic("unused") }
func (s *spruceScriptedRandom) NextBoolean() bool             { panic("unused") }
func (s *spruceScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (s *spruceScriptedRandom) SetSeed(uint32)                {}
func (s *spruceScriptedRandom) GetSeed() uint32               { return 0 }

var _ random.IRandom = (*spruceScriptedRandom)(nil)

// TestCherryCanopy_BottomLayerCornerDoubleRoll pins the cherry canopy's leaf-layer
// write's bottom-layer chance interaction, which is the one place in this file where two
// different chance gates can fire on the SAME cell.
//
// For a bottom-layer cell (dy == -1) that is outer-edge on either axis, the
// wide-bottom chance is rolled. On TRUE the cell is skipped and no second roll is spent; on FALSE
// it FALLS THROUGH to the corner gate, where three things can happen:
//
//   - radius >= 3 and an exact corner: it skips outright, NO second roll;
//   - radius >= 3 and not an exact corner: the corner chance is rolled iff |dx|+|dz| > 2r-2;
//   - radius < 3 and an exact corner: the corner chance IS rolled -- two draws on one cell.
//
// The two chances are given DIFFERENT fraction denominators (7 and 11) so the tracer's recorded
// bound identifies which gate fired, per cell, in order. A test that only counted draws would
// pass on a port that rolled the right number of times through the wrong gates.
func TestCherryCanopy_BottomLayerCornerDoubleRoll(t *testing.T) {
	const wideBound, cornerBound = 7, 11

	// numerator 1 over these denominators: a scripted draw of 0 rolls TRUE, anything else FALSE.
	newCanopy := func(leaf block.ID) *cherryCanopy {
		return &cherryCanopy{
			leafID: leaf, trunkWidth: 1,
			wideBottomHoleChance: chanceInformation{isFraction: true, numerator: 1, denominator: wideBound},
			cornerHoleChance:     chanceInformation{isFraction: true, numerator: 1, denominator: cornerBound},
		}
	}
	// bounds is consumed in call order; pad generously so no sub-test runs off the end.
	runLayer := func(t *testing.T, radius, dy int, scripted []int) []int32 {
		t.Helper()
		v, pal := newTreeTestVolume(t, 8)
		leaf := pal.Get("minecraft:oak_leaves", nil)
		bounds := append(append([]int{}, scripted...), make([]int, 512)...)
		for i := len(scripted); i < len(bounds); i++ {
			bounds[i] = 1 // never 0 -> every unscripted roll comes up FALSE
		}
		tr := random.NewTracer(&spruceScriptedRandom{bounds: bounds})
		newCanopy(leaf).placeLayer(v, wgen.BlockPos{X: 0, Y: 20, Z: 0}, tr, treeParamsLists{}, dy, radius)
		got := make([]int32, len(tr.Draws))
		for i, d := range tr.Draws {
			got[i] = d.Bound
		}
		return got
	}

	t.Run("radius<3 exact corner rolls BOTH, wide first then corner", func(t *testing.T) {
		// radius 2, trunk_width 1: dx and dz both sweep [-2,2], dx outer. Edge cells are
		// |dx|==2 or |dz|==2; the four exact corners additionally reach the corner gate.
		want := []int32{
			wideBound, cornerBound, wideBound, wideBound, wideBound, wideBound, cornerBound, // dx=-2
			wideBound, wideBound, // dx=-1 (dz=-2 and dz=2 only)
			wideBound, wideBound, // dx=0
			wideBound, wideBound, // dx=1
			wideBound, cornerBound, wideBound, wideBound, wideBound, wideBound, cornerBound, // dx=2
		}
		if got := runLayer(t, 2, -1, nil); !slices.Equal(got, want) {
			t.Errorf("bound sequence = %v, want %v", got, want)
		}
	})

	t.Run("a TRUE wide-bottom roll spends no second roll", func(t *testing.T) {
		// The very first cell visited (dx=-2,dz=-2) is an exact corner. Scripting its
		// wide-bottom roll to TRUE must skip it outright: the second draw belongs to the NEXT
		// cell's wide-bottom gate, not to this cell's corner gate.
		got := runLayer(t, 2, -1, []int{0})
		if len(got) < 2 || got[0] != wideBound || got[1] != wideBound {
			t.Fatalf("first two bounds = %v, want [%d %d] -- a TRUE wide-bottom roll must not fall through", got, wideBound, wideBound)
		}
	})

	t.Run("radius>=3 exact corner skips with no second roll", func(t *testing.T) {
		// radius 3: dx,dz sweep [-3,3]. Exact corners roll wide-bottom, come up false, and
		// then skip outright with NO corner roll. Near-corner cells (|dx|+|dz| > 4) do
		// roll the corner chance.
		want := []int32{
			wideBound, wideBound, cornerBound, wideBound, wideBound, wideBound, wideBound, cornerBound, wideBound, // dx=-3
			wideBound, cornerBound, wideBound, cornerBound, // dx=-2 (dz=-3 and dz=3)
			wideBound, wideBound, // dx=-1
			wideBound, wideBound, // dx=0
			wideBound, wideBound, // dx=1
			wideBound, cornerBound, wideBound, cornerBound, // dx=2
			wideBound, wideBound, cornerBound, wideBound, wideBound, wideBound, wideBound, cornerBound, wideBound, // dx=3
		}
		if got := runLayer(t, 3, -1, nil); !slices.Equal(got, want) {
			t.Errorf("bound sequence = %v, want %v", got, want)
		}
	})

	t.Run("a non-bottom layer never rolls the wide-bottom chance", func(t *testing.T) {
		// Same radius, dy=0: the wide-bottom gate is bottom-layer only, so only the corner
		// chance can fire -- four exact corners at radius 2.
		want := []int32{cornerBound, cornerBound, cornerBound, cornerBound}
		if got := runLayer(t, 2, 0, nil); !slices.Equal(got, want) {
			t.Errorf("bound sequence = %v, want %v", got, want)
		}
	})
}

// TestCanopies_RadiusZeroCornerTests pins three canopies that disagree with each other about
// what a radius-0 layer means, and pins the disagreement itself as correct rather than tidying it
// into consistency.
//
// The corner test each of these runs is `abs(dx)==radius && abs(dz)==radius`. At radius 0 the
// single centre cell satisfies it, so whether that cell survives depends entirely on whether the
// shape guards the test with a nonzero radius. The game does not do the same thing three times:
//
//   - The simple canopy has NO radius guard: both halves of the corner test compare against the
//     radius and nothing anywhere in the block short-circuits on zero. So at
//     radius 0 it spends a variation_chance roll on the centre cell, and a successful roll
//     deletes the canopy's only cell. The test exists so this is not mistaken for a bug.
//   - The acacia canopy has NO guard either (no radius-zero escape anywhere in its loop) -- but
//     its corner cut is deterministic, not a chance roll, so at canopy_size 0 the anchor's own
//     layer is unconditionally empty. Only the layer above it survives.
//   - The spruce canopy DOES have one, so its radius-0 layer keeps the
//     centre cell.
//
// Note that acacia, pine and spruce run no chance roll at all (their corner cut is
// deterministic), and they do not agree with each other about the guard. This port gives the
// pine canopy a guard; whether vanilla pine has one is an open question.
func TestCanopies_RadiusZeroCornerTests(t *testing.T) {
	// The simple canopy: rise/run/min_width chosen so the single layer's radius is exactly
	// topSlope + min_width - slopeAt(0) = 0.
	simpleAt := func(t *testing.T, NextFloat float64) (placed bool, draws int) {
		t.Helper()
		v, pal := newTreeTestVolume(t, 6)
		leaf := pal.Get("minecraft:oak_leaves", nil)
		c := &simpleCanopy{
			leafID: leaf, offsetMin: 0, offsetMax: 0, minWidth: 0, rise: 1, run: 1,
			variationChance: []chanceInformation{{percent: 50}},
		}
		tr := random.NewTracer(&spruceScriptedRandom{floats: []float64{NextFloat}})
		anchor := wgen.BlockPos{X: 0, Y: 20, Z: 0}
		c.place(v, anchor, tr, treeParamsLists{}, nil)
		return v.GetBlock(anchor) == leaf, len(tr.Draws)
	}

	t.Run("simple canopy rolls at radius 0 and a hit deletes its only cell", func(t *testing.T) {
		// 0.1*100 = 10 < 50 -> roll true -> the centre cell is SKIPPED.
		placed, draws := simpleAt(t, 0.1)
		if draws != 1 {
			t.Errorf("draws = %d, want exactly 1 -- the corner test is unguarded at radius 0", draws)
		}
		if placed {
			t.Error("a successful variation_chance roll must delete the canopy's only cell")
		}
	})
	t.Run("simple canopy still spends the draw when the roll misses", func(t *testing.T) {
		// 0.9*100 = 90 < 50 is false -> the cell survives, but the draw was still spent.
		placed, draws := simpleAt(t, 0.9)
		if draws != 1 {
			t.Errorf("draws = %d, want exactly 1", draws)
		}
		if !placed {
			t.Error("a failed roll must keep the cell")
		}
	})

	t.Run("acacia canopy at canopy_size 0 empties its own anchor layer", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 6)
		leaf := pal.Get("minecraft:oak_leaves", nil)
		c := &acaciaCanopy{leafID: leaf, canopySize: 0}
		anchor := wgen.BlockPos{X: 0, Y: 20, Z: 0}
		c.place(v, anchor, nil, treeParamsLists{}, nil)

		if v.GetBlock(anchor) == leaf {
			t.Error("anchor layer: acacia has no radius-zero escape, so its only cell is cut")
		}
		above := wgen.BlockPos{X: anchor.X, Y: anchor.Y + 1, Z: anchor.Z}
		if v.GetBlock(above) != leaf {
			t.Error("layer above: the upper layer has no corner cut and must still place")
		}
	})

	t.Run("spruce canopy at radius 0 keeps its centre cell", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 6)
		leaf := pal.Get("minecraft:oak_leaves", nil)
		// lower/upper are degenerate (zero draws); max_radius={0,3} draws twice -- the
		// the int-range draw and then the direct nextIntBound(max-min) -- both scripted to 0,
		// so both the cap and the starting radius are 0 and the run is a single layer.
		c := &spruceCanopy{leafID: leaf, lowerMin: 0, lowerMax: 0, upperMin: 0, upperMax: 0, radiusMin: 0, radiusMax: 3}
		rnd := &spruceScriptedRandom{bounds: []int{0, 0}}
		anchor := wgen.BlockPos{X: 0, Y: 20, Z: 0}
		c.place(v, anchor, rnd, treeParamsLists{}, nil)

		if rnd.idx != 2 {
			t.Fatalf("consumed %d scripted draws, want exactly 2", rnd.idx)
		}
		if v.GetBlock(anchor) != leaf {
			t.Error("spruce guards its corner test with a nonzero radius, so the centre cell survives")
		}
	})
}

// TestSpruceCanopy_Place_TieredCrossSections places a canopy directly (empty may_replace, so the
// ground search's passesAllowList succeeds immediately at the anchor -- see tree.go's header -- and the
// leaf gate's own passesAllowList also always succeeds) with lower_offset={-7,-2}, upper_offset=
// {0,5}, max_radius={2,5}, scripted draws [0,0,1,0] (lowerVal=-7, upperVal=0, maxRadiusVal=3,
// jitter=0). By the pinned grow-then-reset formula this must produce EXACTLY 8 layers (n=7) with
// radii 0,1,2,0,1,2,3,1 -- hand-derived from the module header's own transliterated state machine
// and cross-checked twice independently before being pinned here. Renders a vertical (X/Y)
// cross-section through the center Z so the alternating-tier silhouette (spruce's real signature
// shape, unlike Acacia/Pine/Simple/Fancy's single smooth taper) is visible, plus per-layer
// horizontal cross-sections at the two radii (2 and 3) where the corner-cut actually removes cells.
func TestSpruceCanopy_Place_TieredCrossSections(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &spruceCanopy{
		leafID:   leaf,
		lowerMin: -7, lowerMax: -2,
		upperMin: 0, upperMax: 5,
		radiusMin: 2, radiusMax: 5,
	}
	rnd := &spruceScriptedRandom{bounds: []int{0, 0, 1, 0}}

	anchor := wgen.BlockPos{X: 0, Y: 20, Z: 0}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)

	if rnd.idx != 4 {
		t.Fatalf("consumed %d scripted draws, want exactly 4", rnd.idx)
	}

	wantRadius := []int{0, 1, 2, 0, 1, 2, 3, 1} // dy=0..7, topY=anchor.Y down to anchor.Y-7
	for dy, r := range wantRadius {
		y := anchor.Y - dy
		var art strings.Builder
		for dz := -3; dz <= 3; dz++ {
			for dx := -3; dx <= 3; dx++ {
				pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z + dz}
				if v.GetBlock(pos) == leaf {
					art.WriteByte('#')
				} else {
					art.WriteByte('.')
				}
			}
			art.WriteByte('\n')
		}
		t.Logf("layer dy=%d (want radius %d), horizontal cross-section at y=%d (# leaves, . empty):\n%s", dy, r, y, art.String())

		for dx := -3; dx <= 3; dx++ {
			for dz := -3; dz <= 3; dz++ {
				pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z + dz}
				corner := r != 0 && abs(dx) == r && abs(dz) == r
				want := abs(dx) <= r && abs(dz) <= r && !corner
				got := v.GetBlock(pos) == leaf
				if got != want {
					t.Errorf("layer dy=%d pos(dx=%d,dz=%d): leaf=%v, want %v (radius %d, corner=%v)", dy, dx, dz, got, want, r, corner)
				}
			}
		}
	}

	// No leaves at all beyond dy=7 (n=7 is the last layer).
	for dy := 8; dy <= 10; dy++ {
		y := anchor.Y - dy
		for dx := -4; dx <= 4; dx++ {
			for dz := -4; dz <= 4; dz++ {
				pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z + dz}
				if v.GetBlock(pos) == leaf {
					t.Errorf("leaf placed at dy=%d (beyond n=7, last layer) pos(dx=%d,dz=%d)", dy, dx, dz)
				}
			}
		}
	}

	// Vertical (X/Y) cross-section through the center Z -- the alternating-tier silhouette.
	var art strings.Builder
	for dy := 0; dy <= 7; dy++ {
		y := anchor.Y - dy
		for dx := -3; dx <= 3; dx++ {
			pos := wgen.BlockPos{X: anchor.X + dx, Y: y, Z: anchor.Z}
			if v.GetBlock(pos) == leaf {
				art.WriteByte('#')
			} else {
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("vertical (X/Y) cross-section through anchor, top to bottom (# leaves, . empty):\n%s", art.String())

	wantLines := []string{
		"...#...\n", // dy=0, r=0
		"..###..\n", // dy=1, r=1
		".#####.\n", // dy=2, r=2
		"...#...\n", // dy=3, r=0 -- RESET
		"..###..\n", // dy=4, r=1
		".#####.\n", // dy=5, r=2
		"#######\n", // dy=6, r=3
		"..###..\n", // dy=7, r=1 -- RESET (flag=1, not 0)
	}
	if art.String() != strings.Join(wantLines, "") {
		t.Fatalf("vertical cross-section =\n%s\nwant\n%s", art.String(), strings.Join(wantLines, ""))
	}
}

// TestSpruceCanopy_Place_GroundSearch_WalksThroughTrunkAndAborts proves the ground-search loop is
// real: a solid, non-may_replace column below the anchor makes the search walk all the way down to
// MinY and abort WITHOUT placing anything and WITHOUT drawing any RNG (confirmed via a Tracer) --
// see the module header's own account of that early return.
func TestSpruceCanopy_Place_GroundSearch_WalksThroughTrunkAndAborts(t *testing.T) {
	v, pal := newTreeTestVolume(t, 4)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	stone := pal.Get("minecraft:stone", nil)
	c := &spruceCanopy{
		leafID:   leaf,
		lowerMin: -2, lowerMax: 0,
		upperMin: 0, upperMax: 2,
		radiusMin: 1, radiusMax: 3,
	}
	// A non-empty may_replace that names neither stone nor air -- so the ground search's own
	// passesAllowList (no IsAir fallback, unlike the leaf gate) never succeeds.
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:short_grass")}, nil, nil, nil)

	anchor := wgen.BlockPos{X: 0, Y: 5, Z: 0}
	for y := 0; y < anchor.Y; y++ {
		v.SetBlock(wgen.BlockPos{X: anchor.X, Y: y, Z: anchor.Z}, stone)
	}

	tr := random.NewTracer(random.New(1))
	c.place(v, anchor, tr, treeParamsLists{mayReplace: mayReplace}, nil)

	if len(tr.Draws) != 0 {
		t.Fatalf("draws = %v, want none (the abort path draws nothing)", tr.Draws)
	}
	for x := -4; x <= 4; x++ {
		for y := 0; y <= 10; y++ {
			for z := -4; z <= 4; z++ {
				pos := wgen.BlockPos{X: x, Y: y, Z: z}
				if v.GetBlock(pos) == leaf {
					t.Fatalf("leaf placed at (%d,%d,%d), want nothing (ground search must abort)", x, y, z)
				}
			}
		}
	}
}

// TestSpruceCanopy_Place_RespectsMayReplace mirrors simpleCanopy's own precedent test: the leaf
// gate has the SAME "may_replace OR IsAir" shape (not Acacia/Pine/Fancy's plain passesAllowList),
// so a pre-placed block that is neither in may_replace nor air must be left untouched, while air
// positions still get leafed via the fallback.
func TestSpruceCanopy_Place_RespectsMayReplace(t *testing.T) {
	v, pal := newTreeTestVolume(t, 4)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	stone := pal.Get("minecraft:stone", nil)
	grass := pal.Get("minecraft:short_grass", nil)
	c := &spruceCanopy{
		leafID:   leaf,
		lowerMin: 0, lowerMax: 0,
		upperMin: 0, upperMax: 0,
		radiusMin: 1, radiusMax: 3,
	}
	// Non-empty, so the ground search's own passesAllowList (no IsAir fallback -- see module
	// header) needs a real match one below the anchor to succeed immediately.
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:short_grass")}, nil, nil, nil)

	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	blocked := wgen.BlockPos{X: 1, Y: 15, Z: 0}
	v.SetBlock(blocked, stone)
	v.SetBlock(wgen.BlockPos{X: anchor.X, Y: anchor.Y - 1, Z: anchor.Z}, grass)

	// lowerMin==lowerMax and upperMin==upperMax: those two draws are degenerate (min>=max-1, zero
	// RNG). max_radius (1,3) and the direct jitter draw are NOT degenerate, so this uses a scripted
	// RNG to pin radius=1 deterministically (maxRadiusVal draw -> treeIntRangeValue's
	// NextIntBound(max-min)=NextIntBound(2), scripted to 0; jitter draw -> the direct draw's own
	// NextIntBound(max_radius.max-max_radius.min)=NextIntBound(2), scripted to 1) rather than depend
	// on an arbitrary seed's output. spruceScriptedRandom ignores the bound argument entirely (see
	// its own doc comment), so these exact bound numbers are documentation only, not asserted.
	rnd := &spruceScriptedRandom{bounds: []int{0, 1}}
	c.place(v, anchor, rnd, treeParamsLists{mayReplace: mayReplace}, nil)
	if rnd.idx != 2 {
		t.Fatalf("consumed %d scripted draws, want exactly 2", rnd.idx)
	}

	if got := v.GetBlock(blocked); got != stone {
		t.Fatalf("expected the pre-placed stone to be left untouched (not in may_replace, not air), got %v", pal.Entry(got))
	}
	if got := v.GetBlock(anchor); got != leaf {
		t.Fatalf("expected the anchor itself to be leafed (starts as air, passes the IsAir fallback), got %v", pal.Entry(got))
	}
}

// --- randomSpreadCanopy: schema -------------------------------------------------------------------

func randomSpreadTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"canopy_height":           map[string]any{"range_min": float64(-2), "range_max": float64(2)},
		"canopy_radius":           map[string]any{"range_min": float64(1), "range_max": float64(3)},
		"leaf_placement_attempts": float64(3),
		"leaf_blocks":             []any{[]any{"minecraft:oak_leaves", float64(1)}},
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:oak_log",
			"trunk_height": float64(5),
		},
		"random_spread_canopy": canopy,
	}
}

func TestBuildTreeFeature_RandomSpreadCanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		f, err := buildTreeFeature(randomSpreadTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		rc := f.(*TreeFeature).canopy.(*randomSpreadCanopy)
		if rc.heightMin != -2 || rc.heightMax != 2 || rc.radiusMin != 1 || rc.radiusMax != 3 || rc.attempts != 3 || len(rc.blocks) != 1 {
			t.Errorf("got %+v, want heightMin=-2 heightMax=2 radiusMin=1 radiusMax=3 attempts=3 len(blocks)=1", rc)
		}
	})
	t.Run("canopy_height required", func(t *testing.T) {
		body := randomSpreadTreeBody(nil)
		delete(body["random_spread_canopy"].(map[string]any), "canopy_height")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_radius required", func(t *testing.T) {
		body := randomSpreadTreeBody(nil)
		delete(body["random_spread_canopy"].(map[string]any), "canopy_radius")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_placement_attempts required", func(t *testing.T) {
		body := randomSpreadTreeBody(nil)
		delete(body["random_spread_canopy"].(map[string]any), "leaf_placement_attempts")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_placement_attempts must be >= 0", func(t *testing.T) {
		body := randomSpreadTreeBody(map[string]any{"leaf_placement_attempts": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_blocks required", func(t *testing.T) {
		body := randomSpreadTreeBody(nil)
		delete(body["random_spread_canopy"].(map[string]any), "leaf_blocks")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_blocks must be non-empty", func(t *testing.T) {
		body := randomSpreadTreeBody(map[string]any{"leaf_blocks": []any{}})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_blocks entries must be [blockDescriptor, weight] tuples", func(t *testing.T) {
		body := randomSpreadTreeBody(map[string]any{"leaf_blocks": []any{[]any{"minecraft:oak_leaves"}}})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_height accepts plain number shorthand", func(t *testing.T) {
		body := randomSpreadTreeBody(map[string]any{"canopy_height": float64(3)})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		rc := f.(*TreeFeature).canopy.(*randomSpreadCanopy)
		if rc.heightMin != 3 || rc.heightMax != 3 {
			t.Errorf("heightMin=%d heightMax=%d, want 3,3", rc.heightMin, rc.heightMax)
		}
	})
	t.Run("canopy_radius accepts [min,max] array shorthand", func(t *testing.T) {
		body := randomSpreadTreeBody(map[string]any{"canopy_radius": []any{float64(1), float64(4)}})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		rc := f.(*TreeFeature).canopy.(*randomSpreadCanopy)
		if rc.radiusMin != 1 || rc.radiusMax != 4 {
			t.Errorf("radiusMin=%d radiusMax=%d, want 1,4", rc.radiusMin, rc.radiusMax)
		}
	})
}

// --- randomSpreadCanopy: RNG draw sequence ----------------------------------------------------

// TestTreeFeature_RandomSpreadCanopyKey_RNGDrawSequence pins the full sequence through a real
// TreeFeature.Place: the trunk's lean-direction draw, THEN random_spread_canopy's own draws
// (canopy_height, canopy_radius, then per candidate x per attempt: the weighted leaf-block pick,
// then 6 jitter draws in X,X,Y,Y,Z,Z order -- see module header), THEN the trunk's trailing branch
// re-roll. One log yields exactly ONE candidate, and leaf_placement_attempts=1 keeps this to
// exactly one attempt, so the expected sequence is fully enumerable by hand: 1 + 1 (height) + 1
// (radius) + 1 (pick) + 6 (jitter) + 1 (re-roll) = 11 draws, all NextIntBound (both the
// inclusive two-argument integer draw -- geodeIntRange's own shape -- and the bounded integer draw
// bottom out
// at the IRandom-interface level in NextIntBound; see module header).
//
// [REBASED ONTO acacia_trunk] This used to grow from the bare `trunk` key, which was
// wrongly dispatched to an acacia-shaped path. The bare key is the simple trunk, and
// the simple trunk hands the canopy an EMPTY candidates list -- so on the old body this canopy now
// draws NOTHING AT ALL and places NOTHING, which is correct vanilla behaviour but leaves the test
// with no subject. Simply shrinking the expected sequence to zero would have quietly retired the
// only draw-order pin random_spread_canopy has. It is rebased onto the trunk class that actually
// populates the vector instead; see withAcaciaTrunkForCandidates.
//
// canopy_height is overridden to {1,3} (the body default is {-2,2}). heightVal feeds
// NextIntBound(heightVal) for the two Y jitter draws, and random.Tracer deliberately does not record
// a NextIntBound(0) call -- so a heightVal that can land <= 0 makes this test's own expected LENGTH
// seed-dependent. {1,3} draws once and can only yield 1 or 2. This is the same reasoning
// mangrove_canopy's own sequence test already spells out for its degenerate ranges.
func TestTreeFeature_RandomSpreadCanopyKey_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	body := randomSpreadTreeBody(map[string]any{
		"leaf_placement_attempts": float64(1),
		"canopy_height":           map[string]any{"range_min": float64(1), "range_max": float64(3)},
	})
	body = withAcaciaTrunkForCandidates(body, 1)
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := built.(*TreeFeature)
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantSeq := []random.Method{
		random.MethodNextIntBound, // trunk lean direction
		random.MethodNextIntBound, // canopy_height draw
		random.MethodNextIntBound, // canopy_radius draw
		random.MethodNextIntBound, // weighted leaf-block pick (1 leaf_blocks entry, nonzero weight)
		random.MethodNextIntBound, // dx1
		random.MethodNextIntBound, // dx2
		random.MethodNextIntBound, // dy1
		random.MethodNextIntBound, // dy2
		random.MethodNextIntBound, // dz1
		random.MethodNextIntBound, // dz2
		random.MethodNextIntBound, // trailing branch re-roll
	}
	if seq := drawSeqRandom(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v (len %d), want %v (len %d)", seq, len(seq), wantSeq, len(wantSeq))
	}
	if leaves := countBlocksOfID(v, 10, pal.Get("minecraft:oak_leaves", nil)); leaves == 0 {
		t.Fatal("random_spread_canopy placed no leaves -- the sequence above must come from a canopy that ran")
	}
}

// --- randomSpreadCanopy: real geometry, ASCII cross-sections ------------------------------------

// TestRandomSpreadCanopy_Place_ScattersAroundMultipleCandidates exercises the one property no
// other canopy in this file has: the random-spread canopy is the ONLY implemented shape that reads
// the candidates slice (the trunk's own log column, one entry per successfully-placed position --
// see module header) instead of a single anchor. canopy_height min==max (0 draws, heightVal=1) and
// canopy_radius min==max (0 draws, radiusVal=1) keep every jitter draw's bound fixed at 1, so an
// ALL-ZERO scripted draw sequence places the leaf EXACTLY on its own candidate (offset formula:
// (0-1)+0+1 = 0 on every axis -- see module header). Scripting ONE non-zero draw per candidate
// (alternating which axis) then scatters the three single-cell placements to three DIFFERENT
// offsets around three DIFFERENT candidates -- the defining visual trait vs. every other canopy in
// this file, which all place a single contiguous shape around one shared anchor.
func TestRandomSpreadCanopy_Place_ScattersAroundMultipleCandidates(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &randomSpreadCanopy{
		heightMin: 1, heightMax: 1, // max<=min -> 0 draws, heightVal=1
		radiusMin: 1, radiusMax: 1, // max<=min -> 0 draws, radiusVal=1
		attempts: 1,
		blocks:   []randomSpreadWeightedBlock{{id: leaf, weight: 1}},
	}
	candidates := []wgen.BlockPos{
		{X: 0, Y: 10, Z: 0}, // attempt draws all-zero -> offset (0,0,0) -> lands ON the candidate
		{X: 0, Y: 11, Z: 0}, // attempt draws dx2=1 -> offset (1,0,0) -> one cell +X of the candidate
		{X: 0, Y: 12, Z: 0}, // attempt draws dz1=1 -> offset (0,0,1) -> one cell +Z of the candidate
	}
	// Per attempt: [pick, dx1, dx2, dy1, dy2, dz1, dz2]. radiusVal=heightVal=1, so offset =
	// a+b-1+1 = a+b for every axis -- 0 unless exactly one of that axis's two draws is 1.
	rnd := &spruceScriptedRandom{bounds: []int{
		0, 0, 0, 0, 0, 0, 0, // candidate 1: all zero -> (0,0,0)
		0, 0, 1, 0, 0, 0, 0, // candidate 2: dx2=1 -> (1,0,0)
		0, 0, 0, 0, 0, 1, 0, // candidate 3: dz1=1 -> (0,0,1)
	}}
	c.place(v, wgen.BlockPos{}, rnd, treeParamsLists{}, candidates)
	if rnd.idx != len(rnd.bounds) {
		t.Fatalf("consumed %d scripted draws, want exactly %d", rnd.idx, len(rnd.bounds))
	}

	want := []wgen.BlockPos{
		{X: 0, Y: 10, Z: 0},
		{X: 1, Y: 11, Z: 0},
		{X: 0, Y: 12, Z: 1},
	}
	for _, p := range want {
		if got := v.GetBlock(p); got != leaf {
			t.Errorf("expected leaf at %+v, got %v", p, pal.Entry(got))
		}
	}

	var art strings.Builder
	for _, y := range []int{12, 11, 10} {
		art.WriteString(fmt.Sprintf("y=%d (x=-1..2 across, z=-1..2 down):\n", y))
		for z := -1; z <= 2; z++ {
			for x := -1; x <= 2; x++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == leaf {
					art.WriteByte('#')
				} else {
					art.WriteByte('.')
				}
			}
			art.WriteByte('\n')
		}
	}
	t.Logf("random_spread_canopy: three candidates (0,10,0)/(0,11,0)/(0,12,0), one leaf per attempt, each at a "+
		"DIFFERENT offset from its OWN candidate -- not a shared shape around one anchor:\n%s", art.String())
}

// TestRandomSpreadCanopy_Place_RespectsMayReplace mirrors spruceCanopy's own mayReplace test:
// a pre-placed stone cell (not in may_replace, not air) at the exact position a scripted all-zero
// draw would target must be left untouched, while a genuinely-air cell elsewhere still gets leafed
// via the same passesAllowList-OR-IsAir gate every other canopy in this file already established
// (see module header for why random_spread_canopy's own, more elaborate real gate reduces to this
// same approximation).
func TestRandomSpreadCanopy_Place_RespectsMayReplace(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	stone := pal.Get("minecraft:stone", nil)
	grass := pal.Get("minecraft:short_grass", nil)
	c := &randomSpreadCanopy{
		heightMin: 1, heightMax: 1,
		radiusMin: 1, radiusMax: 1,
		attempts: 1,
		blocks:   []randomSpreadWeightedBlock{{id: leaf, weight: 1}},
	}
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:short_grass")}, nil, nil, nil)

	blocked := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	replaceable := wgen.BlockPos{X: 5, Y: 10, Z: 0}
	v.SetBlock(blocked, stone)
	v.SetBlock(replaceable, grass)
	candidates := []wgen.BlockPos{blocked, replaceable}

	// All-zero draws -> offset (0,0,0) on every axis (heightVal=radiusVal=1, see the scatter test
	// above) -- each attempt lands exactly on its own candidate.
	rnd := &spruceScriptedRandom{bounds: []int{
		0, 0, 0, 0, 0, 0, 0, // candidate 1 (blocked)
		0, 0, 0, 0, 0, 0, 0, // candidate 2 (replaceable)
	}}
	c.place(v, wgen.BlockPos{}, rnd, treeParamsLists{mayReplace: mayReplace}, candidates)

	if got := v.GetBlock(blocked); got != stone {
		t.Fatalf("expected the pre-placed stone to be left untouched (not in may_replace, not air), got %v", pal.Entry(got))
	}
	if got := v.GetBlock(replaceable); got != leaf {
		t.Fatalf("expected the short_grass cell to be replaced (matches may_replace), got %v", pal.Entry(got))
	}
}

// --- roofedCanopy: schema validation (buildTreeFeature, "roofed_canopy" key) --------------------

func roofedTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"leaf_block":    "minecraft:oak_leaves",
		"canopy_height": float64(2),
		"core_width":    float64(1),
		"outer_radius":  float64(2),
		"inner_radius":  float64(1),
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:oak_log",
			"trunk_height": float64(5),
		},
		"roofed_canopy": canopy,
	}
}

func buildTestRoofedTree(t *testing.T, pal *block.Palette, canopyExtra map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(roofedTreeBody(canopyExtra), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf, ok := f.(*TreeFeature)
	if !ok {
		t.Fatalf("builder returned %T, want *TreeFeature", f)
	}
	return tf
}

func TestBuildTreeFeature_RoofedCanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		f, err := buildTreeFeature(roofedTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		rc := f.(*TreeFeature).canopy.(*roofedCanopy)
		if rc.canopyHeight != 2 || rc.outerRadius != 2 || rc.innerRadius != 1 {
			t.Errorf("got %+v, want canopyHeight=2 outerRadius=2 innerRadius=1", rc)
		}
	})
	t.Run("leaf_block required", func(t *testing.T) {
		body := roofedTreeBody(nil)
		delete(body["roofed_canopy"].(map[string]any), "leaf_block")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_height required", func(t *testing.T) {
		body := roofedTreeBody(nil)
		delete(body["roofed_canopy"].(map[string]any), "canopy_height")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_height must be >= 0", func(t *testing.T) {
		body := roofedTreeBody(map[string]any{"canopy_height": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("core_width required", func(t *testing.T) {
		body := roofedTreeBody(nil)
		delete(body["roofed_canopy"].(map[string]any), "core_width")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("core_width must be 1", func(t *testing.T) {
		body := roofedTreeBody(map[string]any{"core_width": float64(2)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("outer_radius required (no known default)", func(t *testing.T) {
		body := roofedTreeBody(nil)
		delete(body["roofed_canopy"].(map[string]any), "outer_radius")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("outer_radius must be >= -1", func(t *testing.T) {
		body := roofedTreeBody(map[string]any{"outer_radius": float64(-2)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("outer_radius == -1 is legal (skips the floor/roof-cap section)", func(t *testing.T) {
		body := roofedTreeBody(map[string]any{"outer_radius": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
	t.Run("inner_radius required (no known default)", func(t *testing.T) {
		body := roofedTreeBody(nil)
		delete(body["roofed_canopy"].(map[string]any), "inner_radius")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("inner_radius must be >= 0", func(t *testing.T) {
		body := roofedTreeBody(map[string]any{"inner_radius": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
}

// --- roofedCanopy: RNG draw sequence -------------------------------------------------------------

// TestTreeFeature_RoofedCanopyKey_RNGDrawSequence pins the full sequence through a real
// TreeFeature.Place: the trunk draws nothing, so the WHOLE sequence is roofed_canopy's own SINGLE
// draw (NextBoolean, the "peak" gate -- see module header). Uses a real seeded
// Tracer(random.New(seed)), not a scripted mock, specifically to prove the canopy draws
// NextBoolean and NOTHING else -- not just that it draws once. A NextBoolean in a sequence of
// otherwise-NextIntBound draws is also its own proof the canopy ran.//
// [UPDATED] The bare `trunk` key this body uses is the simple trunk, not
// the acacia one -- see tree.go's trunk-key table. The 3 lean draws and the trailing re-roll
// this test used to expect belonged to a class the key never binds, and a scalar trunk_height plus
// an absent height_modifier make the simple trunk itself draw nothing, so only the canopy's own
// draws remain. The canopy is still genuinely exercised: every draw below is its own.
func TestTreeFeature_RoofedCanopyKey_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	tf := buildTestRoofedTree(t, pal, nil)
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantSeq := []random.Method{
		random.MethodNextBoolean, // roofed_canopy's own single "peak" draw
	}
	if seq := drawSeqRandom(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v (len %d), want %v (len %d)", seq, len(seq), wantSeq, len(wantSeq))
	}
}

// --- roofedCanopy: real geometry, ASCII cross-sections --------------------------------------------

// roofedScriptedRandom scripts NextBoolean's return values in call order -- roofedCanopy's own
// single draw (the "peak" gate) is the ONLY RNG in this shape (see module header), so no
// NextIntBound scripting is needed, unlike spruceScriptedRandom.
type roofedScriptedRandom struct {
	values []bool
	idx    int
}

func (r *roofedScriptedRandom) NextBoolean() bool {
	v := r.values[r.idx]
	r.idx++
	return v
}
func (r *roofedScriptedRandom) NextInt() int32                { panic("unused") }
func (r *roofedScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (r *roofedScriptedRandom) NextIntBound(int) int          { panic("unused") }
func (r *roofedScriptedRandom) NextFloat() float64            { panic("unused") }
func (r *roofedScriptedRandom) NextDouble() float64           { panic("unused") }
func (r *roofedScriptedRandom) SetSeed(uint32)                {}
func (r *roofedScriptedRandom) GetSeed() uint32               { return 0 }

var _ random.IRandom = (*roofedScriptedRandom)(nil)

// TestRoofedCanopy_Place_HutCrossSections places directly with outer_radius=2, inner_radius=1,
// canopy_height=2, scripting NextBoolean()=true so the optional peak is included. By the module
// header's own enumeration, outer_radius=2 produces a solid 5x5 floor and a 13-cell rounded-diamond
// roof cap (NOT the full 5x5 square -- the 4 far corners AND their immediate radius=2 neighbours on
// each axis are trimmed by roofedUpperCornerAllowed); inner_radius=1 produces the SAME corner-cut
// octagon ring acacia_canopy/pine_canopy/spruce_canopy already use, stacked 2 layers tall.
func TestRoofedCanopy_Place_HutCrossSections(t *testing.T) {
	v, pal := newTreeTestVolume(t, 8)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &roofedCanopy{leafID: leaf, canopyHeight: 2, outerRadius: 2, innerRadius: 1}
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	rnd := &roofedScriptedRandom{values: []bool{true}}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)
	if rnd.idx != 1 {
		t.Fatalf("consumed %d NextBoolean draws, want exactly 1", rnd.idx)
	}

	at := func(dx, dy, dz int) bool {
		return v.GetBlock(wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}) == leaf
	}

	// Floor (y=-1): a FULL solid 5x5 square, no corner cut -- see module header's enumeration note.
	for dx := -2; dx <= 2; dx++ {
		for dz := -2; dz <= 2; dz++ {
			if !at(dx, -1, dz) {
				t.Errorf("floor cell (%d,-1,%d) not placed, want a full solid square", dx, dz)
			}
		}
	}
	// Roof cap (y=+2, == canopyHeight): the far corners AND their radius=2 neighbours are trimmed.
	trimmed := [][2]int{{-2, -2}, {-2, -1}, {-2, 2}, {-2, 1}, {2, -2}, {2, -1}, {2, 2}, {2, 1}, {-1, -2}, {1, -2}, {-1, 2}, {1, 2}}
	trimmedSet := map[[2]int]bool{}
	for _, p := range trimmed {
		trimmedSet[p] = true
	}
	roofCount := 0
	for dx := -2; dx <= 2; dx++ {
		for dz := -2; dz <= 2; dz++ {
			got := at(dx, 2, dz)
			want := !trimmedSet[[2]int{dx, dz}]
			if got != want {
				t.Errorf("roof cap cell (%d,+2,%d) = %v, want %v", dx, dz, got, want)
			}
			if got {
				roofCount++
			}
		}
	}
	if roofCount != 13 {
		t.Errorf("roof cap placed %d cells, want 13 (the rounded-diamond trim -- see module header)", roofCount)
	}
	// Peak (y=+3, == canopyHeight+1): exactly one cell, since NextBoolean scripted true.
	if !at(0, 3, 0) {
		t.Error("peak cell (0,+3,0) not placed even though NextBoolean was scripted true")
	}
	// Walls (y=0,1, == 0..canopyHeight-1): corner-cut octagon ring, radius 1, at BOTH layers.
	for _, dy := range []int{0, 1} {
		for dx := -1; dx <= 1; dx++ {
			for dz := -1; dz <= 1; dz++ {
				got := at(dx, dy, dz)
				want := !(abs(dx) == 1 && abs(dz) == 1) // true corners cut, same as acacia/pine/spruce
				if got != want {
					t.Errorf("wall cell (%d,%d,%d) = %v, want %v", dx, dy, dz, got, want)
				}
			}
		}
	}

	var art strings.Builder
	for _, y := range []int{3, 2, 1, 0, -1} {
		art.WriteString(fmt.Sprintf("y=%+d:\n", y-0))
		for dz := -2; dz <= 2; dz++ {
			for dx := -2; dx <= 2; dx++ {
				if at(dx, y, dz) {
					art.WriteByte('#')
				} else {
					art.WriteByte('.')
				}
			}
			art.WriteByte('\n')
		}
	}
	t.Logf("roofed_canopy hut: outer_radius=2/inner_radius=1/canopy_height=2, peak on -- top to bottom "+
		"(peak, roof cap, 2 wall layers, floor):\n%s", art.String())
}

// TestRoofedCanopy_Place_PeakGatedByNextBoolean proves the SINGLE RNG draw actually gates the peak
// cell -- scripting false must leave it unplaced while everything else (floor/roof-cap/walls, which
// draw no RNG) is unaffected. With the gate ignored, the peak cell is placed and this test fails.
func TestRoofedCanopy_Place_PeakGatedByNextBoolean(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &roofedCanopy{leafID: leaf, canopyHeight: 1, outerRadius: 0, innerRadius: 0}
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	rnd := &roofedScriptedRandom{values: []bool{false}}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)
	if v.GetBlock(wgen.BlockPos{X: anchor.X, Y: anchor.Y + 2, Z: anchor.Z}) == leaf {
		t.Fatal("peak cell placed even though NextBoolean was scripted false")
	}

	v2, pal2 := newTreeTestVolume(t, 6)
	leaf2 := pal2.Get("minecraft:oak_leaves", nil)
	c2 := &roofedCanopy{leafID: leaf2, canopyHeight: 1, outerRadius: 0, innerRadius: 0}
	rnd2 := &roofedScriptedRandom{values: []bool{true}}
	c2.place(v2, anchor, rnd2, treeParamsLists{}, nil)
	if v2.GetBlock(wgen.BlockPos{X: anchor.X, Y: anchor.Y + 2, Z: anchor.Z}) != leaf2 {
		t.Fatal("peak cell not placed even though NextBoolean was scripted true")
	}
}

// TestRoofedCanopy_Place_IsAirGateOnly_NoMayReplaceFallback proves the roofed canopy's own leaf gate
// (see module header: a raw material-type test against index 0 alone, no may_replace term at all) is
// STRICTER than every other canopy in this file: a pre-placed block that IS listed in may_replace
// but is NOT air must still be left untouched, unlike acacia/pine/simple/spruce/random_spread's own
// "passesAllowList OR IsAir" gate, which WOULD replace it. This is the one property that would
// silently break if roofedCanopy.place reused the established OR-air-fallback helper other canopies
// share instead of IsAir alone.
func TestRoofedCanopy_Place_IsAirGateOnly_NoMayReplaceFallback(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	grass := pal.Get("minecraft:short_grass", nil)
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:short_grass")}, nil, nil, nil)

	c := &roofedCanopy{leafID: leaf, canopyHeight: 0, outerRadius: 0, innerRadius: 0}
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	floorPos := wgen.BlockPos{X: anchor.X, Y: anchor.Y - 1, Z: anchor.Z}
	v.SetBlock(floorPos, grass)

	rnd := &roofedScriptedRandom{values: []bool{false}}
	c.place(v, anchor, rnd, treeParamsLists{mayReplace: mayReplace}, nil)

	if got := v.GetBlock(floorPos); got != grass {
		t.Fatalf("expected short_grass left untouched (matches may_replace but is NOT air, and "+
			"roofed_canopy's own gate has no may_replace fallback), got %v", pal.Entry(got))
	}
}

// --- mangroveCanopy: schema validation (buildTreeFeature, "mangrove_canopy" key) ----------------

func mangroveTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"canopy_height":                  map[string]any{"range_min": float64(0), "range_max": float64(2)},
		"canopy_radius":                  map[string]any{"range_min": float64(0), "range_max": float64(2)},
		"leaf_placement_attempts":        float64(3),
		"leaf_blocks":                    []any{[]any{"minecraft:mangrove_leaves", float64(1)}},
		"hanging_block":                  "minecraft:mangrove_roots",
		"hanging_block_placement_chance": map[string]any{"numerator": float64(1), "denominator": float64(2)},
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:mangrove_log",
			"trunk_height": float64(5),
		},
		"mangrove_canopy": canopy,
	}
}

func TestBuildTreeFeature_MangroveCanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		f, err := buildTreeFeature(mangroveTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		mc := f.(*TreeFeature).canopy.(*mangroveCanopy)
		if mc.heightMin != 0 || mc.heightMax != 2 || mc.radiusMin != 0 || mc.radiusMax != 2 || mc.attempts != 3 {
			t.Errorf("got %+v, want heightMin=0 heightMax=2 radiusMin=0 radiusMax=2 attempts=3", mc)
		}
		if len(mc.leafBlocks) != 1 || mc.leafBlocks[0].weight != 1 {
			t.Errorf("got leafBlocks=%+v", mc.leafBlocks)
		}
		if !mc.hangingChance.isFraction || mc.hangingChance.numerator != 1 || mc.hangingChance.denominator != 2 {
			t.Errorf("got hangingChance=%+v, want fraction 1/2", mc.hangingChance)
		}
	})
	t.Run("canopy_height required", func(t *testing.T) {
		body := mangroveTreeBody(nil)
		delete(body["mangrove_canopy"].(map[string]any), "canopy_height")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_radius required", func(t *testing.T) {
		body := mangroveTreeBody(nil)
		delete(body["mangrove_canopy"].(map[string]any), "canopy_radius")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_placement_attempts required", func(t *testing.T) {
		body := mangroveTreeBody(nil)
		delete(body["mangrove_canopy"].(map[string]any), "leaf_placement_attempts")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_placement_attempts must be >= 0", func(t *testing.T) {
		body := mangroveTreeBody(map[string]any{"leaf_placement_attempts": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_blocks required", func(t *testing.T) {
		body := mangroveTreeBody(nil)
		delete(body["mangrove_canopy"].(map[string]any), "leaf_blocks")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("leaf_blocks must be non-empty", func(t *testing.T) {
		body := mangroveTreeBody(map[string]any{"leaf_blocks": []any{}})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("hanging_block required", func(t *testing.T) {
		body := mangroveTreeBody(nil)
		delete(body["mangrove_canopy"].(map[string]any), "hanging_block")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("hanging_block_placement_chance required", func(t *testing.T) {
		body := mangroveTreeBody(nil)
		delete(body["mangrove_canopy"].(map[string]any), "hanging_block_placement_chance")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("hanging_block_placement_chance accepts a plain percent number", func(t *testing.T) {
		body := mangroveTreeBody(map[string]any{"hanging_block_placement_chance": float64(50)})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		mc := f.(*TreeFeature).canopy.(*mangroveCanopy)
		if mc.hangingChance.isFraction || mc.hangingChance.percent != 50 {
			t.Errorf("got hangingChance=%+v, want percent mode, percent=50", mc.hangingChance)
		}
	})
	t.Run("canopy_decoration -- CLOSED: a well-formed object now parses and wires", func(t *testing.T) {
		body := mangroveTreeBody(map[string]any{
			"canopy_decoration": map[string]any{
				"decoration_block":  "minecraft:vine",
				"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(2)},
			},
		})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		mc := f.(*TreeFeature).canopy.(*mangroveCanopy)
		if mc.decoration == nil {
			t.Fatal("want mangroveCanopy.decoration non-nil")
		}
		if len(mc.decoration.entries) != 1 || mc.decoration.entries[0].blockID != pal.Get("minecraft:vine", nil) {
			t.Errorf("decoration.entries = %+v, want one vine entry", mc.decoration.entries)
		}
	})
	t.Run("canopy_decoration still refuses a malformed object (neither decoration_block nor decoration_blocks_sequence)", func(t *testing.T) {
		body := mangroveTreeBody(map[string]any{"canopy_decoration": map[string]any{}})
		_, err := buildTreeFeature(body, ctx)
		if err == nil {
			t.Fatal("want error, got nil")
		}
		if !strings.Contains(err.Error(), "canopy_decoration") {
			t.Errorf("error %q does not name canopy_decoration", err.Error())
		}
	})
}

// TestTreeFeature_MangroveCanopyKey_RNGDrawSequence pins the EXACT draw sequence for a whole
// TreeFeature.Place() call using the "mangrove_canopy" key: the trunk's lean-direction draw, then
// ONE attempt's own weighted-pick + 6-draw jitter (leaf_placement_attempts forced to 1 and the
// trunk forced to one log so there is exactly one candidate and one attempt -- no shuffle draw,
// since a single-element propagule list never enters the Fisher-Yates loop), then
// hanging_block_placement_chance's own roll (fraction 1/2, so it draws), then the trunk's trailing
// branch re-roll. canopy_height and
// canopy_radius are BOTH forced to {min:1,max:1} (max<=min -> 0 draws each, per geodeIntRange's own
// established contract) specifically so heightVal=radiusVal=1 is GUARANTEED rather than left to
// this seed's own draw -- a real (non-degenerate) range risks drawing 0, and random.Tracer
// deliberately does NOT record a NextIntBound(0) call (matches the game's bounded integer draw's
// "bound 0 draws nothing" contract -- see trace.go), which would make this test's own expected
// length seed-dependent. Pinning heightVal/radiusVal=1 removes that variable entirely.
//
// [REBASED ONTO acacia_trunk] This used to grow from the bare `trunk` key, which was
// wrongly dispatched to an acacia-shaped path. The bare key is the simple trunk, and
// the simple trunk hands the canopy an EMPTY candidates list -- so on the old body mangrove_canopy
// now draws NOTHING AT ALL and places NOTHING. That is correct vanilla behaviour (a bare `trunk` +
// `mangrove_canopy` really does grow a bare pole, in the game too; real mangroves use
// mangrove_trunk), but it leaves this test with no subject, and shrinking the expectation to zero
// would have quietly retired mangrove_canopy's only draw-order pin. Rebased onto a trunk that
// populates the vector -- see withAcaciaTrunkForCandidates.
func TestTreeFeature_MangroveCanopyKey_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	body := mangroveTreeBody(map[string]any{
		"leaf_placement_attempts": float64(1),
		"canopy_height":           map[string]any{"range_min": float64(1), "range_max": float64(1)},
		"canopy_radius":           map[string]any{"range_min": float64(1), "range_max": float64(1)},
	})
	body = withAcaciaTrunkForCandidates(body, 1)
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := built.(*TreeFeature)
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantSeq := []random.Method{
		random.MethodNextIntBound, // trunk lean direction
		// canopy_height and canopy_radius: 0 draws each (max<=min)
		random.MethodNextIntBound, // weighted leaf-block pick (1 leaf_blocks entry, nonzero weight)
		random.MethodNextIntBound, // dx1
		random.MethodNextIntBound, // dx2
		random.MethodNextIntBound, // dy1
		random.MethodNextIntBound, // dy2
		random.MethodNextIntBound, // dz1
		random.MethodNextIntBound, // dz2
		random.MethodNextIntBound, // hanging_block_placement_chance.roll (fraction 1/2)
		random.MethodNextIntBound, // trailing branch re-roll
	}
	if seq := drawSeqRandom(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v (len %d), want %v (len %d)", seq, len(seq), wantSeq, len(wantSeq))
	}
	if leaves := countBlocksOfID(v, 10, pal.Get("minecraft:mangrove_leaves", nil)); leaves == 0 {
		t.Fatal("mangrove_canopy placed no propagule leaves -- the sequence above must come from a canopy that ran")
	}
}

// --- mangroveCanopy: real geometry, ASCII cross-sections -----------------------------------------

// TestMangroveCanopy_Place_ScatterAndHangingRoots exercises the two properties no other canopy in
// this file has together: propagule scatter (candidates-vector wiring, like random_spread_canopy)
// PLUS the prop-root/hash-adjacency pass (unique to mangrove_canopy). Two candidates one cell apart
// both draw an all-zero jitter (radiusVal=heightVal=1, scripted zero -> offset (0,0,0) on every
// axis, landing each propagule exactly on its own candidate -- see randomSpreadCanopy's own
// identical "all-zero -> zero offset" precedent). The scripted Fisher-Yates shuffle (j=0) swaps the
// two propagules, so the hanging-root pass visits (1,12,0) FIRST: its root at (1,11,0) marks a 3x3
// footprint (mangroveFootprintRadius=1) that swallows (0,12,0)'s own would-be root at (0,11,0)
// entirely -- proving the hash-set dedup actually suppresses a SECOND root, not just that one root
// can be placed, and that the suppression happens BEFORE roll() is called (only 16 draws are
// scripted, not 17 -- see the exact count assertion below).
func TestMangroveCanopy_Place_ScatterAndHangingRoots(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:mangrove_leaves", nil)
	rootBlock := pal.Get("minecraft:mangrove_roots", nil)
	c := &mangroveCanopy{
		heightMin: 1, heightMax: 1, // max<=min -> 0 draws, heightVal=1
		radiusMin: 1, radiusMax: 1, // max<=min -> 0 draws, radiusVal=1
		attempts:      1,
		leafBlocks:    []randomSpreadWeightedBlock{{id: leaf, weight: 1}},
		hangingBlock:  rootBlock,
		hangingChance: chanceInformation{isFraction: true, numerator: 1, denominator: 2},
	}
	candidates := []wgen.BlockPos{
		{X: 0, Y: 12, Z: 0},
		{X: 1, Y: 12, Z: 0},
	}
	rnd := &spruceScriptedRandom{bounds: []int{
		0, 0, 0, 0, 0, 0, 0, // candidate (0,12,0): pick + all-zero jitter -> lands ON the candidate
		0, 0, 0, 0, 0, 0, 0, // candidate (1,12,0): same
		0, // Fisher-Yates shuffle: j=NextIntBound(2)=0 -> swap -> hanging pass visits (1,12,0) first
		0, // (1,12,0)'s own roll: fraction 1/2, draw=0 (0<1) -> true, root placed at (1,11,0)
		// (0,12,0)'s own below-cell (0,11,0) falls inside the 3x3 footprint just marked around
		// (1,11,0) -- occupied[...] short-circuits before roll() is ever called for it, so there is
		// NO 17th scripted draw here (see the exact-count assertion below).
	}}
	c.place(v, wgen.BlockPos{}, rnd, treeParamsLists{}, candidates)
	if rnd.idx != len(rnd.bounds) {
		t.Fatalf("consumed %d scripted draws, want exactly %d", rnd.idx, len(rnd.bounds))
	}

	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 12, Z: 0}); got != leaf {
		t.Errorf("expected leaf at (0,12,0), got %v", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 12, Z: 0}); got != leaf {
		t.Errorf("expected leaf at (1,12,0), got %v", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 11, Z: 0}); got != rootBlock {
		t.Errorf("expected hanging root at (1,11,0) (processed first after the shuffle), got %v", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 11, Z: 0}); got == rootBlock {
		t.Error("expected NO root at (0,11,0) -- its own below-cell falls inside (1,11,0)'s already-marked 3x3 footprint")
	}

	var art strings.Builder
	art.WriteString("y=12 (leaves, x=-1..2 across, z=-1..1 down):\n")
	for z := -1; z <= 1; z++ {
		for x := -1; x <= 2; x++ {
			if v.GetBlock(wgen.BlockPos{X: x, Y: 12, Z: z}) == leaf {
				art.WriteByte('#')
			} else {
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	art.WriteString("y=11 (hanging roots, x=-1..2 across, z=-1..1 down):\n")
	for z := -1; z <= 1; z++ {
		for x := -1; x <= 2; x++ {
			if v.GetBlock(wgen.BlockPos{X: x, Y: 11, Z: z}) == rootBlock {
				art.WriteByte('R')
			} else {
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("mangrove_canopy: two candidates (0,12,0)/(1,12,0), one propagule leaf each landing exactly "+
		"on its own candidate; the shuffle swaps hanging-pass order so (1,12,0) is processed FIRST -- its "+
		"root at (1,11,0) marks a 3x3 footprint that swallows (0,12,0)'s own would-be root at (0,11,0) "+
		"WITHOUT drawing a second roll():\n%s", art.String())
}

// TestMangroveCanopy_Place_GroundClearance_BlocksRootWhenObstructed proves the
// mangroveRootSearchDepth ground-clearance search actually gates placement: a solid block one cell
// below the propagule must suppress the hanging root even though the chance roll itself succeeds.
func TestMangroveCanopy_Place_GroundClearance_BlocksRootWhenObstructed(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:mangrove_leaves", nil)
	rootBlock := pal.Get("minecraft:mangrove_roots", nil)
	stone := pal.Get("minecraft:stone", nil)
	c := &mangroveCanopy{
		heightMin: 1, heightMax: 1,
		radiusMin: 1, radiusMax: 1,
		attempts:      1,
		leafBlocks:    []randomSpreadWeightedBlock{{id: leaf, weight: 1}},
		hangingBlock:  rootBlock,
		hangingChance: chanceInformation{isFraction: true, numerator: 1, denominator: 1}, // always true, NO draw
	}
	candidate := wgen.BlockPos{X: 0, Y: 12, Z: 0}
	v.SetBlock(wgen.BlockPos{X: 0, Y: 11, Z: 0}, stone) // directly below the propagule -- obstructs the clearance search

	rnd := &spruceScriptedRandom{bounds: []int{0, 0, 0, 0, 0, 0, 0}} // pick + all-zero jitter, no shuffle (1 propagule), no roll draw (numerator==denominator)
	c.place(v, wgen.BlockPos{}, rnd, treeParamsLists{}, []wgen.BlockPos{candidate})
	if rnd.idx != len(rnd.bounds) {
		t.Fatalf("consumed %d scripted draws, want exactly %d", rnd.idx, len(rnd.bounds))
	}

	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 12, Z: 0}); got != leaf {
		t.Errorf("expected leaf at (0,12,0), got %v", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 11, Z: 0}); got != stone {
		t.Errorf("expected the pre-placed stone to be left untouched (obstructs the clearance search), got %v", pal.Entry(got))
	}
}

// --- megaCanopy: schema validation (buildTreeFeature, "mega_canopy" key) ------------------------

func megaTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"leaf_block":    "minecraft:oak_leaves",
		"canopy_height": map[string]any{"range_min": float64(5), "range_max": float64(6)}, // min>=max-1 -> 0 draws, value=5
		"core_width":    float64(1),
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:oak_log",
			"trunk_height": float64(5),
		},
		"mega_canopy": canopy,
	}
}

func buildTestMegaTree(t *testing.T, pal *block.Palette, canopyExtra map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(megaTreeBody(canopyExtra), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf, ok := f.(*TreeFeature)
	if !ok {
		t.Fatalf("builder returned %T, want *TreeFeature", f)
	}
	return tf
}

func TestBuildTreeFeature_MegaCanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds, base_radius/simplify_canopy default", func(t *testing.T) {
		f, err := buildTreeFeature(megaTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		mc := f.(*TreeFeature).canopy.(*megaCanopy)
		if mc.canopyHeightMin != 5 || mc.canopyHeightMax != 6 {
			t.Errorf("got canopyHeightMin=%d canopyHeightMax=%d, want 5,6", mc.canopyHeightMin, mc.canopyHeightMax)
		}
		if mc.baseRadius != 2 {
			t.Errorf("baseRadius = %d, want 2 (vanilla default -- see tree.go header)", mc.baseRadius)
		}
		if mc.simplifyCanopy != false {
			t.Errorf("simplifyCanopy = %v, want false (vanilla default)", mc.simplifyCanopy)
		}
	})
	t.Run("leaf_block required", func(t *testing.T) {
		body := megaTreeBody(nil)
		delete(body["mega_canopy"].(map[string]any), "leaf_block")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_height required", func(t *testing.T) {
		body := megaTreeBody(nil)
		delete(body["mega_canopy"].(map[string]any), "canopy_height")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("core_width required", func(t *testing.T) {
		body := megaTreeBody(nil)
		delete(body["mega_canopy"].(map[string]any), "core_width")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("core_width must be 1", func(t *testing.T) {
		body := megaTreeBody(map[string]any{"core_width": float64(2)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("base_radius optional override", func(t *testing.T) {
		body := megaTreeBody(map[string]any{"base_radius": float64(4)})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if got := f.(*TreeFeature).canopy.(*megaCanopy).baseRadius; got != 4 {
			t.Errorf("baseRadius = %d, want 4", got)
		}
	})
	t.Run("base_radius must be >= 0", func(t *testing.T) {
		body := megaTreeBody(map[string]any{"base_radius": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("simplify_canopy optional override", func(t *testing.T) {
		body := megaTreeBody(map[string]any{"simplify_canopy": true})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if got := f.(*TreeFeature).canopy.(*megaCanopy).simplifyCanopy; got != true {
			t.Errorf("simplifyCanopy = %v, want true", got)
		}
	})
	t.Run("simplify_canopy must be a boolean", func(t *testing.T) {
		body := megaTreeBody(map[string]any{"simplify_canopy": "true"})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
}

// --- megaCanopy: RNG draw sequence ----------------------------------------------------------------

// TestTreeFeature_MegaCanopyKey_RNGDrawSequence pins the full sequence through a real
// TreeFeature.Place: the trunk draws nothing, so the whole sequence is mega_canopy's own SINGLE
// draw (canopy_height.getValue -- NextIntBound, via treeIntRangeValue). Uses a real seeded Tracer,
// and a canopy_height range wide enough to guarantee the draw actually fires (min=2,max=5 --
// min<max-1), proving mega_canopy draws exactly once and nothing else, not merely that it happened
// not to draw for one particular seed.//
// [UPDATED] The bare `trunk` key this body uses is the simple trunk, not
// the acacia one -- see tree.go's trunk-key table. The 3 lean draws and the trailing re-roll
// this test used to expect belonged to a class the key never binds, and a scalar trunk_height plus
// an absent height_modifier make the simple trunk itself draw nothing, so only the canopy's own
// draw remains. The canopy is still genuinely exercised: the draw below is its own.
func TestTreeFeature_MegaCanopyKey_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	tf := buildTestMegaTree(t, pal, map[string]any{"canopy_height": map[string]any{"range_min": float64(2), "range_max": float64(5)}})
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantSeq := []random.Method{
		random.MethodNextIntBound, // mega_canopy's own single canopy_height.getValue draw
	}
	if seq := drawSeqRandom(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v (len %d), want %v (len %d)", seq, len(seq), wantSeq, len(wantSeq))
	}
}

// TestMegaCanopy_Place_ZeroValue_DrawsOnceAndPlacesNothing pins the value==0 special case
// (vanilla places nothing when the value is zero) directly against megaCanopy.place -- a legal, empty
// tree, not an error, distinguishing this shape from mega_pine_canopy's own different value==-1
// empty case (see that canopy's own tests).
func TestMegaCanopy_Place_ZeroValue_DrawsOnceAndPlacesNothing(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &megaCanopy{leafID: leaf, canopyHeightMin: 0, canopyHeightMax: 1, baseRadius: 2, pal: pal} // min>=max-1 -> 0 draws, value=0
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	rnd := &spruceScriptedRandom{bounds: []int{}}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)
	if rnd.idx != 0 {
		t.Fatalf("consumed %d draws, want 0 (min>=max-1 -> treeIntRangeValue draws nothing)", rnd.idx)
	}
	for dx := -3; dx <= 3; dx++ {
		for dz := -3; dz <= 3; dz++ {
			for dy := -3; dy <= 3; dy++ {
				if v.GetBlock(wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}) == leaf {
					t.Fatalf("leaf placed at (%d,%d,%d) with value=0, want nothing placed", dx, dy, dz)
				}
			}
		}
	}
}

// TestMegaCanopy_Place_NegativeValue_Panics pins the malformed-range runtime refusal
// (the game asserts 1-Value>=2) -- only reachable when canopy_height's own min
// draws negative, so it is a runtime panic (spruce_canopy's own established "malformed range,
// unsupported" precedent), not a build-time rejection.
func TestMegaCanopy_Place_NegativeValue_Panics(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &megaCanopy{leafID: leaf, canopyHeightMin: -3, canopyHeightMax: -2, baseRadius: 2, pal: pal} // min>=max-1 -> 0 draws, value=-3
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("want panic (malformed range), got none")
		}
	}()
	c.place(v, anchor, &spruceScriptedRandom{bounds: []int{}}, treeParamsLists{}, nil)
}

// --- placeRadialBlockGroup: shared geometry --------------------------------------------------------

// TestPlaceRadialBlockGroup_RelaxedVsStrictCornerCounts pins the exact cell counts a throwaway
// enumeration program (this project's own established cross-check technique) already confirmed for
// radius=2: the relaxed (simplify_canopy=false) 4-corner-footprint test keeps 20 cells, strictly more
// than the plain circle test's (simplify_canopy=true) 13 -- proving simplify_canopy's own name (true
// selects the SIMPLER, smaller, strictly-circular test) actually holds in the shipped geometry, not
// just in the module header's prose.
func TestPlaceRadialBlockGroup_RelaxedVsStrictCornerCounts(t *testing.T) {
	center := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	count := func(strict bool) int {
		v, pal := newTreeTestVolume(t, 6)
		leaf := pal.Get("minecraft:oak_leaves", nil)
		if err := placeRadialBlockGroup(v, pal, center, leaf, 2, 1, strict, block.MatchSet{}); err != nil {
			t.Fatalf("placeRadialBlockGroup: %v", err)
		}
		n := 0
		for dx := -3; dx <= 3; dx++ {
			for dz := -3; dz <= 3; dz++ {
				if v.GetBlock(wgen.BlockPos{X: center.X + dx, Y: center.Y, Z: center.Z + dz}) == leaf {
					n++
				}
			}
		}
		return n
	}
	if got := count(false); got != 20 {
		t.Errorf("relaxed (simplify_canopy=false) radius=2 placed %d cells, want 20", got)
	}
	if got := count(true); got != 13 {
		t.Errorf("strict (simplify_canopy=true) radius=2 placed %d cells, want 13", got)
	}
}

// TestPlaceRadialBlockGroup_RoundingTestDoesNotScaleWithCoreWidth pins a correction. This
// helper's outer loop IS core-width-parameterised (x runs [-r, sizeX+r)),
// but its rounding test is NOT: the game tests exactly two
// centres per axis, at offsets {0,1}, subtracting a constant 1
// rather than a (size-1). This port used to run the offsets through a core-width-dependent
// distance transform first, which generalised the test to `core_width` centres and kept cells
// the game cuts.
//
// The consequence is visible as a count that STOPS GROWING. Widening the core rectangle widens
// the scanned box, so at core_width 2 four more cells fall inside the fixed 2x2 stadium; past
// that the box keeps growing and the accepted region does not, so core_width 3 and 4 keep
// exactly what core_width 2 keeps. Under the old, generalised test the count kept climbing
// (31, 44, 59 relaxed). The strict (simplify_canopy=true) test is a plain circle about the
// origin and is core-width-invariant outright.
//
// core_width 1 is unchanged in every cell.
func TestPlaceRadialBlockGroup_RoundingTestDoesNotScaleWithCoreWidth(t *testing.T) {
	center := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	count := func(coreWidth int, strict bool) int {
		v, pal := newTreeTestVolume(t, 12)
		leaf := pal.Get("minecraft:oak_leaves", nil)
		if err := placeRadialBlockGroup(v, pal, center, leaf, 2, coreWidth, strict, block.MatchSet{}); err != nil {
			t.Fatalf("placeRadialBlockGroup: %v", err)
		}
		n := 0
		for dx := -8; dx <= 8; dx++ {
			for dz := -8; dz <= 8; dz++ {
				if v.GetBlock(wgen.BlockPos{X: center.X + dx, Y: center.Y, Z: center.Z + dz}) == leaf {
					n++
				}
			}
		}
		return n
	}
	for _, tc := range []struct {
		coreWidth   int
		strict      bool
		want        int
		wantIfWrong int // what the old, core-width-generalised test kept
	}{
		{1, false, 20, 20},
		{2, false, 24, 31},
		{3, false, 24, 44},
		{4, false, 24, 59},
		{1, true, 13, 13},
		{2, true, 13, 24},
		{3, true, 13, 37},
		{4, true, 13, 52},
	} {
		got := count(tc.coreWidth, tc.strict)
		if got != tc.want {
			extra := ""
			if got == tc.wantIfWrong {
				extra = " -- that is exactly the count a core-width-generalised rounding test keeps; the game uses two centres per axis, not core_width of them"
			}
			t.Errorf("core_width=%d strict=%v: placed %d cells, want %d%s", tc.coreWidth, tc.strict, got, tc.want, extra)
		}
	}
}

// TestPlaceRadialBlockGroup_NegativeRadius_Errors pins the malformed-range guard directly.
func TestPlaceRadialBlockGroup_NegativeRadius_Errors(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	err := placeRadialBlockGroup(v, pal, wgen.BlockPos{X: 0, Y: 15, Z: 0}, leaf, -1, 1, false, block.MatchSet{})
	if err == nil {
		t.Fatal("want error for radius=-1, got nil")
	}
}

// TestMegaCanopy_Place_ConeCrossSections places directly with value=5 (canopy_height={5,6}, 0
// draws), baseRadius=2: five layers dy=-4..0 with radius 6,5,4,3,2 -- widest at the bottom, narrowing
// by exactly 1 per layer to the smallest at the anchor's own layer (dy=0) -- see megaCanopy and the module header
// for the -dy+baseRadius+halfCoreWidth(0) formula this pins.
func TestMegaCanopy_Place_ConeCrossSections(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	leaf := pal.Get("minecraft:oak_leaves", nil)
	c := &megaCanopy{leafID: leaf, canopyHeightMin: 5, canopyHeightMax: 6, baseRadius: 2, pal: pal}
	anchor := wgen.BlockPos{X: 0, Y: 20, Z: 0}

	rnd := &spruceScriptedRandom{bounds: []int{}}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)
	if rnd.idx != 0 {
		t.Fatalf("consumed %d draws, want 0", rnd.idx)
	}

	wantRadius := map[int]int{-4: 6, -3: 5, -2: 4, -1: 3, 0: 2}
	for dy, r := range wantRadius {
		// The exact corner of the (relaxed) bounding diamond at (r,0) must be placed (basic test:
		// r^2+0^2<=r^2), and (r+1,0) must NOT be (even the most relaxed shifted test needs
		// (r+1-1)^2==r^2<=r^2, true -- so use a cell truly outside every shifted test instead:
		// (r+1,r+1), whose closest corner (r,r) is r*sqrt2 away, always > r for r>=1).
		if got := v.GetBlock(wgen.BlockPos{X: anchor.X + r, Y: anchor.Y + dy, Z: anchor.Z}); got != leaf {
			t.Errorf("dy=%d: cell (%d,0) not placed, want leaf (radius=%d)", dy, r, r)
		}
		if got := v.GetBlock(wgen.BlockPos{X: anchor.X + r + 1, Y: anchor.Y + dy, Z: anchor.Z + r + 1}); got == leaf {
			t.Errorf("dy=%d: cell (%d,%d) placed, want nothing (well outside radius=%d)", dy, r+1, r+1, r)
		}
	}
	// dy=+1 (one above the anchor's own top layer) must be untouched entirely.
	for dx := -3; dx <= 3; dx++ {
		for dz := -3; dz <= 3; dz++ {
			if v.GetBlock(wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + 1, Z: anchor.Z + dz}) == leaf {
				t.Fatalf("leaf placed above the topmost layer at (%d,+1,%d)", dx, dz)
			}
		}
	}

	var art strings.Builder
	for _, dy := range []int{0, -1, -2, -3, -4} {
		art.WriteString(fmt.Sprintf("dy=%+d (radius=%d):\n", dy, wantRadius[dy]))
		for dz := -6; dz <= 6; dz++ {
			for dx := -6; dx <= 6; dx++ {
				if v.GetBlock(wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}) == leaf {
					art.WriteByte('#')
				} else {
					art.WriteByte('.')
				}
			}
			art.WriteByte('\n')
		}
	}
	t.Logf("mega_canopy cone: canopy_height value=5, base_radius=2, core_width=1, simplify_canopy=false -- "+
		"top (dy=0) to bottom (dy=-4):\n%s", art.String())
}

// --- megaPineRadiusFor: the radius_step_modifier formula --------------------------------------

// TestMegaPineRadiusFor_ToplayerIsExactlyBaseRadius pins the dy==0 special case (see
// megaPineRadiusFor's own doc comment): regardless of value/radiusStepModifier/prevPreBump, the
// topmost layer's radius must be exactly baseRadius, with no bump.
func TestMegaPineRadiusFor_TopLayerIsExactlyBaseRadius(t *testing.T) {
	for _, value := range []int{0, 1, 5, 8} {
		for _, prevPreBump := range []int{-5, 0, 2, 99} {
			radius, preBump := megaPineRadiusFor(0, value, 2, 3.5, prevPreBump, 100)
			if radius != 2 || preBump != 2 {
				t.Errorf("value=%d prevPreBump=%d: megaPineRadiusFor(dy=0) = (%d,%d), want (2,2)", value, prevPreBump, radius, preBump)
			}
		}
	}
}

// TestMegaPineRadiusFor_SteppedTaper pins the exact per-layer radius sequence for value=8,
// baseRadius=2, radiusStepModifier=3.5, anchor.Y=100 (even) -- confirmed via a throwaway Go
// enumeration program before being pinned here (this project's own established cross-check
// technique): a stepped taper (5,5,4,4,3,3,2,2,2) with NO bumps firing, because every
// preBump==prevPreBump pair in this specific sequence happens to land on an ODD world Y.
func TestMegaPineRadiusFor_SteppedTaper(t *testing.T) {
	value := 8
	baseRadius := 2
	rsm := float32(3.5)
	anchorY := 100
	wantRadius := map[int]int{-8: 5, -7: 5, -6: 4, -5: 4, -4: 3, -3: 3, -2: 2, -1: 2, 0: 2}
	prevPreBump := 0
	for dy := -value; dy <= 0; dy++ {
		radius, preBump := megaPineRadiusFor(dy, value, baseRadius, rsm, prevPreBump, anchorY+dy)
		if want := wantRadius[dy]; radius != want {
			t.Errorf("dy=%d: radius = %d, want %d", dy, radius, want)
		}
		prevPreBump = preBump
	}
}

// TestMegaPineRadiusFor_EvenYBumpsAPlateau proves the "bump" mechanic actually fires: the SAME
// value/baseRadius/radiusStepModifier as the stepped-taper test above, shifted by anchorY=101 (odd)
// so every preBump==prevPreBump plateau now lands on an EVEN world Y, must bump every one of them
// by +1 -- confirmed via the same throwaway enumeration program (5,6,4,5,3,4,2,3,2), and proving the
// mechanic is not vacuously always-0 the way the taper test alone would leave ambiguous.
func TestMegaPineRadiusFor_EvenYBumpsAPlateau(t *testing.T) {
	value := 8
	baseRadius := 2
	rsm := float32(3.5)
	anchorY := 101
	wantRadius := map[int]int{-8: 5, -7: 6, -6: 4, -5: 5, -4: 3, -3: 4, -2: 2, -1: 3, 0: 2}
	prevPreBump := 0
	for dy := -value; dy <= 0; dy++ {
		radius, preBump := megaPineRadiusFor(dy, value, baseRadius, rsm, prevPreBump, anchorY+dy)
		if want := wantRadius[dy]; radius != want {
			t.Errorf("dy=%d: radius = %d, want %d", dy, radius, want)
		}
		prevPreBump = preBump
	}
}

// --- megaPineCanopy: schema validation (buildTreeFeature, "mega_pine_canopy" key) ---------------

func megaPineTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"leaf_block":    "minecraft:spruce_leaves",
		"canopy_height": map[string]any{"range_min": float64(8), "range_max": float64(9)}, // min>=max-1 -> 0 draws, value=8
		"core_width":    float64(1),
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk": map[string]any{
			"trunk_block":  "minecraft:spruce_log",
			"trunk_height": float64(5),
		},
		"mega_pine_canopy": canopy,
	}
}

func buildTestMegaPineTree(t *testing.T, pal *block.Palette, canopyExtra map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(megaPineTreeBody(canopyExtra), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf, ok := f.(*TreeFeature)
	if !ok {
		t.Fatalf("builder returned %T, want *TreeFeature", f)
	}
	return tf
}

func TestBuildTreeFeature_MegaPineCanopyKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds, base_radius/radius_step_modifier default", func(t *testing.T) {
		f, err := buildTreeFeature(megaPineTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		mc := f.(*TreeFeature).canopy.(*megaPineCanopy)
		if mc.canopyHeightMin != 8 || mc.canopyHeightMax != 9 {
			t.Errorf("got canopyHeightMin=%d canopyHeightMax=%d, want 8,9", mc.canopyHeightMin, mc.canopyHeightMax)
		}
		if mc.baseRadius != 2 {
			t.Errorf("baseRadius = %d, want 2 (vanilla default)", mc.baseRadius)
		}
		if mc.radiusStepModifier != 3.5 {
			t.Errorf("radiusStepModifier = %v, want 3.5 (vanilla default)", mc.radiusStepModifier)
		}
	})
	t.Run("leaf_block required", func(t *testing.T) {
		body := megaPineTreeBody(nil)
		delete(body["mega_pine_canopy"].(map[string]any), "leaf_block")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("canopy_height required", func(t *testing.T) {
		body := megaPineTreeBody(nil)
		delete(body["mega_pine_canopy"].(map[string]any), "canopy_height")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("core_width required", func(t *testing.T) {
		body := megaPineTreeBody(nil)
		delete(body["mega_pine_canopy"].(map[string]any), "core_width")
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("core_width must be 1", func(t *testing.T) {
		body := megaPineTreeBody(map[string]any{"core_width": float64(2)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("base_radius optional override", func(t *testing.T) {
		body := megaPineTreeBody(map[string]any{"base_radius": float64(4)})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if got := f.(*TreeFeature).canopy.(*megaPineCanopy).baseRadius; got != 4 {
			t.Errorf("baseRadius = %d, want 4", got)
		}
	})
	t.Run("base_radius must be >= 0", func(t *testing.T) {
		body := megaPineTreeBody(map[string]any{"base_radius": float64(-1)})
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("radius_step_modifier optional override", func(t *testing.T) {
		body := megaPineTreeBody(map[string]any{"radius_step_modifier": float64(1.5)})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if got := f.(*TreeFeature).canopy.(*megaPineCanopy).radiusStepModifier; got != 1.5 {
			t.Errorf("radiusStepModifier = %v, want 1.5", got)
		}
	})
	t.Run("no simplify_canopy field -- the mega pine canopy has none", func(t *testing.T) {
		body := megaPineTreeBody(map[string]any{"simplify_canopy": true})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success (unknown extra keys are ignored, not refused), got %v", err)
		}
		// megaPineCanopy has no such field at all -- confirmed by the struct having none; this
		// sub-test only proves the extra key doesn't break parsing, matching the bare-"roots"-key
		// precedent above.
		if _, ok := f.(*TreeFeature).canopy.(*megaPineCanopy); !ok {
			t.Fatalf("canopy is %T, want *megaPineCanopy", f.(*TreeFeature).canopy)
		}
	})
}

// --- megaPineCanopy: RNG draw sequence ------------------------------------------------------------

// TestTreeFeature_MegaPineCanopyKey_RNGDrawSequence pins the full sequence through a real
// TreeFeature.Place: the trunk draws nothing, so the whole sequence is mega_pine_canopy's own
// SINGLE draw (canopy_height.getValue) -- the SAME shape as mega_canopy's own sequence (see that
// canopy's own RNG draw sequence test), proving mega_pine_canopy's own radius_step_modifier
// formula (megaPineRadiusFor) draws no RNG of its own.
//
// The bare `trunk` key this body uses is the simple trunk, not the acacia one (see tree.go's
// trunk-key table), and a scalar trunk_height plus an absent height_modifier make the simple trunk
// itself draw nothing, so only the canopy's own draw remains.
func TestTreeFeature_MegaPineCanopyKey_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	tf := buildTestMegaPineTree(t, pal, map[string]any{"canopy_height": map[string]any{"range_min": float64(3), "range_max": float64(8)}})
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	tr := random.NewTracer(random.New(1))
	got := placeTestTree(tf, v, origin, tr)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantSeq := []random.Method{
		random.MethodNextIntBound, // mega_pine_canopy's own single canopy_height.getValue draw
	}
	if seq := drawSeqRandom(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v (len %d), want %v (len %d)", seq, len(seq), wantSeq, len(wantSeq))
	}
}

// TestMegaPineCanopy_Place_NegativeOneValue_DrawsOnceAndPlacesNothing pins the value==-1 empty case
// directly -- DIFFERENT from megaCanopy's own value==0 empty case (see that
// canopy's own test), the one genuinely new edge this shape has.
func TestMegaPineCanopy_Place_NegativeOneValue_DrawsOnceAndPlacesNothing(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:spruce_leaves", nil)
	c := &megaPineCanopy{leafID: leaf, canopyHeightMin: -1, canopyHeightMax: 0, baseRadius: 2, radiusStepModifier: 3.5, pal: pal} // min>=max-1 -> 0 draws, value=-1
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	rnd := &spruceScriptedRandom{bounds: []int{}}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)
	if rnd.idx != 0 {
		t.Fatalf("consumed %d draws, want 0", rnd.idx)
	}
	for dx := -3; dx <= 3; dx++ {
		for dz := -3; dz <= 3; dz++ {
			for dy := -3; dy <= 3; dy++ {
				if v.GetBlock(wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}) == leaf {
					t.Fatalf("leaf placed at (%d,%d,%d) with value=-1, want nothing placed", dx, dy, dz)
				}
			}
		}
	}
}

// TestMegaPineCanopy_Place_ZeroValue_PlacesExactlyOneLayer pins the value==0 case -- UNLIKE
// megaCanopy's own value==0 (empty), mega_pine_canopy still places exactly ONE layer (dy=0,
// radius=baseRadius) -- see megaPineRadiusFor's own doc comment for why this is exact, not a guess
// about IEEE NaN-to-int behavior.
func TestMegaPineCanopy_Place_ZeroValue_PlacesExactlyOneLayer(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:spruce_leaves", nil)
	c := &megaPineCanopy{leafID: leaf, canopyHeightMin: 0, canopyHeightMax: 1, baseRadius: 2, radiusStepModifier: 3.5, pal: pal} // min>=max-1 -> 0 draws, value=0
	anchor := wgen.BlockPos{X: 0, Y: 15, Z: 0}

	rnd := &spruceScriptedRandom{bounds: []int{}}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)

	if got := v.GetBlock(wgen.BlockPos{X: anchor.X + 2, Y: anchor.Y, Z: anchor.Z}); got != leaf {
		t.Error("edge of the radius=2 dy=0 layer not placed")
	}
	// No other Y layer should have anything.
	for dy := -3; dy <= 3; dy++ {
		if dy == 0 {
			continue
		}
		for dx := -3; dx <= 3; dx++ {
			for dz := -3; dz <= 3; dz++ {
				if v.GetBlock(wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}) == leaf {
					t.Fatalf("leaf placed at dy=%d, want only dy=0", dy)
				}
			}
		}
	}
}

// TestMegaPineCanopy_Place_SteppedTaperCrossSections places directly with value=8
// (canopy_height={8,9}, 0 draws), baseRadius=2, radiusStepModifier=3.5, anchor.Y=100 (even, so no
// bumps fire -- see TestMegaPineRadiusFor_SteppedTaper above): nine layers dy=-8..0 with radius
// 5,5,4,4,3,3,2,2,2 -- a genuinely different silhouette from mega_canopy's own smooth per-layer
// taper (a STEPPED one, holding each radius for 2 layers before narrowing), matching real Minecraft
// mega-spruce/dark-oak canopies.
func TestMegaPineCanopy_Place_SteppedTaperCrossSections(t *testing.T) {
	v, pal := newTreeTestVolume(t, 8)
	leaf := pal.Get("minecraft:spruce_leaves", nil)
	c := &megaPineCanopy{leafID: leaf, canopyHeightMin: 8, canopyHeightMax: 9, baseRadius: 2, radiusStepModifier: 3.5, pal: pal}
	anchor := wgen.BlockPos{X: 0, Y: 20, Z: 0} // even Y -- no bumps fire, see TestMegaPineRadiusFor_SteppedTaper

	rnd := &spruceScriptedRandom{bounds: []int{}}
	c.place(v, anchor, rnd, treeParamsLists{}, nil)
	if rnd.idx != 0 {
		t.Fatalf("consumed %d draws, want 0", rnd.idx)
	}

	wantRadius := map[int]int{-8: 5, -7: 5, -6: 4, -5: 4, -4: 3, -3: 3, -2: 2, -1: 2, 0: 2}
	for dy, r := range wantRadius {
		if got := v.GetBlock(wgen.BlockPos{X: anchor.X + r, Y: anchor.Y + dy, Z: anchor.Z}); got != leaf {
			t.Errorf("dy=%d: cell (%d,0) not placed, want leaf (radius=%d)", dy, r, r)
		}
		if got := v.GetBlock(wgen.BlockPos{X: anchor.X + r + 1, Y: anchor.Y + dy, Z: anchor.Z + r + 1}); got == leaf {
			t.Errorf("dy=%d: cell (%d,%d) placed, want nothing (well outside radius=%d)", dy, r+1, r+1, r)
		}
	}

	var art strings.Builder
	for _, dy := range []int{0, -2, -4, -6, -8} {
		art.WriteString(fmt.Sprintf("dy=%+d (radius=%d):\n", dy, wantRadius[dy]))
		for dz := -6; dz <= 6; dz++ {
			for dx := -6; dx <= 6; dx++ {
				if v.GetBlock(wgen.BlockPos{X: anchor.X + dx, Y: anchor.Y + dy, Z: anchor.Z + dz}) == leaf {
					art.WriteByte('#')
				} else {
					art.WriteByte('.')
				}
			}
			art.WriteByte('\n')
		}
	}
	t.Logf("mega_pine_canopy stepped taper: canopy_height value=8, base_radius=2, "+
		"radius_step_modifier=3.5, core_width=1, anchor.Y even (no bumps) -- top (dy=0) to bottom (dy=-8), every other layer shown:\n%s", art.String())
}

// --- simpleTrunk (can_be_submerged): RNG draw sequence + cross-section --------------------------

// submergedTreeBody builds a valid can_be_submerged trunk body (object form, using an int-range
// trunk_height and height_modifier so both of placeSubmergedTrunk's own draws are non-degenerate --
// see TestSimpleTrunk_PlaceSubmerged_RNGDrawSequence) paired with the zero-RNG "canopy"
// (the simple canopy) shape, so any draw beyond the two the trunk itself makes is a real bug, not
// noise from the canopy.
func submergedTreeBody(trunkExtra map[string]any) map[string]any {
	trunk := map[string]any{
		"trunk_block":      "minecraft:oak_log",
		"trunk_height":     []any{float64(5), float64(8)},
		"height_modifier":  []any{float64(0), float64(2)},
		"can_be_submerged": map[string]any{"max_depth": float64(255)},
	}
	for k, v := range trunkExtra {
		trunk[k] = v
	}
	return map[string]any{
		"trunk": trunk,
		"canopy": map[string]any{
			"leaf_block":    "minecraft:oak_leaves",
			"canopy_offset": map[string]any{"min": float64(-2), "max": float64(0)},
			"min_width":     float64(1),
		},
		"may_replace":      []any{"minecraft:air"},
		"may_grow_through": []any{"minecraft:water"},
	}
}

// TestSimpleTrunk_PlaceSubmerged_RNGDrawSequence pins placeSubmergedTrunk's own draw sequence: with
// a non-degenerate trunk_height=[5,8] and height_modifier=[0,2], exactly two NextIntBound draws
// happen (the simple trunk's own height draw over trunk_height, then
// height_modifier's own int-range draw) and NOTHING else -- the can_be_submerged
// descent itself is ZERO-RNG (see placeSubmergedTrunk's doc comment), and
// the paired "canopy" (the simple canopy) shape is independently proven zero-RNG elsewhere in this
// file, so any extra draw here is a real bug in placeSubmergedTrunk, not canopy noise.
func TestSimpleTrunk_PlaceSubmerged_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(submergedTreeBody(nil), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := f.(*TreeFeature)

	tracer := random.NewTracer(random.New(1))
	if got := placeTestTree(tf, v, wgen.BlockPos{X: 0, Y: 20, Z: 0}, tracer); got == nil {
		t.Fatal("Place returned nil, want success")
	}

	want := []random.Method{random.MethodNextIntBound, random.MethodNextIntBound}
	if got := drawSeqRandom(tracer); !equalMethods(got, want) {
		t.Fatalf("draw sequence = %v, want %v (trunk_height.getValue, height_modifier.getValue, nothing else)", got, want)
	}
}

func equalMethods(a, b []random.Method) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestSimpleTrunk_PlaceSubmerged_DescendsThroughWaterAndRisesFromFloor is the cross-section proof of
// can_be_submerged's own descent (see placeSubmergedTrunk's doc comment):
// a water column sits on a dirt floor, origin is placed at the water's own
// surface (air directly above, water directly below), and max_depth is large enough that the ONLY
// thing that stops the descent is hitting the dirt floor -- proving the relocation is real ground-
// seeking, not a fixed offset. trunk_height/height_modifier are pinned to plain numbers here (0
// draws each) so the exact log column is fully deterministic regardless of seed.
func TestSimpleTrunk_PlaceSubmerged_DescendsThroughWaterAndRisesFromFloor(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	water := pal.Get("minecraft:water", nil)
	bounds := volume.Bounds{MinX: -4, MinY: 0, MinZ: -4, SizeX: 9, SizeY: 30, SizeZ: 9}
	v := volume.New(bounds, pal, air)
	// Dirt floor at Y=5, water Y=6..13 (8 cells), air Y=14+. Origin sits at Y=14 -- the water's own
	// surface (probe at origin.Y-1=13 is the topmost water cell).
	const floorY, waterTop, originY = 5, 13, 14
	for x := -4; x <= 4; x++ {
		for z := -4; z <= 4; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, dirt)
			for y := floorY + 1; y <= waterTop; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, water)
			}
		}
	}

	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	body := submergedTreeBody(map[string]any{
		"trunk_height":     float64(10),
		"height_modifier":  []any{float64(0), float64(0)},
		"can_be_submerged": map[string]any{"max_depth": float64(255)}, // effectively unlimited -- floor stops it
	})
	body["may_grow_through"] = []any{"minecraft:water"}
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := f.(*TreeFeature)

	origin := wgen.BlockPos{X: 0, Y: originY, Z: 0}
	if got := placeTestTree(tf, v, origin, random.New(1)); got == nil {
		t.Fatal("Place returned nil, want success")
	}

	logID := pal.Get("minecraft:oak_log", nil)
	leafID := pal.Get("minecraft:oak_leaves", nil)

	// The trunk must rise from the FLOOR (Y=6, one above the dirt at Y=5), not from the origin --
	// this is the entire point of can_be_submerged. trunk_height=10 -> logs at Y=6..15.
	for y := floorY + 1; y <= floorY+10; y++ {
		pos := wgen.BlockPos{X: 0, Y: y, Z: 0}
		if got := v.GetBlock(pos); got != logID {
			t.Errorf("Y=%d: block = %v, want oak_log (trunk column must span the floor up through the water)", y, pal.Entry(got))
		}
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: floorY, Z: 0}); got != dirt {
		t.Errorf("Y=%d (floor): block = %v, want dirt (untouched -- the descent COMMITS the deepest PASSING cell, "+
			"never the floor itself)", floorY, pal.Entry(got))
	}

	// Vertical (X/Y) cross-section through the trunk column, floor to canopy.
	var art strings.Builder
	for y := floorY + 12; y >= floorY-1; y-- {
		marker := byte(' ')
		switch y {
		case originY:
			marker = 'o'
		case floorY:
			marker = 'f'
		}
		art.WriteByte(marker)
		art.WriteByte(' ')
		for x := -3; x <= 3; x++ {
			pos := wgen.BlockPos{X: x, Y: y, Z: 0}
			switch v.GetBlock(pos) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			case water:
				art.WriteByte('~')
			case dirt:
				art.WriteByte('D')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("can_be_submerged: water column Y=%d..%d on a dirt floor at Y=%d, origin.Y=%d (water surface), "+
		"max_depth=255 (floor-limited, not budget-limited) -- vertical (X/Y) cross-section, top to bottom "+
		"(L=log, #=leaves, ~=water, D=dirt, .=air, 'o'=origin.Y, 'f'=floor):\n%s",
		floorY+1, waterTop, floorY, originY, art.String())
}

// TestSimpleTrunk_PlaceSubmerged_BaseBlockGroundFixup proves the top-level "base_block" key is
// actually consumed by placeSubmergedTrunk's own post-canopy ground fixup, not just
// resolved-but-unused: it fires at (origin.X, relPos.Y-1, origin.Z) -- relPos being the
// can_be_submerged-relocated position the log column actually rose from, NOT the original pre-descent
// origin -- and draws ZERO extra RNG (see placeSubmergedTrunk's own doc comment). Removing the
// `if !f.baseBlock.Empty()` fixup (or changing its position) makes this test fail.
func TestSimpleTrunk_PlaceSubmerged_BaseBlockGroundFixup(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	stone := pal.Get("minecraft:stone", nil)
	water := pal.Get("minecraft:water", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	bounds := volume.Bounds{MinX: -4, MinY: 0, MinZ: -4, SizeX: 9, SizeY: 30, SizeZ: 9}
	v := volume.New(bounds, pal, air)
	const floorY, waterTop, originY = 5, 13, 14
	for x := -4; x <= 4; x++ {
		for z := -4; z <= 4; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, stone) // NOT base_block's own dirt
			for y := floorY + 1; y <= waterTop; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, water)
			}
		}
	}

	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	body := submergedTreeBody(map[string]any{
		"trunk_height":     float64(10),
		"height_modifier":  []any{float64(0), float64(0)},
		"can_be_submerged": map[string]any{"max_depth": float64(255)},
	})
	body["may_grow_through"] = []any{"minecraft:water"}
	body["base_block"] = []any{"minecraft:dirt"}
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := f.(*TreeFeature)

	origin := wgen.BlockPos{X: 0, Y: originY, Z: 0}
	tr := random.NewTracer(random.New(1))
	if got := placeTestTree(tf, v, origin, tr); got == nil {
		t.Fatal("Place returned nil, want success")
	}

	// relPos is the floor+1 cell (Y=6) the trunk column rose from -- base_block's own fixup targets
	// ONE BELOW that (Y=5, the floor itself), not one below the original origin (Y=13).
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: floorY, Z: 0}); got != dirt {
		t.Errorf("floor cell (Y=%d) = %v, want base_block's dirt (relPos.Y-1 fixup)", floorY, pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: originY - 1, Z: 0}); got == dirt {
		t.Errorf("Y=%d (one below the ORIGINAL origin) = dirt, want untouched water -- base_block must "+
			"target the RELOCATED position, not the pre-descent origin", originY-1)
	}

	// Zero-RNG: base_block's own fixup (passesAllowList + a conditional SetBlock) draws
	// nothing (see placeSubmergedTrunk's doc comment) -- every draw in
	// this trace belongs to getTreeHeight/height_modifier/canopy, none to the fixup itself.
	for _, d := range tr.Draws {
		if d.Method != random.MethodNextIntBound {
			t.Fatalf("unexpected draw method %v -- base_block's own fixup should never reach this stub for a non-NextIntBound method", d.Method)
		}
	}
}

// --- mangrove_roots (the mangrove root placement) -------------------------------------------------

// mangroveScriptedRandom is a scripted random.IRandom for mangrovePotentialRootPositions's own two
// draw sites (NextFloat, NextBoolean) -- mirrors spruceScriptedRandom's own pattern (panics on any
// unscripted method, so an extra/missing draw fails loudly rather than silently reading a zero
// value).
type mangroveScriptedRandom struct {
	floats     []float64
	bools      []bool
	intBounds  []int // NextIntBound's own return values, in call order
	fi, bi, ii int
}

func (s *mangroveScriptedRandom) NextFloat() float64 {
	v := s.floats[s.fi]
	s.fi++
	return v
}
func (s *mangroveScriptedRandom) NextBoolean() bool {
	v := s.bools[s.bi]
	s.bi++
	return v
}
func (s *mangroveScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (s *mangroveScriptedRandom) NextIntBound(int) int {
	v := s.intBounds[s.ii]
	s.ii++
	return v
}
func (s *mangroveScriptedRandom) NextInt() int32      { panic("unused") }
func (s *mangroveScriptedRandom) NextDouble() float64 { panic("unused") }
func (s *mangroveScriptedRandom) SetSeed(uint32)      {}
func (s *mangroveScriptedRandom) GetSeed() uint32     { return 0 }

var _ random.IRandom = (*mangroveScriptedRandom)(nil)

// TestMangrovePotentialRootPositions_DistanceBands pins all three distance bands of
// the mangrove candidate-root-position walk directly (bypassing the recursive search),
// including the exact draw counts each band takes -- see mangrovePotentialRootPositions's own doc
// comment. origPos is fixed at the origin; dir is East (+X).
func TestMangrovePotentialRootPositions_DistanceBands(t *testing.T) {
	origin := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	east := wgen.BlockPos{X: 1, Y: 0, Z: 0}
	down := wgen.BlockPos{X: 0, Y: -1, Z: 0}
	fwd := wgen.BlockPos{X: 1, Y: 0, Z: 0}

	t.Run("too far: single down candidate, ZERO draws", func(t *testing.T) {
		curPos := wgen.BlockPos{X: 10, Y: 0, Z: 0} // dist=10
		rnd := &mangroveScriptedRandom{}           // any draw panics
		got := mangrovePotentialRootPositions(5, curPos, origin, east, rnd)
		want := []wgen.BlockPos{{X: 10, Y: -1, Z: 0}}
		if !equalBlockPosSeq(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("safe zone, NextFloat>=0.2 then NextBoolean=true: forward candidate", func(t *testing.T) {
		rnd := &mangroveScriptedRandom{floats: []float64{0.5}, bools: []bool{true}}
		got := mangrovePotentialRootPositions(100, origin, origin, east, rnd)
		if !equalBlockPosSeq(got, []wgen.BlockPos{fwd}) {
			t.Fatalf("got %v, want [%v]", got, fwd)
		}
		if rnd.fi != 1 || rnd.bi != 1 {
			t.Fatalf("draws consumed = (%d floats, %d bools), want (1,1)", rnd.fi, rnd.bi)
		}
	})

	t.Run("safe zone, NextFloat>=0.2 then NextBoolean=false: down candidate", func(t *testing.T) {
		rnd := &mangroveScriptedRandom{floats: []float64{0.5}, bools: []bool{false}}
		got := mangrovePotentialRootPositions(100, origin, origin, east, rnd)
		if !equalBlockPosSeq(got, []wgen.BlockPos{down}) {
			t.Fatalf("got %v, want [%v]", got, down)
		}
	})

	t.Run("safe zone, NextFloat<0.2: down candidate, NextBoolean NEVER drawn", func(t *testing.T) {
		rnd := &mangroveScriptedRandom{floats: []float64{0.1}} // no bools scripted -- NextBoolean would panic
		got := mangrovePotentialRootPositions(100, origin, origin, east, rnd)
		if !equalBlockPosSeq(got, []wgen.BlockPos{down}) {
			t.Fatalf("got %v, want [%v]", got, down)
		}
		if rnd.fi != 1 {
			t.Fatalf("floats consumed = %d, want 1", rnd.fi)
		}
	})

	t.Run("boundary zone, NextFloat>=0.2: down only", func(t *testing.T) {
		curPos := wgen.BlockPos{X: 8, Y: 0, Z: 0} // dist=8, maxW=8 -> boundary (maxW-2..maxW)
		rnd := &mangroveScriptedRandom{floats: []float64{0.5}}
		got := mangrovePotentialRootPositions(8, curPos, origin, east, rnd)
		want := []wgen.BlockPos{{X: 8, Y: -1, Z: 0}}
		if !equalBlockPosSeq(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("boundary zone, NextFloat<0.2: down PLUS diagonal forward-down fork", func(t *testing.T) {
		curPos := wgen.BlockPos{X: 8, Y: 0, Z: 0}
		rnd := &mangroveScriptedRandom{floats: []float64{0.1}}
		got := mangrovePotentialRootPositions(8, curPos, origin, east, rnd)
		want := []wgen.BlockPos{{X: 8, Y: -1, Z: 0}, {X: 9, Y: -1, Z: 0}}
		if !equalBlockPosSeq(got, want) {
			t.Fatalf("got %v, want %v (down, then forward-and-down)", got, want)
		}
	})
}

func equalBlockPosSeq(a, b []wgen.BlockPos) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestMangroveCanPlaceRoot pins the root viability test's own shipped (approximated) gate: passesAllowList OR
// isWater -- see mangroveCanPlaceRoot's own doc comment for how this approximates the game's gate.
func TestMangroveCanPlaceRoot(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	water := pal.Get("minecraft:water", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, air)
	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}

	mayGrowThrough := ResolveMatchSet([]block.Descriptor{{Name: "minecraft:dirt"}}, &BuildContext{Palette: pal}, "test")

	v.SetBlock(pos, dirt)
	if !mangroveCanPlaceRoot(v, pos, mayGrowThrough) {
		t.Error("dirt (in roots_may_grow_through) should pass")
	}

	v.SetBlock(pos, water)
	if !mangroveCanPlaceRoot(v, pos, mayGrowThrough) {
		t.Error("water should pass (isWater fallback) even though it's not in roots_may_grow_through")
	}

	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(pos, stone)
	if mangroveCanPlaceRoot(v, pos, mayGrowThrough) {
		t.Error("stone (neither in roots_may_grow_through nor water) should fail")
	}
}

// mangroveTestRoots builds a minimal, fully-valid *mangroveRoots for direct (non-buildTreeFeature)
// unit tests of mangroveSimulateRoots/mangrovePlaceRoot/mangroveRootsPlace.
func mangroveTestRoots(pal *block.Palette, maxWidth, maxLength int) *mangroveRoots {
	return &mangroveRoots{
		maxRootWidth:        maxWidth,
		maxRootLength:       maxLength,
		yOffsetMin:          0,
		yOffsetMax:          0,
		rootBlock:           pal.Get("minecraft:mangrove_roots", nil),
		muddyRootBlock:      pal.Get("minecraft:muddy_mangrove_roots", nil),
		mudBlock:            pal.Get("minecraft:mud", nil),
		rootsMayGrowThrough: ResolveMatchSet([]block.Descriptor{{Name: "minecraft:air"}}, &BuildContext{Palette: pal}, "test"),
	}
}

// TestMangroveSimulateRoots_DepthCapTruncatesWholeBranch pins the depth-cap failure contract
// : with max_root_width=0 every candidate-root-position call is forced into the
// "too far" band (dist=1 > maxW=0 the moment curPos moves away from origPos), which returns a single,
// ZERO-RNG "straight down" candidate every time -- so with open air on all sides, growth NEVER
// naturally stops and MUST hit the depth cap. That must truncate the branch to completely empty (not
// just stop appending) and return false.
func TestMangroveSimulateRoots_DepthCapTruncatesWholeBranch(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -20, MinZ: -2, SizeX: 5, SizeY: 40, SizeZ: 5}
	v := volume.New(bounds, pal, air)

	r := mangroveTestRoots(pal, 0, 3)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	start := wgen.BlockPos{X: 1, Y: 10, Z: 0} // one step East of origin
	var branch []wgen.BlockPos
	rnd := &mangroveScriptedRandom{} // must draw NOTHING -- the "too far" band is 0-RNG

	ok := mangroveSimulateRoots(v, rnd, start, origin, wgen.BlockPos{X: 1}, &branch, 0, r)
	if ok {
		t.Fatal("want false (depth cap reached with no natural stop)")
	}
	if len(branch) != 0 {
		t.Fatalf("branch = %v, want empty (depth cap must TRUNCATE, not just stop growing)", branch)
	}
}

// TestMangroveSimulateRoots_NaturalStopAtObstruction proves the OTHER side of that same contract:
// when growth hits solid ground (fails the viability test) before the depth cap, that is success (a clean,
// natural stop), not a failure -- the branch keeps whatever it already accumulated.
func TestMangroveSimulateRoots_NaturalStopAtObstruction(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -20, MinZ: -2, SizeX: 5, SizeY: 40, SizeZ: 5}
	v := volume.New(bounds, pal, air)
	// Floor at Y=5 -- one cell below the start position, so the very first "down" candidate is blocked.
	for x := -2; x <= 2; x++ {
		for z := -2; z <= 2; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: 5, Z: z}, stone)
		}
	}

	r := mangroveTestRoots(pal, 0, 3)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	start := wgen.BlockPos{X: 1, Y: 6, Z: 0} // one cell above the floor
	var branch []wgen.BlockPos
	rnd := &mangroveScriptedRandom{}

	ok := mangroveSimulateRoots(v, rnd, start, origin, wgen.BlockPos{X: 1}, &branch, 0, r)
	if !ok {
		t.Fatal("want true (blocked by stone = natural stop, not a failure)")
	}
	if len(branch) != 0 {
		t.Fatalf("branch = %v, want empty (the ONLY candidate, straight down into stone, must have been rejected before ever being pushed)", branch)
	}
}

// mangroveRootsBody returns a minimal, valid mangrove_roots JSON body paired with an acacia trunk +
// "canopy" shape -- small max_root_width/max_root_length and roots_may_grow_through=[air] keep the
// geometry easy to reason about in tests, matching this file's own established "small, controlled
// JSON" convention for other shapes.
func mangroveRootsBody(rootsExtra map[string]any) map[string]any {
	body := simpleTreeBody(nil)
	roots := map[string]any{
		"max_root_width":         float64(0),
		"max_root_length":        float64(3),
		"root_block":             "minecraft:mangrove_roots",
		"muddy_root_block":       "minecraft:muddy_mangrove_roots",
		"mud_block":              "minecraft:mud",
		"y_offset":               map[string]any{"range_min": float64(0), "range_max": float64(0)},
		"roots_may_grow_through": []any{"minecraft:air"},
	}
	for k, v := range rootsExtra {
		roots[k] = v
	}
	body["mangrove_roots"] = roots
	return body
}

func TestBuildTreeFeature_MangroveRootsKey_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		f, err := buildTreeFeature(mangroveRootsBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if f.(*TreeFeature).roots == nil {
			t.Fatal("want roots set")
		}
	})
	t.Run("absent: roots stays nil (pure no-op)", func(t *testing.T) {
		f, err := buildTreeFeature(simpleTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if f.(*TreeFeature).roots != nil {
			t.Error("want roots nil when mangrove_roots is absent")
		}
	})
	for _, field := range []string{"max_root_width", "max_root_length", "root_block", "muddy_root_block", "mud_block", "y_offset", "roots_may_grow_through"} {
		field := field
		t.Run(field+" required", func(t *testing.T) {
			body := mangroveRootsBody(nil)
			delete(body["mangrove_roots"].(map[string]any), field)
			_, err := buildTreeFeature(body, ctx)
			if err == nil {
				t.Fatalf("want error (missing %s), got nil", field)
			}
			if !strings.Contains(err.Error(), field) {
				t.Errorf("error %q does not name %s", err.Error(), field)
			}
		})
	}
	t.Run("root_decoration -- CLOSED: a well-formed object now parses and wires", func(t *testing.T) {
		body := mangroveRootsBody(map[string]any{
			"root_decoration": map[string]any{
				"decoration_block":  "minecraft:vine",
				"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(2)},
			},
		})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		roots := f.(*TreeFeature).roots
		if roots.decoration == nil {
			t.Fatal("want roots.decoration non-nil")
		}
		if len(roots.decoration.entries) != 1 || roots.decoration.entries[0].blockID != pal.Get("minecraft:vine", nil) {
			t.Errorf("decoration.entries = %+v, want one vine entry", roots.decoration.entries)
		}
	})
	t.Run("root_decoration still refuses a malformed object (neither decoration_block nor decoration_blocks_sequence)", func(t *testing.T) {
		body := mangroveRootsBody(map[string]any{"root_decoration": map[string]any{}})
		_, err := buildTreeFeature(body, ctx)
		if err == nil {
			t.Fatal("want error, got nil")
		}
		if !strings.Contains(err.Error(), "root_decoration") {
			t.Errorf("error %q does not name root_decoration", err.Error())
		}
	})
	t.Run("above_root optional, absent leaves hasAboveRootBlock false", func(t *testing.T) {
		f, err := buildTreeFeature(mangroveRootsBody(nil), ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		if f.(*TreeFeature).roots.hasAboveRootBlock {
			t.Error("want hasAboveRootBlock=false when above_root is absent")
		}
	})
	t.Run("above_root.above_root_block sets hasAboveRootBlock", func(t *testing.T) {
		body := mangroveRootsBody(map[string]any{
			"above_root": map[string]any{
				"above_root_chance": float64(100),
				"above_root_block":  "minecraft:moss_carpet",
			},
		})
		f, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("want success, got %v", err)
		}
		roots := f.(*TreeFeature).roots
		if !roots.hasAboveRootBlock {
			t.Error("want hasAboveRootBlock=true")
		}
		if !roots.aboveRootChance.isValid() || roots.aboveRootChance.percent != 100 {
			t.Errorf("aboveRootChance = %+v, want percent=100, valid", roots.aboveRootChance)
		}
	})
}

// TestTreeFeature_MangroveRoots_RNGDrawSequence pins the full Place() draw sequence for a
// max_root_width=0 tree (every direction's growth is forced into the ZERO-RNG "too far" band from
// its very first step, since dist=1>maxW=0 immediately -- see
// TestMangrovePotentialRootPositions_DistanceBands) with a floor placed exactly 2 cells below the
// growth start (topY-2): each direction pushes ONE position (topY-1) then hits the floor and stops
// NATURALLY, before max_root_length=3's own depth cap (which would otherwise TRUNCATE the branch to
// empty and abort the whole call -- see mangroveSimulateRoots' own doc comment; a floor placed at
// topY-1 would ALSO abort, since an empty-but-successful branch is treated the same as a failure --
// see TestMangroveSimulateRoots_DepthCapTruncatesWholeBranch/mangroveRootsPlace's own comment). The
// origin's own (X,Z) column is left clear so the vertical validation loop (which only probes that one
// column) is unaffected.
//
// y_offset is {0,2} (non-degenerate -- treeIntRangeValue's own "min>=max-1" guard would otherwise
// skip the draw entirely, per TestTreeIntRangeValue_DegenerateDrawsNothing; a degenerate {0,0} range,
// tried first, draws ZERO times and silently hid this test's whole point). Every NextIntBound call in
// this run is scripted to return 0 via a fully-controlled inner random -- keeping topY=origin.Y=10
// exactly (so the floor math above still holds) while proving the y_offset draw genuinely happens,
// not merely "didn't happen to draw for this seed".
//
// y_offset is the ONLY draw. The bare `trunk` key is the simple trunk, not the acacia one (see
// tree.go's trunk-key table), and the simple trunk's own two draws (trunk_height, height_modifier)
// are both degenerate for this body. The roots themselves are unchanged and still exercised: they
// relocate the origin and place blocks, which TestTreeFeature_MangroveRoots_RelocatesTrunkOrigin
// and the mangroveSimulateRoots tests cover directly.
func TestTreeFeature_MangroveRoots_RNGDrawSequence(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -10, MinY: -20, MinZ: -10, SizeX: 21, SizeY: 60, SizeZ: 21}
	v := volume.New(bounds, pal, air)
	const floorY = 8 // topY(=origin.Y=10, y_offset draws 0 of [0,2)) - 2
	for x := -10; x <= 10; x++ {
		for z := -10; z <= 10; z++ {
			if x == 0 && z == 0 {
				continue // leave the origin's own column clear
			}
			v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, stone)
		}
	}

	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	body := mangroveRootsBody(map[string]any{"y_offset": map[string]any{"range_min": float64(0), "range_max": float64(2)}})
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := f.(*TreeFeature)

	inner := &mangroveScriptedRandom{intBounds: []int{0, 0, 0, 0, 0}}
	tr := random.NewTracer(inner)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	if got := placeTestTree(tf, v, origin, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantSeq := []random.Method{
		random.MethodNextIntBound, // mangrove_roots' own y_offset.getValue -- the ONLY draw
	}
	if seq := drawSeqRandom(tr); !equalMethodSeq(seq, wantSeq) {
		t.Fatalf("draw sequence = %v, want %v", seq, wantSeq)
	}
}

// TestTreeFeature_MangroveRoots_RelocatesTrunkOrigin proves mangroveRootsPlace's own returned
// position (origin.X, origin.Y+yOffsetValue, origin.Z) is what the trunk column actually rises from
// -- the tree feature's shared placement path applies this relocation (mangroveRootsPlace's own
// doc comment). y_offset={4,4} (a degenerate, still-drawing int range -- 0 or 1 NextIntBound draw with
// value always 4) relocates the trunk 4 blocks UP from the feature's raw ctx.Origin. Floor placement
// mirrors TestTreeFeature_MangroveRoots_RNGDrawSequence's own reasoning (topY-2, origin column left
// clear) -- topY here is origin.Y+4=14, so the floor sits at Y=12.
func TestTreeFeature_MangroveRoots_RelocatesTrunkOrigin(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -10, MinY: -20, MinZ: -10, SizeX: 21, SizeY: 60, SizeZ: 21}
	v := volume.New(bounds, pal, air)
	const floorY = 12 // topY(=origin.Y+4=14) - 2
	for x := -10; x <= 10; x++ {
		for z := -10; z <= 10; z++ {
			if x == 0 && z == 0 {
				continue
			}
			v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, stone)
		}
	}

	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	body := mangroveRootsBody(map[string]any{"y_offset": map[string]any{"range_min": float64(4), "range_max": float64(4)}})
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := f.(*TreeFeature)

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	got := placeTestTree(tf, v, origin, random.New(1))
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	logID := pal.Get("minecraft:oak_log", nil)
	// The trunk's own first log lands at the RELOCATED origin (Y=14), not the raw origin (Y=10).
	if b := v.GetBlock(wgen.BlockPos{X: 0, Y: 14, Z: 0}); b != logID {
		t.Errorf("Y=14 (relocated origin): block = %v, want oak_log", pal.Entry(b))
	}
	if b := v.GetBlock(wgen.BlockPos{X: 0, Y: 10, Z: 0}); b == logID {
		t.Errorf("Y=10 (raw ctx.Origin): got a log there -- trunk must rise from the RELOCATED origin, not the raw one")
	}
}

// TestTreeFeature_MangroveRoots_FailureAbortsWholeTree proves a root failure aborts the ENTIRE
// feature (no trunk, no canopy) -- the tree feature's shared placement path never reaches the
// trunk's own placement call when the root call's own success flag is clear (mangroveRootsPlace's own
// doc comment). Forces failure the simplest way: origin.Y at api.MinY() fails mangroveRootsPlace's
// own spawn-preparation-equivalent bounds check before any RNG or placement happens.
func TestTreeFeature_MangroveRoots_FailureAbortsWholeTree(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	bounds := volume.Bounds{MinX: -5, MinY: 0, MinZ: -5, SizeX: 11, SizeY: 30, SizeZ: 11}
	v := volume.New(bounds, pal, air)

	ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
	f, err := buildTreeFeature(mangroveRootsBody(nil), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := f.(*TreeFeature)

	var failMsg string
	origin := wgen.BlockPos{X: 0, Y: 0, Z: 0} // == api.MinY()
	pctx := &wgen.PlacementContext{
		API: v, Origin: origin, Random: random.New(1),
		MolangScope: wgen.NewScope(), Biome: &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) { failMsg = message },
	}
	got := tf.Place(pctx)
	if got != nil {
		t.Fatalf("Place() = %v, want nil", got)
	}
	if failMsg != "Roots could not be placed" {
		t.Errorf("LogFailure message = %q, want %q", failMsg, "Roots could not be placed")
	}
	// Nothing anywhere should have been touched -- the trunk column must never run.
	for x := -5; x <= 5; x++ {
		for y := 0; y < 30; y++ {
			for z := -5; z <= 5; z++ {
				pos := wgen.BlockPos{X: x, Y: y, Z: z}
				if b := v.GetBlock(pos); b != air {
					t.Fatalf("%v: block = %v, want air (whole tree must be aborted)", pos, pal.Entry(b))
				}
			}
		}
	}
}

// TestMangrovePlaceRoot_MuddyRootSubstitution pins the single-root write's own mud_block substitution branch
// : when the EXISTING block at the target position is already mud_block, that
// position gets muddy_root_block instead of root_block, and above_root is NEVER attempted on that
// branch even when above_root is fully configured with a 100%-certain roll.
func TestMangrovePlaceRoot_MuddyRootSubstitution(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, air)

	r := mangroveTestRoots(pal, 0, 3)
	r.hasAboveRootBlock = true
	r.aboveRootBlock = pal.Get("minecraft:moss_carpet", nil)
	r.aboveRootChance = chanceInformation{percent: 100} // roll() always true, 0 draws
	// mangroveTestRoots' own roots_may_grow_through is [air] -- widen it to "no restriction" here so
	// the viability re-check (mangrovePlaceRoot's first line) passes at a position that is
	// itself mud, not air.
	r.rootsMayGrowThrough = block.MatchSet{}

	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	v.SetBlock(pos, r.mudBlock)

	rnd := &mangroveScriptedRandom{} // must draw NOTHING on this branch
	mangrovePlaceRoot(v, pos, rnd, r)

	if got := v.GetBlock(pos); got != r.muddyRootBlock {
		t.Errorf("block = %v, want muddyRootBlock", pal.Entry(got))
	}
	above := wgen.BlockPos{X: 0, Y: 1, Z: 0}
	if got := v.GetBlock(above); got != air {
		t.Errorf("above = %v, want air (above_root must NOT fire on the mud-substitution branch)", pal.Entry(got))
	}
}

// TestMangrovePlaceRoot_AboveRootBlock_PlacedOnSuccessfulRoll pins the single-root write's own root_block +
// above_root branch: a fresh root_block placement (existing != mud_block), a
// 100%-certain above_root_chance roll (0 draws, per chanceInformation.roll's own established
// contract), and clear air directly above -- above_root_block must land one cell above pos.
func TestMangrovePlaceRoot_AboveRootBlock_PlacedOnSuccessfulRoll(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, air)

	r := mangroveTestRoots(pal, 0, 3)
	r.hasAboveRootBlock = true
	r.aboveRootBlock = pal.Get("minecraft:moss_carpet", nil)
	r.aboveRootChance = chanceInformation{percent: 100}

	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	rnd := &mangroveScriptedRandom{} // percent>=100 -> 0 draws
	mangrovePlaceRoot(v, pos, rnd, r)

	if got := v.GetBlock(pos); got != r.rootBlock {
		t.Errorf("block at pos = %v, want rootBlock", pal.Entry(got))
	}
	above := wgen.BlockPos{X: 0, Y: 1, Z: 0}
	if got := v.GetBlock(above); got != r.aboveRootBlock {
		t.Errorf("block above = %v, want aboveRootBlock", pal.Entry(got))
	}
}

// TestMangrovePlaceRoot_AboveRootBlock_SkippedWhenNotConfigured proves the no-op default: with
// hasAboveRootBlock=false (the default, above_root omitted), root_block is placed
// but nothing at all happens above it, and NO chance draw occurs.
func TestMangrovePlaceRoot_AboveRootBlock_SkippedWhenNotConfigured(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, air)

	r := mangroveTestRoots(pal, 0, 3) // hasAboveRootBlock stays false

	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	rnd := &mangroveScriptedRandom{} // must draw NOTHING
	mangrovePlaceRoot(v, pos, rnd, r)

	if got := v.GetBlock(pos); got != r.rootBlock {
		t.Errorf("block at pos = %v, want rootBlock", pal.Entry(got))
	}
	above := wgen.BlockPos{X: 0, Y: 1, Z: 0}
	if got := v.GetBlock(above); got != air {
		t.Errorf("above = %v, want air", pal.Entry(got))
	}
}

// TestMangroveRootsPlace_StraightDownColumn_ASCII is the geometry proof: max_root_width=0 forces
// every direction's growth straight down (see TestMangrovePotentialRootPositions_DistanceBands), and
// a floor at topY-2 (see TestTreeFeature_MangroveRoots_RNGDrawSequence's own comment for why exactly
// topY-2, not topY-1 or deeper) lets every direction terminate NATURALLY (hits stone, not the
// max_root_length=3 depth cap) -- and renders the result as an ASCII cross-section, the way this
// file's other shapes prove their own geometry.
func TestMangroveRootsPlace_StraightDownColumn_ASCII(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -3, MinY: -10, MinZ: -3, SizeX: 7, SizeY: 30, SizeZ: 7}
	v := volume.New(bounds, pal, air)
	const floorY = 8 // topY(=origin.Y=10, y_offset=0) - 2
	for x := -3; x <= 3; x++ {
		for z := -3; z <= 3; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, stone)
		}
	}

	r := mangroveTestRoots(pal, 0, 3)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	relocated, ok := mangroveRootsPlace(v, origin, random.New(1), 5, block.MatchSet{}, r)
	if !ok {
		t.Fatal("want success")
	}
	if relocated != origin {
		t.Errorf("relocated = %v, want %v (y_offset={0,0})", relocated, origin)
	}

	rootID := r.rootBlock
	var art strings.Builder
	for y := origin.Y + 1; y >= floorY; y-- {
		art.WriteByte(' ')
		for x := -2; x <= 2; x++ {
			switch v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: 0}) {
			case rootID:
				art.WriteByte('R')
			case stone:
				art.WriteByte('S')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("mangrove_roots (max_root_width=0, straight down every direction), origin.Y=%d, floor Y=%d -- "+
		"vertical (X/Y) cross-section through Z=0, top to bottom (R=mangrove_roots, S=stone floor, .=air):\n%s",
		origin.Y, floorY, art.String())

	// East and West directions must each have carved a straight-down root column reaching the floor.
	for _, x := range []int{1, -1} {
		pos := wgen.BlockPos{X: x, Y: floorY + 1, Z: 0}
		if got := v.GetBlock(pos); got != rootID {
			t.Errorf("%v: block = %v, want mangrove_roots (straight-down column reaching the floor)", pos, pal.Entry(got))
		}
	}

	// Every one of the 4 directions' own "start" cell (base+dir, at Y=topY itself -- ONE STEP ABOVE
	// where the branch's own growth begins) must ALSO be a root_block:
	// this position is pushed a SECOND time, separately from the branch's own
	// positions, AFTER the branch is copied in (mangroveRootsPlace's own doc comment). All 4 in one
	// assertion, since mangroveRootDirections' own order is separately pinned by
	// TestMangroveRootDirections_Order below.
	for _, dir := range mangroveRootDirections {
		pos := wgen.BlockPos{X: origin.X + dir.X, Y: origin.Y, Z: origin.Z + dir.Z}
		if got := v.GetBlock(pos); got != rootID {
			t.Errorf("direction start %v: block = %v, want mangrove_roots (the direction's own start cell, "+
				"pushed a second time after its branch)", pos, pal.Entry(got))
		}
	}
}

// TestMangroveRootDirections_Order pins the game's horizontal direction order
// (North, East, South, West -- facing values [2,5,3,4], see
// mangroveRootDirections' own doc comment), independently of any placement geometry.
func TestMangroveRootDirections_Order(t *testing.T) {
	want := []wgen.BlockPos{
		{X: 0, Y: 0, Z: -1}, // North
		{X: 1, Y: 0, Z: 0},  // East
		{X: 0, Y: 0, Z: 1},  // South
		{X: -1, Y: 0, Z: 0}, // West
	}
	if !equalBlockPosSeq(mangroveRootDirections, want) {
		t.Fatalf("mangroveRootDirections = %v, want %v", mangroveRootDirections, want)
	}
}

// TestMangroveRootsPlace_VerticalValidation_BlocksOnObstruction pins the root placement's own vertical
// validation loop (EVERY Y from origin.Y up to
// (excluding) topY must pass the root viability test, aborting the WHOLE call the first time one fails --
// mangroveRootsPlace's own doc comment). max_root_width=0 (deterministic straight-down growth, per
// TestMangrovePotentialRootPositions_DistanceBands) plus a full floor at topY-2 makes EVERY direction
// terminate naturally at exactly one committed position (the SAME shape
// TestMangroveRootsPlace_StraightDownColumn_ASCII already proves in isolation) -- so with the
// vertical validation intact, the ONLY thing that can fail this call is the floor ALSO sitting inside
// the origin's own probed band [origin.Y, topY), which it deliberately does here (y_offset=3, floor
// at topY-2=origin.Y+1, squarely inside {origin.Y, origin.Y+1, origin.Y+2}). This is a REAL
// discriminator, not a coincidental failure: a large max_root_width with a real seeded RNG can
// return false either way (the depth cap firing on its own from RNG noise, unrelated to the
// vertical loop), which is why this version is fully deterministic.
func TestMangroveRootsPlace_VerticalValidation_BlocksOnObstruction(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	stone := pal.Get("minecraft:stone", nil)
	bounds := volume.Bounds{MinX: -3, MinY: -10, MinZ: -3, SizeX: 7, SizeY: 30, SizeZ: 7}
	v := volume.New(bounds, pal, air)

	r := mangroveTestRoots(pal, 0, 3)
	r.yOffsetMin, r.yOffsetMax = 3, 3
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	const floorY = 11 // topY(=origin.Y+3=13) - 2, and origin.Y+1 -- inside [origin.Y, topY)
	for x := -3; x <= 3; x++ {
		for z := -3; z <= 3; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, stone)
		}
	}

	_, ok := mangroveRootsPlace(v, origin, random.New(1), 5, block.MatchSet{}, r)
	if ok {
		t.Fatal("want false -- the vertical validation band contains an obstruction (the SAME floor that would otherwise let every direction terminate naturally)")
	}
}

// --- cherry_canopy ------------------------------------------------------------------------------

func cherryTreeBody(canopyExtra map[string]any) map[string]any {
	canopy := map[string]any{
		"leaf_block":                      "minecraft:cherry_leaves",
		"height":                          map[string]any{"range_min": float64(5), "range_max": float64(5)},
		"radius":                          map[string]any{"range_min": float64(4), "range_max": float64(4)},
		"wide_bottom_layer_hole_chance":   float64(0),
		"corner_hole_chance":              float64(0),
		"hanging_leaves_chance":           float64(0),
		"hanging_leaves_extension_chance": float64(0),
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"trunk":         map[string]any{"trunk_block": "minecraft:cherry_log", "trunk_height": float64(5)},
		"cherry_canopy": canopy,
	}
}

func vanillaCherryTreeBody() map[string]any {
	return map[string]any{
		"cherry_trunk": map[string]any{
			"trunk_block": "minecraft:cherry_log",
			"trunk_height": map[string]any{
				"base":      float64(5),
				"intervals": []any{float64(2)},
			},
			"branches": map[string]any{
				"tree_type_weights": map[string]any{
					"one_branch":             float64(0),
					"two_branches":           float64(0),
					"two_branches_and_trunk": float64(1),
				},
				"branch_horizontal_length":     map[string]any{"range_min": float64(2), "range_max": float64(3)},
				"branch_start_offset_from_top": map[string]any{"range_min": float64(-4), "range_max": float64(-2)},
				"branch_end_offset_from_top":   map[string]any{"range_min": float64(-1), "range_max": float64(0)},
				"branch_canopy": map[string]any{
					"cherry_canopy": map[string]any{
						"leaf_block":                      "minecraft:cherry_leaves",
						"height":                          float64(5),
						"radius":                          float64(4),
						"wide_bottom_layer_hole_chance":   float64(0),
						"corner_hole_chance":              float64(0),
						"hanging_leaves_chance":           float64(0),
						"hanging_leaves_extension_chance": float64(0),
					},
				},
			},
		},
		"may_replace": []any{"minecraft:air"},
	}
}

type recordingTreeCanopy struct {
	anchors    []wgen.BlockPos
	candidates [][]wgen.BlockPos
}

func (c *recordingTreeCanopy) place(_ wgen.BlockWorld, anchor wgen.BlockPos, _ random.IRandom, _ treeParamsLists, candidates []wgen.BlockPos) {
	c.anchors = append(c.anchors, anchor)
	c.candidates = append(c.candidates, candidates)
}

func TestBuildTreeFeature_CherryTrunk_VanillaShapeAndSchema(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:cherry", FileID: "test:cherry", Warn: func(string) {}}
	built, err := buildTreeFeature(vanillaCherryTreeBody(), ctx)
	if err != nil {
		t.Fatalf("vanilla-shaped body: %v", err)
	}
	tf := built.(*TreeFeature)
	if tf.cherryTrunk == nil {
		t.Fatal("cherryTrunk = nil, want cherry-trunk dispatch")
	}
	if _, ok := tf.canopy.(*cherryCanopy); !ok {
		t.Fatalf("nested branch canopy = %T, want *cherryCanopy", tf.canopy)
	}
	if tf.cherryTrunk.baseHeight != 5 || len(tf.cherryTrunk.heightIntervals) != 1 || tf.cherryTrunk.heightIntervals[0] != 2 {
		t.Fatalf("trunk height = base %d intervals %v, want base 5 intervals [2]", tf.cherryTrunk.baseHeight, tf.cherryTrunk.heightIntervals)
	}

	for _, key := range []string{"branch_horizontal_length", "branch_start_offset_from_top", "branch_end_offset_from_top"} {
		t.Run("requires_"+key, func(t *testing.T) {
			body := vanillaCherryTreeBody()
			branches := body["cherry_trunk"].(map[string]any)["branches"].(map[string]any)
			delete(branches, key)
			if _, err := buildTreeFeature(body, ctx); err == nil {
				t.Fatalf("missing %s: want error", key)
			}
		})
	}
	t.Run("branch_canopy_is_optional", func(t *testing.T) {
		body := vanillaCherryTreeBody()
		delete(body["cherry_trunk"].(map[string]any)["branches"].(map[string]any), "branch_canopy")
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("optional branch_canopy: %v", err)
		}
		if built.(*TreeFeature).canopy != nil {
			t.Fatalf("canopy = %T, want nil", built.(*TreeFeature).canopy)
		}
	})
}

func TestCherryTrunk_RNGSequenceAndOrderedFreshCanopyAnchors(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	ctx := &BuildContext{Palette: pal, Identifier: "test:cherry", FileID: "test:cherry", Warn: func(string) {}}
	built, err := buildTreeFeature(vanillaCherryTreeBody(), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := built.(*TreeFeature)
	recording := &recordingTreeCanopy{}
	tf.canopy = recording
	scripted := &spruceScriptedRandom{
		bounds: []int{0, 0, 0, 0, 1, 1, 0, 1, 0},
		floats: []float64{0, 0, 0, 0, 0, 0, 0, 0, 0},
	}
	tr := random.NewTracer(scripted)
	if got := placeTestTree(tf, v, wgen.BlockPos{Y: 10}, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	wantAnchors := []wgen.BlockPos{{Y: 15}, {X: -3, Y: 15}, {X: 3, Y: 15}}
	if fmt.Sprint(recording.anchors) != fmt.Sprint(wantAnchors) {
		t.Fatalf("ordered anchors = %v, want %v (vertical, forward, opposite)", recording.anchors, wantAnchors)
	}
	for i, candidates := range recording.candidates {
		if len(candidates) != 0 {
			t.Fatalf("canopy call %d candidates = %v, want fresh empty vector", i, candidates)
		}
	}

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 3}, // height interval: inclusive [0,2]
		{random.MethodNextIntBound, 1}, // weighted three-tip selection
		{random.MethodNextIntBound, 3}, // first start: inclusive [-4,-2]
		{random.MethodNextIntBound, 2}, // second start: inclusive [-4,-3]
		{random.MethodNextIntBound, 4}, // direction
		{random.MethodNextIntBound, 2}, // first branch end
		{random.MethodNextIntBound, 2}, // first branch horizontal length
		{random.MethodNextFloat, 0}, {random.MethodNextFloat, 0}, {random.MethodNextFloat, 0}, {random.MethodNextFloat, 0}, {random.MethodNextFloat, 0},
		{random.MethodNextIntBound, 2}, // second branch end
		{random.MethodNextIntBound, 2}, // second branch horizontal length
		{random.MethodNextFloat, 0}, {random.MethodNextFloat, 0}, {random.MethodNextFloat, 0}, {random.MethodNextFloat, 0},
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want %d draws", tr.Draws, len(want))
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}
}

func TestCherryTrunk_BranchLogsCarryPillarAxisAndPreserveStates(t *testing.T) {
	for _, tc := range []struct {
		name      string
		direction int
		position  wgen.BlockPos
		axis      string
	}{
		{"z_branch", 0, wgen.BlockPos{Y: 10, Z: 1}, "z"},
		{"x_branch", 1, wgen.BlockPos{X: -1, Y: 10}, "x"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, pal := newTreeTestVolume(t, 10)
			body := vanillaCherryTreeBody()
			body["cherry_trunk"].(map[string]any)["trunk_block"] = map[string]any{
				"name":   "minecraft:cherry_log",
				"states": map[string]any{"persistent_bit": true},
			}
			ctx := &BuildContext{Palette: pal, Identifier: "test:cherry", FileID: "test:cherry", Warn: func(string) {}}
			built, err := buildTreeFeature(body, ctx)
			if err != nil {
				t.Fatalf("buildTreeFeature: %v", err)
			}
			tf := built.(*TreeFeature)
			tf.canopy = &recordingTreeCanopy{}
			scripted := &spruceScriptedRandom{
				bounds: []int{0, 0, 0, 0, tc.direction, 1, 0, 1, 0},
				floats: []float64{0, 0, 0, 0, 0, 0, 0, 0, 0},
			}
			if got := placeTestTree(tf, v, wgen.BlockPos{Y: 10}, scripted); got == nil {
				t.Fatal("Place() = nil, want success")
			}
			states := pal.StatesOf(v.GetBlock(tc.position))
			if states["pillar_axis"] != tc.axis {
				t.Fatalf("branch states = %v, want pillar_axis=%q", states, tc.axis)
			}
			if states["persistent_bit"] != true {
				t.Fatalf("branch states = %v, original persistent_bit was not preserved", states)
			}
			verticalStates := pal.StatesOf(v.GetBlock(wgen.BlockPos{Y: 10}))
			if _, present := verticalStates["pillar_axis"]; present {
				t.Fatalf("vertical trunk states = %v, pillar_axis must only be added to branch logs", verticalStates)
			}
		})
	}
}

func TestCherryTrunk_BranchWalkUsesFloat32Probability(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	ctx := &BuildContext{Palette: pal, Identifier: "test:cherry", FileID: "test:cherry", Warn: func(string) {}}
	built, err := buildTreeFeature(vanillaCherryTreeBody(), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	ct := built.(*TreeFeature).cherryTrunk
	ct.horizontalMin, ct.horizontalMax = 4, 4
	ct.endMin, ct.endMax = 0, 0

	// At the first walk step dy/distance is 7/10. float32(0.7) rounds down:
	// the game's float32 arithmetic compares equal and takes a horizontal step,
	// while an incorrect float64 ratio would treat the same draw as less-than.
	rnd := &spruceScriptedRandom{floats: []float64{0.699999988079071, 0, 0, 0, 0, 0, 0, 0, 0, 0}}
	origin := wgen.BlockPos{Y: 10}
	ct.generateBranch(v, origin, rnd, 10, treeParamsLists{}, 3, 2, false)
	horizontalStep := wgen.BlockPos{X: 2, Y: 12}
	if got := v.GetBlock(horizontalStep); got != ct.branchXBlock {
		t.Fatalf("block at first native float32 horizontal step %v = %v, want x-axis branch block %v", horizontalStep, got, ct.branchXBlock)
	}
	if verticalStep := (wgen.BlockPos{X: 1, Y: 13}); v.GetBlock(verticalStep) != 0 {
		t.Fatalf("block at float64-only vertical step %v = %v, want air", verticalStep, v.GetBlock(verticalStep))
	}
}

func TestTreeFeature_ExistingTrunkRNGSequencesRemainExact(t *testing.T) {
	// A bare `trunk` with a scalar trunk_height binds the simple trunk (not an acacia-shaped
	// path), and a scalar trunk_height is just the degenerate spelling of the simple trunk's
	// required int range. An earlier version of this port spent four acacia-style NextIntBound
	// draws (bounds 4,3,3,4) here; this subtest pins that it draws nothing, because those four
	// draws per tree shifted every feature placed after a tree in the same chunk.
	t.Run("scalar_trunk_height_bare_trunk_is_SimpleTreeTrunk_and_draws_nothing", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 10)
		tf := buildTestSimpleTree(t, pal, nil)
		if tf.submergedTrunk == nil {
			t.Fatal("bare `trunk` must bind the simple trunk even with a scalar trunk_height")
		}
		if tf.submergedTrunk.trunkHeightMin != 5 || tf.submergedTrunk.trunkHeightMax != 5 {
			t.Fatalf("trunk_height = {%d,%d}, want the degenerate {5,5} a JSON scalar parses to",
				tf.submergedTrunk.trunkHeightMin, tf.submergedTrunk.trunkHeightMax)
		}
		tr := random.NewTracer(random.New(1))
		if placeTestTree(tf, v, wgen.BlockPos{Y: 10}, tr) == nil {
			t.Fatal("Place() = nil")
		}
		if len(tr.Draws) != 0 {
			t.Fatalf("draws = %v, want NONE: a degenerate trunk_height and an absent height_modifier "+
				"both draw nothing, and this shape must never spend the acacia trunk's four lean/branch draws again", tr.Draws)
		}
		// The column is 5 logs tall from Y=10, but the canopy (canopy_offset {-2,0} around an
		// anchor at Y=15) overwrites the top two with leaves -- so check the three that survive.
		oakLog := pal.Get("minecraft:oak_log", nil)
		for y := 10; y <= 12; y++ {
			if got := v.GetBlock(wgen.BlockPos{Y: y}); got != oakLog {
				t.Fatalf("block at Y=%d is %v, want an oak log -- the zero-draw expectation above is only meaningful if the trunk grew", y, pal.Entry(got))
			}
		}
	})
	t.Run("simple_submerged_trunk", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 6)
		ctx := &BuildContext{Palette: pal, Identifier: "test:tree", FileID: "test:tree", Warn: func(string) {}}
		built, err := buildTreeFeature(submergedTreeBody(nil), ctx)
		if err != nil {
			t.Fatalf("buildTreeFeature: %v", err)
		}
		tr := random.NewTracer(random.New(1))
		if placeTestTree(built.(*TreeFeature), v, wgen.BlockPos{Y: 20}, tr) == nil {
			t.Fatal("Place() = nil")
		}
		wantBounds := []int32{3, 2}
		if len(tr.Draws) != len(wantBounds) {
			t.Fatalf("draws = %v, want %d", tr.Draws, len(wantBounds))
		}
		for i, bound := range wantBounds {
			if tr.Draws[i].Method != random.MethodNextIntBound || tr.Draws[i].Bound != bound {
				t.Fatalf("draw %d = %+v, want NextIntBound(%d)", i, tr.Draws[i], bound)
			}
		}
	})
}

func TestTreeIntRangeValueInclusive_PinsIncludedMaximum(t *testing.T) {
	tr := random.NewTracer(random.New(1))
	got := treeIntRangeValueInclusive(4, 6, tr)
	if len(tr.Draws) != 1 {
		t.Fatalf("draws = %v, want exactly one", tr.Draws)
	}
	if d := tr.Draws[0]; d.Method != random.MethodNextIntBound || d.Bound != 3 {
		t.Fatalf("draw = %+v, want NextIntBound(3): max-min+1, maximum INCLUDED", d)
	}
	if got < 4 || got > 6 {
		t.Fatalf("value = %d, want [4,6]", got)
	}
	for _, bounds := range [][2]int{{4, 4}, {6, 4}} {
		tr = random.NewTracer(random.New(1))
		if got := treeIntRangeValueInclusive(bounds[0], bounds[1], tr); got != bounds[0] {
			t.Errorf("range %v returned %d, want min %d", bounds, got, bounds[0])
		}
		if len(tr.Draws) != 0 {
			t.Errorf("range %v drew %v, want zero draws", bounds, tr.Draws)
		}
	}
}

// TestChanceInformationFraction_UsesRawDrawAndZeroDenominatorShortCircuits pins the fraction-mode
// draw to rnd.NextIntBound(denominator) -- i.e. NextUint32()%denominator: the game takes a raw
// 32-bit MT19937 output (fully tempered, as mtrand.Rand.NextUint32) modulo the denominator
// (see roll's own doc comment). rnd.NextInt() -- int32(NextUint32()>>1), one bit narrower -- is WRONG here
// and must fail this test: an earlier draft called it, compiled, and passed every then-existing test
// (fraction mode was unexercised before cherry) while silently drawing the wrong value every roll.
func TestChanceInformationFraction_UsesRawDrawAndZeroDenominatorShortCircuits(t *testing.T) {
	tr := random.NewTracer(&spruceScriptedRandom{bounds: []int{1}})
	if !(chanceInformation{isFraction: true, numerator: 2, denominator: 7}).roll(tr) {
		t.Fatal("1 < 2: want true")
	}
	if len(tr.Draws) != 1 || tr.Draws[0].Method != random.MethodNextIntBound || tr.Draws[0].Bound != 7 {
		t.Fatalf("draws = %v, want one NextIntBound(7)", tr.Draws)
	}
	tr = random.NewTracer(random.New(1))
	if (chanceInformation{isFraction: true, numerator: 1, denominator: 0}).roll(tr) {
		t.Fatal("denominator 0: want false")
	}
	if len(tr.Draws) != 0 {
		t.Fatalf("denominator 0 drew %v, want zero draws", tr.Draws)
	}
}

func TestBuildTreeFeature_CherryCanopyKey_SchemaAndDefaults(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:cherry", FileID: "test:cherry", Warn: func(string) {}}
	f, err := buildTreeFeature(cherryTreeBody(nil), ctx)
	if err != nil {
		t.Fatalf("valid body: %v", err)
	}
	c, ok := f.(*TreeFeature).canopy.(*cherryCanopy)
	if !ok {
		t.Fatalf("canopy = %T, want *cherryCanopy", f.(*TreeFeature).canopy)
	}
	if c.trunkWidth != 1 {
		t.Fatalf("default trunk_width = %d, want 1", c.trunkWidth)
	}

	required := []string{"leaf_block", "height", "radius", "wide_bottom_layer_hole_chance", "corner_hole_chance", "hanging_leaves_chance", "hanging_leaves_extension_chance"}
	for _, key := range required {
		t.Run("requires_"+key, func(t *testing.T) {
			body := cherryTreeBody(nil)
			delete(body["cherry_canopy"].(map[string]any), key)
			if _, err := buildTreeFeature(body, ctx); err == nil {
				t.Fatalf("missing %s: want error", key)
			}
		})
	}
	if _, err := buildTreeFeature(cherryTreeBody(map[string]any{"trunk_width": float64(2)}), ctx); err == nil {
		t.Fatal("trunk_width=2: want a branch-size {1,1} mismatch error")
	}
}

// Distinct radius/height bounds make radius-before-height observable. The
// inclusive +1 also makes this fail if the exclusive int-range draw is substituted.
//
// cherryTreeBody uses the bare `trunk` key, which is the simple trunk and draws nothing for this
// body -- so the sequence is cherry_canopy's two draws alone. Their DISTINCT bounds (3 then 2)
// pin the radius-before-height order.
func TestTreeFeature_CherryCanopyKey_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 12)
	ctx := &BuildContext{Palette: pal, Identifier: "test:cherry", FileID: "test:cherry", Warn: func(string) {}}
	body := cherryTreeBody(map[string]any{
		"radius": map[string]any{"range_min": float64(4), "range_max": float64(6)},
		"height": map[string]any{"range_min": float64(5), "range_max": float64(6)},
	})
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tr := random.NewTracer(random.New(1))
	if got := placeTestTree(f.(*TreeFeature), v, wgen.BlockPos{Y: 10}, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	wantBounds := []int32{3, 2}
	if len(tr.Draws) != len(wantBounds) {
		t.Fatalf("draws = %v, want %d draws", tr.Draws, len(wantBounds))
	}
	for i, want := range wantBounds {
		if d := tr.Draws[i]; d.Method != random.MethodNextIntBound || d.Bound != want {
			t.Fatalf("draw %d = %+v, want NextIntBound(%d); cherry_canopy radius then height, nothing else", i, d, want)
		}
	}
}

// Wide-bottom/corner rolls precede may_replace. Air is not in the stone-only
// allow-list, yet every denominator-tagged roll must still be consumed.
func TestCherryCanopy_PlaceLayer_RollsBeforeAllowListInTraversalOrder(t *testing.T) {
	v, pal := newTreeTestVolume(t, 4)
	leaf := pal.Get("minecraft:cherry_leaves", nil)
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:stone")}, nil, nil, nil)
	c := &cherryCanopy{
		leafID:               leaf,
		trunkWidth:           1,
		wideBottomHoleChance: chanceInformation{percent: 50},
		cornerHoleChance:     chanceInformation{isFraction: true, denominator: 11},
	}
	scripted := &spruceScriptedRandom{
		floats: []float64{0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9}, // wide rolls all false
		bounds: []int{1, 1, 1, 1},                                 // corner rolls all false (numerator defaults to 0, so uint32(draw)<0 is never true)
	}
	tr := random.NewTracer(scripted)
	c.placeLayer(v, wgen.BlockPos{Y: 15}, tr, treeParamsLists{mayReplace: mayReplace}, -1, 1)
	want := []random.Method{
		random.MethodNextFloat, random.MethodNextIntBound,
		random.MethodNextFloat,
		random.MethodNextFloat, random.MethodNextIntBound,
		random.MethodNextFloat, random.MethodNextFloat,
		random.MethodNextFloat, random.MethodNextIntBound,
		random.MethodNextFloat,
		random.MethodNextFloat, random.MethodNextIntBound,
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want methods %v", tr.Draws, want)
	}
	for i, method := range want {
		if d := tr.Draws[i]; d.Method != method {
			t.Fatalf("draw %d = %+v, want method %v", i, d, method)
		}
	}
}

func TestCherryCanopy_Place_DefaultGeometry_ASCII(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	leaf := pal.Get("minecraft:cherry_leaves", nil)
	c := &cherryCanopy{leafID: leaf, heightMin: 5, heightMax: 5, radiusMin: 4, radiusMax: 4, trunkWidth: 1}
	anchor := wgen.BlockPos{Y: 15}
	tr := random.NewTracer(random.New(1))
	c.place(v, anchor, tr, treeParamsLists{}, nil)
	if len(tr.Draws) != 0 {
		t.Fatalf("degenerate ranges and zero chances drew %v, want zero draws", tr.Draws)
	}
	count := 0
	for y := anchor.Y - 2; y <= anchor.Y+2; y++ {
		for x := -4; x <= 4; x++ {
			for z := -4; z <= 4; z++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == leaf {
					count++
				}
			}
		}
	}
	if count != 149 {
		t.Fatalf("leaf count = %d, want 149", count)
	}
	var art strings.Builder
	for y := anchor.Y + 2; y >= anchor.Y-2; y-- {
		for x := -3; x <= 3; x++ {
			if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: 0}) == leaf {
				art.WriteByte('#')
			} else {
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	want := "..###..\n.#####.\n#######\n#######\n.#####.\n"
	t.Logf("cherry_canopy default, vertical X/Y cross-section at Z=0 (# leaves, . air):\n%s", art.String())
	if art.String() != want {
		t.Fatalf("cross-section =\n%s\nwant\n%s", art.String(), want)
	}
}

func TestCherryCanopy_HangingAndExtensionGeometry(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	leaf := pal.Get("minecraft:cherry_leaves", nil)
	c := &cherryCanopy{leafID: leaf, trunkWidth: 1, hangingLeavesChance: chanceInformation{percent: 100}, hangingLeavesExtensionChance: chanceInformation{percent: 100}}
	c.placeLayerWithHanging(v, wgen.BlockPos{Y: 15}, random.New(1), treeParamsLists{}, -2, 2)
	counts := map[int]int{}
	for y := 11; y <= 13; y++ {
		for x := -3; x <= 3; x++ {
			for z := -3; z <= 3; z++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == leaf {
					counts[y]++
				}
			}
		}
	}
	if counts[13] != 25 || counts[12] != 16 || counts[11] != 16 {
		t.Fatalf("layer/hanging/extension counts = %v, want map[13:25 12:16 11:16]", counts)
	}
}

// TestCherryCanopy_HangingExtension_GatedOnPlacementSuccess pins the gate on whether the hanging
// leaf write actually placed a block -- see cherryCanopy's own doc comment:
// hanging_leaves_extension_chance.roll must be called ONLY after the first hanging placement
// actually succeeds, never merely after hanging_leaves_chance succeeds. Every "below" cell is
// pre-occupied with stone, outside the sole may_replace entry (air), so every hanging placement
// fails passesAllowList and hanging_leaves_extension_chance must never be queried. Uses percent=100
// (0 draws) for hangingLeavesChance so it never itself shows up in the trace, and a non-degenerate
// percent=50 (which WOULD draw if reached) for hangingLeavesExtensionChance, so any recorded draw at
// all proves the gate was bypassed.
func TestCherryCanopy_HangingExtension_GatedOnPlacementSuccess(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	leaf := pal.Get("minecraft:cherry_leaves", nil)
	stone := pal.Get("minecraft:stone", nil)
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:air")}, nil, nil, nil)
	c := &cherryCanopy{
		leafID: leaf, trunkWidth: 1,
		hangingLeavesChance:          chanceInformation{percent: 100}, // always true, 0 draws
		hangingLeavesExtensionChance: chanceInformation{percent: 50},  // draws IFF actually reached
	}
	anchor := wgen.BlockPos{Y: 15}
	// Every hanging placement (dy=-1) writes to Y=anchor.Y-2; stone there is not in may_replace, so
	// the single-block write (passesAllowList+SetBlock) must fail for
	// every one of the 4*count edge cells.
	for x := -4; x <= 4; x++ {
		for z := -4; z <= 4; z++ {
			v.SetBlock(wgen.BlockPos{X: anchor.X + x, Y: anchor.Y - 2, Z: anchor.Z + z}, stone)
		}
	}
	tr := random.NewTracer(random.New(1))
	c.placeLayerWithHanging(v, anchor, tr, treeParamsLists{mayReplace: mayReplace}, -1, 1)
	if len(tr.Draws) != 0 {
		t.Fatalf("draws = %v, want ZERO -- hanging_leaves_extension_chance must never be queried when every hanging placement fails", tr.Draws)
	}
	if got := v.GetBlock(wgen.BlockPos{X: anchor.X, Y: anchor.Y - 2, Z: anchor.Z}); got != stone {
		t.Fatalf("expected the pre-placed stone to be left untouched, got %v", pal.Entry(got))
	}
}

// --- mega_trunk: branches --------------------------------------------------------------------------
//
// See tree.go's megaBranches doc comment for the full derivation this test pins.

// TestMegaBranches_Place_RNGDrawSequenceAndGeometry pins megaBranches.place's own draw sequence
// (branch_interval, NextFloat, branch_interval again to end the loop) AND the resulting log
// positions/branch_canopy anchor for a single hand-computable branch, using the SAME full-precision
// float32 pi and truncate-toward-zero arithmetic tree.go's own doc comment cites (the game uses the
// bit-exact float32 pi -- NOT a truncated 3.1416).
func TestMegaBranches_Place_RNGDrawSequenceAndGeometry(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	logID := pal.Get("minecraft:log", nil)
	recording := &recordingTreeCanopy{}
	b := &megaBranches{
		length:      2,
		slope:       0.5,
		intervalMin: 2, intervalMax: 6,
		altitudeMin: 0, altitudeMax: 1,
		canopy: recording,
	}
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	scripted := &spruceScriptedRandom{
		bounds: []int{0, 6}, // interval draws: min+0=2 (first), min+6=8 (second, ends the loop)
		floats: []float64{0},
	}
	tr := random.NewTracer(scripted)
	b.place(v, origin, tr, 10 /* height */, treeParamsLists{}, logID)

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 4}, // branch_interval: 6-2=4 -> level = 10*1+10 - (2+0) = 18
		{random.MethodNextFloat, 0},    // outward angle -- angle=0*pi*2=0, cos=1, sin=0
		{random.MethodNextIntBound, 4}, // branch_interval again: level = 18 - (2+6) = 10, exits (10*0+10=10, not > 10)
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want %d draws", tr.Draws, len(want))
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}

	// startY = int(float32(level-1) - slope*float32(length-1)) = int(float32(17) - 0.5*1) = 16
	// step 0: x = 0+int(1.5+cos(0)*0) = 1; z = 0+int(1.5+sin(0)*0) = 1; y = int(16+0.5*0) = 16
	// step 1: x = 0+int(1.5+cos(0)*1) = 2; z = 0+int(1.5+sin(0)*1) = 1; y = int(16+0.5*1) = 16
	for _, want := range []wgen.BlockPos{{X: 1, Y: 16, Z: 1}, {X: 2, Y: 16, Z: 1}} {
		if got := v.GetBlock(want); got != logID {
			t.Errorf("branch log at %v = %v, want the trunk block", want, pal.Entry(got))
		}
	}

	// The branch_canopy anchor is (lastX, level, lastZ) -- Y is the CURRENT
	// threshold (18) BEFORE this branch's own startY/slope offset, NOT the
	// last placed log's own Y (16) -- see megaBranches' own doc comment.
	wantAnchor := []wgen.BlockPos{{X: 2, Y: 18, Z: 1}}
	if fmt.Sprint(recording.anchors) != fmt.Sprint(wantAnchor) {
		t.Fatalf("branch canopy anchor = %v, want %v", recording.anchors, wantAnchor)
	}
	if len(recording.candidates) != 1 || recording.candidates[0] != nil {
		t.Fatalf("branch canopy candidates = %v, want a single nil (fresh empty) vector", recording.candidates)
	}
}

// TestMegaBranches_Place_ZeroLength_NoOp pins that branch_length<1 draws NOTHING and places nothing
// -- the mega trunk placement's own "branch_length < 1, skip" gate.
func TestMegaBranches_Place_ZeroLength_NoOp(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	logID := pal.Get("minecraft:log", nil)
	b := &megaBranches{length: 0, intervalMin: 2, intervalMax: 6, altitudeMin: 0, altitudeMax: 1}
	tr := random.NewTracer(random.New(1))
	b.place(v, wgen.BlockPos{Y: 10}, tr, 10, treeParamsLists{}, logID)
	if len(tr.Draws) != 0 {
		t.Fatalf("draws = %v, want ZERO", tr.Draws)
	}
}

// --- mega_trunk: trunk_decoration -------------------------------------------------------------------
//
// See tree.go's megaTrunkDecoration doc comment for the full derivation.

// TestMegaTrunkDecoration_Place_DirectionMaskOrderAndRolls pins the fixed west/east/north/south
// roll order of the attachable decoration and that
// a disabled mask direction draws NOTHING, using a fractional chance that genuinely rolls.
func TestMegaTrunkDecoration_Place_DirectionMaskOrderAndRolls(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	vine := pal.Get("minecraft:vine", nil)
	d := &megaTrunkDecoration{
		entries: []megaTrunkDecorationEntry{{blockID: vine, countMin: 1, countMax: 1}},
		chance:  chanceInformation{isFraction: true, numerator: 1, denominator: 2},
		pal:     pal,
	}
	log := wgen.BlockPos{X: 5, Y: 10, Z: 5}
	// west succeeds (draw 0 < 1), east fails (draw 1 !< 1), north succeeds, south is DISABLED
	// (enabled[3]=false) and must not draw at all.
	scripted := &spruceScriptedRandom{bounds: []int{0, 1, 0}}
	tr := random.NewTracer(scripted)
	d.place(v, log, [4]bool{true, true, true, false}, tr)

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 2}, // west roll -- succeeds
		{random.MethodNextIntBound, 2}, // east roll -- fails
		{random.MethodNextIntBound, 2}, // north roll -- succeeds
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want %d draws (west, east, north -- south disabled)", tr.Draws, len(want))
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}

	westDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	northDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 4)
	if got := v.GetBlock(wgen.BlockPos{X: 4, Y: 10, Z: 5}); got != westDecorated {
		t.Errorf("west cell = %v, want vine with west MultiFaceDirectionBits", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 5, Y: 10, Z: 4}); got != northDecorated {
		t.Errorf("north cell = %v, want vine with north MultiFaceDirectionBits", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 6, Y: 10, Z: 5}); pal.IsAir(got) == false {
		t.Errorf("east cell = %v, want air (roll failed)", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 5, Y: 10, Z: 6}); pal.IsAir(got) == false {
		t.Errorf("south cell = %v, want air (direction disabled, never rolled)", pal.Entry(got))
	}
}

// TestMegaTrunkDecoration_Place_MaterialCheckSkipsWithoutConsumingRNG pins that a failed material
// check (existing block not air) skips placement WITHOUT drawing the count/steps RNG -- the "count"
// draw only happens after both the roll AND the material check succeed (see megaTrunkDecoration's
// doc comment).
func TestMegaTrunkDecoration_Place_MaterialCheckSkipsWithoutConsumingRNG(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	stone := pal.Get("minecraft:stone", nil)
	vine := pal.Get("minecraft:vine", nil)
	log := wgen.BlockPos{X: 5, Y: 10, Z: 5}
	v.SetBlock(wgen.BlockPos{X: 4, Y: 10, Z: 5}, stone) // occupy the west cell
	d := &megaTrunkDecoration{
		// A non-degenerate count range so a real draw would be visible if
		// wrongly reached.
		entries: []megaTrunkDecorationEntry{{blockID: vine, countMin: 1, countMax: 3}},
		chance:  chanceInformation{percent: 100}, // always succeeds, 0 draws
		pal:     pal,
	}
	tr := random.NewTracer(random.New(1))
	d.place(v, log, [4]bool{true, false, false, false}, tr)
	if len(tr.Draws) != 0 {
		t.Fatalf("draws = %v, want ZERO -- the material check failed, so count must never be drawn", tr.Draws)
	}
	if got := v.GetBlock(wgen.BlockPos{X: 4, Y: 10, Z: 5}); got != stone {
		t.Fatalf("west cell = %v, want the pre-placed stone left untouched", pal.Entry(got))
	}
}

// TestMegaTrunkDecoration_Place_SequenceEntriesContinuePositionAndAlwaysDrawCount pins
// the multi-decoration write's own per-entry-sequence shape: position CONTINUES across
// entries (no reset), and EVERY entry draws its own count via treeIntRangeValueInclusive
// UNCONDITIONALLY, even when a later entry's own material check fails -- see megaTrunkDecoration's
// own doc comment. Two entries, both non-degenerate counts, so both draws are visible.
func TestMegaTrunkDecoration_Place_SequenceEntriesContinuePositionAndAlwaysDrawCount(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	vine := pal.Get("minecraft:vine", nil)
	moss := pal.Get("minecraft:moss_block", nil)
	log := wgen.BlockPos{X: 5, Y: 10, Z: 5}
	d := &megaTrunkDecoration{
		entries: []megaTrunkDecorationEntry{
			{blockID: vine, countMin: 1, countMax: 2},
			{blockID: moss, countMin: 1, countMax: 2},
		},
		chance: chanceInformation{percent: 100}, // always succeeds, 0 draws
		pal:    pal,
	}
	// west roll succeeds with 0 draws (percent=100); then entry[0].count draws
	// bound=2 (countMax-countMin+1), entry[1].count draws bound=2.
	scripted := &spruceScriptedRandom{bounds: []int{2, 2}}
	tr := random.NewTracer(scripted)
	d.place(v, log, [4]bool{true, false, false, false}, tr)

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 2}, // entry[0] (vine) count draw
		{random.MethodNextIntBound, 2}, // entry[1] (moss) count draw
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want %d draws (one count draw per entry)", tr.Draws, len(want))
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}

	// The draw SEQUENCE (method+bound, asserted above) is this test's load-bearing fact --
	// entry[1] draws its own count even though entry[0] already consumed the roll's material
	// gate. This placement check just confirms entry[0] actually placed into the enabled
	// (west) direction rather than silently no-op'ing.
	westFirst := wgen.BlockPos{X: 4, Y: 10, Z: 5}
	if got := v.GetBlock(westFirst); pal.IsAir(got) {
		t.Fatalf("west-adjacent cell = air, want entry[0]'s vine placed")
	}
}

// --- mega_trunk: schema -----------------------------------------------------------------------------

func vanillaMegaJungleTrunkBody() map[string]any {
	return map[string]any{
		"mega_trunk": map[string]any{
			"trunk_width":  float64(2),
			"trunk_height": map[string]any{"base": float64(10), "intervals": []any{float64(3), float64(20)}},
			"trunk_block":  "minecraft:log",
			"trunk_decoration": map[string]any{
				"decoration_block":  "minecraft:vine",
				"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(3)},
			},
			"branches": map[string]any{
				"branch_length":          float64(5),
				"branch_slope":           float64(0.5),
				"branch_interval":        map[string]any{"range_min": float64(2), "range_max": float64(6)},
				"branch_altitude_factor": map[string]any{"min": float64(0.5), "max": float64(1.0)},
				"branch_canopy": map[string]any{
					"mega_canopy": map[string]any{
						"canopy_height":   map[string]any{"range_min": float64(2), "range_max": float64(4)},
						"base_radius":     float64(1),
						"simplify_canopy": true,
						"leaf_block":      map[string]any{"name": "minecraft:leaves", "states": map[string]any{"old_leaf_type": "jungle"}},
					},
				},
			},
		},
		"mega_canopy": map[string]any{
			"canopy_height": float64(3),
			"base_radius":   float64(2),
			"core_width":    float64(2),
			"leaf_block":    map[string]any{"name": "minecraft:leaves", "states": map[string]any{"old_leaf_type": "jungle"}},
		},
		"may_replace": []any{"minecraft:air"},
	}
}

func TestBuildTreeFeature_MegaTrunk_BranchesAndDecoration_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:mega", FileID: "test:mega", Warn: func(string) {}}

	built, err := buildTreeFeature(vanillaMegaJungleTrunkBody(), ctx)
	if err != nil {
		t.Fatalf("vanilla-shaped mega_jungle body: %v", err)
	}
	tf := built.(*TreeFeature)
	if len(tf.warnings) != 0 {
		t.Fatalf("warnings = %v, want none -- trunk_decoration and branches are both implemented", tf.warnings)
	}
	if tf.shaped == nil || tf.shaped.branches == nil || tf.shaped.decoration == nil {
		t.Fatalf("shaped.branches/decoration = %v/%v, want both non-nil", tf.shaped.branches, tf.shaped.decoration)
	}
	if _, ok := tf.shaped.branches.canopy.(*megaCanopy); !ok {
		t.Fatalf("branch canopy = %T, want *megaCanopy", tf.shaped.branches.canopy)
	}

	for _, tc := range []struct {
		name   string
		mutate func(body map[string]any)
	}{
		{"trunk_decoration_requires_decoration_chance", func(body map[string]any) {
			delete(body["mega_trunk"].(map[string]any)["trunk_decoration"].(map[string]any), "decoration_chance")
		}},
		{"trunk_decoration_refuses_empty_decoration_blocks_sequence", func(body map[string]any) {
			body["mega_trunk"].(map[string]any)["trunk_decoration"].(map[string]any)["decoration_blocks_sequence"] = []any{}
		}},
		{"branches_requires_branch_length", func(body map[string]any) {
			delete(body["mega_trunk"].(map[string]any)["branches"].(map[string]any), "branch_length")
		}},
		{"branches_requires_branch_slope", func(body map[string]any) {
			delete(body["mega_trunk"].(map[string]any)["branches"].(map[string]any), "branch_slope")
		}},
		{"branches_requires_branch_interval", func(body map[string]any) {
			delete(body["mega_trunk"].(map[string]any)["branches"].(map[string]any), "branch_interval")
		}},
		{"branches_requires_branch_altitude_factor", func(body map[string]any) {
			delete(body["mega_trunk"].(map[string]any)["branches"].(map[string]any), "branch_altitude_factor")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := vanillaMegaJungleTrunkBody()
			tc.mutate(body)
			if _, err := buildTreeFeature(body, ctx); err == nil {
				t.Fatal("want error")
			}
		})
	}

	t.Run("trunk_decoration_is_optional", func(t *testing.T) {
		body := vanillaMegaJungleTrunkBody()
		delete(body["mega_trunk"].(map[string]any), "trunk_decoration")
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("optional trunk_decoration: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.shaped.decoration != nil {
			t.Fatalf("decoration = %v, want nil", tf.shaped.decoration)
		}
		for _, w := range tf.warnings {
			if strings.Contains(w, "trunk_decoration") {
				t.Fatalf("warnings = %v, want none mentioning trunk_decoration once absent", tf.warnings)
			}
		}
	})

	t.Run("trunk_decoration_accepts_decoration_blocks_sequence", func(t *testing.T) {
		body := vanillaMegaJungleTrunkBody()
		dec := body["mega_trunk"].(map[string]any)["trunk_decoration"].(map[string]any)
		delete(dec, "decoration_block")
		dec["decoration_blocks_sequence"] = []any{
			map[string]any{"block": "minecraft:vine"},
			map[string]any{"block": "minecraft:moss_block", "count": map[string]any{"range_min": float64(1), "range_max": float64(3)}},
		}
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("decoration_blocks_sequence: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.shaped.decoration == nil {
			t.Fatal("decoration = nil, want non-nil")
		}
		if got := len(tf.shaped.decoration.entries); got != 2 {
			t.Fatalf("entries = %d, want 2", got)
		}
		e0, e1 := tf.shaped.decoration.entries[0], tf.shaped.decoration.entries[1]
		if e0.countMin != 1 || e0.countMax != 1 {
			t.Errorf("entries[0].count = {%d,%d}, want default {1,1}", e0.countMin, e0.countMax)
		}
		if e1.countMin != 1 || e1.countMax != 3 {
			t.Errorf("entries[1].count = {%d,%d}, want {1,3}", e1.countMin, e1.countMax)
		}
	})

	t.Run("branches_is_optional", func(t *testing.T) {
		body := vanillaMegaJungleTrunkBody()
		delete(body["mega_trunk"].(map[string]any), "branches")
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("optional branches: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.shaped.branches != nil {
			t.Fatalf("branches = %v, want nil", tf.shaped.branches)
		}
		for _, w := range tf.warnings {
			if strings.Contains(w, "branches") {
				t.Fatalf("warnings = %v, want none mentioning branches once absent", tf.warnings)
			}
		}
	})

	t.Run("branch_canopy_is_optional", func(t *testing.T) {
		body := vanillaMegaJungleTrunkBody()
		delete(body["mega_trunk"].(map[string]any)["branches"].(map[string]any), "branch_canopy")
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("optional branch_canopy: %v", err)
		}
		if built.(*TreeFeature).shaped.branches.canopy != nil {
			t.Fatalf("branch canopy = %v, want nil", built.(*TreeFeature).shaped.branches.canopy)
		}
	})
}

// --- mega_trunk: end-to-end Place() -------------------------------------------------------------------

// TestTreeFeature_MegaTrunk_FullRNGDrawSequenceAndPlacement builds and places a controlled
// mega_trunk tree (trunk_decoration with an always-succeeding percent chance and a degenerate
// {1,1} step count -- both draw ZERO RNG, see megaTrunkDecoration's own doc comment -- and
// mega_canopy's own degenerate canopy_height=1, also ZERO draws) end to end, pinning that the
// COMPLETE draw sequence for the whole Place() call is exactly the 3 branch draws this file's
// own TestMegaBranches_Place_RNGDrawSequenceAndGeometry already isolates.
//
// It also pins the COLUMN SHAPE. The game builds the column in three pieces, not two:
//
//	y = 0            width x width, and NO decoration at all
//	y = 1..height-2  width x width WITH decoration
//	top              exactly ONE cell on the origin column at origin.Y+height-1
//
// This port used to decorate y = 0 and write a width x width TOP layer, so at the default
// trunk_width of 2 it wrote four top logs where the game writes one, and made up to width^2
// surplus decoration calls per tree. With height 4 and origin.Y 10 that puts the undecorated
// layer at Y=10, the decorated layers at Y=11 and Y=12, and the single top log at (0,13,0) --
// all four asserted below, because the draw sequence alone cannot see any of it (this body's
// decoration chance is degenerate and draws nothing either way).
//
// The canopy is dispatched FIRST here (if present), before the branches. It is invisible in the
// draw list only because canopy_height is degenerate; its
// ordering is pinned by TestMegaBranches_Place_RNGDrawSequenceAndGeometry's siblings, not here.
func TestTreeFeature_MegaTrunk_FullRNGDrawSequenceAndPlacement(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	vine := pal.Get("minecraft:vine", nil)
	logID := pal.Get("minecraft:log", nil)

	body := map[string]any{
		"mega_trunk": map[string]any{
			"trunk_width":  float64(2),
			"trunk_height": map[string]any{"base": float64(4)}, // no intervals -- 0 draws
			"trunk_block":  "minecraft:log",
			"trunk_decoration": map[string]any{
				"decoration_block":  "minecraft:vine",
				"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(1)}, // always true, 0 draws
			},
			"branches": map[string]any{
				"branch_length":          float64(2),
				"branch_slope":           float64(0.5),
				"branch_interval":        map[string]any{"range_min": float64(2), "range_max": float64(6)},
				"branch_altitude_factor": map[string]any{"min": float64(0.0), "max": float64(1.0)},
			},
		},
		"mega_canopy": map[string]any{
			"canopy_height": float64(1), // degenerate {1,1} -- 0 draws
			"base_radius":   float64(0),
			"core_width":    float64(2),
			"leaf_block":    "minecraft:leaves",
		},
		"may_replace": []any{"minecraft:air"},
	}
	ctx := &BuildContext{Palette: pal, Identifier: "test:mega2", FileID: "test:mega2", Warn: func(string) {}}
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := built.(*TreeFeature)
	if len(tf.warnings) != 0 {
		t.Fatalf("warnings = %v, want none", tf.warnings)
	}

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	scripted := &spruceScriptedRandom{
		bounds: []int{0, 6}, // branch_interval: 2+0=2 (starts), then 2+6=8 (ends the loop)
		floats: []float64{0},
	}
	tr := random.NewTracer(scripted)
	if got := placeTestTree(tf, v, origin, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 4}, // branch_interval (first)
		{random.MethodNextFloat, 0},    // branch angle
		{random.MethodNextIntBound, 4}, // branch_interval (second, ends the branches loop)
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want exactly the 3 branch draws (branches before column, decoration/canopy both degenerate)", tr.Draws)
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}

	// The single branch (angle=0, length=2) places logs at (1,10,1) and (2,10,1) -- see
	// TestMegaBranches_Place_RNGDrawSequenceAndGeometry for the derivation (height=10 there vs. 4
	// here changes topThreshold/level but startY still comes out to the SAME 10, since this test's
	// altitude_factor is {0,1} against a shorter height=4: topThreshold=4+10=14, level after the
	// first draw = 14-2=12, startY = int(float32(11) - 0.5) = 10).
	for _, want := range []wgen.BlockPos{{X: 1, Y: 10, Z: 1}, {X: 2, Y: 10, Z: 1}} {
		if got := v.GetBlock(want); got != logID {
			t.Errorf("branch log at %v = %v, want the trunk block", want, pal.Entry(got))
		}
	}

	// (1,10,1) is BOTH a branch-log cell AND one of the bottom layer's own footprint cells
	// (dx=1,dz=1 at Y=10) -- the branch log, placed first and unconditionally, occupies it, so the
	// column's own isValidTreePosition gate must find it already non-air and skip re-placing it.
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 10, Z: 1}); got != logID {
		t.Errorf("shadowed cell (1,10,1) = %v, want the branch's own log", pal.Entry(got))
	}

	westDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	northDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 4)

	// The BOTTOM layer (Y = origin.Y) gets no decoration call at all, so no cell around it may
	// hold a vine. This is the half of the column-shape fix that REMOVES writes: every one of these
	// cells used to be decorated. Checked for the absence of a vine rather than for air, since a
	// branch log legitimately sits in this layer.
	for _, dx := range []int{0, 1} {
		for _, dz := range []int{0, 1} {
			for _, offset := range []wgen.BlockPos{{X: -1}, {X: 1}, {Z: -1}, {Z: 1}} {
				p := wgen.BlockPos{X: dx + offset.X, Y: 10, Z: dz + offset.Z}
				if got := v.GetBlock(p); pal.Entry(got).Name == "minecraft:vine" {
					t.Errorf("bottom-layer neighbour %v = %v, want no vine (y=0 is never decorated)", p, pal.Entry(got))
				}
			}
		}
	}

	// (0,0)@Y=11 is a normal, unshadowed MIDDLE-layer cell: west+north enabled. Y=11 is the
	// lowest decorated layer, and the fix is what moved this pair up from Y=10.
	if got := v.GetBlock(wgen.BlockPos{X: -1, Y: 11, Z: 0}); got != westDecorated {
		t.Errorf("west vine at (-1,11,0) = %v, want vine with west bit", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 11, Z: -1}); got != northDecorated {
		t.Errorf("north vine at (0,11,-1) = %v, want vine with north bit", pal.Entry(got))
	}

	// The top is ONE cell on the origin column, not a width x width layer. This is the half of
	// the fix that removes GEOMETRY: (1,13,0), (0,13,1) and (1,13,1) used to be logs too.
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 13, Z: 0}); got != logID {
		t.Errorf("top cell (0,13,0) = %v, want the trunk block", pal.Entry(got))
	}
	for _, extra := range []wgen.BlockPos{{X: 1, Y: 13, Z: 0}, {X: 0, Y: 13, Z: 1}, {X: 1, Y: 13, Z: 1}} {
		if got := v.GetBlock(extra); got == logID {
			t.Errorf("top cell %v = a trunk log, want none (the game's top is a single cell)", extra)
		}
	}

	// The top cell is decorated with an all-zero direction mask, which cannot place anything --
	// so no vine around it either.
	for _, offset := range []wgen.BlockPos{{X: -1}, {X: 1}, {Z: -1}, {Z: 1}} {
		p := wgen.BlockPos{X: offset.X, Y: 13, Z: offset.Z}
		if got := v.GetBlock(p); pal.Entry(got).Name == "minecraft:vine" {
			t.Errorf("top-cell neighbour %v = %v, want no vine (its mask is all-zero)", p, pal.Entry(got))
		}
	}
}

// TestTreeFeature_MegaTrunk_NumStepsAcceptedButUnused proves trunk_decoration.num_steps is a true
// no-op for mega_trunk, not merely "no longer refused at parse time": builds the SAME body used by
// TestTreeFeature_MegaTrunk_FullRNGDrawSequenceAndPlacement twice, once with num_steps added to
// trunk_decoration and once without, places both against separately-scripted (but identically
// configured) RNG instances, and requires BOTH the exact draw sequence AND the placed blocks to
// be identical. If a future change ever wires num_steps into the multi-decoration write's own placement
// count, this test fails (either the draw count changes, or the vine run length at (-1,10,0)
// changes) -- pinning behavior, not just absence of an error.
func TestTreeFeature_MegaTrunk_NumStepsAcceptedButUnused(t *testing.T) {
	build := func(t *testing.T, withNumSteps bool) (*TreeFeature, *volume.Volume, *block.Palette) {
		v, pal := newTreeTestVolume(t, 10)
		decoration := map[string]any{
			"decoration_block":  "minecraft:vine",
			"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(1)},
		}
		if withNumSteps {
			decoration["num_steps"] = float64(3)
		}
		body := map[string]any{
			"mega_trunk": map[string]any{
				"trunk_width":      float64(2),
				"trunk_height":     map[string]any{"base": float64(4)},
				"trunk_block":      "minecraft:log",
				"trunk_decoration": decoration,
				"branches": map[string]any{
					"branch_length":          float64(2),
					"branch_slope":           float64(0.5),
					"branch_interval":        map[string]any{"range_min": float64(2), "range_max": float64(6)},
					"branch_altitude_factor": map[string]any{"min": float64(0.0), "max": float64(1.0)},
				},
			},
			"mega_canopy": map[string]any{
				"canopy_height": float64(1),
				"base_radius":   float64(0),
				"core_width":    float64(2),
				"leaf_block":    "minecraft:leaves",
			},
			"may_replace": []any{"minecraft:air"},
		}
		ctx := &BuildContext{Palette: pal, Identifier: "test:mega3", FileID: "test:mega3", Warn: func(string) {}}
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("buildTreeFeature(withNumSteps=%v): %v", withNumSteps, err)
		}
		return built.(*TreeFeature), v, pal
	}

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	newScripted := func() *spruceScriptedRandom {
		return &spruceScriptedRandom{bounds: []int{0, 6}, floats: []float64{0}}
	}

	tfWithout, vWithout, palWithout := build(t, false)
	trWithout := random.NewTracer(newScripted())
	if got := placeTestTree(tfWithout, vWithout, origin, trWithout); got == nil {
		t.Fatal("Place() (without num_steps) = nil, want success")
	}

	tfWith, vWith, palWith := build(t, true)
	trWith := random.NewTracer(newScripted())
	if got := placeTestTree(tfWith, vWith, origin, trWith); got == nil {
		t.Fatal("Place() (with num_steps) = nil, want success")
	}

	if len(trWithout.Draws) != len(trWith.Draws) {
		t.Fatalf("draw count = %d (with num_steps) vs %d (without), want identical", len(trWith.Draws), len(trWithout.Draws))
	}
	for i := range trWithout.Draws {
		if trWithout.Draws[i] != trWith.Draws[i] {
			t.Fatalf("draw %d = %+v (without) vs %+v (with num_steps), want identical", i, trWithout.Draws[i], trWith.Draws[i])
		}
	}

	// Spot-check the same decorated cell TestTreeFeature_MegaTrunk_FullRNGDrawSequenceAndPlacement
	// pins: a single vine block (run length 1, i.e. NOT extended to 3 by num_steps) west of
	// (0,11,0). Y=11, not Y=10: the bottom layer of a mega column takes no decoration call at all
	// (see that test's header), so Y=10 would pass vacuously -- the
	// cell would be air whether or not num_steps did anything.
	vine := palWithout.Get("minecraft:vine", nil)
	westDecorated, _ := palWithout.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	for name, v := range map[string]*volume.Volume{"without": vWithout, "with": vWith} {
		if got := v.GetBlock(wgen.BlockPos{X: -1, Y: 11, Z: 0}); got != westDecorated {
			t.Errorf("[%s num_steps] west vine at (-1,11,0) = %v, want vine with west bit only", name, palWith.Entry(got))
		}
		if got := v.GetBlock(wgen.BlockPos{X: -2, Y: 11, Z: 0}); !palWithout.IsAir(got) {
			t.Errorf("[%s num_steps] (-2,11,0) = %v, want air (num_steps must NOT extend the vine run)", name, palWith.Entry(got))
		}
	}
}

// --- base_cluster (the tree parameters' own base-cluster placement) ------------------------------
//
// See baseCluster's own doc comment in tree.go for the full schema/draw-sequence derivation.

// intBoundScriptedRandom scripts ONLY NextIntBound's return values, in call order; panics on any
// other method (proving a test that expects zero draws of a given kind truly gets zero) or an
// exhausted script (an extra draw fails loudly instead of silently reading a zero value).
type intBoundScriptedRandom struct {
	vals []int
	idx  int
}

func (s *intBoundScriptedRandom) NextIntBound(int) int {
	v := s.vals[s.idx]
	s.idx++
	return v
}
func (s *intBoundScriptedRandom) NextInt() int32                { panic("unused") }
func (s *intBoundScriptedRandom) NextFloat() float64            { panic("unused") }
func (s *intBoundScriptedRandom) NextDouble() float64           { panic("unused") }
func (s *intBoundScriptedRandom) NextBoolean() bool             { panic("unused") }
func (s *intBoundScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (s *intBoundScriptedRandom) SetSeed(uint32)                {}
func (s *intBoundScriptedRandom) GetSeed() uint32               { return 0 }

var _ random.IRandom = (*intBoundScriptedRandom)(nil)

// panicRandom draws nothing, ever -- used to prove a gated code path takes ZERO draws (any call at
// all fails the test immediately, rather than silently succeeding on a script that happens to have
// enough entries).
type panicRandom struct{}

func (panicRandom) NextIntBound(int) int          { panic("unexpected draw: NextIntBound") }
func (panicRandom) NextInt() int32                { panic("unexpected draw: NextInt") }
func (panicRandom) NextFloat() float64            { panic("unexpected draw: NextFloat") }
func (panicRandom) NextDouble() float64           { panic("unexpected draw: NextDouble") }
func (panicRandom) NextBoolean() bool             { panic("unexpected draw: NextBoolean") }
func (panicRandom) NextUnsignedInt(uint32) uint32 { panic("unexpected draw: NextUnsignedInt") }
func (panicRandom) SetSeed(uint32)                {}
func (panicRandom) GetSeed() uint32               { return 0 }

var _ random.IRandom = panicRandom{}

// TestBuildTreeFeature_BaseCluster_SchemaValidation pins base_cluster's required/optional shape:
// optional at the top level (absent -> nil, no error); once present, may_replace/num_clusters/
// cluster_radius are ALL required; and a
// base_cluster configured on a NON-mega_trunk shape parses fine (the real schema is not
// trunk-kind-conditional) but produces the "not implemented" warning, since no other trunk shape's
// placement ever calls the base-cluster placement.
func TestBuildTreeFeature_BaseCluster_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:basecluster", FileID: "test:basecluster", Warn: func(string) {}}

	megaBody := func(mutateBaseCluster func(bc map[string]any)) map[string]any {
		bc := map[string]any{
			"may_replace":    []any{"minecraft:dirt"},
			"num_clusters":   float64(4),
			"cluster_radius": float64(1),
		}
		if mutateBaseCluster != nil {
			mutateBaseCluster(bc)
		}
		return map[string]any{
			"mega_trunk": map[string]any{
				"trunk_width":  float64(2),
				"trunk_height": map[string]any{"base": float64(4)},
				"trunk_block":  "minecraft:log",
			},
			"mega_canopy": map[string]any{
				"canopy_height": float64(1),
				"base_radius":   float64(0),
				"core_width":    float64(2),
				"leaf_block":    "minecraft:leaves",
			},
			"may_replace":  []any{"minecraft:air"},
			"base_cluster": bc,
		}
	}

	t.Run("absent_is_a_pure_no-op", func(t *testing.T) {
		body := megaBody(nil)
		delete(body, "base_cluster")
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("base_cluster-less body: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.baseCluster != nil {
			t.Fatalf("baseCluster = %v, want nil", tf.baseCluster)
		}
		if len(tf.warnings) != 0 {
			t.Fatalf("warnings = %v, want none", tf.warnings)
		}
	})

	t.Run("valid_body_builds_with_no_warning", func(t *testing.T) {
		built, err := buildTreeFeature(megaBody(nil), ctx)
		if err != nil {
			t.Fatalf("valid base_cluster: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.baseCluster == nil {
			t.Fatal("baseCluster = nil, want non-nil")
		}
		if tf.baseCluster.numClusters != 4 || tf.baseCluster.clusterRadius != 1 {
			t.Errorf("numClusters/clusterRadius = %d/%d, want 4/1", tf.baseCluster.numClusters, tf.baseCluster.clusterRadius)
		}
		if tf.baseCluster.mayReplace.Empty() {
			t.Error("mayReplace = empty, want non-empty")
		}
		for _, w := range tf.warnings {
			if strings.Contains(w, "base_cluster") {
				t.Fatalf("warnings = %v, want none mentioning base_cluster", tf.warnings)
			}
		}
	})

	for _, tc := range []struct {
		name   string
		mutate func(bc map[string]any)
	}{
		{"requires_may_replace", func(bc map[string]any) { delete(bc, "may_replace") }},
		{"requires_num_clusters", func(bc map[string]any) { delete(bc, "num_clusters") }},
		{"requires_cluster_radius", func(bc map[string]any) { delete(bc, "cluster_radius") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := buildTreeFeature(megaBody(tc.mutate), ctx); err == nil {
				t.Fatal("want error")
			}
		})
	}

	t.Run("not_an_object_is_an_error", func(t *testing.T) {
		body := megaBody(nil)
		body["base_cluster"] = float64(1)
		if _, err := buildTreeFeature(body, ctx); err == nil {
			t.Fatal("want error")
		}
	})

	t.Run("warns_when_present_on_a_non-mega_trunk", func(t *testing.T) {
		body := simpleTreeBody(nil)
		body["base_cluster"] = map[string]any{
			"may_replace":    []any{"minecraft:dirt"},
			"num_clusters":   float64(4),
			"cluster_radius": float64(1),
		}
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("base_cluster on acacia_trunk-shaped body: %v", err)
		}
		tf := built.(*TreeFeature)
		found := false
		for _, w := range tf.warnings {
			if strings.Contains(w, "base_cluster") {
				found = true
			}
		}
		if !found {
			t.Fatalf("warnings = %v, want one mentioning base_cluster", tf.warnings)
		}
	})
}

// baseClusterTestVolume returns an all-air (well beyond the requested radius) volume with a dirt
// floor far below the test Y so no scan probe ever sees anything but air -- isolating
// placeBaseClusterGroundwork's own geometry/draw sequence from any "found the ground" complexity
// (that complexity belongs to TestReplaceBaseBlockAt_VerticalScanOrderAndShortCircuit instead).
func baseClusterTestVolume(t *testing.T, radius int) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	bounds := volume.Bounds{MinX: -radius, MinY: 0, MinZ: -radius, SizeX: 2*radius + 1, SizeY: 40, SizeZ: 2*radius + 1}
	return volume.New(bounds, pal, air), pal
}

// TestPlaceBaseClusterGroundwork_GateOnNumClustersLessEqualZero pins the caller-side pre-check
// (in the mega trunk's placement: num_clusters <= 0 skips the call entirely) as a
// SEPARATE gate from the base-cluster placement's own internal may_replace-emptiness check: num_clusters<=0
// skips EVERYTHING, including the four fixed corners that would otherwise fire unconditionally.
// panicRandom proves zero draws for both num_clusters==0 and a negative value.
func TestPlaceBaseClusterGroundwork_GateOnNumClustersLessEqualZero(t *testing.T) {
	for _, numClusters := range []int{0, -1, -5} {
		t.Run(fmt.Sprintf("numClusters=%d", numClusters), func(t *testing.T) {
			v, pal := baseClusterTestVolume(t, 10)
			bc := &baseCluster{
				mayReplace:         pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:dirt"}, {Name: "minecraft:air"}}, nil, nil, nil),
				mayReplaceFallback: pal.Get("minecraft:dirt", nil),
				numClusters:        numClusters,
				clusterRadius:      2,
			}
			origin := wgen.BlockPos{X: 0, Y: 20, Z: 0}
			placeBaseClusterGroundwork(v, origin, 2, panicRandom{}, bc)
			for x := -6; x <= 6; x++ {
				for z := -6; z <= 6; z++ {
					for dy := -5; dy <= 3; dy++ {
						p := wgen.BlockPos{X: x, Y: 19 + dy, Z: z}
						if got := v.GetBlock(p); !pal.IsAir(got) {
							t.Fatalf("%v = %v, want air (num_clusters<=0 must place nothing)", p, pal.Entry(got))
						}
					}
				}
			}
		})
	}
}

// TestPlaceBaseClusterGroundwork_GateOnEmptyMayReplace pins the base-cluster placement's OWN
// internal gate
// (may_replace must be non-empty): an empty may_replace skips everything too, even with a
// positive num_clusters. panicRandom proves zero draws.
func TestPlaceBaseClusterGroundwork_GateOnEmptyMayReplace(t *testing.T) {
	v, pal := baseClusterTestVolume(t, 10)
	bc := &baseCluster{numClusters: 5, clusterRadius: 2} // mayReplace zero-value == Empty()
	origin := wgen.BlockPos{X: 0, Y: 20, Z: 0}
	placeBaseClusterGroundwork(v, origin, 2, panicRandom{}, bc)
	for x := -6; x <= 6; x++ {
		for z := -6; z <= 6; z++ {
			p := wgen.BlockPos{X: x, Y: 19, Z: z}
			if got := v.GetBlock(p); !pal.IsAir(got) {
				t.Fatalf("%v = %v, want air (empty may_replace must place nothing)", p, pal.Entry(got))
			}
		}
	}
}

// TestPlaceBaseClusterGroundwork_FourCornersGeometry pins the four FIXED corner
// circle-replacement calls' positions -- {-1,-1}/{reach,-1}/{-1,reach}/{reach,reach} relative
// to pos={origin.X,origin.Y-1,origin.Z} -- using clusterRadius=1 (a "plus" footprint: center + 4
// orthogonal neighbors, corners clipped) so each fixed corner's own footprint is unambiguous. The
// single scripted draw (r=27 -> qx=3,rem=3, interior, non-border) is chosen to place NOTHING from
// the random loop, isolating the four corners entirely; pos itself (the loop's own would-be
// interior target) is checked to confirm this.
func TestPlaceBaseClusterGroundwork_FourCornersGeometry(t *testing.T) {
	v, pal := baseClusterTestVolume(t, 15)
	dirt := pal.Get("minecraft:dirt", nil)
	bc := &baseCluster{
		mayReplace:         pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:dirt"}, {Name: "minecraft:air"}}, nil, nil, nil),
		mayReplaceFallback: dirt,
		numClusters:        1,
		clusterRadius:      1,
	}
	origin := wgen.BlockPos{X: 0, Y: 20, Z: 0}
	reach := 2
	rnd := &intBoundScriptedRandom{vals: []int{27}}
	placeBaseClusterGroundwork(v, origin, reach, rnd, bc)
	if rnd.idx != 1 {
		t.Fatalf("draws consumed = %d, want exactly 1", rnd.idx)
	}

	pos := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
	corners := []wgen.BlockPos{
		{X: pos.X - 1, Y: pos.Y, Z: pos.Z - 1},
		{X: pos.X + reach, Y: pos.Y, Z: pos.Z - 1},
		{X: pos.X - 1, Y: pos.Y, Z: pos.Z + reach},
		{X: pos.X + reach, Y: pos.Y, Z: pos.Z + reach},
	}
	// Every cell replaceBaseBlockCircle visits gets routed through replaceBaseBlockAt's OWN
	// six-probe vertical scan (dy=+2,+1,0,...); in this all-air volume the FIRST probe (dy=+2)
	// always already qualifies (existing=air != target=dirt, and air passes the allow-list), so
	// every actual placement lands at Y+2, not at the nominal circle Y -- atY below.
	for _, c := range corners {
		atY := c.Y + 2
		plus := []wgen.BlockPos{
			{X: c.X, Y: atY, Z: c.Z},
			{X: c.X + 1, Y: atY, Z: c.Z}, {X: c.X - 1, Y: atY, Z: c.Z},
			{X: c.X, Y: atY, Z: c.Z + 1}, {X: c.X, Y: atY, Z: c.Z - 1},
		}
		for _, p := range plus {
			if got := v.GetBlock(p); got != dirt {
				t.Errorf("corner-circle cell %v = %v, want dirt (corner center %v)", p, pal.Entry(got), c)
			}
		}
		// The diagonal neighbor is the clipped corner of THIS circle's own radius-1 square --
		// must stay air.
		diag := wgen.BlockPos{X: c.X + 1, Y: atY, Z: c.Z + 1}
		if got := v.GetBlock(diag); !pal.IsAir(got) {
			t.Errorf("clipped diagonal %v = %v, want air (radius-1 circle excludes its own corners)", diag, pal.Entry(got))
		}
	}

	// The random loop's own single draw (r=27, interior) must place nothing at pos itself
	// (checked across the same +2/+1/0/-1/-2/-3 scan window replaceBaseBlockAt would have used).
	for _, dy := range []int{2, 1, 0, -1, -2, -3} {
		p := wgen.BlockPos{X: pos.X, Y: pos.Y + dy, Z: pos.Z}
		if got := v.GetBlock(p); !pal.IsAir(got) {
			t.Errorf("pos+dy%d %v = %v, want air (interior draw r=27 must not place anything)", dy, p, pal.Entry(got))
		}
	}
}

// TestPlaceBaseClusterGroundwork_RandomLoopBorderSelection pins the random loop's own draw
// sequence and its qx,rem := r/8, r%8 border decomposition (qx==0||qx==7||rem==0||rem==7 ->
// replaceBaseBlockCircle at offset {rem-3,qx-3} from pos; interior r values place nothing), with
// EVERY one of the four OR-branches independently isolated by its own r value, plus one interior
// (non-placing) draw. reach is set far enough away (10, in a wide-enough volume) that the four
// fixed corners' own circles cannot overlap any cell this test inspects -- see the inline offset
// arithmetic for the non-overlap proof.
func TestPlaceBaseClusterGroundwork_RandomLoopBorderSelection(t *testing.T) {
	v, pal := baseClusterTestVolume(t, 20)
	dirt := pal.Get("minecraft:dirt", nil)
	bc := &baseCluster{
		mayReplace:         pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:dirt"}, {Name: "minecraft:air"}}, nil, nil, nil),
		mayReplaceFallback: dirt,
		numClusters:        5,
		clusterRadius:      1,
	}
	origin := wgen.BlockPos{X: 0, Y: 20, Z: 0}
	pos := wgen.BlockPos{X: origin.X, Y: origin.Y - 1, Z: origin.Z}
	reach := 10

	// r=3: qx=0,rem=3 -> qx==0 branch only.        offset=(rem-3,qx-3)=(0,-3)
	// r=59: qx=7,rem=3 -> qx==7 branch only.        offset=(0,4)
	// r=24: qx=3,rem=0 -> rem==0 branch only.       offset=(-3,0)
	// r=31: qx=3,rem=7 -> rem==7 branch only.       offset=(4,0)
	// r=27: qx=3,rem=3 -> interior, no branch.      no placement
	rnd := &intBoundScriptedRandom{vals: []int{3, 59, 24, 31, 27}}
	placeBaseClusterGroundwork(v, origin, reach, rnd, bc)
	if rnd.idx != 5 {
		t.Fatalf("draws consumed = %d, want exactly 5 (one per num_clusters, ALWAYS drawn)", rnd.idx)
	}

	// Every visited cell is routed through replaceBaseBlockAt's own vertical scan; in this all-air
	// volume the first probe (dy=+2) always already qualifies, so actual placements land at
	// pos.Y+2 -- see TestPlaceBaseClusterGroundwork_FourCornersGeometry's own note.
	atY := pos.Y + 2
	wantCenters := []wgen.BlockPos{
		{X: pos.X + 0, Y: atY, Z: pos.Z - 3},
		{X: pos.X + 0, Y: atY, Z: pos.Z + 4},
		{X: pos.X - 3, Y: atY, Z: pos.Z + 0},
		{X: pos.X + 4, Y: atY, Z: pos.Z + 0},
	}
	for _, c := range wantCenters {
		if got := v.GetBlock(c); got != dirt {
			t.Errorf("border-draw center %v = %v, want dirt", c, pal.Entry(got))
		}
	}
	// The interior draw's own would-be center is pos itself -- must stay air. Also confirm no
	// corner circle (reach=10, radius=1) reaches any of the four border cells or pos: the
	// nearest corner center is (pos.X-1,pos.Z-1) or (pos.X+10,pos.Z-1) etc., whose own radius-1
	// "plus" footprint spans at most 1 cell away from x=-1/10, z=-1/10 -- never coinciding with
	// x=0/-3/4 & z=-3/4/0 (checked exhaustively: {-2,-1,0}x{-2,-1,0}, {9,10,11}x{-2,-1,0},
	// {-2,-1,0}x{9,10,11}, {9,10,11}x{9,10,11} -- none of these squares contain any of pos or the
	// four border centers above).
	for _, dy := range []int{2, 1, 0, -1, -2, -3} {
		p := wgen.BlockPos{X: pos.X, Y: pos.Y + dy, Z: pos.Z}
		if got := v.GetBlock(p); !pal.IsAir(got) {
			t.Errorf("pos+dy%d %v = %v, want air (interior draw r=27 must not place anything)", dy, p, pal.Entry(got))
		}
	}
}

// TestReplaceBaseBlockCircle_CornerClipping is a focused, zero-RNG unit test of
// the circle replacement's own geometry, independent of the base-cluster placement's gates/draws: radius=0
// places nothing at all (the single (0,0) cell IS the degenerate corner); radius=1 produces a
// 5-cell "plus" (corners clipped); radius=2 produces a 21-cell square-with-clipped-corners (25 - 4).
func TestReplaceBaseBlockCircle_CornerClipping(t *testing.T) {
	for _, tc := range []struct {
		radius int
		want   int
	}{
		{0, 0},
		{1, 5},
		{2, 21},
	} {
		t.Run(fmt.Sprintf("radius=%d", tc.radius), func(t *testing.T) {
			v, pal := baseClusterTestVolume(t, 10)
			dirt := pal.Get("minecraft:dirt", nil)
			mayReplace := pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:dirt"}, {Name: "minecraft:air"}}, nil, nil, nil)
			center := wgen.BlockPos{X: 0, Y: 20, Z: 0}
			replaceBaseBlockCircle(v, center, tc.radius, mayReplace, dirt)
			// Every visited cell is routed through replaceBaseBlockAt's own vertical scan; in
			// this all-air volume the first probe (dy=+2) always already qualifies, so actual
			// placements land at Y+2, not at the nominal circle Y.
			got := 0
			for dx := -3; dx <= 3; dx++ {
				for dz := -3; dz <= 3; dz++ {
					p := wgen.BlockPos{X: center.X + dx, Y: center.Y + 2, Z: center.Z + dz}
					if v.GetBlock(p) == dirt {
						got++
						if abs(dx) == tc.radius && abs(dz) == tc.radius && tc.radius > 0 {
							t.Errorf("corner cell %v was placed, want clipped", p)
						}
					}
				}
			}
			if got != tc.want {
				t.Errorf("placed cell count = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestReplaceBaseBlockAt_VerticalScanOrderAndShortCircuit is a focused, zero-RNG unit test of
// the single-position replacement's own six-probe vertical scan (dy = +2,+1,0,-1,-2,-3, in that order): the
// first probe whose existing block does NOT already equal the target AND passes the may_replace
// allow-list gets the target block; a probe whose existing block ALREADY equals the target stops
// the ENTIRE scan (treated as already satisfied), even if a later probe would have qualified.
func TestReplaceBaseBlockAt_VerticalScanOrderAndShortCircuit(t *testing.T) {
	mayReplace := func(pal *block.Palette) block.MatchSet {
		return pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:dirt"}, {Name: "minecraft:air"}}, nil, nil, nil)
	}

	t.Run("first_qualifying_probe_wins", func(t *testing.T) {
		v, pal := baseClusterTestVolume(t, 5)
		dirt := pal.Get("minecraft:dirt", nil)
		pos := wgen.BlockPos{X: 0, Y: 20, Z: 0}
		replaceBaseBlockAt(v, pos, mayReplace(pal), dirt)
		if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 22, Z: 0}); got != dirt {
			t.Fatalf("dy=+2 (%v) = %v, want dirt (the first probe, all-air volume)", wgen.BlockPos{X: 0, Y: 22, Z: 0}, pal.Entry(got))
		}
		for _, dy := range []int{1, 0, -1, -2, -3} {
			p := wgen.BlockPos{X: 0, Y: 20 + dy, Z: 0}
			if got := v.GetBlock(p); !pal.IsAir(got) {
				t.Errorf("dy=%d (%v) = %v, want air (scan must stop at the first qualifying probe)", dy, p, pal.Entry(got))
			}
		}
	})

	t.Run("existing_target_short-circuits_the_whole_scan", func(t *testing.T) {
		v, pal := baseClusterTestVolume(t, 5)
		dirt := pal.Get("minecraft:dirt", nil)
		pos := wgen.BlockPos{X: 0, Y: 20, Z: 0}
		// The allow-list here deliberately EXCLUDES the target (dirt) itself -- unlike
		// mayReplace(pal) above -- so this subtest genuinely isolates the "existing == target"
		// short-circuit from the ordinary allow-list match: if the short-circuit were removed,
		// the scan would NOT stop at dy=+2 (dirt fails this narrower allow-list) and would fall
		// through to place at dy=+1 (air, which IS allow-listed) instead.
		narrowAllowList := pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:air"}}, nil, nil, nil)
		// Pre-place the TARGET block at the very first probe (dy=+2): the scan must stop there
		// (existing == target) without ever placing at dy=+1, even though dy=+1 (air) would
		// otherwise qualify under narrowAllowList.
		v.SetBlock(wgen.BlockPos{X: 0, Y: 22, Z: 0}, dirt)
		replaceBaseBlockAt(v, pos, narrowAllowList, dirt)
		for _, dy := range []int{1, 0, -1, -2, -3} {
			p := wgen.BlockPos{X: 0, Y: 20 + dy, Z: 0}
			if got := v.GetBlock(p); !pal.IsAir(got) {
				t.Errorf("dy=%d (%v) = %v, want air (existing-target match must short-circuit the scan)", dy, p, pal.Entry(got))
			}
		}
	})

	t.Run("non-allow-listed_existing_blocks_are_skipped", func(t *testing.T) {
		v, pal := baseClusterTestVolume(t, 5)
		dirt := pal.Get("minecraft:dirt", nil)
		stone := pal.Get("minecraft:stone", nil) // NOT in the allow-list below
		pos := wgen.BlockPos{X: 0, Y: 20, Z: 0}
		v.SetBlock(wgen.BlockPos{X: 0, Y: 22, Z: 0}, stone)
		v.SetBlock(wgen.BlockPos{X: 0, Y: 21, Z: 0}, stone)
		// dy=0 (Y=20) stays the default air -- the first allow-listed, non-target probe.
		mr := pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:air"}}, nil, nil, nil) // target itself (dirt) NOT in the allow-list
		replaceBaseBlockAt(v, pos, mr, dirt)
		if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 20, Z: 0}); got != dirt {
			t.Fatalf("dy=0 = %v, want dirt (first allow-listed probe after two non-allow-listed ones)", pal.Entry(got))
		}
		for _, p := range []wgen.BlockPos{{X: 0, Y: 22, Z: 0}, {X: 0, Y: 21, Z: 0}} {
			if got := v.GetBlock(p); got != stone {
				t.Errorf("%v = %v, want unchanged stone (not in the allow-list)", p, pal.Entry(got))
			}
		}
	})
}

// TestTreeFeature_MegaTrunk_BaseCluster_EndToEnd exercises base_cluster through the full
// TreeFeature.Place pipeline (not placeBaseClusterGroundwork directly), pinning that it draws
// AFTER every other mega_trunk draw (branches, then the trunk column) and AFTER the top canopy's
// own placement, matching placeMegaTrunk's own wiring.
func TestTreeFeature_MegaTrunk_BaseCluster_EndToEnd(t *testing.T) {
	v, pal := newTreeTestVolume(t, 15)
	dirt := pal.Get("minecraft:dirt", nil)
	body := map[string]any{
		"mega_trunk": map[string]any{
			"trunk_width":  float64(2),
			"trunk_height": map[string]any{"base": float64(4)}, // 0 draws
			"trunk_block":  "minecraft:log",
		},
		"mega_canopy": map[string]any{
			"canopy_height": float64(1), // degenerate {1,1} -- 0 draws
			"base_radius":   float64(0),
			"core_width":    float64(2),
			"leaf_block":    "minecraft:leaves",
		},
		"may_replace": []any{"minecraft:air"},
		"base_cluster": map[string]any{
			"may_replace":    []any{"minecraft:dirt", "minecraft:air"},
			"num_clusters":   float64(2),
			"cluster_radius": float64(0), // 0 placements, but still 2 real draws
		},
	}
	ctx := &BuildContext{Palette: pal, Identifier: "test:mega-basecluster", FileID: "test:mega-basecluster", Warn: func(string) {}}
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := built.(*TreeFeature)
	if len(tf.warnings) != 0 {
		t.Fatalf("warnings = %v, want none", tf.warnings)
	}

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	rnd := &intBoundScriptedRandom{vals: []int{27, 27}} // both interior draws -- cluster_radius=0 places nothing regardless
	tr := random.NewTracer(rnd)
	if got := placeTestTree(tf, v, origin, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if len(tr.Draws) != 2 {
		t.Fatalf("draws = %v, want exactly 2 (trunk_height/canopy_height are both degenerate/zero-draw; base_cluster's own 2 num_clusters draws are the ONLY draws)", tr.Draws)
	}
	for i, d := range tr.Draws {
		if d.Method != random.MethodNextIntBound || d.Bound != 64 {
			t.Fatalf("draw %d = %+v, want NextIntBound(64) (base_cluster's own draw)", i, d)
		}
	}
	// cluster_radius=0 places nothing anywhere -- confirms the draws happened but had no visible
	// effect, exactly like the circle replacement's own radius=0 degenerate case.
	for x := -3; x <= 3; x++ {
		for z := -3; z <= 3; z++ {
			p := wgen.BlockPos{X: x, Y: 9, Z: z}
			if got := v.GetBlock(p); got != dirt {
				t.Errorf("ground %v = %v, want the pre-existing dirt floor unchanged (cluster_radius=0)", p, pal.Entry(got))
			}
		}
	}
}

// --- mangrove_trunk (its placement and branch placement) ----------------------------------------
//
// See tree.go's mangroveTrunk doc comment for the field set and the exact RNG draw order. The key
// behaviour this section pins is that the boolean draw is made UNCONDITIONALLY for every non-final
// successfully-placed log, with no "branches configured" gate -- see
// TestTreeFeature_MangroveTrunk_CoinFlipDrawsRegardlessOfBranchesPresence below.

// mangroveTrunkScriptedRandom scripts NextIntBound and NextBoolean's own return values in call
// order (used by both the height draw's two draws and every subsequent draw in the trunk and
// branch placements, which -- per tree.go's own established convention -- are ALL either NextIntBound or
// NextBoolean; treeIntRangeValueInclusive itself only ever calls NextIntBound). Panics on any other
// method or an exhausted script, so an extra/missing draw fails loudly.
type mangroveTrunkScriptedRandom struct {
	intBounds []int
	bools     []bool
	ii, bi    int
}

func (s *mangroveTrunkScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (s *mangroveTrunkScriptedRandom) NextIntBound(int) int {
	v := s.intBounds[s.ii]
	s.ii++
	return v
}
func (s *mangroveTrunkScriptedRandom) NextBoolean() bool {
	v := s.bools[s.bi]
	s.bi++
	return v
}
func (s *mangroveTrunkScriptedRandom) NextInt() int32      { panic("unused") }
func (s *mangroveTrunkScriptedRandom) NextFloat() float64  { panic("unused") }
func (s *mangroveTrunkScriptedRandom) NextDouble() float64 { panic("unused") }
func (s *mangroveTrunkScriptedRandom) SetSeed(uint32)      {}
func (s *mangroveTrunkScriptedRandom) GetSeed() uint32     { return 0 }

var _ random.IRandom = (*mangroveTrunkScriptedRandom)(nil)

// mangroveTrunkTestBody builds a minimal, schema-valid mangrove_trunk body paired with the bare
// "canopy" key (the simple canopy, cheapest to satisfy) so tests can focus on trunk behavior. mutate
// (if non-nil) edits the mangrove_trunk object in place before returning.
func mangroveTrunkTestBody(mutate func(mt map[string]any)) map[string]any {
	mt := map[string]any{
		"trunk_block": "minecraft:mangrove_log",
		"trunk_height": map[string]any{
			"base":          float64(3),
			"height_rand_a": float64(0),
			"height_rand_b": float64(0),
		},
	}
	if mutate != nil {
		mutate(mt)
	}
	return map[string]any{
		"mangrove_trunk": mt,
		"canopy": map[string]any{
			"leaf_block":    "minecraft:mangrove_leaves",
			"canopy_offset": map[string]any{"min": float64(0), "max": float64(0)},
		},
		"may_replace": []any{"minecraft:air"},
	}
}

// TestBuildTreeFeature_MangroveTrunk_SchemaValidation pins mangrove_trunk's required/optional
// fields: trunk_height.{base,height_rand_a,height_rand_b} required; trunk_width and
// branches.branch_chance schema-present but PROVEN UNUSED (accepted, not consumed -- see
// mangroveTrunk's own doc comment); trunk_decoration reuses parseAttachableDecorationObject
// (num_steps also schema-present but PROVEN UNUSED, matching mega_trunk's own established
// policy -- see parseAttachableDecorationObject's own doc comment).
func TestBuildTreeFeature_MangroveTrunk_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:mangrove", FileID: "test:mangrove", Warn: func(string) {}}

	built, err := buildTreeFeature(mangroveTrunkTestBody(nil), ctx)
	if err != nil {
		t.Fatalf("minimal mangrove_trunk body: %v", err)
	}
	tf := built.(*TreeFeature)
	if tf.mangroveTrunk == nil {
		t.Fatal("mangroveTrunk = nil, want non-nil")
	}
	if tf.mangroveTrunk.heightBase != 3 {
		t.Errorf("heightBase = %d, want 3", tf.mangroveTrunk.heightBase)
	}
	if tf.mangroveTrunk.decoration != nil {
		t.Errorf("decoration = %v, want nil (trunk_decoration omitted)", tf.mangroveTrunk.decoration)
	}

	for _, tc := range []struct {
		name   string
		mutate func(mt map[string]any)
	}{
		{"requires_trunk_height", func(mt map[string]any) { delete(mt, "trunk_height") }},
		{"requires_trunk_height_base", func(mt map[string]any) {
			delete(mt["trunk_height"].(map[string]any), "base")
		}},
		{"requires_trunk_height_height_rand_a", func(mt map[string]any) {
			delete(mt["trunk_height"].(map[string]any), "height_rand_a")
		}},
		{"requires_trunk_height_height_rand_b", func(mt map[string]any) {
			delete(mt["trunk_height"].(map[string]any), "height_rand_b")
		}},
		{"requires_trunk_block", func(mt map[string]any) { delete(mt, "trunk_block") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := mangroveTrunkTestBody(tc.mutate)
			if _, err := buildTreeFeature(body, ctx); err == nil {
				t.Fatal("want error")
			}
		})
	}

	t.Run("trunk_width_and_branch_chance_are_accepted_but_unused", func(t *testing.T) {
		body := mangroveTrunkTestBody(func(mt map[string]any) {
			mt["trunk_width"] = float64(1)
			mt["branches"] = map[string]any{
				"branch_chance": map[string]any{"numerator": float64(1), "denominator": float64(2)},
			}
		})
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("trunk_width/branch_chance: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.mangroveTrunk.branchLengthMin != 0 || tf.mangroveTrunk.branchLengthMax != 0 {
			t.Errorf("branch_length = {%d,%d}, want zeroed default (branches.branch_length omitted)", tf.mangroveTrunk.branchLengthMin, tf.mangroveTrunk.branchLengthMax)
		}
	})

	t.Run("trunk_decoration_num_steps_is_accepted_but_unused", func(t *testing.T) {
		body := mangroveTrunkTestBody(func(mt map[string]any) {
			mt["trunk_decoration"] = map[string]any{
				"decoration_block":  "minecraft:vine",
				"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(1)},
				"num_steps":         float64(3),
			}
		})
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("num_steps must not be refused: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.mangroveTrunk.decoration == nil {
			t.Fatal("decoration = nil, want non-nil (the rest of trunk_decoration still parsed)")
		}
	})

	t.Run("branches_and_trunk_decoration_fully_configured", func(t *testing.T) {
		body := mangroveTrunkTestBody(func(mt map[string]any) {
			mt["branches"] = map[string]any{
				"branch_length": map[string]any{"range_min": float64(1), "range_max": float64(3)},
				"branch_steps":  map[string]any{"range_min": float64(2), "range_max": float64(4)},
			}
			mt["trunk_decoration"] = map[string]any{
				"decoration_block":  "minecraft:vine",
				"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(3)},
			}
		})
		built, err := buildTreeFeature(body, ctx)
		if err != nil {
			t.Fatalf("fully-configured branches/trunk_decoration: %v", err)
		}
		tf := built.(*TreeFeature)
		if tf.mangroveTrunk.branchLengthMin != 1 || tf.mangroveTrunk.branchLengthMax != 3 {
			t.Errorf("branch_length = {%d,%d}, want {1,3}", tf.mangroveTrunk.branchLengthMin, tf.mangroveTrunk.branchLengthMax)
		}
		if tf.mangroveTrunk.branchStepsMin != 2 || tf.mangroveTrunk.branchStepsMax != 4 {
			t.Errorf("branch_steps = {%d,%d}, want {2,4}", tf.mangroveTrunk.branchStepsMin, tf.mangroveTrunk.branchStepsMax)
		}
		if tf.mangroveTrunk.decoration == nil {
			t.Fatal("decoration = nil, want non-nil")
		}
		// trunk_decoration IS applied for mangrove_trunk (via mangrove.decoration, not shaped.decoration
		// -- a warnings check that only tests `shaped` would misreport it), so no
		// "not implemented" warning should fire here.
		for _, w := range tf.warnings {
			if strings.Contains(w, "trunk_decoration") {
				t.Fatalf("warnings = %v, want none mentioning trunk_decoration (it IS implemented for mangrove_trunk)", tf.warnings)
			}
		}
	})
}

// TestMangroveTrunk_GetTreeHeight_RNGDrawSequence pins getTreeHeight's exact two-draw order and
// formula: height_rand_a's own NextIntBound(height_rand_a+1) FIRST, height_rand_b's own
// NextIntBound(height_rand_b+1) SECOND, summed with base (which itself draws nothing).
func TestMangroveTrunk_GetTreeHeight_RNGDrawSequence(t *testing.T) {
	mt := &mangroveTrunk{heightBase: 5, heightRandA: 2, heightRandB: 4}
	scripted := &mangroveTrunkScriptedRandom{intBounds: []int{1, 3}}
	tr := random.NewTracer(scripted)
	got := mt.getTreeHeight(tr)
	if want := 5 + 1 + 3; got != want {
		t.Fatalf("getTreeHeight = %d, want %d", got, want)
	}
	want := []struct {
		bound int32
	}{
		{3}, // NextIntBound(height_rand_a+1 = 3) FIRST
		{5}, // NextIntBound(height_rand_b+1 = 5) SECOND
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want exactly 2", tr.Draws)
	}
	for i, w := range want {
		if d := tr.Draws[i]; d.Method != random.MethodNextIntBound || d.Bound != w.bound {
			t.Fatalf("draw %d = %+v, want NextIntBound(%d)", i, d, w.bound)
		}
	}
}

// TestTreeFeature_MangroveTrunk_CoinFlipDrawsRegardlessOfBranchesPresence is THE decisive test for
// this trunk: the mangrove trunk's placement makes the boolean draw UNCONDITIONALLY for every
// non-final successfully-placed log, with NO "branches configured" gate (see mangroveTrunk's own
// doc comment).
// This test's own JSON body has NO "branches" key at all -- a completely legal, unremarkable
// mangrove_trunk body -- yet the trace below must still show exactly one NextBoolean draw per
// non-final log. A version that special-cases "branches present" (e.g. skipping the coin flip when
// mangroveTrunk.branchLengthMax==0) would drop these draws and silently desync the RNG stream
// against vanilla for every JSON that omits "branches" -- exactly the regression this test
// must catch.
func TestTreeFeature_MangroveTrunk_CoinFlipDrawsRegardlessOfBranchesPresence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	logID := pal.Get("minecraft:mangrove_log", nil)

	body := mangroveTrunkTestBody(nil) // height=3, no "branches" key present at all
	ctx := &BuildContext{Palette: pal, Identifier: "test:mangrove-coin", FileID: "test:mangrove-coin", Warn: func(string) {}}
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := built.(*TreeFeature)
	if tf.mangroveTrunk.branchLengthMax != 0 || tf.mangroveTrunk.branchStepsMax != 0 {
		t.Fatalf("branch_length/branch_steps = %d/%d, want zeroed defaults (branches was never supplied)", tf.mangroveTrunk.branchLengthMax, tf.mangroveTrunk.branchStepsMax)
	}

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	// height=3 -> logs at i=0,1,2 (origin.Y+0..+2); non-final = i=0,1 (2 coin flips). Both flips
	// scripted false so no branch RNG is needed for this test to stay focused on the flip itself.
	scripted := &mangroveTrunkScriptedRandom{
		intBounds: []int{0, 0}, // getTreeHeight: height_rand_a=0 -> NextIntBound(1)=0, height_rand_b=0 -> NextIntBound(1)=0
		bools:     []bool{false, false},
	}
	tr := random.NewTracer(scripted)
	if got := placeTestTree(tf, v, origin, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 1}, // getTreeHeight: height_rand_a
		{random.MethodNextIntBound, 1}, // getTreeHeight: height_rand_b
		{random.MethodNextBoolean, 0},  // log i=0 (non-final): the coin flip
		{random.MethodNextBoolean, 0},  // log i=1 (non-final): the coin flip
		// log i=2 is the FINAL log (i == height-1) -- no coin flip drawn at all.
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want exactly %d (2 height draws + 2 coin flips, one per non-final log, NO branches key present)", tr.Draws, len(want))
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}

	for i := 0; i < 3; i++ {
		p := wgen.BlockPos{X: 0, Y: 10 + i, Z: 0}
		if got := v.GetBlock(p); got != logID {
			t.Errorf("log at %v = %v, want mangrove_log", p, pal.Entry(got))
		}
	}
}

// TestTreeFeature_MangroveTrunk_CoinFlipTrueDrawsBranchSequence exercises the OTHER side of the coin
// flip: when it returns true, the placement draws (in this exact order) the random horizontal
// face draw (NextIntBound(4)), branch_length.getValueInclusive TWICE, then
// branch_steps.getValueInclusive ONCE, before the branch placement -- see mangroveTrunk's own doc
// comment, "The coin flip", steps 5a-5d.
func TestTreeFeature_MangroveTrunk_CoinFlipTrueDrawsBranchSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	logID := pal.Get("minecraft:mangrove_log", nil)

	body := mangroveTrunkTestBody(func(mt map[string]any) {
		// height=2 (one non-final log, i=0, and one final log, i=1) keeps the coin-flip script to a
		// single bool for this test's own focus (the branch draw sequence itself).
		mt["trunk_height"] = map[string]any{"base": float64(2), "height_rand_a": float64(0), "height_rand_b": float64(0)}
		mt["branches"] = map[string]any{
			"branch_length": map[string]any{"range_min": float64(0), "range_max": float64(2)},
			"branch_steps":  map[string]any{"range_min": float64(2), "range_max": float64(2)}, // degenerate -- 0 draws, value=2
		}
	})
	ctx := &BuildContext{Palette: pal, Identifier: "test:mangrove-branch", FileID: "test:mangrove-branch", Warn: func(string) {}}
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	tf := built.(*TreeFeature)

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	scripted := &mangroveTrunkScriptedRandom{
		intBounds: []int{
			0, 0, // getTreeHeight draws (height_rand_a/b both 0)
			1, // the random horizontal face draw -> NextIntBound(4)=1 -> facing=1+2=3=South
			2, // branch_length draw #1 -> NextIntBound(3)=2 -> value 0+2=2
			1, // branch_length draw #2 -> NextIntBound(3)=1 -> value 0+1=1
			// branch_steps.getValueInclusive(2,2) is degenerate (min>=max) -> 0 draws
			// i=1 is the FINAL log (height-1==1) -- no coin flip drawn for it at all.
		},
		bools: []bool{true}, // i=0's coin flip: true -> branch fires
	}
	tr := random.NewTracer(scripted)
	if got := placeTestTree(tf, v, origin, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 1}, // getTreeHeight: height_rand_a
		{random.MethodNextIntBound, 1}, // getTreeHeight: height_rand_b
		{random.MethodNextBoolean, 0},  // i=0's coin flip: true
		{random.MethodNextIntBound, 4}, // the random horizontal face draw
		{random.MethodNextIntBound, 3}, // branch_length draw #1 (range_max-range_min+1 = 2-0+1 = 3)
		{random.MethodNextIntBound, 3}, // branch_length draw #2
		// branch_steps.getValueInclusive(2,2): min>=max -> 0 draws
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want exactly %d", tr.Draws, len(want))
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}

	// start = max(0, draw1-draw2-1) = max(0, 2-1-1) = 0; facing=3=South -> (dx,dz)=(0,+1); steps=2.
	// Trunk log at i=0 is (0,10,0); branch's own yBase = origin.Y+i = 10.
	// v=0: "v>=1" fails (no placement/step). v becomes 1 (<height=2); old steps(2)>1 -> continue.
	// v=1: "v>=1" true -> ONE step+placement: x,z step to (0,_,1), y=v+yBase=1+10=11. v becomes 2;
	// 2>=height(2) -> break (loop ends via the height ceiling, not the steps budget).
	branchLog := wgen.BlockPos{X: 0, Y: 11, Z: 1}
	if got := v.GetBlock(branchLog); got != logID {
		t.Errorf("branch log at %v = %v, want mangrove_log", branchLog, pal.Entry(got))
	}
	// The trunk column itself (i=0,1) still stands.
	for i := 0; i < 2; i++ {
		p := wgen.BlockPos{X: 0, Y: 10 + i, Z: 0}
		if got := v.GetBlock(p); got != logID {
			t.Errorf("trunk log at %v = %v, want mangrove_log", p, pal.Entry(got))
		}
	}
}

// TestMangroveTrunkBranch_UnconditionalCandidatePushAndDecoration exercises mangroveTrunkBranch
// directly: every attempted step pushes a candidate REGARDLESS of isValidTreePosition/SetBlock
// success (see mangroveTrunkBranch's own doc comment), and
// trunk_decoration's own attachable decoration fires per successfully-placed branch log via the SAME
// megaTrunkDecoration machinery mega_trunk already ships.
func TestMangroveTrunkBranch_UnconditionalCandidatePushAndDecoration(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	logID := pal.Get("minecraft:mangrove_log", nil)
	vineID := pal.Get("minecraft:vine", nil)
	// Obstruct the SECOND attempted step (v=2, Y=yBase+2=12, Z=2) so its own SetBlock fails, but the
	// candidate push must still happen for it.
	v.SetBlock(wgen.BlockPos{X: 0, Y: 12, Z: 2}, pal.Get("minecraft:bedrock", nil))

	dec := &megaTrunkDecoration{
		entries: []megaTrunkDecorationEntry{{blockID: vineID, countMin: 1, countMax: 1}},
		chance:  chanceInformation{percent: 100}, // always true, 0 draws
		pal:     pal,
	}
	mayReplace := pal.NewMatchSet([]block.Descriptor{block.NameDescriptor("minecraft:air")}, nil, nil, nil)
	var candidates []wgen.BlockPos
	scripted := &mangroveTrunkScriptedRandom{}
	tr := random.NewTracer(scripted)

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	// yBase=10, height=5, facing=3(South), start=0, steps=4 -- see the walk below for why steps=4
	// (not 3) is needed to reach 3 attempted placement steps (v=1,2,3) given the loop's own
	// steps-budget bookkeeping.
	mangroveTrunkBranch(v, tr, mayReplace, origin, 10, 5, 3, 0, 4, logID, dec, &candidates)

	if len(tr.Draws) != 0 {
		t.Fatalf("draws = %v, want zero (chance is always-true, zero-draw)", tr.Draws)
	}

	// v walks 0..3 (Y = yBase+v = 10+v, Z = v, since facing=South steps +Z per placement iteration):
	// v=0: "v>=1" fails -- no placement/step. v becomes 1; oldSteps=4>1 -> continue, steps=3.
	// v=1: placement at (0,11,1) -- succeeds, decorated. v becomes 2; oldSteps=3>1 -> continue, steps=2.
	// v=2: placement at (0,12,2) -- bedrock, SetBlock fails, STILL a candidate, no decoration. v
	//      becomes 3; oldSteps=2>1 -> continue, steps=1.
	// v=3: placement at (0,13,3) -- succeeds, decorated. v becomes 4; oldSteps=1<=1 -> break.
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 11, Z: 1}); got != logID {
		t.Errorf("v=1 log = %v, want mangrove_log", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 13, Z: 3}); got != logID {
		t.Errorf("v=3 log = %v, want mangrove_log", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 12, Z: 2}); pal.Entry(got).Name != "minecraft:bedrock" {
		t.Errorf("obstructed cell = %v, want untouched bedrock", pal.Entry(got))
	}

	wantCandidates := []wgen.BlockPos{
		{X: 0, Y: 11, Z: 1},
		{X: 0, Y: 12, Z: 2}, // pushed even though SetBlock failed here
		{X: 0, Y: 13, Z: 3},
	}
	if len(candidates) < len(wantCandidates) {
		t.Fatalf("candidates = %v, want at least %v", candidates, wantCandidates)
	}
	for i, want := range wantCandidates {
		if candidates[i] != want {
			t.Errorf("candidates[%d] = %v, want %v", i, candidates[i], want)
		}
	}

	// Decoration only fires where SetBlock succeeded: (0,11,1) and (0,13,3) get a vine on their own
	// north face (mangroveTrunkAllDirections enables all 4; north is dz=-1 relative to each log).
	northVine, _ := pal.WithIntState(vineID, block.MultiFaceDirectionBits, 4)
	for _, p := range []wgen.BlockPos{{X: 0, Y: 11, Z: 0}, {X: 0, Y: 13, Z: 2}} {
		if got := v.GetBlock(p); got != northVine {
			t.Errorf("decoration north of %v = %v, want vine(north)", p, pal.Entry(got))
		}
	}
}

// --- mangrove_canopy.canopy_decoration ------------------------------------------------------------

// TestMangroveCanopy_Place_CanopyDecoration_RNGSequenceAndPlacement pins canopy_decoration's own
// draw sequence and placement: the decoration loop (see tree.go's module header) runs once
// per SHUFFLED propagule, strictly BETWEEN the scatter phase and the hanging_block pass, reusing
// megaTrunkDecoration.place with mangroveTrunkAllDirections unchanged. canopy_height/canopy_radius
// are forced to {1,1} (degenerate, 0 draws) and leaf_placement_attempts=1 with a single leaf_blocks
// entry (weight=1, so sumInt=1 and the pick still draws NextIntBound(1)) and an all-zero scripted
// jitter, so exactly ONE propagule lands at the candidate position itself -- keeping the shuffle at
// zero draws (len==1) and isolating canopy_decoration's own 4 direction rolls from everything else.
// hanging_block_placement_chance is forced to percent=0 (never fires, 0 draws, and confirms
// hanging_block truly runs AFTER canopy_decoration -- if it ran first or canopy_decoration were
// skipped, this test's own draw-count assertion below would fail).
func TestMangroveCanopy_Place_CanopyDecoration_RNGSequenceAndPlacement(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	leaf := pal.Get("minecraft:mangrove_leaves", nil)
	vine := pal.Get("minecraft:vine", nil)
	c := &mangroveCanopy{
		heightMin: 1, heightMax: 1,
		radiusMin: 1, radiusMax: 1,
		attempts:      1,
		leafBlocks:    []randomSpreadWeightedBlock{{id: leaf, weight: 1}},
		hangingBlock:  pal.Get("minecraft:mangrove_propagule", nil),
		hangingChance: chanceInformation{percent: 0}, // never fires, 0 draws
		decoration: &megaTrunkDecoration{
			entries: []megaTrunkDecorationEntry{{blockID: vine, countMin: 1, countMax: 1}},
			chance:  chanceInformation{isFraction: true, numerator: 1, denominator: 2},
			pal:     pal,
		},
	}
	candidate := wgen.BlockPos{X: 0, Y: 20, Z: 0}
	// leaf pick=0, dx1=dx2=dy1=dy2=dz1=dz2=0 (propagule lands exactly on the candidate), then west=0
	// (succeeds, 0<1), east=1 (fails), north=0 (succeeds), south=1 (fails).
	scripted := &spruceScriptedRandom{bounds: []int{0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1}}
	tr := random.NewTracer(scripted)
	c.place(v, wgen.BlockPos{}, tr, treeParamsLists{}, []wgen.BlockPos{candidate})

	want := []struct {
		method random.Method
		bound  int32
	}{
		{random.MethodNextIntBound, 1}, // leaf_blocks pick (sum=1)
		{random.MethodNextIntBound, 1}, // dx1
		{random.MethodNextIntBound, 1}, // dx2
		{random.MethodNextIntBound, 1}, // dy1
		{random.MethodNextIntBound, 1}, // dy2
		{random.MethodNextIntBound, 1}, // dz1
		{random.MethodNextIntBound, 1}, // dz2
		{random.MethodNextIntBound, 2}, // canopy_decoration west roll -- succeeds
		{random.MethodNextIntBound, 2}, // canopy_decoration east roll -- fails
		{random.MethodNextIntBound, 2}, // canopy_decoration north roll -- succeeds
		{random.MethodNextIntBound, 2}, // canopy_decoration south roll -- fails
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %v, want %d draws (scatter, then canopy_decoration x4, then ZERO from a never-firing hanging_block pass)", tr.Draws, len(want))
	}
	for i, expected := range want {
		if got := tr.Draws[i]; got.Method != expected.method || got.Bound != expected.bound {
			t.Fatalf("draw %d = %+v, want method=%v bound=%d", i, got, expected.method, expected.bound)
		}
	}

	westDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	northDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 4)
	if got := v.GetBlock(wgen.BlockPos{X: -1, Y: 20, Z: 0}); got != westDecorated {
		t.Errorf("west cell = %v, want vine decorated west", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 20, Z: -1}); got != northDecorated {
		t.Errorf("north cell = %v, want vine decorated north", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 20, Z: 0}); !pal.IsAir(got) {
		t.Errorf("east cell = %v, want air (roll failed)", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 20, Z: 1}); !pal.IsAir(got) {
		t.Errorf("south cell = %v, want air (roll failed)", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 19, Z: 0}); !pal.IsAir(got) {
		t.Errorf("below propagule = %v, want air -- hanging_block_placement_chance (percent=0) must never fire", pal.Entry(got))
	}
}

// TestMangroveCanopy_Place_NilDecoration_UnaffectedByAbsence proves the default "canopy_
// decoration absent" case (nil) is a true zero-draw no-op: with an rnd that panics on the FIRST
// unscripted draw past the scatter phase, a nil-decoration canopy must reach the (also-disabled)
// hanging_block pass without ever touching canopy_decoration's own code path.
func TestMangroveCanopy_Place_NilDecoration_UnaffectedByAbsence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 5)
	leaf := pal.Get("minecraft:mangrove_leaves", nil)
	c := &mangroveCanopy{
		heightMin: 1, heightMax: 1,
		radiusMin: 1, radiusMax: 1,
		attempts:      1,
		leafBlocks:    []randomSpreadWeightedBlock{{id: leaf, weight: 1}},
		hangingBlock:  pal.Get("minecraft:mangrove_propagule", nil),
		hangingChance: chanceInformation{percent: 0},
		decoration:    nil,
	}
	candidate := wgen.BlockPos{X: 0, Y: 20, Z: 0}
	scripted := &spruceScriptedRandom{bounds: []int{0, 0, 0, 0, 0, 0, 0}} // scatter draws only
	tr := random.NewTracer(scripted)
	c.place(v, wgen.BlockPos{}, tr, treeParamsLists{}, []wgen.BlockPos{candidate})
	if len(tr.Draws) != 7 {
		t.Fatalf("draws = %v, want exactly 7 (scatter only -- nil decoration must add ZERO draws)", tr.Draws)
	}
}

// --- mangrove_roots.root_decoration --------------------------------------------------------------

// TestMangrovePlaceRoot_RootDecoration_MuddyBranch pins root_decoration on the muddy-root branch:
// decoration fires EXACTLY ONCE, at pos itself, immediately after muddy_root_block is placed --
// and the single-root write returns right after (the above_root gate is never reached on this
// branch, as the total draw count below shows).
func TestMangrovePlaceRoot_RootDecoration_MuddyBranch(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	vine := pal.Get("minecraft:vine", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, air)

	r := mangroveTestRoots(pal, 0, 3)
	r.rootsMayGrowThrough = block.MatchSet{} // widen -- see TestMangrovePlaceRoot_MuddyRootSubstitution's own note
	r.decoration = &megaTrunkDecoration{
		entries: []megaTrunkDecorationEntry{{blockID: vine, countMin: 1, countMax: 1}},
		chance:  chanceInformation{isFraction: true, numerator: 1, denominator: 2},
		pal:     pal,
	}

	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	v.SetBlock(pos, r.mudBlock)

	scripted := &mangroveScriptedRandom{intBounds: []int{0, 1, 0, 1}} // west ok, east fail, north ok, south fail
	tr := random.NewTracer(scripted)
	mangrovePlaceRoot(v, pos, tr, r)

	if len(tr.Draws) != 4 {
		t.Fatalf("draws = %v, want exactly 4 (root_decoration's own 4 direction rolls, muddy branch returns immediately)", tr.Draws)
	}
	if got := v.GetBlock(pos); got != r.muddyRootBlock {
		t.Fatalf("block at pos = %v, want muddyRootBlock", pal.Entry(got))
	}
	westDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	northDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 4)
	if got := v.GetBlock(wgen.BlockPos{X: -1, Y: 0, Z: 0}); got != westDecorated {
		t.Errorf("west = %v, want vine decorated west", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 0, Z: -1}); got != northDecorated {
		t.Errorf("north = %v, want vine decorated north", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 0, Z: 0}); !pal.IsAir(got) {
		t.Errorf("east = %v, want air (roll failed)", pal.Entry(got))
	}
}

// TestMangrovePlaceRoot_RootDecoration_NonMuddyAndAboveRoot_DecoratesBothPositions pins the
// non-muddy branch plus the above_root branch (via placeDecoratedBlock):
// root_decoration's SAME decoration object decorates BOTH the root
// position and (independently) the above_root position, each with its own full 4-direction roll
// set -- 8 draws total, root decoration ONLY on the west face, above_root decoration ONLY on the
// east face, proving the two calls are genuinely independent (not the same 4 rolls reused twice).
func TestMangrovePlaceRoot_RootDecoration_NonMuddyAndAboveRoot_DecoratesBothPositions(t *testing.T) {
	pal := block.NewPalette()
	air := pal.Get("minecraft:air", nil)
	vine := pal.Get("minecraft:vine", nil)
	bounds := volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, air)

	r := mangroveTestRoots(pal, 0, 3)
	r.hasAboveRootBlock = true
	r.aboveRootBlock = pal.Get("minecraft:moss_carpet", nil)
	r.aboveRootChance = chanceInformation{percent: 100} // roll() always true, 0 draws
	r.decoration = &megaTrunkDecoration{
		entries: []megaTrunkDecorationEntry{{blockID: vine, countMin: 1, countMax: 1}},
		chance:  chanceInformation{isFraction: true, numerator: 1, denominator: 2},
		pal:     pal,
	}

	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	// root decoration: west succeeds (0), east/north/south fail (1,1,1).
	// above_root decoration: east succeeds (0), west/north/south fail (1,1,1).
	scripted := &mangroveScriptedRandom{intBounds: []int{0, 1, 1, 1, 1, 0, 1, 1}}
	tr := random.NewTracer(scripted)
	mangrovePlaceRoot(v, pos, tr, r)

	if len(tr.Draws) != 8 {
		t.Fatalf("draws = %v, want exactly 8 (root_decoration x4 + above_root_chance.roll (0 draws, percent=100) + above_root's own decoration x4)", tr.Draws)
	}
	if got := v.GetBlock(pos); got != r.rootBlock {
		t.Fatalf("block at pos = %v, want rootBlock", pal.Entry(got))
	}
	above := wgen.BlockPos{X: 0, Y: 1, Z: 0}
	if got := v.GetBlock(above); got != r.aboveRootBlock {
		t.Fatalf("block above = %v, want aboveRootBlock", pal.Entry(got))
	}

	westOfRoot, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	if got := v.GetBlock(wgen.BlockPos{X: -1, Y: 0, Z: 0}); got != westOfRoot {
		t.Errorf("west of root = %v, want vine decorated west", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 0, Z: 0}); !pal.IsAir(got) {
		t.Errorf("east of root = %v, want air (root's own east roll failed)", pal.Entry(got))
	}
	eastOfAbove, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 8)
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 1, Z: 0}); got != eastOfAbove {
		t.Errorf("east of above_root = %v, want vine decorated east", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: -1, Y: 1, Z: 0}); !pal.IsAir(got) {
		t.Errorf("west of above_root = %v, want air (above_root's own west roll failed)", pal.Entry(got))
	}
}

// --- fallen_trunk: log_decoration_feature and trunk_decoration -----------------------------------

func vanillaFallenTrunkBody() map[string]any {
	return map[string]any{
		"fallen_trunk": map[string]any{
			"log_length":   float64(3),
			"trunk_block":  "minecraft:mangrove_log",
			"stump_height": map[string]any{"range_min": float64(1), "range_max": float64(1)},
		},
		"may_replace": []any{"minecraft:air"},
	}
}

// TestBuildTreeFeature_FallenTrunk_LogDecorationFeatureAndTrunkDecoration_SchemaValidation proves
// both fields now parse and wire (they used to hit the SAME generic "not implemented" warning every
// unwired trunk field shares), and that the warning stops firing once the field is actually
// consumed.
func TestBuildTreeFeature_FallenTrunk_LogDecorationFeatureAndTrunkDecoration_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	resolver := stubResolver{&stubDelegate{}}
	ctx := &BuildContext{Palette: pal, Resolver: resolver, Identifier: "test:fallen", FileID: "test:fallen", Warn: func(string) {}}

	body := vanillaFallenTrunkBody()
	body["fallen_trunk"].(map[string]any)["log_decoration_feature"] = "test:delegate"
	body["fallen_trunk"].(map[string]any)["trunk_decoration"] = map[string]any{
		"decoration_block":  "minecraft:vine",
		"decoration_chance": map[string]any{"numerator": float64(1), "denominator": float64(2)},
	}
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("want success, got %v", err)
	}
	tf := f.(*TreeFeature)
	if len(tf.warnings) != 0 {
		t.Fatalf("warnings = %v, want none -- both fields are now implemented", tf.warnings)
	}
	if tf.fallen == nil {
		t.Fatal("want fallen non-nil")
	}
	if tf.fallen.logDecorationRef != "test:delegate" || tf.fallen.logDecorationResolver == nil {
		t.Errorf("logDecorationRef/Resolver = %q/%v, want \"test:delegate\"/non-nil", tf.fallen.logDecorationRef, tf.fallen.logDecorationResolver)
	}
	if tf.fallen.decoration == nil {
		t.Fatal("want fallen.decoration non-nil")
	}
}

// TestBuildTreeFeature_FallenTrunk_LogDecorationFeature_MustBeAStringReference proves a malformed
// log_decoration_feature value (not a plain "namespace:id" string) is still rejected, not silently
// coerced or ignored.
func TestBuildTreeFeature_FallenTrunk_LogDecorationFeature_MustBeAStringReference(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:fallen", FileID: "test:fallen", Warn: func(string) {}}
	body := vanillaFallenTrunkBody()
	body["fallen_trunk"].(map[string]any)["log_decoration_feature"] = float64(5)
	if _, err := buildTreeFeature(body, ctx); err == nil {
		t.Fatal("want error, got nil -- log_decoration_feature must be a string reference")
	}
}

// TestBuildTreeFeature_MegaTrunk_LogDecorationFeature_WarningStaysGeneric proves the log_decoration_
// feature warning-suppression added for fallen_trunk is scoped to that trunk kind specifically, not
// a global relaxation: mega_trunk has no wiring for this key at all (only the fallen trunk
// accepts it -- see tree.go's module header), so setting it on a mega_trunk body must still
// produce the generic "not implemented" warning.
func TestBuildTreeFeature_MegaTrunk_LogDecorationFeature_WarningStaysGeneric(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:mega", FileID: "test:mega", Warn: func(string) {}}
	body := vanillaMegaJungleTrunkBody()
	body["mega_trunk"].(map[string]any)["log_decoration_feature"] = "test:delegate"
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("want success (with a warning), got error %v", err)
	}
	tf := f.(*TreeFeature)
	found := false
	for _, w := range tf.warnings {
		if strings.Contains(w, "log_decoration_feature is not implemented") {
			found = true
		}
	}
	if !found {
		t.Errorf("warnings = %v, want one naming log_decoration_feature as not implemented", tf.warnings)
	}
}

// TestFallenTrunk_LogDecorationFeature_DelegatesOncePerLogAtLogPosition pins the RUNTIME behavior:
// the fallen-log placement's own loop calls the resolved feature's placement entry ONCE
// PER LOG placed along the line, at that log's own position, AFTER the block write (see
// placeFallenTrunk's own doc comment). log_length is forced to a
// fixed 3 so logLen computes to exactly 1 (logMin=logMax=3, degenerate -> 0 draws;
// height_modifier {0,0} degenerate -> 0 draws; logLen = 3+0-2 = 1), isolating a SINGLE log and a
// SINGLE delegate call. The log DESCENDS to rest on the ground (the descend loop):
// the test volume's dirt floor is at y=9, so the log lands at y=10, five
// below the origin -- the pre-rewrite flat-at-origin.Y behavior would put it at y=15.
func TestFallenTrunk_LogDecorationFeature_DelegatesOncePerLogAtLogPosition(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	log := pal.Get("minecraft:mangrove_log", nil)
	delegate := &stubDelegate{}
	trunk := &fallenTrunk{
		logMin: 3, logMax: 3,
		stumpMin: 1, stumpMax: 1, // the parse-time default -- needed for the engaged return
		logX: log, logZ: log,
		logDecorationRef:      "test:delegate",
		logDecorationResolver: stubResolver{delegate},
	}
	f := &TreeFeature{identifier: "test:fallen", trunkBlock: log, fallen: trunk, mayReplace: block.MatchSet{}}

	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	// direction draw=0 -> facing 2 (north, dz=-1); startOffset draw=0 -> startOffset=2.
	rnd := &spruceScriptedRandom{bounds: []int{0, 0}}
	got := placeTestTree(f, v, origin, rnd)

	// The game returns the last stump cell + 1, NOT the origin.
	wantReturn := wgen.BlockPos{X: origin.X, Y: origin.Y + 1, Z: origin.Z}
	if got == nil || *got != wantReturn {
		t.Fatalf("Place() = %v, want %v (stump top + 1)", got, wantReturn)
	}
	if !delegate.called {
		t.Fatal("want log_decoration_feature's delegate to have been called")
	}
	wantLogPos := wgen.BlockPos{X: origin.X, Y: 10, Z: origin.Z - 2}
	if delegate.origin != wantLogPos {
		t.Errorf("delegate called at origin=%v, want %v (the log's own rested position)", delegate.origin, wantLogPos)
	}
	if got := v.GetBlock(wantLogPos); got != log {
		t.Errorf("log block at %v = %v, want the fallen log", wantLogPos, pal.Entry(got))
	}
}

// TestFallenTrunk_LogDecorationFeature_AbsentIsNoOp proves the default (log_decoration_
// feature omitted) case never attempts a resolve or delegate call.
func TestFallenTrunk_LogDecorationFeature_AbsentIsNoOp(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	log := pal.Get("minecraft:mangrove_log", nil)
	trunk := &fallenTrunk{
		logMin: 3, logMax: 3,
		stumpMin: 1, stumpMax: 1,
		logX: log, logZ: log,
		// logDecorationRef left empty -- absent key, the common case.
	}
	f := &TreeFeature{identifier: "test:fallen", trunkBlock: log, fallen: trunk, mayReplace: block.MatchSet{}}
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	rnd := &spruceScriptedRandom{bounds: []int{0, 0}}
	got := placeTestTree(f, v, origin, rnd)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}
}

// TestFallenTrunk_DescendsAndRequiresSupport pins the two structural pieces of the game's
// fallen-log placement:
//
//  1. the log DESCENDS from start.y+stump_height to rest on the first non-passable ground; and
//  2. the validity walk is ALL-OR-NOTHING with a <=2-consecutive-unsupported rule: the third
//     consecutive cell whose below-block fails the block's solid-blocking predicate kills the whole log
//     (the stump still places).
func TestFallenTrunk_DescendsAndRequiresSupport(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	log := pal.Get("minecraft:oak_log", nil)

	build := func(logLenTotal int) *TreeFeature {
		trunk := &fallenTrunk{
			logMin: logLenTotal, logMax: logLenTotal,
			stumpMin: 1, stumpMax: 1,
			logX: log, logZ: log,
		}
		return &TreeFeature{identifier: "test:fallen", trunkBlock: log, fallen: trunk, mayReplace: block.MatchSet{}}
	}

	// Case 1: fully supported line (the dirt floor at y=9 spans the whole volume). logLen = 5-2 = 3.
	// direction draw=1 -> facing 3 (south, dz=+1); startOffset draw=0 -> 2. Cells z=2,3,4 at y=10.
	f := build(5)
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	if placeTestTree(f, v, origin, &spruceScriptedRandom{bounds: []int{1, 0}}) == nil {
		t.Fatal("supported fallen log: Place() = nil, want success")
	}
	for _, z := range []int{2, 3, 4} {
		p := wgen.BlockPos{X: 0, Y: 10, Z: z}
		if v.GetBlock(p) != log {
			t.Errorf("no rested log at %v (descend must land the line on the ground)", p)
		}
	}
	// Nothing at the pre-rewrite flat altitude.
	if v.GetBlock(wgen.BlockPos{X: 0, Y: 15, Z: 2}) == log {
		t.Error("log at the origin's own y -- the descend-to-ground step is missing again")
	}

	// Case 2: three consecutive unsupported cells kill the WHOLE line (all-or-nothing), while the
	// stump still places. Carve a 3-cell hole in the floor under cells z=2..4.
	v2, pal2 := newTreeTestVolume(t, 10)
	log2 := pal2.Get("minecraft:oak_log", nil)
	air := pal2.Get("minecraft:air", nil)
	for _, z := range []int{2, 3, 4} {
		v2.SetBlock(wgen.BlockPos{X: 0, Y: 9, Z: z}, air)
	}
	trunk2 := &fallenTrunk{
		logMin: 5, logMax: 5,
		stumpMin: 1, stumpMax: 1,
		logX: log2, logZ: log2,
	}
	f2 := &TreeFeature{identifier: "test:fallen", trunkBlock: log2, fallen: trunk2, mayReplace: block.MatchSet{}}
	// Same draws: facing south, startOffset 2 -> the line starts on the z=2 column, whose floor is
	// now carved out, so the descend runs to the volume floor and every below-probe on z=2..4 fails
	// the support rule -- three consecutive unsupported cells, all-or-nothing abandon.
	if placeTestTree(f2, v2, origin, &spruceScriptedRandom{bounds: []int{1, 0}}) == nil {
		t.Fatal("unsupported fallen log: Place() = nil, want success (the stump still engages the return)")
	}
	for y := 0; y < 16; y++ {
		for _, z := range []int{2, 3, 4} {
			if p := (wgen.BlockPos{X: 0, Y: y, Z: z}); v2.GetBlock(p) == log2 {
				t.Errorf("log at %v -- the >2-consecutive-unsupported rule must abandon the whole line", p)
			}
		}
	}
	if v2.GetBlock(origin) != log2 {
		t.Error("stump did not place -- the stump must be independent of the log's validity walk")
	}
}

// TestFallenTrunk_PlacesThroughLeafLitterEquivalents pins the leaf-litter tolerance of fallen
// trunks (newer game versions): a non-empty cell that passes the buildable-over test (checked in
// both the descend probe and the validity walk) is treated as passable, so the log drops through
// and overwrites replaceable ground cover such as leaf litter instead of failing on it.
func TestFallenTrunk_PlacesThroughLeafLitterEquivalents(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	log := pal.Get("minecraft:oak_log", nil)
	grass := pal.Get("minecraft:short_grass", nil)
	// Ground cover on every cell the log line will occupy (y=10, on the dirt at y=9).
	for _, z := range []int{2, 3, 4} {
		v.SetBlock(wgen.BlockPos{X: 0, Y: 10, Z: z}, grass)
	}
	trunk := &fallenTrunk{
		logMin: 5, logMax: 5,
		stumpMin: 1, stumpMax: 1,
		logX: log, logZ: log,
	}
	f := &TreeFeature{identifier: "test:fallen", trunkBlock: log, fallen: trunk, mayReplace: block.MatchSet{}}
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	if placeTestTree(f, v, origin, &spruceScriptedRandom{bounds: []int{1, 0}}) == nil {
		t.Fatal("Place() = nil, want success")
	}
	for _, z := range []int{2, 3, 4} {
		p := wgen.BlockPos{X: 0, Y: 10, Z: z}
		if v.GetBlock(p) != log {
			t.Errorf("cell %v = %v, want the log to replace the ground cover (canBeBuiltOver)", p, pal.Entry(v.GetBlock(p)))
		}
	}
}

// TestFallenTrunk_TrunkDecoration_StumpColumnDecoratesOnSuccessfulPlacement pins trunk_decoration
// on the stump column: each stump layer that successfully places calls
// placeDecoratedBlock/megaTrunkDecoration.place with mangroveTrunkAllDirections, the SAME shared
// helper mangrove_roots' own above_root branch uses.
func TestFallenTrunk_TrunkDecoration_StumpColumnDecoratesOnSuccessfulPlacement(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	log := pal.Get("minecraft:mangrove_log", nil)
	vine := pal.Get("minecraft:vine", nil)
	trunk := &fallenTrunk{
		logMin: 3, logMax: 3,
		stumpMin: 1, stumpMax: 1, // degenerate -- exactly one stump layer, 0 draws
		logX: log, logZ: log,
		decoration: &megaTrunkDecoration{
			entries: []megaTrunkDecorationEntry{{blockID: vine, countMin: 1, countMax: 1}},
			chance:  chanceInformation{isFraction: true, numerator: 1, denominator: 2},
			pal:     pal,
		},
	}
	f := &TreeFeature{identifier: "test:fallen", trunkBlock: log, fallen: trunk, mayReplace: block.MatchSet{}}
	origin := wgen.BlockPos{X: 0, Y: 15, Z: 0}
	// direction=0, startOffset=2 (2 draws for the line), then stump's own 4 direction rolls: west ok
	// (0), east/north/south fail (1,1,1).
	rnd := &spruceScriptedRandom{bounds: []int{0, 0, 0, 1, 1, 1}}
	got := placeTestTree(f, v, origin, rnd)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}
	stumpPos := wgen.BlockPos{X: origin.X, Y: origin.Y, Z: origin.Z}
	if gb := v.GetBlock(stumpPos); gb != log {
		t.Fatalf("stump block = %v, want the trunk log", pal.Entry(gb))
	}
	westDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	if got := v.GetBlock(wgen.BlockPos{X: origin.X - 1, Y: origin.Y, Z: origin.Z}); got != westDecorated {
		t.Errorf("west of stump = %v, want vine decorated west", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: origin.X + 1, Y: origin.Y, Z: origin.Z}); !pal.IsAir(got) {
		t.Errorf("east of stump = %v, want air (roll failed)", pal.Entry(got))
	}
}

// --- Real CLI-driven placement -------------------------------------------------------------------
//
// See tree_cli_test.go (package main, cmd/featurelab) for the actual `featurelab generate` CLI
// run growing a real tree_feature using the "canopy", "fancy_canopy", "spruce_canopy",
// "random_spread_canopy", "roofed_canopy", "mangrove_canopy", "mega_canopy", "mega_pine_canopy", "cherry_canopy",
// "mangrove_trunk", and can_be_submerged keys end to end.

// --- unimplemented-trunk-field warnings ---------------------------------------------------------
//
// These pin the load-time warnings for keys owned solely by the acacia and fancy trunks that this
// port accepts but does not consume. A warning that quietly stops firing is worse than no warning,
// because the file still loads and the only signal that the tree is wrong is gone -- hence a test
// rather than trust.
//
// The bodies below follow vanilla's own definitions (savanna_tree_feature.json /
// fancy_oak_tree_feature.json), so a body shape the game does not actually ship cannot make these
// pass. `branches` deliberately has NO assertion of its own here: it is declared by the
// placement-time warning list instead, which TestTreeFeature_Place_WarnsBranchesUnimplemented
// territory already covers via the CLI test.

func collectTreeBuildWarnings(t *testing.T, body map[string]any) []string {
	t.Helper()
	var got []string
	ctx := &BuildContext{
		Palette:    block.NewPalette(),
		Identifier: "test:tree",
		FileID:     "test:tree",
		Warn:       func(msg string) { got = append(got, msg) },
	}
	if _, err := buildTreeFeature(body, ctx); err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	return got
}

func warningNaming(t *testing.T, warnings []string, needle string) string {
	t.Helper()
	for _, w := range warnings {
		if strings.Contains(w, needle) {
			return w
		}
	}
	t.Errorf("no warning naming %q; got %d warning(s):\n  %s",
		needle, len(warnings), strings.Join(warnings, "\n  "))
	return ""
}

func acaciaTrunkBody(trunkExtra, leanExtra map[string]any) map[string]any {
	lean := map[string]any{
		"allow_diagonal_growth": true,
		"lean_height":           map[string]any{"range_min": float64(1), "range_max": float64(2)},
		"lean_steps":            map[string]any{"range_min": float64(1), "range_max": float64(2)},
	}
	for k, v := range leanExtra {
		lean[k] = v
	}
	trunk := map[string]any{
		"trunk_width":  float64(1),
		"trunk_height": map[string]any{"base": float64(6)},
		"trunk_block":  "minecraft:oak_log",
		"trunk_lean":   lean,
	}
	for k, v := range trunkExtra {
		trunk[k] = v
	}
	return map[string]any{
		"acacia_trunk": trunk,
		"acacia_canopy": map[string]any{
			"canopy_size": float64(1),
			"leaf_block":  "minecraft:oak_leaves",
		},
	}
}

func buildAcaciaTree(t *testing.T, pal *block.Palette, body map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:acacia", FileID: "test:acacia", Warn: func(string) {}}
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	return f.(*TreeFeature)
}

// countLeaves reports how many cells in [minY,maxY] hold the given leaf id, which is how the
// canopy-gating tests ask "did a canopy run, and WHERE" without depending on its exact shape.
func countLeaves(v *volume.Volume, leaf block.ID, radius, minY, maxY int) int {
	n := 0
	for y := minY; y <= maxY; y++ {
		for x := -radius; x <= radius; x++ {
			for z := -radius; z <= radius; z++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == leaf {
					n++
				}
			}
		}
	}
	return n
}

// TestAcaciaTrunk_LeanStartIsHeightMinusDraw pins the CORRECTED lean start. The trunk placement
// computes height minus the lean_height draw -- so with height 6 and a
// degenerate lean_height of {5,6} (treeIntRangeValue returns min with zero draws) the lean must
// begin at index 6-5 = 1, i.e. the SECOND log. The pre-correction code used the draw directly and
// would have started the lean at index 5.
func TestAcaciaTrunk_LeanStartIsHeightMinusDraw(t *testing.T) {
	body := acaciaTrunkBody(nil, map[string]any{
		"lean_height": map[string]any{"range_min": float64(5), "range_max": float64(6)},
		"lean_steps":  map[string]any{"range_min": float64(9), "range_max": float64(10)},
	})
	v, pal := newTreeTestVolume(t, 10)
	f := buildAcaciaTree(t, pal, body)
	log := pal.Get("minecraft:oak_log", nil)

	// Draw 1 is the trunk lean direction; lean_height/lean_steps/lean_length are all degenerate
	// (zero draws). Draw 2 is the branch routine's own direction re-roll, made equal to the trunk
	// direction so it returns immediately and places nothing.
	rnd := &intBoundScriptedRandom{vals: []int{0, 0}}
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	if placeTestTree(f, v, origin, rnd) == nil {
		t.Fatal("tree did not place")
	}

	// direction 0 is +Z (leanDZ[0]=1). Index 0 sits at the origin; indices 1..4 each step one cell
	// further in +Z, because lean_steps is effectively unlimited here. Index 5 is the trunk top and
	// the canopy overwrites it with a leaf, so it is deliberately not asserted here.
	for i := 0; i <= 4; i++ {
		wantZ := 0
		if i >= 1 {
			wantZ = i
		}
		pos := wgen.BlockPos{X: 0, Y: origin.Y + i, Z: wantZ}
		if got := v.GetBlock(pos); got != log {
			t.Errorf("index %d: no log at %+v (lean must start at index 1 = height-5)", i, pos)
		}
	}
	// The pre-correction behaviour: no lean until index 5, so (0, y+1, 0) would hold a log.
	if v.GetBlock(wgen.BlockPos{X: 0, Y: origin.Y + 1, Z: 0}) == log {
		t.Error("log at the un-leaned index 1 -- leanStart looks like the raw draw again, not height-draw")
	}
}

// TestAcaciaTrunk_LeanLengthExtendsSideways pins lean_length: it extends the trunk loop past
// trunk_height (the game adds the draw to the height) while the y write stays guarded by
// `index < height`, so the tail runs HORIZONTALLY at the top log's level rather than growing the
// tree taller.
func TestAcaciaTrunk_LeanLengthExtendsSideways(t *testing.T) {
	body := acaciaTrunkBody(nil, map[string]any{
		// Lean from index 0 (height 6 - 6), unlimited steps, plus 3 extra iterations.
		"lean_height": map[string]any{"range_min": float64(6), "range_max": float64(7)},
		"lean_steps":  map[string]any{"range_min": float64(20), "range_max": float64(21)},
		"lean_length": map[string]any{"range_min": float64(3), "range_max": float64(4)},
	})
	v, pal := newTreeTestVolume(t, 12)
	f := buildAcaciaTree(t, pal, body)
	log := pal.Get("minecraft:oak_log", nil)

	rnd := &intBoundScriptedRandom{vals: []int{0, 0}}
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	if placeTestTree(f, v, origin, rnd) == nil {
		t.Fatal("tree did not place")
	}

	// height 6 -> indices 0..5, and lean_length 3 adds indices 6..8. leanStart is 0 here, so every
	// index (including 0) steps once in +Z before placing: index i sits at z=i+1.
	topY := origin.Y + 5
	// The tail cells all sit at topY, marching on in +Z past the 6th log. Indices 7 and 8 land
	// under the canopy anchored at the final cell, so the two asserted here are the surviving ones.
	for _, dz := range []int{6, 7} {
		pos := wgen.BlockPos{X: 0, Y: topY, Z: dz}
		if got := v.GetBlock(pos); got != log {
			t.Errorf("lean_length tail: no log at %+v", pos)
		}
	}
	// The decisive claim: the tail did NOT grow the trunk taller. Nothing may exist above topY
	// anywhere along the tail, so a y that kept incrementing would fail here.
	for _, dz := range []int{6, 7, 8, 9} {
		pos := wgen.BlockPos{X: 0, Y: topY + 1, Z: dz}
		if v.GetBlock(pos) == log {
			t.Errorf("lean_length grew the trunk upward at %+v; y must be frozen past trunk_height", pos)
		}
	}
}

// TestAcaciaTrunk_MinHeightForCanopyGatesAnchorOnly proves min_height_for_canopy moves the CANOPY
// anchor without changing which logs are placed (the trunk placement gates only the anchor push, on
// the log index reaching the threshold), and that a trunk too short to clear it hands the canopy a
// zeroed position -- the game leaves the anchor {0,0,0} when no cell qualified.
func TestAcaciaTrunk_MinHeightForCanopyGatesAnchorOnly(t *testing.T) {
	t.Run("short trunk under the threshold grows no canopy", func(t *testing.T) {
		body := acaciaTrunkBody(map[string]any{
			// height 2, threshold 5 -> no index ever qualifies as an anchor.
			"trunk_height": map[string]any{"base": float64(2), "min_height_for_canopy": float64(5)},
		}, nil)
		v, pal := newTreeTestVolume(t, 10)
		f := buildAcaciaTree(t, pal, body)
		log, leaf := pal.Get("minecraft:oak_log", nil), pal.Get("minecraft:oak_leaves", nil)

		rnd := &intBoundScriptedRandom{vals: []int{0, 0}}
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
		if placeTestTree(f, v, origin, rnd) == nil {
			t.Fatal("tree did not place")
		}
		// The logs are still there -- the gate is anchor-only, never placement.
		if v.GetBlock(wgen.BlockPos{X: 0, Y: origin.Y, Z: 0}) != log {
			t.Error("no trunk log at the origin; min_height_for_canopy must not gate placement")
		}
		// No canopy near the tree...
		if n := countLeaves(v, leaf, 10, origin.Y-2, 29); n != 0 {
			t.Errorf("%d leaves near the tree: a trunk shorter than min_height_for_canopy anchors no "+
				"canopy there", n)
		}
		// ...because the game hands it the ZEROED anchor instead, which in this volume lands
		// down at world y=0. Asserting the leaves are actually THERE keeps this test honest: a
		// version that simply skipped the canopy call would pass the check above and fail here.
		if n := countLeaves(v, leaf, 10, 0, 4); n == 0 {
			t.Error("no leaves at the bottom of the volume either; the canopy should have been " +
				"placed at the zeroed {0,0,0} anchor, not skipped")
		}
	})

	t.Run("tall trunk clears the threshold and grows one", func(t *testing.T) {
		body := acaciaTrunkBody(map[string]any{
			"trunk_height": map[string]any{"base": float64(6), "min_height_for_canopy": float64(2)},
		}, nil)
		v, pal := newTreeTestVolume(t, 10)
		f := buildAcaciaTree(t, pal, body)
		leaf := pal.Get("minecraft:oak_leaves", nil)

		rnd := &intBoundScriptedRandom{vals: []int{0, 0}}
		if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, rnd) == nil {
			t.Fatal("tree did not place")
		}
		if countLeaves(v, leaf, 10, 10, 29) == 0 {
			t.Error("no canopy at the trunk top even though the trunk clears min_height_for_canopy")
		}
	})
}

// TestAcaciaBranches_LeaningPath covers the allow_diagonal_growth=true routine
// the leaning-branch pass: the direction draw is unconditional, a direction equal to
// the trunk lean aborts, and a winning roll walks one diagonal branch upward-and-outward.
func TestAcaciaBranches_LeaningPath(t *testing.T) {
	branches := func(chance float64) map[string]any {
		return map[string]any{
			// Degenerate ranges: zero draws, known constants. position 1, length 3.
			"branch_position": map[string]any{"range_min": float64(1), "range_max": float64(2)},
			"branch_length":   map[string]any{"range_min": float64(3), "range_max": float64(4)},
			"branch_chance":   chance,
		}
	}

	t.Run("branch direction equal to the trunk lean places nothing", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 10)
		f := buildAcaciaTree(t, pal, acaciaTrunkBody(map[string]any{"branches": branches(100)}, nil))
		log := pal.Get("minecraft:oak_log", nil)
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

		// Both draws are 0: trunk lean direction 0, branch direction 0 -> equal -> abort.
		rnd := &intBoundScriptedRandom{vals: []int{0, 0}}
		if placeTestTree(f, v, origin, rnd) == nil {
			t.Fatal("tree did not place")
		}
		if rnd.idx != 2 {
			t.Errorf("consumed %d draws, want exactly 2: the branch direction draw happens BEFORE "+
				"the equality test, so it must be spent even when the branch is abandoned", rnd.idx)
		}
		// A branch would have run along X; nothing may appear off the trunk's own axis.
		for _, x := range []int{-3, -2, -1, 1, 2, 3} {
			for y := origin.Y; y < origin.Y+8; y++ {
				for z := -3; z <= 3; z++ {
					if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == log {
						t.Fatalf("log at (%d,%d,%d): no branch may be placed when the branch direction "+
							"matches the trunk lean", x, y, z)
					}
				}
			}
		}
	})

	t.Run("winning roll walks a diagonal branch", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 12)
		f := buildAcaciaTree(t, pal, acaciaTrunkBody(map[string]any{"branches": branches(100)}, nil))
		log := pal.Get("minecraft:oak_log", nil)
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

		// Trunk lean direction 0 (+Z), branch direction 3 (+X per leanDX). leanStart = 6-1 = 5,
		// so the branch's own start index is 5 - position(1) = 4.
		rnd := &intBoundScriptedRandom{vals: []int{0, 3}}
		if placeTestTree(f, v, origin, rnd) == nil {
			t.Fatal("tree did not place")
		}
		// Branch starts at index 4 and steps +1x and +1y per cell, bounded by trunk height 6.
		want := []wgen.BlockPos{
			{X: 1, Y: origin.Y + 4, Z: 0},
			{X: 2, Y: origin.Y + 5, Z: 0},
		}
		for i, p := range want {
			if got := v.GetBlock(p); got != log {
				t.Errorf("branch cell %d: no log at %+v", i, p)
			}
		}
		// The walk stops when index+1 reaches the trunk height.
		if v.GetBlock(wgen.BlockPos{X: 3, Y: origin.Y + 6, Z: 0}) == log {
			t.Error("branch ran past its height bound")
		}
	})

	t.Run("failing chance roll places nothing and still spends the direction draw", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 10)
		f := buildAcaciaTree(t, pal, acaciaTrunkBody(map[string]any{"branches": branches(0)}, nil))
		log := pal.Get("minecraft:oak_log", nil)
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

		rnd := &intBoundScriptedRandom{vals: []int{0, 3}}
		if placeTestTree(f, v, origin, rnd) == nil {
			t.Fatal("tree did not place")
		}
		if rnd.idx != 2 {
			t.Errorf("consumed %d draws, want 2 (trunk direction + branch direction; a 0%% chance "+
				"rolls false without drawing)", rnd.idx)
		}
		if v.GetBlock(wgen.BlockPos{X: 1, Y: origin.Y + 4, Z: 0}) == log {
			t.Error("branch placed despite a 0% branch_chance")
		}
	})
}

// TestAcaciaBranches_VerticalPath covers the allow_diagonal_growth=false routine
// the vertical-branch pass: it sweeps the ring around the trunk footprint, and each
// winning cell drops a DOWNWARD column of branch_length logs starting branch_position below the
// canopy anchor. With a 100% chance every ring cell wins, which also pins the ring's extent.
func TestAcaciaBranches_VerticalPath(t *testing.T) {
	body := acaciaTrunkBody(map[string]any{
		"branches": map[string]any{
			"branch_position": map[string]any{"range_min": float64(1), "range_max": float64(2)},
			"branch_length":   map[string]any{"range_min": float64(2), "range_max": float64(3)},
			"branch_chance":   float64(100),
		},
	}, map[string]any{"allow_diagonal_growth": false})
	v, pal := newTreeTestVolume(t, 10)
	f := buildAcaciaTree(t, pal, body)
	log := pal.Get("minecraft:oak_log", nil)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

	// Only the trunk lean direction is drawn: the vertical path draws no direction of its own, and
	// every int range here is degenerate.
	rnd := &intBoundScriptedRandom{vals: []int{0}}
	if placeTestTree(f, v, origin, rnd) == nil {
		t.Fatal("tree did not place")
	}

	// trunk_width 1, so the ring is every cell of the 3x3 block around the trunk except (0,0).
	anchorY := origin.Y + 5 // top log of a height-6 trunk
	for dx := -1; dx <= 1; dx++ {
		for dz := -1; dz <= 1; dz++ {
			if dx == 0 && dz == 0 {
				continue
			}
			// Column of branch_length=2, walking DOWN from anchorY - position.
			for _, y := range []int{anchorY - 1, anchorY - 2} {
				pos := wgen.BlockPos{X: dx, Y: y, Z: dz}
				if got := v.GetBlock(pos); got != log {
					t.Errorf("ring cell (%d,%d): no log at %+v", dx, dz, pos)
				}
			}
			if v.GetBlock(wgen.BlockPos{X: dx, Y: anchorY - 3, Z: dz}) == log {
				t.Errorf("ring cell (%d,%d): column longer than branch_length", dx, dz)
			}
		}
	}
	// Cells beyond the ring must be untouched: the sweep spans -1..trunk_width only.
	if v.GetBlock(wgen.BlockPos{X: 2, Y: anchorY - 1, Z: 0}) == log {
		t.Error("log outside the ring")
	}
}

// TestAcaciaBranches_DrawOrderDiffersBetweenPaths pins the one detail most likely to be
// "corrected" by a future reader into consistency: the leaning routine draws branch_position
// first, then branch_length; the vertical routine draws branch_length
// first, then branch_position. Both ranges here really do draw, and they
// are sized so a swapped order produces a visibly different geometry.
func TestAcaciaBranches_DrawOrderDiffersBetweenPaths(t *testing.T) {
	// position range {1,4} draws nextIntBound(3); length range {2,6} draws nextIntBound(4).
	branches := map[string]any{
		"branch_position": map[string]any{"range_min": float64(1), "range_max": float64(4)},
		"branch_length":   map[string]any{"range_min": float64(2), "range_max": float64(6)},
		"branch_chance":   float64(100),
	}

	t.Run("leaning draws position then length", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 12)
		f := buildAcaciaTree(t, pal, acaciaTrunkBody(map[string]any{"branches": branches}, nil))
		log := pal.Get("minecraft:oak_log", nil)
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

		// trunk direction 0; branch direction 3 (+X); then position draw 2 -> position 3;
		// then length draw 0 -> length 2. A swapped order would read position 1 / length 4.
		rnd := &intBoundScriptedRandom{vals: []int{0, 3, 2, 0}}
		if placeTestTree(f, v, origin, rnd) == nil {
			t.Fatal("tree did not place")
		}
		// index = leanStart(5) - position(3) = 2, so the first branch cell sits at index 2.
		if got := v.GetBlock(wgen.BlockPos{X: 1, Y: origin.Y + 2, Z: 0}); got != log {
			t.Error("no branch log at index 2; branch_position must be the FIRST draw")
		}
		if v.GetBlock(wgen.BlockPos{X: 1, Y: origin.Y + 4, Z: 0}) == log {
			t.Error("branch log at index 4: looks like branch_length was drawn before branch_position")
		}
	})

	t.Run("vertical draws length then position", func(t *testing.T) {
		body := acaciaTrunkBody(map[string]any{"branches": branches},
			map[string]any{"allow_diagonal_growth": false})
		v, pal := newTreeTestVolume(t, 12)
		f := buildAcaciaTree(t, pal, body)
		log := pal.Get("minecraft:oak_log", nil)
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

		// trunk direction 0; then for the FIRST ring cell (-1,-1): length draw 3 -> length 5,
		// position draw 0 -> position 1. Remaining entries feed the other seven ring cells.
		vals := []int{0, 3, 0}
		for i := 0; i < 40; i++ {
			vals = append(vals, 0)
		}
		rnd := &intBoundScriptedRandom{vals: vals}
		if placeTestTree(f, v, origin, rnd) == nil {
			t.Fatal("tree did not place")
		}
		anchorY := origin.Y + 5
		// length 5 from anchorY-1 downward. A swapped order (length 2, position 4) would place
		// only two cells, starting at anchorY-4.
		for i := 1; i <= 5; i++ {
			pos := wgen.BlockPos{X: -1, Y: anchorY - i, Z: -1}
			if got := v.GetBlock(pos); got != log {
				t.Errorf("no log at %+v; branch_length must be the FIRST draw on the vertical path", pos)
			}
		}
	})
}

// TestAcaciaBranches_BranchCanopy proves branches.branch_canopy resolves through the shared canopy
// dispatch and runs at the branch tip. The branch canopy uses a leaf block the main canopy does
// not, so its presence cannot be confused with the tree's own foliage.
func TestAcaciaBranches_BranchCanopy(t *testing.T) {
	body := acaciaTrunkBody(map[string]any{
		"branches": map[string]any{
			"branch_position": map[string]any{"range_min": float64(1), "range_max": float64(2)},
			"branch_length":   map[string]any{"range_min": float64(1), "range_max": float64(2)},
			"branch_chance":   float64(100),
			"branch_canopy": map[string]any{
				"acacia_canopy": map[string]any{
					"canopy_size":     float64(1),
					"leaf_block":      "minecraft:birch_leaves",
					"simplify_canopy": true,
				},
			},
		},
	}, nil)
	v, pal := newTreeTestVolume(t, 12)
	f := buildAcaciaTree(t, pal, body)
	branchLeaf := pal.Get("minecraft:birch_leaves", nil)

	rnd := &intBoundScriptedRandom{vals: []int{0, 3}}
	if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, rnd) == nil {
		t.Fatal("tree did not place")
	}
	if countLeaves(v, branchLeaf, 12, 0, 29) == 0 {
		t.Error("branch_canopy placed no leaves; it must resolve and run at the branch tip")
	}
}

// TestBuildTreeFeature_AcaciaBranchesRequiredKeys pins the three REQUIRED sub-keys:
// branch_length, branch_position and branch_chance. `branches` itself and branch_canopy are
// optional.
func TestBuildTreeFeature_AcaciaBranchesRequiredKeys(t *testing.T) {
	full := map[string]any{
		"branch_position": map[string]any{"range_min": float64(1), "range_max": float64(3)},
		"branch_length":   map[string]any{"range_min": float64(1), "range_max": float64(4)},
		"branch_chance":   float64(100),
	}
	newCtx := func() *BuildContext {
		return &BuildContext{Palette: block.NewPalette(), Identifier: "test:acacia", FileID: "test:acacia", Warn: func(string) {}}
	}

	if _, err := buildTreeFeature(acaciaTrunkBody(nil, nil), newCtx()); err != nil {
		t.Errorf("branches absent must be accepted (it is optional): %v", err)
	}
	if _, err := buildTreeFeature(acaciaTrunkBody(map[string]any{"branches": full}, nil), newCtx()); err != nil {
		t.Errorf("complete branches must build: %v", err)
	}
	for _, key := range []string{"branch_position", "branch_length", "branch_chance"} {
		partial := map[string]any{}
		for k, v := range full {
			if k != key {
				partial[k] = v
			}
		}
		if _, err := buildTreeFeature(acaciaTrunkBody(map[string]any{"branches": partial}, nil), newCtx()); err == nil {
			t.Errorf("branches without %s must be rejected: it is schema-required", key)
		}
	}
}

// --- fancy_trunk -------------------------------------------------------------------------------
//
// These replace the four "field is not implemented" warnings this trunk shape used to emit. Each
// one targets a specific step of the fancy trunk's placement, because the algorithm is float
// geometry whose output is not eyeball-checkable: a swapped sin/cos or a dropped +0.5 still grows a
// plausible tree. The claims pinned here are the ones that would silently survive such a slip.

// fancyScriptedRandom scripts NextIntBound (the height sample) and NextFloat (two draws per
// foliage cluster) separately, and counts both, so a test can assert HOW MANY draws a phase spent
// as well as what it produced.
type fancyScriptedRandom struct {
	bounds   []int
	floats   []float64
	boundIdx int
	floatIdx int
}

func (s *fancyScriptedRandom) NextIntBound(int) int {
	if s.boundIdx >= len(s.bounds) {
		return 0
	}
	v := s.bounds[s.boundIdx]
	s.boundIdx++
	return v
}

func (s *fancyScriptedRandom) NextFloat() float64 {
	if s.floatIdx >= len(s.floats) {
		return 0
	}
	v := s.floats[s.floatIdx]
	s.floatIdx++
	return v
}
func (s *fancyScriptedRandom) NextInt() int32                { panic("unused") }
func (s *fancyScriptedRandom) NextDouble() float64           { panic("unused") }
func (s *fancyScriptedRandom) NextBoolean() bool             { panic("unused") }
func (s *fancyScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (s *fancyScriptedRandom) SetSeed(uint32)                {}
func (s *fancyScriptedRandom) GetSeed() uint32               { return 0 }

var _ random.IRandom = (*fancyScriptedRandom)(nil)

func fancyTrunkBody(trunkExtra map[string]any) map[string]any {
	trunk := map[string]any{
		"trunk_width":  float64(1),
		"trunk_height": map[string]any{"base": float64(8), "variance": float64(3), "scale": float64(0.6)},
		"trunk_block":  "minecraft:oak_log",
		"branches": map[string]any{
			"slope":               float64(0.4),
			"density":             float64(1.0),
			"min_altitude_factor": float64(0.2),
		},
		"width_scale":             float64(1.0),
		"foliage_altitude_factor": float64(0.3),
	}
	for k, v := range trunkExtra {
		trunk[k] = v
	}
	return map[string]any{
		"fancy_trunk": trunk,
		"fancy_canopy": map[string]any{
			"height":     float64(2),
			"radius":     float64(1),
			"leaf_block": "minecraft:oak_leaves",
		},
		"may_grow_on": []any{"minecraft:dirt", "minecraft:grass_block"},
		"may_replace": []any{"minecraft:air"},
	}
}

func buildFancyTree(t *testing.T, pal *block.Palette, body map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:fancy", FileID: "test:fancy", Warn: func(string) {}}
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	return f.(*TreeFeature)
}

// TestBuildTreeFeature_FancyTrunkRequiredFields pins the required set. Every one of these is
// required, and `branches` itself is required here -- the opposite
// of acacia_trunk, where it is optional. Getting that backwards would silently accept a file the
// game rejects.
func TestBuildTreeFeature_FancyTrunkRequiredFields(t *testing.T) {
	newCtx := func() *BuildContext {
		return &BuildContext{Palette: block.NewPalette(), Identifier: "test:fancy", FileID: "test:fancy", Warn: func(string) {}}
	}
	if _, err := buildTreeFeature(fancyTrunkBody(nil), newCtx()); err != nil {
		t.Fatalf("a complete fancy_trunk must build: %v", err)
	}

	t.Run("branches is required", func(t *testing.T) {
		body := fancyTrunkBody(nil)
		delete(body["fancy_trunk"].(map[string]any), "branches")
		if _, err := buildTreeFeature(body, newCtx()); err == nil {
			t.Error("fancy_trunk without branches must be rejected; it is schema-required here")
		}
	})
	for _, key := range []string{"slope", "density", "min_altitude_factor"} {
		t.Run("branches."+key+" is required", func(t *testing.T) {
			body := fancyTrunkBody(nil)
			delete(body["fancy_trunk"].(map[string]any)["branches"].(map[string]any), key)
			if _, err := buildTreeFeature(body, newCtx()); err == nil {
				t.Errorf("fancy_trunk.branches without %s must be rejected", key)
			}
		})
	}
	for _, key := range []string{"width_scale", "foliage_altitude_factor"} {
		t.Run(key+" is required", func(t *testing.T) {
			body := fancyTrunkBody(nil)
			delete(body["fancy_trunk"].(map[string]any), key)
			if _, err := buildTreeFeature(body, newCtx()); err == nil {
				t.Errorf("fancy_trunk without %s must be rejected", key)
			}
		})
	}
}

// TestFancyCheckLine_MinusOneMeansClear pins the inverted return convention directly, because it
// is the single most likely thing for a later reader to "tidy up" into a bool and get backwards.
func TestFancyCheckLine_MinusOneMeansClear(t *testing.T) {
	v, pal := newTreeTestVolume(t, 4)
	stone := pal.Get("minecraft:stone", nil)
	// A NON-EMPTY may_replace is essential here: an empty MatchSet means "no restriction" in this
	// codebase's passesAllowList convention, so every block would pass and the line would always
	// read as clear. This list deliberately excludes stone.
	mayReplace := pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:oak_leaves"}}, nil, nil, nil)

	from := wgen.BlockPos{X: 0, Y: 12, Z: 0}
	to := wgen.BlockPos{X: 0, Y: 16, Z: 0}
	if got := fancyCheckLine(v, from, to, mayReplace); got != -1 {
		t.Errorf("clear line returned %d, want -1 (-1 IS the success value)", got)
	}
	// Block the third cell. An empty may_replace means "air only" for this predicate, so a stone
	// cell fails it.
	v.SetBlock(wgen.BlockPos{X: 0, Y: 14, Z: 0}, stone)
	if got := fancyCheckLine(v, from, to, mayReplace); got != 2 {
		t.Errorf("line blocked at index 2 returned %d, want 2 (the index of the first blocked cell)", got)
	}
	// The destination cell is included in the walk: steps+1 iterations.
	v.SetBlock(wgen.BlockPos{X: 0, Y: 14, Z: 0}, pal.Get("minecraft:air", nil))
	v.SetBlock(to, stone)
	if got := fancyCheckLine(v, from, to, mayReplace); got != 4 {
		t.Errorf("line blocked at its destination returned %d, want 4; the walk must include the "+
			"destination cell", got)
	}
}

// TestFancyTrunk_BlockedLineShortensRatherThanFails pins the phase-1 behaviour that reads
// backwards: an obstructed trunk line does not abort the tree, it lowers its height -- but only
// when the obstruction is ABOVE trunk_height.base. At or below base, the feature fails.
func TestFancyTrunk_BlockedLineShortensRatherThanFails(t *testing.T) {
	t.Run("blocked above base shortens", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 6)
		f := buildFancyTree(t, pal, fancyTrunkBody(map[string]any{
			"trunk_height": map[string]any{"base": float64(4), "variance": float64(1), "scale": float64(0.9)},
		}))
		log := pal.Get("minecraft:oak_log", nil)
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
		// Obstruct index 6 (y=16), well above base 4.
		v.SetBlock(wgen.BlockPos{X: 0, Y: 16, Z: 0}, pal.Get("minecraft:stone", nil))

		rnd := &fancyScriptedRandom{bounds: []int{0}, floats: make([]float64, 200)}
		if placeTestTree(f, v, origin, rnd) == nil {
			t.Fatal("an obstruction above trunk_height.base must SHORTEN the tree, not fail it")
		}
		// It still grew a trunk.
		if v.GetBlock(origin) != log {
			t.Error("no trunk log at the origin after shortening")
		}
	})

	t.Run("blocked at or below base fails", func(t *testing.T) {
		v, pal := newTreeTestVolume(t, 6)
		f := buildFancyTree(t, pal, fancyTrunkBody(map[string]any{
			"trunk_height": map[string]any{"base": float64(6), "variance": float64(1), "scale": float64(0.9)},
		}))
		log := pal.Get("minecraft:oak_log", nil)
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
		// Obstruct index 2 (y=12), below base 6.
		v.SetBlock(wgen.BlockPos{X: 0, Y: 12, Z: 0}, pal.Get("minecraft:stone", nil))

		rnd := &fancyScriptedRandom{bounds: []int{0}, floats: make([]float64, 200)}
		if placeTestTree(f, v, origin, rnd) != nil {
			t.Error("an obstruction at or below trunk_height.base must fail the feature")
		}
		if v.GetBlock(origin) == log {
			t.Error("logs were placed even though phase 1 failed")
		}
	})
}

// TestFancyTrunk_SinDrivesXCosDrivesZ pins the axis assignment. The game multiplies the sampled
// distance by sin for the X offset and cos for the Z offset -- the opposite of the convention most
// readers carry -- so a "correction" to the usual order would move every foliage cluster and
// every limb with it. Scripting the angle draw to 0 makes the assignment observable: sin(0)=0 and
// cos(0)=1, so the cluster must be displaced along Z ONLY.
func TestFancyTrunk_SinDrivesXCosDrivesZ(t *testing.T) {
	v, pal := newTreeTestVolume(t, 14)
	f := buildFancyTree(t, pal, fancyTrunkBody(map[string]any{
		// A big width_scale so the single cluster lands far from the trunk and cannot be
		// confused with it.
		"width_scale":             float64(6.0),
		"foliage_altitude_factor": float64(0),
		"trunk_height":            map[string]any{"base": float64(9), "variance": float64(1), "scale": float64(0.6)},
		"branches": map[string]any{
			"slope":               float64(0),
			"density":             float64(0.01), // -> 1 cluster per level
			"min_altitude_factor": float64(0),
		},
	}))
	log := pal.Get("minecraft:oak_log", nil)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}

	// Every cluster: distance draw 1.0, angle draw 0.0 -> angle 0 -> sin 0, cos 1.
	floats := make([]float64, 0, 200)
	for i := 0; i < 100; i++ {
		floats = append(floats, 1.0, 0.0)
	}
	rnd := &fancyScriptedRandom{bounds: []int{0}, floats: floats}
	if placeTestTree(f, v, origin, rnd) == nil {
		t.Fatal("tree did not place")
	}

	// Limbs must run out along +Z and never along X: an X displacement could only come from sin.
	offAxis := 0
	for x := -12; x <= 12; x++ {
		if x == 0 {
			continue
		}
		for y := 0; y < 30; y++ {
			for z := -12; z <= 12; z++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == log {
					offAxis++
				}
			}
		}
	}
	if offAxis != 0 {
		t.Errorf("%d logs off the X=0 plane with angle 0: sin must drive X (sin(0)=0), so an "+
			"angle of 0 can displace clusters along Z only", offAxis)
	}
	onAxis := 0
	for y := 0; y < 30; y++ {
		for z := 1; z <= 12; z++ {
			if v.GetBlock(wgen.BlockPos{X: 0, Y: y, Z: z}) == log {
				onAxis++
			}
		}
	}
	if onAxis == 0 {
		t.Error("no logs displaced along +Z at all; cos must drive Z (cos(0)=1)")
	}
}

// TestFancyTrunk_TwoFloatDrawsPerCluster pins the draw accounting: both NextFloat draws happen
// before any validation, so a cluster rejected by either clearance check still costs two. A port
// that validated first and drew second would keep the same geometry at seed 0 and desync
// everything downstream.
func TestFancyTrunk_TwoFloatDrawsPerCluster(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	// density 0.01 -> exactly 1 cluster per level; foliage_altitude_factor 0 -> every level from
	// topLevel down to 0 is eligible, so the count is predictable from the geometry alone.
	f := buildFancyTree(t, pal, fancyTrunkBody(map[string]any{
		"foliage_altitude_factor": float64(0),
		"trunk_height":            map[string]any{"base": float64(8), "variance": float64(3), "scale": float64(0.6)},
		"branches": map[string]any{
			"slope":               float64(0.4),
			"density":             float64(0.01),
			"min_altitude_factor": float64(0.2),
		},
	}))
	rnd := &fancyScriptedRandom{bounds: []int{0}, floats: make([]float64, 400)}
	if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, rnd) == nil {
		t.Fatal("tree did not place")
	}
	// height = 8 + 0 = 8, span = variance+1 = 4, rise = 4/3 = 1, topLevel = 8-1 = 7.
	// Levels 7..0 inclusive = 8 levels, 1 cluster each, 2 draws each.
	const wantLevels = 8
	if rnd.floatIdx != 2*wantLevels {
		t.Errorf("spent %d float draws, want %d (2 per cluster x %d levels, spent BEFORE "+
			"validation so rejected clusters still pay)", rnd.floatIdx, 2*wantLevels, wantLevels)
	}
}

// TestFancyTrunk_TrunkIsWidthSquaredColumns pins phase 3b: the trunk is not one column but
// trunk_width^2 vertical limbs, each from the ground to the scaled stem top.
func TestFancyTrunk_TrunkIsWidthSquaredColumns(t *testing.T) {
	v, pal := newTreeTestVolume(t, 8)
	f := buildFancyTree(t, pal, fancyTrunkBody(map[string]any{
		"trunk_width":             float64(2),
		"foliage_altitude_factor": float64(2), // no level qualifies -> only the seeded coord
		"trunk_height":            map[string]any{"base": float64(10), "variance": float64(1), "scale": float64(0.5)},
	}))
	log := pal.Get("minecraft:oak_log", nil)
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	rnd := &fancyScriptedRandom{bounds: []int{0}, floats: make([]float64, 200)}
	if placeTestTree(f, v, origin, rnd) == nil {
		t.Fatal("tree did not place")
	}
	// height 10, scale 0.5 -> stem top offset 5, so y = origin.Y .. origin.Y+5 on all four cells.
	for dx := 0; dx < 2; dx++ {
		for dz := 0; dz < 2; dz++ {
			for dy := 0; dy <= 5; dy++ {
				p := wgen.BlockPos{X: origin.X + dx, Y: origin.Y + dy, Z: origin.Z + dz}
				if v.GetBlock(p) != log {
					t.Errorf("no trunk log at %+v; a trunk_width of 2 must draw 4 columns", p)
				}
			}
		}
	}
}

// TestFancyPlaceLimb_IgnoresMayReplace pins that the limb placement writes UNCONDITIONALLY: it
// uses a plain single-block write with no allow-list gate, the same ungated write
// mega_trunk's branch
// logs already use.
//
// This tests the helper directly rather than through a whole tree, for a reason worth recording:
// the trunk column CANNOT demonstrate it. Phase 1 checks exactly the cells phase 3b later draws,
// and a blocked line shortens the height to the blocked index -- so the column always stops BELOW
// an obstacle and never gets the chance to overwrite one. The only writes that can land on
// occupied cells are limbs to foliage clusters, whose paths were validated before phase 3a placed
// any canopy leaves. Testing the helper keeps the claim exact instead of depending on that
// interaction.
func TestFancyPlaceLimb_IgnoresMayReplace(t *testing.T) {
	v, pal := newTreeTestVolume(t, 6)
	log, stone := pal.Get("minecraft:oak_log", nil), pal.Get("minecraft:stone", nil)
	// A non-empty may_replace excluding stone -- what a GATED write would refuse to overwrite.
	gated := pal.NewMatchSet([]block.Descriptor{{Name: "minecraft:air"}}, nil, nil, nil)

	from := wgen.BlockPos{X: 0, Y: 12, Z: 0}
	to := wgen.BlockPos{X: 4, Y: 15, Z: 0}
	obstacle := wgen.BlockPos{X: 2, Y: 14, Z: 0}
	v.SetBlock(obstacle, stone)

	// Sanity: the gate this write does NOT consult would have refused that cell.
	if isValidTreePosition(v, obstacle, gated) {
		t.Fatal("test setup is wrong: the obstacle must fail the gated predicate for this to mean anything")
	}

	fancyPlaceLimb(v, from, to, log)

	if got := v.GetBlock(obstacle); got != log {
		t.Errorf("block at %+v was not overwritten; the limb placer writes with no may_replace gate", obstacle)
	}
	// And the whole line is drawn, endpoints included.
	for _, p := range []wgen.BlockPos{from, to} {
		if v.GetBlock(p) != log {
			t.Errorf("no log at endpoint %+v; the walk runs steps+1 times", p)
		}
	}
}

// --- trunk_decoration on the acacia and plain-trunk paths ---------------------------------------
//
// `trunk_decoration` is accepted by the acacia and simple trunks too (not only mega_trunk,
// mangrove_trunk and fallen_trunk), and the game applies it to every log they place. Several
// vanilla definitions use it, so the tests below use vanilla's own decoration bodies.

// TestAcaciaDecorationMask pins the per-cell mask, which is NOT the obvious
// {dx==0, dx==width-1, dz==0, dz==width-1}. The game branches rather than evaluating both edge
// tests, so the +X and +Z bits are only reachable when the cell is not already on the minus edge.
// At trunk_width 1 that is observable: every cell is on both edges of both axes, and the game
// still sets only the two minus bits.
func TestAcaciaDecorationMask(t *testing.T) {
	cases := []struct {
		dx, dz, width int
		want          [4]bool
	}{
		// width 1: the single cell is -X and -Z only. The unguarded form would give all four.
		{0, 0, 1, [4]bool{true, false, true, false}},
		// width 2: each of the four cells sits on exactly one edge per axis.
		{0, 0, 2, [4]bool{true, false, true, false}},
		{1, 0, 2, [4]bool{false, true, true, false}},
		{0, 1, 2, [4]bool{true, false, false, true}},
		{1, 1, 2, [4]bool{false, true, false, true}},
		// width 3: the middle cell touches no edge at all, so nothing is decorated there.
		{1, 1, 3, [4]bool{false, false, false, false}},
		{0, 1, 3, [4]bool{true, false, false, false}},
		{2, 2, 3, [4]bool{false, true, false, true}},
	}
	for _, c := range cases {
		if got := acaciaDecorationMask(c.dx, c.dz, c.width); got != c.want {
			t.Errorf("acaciaDecorationMask(dx=%d, dz=%d, width=%d) = %v, want %v",
				c.dx, c.dz, c.width, got, c.want)
		}
	}
}

// countBlocksNamed counts cells whose block NAME matches, ignoring states. The decoration tests
// need this rather than an ID comparison: the decoration resolves its descriptor to a stated block
// (a vine carries vine_direction_bits), so pal.Get(name, nil) interns a DIFFERENT id than the one
// actually placed and an id comparison silently finds nothing.
func countBlocksNamed(v *volume.Volume, pal *block.Palette, name string, radius, minY, maxY int) int {
	n := 0
	for y := minY; y <= maxY; y++ {
		for x := -radius; x <= radius; x++ {
			for z := -radius; z <= radius; z++ {
				if pal.NameOf(v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z})) == name {
					n++
				}
			}
		}
	}
	return n
}

// vanillaVineDecoration is the body vanilla's own roofed_tree_with_vines_feature uses. The 6/7
// fraction is kept rather than simplified to 100%, so the test exercises the same
// chance-value path a real file does.
func vanillaVineDecoration() map[string]any {
	return map[string]any{
		"decoration_block":  "minecraft:vine",
		"decoration_chance": map[string]any{"numerator": float64(6), "denominator": float64(7)},
	}
}

// TestAcaciaTrunk_TrunkDecorationIsApplied proves the acacia path both accepts the field and acts
// on it: vines appear beside the trunk, and the "not implemented" warning is gone.
func TestAcaciaTrunk_TrunkDecorationIsApplied(t *testing.T) {
	v, pal := newTreeTestVolume(t, 8)
	body := acaciaTrunkBody(map[string]any{"trunk_decoration": vanillaVineDecoration()}, nil)

	var warnings []string
	ctx := &BuildContext{Palette: pal, Identifier: "test:acacia", FileID: "test:acacia",
		Warn: func(m string) { warnings = append(warnings, m) }}
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	for _, w := range warnings {
		if strings.Contains(w, "trunk_decoration") {
			t.Errorf("still warning about trunk_decoration: %q", w)
		}
	}

	// A real RNG: the decoration's 6/7 chance draws, and scripting every draw for a whole tree
	// would pin the tree's shape rather than the claim under test.
	if placeTestTree(built.(*TreeFeature), v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(7)) == nil {
		t.Fatal("tree did not place")
	}
	if countBlocksNamed(v, pal, "minecraft:vine", 8, 0, 29) == 0 {
		t.Error("no vine placed anywhere: acacia_trunk.trunk_decoration must be applied to trunk logs")
	}
}

// TestPlainTrunk_TrunkDecorationIsApplied does the same for the plain `trunk` key, which
// the simple trunk backs. Four vanilla definitions rely on it, more than acacia's one.
func TestPlainTrunk_TrunkDecorationIsApplied(t *testing.T) {
	v, pal := newTreeTestVolume(t, 8)
	body := map[string]any{
		"trunk": map[string]any{
			"trunk_block":      "minecraft:oak_log",
			"trunk_height":     float64(6),
			"trunk_decoration": vanillaVineDecoration(),
		},
		"canopy": map[string]any{
			"leaf_block":    "minecraft:oak_leaves",
			"canopy_offset": map[string]any{"min": float64(-2), "max": float64(0)},
			"min_width":     float64(1),
		},
		"may_grow_on": []any{"minecraft:dirt", "minecraft:grass_block"},
		"may_replace": []any{"minecraft:air"},
	}

	var warnings []string
	ctx := &BuildContext{Palette: pal, Identifier: "test:plain", FileID: "test:plain",
		Warn: func(m string) { warnings = append(warnings, m) }}
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	for _, w := range warnings {
		if strings.Contains(w, "trunk_decoration") {
			t.Errorf("still warning about trunk_decoration: %q", w)
		}
	}

	if placeTestTree(built.(*TreeFeature), v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(7)) == nil {
		t.Fatal("tree did not place")
	}
	if countBlocksNamed(v, pal, "minecraft:vine", 8, 0, 29) == 0 {
		t.Error("no vine placed anywhere: trunk.trunk_decoration must be applied to trunk logs")
	}
}

// TestTrunkDecoration_AbsentDrawsNothing guards the wiring against the one way it could go wrong
// invisibly: a decoration object that is absent must cost no random draws at all, or every tree
// without the field would desynchronise from the game.
func TestTrunkDecoration_AbsentDrawsNothing(t *testing.T) {
	v, pal := newTreeTestVolume(t, 8)
	f := buildAcaciaTree(t, pal, acaciaTrunkBody(nil, nil))
	// Exactly the draws the tree itself needs: trunk lean direction, then the branch routine's own
	// direction re-roll. A decoration roll would ask for a third and run off the end of the script.
	rnd := &intBoundScriptedRandom{vals: []int{0, 0}}
	if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, rnd) == nil {
		t.Fatal("tree did not place")
	}
	if rnd.idx != 2 {
		t.Errorf("consumed %d draws, want 2: an absent trunk_decoration must draw nothing", rnd.idx)
	}
}

// --- poplar_trunk / poplar_canopy -----------------------------------------------------------------
//
// See tree.go's Poplar section for the schema and algorithm these tests pin.

// poplarScriptedRandom scripts NextIntBound, NextFloat AND NextBoolean, and counts each, so a test
// can assert how many draws each poplar phase spent as well as what it produced.
type poplarScriptedRandom struct {
	bounds   []int
	floats   []float64
	bools    []bool
	boundIdx int
	floatIdx int
	boolIdx  int
}

func (s *poplarScriptedRandom) NextIntBound(int) int {
	if s.boundIdx >= len(s.bounds) {
		return 0
	}
	v := s.bounds[s.boundIdx]
	s.boundIdx++
	return v
}

func (s *poplarScriptedRandom) NextFloat() float64 {
	if s.floatIdx >= len(s.floats) {
		return 0.5 // off-script: no side hole (a hole needs f <= chance)
	}
	v := s.floats[s.floatIdx]
	s.floatIdx++
	return v
}

func (s *poplarScriptedRandom) NextBoolean() bool {
	if s.boolIdx >= len(s.bools) {
		return false
	}
	v := s.bools[s.boolIdx]
	s.boolIdx++
	return v
}
func (s *poplarScriptedRandom) NextInt() int32                { panic("unused") }
func (s *poplarScriptedRandom) NextDouble() float64           { panic("unused") }
func (s *poplarScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unused") }
func (s *poplarScriptedRandom) SetSeed(uint32)                {}
func (s *poplarScriptedRandom) GetSeed() uint32               { return 0 }

var _ random.IRandom = (*poplarScriptedRandom)(nil)

func poplarTreeBody(trunkExtra, canopyExtra map[string]any) map[string]any {
	trunk := map[string]any{
		"trunk_height": float64(6),
		"trunk_block":  "minecraft:oak_log",
	}
	for k, v := range trunkExtra {
		trunk[k] = v
	}
	canopy := map[string]any{
		"leaf_block":   "minecraft:oak_leaves",
		"branch_block": "minecraft:oak_log",
		"radius":       []any{map[string]any{"value": float64(3)}},
		"height":       float64(5),
	}
	for k, v := range canopyExtra {
		canopy[k] = v
	}
	return map[string]any{
		"poplar_trunk":  trunk,
		"poplar_canopy": canopy,
	}
}

func buildPoplarTree(t *testing.T, pal *block.Palette, body map[string]any) *TreeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:poplar", FileID: "test:poplar", Warn: func(string) {}}
	f, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	return f.(*TreeFeature)
}

// TestBuildTreeFeature_PoplarKeys_SchemaValidation pins the poplar schema: which keys are required
// (see tree.go's Poplar section) and the defaults for the optional ones.
func TestBuildTreeFeature_PoplarKeys_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()

	f := buildPoplarTree(t, pal, poplarTreeBody(nil, nil))
	if f.poplar == nil {
		t.Fatal("want poplar non-nil")
	}
	// Defaults.
	if f.poplar.remainingMin != 4 || f.poplar.remainingMax != 4 {
		t.Errorf("remaining default = {%d,%d}, want {4,4}", f.poplar.remainingMin, f.poplar.remainingMax)
	}
	if f.poplar.foliageMin != 1 || f.poplar.foliageMax != 4 {
		t.Errorf("foliage default = {%d,%d}, want {1,4}", f.poplar.foliageMin, f.poplar.foliageMax)
	}
	pc, ok := f.canopy.(*poplarCanopy)
	if !ok {
		t.Fatalf("canopy = %T, want *poplarCanopy", f.canopy)
	}
	if pc.sideHoleChance != 0 {
		t.Errorf("side_hole_chance default = %v, want 0 (vanilla default)", pc.sideHoleChance)
	}
	if pc.trunkWidth != 1 {
		t.Errorf("trunk_width default = %d, want 1", pc.trunkWidth)
	}
	if len(pc.radius) != 1 || pc.radius[0].value != 3 || pc.radius[0].weight != 1 {
		t.Errorf("radius = %+v, want one entry {value:3, weight:1} (weight default 1)", pc.radius)
	}

	// Required keys, each removed in isolation.
	newCtx := func() *BuildContext {
		return &BuildContext{Palette: block.NewPalette(), Identifier: "test:poplar", FileID: "test:poplar", Warn: func(string) {}}
	}
	requireError := func(mutate func(body map[string]any), name string) {
		t.Helper()
		body := poplarTreeBody(nil, nil)
		mutate(body)
		if _, err := buildTreeFeature(body, newCtx()); err == nil {
			t.Errorf("%s: want error, got nil", name)
		}
	}
	requireError(func(b map[string]any) { delete(b["poplar_trunk"].(map[string]any), "trunk_height") }, "missing trunk_height")
	requireError(func(b map[string]any) { delete(b["poplar_trunk"].(map[string]any), "trunk_block") }, "missing trunk_block")
	requireError(func(b map[string]any) { delete(b["poplar_canopy"].(map[string]any), "leaf_block") }, "missing leaf_block")
	requireError(func(b map[string]any) { delete(b["poplar_canopy"].(map[string]any), "branch_block") }, "missing branch_block")
	requireError(func(b map[string]any) { delete(b["poplar_canopy"].(map[string]any), "radius") }, "missing radius")
	requireError(func(b map[string]any) { delete(b["poplar_canopy"].(map[string]any), "height") }, "missing height")
	requireError(func(b map[string]any) { b["poplar_canopy"].(map[string]any)["radius"] = []any{} }, "empty radius array")
	requireError(func(b map[string]any) {
		b["poplar_canopy"].(map[string]any)["radius"] = []any{map[string]any{"weight": float64(2)}}
	}, "radius entry missing value")

	// Optional keys parse into their fields.
	body := poplarTreeBody(
		map[string]any{
			"remaining_trunk_height_above_branches": map[string]any{"range_min": float64(2), "range_max": float64(3)},
			"amount_of_foliage_support_branches":    float64(2),
		},
		map[string]any{
			"side_hole_chance": float64(0.25),
			"trunk_width":      float64(2),
			"radius":           []any{map[string]any{"value": float64(3), "weight": float64(2)}, map[string]any{"value": float64(6), "weight": float64(5)}},
		})
	f2 := buildPoplarTree(t, block.NewPalette(), body)
	if f2.poplar.remainingMin != 2 || f2.poplar.remainingMax != 3 {
		t.Errorf("remaining = {%d,%d}, want {2,3}", f2.poplar.remainingMin, f2.poplar.remainingMax)
	}
	if f2.poplar.foliageMin != 2 || f2.poplar.foliageMax != 2 {
		t.Errorf("foliage = {%d,%d}, want {2,2}", f2.poplar.foliageMin, f2.poplar.foliageMax)
	}
	pc2 := f2.canopy.(*poplarCanopy)
	if pc2.sideHoleChance != 0.25 || pc2.trunkWidth != 2 {
		t.Errorf("side_hole_chance/trunk_width = %v/%d, want 0.25/2", pc2.sideHoleChance, pc2.trunkWidth)
	}
	if len(pc2.radius) != 2 || pc2.radius[1].value != 6 || pc2.radius[1].weight != 5 {
		t.Errorf("radius = %+v, want two entries with [1]={6,5}", pc2.radius)
	}
}

// TestTreeShuffledHorizontalDirections pins the game's shuffled horizontal direction list:
// the initial array {NORTH,EAST,SOUTH,WEST}, the Fisher-Yates swap
// positions, and the exact 3-draw cost (bounds 2, 3, 4).
func TestTreeShuffledHorizontalDirections(t *testing.T) {
	// Identity draws: j == i at every step.
	rnd := &intBoundScriptedRandom{vals: []int{1, 2, 3}}
	if got := treeShuffledHorizontalDirections(rnd); got != [4]uint8{2, 5, 3, 4} {
		t.Errorf("identity shuffle = %v, want [2 5 3 4] (north, east, south, west)", got)
	}
	if rnd.idx != 3 {
		t.Errorf("draws = %d, want exactly 3", rnd.idx)
	}
	// All-zero draws: swap(1,0), swap(2,0), swap(3,0).
	rnd = &intBoundScriptedRandom{vals: []int{0, 0, 0}}
	if got := treeShuffledHorizontalDirections(rnd); got != [4]uint8{4, 2, 5, 3} {
		t.Errorf("all-zero shuffle = %v, want [4 2 5 3]", got)
	}
}

// TestPoplarPickWeightedRadius pins the poplar canopy's radius draw: one NextIntBound(totalWeight)
// draw, the cumulative-subtract scan, and the poplar-specific value-1.
func TestPoplarPickWeightedRadius(t *testing.T) {
	entries := []poplarWeightedInt{{value: 3, weight: 2}, {value: 6, weight: 5}}
	for _, tc := range []struct{ roll, want int }{
		{0, 2}, {1, 2}, // first entry: value 3 -> radius 2
		{2, 5}, {6, 5}, // second entry: value 6 -> radius 5
	} {
		rnd := &intBoundScriptedRandom{vals: []int{tc.roll}}
		if got := poplarPickWeightedRadius(entries, rnd); got != tc.want {
			t.Errorf("roll %d: radius = %d, want %d", tc.roll, got, tc.want)
		}
		if rnd.idx != 1 {
			t.Errorf("roll %d: draws = %d, want exactly 1", tc.roll, rnd.idx)
		}
	}
	// All-zero weights: a zero total skips the draw entirely.
	if got := poplarPickWeightedRadius([]poplarWeightedInt{{value: 4, weight: 0}}, panicRandom{}); got != 3 {
		t.Errorf("zero-weight pick = %d, want 3 (value-1, zero draws)", got)
	}
}

// TestTreeFeature_PoplarKeys_RNGDrawSequence pins the COMPLETE draw sequence of one poplar tree:
// the trunk_height draw, (remaining {4,4} degenerate: nothing), the 3 shuffle draws, the foliage
// count, then the canopy's radius pick, height, NextBoolean, and one NextFloat per surviving
// canopy cell -- with the top-two-layer edge cells consuming NOTHING (the skip sits
// before the draw).
func TestTreeFeature_PoplarKeys_RNGDrawSequence(t *testing.T) {
	v, pal := newTreeTestVolume(t, 12)
	body := poplarTreeBody(
		map[string]any{"trunk_height": map[string]any{"range_min": float64(6), "range_max": float64(8)}},
		map[string]any{"height": map[string]any{"range_min": float64(5), "range_max": float64(6)}})
	f := buildPoplarTree(t, pal, body)

	tr := random.NewTracer(random.New(7))
	if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, tr) == nil {
		t.Fatal("Place() = nil, want success")
	}
	seq := drawSeqRandom(tr)
	wantPrefix := []random.Method{
		random.MethodNextIntBound, // trunk_height getValue (bound 2 = max-min, EXCLUSIVE max)
		random.MethodNextIntBound, // shuffle bound 2
		random.MethodNextIntBound, // shuffle bound 3
		random.MethodNextIntBound, // shuffle bound 4
		random.MethodNextIntBound, // amount_of_foliage_support_branches inclusive {1,4} (bound 4)
		random.MethodNextIntBound, // radius weighted pick (bound 1 -- single weight-1 entry)
		random.MethodNextIntBound, // canopy height inclusive {5,6} (bound 2)
		random.MethodNextBoolean,  // the quadrant bool (a boolean draw)
	}
	if len(seq) < len(wantPrefix) {
		t.Fatalf("draw sequence too short: %v", seq)
	}
	for i, m := range wantPrefix {
		if seq[i] != m {
			t.Fatalf("draw %d = %v, want %v (full prefix %v)", i, seq[i], m, seq[:len(wantPrefix)])
		}
	}
	wantBounds := []int32{2, 2, 3, 4, 4, 1, 2}
	for i, b := range wantBounds {
		if tr.Draws[i].Bound != b {
			t.Fatalf("draw %d bound = %d, want %d", i, tr.Draws[i].Bound, b)
		}
	}
	floats := seq[len(wantPrefix):]
	for i, m := range floats {
		if m != random.MethodNextFloat {
			t.Fatalf("post-prefix draw %d = %v, want NextFloat only", i, m)
		}
	}
	// Exact float count for r=2 (radius value 3), canopy height h = 5 + the inclusive draw:
	// layer(r-2=0 @ h-1): its only cell is a top-two edge cell -- skipped, ZERO draws;
	// layer(1 @ h-2): edge skip leaves only (0,0) -> 1; layer(1 @ h-3): 9;
	// layers(2 @ h-4..1): 25 each; branch layer: zero draws; layer(1 @ 0): 9; layer(1 @ -1): 9.
	drawnHeight := 5 + int(tr.Draws[6].Value)
	wantFloats := 1 + 9 + 25*(drawnHeight-4) + 9 + 9
	if len(floats) != wantFloats {
		t.Fatalf("float draws = %d, want %d (canopy height %d)", len(floats), wantFloats, drawnHeight)
	}
}

// TestPoplarTrunk_PlacesColumnBranchesAndCanopy is the full worked poplar tree: trunk column,
// the four pillar-axis branch logs one below the canopy anchor, and the canopy's per-layer
// diamond counts, for a fully scripted RNG (see each layer's arithmetic in the comments).
//
// Config: trunk_height 6 (plain -> {6,6}, 0 draws), remaining default {4,4} (0 draws), radius
// [{value 3}] -> r=2, canopy height 5 (plain, 0 draws), may_replace [air] so leaves can never
// overwrite logs. Scripted: shuffle draws 0,0,0 -> direction order [west,north,east,south];
// foliage draw 3 -> 4 branches; radius pick draw 0; quadrant bool true; floats all 0.5 (no
// side holes at chance 0).
func TestPoplarTrunk_PlacesColumnBranchesAndCanopy(t *testing.T) {
	v, pal := newTreeTestVolume(t, 12)
	body := poplarTreeBody(nil, nil)
	body["may_replace"] = []any{"minecraft:air"}
	f := buildPoplarTree(t, pal, body)

	rnd := &poplarScriptedRandom{bounds: []int{0, 0, 0, 3, 0}, bools: []bool{true}}
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	got := placeTestTree(f, v, origin, rnd)
	if got == nil || *got != origin {
		t.Fatalf("Place() = %v, want &origin (the trunk placement returns the ORIGINAL origin)", got)
	}

	log := pal.Get("minecraft:oak_log", nil)
	leaf := pal.Get("minecraft:oak_leaves", nil)

	// Trunk column: 6 logs, none overwritten (may_replace=[air] rejects every leaf overlap).
	for y := 10; y <= 15; y++ {
		if v.GetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}) != log {
			t.Errorf("trunk column: no log at y=%d", y)
		}
	}

	// Branches: topPos = origin + (0, height-remaining-1, 0) = y11; all four directions with
	// pillar_axis z for north/south and x for west/east.
	axis := func(a string) block.ID {
		return pal.Get("minecraft:oak_log", map[string]block.StateValue{"pillar_axis": a})
	}
	for _, tc := range []struct {
		p    wgen.BlockPos
		want block.ID
	}{
		{wgen.BlockPos{X: -1, Y: 11, Z: 0}, axis("x")}, // west
		{wgen.BlockPos{X: 0, Y: 11, Z: -1}, axis("z")}, // north
		{wgen.BlockPos{X: 1, Y: 11, Z: 0}, axis("x")},  // east
		{wgen.BlockPos{X: 0, Y: 11, Z: 1}, axis("z")},  // south
	} {
		if gotB := v.GetBlock(tc.p); gotB != tc.want {
			t.Errorf("branch at %v = %v, want %v", tc.p, pal.Entry(gotB), pal.Entry(tc.want))
		}
	}

	// Canopy (anchor y12, r=2, h=5, quadrant=true): per-layer leaf counts after log rejections.
	// y15 (h-2 layer, r-1): edge skip leaves only (0,0), which is the trunk log -> 0 leaves.
	// y14 (h-3, r-1): diamond+quadrant keeps 7 of 9, center is log -> 6.
	// y13 (h-4, r): keeps 13 |x|+|z|<=2 cells + 4 quadrant-bump cells, center is log -> 16.
	// y12 (0, r-1): 7 kept, center log -> 6.  y11 (-1, top r=1): 7 kept, center+4 branches -> 2.
	for _, tc := range []struct{ y, want int }{
		{15, 0}, {14, 6}, {13, 16}, {12, 6}, {11, 2},
	} {
		if n := countLeaves(v, leaf, 6, tc.y, tc.y); n != tc.want {
			t.Errorf("leaves at y=%d: %d, want %d", tc.y, n, tc.want)
		}
	}
	// The quadrant-true bump admits (1,2)/(2,1)/(-1,-2)/(-2,-1) at the r layer and nothing in
	// the other two quadrants.
	if v.GetBlock(wgen.BlockPos{X: 1, Y: 13, Z: 2}) != leaf {
		t.Error("quadrant-true bump cell (1,13,2) missing its leaf")
	}
	if v.GetBlock(wgen.BlockPos{X: 1, Y: 13, Z: -2}) == leaf {
		t.Error("cell (1,13,-2) has a leaf -- the quadrant bump leaked into the (+,-) quadrant")
	}
}

// TestPoplarCanopy_QuadrantBoolFlipsTheBumpedQuadrants pins the NextBoolean's effect: false
// selects the (+,-)/(-,+) quadrants instead.
func TestPoplarCanopy_QuadrantBoolFlipsTheBumpedQuadrants(t *testing.T) {
	v, pal := newTreeTestVolume(t, 12)
	body := poplarTreeBody(nil, nil)
	body["may_replace"] = []any{"minecraft:air"}
	f := buildPoplarTree(t, pal, body)
	rnd := &poplarScriptedRandom{bounds: []int{0, 0, 0, 3, 0}, bools: []bool{false}}
	if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, rnd) == nil {
		t.Fatal("Place() = nil, want success")
	}
	leaf := pal.Get("minecraft:oak_leaves", nil)
	if v.GetBlock(wgen.BlockPos{X: 1, Y: 13, Z: -2}) != leaf {
		t.Error("quadrant-false bump cell (1,13,-2) missing its leaf")
	}
	if v.GetBlock(wgen.BlockPos{X: 1, Y: 13, Z: 2}) == leaf {
		t.Error("cell (1,13,2) has a leaf -- the quadrant bump leaked into the (+,+) quadrant")
	}
}

// TestPoplarCanopy_BranchArms pins the leaf-to-log replacement: the branch layer
// (anchor.y + height-4) gets oriented branch logs along the two axis arms, |coord| <= r-4,
// z-axis logs on the z arm, x-axis on the x arm AND the center -- replacing the leaves the
// r-layer loop had just placed there (may_replace left EMPTY so the overwrite goes through,
// an empty may_replace list accepts every block).
func TestPoplarCanopy_BranchArms(t *testing.T) {
	v, pal := newTreeTestVolume(t, 14)
	body := poplarTreeBody(
		map[string]any{"trunk_height": float64(12)},
		map[string]any{
			"radius":       []any{map[string]any{"value": float64(6)}}, // r = 5
			"height":       float64(7),
			"branch_block": "minecraft:spruce_log",
		})
	f := buildPoplarTree(t, pal, body)
	rnd := &poplarScriptedRandom{bounds: []int{0, 0, 0, 0, 0}, bools: []bool{false}}
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	if placeTestTree(f, v, origin, rnd) == nil {
		t.Fatal("Place() = nil, want success")
	}
	// anchor = origin + 12 - 4 = y18; branch layer = anchor + 7 - 4 = y21.
	axis := func(a string) block.ID {
		return pal.Get("minecraft:spruce_log", map[string]block.StateValue{"pillar_axis": a})
	}
	for _, tc := range []struct {
		p    wgen.BlockPos
		want block.ID
	}{
		{wgen.BlockPos{X: 0, Y: 21, Z: 0}, axis("x")},  // center: z==0 -> x axis (CINC)
		{wgen.BlockPos{X: -1, Y: 21, Z: 0}, axis("x")}, // x arm
		{wgen.BlockPos{X: 1, Y: 21, Z: 0}, axis("x")},
		{wgen.BlockPos{X: 0, Y: 21, Z: -1}, axis("z")}, // z arm
		{wgen.BlockPos{X: 0, Y: 21, Z: 1}, axis("z")},
	} {
		if gotB := v.GetBlock(tc.p); gotB != tc.want {
			t.Errorf("branch arm at %v = %v, want %v", tc.p, pal.Entry(gotB), pal.Entry(tc.want))
		}
	}
	// The arm stops at |coord| <= r-4 = 1: cell (0, 21, 2) must be a leaf, not a log.
	if gotB := v.GetBlock(wgen.BlockPos{X: 0, Y: 21, Z: 2}); gotB != pal.Get("minecraft:oak_leaves", nil) {
		t.Errorf("cell just past the arm = %v, want a leaf (arm length is r-4)", pal.Entry(gotB))
	}
}

// TestPoplarCanopy_SideHoleChanceShrinksCells pins the per-cell side_hole_chance draw: at
// chance 1.0 every draw satisfies f <= chance, shrinking every
// cell's effective radius by 1 -- the canopy collapses to the 7-cell bumped diamond on the
// r layer only (all other layers' survivors are the trunk column itself).
func TestPoplarCanopy_SideHoleChanceShrinksCells(t *testing.T) {
	v, pal := newTreeTestVolume(t, 12)
	body := poplarTreeBody(nil, map[string]any{"side_hole_chance": float64(1)})
	body["may_replace"] = []any{"minecraft:air"}
	f := buildPoplarTree(t, pal, body)
	rnd := &poplarScriptedRandom{bounds: []int{0, 0, 0, 3, 0}, bools: []bool{true}}
	if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, rnd) == nil {
		t.Fatal("Place() = nil, want success")
	}
	leaf := pal.Get("minecraft:oak_leaves", nil)
	if n := countLeaves(v, leaf, 6, 11, 16); n != 6 {
		t.Errorf("total leaves = %d, want 6 (all on the r layer at y13)", n)
	}
	if n := countLeaves(v, leaf, 6, 13, 13); n != 6 {
		t.Errorf("y13 leaves = %d, want 6", n)
	}
}

// poplarCountingDelegate records EVERY Place call's origin (stubDelegate keeps only the last).
type poplarCountingDelegate struct{ calls []wgen.BlockPos }

func (d *poplarCountingDelegate) TypeID() string     { return "test:counting_delegate" }
func (d *poplarCountingDelegate) Identifier() string { return "test:delegate" }
func (d *poplarCountingDelegate) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	d.calls = append(d.calls, ctx.Origin)
	return &ctx.Origin
}

type poplarCountingResolver struct{ delegate *poplarCountingDelegate }

func (r poplarCountingResolver) Resolve(identifier string) wgen.IFeature {
	if identifier == "test:delegate" {
		return r.delegate
	}
	return nil
}

// TestPoplarTrunk_LogDecorationFeature_FiresPerColumnCellEvenWhenBlocked pins the UNGATED
// log_decoration_feature hook: the optional-feature presence test sits on the loop
// path BOTH the placed and the allowlist-rejected cell reach, so the referenced feature runs for
// every column cell -- including one whose own log was rejected by may_replace.
func TestPoplarTrunk_LogDecorationFeature_FiresPerColumnCellEvenWhenBlocked(t *testing.T) {
	v, pal := newTreeTestVolume(t, 12)
	stone := pal.Get("minecraft:stone", nil)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 12, Z: 0}, stone) // blocks the y12 log
	delegate := &poplarCountingDelegate{}
	body := poplarTreeBody(map[string]any{
		"trunk_height":           float64(5),
		"log_decoration_feature": "test:delegate",
	}, nil)
	body["may_replace"] = []any{"minecraft:air"}
	ctx := &BuildContext{Palette: pal, Resolver: poplarCountingResolver{delegate}, Identifier: "test:poplar", FileID: "test:poplar", Warn: func(string) {}}
	built, err := buildTreeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	f := built.(*TreeFeature)

	rnd := &poplarScriptedRandom{bounds: []int{0, 0, 0, 0, 0}}
	if placeTestTree(f, v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, rnd) == nil {
		t.Fatal("Place() = nil, want success")
	}
	if len(delegate.calls) != 5 {
		t.Fatalf("delegate calls = %d (%v), want 5 -- one per column cell, gated on NOTHING", len(delegate.calls), delegate.calls)
	}
	sawBlocked := false
	for _, p := range delegate.calls {
		if p == (wgen.BlockPos{X: 0, Y: 12, Z: 0}) {
			sawBlocked = true
		}
	}
	if !sawBlocked {
		t.Error("delegate never ran at the BLOCKED y12 cell -- the hook must not be gated on the log placing")
	}
	if v.GetBlock(wgen.BlockPos{X: 0, Y: 12, Z: 0}) != stone {
		t.Error("the blocked cell's stone was overwritten -- may_replace must reject the log itself")
	}
}

// TestMegaTrunkDecoration_StepDirection pins step_direction, the growth-direction field: default 0
// steps DOWN (-Y), 1 steps UP, 2 steps OUTWARD along the mask direction, and any other value
// stays put. count {2,2} is degenerate (zero draws), chance 100%%
// never draws, so panicRandom proves the whole walk costs nothing.
func TestMegaTrunkDecoration_StepDirection(t *testing.T) {
	logPos := wgen.BlockPos{X: 5, Y: 12, Z: 5}
	candidate := wgen.BlockPos{X: 4, Y: 12, Z: 5} // west of the log
	for _, tc := range []struct {
		name   string
		dir    int
		second wgen.BlockPos
	}{
		{"default down", 0, wgen.BlockPos{X: 4, Y: 11, Z: 5}},
		{"up", 1, wgen.BlockPos{X: 4, Y: 13, Z: 5}},
		{"outward", 2, wgen.BlockPos{X: 3, Y: 12, Z: 5}},
	} {
		v, pal := newTreeTestVolume(t, 8)
		vine := pal.Get("minecraft:vine", nil)
		d := &megaTrunkDecoration{
			entries:       []megaTrunkDecorationEntry{{blockID: vine, countMin: 2, countMax: 2}},
			chance:        chanceInformation{percent: 100},
			stepDirection: tc.dir,
			pal:           pal,
		}
		d.place(v, logPos, [4]bool{true, false, false, false}, panicRandom{})
		westDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
		if got := v.GetBlock(candidate); got != westDecorated {
			t.Errorf("%s: candidate cell = %v, want the vine", tc.name, pal.Entry(got))
		}
		if got := v.GetBlock(tc.second); got != westDecorated {
			t.Errorf("%s: second cell %v = %v, want the vine (step vector wrong)", tc.name, tc.second, pal.Entry(got))
		}
	}
	// "no movement" for out-of-range values: the second placement lands on the SAME cell.
	v, pal := newTreeTestVolume(t, 8)
	vine := pal.Get("minecraft:vine", nil)
	d := &megaTrunkDecoration{
		entries:       []megaTrunkDecorationEntry{{blockID: vine, countMin: 2, countMax: 2}},
		chance:        chanceInformation{percent: 100},
		stepDirection: 7,
		pal:           pal,
	}
	d.place(v, logPos, [4]bool{true, false, false, false}, panicRandom{})
	westDecorated, _ := pal.WithIntState(vine, block.MultiFaceDirectionBits, 32)
	if got := v.GetBlock(candidate); got != westDecorated {
		t.Errorf("no-movement: candidate cell = %v, want the vine", pal.Entry(got))
	}
	for _, p := range []wgen.BlockPos{{X: 3, Y: 12, Z: 5}, {X: 4, Y: 11, Z: 5}, {X: 4, Y: 13, Z: 5}} {
		if !pal.IsAir(v.GetBlock(p)) {
			t.Errorf("no-movement: %v is not air -- an out-of-range step_direction must not move", p)
		}
	}
}

// TestParseAttachableDecoration_StepDirectionKey pins the JSON wiring for the step_direction
// key (a numeric value is accepted as the raw direction).
func TestParseAttachableDecoration_StepDirectionKey(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:deco", FileID: "test:deco", Warn: func(string) {}}
	d, err := parseAttachableDecorationObject(map[string]any{
		"decoration_block":  "minecraft:vine",
		"decoration_chance": float64(1),
		"step_direction":    float64(1),
	}, "t", ctx)
	if err != nil {
		t.Fatalf("parseAttachableDecorationObject: %v", err)
	}
	if d.stepDirection != 1 {
		t.Errorf("stepDirection = %d, want 1", d.stepDirection)
	}
	d2, err := parseAttachableDecorationObject(map[string]any{"decoration_block": "minecraft:vine", "decoration_chance": float64(1)}, "t", ctx)
	if err != nil {
		t.Fatalf("parseAttachableDecorationObject: %v", err)
	}
	if d2.stepDirection != 0 {
		t.Errorf("stepDirection default = %d, want 0 (default = DOWN)", d2.stepDirection)
	}
}

// TestBuildTreeFeature_MayGrowThroughOnAnIgnoringTrunk_Warns pins the promise the wiki makes
// about this whole tool: "a file that loads without warnings is one whose fields were all
// applied." may_grow_through is resolved on every trunk kind and read by only some of them, so
// without this warning a pack author gets a tree that stops at a block they explicitly listed as
// passable, with nothing anywhere saying why.
//
// A bare `trunk` key is always the simple trunk (even with a numeric trunk_height and
// can_be_submerged:false), and the simple trunk DOES consult may_grow_through, so it does not
// warn. The kinds that ignore the field are the seven named <shape>_trunk keys; acacia_trunk
// stands in for them.
func TestBuildTreeFeature_MayGrowThroughOnAnIgnoringTrunk_Warns(t *testing.T) {
	build := func(trunkKey string, trunk map[string]any, withField bool) []string {
		t.Helper()
		body := map[string]any{
			"description": map[string]any{"identifier": "probe:t"},
			"may_grow_on": []any{"minecraft:grass_block"},
			"may_replace": []any{"minecraft:air"},
			trunkKey:      trunk,
			"acacia_canopy": map[string]any{
				"canopy_size":     2.0,
				"leaf_block":      "minecraft:oak_leaves",
				"simplify_canopy": true,
			},
		}
		if withField {
			body["may_grow_through"] = []any{"minecraft:stone"}
		}
		var warnings []string
		ctx := &BuildContext{Palette: block.NewPalette(), Identifier: "probe:t", FileID: "t.json",
			Warn: func(m string) { warnings = append(warnings, m) }}
		if _, err := buildTreeFeature(body, ctx); err != nil {
			t.Fatalf("buildTreeFeature: %v", err)
		}
		var out []string
		for _, w := range warnings {
			if strings.HasPrefix(w, "may_grow_through") {
				out = append(out, w)
			}
		}
		return out
	}

	// acacia_trunk gates its column on may_replace alone -- one of the seven <shape>_trunk keys
	// that never reach may_grow_through.
	ignoring := map[string]any{
		"trunk_block":  "minecraft:oak_log",
		"trunk_width":  1.0,
		"trunk_height": map[string]any{"base": 5.0},
		"trunk_lean": map[string]any{
			"allow_diagonal_growth": true,
			"lean_height":           map[string]any{"range_min": 1.0, "range_max": 4.0},
			"lean_steps":            map[string]any{"range_min": 1.0, "range_max": 4.0},
		},
	}
	if got := build("acacia_trunk", ignoring, true); len(got) != 1 {
		t.Fatalf("a trunk that ignores may_grow_through must say so: got %d warnings %v", len(got), got)
	}
	if got := build("acacia_trunk", ignoring, false); len(got) != 0 {
		t.Errorf("no may_grow_through means nothing to warn about, got %v", got)
	}

	// The bare `trunk` key is the simple trunk, which reads the field on its descent probe AND on
	// its below-original-origin log gate -- with or without can_be_submerged, since
	// can_be_submerged only picks the descent depth. Neither spelling may warn.
	for _, consuming := range []map[string]any{
		{"trunk_height": 5.0, "trunk_block": "minecraft:oak_log"},
		{"trunk_height": 5.0, "trunk_block": "minecraft:oak_log", "can_be_submerged": false},
		{"trunk_height": 5.0, "trunk_block": "minecraft:oak_log", "can_be_submerged": true},
	} {
		if got := build("trunk", consuming, true); len(got) != 0 {
			t.Errorf("the bare `trunk` key DOES consult may_grow_through and must not warn (body %v), got %v", consuming, got)
		}
	}
}

// TestTreeFeature_MangroveRoots_RunsForEveryTrunkClass replaces a test that asserted the
// opposite. The game runs mangrove_roots (when present) for every trunk shape, with no per-shape
// exception, so a port that skipped the root pass on some trunk paths and warned instead was
// simply wrong.
//
// The load-bearing assertion here is the draw ORDER, not the draw count. The game draws the
// height FIRST (through the trunk's own height draw), THEN runs the roots, THEN places the
// trunk at the relocated origin. A port that ran the roots before the height draw
// -- or that moved the height draw to make room -- would shift the whole RNG stream and every
// feature placed after this tree in the chunk. mega_trunk is used because it is one of the five
// paths that previously skipped the roots entirely, and because its trunk_height.intervals gives
// the height a draw with a distinctive bound (3) that cannot be confused with the root pass's
// own y_offset draw (bound 2).
//
// World setup mirrors TestTreeFeature_MangroveRoots_RNGDrawSequence: every NextIntBound is
// scripted to 0, so y_offset draws 0 and topY stays at origin.Y=10, with the floor two below
// and the origin's own column left clear for the vertical validation loop.
func TestTreeFeature_MangroveRoots_RunsForEveryTrunkClass(t *testing.T) {
	roots := map[string]any{
		"max_root_width":         float64(0),
		"max_root_length":        float64(3),
		"root_block":             "minecraft:mangrove_roots",
		"muddy_root_block":       "minecraft:muddy_mangrove_roots",
		"mud_block":              "minecraft:mud",
		"y_offset":               map[string]any{"range_min": float64(0), "range_max": float64(2)},
		"roots_may_grow_through": []any{"minecraft:air"},
	}
	megaBody := func(withRoots bool) map[string]any {
		body := map[string]any{
			"description": map[string]any{"identifier": "probe:t"},
			"may_replace": []any{"minecraft:air"},
			"mega_trunk": map[string]any{
				"trunk_width":  float64(1),
				"trunk_height": map[string]any{"base": float64(5), "intervals": []any{float64(3)}},
				"trunk_block":  "minecraft:oak_log",
			},
			"mega_canopy": map[string]any{
				"canopy_height":   float64(2),
				"base_radius":     float64(1),
				"core_width":      float64(1),
				"simplify_canopy": true,
				"leaf_block":      "minecraft:oak_leaves",
			},
		}
		if withRoots {
			body["mangrove_roots"] = roots
		}
		return body
	}

	build := func(t *testing.T, body map[string]any) *TreeFeature {
		t.Helper()
		built, err := buildTreeFeature(body, &BuildContext{
			Palette: block.NewPalette(), Identifier: "probe:t", FileID: "t.json", Warn: func(string) {},
		})
		if err != nil {
			t.Fatalf("buildTreeFeature: %v", err)
		}
		return built.(*TreeFeature)
	}

	t.Run("mega_trunk no longer warns that it ignores mangrove_roots", func(t *testing.T) {
		for _, w := range build(t, megaBody(true)).warnings {
			if strings.Contains(w, "mangrove_roots") {
				t.Errorf("mega_trunk runs the root pass now and must not warn: %q", w)
			}
		}
	})

	t.Run("height is drawn BEFORE the roots, and the roots run", func(t *testing.T) {
		pal := block.NewPalette()
		air := pal.Get("minecraft:air", nil)
		stone := pal.Get("minecraft:stone", nil)
		bounds := volume.Bounds{MinX: -10, MinY: -20, MinZ: -10, SizeX: 21, SizeY: 60, SizeZ: 21}
		v := volume.New(bounds, pal, air)
		const floorY = 8 // topY(= origin.Y = 10, y_offset scripted to 0) - 2
		for x := -10; x <= 10; x++ {
			for z := -10; z <= 10; z++ {
				if x == 0 && z == 0 {
					continue // the origin's own column stays clear
				}
				v.SetBlock(wgen.BlockPos{X: x, Y: floorY, Z: z}, stone)
			}
		}

		ctx := &BuildContext{Palette: pal, Identifier: "probe:t", FileID: "t.json", Warn: func(string) {}}
		built, err := buildTreeFeature(megaBody(true), ctx)
		if err != nil {
			t.Fatalf("buildTreeFeature: %v", err)
		}
		tf := built.(*TreeFeature)

		tr := random.NewTracer(&mangroveScriptedRandom{intBounds: []int{0, 0, 0, 0, 0, 0}})
		origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
		if got := placeTestTree(tf, v, origin, tr); got == nil {
			t.Fatal("Place() = nil, want success")
		}

		// mega_canopy's canopy_height is a scalar (a degenerate int range, zero draws) and
		// max_root_width is 0 (the root growth itself draws nothing -- see
		// TestTreeFeature_MangroveRoots_RNGDrawSequence), so the whole run is exactly two
		// draws whose BOUNDS say which is which.
		wantBounds := []int32{
			3, // mega_trunk's trunk_height interval -- getTreeHeight, FIRST
			2, // mangrove_roots' y_offset.getValue -- the root pass, SECOND
		}
		if len(tr.Draws) != len(wantBounds) {
			t.Fatalf("draws = %+v, want exactly %d (bounds %v)", tr.Draws, len(wantBounds), wantBounds)
		}
		for i, want := range wantBounds {
			if tr.Draws[i].Method != random.MethodNextIntBound || tr.Draws[i].Bound != want {
				t.Fatalf("draw %d = %+v, want NextIntBound(%d)", i, tr.Draws[i], want)
			}
		}

		// The roots actually ran: the root placement's unconditional first accumulated position is
		// (origin.X, topY-1, origin.Z) -- see mangroveRootsPlace.
		rootID := pal.Get("minecraft:mangrove_roots", nil)
		if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 9, Z: 0}); got != rootID {
			t.Errorf("(0,9,0) = %v, want mangrove_roots -- the root pass must run for mega_trunk", pal.Entry(got))
		}
		// ...and the trunk still rose from the (here unmoved) relocated origin.
		if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 10, Z: 0}); got != pal.Get("minecraft:oak_log", nil) {
			t.Errorf("(0,10,0) = %v, want oak_log", pal.Entry(got))
		}
	})
}

// TestParseAttachableDecoration_MatchesTheSchemaRatherThanBeingStricter pins two places this
// parser used to refuse a file the game loads, and one place it accepted a value the game does
// not. Being stricter than the game is the costly direction: the author's JSON is fine, and the
// only tool that could tell them so says it is not.
//
// In the attachable decoration, decoration_block and
// decoration_blocks_sequence are BOTH optional, and step_direction is an enum over four string
// spellings -- "down" = 0, "up" = 1, "out" = 2, and "away" = 2 as an alias for "out".
func TestParseAttachableDecoration_MatchesTheSchemaRatherThanBeingStricter(t *testing.T) {
	parse := func(obj map[string]any) (*megaTrunkDecoration, []string, error) {
		t.Helper()
		var warnings []string
		ctx := &BuildContext{
			Palette: block.NewPalette(), Identifier: "probe:t", FileID: "t.json",
			Warn: func(m string) { warnings = append(warnings, m) },
		}
		d, err := parseAttachableDecorationObject(obj, "trunk.trunk_decoration", ctx)
		return d, warnings, err
	}
	chance := map[string]any{"numerator": 1.0, "denominator": 1.0}

	t.Run("neither block key loads, with a warning", func(t *testing.T) {
		d, warnings, err := parse(map[string]any{"decoration_chance": chance})
		if err != nil {
			t.Fatalf("both block keys are optional in the schema, so this must LOAD: %v", err)
		}
		if len(d.entries) != 0 {
			t.Errorf("a decoration with no block has nothing to place, got %d entries", len(d.entries))
		}
		if len(warnings) != 1 {
			t.Fatalf("it decorates nothing, which is worth saying once: got %v", warnings)
		}
	})

	for _, c := range []struct {
		spelling string
		want     int
	}{
		{"down", 0}, {"up", 1}, {"out", 2},
		{"away", 2}, // an alias for "out"
		{"DOWN", 0}, // the game lower-cases before matching
	} {
		t.Run("step_direction "+c.spelling, func(t *testing.T) {
			d, warnings, err := parse(map[string]any{
				"decoration_chance": chance, "decoration_block": "minecraft:vine",
				"step_direction": c.spelling,
			})
			if err != nil {
				t.Fatalf("%q is a legal enum value and must load: %v", c.spelling, err)
			}
			if d.stepDirection != c.want {
				t.Errorf("step_direction %q = %d, want %d", c.spelling, d.stepDirection, c.want)
			}
			if len(warnings) != 0 {
				t.Errorf("a legal spelling must not warn, got %v", warnings)
			}
		})
	}

	t.Run("a number still loads but says the game would not take it", func(t *testing.T) {
		d, warnings, err := parse(map[string]any{
			"decoration_chance": chance, "decoration_block": "minecraft:vine",
			"step_direction": 1.0,
		})
		if err != nil {
			t.Fatalf("a number is read for compatibility, not refused: %v", err)
		}
		if d.stepDirection != 1 {
			t.Errorf("step_direction = %d, want 1", d.stepDirection)
		}
		if len(warnings) != 1 {
			t.Fatalf("want one warning saying an enum node would refuse a number, got %v", warnings)
		}
	})

	t.Run("an unknown spelling is a real error", func(t *testing.T) {
		if _, _, err := parse(map[string]any{
			"decoration_chance": chance, "decoration_block": "minecraft:vine",
			"step_direction": "sideways",
		}); err == nil {
			t.Error("a spelling the enum does not register must fail, not silently mean down")
		}
	})
}

// TestMegaTrunkDecorationMask_IsGuardedTheWayAcaciasIs pins the case the two forms disagree on.
// The mega trunk builds its per-log direction mask exactly the way the acacia trunk does -- the
// guard before the +X and +Z entries included -- rather than the unguarded form, which differs only at trunk_width 1, where dx == 0 and dx == width-1 are the
// same cell.
func TestMegaTrunkDecorationMask_IsGuardedTheWayAcaciasIs(t *testing.T) {
	// width 1: the single column is on BOTH the minus and the plus edge. The game reaches the
	// plus test only when the minus one failed, so it sets one entry per axis, not two.
	if got := acaciaDecorationMask(0, 0, 1); got != [4]bool{true, false, true, false} {
		t.Errorf("width 1 = %v, want the -X and -Z bytes only", got)
	}
	// width 2: the two edges are distinct cells and the guard is inert, which is why typical
	// mega trees (where mega's width defaults to 2) never show the difference.
	if got := acaciaDecorationMask(0, 0, 2); got != [4]bool{true, false, true, false} {
		t.Errorf("width 2, min corner = %v", got)
	}
	if got := acaciaDecorationMask(1, 1, 2); got != [4]bool{false, true, false, true} {
		t.Errorf("width 2, max corner = %v", got)
	}
	// width 3: an interior column touches no edge at all.
	if got := acaciaDecorationMask(1, 1, 3); got != [4]bool{false, false, false, false} {
		t.Errorf("width 3, interior = %v, want no bytes set", got)
	}
}
