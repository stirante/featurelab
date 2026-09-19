package main

// dangling_test.go covers the finding this app used to be the only host that could not report:
// a delegation naming a feature no loaded file defines.
//
// Every file in such a pack is perfectly well-formed -- a `"places_feature"` is a string and
// that string is spelled fine -- so pack.Load has nothing to say about it, the picker fills in
// as usual, and generating places nothing. `featurelab check` has failed on it for some time and
// the VS Code extension gets it over `serve`; the check was written in cmd/featurelab, and this
// app links the engine in-process and never goes near that package. So the one host whose whole
// window is a preview opened the pack, painted no banner and gave the author nothing to go on.

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/wire"
)

// loadPackForTest opens root through the bound method, with the two things every in-process
// App needs: a no-op event emitter (the real Wails one calls log.Fatalf when handed a context
// that did not come from a running app -- see App.emitEvent) and a shutdown that closes the
// watcher LoadPack starts, before the test's temp directory is removed under it.
func loadPackForTest(t *testing.T, root string) *LoadPackResult {
	t.Helper()
	app := NewApp()
	app.emitEvent = func(string, ...any) {}
	t.Cleanup(func() { app.shutdown(nil) })
	got, err := app.LoadPack(root)
	if err != nil {
		t.Fatalf("App.LoadPack: %v", err)
	}
	return got
}

// danglingDelegationPack is the whole finding in two files: `wiki:gold_block` exists, and a
// scatter delegates to `wiki:gold_blok`.
func danglingDelegationPack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "gold.json"),
		singleBlockFeatureJSON("wiki:gold_block", "minecraft:gold_block"))
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
		scatterFeatureFixedOffsetJSON("wiki:scatter", "wiki:gold_blok", 0, 0, 0))
	return root
}

func TestApp_LoadPackReportsADanglingDelegation(t *testing.T) {
	got := loadPackForTest(t, danglingDelegationPack(t))
	if len(got.Warnings) != 1 {
		t.Fatalf("warnings = %#v, want exactly one -- the dangling delegation, and none of the "+
			"informational directory notices this pack also raises", got.Warnings)
	}
	warning := got.Warnings[0]
	// The delegating feature, where inside its file the reference is written, and the reference
	// itself. Without the first two a banner saying only "wiki:gold_blok does not exist" leaves
	// the author hunting for which of their files wrote it.
	for _, want := range []string{"wiki:scatter", "places_feature", `"wiki:gold_blok"`} {
		if !strings.Contains(warning, want) {
			t.Errorf("warning %q does not name %s", warning, want)
		}
	}
	// The near match, which is what turns the banner from a report into a fix.
	if !strings.Contains(warning, `did you mean "wiki:gold_block"?`) {
		t.Errorf("warning = %q, want it to suggest the id the pack actually defines", warning)
	}
	// The pack still LOADS and the picker still fills in: this is a finding about the pack, not
	// a refusal to open it.
	if len(got.Items) == 0 {
		t.Error("LoadPack reported the delegation and then handed the picker nothing")
	}
}

// TestApp_DanglingDelegationSentenceIsTheOneEveryHostShows is the anti-drift assertion, and the
// reason this app calls wire rather than wording the finding itself. Two phrasings of one
// problem is how a reader ends up believing they have two problems -- and a desktop user and a
// CI log are frequently the same person.
func TestApp_DanglingDelegationSentenceIsTheOneEveryHostShows(t *testing.T) {
	root := danglingDelegationPack(t)
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatal(err)
	}
	shared, ok := wire.UnresolvedTargetDiagnostics(context.Background(), loaded, nil)
	if !ok || len(shared) != 1 {
		t.Fatalf("wire.UnresolvedTargetDiagnostics = %+v (ok=%v), want exactly one", shared, ok)
	}
	got := delegationWarnings(loaded)
	if len(got) != 1 || got[0] != shared[0].Message {
		t.Errorf("app warning = %#v, want the shared sentence %q", got, shared[0].Message)
	}
}

// An author who wrote @featurelab:ignore unresolved-target has said something about the PACK,
// not about one tool that reads it, so the banner must stay down here too.
func TestApp_DanglingDelegationHonoursTheIgnoreDirective(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
		"// @featurelab:ignore unresolved-target\n"+
			scatterFeatureFixedOffsetJSON("wiki:scatter", "wiki:gold_blok", 0, 0, 0))

	got := loadPackForTest(t, root)
	if len(got.Warnings) != 0 {
		t.Errorf("warnings = %#v, want none -- the directive was written", got.Warnings)
	}
}

// Delegating to one of the GAME's features is not a defect: the pack is correct, the reference
// resolves at run time, and only the preview cannot draw it. On one real pack 13 of these were
// reported as errors telling the author to fix names that were spelled right.
func TestApp_GameProvidedDelegationRaisesNoWarning(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "scatter.json"),
		scatterFeatureFixedOffsetJSON("wiki:scatter", "minecraft:bush_feature", 0, 0, 0))

	got := loadPackForTest(t, root)
	if len(got.Warnings) != 0 {
		t.Errorf("warnings = %#v, want none", got.Warnings)
	}
}

// delegationCyclePack is the second graph-only finding in two files: two scatters that place
// each other, which is a loop no single file can be read to reveal.
func delegationCyclePack(t *testing.T, annotation string) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "a.json"),
		annotation+scatterFeatureFixedOffsetJSON("wiki:a", "wiki:b", 0, 0, 0))
	writeTestFile(t, filepath.Join(root, "features", "b.json"),
		scatterFeatureFixedOffsetJSON("wiki:b", "wiki:a", 0, 0, 0))
	return root
}

// TestApp_LoadPackReportsADelegationCycle: the pack loads, generates, and places one of the two
// features and never the other -- the recursion guard DROPS the re-entry at run time, silently,
// at every origin and under every seed. `featurelab check` has said so since the finding was
// lifted into wire; this app is the host whose entire window is a preview, and it said nothing.
func TestApp_LoadPackReportsADelegationCycle(t *testing.T) {
	got := loadPackForTest(t, delegationCyclePack(t, ""))
	if len(got.Warnings) != 1 {
		t.Fatalf("warnings = %#v, want exactly one -- the cycle, and none of the informational "+
			"directory notices this pack also raises", got.Warnings)
	}
	// The chain, so the author can see which files it runs through: naming only one end of a
	// loop leaves them looking for the other.
	if !strings.Contains(got.Warnings[0], "wiki:a -> wiki:b -> wiki:a") {
		t.Errorf("warning = %q, want the delegation chain in it", got.Warnings[0])
	}
}

// The sentence is wire's, exactly as the dangling one is: a desktop user and a CI log are
// frequently the same person, and two phrasings of one problem read as two problems.
func TestApp_DelegationCycleSentenceIsTheOneEveryHostShows(t *testing.T) {
	loaded, err := pack.Load(pack.Options{Dir: delegationCyclePack(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	graph, err := wire.BuildGraphContext(context.Background(), loaded)
	if err != nil {
		t.Fatal(err)
	}
	shared := wire.DelegationCycleDiagnostics(graph)
	if len(shared) != 1 {
		t.Fatalf("wire.DelegationCycleDiagnostics = %+v, want exactly one", shared)
	}
	got := delegationWarnings(loaded)
	if len(got) != 1 || got[0] != shared[0].Message {
		t.Errorf("app warning = %#v, want the shared sentence %q", got, shared[0].Message)
	}
}

// A cycle an author wrote `@featurelab:ignore cycle` about is a decision they have already
// taken, and this banner must not reopen it.
func TestApp_DelegationCycleHonoursTheIgnoreDirective(t *testing.T) {
	got := loadPackForTest(t, delegationCyclePack(t, "// @featurelab:ignore cycle\n"))
	if len(got.Warnings) != 0 {
		t.Errorf("warnings = %#v, want none -- the directive was written", got.Warnings)
	}
}
