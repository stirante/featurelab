package pack

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
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

// TestLoad_MissingDirectoryWarningSpellsThePathOnce pins the warning TEXT, not just its
// presence, because these strings are shown verbatim to people -- the extension puts them in
// its log and inside its error messages.
//
// Both defects this guards against shipped at once. The format string's leading verb was fed
// the PATH where it meant the KIND, and the %q beside it printed the same path again with every
// backslash doubled, so one missing directory produced
//
//	C:\pack\biomes directory "C:\pack\biomes" does not exist -- 0 biomes files loaded
//
// which reads as two different paths, neither of them spelled the way it exists on disk. The
// blocks warning alongside it had no leading path at all, so adjacent warnings about the same
// pack did not even agree on their own shape.
func TestLoad_MissingDirectoryWarningSpellsThePathOnce(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "f.json"), "{}")

	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Warnings) == 0 {
		t.Fatal("Warnings = none, want one per missing conventional directory")
	}
	for _, w := range p.Warnings {
		// Exactly one kind name, then exactly one path, then the rest of the sentence. A
		// second occurrence of the directory path is the duplication itself.
		dir := p.Dirs.Structures
		switch {
		case strings.Contains(w, "feature_rules directory"):
			dir = p.Dirs.Rules
		case strings.Contains(w, "biomes directory"):
			dir = p.Dirs.Biomes
		case strings.Contains(w, "blocks directory"):
			dir = p.Dirs.Blocks
		}
		if n := strings.Count(w, dir); n != 1 {
			t.Errorf("warning names %s %d times, want exactly once: %s", dir, n, w)
		}
		if !strings.Contains(w, `"`+dir+`"`) {
			t.Errorf("warning does not spell the path verbatim in quotes: %s", w)
		}
		// The Go-quoted spelling doubles every separator on Windows, which is what made one
		// warning show two different-looking paths for one directory. On a platform whose
		// separator needs no escaping the two spellings coincide and this check is a no-op,
		// which is correct: there is nothing to get wrong there.
		if quoted := fmt.Sprintf("%q", dir); quoted != `"`+dir+`"` && strings.Contains(w, quoted) {
			t.Errorf("warning contains the Go-escaped spelling %s: %s", quoted, w)
		}
		// Every warning starts with the KIND, never with the path -- the one shape all of
		// them share.
		if strings.HasPrefix(w, dir) {
			t.Errorf("warning starts with the path rather than the asset kind: %s", w)
		}
	}
}

// TestLoad_MissingDirsMirrorWarningsAndSayWhichKindOfNewsEachIs covers the structured half of
// Load's missing-directory notices.
//
// Those sentences are not all the same kind of news and, until MissingDirs, the only thing that
// said which was which was the prose. A conventional directory a pack simply does not have is
// normal -- every minimal pack is missing four of the five -- while a directory an explicit
// override NAMED and that is not there is a typo'd path. A consumer levelling these (see
// cmd/featurelab's `check`) has to be able to tell them apart without matching on
// "(fine if this pack has none)".
func TestLoad_MissingDirsMirrorWarningsAndSayWhichKindOfNewsEachIs(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "features"), 0o755); err != nil {
		t.Fatal(err)
	}
	explicit := filepath.Join(root, "not_biomes_at_all")

	p, err := Load(Options{Dir: root, BiomesDir: explicit})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Same set, same order, same strings: Warnings is untouched by this, and every client
	// already reading it carries on unchanged.
	if len(p.MissingDirs) != len(p.Warnings) {
		t.Fatalf("MissingDirs = %+v, Warnings = %v -- the two lists must describe the same notices", p.MissingDirs, p.Warnings)
	}
	for i := range p.Warnings {
		if p.MissingDirs[i].Message != p.Warnings[i] {
			t.Errorf("MissingDirs[%d].Message = %q, Warnings[%d] = %q -- they must be the same sentence",
				i, p.MissingDirs[i].Message, i, p.Warnings[i])
		}
	}

	var sawExplicit, sawConventional bool
	for _, m := range p.MissingDirs {
		if m.Kind == "biomes" {
			sawExplicit = true
			if !m.Explicit {
				t.Errorf("MissingDir for the explicitly given --biomes directory = %+v, want Explicit", m)
			}
			if m.Dir != explicit {
				t.Errorf("MissingDir.Dir = %q, want the directory that was actually asked for (%q)", m.Dir, explicit)
			}
			continue
		}
		sawConventional = true
		if m.Explicit {
			t.Errorf("MissingDir %+v is a conventional subdirectory and must not be reported as explicitly named", m)
		}
	}
	if !sawExplicit || !sawConventional {
		t.Fatalf("MissingDirs = %+v, want both an explicitly named and a conventional entry", p.MissingDirs)
	}
}

// TestLoad_MissingPackRootIsAnError is the bug this whole group covers, at its
// source. Load used to stat only the SUBdirectories: a root that was not on
// disk resolved five conventional paths under it, found none of them, recorded
// the ordinary "fine if this pack has none" notice for each, and returned a Pack
// with no files and a nil error. Every caller then reported a clean, empty pack
// for a directory that does not exist.
func TestLoad_MissingPackRootIsAnError(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no_such_pack")

	p, err := Load(Options{Dir: missing})
	if err == nil {
		t.Fatalf("Load of a pack root that is not on disk returned no error (Pack = %+v) -- a caller cannot tell this from an empty pack", p)
	}
	// The path, spelled once and verbatim: it is the thing the caller has to
	// fix, and a message without it sends them looking for which of several
	// --pack/--features paths was wrong.
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("error = %q, want it to name the path %q", err, missing)
	}
	if p != nil {
		t.Errorf("Load returned a Pack alongside the error (%+v); a caller that ignores the error must not find a usable-looking pack", p)
	}
}

// A root that IS there but is a file -- --pack aimed at manifest.json, or at a
// .mcpack nobody unpacked -- is the other half of the same typo, and produced
// the same wordless clean pack for the same reason.
func TestLoad_PackRootThatIsAFileIsAnError(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "manifest.json")
	writeFile(t, file, `{"format_version":2}`)

	_, err := Load(Options{Dir: file})
	if err == nil {
		t.Fatal("Load of a pack root that is a file returned no error")
	}
	if !strings.Contains(err.Error(), file) {
		t.Errorf("error = %q, want it to name the path %q", err, file)
	}
	// It has to say WHICH of the two wrong things it is. "does not exist" for a
	// file that plainly does exist is the message that costs the reader the
	// most time.
	if !contains(err.Error(), "not a directory") {
		t.Errorf("error = %q, want it to say the path is a file rather than a directory", err)
	}
}

// TestLoad_PackRootWithNoneOfTheExpectedDirsWarnsButLoads pins the DECISION
// about the third case, which is deliberately not the same as the two above: a
// real directory holding none of the five is either --pack aimed one level too
// high or an ordinary behaviour pack with no world-generation content at all,
// and this loader cannot tell those apart. So it loads, it does not error --
// and it says so at a level someone will actually read, because the five
// per-kind notices it already emits each end "(fine if this pack has none)"
// and between them never say that nothing was loaded.
func TestLoad_PackRootWithNoneOfTheExpectedDirsWarnsButLoads(t *testing.T) {
	root := t.TempDir()
	// A plausible non-worldgen behaviour pack: real files, none of them ours.
	writeFile(t, filepath.Join(root, "manifest.json"), `{"format_version":2}`)
	writeFile(t, filepath.Join(root, "loot_tables", "t.json"), `{}`)

	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v -- a directory that exists and simply has no worldgen content is not an error", err)
	}
	var found string
	for _, w := range p.Warnings {
		if contains(w, "contains none of") {
			found = w
		}
	}
	if found == "" {
		t.Fatalf("Warnings = %v, want one saying the root holds none of the five directories", p.Warnings)
	}
	if !strings.Contains(found, root) {
		t.Errorf("notice = %q, want it to name the root %q", found, root)
	}
	// It is about the root, not about a missing directory, so it is the one
	// warning with no MissingDirs entry -- which is what makes a consumer
	// pairing the two by message level it as a warning rather than as another
	// benign per-kind note. Pairing by INDEX would now be wrong, and this is
	// what says so.
	for _, m := range p.MissingDirs {
		if m.Message == found {
			t.Errorf("MissingDirs carries the root notice (%+v); it names no missing directory and must not be levelled as one", m)
		}
	}
}

// The same root with even ONE of the five present is an ordinary pack and must
// stay silent about the root -- the notice above is worth having only because
// it is rare.
func TestLoad_PackRootWithOneOfTheExpectedDirsSaysNothingAboutTheRoot(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "features", "a.json"), `{}`)

	p, err := Load(Options{Dir: root})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	for _, w := range p.Warnings {
		if contains(w, "contains none of") {
			t.Errorf("Warnings = %v, want nothing about the root -- features/ is there", p.Warnings)
		}
	}
}
