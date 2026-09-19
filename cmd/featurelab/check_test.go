package main

// check_test.go covers what `check` SAYS, which until now was the part of it nobody had pinned:
// which problems it finds at all, what level it calls them, and what a person reading the
// output sees.
//
// All four subjects here came out of one session with a pack that had a single letter wrong:
//
//   - the delegation whose target does not exist was not reported at all, so `check` exited 0
//     on a pack that generates nothing (TestCheck_DanglingDelegation*),
//   - four "this pack has no biomes/" rows sat around every real finding at warning level
//     (TestCheck_MissingConventionalDirectoriesAreInformational),
//   - the output was a raw JSON array with no summary of any kind (TestCheck_TextOutput*),
//   - and the same file was spelled two different ways by two commands
//     (TestCheck_AndGenerateSpellTheSameFileTheSameWay).

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// danglingDelegationPack is the whole finding in two files: `wiki:gold_block` exists, and a
// scatter delegates to `wiki:gold_blok`. Every file here is well-formed -- a places_feature is a
// string and that string is spelled fine -- so no loader has anything to say about either of
// them, and the mistake is visible only between the two.
func danglingDelegationPack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "gold.json"), singleBlockFeatureJSON("wiki:gold_block", "minecraft:gold_block"))
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"), scatterFeatureFixedOffsetJSON("wiki:scatter", "wiki:gold_blok", 0, 0, 0))
	return root
}

// checkJSON runs `check --json` over root and returns the decoded diagnostics and the exit code.
func checkJSON(t *testing.T, root string) ([]Diagnostic, int) {
	t.Helper()
	var code int
	out := captureStdout(t, func() { code = run([]string{"check", "--pack", root, "--json"}) })
	var diags []Diagnostic
	if err := json.Unmarshal(out, &diags); err != nil {
		t.Fatalf("check --json output is not valid JSON: %v; output: %s", err, out)
	}
	return diags, code
}

// errorDiagnostics is the subset a CI job acts on.
func errorDiagnostics(diags []Diagnostic) []Diagnostic {
	var out []Diagnostic
	for _, d := range diags {
		if d.Level == LevelError {
			out = append(out, d)
		}
	}
	return out
}

// TestCheck_DanglingDelegationIsAnErrorThatFailsTheCommand is the bug, asserted from the side a
// CI job sees it from: this pack places nothing at all, and `check` used to exit 0 on it with
// nothing but the four directory notices.
func TestCheck_DanglingDelegationIsAnErrorThatFailsTheCommand(t *testing.T) {
	diags, code := checkJSON(t, danglingDelegationPack(t))
	if code != 1 {
		t.Errorf("check exited %d, want 1 -- a pack whose only delegation resolves to nothing must not pass", code)
	}
	errs := errorDiagnostics(diags)
	if len(errs) != 1 {
		t.Fatalf("error diagnostics = %+v, want exactly one (the dangling delegation)", errs)
	}
	got := errs[0]
	// The FILE is the one that WROTE the reference, not the one that does not exist -- there is
	// no file for the second, and there is nothing to open.
	if got.FileID != filepath.ToSlash(filepath.Join("features", "scatter.json")) {
		t.Errorf("fileId = %q, want the delegating file", got.FileID)
	}
	if got.Scope != "pack" {
		t.Errorf("scope = %q, want pack -- it is a fact about the files on disk, true of every run", got.Scope)
	}
	for _, want := range []string{"wiki:scatter", "places_feature", `"wiki:gold_blok"`} {
		if !strings.Contains(got.Message, want) {
			t.Errorf("message %q does not name %s", got.Message, want)
		}
	}
}

// TestCheck_DanglingDelegationOffersTheNearMatch is finding 2 arriving where a pack author
// reads it. The suggestion machinery has been in this repo the whole time; the only path it
// reached was the identifier a caller typed on the command line, so the identical typo written
// inside a file got nothing.
func TestCheck_DanglingDelegationOffersTheNearMatch(t *testing.T) {
	diags, _ := checkJSON(t, danglingDelegationPack(t))
	errs := errorDiagnostics(diags)
	if len(errs) != 1 {
		t.Fatalf("error diagnostics = %+v, want exactly one", errs)
	}
	if !strings.Contains(errs[0].Message, `did you mean "wiki:gold_block"?`) {
		t.Errorf("message = %q, want it to suggest the id the pack actually defines", errs[0].Message)
	}
}

// TestCheck_GameProvidedDelegationIsNotAnError keeps the exemption that made the unresolved-node
// distinction worth having: `minecraft:*` is the GAME's feature, the pack is correct, and the
// reference resolves at run time. On one real pack, 13 of these were reported as errors telling
// the author to fix the spelling of names that were spelled right.
func TestCheck_GameProvidedDelegationIsNotAnError(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
		scatterFeatureFixedOffsetJSON("wiki:scatter", "minecraft:bush_feature", 0, 0, 0))

	diags, code := checkJSON(t, root)
	if code != 0 {
		t.Errorf("check exited %d, want 0 -- delegating to a game feature is not a defect", code)
	}
	if errs := errorDiagnostics(diags); len(errs) != 0 {
		t.Errorf("error diagnostics = %+v, want none", errs)
	}
}

// TestCheck_MissingConventionalDirectoriesAreInformational is finding 3. A pack with one real
// error used to show it surrounded by four rows saying the pack was fine as it is. They are
// still reported -- a channel that hides "this pack has no biomes/" would hide a mistyped
// override too -- but at the level that says what they are.
func TestCheck_MissingConventionalDirectoriesAreInformational(t *testing.T) {
	diags, _ := checkJSON(t, danglingDelegationPack(t))

	var packRows int
	for _, d := range diags {
		if d.FileID != packDiagnosticFileID {
			continue
		}
		packRows++
		if d.Level != LevelInfo {
			t.Errorf("level = %q for %q, want %q -- a directory this pack simply does not have is not a warning",
				d.Level, d.Message, LevelInfo)
		}
	}
	if packRows != 4 {
		t.Fatalf("pack-level rows = %d, want 4 (structures, feature_rules, biomes, blocks) -- the fixture changed", packRows)
	}
}

// TestCheck_ExplicitlyNamedMissingDirectoryStaysAWarning is the other half of the same decision,
// and the reason it is made from pack.MissingDir.Explicit rather than from the sentence: a
// directory someone TYPED and that is not there is a typo, and dropping it to info is how a
// mistyped --features starts looking like a pack with no features.
func TestCheck_ExplicitlyNamedMissingDirectoryStaysAWarning(t *testing.T) {
	root := danglingDelegationPack(t)
	missing := filepath.Join(root, "not_biomes_at_all")

	var code int
	out := captureStdout(t, func() {
		code = run([]string{"check", "--pack", root, "--biomes", missing, "--json"})
	})
	_ = code
	var diags []Diagnostic
	if err := json.Unmarshal(out, &diags); err != nil {
		t.Fatalf("check --json output is not valid JSON: %v; output: %s", err, out)
	}

	var found bool
	for _, d := range diags {
		if d.FileID != packDiagnosticFileID || !strings.Contains(d.Message, "not_biomes_at_all") {
			continue
		}
		found = true
		if d.Level != LevelWarning {
			t.Errorf("level = %q for the explicitly named missing directory, want %q", d.Level, LevelWarning)
		}
	}
	if !found {
		t.Fatal("no diagnostic named the explicitly given --biomes directory")
	}
}

// TestCheck_TextOutputIsTheDefaultAndCarriesASummary is finding 4. `check` printed a raw JSON
// array and nothing else: no summary line, no way to ask for anything else, and a healthy pack
// answered "[]".
func TestCheck_TextOutputIsTheDefaultAndCarriesASummary(t *testing.T) {
	var code int
	out := captureStdout(t, func() { code = run([]string{"check", "--pack", danglingDelegationPack(t)}) })
	if code != 1 {
		t.Errorf("check exited %d, want 1", code)
	}
	text := string(out)
	if strings.HasPrefix(strings.TrimSpace(text), "[") {
		t.Fatalf("default output is still JSON: %s", text)
	}
	for _, want := range []string{"LEVEL", "MESSAGE", "features/scatter.json", "1 error, 0 warnings, 4 notes"} {
		if !strings.Contains(text, want) {
			t.Errorf("text output does not contain %q:\n%s", want, text)
		}
	}
}

// TestCheck_CleanPackStillSaysSo pins the other end of the summary: "[]" told a reader nothing,
// and an empty table would tell them no more. The counts are printed even when they are all
// zero, so nobody has to work out which number is missing.
func TestCheck_CleanPackStillSaysSo(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"features", "structures", "feature_rules", "biomes", "blocks"} {
		writeTestFile(t, filepath.Join(root, dir, ".keep"), "")
	}
	writeTestFile(t, filepath.Join(root, "features", "alpha.json"), singleBlockFeatureJSON("wiki:alpha", "minecraft:diamond_block"))

	var code int
	out := captureStdout(t, func() { code = run([]string{"check", "--pack", root}) })
	if code != 0 {
		t.Fatalf("check exited %d, want 0; output: %s", code, out)
	}
	if !strings.Contains(string(out), "0 errors, 0 warnings, 0 notes") {
		t.Errorf("clean pack output = %q, want the summary line", out)
	}
}

// TestCheck_JSONFlagStillPrintsTheArray is the compatibility half: everything that used to read
// check's output can still read it, by asking. The exit code must not depend on which format was
// asked for -- that would make --json mean two things.
func TestCheck_JSONFlagStillPrintsTheArray(t *testing.T) {
	root := danglingDelegationPack(t)
	diags, code := checkJSON(t, root)
	if code != 1 {
		t.Errorf("check --json exited %d, want 1 -- the same code the text format gives", code)
	}
	if len(diags) == 0 {
		t.Fatal("check --json printed an empty array for a pack with a dangling delegation")
	}
}

// TestCheck_AndGenerateSpellTheSameFileTheSameWay is finding 6: one file, two commands, one
// spelling. `check` and the graph canvas said "features/broken.json" while a preview's own
// diagnostics -- which come from session, through a different path -- said "broken.json", and
// every client was left to normalise for itself.
func TestCheck_AndGenerateSpellTheSameFileTheSameWay(t *testing.T) {
	root := t.TempDir()
	// A trailing comma, which is both the commonest way a hand-edited file stops parsing and
	// the subject of the jsonc test beside this one.
	writeTestFile(t, filepath.Join(root, "features", "broken.json"),
		"{\n  \"format_version\": \"1.21.110\",\n  \"minecraft:single_block_feature\": {\n    \"description\": { \"identifier\": \"wiki:broken\" },\n    \"places_block\": \"minecraft:gold_block\",\n  }\n}\n")

	diags, _ := checkJSON(t, root)
	var fromCheck string
	for _, d := range diags {
		if strings.HasSuffix(d.FileID, "broken.json") {
			fromCheck = d.FileID
		}
	}
	if fromCheck == "" {
		t.Fatal("check reported nothing about the unparseable file")
	}

	out := captureStdout(t, func() { run([]string{"generate", "--pack", root, "--feature", "wiki:broken"}) })
	var gen struct {
		Diagnostics []struct {
			FileID  string `json:"fileId"`
			Message string `json:"message"`
		} `json:"diagnostics"`
	}
	if err := json.Unmarshal(out, &gen); err != nil {
		t.Fatalf("generate output is not valid JSON: %v; output: %s", err, out)
	}
	var seen bool
	for _, d := range gen.Diagnostics {
		if strings.HasSuffix(d.FileID, "broken.json") {
			seen = true
			if d.FileID != fromCheck {
				t.Errorf("generate spells the file %q, check spells it %q -- they must agree", d.FileID, fromCheck)
			}
		}
		// The file is also QUOTED inside a message ("is declared by X"), and a message that
		// names a file by a different string than the diagnostic beside it reads as being about
		// a different file.
		if strings.Contains(d.Message, "broken.json") && !strings.Contains(d.Message, fromCheck) {
			t.Errorf("message names the file by a different spelling: %q, want %q", d.Message, fromCheck)
		}
	}
	if !seen {
		t.Fatal("generate reported nothing about the unparseable file")
	}
}

// ---------------------------------------------------------------------------
// The file that is structurally fine and semantically dead
//
// Every case below was measured by building the file through the editor and
// then running `check` on the bytes it wrote. Each one loaded clean, checked
// clean, and could not place a single block.
// ---------------------------------------------------------------------------

// checkMessages returns every diagnostic message at one level, so a test can
// assert on WHAT was said without pinning the whole row.
func checkMessages(diags []Diagnostic, level string) []string {
	var out []string
	for _, d := range diags {
		if d.Level == level {
			out = append(out, d.Message)
		}
	}
	return out
}

func containsSubstring(all []string, want string) bool {
	for _, s := range all {
		if strings.Contains(s, want) {
			return true
		}
	}
	return false
}

// TestCheck_EmptyBlockInAWeightedEntryIsAnError is the editor's `+` button:
// `places_block: []` was already refused, and the row the button actually
// writes was not.
func TestCheck_EmptyBlockInAWeightedEntryIsAnError(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "x.json"), `{"format_version":"1.21.110",
		"minecraft:single_block_feature":{"description":{"identifier":"wiki:x"},
		"enforce_placement_rules":false,"enforce_survivability_rules":false,
		"places_block":[{"block":"","weight":1}]}}`)

	diags, code := checkJSON(t, root)
	if code != 1 {
		t.Errorf("check exited %d, want 1 -- the game rejects \"\" as a block id", code)
	}
	if !containsSubstring(checkMessages(diags, LevelError), "empty block name") {
		t.Errorf("errors = %v, want one about the empty block name", checkMessages(diags, LevelError))
	}
}

// TestCheck_AnUnknownBlockNameIsAWarningAndDoesNotFailTheCommand: free text in
// a block field used to reach disk in total silence. It is a warning and not an
// error because a pack may declare its own blocks and another add-on may
// declare the rest.
func TestCheck_AnUnknownBlockNameIsAWarningAndDoesNotFailTheCommand(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "x.json"),
		singleBlockFeatureJSON("wiki:x", "not even an id"))

	diags, code := checkJSON(t, root)
	if code != 0 {
		t.Errorf("check exited %d, want 0 -- an unrecognised block name must not fail a pack", code)
	}
	warnings := checkMessages(diags, LevelWarning)
	if !containsSubstring(warnings, "not a block this engine knows") {
		t.Fatalf("warnings = %v, want one about the unknown block name", warnings)
	}
	if !containsSubstring(warnings, "vanilla block catalogue") {
		t.Errorf("the warning does not say what it looked in: %v", warnings)
	}
}

// TestCheck_TwoNodeDelegationCycleIsReported: `1 -> 2` and `2 -> 1` were both
// accepted and check was clean. One of the two delegations places nothing at
// run time, silently.
func TestCheck_TwoNodeDelegationCycleIsReported(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "one.json"),
		scatterFeatureFixedOffsetJSON("wiki:scatter_1", "wiki:scatter_2", 0, 0, 0))
	writeTestFile(t, filepath.Join(root, "features", "two.json"),
		scatterFeatureFixedOffsetJSON("wiki:scatter_2", "wiki:scatter_1", 0, 0, 0))

	diags, code := checkJSON(t, root)
	// A cycle is legal: the pack loads and generates, so it must never flip the
	// exit code. This is the whole reason it was the one graph check safe to
	// wire without a corpus run behind it.
	if code != 0 {
		t.Errorf("check exited %d, want 0 -- a cycle is legal and must stay a warning", code)
	}
	warnings := checkMessages(diags, LevelWarning)
	if !containsSubstring(warnings, "delegation cycle") {
		t.Fatalf("warnings = %v, want one naming the cycle", warnings)
	}
	if !containsSubstring(warnings, "wiki:scatter_1 -> wiki:scatter_2 -> wiki:scatter_1") {
		t.Errorf("the warning does not spell the loop out: %v", warnings)
	}
}

// TestCheck_AcyclicPackSaysNothingAboutCycles is the other half of wiring a
// check that was deliberately left off: it must be silent on everything that
// passes today.
func TestCheck_AcyclicPackSaysNothingAboutCycles(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "gold.json"), singleBlockFeatureJSON("wiki:gold", "minecraft:gold_block"))
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"), scatterFeatureFixedOffsetJSON("wiki:scatter", "wiki:gold", 0, 0, 0))

	diags, _ := checkJSON(t, root)
	for _, d := range diags {
		if strings.Contains(d.Message, "delegation cycle") {
			t.Errorf("an acyclic pack was told it has a cycle: %q", d.Message)
		}
	}
}

// TestCheck_ZeroIterationsIsAWarning: a literal zero is a scatter that places
// nothing, deterministically, with no failed placement anywhere to look at.
// Writing one is legitimate while building, so it is a warning.
func TestCheck_ZeroIterationsIsAWarning(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "gold.json"), singleBlockFeatureJSON("wiki:gold", "minecraft:gold_block"))
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"), `{"format_version":"1.21.110",
		"minecraft:scatter_feature":{"description":{"identifier":"wiki:scatter"},
		"places_feature":"wiki:gold","distribution":{"iterations":0,"x":0,"y":0,"z":0}}}`)

	diags, code := checkJSON(t, root)
	if code != 0 {
		t.Errorf("check exited %d, want 0 -- the game loads and runs this file", code)
	}
	if !containsSubstring(checkMessages(diags, LevelWarning), "rounds to 0") {
		t.Errorf("warnings = %v, want one about the zero iteration count", checkMessages(diags, LevelWarning))
	}
}

// TestCheck_PatternPlaceholderIsStillAnError re-measures the one item in this
// set that a previous change had already closed: the `example:replace_me` every
// editor pattern ships is a dangling delegation, and a dangling delegation is a
// hard error. Pinned here so it stays that way for the pattern's own spelling
// of it, in a feature and in a feature rule.
func TestCheck_PatternPlaceholderIsStillAnError(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
		scatterFeatureFixedOffsetJSON("wiki:scatter", "example:replace_me", 0, 0, 0))
	writeTestFile(t, filepath.Join(root, "feature_rules", "rule.json"), `{"format_version":"1.21.110",
		"minecraft:feature_rules":{"description":{"identifier":"wiki:rule","places_feature":"example:replace_me"},
		"conditions":{"placement_pass":"surface_pass","minecraft:biome_filter":{}},
		"distribution":{"iterations":1,"x":0,"y":0,"z":0}}}`)

	diags, code := checkJSON(t, root)
	if code != 1 {
		t.Fatalf("check exited %d, want 1 -- the placeholder resolves to nothing in both files", code)
	}
	errs := checkMessages(diags, LevelError)
	var forFeature, forRule int
	for _, d := range diags {
		if d.Level != LevelError || !strings.Contains(d.Message, "example:replace_me") {
			continue
		}
		if strings.HasPrefix(d.FileID, "features/") {
			forFeature++
		}
		if strings.HasPrefix(d.FileID, "feature_rules/") {
			forRule++
		}
	}
	if forFeature != 1 || forRule != 1 {
		t.Errorf("placeholder errors: %d from features/, %d from feature_rules/, want 1 each; all errors = %v", forFeature, forRule, errs)
	}
}

// TestCheck_BOMPrefixedFeatureLoadsAndIsReported is the same finding from the
// outside. The file is the one Notepad saves: three invisible bytes, then a
// perfectly good feature. It used to fail to parse, so the feature did not
// exist and `check`'s only clue was a delegation error in a DIFFERENT file
// naming something nothing defines -- which is what this test also asserts is
// now absent.
func TestCheck_BOMPrefixedFeatureLoadsAndIsReported(t *testing.T) {
	root := t.TempDir()
	// Real bytes, written to a real file, the way an editor writes them.
	bom := "\xEF\xBB\xBF" + singleBlockFeatureJSON("wiki:gold", "minecraft:gold_block")
	writeTestFile(t, filepath.Join(root, "features", "gold.json"), bom)
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
		scatterFeatureFixedOffsetJSON("wiki:scatter", "wiki:gold", 0, 0, 0))

	diags, code := checkJSON(t, root)
	if code != 0 {
		t.Errorf("check exited %d, want 0 -- the file is valid UTF-8 and this tool reads it", code)
	}
	for _, d := range diags {
		if d.Level == LevelError {
			t.Errorf("a BOM produced an error: %q (in %s)", d.Message, d.FileID)
		}
	}
	if !containsSubstring(checkMessages(diags, LevelWarning), "byte-order mark") {
		t.Errorf("warnings = %v, want one about the BOM", checkMessages(diags, LevelWarning))
	}
}

// TestEveryPackCommand_FailsOnAPackRootThatIsNotThere is the worst thing this
// tool did, asserted from the side a CI job sees it from.
//
// Nothing stat'd the pack root. `check --pack ./bulid/BP` resolved five
// conventional subdirectories under a path that does not exist, reported each
// of them missing as the ordinary "fine if this pack has none" note, printed
// "0 errors, 0 warnings, 5 notes" and exited 0. A one-letter typo in a CI
// script, or a script run from the wrong working directory, passed as a healthy
// pack -- from the one command whose entire job is to fail on an unhealthy one.
//
// Every command that takes a pack root is here and not just `check`, because
// they all reach the same loader and the fix is only worth anything if none of
// them is left behind: `generate` would have placed nothing and said it went
// fine, `graph` would have dumped an empty graph.
func TestEveryPackCommand_FailsOnAPackRootThatIsNotThere(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "bulid", "BP")
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"check", []string{"check", "--pack", missing}},
		{"check --json", []string{"check", "--pack", missing, "--json"}},
		{"generate", []string{"generate", "--pack", missing, "--feature", "wiki:gold_block", "--env", "void", "--size", "4x4x4"}},
		{"graph", []string{"graph", "--pack", missing}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var code int
			var stderr []byte
			captureStdout(t, func() {
				stderr = captureStderr(t, func() { code = run(tc.args) })
			})
			if code == 0 {
				t.Errorf("%s exited 0 on a pack root that is not on disk", tc.name)
			}
			// And it has to name the path. "failed to load pack" sends someone
			// reading a CI log hunting through a script for which of several
			// paths was wrong.
			if !strings.Contains(string(stderr), missing) {
				t.Errorf("%s said %q, want it to name the path %q", tc.name, stderr, missing)
			}
		})
	}
}

// A pack root that is a FILE -- --pack pointed at manifest.json, or at a
// .mcpack nobody unpacked -- is the same typo wearing different clothes, and
// produced the same wordless clean report.
func TestCheck_FailsOnAPackRootThatIsAFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "manifest.json")
	writeTestFile(t, file, `{"format_version":2}`)

	var code int
	var stderr []byte
	captureStdout(t, func() {
		stderr = captureStderr(t, func() { code = run([]string{"check", "--pack", file}) })
	})
	if code == 0 {
		t.Error("check exited 0 with --pack pointing at a file")
	}
	if !strings.Contains(string(stderr), file) || !strings.Contains(string(stderr), "not a directory") {
		t.Errorf("check said %q, want it to name %q and say it is not a directory", stderr, file)
	}
}

// TestCheck_RealDirectoryWithNoPackContentIsAWarningNotAFailure pins the other
// side of that decision. This root exists, so the tool cannot tell "--pack is
// one level too high" from "an ordinary behaviour pack with no worldgen content"
// -- and a CI loop running `check` over every pack in a monorepo must not fail
// on the ones that are simply not worldgen packs. So: exit 0, but a WARNING,
// not another note. The five per-kind notes each end "(fine if this pack has
// none)" and between them never say that nothing at all was loaded, which is
// the sentence someone staring at a clean report on a wrong path needs.
func TestCheck_RealDirectoryWithNoPackContentIsAWarningNotAFailure(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "manifest.json"), `{"format_version":2}`)

	diags, code := checkJSON(t, root)
	if code != 0 {
		t.Errorf("check exited %d, want 0 -- a directory that exists and holds no worldgen content is not a failure", code)
	}
	var found *Diagnostic
	for i, d := range diags {
		if strings.Contains(d.Message, "contains none of") {
			found = &diags[i]
		}
	}
	if found == nil {
		t.Fatalf("diagnostics = %+v, want one saying the root holds none of the expected directories", diags)
	}
	if found.Level != LevelWarning {
		t.Errorf("level = %q, want %q -- levelled as info it sits among five notes that each say the pack is fine as it is", found.Level, LevelWarning)
	}
	if !strings.Contains(found.Message, root) {
		t.Errorf("message = %q, want it to name the root %q", found.Message, root)
	}
}
