// Package pack loads a behaviour pack's on-disk assets (features/,
// structures/, feature_rules/, biomes/) into the SourceFile slices
// featurelab-go/features, featurelab-go/structures, featurelab-go/rules and
// featurelab-go/biomes each build a library from.
//
// The walking logic (recurse a directory, derive a POSIX-style "id" from the
// path relative to the root, read every matching file) has one home here:
// cmd/featurelab (generate/serve/check all load a pack directory from disk,
// not a hand-built []SourceFile like most unit tests use) and goldentest both
// call it rather than keeping their own copies.
package pack

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/rules"
	"github.com/stirante/featurelab/structures"
)

// Options selects which directories to load. Dir is the pack root; each of
// FeaturesDir/StructuresDir/RulesDir/BiomesDir independently overrides the
// conventional Dir/<name> subdirectory (mirrors the CLI's own
// --pack/--features/--structures/--rules/--biomes flags) -- set one without
// Dir to load only that one kind, e.g. from an arbitrary directory that
// isn't shaped like a full pack.
type Options struct {
	Dir           string
	FeaturesDir   string
	StructuresDir string
	RulesDir      string
	BiomesDir     string
	// BlocksDir overrides the conventional Dir/blocks subdirectory --
	// <pack>/blocks/**/*.json declares each block's own real tags as
	// "tag:<name>": {} components (see block.Palette.LoadBlockTags). This is
	// the ONLY source of truth for a pack's own tags, including every
	// custom-namespaced one, so a caller that wants may_replace/
	// may_attach_to (and similar) tag predicates to resolve against real
	// data -- rather than only the small curated approximate vanilla table
	// -- must load this directory and call LoadBlockTags with it.
	BlocksDir string
}

// Pack is every asset kind Load knows how to read, plus a Warnings list for
// any directory that was expected to exist (because Dir or an explicit
// override named it) but didn't -- surfaced rather than silently treated as
// "zero files", which reads identically to "this pack really has none" and
// would hide a typo'd --pack path behind an empty, wordless result.
type Pack struct {
	Dir string

	// Dirs is where each of the lists below was actually read from -- see
	// Dirs's own doc comment for why a loaded Pack has to carry that and
	// not just Dir.
	Dirs Dirs

	Features   []features.SourceFile
	Structures []structures.SourceFile
	Rules      []rules.SourceFile
	Biomes     []biomes.SourceFile
	Blocks     []block.SourceFile

	Warnings []string

	// blocksOwnStart is the index in Blocks where this pack's OWN blocks/
	// files begin -- everything before it is the embedded vanilla
	// catalogue (block.DefaultBlocks), which Load always stacks
	// underneath. ReloadFile needs it because Blocks is the one list whose
	// order carries meaning beyond tidiness: LoadBlockTags lets the LAST
	// file declaring a block identifier win, so a pack file re-inserted at
	// its globally-sorted position could land in the MIDDLE of the vanilla
	// catalogue and silently lose to a vanilla entry it is supposed to
	// override. Splicing only within [blocksOwnStart:] keeps that
	// override relationship exactly as a full Load leaves it.
	blocksOwnStart int
}

// Dirs is the source directory Load actually resolved for each asset kind:
// an explicit Options override, or Dir/<conventional name>, or "" for a
// kind that wasn't requested at all. Recorded on the Pack rather than
// recomputed on demand because a caller holding a loaded Pack open (cmd/
// featurelab/serve.go's long-lived session, which reloads one saved file at
// a time) has to answer "which asset kind does this path belong to?", and
// re-deriving the three-way rule at that call site is exactly how the two
// copies drift apart the first time an override's default name changes.
type Dirs struct {
	Features   string
	Structures string
	Rules      string
	Biomes     string
	Blocks     string
}

// resolvedDir is one asset kind's resolved source directory: either an
// explicit override, or Dir/<defaultName> when Dir is set, or "" (not
// requested at all) when neither is given.
func resolvedDir(root, override, defaultName string) (dir string, explicit bool) {
	if strings.TrimSpace(override) != "" {
		return override, true
	}
	if strings.TrimSpace(root) != "" {
		return filepath.Join(root, defaultName), false
	}
	return "", false
}

// Load reads every directory Options names into the matching Pack field.
// A directory that doesn't exist on disk is not an error -- real packs
// legitimately omit feature_rules/ or biomes/ -- but it IS recorded in
// Warnings so a caller (check's diagnostics, generate's stderr) can tell
// "this pack has none of this kind" apart from "the path was wrong", which
// an empty slice alone cannot distinguish.
//
// Load itself returns an error only when nothing was requested at all
// (every field of opts empty) -- there is nothing to load, and proceeding
// would silently hand back an all-empty Pack with no explanation of why.
func Load(opts Options) (*Pack, error) {
	featuresDir, featuresExplicit := resolvedDir(opts.Dir, opts.FeaturesDir, "features")
	structuresDir, structuresExplicit := resolvedDir(opts.Dir, opts.StructuresDir, "structures")
	rulesDir, rulesExplicit := resolvedDir(opts.Dir, opts.RulesDir, "feature_rules")
	biomesDir, biomesExplicit := resolvedDir(opts.Dir, opts.BiomesDir, "biomes")
	blocksDir, blocksExplicit := resolvedDir(opts.Dir, opts.BlocksDir, "blocks")

	if featuresDir == "" && structuresDir == "" && rulesDir == "" && biomesDir == "" && blocksDir == "" {
		return nil, fmt.Errorf("pack: no directory to load -- pass Dir (a pack root) or at least one of " +
			"FeaturesDir/StructuresDir/RulesDir/BiomesDir/BlocksDir")
	}

	p := &Pack{Dir: opts.Dir, Dirs: Dirs{
		Features: featuresDir, Structures: structuresDir, Rules: rulesDir, Biomes: biomesDir, Blocks: blocksDir,
	}}

	if featuresDir != "" {
		files, existed, err := walkText(featuresDir, ".json")
		if err != nil {
			return nil, fmt.Errorf("pack: reading features directory %s: %w", featuresDir, err)
		}
		if !existed {
			p.Warnings = append(p.Warnings, warnMissing("features", featuresDir, featuresExplicit))
		}
		for _, f := range files {
			p.Features = append(p.Features, features.SourceFile{ID: f.id, AbsPath: f.absPath, Text: f.text})
		}
	}

	if structuresDir != "" {
		// Both extensions load into the SAME p.Structures slice, matching a real behaviour pack's
		// own structures/ directory (namespaced `.mcstructure` files plus, for a pack that ships
		// one -- like vanilla's own -- unnamespaced legacy `.nbt` files such as
		// structures/fossils/fossil_spine_01.nbt). structures.BuildLibrary tells the two formats
		// apart by extension and resolves each through its own interface (IResolver vs.
		// ILegacyResolver) -- see that function's own doc comment.
		files, existed, err := walkBinary(structuresDir, ".mcstructure", ".nbt")
		if err != nil {
			return nil, fmt.Errorf("pack: reading structures directory %s: %w", structuresDir, err)
		}
		if !existed {
			p.Warnings = append(p.Warnings, warnMissing("structures", structuresDir, structuresExplicit))
		}
		for _, f := range files {
			p.Structures = append(p.Structures, structures.SourceFile{ID: f.id, AbsPath: f.absPath, Data: f.data})
		}
	}

	if rulesDir != "" {
		files, existed, err := walkText(rulesDir, ".json")
		if err != nil {
			return nil, fmt.Errorf("pack: reading feature_rules directory %s: %w", rulesDir, err)
		}
		if !existed {
			p.Warnings = append(p.Warnings, warnMissing("feature_rules", rulesDir, rulesExplicit))
		}
		for _, f := range files {
			p.Rules = append(p.Rules, rules.SourceFile{ID: f.id, AbsPath: f.absPath, Text: f.text})
		}
	}

	if biomesDir != "" {
		files, existed, err := walkText(biomesDir, ".json")
		if err != nil {
			return nil, fmt.Errorf("pack: reading biomes directory %s: %w", biomesDir, err)
		}
		if !existed {
			p.Warnings = append(p.Warnings, warnMissing("biomes", biomesDir, biomesExplicit))
		}
		for _, f := range files {
			p.Biomes = append(p.Biomes, biomes.SourceFile{ID: f.id, AbsPath: f.absPath, Text: f.text})
		}
	}

	if blocksDir != "" {
		files, existed, err := walkText(blocksDir, ".json")
		if err != nil {
			return nil, fmt.Errorf("pack: reading blocks directory %s: %w", blocksDir, err)
		}
		if !existed {
			p.Warnings = append(p.Warnings, warnMissingBlocks(blocksDir, blocksExplicit))
		}
		// block.DefaultBlocks() -- the generated vanilla catalogue -- is
		// always loaded first, exactly like a default resource/behavior
		// pack sits below every user pack in the game's own pack stack.
		// It goes through the SAME []block.SourceFile shape and the SAME
		// downstream consumer (block.Palette.LoadBlockTags) as the pack's
		// own blocks/ directory below -- no parallel "vanilla" code path.
		// Ordering here is load-bearing: LoadBlockTags processes files in
		// slice order and the LAST file declaring a given block identifier
		// wins outright (replaces, not merges, that block's declared
		// tags -- see LoadBlockTags's doc comment), so appending the
		// vanilla catalogue before the pack's own files is what makes a
		// user-pack block with the same id override the vanilla entry,
		// matching how a higher-priority pack overrides a lower one in
		// game.
		p.Blocks = append(p.Blocks, block.DefaultBlocks()...)
		p.blocksOwnStart = len(p.Blocks)
		for _, f := range files {
			p.Blocks = append(p.Blocks, block.SourceFile{ID: f.id, AbsPath: f.absPath, Text: f.text})
		}
	}

	return p, nil
}

func warnMissing(kind, dir string, explicit bool) string {
	if explicit {
		return fmt.Sprintf("%s directory %q was given explicitly but does not exist -- 0 %s files loaded", dir, dir, kind)
	}
	return fmt.Sprintf("%s directory %q does not exist -- 0 %s files loaded (fine if this pack has none)", dir, dir, kind)
}

// warnMissingBlocks is warnMissing's "blocks" specialization: unlike every
// other kind, a missing blocks/ directory does NOT mean zero block files
// were loaded -- the generated vanilla default catalogue (block.
// DefaultBlocks) is loaded regardless, so the wording says so instead of
// claiming zero.
func warnMissingBlocks(dir string, explicit bool) string {
	if explicit {
		return fmt.Sprintf("blocks directory %q was given explicitly but does not exist -- 0 pack-specific block files loaded (the generated vanilla defaults are still loaded)", dir)
	}
	return fmt.Sprintf("blocks directory %q does not exist -- 0 pack-specific block files loaded (fine if this pack has none; the generated vanilla defaults are still loaded)", dir)
}

// ReloadFile re-reads exactly ONE file from disk into this Pack's source
// lists and leaves every other file exactly as it already is in memory.
// This is the edit-save-look path: a full Load of a large pack re-reads and
// re-parses thousands of files (measured ~680ms warm, ~1.05s cold on a
// pack with a few thousand features) to find the one file the user just saved, and all but
// that one read is wasted work between the save and the preview.
//
// The lists this leaves behind are exactly what a full Load would have
// produced for the same on-disk state -- same entries, same ids, same
// order -- which is the property that makes the fast path safe to mix with
// the slow one: a session.Workspace fingerprinting these lists reaches the
// same conclusion either way, so nothing rebuilds that a full reload
// wouldn't have rebuilt, and nothing is skipped that it would have.
//
// The four cases, each decided rather than fallen into:
//
//   - already in the list -> replaced in place, keeping the ENTRY's own id
//     and path (not the caller's spelling of them, which may differ in
//     case on Windows) so the list stays exactly what a full Load's would
//     have been
//   - not in the list -> inserted at its sorted-by-id position, the same
//     position walkText's own sort would have given it
//   - gone from disk (deleted, or renamed away -- a rename surfaces as a
//     save of the NEW path and nothing at all for the old one) -> dropped
//     from the list, because a stale entry here would keep placing a
//     feature the pack no longer defines
//   - under no directory this Pack was loaded from, or carrying an
//     extension that directory's walk never reads -> an error, meaning
//     "this method cannot answer for that path, reload the whole pack".
//     The extension case errors rather than reporting a no-op success even
//     though it provably changes nothing: the contract worth having is the
//     narrow one -- this handles exactly the files Load itself would have
//     read, everything else takes the slow road -- because a caller that
//     wrongly trusts a no-op shows a stale preview, while a caller that
//     falls back needlessly only pays one full reload.
//
// A read error that is NOT "file does not exist" (a permission error, an
// editor still holding the file open) comes back as-is rather than being
// treated as a deletion -- dropping a file would silently change what the
// pack generates on the strength of a transient failure.
func (p *Pack) ReloadFile(absPath string) error {
	if strings.TrimSpace(absPath) == "" {
		return fmt.Errorf("pack: ReloadFile needs a file path")
	}
	clean := filepath.Clean(absPath)

	// Read at most once, and only if some kind actually claims the path --
	// the overlapping-directories case below (one kind's directory nested
	// inside another's) is the only reason this isn't a plain local.
	var (
		data    []byte
		exists  bool
		readErr error
		didRead bool
	)
	read := func() ([]byte, bool, error) {
		if !didRead {
			data, exists, readErr = readIfExists(clean)
			didRead = true
		}
		return data, exists, readErr
	}

	// Every kind whose directory contains the path gets the file spliced
	// in, not just the first one to match. Overlapping directories are
	// only reachable through deliberately odd Options (BlocksDir pointed at
	// the pack root, say), but when they DO overlap a full Load walks the
	// file into both lists -- so splicing it into both is what keeps this
	// method's "the same lists a full Load would produce" promise true
	// even there.
	matched := false

	if rel, ok := relWithin(p.Dirs.Features, clean); ok && hasExt(rel, ".json") {
		matched = true
		text, present, err := read()
		if err != nil {
			return err
		}
		p.Features = spliceSorted(p.Features, 0, toID(rel), clean, present,
			func(f features.SourceFile) (string, string) { return f.ID, f.AbsPath },
			func(id, abs string) features.SourceFile {
				return features.SourceFile{ID: id, AbsPath: abs, Text: string(text)}
			})
	}

	if rel, ok := relWithin(p.Dirs.Structures, clean); ok && (hasExt(rel, ".mcstructure") || hasExt(rel, ".nbt")) {
		matched = true
		raw, present, err := read()
		if err != nil {
			return err
		}
		p.Structures = spliceSorted(p.Structures, 0, toID(rel), clean, present,
			func(f structures.SourceFile) (string, string) { return f.ID, f.AbsPath },
			func(id, abs string) structures.SourceFile {
				return structures.SourceFile{ID: id, AbsPath: abs, Data: raw}
			})
	}

	if rel, ok := relWithin(p.Dirs.Rules, clean); ok && hasExt(rel, ".json") {
		matched = true
		text, present, err := read()
		if err != nil {
			return err
		}
		p.Rules = spliceSorted(p.Rules, 0, toID(rel), clean, present,
			func(f rules.SourceFile) (string, string) { return f.ID, f.AbsPath },
			func(id, abs string) rules.SourceFile {
				return rules.SourceFile{ID: id, AbsPath: abs, Text: string(text)}
			})
	}

	if rel, ok := relWithin(p.Dirs.Biomes, clean); ok && hasExt(rel, ".json") {
		matched = true
		text, present, err := read()
		if err != nil {
			return err
		}
		p.Biomes = spliceSorted(p.Biomes, 0, toID(rel), clean, present,
			func(f biomes.SourceFile) (string, string) { return f.ID, f.AbsPath },
			func(id, abs string) biomes.SourceFile {
				return biomes.SourceFile{ID: id, AbsPath: abs, Text: string(text)}
			})
	}

	if rel, ok := relWithin(p.Dirs.Blocks, clean); ok && hasExt(rel, ".json") {
		matched = true
		text, present, err := read()
		if err != nil {
			return err
		}
		// blocksOwnStart, not 0 -- see its own doc comment: the vanilla
		// catalogue sits below this pack's own files and must stay there.
		p.Blocks = spliceSorted(p.Blocks, p.blocksOwnStart, toID(rel), clean, present,
			func(f block.SourceFile) (string, string) { return f.ID, f.AbsPath },
			func(id, abs string) block.SourceFile {
				return block.SourceFile{ID: id, AbsPath: abs, Text: string(text)}
			})
	}

	if !matched {
		return fmt.Errorf("pack: %s is not a file this pack was loaded from -- reload the whole pack instead", clean)
	}
	return nil
}

// spliceSorted replaces, inserts, or removes one entry in a sorted-by-id
// source list and returns the new list. start is the first index it may
// touch (see Pack.blocksOwnStart for the one list where that isn't 0);
// present is whether the file still exists on disk; keys reports an
// entry's (id, absPath); build makes the entry to store from the id and
// path the list should record for it.
//
// It never writes through the list it was given, always copying instead:
// that slice is, by this point, the one a session.Workspace is still
// holding as "the files I last built from", and mutating an element in
// place would edit that snapshot underneath it -- exactly the aliasing
// that stops a cache being able to tell what it has already seen. The copy
// is a few hundred KB of slice headers on a real pack, thousands of times
// cheaper than the file reads this whole path exists to avoid.
func spliceSorted[T any](list []T, start int, id, absPath string, present bool,
	keys func(T) (string, string), build func(id, abs string) T) []T {
	for i := start; i < len(list); i++ {
		existingID, existingPath := keys(list[i])
		if !samePath(existingPath, absPath) {
			continue
		}
		if !present {
			out := make([]T, 0, len(list)-1)
			out = append(out, list[:i]...)
			return append(out, list[i+1:]...)
		}
		out := make([]T, len(list))
		copy(out, list)
		out[i] = build(existingID, existingPath)
		return out
	}
	if !present {
		// Gone from disk and not in the list either: whatever the caller
		// saw, this pack never had it. Nothing to do, and NOT an error --
		// a file deleted twice, or saved and then removed again before the
		// reload arrived, is no reason to send the caller down the slow
		// path.
		return list
	}
	pos := start
	for pos < len(list) {
		entryID, _ := keys(list[pos])
		if entryID >= id {
			break
		}
		pos++
	}
	out := make([]T, 0, len(list)+1)
	out = append(out, list[:pos]...)
	out = append(out, build(id, absPath))
	return append(out, list[pos:]...)
}

// relWithin reports where file sits relative to dir, and whether it is
// inside dir at all. dir == "" (a kind this pack never loaded) contains
// nothing.
func relWithin(dir, file string) (string, bool) {
	if dir == "" {
		return "", false
	}
	rel, err := filepath.Rel(dir, file)
	if err != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) ||
		strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

// SamePath reports whether two paths name the same file. Deliberately not
// `a == b`: the paths a Pack recorded came from walking directories on
// disk, while the path a caller hands ReloadFile came from an editor's own
// notion of the document that was saved, and on Windows those two
// routinely differ in case (`C:\` vs `c:\` above all) while naming the
// same file. filepath.Rel already compares path elements the way the host
// filesystem does -- folding case on Windows, exact elsewhere -- so "the
// same file" is exactly "the path from one to the other is `.`", with no
// build-tagged second implementation to keep in step.
func SamePath(a, b string) bool {
	if a == b {
		return true
	}
	rel, err := filepath.Rel(a, b)
	return err == nil && rel == "."
}

// samePath is SamePath spelled the way this package's own unexported
// helpers are -- see SamePath for the rule it implements.
func samePath(a, b string) bool { return SamePath(a, b) }

// hasExt matches walkText/walkBinary's own extension test exactly (lower-
// cased suffix, not filepath.Ext) so ReloadFile accepts a file if and only
// if a full Load of the same directory would have read it.
func hasExt(name, ext string) bool { return strings.HasSuffix(strings.ToLower(name), ext) }

// toID converts a path relative to a kind's directory into the POSIX-style
// id every SourceFile.ID uses -- see walkText's doc comment for the
// convention this has to match.
func toID(rel string) string { return filepath.ToSlash(rel) }

// readIfExists reads path, reporting a missing file as (nil, false, nil)
// rather than an error -- ReloadFile's "the file was deleted" case is the
// normal outcome of a rename or a delete, not a failure.
func readIfExists(path string) (data []byte, exists bool, err error) {
	data, err = os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return data, true, nil
}

// textFile/binaryFile are the walk's intermediate shape, before being
// wrapped into whichever package's own SourceFile type.
type textFile struct{ id, absPath, text string }
type binaryFile struct {
	id, absPath string
	data        []byte
}

// walkText recurses dir, collecting every file whose lowercased name ends
// in ext as a textFile. id is the path relative to dir with POSIX ('/')
// separators, matching every existing SourceFile.ID convention exactly
// (features.SourceFile/structures.SourceFile/rules.SourceFile/
// biomes.SourceFile all key off this same "relative path, forward slashes"
// shape). existed=false (with a nil error) means dir itself doesn't exist --
// distinct from an error reading something that DOES exist.
func walkText(dir, ext string) (out []textFile, existed bool, err error) {
	if _, statErr := os.Stat(dir); statErr != nil {
		if os.IsNotExist(statErr) {
			return nil, false, nil
		}
		return nil, false, statErr
	}
	var walk func(d, prefix string) error
	walk = func(d, prefix string) error {
		entries, err := os.ReadDir(d)
		if err != nil {
			return fmt.Errorf("reading %s: %w", d, err)
		}
		for _, e := range entries {
			abs := filepath.Join(d, e.Name())
			id := e.Name()
			if prefix != "" {
				id = prefix + "/" + e.Name()
			}
			if e.IsDir() {
				if err := walk(abs, id); err != nil {
					return err
				}
				continue
			}
			if !strings.HasSuffix(strings.ToLower(e.Name()), ext) {
				continue
			}
			text, err := os.ReadFile(abs)
			if err != nil {
				return fmt.Errorf("reading %s: %w", abs, err)
			}
			out = append(out, textFile{id: id, absPath: abs, text: string(text)})
		}
		return nil
	}
	if err := walk(dir, ""); err != nil {
		return nil, true, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out, true, nil
}

// walkBinary is walkText's counterpart for binary asset kinds (`.mcstructure`, and -- as of the
// fossil_feature port -- legacy `.nbt`) -- see walkText's doc comment for the shared shape/id
// convention. exts is variadic (unlike walkText's single ext) because the structures/ directory is
// the one place this tool loads two genuinely different binary formats out of the same directory
// tree side by side (see the structuresDir call site in Load).
func walkBinary(dir string, exts ...string) (out []binaryFile, existed bool, err error) {
	if _, statErr := os.Stat(dir); statErr != nil {
		if os.IsNotExist(statErr) {
			return nil, false, nil
		}
		return nil, false, statErr
	}
	matchesExt := func(name string) bool {
		lower := strings.ToLower(name)
		for _, ext := range exts {
			if strings.HasSuffix(lower, ext) {
				return true
			}
		}
		return false
	}
	var walk func(d, prefix string) error
	walk = func(d, prefix string) error {
		entries, err := os.ReadDir(d)
		if err != nil {
			return fmt.Errorf("reading %s: %w", d, err)
		}
		for _, e := range entries {
			abs := filepath.Join(d, e.Name())
			id := e.Name()
			if prefix != "" {
				id = prefix + "/" + e.Name()
			}
			if e.IsDir() {
				if err := walk(abs, id); err != nil {
					return err
				}
				continue
			}
			if !matchesExt(e.Name()) {
				continue
			}
			data, err := os.ReadFile(abs)
			if err != nil {
				return fmt.Errorf("reading %s: %w", abs, err)
			}
			out = append(out, binaryFile{id: id, absPath: abs, data: data})
		}
		return nil
	}
	if err := walk(dir, ""); err != nil {
		return nil, true, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out, true, nil
}
