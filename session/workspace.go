// workspace.go separates "build the feature/structure/rule libraries from
// source files" out of "run one placement" -- the performance fix this
// file exists for. Generate (session.go) rebuilds every library from
// scratch on every call: measured on a large, structure-heavy add-on, ~94% of a
// call's time is re-parsing .mcstructure files that did not change since
// the last call. Workspace holds the built libraries (and the palette they
// were interned against) across many Generate calls, so only source files
// that actually changed since the last Update get rebuilt.
package session

import (
	"context"
	"hash/fnv"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/rules"
	"github.com/stirante/featurelab/structures"
)

// Workspace owns the built feature/structure/rule libraries and the shared
// block.Palette for one loaded pack, so repeated Generate calls reuse them
// instead of re-parsing every source file on every call. Not safe for
// concurrent use -- cmd/featurelab/serve.go's runServe, the intended
// caller, dispatches every request on ONE worker goroutine, never two at
// once, so a mutex would only cost cycles no caller needs. (That server
// reads its input on a second goroutine, so a "cancel" can arrive while a
// generate runs; the reader never touches a Workspace.)
//
// # Correctness contract
//
// The palette is shared, mutable state that every cached library's
// block.IDs were interned against. It is created once (NewWorkspace) and
// NEVER replaced for the life of a Workspace: block.Palette's interning is
// idempotent and append-only (same name+states always returns the same
// id; ids are never reassigned or removed), so a library that gets
// rebuilt because ITS OWN source files changed re-interns into the SAME
// palette a still-cached sibling library depends on, and every id either
// side ever handed out stays valid. A fresh palette per Workspace (rather
// than per Generate call, which is what session.Generate itself still
// effectively does, once per one-shot call) is what makes reuse safe
// instead of leaking a stale id from one palette generation into a
// library built against a different one.
//
// # Per-kind invalidation
//
// Update recomputes a content fingerprint per kind (feature/structure/
// rule) and only rebuilds a kind whose fingerprint changed -- editing one
// feature file must never force a 780ms structures re-parse just to pick
// up that edit, and structures/rules changing must never require the
// caller to somehow know to also resend feature files.
//
// The one coupling that can't be relaxed: a structure change ALSO forces
// the feature library to rebuild, even when no feature file itself
// changed. minecraft:structure_template_feature resolves structure_name to
// a concrete *structures.ResolvedStructure at BUILD time (features/
// structure_template.go's buildStructureTemplateFeature captures that
// pointer directly into the built feature) rather than through a lazy
// resolver call at place-time the way every other cross-reference in this
// codebase works. A feature library built against the OLD structure
// library would keep placing the old structure's blocks forever after a
// structure file changes -- exactly the stale-preview bug this whole
// design is trying to avoid, just for structures instead of features. Since
// structures change far less often than features (the whole reason this
// file exists), paying an extra feature-library rebuild on the rare
// structure edit is the right trade.
//
// Rules have no such coupling: a FeatureRule's places_feature is a plain
// string, resolved against whichever features.Library the CALLER passes to
// rules.PlaceFeatureRule at place-time (see generate's ModeRule branch and
// rules.go's own doc comment), so a rule library never needs rebuilding
// just because features changed, and vice versa.
//
// Biomes have no coupling either, for the same reason as rules: a resolved
// biome is looked up by generate (session.go) at place-time via
// Config.EnvironmentBiomeID against whichever biomes.Library the caller
// (Workspace.Generate, below) hands it -- nothing captures a *biomes.
// ResolvedBiome pointer into a built feature/structure the way
// structure_template_feature captures a *structures.ResolvedStructure -- so
// editing a biome file never forces a feature/structure/rule rebuild, and
// vice versa.
type Workspace struct {
	palette *block.Palette

	featureFiles   []features.SourceFile
	structureFiles []structures.SourceFile
	ruleFiles      []rules.SourceFile
	biomeFiles     []biomes.SourceFile
	blockFiles     []block.SourceFile

	featureFingerprint   string
	structureFingerprint string
	ruleFingerprint      string
	biomeFingerprint     string
	blockFingerprint     string

	featureLib   *features.Library
	structureLib *structures.Library
	ruleLib      *rules.FeatureRuleLibrary
	biomeLib     *biomes.Library

	// blockDiagnostics is LoadBlockTags's own per-file report (malformed
	// JSON, a block file missing description.identifier) -- kept, not
	// discarded, so a caller wanting pack-load diagnostics (mirroring
	// featureLib.Diagnostics/structureLib.Diagnostics/ruleLib.Diagnostics/
	// biomeLib.Diagnostics) can reach it via BlockDiagnostics.
	blockDiagnostics []block.Diagnostic

	// pathsCache/pathsDir/pathsBuilt memoise the per-kind "SourceFile id ->
	// pack-relative path" index a generate's diagnostics are respelled
	// through -- see packpaths.go. Keyed by pack root, and dropped by Update
	// because the file lists it is built from are exactly what Update
	// replaces.
	pathsCache packPaths
	pathsDir   string
	pathsBuilt bool
}

// BlockDiagnostics returns the diagnostics from this Workspace's most
// recent blocks/**/*.json load (see LoadBlockTags) -- e.g. a file that
// could not be attributed to a block. This is separate from a tag a
// feature predicate could not resolve at all (see
// features.ResolveMatchSet), which surfaces through featureLib.Diagnostics
// like every other feature-build diagnostic instead.
func (w *Workspace) BlockDiagnostics() []block.Diagnostic { return w.blockDiagnostics }

// LoadCounts is what a pack actually loaded, per asset kind, with the two
// numbers that used to be conflated kept apart: Files is how many source
// files of that kind were read off disk, Loaded is how many of them the
// library could actually make an entry out of.
//
// They differ by exactly the files that could not be parsed. Reporting only
// Files (which is what "featureCount" used to be) means a pack with a
// truncated feature file reports the same count as the same pack with that
// file intact -- the number goes on looking healthy while the feature is
// gone. Reporting only Loaded loses the fact that there is a file there at
// all. Both, side by side, is the only pair that cannot mislead.
type LoadCounts struct {
	Files  int `json:"files"`
	Loaded int `json:"loaded"`
}

// PackCounts is LoadCounts for every asset kind this Workspace holds. Same
// shape for all four so a client has one rule to follow rather than four,
// and Files >= Loaded always: a kind whose two numbers differ has that many
// files it could not read, each of which has a diagnostic of its own in
// PackDiagnostics naming it.
type PackCounts struct {
	Features   LoadCounts `json:"features"`
	Structures LoadCounts `json:"structures"`
	Rules      LoadCounts `json:"rules"`
	Biomes     LoadCounts `json:"biomes"`
}

// Counts reports what the currently-built libraries actually contain -- see
// LoadCounts for why every kind carries two numbers rather than one.
func (w *Workspace) Counts() PackCounts {
	var c PackCounts
	if w.featureLib != nil {
		c.Features = LoadCounts{Files: len(w.featureLib.Entries) + len(w.featureLib.Failed), Loaded: len(w.featureLib.Entries)}
	}
	if w.structureLib != nil {
		c.Structures = LoadCounts{Files: len(w.structureFiles), Loaded: w.structureLib.Loaded}
	}
	if w.ruleLib != nil {
		c.Rules = LoadCounts{Files: len(w.ruleLib.Entries) + len(w.ruleLib.Failed), Loaded: len(w.ruleLib.Entries)}
	}
	if w.biomeLib != nil {
		c.Biomes = LoadCounts{Files: len(w.biomeFiles), Loaded: len(w.biomeLib.Entries)}
	}
	return c
}

// PackDiagnostics is every ScopePack diagnostic the currently-built
// libraries hold: what is wrong with the pack ON DISK, available without
// running a placement.
//
// This is what closes the silent-broken-file hole at the `loadPack` level.
// Every one of these diagnostics has existed all along and was produced
// during this Workspace's own library builds -- but the only way to see one
// was to run a `generate`, which then mixed them in with that run's own
// diagnostics. A pack with a file that does not parse could therefore be
// loaded, reported on, and counted, with nothing anywhere saying a file had
// been dropped.
//
// The list matches -- same order, same contents -- the ScopePack half of
// what a Generate against this Workspace returns, because both are built
// from the same libraries by the same converters.
func (w *Workspace) PackDiagnostics() []Diagnostic {
	byKind := w.PackDiagnosticsByKind()
	var out []Diagnostic
	out = append(out, byKind.Blocks...)
	out = append(out, byKind.Structures...)
	out = append(out, byKind.Features...)
	out = append(out, byKind.Rules...)
	out = append(out, byKind.Biomes...)
	return out
}

// PackDiagnosticsByKind is PackDiagnostics split by which asset kind raised
// each diagnostic, for the one caller that needs to know: a Diagnostic's
// FileID is a SourceFile id, and a SourceFile id is unique only WITHIN its
// kind (the loader derives it relative to that kind's own directory), so a
// pack holding both features/thing.json and feature_rules/thing.json has two
// files whose id is "thing.json". Anything turning these ids back into
// openable paths has to know which directory each came from, and this is
// where that is known -- recovering it from the id afterwards cannot be
// done, and guessing is right often enough that the bug would survive.
type PackDiagnosticKinds struct {
	Blocks     []Diagnostic
	Structures []Diagnostic
	Features   []Diagnostic
	Rules      []Diagnostic
	Biomes     []Diagnostic
}

// PackDiagnosticsByKind returns this Workspace's pack-scoped diagnostics
// grouped by asset kind -- see PackDiagnosticKinds for why the grouping
// exists at all.
func (w *Workspace) PackDiagnosticsByKind() PackDiagnosticKinds {
	// Every fileId here is the loader's own kind-relative SourceFile id, NOT
	// the pack-relative path a generate's diagnostics now carry -- the caller
	// is asking for these BY KIND precisely so it can respell them itself, and
	// respelling them here as well would leave it doing it twice.
	var out PackDiagnosticKinds
	out.Blocks = convertBlockDiagnostics(w.blockDiagnostics, keepFileID)
	if w.structureLib != nil {
		out.Structures = convertStructureDiagnostics(w.structureLib.Diagnostics, keepFileID)
	}
	if w.featureLib != nil {
		out.Features = convertFeatureDiagnostics(w.featureLib.Diagnostics, keepFileID)
	}
	if w.ruleLib != nil {
		out.Rules = convertFeatureDiagnostics(w.ruleLib.Diagnostics, keepFileID)
	}
	if w.biomeLib != nil {
		out.Biomes = convertBiomeDiagnostics(w.biomeLib.Diagnostics, keepFileID)
	}
	return out
}

// keepFileID is the converters' "respell nothing" spelling function.
func keepFileID(fileID string) string { return fileID }

// NewWorkspace builds every library fresh, against a new palette -- the
// expensive path (re-parsing every .mcstructure/.json file), paid once
// here. Use Update afterward to react to changed source files without
// paying that full cost again for kinds that didn't change.
func NewWorkspace(featureFiles []features.SourceFile, structureFiles []structures.SourceFile, ruleFiles []rules.SourceFile, biomeFiles []biomes.SourceFile, blockFiles []block.SourceFile) *Workspace {
	w := &Workspace{palette: block.NewPalette()}
	w.Update(featureFiles, structureFiles, ruleFiles, biomeFiles, blockFiles)
	return w
}

// Update replaces this Workspace's source files, rebuilding only the
// libraries whose kind actually changed by content (not just by slice
// identity: cmd/featurelab/serve.go's loadPack re-reads every file off
// disk on every call, so it hands Update a brand-new []SourceFile of
// brand-new strings/[]bytes even when nothing on disk actually changed --
// fingerprinting content, not comparing slices, is what makes an
// unrelated loadPack call cheap instead of a full rebuild every time).
//
// Slice identity is still worth one thing, though, and reuseFingerprint
// (below) takes it: a kind handed back as the very same slice it was last
// given cannot have changed content, so its fingerprint is not recomputed
// at all. That is the difference between a single-file reload costing the
// rebuild it actually needs and it costing that plus a re-hash of every
// structure binary in the pack -- see reuseFingerprint's own comment, and
// the obligation it puts on callers not to mutate a slice they have
// already handed over.
//
// See Workspace's own doc comment for why a structure change also forces
// the feature library to rebuild -- a blocks/ change forces the same
// rebuild, for an analogous reason: a {"tags": ...} predicate compiled
// into a built feature reads the shared palette's tag index LIVE at
// place-time (block.MatchSet.Contains), so the placement behavior itself
// updates automatically without a rebuild -- but the "tag could not be
// resolved" build diagnostics (features.ResolveMatchSet's ctx.Warn calls)
// were captured at BUILD time against whatever blocks/ content existed
// then, and would go stale (naming a tag as unresolved that a later blocks/
// edit actually did define, or vice versa) without also rebuilding here.
func (w *Workspace) Update(featureFiles []features.SourceFile, structureFiles []structures.SourceFile, ruleFiles []rules.SourceFile, biomeFiles []biomes.SourceFile, blockFiles []block.SourceFile) {
	newStructureFP := reuseFingerprint(structureFiles, w.structureFiles, w.structureFingerprint, fingerprintStructureFiles)
	newFeatureFP := reuseFingerprint(featureFiles, w.featureFiles, w.featureFingerprint, fingerprintFeatureFiles)
	newRuleFP := reuseFingerprint(ruleFiles, w.ruleFiles, w.ruleFingerprint, fingerprintRuleFiles)
	newBiomeFP := reuseFingerprint(biomeFiles, w.biomeFiles, w.biomeFingerprint, fingerprintBiomeFiles)
	newBlockFP := reuseFingerprint(blockFiles, w.blockFiles, w.blockFingerprint, fingerprintBlockFiles)

	structuresChanged := newStructureFP != w.structureFingerprint
	featuresChanged := newFeatureFP != w.featureFingerprint
	rulesChanged := newRuleFP != w.ruleFingerprint
	biomesChanged := newBiomeFP != w.biomeFingerprint
	blocksChanged := newBlockFP != w.blockFingerprint

	w.structureFiles = structureFiles
	w.featureFiles = featureFiles
	w.ruleFiles = ruleFiles
	w.biomeFiles = biomeFiles
	w.blockFiles = blockFiles
	// The file lists the path index is built from have just been replaced, so
	// whatever it holds is about the previous ones -- see pathsFor.
	w.pathsBuilt = false

	if blocksChanged {
		// LoadBlockTags fully replaces the palette's tag index each call
		// (never accumulates stale entries from a previous, now-removed
		// blocks/ file) -- see its own doc comment.
		w.blockDiagnostics = w.palette.LoadBlockTags(blockFiles)
		w.blockFingerprint = newBlockFP
	}
	if structuresChanged {
		w.structureLib = structures.BuildLibrary(structureFiles, w.palette)
		w.structureFingerprint = newStructureFP
	}
	// structuresChanged/blocksChanged (not just featuresChanged) deliberately also
	// gate this rebuild -- see this method's own doc comment and Workspace's "one
	// coupling that can't be relaxed".
	if structuresChanged || featuresChanged || blocksChanged {
		w.featureLib = features.BuildLibrary(featureFiles, w.palette, w.structureLib)
		w.featureFingerprint = newFeatureFP
	}
	if rulesChanged {
		w.ruleLib = rules.BuildFeatureRuleLibrary(ruleFiles)
		w.ruleFingerprint = newRuleFP
	}
	// biomes.BuildLibrary doesn't intern anything into w.palette (biomes.
	// MaterialSlots holds plain block-name strings -- see that type's doc
	// comment -- interning happens later, per Generate call, in session.
	// go's generate), so unlike structures/features it never needs to run
	// just because some OTHER kind changed; independent invalidation, same
	// as rules.
	if biomesChanged {
		w.biomeLib = biomes.BuildLibrary(biomeFiles)
		w.biomeFingerprint = newBiomeFP
	}
}

// Generate runs one placement against this Workspace's currently-built
// libraries -- see package-level Generate's doc comment for what a run
// actually does; this differs only in reusing already-built libraries (and
// the palette they were interned against) instead of rebuilding them from
// source files on every call.
func (w *Workspace) Generate(config Config) (*Result, error) {
	// No profiling-only special case here any more: every concrete feature type's own Place
	// method now pushes/pops its own profiler frame unconditionally (features/*.go, see
	// profiler.go's "Always-on delegation chain" doc comment), so there is no per-library "arm"
	// step left to worry about re-running on a cached, reused w.featureLib -- w.featureLib itself
	// never needs to be mutated or rebuilt just because config.Profiling is true. A profiled
	// "generate" call through a long-lived Workspace (the "serve" reuse path) now costs exactly
	// what a non-profiled one does, rather than paying a throwaway feature-library rebuild.
	return w.GenerateContext(context.Background(), config)
}

// GenerateContext is Generate with a cancellation signal -- cancelling ctx abandons the
// placement and returns ctx.Err() rather than a partial Result. See GenerateContext (session.go)
// for why no partial result comes back.
//
// It covers the PLACEMENT only, never a library build. On this method there is nothing to cover:
// the libraries are already built and this call reuses them. On the package-level
// GenerateContext, which builds a throwaway Workspace first, that build is genuinely
// uncancellable -- and is left so deliberately, because a half-built library is not a state any
// caller can be handed, and the one-shot path it belongs to has no long-lived process to keep
// responsive anyway.
func (w *Workspace) GenerateContext(ctx context.Context, config Config) (*Result, error) {
	result, err := generate(ctx, config, w.palette, w.featureLib, w.structureLib, w.ruleLib, w.biomeLib, w.pathsFor(config.PackDir))
	if err != nil {
		return nil, err
	}
	// LibraryBuildDurationMs stays at its zero value here -- this call reused w's already-built
	// libraries, so TotalDurationMs collapses to exactly PlacementDurationMs. See Result.
	// LibraryBuildDurationMs's doc comment: package-level Generate (the one-shot path) is the only
	// caller that overwrites it with a real cost, after this method returns.
	result.TotalDurationMs = result.LibraryBuildDurationMs + result.PlacementDurationMs
	return result, nil
}

// reuseFingerprint answers "what is this kind's content fingerprint now?"
// without re-hashing files the caller demonstrably did not touch: when the
// slice handed in is LITERALLY the one the stored fingerprint was computed
// from -- same backing array, same length -- the stored fingerprint is
// still the answer.
//
// This is not a micro-optimisation; it is what makes a single-file reload
// cheap. cmd/featurelab/serve.go's "reloadFile" re-reads one saved file and
// passes every other kind straight back in, unchanged and untouched, so
// without this Update would re-hash every feature file and every structure
// file of a large add-on (tens of MB, most of it structures it did not even look at) on every keystroke's
// worth of save -- measured at ~67ms, which was the entire remaining cost
// of an incremental reload once the disk walk was gone.
//
// The correctness condition is the caller's, and it is a real obligation:
// a slice previously handed to Update must never be mutated in place. Both
// callers honour it -- pack.Load builds fresh lists per load, and pack.
// Pack.ReloadFile copies before splicing precisely so that a changed kind
// arrives as a DIFFERENT slice (see spliceSorted's own comment) -- so
// "same slice" really does mean "same bytes" here. Slices of length zero
// are deliberately excluded: they have no address to compare, and hashing
// nothing costs nothing.
func reuseFingerprint[T any](files, previous []T, previousFP string, hash func([]T) string) string {
	if len(files) > 0 && len(files) == len(previous) && &files[0] == &previous[0] {
		return previousFP
	}
	return hash(files)
}

// fingerprintFeatureFiles/fingerprintStructureFiles/fingerprintRuleFiles
// hash each SourceFile's (id, content) in slice order with FNV-1a 128 --
// not cryptographic, not needed to be: this is a change-detection cache
// key over trusted local files, not a security boundary, and a 128-bit
// hash makes an accidental collision (silently serving a stale library)
// astronomically unlikely. The 0x00 separators between and after each
// field keep e.g. ("ab","c") distinguishable from ("a","bc").
func fingerprintFeatureFiles(files []features.SourceFile) string {
	h := fnv.New128a()
	for _, f := range files {
		h.Write([]byte(f.ID))
		h.Write([]byte{0})
		h.Write([]byte(f.Text))
		h.Write([]byte{0})
	}
	return string(h.Sum(nil))
}

func fingerprintStructureFiles(files []structures.SourceFile) string {
	h := fnv.New128a()
	for _, f := range files {
		h.Write([]byte(f.ID))
		h.Write([]byte{0})
		h.Write(f.Data)
		h.Write([]byte{0})
	}
	return string(h.Sum(nil))
}

func fingerprintRuleFiles(files []rules.SourceFile) string {
	h := fnv.New128a()
	for _, f := range files {
		h.Write([]byte(f.ID))
		h.Write([]byte{0})
		h.Write([]byte(f.Text))
		h.Write([]byte{0})
	}
	return string(h.Sum(nil))
}

func fingerprintBiomeFiles(files []biomes.SourceFile) string {
	h := fnv.New128a()
	for _, f := range files {
		h.Write([]byte(f.ID))
		h.Write([]byte{0})
		h.Write([]byte(f.Text))
		h.Write([]byte{0})
	}
	return string(h.Sum(nil))
}

func fingerprintBlockFiles(files []block.SourceFile) string {
	h := fnv.New128a()
	for _, f := range files {
		h.Write([]byte(f.ID))
		h.Write([]byte{0})
		h.Write([]byte(f.Text))
		h.Write([]byte{0})
	}
	return string(h.Sum(nil))
}
