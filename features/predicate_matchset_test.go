// predicate_matchset_test.go is the feature-level regression coverage for
// the may_replace/{"tags": ...} predicate fix (see block/tags.go and
// ResolveMatchSet in shared.go): building and PLACING a real
// minecraft:single_block_feature, rather than exercising block.MatchSet in
// isolation (block/tags_test.go already does that).
//
// The three JSON bodies below are synthetic, each in the shape of a common
// add-on pattern -- an "air shaver": a
// single_block_feature that places minecraft:air with both enforcement
// flags off, an EMPTY may_attach_to object, and a may_replace expressed as
// a one-element array of {"tags": "!q.any_tag(...)"} rather than a bare
// block-name list. That negated-object form is the whole point; flattening
// it to a plain may_replace list would delete the case.
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// waterSafeShaverJSON is an air shaver excluding a VANILLA tag ("water"),
// so its predicate resolves against the curated approximate vanilla tag
// table rather than any loaded pack data.
const waterSafeShaverJSON = `{
    "format_version": "1.21.110",
    "minecraft:single_block_feature": {
        "description": {
            "identifier": "wiki:blast_crater.clear_block"
        },
        "places_block": "minecraft:air",
        "enforce_placement_rules": false,
        "enforce_survivability_rules": false,
        "may_replace": [
            {
                "tags": "!q.any_tag('water')"
            }
        ],
        "may_attach_to": {}
    }
}`

// customTagShaverJSON is the same shape, but excluding a CUSTOM
// pack-namespaced tag that exists nowhere in the curated vanilla table --
// it can only resolve through Palette.LoadBlockTags reading the block
// definition below. The dotted ".f" identifier suffix is kept because real
// packs use one and it must survive identifier parsing.
const customTagShaverJSON = `{
    "format_version": "1.21.110",
    "minecraft:single_block_feature": {
        "description": {
            "identifier": "wiki:brine_safe_air_shaver.f"
        },
        "places_block": "minecraft:air",
        "enforce_placement_rules": false,
        "enforce_survivability_rules": false,
        "may_replace": [
            {
                "tags": "!q.any_tag('wiki:brine_shaver_excluded')"
            }
        ],
        "may_attach_to": {}
    }
}`

// brineCrystalBlockJSON is the only declaration of
// wiki:brine_shaver_excluded anywhere. It carries a custom-namespaced tag
// component ALONGSIDE a vanilla-namespaced one, because that mix is what a
// real blocks/*.json looks like and LoadBlockTags has to pick up both
// without being confused by the namespace in the tag name.
const brineCrystalBlockJSON = `{
    "minecraft:block": {
        "description": {"identifier": "wiki:brine_crystal"},
        "components": {
            "tag:wiki:brine_shaver_excluded": {},
            "tag:minecraft:is_pickaxe_item_destructible": {}
        }
    }
}`

// placeSingleBlockAt builds a 1-cell volume whose only block is existing,
// places feature at that cell, and returns whether it succeeded and what
// ended up there.
func placeSingleBlockAt(t *testing.T, feature wgen.IFeature, palette *block.Palette, existing block.ID) (placed bool, final block.ID) {
	t.Helper()
	v := volume.New(volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 1, SizeY: 1, SizeZ: 1}, palette, block.AirID)
	origin := wgen.BlockPos{X: 0, Y: 0, Z: 0}
	v.SetBlock(origin, existing)

	ctx := &wgen.PlacementContext{
		API: v, Origin: origin, Random: random.New(1), MolangScope: wgen.NewScope(),
	}
	result := feature.Place(ctx)
	return result != nil, v.GetBlock(origin)
}

// TestWaterSafeShaver_ReplacesNonWaterBlocks is the direct regression test
// for the reported bug: a may_replace of `!q.any_tag('water')` was
// resolving to "replace only air" (0 real blocks ever cleared on solid
// ground). After the fix it must
// replace any non-water block, and must still refuse to replace water.
func TestWaterSafeShaver_ReplacesNonWaterBlocks(t *testing.T) {
	palette := block.NewPalette()
	lib := BuildLibrary([]SourceFile{{ID: "blast_crater.clear_block.json", Text: waterSafeShaverJSON}}, palette, nil)
	if len(lib.Diagnostics) != 0 {
		t.Fatalf("build diagnostics = %+v, want none", lib.Diagnostics)
	}
	feature := lib.Resolve("wiki:blast_crater.clear_block")
	if feature == nil {
		t.Fatal("wiki:blast_crater.clear_block did not resolve")
	}

	stoneID := palette.Get("minecraft:stone", nil)
	if placed, final := placeSingleBlockAt(t, feature, palette, stoneID); !placed || final != block.AirID {
		t.Errorf("placing on minecraft:stone: placed=%v final=%v, want placed=true final=air -- "+
			"this is the bug: it used to only ever replace air", placed, final)
	}

	waterID := palette.Get("minecraft:water", nil)
	if placed, final := placeSingleBlockAt(t, feature, palette, waterID); placed || final != waterID {
		t.Errorf("placing on minecraft:water: placed=%v final=%v, want placed=false final=water (water must stay excluded)", placed, final)
	}

	// Air itself must still be replaceable (air is not water either) --
	// this is the one case the OLD buggy code got right, by accident.
	if placed, final := placeSingleBlockAt(t, feature, palette, block.AirID); !placed || final != block.AirID {
		t.Errorf("placing on minecraft:air: placed=%v final=%v, want placed=true final=air", placed, final)
	}
}

// TestCustomTagShaver_RespectsCustomPackTag is the direct regression
// test for wiki:brine_safe_air_shaver.f, which excludes a
// PACK-declared custom tag ("wiki:brine_shaver_excluded",
// declared only on wiki:brine_crystal) rather than a vanilla one --
// exercising LoadBlockTags, not the curated approximate table.
func TestCustomTagShaver_RespectsCustomPackTag(t *testing.T) {
	palette := block.NewPalette()
	if diags := palette.LoadBlockTags([]block.SourceFile{
		{ID: "brine/brine_crystal.b.json", Text: brineCrystalBlockJSON},
	}); len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}

	lib := BuildLibrary([]SourceFile{{ID: "brine_safe_air_shaver.f.json", Text: customTagShaverJSON}}, palette, nil)
	if len(lib.Diagnostics) != 0 {
		t.Fatalf("build diagnostics = %+v, want none", lib.Diagnostics)
	}
	feature := lib.Resolve("wiki:brine_safe_air_shaver.f")
	if feature == nil {
		t.Fatal("wiki:brine_safe_air_shaver.f did not resolve")
	}

	brineCrystalID := palette.Get("wiki:brine_crystal", nil)
	if placed, final := placeSingleBlockAt(t, feature, palette, brineCrystalID); placed || final != brineCrystalID {
		t.Errorf("placing on wiki:brine_crystal: placed=%v final=%v, want placed=false (pack-tagged excluded)", placed, final)
	}

	stoneID := palette.Get("minecraft:stone", nil)
	if placed, final := placeSingleBlockAt(t, feature, palette, stoneID); !placed || final != block.AirID {
		t.Errorf("placing on minecraft:stone: placed=%v final=%v, want placed=true final=air (not pack-tagged excluded)", placed, final)
	}
}

// TestResolveMatchSet_UnknownTagDiagnostic_NamesFeatureAndTag proves the
// "never silently guessed" requirement: a tag literal resolvable from
// neither real pack data nor the curated approximate table must surface as
// a build diagnostic naming BOTH the feature and the tag, not just get
// treated as "never present" with no trace.
func TestResolveMatchSet_UnknownTagDiagnostic_NamesFeatureAndTag(t *testing.T) {
	palette := block.NewPalette()
	body := `{
        "format_version": "1.21.110",
        "minecraft:single_block_feature": {
            "description": {"identifier": "test:unknown_tag_feature"},
            "places_block": "minecraft:air",
            "may_replace": [{"tags": "q.any_tag('totally_unknown_made_up_tag')"}]
        }
    }`
	lib := BuildLibrary([]SourceFile{{ID: "unknown_tag_feature.json", Text: body}}, palette, nil)

	found := false
	for _, d := range lib.Diagnostics {
		if d.Level != "warning" {
			continue
		}
		if containsAll(d.Message, "test:unknown_tag_feature", "totally_unknown_made_up_tag", "may_replace") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a warning diagnostic naming the feature, field, and unresolved tag; got %+v", lib.Diagnostics)
	}
}

func containsAll(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if !contains(s, sub) {
			return false
		}
	}
	return true
}

func contains(s, sub string) bool {
	return len(sub) == 0 || indexOf(s, sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
