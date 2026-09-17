package pack

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/stirante/featurelab/block"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoad_NothingRequestedIsAnError(t *testing.T) {
	if _, err := Load(Options{}); err == nil {
		t.Error("Load with no Dir and no overrides should return an error, not an empty Pack")
	}
}

func TestLoad_ConventionalSubdirsFromPackRoot(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":1}`)
	writeFile(t, filepath.Join(root, "features", "sub", "b.json"), `{"b":2}`)
	writeFile(t, filepath.Join(root, "structures", "s.mcstructure"), "binarydata")
	writeFile(t, filepath.Join(root, "feature_rules", "r.json"), `{"r":1}`)
	writeFile(t, filepath.Join(root, "biomes", "bi.json"), `{"bi":1}`)
	writeFile(t, filepath.Join(root, "blocks", "bl.json"), `{"bl":1}`)

	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none (every conventional dir exists)", p.Warnings)
	}
	if len(p.Features) != 2 {
		t.Fatalf("len(Features) = %d, want 2", len(p.Features))
	}
	// ID uses POSIX separators and is relative to the features/ root, sorted.
	if p.Features[0].ID != "a.json" || p.Features[1].ID != "sub/b.json" {
		t.Errorf("Feature IDs = %q, %q", p.Features[0].ID, p.Features[1].ID)
	}
	if len(p.Structures) != 1 || p.Structures[0].ID != "s.mcstructure" {
		t.Errorf("Structures = %+v", p.Structures)
	}
	if len(p.Rules) != 1 || p.Rules[0].ID != "r.json" {
		t.Errorf("Rules = %+v", p.Rules)
	}
	if len(p.Biomes) != 1 || p.Biomes[0].ID != "bi.json" {
		t.Errorf("Biomes = %+v", p.Biomes)
	}
	// Blocks now carries the generated vanilla default catalogue (block.
	// DefaultBlocks) ahead of the pack's own bl.json -- pack.Load wires
	// vanilla in as a default pack loaded before any user pack, through
	// this exact same loader path (see pack.Load's blocks branch).
	wantVanilla := len(block.DefaultBlocks())
	if wantVanilla == 0 {
		t.Fatal("block.DefaultBlocks() returned nothing -- test cannot tell vanilla defaults from the pack's own file")
	}
	if len(p.Blocks) != wantVanilla+1 {
		t.Fatalf("len(Blocks) = %d, want %d (vanilla defaults) + 1 (the pack's own bl.json)", len(p.Blocks), wantVanilla+1)
	}
	last := p.Blocks[len(p.Blocks)-1]
	if last.ID != "bl.json" {
		t.Errorf("last Blocks entry ID = %q, want %q (the pack's own file must load AFTER every vanilla default)", last.ID, "bl.json")
	}
	for i, f := range p.Blocks[:wantVanilla] {
		if f.ID == "bl.json" {
			t.Fatalf("Blocks[%d] is the pack's own bl.json, found among the leading vanilla-default entries", i)
		}
	}
}

func TestLoad_MissingConventionalDirWarnsButDoesNotError(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{}`)
	// No structures/, feature_rules/, biomes/, or blocks/ directory at all.

	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Structures) != 0 || len(p.Rules) != 0 || len(p.Biomes) != 0 {
		t.Errorf("expected empty Structures/Rules/Biomes, got %+v / %+v / %+v", p.Structures, p.Rules, p.Biomes)
	}
	// Blocks is deliberately NOT expected to be empty here even though this
	// pack has no blocks/ directory of its own: the generated vanilla
	// default catalogue (block.DefaultBlocks) loads unconditionally
	// whenever block loading is requested at all -- see pack.Load's blocks
	// branch. A pack that truly declares zero blocks of its own still ends
	// up with exactly the vanilla defaults, never zero.
	wantVanilla := len(block.DefaultBlocks())
	if wantVanilla == 0 {
		t.Fatal("block.DefaultBlocks() returned nothing -- test cannot distinguish vanilla defaults from an empty Blocks slice")
	}
	if len(p.Blocks) != wantVanilla {
		t.Errorf("len(Blocks) = %d, want exactly %d (vanilla defaults only -- this pack declares none of its own)", len(p.Blocks), wantVanilla)
	}
	if len(p.Warnings) != 4 {
		t.Fatalf("Warnings = %v, want exactly 4 (structures, feature_rules, biomes, blocks each missing)", p.Warnings)
	}
}

// TestLoad_UserPackBlockOverridesVanillaDefault is the end-to-end proof of
// this pack's two wiring requirements together: (1) block.DefaultBlocks()
// (the generated vanilla catalogue) loads through Load's SAME blocks
// branch a user pack's own blocks/ directory goes through, ordered before
// it, and (2) a user-pack block declaring an id that a vanilla default
// already carries overrides it, exactly like a higher-priority pack
// overriding a lower one in game. minecraft:stone is a real entry in the
// shipped block/vanilla/blocks catalogue (see block/vanilla/blocks/
// minecraft__stone.json) with empty components -- this pack redeclares
// that exact identifier, under a differently-named file (proving the
// override is keyed by the JSON identifier, not by filename), carrying a
// tag the vanilla entry does not have. If Load appended vanilla AFTER the
// user's files instead of before, or if LoadBlockTags merged instead of
// overriding, the vanilla (tagless) declaration would win and this tag
// would be absent.
func TestLoad_UserPackBlockOverridesVanillaDefault(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "blocks", "stone_override.json"), `{
		"minecraft:block": {
			"description": {"identifier": "minecraft:stone"},
			"components": {"tag:wiki:user_pack_override": {}}
		}
	}`)

	p, err := Load(Options{BlocksDir: filepath.Join(root, "blocks")})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	wantVanilla := len(block.DefaultBlocks())
	if len(p.Blocks) != wantVanilla+1 {
		t.Fatalf("len(Blocks) = %d, want %d (vanilla defaults) + 1 (stone_override.json)", len(p.Blocks), wantVanilla+1)
	}
	if p.Blocks[len(p.Blocks)-1].ID != "stone_override.json" {
		t.Fatalf("last Blocks entry ID = %q, want stone_override.json -- the user pack's own file must load after every vanilla default", p.Blocks[len(p.Blocks)-1].ID)
	}

	palette := block.NewPalette()
	diags := palette.LoadBlockTags(p.Blocks)
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}
	stoneID := palette.Get("minecraft:stone", nil)
	m := palette.NewMatchSet([]block.Descriptor{{IsTags: true, Tags: "q.any_tag('wiki:user_pack_override')"}}, nil, nil, nil)
	if !m.Contains(stoneID) {
		t.Error("expected minecraft:stone to carry wiki:user_pack_override -- the user pack's block must override the vanilla default of the same id")
	}
}

func TestLoad_ExplicitOverrideWinsOverConventionalSubdir(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "conventional.json"), `{}`)
	altDir := t.TempDir()
	writeFile(t, filepath.Join(altDir, "override.json"), `{}`)

	p, err := Load(Options{Dir: root, FeaturesDir: altDir})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Features) != 1 || p.Features[0].ID != "override.json" {
		t.Fatalf("Features = %+v, want exactly the override dir's file", p.Features)
	}
}

func TestLoad_ExplicitOverrideThatDoesNotExistStillWarns(t *testing.T) {
	root := t.TempDir()
	p, err := Load(Options{Dir: root, FeaturesDir: filepath.Join(root, "does_not_exist")})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Features) != 0 {
		t.Errorf("Features = %+v, want none", p.Features)
	}
	found := false
	for _, w := range p.Warnings {
		if contains(w, "given explicitly") {
			found = true
		}
	}
	if !found {
		t.Errorf("Warnings = %v, want one calling out the explicit override as missing", p.Warnings)
	}
}

func TestLoad_OnlyOneKindRequestedWithNoDir(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "x.mcstructure"), "data")

	p, err := Load(Options{StructuresDir: dir})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Structures) != 1 {
		t.Fatalf("Structures = %+v, want 1", p.Structures)
	}
	if len(p.Features) != 0 || len(p.Rules) != 0 || len(p.Biomes) != 0 {
		t.Errorf("expected only Structures populated, got Features=%+v Rules=%+v Biomes=%+v", p.Features, p.Rules, p.Biomes)
	}
	if len(p.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none -- only StructuresDir was requested and it exists", p.Warnings)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (func() bool {
		for i := 0; i+len(substr) <= len(s); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	})()
}

// TestReloadFile_LeavesExactlyWhatAFullLoadWouldHave is ReloadFile's whole
// safety argument in one test: after an edit, an addition and a deletion
// are spliced in one file at a time, every list must be deep-equal to what
// Load produces by walking the same directories from scratch -- same
// entries, same ids, same order. That equality is what lets a client mix
// the fast path and the slow one freely: whatever the incremental route
// leaves behind, a full reload would have agreed with.
func TestReloadFile_LeavesExactlyWhatAFullLoadWouldHave(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":1}`)
	writeFile(t, filepath.Join(root, "features", "m.json"), `{"m":1}`)
	writeFile(t, filepath.Join(root, "features", "sub", "b.json"), `{"b":2}`)
	writeFile(t, filepath.Join(root, "structures", "s.mcstructure"), "binarydata")
	writeFile(t, filepath.Join(root, "feature_rules", "r.json"), `{"r":1}`)
	writeFile(t, filepath.Join(root, "biomes", "bi.json"), `{"bi":1}`)
	writeFile(t, filepath.Join(root, "blocks", "bl.json"), `{"bl":1}`)

	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// One of each case, across four different kinds.
	edited := filepath.Join(root, "features", "m.json")
	writeFile(t, edited, `{"m":2}`)
	added := filepath.Join(root, "features", "c.json") // sorts between a.json and m.json
	writeFile(t, added, `{"c":3}`)
	addedBlock := filepath.Join(root, "blocks", "aa.json") // sorts BEFORE bl.json, and before every vanilla file
	writeFile(t, addedBlock, `{"aa":1}`)
	deleted := filepath.Join(root, "features", "a.json")
	if err := os.Remove(deleted); err != nil {
		t.Fatal(err)
	}
	editedBiome := filepath.Join(root, "biomes", "bi.json")
	writeFile(t, editedBiome, `{"bi":2}`)

	for _, path := range []string{edited, added, addedBlock, deleted, editedBiome} {
		if err := p.ReloadFile(path); err != nil {
			t.Fatalf("ReloadFile(%s): %v", path, err)
		}
	}

	fresh, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if !reflect.DeepEqual(p.Features, fresh.Features) {
		t.Errorf("Features after incremental reloads:\n%+v\nafter a full Load:\n%+v", p.Features, fresh.Features)
	}
	if !reflect.DeepEqual(p.Biomes, fresh.Biomes) {
		t.Errorf("Biomes after incremental reloads:\n%+v\nafter a full Load:\n%+v", p.Biomes, fresh.Biomes)
	}
	if !reflect.DeepEqual(p.Rules, fresh.Rules) {
		t.Errorf("Rules diverged even though no rule file was touched:\n%+v\n%+v", p.Rules, fresh.Rules)
	}
	if !reflect.DeepEqual(p.Structures, fresh.Structures) {
		t.Errorf("Structures diverged even though no structure file was touched:\n%+v\n%+v", p.Structures, fresh.Structures)
	}
	if !reflect.DeepEqual(p.Blocks, fresh.Blocks) {
		t.Errorf("Blocks diverged: %d entries incrementally, %d after a full Load", len(p.Blocks), len(fresh.Blocks))
	}
}

// TestReloadFile_NewPackBlockStaysBelowNothingAndAboveTheVanillaCatalogue
// pins the one ordering that is not just cosmetic: LoadBlockTags lets the
// LAST file declaring a block identifier win, so a pack's own blocks/ file
// added incrementally has to land AFTER the whole embedded vanilla
// catalogue -- even when its id sorts before every vanilla id. Sorted
// insertion into the list as a whole would bury it in the middle of the
// catalogue and silently hand the win back to vanilla.
func TestReloadFile_NewPackBlockStaysAboveTheVanillaCatalogue(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "blocks", "zz.json"), `{"zz":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	vanillaCount := len(p.Blocks) - 1

	// "0.json" sorts before every vanilla file id there is.
	added := filepath.Join(root, "blocks", "0.json")
	writeFile(t, added, `{"zero":1}`)
	if err := p.ReloadFile(added); err != nil {
		t.Fatalf("ReloadFile: %v", err)
	}
	if len(p.Blocks) != vanillaCount+2 {
		t.Fatalf("len(Blocks) = %d, want %d", len(p.Blocks), vanillaCount+2)
	}
	own := p.Blocks[vanillaCount:]
	if own[0].ID != "0.json" || own[1].ID != "zz.json" {
		t.Errorf("this pack's own block files = %q, %q -- want the new file inside the pack's own section, sorted", own[0].ID, own[1].ID)
	}
	for i, f := range p.Blocks[:vanillaCount] {
		if f.AbsPath == added {
			t.Fatalf("the new pack file landed at index %d, inside the vanilla catalogue -- it would lose to a vanilla entry it should override", i)
		}
	}
}

func TestReloadFile_PathOutsideEveryLoadedDirIsRefused(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	outside := filepath.Join(t.TempDir(), "elsewhere.json")
	writeFile(t, outside, `{"x":1}`)
	if err := p.ReloadFile(outside); err == nil {
		t.Error("ReloadFile of a path outside every loaded directory should refuse, so the caller can fall back to a full reload")
	}
	// Inside features/, but not a file the walk would ever have read.
	notes := filepath.Join(root, "features", "notes.md")
	writeFile(t, notes, "not json")
	if err := p.ReloadFile(notes); err == nil {
		t.Error("ReloadFile of a file Load itself would skip should refuse rather than silently report success")
	}
	if len(p.Features) != 1 {
		t.Errorf("len(Features) = %d, want 1 -- a refused reload must not change anything", len(p.Features))
	}
}

// TestReloadFile_DoesNotWriteThroughTheCallersPreviousSlice pins the
// obligation session.Workspace's reuseFingerprint now relies on: the
// slices handed out before a reload keep the contents they had, so a cache
// holding one as "the files I last built from" is never edited underneath.
func TestReloadFile_DoesNotWriteThroughTheCallersPreviousSlice(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	before := p.Features

	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":2}`)
	if err := p.ReloadFile(filepath.Join(root, "features", "a.json")); err != nil {
		t.Fatalf("ReloadFile: %v", err)
	}
	if before[0].Text != `{"a":1}` {
		t.Errorf("the previously handed-out slice now reads %q -- ReloadFile wrote through it", before[0].Text)
	}
	if p.Features[0].Text != `{"a":2}` {
		t.Errorf("Features[0].Text = %q, want the edited content", p.Features[0].Text)
	}
	if &before[0] == &p.Features[0] {
		t.Error("the changed kind came back as the SAME backing array -- session.Workspace would take that as proof nothing changed")
	}
}

// TestReloadFile_DeletedFileIsDropped covers the case that would otherwise
// keep generating from a file the pack no longer has.
func TestReloadFile_DeletedFileIsDropped(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":1}`)
	writeFile(t, filepath.Join(root, "features", "b.json"), `{"b":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if err := os.Remove(filepath.Join(root, "features", "a.json")); err != nil {
		t.Fatal(err)
	}
	if err := p.ReloadFile(filepath.Join(root, "features", "a.json")); err != nil {
		t.Fatalf("ReloadFile of a deleted file should succeed by dropping it: %v", err)
	}
	if len(p.Features) != 1 || p.Features[0].ID != "b.json" {
		t.Errorf("Features = %+v, want only b.json", p.Features)
	}
	// ...and a file that was never there and still isn't is a no-op, not an error.
	if err := p.ReloadFile(filepath.Join(root, "features", "a.json")); err != nil {
		t.Errorf("second ReloadFile of the same deleted file: %v", err)
	}
	if len(p.Features) != 1 {
		t.Errorf("len(Features) = %d, want 1", len(p.Features))
	}
}

// TestReloadFile_MatchesAPathSpelledDifferently proves the path comparison
// is the filesystem's, not Go's == -- an editor reporting a saved document
// with a differently-cased drive letter (or a redundant "." segment) must
// still update the entry that is already there instead of adding a second
// one beside it.
func TestReloadFile_MatchesAPathSpelledDifferently(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	writeFile(t, filepath.Join(root, "features", "a.json"), `{"a":2}`)
	if err := p.ReloadFile(filepath.Join(root, "features", ".", "a.json")); err != nil {
		t.Fatalf("ReloadFile: %v", err)
	}
	if len(p.Features) != 1 {
		t.Fatalf("len(Features) = %d, want 1 -- the same file was added a second time", len(p.Features))
	}
	if p.Features[0].Text != `{"a":2}` {
		t.Errorf("Features[0].Text = %q, want the edited content", p.Features[0].Text)
	}
}

func TestReloadFile_StructureAndRuleFilesReachTheirOwnLists(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "structures", "s.mcstructure"), "before")
	writeFile(t, filepath.Join(root, "feature_rules", "r.json"), `{"r":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	writeFile(t, filepath.Join(root, "structures", "s.mcstructure"), "after")
	writeFile(t, filepath.Join(root, "structures", "legacy.nbt"), "nbtdata")
	writeFile(t, filepath.Join(root, "feature_rules", "r.json"), `{"r":2}`)
	for _, path := range []string{
		filepath.Join(root, "structures", "s.mcstructure"),
		filepath.Join(root, "structures", "legacy.nbt"),
		filepath.Join(root, "feature_rules", "r.json"),
	} {
		if err := p.ReloadFile(path); err != nil {
			t.Fatalf("ReloadFile(%s): %v", path, err)
		}
	}
	if len(p.Structures) != 2 || p.Structures[0].ID != "legacy.nbt" || string(p.Structures[1].Data) != "after" {
		t.Errorf("Structures = %+v, want legacy.nbt added and s.mcstructure re-read", p.Structures)
	}
	if len(p.Rules) != 1 || p.Rules[0].Text != `{"r":2}` {
		t.Errorf("Rules = %+v, want the re-read rule file", p.Rules)
	}
}

// TestReloadFile_KeepsTheEntrysOwnIDAndPathNotTheCallersSpelling pins the
// first of ReloadFile's four decided cases: a file already in the list is
// replaced KEEPING THE ENTRY'S own id and path, never the caller's spelling
// of them. TestReloadFile_MatchesAPathSpelledDifferently above proves the
// two spellings still find each other; this proves what is left behind
// afterwards, which is the half that keeps "the same lists a full Load
// would produce" true.
//
// Windows only, because Windows is the only host where two different
// spellings can name one file -- which is exactly the situation SamePath
// exists for (see its doc comment). Elsewhere MIXEDCASE.JSON simply is not
// the same file and there is nothing to assert.
//
// If the caller's spelling were stored instead, the entry's ID would stop
// being the one walkText derived from the name on disk. Nothing fails
// immediately; the damage shows up wherever the id is what the user sees --
// a diagnostic naming a file that exists under no such name, a picker entry
// whose spelling depends on which editor last saved it -- and the list
// quietly stops being deep-equal to a full Load's.
func TestReloadFile_KeepsTheEntrysOwnIDAndPathNotTheCallersSpelling(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("needs a case-insensitive filesystem for two spellings to name one file -- see SamePath")
	}
	root := t.TempDir()
	onDisk := filepath.Join(root, "features", "MixedCase.json")
	writeFile(t, onDisk, `{"a":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Features) != 1 || p.Features[0].ID != "MixedCase.json" {
		t.Fatalf("Features = %+v, want the one file under its on-disk spelling", p.Features)
	}

	writeFile(t, onDisk, `{"a":2}`)
	// The same file, as an editor that does not preserve case would report it.
	shouted := filepath.Join(root, "features", "MIXEDCASE.JSON")
	if err := p.ReloadFile(shouted); err != nil {
		t.Fatalf("ReloadFile: %v", err)
	}

	if len(p.Features) != 1 {
		t.Fatalf("len(Features) = %d, want 1 -- the same file was added a second time", len(p.Features))
	}
	if p.Features[0].Text != `{"a":2}` {
		t.Errorf("Features[0].Text = %q, want the edited content", p.Features[0].Text)
	}
	if p.Features[0].ID != "MixedCase.json" {
		t.Errorf("Features[0].ID = %q, want %q -- the entry took the caller's spelling instead of keeping its own", p.Features[0].ID, "MixedCase.json")
	}
	if p.Features[0].AbsPath != onDisk {
		t.Errorf("Features[0].AbsPath = %q, want %q -- the entry took the caller's spelling instead of keeping its own", p.Features[0].AbsPath, onDisk)
	}
	fresh, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if !reflect.DeepEqual(p.Features, fresh.Features) {
		t.Errorf("Features after the reload:\n%+v\nafter a full Load:\n%+v", p.Features, fresh.Features)
	}
}

// TestReloadFile_ADeletedFileIsDroppedFromEveryKindsList extends
// TestReloadFile_LeavesExactlyWhatAFullLoadWouldHave's promise to the four
// kinds that test never deletes from. ReloadFile's five splice call sites
// are five separate pieces of code, so "features drops a deleted file" says
// nothing about the other four -- and a kind that kept an entry for a file
// the pack no longer has is exactly the failure
// TestReloadFile_DeletedFileIsDropped names, just for a structure, rule,
// biome or block instead of a feature.
func TestReloadFile_ADeletedFileIsDroppedFromEveryKindsList(t *testing.T) {
	root := t.TempDir()
	// Two files per kind, so a list emptied by mistake is distinguishable
	// from one entry correctly dropped.
	writeFile(t, filepath.Join(root, "structures", "keep.mcstructure"), "keepdata")
	writeFile(t, filepath.Join(root, "structures", "doomed.mcstructure"), "doomeddata")
	writeFile(t, filepath.Join(root, "feature_rules", "keep.json"), `{"keep":1}`)
	writeFile(t, filepath.Join(root, "feature_rules", "doomed.json"), `{"doomed":1}`)
	writeFile(t, filepath.Join(root, "biomes", "keep.json"), `{"keep":1}`)
	writeFile(t, filepath.Join(root, "biomes", "doomed.json"), `{"doomed":1}`)
	writeFile(t, filepath.Join(root, "blocks", "keep.json"), `{"keep":1}`)
	writeFile(t, filepath.Join(root, "blocks", "doomed.json"), `{"doomed":1}`)

	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	for _, doomed := range []string{
		filepath.Join(root, "structures", "doomed.mcstructure"),
		filepath.Join(root, "feature_rules", "doomed.json"),
		filepath.Join(root, "biomes", "doomed.json"),
		filepath.Join(root, "blocks", "doomed.json"),
	} {
		if err := os.Remove(doomed); err != nil {
			t.Fatal(err)
		}
		if err := p.ReloadFile(doomed); err != nil {
			t.Fatalf("ReloadFile(%s) of a deleted file should succeed by dropping it: %v", doomed, err)
		}
	}

	if len(p.Structures) != 1 || p.Structures[0].ID != "keep.mcstructure" {
		t.Errorf("Structures = %+v, want only keep.mcstructure", p.Structures)
	}
	if len(p.Rules) != 1 || p.Rules[0].ID != "keep.json" {
		t.Errorf("Rules = %+v, want only keep.json", p.Rules)
	}
	if len(p.Biomes) != 1 || p.Biomes[0].ID != "keep.json" {
		t.Errorf("Biomes = %+v, want only keep.json", p.Biomes)
	}
	// Blocks carries the vanilla catalogue as well as this pack's own two,
	// so the assertion is by name rather than by length.
	for _, f := range p.Blocks {
		if f.ID == "doomed.json" {
			t.Errorf("Blocks still carries doomed.json (%s) after it was deleted from disk", f.AbsPath)
		}
	}

	// And the whole point: every list is still exactly what a full Load makes.
	fresh, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if !reflect.DeepEqual(p.Structures, fresh.Structures) {
		t.Errorf("Structures after the deletions:\n%+v\nafter a full Load:\n%+v", p.Structures, fresh.Structures)
	}
	if !reflect.DeepEqual(p.Rules, fresh.Rules) {
		t.Errorf("Rules after the deletions:\n%+v\nafter a full Load:\n%+v", p.Rules, fresh.Rules)
	}
	if !reflect.DeepEqual(p.Biomes, fresh.Biomes) {
		t.Errorf("Biomes after the deletions:\n%+v\nafter a full Load:\n%+v", p.Biomes, fresh.Biomes)
	}
	if !reflect.DeepEqual(p.Blocks, fresh.Blocks) {
		t.Errorf("Blocks diverged: %d entries incrementally, %d after a full Load", len(p.Blocks), len(fresh.Blocks))
	}
}

// TestReloadFile_AnUnreadableFileIsRefusedNotTreatedAsADeletion pins the
// paragraph ReloadFile's doc comment ends on. "Cannot read it" and "it is
// gone" are different answers: a file an editor is still holding open, or
// one whose permissions momentarily deny a read, is still part of the pack,
// and dropping it on that evidence silently changes what the pack generates
// on the strength of a transient failure. Worse, it would do so
// SUCCESSFULLY -- so every caller (serve's "reloadFile", the desktop app's
// save path) reads that as "the fast route worked" and never falls back to
// the full reload that would have got it right.
//
// A directory standing where the file was is the portable way to produce a
// read error that is not os.IsNotExist (EISDIR on unix, "Incorrect
// function" on Windows) without depending on this process's privileges.
func TestReloadFile_AnUnreadableFileIsRefusedNotTreatedAsADeletion(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "features", "a.json")
	writeFile(t, target, `{"a":1}`)
	writeFile(t, filepath.Join(root, "features", "b.json"), `{"b":1}`)
	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := p.ReloadFile(target); err == nil {
		t.Error("ReloadFile reported success for a file it could not read -- the caller will not fall back, and the entry was dropped on the strength of a transient failure")
	}
	if len(p.Features) != 2 {
		t.Errorf("Features = %+v, want both entries left exactly as they were -- an unreadable file is not a deleted one", p.Features)
	}
}

// TestReloadFile_OverlappingKindDirectoriesSpliceIntoEveryMatchingList
// covers what ReloadFile's "every kind whose directory contains the path,
// not just the first one to match" comment is about. Pointing two kinds at
// one directory is deliberately odd (--blocks aimed at the pack root, or a
// flat directory loaded as both features and blocks) but it is a
// configuration Load accepts, and a full Load walks such a file into BOTH
// lists. The incremental route has to agree, or a save updates one list and
// leaves the other reading whatever was on disk at load time.
func TestReloadFile_OverlappingKindDirectoriesSpliceIntoEveryMatchingList(t *testing.T) {
	dir := t.TempDir()
	shared := filepath.Join(dir, "shared.json")
	writeFile(t, shared, `{"v":1}`)

	p, err := Load(Options{FeaturesDir: dir, BlocksDir: dir})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Features) != 1 {
		t.Fatalf("Features = %+v, want the shared file", p.Features)
	}

	writeFile(t, shared, `{"v":2}`)
	if err := p.ReloadFile(shared); err != nil {
		t.Fatalf("ReloadFile: %v", err)
	}

	if p.Features[0].Text != `{"v":2}` {
		t.Errorf("Features[0].Text = %q, want the edited content", p.Features[0].Text)
	}
	own := p.Blocks[len(p.Blocks)-1]
	if own.ID != "shared.json" || own.Text != `{"v":2}` {
		t.Errorf("this pack's own last Blocks entry = %+v, want shared.json carrying the edited content -- the splice stopped at the first kind that claimed the path", own)
	}

	fresh, err := Load(Options{FeaturesDir: dir, BlocksDir: dir})
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if !reflect.DeepEqual(p.Features, fresh.Features) {
		t.Errorf("Features:\n%+v\nafter a full Load:\n%+v", p.Features, fresh.Features)
	}
	if !reflect.DeepEqual(p.Blocks, fresh.Blocks) {
		t.Errorf("Blocks diverged from a full Load's")
	}
}
