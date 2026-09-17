package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// annotatePack writes a two-feature pack and loads it, for the tests below. The files are written
// with an explicit line-ending style each, because what a removal leaves behind is the whole
// point of half of these tests.
func annotatePack(t *testing.T) (root string, state *serverState) {
	t.Helper()
	root = t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "a.json"),
		"{\n  \"format_version\": \"1.21.110\",\n  \"minecraft:single_block_feature\": {\n    \"description\": { \"identifier\": \"test:a\" },\n    \"enforce_placement_rules\": false,\n    \"enforce_survivability_rules\": false,\n    \"places_block\": \"minecraft:stone\"\n  }\n}\n")
	writeTestFile(t, filepath.Join(root, "features", "b.json"),
		"{\r\n  \"format_version\": \"1.21.110\",\r\n  \"minecraft:single_block_feature\": {\r\n    \"description\": { \"identifier\": \"test:b\" },\r\n    \"enforce_placement_rules\": false,\r\n    \"enforce_survivability_rules\": false,\r\n    \"places_block\": \"minecraft:stone\"\r\n  }\r\n}\r\n")
	state = &serverState{}
	assertNoErrors(t, handleLines(t, state, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root)))
	return root, state
}

func readPackFile(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// graphAnnotations asks the loaded engine what it now believes, which is the thing the editor
// draws from: a directive on disk that the graph does not carry is a directive the editor cannot
// see, and the reload after a write is what puts it there.
func graphAnnotations(t *testing.T, state *serverState, nodeID string) []map[string]any {
	t.Helper()
	resps := handleLines(t, state, `{"id":9,"method":"graph"}`)
	assertNoErrors(t, resps)
	raw, err := json.Marshal(resps[0].Result)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Nodes []struct {
			ID          string           `json:"id"`
			Annotations []map[string]any `json:"annotations"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	for _, n := range g.Nodes {
		if n.ID == nodeID {
			return n.Annotations
		}
	}
	t.Fatalf("graph has no node %s", nodeID)
	return nil
}

// TestServe_AnnotateWritesAndReloads pins the single-directive method that the batch is built
// beside: the directive lands on the file's root, and the graph sees it without a reload request.
func TestServe_AnnotateWritesAndReloads(t *testing.T) {
	root, state := annotatePack(t)
	resps := handleLines(t, state,
		`{"id":2,"method":"annotate","params":{"file":"features/a.json","path":"$","name":"group","args":["trees","expanded","Big","Trees"]}}`)
	assertNoErrors(t, resps)
	if !strings.HasPrefix(readPackFile(t, root, "features/a.json"), "// @featurelab:group trees expanded Big Trees\n{") {
		t.Fatalf("the directive is not on the root line:\n%s", readPackFile(t, root, "features/a.json"))
	}
	anns := graphAnnotations(t, state, "test:a")
	if len(anns) != 1 || anns[0]["name"] != "group" || anns[0]["jsonPath"] != "$" {
		t.Fatalf("graph annotations after annotate = %v", anns)
	}
}

// TestServe_AnnotateBatchWritesEveryFileOnce is the ordinary group operation: one directive on
// each member, both files rewritten, the graph carrying both, and each file's own line-ending
// style intact.
func TestServe_AnnotateBatchWritesEveryFileOnce(t *testing.T) {
	root, state := annotatePack(t)
	resps := handleLines(t, state,
		`{"id":2,"method":"annotateBatch","params":{"ops":[`+
			`{"file":"features/a.json","path":"$","name":"group","args":["trees","expanded","Big","Trees"]},`+
			`{"file":"features/b.json","path":"$","name":"group","args":["trees","expanded","Big","Trees"]}]}}`)
	assertNoErrors(t, resps)
	result, ok := resps[0].Result.(map[string]any)
	if !ok || result["changed"].(float64) != 2 {
		t.Fatalf("result = %+v, want changed=2", resps[0].Result)
	}
	a := readPackFile(t, root, "features/a.json")
	b := readPackFile(t, root, "features/b.json")
	if !strings.HasPrefix(a, "// @featurelab:group trees expanded Big Trees\n{\n") {
		t.Errorf("a.json:\n%q", a)
	}
	if !strings.HasPrefix(b, "// @featurelab:group trees expanded Big Trees\r\n{\r\n") {
		t.Errorf("b.json kept neither the directive nor its CRLF endings:\n%q", b)
	}
	if strings.Contains(b, "\n{") && !strings.Contains(b, "\r\n{") {
		t.Errorf("b.json lost its CRLF style: %q", b)
	}
	for _, id := range []string{"test:a", "test:b"} {
		anns := graphAnnotations(t, state, id)
		if len(anns) != 1 || anns[0]["name"] != "group" {
			t.Errorf("%s: graph annotations = %v, want the group directive", id, anns)
		}
	}
}

// TestServe_AnnotateBatchRemovesWithoutLeavingBlankLines is ungrouping: after the batch neither
// file carries the directive, and neither carries the empty line a naive removal leaves.
func TestServe_AnnotateBatchRemovesWithoutLeavingBlankLines(t *testing.T) {
	root, state := annotatePack(t)
	beforeA := readPackFile(t, root, "features/a.json")
	beforeB := readPackFile(t, root, "features/b.json")
	set := `{"id":2,"method":"annotateBatch","params":{"ops":[` +
		`{"file":"features/a.json","path":"$","name":"group","args":["trees","collapsed","T"]},` +
		`{"file":"features/b.json","path":"$","name":"group","args":["trees","collapsed","T"]}]}}`
	remove := `{"id":3,"method":"annotateBatch","params":{"ops":[` +
		`{"file":"features/a.json","path":"$","name":"group","remove":true},` +
		`{"file":"features/b.json","path":"$","name":"group","remove":true}]}}`
	assertNoErrors(t, handleLines(t, state, set, remove))
	if got := readPackFile(t, root, "features/a.json"); got != beforeA {
		t.Errorf("a.json after set+remove:\n%q\nwant the original:\n%q", got, beforeA)
	}
	if got := readPackFile(t, root, "features/b.json"); got != beforeB {
		t.Errorf("b.json after set+remove:\n%q\nwant the original:\n%q", got, beforeB)
	}
	if anns := graphAnnotations(t, state, "test:a"); len(anns) != 0 {
		t.Errorf("the graph still carries %v after removal", anns)
	}
}

// TestServe_AnnotateBatchIsAllOrNothing is the property the batch exists for: one bad op refuses
// the whole batch and the good ops beside it write nothing.
func TestServe_AnnotateBatchIsAllOrNothing(t *testing.T) {
	root, state := annotatePack(t)
	before := readPackFile(t, root, "features/a.json")
	resps := handleLines(t, state,
		`{"id":2,"method":"annotateBatch","params":{"ops":[`+
			`{"file":"features/a.json","path":"$","name":"group","args":["trees","expanded","T"]},`+
			`{"file":"../outside.json","path":"$","name":"group","args":["trees","expanded","T"]}]}}`)
	if resps[0].Error == nil {
		t.Fatal("a batch with an op outside the pack was accepted")
	}
	if got := readPackFile(t, root, "features/a.json"); got != before {
		t.Errorf("the good op was written despite the refusal:\n%q", got)
	}
	// The same for an argument the Args contract cannot carry.
	resps = handleLines(t, state,
		`{"id":3,"method":"annotateBatch","params":{"ops":[`+
			`{"file":"features/a.json","path":"$","name":"group","args":["trees","expanded","T"]},`+
			`{"file":"features/b.json","path":"$","name":"group","args":["trees","expanded","two words"]}]}}`)
	if resps[0].Error == nil {
		t.Fatal("an argument with whitespace was accepted")
	}
	if got := readPackFile(t, root, "features/a.json"); got != before {
		t.Errorf("the good op was written despite the refusal:\n%q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "..", "outside.json")); err == nil {
		t.Error("a file was written outside the pack")
	}
}

// TestServe_AnnotateBatchAppliesOpsToOneFileInOrder: two ops on the same file see each other's
// result, so a remove-then-set in one batch ends with exactly the set.
func TestServe_AnnotateBatchAppliesOpsToOneFileInOrder(t *testing.T) {
	root, state := annotatePack(t)
	assertNoErrors(t, handleLines(t, state,
		`{"id":2,"method":"annotateBatch","params":{"ops":[`+
			`{"file":"features/a.json","path":"$","name":"group","args":["old","expanded","Old"]},`+
			`{"file":"features/a.json","path":"$","name":"group","remove":true},`+
			`{"file":"features/a.json","path":"$","name":"group","args":["new","collapsed","New"]}]}}`))
	got := readPackFile(t, root, "features/a.json")
	if strings.Count(got, "@featurelab:group") != 1 || !strings.Contains(got, "@featurelab:group new collapsed New") {
		t.Fatalf("a.json after remove-then-set:\n%q", got)
	}
}

// TestServe_AnnotateBatchRefusesWithoutOps: an empty batch is a malformed request, not a no-op
// that silently reports success.
func TestServe_AnnotateBatchRefusesWithoutOps(t *testing.T) {
	_, state := annotatePack(t)
	resps := handleLines(t, state, `{"id":2,"method":"annotateBatch","params":{"ops":[]}}`)
	if resps[0].Error == nil {
		t.Fatal("an empty batch was accepted")
	}
}
