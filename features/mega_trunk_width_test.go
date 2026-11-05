package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

func megaWidthBody(width any, height int) map[string]any {
	trunk := map[string]any{
		"trunk_height": map[string]any{"base": float64(height)},
		"trunk_block":  "minecraft:log",
	}
	if width != nil {
		trunk["trunk_width"] = width
	}
	return map[string]any{
		"mega_trunk": trunk,
		"mega_canopy": map[string]any{
			"canopy_height": float64(1),
			"base_radius":   float64(0),
			"leaf_block":    "minecraft:leaves",
		},
		"may_replace": []any{"minecraft:air"},
	}
}

func widthRange(lo, hi int) map[string]any {
	return map[string]any{"range_min": float64(lo), "range_max": float64(hi)}
}

func TestMegaTrunk_WidthRange_DrawsFirstAndSizesTrunkAndCanopy(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	logID := pal.Get("minecraft:log", nil)
	leaves := pal.Get("minecraft:leaves", nil)
	ctx := &BuildContext{Palette: pal, Identifier: "test:w", FileID: "test:w", Warn: func(string) {}}
	built, err := buildTreeFeature(megaWidthBody(widthRange(2, 4), 4), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}

	tr := random.NewTracer(&spruceScriptedRandom{bounds: []int{2}, floats: []float64{0}})
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	if got := placeTestTree(built.(*TreeFeature), v, origin, tr); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	if len(tr.Draws) != 1 || tr.Draws[0].Method != random.MethodNextIntBound || tr.Draws[0].Bound != 3 {
		t.Fatalf("draws = %v, want the one trunk_width draw of bound 3", tr.Draws)
	}
	if got := v.GetBlock(wgen.BlockPos{X: 3, Y: 10, Z: 3}); got != logID {
		t.Errorf("far corner of the drawn width 4 = %v, want a log", pal.Entry(got))
	}
	// The radius ignores the trunk: in game, widths 2, 3 and 4 grew the same crown.
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 14, Z: 0}); got != leaves {
		t.Errorf("crown at the anchor = %v, want leaves", pal.Entry(got))
	}
	if got := v.GetBlock(wgen.BlockPos{X: -1, Y: 14, Z: 0}); got == leaves {
		t.Error("crown reaches one cell past the anchor at base_radius 0, want it to ignore the drawn width")
	}
}

func TestMegaTrunk_EqualRangeAndPlainNumberDrawNothing(t *testing.T) {
	for name, width := range map[string]any{"range": widthRange(2, 2), "number": float64(2)} {
		t.Run(name, func(t *testing.T) {
			v, pal := newTreeTestVolume(t, 10)
			ctx := &BuildContext{Palette: pal, Identifier: "test:w", FileID: "test:w", Warn: func(string) {}}
			built, err := buildTreeFeature(megaWidthBody(width, 4), ctx)
			if err != nil {
				t.Fatalf("buildTreeFeature: %v", err)
			}
			tr := random.NewTracer(&spruceScriptedRandom{})
			if got := placeTestTree(built.(*TreeFeature), v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, tr); got == nil {
				t.Fatal("Place() = nil, want success")
			}
			if len(tr.Draws) != 0 {
				t.Errorf("draws = %v, want none", tr.Draws)
			}
		})
	}
}

func TestMegaTrunk_WidthErrors(t *testing.T) {
	_, pal := newTreeTestVolume(t, 10)
	ctx := &BuildContext{Palette: pal, Identifier: "test:w", FileID: "test:w", Warn: func(string) {}}
	withCore := func(width any, core any) map[string]any {
		body := megaWidthBody(width, 4)
		body["mega_canopy"].(map[string]any)["core_width"] = core
		return body
	}
	acacia := map[string]any{
		"acacia_trunk": map[string]any{
			"trunk_width":  widthRange(1, 2),
			"trunk_height": map[string]any{"base": float64(4)},
			"trunk_block":  "minecraft:log",
		},
		"acacia_canopy": map[string]any{"canopy_size": float64(1), "leaf_block": "minecraft:leaves"},
		"may_replace":   []any{"minecraft:air"},
	}
	cases := map[string]map[string]any{
		"missing":             megaWidthBody(nil, 4),
		"not a range":         megaWidthBody("wide", 4),
		"zero":                megaWidthBody(float64(0), 4),
		"range below one":     megaWidthBody(widthRange(0, 2), 4),
		"core with a range":   withCore(widthRange(2, 3), float64(2)),
		"core not a number":   withCore(float64(2), "two"),
		"core differs":        withCore(float64(2), float64(3)),
		"acacia stays number": acacia,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := buildTreeFeature(body, ctx); err == nil {
				t.Error("want an error, got nil")
			}
		})
	}
}

type recordingWorld struct {
	wgen.BlockWorld
	writes []wgen.BlockPos
}

func (w *recordingWorld) SetBlock(p wgen.BlockPos, id block.ID) bool {
	w.writes = append(w.writes, p)
	return w.BlockWorld.SetBlock(p, id)
}

// Since 1.26.70 the decorated layers are walked x, y, z. The old order was y, x, z.
func TestMegaTrunk_MiddleLayersWalkXThenYThenZ(t *testing.T) {
	v, pal := newTreeTestVolume(t, 10)
	ctx := &BuildContext{Palette: pal, Identifier: "test:w", FileID: "test:w", Warn: func(string) {}}
	built, err := buildTreeFeature(megaWidthBody(float64(2), 4), ctx)
	if err != nil {
		t.Fatalf("buildTreeFeature: %v", err)
	}
	world := &recordingWorld{BlockWorld: v}
	origin := wgen.BlockPos{X: 0, Y: 10, Z: 0}
	if got := built.(*TreeFeature).Place(&wgen.PlacementContext{
		API: world, Origin: origin, Random: &spruceScriptedRandom{},
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
	}); got == nil {
		t.Fatal("Place() = nil, want success")
	}

	var middle []wgen.BlockPos
	logID := pal.Get("minecraft:log", nil)
	for _, p := range world.writes {
		if p.Y >= 11 && p.Y <= 12 && v.GetBlock(p) == logID {
			middle = append(middle, p)
		}
	}
	want := []wgen.BlockPos{
		{X: 0, Y: 11, Z: 0}, {X: 0, Y: 11, Z: 1}, {X: 0, Y: 12, Z: 0}, {X: 0, Y: 12, Z: 1},
		{X: 1, Y: 11, Z: 0}, {X: 1, Y: 11, Z: 1}, {X: 1, Y: 12, Z: 0}, {X: 1, Y: 12, Z: 1},
	}
	if len(middle) != len(want) {
		t.Fatalf("middle writes = %v, want %v", middle, want)
	}
	for i := range want {
		if middle[i] != want[i] {
			t.Fatalf("middle write %d = %v, want %v (all: %v)", i, middle[i], want[i], middle)
		}
	}
}

// The walk covers y+1 to y+height-2 in either order, so short trunks walk more than the
// old "height-2 layers" did.
func TestMegaTrunk_ShortTrunksKeepTheFullWidthAtYPlusOne(t *testing.T) {
	for _, height := range []int{1, 2} {
		v, pal := newTreeTestVolume(t, 10)
		ctx := &BuildContext{Palette: pal, Identifier: "test:w", FileID: "test:w", Warn: func(string) {}}
		built, err := buildTreeFeature(megaWidthBody(float64(2), height), ctx)
		if err != nil {
			t.Fatalf("buildTreeFeature: %v", err)
		}
		if got := placeTestTree(built.(*TreeFeature), v, wgen.BlockPos{X: 0, Y: 10, Z: 0}, &spruceScriptedRandom{}); got == nil {
			t.Fatalf("height %d: Place() = nil, want success", height)
		}
		if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 11, Z: 1}); got != pal.Get("minecraft:log", nil) {
			t.Errorf("height %d: (1,11,1) = %v, want a log", height, pal.Entry(got))
		}
	}
}
