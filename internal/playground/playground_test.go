package playground

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/wire"
)

// fixtureFeatures reads feature files from the committed fixture pack, keyed
// by file name the way the page keys them.
func fixtureFeatures(t *testing.T, names ...string) map[string]string {
	t.Helper()
	files := map[string]string{}
	for _, name := range names {
		b, err := os.ReadFile("../../docs/wiki/tools/fixtures/features/" + name)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = string(b)
	}
	return files
}

var pumpkinPatch = []string{"scatter_pumpkin_patch.json", "single_block_pumpkin.json"}

const pumpkinParams = `{"feature":"wiki:pumpkin_patch","size":"32x32x32","seed":7}`

// decode parses a Generate answer, failing the test on an {"error"} one.
func decode(t *testing.T, answer string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(answer), &out); err != nil {
		t.Fatalf("answer is not JSON: %v\n%s", err, answer)
	}
	if msg, ok := out["error"]; ok {
		t.Fatalf("answered with an error: %v", msg)
	}
	return out
}

// untimed is an answer with its wall-clock fields zeroed, the only part of it
// that is allowed to differ between two runs of the same request.
func untimed(t *testing.T, answer string) string {
	t.Helper()
	out := decode(t, answer)
	for _, k := range []string{"placementDurationMs", "libraryBuildDurationMs", "totalDurationMs"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("answer has no %q; this helper is out of date", k)
		}
		out[k] = 0
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// topKeys lists an answer's top-level fields in the order the text has them.
func topKeys(answer string) string {
	dec := json.NewDecoder(strings.NewReader(answer))
	var keys []string
	dec.Token() // {
	for dec.More() {
		k, _ := dec.Token()
		keys = append(keys, k.(string))
		var skip json.RawMessage
		dec.Decode(&skip)
	}
	return strings.Join(keys, ",")
}

func packDiagnostics(out map[string]any) []map[string]any {
	var found []map[string]any
	diags, _ := out["diagnostics"].([]any)
	for _, d := range diags {
		if m, ok := d.(map[string]any); ok && m["scope"] == string(session.ScopePack) {
			found = append(found, m)
		}
	}
	return found
}

// TestGenerate_AnswersAsServeDoes is the contract the page's decoder relies
// on: the answer is, byte for byte, the result serve would put in its
// "generate" response for the same files and params.
func TestGenerate_AnswersAsServeDoes(t *testing.T) {
	files := fixtureFeatures(t, pumpkinPatch...)
	got := New().Generate(files, pumpkinParams)

	var params wire.GenerateParams
	if err := json.Unmarshal([]byte(pumpkinParams), &params); err != nil {
		t.Fatal(err)
	}
	ws := session.NewWorkspace(sourceFiles(files), nil, nil, nil, block.DefaultBlocks())
	out, err := wire.RunGenerateFromWorkspace(ws, params)
	if err != nil {
		t.Fatal(err)
	}
	want, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	// Compared as decoded documents with the timings zeroed, and separately as
	// key order, since the page's decoder sees the text and the timings are
	// the one thing two runs never agree on.
	if untimed(t, got) != untimed(t, string(want)) {
		t.Fatalf("answer differs from serve's result\n got: %.300s\nwant: %.300s", got, want)
	}
	if topKeys(got) != topKeys(string(want)) {
		t.Errorf("fields in a different order:\n got %s\nwant %s", topKeys(got), topKeys(string(want)))
	}
	if placed := decode(t, got)["blocksPlaced"]; placed == nil || placed.(float64) == 0 {
		t.Errorf("blocksPlaced = %v, want a pumpkin patch", placed)
	}
}

// TestGenerate_FollowsTheFiles: a second call with an edited file answers for
// the edit, and a third with the original files answers as the first did --
// the Workspace is reused, never left describing a file set it was not given.
func TestGenerate_FollowsTheFiles(t *testing.T) {
	e := New()
	files := fixtureFeatures(t, pumpkinPatch...)
	first := e.Generate(files, pumpkinParams)

	edited := map[string]string{}
	for k, v := range files {
		edited[k] = v
	}
	edited["scatter_pumpkin_patch.json"] = strings.Replace(files["scatter_pumpkin_patch.json"], `"iterations": 14`, `"iterations": 0`, 1)
	if edited["scatter_pumpkin_patch.json"] == files["scatter_pumpkin_patch.json"] {
		t.Fatal("the fixture no longer has the line this test edits")
	}
	if placed := decode(t, e.Generate(edited, pumpkinParams))["blocksPlaced"]; placed.(float64) != 0 {
		t.Errorf("zero iterations placed %v blocks", placed)
	}
	if again := e.Generate(files, pumpkinParams); untimed(t, again) != untimed(t, first) {
		t.Error("the original files answered differently the second time")
	}
}

// TestGenerate_ReusesAnUnchangedFileSet: the same files sent again are handed
// to the Workspace as the slice it already has, which is what lets it skip
// fingerprinting them.
func TestGenerate_ReusesAnUnchangedFileSet(t *testing.T) {
	e := New()
	files := fixtureFeatures(t, pumpkinPatch...)
	e.Generate(files, pumpkinParams)
	before := e.files
	e.Generate(fixtureFeatures(t, pumpkinPatch...), pumpkinParams)
	if &e.files[0] != &before[0] {
		t.Error("an unchanged file set was replaced by a fresh slice")
	}
}

// TestGenerate_BrokenFileIsADiagnostic: a file that does not parse is
// reported the way serve reports it, as a pack diagnostic in a normal answer
// -- and so is asking for the very feature that file was meant to define.
func TestGenerate_BrokenFileIsADiagnostic(t *testing.T) {
	files := fixtureFeatures(t, pumpkinPatch...)
	files["broken.json"] = `{"format_version": "1.21.110", "minecraft:scatter_feature": {`

	out := decode(t, New().Generate(files, pumpkinParams))
	diags := packDiagnostics(out)
	if len(diags) == 0 || diags[0]["fileId"] != "broken.json" {
		t.Fatalf("pack diagnostics = %v, want one naming broken.json", diags)
	}

	files["scatter_pumpkin_patch.json"] = files["scatter_pumpkin_patch.json"][:40]
	out = decode(t, New().Generate(files, pumpkinParams))
	named := false
	for _, d := range packDiagnostics(out) {
		named = named || d["fileId"] == "scatter_pumpkin_patch.json"
	}
	if !named {
		t.Errorf("the requested feature's own parse error was not reported: %v", out["diagnostics"])
	}
}

// TestGenerate_OmitPackDiagnostics: the flag the page sets on repeat runs
// drops exactly the diagnostics about the files.
func TestGenerate_OmitPackDiagnostics(t *testing.T) {
	files := fixtureFeatures(t, pumpkinPatch...)
	files["broken.json"] = `{`
	out := decode(t, New().Generate(files, `{"feature":"wiki:pumpkin_patch","omitPackDiagnostics":true,"omitCatalogs":true}`))
	if d := packDiagnostics(out); len(d) != 0 {
		t.Errorf("omitPackDiagnostics left %v", d)
	}
	if out["entries"] != nil {
		t.Errorf("omitCatalogs left entries: %v", out["entries"])
	}
}

// TestGenerate_Errors: requests that cannot be run answer {"error"} with a
// message, never an empty output and never a panic.
func TestGenerate_Errors(t *testing.T) {
	files := fixtureFeatures(t, pumpkinPatch...)
	cases := map[string]struct{ params, want string }{
		"params not JSON":     {`{"feature":`, "malformed params"},
		"no feature":          {`{}`, "one of feature or rule is required"},
		"unknown environment": {`{"feature":"wiki:pumpkin_patch","env":"moon"}`, "unknown environment"},
		"bad size":            {`{"feature":"wiki:pumpkin_patch","size":"big"}`, "size"},
	}
	for name, c := range cases {
		var out map[string]string
		answer := New().Generate(files, c.params)
		if err := json.Unmarshal([]byte(answer), &out); err != nil {
			t.Errorf("%s: answer is not an {\"error\"} object: %s", name, answer)
			continue
		}
		if !strings.Contains(out["error"], c.want) {
			t.Errorf("%s: error %q, want it to mention %q", name, out["error"], c.want)
		}
	}
}

// TestGenerate_RecoversAPanic: a panic comes back as {"error"}, the Workspace
// it happened in is dropped, and the next call works.
func TestGenerate_RecoversAPanic(t *testing.T) {
	e := New()
	files := fixtureFeatures(t, pumpkinPatch...)
	e.Generate(files, pumpkinParams)

	saved, savedLog := runGenerate, panicLog
	runGenerate = func(*session.Workspace, wire.GenerateParams) (*wire.GenerateOutput, error) { panic("boom") }
	panicLog = io.Discard
	answer := e.Generate(files, pumpkinParams)
	runGenerate, panicLog = saved, savedLog

	if !strings.Contains(answer, `"error"`) || !strings.Contains(answer, "boom") {
		t.Fatalf("answer = %s, want an error naming the panic", answer)
	}
	if e.ws != nil {
		t.Error("the Workspace the panic happened in was kept")
	}
	decode(t, e.Generate(files, pumpkinParams))
}

// TestSourceFiles_Sorted: map order is random and the library build is not
// indifferent to order, so the files reach it sorted by id every time.
func TestSourceFiles_Sorted(t *testing.T) {
	got := sourceFiles(map[string]string{"b.json": "", "a.json": "", "c/d.json": ""})
	want := []features.SourceFile{{ID: "a.json", AbsPath: "a.json"}, {ID: "b.json", AbsPath: "b.json"}, {ID: "c/d.json", AbsPath: "c/d.json"}}
	if !sameFiles(got, want) {
		t.Errorf("got %v", got)
	}
}

// TestEnvironments_IsServesList: the page fills its preset picker from this,
// so it must be serve's "environments" answer, in the same order.
func TestEnvironments_IsServesList(t *testing.T) {
	var got []wire.EnvironmentOption
	if err := json.Unmarshal([]byte(Environments()), &got); err != nil {
		t.Fatal(err)
	}
	want := wire.Environments()
	if len(got) != len(want) || len(got) == 0 {
		t.Fatalf("got %d presets, want %d", len(got), len(want))
	}
	for i := range got {
		if got[i].ID != want[i].ID {
			t.Errorf("preset %d is %q, want %q", i, got[i].ID, want[i].ID)
		}
	}
}

func TestVersion(t *testing.T) {
	if v := Version("1.2.3"); v != "1.2.3" {
		t.Errorf("a stamped version came back as %q", v)
	}
	if v := Version(""); v == "" {
		t.Error("an unstamped build has no version at all")
	}
}
