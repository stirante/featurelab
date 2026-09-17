// fossil_test.go exercises FossilFeature's RNG draw sequence explicitly (method/bound/order,
// per random.Tracer, including the zero-draw abort path), the two-pass local-Random replay
// identity (ore positions subset of bone positions), the palette mapping (bone_block axis ->
// pillar_axis, and the per-rotation axis swap), the corner-emptiness check, and build-time refusal
// by name when structures are missing -- not just final block counts. There is no golden-dump
// differential coverage for this type (its structures are not vendored in this repo -- see
// fossil.go's header), so these tests are what stands between a
// wrong implementation and a caller relying on this type, together with
// TestFossilFeature_RealVanillaStructures below (skips cleanly without the real files).
package features

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/nbt"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// ---------------------------------------------------------------------------
// Synthetic structures -- fully under this test file's control, so tests
// don't depend on the real vanilla .nbt files being present on disk.
// ---------------------------------------------------------------------------

// fakeLegacyResolver implements structures.ILegacyResolver over a plain map -- the minimal stand-
// in this file's builder tests need, independent of structures.BuildLibrary's own file-parsing
// path (already covered by structures/legacy_test.go).
type fakeLegacyResolver map[string]*structures.ResolvedLegacyStructure

func (f fakeLegacyResolver) ResolveLegacy(key string) *structures.ResolvedLegacyStructure {
	return f[key]
}

var _ structures.ILegacyResolver = fakeLegacyResolver{}

// syntheticFossilStructure builds a rectangular structure of the given size, one bone_block entry
// per cell, palette entries cycling through axis x/y/z so every rotation test has real axis
// remapping to exercise. Deliberately NOT a realistic fossil silhouette -- these tests check the
// game's mechanism (draw order, rotation math, integrity rolls), not real fossil geometry
// (TestFossilFeature_RealVanillaStructures below covers that).
func syntheticFossilStructure(sizeX, sizeY, sizeZ int) *structures.ResolvedLegacyStructure {
	axes := []string{"x", "y", "z"}
	palette := []structures.LegacyPaletteEntry{
		{Name: "minecraft:bone_block", Properties: map[string]any{"axis": "x"}},
		{Name: "minecraft:bone_block", Properties: map[string]any{"axis": "y"}},
		{Name: "minecraft:bone_block", Properties: map[string]any{"axis": "z"}},
	}
	var blocks []structures.LegacyBlockRef
	i := 0
	for x := 0; x < sizeX; x++ {
		for y := 0; y < sizeY; y++ {
			for z := 0; z < sizeZ; z++ {
				blocks = append(blocks, structures.LegacyBlockRef{
					Pos:     nbt.Vec3Int{X: x, Y: y, Z: z},
					Palette: i % len(axes),
				})
				i++
			}
		}
	}
	return &structures.ResolvedLegacyStructure{
		Size:    nbt.Vec3Int{X: sizeX, Y: sizeY, Z: sizeZ},
		Palette: palette,
		Blocks:  blocks,
	}
}

// allEightFossilStructures returns a fakeLegacyResolver with all 8 required keys present, each a
// distinctly-sized synthetic structure (so a test can tell which one nextInt(8) picked from its
// draw's own recorded bound/value without needing real data).
func allEightFossilStructures() fakeLegacyResolver {
	sizes := [8][3]int{
		{2, 2, 3}, {3, 2, 4}, {2, 3, 5}, {4, 2, 3},
		{3, 3, 2}, {2, 4, 3}, {5, 2, 2}, {3, 2, 2},
	}
	r := make(fakeLegacyResolver, 8)
	for i, name := range fossilStructureNames {
		s := sizes[i]
		r[name] = syntheticFossilStructure(s[0], s[1], s[2])
	}
	return r
}

func buildTestFossilFeature(t *testing.T, pal *block.Palette, resolver structures.ILegacyResolver, body map[string]any) *FossilFeature {
	t.Helper()
	base := map[string]any{
		"ore_block":         "minecraft:diamond_ore",
		"max_empty_corners": float64(8),
	}
	for k, v := range body {
		base[k] = v
	}
	ctx := &BuildContext{Palette: pal, LegacyStructures: resolver, Identifier: "test:fossil", FileID: "test:fossil.json", Warn: func(string) {}}
	f, err := buildFossilFeature(base, ctx)
	if err != nil {
		t.Fatalf("buildFossilFeature: %v", err)
	}
	ff, ok := f.(*FossilFeature)
	if !ok {
		t.Fatalf("buildFossilFeature returned %T, want *FossilFeature", f)
	}
	return ff
}

func newFossilTestVolume() (*volume.Volume, *block.Palette, wgen.BlockPos) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -20, MinY: 40, MinZ: -20, SizeX: 40, SizeY: 60, SizeZ: 40}
	v := volume.New(bounds, pal, block.AirID)
	// Fill a solid floor so GetAboveTopSolidAt has something to find and corners aren't
	// trivially "empty" everywhere.
	for x := -20; x < 20; x++ {
		for z := -20; z < 20; z++ {
			v.SetBlock(wgen.BlockPos{X: x, Y: 63, Z: z}, pal.Get("minecraft:stone", nil))
		}
	}
	return v, pal, wgen.BlockPos{X: 0, Y: 70, Z: 0}
}

// ---------------------------------------------------------------------------
// Palette mapping: bone_block axis -> pillar_axis, and the per-rotation swap.
// ---------------------------------------------------------------------------

func TestFossilRotateAxis(t *testing.T) {
	cases := []struct {
		axis     string
		rotation int
		want     string
	}{
		{"x", 0, "x"}, {"y", 0, "y"}, {"z", 0, "z"},
		{"x", 1, "z"}, {"z", 1, "x"}, {"y", 1, "y"},
		{"x", 2, "x"}, {"y", 2, "y"}, {"z", 2, "z"},
		{"x", 3, "z"}, {"z", 3, "x"}, {"y", 3, "y"},
	}
	for _, c := range cases {
		if got := fossilRotateAxis(c.axis, c.rotation); got != c.want {
			t.Errorf("fossilRotateAxis(%q, %d) = %q, want %q", c.axis, c.rotation, got, c.want)
		}
	}
}

func TestBuildFossilFeature_InternsAllThreeBoneAxes(t *testing.T) {
	pal := block.NewPalette()
	f := buildTestFossilFeature(t, pal, allEightFossilStructures(), nil)
	for _, axis := range []string{"x", "y", "z"} {
		id, ok := f.boneBlockByAxis[axis]
		if !ok {
			t.Fatalf("no interned block.ID for axis %q", axis)
		}
		entry := pal.Entry(id)
		if entry.Name != "minecraft:bone_block" {
			t.Errorf("axis %q: Name = %q, want minecraft:bone_block", axis, entry.Name)
		}
		if entry.States["pillar_axis"] != block.StateValue(axis) {
			t.Errorf("axis %q: States[pillar_axis] = %v, want %q", axis, entry.States["pillar_axis"], axis)
		}
	}
	// The three axes must intern to three DISTINCT ids -- otherwise SetBlock couldn't tell them
	// apart at all.
	if f.boneBlockByAxis["x"] == f.boneBlockByAxis["y"] || f.boneBlockByAxis["y"] == f.boneBlockByAxis["z"] {
		t.Error("distinct axes interned to the same block.ID")
	}
}

// ---------------------------------------------------------------------------
// Build-time refusal by name.
// ---------------------------------------------------------------------------

func TestBuildFossilFeature_RefusesByNameWhenStructuresMissing(t *testing.T) {
	pal := block.NewPalette()
	resolver := allEightFossilStructures()
	delete(resolver, "fossils/fossil_spine_02")
	delete(resolver, "fossils/fossil_skull_04")

	ctx := &BuildContext{Palette: pal, LegacyStructures: resolver, Identifier: "test:fossil", FileID: "test:fossil.json", Warn: func(string) {}}
	_, err := buildFossilFeature(map[string]any{"ore_block": "minecraft:diamond_ore", "max_empty_corners": float64(8)}, ctx)
	if err == nil {
		t.Fatal("expected an error when required structures are missing, got nil")
	}
	for _, missing := range []string{"fossils/fossil_spine_02", "fossils/fossil_skull_04"} {
		if !strings.Contains(err.Error(), missing) {
			t.Errorf("error does not name missing structure %q: %v", missing, err)
		}
	}
}

func TestBuildFossilFeature_RefusesWithNoLegacyStructures(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, LegacyStructures: structures.NoLegacyStructures, Identifier: "test:fossil", FileID: "test:fossil.json", Warn: func(string) {}}
	_, err := buildFossilFeature(map[string]any{"ore_block": "minecraft:diamond_ore", "max_empty_corners": float64(8)}, ctx)
	if err == nil {
		t.Fatal("expected an error when no legacy structures are loaded at all, got nil")
	}
	if !strings.Contains(err.Error(), "fossils/fossil_spine_01") {
		t.Errorf("error should name at least the first missing structure: %v", err)
	}
}

func TestNewFossilStructure_RefusesNonBoneBlock(t *testing.T) {
	raw := &structures.ResolvedLegacyStructure{
		Size:    nbt.Vec3Int{X: 1, Y: 1, Z: 1},
		Palette: []structures.LegacyPaletteEntry{{Name: "minecraft:stone", Properties: nil}},
		Blocks:  []structures.LegacyBlockRef{{Pos: nbt.Vec3Int{}, Palette: 0}},
	}
	if _, err := newFossilStructure("test/key", raw); err == nil {
		t.Fatal("expected an error for a non-bone_block palette entry, got nil")
	}
}

func TestNewFossilStructure_RefusesMissingAxis(t *testing.T) {
	raw := &structures.ResolvedLegacyStructure{
		Size:    nbt.Vec3Int{X: 1, Y: 1, Z: 1},
		Palette: []structures.LegacyPaletteEntry{{Name: "minecraft:bone_block", Properties: map[string]any{}}},
		Blocks:  []structures.LegacyBlockRef{{Pos: nbt.Vec3Int{}, Palette: 0}},
	}
	if _, err := newFossilStructure("test/key", raw); err == nil {
		t.Fatal("expected an error for a bone_block palette entry with no axis, got nil")
	}
}

func TestNewFossilStructure_RefusesOversizedStructure(t *testing.T) {
	raw := &structures.ResolvedLegacyStructure{
		Size: nbt.Vec3Int{X: 16, Y: 1, Z: 1},
	}
	if _, err := newFossilStructure("test/key", raw); err == nil {
		t.Fatal("expected an error for a structure with X size >= 16, got nil")
	}
}

// ---------------------------------------------------------------------------
// The five-draw RNG sequence, and the zero-draw abort path.
// ---------------------------------------------------------------------------

func TestFossilFeature_DrawSequence(t *testing.T) {
	v, pal, origin := newFossilTestVolume()
	f := buildTestFossilFeature(t, pal, allEightFossilStructures(), nil)

	rnd := random.New(42)
	tracer := random.NewTracer(rnd)
	ctx := &wgen.PlacementContext{API: v, Origin: origin, Random: tracer, MolangScope: wgen.NewScope()}
	f.Place(ctx)

	if len(tracer.Draws) != 5 {
		t.Fatalf("len(Draws) = %d, want exactly 5: %+v", len(tracer.Draws), tracer.Draws)
	}
	for i, d := range tracer.Draws {
		if d.Method != random.MethodNextIntBound {
			t.Errorf("draw %d: Method = %v, want MethodNextIntBound", i, d.Method)
		}
	}
	rotationDraw, idxDraw, offXDraw, offZDraw, depthDraw := tracer.Draws[0], tracer.Draws[1], tracer.Draws[2], tracer.Draws[3], tracer.Draws[4]

	if rotationDraw.Bound != 4 {
		t.Errorf("draw 1 (rotation): Bound = %d, want 4", rotationDraw.Bound)
	}
	if idxDraw.Bound != 8 {
		t.Errorf("draw 2 (structure index): Bound = %d, want 8", idxDraw.Bound)
	}
	rotation := int(rotationDraw.Value)
	idx := int(idxDraw.Value)
	st := f.structures[idx]
	sizeX, sizeZ := st.raw.Size.X, st.raw.Size.Z
	rotSizeX, rotSizeZ := sizeX, sizeZ
	if rotation == 1 || rotation == 3 {
		rotSizeX, rotSizeZ = sizeZ, sizeX
	}
	if int(offXDraw.Bound) != 16-rotSizeX {
		t.Errorf("draw 3 (offX): Bound = %d, want %d (16 - rotSizeX=%d, rotation=%d, structure=%s)", offXDraw.Bound, 16-rotSizeX, rotSizeX, rotation, fossilStructureNames[idx])
	}
	if int(offZDraw.Bound) != 16-rotSizeZ {
		t.Errorf("draw 4 (offZ): Bound = %d, want %d", offZDraw.Bound, 16-rotSizeZ)
	}
	if depthDraw.Bound != 10 {
		t.Errorf("draw 5 (burial depth): Bound = %d, want 10", depthDraw.Bound)
	}
}

func TestFossilFeature_DrawSequence_MultipleSeedsAlwaysExactlyFive(t *testing.T) {
	// Different seeds pick different rotations/structures/offsets -- the draw COUNT and METHOD
	// sequence must stay fixed regardless (only the values vary).
	for _, seed := range []uint32{1, 2, 3, 100, 999999, 0xDEADBEEF} {
		v, pal, origin := newFossilTestVolume()
		f := buildTestFossilFeature(t, pal, allEightFossilStructures(), nil)
		tracer := random.NewTracer(random.New(seed))
		ctx := &wgen.PlacementContext{API: v, Origin: origin, Random: tracer, MolangScope: wgen.NewScope()}
		f.Place(ctx)
		if len(tracer.Draws) != 5 {
			t.Errorf("seed %d: len(Draws) = %d, want 5", seed, len(tracer.Draws))
		}
	}
}

func TestFossilFeature_ZeroDrawAbortPath(t *testing.T) {
	orig := fossilOverlapsWithStructureFeature
	defer func() { fossilOverlapsWithStructureFeature = orig }()

	var calledWith wgen.BlockPos
	fossilOverlapsWithStructureFeature = func(ctx *wgen.PlacementContext, pos wgen.BlockPos) bool {
		calledWith = pos
		return true
	}

	v, pal, origin := newFossilTestVolume()
	f := buildTestFossilFeature(t, pal, allEightFossilStructures(), nil)
	tracer := random.NewTracer(random.New(7))
	var failures []string
	ctx := &wgen.PlacementContext{
		API: v, Origin: origin, Random: tracer, MolangScope: wgen.NewScope(),
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {
			failures = append(failures, featureType+": "+message)
		},
	}

	result := f.Place(ctx)

	if result != nil {
		t.Errorf("Place() = %+v, want nil when the overlap hook returns true", result)
	}
	if len(tracer.Draws) != 0 {
		t.Errorf("len(Draws) = %d, want 0 -- the abort must happen BEFORE any draw", len(tracer.Draws))
	}
	if calledWith != origin {
		t.Errorf("hook called with %+v, want origin %+v", calledWith, origin)
	}
	if len(failures) != 1 {
		t.Fatalf("LogFailure calls = %+v, want exactly 1", failures)
	}
}

// ---------------------------------------------------------------------------
// Two-pass local-Random replay identity: ore positions are a subset of bone positions.
// ---------------------------------------------------------------------------

// fossilRecordingAPI wraps a real BlockWorld, logging every SetBlock call (position, id) in
// call order, REGARDLESS of whether the underlying write changed anything or was later
// overwritten -- exactly what's needed to observe both passes' own candidate positions even though
// the final volume state only shows the LAST write at any given position.
type fossilRecordingAPI struct {
	wgen.BlockWorld
	writes []struct {
		pos wgen.BlockPos
		id  block.ID
	}
}

func (r *fossilRecordingAPI) SetBlock(pos wgen.BlockPos, id block.ID) bool {
	r.writes = append(r.writes, struct {
		pos wgen.BlockPos
		id  block.ID
	}{pos, id})
	return r.BlockWorld.SetBlock(pos, id)
}

// TestFossilFeature_OrePositionsSubsetOfBonePositions proves ore positions are a subset of bone
// positions AND (the stronger, actually mutation-sensitive check) that the ore set is EXACTLY what
// independently replaying the SAME captured seed predicts. A plain subset check alone is too weak
// to catch a wrong seed: at bone integrity 0.9, bone covers ~90% of all entries regardless of which
// generator drives the ore pass, so an ore pass seeded from a WRONG value would still land inside
// that 90% footprint most of the time by sheer chance (a subset check alone does NOT fail when
// orePass is deliberately reseeded to localSeed+1). The independent-replay check below closes
// that gap: it
// recomputes the predicted ore positions from scratch, using ONLY the captured seed (rnd.GetSeed(),
// readable from the test because random.New(seed).GetSeed() always returns the construction seed
// verbatim -- IRandom.GetSeed's own documented contract) and the SAME rotateXZ/offset formula
// fossil.go's Place uses, and requires an EXACT set match, not just containment.
func TestFossilFeature_OrePositionsSubsetOfBonePositions(t *testing.T) {
	v, pal, origin := newFossilTestVolume()
	// EVERY one of the 8 keys gets a decently large structure (still well under the offset
	// bound) -- whichever nextInt(8) happens to pick for this seed, there are enough entries
	// (60) for both the ~90% bone band and the ~10% ore band to fire in practice.
	resolver := make(fakeLegacyResolver, 8)
	for _, name := range fossilStructureNames {
		resolver[name] = syntheticFossilStructure(4, 3, 5) // 60 entries
	}
	f := buildTestFossilFeature(t, pal, resolver, nil)

	const seed = 123
	rec := &fossilRecordingAPI{BlockWorld: v}
	tracer := random.NewTracer(random.New(seed))
	ctx := &wgen.PlacementContext{API: rec, Origin: origin, Random: tracer, MolangScope: wgen.NewScope()}
	result := f.Place(ctx)
	if result == nil {
		t.Fatal("Place() returned nil -- test setup should always succeed to place something")
	}

	boneIDs := map[block.ID]bool{f.boneBlockByAxis["x"]: true, f.boneBlockByAxis["y"]: true, f.boneBlockByAxis["z"]: true}
	bonePositions := make(map[wgen.BlockPos]bool)
	orePositions := make(map[wgen.BlockPos]bool)
	for _, w := range rec.writes {
		switch {
		case boneIDs[w.id]:
			bonePositions[w.pos] = true
		case w.id == f.oreBlock:
			orePositions[w.pos] = true
		default:
			t.Fatalf("unexpected written id %v at %+v (neither bone nor ore)", w.id, w.pos)
		}
	}
	if len(bonePositions) == 0 {
		t.Fatal("0 bone positions written -- test parameters yield nothing to check")
	}
	if len(orePositions) == 0 {
		t.Fatal("0 ore positions written -- test parameters yield nothing to check (integrity 0.1 should still fire for ~10% of 60 entries)")
	}
	for pos := range orePositions {
		if !bonePositions[pos] {
			t.Errorf("ore written at %+v, but bone was never written there -- the two passes did not replay the same stream", pos)
		}
	}

	// Strong check: recompute the EXACT predicted ore set independently, from just the captured
	// seed, rotation, and returned position P -- all three are things the test itself either
	// chose (seed) or can read back off Place()'s own output (rotation via the recorded draw,
	// P via the returned position).
	rotation := int(tracer.Draws[0].Value)
	idx := int(tracer.Draws[1].Value)
	st := f.structures[idx]
	p := *result
	predicted := random.New(seed)
	predictedOre := make(map[wgen.BlockPos]bool)
	for _, entry := range st.raw.Blocks {
		roll := predicted.NextFloat()
		if roll > fossilOreIntegrity {
			continue
		}
		wx, wz := rotateXZ(entry.Pos.X, entry.Pos.Z, rotation)
		predictedOre[wgen.BlockPos{X: p.X + wx, Y: p.Y + entry.Pos.Y, Z: p.Z + wz}] = true
	}
	if len(predictedOre) != len(orePositions) {
		t.Fatalf("independently predicted %d ore positions, but Place() actually wrote %d -- the ore pass is not replaying the captured seed", len(predictedOre), len(orePositions))
	}
	for pos := range predictedOre {
		if !orePositions[pos] {
			t.Errorf("predicted ore at %+v was never actually written", pos)
		}
	}

	t.Logf("bone positions=%d ore positions=%d (subset of bone: true; exact match with independent same-seed replay: true)", len(bonePositions), len(orePositions))
}

// TestFossilFeature_TwoFreshGeneratorsFromSameSeedReplayIdentically is the underlying mechanism
// TestFossilFeature_OrePositionsSubsetOfBonePositions's integration result rests on, isolated as a
// pure random-package fact: random.New(seed) called twice, drawing NextFloat() the same number of
// times from each, must produce an IDENTICAL sequence. If this ever failed, the integration test
// above would fail too, but for a much harder-to-diagnose reason.
func TestFossilFeature_TwoFreshGeneratorsFromSameSeedReplayIdentically(t *testing.T) {
	const seed = 999
	a := random.New(seed)
	b := random.New(seed)
	for i := 0; i < 200; i++ {
		va, vb := a.NextFloat(), b.NextFloat()
		if va != vb {
			t.Fatalf("draw %d: %v != %v -- two random.New(%d) instances diverged", i, va, vb, seed)
		}
	}
}

// ---------------------------------------------------------------------------
// Corner-emptiness check.
// ---------------------------------------------------------------------------

func TestFossilCountEmptyCorners(t *testing.T) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -10, MinY: 0, MinZ: -10, SizeX: 20, SizeY: 20, SizeZ: 20}
	v := volume.New(bounds, pal, block.AirID)
	stoneID := pal.Get("minecraft:stone", nil)
	waterID := pal.Get("minecraft:water", nil)
	lavaID := pal.Get("minecraft:lava", nil)

	p := wgen.BlockPos{X: 0, Y: 5, Z: 0}
	sizeX, sizeY, sizeZ := 3, 2, 4 // corners at (0,5,0)-(2,6,3) for rotation 0

	// All 8 corners solid -> count 0.
	corners := []wgen.BlockPos{
		{X: 0, Y: 5, Z: 0}, {X: 0, Y: 5, Z: 3}, {X: 0, Y: 6, Z: 0}, {X: 0, Y: 6, Z: 3},
		{X: 2, Y: 5, Z: 0}, {X: 2, Y: 5, Z: 3}, {X: 2, Y: 6, Z: 0}, {X: 2, Y: 6, Z: 3},
	}
	for _, c := range corners {
		v.SetBlock(c, stoneID)
	}
	if got := fossilCountEmptyCorners(v, pal, p, sizeX, sizeY, sizeZ, 0); got != 0 {
		t.Errorf("all-solid corners: count = %d, want 0", got)
	}

	// Set one corner to water, one to lava -- both count as "empty".
	v.SetBlock(corners[0], waterID)
	v.SetBlock(corners[1], lavaID)
	if got := fossilCountEmptyCorners(v, pal, p, sizeX, sizeY, sizeZ, 0); got != 2 {
		t.Errorf("water+lava corners: count = %d, want 2", got)
	}

	// Air (never written -- volume defaults to AirID) at every corner -> 8.
	v2 := volume.New(bounds, pal, block.AirID)
	if got := fossilCountEmptyCorners(v2, pal, p, sizeX, sizeY, sizeZ, 0); got != 8 {
		t.Errorf("all-air corners: count = %d, want 8", got)
	}
}

// TestFossilCountEmptyCorners_AllRotations exercises the 4 per-rotation corner-box formulas (this
// file's header cites all 4; TestFossilCountEmptyCorners above only ever used rotation 0) by
// solidifying EXACTLY the 8 corner cells each rotation's own formula predicts and confirming the
// OTHER 3 rotations' corner sets (which differ on at least one axis for every non-cubic size used
// here) see those same solid blocks as impossible to land on by coincidence -- i.e. every rotation
// counts 0 for ITS OWN corner set and would count something other than 0 for a mismatched one,
// proving the per-rotation formula is actually selecting a different box, not silently reusing
// rotation 0's.
func TestFossilCountEmptyCorners_AllRotations(t *testing.T) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -10, MinY: 0, MinZ: -10, SizeX: 20, SizeY: 20, SizeZ: 20}
	stoneID := pal.Get("minecraft:stone", nil)
	p := wgen.BlockPos{X: 0, Y: 5, Z: 0}
	sizeX, sizeY, sizeZ := 3, 2, 5 // deliberately asymmetric X vs Z so rotations 1/3 land elsewhere

	cornersFor := func(rotation int) []wgen.BlockPos {
		var maxC wgen.BlockPos
		switch rotation {
		case 1:
			maxC = wgen.BlockPos{X: p.X - (sizeZ - 1), Y: p.Y + (sizeY - 1), Z: p.Z + (sizeX - 1)}
		case 2:
			maxC = wgen.BlockPos{X: p.X - (sizeX - 1), Y: p.Y + (sizeY - 1), Z: p.Z - (sizeZ - 1)}
		case 3:
			maxC = wgen.BlockPos{X: p.X + (sizeZ - 1), Y: p.Y + (sizeY - 1), Z: p.Z - (sizeX - 1)}
		default:
			maxC = wgen.BlockPos{X: p.X + (sizeX - 1), Y: p.Y + (sizeY - 1), Z: p.Z + (sizeZ - 1)}
		}
		var out []wgen.BlockPos
		for _, cx := range [2]int{p.X, maxC.X} {
			for _, cy := range [2]int{p.Y, maxC.Y} {
				for _, cz := range [2]int{p.Z, maxC.Z} {
					out = append(out, wgen.BlockPos{X: cx, Y: cy, Z: cz})
				}
			}
		}
		return out
	}

	for rotation := 0; rotation < 4; rotation++ {
		v := volume.New(bounds, pal, block.AirID)
		for _, c := range cornersFor(rotation) {
			v.SetBlock(c, stoneID)
		}
		if got := fossilCountEmptyCorners(v, pal, p, sizeX, sizeY, sizeZ, rotation); got != 0 {
			t.Errorf("rotation %d: own corners solidified but count = %d, want 0", rotation, got)
		}
		for other := 0; other < 4; other++ {
			if other == rotation {
				continue
			}
			if got := fossilCountEmptyCorners(v, pal, p, sizeX, sizeY, sizeZ, other); got == 0 {
				t.Errorf("rotation %d's corners, read back as rotation %d, count = 0 -- the two rotations' corner boxes must differ for this asymmetric size", rotation, other)
			}
		}
	}
}

func TestFossilEmptyCornersExceeded_NegativeConfigNeverFails(t *testing.T) {
	f := &FossilFeature{maxEmptyCorners: -1}
	if f.emptyCornersExceeded(8) {
		t.Error("a negative max_empty_corners must never fail the check -- matches the game's (uint64) cast quirk, see fossil.go's doc comment")
	}
	f2 := &FossilFeature{maxEmptyCorners: 3}
	if !f2.emptyCornersExceeded(4) {
		t.Error("count(4) > maxEmptyCorners(3) should exceed")
	}
	if f2.emptyCornersExceeded(3) {
		t.Error("count(3) == maxEmptyCorners(3) should NOT exceed (comparison is strictly-greater)")
	}
}

func TestFossilFeature_TooManyEmptyCornersRefuses(t *testing.T) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -20, MinY: 0, MinZ: -20, SizeX: 40, SizeY: 100, SizeZ: 40}
	v := volume.New(bounds, pal, block.AirID) // ALL air: every corner is empty, always
	f := buildTestFossilFeature(t, pal, allEightFossilStructures(), map[string]any{"max_empty_corners": float64(0)})

	tracer := random.NewTracer(random.New(5))
	var failures []string
	ctx := &wgen.PlacementContext{
		API: v, Origin: wgen.BlockPos{X: 0, Y: 50, Z: 0}, Random: tracer, MolangScope: wgen.NewScope(),
		LogFailure: func(featureType, message string, pos wgen.BlockPos) { failures = append(failures, message) },
	}
	if result := f.Place(ctx); result != nil {
		t.Errorf("Place() = %+v, want nil (max_empty_corners=0 in an all-air volume)", result)
	}
	if len(tracer.Draws) != 5 {
		t.Errorf("len(Draws) = %d, want 5 -- this abort happens AFTER all five draws, see fossil.go's header", len(tracer.Draws))
	}
	if len(failures) != 1 || !strings.Contains(failures[0], "empty corners") {
		t.Errorf("failures = %v, want one mentioning empty corners", failures)
	}
}

// ---------------------------------------------------------------------------
// End-to-end placement sanity.
// ---------------------------------------------------------------------------

func TestFossilFeature_PlacesBoneAndOre(t *testing.T) {
	v, pal, origin := newFossilTestVolume()
	f := buildTestFossilFeature(t, pal, allEightFossilStructures(), nil)

	tracer := random.NewTracer(random.New(2024))
	ctx := &wgen.PlacementContext{API: v, Origin: origin, Random: tracer, MolangScope: wgen.NewScope()}
	result := f.Place(ctx)
	if result == nil {
		t.Fatal("Place() = nil, want a position")
	}

	boneCount, oreCount := 0, 0
	for x := -20; x < 20; x++ {
		for y := 40; y < 100; y++ {
			for z := -20; z < 20; z++ {
				id := v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z})
				name := pal.NameOf(id)
				if name == "minecraft:bone_block" {
					boneCount++
				}
				if id == f.oreBlock {
					oreCount++
				}
			}
		}
	}
	if boneCount == 0 {
		t.Error("0 bone_block placed")
	}
	if oreCount == 0 {
		t.Error("0 ore placed")
	}
	t.Logf("placed bone=%d ore=%d at result=%+v", boneCount, oreCount, *result)
}

// ---------------------------------------------------------------------------
// Real vanilla data -- see fossil.go's header. Skips cleanly, via t.Skipf, when the vanilla
// structure files aren't available locally, rather than failing the build or (worse) silently
// not running anywhere.
// ---------------------------------------------------------------------------

// fossilRealStructuresDir is a directory of vanilla fossil .nbt files, which this
// repository does not vendor -- they are Mojang's. Point
// FEATURELAB_FOSSIL_STRUCTURES at an extracted
// behavior_packs/vanilla/structures/fossils to run these; unset, they skip.
var fossilRealStructuresDir = os.Getenv("FEATURELAB_FOSSIL_STRUCTURES")

func realFossilLegacyLibrary(t *testing.T, pal *block.Palette) structures.ILegacyResolver {
	t.Helper()
	if info, err := os.Stat(fossilRealStructuresDir); err != nil || !info.IsDir() {
		t.Skipf("pack not available at %s: %v", fossilRealStructuresDir, err)
	}
	var files []structures.SourceFile
	for _, name := range realFossilFileBaseNames {
		abs := fossilRealStructuresDir + `\` + name + ".nbt"
		data, err := os.ReadFile(abs)
		if err != nil {
			t.Fatalf("ReadFile(%s): %v", abs, err)
		}
		// ID mirrors pack.Load's own walkBinary convention: path relative to the structures/
		// root, POSIX separators, extension included -- "fossils/fossil_spine_01.nbt".
		files = append(files, structures.SourceFile{ID: "fossils/" + name + ".nbt", AbsPath: abs, Data: data})
	}
	lib := structures.BuildLibrary(files, pal)
	if len(lib.Diagnostics) != 0 {
		t.Fatalf("structures.BuildLibrary diagnostics on the real vanilla files: %+v", lib.Diagnostics)
	}
	return lib
}

var realFossilFileBaseNames = []string{
	"fossil_spine_01", "fossil_spine_02", "fossil_spine_03", "fossil_spine_04",
	"fossil_skull_01", "fossil_skull_02", "fossil_skull_03", "fossil_skull_04",
}

// TestFossilFeature_RealVanillaStructures builds a FossilFeature against the real eight vanilla
// legacy structures (parsed via nbt/legacy.go, resolved via structures/legacy.go, exactly the path
// a real pack pointed at a vanilla behaviour pack's structures/ directory would take -- see
// fossil.go's header, "STRUCTURE SOURCING") and places it repeatedly, checking every placement
// picks a real structure, places a plausible block count, and that bone/ore counts are consistent
// with the two-pass integrity contract.
func TestFossilFeature_RealVanillaStructures(t *testing.T) {
	pal := block.NewPalette()
	lib := realFossilLegacyLibrary(t, pal)
	f := buildTestFossilFeature(t, pal, lib, nil)

	for _, name := range fossilStructureNames {
		if f.structures[indexOfFossilName(name)] == nil {
			t.Fatalf("structure %q did not resolve", name)
		}
	}

	newFloorVolume := func() (*volume.Volume, wgen.BlockPos) {
		v := volume.New(volume.Bounds{MinX: -20, MinY: 40, MinZ: -20, SizeX: 40, SizeY: 60, SizeZ: 40}, pal, block.AirID)
		for x := -20; x < 20; x++ {
			for z := -20; z < 20; z++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: 63, Z: z}, pal.Get("minecraft:stone", nil))
			}
		}
		return v, wgen.BlockPos{X: 0, Y: 70, Z: 0}
	}

	seenStructures := make(map[int]bool)
	for seed := uint32(1); seed <= 40; seed++ {
		v, origin := newFloorVolume()
		tracer := random.NewTracer(random.New(seed))
		ctx := &wgen.PlacementContext{API: v, Origin: origin, Random: tracer, MolangScope: wgen.NewScope()}
		result := f.Place(ctx)
		if result == nil {
			continue // corner check can legitimately refuse -- not every seed places
		}
		if len(tracer.Draws) != 5 {
			t.Errorf("seed %d: len(Draws) = %d, want 5", seed, len(tracer.Draws))
		}
		idx := int(tracer.Draws[1].Value)
		seenStructures[idx] = true
	}
	if len(seenStructures) < 4 {
		t.Errorf("only %d distinct structures were ever selected across 40 seeds -- nextInt(8) selection looks broken", len(seenStructures))
	}

	// One concrete, logged placement with block counts and an ASCII cross-section, at a fixed
	// seed for reproducibility.
	v, origin := newFloorVolume()
	tracer := random.NewTracer(random.New(2024))
	ctx := &wgen.PlacementContext{API: v, Origin: origin, Random: tracer, MolangScope: wgen.NewScope()}
	result := f.Place(ctx)
	if result == nil {
		t.Fatal("Place() at seed 2024 returned nil -- pick a different fixed seed if this ever legitimately refuses")
	}
	idx := int(tracer.Draws[1].Value)
	rotation := int(tracer.Draws[0].Value)
	t.Logf("real-data placement: seed=2024 structure=%s rotation=%d result=%+v draws=%d",
		fossilStructureNames[idx], rotation, *result, len(tracer.Draws))

	boneCount, oreCount := 0, 0
	minX, maxX, minY, maxY, minZ, maxZ := 1<<30, -(1 << 30), 1<<30, -(1 << 30), 1<<30, -(1 << 30)
	for x := -20; x < 20; x++ {
		for y := 40; y < 100; y++ {
			for z := -20; z < 20; z++ {
				id := v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z})
				name := pal.NameOf(id)
				if name == "minecraft:bone_block" {
					boneCount++
					minX, maxX = min(minX, x), max(maxX, x)
					minY, maxY = min(minY, y), max(maxY, y)
					minZ, maxZ = min(minZ, z), max(maxZ, z)
				}
				if id == f.oreBlock {
					oreCount++
					minX, maxX = min(minX, x), max(maxX, x)
					minY, maxY = min(minY, y), max(maxY, y)
					minZ, maxZ = min(minZ, z), max(maxZ, z)
				}
			}
		}
	}
	t.Logf("bone=%d ore=%d bounds x[%d,%d] y[%d,%d] z[%d,%d]", boneCount, oreCount, minX, maxX, minY, maxY, minZ, maxZ)
	if boneCount == 0 {
		t.Fatal("0 bone_block placed against real vanilla data")
	}

	// ASCII cross-section at the result's own Y (a horizontal slice through the placement) --
	// '#' = bone_block, 'O' = ore, '.' = anything else.
	var sb strings.Builder
	sb.WriteString("cross-section at Y=" + strconv.Itoa(result.Y) + ":\n")
	for z := minZ; z <= maxZ; z++ {
		for x := minX; x <= maxX; x++ {
			id := v.GetBlock(wgen.BlockPos{X: x, Y: result.Y, Z: z})
			switch {
			case id == f.oreBlock:
				sb.WriteByte('O')
			case pal.NameOf(id) == "minecraft:bone_block":
				sb.WriteByte('#')
			default:
				sb.WriteByte('.')
			}
		}
		sb.WriteByte('\n')
	}
	t.Log(sb.String())
}

func indexOfFossilName(name string) int {
	for i, n := range fossilStructureNames {
		if n == name {
			return i
		}
	}
	return -1
}

// ---------------------------------------------------------------------------
// The port's own third failure path -- "No blocks could be placed". See fossil.go's header,
// "A THIRD FAILURE PATH, ADDED BY THIS PORT": the game has no equivalent
// (it never inspects its structure placement's result and its clip test is disabled), so
// this is a DISCLOSED
// bench deviation, not game behaviour. These tests pin where it fires and that its message names
// the cause, so it cannot quietly go back to being an unexplained "No blocks could be placed".
// ---------------------------------------------------------------------------

// fossilShallowPlacement runs one placement in a solid-stone area of the given height and width, with
// the corner check disabled (max_empty_corners 8) so the geometry -- not the corner test -- is
// what decides. Returns whether it succeeded and the failure message if it did not.
func fossilShallowPlacement(t *testing.T, seed uint32, height, width int) (bool, string) {
	t.Helper()
	pal := block.NewPalette()
	half := width / 2
	const minY = 0
	v := volume.New(volume.Bounds{MinX: -half, MinY: minY, MinZ: -half, SizeX: width, SizeY: height, SizeZ: width}, pal, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	top := minY + height - 2
	for x := -half; x < width-half; x++ {
		for z := -half; z < width-half; z++ {
			for y := minY; y <= top; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	f := buildTestFossilFeature(t, pal, allEightFossilStructures(), nil)
	var msgs []string
	ctx := &wgen.PlacementContext{
		API: v, Origin: wgen.BlockPos{X: 0, Y: top + 1, Z: 0},
		Random: random.New(seed), MolangScope: wgen.NewScope(),
		LogFailure: func(featureType, message string, pos wgen.BlockPos) { msgs = append(msgs, message) },
	}
	if f.Place(ctx) != nil {
		return true, ""
	}
	if len(msgs) == 0 {
		t.Fatalf("failed placement logged nothing")
	}
	return false, msgs[0]
}

// TestFossilFeature_ShallowAreaCannotHoldAFossil pins the exact threshold the anchor clamp
// produces: y is never lower than MinY()+10, so an area 10 blocks tall has nowhere to put a
// fossil at all and one 11 blocks tall always does. 30 seeds each side -- this is not an edge
// case, it is every seed.
func TestFossilFeature_ShallowAreaCannotHoldAFossil(t *testing.T) {
	failed := 0
	for seed := uint32(0); seed < 30; seed++ {
		ok, msg := fossilShallowPlacement(t, seed, 10, 40)
		if ok {
			t.Fatalf("seed %d placed a fossil in a 10-block-tall area", seed)
		}
		if !strings.Contains(msg, "No blocks could be placed") {
			t.Fatalf("seed %d failed with %q, want the port's own no-blocks-placed path", seed, msg)
		}
		// The diagnostic must name the cause, not just the symptom.
		for _, want := range []string{"fell outside the generated area", "min_y+10", "10 blocks tall or less"} {
			if !strings.Contains(msg, want) {
				t.Fatalf("failure message does not name the cause (missing %q): %q", want, msg)
			}
		}
		failed++
	}
	if failed != 30 {
		t.Fatalf("failed = %d, want 30", failed)
	}
	for seed := uint32(0); seed < 30; seed++ {
		if ok, msg := fossilShallowPlacement(t, seed, 11, 40); !ok {
			t.Fatalf("seed %d failed in an 11-block-tall area: %q -- the threshold is MinY()+10, not higher", seed, msg)
		}
	}
}

// TestFossilFeature_NarrowAreaLosesSomePlacements pins the other half of the same geometry: offX
// and offZ are nextInt(16 - rotatedSize) measured FROM THE ORIGIN, so with a centred origin a
// narrow area loses placements off its east/south edge while a 32-wide one loses none.
func TestFossilFeature_NarrowAreaLosesSomePlacements(t *testing.T) {
	count := func(width int) int {
		lost := 0
		for seed := uint32(0); seed < 30; seed++ {
			if ok, _ := fossilShallowPlacement(t, seed, 60, width); !ok {
				lost++
			}
		}
		return lost
	}
	if lost := count(32); lost != 0 {
		t.Fatalf("32-wide area lost %d of 30 placements, want 0", lost)
	}
	if lost := count(16); lost == 0 {
		t.Fatal("16-wide area lost nothing -- the x/z offset is supposed to reach 15 blocks past the origin")
	}
}

// TestFossilFeature_NoBlocksPlacedCostsNoExtraDraws pins that the port's own failure path is
// draw-neutral: all five world-gen draws have already happened when it fires, so a downstream
// feature in the same chunk sees the same stream whether the fossil landed or not.
func TestFossilFeature_NoBlocksPlacedCostsNoExtraDraws(t *testing.T) {
	pal := block.NewPalette()
	v := volume.New(volume.Bounds{MinX: -20, MinY: 0, MinZ: -20, SizeX: 40, SizeY: 10, SizeZ: 40}, pal, block.AirID)
	stone := pal.Get("minecraft:stone", nil)
	for x := -20; x < 20; x++ {
		for z := -20; z < 20; z++ {
			for y := 0; y <= 8; y++ {
				v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, stone)
			}
		}
	}
	f := buildTestFossilFeature(t, pal, allEightFossilStructures(), nil)
	tracer := random.NewTracer(random.New(11))
	ctx := &wgen.PlacementContext{
		API: v, Origin: wgen.BlockPos{X: 0, Y: 9, Z: 0}, Random: tracer, MolangScope: wgen.NewScope(),
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {},
	}
	if f.Place(ctx) != nil {
		t.Fatal("expected the no-blocks-placed path")
	}
	if len(tracer.Draws) != 5 {
		t.Fatalf("draws = %d (%v), want exactly the same five", len(tracer.Draws), tracer.Draws)
	}
}
