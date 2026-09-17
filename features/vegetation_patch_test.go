package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// TestVegIntRangeValue_DegenerateDrawsNothing pins the degenerate branch of
// the engine's int-range draw: min >= max-1
// returns min with ZERO draws. That covers scalars ({v,v}), [n,n+1], and
// reversed/equal ranges alike.
func TestVegIntRangeValue_DegenerateDrawsNothing(t *testing.T) {
	cases := []vegIntRange{
		{min: 3, max: 3}, // scalar form
		{min: 3, max: 4}, // min == max-1: still degenerate
		{min: 5, max: 2}, // reversed
	}
	for _, r := range cases {
		tracer := random.NewTracer(random.New(1))
		got := vegIntRangeValue(r, tracer)
		if got != r.min {
			t.Errorf("vegIntRangeValue(%+v) = %d, want %d", r, got, r.min)
		}
		if len(tracer.Draws) != 0 {
			t.Errorf("vegIntRangeValue(%+v) drew %v, want zero draws", r, tracer.Draws)
		}
	}
}

// TestVegIntRangeValue_NonDegenerateFormula pins the non-degenerate
// branch: exactly ONE NextIntBound draw with bound = max-min (NOT
// max-min+1), so the result is uniform over [min, max-1]
// -- max is EXCLUSIVE. The engine's int-range draw is its inclusive bounded
// draw over (min, max-1), and nextIntInclusive is
// a + nextIntBound(b-a+1); composed: min + nextIntBound(max-min).
func TestVegIntRangeValue_NonDegenerateFormula(t *testing.T) {
	r := vegIntRange{min: 2, max: 5}
	for seed := uint32(1); seed <= 20; seed++ {
		tracer := random.NewTracer(random.New(seed))
		got := vegIntRangeValue(r, tracer)
		if len(tracer.Draws) != 1 {
			t.Fatalf("seed %d: drew %v, want exactly one draw", seed, tracer.Draws)
		}
		d := tracer.Draws[0]
		if d.Method != random.MethodNextIntBound {
			t.Fatalf("seed %d: draw method = %v, want NextIntBound", seed, d.Method)
		}
		if d.Bound != 3 {
			t.Fatalf("seed %d: bound = %d, want 3 (max-min -- the -1'd inclusive call's b-a+1 with b=max-1)", seed, d.Bound)
		}
		if got < 2 || got > 4 {
			t.Fatalf("seed %d: value = %d, want in [2,4] (max EXCLUSIVE)", seed, got)
		}
	}
}

// --- surface: "ceiling" -------------------------------------------------
//
// Every test below stands behind vegetation_patch.go's own header
// (the surface value, the opposite-face table and the
// per-face Y step): "ceiling" scans UPWARD for a solid anchor, fills depth UPWARD
// into it, and grows vegetation DOWNWARD -- the exact mirror image of
// "floor", via a single signed surfaceDir the arithmetic multiplies through.

// vegMarkerDelegate is a minimal wgen.IFeature standing in for
// "vegetation_feature": records every origin it was placed at and writes a
// marker block there, so a test can see (and render) exactly where the
// vegetation growth landed, not just assert a count.
type vegMarkerDelegate struct {
	v       *volume.Volume
	marker  block.ID
	origins []wgen.BlockPos
}

func (d *vegMarkerDelegate) TypeID() string     { return "test:veg_marker" }
func (d *vegMarkerDelegate) Identifier() string { return "test:veg_marker" }
func (d *vegMarkerDelegate) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	d.origins = append(d.origins, ctx.Origin)
	d.v.SetBlock(ctx.Origin, d.marker)
	return &ctx.Origin
}

// vegMarkerResolver resolves exactly "test:veg_marker".
type vegMarkerResolver struct{ delegate *vegMarkerDelegate }

func (r vegMarkerResolver) Resolve(identifier string) wgen.IFeature {
	if identifier == "test:veg_marker" {
		return r.delegate
	}
	return nil
}

// buildTestVegPatch builds a minecraft:vegetation_patch_feature with sane
// defaults (horizontal_radius 1, depth 2, vertical_range 5, ground_block
// minecraft:podzol, replaceable_blocks [air, dirt], vegetation_feature
// "test:veg_marker", vegetation_chance 1.0), overridden/extended by extra.
func buildTestVegPatch(t *testing.T, pal *block.Palette, resolver wgen.IFeatureResolver, extra map[string]any) wgen.IFeature {
	t.Helper()
	body := map[string]any{
		"replaceable_blocks": []any{"minecraft:air", "minecraft:dirt"},
		"ground_block":       "minecraft:podzol",
		"vegetation_feature": "test:veg_marker",
		"depth":              float64(2),
		"horizontal_radius":  float64(1),
		"vertical_range":     float64(5),
		"vegetation_chance":  float64(1),
	}
	for k, v := range extra {
		body[k] = v
	}
	ctx := &BuildContext{
		Palette:    pal,
		Resolver:   resolver,
		Identifier: "test:veg_patch",
		FileID:     "test:veg_patch",
		Warn:       func(string) {},
	}
	f, err := buildVegetationPatchFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildVegetationPatchFeature: %v", err)
	}
	return f
}

func vegTestCtx(v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) *wgen.PlacementContext {
	return &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
}

// TestVegetationPatchFeature_UnknownSurfaceStillRejected: the two-value
// switch ("floor"/"ceiling") must still fail loudly on anything else,
// matching the engine's own "Bad value for surface - should be 'ceiling' or
// 'floor'" content-log diagnostic -- this is not a case the refactor should
// have silently widened.
func TestVegetationPatchFeature_UnknownSurfaceStillRejected(t *testing.T) {
	pal := block.NewPalette()
	body := map[string]any{
		"replaceable_blocks": []any{"minecraft:air"},
		"ground_block":       "minecraft:podzol",
		"vegetation_feature": "test:veg_marker",
		"depth":              float64(1),
		"horizontal_radius":  float64(1),
		"vertical_range":     float64(5),
		"surface":            "sideways",
	}
	ctx := &BuildContext{Palette: pal, Resolver: vegMarkerResolver{}, Identifier: "test:veg_patch", FileID: "test:veg_patch", Warn: func(string) {}}
	_, err := buildVegetationPatchFeature(body, ctx)
	if err == nil {
		t.Fatal("expected an error for surface: \"sideways\"")
	}
	if !strings.Contains(err.Error(), "ceiling") || !strings.Contains(err.Error(), "floor") {
		t.Fatalf("expected the error to name both valid values, got: %v", err)
	}
}

// newVegFloorVolume builds a 5x8x5 volume (X/Z -2..2, Y 6..13) with solid
// minecraft:dirt at Y=7,8,9 under an air pocket at Y=10 (origin) -- a floor
// three dirt layers thick, deep enough for depth up to 3 to fully consume.
//
// The X/Z extent is +-2, not +-1, because place() passes
// horizontal_radius + 1 to the ground-patch placement, on both axes:
// a file asking for radius 1 walks a 5x5 patch whose outermost
// ring is the one extra_edge_column_chance gates.
func newVegFloorVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	dirt := pal.Get("minecraft:dirt", nil)
	bounds := volume.Bounds{MinX: -2, MinY: 6, MinZ: -2, SizeX: 5, SizeY: 8, SizeZ: 5}
	v := volume.New(bounds, pal, block.AirID)
	for x := -2; x <= 2; x++ {
		for z := -2; z <= 2; z++ {
			for y := 7; y <= 9; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, dirt)
			}
		}
	}
	return v, pal
}

// newVegCeilingVolume is newVegFloorVolume's exact mirror image about
// origin.Y=10: solid minecraft:dirt at Y=11,12,13 (a ceiling three dirt
// layers thick) over an air pocket at Y=10.
func newVegCeilingVolume(t *testing.T) (*volume.Volume, *block.Palette) {
	t.Helper()
	pal := block.NewPalette()
	dirt := pal.Get("minecraft:dirt", nil)
	bounds := volume.Bounds{MinX: -2, MinY: 6, MinZ: -2, SizeX: 5, SizeY: 8, SizeZ: 5}
	v := volume.New(bounds, pal, block.AirID)
	for x := -2; x <= 2; x++ {
		for z := -2; z <= 2; z++ {
			for y := 11; y <= 13; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, dirt)
			}
		}
	}
	return v, pal
}

// TestVegetationPatchFeature_Ceiling_RealCarve_CrossSection is this
// project's own carve-verification standard, applied to the direction this
// task warns about specifically: "a patch placed in the wrong direction
// places the right number of blocks and looks fine to a count-based test."
// This renders and asserts the actual geometry, not just counts.
//
// Expected geometry: the cell that goes into the
// list -- and the first cell the depth fill writes -- is the one a step
// FURTHER in the scan direction than the air cell the column walk stops in
// -- the engine adds the extra step to the fill count. So ground_block eats into the dirt
// ceiling proper (Y=11 and Y=12), the air pocket at Y=10 STAYS air, and the
// vegetation hangs in it. Writing podzol into the air cell itself would hang
// the vegetation a further block below it.
func TestVegetationPatchFeature_Ceiling_RealCarve_CrossSection(t *testing.T) {
	v, pal := newVegCeilingVolume(t)
	podzol := pal.Get("minecraft:podzol", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	torch := pal.Get("minecraft:torch", nil)
	marker := &vegMarkerDelegate{v: v, marker: torch}

	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"surface":                  "ceiling",
		"extra_edge_column_chance": float64(1), // deterministically include every edge cell
	})

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	ctx := vegTestCtx(v, origin, random.New(1))
	got := f.Place(ctx)
	if got == nil {
		t.Fatal("expected Place to succeed")
	}

	// Render the X/Y cross-section at Z=0 -- '#'=dirt, '.'=air, 'G'=ground
	// block (podzol), 'V'=vegetation marker (torch).
	var art strings.Builder
	for y := 13; y >= 8; y-- {
		for x := -2; x <= 2; x++ {
			pos := wgen.BlockPos{X: x, Y: y, Z: 0}
			switch v.GetBlock(pos) {
			case podzol:
				art.WriteByte('G')
			case torch:
				art.WriteByte('V')
			case dirt:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("ceiling vegetation_patch cross-section at Z=0, Y=13(top)..8(bottom), X=-2..2 (# dirt, . air, G ground_block, V vegetation marker):\n%s", art.String())

	// Every non-corner cell of the 5x5 patch: ground_block eats UPWARD into
	// the ceiling (Y=11 and Y=12); Y=13 stays dirt (depth=2 consumes two
	// layers) and the air pocket at Y=10 stays air, holding the vegetation.
	for _, c := range vegPatchColumns(2) {
		p10 := wgen.BlockPos{X: c.X, Y: 10, Z: c.Z}
		p11 := wgen.BlockPos{X: c.X, Y: 11, Z: c.Z}
		p12 := wgen.BlockPos{X: c.X, Y: 12, Z: c.Z}
		p13 := wgen.BlockPos{X: c.X, Y: 13, Z: c.Z}
		if got := v.GetBlock(p11); got != podzol {
			t.Errorf("cell %+v: expected podzol at Y=11 (the ceiling block itself), got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(p12); got != podzol {
			t.Errorf("cell %+v: expected podzol at Y=12 (depth ate upward into the ceiling), got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(p13); got != dirt {
			t.Errorf("cell %+v: expected Y=13 untouched dirt (depth=2 stops here), got %v", c, pal.Entry(got))
		}
		// Vegetation grows DOWNWARD, into the air cell the walk stopped in.
		if got := v.GetBlock(p10); got != torch {
			t.Errorf("cell %+v: expected a vegetation marker at Y=10 (the air cell below the ground block), got %v", c, pal.Entry(got))
		}
	}

	// Corners are trimmed with NO RNG and never visited at all -- confirm
	// they keep their original untouched state (dirt at Y=11.., air at Y=10
	// and below).
	for _, c := range []wgen.BlockPos{{X: 2, Z: 2}, {X: 2, Z: -2}, {X: -2, Z: 2}, {X: -2, Z: -2}} {
		p10 := wgen.BlockPos{X: c.X, Y: 10, Z: c.Z}
		p9 := wgen.BlockPos{X: c.X, Y: 9, Z: c.Z}
		p11 := wgen.BlockPos{X: c.X, Y: 11, Z: c.Z}
		if got := v.GetBlock(p10); got != block.AirID {
			t.Errorf("corner %+v: expected untouched air at Y=10, got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(p9); got != block.AirID {
			t.Errorf("corner %+v: expected untouched air at Y=9 (no vegetation), got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(p11); got != dirt {
			t.Errorf("corner %+v: expected untouched dirt at Y=11, got %v", c, pal.Entry(got))
		}
	}

	if want := len(vegPatchColumns(2)); len(marker.origins) != want {
		t.Fatalf("expected %d vegetation delegations (one per non-corner cell of the 5x5 patch), got %d: %+v", want, len(marker.origins), marker.origins)
	}
}

// vegPatchColumns is every column the ground-patch placement visits for a given span:
// the full (2*span+1)^2 square minus its four corners, which the engine trims
// unconditionally and without a draw -- the engine tests the corner first. span is
// horizontal_radius + 1.
func vegPatchColumns(span int) []wgen.BlockPos {
	var out []wgen.BlockPos
	for dx := -span; dx <= span; dx++ {
		for dz := -span; dz <= span; dz++ {
			if (dx == -span || dx == span) && (dz == -span || dz == span) {
				continue
			}
			out = append(out, wgen.BlockPos{X: dx, Z: dz})
		}
	}
	return out
}

// TestVegetationPatchFeature_Floor_RealCarve_StillCorrect is the same
// standard applied to "floor" post-refactor, as a direct regression guard
// alongside TestGoldenDigest: ground_block eats DOWNWARD into the dirt
// floor, vegetation grows UPWARD.
func TestVegetationPatchFeature_Floor_RealCarve_StillCorrect(t *testing.T) {
	v, pal := newVegFloorVolume(t)
	podzol := pal.Get("minecraft:podzol", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	torch := pal.Get("minecraft:torch", nil)
	marker := &vegMarkerDelegate{v: v, marker: torch}

	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"surface":                  "floor",
		"extra_edge_column_chance": float64(1),
	})

	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	ctx := vegTestCtx(v, origin, random.New(1))
	if got := f.Place(ctx); got == nil {
		t.Fatal("expected Place to succeed")
	}

	for _, c := range vegPatchColumns(2) {
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 9, Z: c.Z}); got != podzol {
			t.Errorf("cell %+v: expected podzol at Y=9 (the floor block itself), got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 8, Z: c.Z}); got != podzol {
			t.Errorf("cell %+v: expected podzol at Y=8 (depth ate downward), got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 7, Z: c.Z}); got != dirt {
			t.Errorf("cell %+v: expected Y=7 untouched dirt, got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 10, Z: c.Z}); got != torch {
			t.Errorf("cell %+v: expected a vegetation marker at Y=10 (the air cell above the ground block), got %v", c, pal.Entry(got))
		}
	}
	if want := len(vegPatchColumns(2)); len(marker.origins) != want {
		t.Fatalf("expected %d vegetation delegations, got %d", want, len(marker.origins))
	}
}

// TestVegetationPatchFeature_CeilingRNGSequence_MatchesFloor pins the exact
// RNG draw sequence (method, bound, AND value, not just count) for "ceiling"
// against the same sequence "floor" produces from the same seed and
// otherwise-identical config -- proving the direction selector changes only
// Y arithmetic, never the RNG call order this project's correctness
// contract depends on. Uses a non-degenerate depth range and non-zero
// extra_deep_block_chance/extra_edge_column_chance so every RNG branch in
// both placeGroundPatch and Place actually fires.
func TestVegetationPatchFeature_CeilingRNGSequence_MatchesFloor(t *testing.T) {
	run := func(surface string) []random.DrawRecord {
		var v *volume.Volume
		var pal *block.Palette
		if surface == "floor" {
			v, pal = newVegFloorVolume(t)
		} else {
			v, pal = newVegCeilingVolume(t)
		}
		torch := pal.Get("minecraft:torch", nil)
		marker := &vegMarkerDelegate{v: v, marker: torch}
		f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
			"surface":                  surface,
			"depth":                    []any{float64(1), float64(3)}, // non-degenerate -- draws
			"extra_deep_block_chance":  float64(0.4),
			"extra_edge_column_chance": float64(0.6),
		})
		tracer := random.NewTracer(random.New(7))
		ctx := vegTestCtx(v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, tracer)
		if got := f.Place(ctx); got == nil {
			t.Fatalf("surface=%s: expected Place to succeed", surface)
		}
		return tracer.Draws
	}

	floorDraws := run("floor")
	ceilingDraws := run("ceiling")

	if len(floorDraws) == 0 {
		t.Fatal("expected a nonzero number of draws for this config (radius/edge/deep/depth/vegetation all RNG-eligible)")
	}
	if len(floorDraws) != len(ceilingDraws) {
		t.Fatalf("draw count differs: floor=%d ceiling=%d -- direction must not change how many draws happen", len(floorDraws), len(ceilingDraws))
	}
	for i := range floorDraws {
		fd, cd := floorDraws[i], ceilingDraws[i]
		if fd.Method != cd.Method || fd.Bound != cd.Bound || fd.Value != cd.Value {
			t.Fatalf("draw %d differs: floor=%+v ceiling=%+v -- direction must not perturb the RNG sequence", i, fd, cd)
		}
	}
	t.Logf("floor and ceiling produced the IDENTICAL %d-draw RNG sequence: %+v", len(floorDraws), floorDraws)
}

// TestVegetationPatchFeature_DepthZeroStillGrowsVegetation is the headline
// regression: `depth: 0` writes NO ground_block and still contributes every
// column it found. the zero case
// is the engine's own zero-depth branch -- a zero depth count jumps
// straight past the fill loop to the push, and only the loop's own
// non-replaceable BREAK is guarded by "did this column write anything"
// -- the engine drops the column only when nothing was written at all.
//
// Requiring a written cell before keeping a column would make a depth-0
// patch produce nothing at all and report "Vegetation could not be placed".
func TestVegetationPatchFeature_DepthZeroStillGrowsVegetation(t *testing.T) {
	v, pal := newVegFloorVolume(t)
	podzol := pal.Get("minecraft:podzol", nil)
	dirt := pal.Get("minecraft:dirt", nil)
	torch := pal.Get("minecraft:torch", nil)
	marker := &vegMarkerDelegate{v: v, marker: torch}

	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"depth":                    float64(0),
		"extra_edge_column_chance": float64(1),
	})
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	if got := f.Place(vegTestCtx(v, origin, random.New(1))); got == nil {
		t.Fatal("expected Place to succeed for depth: 0 -- the engine keeps every column it found")
	}

	for _, c := range vegPatchColumns(2) {
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 9, Z: c.Z}); got != dirt {
			t.Errorf("cell %+v: expected the floor at Y=9 to stay dirt (depth 0 writes nothing), got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 10, Z: c.Z}); got != torch {
			t.Errorf("cell %+v: expected a vegetation marker at Y=10, got %v", c, pal.Entry(got))
		}
	}
	if want := len(vegPatchColumns(2)); len(marker.origins) != want {
		t.Fatalf("expected %d vegetation delegations for depth: 0, got %d", want, len(marker.origins))
	}
	for x := -2; x <= 2; x++ {
		for z := -2; z <= 2; z++ {
			for y := 6; y <= 13; y++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == podzol {
					t.Fatalf("depth: 0 wrote ground_block at %+v", wgen.BlockPos{X: x, Y: y, Z: z})
				}
			}
		}
	}
}

// TestVegetationPatchFeature_BuriedOriginClimbsOutOfTheGround pins the second
// column-walk phase: an origin that starts INSIDE the ground
// walks back the other way until it finds air, up to vertical_range steps,
// and anchors there. This port scanned one direction only and treated a
// buried origin as ground found at the origin itself, burying the whole patch
// two layers too deep.
func TestVegetationPatchFeature_BuriedOriginClimbsOutOfTheGround(t *testing.T) {
	v, pal := newVegFloorVolume(t)
	podzol := pal.Get("minecraft:podzol", nil)
	torch := pal.Get("minecraft:torch", nil)
	marker := &vegMarkerDelegate{v: v, marker: torch}

	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"extra_edge_column_chance": float64(1),
	})
	// Y=8 is the middle of the three dirt layers (7, 8, 9); the air pocket
	// starts at Y=10.
	origin := wgen.BlockPos{X: 0, Y: 8, Z: 0}
	if got := f.Place(vegTestCtx(v, origin, random.New(1))); got == nil {
		t.Fatal("expected Place to succeed from a buried origin")
	}
	for _, c := range vegPatchColumns(2) {
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 9, Z: c.Z}); got != podzol {
			t.Errorf("cell %+v: expected podzol at Y=9 (the surface the walk climbed to), got %v", c, pal.Entry(got))
		}
		if got := v.GetBlock(wgen.BlockPos{X: c.X, Y: 10, Z: c.Z}); got != torch {
			t.Errorf("cell %+v: expected a vegetation marker at Y=10, got %v", c, pal.Entry(got))
		}
	}
}

// TestVegetationPatchFeature_RadiusIsPlusOne pins place()'s two `ADD Wn, Wn,
// on each axis: the patch a file asks for is two columns
// wider than its horizontal_radius on each axis, and its outermost ring is
// the one extra_edge_column_chance gates. `horizontal_radius: 0` is therefore
// a 3x3 patch, not a single column.
func TestVegetationPatchFeature_RadiusIsPlusOne(t *testing.T) {
	v, pal := newVegFloorVolume(t)
	torch := pal.Get("minecraft:torch", nil)
	marker := &vegMarkerDelegate{v: v, marker: torch}

	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"horizontal_radius": float64(0),
		// left at its default of 0, so the outermost ring is skipped without
		// a draw and only the single interior column survives.
	})
	if got := f.Place(vegTestCtx(v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(1))); got == nil {
		t.Fatal("expected Place to succeed")
	}
	if len(marker.origins) != 1 {
		t.Fatalf("expected exactly 1 delegation (the centre of a 3x3 patch whose whole outer ring is edge-gated), got %d: %+v",
			len(marker.origins), marker.origins)
	}
	if got := marker.origins[0]; got != (wgen.BlockPos{X: 0, Y: 10, Z: 0}) {
		t.Fatalf("delegation origin = %+v, want the centre column at Y=10", got)
	}
}

// TestVegetationPatchFeature_DefaultEdgeChanceLeavesTheInterior measures the
// footprint the wiki page quotes: with the default extra_edge_column_chance
// of 0 the whole outer ring is dropped without a draw, so a
// `horizontal_radius: 4` patch -- an 11x11 rectangle once place()'s +1 is
// applied -- keeps exactly its 9x9 interior.
func TestVegetationPatchFeature_DefaultEdgeChanceLeavesTheInterior(t *testing.T) {
	pal := block.NewPalette()
	dirt := pal.Get("minecraft:dirt", nil)
	bounds := volume.Bounds{MinX: -8, MinY: 6, MinZ: -8, SizeX: 17, SizeY: 8, SizeZ: 17}
	v := volume.New(bounds, pal, block.AirID)
	for x := -8; x <= 8; x++ {
		for z := -8; z <= 8; z++ {
			for y := 7; y <= 9; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, dirt)
			}
		}
	}
	torch := pal.Get("minecraft:torch", nil)
	marker := &vegMarkerDelegate{v: v, marker: torch}
	f := buildTestVegPatch(t, pal, vegMarkerResolver{marker}, map[string]any{
		"horizontal_radius": float64(4),
		"depth":             float64(1),
	})
	if got := f.Place(vegTestCtx(v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, random.New(1))); got == nil {
		t.Fatal("expected Place to succeed")
	}
	if len(marker.origins) != 81 {
		t.Fatalf("kept columns = %d, want 81 (the 9x9 interior of an 11x11 patch)", len(marker.origins))
	}
	for _, o := range marker.origins {
		if o.X < -4 || o.X > 4 || o.Z < -4 || o.Z > 4 {
			t.Fatalf("column %+v is outside the 9x9 interior -- the outer ring should be dropped at the default extra_edge_column_chance", o)
		}
	}
}
