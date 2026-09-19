package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
)

// TestCheckBlockNames_FindsCaveAirWhereverItHides is the whole point of doing this as a walk
// rather than per-field: the name is caught in a bare string, in a list, in a {name,states}
// object and three levels down inside a nested object, without any of those parsers knowing
// about it.
func TestCheckBlockNames_FindsCaveAirWhereverItHides(t *testing.T) {
	cases := map[string]map[string]any{
		"bare string field": {"fill_with": "minecraft:cave_air"},
		"inside a list":     {"may_replace": []any{"minecraft:air", "minecraft:cave_air"}},
		"inside {name}":     {"places_block": map[string]any{"name": "minecraft:cave_air"}},
		"three levels down": {"constraints": map[string]any{
			"block_intersection": map[string]any{
				"block_allowlist": []any{map[string]any{"name": "minecraft:cave_air"}},
			},
		}},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			var diags []Diagnostic
			checkBlockNames("f.json", "wiki:x", body, &diags)
			if len(diags) != 1 {
				t.Fatalf("want exactly one diagnostic, got %d: %v", len(diags), diags)
			}
			if diags[0].Level != "warning" {
				t.Errorf("level = %q, want warning -- the name is inert in the real game, not a load failure", diags[0].Level)
			}
			if !strings.Contains(diags[0].Message, "minecraft:air") {
				t.Errorf("the diagnostic does not name the replacement: %q", diags[0].Message)
			}
		})
	}
}

// TestCheckBlockNames_ReportsEachNameOncePerFile: a carver that writes cave_air in fill_with is
// likely to write it in may_replace too, and three copies of one sentence is how a real
// diagnostic gets scrolled past.
func TestCheckBlockNames_ReportsEachNameOncePerFile(t *testing.T) {
	var diags []Diagnostic
	checkBlockNames("f.json", "wiki:x", map[string]any{
		"fill_with":    "minecraft:cave_air",
		"may_replace":  []any{"minecraft:cave_air"},
		"places_block": map[string]any{"name": "minecraft:cave_air"},
	}, &diags)
	if len(diags) != 1 {
		t.Fatalf("want one diagnostic for three occurrences of one name, got %d", len(diags))
	}
}

// TestCheckBlockNames_LeavesRealBlocksAlone. A false positive here tells someone to change JSON
// that works, so the negative case is worth as much as the positive one -- including the two
// air blocks that ARE real and the name this one is easily confused with.
func TestCheckBlockNames_LeavesRealBlocksAlone(t *testing.T) {
	var diags []Diagnostic
	checkBlockNames("f.json", "wiki:x", map[string]any{
		"fill_with":   "minecraft:air",
		"may_replace": []any{"minecraft:void_air", "minecraft:water", "minecraft:stone"},
		"description": map[string]any{"identifier": "wiki:cave_air_demo"},
	}, &diags)
	if len(diags) != 0 {
		t.Fatalf("want no diagnostics, got %v", diags)
	}
}

// ---------------------------------------------------------------------------
// The generic "this is not a block" warning
// ---------------------------------------------------------------------------

// TestBuildLibrary_AnUnknownBlockNameIsAWarningNamingWhereItLooked is the
// critic's second file: `places_block: "not even an id"` reached disk and check
// said nothing at all. It is free text in the JSON, so nothing structural can
// object -- the only thing that can is the block table.
func TestBuildLibrary_AnUnknownBlockNameIsAWarningNamingWhereItLooked(t *testing.T) {
	const text = `{"format_version":"1.21.110","minecraft:single_block_feature":{
		"description":{"identifier":"wiki:x"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"places_block":"not even an id"}}`
	lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: text}}, block.NewPalette(), nil)

	var found *Diagnostic
	for i, d := range lib.Diagnostics {
		if strings.Contains(d.Message, "not a block this engine knows") {
			found = &lib.Diagnostics[i]
		}
	}
	if found == nil {
		t.Fatalf("an unparseable block name produced no diagnostic; got %+v", lib.Diagnostics)
	}
	if found.Level != "warning" {
		t.Errorf("level = %q, want warning -- a pack may declare its own blocks and a name may come from another add-on", found.Level)
	}
	if !strings.Contains(found.Message, "not even an id") {
		t.Errorf("the diagnostic does not quote the name: %q", found.Message)
	}
	// "Say what it looked in" -- a reader who cannot act on the row is worse off
	// than one who was never told.
	for _, where := range []string{"vanilla block catalogue", "blocks/ directory"} {
		if !strings.Contains(found.Message, where) {
			t.Errorf("the diagnostic does not say it consulted the %s: %q", where, found.Message)
		}
	}
	// It is a warning, so the feature still builds.
	if lib.Resolve("wiki:x") == nil {
		t.Error("the feature did not build -- an unknown block name must not delete the feature")
	}
}

// TestBuildLibrary_RealBlockNamesAreSilent is the half that keeps the channel
// worth reading. Vanilla in both its spellings, a legacy aggregate, and a block
// this pack declares itself.
func TestBuildLibrary_RealBlockNamesAreSilent(t *testing.T) {
	pal := block.NewPalette()
	pal.LoadBlockTags([]block.SourceFile{{ID: "custom.json", Text: `{
		"format_version":"1.21.70",
		"minecraft:block":{"description":{"identifier":"wiki:custom_ore"},"components":{}}
	}`}})
	const text = `{"format_version":"1.21.110","minecraft:single_block_feature":{
		"description":{"identifier":"wiki:x"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"places_block":"wiki:custom_ore","may_replace":["minecraft:diamond_block","stone","minecraft:air"]}}`
	lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: text}}, pal, nil)
	for _, d := range lib.Diagnostics {
		if strings.Contains(d.Message, "not a block this engine knows") {
			t.Errorf("a real block name was reported as unknown: %q", d.Message)
		}
	}
}

// TestBuildLibrary_UnknownNameIsChargedToTheFileThatWroteIt: the palette is
// shared across a whole pack build, so the set has to drain per file or the
// second file's mistake is reported against the first.
func TestBuildLibrary_UnknownNameIsChargedToTheFileThatWroteIt(t *testing.T) {
	fine := `{"format_version":"1.21.110","minecraft:single_block_feature":{
		"description":{"identifier":"wiki:a"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"places_block":"minecraft:stone"}}`
	broken := `{"format_version":"1.21.110","minecraft:single_block_feature":{
		"description":{"identifier":"wiki:b"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"places_block":"wiki:nope"}}`
	lib := BuildLibrary([]SourceFile{
		{ID: "a.json", Text: fine},
		{ID: "b.json", Text: broken},
	}, block.NewPalette(), nil)
	for _, d := range lib.Diagnostics {
		if !strings.Contains(d.Message, "not a block this engine knows") {
			continue
		}
		if d.FileID != "b.json" {
			t.Errorf("the unknown name was charged to %q, want b.json", d.FileID)
		}
	}
}

// TestBuildLibrary_CaveAirKeepsItsOwnSentenceAndDoesNotGetTwo: cave_air is in no
// block table either, so both checks see it. The specific one is more useful and
// the generic one stands down -- one problem reported twice reads as two.
func TestBuildLibrary_CaveAirKeepsItsOwnSentenceAndDoesNotGetTwo(t *testing.T) {
	const text = `{"format_version":"1.21.110","minecraft:single_block_feature":{
		"description":{"identifier":"wiki:x"},"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"places_block":"minecraft:cave_air"}}`
	lib := BuildLibrary([]SourceFile{{ID: "f.json", Text: text}}, block.NewPalette(), nil)
	var specific, generic int
	for _, d := range lib.Diagnostics {
		if strings.Contains(d.Message, "not a block on Bedrock") {
			specific++
		}
		if strings.Contains(d.Message, "not a block this engine knows") {
			generic++
		}
	}
	if specific != 1 {
		t.Errorf("cave_air's own diagnostic count = %d, want 1", specific)
	}
	if generic != 0 {
		t.Errorf("cave_air also got the generic diagnostic %d time(s) -- one problem, one row", generic)
	}
}
