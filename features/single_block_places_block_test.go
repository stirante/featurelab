// single_block_places_block_test.go covers places_block's PARSE surface -- the shapes it accepts
// and, more usefully, the two it accepts that the engine's own schema does not. The attach and
// rotation semantics live in single_block_attach_test.go.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
)

// TestParseCandidates_WarnsOnShapesTheEngineWouldRefuse pins two shapes this tool reads happily
// and the engine's schema does not: an array entry with no `weight`, and an array entry that is a
// bare block descriptor rather than a {block, weight} pair. Both are read at weight 1 here.
//
// The DIRECTION is what makes these worth a diagnostic. Being more permissive than the game means
// a file that previews perfectly and then fails to load in the world -- and the author has no
// reason to suspect the file, because the tool whose whole job is to check it said nothing.
func TestParseCandidates_WarnsOnShapesTheEngineWouldRefuse(t *testing.T) {
	parse := func(raw any) ([]candidate, []string) {
		t.Helper()
		var warnings []string
		got, err := parseCandidates(raw, "places_block", func(m string) { warnings = append(warnings, m) })
		if err != nil {
			t.Fatalf("parseCandidates(%v): %v", raw, err)
		}
		return got, warnings
	}

	t.Run("object entry with no weight", func(t *testing.T) {
		got, warnings := parse([]any{map[string]any{"block": "minecraft:stone"}})
		if len(got) != 1 || got[0].weight != 1 {
			t.Fatalf("want one candidate at weight 1, got %+v", got)
		}
		if len(warnings) != 1 || !strings.Contains(warnings[0], "requires it") {
			t.Fatalf("want one warning saying the engine requires weight, got %v", warnings)
		}
	})

	t.Run("bare descriptor inside an array", func(t *testing.T) {
		got, warnings := parse([]any{"minecraft:stone"})
		if len(got) != 1 || got[0].weight != 1 {
			t.Fatalf("want one candidate at weight 1, got %+v", got)
		}
		if len(warnings) != 1 {
			t.Fatalf("want one warning, got %v", warnings)
		}
	})

	t.Run("the shapes the engine accepts stay quiet", func(t *testing.T) {
		if _, warnings := parse("minecraft:stone"); len(warnings) != 0 {
			t.Errorf("a lone descriptor is the single-candidate spelling and must not warn: %v", warnings)
		}
		if _, warnings := parse([]any{
			map[string]any{"block": "minecraft:stone", "weight": 3.0},
			map[string]any{"block": "minecraft:dirt", "weight": 1.0},
		}); len(warnings) != 0 {
			t.Errorf("a full {block, weight} array must not warn: %v", warnings)
		}
	})

	t.Run("one warning per offending entry, not one per file", func(t *testing.T) {
		_, warnings := parse([]any{
			map[string]any{"block": "minecraft:stone"},
			map[string]any{"block": "minecraft:dirt", "weight": 2.0},
			"minecraft:gravel",
		})
		if len(warnings) != 2 {
			t.Fatalf("want a warning for entry 0 and entry 2 only, got %d: %v", len(warnings), warnings)
		}
		if !strings.Contains(warnings[0], "[0]") || !strings.Contains(warnings[1], "[2]") {
			t.Errorf("warnings must name the entry they are about: %v", warnings)
		}
	})
}

// TestBuildSingleBlock_MinSidesMustAttach_IsTranscribedNotRepaired pins the policy, not just the
// values. This field used to be REFUSED when negative or fractional, which is this tool inventing
// a constraint the engine does not have -- and it is the same shape as
// constraints.leveled.max_steepness, which the same codebase deliberately transcribes with a
// warning for exactly that reason. Two structurally identical fields taking opposite policies is
// how a rule stops being a rule.
func TestBuildSingleBlock_MinSidesMustAttach_IsTranscribedNotRepaired(t *testing.T) {
	build := func(value any) (*SingleBlockFeature, []string) {
		t.Helper()
		var warnings []string
		ctx := &BuildContext{
			Palette: block.NewPalette(), Identifier: "test:b", FileID: "b.json",
			Warn: func(m string) { warnings = append(warnings, m) },
		}
		body := map[string]any{
			"description":                 map[string]any{"identifier": "test:b"},
			"places_block":                "minecraft:stone",
			"enforce_placement_rules":     true,
			"enforce_survivability_rules": true,
			"may_attach_to":               map[string]any{"min_sides_must_attach": value},
		}
		built, err := buildSingleBlockFeature(body, ctx)
		if err != nil {
			t.Fatalf("min_sides_must_attach %v: refused (%v) -- this field is transcribed, not repaired", value, err)
		}
		return built.(*SingleBlockFeature), warnings
	}

	t.Run("a negative value is carried through", func(t *testing.T) {
		f, warnings := build(-1.0)
		if f.minSidesMustAttach != -1 {
			t.Errorf("minSidesMustAttach = %d, want -1 (clamping is what the engine does NOT do)", f.minSidesMustAttach)
		}
		if len(warnings) != 1 || !strings.Contains(warnings[0], "passes everywhere") {
			t.Fatalf("want one warning saying what a negative value actually does, got %v", warnings)
		}
	})

	t.Run("a fractional value truncates toward zero and says so", func(t *testing.T) {
		f, warnings := build(2.7)
		if f.minSidesMustAttach != 2 {
			t.Errorf("minSidesMustAttach = %d, want 2 -- reading a JSON number into an int truncates", f.minSidesMustAttach)
		}
		if len(warnings) != 1 || !strings.Contains(warnings[0], "truncates") {
			t.Fatalf("want one warning about truncation, got %v", warnings)
		}
	})

	t.Run("an ordinary value is silent and lands", func(t *testing.T) {
		f, warnings := build(3.0)
		if f.minSidesMustAttach != 3 {
			t.Errorf("minSidesMustAttach = %d, want 3", f.minSidesMustAttach)
		}
		if len(warnings) != 0 {
			t.Errorf("a legal value must not warn, got %v", warnings)
		}
	})

	t.Run("a non-number is still an error", func(t *testing.T) {
		ctx := &BuildContext{Palette: block.NewPalette(), Identifier: "test:b", FileID: "b.json", Warn: func(string) {}}
		_, err := buildSingleBlockFeature(map[string]any{
			"description":                 map[string]any{"identifier": "test:b"},
			"places_block":                "minecraft:stone",
			"enforce_placement_rules":     true,
			"enforce_survivability_rules": true,
			"may_attach_to":               map[string]any{"min_sides_must_attach": "four"},
		}, ctx)
		if err == nil {
			t.Error("a string is not a number in any schema -- that one really is a load error")
		}
	})
}
