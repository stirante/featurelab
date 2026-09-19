package wire

import (
	"strings"
	"testing"
)

// A dangling edge in the graph editor is the same failure as "not defined by the loaded pack" on
// the command line, and the commonest cause is the same: the reference was written without its
// namespace. It gets the same near-match treatment.
func TestCheckGraph_UnresolvedTargetOffersTheNamespacedMatch(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{
			{ID: "wiki:parent", TypeID: "minecraft:scatter_feature", File: "parent.json"},
			{ID: "wiki:rng_marker", TypeID: "minecraft:single_block_feature", File: "marker.json"},
			{ID: "rng_marker", Unresolved: true},
		},
		Edges: []GraphEdge{
			{From: "wiki:parent", To: "rng_marker", Kind: EdgeScatter, JSONPath: "$.a", Required: true},
		},
		Roots: []string{"wiki:parent"},
	}
	msg := findCheckMessage(t, g, "no loaded file defines")
	if !strings.Contains(msg, `did you mean "wiki:rng_marker"`) {
		t.Errorf("message = %q, want the namespaced target offered", msg)
	}
}

// The candidate list is the ids the pack DEFINES. Another dangling reference is not a candidate:
// suggesting one broken name in place of another would be worse than saying nothing.
func TestCheckGraph_UnresolvedTargetsAreNotSuggestedToEachOther(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{
			{ID: "wiki:parent", TypeID: "minecraft:scatter_feature", File: "parent.json"},
			{ID: "rng_marker", Unresolved: true},
			{ID: "wiki:rng_marker", Unresolved: true},
		},
		Edges: []GraphEdge{
			{From: "wiki:parent", To: "rng_marker", Kind: EdgeScatter, JSONPath: "$.a", Required: true},
		},
		Roots: []string{"wiki:parent"},
	}
	msg := findCheckMessage(t, g, "no loaded file defines")
	if strings.Contains(msg, "did you mean") {
		t.Errorf("message = %q, want no suggestion drawn from another unresolved reference", msg)
	}
}

// A reference the GAME provides is not a broken one, and must keep its own message -- 13 of 3531
// nodes on one real pack are these, and telling their authors to check the spelling of correctly
// spelled names is how a tool teaches people to stop reading its warnings.
func TestCheckGraph_GameProvidedTargetIsStillNotAnError(t *testing.T) {
	g := &Graph{
		Nodes: []GraphNode{
			{ID: "wiki:parent", TypeID: "minecraft:scatter_feature", File: "parent.json"},
			{ID: "minecraft:bush_feature", Unresolved: true, External: true},
		},
		Edges: []GraphEdge{
			{From: "wiki:parent", To: "minecraft:bush_feature", Kind: EdgeScatter, JSONPath: "$.a", Required: true},
		},
		Roots: []string{"wiki:parent"},
	}
	msg := findCheckMessage(t, g, "the game provides")
	if strings.Contains(msg, "did you mean") {
		t.Errorf("message = %q, want no correction for a name that is spelled correctly", msg)
	}
}

func findCheckMessage(t *testing.T, g *Graph, contains string) string {
	t.Helper()
	for _, d := range CheckGraph(g) {
		if strings.Contains(d.Message, contains) {
			return d.Message
		}
	}
	t.Fatalf("no diagnostic containing %q, got %+v", contains, CheckGraph(g))
	return ""
}
