package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/session"
)

// runLines feeds each of lines into runServe (one per input line) and
// returns each output line parsed back into a Response, in order.
func runLines(t *testing.T, lines ...string) []Response {
	t.Helper()
	in := strings.NewReader(strings.Join(lines, "\n") + "\n")
	var out bytes.Buffer
	if err := runServe(in, &out); err != nil {
		t.Fatalf("runServe: %v", err)
	}
	var resps []Response
	scanner := bufio.NewScanner(&out)
	// A generate response's blocks/baseline arrays can comfortably exceed
	// bufio.Scanner's default 64KiB token size (this is exactly why
	// runServe's OWN input-side scanner sets a larger buffer, see
	// serve.go) -- without this, a long line here fails SILENTLY: Scan()
	// just returns false early with no panic, which reads as "the server
	// only produced N responses" and would misreport a real server bug as
	// a scanner limitation in the test harness instead.
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		// The rule notify.go documents for every client: a line with no "id" member is not an
		// answer to anything. This harness implements it rather than special-casing the
		// readiness line, so it is asserting the CONTRACT a real client follows -- see
		// notify_test.go, which is where the notifications themselves are checked.
		if isNotificationLine(scanner.Bytes()) {
			continue
		}
		var r Response
		if err := json.Unmarshal(scanner.Bytes(), &r); err != nil {
			t.Fatalf("response line is not valid JSON: %s: %v", scanner.Text(), err)
		}
		resps = append(resps, r)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanning response lines: %v", err)
	}
	return resps
}

// TestServe_MalformedRequestProducesErrorNotCrash is the load-bearing
// assertion for `serve`'s whole reason for being a long-lived loop: one bad
// line must produce an {"id":...,"error":{...}} response and the loop must
// keep running for the NEXT line, never exit/panic the process.
func TestServe_MalformedRequestProducesErrorResponseAndKeepsRunning(t *testing.T) {
	resps := runLines(t,
		`{"id":1,"method":"types"}`,
		`this is not json at all`,
		`{"id":2,"method":"types"}`,
	)
	if len(resps) != 3 {
		t.Fatalf("got %d responses, want 3 (the malformed line must still produce exactly one response and not swallow the next line)", len(resps))
	}
	if resps[0].Error != nil {
		t.Errorf("response 1 (valid request) has an error: %+v", resps[0].Error)
	}
	if resps[1].Error == nil {
		t.Fatalf("response 2 (malformed line) should carry an error, got %+v", resps[1])
	}
	if !strings.Contains(resps[1].Error.Message, "malformed") {
		t.Errorf("error message = %q, want it to say the request was malformed", resps[1].Error.Message)
	}
	if resps[2].Error != nil {
		t.Errorf("response 3 (valid request AFTER the malformed line) has an error -- the server did not recover: %+v", resps[2].Error)
	}
	idFloat, ok := resps[2].ID.(float64)
	if !ok || idFloat != 2 {
		t.Errorf("response 3 id = %v, want 2", resps[2].ID)
	}
}

func TestServe_UnknownMethodProducesError(t *testing.T) {
	resps := runLines(t, `{"id":"x","method":"not_a_real_method"}`)
	if len(resps) != 1 || resps[0].Error == nil {
		t.Fatalf("got %+v, want one error response", resps)
	}
	if !strings.Contains(resps[0].Error.Message, "unknown method") {
		t.Errorf("error message = %q", resps[0].Error.Message)
	}
}

func TestServe_GenerateBeforeLoadPackIsAnError(t *testing.T) {
	resps := runLines(t, `{"id":1,"method":"generate","params":{"feature":"x"}}`)
	if len(resps) != 1 || resps[0].Error == nil {
		t.Fatalf("got %+v, want one error response", resps)
	}
	if !strings.Contains(resps[0].Error.Message, "no pack loaded") {
		t.Errorf("error message = %q", resps[0].Error.Message)
	}
}

func TestServe_TypesMethod(t *testing.T) {
	resps := runLines(t, `{"id":1,"method":"types"}`)
	if len(resps) != 1 || resps[0].Error != nil {
		t.Fatalf("got %+v", resps)
	}
	result, ok := resps[0].Result.(map[string]any)
	if !ok {
		t.Fatalf("result is not an object: %v", resps[0].Result)
	}
	if _, ok := result["summary"]; !ok {
		t.Error("types result missing \"summary\"")
	}
	if _, ok := result["types"]; !ok {
		t.Error("types result missing \"types\"")
	}
}

// TestServe_EnvironmentsMethod proves the `environments` method works standalone -- no
// loadPack call first (env.ENVIRONMENTS is a fixed built-in table, not pack-derived, see
// environmentsOutput's own doc comment) -- and returns every preset with the fields a client
// picker needs (id/label/description plus the defaults/materials/biome/biomeTags a
// hand-transcribed mirror used to have to copy by hand -- see frontend/src/ui/environments.ts's
// deletion in the same change that added this method).
func TestServe_EnvironmentsMethod(t *testing.T) {
	resps := runLines(t, `{"id":1,"method":"environments"}`)
	if len(resps) != 1 || resps[0].Error != nil {
		t.Fatalf("got %+v", resps)
	}
	result, ok := resps[0].Result.([]any)
	if !ok {
		t.Fatalf("result is not an array: %v", resps[0].Result)
	}
	if len(result) != len(env.ENVIRONMENTS) {
		t.Fatalf("got %d environments, want %d (one per env.ENVIRONMENTS entry)", len(result), len(env.ENVIRONMENTS))
	}
	first, ok := result[0].(map[string]any)
	if !ok {
		t.Fatalf("first entry is not an object: %v", result[0])
	}
	if first["id"] != "void" {
		t.Errorf("first entry id = %v, want %q (env.ENVIRONMENTS[0])", first["id"], "void")
	}
	if first["label"] != "Void" {
		t.Errorf("first entry label = %v, want %q", first["label"], "Void")
	}
	if _, ok := first["description"].(string); !ok || first["description"] == "" {
		t.Errorf("first entry description = %v, want a non-empty string", first["description"])
	}
	defaults, ok := first["defaults"].(map[string]any)
	if !ok {
		t.Fatalf("first entry defaults is not an object: %v", first["defaults"])
	}
	if defaults["sizeX"].(float64) != 32 || defaults["minY"].(float64) != -8 {
		t.Errorf("first entry defaults = %+v, want sizeX=32 minY=-8 (void preset)", defaults)
	}
	materials, ok := first["materials"].(map[string]any)
	if !ok {
		t.Fatalf("first entry materials is not an object: %v", first["materials"])
	}
	if materials["topMaterial"] != "minecraft:air" {
		t.Errorf("first entry materials.topMaterial = %v, want minecraft:air (void preset)", materials["topMaterial"])
	}
	if first["biome"] != "void" {
		t.Errorf("first entry biome = %v, want %q", first["biome"], "void")
	}
	tags, ok := first["biomeTags"].([]any)
	if !ok || len(tags) != 0 {
		t.Errorf("first entry biomeTags = %v, want an empty array (void preset has no tags)", first["biomeTags"])
	}
}

// TestServe_LoadPackThenGenerateRoundTrip proves the "load a pack once,
// then regenerate repeatedly without restarting" requirement: one loadPack
// call followed by two independent generate calls in the SAME server
// instance, neither of which re-supplies pack file paths.
func TestServe_LoadPackThenGenerateRoundTrip(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	loadReq := fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root)
	genReq := `{"id":2,"method":"generate","params":{"feature":"test:place_diamond","env":"void"}}`
	genReq2 := `{"id":3,"method":"generate","params":{"feature":"test:place_diamond","env":"void","seed":7}}`

	resps := runLines(t, loadReq, genReq, genReq2)
	if len(resps) != 3 {
		t.Fatalf("got %d responses, want 3", len(resps))
	}
	for i, r := range resps {
		if r.Error != nil {
			t.Fatalf("response %d has an unexpected error: %+v", i, r.Error)
		}
	}

	loadResult, ok := resps[0].Result.(map[string]any)
	if !ok || loadResult["featureCount"].(float64) != 1 {
		t.Errorf("loadPack result = %+v, want featureCount=1", resps[0].Result)
	}

	gen1, ok := resps[1].Result.(map[string]any)
	if !ok {
		t.Fatalf("generate result is not an object: %v", resps[1].Result)
	}
	if gen1["blocksPlaced"].(float64) != 1 {
		t.Errorf("first generate blocksPlaced = %v, want 1", gen1["blocksPlaced"])
	}

	gen2, ok := resps[2].Result.(map[string]any)
	if !ok {
		t.Fatalf("second generate result is not an object: %v", resps[2].Result)
	}
	if gen2["featureSeed"].(float64) != 7 {
		t.Errorf("second generate featureSeed = %v, want 7 (per-call seed override honoured on a reused pack)", gen2["featureSeed"])
	}
}

// TestServe_GenerateGrownMethod proves the "generateGrown" method (methodGenerateGrown, wire.
// RunGenerateGrownFromWorkspace) is reachable over the same request/response loop as "generate"
// and "loadPack" -- a feature placing a fixed offset outside a small bench captures that write on
// a plain "generate" call, and "generateGrown" reports grown:true plus a larger bench that
// actually contains it.
func TestServe_GenerateGrownMethod(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "leaf.json"), singleBlockFeatureJSON("test:leaf", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "root.json"), scatterFeatureFixedOffsetJSON("test:root", "test:leaf", 100, 0, 0))

	loadReq := fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root)
	genReq := `{"id":2,"method":"generate","params":{"feature":"test:root","env":"void","origin":"0,0,0","size":"8x8x8"}}`
	growReq := `{"id":3,"method":"generateGrown","params":{"feature":"test:root","env":"void","origin":"0,0,0","size":"8x8x8"}}`

	resps := runLines(t, loadReq, genReq, growReq)
	if len(resps) != 3 {
		t.Fatalf("got %d responses, want 3", len(resps))
	}
	for i, r := range resps {
		if r.Error != nil {
			t.Fatalf("response %d has an unexpected error: %+v", i, r.Error)
		}
	}

	gen, ok := resps[1].Result.(map[string]any)
	if !ok {
		t.Fatalf("generate result is not an object: %v", resps[1].Result)
	}
	if gen["writesOutOfBounds"].(float64) != 1 {
		t.Errorf("plain generate writesOutOfBounds = %v, want 1", gen["writesOutOfBounds"])
	}
	overflow, ok := gen["overflowBlocks"].([]any)
	if !ok || len(overflow) != 1 {
		t.Fatalf("plain generate overflowBlocks = %v, want exactly 1 captured block", gen["overflowBlocks"])
	}

	grown, ok := resps[2].Result.(map[string]any)
	if !ok {
		t.Fatalf("generateGrown result is not an object: %v", resps[2].Result)
	}
	if grown["grown"] != true {
		t.Errorf("generateGrown grown = %v, want true", grown["grown"])
	}
	if grown["preGrowBounds"] == nil {
		t.Error("generateGrown preGrowBounds should be present when grown is true")
	}
	if grown["writesOutOfBounds"].(float64) != 0 {
		t.Errorf("generateGrown writesOutOfBounds = %v, want 0 (the grown bench contains the write)", grown["writesOutOfBounds"])
	}
	if grown["blocksPlaced"].(float64) != 1 {
		t.Errorf("generateGrown blocksPlaced = %v, want 1", grown["blocksPlaced"])
	}
}

// TestServe_GenerateUnknownFeatureReturnsDiagnosticNotProcessError proves `serve`'s side of the
// exit-code decision: an unresolved --feature/--rule fails the ONE-SHOT `generate`
// subcommand's process exit code (see resolve_exitcode_test.go), but `serve` is a long-lived loop
// a VS Code extension/desktop app keeps open across many requests -- an "error" belongs in THIS
// response's own diagnostics/error field, never as a reason to kill the process other requests are
// still waiting on. A request right after the unresolved one, in the SAME server instance, must
// still succeed normally, proving the server itself is unaffected.
func TestServe_GenerateUnknownFeatureReturnsDiagnosticNotProcessError(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	loadReq := fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root)
	badFeatureReq := `{"id":2,"method":"generate","params":{"feature":"test:does_not_exist","env":"void"}}`
	badRuleReq := `{"id":3,"method":"generate","params":{"rule":"test:does_not_exist","env":"void"}}`
	goodReq := `{"id":4,"method":"generate","params":{"feature":"test:place_diamond","env":"void"}}`

	resps := runLines(t, loadReq, badFeatureReq, badRuleReq, goodReq)
	if len(resps) != 4 {
		t.Fatalf("got %d responses, want 4 -- the process must stay alive through the two unresolved requests", len(resps))
	}
	for i, r := range resps {
		if r.Error != nil {
			t.Fatalf("response %d has a transport-level error (should never happen here -- the pack IS loaded and the request IS well-formed, only the requested identifier is unresolved): %+v", i, r.Error)
		}
	}

	badFeature, ok := resps[1].Result.(map[string]any)
	if !ok {
		t.Fatalf("response 2 result is not an object: %v", resps[1].Result)
	}
	diags, ok := badFeature["diagnostics"].([]any)
	if !ok || len(diags) == 0 {
		t.Fatalf("response 2 diagnostics = %v, want an error entry naming test:does_not_exist", badFeature["diagnostics"])
	}
	d, ok := diags[0].(map[string]any)
	if !ok || d["level"] != "error" || !strings.Contains(d["message"].(string), "test:does_not_exist") {
		t.Errorf("response 2 diagnostics[0] = %+v, want an error naming test:does_not_exist", d)
	}

	badRule, ok := resps[2].Result.(map[string]any)
	if !ok {
		t.Fatalf("response 3 result is not an object: %v", resps[2].Result)
	}
	if badRule["activeRule"] != nil {
		t.Errorf("response 3 activeRule = %v, want null", badRule["activeRule"])
	}
	ruleDiags, ok := badRule["diagnostics"].([]any)
	if !ok || len(ruleDiags) == 0 {
		t.Fatalf("response 3 diagnostics = %v, want an error entry naming test:does_not_exist", badRule["diagnostics"])
	}

	// The server itself must be completely unaffected: the very next request, in the same
	// process, still succeeds normally.
	good, ok := resps[3].Result.(map[string]any)
	if !ok {
		t.Fatalf("response 4 result is not an object: %v", resps[3].Result)
	}
	if good["blocksPlaced"].(float64) != 1 {
		t.Errorf("response 4 blocksPlaced = %v, want 1 -- the server must still work normally after the two unresolved requests", good["blocksPlaced"])
	}
}

func TestServe_GenerateGrownBeforeLoadPackIsAnError(t *testing.T) {
	resps := runLines(t, `{"id":1,"method":"generateGrown","params":{"feature":"x:y"}}`)
	if len(resps) != 1 {
		t.Fatalf("got %d responses, want 1", len(resps))
	}
	if resps[0].Error == nil {
		t.Fatal("expected an error before any pack is loaded")
	}
}

// --- "reloadFile": the single-file counterpart to loadPack -----------------
//
// These pin methodReloadFile's four decided cases (edited/new/deleted/
// foreign path) plus the one that is the whole point: after a single-file
// reload, the very NEXT generate shows the edit. A fast reload that leaves
// a stale preview behind is worse than the slow one it replaces, so that is
// asserted through the dispatch path a real client drives, not by reading
// the workspace from the inside.

// handleLines feeds each line to ONE long-lived serverState and returns the
// responses, JSON-round-tripped so assertions read exactly like runLines'.
// runLines can't be used for these: it hands runServe a string that already
// contains every line, so a test can't change a file on disk BETWEEN two
// requests -- which is the entire situation "reloadFile" exists for. Same
// state across calls means the same server session, so a load in one call
// is still loaded in the next.
func handleLines(t *testing.T, state *serverState, lines ...string) []Response {
	t.Helper()
	var resps []Response
	for _, line := range lines {
		raw, err := json.Marshal(handleLine(state, []byte(line)))
		if err != nil {
			t.Fatalf("marshalling the response to %s: %v", line, err)
		}
		var r Response
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatalf("response is not valid JSON: %s: %v", raw, err)
		}
		resps = append(resps, r)
	}
	return resps
}

// placedBlockNames reports the name of every block this run actually WROTE:
// the changed-cell mask picked out of the response, resolved through the
// run's own palette. Deliberately not just "what is in the palette" -- the
// palette is the Workspace's shared, append-only block table, so a block
// interned by an EARLIER generate in the same session is still listed long
// after the file that mentioned it stopped placing it. Asserting on the
// palette would therefore pass whether or not the reload took effect.
func placedBlockNames(t *testing.T, result any) []string {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("re-marshalling the generate result: %v", err)
	}
	var decoded struct {
		Blocks  session.CellIDs  `json:"blocks"`
		Changed session.CellMask `json:"changed"`
		Palette []block.Entry    `json:"palette"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decoding the generate result: %v", err)
	}
	names := make(map[block.ID]string, len(decoded.Palette))
	for _, e := range decoded.Palette {
		names[e.ID] = e.Name
	}
	var placed []string
	for i, changed := range decoded.Changed {
		if changed == 0 || i >= len(decoded.Blocks) {
			continue
		}
		placed = append(placed, names[decoded.Blocks[i]])
	}
	return placed
}

// featureIdentifiers pulls the identifier of every feature FILE the loaded
// pack has (the `entries` catalogue a client builds its Feature picker
// from) out of a generate response.
func featureIdentifiers(t *testing.T, result any) []string {
	t.Helper()
	obj, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("generate result is not an object: %v", result)
	}
	entries, ok := obj["entries"].([]any)
	if !ok {
		t.Fatalf("generate result has no entries: %v", obj["entries"])
	}
	var ids []string
	for _, entry := range entries {
		e, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("entry is not an object: %v", entry)
		}
		id, _ := e["identifier"].(string)
		ids = append(ids, id)
	}
	return ids
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func assertNoErrors(t *testing.T, resps []Response) {
	t.Helper()
	for _, r := range resps {
		if r.Error != nil {
			t.Fatalf("response %v has an unexpected error: %+v", r.ID, r.Error)
		}
	}
}

// TestServe_ReloadFileThenGenerateShowsTheEdit is the one that matters: the
// save-to-preview loop end to end. A feature file is edited on disk between
// two generates with only a "reloadFile" in between -- no "loadPack" -- and
// the second generate must place what the EDITED file says.
func TestServe_ReloadFileThenGenerateShowsTheEdit(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "features", "place.json")
	writeTestFile(t, path, singleBlockFeatureJSON("test:place", "minecraft:diamond_block"))

	state := &serverState{}
	genReq := `{"id":2,"method":"generate","params":{"feature":"test:place","env":"void"}}`
	before := handleLines(t, state,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		genReq,
	)
	assertNoErrors(t, before)
	if names := placedBlockNames(t, before[1].Result); !containsString(names, "minecraft:diamond_block") {
		t.Fatalf("first generate placed %v, want the pre-edit block", names)
	}

	writeTestFile(t, path, singleBlockFeatureJSON("test:place", "minecraft:gold_block"))

	after := handleLines(t, state,
		fmt.Sprintf(`{"id":3,"method":"reloadFile","params":{"dir":%q,"path":%q}}`, root, path),
		genReq,
	)
	assertNoErrors(t, after)
	names := placedBlockNames(t, after[1].Result)
	if !containsString(names, "minecraft:gold_block") {
		t.Errorf("generate after reloadFile placed %v, want minecraft:gold_block -- the preview is STALE, which is worse than a slow reload", names)
	}
	if containsString(names, "minecraft:diamond_block") {
		t.Errorf("generate after reloadFile still placed the pre-edit block: %v", names)
	}
}

// TestServe_ReloadFileAddsAFileTheLoadNeverSaw covers the "new file" case:
// a feature created after the pack was loaded has to become resolvable and
// has to appear in the catalogue a client's picker is built from.
func TestServe_ReloadFileAddsAFileTheLoadNeverSaw(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "old.json"), singleBlockFeatureJSON("test:old", "minecraft:diamond_block"))

	state := &serverState{}
	assertNoErrors(t, handleLines(t, state, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root)))

	added := filepath.Join(root, "features", "added.json")
	writeTestFile(t, added, singleBlockFeatureJSON("test:added", "minecraft:gold_block"))

	resps := handleLines(t, state,
		fmt.Sprintf(`{"id":2,"method":"reloadFile","params":{"path":%q}}`, added),
		`{"id":3,"method":"generate","params":{"feature":"test:added","env":"void"}}`,
	)
	assertNoErrors(t, resps)

	reload, ok := resps[0].Result.(map[string]any)
	if !ok || reload["featureCount"].(float64) != 2 {
		t.Errorf("reloadFile result = %+v, want featureCount=2", resps[0].Result)
	}
	gen, ok := resps[1].Result.(map[string]any)
	if !ok {
		t.Fatalf("generate result is not an object: %v", resps[1].Result)
	}
	if gen["blocksPlaced"].(float64) != 1 {
		t.Errorf("blocksPlaced = %v, want 1 -- the feature added after the load did not resolve", gen["blocksPlaced"])
	}
	if ids := featureIdentifiers(t, resps[1].Result); !containsString(ids, "test:added") {
		t.Errorf("entries = %v, want the added feature in the catalogue", ids)
	}
}

// TestServe_ReloadFileDropsAFileDeletedFromDisk is the mirror image, and
// the case a naive implementation gets wrong by reading "cannot read it" as
// "leave it alone": a feature whose file is gone must stop resolving, or
// the preview keeps placing something the pack no longer defines.
func TestServe_ReloadFileDropsAFileDeletedFromDisk(t *testing.T) {
	root := t.TempDir()
	doomed := filepath.Join(root, "features", "doomed.json")
	writeTestFile(t, doomed, singleBlockFeatureJSON("test:doomed", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "kept.json"), singleBlockFeatureJSON("test:kept", "minecraft:gold_block"))

	state := &serverState{}
	assertNoErrors(t, handleLines(t, state, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root)))

	if err := os.Remove(doomed); err != nil {
		t.Fatal(err)
	}

	resps := handleLines(t, state,
		fmt.Sprintf(`{"id":2,"method":"reloadFile","params":{"path":%q}}`, doomed),
		`{"id":3,"method":"generate","params":{"feature":"test:doomed","env":"void"}}`,
	)
	if resps[0].Error != nil {
		t.Fatalf("reloadFile of a deleted file should succeed by dropping it, got %+v", resps[0].Error)
	}
	reload, ok := resps[0].Result.(map[string]any)
	if !ok || reload["featureCount"].(float64) != 1 {
		t.Errorf("reloadFile result = %+v, want featureCount=1", resps[0].Result)
	}
	gen, ok := resps[1].Result.(map[string]any)
	if !ok {
		t.Fatalf("generate result is not an object: %v", resps[1].Result)
	}
	if gen["blocksPlaced"].(float64) != 0 {
		t.Errorf("blocksPlaced = %v, want 0 -- the deleted feature is still being placed", gen["blocksPlaced"])
	}
	if diags, ok := gen["diagnostics"].([]any); !ok || len(diags) == 0 {
		t.Errorf("diagnostics = %v, want an error naming the now-missing feature", gen["diagnostics"])
	}
	if ids := featureIdentifiers(t, resps[1].Result); containsString(ids, "test:doomed") {
		t.Errorf("entries = %v, want the deleted feature gone from the catalogue", ids)
	}
}

// TestServe_ReloadFileOutsideTheLoadedPackIsRefused -- a refusal is the
// client's cue to fall back to a full "loadPack". Both flavours are
// refused: a path under no loaded directory at all, and a path claimed to
// belong to a DIFFERENT pack than the loaded one (which would otherwise
// splice one pack's file into another's workspace and preview something
// that exists nowhere on disk).
func TestServe_ReloadFileOutsideTheLoadedPackIsRefused(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "a.json"), singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	other := t.TempDir()
	outside := filepath.Join(other, "notes.json")
	writeTestFile(t, outside, `{"x":1}`)

	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		fmt.Sprintf(`{"id":2,"method":"reloadFile","params":{"path":%q}}`, outside),
		fmt.Sprintf(`{"id":3,"method":"reloadFile","params":{"dir":%q,"path":%q}}`, other, filepath.Join(other, "features", "a.json")),
		`{"id":4,"method":"reloadFile","params":{}}`,
		`{"id":5,"method":"generate","params":{"feature":"test:a","env":"void"}}`,
	)
	if len(resps) != 5 {
		t.Fatalf("got %d responses, want 5", len(resps))
	}
	if resps[1].Error == nil {
		t.Errorf("reloadFile of a path outside the pack returned %+v, want an error the client can fall back on", resps[1].Result)
	} else if !strings.Contains(resps[1].Error.Message, "reload the whole pack") {
		t.Errorf("error message = %q, want it to name the fallback", resps[1].Error.Message)
	}
	if resps[2].Error == nil {
		t.Errorf("reloadFile naming a different pack returned %+v, want an error", resps[2].Result)
	}
	if resps[3].Error == nil {
		t.Errorf("reloadFile with no path returned %+v, want an error", resps[3].Result)
	}
	// A refused reload must leave the server exactly as it was.
	if resps[4].Error != nil {
		t.Fatalf("generate after three refused reloads: %+v", resps[4].Error)
	}
	if gen, ok := resps[4].Result.(map[string]any); !ok || gen["blocksPlaced"].(float64) != 1 {
		t.Errorf("generate after three refused reloads = %+v, want the pack still loaded and working", resps[4].Result)
	}
}

// TestServe_ReloadFileBeforeLoadPackIsAnError gives the same answer
// "generate" gives before a pack is loaded (errNoPackLoaded), because the
// client's recovery is the same one: load the pack first.
func TestServe_ReloadFileBeforeLoadPackIsAnError(t *testing.T) {
	resps := runLines(t, `{"id":1,"method":"reloadFile","params":{"path":"/pack/features/a.json"}}`)
	if len(resps) != 1 || resps[0].Error == nil {
		t.Fatalf("got %+v, want one error response", resps)
	}
	if !strings.Contains(resps[0].Error.Message, "no pack loaded") {
		t.Errorf("error message = %q, want the same wording generate uses before a load", resps[0].Error.Message)
	}
}

// TestServe_ReloadFileResultIsShapedLikeLoadPacks pins the
// interchangeability a client relies on: the same four counts, and the
// CURRENT pack's whole warning set -- not just whatever this one file had
// to say -- so warnings a client renders don't blink out on every save.
// See methodReloadFile's own doc comment for that decision.
func TestServe_ReloadFileResultIsShapedLikeLoadPacks(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "features", "a.json")
	writeTestFile(t, path, singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))

	// No structures/, feature_rules/ or biomes/ directory here: loadPack
	// warns about each, and reloadFile has to keep saying so.
	resps := runLines(t,
		fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root),
		fmt.Sprintf(`{"id":2,"method":"reloadFile","params":{"path":%q}}`, path),
	)
	if len(resps) != 2 {
		t.Fatalf("got %d responses, want 2", len(resps))
	}
	load, ok := resps[0].Result.(map[string]any)
	if !ok {
		t.Fatalf("loadPack result is not an object: %v", resps[0].Result)
	}
	reload, ok := resps[1].Result.(map[string]any)
	if !ok {
		t.Fatalf("reloadFile result is not an object: %v", resps[1].Result)
	}
	if !reflect.DeepEqual(load, reload) {
		t.Errorf("reloadFile result:\n%+v\nloadPack result:\n%+v\nwant them interchangeable for an unchanged file", reload, load)
	}
	if warnings, ok := reload["warnings"].([]any); !ok || len(warnings) == 0 {
		t.Errorf("reloadFile warnings = %v, want the loaded pack's whole warning set (three missing directories here)", reload["warnings"])
	}
}

// TestServe_ReloadFileNamingADifferentPackIsRefusedEvenForAFileOfTheLoadedOne
// is the "dir" param's own test, and it needs a path the loaded pack really
// does own. TestServe_ReloadFileOutsideTheLoadedPackIsRefused above also
// sends a mismatched "dir", but with a path under the OTHER pack, which
// pack.Pack.ReloadFile refuses on its own -- so that case says nothing about
// whether the guard exists at all.
//
// What the guard is actually for (see reloadFileParams.Dir): a client with
// two pack roots open, whose editor reports a save in pack A while the
// server holds pack B. Without the guard the file is spliced into whichever
// pack happens to be loaded and the response looks like an ordinary
// success, so the client goes on previewing a pack that exists nowhere on
// disk. With it, the client is told which pack IS loaded and calls loadPack
// for the one it meant.
func TestServe_ReloadFileNamingADifferentPackIsRefusedEvenForAFileOfTheLoadedOne(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "features", "a.json")
	writeTestFile(t, path, singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	otherPack := t.TempDir()
	writeTestFile(t, filepath.Join(otherPack, "features", "a.json"), singleBlockFeatureJSON("test:a", "minecraft:gold_block"))

	state := &serverState{}
	assertNoErrors(t, handleLines(t, state, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root)))

	// The edit is real and the path IS reloadable -- only the pack named
	// alongside it is the wrong one.
	writeTestFile(t, path, singleBlockFeatureJSON("test:a", "minecraft:emerald_block"))

	resps := handleLines(t, state,
		fmt.Sprintf(`{"id":2,"method":"reloadFile","params":{"dir":%q,"path":%q}}`, otherPack, path),
		`{"id":3,"method":"generate","params":{"feature":"test:a","env":"void"}}`,
	)
	if resps[0].Error == nil {
		t.Fatalf("reloadFile naming %s while %s is loaded returned %+v, want an error telling the client to load that pack first", otherPack, root, resps[0].Result)
	}
	if !strings.Contains(resps[0].Error.Message, "loadPack") {
		t.Errorf("error message = %q, want it to name the client's recovery", resps[0].Error.Message)
	}
	// A refused reload must not have spliced anything: the pack is still
	// exactly what the last loadPack read.
	if resps[1].Error != nil {
		t.Fatalf("generate after the refused reload: %+v", resps[1].Error)
	}
	names := placedBlockNames(t, resps[1].Result)
	if !containsString(names, "minecraft:diamond_block") {
		t.Errorf("generate after the refused reload placed %v, want the pre-edit block -- the guard refused and then spliced anyway", names)
	}
}

// The `atlas` method: block textures reach every host over this same channel rather than
// through three separate asset paths (see wire/atlas.go). Pack-independent, like `environments`
// and `types` -- callable before any loadPack.
func TestServe_AtlasMethodReturnsTheTableAndTheImage(t *testing.T) {
	dir := t.TempDir()
	// Our own bytes, not Mojang's: this method delivers an image, it never decodes one.
	if err := os.WriteFile(filepath.Join(dir, "atlas.json"), []byte(`{"version":1,"cell":16}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "atlas.png"), []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}

	resps := runLines(t, fmt.Sprintf(`{"id":1,"method":"atlas","params":{"dir":%q}}`, filepath.ToSlash(dir)))
	if len(resps) != 1 || resps[0].Error != nil {
		t.Fatalf("got %+v", resps)
	}
	result, ok := resps[0].Result.(map[string]any)
	if !ok {
		t.Fatalf("result is not an object: %v", resps[0].Result)
	}
	table, ok := result["table"].(map[string]any)
	if !ok {
		t.Fatalf("table is not an object: %v", result["table"])
	}
	if table["version"] != float64(1) {
		t.Errorf("table version = %v, want 1", table["version"])
	}
	if result["png"] != base64.StdEncoding.EncodeToString([]byte{1, 2, 3}) {
		t.Errorf("png = %v, want the base64 of the file's bytes", result["png"])
	}
}

// "No atlas built yet" is the state every machine starts in, and it must come back as an
// ordinary error response rather than crashing the server or returning a null result the
// frontend would have to guess about.
func TestServe_AtlasMethodWithNoAtlasIsAnOrdinaryError(t *testing.T) {
	resps := runLines(t, fmt.Sprintf(`{"id":1,"method":"atlas","params":{"dir":%q}}`, filepath.ToSlash(filepath.Join(t.TempDir(), "nothing-here"))))
	if len(resps) != 1 || resps[0].Error == nil {
		t.Fatalf("got %+v, want an error response", resps)
	}
	if !strings.Contains(resps[0].Error.Message, "flat block colours") {
		t.Errorf("error = %q, want it to say what happens instead", resps[0].Error.Message)
	}
}

// TestServe_LoadPackOnAPackRootThatIsNotThereIsAnError is the long-lived
// server's share of the bug the CLI commands cover in check_test.go: nothing
// stat'd the pack root, so "loadPack" on a directory that does not exist
// answered with a perfectly ordinary result carrying zero of everything. The
// extension then drew an empty graph and an empty palette for a pack whose
// path was simply wrong, with nothing anywhere saying so -- and, worse, kept
// serving that empty pack for the rest of the session.
//
// It has to be an ERROR response rather than a result with zero counts,
// because a client cannot tell that result from a real pack whose files are
// all somewhere else, and the error is the only thing that makes it say which
// path it tried.
func TestServe_LoadPackOnAPackRootThatIsNotThereIsAnError(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no_such_pack")
	resps := runLines(t, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, missing))
	if len(resps) != 1 {
		t.Fatalf("got %d responses, want 1", len(resps))
	}
	if resps[0].Error == nil {
		t.Fatalf("loadPack on a missing pack root answered with a result (%+v), not an error", resps[0].Result)
	}
	if !strings.Contains(resps[0].Error.Message, missing) {
		t.Errorf("error = %q, want it to name the path %q", resps[0].Error.Message, missing)
	}
}
