// single_block_attach_test.go exercises the game's attach/deny semantics of
// minecraft:single_block_feature (see single_block.go's header): the hard
// top/bottom/diagonal gates vs the counted cardinal sides, the "all"/"sides"
// group keys, min_sides_must_attach's default of 4, may_not_attach_to,
// and randomize_rotation's raw unsigned draw of 4. The prior port had
// none of this (it counted every configured face against a default of 1), so
// these tests are what pins the corrected transcription.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// buildSB builds a single_block_feature from body (with the two required
// enforce_* keys filled in unless the body already has them).
func buildSB(t *testing.T, pal *block.Palette, body map[string]any) wgen.IFeature {
	t.Helper()
	if _, ok := body["enforce_placement_rules"]; !ok {
		body["enforce_placement_rules"] = false
	}
	if _, ok := body["enforce_survivability_rules"]; !ok {
		body["enforce_survivability_rules"] = false
	}
	ctx := &BuildContext{Palette: pal, Resolver: condResolver{}, Identifier: "test:sb", FileID: "test:sb", Warn: func(string) {}}
	f, err := buildSingleBlockFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildSingleBlockFeature: %v", err)
	}
	return f
}

// sbVolume is a 5x5x5 all-air volume centered on the origin.
func sbVolume(pal *block.Palette) *volume.Volume {
	return volume.New(volume.Bounds{MinX: -2, MinY: -2, MinZ: -2, SizeX: 5, SizeY: 5, SizeZ: 5}, pal, block.AirID)
}

func sbCtx(v *volume.Volume) *wgen.PlacementContext {
	return &wgen.PlacementContext{
		API: v, Origin: wgen.BlockPos{}, Random: random.New(1),
		MolangScope: wgen.NewScope(),
		LogFailure:  func(featureType, message string, pos wgen.BlockPos) {},
	}
}

func TestSingleBlock_EmptyMayAttachToPasses(t *testing.T) {
	// A common pattern: "may_attach_to": {}. All lists empty:
	// the hard gates pass vacuously and all four sides count for free, so
	// the default min_sides_must_attach = 4 is met exactly.
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block":  "minecraft:stone",
		"may_attach_to": map[string]any{},
	})
	if f.Place(sbCtx(sbVolume(pal))) == nil {
		t.Fatal("empty may_attach_to must place (4 free side matches >= default min_sides 4)")
	}
}

func TestSingleBlock_TopIsAHardGate(t *testing.T) {
	// "top" configured and not matching must refuse even though every side
	// counts for free -- the hard gates are individually fatal, they are
	// NOT part of the min_sides count.
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block":  "minecraft:stone",
		"may_attach_to": map[string]any{"top": "minecraft:dirt"},
	})
	v := sbVolume(pal) // top neighbor is air, not dirt
	if f.Place(sbCtx(v)) != nil {
		t.Fatal("unmatched top gate must refuse placement")
	}
	v.SetBlock(wgen.BlockPos{Y: 1}, pal.Get("minecraft:dirt", nil))
	if f.Place(sbCtx(v)) == nil {
		t.Fatal("matched top gate must place")
	}
}

func TestSingleBlock_ConfiguredSideMustMatchUnderDefaultMinSides(t *testing.T) {
	// One configured side list under the DEFAULT min_sides (4): the three
	// unconfigured sides count for free, so the configured one must match
	// for 4 >= 4. The earlier port's "any one of the configured faces"
	// (default 1) model made the same JSON place with the side unmatched.
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block":  "minecraft:stone",
		"may_attach_to": map[string]any{"east": "minecraft:dirt"},
	})
	v := sbVolume(pal) // east neighbor is air
	if f.Place(sbCtx(v)) != nil {
		t.Fatal("unmatched configured side under default min_sides=4 must refuse")
	}
	v.SetBlock(wgen.BlockPos{X: 1}, pal.Get("minecraft:dirt", nil))
	if f.Place(sbCtx(v)) == nil {
		t.Fatal("matched configured side must place")
	}
}

func TestSingleBlock_MinSidesRelaxesCountedSides(t *testing.T) {
	// min_sides_must_attach: 3 with one configured, unmatched side: the
	// three free sides suffice.
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block": "minecraft:stone",
		"may_attach_to": map[string]any{
			"east":                  "minecraft:dirt",
			"min_sides_must_attach": float64(3),
		},
	})
	if f.Place(sbCtx(sbVolume(pal))) == nil {
		t.Fatal("min_sides=3 with 3 free sides must place even though east is unmatched")
	}
}

func TestSingleBlock_SidesGroupKeyCountsAllFourCardinals(t *testing.T) {
	// "sides" applies to the four cardinals as a group. With sides=[dirt]
	// and only two dirt neighbors, 2 < 4 refuses; min_sides 2 places.
	pal := block.NewPalette()
	dirt := pal.Get("minecraft:dirt", nil)
	body := func(minSides any) map[string]any {
		m := map[string]any{"sides": "minecraft:dirt"}
		if minSides != nil {
			m["min_sides_must_attach"] = minSides
		}
		return map[string]any{"places_block": "minecraft:stone", "may_attach_to": m}
	}
	v := sbVolume(pal)
	v.SetBlock(wgen.BlockPos{X: 1}, dirt)
	v.SetBlock(wgen.BlockPos{X: -1}, dirt)

	if buildSB(t, pal, body(nil)).Place(sbCtx(v)) != nil {
		t.Fatal("2 matching sides < default min_sides 4 must refuse")
	}
	if buildSB(t, pal, body(float64(2))).Place(sbCtx(v)) == nil {
		t.Fatal("2 matching sides >= min_sides 2 must place")
	}
}

func TestSingleBlock_AllGroupKeyGatesEveryNeighborIncludingDiagonals(t *testing.T) {
	// "all" is checked as a hard gate against all six faces AND the four
	// horizontal diagonals. All-dirt neighbors pass; one stone diagonal
	// breaks it.
	pal := block.NewPalette()
	dirt := pal.Get("minecraft:dirt", nil)
	f := buildSB(t, pal, map[string]any{
		"places_block":  "minecraft:stone",
		"may_attach_to": map[string]any{"all": "minecraft:dirt"},
	})
	v := sbVolume(pal)
	for _, d := range [][3]int{{0, 1, 0}, {0, -1, 0}, {0, 0, -1}, {1, 0, 0}, {0, 0, 1}, {-1, 0, 0}, {1, 0, 1}, {-1, 0, 1}, {1, 0, -1}, {-1, 0, -1}} {
		v.SetBlock(wgen.BlockPos{X: d[0], Y: d[1], Z: d[2]}, dirt)
	}
	if f.Place(sbCtx(v)) == nil {
		t.Fatal("all ten neighbors dirt with all=[dirt] must place")
	}
	v.SetBlock(wgen.BlockPos{X: 1, Z: 1}, pal.Get("minecraft:stone", nil))
	if f.Place(sbCtx(v)) != nil {
		t.Fatal("a diagonal neighbor failing the all-list must refuse")
	}
}

func TestSingleBlock_MayNotAttachToDenies(t *testing.T) {
	// A single matching deny list rejects before any RNG is drawn.
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block":      "minecraft:stone",
		"may_not_attach_to": map[string]any{"bottom": "minecraft:lava"},
	})
	v := sbVolume(pal)
	if f.Place(sbCtx(v)) == nil {
		t.Fatal("deny list with non-matching neighbor must still place")
	}
	v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get("minecraft:lava", nil))
	failures := []string{}
	ctx := sbCtx(v)
	ctx.LogFailure = func(featureType, message string, pos wgen.BlockPos) { failures = append(failures, message) }
	if f.Place(ctx) != nil {
		t.Fatal("matching deny list must refuse")
	}
	if len(failures) == 0 || !strings.Contains(failures[0], "deny list") {
		t.Fatalf("expected the game's deny-list failure message, got %v", failures)
	}
}

// countingRandom records NextUnsignedInt draws and returns fixed values.
type countingRandom struct {
	*random.Rand
	unsignedDraws []uint32
}

func (c *countingRandom) NextUnsignedInt(bound uint32) uint32 {
	c.unsignedDraws = append(c.unsignedDraws, bound)
	return c.Rand.NextUnsignedInt(bound)
}

func TestSingleBlock_RandomizeRotationDrawsOnce(t *testing.T) {
	// randomize_rotation must take exactly one raw unsigned draw of 4 after the
	// may_replace check, whether or not the block has rotatable states
	// (identity transform for stateless blocks; the draw still happens and
	// shifts the stream, which is the part callers can observe).
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block":       "minecraft:stone",
		"randomize_rotation": true,
	})
	rnd := &countingRandom{Rand: random.New(1)}
	v := sbVolume(pal)
	ctx := sbCtx(v)
	ctx.Random = rnd
	if f.Place(ctx) == nil {
		t.Fatal("expected placement to succeed")
	}
	if len(rnd.unsignedDraws) != 1 || rnd.unsignedDraws[0] != 4 {
		t.Fatalf("expected exactly one NextUnsignedInt(4) draw, got %v", rnd.unsignedDraws)
	}
}

func TestSingleBlock_MissingEnforceKeysWarnButBuild(t *testing.T) {
	// The game's schema REQUIRES both enforce_* keys; this port downgrades
	// the missing-key case to a warning (format_version gating unconfirmed)
	// but must say the real game would reject the file.
	pal := block.NewPalette()
	var warnings []string
	ctx := &BuildContext{Palette: pal, Resolver: condResolver{}, Identifier: "test:sb", FileID: "test:sb", Warn: func(w string) { warnings = append(warnings, w) }}
	if _, err := buildSingleBlockFeature(map[string]any{"places_block": "minecraft:stone"}, ctx); err != nil {
		t.Fatalf("build must succeed with a warning, got error: %v", err)
	}
	if len(warnings) != 2 {
		t.Fatalf("expected 2 warnings (one per missing enforce key), got %v", warnings)
	}
	for _, w := range warnings {
		if !strings.Contains(w, "required by the engine's schema") {
			t.Fatalf("warning must name the schema requirement, got %q", w)
		}
	}
}
