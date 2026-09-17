// geode_test.go exercises GeodeFeature's RNG draw sequence explicitly (the
// exact method/order/count contract documented in geode.go's header), not
// just final block counts -- there is no golden-dump differential coverage
// for this type, so these tests are the only thing standing between a wrong
// implementation and a caller relying on this type. See geode.go's header
// for the behaviour these tests check against.
package features

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/noise"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// ---------------------------------------------------------------------------
// geodeTestRecorder -- a local, self-contained recorder implementing
// geodeRandom (IRandom + NextUint32), deliberately NOT reusing
// featurelab-go/random.Tracer (which does not expose NextUint32 -- see
// geode.go header's "Random-surface widening"). Mirrors noise package's own
// test recorder shape.
// ---------------------------------------------------------------------------

type geodeTestRecorder struct {
	inner *random.Rand
	draws []string
}

func newGeodeTestRecorder(seed uint32) *geodeTestRecorder {
	return &geodeTestRecorder{inner: random.New(seed)}
}

func (r *geodeTestRecorder) NextInt() int32 {
	r.draws = append(r.draws, "NextInt")
	return r.inner.NextInt()
}

func (r *geodeTestRecorder) NextIntBound(bound int) int {
	v := r.inner.NextIntBound(bound)
	if bound != 0 { // matches random.Tracer's own bound-0 non-draw exclusion
		r.draws = append(r.draws, fmt.Sprintf("NextIntBound(%d)", bound))
	}
	return v
}

func (r *geodeTestRecorder) NextFloat() float64 {
	r.draws = append(r.draws, "NextFloat")
	return r.inner.NextFloat()
}

func (r *geodeTestRecorder) NextDouble() float64 {
	r.draws = append(r.draws, "NextDouble")
	return r.inner.NextDouble()
}

func (r *geodeTestRecorder) NextBoolean() bool {
	r.draws = append(r.draws, "NextBoolean")
	return r.inner.NextBoolean()
}

func (r *geodeTestRecorder) NextUnsignedInt(bound uint32) uint32 {
	r.draws = append(r.draws, "NextUnsignedInt")
	return r.inner.NextUnsignedInt(bound)
}

func (r *geodeTestRecorder) NextUint32() uint32 {
	r.draws = append(r.draws, "NextUint32")
	return r.inner.NextUint32()
}

func (r *geodeTestRecorder) SetSeed(seed uint32) { r.inner.SetSeed(seed) }
func (r *geodeTestRecorder) GetSeed() uint32     { return r.inner.GetSeed() }

var _ geodeRandom = (*geodeTestRecorder)(nil)

// ---------------------------------------------------------------------------
// geodeIntRange -- pinned against the game's two-argument integer draw
// shape (0 draws iff max<=min, else exactly one NextIntBound(max-min)),
// deliberately NOT tree.go's treeIntRangeValue shape -- see geode.go header.
// ---------------------------------------------------------------------------

func TestGeodeIntRange_NoDrawWhenMaxLessEqualMin(t *testing.T) {
	for _, tc := range []struct{ min, max int }{{5, 5}, {5, 4}, {0, 0}, {-3, -3}} {
		rec := newGeodeTestRecorder(1)
		got := geodeIntRange(tc.min, tc.max, rec)
		if got != tc.min {
			t.Errorf("min=%d max=%d: got %d, want %d", tc.min, tc.max, got, tc.min)
		}
		if len(rec.draws) != 0 {
			t.Errorf("min=%d max=%d: draws=%v, want none", tc.min, tc.max, rec.draws)
		}
	}
}

// TestGeodeIntRange_DrawsEvenForDegenerateOneWideRange is the exact case
// that distinguishes this shape from tree.go's treeIntRangeValue: max-min==1
// still draws (an always-0 NextIntBound(1)), where the game's int-range draw
// would skip the draw entirely.
func TestGeodeIntRange_DrawsEvenForDegenerateOneWideRange(t *testing.T) {
	rec := newGeodeTestRecorder(1)
	got := geodeIntRange(5, 6, rec)
	if got != 5 {
		t.Errorf("got %d, want 5 (NextIntBound(1) is always 0)", got)
	}
	if len(rec.draws) != 1 || rec.draws[0] != "NextIntBound(1)" {
		t.Errorf("draws=%v, want exactly [NextIntBound(1)]", rec.draws)
	}
}

func TestGeodeIntRange_DrawsNextIntBoundOfSpan(t *testing.T) {
	rec := newGeodeTestRecorder(7)
	got := geodeIntRange(3, 9, rec)
	if got < 3 || got > 8 {
		t.Errorf("got %d, want in [3,8]", got)
	}
	if len(rec.draws) != 1 || rec.draws[0] != "NextIntBound(6)" {
		t.Errorf("draws=%v, want exactly [NextIntBound(6)]", rec.draws)
	}
}

// ---------------------------------------------------------------------------
// Feature-level tests.
// ---------------------------------------------------------------------------

func geodeMinimalBody(extra map[string]any) map[string]any {
	body := map[string]any{
		"filler":                "minecraft:air",
		"inner_layer":           "minecraft:diamond_block",
		"alternate_inner_layer": "minecraft:emerald_block",
		"middle_layer":          "minecraft:calcite",
		"outer_layer":           "minecraft:obsidian",
		"inner_placements": []any{
			map[string]any{"name": "minecraft:amethyst_cluster", "states": map[string]any{"amethyst_cluster_type": "small"}},
		},
		"min_outer_wall_distance":             float64(4),
		"max_outer_wall_distance":             float64(7),
		"min_distribution_points":             float64(3),
		"max_distribution_points":             float64(5),
		"min_point_offset":                    float64(1),
		"max_point_offset":                    float64(3),
		"max_radius":                          float64(6),
		"crack_point_offset":                  float64(2),
		"generate_crack_chance":               float64(0.95),
		"base_crack_size":                     float64(2),
		"noise_multiplier":                    float64(0.025),
		"use_potential_placements_chance":     float64(0.35),
		"use_alternate_layer0_chance":         float64(0.5),
		"placements_require_layer0_alternate": true,
		"invalid_blocks_threshold":            float64(3),
	}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

func buildTestGeode(t *testing.T, pal *block.Palette, extra map[string]any) *GeodeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:geode", FileID: "test:geode", Warn: func(string) {}}
	f, err := buildGeodeFeature(geodeMinimalBody(extra), ctx)
	if err != nil {
		t.Fatalf("buildGeodeFeature: %v", err)
	}
	gf, ok := f.(*GeodeFeature)
	if !ok {
		t.Fatalf("builder returned %T, want *GeodeFeature", f)
	}
	return gf
}

func TestGeodeFeature_SchemaValidation(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:geode", FileID: "test:geode", Warn: func(string) {}}

	t.Run("valid body builds", func(t *testing.T) {
		if _, err := buildGeodeFeature(geodeMinimalBody(nil), ctx); err != nil {
			t.Errorf("want success, got %v", err)
		}
	})
	t.Run("filler required", func(t *testing.T) {
		b := geodeMinimalBody(nil)
		delete(b, "filler")
		if _, err := buildGeodeFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("inner_placements optional", func(t *testing.T) {
		b := geodeMinimalBody(nil)
		delete(b, "inner_placements")
		if _, err := buildGeodeFeature(b, ctx); err != nil {
			t.Errorf("want success (inner_placements optional), got %v", err)
		}
	})
	t.Run("min_outer_wall_distance out of range", func(t *testing.T) {
		b := geodeMinimalBody(map[string]any{"min_outer_wall_distance": float64(0)}) // the game's own bound [1,10]
		if _, err := buildGeodeFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("max_distribution_points out of range", func(t *testing.T) {
		b := geodeMinimalBody(map[string]any{"max_distribution_points": float64(21)}) // the game's own bound [1,20]
		if _, err := buildGeodeFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("generate_crack_chance out of range", func(t *testing.T) {
		b := geodeMinimalBody(map[string]any{"generate_crack_chance": float64(1.5)})
		if _, err := buildGeodeFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("placements_require_layer0_alternate must be bool", func(t *testing.T) {
		b := geodeMinimalBody(map[string]any{"placements_require_layer0_alternate": "yes"})
		if _, err := buildGeodeFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
	t.Run("invalid_blocks_threshold required", func(t *testing.T) {
		b := geodeMinimalBody(nil)
		delete(b, "invalid_blocks_threshold")
		if _, err := buildGeodeFeature(b, ctx); err == nil {
			t.Error("want error, got nil")
		}
	})
}

func newGeodeTestVolume(radius int) (*volume.Volume, *block.Palette, wgen.BlockPos) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	r := radius + 4
	bounds := volume.Bounds{MinX: -r, MinY: 40, MinZ: -r, SizeX: 2*r + 1, SizeY: 40, SizeZ: 2*r + 1}
	v := volume.New(bounds, pal, stone)
	origin := wgen.BlockPos{X: 0, Y: 60, Z: 0}
	return v, pal, origin
}

func placeTestGeode(f *GeodeFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) *wgen.BlockPos {
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}
	return f.Place(ctx)
}

// TestGeodeFeature_RNGDrawSequence_MinimalConfig pins the EXACT draw
// sequence for the smallest possible geode: pointCount forced to exactly 1
// (min==max), wall-distance and point-offset draws suppressed (min==max),
// noise_multiplier=0 (removes the noise sample from the density formula
// entirely, so density is a pure, hand-computable function of the fixed
// point/position geometry), max_radius=0 so exactly ONE position (origin
// itself) is evaluated. With wall distance fixed at 2, the one distribution
// point sits at origin+(2,2,2); density at origin works out to
// 1/sqrt(12)=0.2887, which is below tC4 (1/sqrt(0.5+4.2)=0.4613 for
// pointCount=1, max_outer_wall_distance=2) -- the "outside the geode
// entirely" case, which places nothing and draws nothing further. This
// isolates the sequence down to exactly: 2608 raw NextUint32 draws
// (NormalNoise construction, see noise/normal_noise.go), then radiusJitter
// (NextFloat), then crackRoll (NextFloat), then -- gated on crackRoll<0.95,
// which is seed-dependent, so checked structurally rather than assumed --
// at most one NextIntBound(4) crack-branch selector draw.
func TestGeodeFeature_RNGDrawSequence_MinimalConfig(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:geode", FileID: "test:geode", Warn: func(string) {}}
	body := geodeMinimalBody(map[string]any{
		"min_distribution_points": float64(1),
		"max_distribution_points": float64(1),
		"min_outer_wall_distance": float64(2),
		"max_outer_wall_distance": float64(2),
		"min_point_offset":        float64(0),
		"max_point_offset":        float64(0),
		"max_radius":              float64(0),
		"noise_multiplier":        float64(0),
	})
	f, err := buildGeodeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildGeodeFeature: %v", err)
	}
	gf := f.(*GeodeFeature)

	v, _, origin := newGeodeTestVolume(0)
	rec := newGeodeTestRecorder(1)
	got := placeTestGeode(gf, v, origin, rec)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (the single evaluated position's density is below tC4 -- outside the geode)", got)
	}

	const noiseDraws = 2608
	if len(rec.draws) < noiseDraws+2 {
		t.Fatalf("draws = %d, want at least %d (2608 noise + radiusJitter + crackRoll)", len(rec.draws), noiseDraws+2)
	}
	// The first 2608 draws are the NormalNoise construction -- a MIX of
	// NextDouble/NextIntBound (method-shaped) and raw NextUint32
	// (consumeCount skips), already precisely pinned method-by-method by
	// noise/normal_noise_test.go's own TestDrawSequence_GeodeShapedConfig;
	// this test only checks that none of them are NextFloat (which would
	// mean a geode-level draw leaked into the middle of noise construction).
	for i := 0; i < noiseDraws; i++ {
		if rec.draws[i] == "NextFloat" {
			t.Fatalf("draw[%d] = NextFloat, want a noise-construction draw (NextDouble/NextIntBound/NextUint32) -- "+
				"a geode-level float draw leaked into the middle of NormalNoise construction", i)
		}
	}
	if rec.draws[noiseDraws] != "NextFloat" {
		t.Fatalf("draw[%d] = %q, want NextFloat (radiusJitter)", noiseDraws, rec.draws[noiseDraws])
	}
	if rec.draws[noiseDraws+1] != "NextFloat" {
		t.Fatalf("draw[%d] = %q, want NextFloat (crackRoll)", noiseDraws+1, rec.draws[noiseDraws+1])
	}
	rest := rec.draws[noiseDraws+2:]
	switch len(rest) {
	case 0:
		// crackRoll >= 0.95 for this seed: no further draws.
	case 1:
		if rest[0] != "NextIntBound(4)" {
			t.Fatalf("trailing draw = %q, want NextIntBound(4) (crack-branch selector)", rest[0])
		}
	default:
		t.Fatalf("unexpected trailing draws after crackRoll: %v (want at most one NextIntBound(4))", rest)
	}
}

// TestGeodeFeature_AllFiveShellsPlace proves the resolved classification
// cascade actually reaches every branch, not just filler: with a
// sufficiently large max_radius, every one of filler/inner_layer/
// middle_layer/outer_layer must appear somewhere in the placed volume (this
// port's filler is "minecraft:air" here so it is instead checked via the
// *absence* of stone where the original all-stone volume must have been
// carved -- everything else is checked by exact block name).
func TestGeodeFeature_AllFiveShellsPlace(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(10)
	// volume.New leaves the interior at its zero value (air), regardless of
	// the oobBlock argument (that only governs out-of-bounds reads -- see
	// volume.go's own doc comment) -- so filler is overridden to a
	// non-air block here, otherwise "air appeared somewhere" would be true
	// trivially from the untouched background, proving nothing about
	// whether filler was actually PLACED.
	f := buildTestGeode(t, pal, map[string]any{
		"max_radius": float64(9),
		"filler":     "minecraft:tuff",
	})

	rnd := random.New(42)
	got := placeTestGeode(f, v, origin, rnd)
	if got == nil {
		t.Fatal("Place() = nil, want success")
	}

	seen := map[string]bool{}
	r := 12
	for x := -r; x <= r; x++ {
		for y := -r; y <= r; y++ {
			for z := -r; z <= r; z++ {
				pos := wgen.BlockPos{X: origin.X + x, Y: origin.Y + y, Z: origin.Z + z}
				name := pal.NameOf(v.GetBlock(pos))
				seen[name] = true
			}
		}
	}

	for _, want := range []string{
		"minecraft:tuff",          // filler
		"minecraft:diamond_block", // inner_layer
		"minecraft:calcite",       // middle_layer
		"minecraft:obsidian",      // outer_layer
	} {
		if !seen[want] {
			t.Errorf("block %q never appeared in the placed volume -- shell classification is not reaching every branch", want)
		}
	}
}

// TestGeodeFeature_InvalidBlocksThresholdAborts proves the abort path. The
// volume's bounds are deliberately smaller than min_outer_wall_distance, so
// EVERY distribution point's offset lands out of bounds, reading back
// GetBlock's oobBlock (bedrock, a geodeInvalidMaterials entry) -- see
// volume.go's own doc comment: only out-of-bounds reads return oobBlock, the
// interior defaults to air regardless of it, which is why this test can't
// just fill a normal-sized volume with bedrock via the constructor alone.
// With invalid_blocks_threshold=0, the first invalid point must abort the
// whole geode before anything is placed.
func TestGeodeFeature_InvalidBlocksThresholdAborts(t *testing.T) {
	pal := block.NewPalette()
	bedrock := pal.Get("minecraft:bedrock", nil)
	bounds := volume.Bounds{MinX: -2, MinY: 58, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, bedrock)
	origin := wgen.BlockPos{X: 0, Y: 60, Z: 0}

	f := buildTestGeode(t, pal, map[string]any{
		"invalid_blocks_threshold": float64(0),
		"min_distribution_points":  float64(3),
		"max_distribution_points":  float64(3),
		// default min/max_outer_wall_distance (4,7) guarantees every point
		// offset lands outside the tiny 5-wide bounds above.
	})
	rnd := random.New(1)
	got := placeTestGeode(f, v, origin, rnd)
	if got != nil {
		t.Fatalf("Place() = %+v, want nil (every distribution point offset lands out of bounds, reading back invalid bedrock, threshold 0)", got)
	}
}

// ---------------------------------------------------------------------------
// Diagnostics -- a disclosed gap must be VISIBLE at placement time, not just
// documented in a comment: "featurelab types" is not enough, nobody runs it
// while iterating on a feature file.
// ---------------------------------------------------------------------------

// geodeWarning is one captured ctx.LogWarning call.
type geodeWarning struct {
	message string
	pos     *wgen.BlockPos
}

// placeTestGeodeCapturingWarnings is placeTestGeode plus a LogWarning capture
// -- a separate helper (not a placeTestGeode signature change) so every
// existing caller of placeTestGeode is untouched.
func placeTestGeodeCapturingWarnings(f *GeodeFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) (*wgen.BlockPos, []geodeWarning) {
	var warnings []geodeWarning
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogWarning: func(featureType, message string, pos *wgen.BlockPos) {
			warnings = append(warnings, geodeWarning{message: message, pos: pos})
		},
	}
	return f.Place(ctx), warnings
}

// TestGeodeFeature_CrackChanceWarning_Retired proves the OLD "crack-line geometry not
// implemented" diagnostic no longer fires, for ANY generate_crack_chance value -- crack
// geometry is implemented (see geode.go header, "CRACK-LINE GEOMETRY"), so nothing should tell
// a user cracks don't render. One test, not two, since there is exactly one expected behavior
// (silence) regardless of the field's value.
func TestGeodeFeature_CrackChanceWarning_Retired(t *testing.T) {
	for _, crackChance := range []float64{0, 0.95, 1} {
		v, pal, origin := newGeodeTestVolume(9)
		f := buildTestGeode(t, pal, map[string]any{
			"max_radius":            float64(9),
			"generate_crack_chance": crackChance,
		})
		rnd := random.New(42)
		_, warnings := placeTestGeodeCapturingWarnings(f, v, origin, rnd)
		for _, w := range warnings {
			if strings.Contains(w.message, "crack") {
				t.Errorf("generate_crack_chance=%v: unexpected crack warning (crack geometry is implemented): %q", crackChance, w.message)
			}
		}
	}
}

// residualComponentWarnings filters warnings down to the residual data-driven-component
// disclosure (geode.go header, "Residual", vanillaAmethystClusterBlockNames) -- shared by the
// three tests below. Narrowed to the multi-block component alone (not the placement filter,
// which is an evaluated check) -- see TestGeodeFeature_InnerPlacementsWarning_FiresOnceForNonVanillaConfig's own
// doc comment.
func residualComponentWarnings(warnings []geodeWarning) []geodeWarning {
	var out []geodeWarning
	for _, w := range warnings {
		if strings.Contains(w.message, "may legally carry") {
			out = append(out, w)
		}
	}
	return out
}

// TestGeodeFeature_InnerPlacementsWarning_SilentForVanillaConfig: geodeMinimalBody's default
// inner_placements entry (minecraft:amethyst_cluster) IS one of the four vanilla
// amethyst-cluster-registered ids, so the residual data-driven-component warning must NEVER
// fire for it -- seed 42, radius 9 is known (see
// TestGeodeFeature_InnerPlacements_DerivesFacingDirectionState/AllFiveShellsPlace) to place dozens
// of clusters via this exact config, so this is a real test of "never," not "didn't happen to
// trigger." A warning on every placement regardless of vanilla-ness would fire on vanilla content
// it cannot apply to, training users to ignore it; see geode.go's header for the full rationale.
func TestGeodeFeature_InnerPlacementsWarning_SilentForVanillaConfig(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	f := buildTestGeode(t, pal, map[string]any{"max_radius": float64(9)}) // default inner_placements: minecraft:amethyst_cluster
	rnd := random.New(42)
	_, warnings := placeTestGeodeCapturingWarnings(f, v, origin, rnd)

	if got := residualComponentWarnings(warnings); len(got) != 0 {
		t.Errorf("got %d residual component-gap warning(s) for an all-vanilla inner_placements config, want 0: %+v", len(got), got)
	}
	// An "approximated as always-true" claim must NOT appear anywhere -- the anchor check is
	// evaluated, not approximated.
	for _, w := range warnings {
		if strings.Contains(w.message, "approximated as always-true") {
			t.Errorf("unexpected always-true-approximation wording (the anchor check is evaluated): %q", w.message)
		}
	}
}

// TestGeodeFeature_InnerPlacementsWarning_FiresOnceForNonVanillaConfig: the SAME seed/radius
// (known to place 34 buds via the vanilla config above -- i.e. the drain loop's body runs dozens
// of times), but inner_placements names a block outside vanillaAmethystClusterBlockNames. The
// residual warning must fire EXACTLY ONCE (not once per placement -- LogWarning itself has no
// dedup, see shared.go), must name the offending block id in its message, and must NOT
// mention the placement filter -- that check is evaluated (block/tags.go's
// PlacementFilterAllows), not a disclosed gap; only the multi-block component remains unmodeled.
func TestGeodeFeature_InnerPlacementsWarning_FiresOnceForNonVanillaConfig(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	f := buildTestGeode(t, pal, map[string]any{
		"max_radius": float64(9),
		"inner_placements": []any{
			map[string]any{"name": "addonpack:custom_geode_bud"},
		},
	})
	rnd := random.New(42)
	_, warnings := placeTestGeodeCapturingWarnings(f, v, origin, rnd)

	got := residualComponentWarnings(warnings)
	if len(got) != 1 {
		t.Fatalf("got %d residual component-gap warning(s) for a non-vanilla inner_placements config, want exactly 1: %+v", len(got), got)
	}
	if !strings.Contains(got[0].message, "addonpack:custom_geode_bud") {
		t.Errorf("warning message = %q, want it to name the offending block id (addonpack:custom_geode_bud)", got[0].message)
	}
	// The warning must be about the ONE gap that is still real (a block may carry its own
	// placement rules this tool does not read) and must not read as though the attach/face checks
	// were also missing -- those are evaluated. Checked by what it promises rather than by which
	// game component it names, because naming one is what this message must not do.
	if !strings.Contains(got[0].message, "The four vanilla buds preview accurately") {
		t.Errorf("warning message = %q, must say the vanilla case IS accurate -- otherwise it reads "+
			"as a blanket disclaimer and an author cannot tell which half to trust", got[0].message)
	}
	if got[0].pos != nil {
		t.Errorf("warning pos = %+v, want nil -- this now describes the feature's CONFIGURATION (which inner_placements entry is unvouched-for), not one write location", got[0].pos)
	}
}

// TestGeodeFeature_InnerPlacementsWarning_SilentWhenAbsent: the SAME config/seed as the tests
// above, minus inner_placements, must never warn about the residual component gap -- the
// potential-placement drain's `if len(f.innerPlacements) > 0` gate is never entered.
func TestGeodeFeature_InnerPlacementsWarning_SilentWhenAbsent(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	body := geodeMinimalBody(map[string]any{"max_radius": float64(9)})
	delete(body, "inner_placements")
	ctx := &BuildContext{Palette: pal, Identifier: "test:geode", FileID: "test:geode", Warn: func(string) {}}
	built, err := buildGeodeFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildGeodeFeature: %v", err)
	}
	f := built.(*GeodeFeature)

	rnd := random.New(42)
	_, warnings := placeTestGeodeCapturingWarnings(f, v, origin, rnd)

	if got := residualComponentWarnings(warnings); len(got) != 0 {
		t.Errorf("got %d residual component-gap warning(s) with no inner_placements configured, want 0: %+v", len(got), got)
	}
}

// ---------------------------------------------------------------------------
// The placement-check anchor-support check (geode.go header, "BUD PLACEMENT").
// geodeMayPlace as a pure function, then integration proof that it is
// actually wired into Place()'s drain loop, then the no-new-draws proof.
// ---------------------------------------------------------------------------

// TestGeodeMayPlace_SolidAnchorAllowsPlacement pins the base case: a full-cube anchor (the
// overwhelmingly common case -- every vanilla layer0 block) makes the amethyst cluster block's
// placement check (and so geodeMayPlace) return true.
func TestGeodeMayPlace_SolidAnchorAllowsPlacement(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	pos := wgen.BlockPos{X: 5, Y: 5, Z: 5}
	api := &geodePickFaceTestAPI{pal: pal, air: stone, blocks: map[wgen.BlockPos]block.ID{
		pos: stone, // full-cube anchor
	}}
	if !geodeMayPlace(api, pos) {
		t.Error("want true -- anchor is a full cube (stone)")
	}
}

// TestGeodeMayPlace_AirAnchorRefusesPlacement pins the case the crack carve makes
// reachable: an anchor carved to air (the full-support test is false for air) refuses.
func TestGeodeMayPlace_AirAnchorRefusesPlacement(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	pos := wgen.BlockPos{X: 5, Y: 5, Z: 5}
	api := &geodePickFaceTestAPI{pal: pal, air: stone, blocks: map[wgen.BlockPos]block.ID{
		pos: block.AirID, // carved away
	}}
	if geodeMayPlace(api, pos) {
		t.Error("want false -- anchor is air (carved away), the placement check refuses on every face")
	}
}

// TestGeodeMayPlace_WaterAnchorRefusesPlacement pins the other divergence case: a config whose
// layer0 material resolves to a non-full-cube liquid.
func TestGeodeMayPlace_WaterAnchorRefusesPlacement(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	water := pal.Get("minecraft:water", nil)
	pos := wgen.BlockPos{X: 5, Y: 5, Z: 5}
	api := &geodePickFaceTestAPI{pal: pal, air: stone, blocks: map[wgen.BlockPos]block.ID{
		pos: water,
	}}
	if geodeMayPlace(api, pos) {
		t.Error("want false -- anchor is water (non-full-cube liquid), the placement check refuses on every face")
	}
}

// TestGeodeMayPlace_FaceIndependent proves the header's claim directly: geodeMayPlace's
// result does not depend on which face geodePickFace picked -- only pos itself, matching
// the amethyst cluster block's placement check, whose anchor computation always cancels back to
// the pre-face position in the geode's own calling shape.
func TestGeodeMayPlace_FaceIndependent(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	api := &geodePickFaceTestAPI{pal: pal, air: stone, blocks: map[wgen.BlockPos]block.ID{
		pos: stone,
	}}
	// geodeMayPlace takes no face parameter at all -- calling it repeatedly (as if from every one
	// of the six candidate faces) must always agree, since the game's check never
	// varies by face for this anchor.
	want := geodeMayPlace(api, pos)
	for i := 0; i < 6; i++ {
		if got := geodeMayPlace(api, pos); got != want {
			t.Fatalf("call %d: geodeMayPlace = %v, want %v (must not vary)", i, got, want)
		}
	}
}

// geodeVolumeContains scans a cube of the given radius around origin for a block by name --
// shared by the mayPlace integration tests below (and mirrors the identical inline loop
// TestGeodeFeature_AllFiveShellsPlace/_InnerPlacements_DerivesFacingDirectionState already use).
func geodeVolumeContains(v *volume.Volume, pal *block.Palette, origin wgen.BlockPos, r int, name string) bool {
	for x := -r; x <= r; x++ {
		for y := -r; y <= r; y++ {
			for z := -r; z <= r; z++ {
				pos := wgen.BlockPos{X: origin.X + x, Y: origin.Y + y, Z: origin.Z + z}
				if pal.NameOf(v.GetBlock(pos)) == name {
					return true
				}
			}
		}
	}
	return false
}

// TestGeodeFeature_MayPlace_SolidAnchorPlacesCluster is the integration half of "anchor solid ->
// cluster placed": geodeMinimalBody's default inner_layer/alternate_inner_layer (diamond_block/
// emerald_block, both full cubes -- KindSolid via block/kind.go's fallback) must let at least one
// amethyst_cluster actually place, at the same seed/radius already known (by
// TestGeodeFeature_InnerPlacements_DerivesFacingDirectionState) to reach the drain.
func TestGeodeFeature_MayPlace_SolidAnchorPlacesCluster(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	f := buildTestGeode(t, pal, map[string]any{"max_radius": float64(9)})
	rnd := random.New(42)
	if got := placeTestGeode(f, v, origin, rnd); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if !geodeVolumeContains(v, pal, origin, 12, "minecraft:amethyst_cluster") {
		t.Error("no amethyst_cluster placed with a solid (diamond_block/emerald_block) anchor -- want at least one")
	}
}

// TestGeodeFeature_MayPlace_NonSolidAnchorRefusesCluster is the integration half of "anchor
// absent/non-solid -> refused": the SAME seed/radius, but inner_layer AND alternate_inner_layer
// both resolve to minecraft:water (KindLiquid, not KindSolid) -- every layer0 cell's own anchor is
// therefore non-solid regardless of the useAlternate coin flip, so geodeMayPlace must refuse every
// single potential placement, and no amethyst_cluster may appear anywhere. geodePickFace's own
// neighbor scan is unaffected by this config change (it inspects pos's NEIGHBORS, whose
// classification does not depend on pos's own material), so this isolates the mayPlace check
// specifically, not a side effect of the face scan failing instead.
func TestGeodeFeature_MayPlace_NonSolidAnchorRefusesCluster(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	f := buildTestGeode(t, pal, map[string]any{
		"max_radius":            float64(9),
		"inner_layer":           "minecraft:water",
		"alternate_inner_layer": "minecraft:water",
	})
	rnd := random.New(42)
	if got := placeTestGeode(f, v, origin, rnd); got == nil {
		t.Fatal("Place() = nil, want success (the other shells still place)")
	}
	if geodeVolumeContains(v, pal, origin, 12, "minecraft:amethyst_cluster") {
		t.Error("amethyst_cluster placed despite a non-solid (water) layer0 anchor -- the placement check should have refused every face")
	}
}

// TestGeodeFeature_MayPlaceCheck_DoesNotAffectRNGDrawSequence is the RNG-neutrality proof:
// geodeMayPlace makes no Random calls (the game's placement check consumes no randomness
// either), so the
// exact same solid-anchor vs. non-solid-anchor configs that diverge in PLACED BLOCKS above
// (TestGeodeFeature_MayPlace_SolidAnchorPlacesCluster / _NonSolidAnchorRefusesCluster) must
// record byte-IDENTICAL RNG draw sequences -- the mayPlace check changes only whether a placement
// is accepted, strictly downstream of every draw.
func TestGeodeFeature_MayPlaceCheck_DoesNotAffectRNGDrawSequence(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	const radius = 9
	r4 := radius + 4
	bounds := volume.Bounds{MinX: -r4, MinY: 40, MinZ: -r4, SizeX: 2*r4 + 1, SizeY: 40, SizeZ: 2*r4 + 1}
	origin := wgen.BlockPos{X: 0, Y: 60, Z: 0}

	solid := buildTestGeode(t, pal, map[string]any{"max_radius": float64(radius)})
	nonSolid := buildTestGeode(t, pal, map[string]any{
		"max_radius":            float64(radius),
		"inner_layer":           "minecraft:water",
		"alternate_inner_layer": "minecraft:water",
	})

	draws := func(f *GeodeFeature) []string {
		v := volume.New(bounds, pal, stone)
		rec := newGeodeTestRecorder(42)
		if got := placeTestGeode(f, v, origin, rec); got == nil {
			t.Fatal("Place() = nil, want success")
		}
		return append([]string(nil), rec.draws...)
	}

	solidDraws := draws(solid)
	nonSolidDraws := draws(nonSolid)
	if len(solidDraws) != len(nonSolidDraws) {
		t.Fatalf("draw count differs: solid-anchor=%d, non-solid-anchor=%d -- the mayPlace check must not change the RNG draw sequence",
			len(solidDraws), len(nonSolidDraws))
	}
	for i := range solidDraws {
		if solidDraws[i] != nonSolidDraws[i] {
			t.Fatalf("draw[%d] differs: solid-anchor=%q, non-solid-anchor=%q -- the mayPlace check must not change the RNG draw sequence",
				i, solidDraws[i], nonSolidDraws[i])
		}
	}
}

// TestGeodeFeature_RandomWithoutNextUint32Panics documents the explicit,
// loud failure mode this port chooses over silently skipping the noise
// construction -- see geode.go header's "Random-surface widening".
func TestGeodeFeature_RandomWithoutNextUint32Panics(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(2)
	f := buildTestGeode(t, pal, nil)
	defer func() {
		if recover() == nil {
			t.Fatal("want panic (ctx.Random lacks NextUint32), got none")
		}
	}()
	placeTestGeode(f, v, origin, random.NewTracer(random.New(1)))
}

// ---------------------------------------------------------------------------
// Crack-line geometry (geode.go header, "CRACK-LINE GEOMETRY").
// ---------------------------------------------------------------------------

// TestGeodeCrackLinePoints_PinnedGeometry pins the exact per-branch geometry
// (geode.go header, "CRACK-LINE GEOMETRY"): three points at Y=origin.Y+7,
// +5, +1, with X and/or Z offset by span=(2*pointCount)|1 depending on which of the 4 branch
// values (0-3) the crack-branch selector draw returned.
func TestGeodeCrackLinePoints_PinnedGeometry(t *testing.T) {
	origin := wgen.BlockPos{X: 100, Y: 50, Z: -20}
	const pointCount = 3
	const span = 2*pointCount | 1 // 7

	cases := []struct {
		branch int
		want   []wgen.BlockPos
	}{
		{0, []wgen.BlockPos{ // X-axis offset only
			{X: origin.X + span, Y: origin.Y + 7, Z: origin.Z},
			{X: origin.X + span, Y: origin.Y + 5, Z: origin.Z},
			{X: origin.X + span, Y: origin.Y + 1, Z: origin.Z},
		}},
		{1, []wgen.BlockPos{ // Z-axis offset only
			{X: origin.X, Y: origin.Y + 7, Z: origin.Z + span},
			{X: origin.X, Y: origin.Y + 5, Z: origin.Z + span},
			{X: origin.X, Y: origin.Y + 1, Z: origin.Z + span},
		}},
		{2, []wgen.BlockPos{ // diagonal, both offset
			{X: origin.X + span, Y: origin.Y + 7, Z: origin.Z + span},
			{X: origin.X + span, Y: origin.Y + 5, Z: origin.Z + span},
			{X: origin.X + span, Y: origin.Y + 1, Z: origin.Z + span},
		}},
		{3, []wgen.BlockPos{ // no offset, straight up
			{X: origin.X, Y: origin.Y + 7, Z: origin.Z},
			{X: origin.X, Y: origin.Y + 5, Z: origin.Z},
			{X: origin.X, Y: origin.Y + 1, Z: origin.Z},
		}},
	}
	for _, tc := range cases {
		got := geodeCrackLinePoints(origin, pointCount, tc.branch)
		if len(got) != len(tc.want) {
			t.Fatalf("branch %d: got %d points, want %d: %+v", tc.branch, len(got), len(tc.want), got)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("branch %d point %d: got %+v, want %+v", tc.branch, i, got[i], tc.want[i])
			}
		}
	}
}

// TestGeodeCrackLinePoints_SpanFormula pins span=(2*pointCount)|1 directly, exactly as the game
// computes it -- see geode.go's header.
func TestGeodeCrackLinePoints_SpanFormula(t *testing.T) {
	origin := wgen.BlockPos{}
	for _, tc := range []struct{ pointCount, wantSpan int }{
		{1, 3}, {2, 5}, {3, 7}, {4, 9}, {5, 11}, {10, 21},
	} {
		got := geodeCrackLinePoints(origin, tc.pointCount, 0) // branch 0 offsets X only
		if len(got) != 3 || got[0].X != tc.wantSpan {
			t.Errorf("pointCount=%d: X offset = %d, want span %d (got %+v)", tc.pointCount, got[0].X, tc.wantSpan, got)
		}
	}
}

// TestGeodeCrackLinePoints_OutOfRangeBranchReturnsNil documents that the game has no
// fifth case -- any branch value outside [0,3] (impossible from a real NextIntBound(4) draw, but
// defensive) returns no points rather than guessing a shape.
func TestGeodeCrackLinePoints_OutOfRangeBranchReturnsNil(t *testing.T) {
	for _, branch := range []int{-1, 4, 99} {
		if got := geodeCrackLinePoints(wgen.BlockPos{}, 3, branch); got != nil {
			t.Errorf("branch %d: got %+v, want nil", branch, got)
		}
	}
}

// geodeForcedBranchRecorder wraps geodeTestRecorder and forces the ONE NextIntBound(4) call --
// step 5's crack-branch selector, the only bound-4 draw this file makes -- to a caller-chosen
// value, without consuming the underlying stream for it (so the branch is deterministic without
// needing to hand-search for a seed that happens to draw each of the 4 values). This lets the
// SAME seed's geometry be compared across all 4 branches -- see
// TestGeodeFeature_CrackLine_ForcedBranchesDivergeInGeometry.
type geodeForcedBranchRecorder struct {
	*geodeTestRecorder
	branch int
	forced bool
}

func (r *geodeForcedBranchRecorder) NextIntBound(bound int) int {
	// bound==4 alone is NOT a reliable signal: NormalNoise construction's own 2608-draw
	// sequence (noise/normal_noise.go) makes several NextIntBound calls with DESCENDING bounds
	// as part of its own octave math, and 4 is one of the values that sequence legitimately
	// passes through -- discovered by instrumenting this exact wrapper and observing it
	// intercept a mid-noise-construction draw instead of the crack selector. Gated on the
	// stream position instead: the crack selector is the FIRST bound==4 draw at or after index
	// 2610 (2608 noise + radiusJitter + crackRoll -- the same count
	// TestGeodeFeature_RNGDrawSequence_MinimalConfig already pins independently) -- ">=", not
	// "==", because step 4's own per-distribution-point draws (geodeIntRange calls, index 2610
	// onward, count = up to 4*pointCount) sit BEFORE the crack selector too; this test's config
	// deliberately keeps every step-4 span (wall distance, point offset) away from exactly 4 so
	// none of THOSE draws are mistaken for the selector either.
	const afterCrackRollDrawIndex = 2610
	if bound == 4 && !r.forced && len(r.draws) >= afterCrackRollDrawIndex {
		r.forced = true
		r.draws = append(r.draws, fmt.Sprintf("NextIntBound(%d)", bound))
		return r.branch
	}
	return r.geodeTestRecorder.NextIntBound(bound)
}

var _ geodeRandom = (*geodeForcedBranchRecorder)(nil)

// geodeFindSeedWithCrackRoll returns the smallest seed in [1,2000) for which step 3's crackRoll
// < 0.95 (crackRollOk) -- replaying ONLY steps 1-3 (pointCount forced to zero draws by the
// caller using min==max_distribution_points, then the unconditional 2608-draw NormalNoise
// construction, then radiusJitter, then crackRoll), exactly geode.go's own Place() sequence up
// to that point, WITHOUT invoking Place() at all.
func geodeFindSeedWithCrackRoll(t *testing.T) uint32 {
	t.Helper()
	for s := uint32(1); s < 2000; s++ {
		replay := random.New(s)
		noise.New(replay, -4, []float32{1.0})
		_ = replay.NextFloat() // radiusJitter
		if replay.NextFloat() < 0.95 {
			return s
		}
	}
	t.Fatal("no seed in [1,2000) has crackRollOk true -- geodeFindSeedWithCrackRoll's replay may have desynced from Place()'s own step 1-3 sequence")
	return 0
}

// TestGeodeFeature_CrackLine_ForcedBranchesDivergeInGeometry proves the selector draw drives
// geometry without changing the stream's shape. It runs Place() four
// times, once per crack-branch value, over the IDENTICAL underlying seed and config (only the
// FORCED branch differs), and requires every pair of the four placed volumes to differ
// somewhere -- if geodeCrackLinePoints' wiring in Place() were removed (crackLine left nil),
// all four runs would be byte-identical, since nothing else in
// Place() reads the branch draw's VALUE (only that the draw happens at all).
func TestGeodeFeature_CrackLine_ForcedBranchesDivergeInGeometry(t *testing.T) {
	pal := block.NewPalette()
	gf := buildTestGeode(t, pal, map[string]any{
		// pointCount fixed at 4 (>3): step 3 resets pointRatio to 0 for pointCount<=3, which (per
		// geode.go's own RNG-sequence description) makes tC5 the LARGEST/hardest-to-satisfy it
		// can be -- pointCount=4 keeps pointRatio's real term, giving the crack-carve check
		// (crackLineSum>=tC5) realistic room to actually fire within a small test volume.
		"min_distribution_points": float64(4),
		"max_distribution_points": float64(4),
		"max_radius":              float64(14),
		"noise_multiplier":        float64(0),
	})
	seed := geodeFindSeedWithCrackRoll(t)

	// block.ID values are only meaningful relative to the SPECIFIC Palette instance that
	// interned them -- gf's filler/innerLayer/etc IDs were resolved against pal above, so every
	// render() call must build its volume against that SAME pal, not a fresh one (unlike most of
	// this file's other tests, which only ever need one palette+feature+volume, all from a single
	// newGeodeTestVolume call).
	const testRadius = 14
	r4 := testRadius + 4
	bounds := volume.Bounds{MinX: -r4, MinY: 40, MinZ: -r4, SizeX: 2*r4 + 1, SizeY: 40, SizeZ: 2*r4 + 1}
	stone := pal.Get("minecraft:stone", nil)
	origin := wgen.BlockPos{X: 0, Y: 60, Z: 0}

	render := func(branch int) map[wgen.BlockPos]string {
		v := volume.New(bounds, pal, stone)
		rnd := &geodeForcedBranchRecorder{geodeTestRecorder: newGeodeTestRecorder(seed), branch: branch}
		if got := placeTestGeode(gf, v, origin, rnd); got == nil {
			t.Fatalf("branch %d: Place() = nil, want success", branch)
		}
		out := make(map[wgen.BlockPos]string)
		const r = 14
		for x := -r; x <= r; x++ {
			for y := -r; y <= r; y++ {
				for z := -r; z <= r; z++ {
					pos := wgen.BlockPos{X: origin.X + x, Y: origin.Y + y, Z: origin.Z + z}
					out[pos] = pal.NameOf(v.GetBlock(pos))
				}
			}
		}
		return out
	}

	results := make([]map[wgen.BlockPos]string, 4)
	for b := 0; b < 4; b++ {
		results[b] = render(b)
	}
	for a := 0; a < 4; a++ {
		for b := a + 1; b < 4; b++ {
			identical := true
			for pos, name := range results[a] {
				if results[b][pos] != name {
					identical = false
					break
				}
			}
			if identical {
				t.Errorf("branch %d and branch %d produced an identical placed volume -- "+
					"the crack-branch selector's drawn value is not reaching the placed geometry", a, b)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Potential-placement face selection (geode.go header, "BUD PLACEMENT").
// ---------------------------------------------------------------------------

// geodePickFaceTestAPI is a minimal wgen.BlockWorld stub exercising ONLY geodePickFace's
// own two calls (GetBlock, Palette) -- deliberately not volume.Volume, so these tests can set up
// an exact six-neighbor arrangement directly rather than fighting a real volume's bounds/oob
// machinery to get one.
type geodePickFaceTestAPI struct {
	pal    *block.Palette
	blocks map[wgen.BlockPos]block.ID
	air    block.ID // returned for any position not explicitly set in blocks
}

func (a *geodePickFaceTestAPI) GetBlock(p wgen.BlockPos) block.ID {
	if id, ok := a.blocks[p]; ok {
		return id
	}
	return a.air
}
func (a *geodePickFaceTestAPI) SetBlock(p wgen.BlockPos, id block.ID) bool {
	a.blocks[p] = id
	return true
}
func (a *geodePickFaceTestAPI) GetHeight(x, z int) int          { return 0 }
func (a *geodePickFaceTestAPI) GetHeightmapAt(x, z int) int     { return 0 }
func (a *geodePickFaceTestAPI) GetAboveTopSolidAt(x, z int) int { return 0 }
func (a *geodePickFaceTestAPI) MinY() int                       { return -64 }
func (a *geodePickFaceTestAPI) MaxY() int                       { return 320 }
func (a *geodePickFaceTestAPI) Contains(wgen.BlockPos) bool     { return true }
func (a *geodePickFaceTestAPI) Palette() wgen.IPaletteView      { return a.pal }

var _ wgen.BlockWorld = (*geodePickFaceTestAPI)(nil)

// TestGeodePickFace_SearchOrderPrefersUpBeforeDown pins the game's face
// iteration order ({1,0,2,3,4,5} -- Up before Down) against
// partiallyExposedBlobFacingOffsets' own Down-first declaration order.
func TestGeodePickFace_SearchOrderPrefersUpBeforeDown(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	api := &geodePickFaceTestAPI{pal: pal, air: stone, blocks: map[wgen.BlockPos]block.ID{
		{X: 0, Y: -1, Z: 0}: block.AirID, // Down -- also empty, but Up must win
		{X: 0, Y: 1, Z: 0}:  block.AirID, // Up
	}}
	neighbor, face, ok := geodePickFace(api, pos)
	if !ok {
		t.Fatal("want ok=true")
	}
	if face != 1 {
		t.Errorf("face = %d, want 1 (Up) -- the game's face iteration order tries Up before Down", face)
	}
	if want := (wgen.BlockPos{X: 0, Y: 1, Z: 0}); neighbor != want {
		t.Errorf("neighbor = %+v, want %+v", neighbor, want)
	}
}

// TestGeodePickFace_AcceptsWaterNotJustAir pins the bud-growth check's
// air-or-water test -- a water neighbor must qualify, not just air.
func TestGeodePickFace_AcceptsWaterNotJustAir(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	water := pal.Get("minecraft:water", nil)
	pos := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	api := &geodePickFaceTestAPI{pal: pal, air: stone, blocks: map[wgen.BlockPos]block.ID{
		{X: 0, Y: 0, Z: 1}: water, // South -- the only non-solid neighbor
	}}
	neighbor, face, ok := geodePickFace(api, pos)
	if !ok {
		t.Fatal("want ok=true -- a water neighbor satisfies the bud-growth check's isEmptyWaterBlock half")
	}
	if face != 3 {
		t.Errorf("face = %d, want 3 (South)", face)
	}
	if want := (wgen.BlockPos{X: 0, Y: 0, Z: 1}); neighbor != want {
		t.Errorf("neighbor = %+v, want %+v", neighbor, want)
	}
}

// TestGeodePickFace_NoneQualify: all six neighbors solid must return ok=false, matching
// the bud-growth check failing at every one of the game's six neighbour checks.
func TestGeodePickFace_NoneQualify(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	api := &geodePickFaceTestAPI{pal: pal, air: stone, blocks: map[wgen.BlockPos]block.ID{}}
	if _, _, ok := geodePickFace(api, wgen.BlockPos{}); ok {
		t.Error("want ok=false -- all six neighbors solid")
	}
}

// TestGeodeFeature_InnerPlacements_DerivesFacingDirectionState is gap 2's integration proof: a
// real Place() run's placed inner_placements block must carry a live facing_direction state
// (block.FacingDirection, via block.Palette.WithIntState -- see geode.go header, "BUD
// PLACEMENT") in [0,5], AND must keep its JSON-authored sibling state alongside it -- WithIntState
// clones the full States map, it does not replace it (see block/state_test.go's own
// TestWithIntState_PreservesOtherStates for the same contract proven directly against the
// palette).
//
// The inner_placements block here is a dropper rather than this file's usual amethyst cluster,
// and the reason is a fact rather than a convenience: the per-block-type state catalogue
// (block/vanilla_states.go) says an amethyst cluster's type declares minecraft:block_face and
// no facing_direction at all, so the game's hasState gate could never open on one and
// WithIntState now refuses it. TestGeodeFeature_InnerPlacements_LeavesAStatelessTypeAlone below
// pins that. A dropper genuinely declares facing_direction, so it is what the derivation path
// can still be proven on.
func TestGeodeFeature_InnerPlacements_DerivesFacingDirectionState(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	f := buildTestGeode(t, pal, map[string]any{
		"max_radius": float64(9),
		"inner_placements": []any{
			map[string]any{"name": "minecraft:dropper", "states": map[string]any{"triggered_bit": false}},
		},
	})
	rnd := random.New(42)
	if got := placeTestGeode(f, v, origin, rnd); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	found := false
	const r = 12
	for x := -r; x <= r; x++ {
		for y := -r; y <= r; y++ {
			for z := -r; z <= r; z++ {
				pos := wgen.BlockPos{X: origin.X + x, Y: origin.Y + y, Z: origin.Z + z}
				id := v.GetBlock(pos)
				if pal.NameOf(id) != "minecraft:dropper" {
					continue
				}
				found = true
				states := pal.StatesOf(id)
				raw, ok := states["facing_direction"]
				if !ok {
					t.Errorf("placed dropper at %+v has no facing_direction state: %+v", pos, states)
					continue
				}
				fv, ok := raw.(float64)
				if !ok || fv < 0 || fv > 5 {
					t.Errorf("placed dropper at %+v facing_direction = %v, want a number in [0,5]", pos, raw)
				}
				if states["triggered_bit"] != false {
					t.Errorf("placed dropper at %+v lost its authored triggered_bit state: %+v", pos, states)
				}
			}
		}
	}
	if !found {
		t.Fatal("no minecraft:dropper block was placed -- this config/seed is known to reach the " +
			"potential-placement drain (see TestGeodeFeature_InnerPlacementsWarning_SilentForVanillaConfig)")
	}
}

// TestGeodeFeature_InnerPlacements_LeavesAStatelessTypeAlone is the other side of the fact
// above, on the block a real vanilla geode actually places. An amethyst cluster's TYPE declares
// minecraft:block_face and no facing_direction, so the game's hasState gate never opens and
// the picked block is placed completely unchanged.
func TestGeodeFeature_InnerPlacements_LeavesAStatelessTypeAlone(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	f := buildTestGeode(t, pal, map[string]any{"max_radius": float64(9)}) // amethyst_cluster
	rnd := random.New(42)
	if got := placeTestGeode(f, v, origin, rnd); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	found := false
	const r = 12
	for x := -r; x <= r; x++ {
		for y := -r; y <= r; y++ {
			for z := -r; z <= r; z++ {
				pos := wgen.BlockPos{X: origin.X + x, Y: origin.Y + y, Z: origin.Z + z}
				id := v.GetBlock(pos)
				if pal.NameOf(id) != "minecraft:amethyst_cluster" {
					continue
				}
				found = true
				states := pal.StatesOf(id)
				if _, ok := states["facing_direction"]; ok {
					t.Errorf("placed amethyst_cluster at %+v carries a facing_direction its type "+
						"does not declare: %+v", pos, states)
				}
				if states["amethyst_cluster_type"] != "small" {
					t.Errorf("placed amethyst_cluster at %+v lost its authored state: %+v", pos, states)
				}
			}
		}
	}
	if !found {
		t.Fatal("no minecraft:amethyst_cluster block was placed -- this config/seed is known to reach " +
			"the potential-placement drain")
	}
}

// ---------------------------------------------------------------------------
// The placement-filter component (geode.go header, "PLACEMENT FILTER", and
// block/tags.go's own "minecraft:placement_filter" section).
// ---------------------------------------------------------------------------

// TestGeodeFeature_PlacementFilter_NoComponentBehavesAsBefore is the "unchanged" control: a custom
// inner_placements block that never declares minecraft:placement_filter at all (pal.LoadBlockTags
// is never even called here) must place unrestricted -- the
// per-block-type anchor-support check (geodeMayPlace) is the only gate, and this config/seed's
// layer0 anchor (diamond_block/emerald_block, both full cubes) already satisfies it.
func TestGeodeFeature_PlacementFilter_NoComponentBehavesAsBefore(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	f := buildTestGeode(t, pal, map[string]any{
		"max_radius": float64(9),
		"inner_placements": []any{
			map[string]any{"name": "addonpack:custom_bud"},
		},
	})
	rnd := random.New(42)
	if got := placeTestGeode(f, v, origin, rnd); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if !geodeVolumeContains(v, pal, origin, 12, "addonpack:custom_bud") {
		t.Error("no custom_bud placed -- a block with no minecraft:placement_filter component must be unrestricted")
	}
}

// TestGeodeFeature_PlacementFilter_RejectingFilterRefusesPlacement: the SAME seed/radius/config,
// but addonpack:custom_bud now carries a minecraft:placement_filter whose block_filter
// (minecraft:bedrock) can never match this config's actual layer0 anchor (diamond_block/
// emerald_block) -- every potential placement must be refused, though the geode's OTHER shells
// (filler/inner_layer/etc, unaffected by this check) still place, so Place() still succeeds.
func TestGeodeFeature_PlacementFilter_RejectingFilterRefusesPlacement(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	diags := pal.LoadBlockTags([]block.SourceFile{
		{ID: "custom_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:custom_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"allowed_faces": ["all"], "block_filter": ["minecraft:bedrock"]}]
					}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}
	f := buildTestGeode(t, pal, map[string]any{
		"max_radius": float64(9),
		"inner_placements": []any{
			map[string]any{"name": "addonpack:custom_bud"},
		},
	})
	rnd := random.New(42)
	if got := placeTestGeode(f, v, origin, rnd); got == nil {
		t.Fatal("Place() = nil, want success (the other shells still place)")
	}
	if geodeVolumeContains(v, pal, origin, 12, "addonpack:custom_bud") {
		t.Error("custom_bud placed despite a placement_filter block_filter (bedrock) that can never match this config's " +
			"layer0 anchor (diamond_block/emerald_block) -- the placement filter should have refused every face")
	}
}

// TestGeodeFeature_PlacementFilter_AcceptingFilterAllowsPlacement: the SAME seed/radius/config, but
// addonpack:custom_bud's block_filter now names exactly this config's real layer0 blocks
// (diamond_block, emerald_block) -- placement must succeed, proving the check is a real predicate,
// not a check that always happens to refuse.
func TestGeodeFeature_PlacementFilter_AcceptingFilterAllowsPlacement(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(9)
	diags := pal.LoadBlockTags([]block.SourceFile{
		{ID: "custom_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:custom_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"allowed_faces": ["all"], "block_filter": ["minecraft:diamond_block", "minecraft:emerald_block"]}]
					}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}
	f := buildTestGeode(t, pal, map[string]any{
		"max_radius": float64(9),
		"inner_placements": []any{
			map[string]any{"name": "addonpack:custom_bud"},
		},
	})
	rnd := random.New(42)
	if got := placeTestGeode(f, v, origin, rnd); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if !geodeVolumeContains(v, pal, origin, 12, "addonpack:custom_bud") {
		t.Error("no custom_bud placed despite a placement_filter block_filter that matches this config's real layer0 anchor " +
			"(diamond_block/emerald_block) -- the placement filter should have allowed it")
	}
}

// TestGeodeFeature_PlacementFilterCheck_DoesNotAffectRNGDrawSequence is the RNG-neutrality proof
// for the placement filter, the same shape as TestGeodeFeature_MayPlaceCheck_DoesNotAffectRNGDrawSequence
// above: block.Palette.PlacementFilterAllows makes no Random calls (the game's placement filter
// consumes no randomness either), so the no-component / rejecting-filter / accepting-filter configs above, which diverge in
// PLACED BLOCKS, must record byte-IDENTICAL RNG draw sequences at the SAME seed. This isolates
// PlacementFilterAllows's OWN internal branching (present/absent, allow/deny, which condition
// matched) from the draw sequence -- it does NOT by itself catch an extra draw geode.go's Place()
// might add unconditionally on every reached position (all three configs here reach that same
// point the same number of times, so a symmetric extra draw would cancel out of this
// comparison). That class of regression is caught by
// TestGeodeFeature_MayPlaceCheck_DoesNotAffectRNGDrawSequence instead: the placement-filter code sits
// inside the exact region that test's solid-vs-non-solid-anchor comparison already isolates (past
// geodeMayPlace's own gate), so it transitively covers it too (a spurious rnd.NextFloat() inserted
// there leaves THIS test green but fails
// TestGeodeFeature_MayPlaceCheck_DoesNotAffectRNGDrawSequence).
func TestGeodeFeature_PlacementFilterCheck_DoesNotAffectRNGDrawSequence(t *testing.T) {
	pal := block.NewPalette()
	diags := pal.LoadBlockTags([]block.SourceFile{
		{ID: "rejecting_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:rejecting_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"allowed_faces": ["all"], "block_filter": ["minecraft:bedrock"]}]
					}
				}
			}
		}`},
		{ID: "accepting_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:accepting_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"allowed_faces": ["all"], "block_filter": ["minecraft:diamond_block", "minecraft:emerald_block"]}]
					}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}

	const radius = 9
	r4 := radius + 4
	bounds := volume.Bounds{MinX: -r4, MinY: 40, MinZ: -r4, SizeX: 2*r4 + 1, SizeY: 40, SizeZ: 2*r4 + 1}
	stone := pal.Get("minecraft:stone", nil)
	origin := wgen.BlockPos{X: 0, Y: 60, Z: 0}

	build := func(blockName string) *GeodeFeature {
		return buildTestGeode(t, pal, map[string]any{
			"max_radius": float64(radius),
			"inner_placements": []any{
				map[string]any{"name": blockName},
			},
		})
	}
	noComponent := build("addonpack:no_component_bud")
	rejecting := build("addonpack:rejecting_bud")
	accepting := build("addonpack:accepting_bud")

	draws := func(f *GeodeFeature) []string {
		v := volume.New(bounds, pal, stone)
		rec := newGeodeTestRecorder(42)
		if got := placeTestGeode(f, v, origin, rec); got == nil {
			t.Fatal("Place() = nil, want success")
		}
		return append([]string(nil), rec.draws...)
	}

	base := draws(noComponent)
	rejectingDraws := draws(rejecting)
	acceptingDraws := draws(accepting)

	check := func(label string, got []string) {
		if len(got) != len(base) {
			t.Fatalf("%s: draw count differs from no-component base: %d vs %d -- the placement-filter check must not "+
				"change the RNG draw sequence", label, len(got), len(base))
		}
		for i := range base {
			if got[i] != base[i] {
				t.Fatalf("%s: draw[%d] differs from no-component base: %q vs %q -- the placement-filter check must not "+
					"change the RNG draw sequence", label, i, got[i], base[i])
			}
		}
	}
	check("rejecting", rejectingDraws)
	check("accepting", acceptingDraws)
}

// TestGeodeFeature_InvalidBlocksThresholdAbortsImmediately pins WHERE the
// abort happens, not just that it happens. Reaching invalid_blocks_threshold
// fails placement on the spot, so the point that tripped the threshold
// never draws its own point-offset and no later point is drawn at all.
//
// Raising a flag and finishing the loop instead would, with three
// points and a point-offset range that draws, cost 12 draws where the
// game makes 3 -- and since every one of them shifts ctx.Random, every
// feature placed after a geode in the same chain would move too.
func TestGeodeFeature_InvalidBlocksThresholdAbortsImmediately(t *testing.T) {
	pal := block.NewPalette()
	bedrock := pal.Get("minecraft:bedrock", nil)
	bounds := volume.Bounds{MinX: -2, MinY: 58, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}
	v := volume.New(bounds, pal, bedrock)
	origin := wgen.BlockPos{X: 0, Y: 60, Z: 0}

	f := buildTestGeode(t, pal, map[string]any{
		"invalid_blocks_threshold": float64(0),
		"min_distribution_points":  float64(3),
		"max_distribution_points":  float64(3),
	})
	rec := newGeodeTestRecorder(1)
	if got := placeTestGeode(f, v, origin, rec); got != nil {
		t.Fatalf("Place() = %+v, want nil", got)
	}

	// Everything up to and including crackRoll is the noise construction plus
	// two NextFloats; what this test is about is the tail after it.
	var tail []string
	for i, d := range rec.draws {
		if d == "NextFloat" {
			// radiusJitter is the first geode-level NextFloat; crackRoll is
			// the next draw after it.
			tail = rec.draws[i+2:]
			break
		}
	}
	want := []string{"NextIntBound(3)", "NextIntBound(3)", "NextIntBound(3)"}
	if len(tail) != len(want) {
		t.Fatalf("draws after crackRoll = %v, want exactly %v (the first point's three wall-distance draws and nothing else: "+
			"its point-offset, the two remaining points and the crack-branch selector are all past the abort)", tail, want)
	}
	for i := range want {
		if tail[i] != want[i] {
			t.Fatalf("draw %d after crackRoll = %q, want %q", i, tail[i], want[i])
		}
	}
}

// TestFastInvSqrt_IsTheGamesBitHack pins fastInvSqrt against an
// independent implementation of the game's fast inverse square root -- the
// canonical Quake III routine: one magic constant, ONE Newton step, float32
// throughout. It also pins the two properties that make it observably
// different from 1/sqrt(x): the relative error is real (up to ~0.175%), and
// x == 0 does not produce +Inf.
func TestFastInvSqrt_IsTheGamesBitHack(t *testing.T) {
	// Independent reference, written from the canonical operation sequence
	// rather than from fastInvSqrt's own source.
	ref := func(x float32) float32 {
		bits := math.Float32bits(x)
		magic := uint32(0x5F3759DF) - (bits >> 1)
		y := math.Float32frombits(magic)
		return y * (1.5 - (0.5*x)*y*y)
	}
	for _, x := range []float32{0, 1, 2, 3, 4, 12, 27, 100, 1e6, 0.25, 1.0 / 3.0} {
		if got, want := fastInvSqrt(x), ref(x); got != want {
			t.Errorf("fastInvSqrt(%v) = %v, want %v (bit-for-bit)", x, got, want)
		}
	}
	if got := fastInvSqrt(0); math.IsInf(float64(got), 1) {
		t.Errorf("fastInvSqrt(0) = %v, want a finite value -- the game has no zero guard", got)
	}
	// The approximation error is what makes this NOT interchangeable with
	// 1/sqrt: Quake's one-Newton-step bound is about 0.175%.
	worst := 0.0
	for x := float32(0.5); x < 1000; x *= 1.01 {
		exact := 1 / math.Sqrt(float64(x))
		rel := math.Abs(float64(fastInvSqrt(x))-exact) / exact
		if rel > worst {
			worst = rel
		}
	}
	if worst == 0 {
		t.Fatal("fastInvSqrt agrees with 1/sqrt everywhere -- it is not the approximation")
	}
	if worst > 0.002 {
		t.Fatalf("worst relative error %.5f exceeds the one-Newton-step bound", worst)
	}
	t.Logf("worst relative error against 1/sqrt over [0.5, 1000): %.5f%%", worst*100)
}
