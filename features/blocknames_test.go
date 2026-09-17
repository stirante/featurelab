package features

import (
	"strings"
	"testing"
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
