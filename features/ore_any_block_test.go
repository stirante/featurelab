package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

func oreAirWorld(pal *block.Palette) *volume.Volume {
	return volume.New(volume.Bounds{MinX: -32, MinY: 32, MinZ: -32, SizeX: 65, SizeY: 65, SizeZ: 65}, pal, pal.Get("minecraft:air", nil))
}

func oreCount(v *volume.Volume, id block.ID) int {
	n := 0
	for x := -32; x <= 32; x++ {
		for y := 32; y <= 96; y++ {
			for z := -32; z <= 32; z++ {
				if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == id {
					n++
				}
			}
		}
	}
	return n
}

func TestOreFeature_RuleWithoutMayReplaceMatchesAnyBlock(t *testing.T) {
	pal := block.NewPalette()
	ore := pal.Get("minecraft:iron_ore", nil)
	origin := wgen.BlockPos{X: 0, Y: 64, Z: 0}
	rule := []any{map[string]any{"places_block": "minecraft:iron_ore"}}

	stone, _, _ := oreTestWorld(pal)
	orePlace(buildTestOre(t, pal, oreTestBody(16, rule)), stone, origin, random.New(7))
	if oreCount(stone, ore) == 0 {
		t.Error("stone: placed nothing, want the rule to replace it")
	}

	air := oreAirWorld(pal)
	orePlace(buildTestOre(t, pal, oreTestBody(16, rule)), air, origin, random.New(7))
	if oreCount(air, ore) == 0 {
		t.Error("air: placed nothing, want the rule to replace air too")
	}
}

func TestOreFeature_ListedRuleStillOnlyMatchesItsList(t *testing.T) {
	pal := block.NewPalette()
	air := oreAirWorld(pal)
	orePlace(buildTestOre(t, pal, oreTestBody(16, oreTestOneRule())), air, wgen.BlockPos{X: 0, Y: 64, Z: 0}, random.New(7))
	if got := oreCount(air, pal.Get("minecraft:iron_ore", nil)); got != 0 {
		t.Errorf("placed %d blocks in air with may_replace [stone], want 0", got)
	}
}

func TestOreFeature_EmptyMayReplaceArrayIsALoadError(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Palette: pal, Identifier: "test:ore", FileID: "test:ore", Warn: func(string) {}}
	rule := []any{map[string]any{"places_block": "minecraft:iron_ore", "may_replace": []any{}}}
	if _, err := buildOreFeature(oreTestBody(16, rule), ctx); err == nil {
		t.Error("want an error for an empty may_replace array, got nil")
	}
}
