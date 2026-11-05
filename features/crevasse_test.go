package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

const crevasseTopY = 40

type crevasseBench struct {
	pal    *block.Palette
	v      *volume.Volume
	origin wgen.BlockPos
}

// newCrevasseBench is a flat stone world with its top at y 40.
func newCrevasseBench(t *testing.T, ground string) *crevasseBench {
	t.Helper()
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: -24, MinY: 0, MinZ: -24, SizeX: 49, SizeY: 64, SizeZ: 49}
	v := volume.New(bounds, pal, pal.Get("minecraft:air", nil))
	groundID := pal.Get(ground, nil)
	for x := -24; x <= 24; x++ {
		for z := -24; z <= 24; z++ {
			for y := 0; y <= crevasseTopY; y++ {
				v.SetBlockUnbudgeted(wgen.BlockPos{X: x, Y: y, Z: z}, groundID)
			}
		}
	}
	return &crevasseBench{pal: pal, v: v, origin: wgen.BlockPos{X: 0, Y: crevasseTopY, Z: 0}}
}

func (b *crevasseBench) build(t *testing.T, body map[string]any) *CrevasseFeature {
	t.Helper()
	ctx := &BuildContext{Palette: b.pal, Identifier: "test:crevasse", FileID: "test:crevasse", Warn: func(string) {}}
	built, err := buildCrevasseFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildCrevasseFeature: %v", err)
	}
	return built.(*CrevasseFeature)
}

func (b *crevasseBench) place(f *CrevasseFeature, rnd random.RandomSource) *wgen.BlockPos {
	return f.Place(&wgen.PlacementContext{
		API: b.v, Origin: b.origin, Random: rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	})
}

func (b *crevasseBench) count(name string) int {
	id := b.pal.Get(name, nil)
	n := 0
	for x := -24; x <= 24; x++ {
		for z := -24; z <= 24; z++ {
			for y := 0; y < 64; y++ {
				if b.v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == id {
					n++
				}
			}
		}
	}
	return n
}

func (b *crevasseBench) at(x, y, z int) string {
	return b.pal.NameOf(b.v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}))
}

func TestCrevasse_NoTerrainPlacesNothing(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:air")
	b.origin.Y = 40
	if got := b.place(b.build(t, map[string]any{}), random.New(1)); got != nil {
		t.Errorf("Place() = %v, want nil over air", got)
	}
}

func TestCrevasse_GroundOutsideTheCarverListPlacesNothing(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:obsidian")
	if got := b.place(b.build(t, map[string]any{}), random.New(1)); got != nil {
		t.Errorf("Place() = %v, want nil on a block the carver cannot replace", got)
	}
}

func TestCrevasse_OriginTooLowFailsBeforeTheAngleDraw(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	b.origin.Y = 4 // the fixed depth 6 reaches past the bottom of the world
	tr := random.NewTracer(random.New(1))
	f := b.build(t, map[string]any{"carve_depth": float64(6)})
	if got := b.place(f, tr); got != nil {
		t.Errorf("Place() = %v, want nil", got)
	}
	if len(tr.Draws) != 0 {
		t.Errorf("draws = %v, want none: a fixed depth draws nothing and the check comes first", tr.Draws)
	}
}

func TestCrevasse_DrawOrder(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	tr := random.NewTracer(random.New(5))
	f := b.build(t, map[string]any{"max_length": float64(4), "min_footprint": float64(1)})
	b.place(f, tr)

	want := []random.Method{random.MethodNextIntBound, random.MethodNextFloat, random.MethodNextIntBound}
	for i := 0; i < 4; i++ { // two sides, half = 2 steps each
		want = append(want, random.MethodNextFloat, random.MethodNextFloat, random.MethodNextFloat)
	}
	if len(tr.Draws) != len(want) {
		t.Fatalf("draws = %d, want %d: %v", len(tr.Draws), len(want), tr.Draws)
	}
	for i, method := range want {
		if tr.Draws[i].Method != method {
			t.Fatalf("draw %d = %v, want %v", i, tr.Draws[i], method)
		}
	}
	if tr.Draws[0].Bound != 5 || tr.Draws[2].Bound != 3 {
		t.Errorf("bounds = %d, %d, want carve_depth 5 and fill_depth 3", tr.Draws[0].Bound, tr.Draws[2].Bound)
	}
}

func TestCrevasse_FlatTerrainCarvesATrench(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	if got := b.place(b.build(t, map[string]any{}), random.New(3)); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if got := b.at(0, crevasseTopY, 0); got != "minecraft:air" {
		t.Errorf("origin surface = %s, want air", got)
	}
}

func TestCrevasse_SurfaceAndFill(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	f := b.build(t, map[string]any{
		"surface_block": "minecraft:gravel",
		"fill_block":    "minecraft:lava",
		"carve_depth":   float64(8),
		"fill_depth":    float64(4),
	})
	if got := b.place(f, random.New(3)); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if got := b.count("minecraft:gravel"); got == 0 {
		t.Error("no surface block placed")
	}
	if got := b.count("minecraft:lava"); got == 0 {
		t.Error("no fill block placed")
	}
	// lowest surface is 40 here, so the fill starts at min(39, 36) = 36 and nothing fills higher.
	for x := -24; x <= 24; x++ {
		for z := -24; z <= 24; z++ {
			if got := b.at(x, 37, z); got == "minecraft:lava" {
				t.Fatalf("lava at (%d,37,%d), above the fill level 36", x, z)
			}
		}
	}
}

func TestCrevasse_AirSurfaceAndFillBlocksCountAsNone(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	f := b.build(t, map[string]any{"surface_block": "minecraft:air", "fill_block": "minecraft:air"})
	if f.hasSurface || f.hasFill {
		t.Errorf("hasSurface=%v hasFill=%v, want both false", f.hasSurface, f.hasFill)
	}
}

func TestCrevasse_MinFootprintRefusesASmallCarve(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	f := b.build(t, map[string]any{"max_length": float64(4), "max_width": float64(2), "min_footprint": float64(32), "twistiness": float64(0)})
	if got := b.place(f, random.New(3)); got != nil {
		t.Errorf("Place() = %v, want nil below min_footprint", got)
	}
	if got := b.at(0, crevasseTopY, 0); got != "minecraft:stone" {
		t.Errorf("origin = %s, want untouched stone after a refused carve", got)
	}
}

func TestCrevasse_DepthStopsAtABlockItCannotCarve(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	obsidian := b.pal.Get("minecraft:obsidian", nil)
	for x := -24; x <= 24; x++ {
		for z := -24; z <= 24; z++ {
			b.v.SetBlockUnbudgeted(wgen.BlockPos{X: x, Y: crevasseTopY - 2, Z: z}, obsidian)
		}
	}
	if got := b.place(b.build(t, map[string]any{}), random.New(3)); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if got := b.at(0, crevasseTopY-1, 0); got != "minecraft:air" {
		t.Errorf("(0,39,0) = %s, want air", got)
	}
	if got := b.at(0, crevasseTopY-2, 0); got != "minecraft:obsidian" {
		t.Errorf("(0,38,0) = %s, want the obsidian kept", got)
	}
}

func TestCrevasse_LiquidBesideAColumnStopsItsCarve(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	f := b.build(t, map[string]any{"twistiness": float64(0), "surface_block": "minecraft:gravel"})
	if got := b.place(f, random.New(3)); got == nil {
		t.Fatal("control Place() = nil, want success")
	}
	control := b.at(0, crevasseTopY, 0)

	wet := newCrevasseBench(t, "minecraft:stone")
	water := wet.pal.Get("minecraft:water", nil)
	for _, side := range crevasseSides {
		wet.v.SetBlockUnbudgeted(wgen.BlockPos{X: side.x, Y: crevasseTopY + 1, Z: side.z}, wet.pal.Get("minecraft:air", nil))
		wet.v.SetBlockUnbudgeted(wgen.BlockPos{X: side.x * 2, Y: crevasseTopY, Z: side.z * 2}, water)
	}
	f = wet.build(t, map[string]any{"twistiness": float64(0), "surface_block": "minecraft:gravel"})
	wet.place(f, random.New(3))
	if control != "minecraft:gravel" {
		t.Errorf("dry origin = %s, want the surface block", control)
	}
	if got := wet.count("minecraft:water"); got == 0 {
		t.Error("the water beside the carve is gone")
	}
}

func TestCrevasse_SteepOriginFails(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	stone := b.pal.Get("minecraft:stone", nil)
	// Every neighbour of the origin stands two blocks taller, so the origin column is steep.
	for _, side := range crevasseSides {
		for y := crevasseTopY + 1; y <= crevasseTopY+2; y++ {
			b.v.SetBlockUnbudgeted(wgen.BlockPos{X: side.x, Y: y, Z: side.z}, stone)
		}
	}
	f := b.build(t, map[string]any{"max_width": float64(8), "twistiness": float64(0), "min_footprint": float64(1)})
	if got := b.place(f, random.New(3)); got != nil {
		t.Errorf("Place() = %v, want nil with a steep origin column", got)
	}
}

func TestCrevasse_NotFeatureReplaceableBlockStays(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	if diags := b.pal.LoadBlockTags([]block.SourceFile{{ID: "tagged.json", Text: `{
		"minecraft:block": {
			"description": {"identifier": "test:tagged"},
			"components": {"tag:not_feature_replaceable": {}}
		}
	}`}}); len(diags) != 0 {
		t.Fatalf("LoadBlockTags: %v", diags)
	}
	tagged := b.pal.Get("test:tagged", nil)
	f := b.build(t, map[string]any{})
	f.setSafe(b.v, wgen.BlockPos{X: 0, Y: crevasseTopY + 1, Z: 0}, tagged)
	f.setSafe(b.v, wgen.BlockPos{X: 0, Y: crevasseTopY + 1, Z: 0}, b.pal.Get("minecraft:gravel", nil))
	if got := b.at(0, crevasseTopY+1, 0); got != "test:tagged" {
		t.Errorf("tagged block = %s, want it kept", got)
	}
}

func TestCrevasse_VanillaNotFeatureReplaceableBlockStays(t *testing.T) {
	b := newCrevasseBench(t, "minecraft:stone")
	f := b.build(t, map[string]any{})
	pos := wgen.BlockPos{X: 0, Y: crevasseTopY + 1, Z: 0}
	b.v.SetBlockUnbudgeted(pos, b.pal.Get("minecraft:chest", nil))
	f.setSafe(b.v, pos, b.pal.Get("minecraft:gravel", nil))
	if got := b.at(pos.X, pos.Y, pos.Z); got != "minecraft:chest" {
		t.Errorf("chest = %s, want it kept", got)
	}
	b.v.SetBlockUnbudgeted(pos, b.pal.Get("minecraft:dirt", nil))
	f.setSafe(b.v, pos, b.pal.Get("minecraft:gravel", nil))
	if got := b.at(pos.X, pos.Y, pos.Z); got != "minecraft:gravel" {
		t.Errorf("dirt = %s, want it overwritten", got)
	}
}

func TestCrevasse_SchemaErrors(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:crevasse", FileID: "test:crevasse", Warn: func(string) {}}
	cases := map[string]map[string]any{
		"max_length low":       {"max_length": float64(3)},
		"max_length high":      {"max_length": float64(17)},
		"max_length text":      {"max_length": "long"},
		"max_width low":        {"max_width": float64(1)},
		"max_width high":       {"max_width": float64(9)},
		"min_footprint low":    {"min_footprint": float64(0)},
		"min_footprint high":   {"min_footprint": float64(33)},
		"twistiness low":       {"twistiness": float64(-1)},
		"twistiness high":      {"twistiness": float64(17)},
		"twistiness text":      {"twistiness": "yes"},
		"carve_depth low":      {"carve_depth": float64(3)},
		"carve_depth high":     {"carve_depth": map[string]any{"range_min": float64(4), "range_max": float64(33)}},
		"carve_depth text":     {"carve_depth": "deep"},
		"fill_depth low":       {"fill_depth": float64(-1)},
		"fill_depth high":      {"fill_depth": float64(33)},
		"surface_block number": {"surface_block": float64(1)},
		"fill_block number":    {"fill_block": float64(1)},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := buildCrevasseFeature(body, ctx); err == nil {
				t.Error("want an error, got nil")
			}
		})
	}
}

func TestCrevasse_NeedsFormatVersion12650(t *testing.T) {
	if got := MinFormatVersionForType(crevasseTypeID); got.Raw != "1.26.50" {
		t.Errorf("minimum format_version = %q, want 1.26.50", got.Raw)
	}
}
