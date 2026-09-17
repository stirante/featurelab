package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/pack"
)

// normalizedJSON marshals r with the three duration fields zeroed out first
// -- wall-clock timing legitimately differs between two otherwise-identical
// runs, and (for LibraryBuildDurationMs/TotalDurationMs specifically) also
// differs by WHICH entry point ran the call: the "fresh" comparand below goes
// through package-level Generate (which pays and reports a real library-build
// cost), while "first"/"second" call Workspace.Generate directly (which never
// does, by design -- see Result.LibraryBuildDurationMs's doc comment). None of
// that is the thing this test is checking, hence zeroing all three before
// comparing. Volume carries json:"-" already, so it never enters the
// comparison at all.
func normalizedJSON(t *testing.T, r *Result) []byte {
	t.Helper()
	cp := *r
	cp.PlacementDurationMs = 0
	cp.LibraryBuildDurationMs = 0
	cp.TotalDurationMs = 0
	b, err := json.Marshal(&cp)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}

// ---------------------------------------------------------------------------
// Reuse must not change results -- the assertion that matters most: caching
// that changes output is worse than no caching. A feature generated twice
// through the SAME Workspace (paying the build cost once, then reusing) must
// come out byte-identical (module the three duration fields) to generating
// it once through a brand-new Workspace/Generate call.
// ---------------------------------------------------------------------------

func TestWorkspace_ReuseProducesByteIdenticalResultsToFresh(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:scatter_diamonds")
	config.RepeatCount = 3
	files := []features.SourceFile{
		singleBlockFeatureFile("test:place_diamond", "minecraft:diamond_block"),
		scatterFeatureFileForWorkspaceTest("test:scatter_diamonds", "test:place_diamond"),
	}

	// "generating it once through a fresh one" -- the package-level Generate
	// entry point, which (per its own doc comment) builds a brand-new
	// Workspace for this one call and never reuses anything.
	fresh, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate (fresh): %v", err)
	}

	// "a feature generated twice through the same workspace" -- build one
	// Workspace, call Generate on it twice, and compare the SECOND call's
	// output (the one that actually exercised the reused/cached libraries)
	// against the fresh baseline above.
	ws := NewWorkspace(files, nil, nil, nil, nil)
	first, err := ws.Generate(config)
	if err != nil {
		t.Fatalf("Workspace.Generate (1st call): %v", err)
	}
	second, err := ws.Generate(config)
	if err != nil {
		t.Fatalf("Workspace.Generate (2nd call): %v", err)
	}

	if first.BlocksChanged == 0 {
		t.Fatal("test is vacuous: nothing was placed at all (BlocksChanged == 0)")
	}

	freshJSON := normalizedJSON(t, fresh)
	firstJSON := normalizedJSON(t, first)
	secondJSON := normalizedJSON(t, second)

	if !bytes.Equal(freshJSON, firstJSON) {
		t.Errorf("a Workspace's FIRST Generate call diverges from a fresh, one-shot Generate call")
	}
	if !bytes.Equal(freshJSON, secondJSON) {
		t.Errorf("a Workspace's SECOND (reused-libraries) Generate call diverges from a fresh, one-shot Generate call -- reuse changed the result")
	}

	// TotalDurationMs must reconcile with no arithmetic guesswork on either path, regardless of
	// how large LibraryBuildDurationMs itself came out (see
	// TestGenerate_DurationFieldsDistinguishBuildFromPlacement below for the assertion that it is
	// actually nonzero on the one-shot path, which needs disk-backed files to measure reliably --
	// this in-memory fixture's build is fast enough that a coarse system timer can legitimately
	// read it as exactly 0).
	for name, r := range map[string]*Result{"fresh": fresh, "first": first, "second": second} {
		if want := r.LibraryBuildDurationMs + r.PlacementDurationMs; r.TotalDurationMs != want {
			t.Errorf("%s.TotalDurationMs = %v, want LibraryBuildDurationMs(%v) + PlacementDurationMs(%v) = %v",
				name, r.TotalDurationMs, r.LibraryBuildDurationMs, r.PlacementDurationMs, want)
		}
	}
	if first.LibraryBuildDurationMs != 0 {
		t.Errorf("first.LibraryBuildDurationMs = %v, want exactly 0 -- Workspace.Generate reused an already-built Workspace and paid no build cost of its own", first.LibraryBuildDurationMs)
	}
	if second.LibraryBuildDurationMs != 0 {
		t.Errorf("second.LibraryBuildDurationMs = %v, want exactly 0 -- same as first, this call reused ws's already-built libraries", second.LibraryBuildDurationMs)
	}
}

// scatterFeatureFileForWorkspaceTest builds a minimal scatter_feature JSON
// body that always delegates to placesFeature exactly once per attempt at a
// fixed, deterministic (non-random) offset -- just enough surface area
// (two feature files, one delegating to the other) to exercise more of the
// build/place pipeline than a single single_block_feature alone, without
// needing a real .mcstructure asset.
func scatterFeatureFileForWorkspaceTest(identifier, placesFeature string) features.SourceFile {
	axis := map[string]any{"distribution": "uniform", "extent": []any{0, 0}}
	body := map[string]any{
		"format_version": "1.21.110",
		"minecraft:scatter_feature": map[string]any{
			"description":    map[string]any{"identifier": identifier},
			"places_feature": placesFeature,
			"distribution": map[string]any{
				"iterations": 3,
				"x":          axis,
				"y":          axis,
				"z":          axis,
			},
		},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return features.SourceFile{ID: identifier + ".json", AbsPath: identifier + ".json", Text: string(raw)}
}

// ---------------------------------------------------------------------------
// Invalidation: editing a feature file on disk between two generate calls,
// through the same Workspace via Update, must be reflected by the second
// call -- session.Generate's whole reason for existing is the
// save-then-regenerate loop, so a stale library here would be a worse bug
// than the slowness being fixed. Uses a temp dir.
// ---------------------------------------------------------------------------

// writeTestFile writes content to path, creating any missing parent directories -- the general
// form of writeWorkspaceTestFeature below, for a test that needs more than one file on disk (see
// TestGenerate_DurationFieldsDistinguishBuildFromPlacement).
func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeWorkspaceTestFeature(t *testing.T, root, placesBlock string) {
	t.Helper()
	dir := filepath.Join(root, "features")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	text := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"test:editable"},"places_block":"` + placesBlock + `"}}`
	if err := os.WriteFile(filepath.Join(dir, "editable.json"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// loadWorkspaceTestPack loads root's features/structures/feature_rules into
// a *pack.Pack -- the same on-disk loading path serve.go's methodLoadPack
// uses, so this test exercises the same "re-read from disk, then Update"
// shape a real edit-and-reload does.
func loadWorkspaceTestPack(t *testing.T, root string) *pack.Pack {
	t.Helper()
	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}
	return loaded
}

func TestWorkspace_UpdateRebuildsChangedFeatureFile(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceTestFeature(t, root, "minecraft:stone")
	loaded := loadWorkspaceTestPack(t, root)

	ws := NewWorkspace(loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)

	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:editable")

	before, err := ws.Generate(config)
	if err != nil {
		t.Fatalf("Generate (before edit): %v", err)
	}
	if got := placedBlockName(t, before); got != "minecraft:stone" {
		t.Fatalf("before edit: placed block = %q, want minecraft:stone", got)
	}

	// The edit: same file, same identifier, different places_block --
	// exactly a user saving a changed feature file.
	writeWorkspaceTestFeature(t, root, "minecraft:diamond_block")
	reloaded := loadWorkspaceTestPack(t, root)
	ws.Update(reloaded.Features, reloaded.Structures, reloaded.Rules, reloaded.Biomes, reloaded.Blocks)

	after, err := ws.Generate(config)
	if err != nil {
		t.Fatalf("Generate (after edit): %v", err)
	}
	if got := placedBlockName(t, after); got != "minecraft:diamond_block" {
		t.Fatalf("after edit: placed block = %q, want minecraft:diamond_block -- Update did not pick up the on-disk edit (stale library served)", got)
	}
}

// placedBlockName finds the one cell that changed from Baseline and returns
// its palette-decoded canonical block name -- the concrete, checkable proof
// that "the edit took effect" beyond just "no error was returned".
func placedBlockName(t *testing.T, r *Result) string {
	t.Helper()
	for i, id := range r.Blocks {
		if r.Baseline[i] != id {
			return r.Palette[id].Name
		}
	}
	t.Fatal("no cell differs from baseline -- nothing was placed")
	return ""
}

// ---------------------------------------------------------------------------
// Duration fields. durationMs used to
// mean two different things depending on which mode produced it -- see
// wire's package doc comment ("Duration fields") for the full rationale.
// This test proves the session-layer half of that fix: package-level
// Generate (the one-shot `generate` subcommand / desktop-app path) must
// report the real NewWorkspace cost it pays on LibraryBuildDurationMs, while
// Workspace.Generate (the `serve` reuse path) must report exactly zero
// there, since that cost was already paid once, earlier, outside the call.
// Uses pack.Load from real files on disk (not the in-memory SourceFile
// literals TestWorkspace_ReuseProducesByteIdenticalResultsToFresh above
// uses) specifically so the build genuinely takes measurable wall-clock
// time -- an in-memory, single-file build can legitimately complete inside
// one tick of a coarse system timer and read back as exactly 0, which is not
// what this test is trying to prove.
// ---------------------------------------------------------------------------

func TestGenerate_DurationFieldsDistinguishBuildFromPlacement(t *testing.T) {
	root := t.TempDir()
	// Several hundred files, not just one -- makes the build's disk I/O (open/read/parse each)
	// add up to comfortably more than this environment's observed ~1ms effective timer floor
	// (two back-to-back time.Now() calls with negligible work between them can read back an
	// exact zero delta here), so LibraryBuildDurationMs below reads back reliably nonzero instead
	// of flaking near that floor.
	const fillerFeatureCount = 300
	for i := 0; i < fillerFeatureCount; i++ {
		id := fmt.Sprintf("test:filler_%d", i)
		writeTestFile(t, filepath.Join(root, "features", fmt.Sprintf("filler_%d.json", i)), singleBlockFeatureJSONForWorkspaceTest(id, "minecraft:stone"))
	}
	writeWorkspaceTestFeature(t, root, "minecraft:diamond_block")
	loaded := loadWorkspaceTestPack(t, root)

	config, ok := DefaultConfig(env.EnvVoid)
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:editable")

	// One-shot: package-level Generate builds a brand-new Workspace for this call alone.
	oneShot, err := Generate(config, loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if oneShot.LibraryBuildDurationMs <= 0 {
		t.Errorf("one-shot Generate: LibraryBuildDurationMs = %v, want > 0 -- it just paid NewWorkspace's real build cost", oneShot.LibraryBuildDurationMs)
	}
	if want := oneShot.LibraryBuildDurationMs + oneShot.PlacementDurationMs; oneShot.TotalDurationMs != want {
		t.Errorf("one-shot Generate: TotalDurationMs = %v, want LibraryBuildDurationMs(%v) + PlacementDurationMs(%v) = %v",
			oneShot.TotalDurationMs, oneShot.LibraryBuildDurationMs, oneShot.PlacementDurationMs, want)
	}

	// serve-style: build the Workspace once (mirrors "loadPack"), then Generate against it
	// (mirrors a "generate" call) -- the cost above must not be re-paid or re-reported here.
	ws := NewWorkspace(loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	viaWorkspace, err := ws.Generate(config)
	if err != nil {
		t.Fatalf("Workspace.Generate: %v", err)
	}
	if viaWorkspace.LibraryBuildDurationMs != 0 {
		t.Errorf("Workspace.Generate: LibraryBuildDurationMs = %v, want exactly 0 -- the build cost was already paid by NewWorkspace above, outside this call", viaWorkspace.LibraryBuildDurationMs)
	}
	if viaWorkspace.TotalDurationMs != viaWorkspace.PlacementDurationMs {
		t.Errorf("Workspace.Generate: TotalDurationMs = %v, want == PlacementDurationMs (%v) exactly, since LibraryBuildDurationMs is 0",
			viaWorkspace.TotalDurationMs, viaWorkspace.PlacementDurationMs)
	}
}

func singleBlockFeatureJSONForWorkspaceTest(identifier, placesBlock string) string {
	return `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"` +
		identifier + `"},"places_block":"` + placesBlock + `"}}`
}
