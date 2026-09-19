package features

// empty_block_descriptor_test.go pins the ONE refusal AsBlockDescriptor makes on
// behalf of every field that takes a block: a block name that is not a name.
//
// The measurement behind it: an editor's `+` on a weighted places_block writes
// `[{"block": "", "weight": 1}]`, which is structurally perfect JSON, satisfies
// the weighted-array shape, and places nothing. `places_block: []` was already
// refused; the row an editor actually produces was not, so pressing the button
// and saving gave a clean `check` on a dead file.

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
)

// TestAsBlockDescriptor_EmptyNameIsRefused_InEveryFormItCanBeWritten covers the
// three spellings a descriptor has. All three are the same mistake and all three
// have to be the same answer -- an author who learns that `""` is refused and
// `{"name": ""}` is not has learned something worse than nothing.
func TestAsBlockDescriptor_EmptyNameIsRefused_InEveryFormItCanBeWritten(t *testing.T) {
	cases := map[string]any{
		"bare empty string":      "",
		"whitespace only":        "   ",
		"{name: \"\"}":           map[string]any{"name": ""},
		"{name} with states":     map[string]any{"name": "", "states": map[string]any{"direction": 1.0}},
		"{tags: \"\"}":           map[string]any{"tags": ""},
		"{tags} whitespace only": map[string]any{"tags": " "},
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := AsBlockDescriptor(value, "places_block")
			if err == nil {
				t.Fatal("an empty block descriptor was accepted -- it resolves to no block, so the field it was written in does nothing")
			}
			if !strings.Contains(err.Error(), "places_block") {
				t.Errorf("the error does not name the field: %q", err)
			}
		})
	}
}

// TestParseCandidates_EmptyBlockInAWeightedEntryIsAnError is the critic's exact
// file: the array shape is right, the weight is right, and the block is the
// empty string an editor left behind.
func TestParseCandidates_EmptyBlockInAWeightedEntryIsAnError(t *testing.T) {
	raw := []any{map[string]any{"block": "", "weight": 1.0}}
	_, err := parseCandidates(raw, "places_block", nil)
	if err == nil {
		t.Fatal("places_block: [{\"block\": \"\", \"weight\": 1}] was accepted -- this is the row the editor's + writes and it places nothing")
	}
	if !strings.Contains(err.Error(), "places_block[0].block") {
		t.Errorf("the error should point at the entry's own block field, got %q", err)
	}
}

// TestParseCandidates_EmptyBareStringIsAnError: the same field also accepts a
// bare string, and that spelling used to go straight to block.NameDescriptor,
// which takes anything at all.
func TestParseCandidates_EmptyBareStringIsAnError(t *testing.T) {
	if _, err := parseCandidates("", "places_block", nil); err == nil {
		t.Fatal(`places_block: "" was accepted`)
	}
}

// TestBuildLibrary_EmptyBlockNameIsAnErrorInEveryFieldThatTakesOne is the pass
// the brief asked for: not places_block alone, but every field a block
// descriptor reaches -- which is all of them at once, because they share one
// parser. Each fixture is a real feature document, built through the real
// library, so a field that had its own private parsing would show up here as a
// pass.
func TestBuildLibrary_EmptyBlockNameIsAnErrorInEveryFieldThatTakesOne(t *testing.T) {
	cases := map[string]string{
		"places_block (weighted entry)": `{"format_version":"1.21.110","minecraft:single_block_feature":{
			"description":{"identifier":"wiki:x"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
			"places_block":[{"block":"","weight":1}]}}`,
		"may_replace": `{"format_version":"1.21.110","minecraft:single_block_feature":{
			"description":{"identifier":"wiki:x"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
			"places_block":"minecraft:stone","may_replace":[""]}}`,
		"may_attach_to face": `{"format_version":"1.21.110","minecraft:single_block_feature":{
			"description":{"identifier":"wiki:x"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
			"places_block":"minecraft:stone","may_attach_to":{"top":""}}}`,
		"may_grow_on": `{"format_version":"1.21.110","minecraft:tree_feature":{
			"description":{"identifier":"wiki:x"},"may_grow_on":[""],
			"trunk":{"trunk_block":"minecraft:oak_log","trunk_height":5},
			"canopy":{"leaf_block":"minecraft:oak_leaves","canopy_offset":{"min":0,"max":0}}}}`,
		"base_block": `{"format_version":"1.21.110","minecraft:tree_feature":{
			"description":{"identifier":"wiki:x"},"base_block":"",
			"trunk":{"trunk_block":"minecraft:oak_log","trunk_height":5},
			"canopy":{"leaf_block":"minecraft:oak_leaves","canopy_offset":{"min":0,"max":0}}}}`,
		"ore replace_rules may_replace": `{"format_version":"1.21.110","minecraft:ore_feature":{
			"description":{"identifier":"wiki:x"},"count":4,
			"replace_rules":[{"places_block":"minecraft:iron_ore","may_replace":[""]}]}}`,
		"snap_to_surface allowed_surface_blocks": `{"format_version":"1.21.110","minecraft:snap_to_surface_feature":{
			"description":{"identifier":"wiki:x"},"feature_to_snap":"wiki:v","vertical_search_range":8,
			"allowed_surface_blocks":[""]}}`,
		"vegetation_patch ground_block": `{"format_version":"1.21.110","minecraft:vegetation_patch_feature":{
			"description":{"identifier":"wiki:x"},"ground_block":"","vegetation_feature":"wiki:v",
			"replaceable_blocks":["minecraft:air"],
			"surface":"floor","depth":1,"vertical_range":2,"vegetation_chance":1,"horizontal_radius":1,"extra_edge_column":0}}`,
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: text}}, block.NewPalette(), nil)
			var found bool
			for _, d := range lib.Diagnostics {
				if d.Level == "error" && strings.Contains(d.Message, "empty block name") {
					found = true
				}
			}
			if !found {
				t.Fatalf("an empty block name in this field was not refused; diagnostics = %+v", lib.Diagnostics)
			}
		})
	}
}
