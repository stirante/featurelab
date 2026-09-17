package main

// lifecycle_test.go tests "renameFeature" and "deleteFeature" by what they do
// to the FILES, not by what they answer.
//
// That is the whole subject. Both methods exist because an operation on one
// feature reaches files the author is not looking at, so every assertion here
// reads the pack back off disk afterwards: the file that was supposed to
// change did, the files that were not supposed to change are byte-identical,
// and a refusal left every single one of them alone.
//
// The fixtures carry comments, deliberately odd key order and two-space and
// four-space indentation, because surviving those is the reason these methods
// go through the round-trip writer instead of decoding and re-encoding. A test
// that used tidy minified JSON would pass against an implementation that
// rewrote every line of the author's file.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// aggregateOfTwo is written the way a person writes one: a comment above the
// list, `features` before `description`, and four-space indentation. Nothing
// but the one entry that is renamed or removed may move.
const aggregateOfTwo = `{
    "format_version": "1.21.110",
    "minecraft:aggregate_feature": {
        // the two halves of the patch, placed together
        "features": [
            "example:oak",
            "example:fern"
        ],
        "description": {
            "identifier": "example:patch"
        }
    }
}
`

const singleBlockWithComment = `{
    "format_version": "1.21.110",
    "minecraft:single_block_feature": {
        "description": {
            // renaming this must not disturb the comment beside it
            "identifier": "%s"
        },
        "places_block": "%s",
        "enforce_placement_rules": false,
        "enforce_survivability_rules": false
    }
}
`

const ruleFile = `{
    "format_version": "1.21.110",
    "minecraft:feature_rules": {
        "description": {
            "identifier": "example:patch_rule",
            "places_feature": "example:patch"
        },
        "conditions": {
            "placement_pass": "surface_pass",
            "minecraft:biome_filter": [{ "test": "has_biome_tag", "operator": "==", "value": "overworld" }]
        },
        "distribution": {
            "iterations": 1,
            "x": 0,
            "y": 0,
            "z": 0
        }
    }
}
`

func blockFeature(id, name string) string { return fmt.Sprintf(singleBlockWithComment, id, name) }

// lifecyclePack writes a pack shaped like the smallest real one: a rule into
// an aggregate into two single-block features.
func lifecyclePack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "patch.json"), aggregateOfTwo)
	writeTestFile(t, filepath.Join(root, "features", "oak.json"), blockFeature("example:oak", "minecraft:oak_log"))
	writeTestFile(t, filepath.Join(root, "features", "fern.json"), blockFeature("example:fern", "minecraft:fern"))
	writeTestFile(t, filepath.Join(root, "feature_rules", "patch_rule.json"), ruleFile)
	return root
}

// snapshot is every file in the pack and its exact bytes, so a test can assert
// that a refusal wrote nothing anywhere rather than only that the one file it
// thought about is unchanged.
func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func assertPackUnchanged(t *testing.T, root string, before map[string]string) {
	t.Helper()
	after := snapshot(t, root)
	for rel, was := range before {
		now, ok := after[rel]
		if !ok {
			t.Errorf("%s was removed, and nothing should have been written", rel)
			continue
		}
		if now != was {
			t.Errorf("%s changed, and nothing should have been written:\n--- was ---\n%s\n--- now ---\n%s", rel, was, now)
		}
	}
	for rel := range after {
		if _, ok := before[rel]; !ok {
			t.Errorf("%s was created, and nothing should have been written", rel)
		}
	}
}

func read(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// loadedState is a server session with the fixture pack open, which is what
// both methods require before they will look at anything.
func loadedState(t *testing.T, root string) *serverState {
	t.Helper()
	state := &serverState{}
	resps := handleLines(t, state, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root))
	assertNoErrors(t, resps)
	return state
}

func call(t *testing.T, state *serverState, method string, params any) (map[string]any, string) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	resps := handleLines(t, state, fmt.Sprintf(`{"id":9,"method":%q,"params":%s}`, method, raw))
	r := resps[0]
	if r.Error != nil {
		return nil, r.Error.Message
	}
	encoded, err := json.Marshal(r.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	return result, ""
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

// TestRenameFeatureRewritesTheDeclarationAndEveryReference is the whole point
// of the method: a name lives in two kinds of place and both have to move
// together. It also pins the round trip -- the comment, the key order and the
// four-space indentation of the referring file all survive, because a rename
// that reformatted every file it touched would be turned off after one use.
func TestRenameFeatureRewritesTheDeclarationAndEveryReference(t *testing.T) {
	root := lifecyclePack(t)
	state := loadedState(t, root)

	result, errMsg := call(t, state, "renameFeature", map[string]any{"from": "example:oak", "to": "example:oak_log"})
	if errMsg != "" {
		t.Fatalf("the rename was refused: %s", errMsg)
	}

	declaring := read(t, root, "features/oak.json")
	if !strings.Contains(declaring, `"identifier": "example:oak_log"`) {
		t.Errorf("the declaring file does not carry the new identifier:\n%s", declaring)
	}
	if !strings.Contains(declaring, "// renaming this must not disturb the comment beside it") {
		t.Errorf("the comment beside the identifier was lost:\n%s", declaring)
	}
	if !strings.Contains(declaring, `"places_block": "minecraft:oak_log"`) {
		t.Errorf("the rest of the declaring file did not survive:\n%s", declaring)
	}

	referring := read(t, root, "features/patch.json")
	if !strings.Contains(referring, `"example:oak_log"`) {
		t.Errorf("the delegation was not rewritten:\n%s", referring)
	}
	if strings.Contains(referring, `"example:oak"`) {
		t.Errorf("the old name is still referenced, which would resolve to nothing:\n%s", referring)
	}
	if !strings.Contains(referring, `"example:fern"`) {
		t.Errorf("the sibling delegation was disturbed:\n%s", referring)
	}
	if !strings.Contains(referring, "// the two halves of the patch, placed together") {
		t.Errorf("the referring file's comment was lost:\n%s", referring)
	}
	if !strings.Contains(referring, "        \"features\": [") {
		t.Errorf("the referring file was re-indented:\n%s", referring)
	}
	// `features` was written before `description`, which no serialiser that
	// sorts keys would preserve.
	if strings.Index(referring, `"features"`) > strings.Index(referring, `"description"`) {
		t.Errorf("the referring file's key order was rewritten:\n%s", referring)
	}

	if got := result["references"]; got != float64(1) {
		t.Errorf("references = %v, want 1", got)
	}
	if got := result["file"]; got != "features/oak.json" {
		t.Errorf("file = %v, want the declaring file", got)
	}
}

// TestRenameFeatureDoesNotRenameTheFile pins the decision, because it is the
// one a future change is most likely to make quietly: the engine reads the
// identifier out of the file and derives nothing from the file's name, so the
// file stays where the author put it and where their editor has it open.
func TestRenameFeatureDoesNotRenameTheFile(t *testing.T) {
	root := lifecyclePack(t)
	state := loadedState(t, root)

	if _, errMsg := call(t, state, "renameFeature", map[string]any{"from": "example:oak", "to": "example:oak_log"}); errMsg != "" {
		t.Fatalf("the rename was refused: %s", errMsg)
	}
	if _, err := os.Stat(filepath.Join(root, "features", "oak.json")); err != nil {
		t.Errorf("the declaring file moved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "features", "oak_log.json")); err == nil {
		t.Errorf("a file was created at the new name; renaming a file is a separate decision the author makes")
	}
}

// TestRenameFeatureRefusesATakenName covers both shapes of collision, and
// asserts the same thing about each: NOTHING was written. The case-only clash
// is the one that matters -- the engine matches identifiers without regard to
// case, so it is not an error a pack reports, it is a feature that quietly
// stops being placed.
func TestRenameFeatureRefusesATakenName(t *testing.T) {
	for _, tc := range []struct {
		name string
		to   string
	}{
		{"the same name spelled the same way", "example:fern"},
		{"the same name spelled in another case", "example:FERN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := lifecyclePack(t)
			state := loadedState(t, root)
			before := snapshot(t, root)

			result, errMsg := call(t, state, "renameFeature", map[string]any{"from": "example:oak", "to": tc.to})
			if errMsg == "" {
				t.Fatalf("the rename onto a taken name was allowed: %v", result)
			}
			if !strings.Contains(errMsg, "features/fern.json") {
				t.Errorf("the refusal does not name the file that already holds it: %s", errMsg)
			}
			assertPackUnchanged(t, root, before)
		})
	}
}

// TestRenameFeatureAcceptsACaseOnlyRenameOfItself is the other side of that
// coin. "example:Oak" and "example:oak" are one name to the engine, so this
// changes nothing the pack generates -- which is exactly why an author does it
// and why every reference has to move with it, or the pack would be left
// spelling its own feature two ways.
func TestRenameFeatureAcceptsACaseOnlyRenameOfItself(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "patch.json"), aggregateOfTwo)
	writeTestFile(t, filepath.Join(root, "features", "oak.json"), blockFeature("example:Oak", "minecraft:oak_log"))
	writeTestFile(t, filepath.Join(root, "features", "fern.json"), blockFeature("example:fern", "minecraft:fern"))
	state := loadedState(t, root)

	result, errMsg := call(t, state, "renameFeature", map[string]any{"from": "example:Oak", "to": "example:oak"})
	if errMsg != "" {
		t.Fatalf("a rename that only fixes the case of a feature's own name was refused: %s", errMsg)
	}
	if declaring := read(t, root, "features/oak.json"); !strings.Contains(declaring, `"identifier": "example:oak"`) {
		t.Errorf("the declaration was not re-spelled:\n%s", declaring)
	}
	// The reference was already written in the new spelling, so the file is
	// untouched -- and the method must not rewrite identical bytes.
	if referring := read(t, root, "features/patch.json"); !strings.Contains(referring, `"example:oak"`) {
		t.Errorf("the delegation lost the name:\n%s", referring)
	}
	notes, _ := result["notes"].([]any)
	if len(notes) == 0 {
		t.Errorf("a rename that changes nothing the pack generates said nothing about it: %v", result)
	}
}

// TestRenameFeatureRefusesAMalformedName guards the one thing this tool can
// honestly say is wrong about a name. A reference is "namespace:name"; a bare
// name resolves against nothing, and a rename to one would break every file
// that points at the feature while looking like it worked.
func TestRenameFeatureRefusesAMalformedName(t *testing.T) {
	for _, to := range []string{"oak_log", "example:", ":oak", "example:oak:log", "example:oak log"} {
		root := lifecyclePack(t)
		state := loadedState(t, root)
		before := snapshot(t, root)
		if _, errMsg := call(t, state, "renameFeature", map[string]any{"from": "example:oak", "to": to}); errMsg == "" {
			t.Errorf("%q was accepted as a feature identifier", to)
		}
		assertPackUnchanged(t, root, before)
	}
}

// TestRenameFeatureRefusesAFeatureThePackDoesNotDefine covers the two ways
// that happens: a name nothing in the pack mentions, and a name something
// delegates to and no file defines. The second is the interesting one -- it IS
// in the graph, as a dangling reference, and there is still nothing to rename.
func TestRenameFeatureRefusesAFeatureThePackDoesNotDefine(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "patch.json"), strings.Replace(aggregateOfTwo, "example:fern", "example:missing", 1))
	writeTestFile(t, filepath.Join(root, "features", "oak.json"), blockFeature("example:oak", "minecraft:oak_log"))
	state := loadedState(t, root)
	before := snapshot(t, root)

	for _, from := range []string{"example:never_existed", "example:missing"} {
		if _, errMsg := call(t, state, "renameFeature", map[string]any{"from": from, "to": "example:new"}); errMsg == "" {
			t.Errorf("renaming %q, which no file defines, was allowed", from)
		}
	}
	assertPackUnchanged(t, root, before)
}

// TestRenameFeatureRefusesWhenTheFileChangedUnderneath is the reason neither
// method rewrites a path on the strength of the graph alone.
//
// The pack is loaded, then the referring file is edited outside this session
// so that the path the graph reported now holds a DIFFERENT feature. Writing
// there would silently retarget somebody else's delegation, and the path still
// resolves, so nothing would report it. The value at every path is therefore
// read back and checked before anything is planned.
func TestRenameFeatureRefusesWhenTheFileChangedUnderneath(t *testing.T) {
	root := lifecyclePack(t)
	state := loadedState(t, root)

	// features[0] no longer names example:oak.
	writeTestFile(t, filepath.Join(root, "features", "patch.json"),
		strings.Replace(aggregateOfTwo, `"example:oak",`, `"example:birch",`, 1))
	before := snapshot(t, root)

	result, errMsg := call(t, state, "renameFeature", map[string]any{"from": "example:oak", "to": "example:oak_log"})
	if errMsg == "" {
		t.Fatalf("a rename was written against a stale view of the pack: %v", result)
	}
	if !strings.Contains(errMsg, "features/patch.json") {
		t.Errorf("the refusal does not name the file that moved: %s", errMsg)
	}
	// The declaring file must be untouched too: a rename is both halves or
	// neither, so a refusal on the reference cannot have already written the
	// declaration.
	assertPackUnchanged(t, root, before)
}

// TestRenameFeatureOfARuleSaysWhatTheEngineWillLog. A feature rule is the one
// node whose file NAME the engine looks at: it compares the identifier's name
// half against the file's own name and logs when they differ. The rule still
// loads and still runs, so this is a note rather than a refusal -- but an
// author who is not told meets it in the log later.
func TestRenameFeatureOfARuleSaysWhatTheEngineWillLog(t *testing.T) {
	root := lifecyclePack(t)
	state := loadedState(t, root)

	result, errMsg := call(t, state, "renameFeature", map[string]any{"from": "example:patch_rule", "to": "example:meadow_rule"})
	if errMsg != "" {
		t.Fatalf("renaming a feature rule was refused: %s", errMsg)
	}
	if declaring := read(t, root, "feature_rules/patch_rule.json"); !strings.Contains(declaring, `"identifier": "example:meadow_rule"`) {
		t.Errorf("the rule's identifier was not rewritten:\n%s", declaring)
	}
	notes, _ := result["notes"].([]any)
	joined := fmt.Sprint(notes...)
	if !strings.Contains(joined, "file name") {
		t.Errorf("renaming a rule said nothing about the file-name check the engine runs: %v", notes)
	}
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

// TestDeleteFeatureRefusesWhileSomethingDelegatesToIt is the default, and the
// refusal is the product: it names the referrer, its file and the path, so the
// author has a list of places to go rather than a "no".
func TestDeleteFeatureRefusesWhileSomethingDelegatesToIt(t *testing.T) {
	root := lifecyclePack(t)
	state := loadedState(t, root)
	before := snapshot(t, root)

	result, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:oak"})
	if errMsg == "" {
		t.Fatalf("a referenced feature was deleted, leaving a dangling reference behind: %v", result)
	}
	for _, want := range []string{"example:patch", "features/patch.json", "detachReferences"} {
		if !strings.Contains(errMsg, want) {
			t.Errorf("the refusal does not mention %q: %s", want, errMsg)
		}
	}
	assertPackUnchanged(t, root, before)
}

// TestDeleteFeatureDetachesThenRemoves is the opt-in path end to end: the
// delegation goes out of the referring file, the referring file keeps
// everything else it had, and the feature's own file is gone.
func TestDeleteFeatureDetachesThenRemoves(t *testing.T) {
	root := lifecyclePack(t)
	state := loadedState(t, root)

	result, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:oak", "detachReferences": true})
	if errMsg != "" {
		t.Fatalf("the delete was refused: %s", errMsg)
	}
	if _, err := os.Stat(filepath.Join(root, "features", "oak.json")); !os.IsNotExist(err) {
		t.Errorf("the feature's file is still there: %v", err)
	}
	referring := read(t, root, "features/patch.json")
	if strings.Contains(referring, "example:oak") {
		t.Errorf("the delegation was left behind, pointing at nothing:\n%s", referring)
	}
	if !strings.Contains(referring, `"example:fern"`) {
		t.Errorf("the sibling delegation went with it:\n%s", referring)
	}
	if !strings.Contains(referring, "// the two halves of the patch, placed together") {
		t.Errorf("the referring file's comment was lost:\n%s", referring)
	}
	if got := result["detached"]; got != float64(1) {
		t.Errorf("detached = %v, want 1", got)
	}
	// The pack must still load, and still load without the deleted feature.
	state2 := loadedState(t, root)
	graph, errMsg := call(t, state2, "graph", map[string]any{})
	if errMsg != "" {
		t.Fatalf("the pack no longer loads after the delete: %s", errMsg)
	}
	if strings.Contains(fmt.Sprint(graph["nodes"]), "example:oak") {
		t.Errorf("the deleted feature is still in the pack's graph: %v", graph["nodes"])
	}
}

// TestDeleteFeatureRefusesToBreakTheFileItWouldDetachFrom covers the two ways
// removing a delegation breaks the file it lives in. Both refuse with nothing
// written, because the fix is a decision only the author can make: what should
// that parent place instead?
func TestDeleteFeatureRefusesToBreakTheFileItWouldDetachFrom(t *testing.T) {
	t.Run("the delegation is one the type cannot load without", func(t *testing.T) {
		root := t.TempDir()
		writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
			scatterFeatureFixedOffsetJSON("example:scatter", "example:oak", 0, 0, 0))
		writeTestFile(t, filepath.Join(root, "features", "oak.json"), blockFeature("example:oak", "minecraft:oak_log"))
		state := loadedState(t, root)
		before := snapshot(t, root)

		_, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:oak", "detachReferences": true})
		if errMsg == "" {
			t.Fatal("a required delegation was removed, which stops its own file loading")
		}
		if !strings.Contains(errMsg, "features/scatter.json") {
			t.Errorf("the refusal does not name the file that would stop loading: %s", errMsg)
		}
		assertPackUnchanged(t, root, before)
	})

	t.Run("removing it would empty a list the engine requires to be non-empty", func(t *testing.T) {
		root := t.TempDir()
		// Both entries of the aggregate name the same feature, so neither edge
		// is "the last one" on its own and both would go.
		writeTestFile(t, filepath.Join(root, "features", "patch.json"),
			strings.Replace(aggregateOfTwo, "example:fern", "example:oak", 1))
		writeTestFile(t, filepath.Join(root, "features", "oak.json"), blockFeature("example:oak", "minecraft:oak_log"))
		state := loadedState(t, root)
		before := snapshot(t, root)

		_, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:oak", "detachReferences": true})
		if errMsg == "" {
			t.Fatal("an aggregate was left with an empty features list, which the engine refuses to load")
		}
		if !strings.Contains(errMsg, "features/patch.json") {
			t.Errorf("the refusal does not name the file it would have emptied: %s", errMsg)
		}
		assertPackUnchanged(t, root, before)
	})
}

// TestDeleteFeatureRemovesAnUnreferencedFeatureWithoutBeingAsked: nothing
// delegates to it, so there is nothing to leave dangling and no flag to pass.
// The rest of the pack is byte-identical.
func TestDeleteFeatureRemovesAnUnreferencedFeatureWithoutBeingAsked(t *testing.T) {
	root := lifecyclePack(t)
	writeTestFile(t, filepath.Join(root, "features", "spare.json"), blockFeature("example:spare", "minecraft:stone"))
	state := loadedState(t, root)

	result, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:spare"})
	if errMsg != "" {
		t.Fatalf("deleting a feature nothing references was refused: %s", errMsg)
	}
	if _, err := os.Stat(filepath.Join(root, "features", "spare.json")); !os.IsNotExist(err) {
		t.Errorf("the file is still there: %v", err)
	}
	if got := result["detached"]; got != float64(0) {
		t.Errorf("detached = %v, want 0 -- nothing referenced it", got)
	}
	if read(t, root, "features/patch.json") != aggregateOfTwo {
		t.Errorf("an unrelated file was rewritten:\n%s", read(t, root, "features/patch.json"))
	}
}

// TestDeleteFeatureReportsWhatItLeftUnreferenced. Deleting the aggregate does
// not delete what it placed -- those files are somebody's work and nothing
// asked for them to go -- but from now on nothing places them, and that is not
// visible from the one file that vanished.
func TestDeleteFeatureReportsWhatItLeftUnreferenced(t *testing.T) {
	// No rule over the aggregate here: a rule cannot load without its
	// places_feature, so deleting what it places is refused -- which the test
	// above covers, and which is not what this one is about.
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "patch.json"), aggregateOfTwo)
	writeTestFile(t, filepath.Join(root, "features", "oak.json"), blockFeature("example:oak", "minecraft:oak_log"))
	writeTestFile(t, filepath.Join(root, "features", "fern.json"), blockFeature("example:fern", "minecraft:fern"))
	state := loadedState(t, root)

	result, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:patch"})
	if errMsg != "" {
		t.Fatalf("the delete was refused: %s", errMsg)
	}
	for _, rel := range []string{"features/oak.json", "features/fern.json"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			t.Errorf("%s was deleted along with the feature that placed it: %v", rel, err)
		}
	}
	orphaned := fmt.Sprint(result["orphaned"])
	for _, want := range []string{"example:oak", "example:fern"} {
		if !strings.Contains(orphaned, want) {
			t.Errorf("orphaned = %v, want it to name %s", result["orphaned"], want)
		}
	}
}

// TestDeleteFeatureRefusesAFileThatNoLongerDeclaresIt is the delete side of
// the stale-view check, and it is the one with the worst failure mode: the
// method removes a whole file, so acting on a path that has stopped meaning
// what it meant deletes somebody's work outright.
func TestDeleteFeatureRefusesAFileThatNoLongerDeclaresIt(t *testing.T) {
	root := lifecyclePack(t)
	writeTestFile(t, filepath.Join(root, "features", "spare.json"), blockFeature("example:spare", "minecraft:stone"))
	state := loadedState(t, root)

	// The file at that path is now a different feature entirely.
	writeTestFile(t, filepath.Join(root, "features", "spare.json"), blockFeature("example:something_else", "minecraft:stone"))
	before := snapshot(t, root)

	_, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:spare"})
	if errMsg == "" {
		t.Fatal("a file was deleted on the strength of a stale view of the pack")
	}
	if !strings.Contains(errMsg, "features/spare.json") {
		t.Errorf("the refusal does not name the file: %s", errMsg)
	}
	assertPackUnchanged(t, root, before)
}

// TestLifecycleMethodsNeedALoadedPack -- both are pack-dependent and both must
// answer with the one shared sentence a client keys its recovery off, rather
// than a fourth wording of it.
func TestLifecycleMethodsNeedALoadedPack(t *testing.T) {
	for _, method := range []string{"renameFeature", "deleteFeature"} {
		state := &serverState{}
		_, errMsg := call(t, state, method, map[string]any{"from": "example:a", "to": "example:b", "id": "example:a"})
		if errMsg != errNoPackLoaded.Error() {
			t.Errorf("%s before loadPack answered %q, want %q", method, errMsg, errNoPackLoaded.Error())
		}
	}
}

// TestLifecycleRefusalsNameNoPathOutsideThePack -- both methods write files
// named, indirectly, by the least trustworthy half of the editor. resolveInPack
// is the shared gate and its refusals deliberately name no operation; this only
// pins that neither method has grown a way around it.
func TestLifecycleRefusalsStayInsideThePack(t *testing.T) {
	root := lifecyclePack(t)
	state := loadedState(t, root)
	outside := filepath.Join(filepath.Dir(root), "outside.json")
	if err := os.WriteFile(outside, []byte(blockFeature("example:outside", "minecraft:stone")), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(outside) })

	if _, errMsg := call(t, state, "deleteFeature", map[string]any{"id": "example:outside"}); errMsg == "" {
		t.Fatal("a feature outside the loaded pack was deleted")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Errorf("the file outside the pack was removed: %v", err)
	}
}
