// single_block_enforce_test.go pins enforce_placement_rules and
// enforce_survivability_rules: both are real checks where feature rules run,
// both ask about the unrotated pick, and neither draws RNG. The per-block rules
// come from block/survive.go.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

func placeSBWithLog(f wgen.IFeature, ctx *wgen.PlacementContext) (*wgen.BlockPos, []string) {
	var msgs []string
	ctx.LogFailure = func(featureType, message string, pos wgen.BlockPos) { msgs = append(msgs, message) }
	return f.Place(ctx), msgs
}

func TestSingleBlock_EnforceSurvivability_PoppyNeedsVegetationGround(t *testing.T) {
	for _, below := range []string{"minecraft:grass_block", "minecraft:dirt", "minecraft:podzol",
		"minecraft:coarse_dirt", "minecraft:mycelium", "minecraft:dirt_with_roots", "minecraft:moss_block",
		"minecraft:pale_moss_block", "minecraft:mud", "minecraft:muddy_mangrove_roots", "minecraft:farmland"} {
		pal := block.NewPalette()
		f := buildSB(t, pal, map[string]any{
			"places_block":                "minecraft:poppy",
			"enforce_survivability_rules": true,
		})
		v := sbVolume(pal)
		v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get(below, nil))
		if got, msgs := placeSBWithLog(f, sbCtx(v)); got == nil {
			t.Errorf("poppy on %s: refused (%v), want placed", below, msgs)
		}
	}
	for _, below := range []string{"minecraft:stone", "minecraft:sand", "minecraft:air", "minecraft:gravel"} {
		pal := block.NewPalette()
		f := buildSB(t, pal, map[string]any{
			"places_block":                "minecraft:poppy",
			"enforce_survivability_rules": true,
		})
		v := sbVolume(pal)
		v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get(below, nil))
		got, msgs := placeSBWithLog(f, sbCtx(v))
		if got != nil {
			t.Errorf("poppy on %s: placed, want refused", below)
			continue
		}
		if len(msgs) != 1 || msgs[0] != "Block could not be placed given the enforced survivability rules" {
			t.Errorf("poppy on %s: failure %v, want the survivability message", below, msgs)
		}
	}
}

func TestSingleBlock_EnforceFlagsOff_PoppyPlacesAnywhere(t *testing.T) {
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{"places_block": "minecraft:poppy"})
	v := sbVolume(pal)
	v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get("minecraft:stone", nil))
	if f.Place(sbCtx(v)) == nil {
		t.Fatal("with both enforce flags off a poppy places on stone")
	}
}

func TestSingleBlock_EnforcePlacement_RunsFirstAndRefusesWater(t *testing.T) {
	pal := block.NewPalette()
	f := buildSB(t, pal, map[string]any{
		"places_block":                "minecraft:poppy",
		"enforce_placement_rules":     true,
		"enforce_survivability_rules": true,
	})
	// Stone below fails both; the placement check comes first.
	v := sbVolume(pal)
	v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get("minecraft:stone", nil))
	_, msgs := placeSBWithLog(f, sbCtx(v))
	if len(msgs) != 1 || msgs[0] != "Block could not be placed given the enforced placement rules" {
		t.Fatalf("failure %v, want the placement message first", msgs)
	}
	// Grass below, water in the cell: the placement check refuses.
	v = sbVolume(pal)
	v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get("minecraft:grass_block", nil))
	v.SetBlock(wgen.BlockPos{}, pal.Get("minecraft:water", nil))
	if got, _ := placeSBWithLog(f, sbCtx(v)); got != nil {
		t.Fatal("poppy into water with enforce_placement_rules: placed, want refused")
	}
	// Grass below, short grass in the cell (built over): placed.
	v = sbVolume(pal)
	v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get("minecraft:grass_block", nil))
	v.SetBlock(wgen.BlockPos{}, pal.Get("minecraft:short_grass", nil))
	if got, msgs := placeSBWithLog(f, sbCtx(v)); got == nil {
		t.Fatalf("poppy over short grass on grass: refused (%v), want placed", msgs)
	}
}

func TestSingleBlock_EnforceChecks_DrawNoRNG(t *testing.T) {
	pal := block.NewPalette()
	on := buildSB(t, pal, map[string]any{
		"places_block": []any{
			map[string]any{"block": "minecraft:poppy", "weight": float64(1)},
			map[string]any{"block": "minecraft:dandelion", "weight": float64(1)},
		},
		"enforce_placement_rules":     true,
		"enforce_survivability_rules": true,
	})
	off := buildSB(t, pal, map[string]any{
		"places_block": []any{
			map[string]any{"block": "minecraft:poppy", "weight": float64(1)},
			map[string]any{"block": "minecraft:dandelion", "weight": float64(1)},
		},
	})
	for _, below := range []string{"minecraft:grass_block", "minecraft:stone"} {
		count := func(f wgen.IFeature) int {
			v := sbVolume(pal)
			v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get(below, nil))
			tr := random.NewTracer(random.New(7))
			ctx := sbCtx(v)
			ctx.Random = tr
			f.Place(ctx)
			return len(tr.Draws)
		}
		if a, b := count(on), count(off); a != b {
			t.Errorf("on %s: %d draws with the checks on, %d with them off; the checks draw nothing", below, a, b)
		}
	}
}

func TestSingleBlock_EnforceOnUnmodelledBlock_WarnsAndPasses(t *testing.T) {
	pal := block.NewPalette()
	var warnings []string
	ctx := &BuildContext{Palette: pal, Resolver: condResolver{}, Identifier: "test:sb", FileID: "test:sb",
		Warn: func(m string) { warnings = append(warnings, m) }}
	f, err := buildSingleBlockFeature(map[string]any{
		"places_block":                "minecraft:red_mushroom",
		"enforce_placement_rules":     false,
		"enforce_survivability_rules": true,
	}, ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "does not model that block's rules") {
		t.Fatalf("warnings = %v, want one saying the rules are not modelled", warnings)
	}
	v := sbVolume(pal)
	v.SetBlock(wgen.BlockPos{Y: -1}, pal.Get("minecraft:stone", nil))
	if f.Place(sbCtx(v)) == nil {
		t.Fatal("an unmodelled block passes the checks")
	}

	// A modelled block, and a file with both flags off, stay silent.
	for _, body := range []map[string]any{
		{"places_block": "minecraft:poppy", "enforce_placement_rules": true, "enforce_survivability_rules": true},
		{"places_block": "minecraft:red_mushroom", "enforce_placement_rules": false, "enforce_survivability_rules": false},
	} {
		warnings = nil
		if _, err := buildSingleBlockFeature(body, ctx); err != nil {
			t.Fatal(err)
		}
		if len(warnings) != 0 {
			t.Errorf("%v: warnings %v, want none", body, warnings)
		}
	}
}
