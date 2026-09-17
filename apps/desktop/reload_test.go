// reload_test.go covers App.handlePackChanged: the incremental route through
// pack.Pack.ReloadFile, the fallback to a full pack.Load whenever that route cannot answer
// for a batch, and the all-or-nothing batching decision between the two (see
// reloadChangedLocked's own doc comment).
//
// Every test here uses the same device to tell the two routes apart from outside: delete an
// unrelated file from disk AFTER the pack is loaded, then look at whether the reload noticed.
// Only a full pack.Load re-walks the directory, so "the deleted file is still in memory" is
// proof the incremental route ran, and "it is gone" is proof the full one did.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/wire"
)

type emittedEvent struct {
	name string
	data []any
}

// newLoadedApp loads root as a pack, captures the events the app would emit to the frontend,
// and stops the real file watcher. The tests below call handlePackChanged directly with the
// exact batch they mean to test; a live watcher firing its own batch for the same writes
// would race those calls and their assertions.
func newLoadedApp(t *testing.T, root string) (*App, chan emittedEvent) {
	t.Helper()
	app := NewApp()
	events := make(chan emittedEvent, 16)
	app.emitEvent = func(name string, data ...any) { events <- emittedEvent{name: name, data: data} }
	t.Cleanup(func() { app.shutdown(nil) })
	if _, err := app.LoadPack(root); err != nil {
		t.Fatalf("App.LoadPack: %v", err)
	}
	app.shutdown(nil) // closes the watcher; leaves the loaded pack and its Workspace in place
	return app, events
}

// featureLoaded reports whether the pack currently holds an entry with this id, and
// featureTextByID returns its text. They are two functions on purpose: the single-function
// version returned "" for both "no such entry" and "an entry whose text is empty", and a
// mutation pass caught a deletion test passing against a mutant that left the entry in place
// carrying empty text. "Gone" and "still here but blank" are different claims and the tests
// that make them should not share a helper that cannot tell them apart.
func featureLoaded(app *App, id string) bool {
	for _, f := range app.loaded.Features {
		if f.ID == id {
			return true
		}
	}
	return false
}

func featureTextByID(t *testing.T, app *App, id string) string {
	t.Helper()
	for _, f := range app.loaded.Features {
		if f.ID == id {
			return f.Text
		}
	}
	t.Fatalf("no loaded feature with id %q -- if the point of this assertion is that it is GONE, "+
		"use featureLoaded", id)
	return ""
}

func expectEvent(t *testing.T, events chan emittedEvent, name string) {
	t.Helper()
	select {
	case ev := <-events:
		if ev.name != name {
			t.Fatalf("emitted %q, want %q (data: %v)", ev.name, name, ev.data)
		}
	default:
		t.Fatalf("expected a %q event, nothing was emitted", name)
	}
}

// paletteNames pulls the block names out of an App.Generate response.
func paletteNames(t *testing.T, rawJSON string) []string {
	t.Helper()
	var decoded struct {
		Palette []struct {
			Name string `json:"name"`
		} `json:"palette"`
	}
	if err := json.Unmarshal([]byte(rawJSON), &decoded); err != nil {
		t.Fatalf("Generate did not return valid JSON: %v", err)
	}
	names := make([]string, 0, len(decoded.Palette))
	for _, e := range decoded.Palette {
		names = append(names, e.Name)
	}
	return names
}

func containsString(haystack []string, want string) bool {
	for _, s := range haystack {
		if s == want {
			return true
		}
	}
	return false
}

// TestApp_HandlePackChanged_ReloadsOnlyTheSavedFile is the fast path: a batch naming exactly
// one feature file re-reads that file and nothing else, and the edit is live in the very next
// Generate -- which also proves the Workspace really did rebuild the feature library instead
// of serving the one it had cached.
func TestApp_HandlePackChanged_ReloadsOnlyTheSavedFile(t *testing.T) {
	root := t.TempDir()
	edited := filepath.Join(root, "features", "a.json")
	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "b.json"), singleBlockFeatureJSON("test:b", "minecraft:gold_block"))

	app, events := newLoadedApp(t, root)

	before, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"})
	if err != nil {
		t.Fatalf("App.Generate before the edit: %v", err)
	}
	if names := paletteNames(t, before); !containsString(names, "minecraft:diamond_block") {
		t.Fatalf("palette before the edit = %v, want it to contain minecraft:diamond_block", names)
	}

	// Disk now disagrees with memory about b.json. Only a full re-walk could notice.
	if err := os.Remove(filepath.Join(root, "features", "b.json")); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:emerald_block"))

	app.handlePackChanged(PackChange{Paths: []string{edited}, Complete: true})
	expectEvent(t, events, PackChangedEvent)

	if got := featureTextByID(t, app, "a.json"); got != singleBlockFeatureJSON("test:a", "minecraft:emerald_block") {
		t.Errorf("a.json was not re-read; in-memory text is %q", got)
	}
	if !featureLoaded(app, "b.json") {
		t.Error("b.json disappeared from the loaded pack -- the whole pack was re-read, not just the saved file")
	}

	after, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"})
	if err != nil {
		t.Fatalf("App.Generate after the edit: %v", err)
	}
	if names := paletteNames(t, after); !containsString(names, "minecraft:emerald_block") {
		t.Errorf("palette after the edit = %v, want it to contain minecraft:emerald_block", names)
	}
}

// TestApp_HandlePackChanged_ReloadsBeforeTheFirstGenerate covers the same fast path taken
// before anything built a Workspace (the app builds one lazily, on the first generate). The
// splice still has to happen, and the Workspace built afterwards has to see it.
func TestApp_HandlePackChanged_ReloadsBeforeTheFirstGenerate(t *testing.T) {
	root := t.TempDir()
	edited := filepath.Join(root, "features", "a.json")
	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))

	app, events := newLoadedApp(t, root)
	if app.workspace != nil {
		t.Fatal("LoadPack built a Workspace eagerly; the first generate is supposed to")
	}

	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:emerald_block"))
	app.handlePackChanged(PackChange{Paths: []string{edited}, Complete: true})
	expectEvent(t, events, PackChangedEvent)

	out, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"})
	if err != nil {
		t.Fatalf("App.Generate: %v", err)
	}
	if names := paletteNames(t, out); !containsString(names, "minecraft:emerald_block") {
		t.Errorf("palette = %v, want it to contain minecraft:emerald_block", names)
	}
}

// TestApp_HandlePackChanged_FallsBackWhenTheFileCannotBeReloaded covers the refusal case: a
// path pack.Pack.ReloadFile will not answer for (here manifest.json, outside every asset
// directory the pack was loaded from) must send the app down the full pack.Load road rather
// than being skipped.
func TestApp_HandlePackChanged_FallsBackWhenTheFileCannotBeReloaded(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "a.json"), singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "b.json"), singleBlockFeatureJSON("test:b", "minecraft:gold_block"))

	app, events := newLoadedApp(t, root)
	// Builds the Workspace, so the fallback has a real one to Update rather than the nil case.
	if _, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"}); err != nil {
		t.Fatalf("App.Generate: %v", err)
	}

	if err := os.Remove(filepath.Join(root, "features", "b.json")); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(root, "manifest.json")
	writeTestFile(t, manifest, `{"format_version":2}`)

	app.handlePackChanged(PackChange{Paths: []string{manifest}, Complete: true})
	expectEvent(t, events, PackChangedEvent)

	if featureLoaded(app, "b.json") {
		t.Error("b.json is still loaded -- the app did not fall back to a full reload for a path ReloadFile refuses")
	}
}

// TestApp_HandlePackChanged_IncompleteBatchFallsBack covers the other refusal: a batch the
// watcher could not enumerate (PackChange.Complete false -- see maxWatchBatch) names some
// paths but is not the whole truth, so reloading only what it names would reload less than
// actually changed.
func TestApp_HandlePackChanged_IncompleteBatchFallsBack(t *testing.T) {
	root := t.TempDir()
	edited := filepath.Join(root, "features", "a.json")
	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "b.json"), singleBlockFeatureJSON("test:b", "minecraft:gold_block"))

	app, events := newLoadedApp(t, root)

	if err := os.Remove(filepath.Join(root, "features", "b.json")); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:emerald_block"))

	// Every path in this batch is individually reloadable -- it is the Complete flag alone
	// that has to force the slow road here.
	app.handlePackChanged(PackChange{Paths: []string{edited}, Complete: false})
	expectEvent(t, events, PackChangedEvent)

	if featureLoaded(app, "b.json") {
		t.Error("b.json is still loaded -- an incomplete batch did not force a full reload")
	}
	if got := featureTextByID(t, app, "a.json"); got != singleBlockFeatureJSON("test:a", "minecraft:emerald_block") {
		t.Errorf("a.json is stale after the full reload: %q", got)
	}
}

// TestApp_HandlePackChanged_UnreloadablePathDoesNotDropTheRestOfTheBatch pins the batching
// decision reloadChangedLocked documents: a batch mixing one reloadable path with one
// unreloadable one is not partially applied, and -- the part worth a test of its own -- the
// reloadable path is NOT silently dropped, because the full reload that takes over covers it.
func TestApp_HandlePackChanged_UnreloadablePathDoesNotDropTheRestOfTheBatch(t *testing.T) {
	root := t.TempDir()
	edited := filepath.Join(root, "features", "a.json")
	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "b.json"), singleBlockFeatureJSON("test:b", "minecraft:gold_block"))

	app, events := newLoadedApp(t, root)
	if _, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"}); err != nil {
		t.Fatalf("App.Generate: %v", err)
	}

	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:emerald_block"))
	if err := os.Remove(filepath.Join(root, "features", "b.json")); err != nil {
		t.Fatal(err)
	}
	// A pack author saving a feature and, inside the same debounce window, something dropping
	// a file the pack's asset walks never read.
	unreloadable := filepath.Join(root, "notes.txt")
	writeTestFile(t, unreloadable, "scratch")

	app.handlePackChanged(PackChange{Paths: []string{edited, unreloadable}, Complete: true})
	expectEvent(t, events, PackChangedEvent)

	if got := featureTextByID(t, app, "a.json"); got != singleBlockFeatureJSON("test:a", "minecraft:emerald_block") {
		t.Fatalf("the saved feature was dropped because another path in the same batch could not be reloaded; in-memory text is %q", got)
	}
	if featureLoaded(app, "b.json") {
		t.Error("b.json is still loaded -- the batch was applied incrementally despite carrying an unreloadable path")
	}

	after, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"})
	if err != nil {
		t.Fatalf("App.Generate after the mixed batch: %v", err)
	}
	if names := paletteNames(t, after); !containsString(names, "minecraft:emerald_block") {
		t.Errorf("palette after the mixed batch = %v, want it to contain minecraft:emerald_block", names)
	}
}

// TestApp_HandlePackChanged_DoesNotMutateSlicesAlreadyHandedToTheWorkspace pins the
// obligation session.reuseFingerprint documents, from this app's side: a slice already handed
// to Workspace.Update is never written through, and a kind the save did not touch comes back
// as literally the same slice -- which is exactly what lets Update skip re-fingerprinting it.
func TestApp_HandlePackChanged_DoesNotMutateSlicesAlreadyHandedToTheWorkspace(t *testing.T) {
	root := t.TempDir()
	edited := filepath.Join(root, "features", "a.json")
	original := singleBlockFeatureJSON("test:a", "minecraft:diamond_block")
	writeTestFile(t, edited, original)
	writeTestFile(t, filepath.Join(root, "feature_rules", "r.json"),
		`{"format_version":"1.21.110","minecraft:feature_rules":{"description":{"identifier":"test:r","places_feature":"test:a"},"conditions":{"placement_pass":"surface_pass"}}}`)

	app, _ := newLoadedApp(t, root)
	if _, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"}); err != nil {
		t.Fatalf("App.Generate: %v", err)
	}

	workspaceBefore := app.workspace
	featuresBefore := app.loaded.Features
	rulesBefore := app.loaded.Rules

	writeTestFile(t, edited, singleBlockFeatureJSON("test:a", "minecraft:emerald_block"))
	app.handlePackChanged(PackChange{Paths: []string{edited}, Complete: true})

	if app.workspace != workspaceBefore {
		t.Error("the Workspace was replaced by a save; every library it had cached went with it")
	}
	if featuresBefore[0].Text != original {
		t.Errorf("the features slice already handed to Workspace.Update was edited in place: element 0 now reads %q", featuresBefore[0].Text)
	}
	if &app.loaded.Features[0] == &featuresBefore[0] {
		t.Error("the changed kind came back as the same slice; Workspace.Update would have skipped re-fingerprinting it and kept serving a stale library")
	}
	if &app.loaded.Rules[0] != &rulesBefore[0] {
		t.Error("an untouched kind came back as a different slice; Workspace.Update has to re-hash it for nothing")
	}
}

// TestApp_HandlePackChanged_ReloadsADeletedFileOnTheFastPath is a case the VS Code
// extension's save-driven path structurally cannot reach (an editor reports saves, not
// deletions) but this app's watcher does see: a file removed under the pack root arrives as a
// path in a batch like any other, and pack.Pack.ReloadFile drops it. No full reload needed.
func TestApp_HandlePackChanged_ReloadsADeletedFileOnTheFastPath(t *testing.T) {
	root := t.TempDir()
	doomed := filepath.Join(root, "features", "b.json")
	writeTestFile(t, filepath.Join(root, "features", "a.json"), singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	writeTestFile(t, doomed, singleBlockFeatureJSON("test:b", "minecraft:gold_block"))

	app, events := newLoadedApp(t, root)
	if _, err := app.Generate(wire.GenerateParams{Feature: "test:b", Env: "void"}); err != nil {
		t.Fatalf("App.Generate before the delete: %v", err)
	}

	if err := os.Remove(doomed); err != nil {
		t.Fatal(err)
	}
	app.handlePackChanged(PackChange{Paths: []string{doomed}, Complete: true})
	expectEvent(t, events, PackChangedEvent)

	if featureLoaded(app, "b.json") {
		t.Fatal("the deleted feature file is still in the loaded pack")
	}
	// And the feature library really was rebuilt without it -- a preview still placing a
	// feature the pack no longer defines is the exact failure this whole path has to avoid.
	// Asserted on what the run placed, not on an error: naming a feature the pack does not
	// define is not an error to this engine, it is an empty placement with a diagnostic.
	if got := blocksPlaced(t, app, "test:b"); got != 0 {
		t.Errorf("the deleted feature still placed %v blocks", got)
	}
	if got := blocksPlaced(t, app, "test:a"); got != 1 {
		t.Errorf("the surviving feature placed %v blocks, want 1", got)
	}
}

// blocksPlaced runs one feature through App.Generate and returns its blocksPlaced count.
func blocksPlaced(t *testing.T, app *App, feature string) float64 {
	t.Helper()
	raw, err := app.Generate(wire.GenerateParams{Feature: feature, Env: "void"})
	if err != nil {
		t.Fatalf("App.Generate(%s): %v", feature, err)
	}
	var decoded struct {
		BlocksPlaced float64 `json:"blocksPlaced"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("App.Generate(%s) did not return valid JSON: %v", feature, err)
	}
	return decoded.BlocksPlaced
}

// TestApp_HandlePackChanged_FallsBackForAReloadErrorThatIsNotARefusal is the
// second half of reloadChangedLocked's "matched by the fact that there IS an
// error, never by what it says" comment, and the half nothing else reaches.
// Every other test here produces the SAME error -- pack.Pack.ReloadFile's
// "not a file this pack was loaded from" refusal -- so a version that fell
// back only when the message said that would pass all of them, and would
// then silently NOT fall back for every other error ReloadFile can return.
//
// The one that matters in practice is a read error on a file that is
// genuinely part of the pack: on Windows an editor's save briefly holds the
// file open, and the watcher fires inside that window. ReloadFile refuses
// (it will not treat "cannot read it" as "it was deleted"), and this app has
// to take that as its cue for the full reload -- the only route that will
// get the file's real content once the editor lets go. Skipping the path
// instead leaves the preview showing the pre-save file with nothing to say
// it did.
//
// A directory standing where the file was is the portable way to make
// ReloadFile fail with a read error rather than a refusal.
func TestApp_HandlePackChanged_FallsBackForAReloadErrorThatIsNotARefusal(t *testing.T) {
	root := t.TempDir()
	unreadable := filepath.Join(root, "features", "a.json")
	writeTestFile(t, unreadable, singleBlockFeatureJSON("test:a", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "b.json"), singleBlockFeatureJSON("test:b", "minecraft:gold_block"))

	app, events := newLoadedApp(t, root)
	// Builds the Workspace, so the fallback has a real one to Update.
	if _, err := app.Generate(wire.GenerateParams{Feature: "test:a", Env: "void"}); err != nil {
		t.Fatalf("App.Generate: %v", err)
	}

	// The tell: only a full re-walk of the directory notices b.json is gone.
	if err := os.Remove(filepath.Join(root, "features", "b.json")); err != nil {
		t.Fatal(err)
	}
	// a.json is still a path this pack was loaded from -- it just cannot be
	// read right now, which is a different answer from "it is gone".
	if err := os.Remove(unreadable); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(unreadable, 0o755); err != nil {
		t.Fatal(err)
	}

	app.handlePackChanged(PackChange{Paths: []string{unreadable}, Complete: true})
	expectEvent(t, events, PackChangedEvent)

	if featureLoaded(app, "b.json") {
		t.Error("b.json is still loaded -- the app did not fall back to a full reload for a read error, so it is matching on what the error SAYS rather than on there being one")
	}
}
