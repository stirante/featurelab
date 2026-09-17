package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/wire"
)

// graph_test.go covers what cmd/featurelab owns about the feature graph: the
// subcommand's flags and exit codes, serve's "graph" method and its envelope,
// and the ordering that makes a dump diffable. The graph BUILDER is not this
// package's -- these tests deliberately stub it (see stubGraphBuilder), so a
// failure here is always a failure of the plumbing rather than of whatever a
// fixture pack currently contains.

// stubGraphBuilder swaps in a builder for the duration of one test and
// restores the real one afterwards.
func stubGraphBuilder(t *testing.T, fn func(*pack.Pack) (*wire.Graph, error)) {
	t.Helper()
	prev := buildGraph
	buildGraph = fn
	t.Cleanup(func() { buildGraph = prev })
}

// scrambledGraph returns the same small graph every call, but with its lists
// built by walking a map -- so Go's randomized map iteration hands the
// normalizer a genuinely different order each time. Anything downstream that
// comes out identical on two calls is identical because it was sorted, not
// because it got lucky.
func scrambledGraph() *wire.Graph {
	nodes := map[string]wire.GraphNode{
		"test:rule":     {ID: "test:rule", TypeID: "minecraft:feature_rule", File: "feature_rules/rule.json"},
		"test:seq":      {ID: "test:seq", TypeID: "minecraft:sequence_feature", File: "features/seq.json"},
		"test:alpha":    {ID: "test:alpha", TypeID: "minecraft:single_block_feature", File: "features/alpha.json"},
		"test:beta":     {ID: "test:beta", TypeID: "minecraft:single_block_feature", File: "features/beta.json"},
		"test:nowhere":  {ID: "test:nowhere", Unresolved: true},
		"test:zzz_last": {ID: "test:zzz_last", TypeID: "minecraft:single_block_feature", File: "features/zzz.json"},
	}
	edges := map[string]wire.GraphEdge{
		"rule":  {From: "test:rule", To: "test:seq", Kind: wire.EdgeRule, JSONPath: "$.description.places_feature", Required: true},
		"seq0":  {From: "test:seq", To: "test:alpha", Kind: wire.EdgeSequence, JSONPath: "$.features[0]", Ordinal: 0, Required: true},
		"seq1":  {From: "test:seq", To: "test:beta", Kind: wire.EdgeSequence, JSONPath: "$.features[1]", Ordinal: 1, Required: true},
		"seq2":  {From: "test:seq", To: "test:nowhere", Kind: wire.EdgeSequence, JSONPath: "$.features[2]", Ordinal: 2, Required: true},
		"seq10": {From: "test:seq", To: "test:zzz_last", Kind: wire.EdgeSequence, JSONPath: "$.features[10]", Ordinal: 10, Required: true},
	}
	g := &wire.Graph{}
	for _, n := range nodes {
		g.Nodes = append(g.Nodes, n)
	}
	for _, e := range edges {
		g.Edges = append(g.Edges, e)
	}
	g.Roots = []string{"test:zzz_last", "test:rule"}
	return g
}

// graphPack is the smallest pack `graph` can be pointed at: one feature, so
// pack.Load has a directory to find and returns no warnings.
func graphPack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "alpha.json"), singleBlockFeatureJSON("test:alpha", "minecraft:diamond_block"))
	return root
}

func TestCmdGraph_PrintsTheGraphAsJSONAndExitsZero(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) { return scrambledGraph(), nil })
	root := graphPack(t)

	var code int
	out := captureStdout(t, func() { code = run([]string{"graph", "--pack", root}) })
	if code != 0 {
		t.Fatalf("run = %d, want 0; output: %s", code, out)
	}

	var g wire.Graph
	if err := json.Unmarshal(out, &g); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if len(g.Nodes) != 6 || len(g.Edges) != 5 || len(g.Roots) != 2 {
		t.Fatalf("got %d nodes / %d edges / %d roots, want 6/5/2", len(g.Nodes), len(g.Edges), len(g.Roots))
	}
}

// TestCmdGraph_PassesTheLoadedPackToTheBuilder pins the one thing the
// subcommand must do with its pack flags: the pack it loaded is the pack the
// builder is asked about, including a subdirectory override.
func TestCmdGraph_PassesTheLoadedPackToTheBuilder(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "elsewhere", "alpha.json"), singleBlockFeatureJSON("test:alpha", "minecraft:diamond_block"))

	var got *pack.Pack
	stubGraphBuilder(t, func(p *pack.Pack) (*wire.Graph, error) {
		got = p
		return &wire.Graph{}, nil
	})

	var code int
	out := captureStdout(t, func() {
		code = run([]string{"graph", "--pack", root, "--features", filepath.Join(root, "elsewhere")})
	})
	if code != 0 {
		t.Fatalf("run = %d, want 0; output: %s", code, out)
	}
	if got == nil {
		t.Fatal("the builder was never called")
	}
	if len(got.Features) != 1 || !strings.Contains(filepath.ToSlash(got.Features[0].AbsPath), "/elsewhere/") {
		t.Errorf("builder saw %d features (%+v), want the one from the --features override", len(got.Features), got.Features)
	}
}

// TestCmdGraph_TwoDumpsOfOnePackAreByteIdentical is the whole reason
// normalizeGraph exists: an editor diffs successive dumps, so a graph whose
// lists came out of a map walk must not present as edited every time.
func TestCmdGraph_TwoDumpsOfOnePackAreByteIdentical(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) { return scrambledGraph(), nil })
	root := graphPack(t)

	first := captureStdout(t, func() { run([]string{"graph", "--pack", root}) })
	for i := 0; i < 8; i++ {
		again := captureStdout(t, func() { run([]string{"graph", "--pack", root}) })
		if string(again) != string(first) {
			t.Fatalf("dump %d differs from the first dump of the same pack:\n--- first ---\n%s\n--- again ---\n%s", i+2, first, again)
		}
	}
}

// TestCmdGraph_UnresolvedNodeStillExitsZero pins the deliberate difference
// from `check`: a dangling reference is data the editor is meant to render
// (wire.GraphNode.Unresolved), not a failed command. An editor asks for the
// graph of a half-written pack constantly.
func TestCmdGraph_UnresolvedNodeStillExitsZero(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) {
		return &wire.Graph{
			Nodes: []wire.GraphNode{{ID: "test:nowhere", Unresolved: true}},
			Edges: []wire.GraphEdge{{From: "test:rule", To: "test:nowhere", Kind: wire.EdgeRule, JSONPath: "$.description.places_feature"}},
		}, nil
	})
	root := graphPack(t)

	var code int
	out := captureStdout(t, func() { code = run([]string{"graph", "--pack", root}) })
	if code != 0 {
		t.Fatalf("run = %d, want 0: an unresolved reference is part of the graph contract, not a command failure; output: %s", code, out)
	}
}

func TestCmdGraph_BuilderErrorExitsOneAndPrintsNoJSON(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) { return nil, errors.New("boom") })
	root := graphPack(t)

	var code int
	out := captureStdout(t, func() { code = run([]string{"graph", "--pack", root}) })
	if code != 1 {
		t.Errorf("run = %d, want 1 when the graph cannot be built", code)
	}
	if len(out) != 0 {
		t.Errorf("stdout = %q, want nothing: a failed graph must not leave a half-written document for a caller to parse", out)
	}
}

// TestCmdGraph_NoPackFlagExitsOne matches `generate`/`check`: a pack that
// cannot be located is a load failure, not a usage error.
func TestCmdGraph_NoPackFlagExitsOne(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) { return &wire.Graph{}, nil })
	var code int
	captureStdout(t, func() { code = run([]string{"graph"}) })
	if code != 1 {
		t.Errorf("run = %d, want 1 when no pack directory is given", code)
	}
}

func TestCmdGraph_UnparseableFlagExitsTwo(t *testing.T) {
	var code int
	captureStdout(t, func() { code = run([]string{"graph", "--not-a-flag"}) })
	if code != 2 {
		t.Errorf("run = %d, want 2 for a flag parse failure, as every other subcommand does", code)
	}
}

func TestNormalizeGraph_SortsNodesAndRootsByID(t *testing.T) {
	g := scrambledGraph()
	normalizeGraph(g)

	for i := 1; i < len(g.Nodes); i++ {
		if g.Nodes[i-1].ID >= g.Nodes[i].ID {
			t.Fatalf("nodes are not in id order: %q then %q", g.Nodes[i-1].ID, g.Nodes[i].ID)
		}
	}
	if want := []string{"test:rule", "test:zzz_last"}; g.Roots[0] != want[0] || g.Roots[1] != want[1] {
		t.Errorf("roots = %v, want %v", g.Roots, want)
	}
}

// TestNormalizeGraph_SequenceEdgesKeepExecutionOrder pins the ordering choice
// that carries meaning: a sequence's children are ordered by Ordinal, which is
// execution order and therefore part of the RNG contract. Sorting by JSONPath
// or by target id would put entry 10 before entry 2.
func TestNormalizeGraph_SequenceEdgesKeepExecutionOrder(t *testing.T) {
	g := scrambledGraph()
	normalizeGraph(g)

	var ordinals []int
	for _, e := range g.Edges {
		if e.From == "test:seq" {
			ordinals = append(ordinals, e.Ordinal)
		}
	}
	want := []int{0, 1, 2, 10}
	if len(ordinals) != len(want) {
		t.Fatalf("got %d edges out of test:seq, want %d", len(ordinals), len(want))
	}
	for i := range want {
		if ordinals[i] != want[i] {
			t.Fatalf("sequence edge ordinals = %v, want %v", ordinals, want)
		}
	}
}

// TestNormalizeGraph_EmptyGraphMarshalsListsAsArrays keeps a client from
// having to treat `null` and `[]` as the same thing on the three fields the
// contract always carries.
func TestNormalizeGraph_EmptyGraphMarshalsListsAsArrays(t *testing.T) {
	g := &wire.Graph{}
	normalizeGraph(g)
	b, err := json.Marshal(g)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if got, want := string(b), `{"nodes":[],"edges":[],"roots":[],"diagnostics":[]}`; got != want {
		t.Errorf("empty graph = %s, want %s", got, want)
	}
}

// TestServe_GraphMethodAnswersInTheStandardEnvelope pins that "graph" is a
// method like any other: {"id":...,"result":{...}} on the same line-per-
// response loop, with the id echoed back.
func TestServe_GraphMethodAnswersInTheStandardEnvelope(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) { return scrambledGraph(), nil })
	root := graphPack(t)

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		`{"id":"g","method":"graph"}`,
	)
	if len(resps) != 2 {
		t.Fatalf("got %d responses, want 2", len(resps))
	}
	if resps[1].Error != nil {
		t.Fatalf("graph response has an error: %+v", resps[1].Error)
	}
	if resps[1].ID != "g" {
		t.Errorf("graph response id = %v, want \"g\" echoed back verbatim", resps[1].ID)
	}
	result, ok := resps[1].Result.(map[string]any)
	if !ok {
		t.Fatalf("graph result is not an object: %v", resps[1].Result)
	}
	for _, key := range []string{"nodes", "edges", "roots", "diagnostics"} {
		if _, ok := result[key]; !ok {
			t.Errorf("graph result is missing %q", key)
		}
	}
}

// TestServe_GraphMethodSeesTheLoadedPack proves the method reads the pack the
// session already has open rather than re-reading disk or answering about
// some other pack.
func TestServe_GraphMethodSeesTheLoadedPack(t *testing.T) {
	root := graphPack(t)
	var seen string
	stubGraphBuilder(t, func(p *pack.Pack) (*wire.Graph, error) {
		seen = p.Dir
		return &wire.Graph{}, nil
	})

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		`{"id":2,"method":"graph"}`,
	)
	if len(resps) != 2 || resps[1].Error != nil {
		t.Fatalf("got %+v, want a clean graph response", resps)
	}
	if seen != root {
		t.Errorf("builder saw pack %q, want the loaded pack %q", seen, root)
	}
}

// TestServe_GraphBeforeLoadPackIsAnError uses the one shared sentence every
// pack-dependent method answers with, so a client's "load the pack, then
// retry" recovery keys off the same string here as everywhere else.
func TestServe_GraphBeforeLoadPackIsAnError(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) {
		t.Error("the builder must not be called before a pack is loaded")
		return &wire.Graph{}, nil
	})

	resps := runLines(t, `{"id":1,"method":"graph"}`)
	if len(resps) != 1 || resps[0].Error == nil {
		t.Fatalf("got %+v, want one error response", resps)
	}
	if !strings.Contains(resps[0].Error.Message, "no pack loaded") {
		t.Errorf("error message = %q, want the shared no-pack-loaded sentence", resps[0].Error.Message)
	}
}

// TestServe_GraphBuilderErrorKeepsTheLoopRunning: a builder failure is one
// error response, not a dead server -- the same guarantee every other method
// gives the long-lived UI driving this loop.
func TestServe_GraphBuilderErrorKeepsTheLoopRunning(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) { return nil, errors.New("builder exploded") })
	root := graphPack(t)

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		`{"id":2,"method":"graph"}`,
		`{"id":3,"method":"types"}`,
	)
	if len(resps) != 3 {
		t.Fatalf("got %d responses, want 3", len(resps))
	}
	if resps[1].Error == nil || !strings.Contains(resps[1].Error.Message, "builder exploded") {
		t.Errorf("graph response = %+v, want the builder's error", resps[1])
	}
	if resps[2].Error != nil {
		t.Errorf("the request after the failed graph errored -- the loop did not recover: %+v", resps[2].Error)
	}
}

// TestServe_GraphAndCmdGraphAgree: the subcommand and the method are two
// doors onto one graph, so the bytes they produce for one pack must match.
func TestServe_GraphAndCmdGraphAgree(t *testing.T) {
	stubGraphBuilder(t, func(*pack.Pack) (*wire.Graph, error) { return scrambledGraph(), nil })
	root := graphPack(t)

	cliOut := captureStdout(t, func() { run([]string{"graph", "--pack", root}) })
	var fromCLI wire.Graph
	if err := json.Unmarshal(cliOut, &fromCLI); err != nil {
		t.Fatalf("subcommand output is not valid JSON: %v", err)
	}

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		`{"id":2,"method":"graph"}`,
	)
	if len(resps) != 2 || resps[1].Error != nil {
		t.Fatalf("got %+v, want a clean graph response", resps)
	}
	viaServe, err := json.Marshal(resps[1].Result)
	if err != nil {
		t.Fatalf("re-marshalling the serve result: %v", err)
	}
	var fromServe wire.Graph
	if err := json.Unmarshal(viaServe, &fromServe); err != nil {
		t.Fatalf("serve result does not decode as a wire.Graph: %v", err)
	}

	a, _ := json.Marshal(fromCLI)
	b, _ := json.Marshal(fromServe)
	if string(a) != string(b) {
		t.Errorf("the subcommand and the serve method disagree about one pack:\n--- cli ---\n%s\n--- serve ---\n%s", a, b)
	}
}

// ---------------------------------------------------------------------------
// Diagnostics
//
// These are the one part of this file that runs the REAL builder and the REAL
// pack loader, because what they are about is a file that produces no node at
// all: a stub graph cannot be wrong about a file it was never given. The pack
// is written here, two small files, so the thing under test is visible in the
// test rather than in whatever a shared fixture currently holds.
// ---------------------------------------------------------------------------

// refusedRuleJSON is a feature rule file with ONE NESTING LEVEL TOO MANY: the
// rule body sits under a type key inside `minecraft:feature_rules` instead of
// directly under it. It is the mistake an author makes by copying the shape
// of a feature file, and it is quiet in the worst way -- the JSON is valid,
// the identifier is right there in the text, and the engine refuses the whole
// file because `description` is not where the schema requires it.
func refusedRuleJSON() string {
	return `{"format_version":"1.21.110","minecraft:feature_rules":{"minecraft:ore_feature":{` +
		`"description":{"identifier":"test:buried","places_feature":"test:alpha"},` +
		`"conditions":{"placement_pass":"underground_pass","minecraft:biome_filter":[]}}}}`
}

// packWithRefusedRule is graphPack plus that file. The feature it names loads
// fine, so everything the graph DOES contain is correct -- which is exactly
// what made the missing file so hard to notice.
func packWithRefusedRule(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "alpha.json"), singleBlockFeatureJSON("test:alpha", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "feature_rules", "buried.json"), refusedRuleJSON())
	return root
}

// decodeGraph runs `graph` over root with the real builder and decodes stdout.
func decodeGraph(t *testing.T, root string) wire.Graph {
	t.Helper()
	var code int
	out := captureStdout(t, func() { code = run([]string{"graph", "--pack", root}) })
	if code != 0 {
		t.Fatalf("graph exited %d, want 0; output: %s", code, out)
	}
	var g wire.Graph
	if err := json.Unmarshal(out, &g); err != nil {
		t.Fatalf("graph output is not valid JSON: %v; output: %s", err, out)
	}
	return g
}

// TestCmdGraph_RefusedFileArrivesAsADiagnostic is the bug this field exists
// for: the author adds a rule file by hand, the engine refuses it, and the
// graph -- having no node, edge or root for a file that did not load -- used
// to come back describing a pack the author did not have, saying nothing
// about the file they had just written.
func TestCmdGraph_RefusedFileArrivesAsADiagnostic(t *testing.T) {
	g := decodeGraph(t, packWithRefusedRule(t))

	var found *wire.GraphDiagnostic
	for i, d := range g.Diagnostics {
		if d.Level == "error" && strings.Contains(d.FileID, "buried.json") {
			found = &g.Diagnostics[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("no error diagnostic naming the refused file; got %+v", g.Diagnostics)
	}
	if !strings.Contains(found.Message, "description") {
		t.Errorf("diagnostic message = %q, want it to say what is actually wrong (a missing `description`), not just that something is", found.Message)
	}

	// The rest of the pack still has to be there. A diagnostics channel that
	// arrived by way of the graph refusing to answer would be no better than
	// the silence it replaces.
	if len(g.Nodes) == 0 {
		t.Errorf("graph has no nodes: a refused file must not cost the author the graph of everything that did load")
	}
}

// TestCmdGraph_CleanPackCarriesNoDiagnostics is the other half, and the half
// that decides whether anyone ever reads this channel. This pack has no
// structures/, no feature_rules/, no biomes/ and no blocks/ -- pack.Load
// warns about each of them and `check` prints all four -- and none of that is
// a problem with the pack. Handed those, every pack ever opened would show
// diagnostics, and the one that matters would be a needle in them.
func TestCmdGraph_CleanPackCarriesNoDiagnostics(t *testing.T) {
	g := decodeGraph(t, graphPack(t))
	if len(g.Diagnostics) != 0 {
		t.Errorf("clean pack reported %d diagnostics, want none: %+v", len(g.Diagnostics), g.Diagnostics)
	}
}

// TestCmdGraph_DiagnosticsAreCheckSOwn pins the promise that makes this field
// trustworthy: `graph` has no opinion of its own about a file. Every
// file-level entry `check` prints for a pack appears in that pack's graph,
// verbatim -- same level, same id, same sentence -- because both come from
// the same collector. Two spellings of one problem is how an author ends up
// believing they have two.
func TestCmdGraph_DiagnosticsAreCheckSOwn(t *testing.T) {
	root := packWithRefusedRule(t)

	checkOut := captureStdout(t, func() { run([]string{"check", "--pack", root}) })
	var fromCheck []Diagnostic
	if err := json.Unmarshal(checkOut, &fromCheck); err != nil {
		t.Fatalf("check output is not valid JSON: %v; output: %s", err, checkOut)
	}
	var want []wire.GraphDiagnostic
	for _, d := range fromCheck {
		if d.FileID == packDiagnosticFileID {
			continue
		}
		want = append(want, wire.GraphDiagnostic{Level: d.Level, FileID: d.FileID, Message: d.Message})
	}
	if len(want) == 0 {
		t.Fatal("check reported no file-level diagnostics for a pack with a refused file -- the fixture stopped being broken")
	}

	got := decodeGraph(t, root).Diagnostics
	if len(got) != len(want) {
		t.Fatalf("graph reported %d diagnostics, check reported %d file-level ones; graph: %+v; check: %+v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("diagnostic %d differs between the two commands; graph: %+v; check: %+v", i, got[i], want[i])
		}
	}
}

// TestServe_GraphMethodCarriesDiagnostics covers the caller that actually
// matters. The editor never runs the subcommand -- it holds one `serve`
// process open and asks it -- so diagnostics that reached only stdout would
// have fixed nothing for the person the silence was costing.
func TestServe_GraphMethodCarriesDiagnostics(t *testing.T) {
	root := packWithRefusedRule(t)

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		`{"id":2,"method":"graph"}`,
	)
	if len(resps) != 2 || resps[1].Error != nil {
		t.Fatalf("got %+v, want a clean graph response", resps)
	}
	encoded, err := json.Marshal(resps[1].Result)
	if err != nil {
		t.Fatalf("re-marshalling the serve result: %v", err)
	}
	var g wire.Graph
	if err := json.Unmarshal(encoded, &g); err != nil {
		t.Fatalf("serve result does not decode as a wire.Graph: %v", err)
	}

	naming := 0
	for _, d := range g.Diagnostics {
		if d.Level == "error" && strings.Contains(d.FileID, "buried.json") {
			naming++
		}
	}
	if naming == 0 {
		t.Errorf("serve's graph carried no error naming the refused file; got %+v", g.Diagnostics)
	}
}

// ---------------------------------------------------------------------------
// The spelling a diagnostic's FileID promises
//
// GraphDiagnostic.FileID says it is pack-relative, "the same id GraphNode.File
// carries". A renderer does exactly two things with that: match it against a
// node's File to put the message beside that node, or -- for a file the engine
// refused, which has no node -- join it onto the pack root to open the file the
// message is about. Both are string equality with something real, so both are
// asserted here against the graph's own nodes and against the disk.
//
// Nothing below compares a FileID with a path written out in this file. That is
// the trap this pair of fields already fell into once: GraphNode.File spent its
// whole life one directory too high because the tests on each side agreed with
// a hand-written string and never with each other (see wire.withPackPath's own
// doc comment). A hand-written expectation only ever confirms what the person
// writing the test already believed.
// ---------------------------------------------------------------------------

// assertDiagnosticsAreJoinable fails for any diagnostic that a renderer could
// not act on: one whose FileID matches no node's File AND reaches nothing under
// the pack root.
func assertDiagnosticsAreJoinable(t *testing.T, root string, g wire.Graph) {
	t.Helper()
	nodeByFile := map[string]string{}
	for _, n := range g.Nodes {
		if n.File != "" {
			nodeByFile[n.File] = n.ID
		}
	}
	for _, d := range g.Diagnostics {
		// packDiagnosticFileID names no file on purpose -- see its own doc
		// comment -- so it is the one id with nothing to join onto.
		if d.FileID == packDiagnosticFileID {
			continue
		}
		if _, ok := nodeByFile[d.FileID]; ok {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(d.FileID))); err != nil {
			t.Errorf("diagnostic %+v names %q, which is neither any node's File (%v) nor a file the pack root reaches: %v",
				d, d.FileID, nodeByFile, err)
		}
	}
}

// TestCmdGraph_DiagnosticIDsJoinOntoTheGraphOrTheDisk is the promise itself,
// over the pack the field exists for: a rule file the engine refused, which has
// no node anywhere to be found by.
func TestCmdGraph_DiagnosticIDsJoinOntoTheGraphOrTheDisk(t *testing.T) {
	root := packWithRefusedRule(t)
	g := decodeGraph(t, root)
	if len(g.Diagnostics) == 0 {
		t.Fatal("the pack with a refused rule reported no diagnostics -- the fixture stopped being broken")
	}
	assertDiagnosticsAreJoinable(t, root, g)
}

// sharedBasename is one filename used by two DIFFERENT asset kinds in the same
// pack, which a pack may legitimately do: a SourceFile id is unique only within
// its own kind, because the loader derives it relative to that kind's
// directory. Both files below are therefore "thing.json" to their loaders.
const sharedBasename = "thing.json"

// unversionedFeatureJSON is a feature with NO format_version. It is the cheap
// way to get a file that both loads (so it has a node) and is complained about
// (so it has a diagnostic) -- see features.parseFile, which reports the missing
// key as a warning and builds the feature anyway.
func unversionedFeatureJSON(identifier, placesBlock string) string {
	return `{"minecraft:single_block_feature":{"description":{"identifier":"` + identifier + `"},` +
		`"enforce_placement_rules":false,"enforce_survivability_rules":false,"places_block":"` + placesBlock + `"}}`
}

// packWithOneBasenameInTwoKinds holds features/thing.json and
// feature_rules/thing.json, each raising a diagnostic of its own.
func packWithOneBasenameInTwoKinds(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", sharedBasename), unversionedFeatureJSON("test:alpha", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "feature_rules", sharedBasename), refusedRuleJSON())
	return root
}

// TestCmdGraph_TwoKindsSharingAFilenameKeepTheirOwnFileIDs is the half of this
// that a map keyed by the loader's id alone gets wrong. Both files are
// "thing.json" to their own loader, so any scheme that resolves a diagnostic by
// id without knowing WHICH KIND raised it will hand the rule's error the
// feature's path -- and the message will land beside a file that is fine, which
// is worse than landing nowhere, because it accuses the wrong file.
func TestCmdGraph_TwoKindsSharingAFilenameKeepTheirOwnFileIDs(t *testing.T) {
	root := packWithOneBasenameInTwoKinds(t)
	g := decodeGraph(t, root)
	assertDiagnosticsAreJoinable(t, root, g)

	var featureWarning, ruleError *wire.GraphDiagnostic
	for i, d := range g.Diagnostics {
		switch {
		case d.Level == "warning" && strings.Contains(d.Message, "format_version"):
			featureWarning = &g.Diagnostics[i]
		case d.Level == "error" && strings.Contains(d.Message, "description"):
			ruleError = &g.Diagnostics[i]
		}
	}
	if featureWarning == nil || ruleError == nil {
		t.Fatalf("want one warning about the feature and one error about the rule; got %+v", g.Diagnostics)
	}

	// The feature loaded, so its diagnostic has a node to sit beside, and the
	// join is what is being tested -- not the spelling either side chose.
	var featureNode *wire.GraphNode
	for i, n := range g.Nodes {
		if n.ID == "test:alpha" {
			featureNode = &g.Nodes[i]
		}
	}
	if featureNode == nil {
		t.Fatalf("the feature did not reach the graph; nodes: %+v", g.Nodes)
	}
	if featureWarning.FileID != featureNode.File {
		t.Errorf("the feature's diagnostic says %q and its node says %q -- a renderer joining the two matches nothing",
			featureWarning.FileID, featureNode.File)
	}

	// The rule did NOT load, so the only thing its id can be checked against is
	// the disk: joined onto the pack root it must reach the rule file, not the
	// feature file that happens to share its name.
	if ruleError.FileID == featureWarning.FileID {
		t.Fatalf("the rule's error and the feature's warning both say %q -- one file's problem is being reported against another's",
			ruleError.FileID)
	}
	got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(ruleError.FileID)))
	if err != nil {
		t.Fatalf("the rule's error names %q, which the pack root does not reach: %v", ruleError.FileID, err)
	}
	if string(got) != refusedRuleJSON() {
		t.Errorf("the rule's error names %q, but that path holds a different file:\n%s", ruleError.FileID, got)
	}
}

// TestCmdCheck_PackLevelDiagnosticKeepsItsNonPathID is the id that must survive
// all of the above untouched. A pack-level warning ("this pack has no
// structures/ directory") is about a DIRECTORY that is not there; rewriting it
// into a path would send an editor to a file that does not exist and cannot be
// created. It is check's own output that is read here because the graph drops
// these on purpose (see graphDiagnostics), so this is the only place the id is
// still visible.
func TestCmdCheck_PackLevelDiagnosticKeepsItsNonPathID(t *testing.T) {
	// features/ only: no structures/, feature_rules/, biomes/ or blocks/.
	root := graphPack(t)

	out := captureStdout(t, func() { run([]string{"check", "--pack", root}) })
	var diags []Diagnostic
	if err := json.Unmarshal(out, &diags); err != nil {
		t.Fatalf("check output is not valid JSON: %v; output: %s", err, out)
	}
	found := 0
	for _, d := range diags {
		if d.FileID == packDiagnosticFileID {
			found++
		}
	}
	if found == 0 {
		t.Fatalf("no diagnostic carries %q any more -- a pack-level warning has been rewritten into a path, or stopped being reported: %+v",
			packDiagnosticFileID, diags)
	}
}
