package main

import (
	"os"
	"testing"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/rules"
)

func TestIdentifierFromJSON(t *testing.T) {
	t.Run("extracts identifier and type from a well-formed feature body", func(t *testing.T) {
		text := `{
			"format_version": "1.13.0",
			"minecraft:scatter_feature": {
				"description": {"identifier": "wiki:poplar_tree"}
			}
		}`
		id, typeID, err := identifierFromJSON(text)
		if err != nil {
			t.Fatalf("identifierFromJSON: %v", err)
		}
		if id != "wiki:poplar_tree" {
			t.Errorf("identifier = %q, want wiki:poplar_tree", id)
		}
		if typeID != "minecraft:scatter_feature" {
			t.Errorf("typeID = %q, want minecraft:scatter_feature", typeID)
		}
	})

	t.Run("skips format_version when it is not the first key", func(t *testing.T) {
		// Go's encoding/json into a map does not preserve source order -- identifierFromJSON
		// must still find the real type key regardless of where format_version lands.
		text := `{"minecraft:single_block_feature": {"description": {"identifier": "ns:leaf"}}, "format_version": "1.13.0"}`
		id, _, err := identifierFromJSON(text)
		if err != nil {
			t.Fatalf("identifierFromJSON: %v", err)
		}
		if id != "ns:leaf" {
			t.Errorf("identifier = %q, want ns:leaf", id)
		}
	})

	t.Run("rejects invalid JSON", func(t *testing.T) {
		if _, _, err := identifierFromJSON("not json"); err == nil {
			t.Fatal("expected an error for invalid JSON")
		}
	})

	t.Run("rejects a body with no type key besides format_version", func(t *testing.T) {
		if _, _, err := identifierFromJSON(`{"format_version": "1.13.0"}`); err == nil {
			t.Fatal("expected an error when there is no type key")
		}
	})

	t.Run("rejects a body missing description.identifier", func(t *testing.T) {
		text := `{"minecraft:scatter_feature": {"description": {}}}`
		if _, _, err := identifierFromJSON(text); err == nil {
			t.Fatal("expected an error for a missing identifier")
		}
	})

	// Direct regression test for the jsonc.StripComments pre-pass identifierFromJSON now runs:
	// a real vanilla-style file with a "//" comment must still yield its identifier/typeId
	// instead of erroring "not valid JSON", which used to make the pack item picker silently
	// omit the file (see listPackItems's own doc comment on how it treats a parse failure).
	t.Run("tolerates a jsonc comment", func(t *testing.T) {
		text := `{
			"format_version": "1.13.0",
			"minecraft:tree_feature": {
				// a vanilla-style comment
				"description": {"identifier": "minecraft:commented_tree_feature"}
			}
		}`
		id, typeID, err := identifierFromJSON(text)
		if err != nil {
			t.Fatalf("identifierFromJSON: %v", err)
		}
		if id != "minecraft:commented_tree_feature" {
			t.Errorf("identifier = %q, want minecraft:commented_tree_feature", id)
		}
		if typeID != "minecraft:tree_feature" {
			t.Errorf("typeID = %q, want minecraft:tree_feature", typeID)
		}
	})
}

func TestListPackItems(t *testing.T) {
	p := &pack.Pack{
		Features: []features.SourceFile{
			{ID: "poplar_tree.json", Text: `{"format_version":"1.13.0","minecraft:scatter_feature":{"description":{"identifier":"wiki:poplar_tree"}}}`},
			{ID: "broken.json", Text: `not json at all`},
		},
		Rules: []rules.SourceFile{
			{ID: "poplar_rule.json", Text: `{"format_version":"1.13.0","minecraft:feature_rules":{"description":{"identifier":"wiki:poplar_rule"}}}`},
		},
	}

	items := listPackItems(p)
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2 (the malformed feature file must be skipped, not fatal)", len(items))
	}
	// listPackItems sorts by (kind, identifier) -- "feature" < "rule" lexically.
	if items[0].Kind != PackItemFeature || items[0].Identifier != "wiki:poplar_tree" {
		t.Errorf("items[0] = %+v, want the poplar_tree feature", items[0])
	}
	if items[1].Kind != PackItemRule || items[1].Identifier != "wiki:poplar_rule" {
		t.Errorf("items[1] = %+v, want the poplar_rule rule", items[1])
	}
}

// fixturePackDir is the committed public fixture pack docs/wiki/tools/ builds the
// wiki images from -- a real on-disk pack, laid out exactly like any other
// (features/, feature_rules/, structures/), just small and in-repo. Pointing it at a
// committed pack means it runs everywhere rather than skipping, and makes it an
// actual end-to-end check that pack.Load ->
// listPackItems survives a directory read.
const fixturePackDir = `../../docs/wiki/tools/fixtures`

func TestListPackItems_FixturePack(t *testing.T) {
	if _, err := os.Stat(fixturePackDir); err != nil {
		t.Fatalf("committed fixture pack missing at %s: %v", fixturePackDir, err)
	}
	loaded, err := pack.Load(pack.Options{Dir: fixturePackDir})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}
	items := listPackItems(loaded)
	if len(items) == 0 {
		t.Fatal("expected at least one pack item from the fixture pack")
	}

	// Both kinds have to survive the round trip: the fixture pack has features/ AND
	// feature_rules/, and a listPackItems that dropped one kind entirely would still
	// pass a bare len(items) != 0 check.
	var sawFeature, sawRule bool
	for _, it := range items {
		switch {
		case it.Kind == PackItemFeature && it.Identifier == "wiki:poplar_tree":
			sawFeature = true
		case it.Kind == PackItemRule && it.Identifier == "wiki:rng_rule_a.fr":
			sawRule = true
		}
	}
	if !sawFeature {
		t.Errorf("expected feature wiki:poplar_tree among %d listed items", len(items))
	}
	if !sawRule {
		t.Errorf("expected rule wiki:rng_rule_a.fr among %d listed items", len(items))
	}

	// listPackItems sorts by (kind, identifier); every feature must precede every
	// rule, and identifiers must ascend within a kind.
	for i := 1; i < len(items); i++ {
		prev, cur := items[i-1], items[i]
		if prev.Kind == PackItemRule && cur.Kind == PackItemFeature {
			t.Fatalf("items[%d] is a rule but items[%d] is a feature -- kinds are not grouped", i-1, i)
		}
		if prev.Kind == cur.Kind && prev.Identifier >= cur.Identifier {
			t.Fatalf("items[%d].Identifier=%q >= items[%d].Identifier=%q -- not sorted within kind",
				i-1, prev.Identifier, i, cur.Identifier)
		}
	}
}
