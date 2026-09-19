package wire

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/volume"
)

// TestOmitCoverageNotes_ClearsOnlyTheNote pins the shape of the largest duplication in the graph
// contract -- see GraphNode.Coverage for the measurement. Coverage itself stays: it is one short
// word and it is the half an editor acts on.
func TestOmitCoverageNotes_ClearsOnlyTheNote(t *testing.T) {
	g := &Graph{Nodes: []GraphNode{
		{ID: "wiki:a", TypeID: "minecraft:tree_feature", Coverage: "partial", CoverageNote: "a long paragraph"},
		{ID: "wiki:b", TypeID: "minecraft:aggregate_feature", Coverage: "implemented"},
	}}
	OmitCoverageNotes(g)
	for _, n := range g.Nodes {
		if n.CoverageNote != "" {
			t.Errorf("node %s kept a coverageNote", n.ID)
		}
	}
	if g.Nodes[0].Coverage != "partial" || g.Nodes[1].Coverage != "implemented" {
		t.Errorf("coverage was cleared too: %+v", g.Nodes)
	}
}

// The field is omitempty, so clearing it removes the key rather than sending an empty string --
// which is the whole size win.
func TestOmitCoverageNotes_RemovesTheKeyFromTheWire(t *testing.T) {
	g := &Graph{Nodes: []GraphNode{{ID: "wiki:a", CoverageNote: strings.Repeat("x", 1000)}}}
	before, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	OmitCoverageNotes(g)
	after, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(after), "coverageNote") {
		t.Errorf("coverageNote key survived: %s", after)
	}
	if len(after) >= len(before) {
		t.Errorf("payload did not shrink: %d -> %d", len(before), len(after))
	}
}

func TestOmitCoverageNotes_NilGraph(t *testing.T) {
	OmitCoverageNotes(nil) // must not panic
}

// TestOmitPackDiagnostics_KeepsOnlyTheRunScopedOnes is the generate-path counterpart: a
// pack-scoped diagnostic is a fact about the pack, cannot change between two generates, and was
// already delivered by loadPack.
func TestOmitPackDiagnostics_KeepsOnlyTheRunScopedOnes(t *testing.T) {
	result := &session.Result{Diagnostics: []session.Diagnostic{
		{Level: "warning", Scope: session.ScopePack, FileID: "a.json", Message: "pack one"},
		{Level: "error", Scope: session.ScopeRun, FileID: "wiki:x", Message: "run one"},
		{Level: "warning", Scope: session.ScopePack, FileID: "b.json", Message: "pack two"},
		{Level: "warning", Scope: session.ScopeRun, FileID: "wiki:y", Message: "run two"},
	}}
	out := wrapGenerateOutput(session.Config{}, resultWithVolume(t, result), GenerateParams{OmitPackDiagnostics: true})
	if len(out.Diagnostics) != 2 {
		t.Fatalf("Diagnostics = %+v, want the two run-scoped entries", out.Diagnostics)
	}
	// Order is preserved: a client rendering "what happened in this run" sees exactly what it saw
	// before, with fewer entries around it.
	if out.Diagnostics[0].Message != "run one" || out.Diagnostics[1].Message != "run two" {
		t.Errorf("Diagnostics = %+v, want run one then run two", out.Diagnostics)
	}
}

// Off by default: a caller that has not been taught about the flag gets the complete response it
// always got.
func TestOmitPackDiagnostics_IsOffByDefault(t *testing.T) {
	result := &session.Result{Diagnostics: []session.Diagnostic{
		{Level: "warning", Scope: session.ScopePack, Message: "pack one"},
		{Level: "warning", Scope: session.ScopeRun, Message: "run one"},
	}}
	out := wrapGenerateOutput(session.Config{}, resultWithVolume(t, result), GenerateParams{})
	if len(out.Diagnostics) != 2 {
		t.Errorf("Diagnostics = %+v, want both kinds by default", out.Diagnostics)
	}
}

// `diagnostics` is not omitempty, so dropping every entry must still serialise as [] -- a client
// walking the list must not have to tell null from [] because it asked for fewer of them.
func TestOmitPackDiagnostics_EmptyIsAnArrayNotNull(t *testing.T) {
	result := &session.Result{Diagnostics: []session.Diagnostic{
		{Level: "warning", Scope: session.ScopePack, Message: "pack one"},
	}}
	out := wrapGenerateOutput(session.Config{}, resultWithVolume(t, result), GenerateParams{OmitPackDiagnostics: true})
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"diagnostics":[]`) {
		t.Errorf("payload does not carry an empty diagnostics array: %s", firstKB(string(raw)))
	}
}

// The two flags are independent -- one drops the catalogues, the other the pack diagnostics, and
// setting both must not disturb anything else in the response.
func TestOmitFlags_AreIndependent(t *testing.T) {
	result := &session.Result{
		Diagnostics: []session.Diagnostic{{Level: "warning", Scope: session.ScopePack, Message: "pack one"}},
	}
	out := wrapGenerateOutput(session.Config{}, resultWithVolume(t, result),
		GenerateParams{OmitCatalogs: true, OmitPackDiagnostics: true})
	if len(out.Diagnostics) != 0 {
		t.Errorf("Diagnostics = %+v, want none", out.Diagnostics)
	}
	if out.Entries != nil || out.RuleEntries != nil || out.BiomeEntries != nil {
		t.Errorf("catalogues survived omitCatalogs")
	}
}

// resultWithVolume gives a hand-built Result the one field wrapGenerateOutput dereferences. The
// tests here are about which diagnostics survive, so the volume is the smallest one that exists.
func resultWithVolume(t *testing.T, r *session.Result) *session.Result {
	t.Helper()
	palette := block.NewPalette()
	r.Volume = volume.New(volume.Bounds{SizeX: 1, SizeY: 1, SizeZ: 1}, palette, block.AirID)
	return r
}

func firstKB(s string) string {
	if len(s) > 1024 {
		return s[:1024]
	}
	return s
}
