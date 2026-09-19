package main

import (
	"context"
	"fmt"
	"io"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/rules"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wire"
)

// checkPack loads every asset kind's library from an already-loaded pack
// and returns every diagnostic raised -- pack.Load's own directory-missing
// warnings, plus each library's build diagnostics -- normalized into one
// flat list. This is deliberately NOT session.Generate: check's job is
// "does the pack load cleanly", independent of picking any one
// feature/rule to place, so it never runs placement at all.
func checkPack(loaded *pack.Pack) []Diagnostic {
	out, _ := checkPackContext(context.Background(), loaded)
	return out
}

// LevelInfo/LevelWarning/LevelError are the three levels a Diagnostic carries.
//
// "info" is not decoration and it is not a quieter warning: it is the level
// for something that is TRUE, worth being able to see, and not a defect. The
// four "directory does not exist -- 0 files loaded (fine if this pack has
// none)" notices every minimal pack raises are the whole reason it exists
// here. They were warnings, so a pack with exactly one real problem showed
// five rows, four of which said the pack was fine as it is -- and a channel
// that is noisy on every pack ever opened is a channel people stop reading.
// The graph panel already dropped them by matching their prose; making each
// client do that, with its own copy of a sentence this engine is free to
// reword, is the bug rather than the fix.
const (
	LevelInfo    = "info"
	LevelWarning = "warning"
	LevelError   = "error"
)

// checkPackContext is checkPack with a cancellation signal, and returns ok=false when the ctx
// was cancelled before it finished -- in which case the diagnostics returned are a PREFIX of the
// real set and must not be shown to anybody.
//
// PER LIBRARY. Each of the five builds below is a single call that walks one whole asset kind,
// and none of them takes a context; the honest granularity without rewriting five packages is
// between them. That is enough in practice because the cost is dominated by exactly one of them
// (structures, re-parsing .mcstructure binaries), so the worst case is one structure library
// build -- the same unit of work a `loadPack` pays and does not offer to cancel either.
func checkPackContext(ctx context.Context, loaded *pack.Pack) ([]Diagnostic, bool) {
	return checkPackGraphContext(ctx, loaded, nil)
}

// checkPackGraphContext is checkPackContext for a caller that has ALREADY built
// the pack's graph -- serve's "graph" method and the `graph` subcommand, which
// build one and then ask for these diagnostics to hang on it.
//
// The parameter exists because of the dangling-delegation check below: that
// check needs a graph, a graph costs a re-parse of every source file in the
// pack, and a graph request that built one and then made this function build a
// second identical one would have doubled the cost of the slowest request this
// engine serves. Pass nil and one is built here; pass the one you have and
// nothing is rebuilt. Either way the diagnostics are the same, because they are
// the same function reading the same graph.
func checkPackGraphContext(ctx context.Context, loaded *pack.Pack, graph *wire.Graph) ([]Diagnostic, bool) {
	var out []Diagnostic
	for _, w := range loaded.Warnings {
		out = append(out, Diagnostic{Level: packWarningLevel(loaded, w), FileID: packDiagnosticFileID, Scope: session.ScopePack, Message: w})
	}

	// One path index PER ASSET KIND, and never one shared index, because a
	// SourceFile ID is unique only WITHIN its kind: the loader derives it
	// relative to the kind's own directory, so a pack that holds both
	// features/thing.json and feature_rules/thing.json has two files whose id
	// is "thing.json". A single map keyed by id would hand a rule's error the
	// feature's path, and be right often enough for nobody to notice.
	//
	// The diagnostics themselves carry no kind -- every loader's Diagnostic is
	// {level, fileId, message} and nothing more -- but this function does: it
	// is where each library is built, so it knows which kind's ids it is
	// converting at every one of the call sites below. Resolving here uses
	// what is known rather than recovering the kind from the id later, which
	// cannot be done: "thing.json" does not say which directory it came from.
	featurePaths := packRelativeIDs(loaded.Dir, loaded.Features, func(f features.SourceFile) (string, string) { return f.ID, f.AbsPath })
	structurePaths := packRelativeIDs(loaded.Dir, loaded.Structures, func(f structures.SourceFile) (string, string) { return f.ID, f.AbsPath })
	rulePaths := packRelativeIDs(loaded.Dir, loaded.Rules, func(f rules.SourceFile) (string, string) { return f.ID, f.AbsPath })
	biomePaths := packRelativeIDs(loaded.Dir, loaded.Biomes, func(f biomes.SourceFile) (string, string) { return f.ID, f.AbsPath })
	blockPaths := packRelativeIDs(loaded.Dir, loaded.Blocks, func(f block.SourceFile) (string, string) { return f.ID, f.AbsPath })

	if ctx.Err() != nil {
		return nil, false
	}

	palette := block.NewPalette()
	// Load the pack's own block tags BEFORE building the feature library:
	// buildXxxFeature (a may_replace/may_attach_to/etc. predicate) checks
	// tag resolvability against this data at build time -- see
	// features.ResolveMatchSet -- so loading it after would make every
	// pack-declared (including custom-namespaced) tag look unresolved.
	out = append(out, convertBlockDiagnostics(palette.LoadBlockTags(loaded.Blocks), blockPaths)...)

	if ctx.Err() != nil {
		return nil, false
	}
	structureLib := structures.BuildLibrary(loaded.Structures, palette)
	out = append(out, convertStructureDiagnostics(structureLib.Diagnostics, structurePaths)...)

	if ctx.Err() != nil {
		return nil, false
	}
	featureLib := features.BuildLibrary(loaded.Features, palette, structureLib)
	out = append(out, convertFeatureDiagnostics(featureLib.Diagnostics, featurePaths)...)

	// Rules raise features.Diagnostic (see rules.FeatureRuleLibrary), so the
	// TYPE cannot tell these from the line above -- the index passed is the
	// only thing that does, and it is the whole reason a rule's message names
	// feature_rules/x.json rather than borrowing features/x.json.
	if ctx.Err() != nil {
		return nil, false
	}
	ruleLib := rules.BuildFeatureRuleLibrary(loaded.Rules)
	out = append(out, convertFeatureDiagnostics(ruleLib.Diagnostics, rulePaths)...)

	if ctx.Err() != nil {
		return nil, false
	}
	biomeLib := biomes.BuildLibrary(loaded.Biomes)
	out = append(out, convertBiomeDiagnostics(biomeLib.Diagnostics, biomePaths)...)

	if ctx.Err() != nil {
		return nil, false
	}
	graphDiags, ok := delegationDiagnostics(ctx, loaded, graph)
	if !ok {
		return nil, false
	}
	out = append(out, graphDiags...)

	return out, true
}

// packWarningLevel decides whether one of pack.Load's own notices is a warning
// or is merely informational.
//
// Decided from pack.MissingDir.Explicit -- the fact itself, recorded where it
// is known -- and never from the sentence. A directory the conventional layout
// derived and the pack does not have is normal; a directory an explicit
// --features/--biomes/... override NAMED and that is not there is a typo'd path
// and stays a warning, because dropping it to info is how a mistyped --features
// starts looking like a pack with no features.
//
// The pairing is by message, because Warnings[i] and MissingDirs[i] are written
// together and carry the same string (see pack.Pack.noteMissingDir). Anything
// in Warnings that is not a missing-directory notice at all keeps the warning
// level it always had.
func packWarningLevel(loaded *pack.Pack, warning string) string {
	for _, m := range loaded.MissingDirs {
		if m.Message == warning {
			if m.Explicit {
				return LevelWarning
			}
			return LevelInfo
		}
	}
	return LevelWarning
}

// printPackNotices writes pack.Load's own notices to w, each prefixed with the
// LEVEL packWarningLevel gives it rather than with "warning:" unconditionally.
//
// This is `check`'s rule, applied to the commands that print the same notices
// as prose instead of as diagnostic rows. Before this, `generate` and `graph`
// opened a perfectly ordinary pack -- one with features/ and nothing else --
// and printed four lines beginning "featurelab: warning:" whose own text ends
// "(fine if this pack has none)". A warning that says it is fine is a warning
// people stop reading, and the same tool calling the same notice "info" in one
// command and "warning" in another is worse: a reader has no way to tell which
// of the two is telling the truth.
//
// The level comes from packWarningLevel -- i.e. from pack.MissingDir.Explicit
// -- so a directory someone actually TYPED and that is not there still prints
// as a warning here, exactly as it is still levelled a warning there. Nothing
// is dropped in either case: a notice that vanished would make a mistyped
// --features look like a pack with no features.
//
// "note:" rather than "info:" because this is a sentence on a terminal, which
// is the same choice checkSummary makes for the same reason; the level string
// stays "info" on the wire, where it is an identifier rather than prose.
func printPackNotices(w io.Writer, loaded *pack.Pack) {
	for _, notice := range loaded.Warnings {
		label := "warning: "
		if packWarningLevel(loaded, notice) == LevelInfo {
			label = "note: "
		}
		fmt.Fprintln(w, "featurelab: "+label+notice)
	}
}

// delegationDiagnostics reports what only the GRAPH can see -- the findings
// that are about how two files relate rather than about either one of them --
// in this package's row shape. Two of them:
//
//   - A delegation whose target no loaded file defines and the game does not
//     provide (wire.UnresolvedTargetDiagnostics, error).
//   - A delegation cycle (wire.DelegationCycleDiagnostics, warning).
//
// Both findings, both sentences and the "which file do I open" rule are the
// graph package's -- see there for what each catches and why they live beside
// the graph rather than here. The first was written here once, and the
// consequence was that `check`, `graph` and the extension reported a pack
// that places nothing while apps/desktop, which links the engine in-process,
// said nothing at all about it.
//
// ONE GRAPH, built at most once. A graph costs a JSON re-parse of every source
// file in the pack, so the two findings share the caller's graph if it passed
// one and otherwise share the one built here; asking each of them to build its
// own would have doubled the cost of the slowest request this engine serves.
// A graph that cannot be built is not an error: it says nothing about
// delegations either way, and every per-file diagnostic is complete without it.
//
// All that is left here is the conversion into this package's Diagnostic, which
// differs from session.Diagnostic only in carrying no Chain/Position. No path
// mapping: both graph findings already carry the pack-relative spelling every
// host opens (wire.GraphNode.File), not a loader-side id.
//
// ok is false only when ctx was cancelled -- same contract as the caller's.
func delegationDiagnostics(ctx context.Context, loaded *pack.Pack, graph *wire.Graph) ([]Diagnostic, bool) {
	if graph == nil {
		built, err := wire.BuildGraphContext(ctx, loaded)
		if err != nil {
			if ctx.Err() != nil {
				return nil, false
			}
			return nil, true
		}
		graph = built
	}
	if ctx.Err() != nil {
		return nil, false
	}
	found, ok := wire.UnresolvedTargetDiagnostics(ctx, loaded, graph)
	if !ok {
		return nil, false
	}
	found = append(found, wire.DelegationCycleDiagnostics(graph)...)
	var out []Diagnostic
	for _, d := range found {
		out = append(out, Diagnostic{Level: d.Level, FileID: d.FileID, Scope: d.Scope, Message: d.Message})
	}
	return out, true
}

// packDiagnosticFileID is the FileID a diagnostic about the PACK carries --
// a directory that is not there -- rather than about any one file in it. It
// is deliberately not a path: there is no file to open, and spelling one
// would send an editor to a file that does not exist. Named rather than
// written twice because graph.go filters on it (see graphDiagnostics), and a
// filter keyed by a literal that only matches by coincidence is a filter that
// stops matching without anything failing.
const packDiagnosticFileID = "(pack)"

// packRelativeIDs indexes ONE asset kind's source files by the SourceFile ID
// its diagnostics are reported under, mapping each to the pack-relative path
// that same file is spelled by everywhere an editor can act on it --
// wire.GraphNode.File, and the paths `apply` takes.
//
// Built from the absolute path through wire.PackRelativePath, the function
// that also spells a graph node's File. A second implementation here --
// prefixing "features/", say -- would be right for a conventionally laid out
// pack and wrong for one loaded through --features, and the two sides would
// each agree with their own tests and not with each other, which is exactly
// how the identical bug in GraphNode.File survived (see withPackPath).
//
// An id with no entry keeps the spelling it had. That is the honest answer for
// three real cases: a pack with no root (Dir empty, one kind loaded through an
// override) where there is nothing to be relative TO; the embedded vanilla
// block catalogue, whose files are not on disk at all; and a diagnostic whose
// FileID names something that was never a source file -- packDiagnosticFileID
// itself, which is "(pack)", names no file and must stay exactly that.
func packRelativeIDs[T any](packDir string, files []T, split func(T) (id, absPath string)) map[string]string {
	if packDir == "" || len(files) == 0 {
		return nil
	}
	out := make(map[string]string, len(files))
	for _, f := range files {
		id, absPath := split(f)
		if id == "" {
			continue
		}
		if rel := wire.PackRelativePath(packDir, absPath); rel != "" {
			out[id] = rel
		}
	}
	return out
}

// packRelativeFileID is the lookup packRelativeIDs exists for -- see there for
// why a miss returns the id unchanged rather than an empty string or a guess.
func packRelativeFileID(paths map[string]string, fileID string) string {
	if rel, ok := paths[fileID]; ok {
		return rel
	}
	return fileID
}

func convertFeatureDiagnostics(in []features.Diagnostic, paths map[string]string) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID),
			Scope: session.ScopePack, Line: d.Line, Column: d.Column, Message: d.Message}
	}
	return out
}

func convertStructureDiagnostics(in []structures.Diagnostic, paths map[string]string) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		// No Line/Column: structures are binary NBT, with no line to point at.
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID),
			Scope: session.ScopePack, Message: d.Message}
	}
	return out
}

func convertBiomeDiagnostics(in []biomes.Diagnostic, paths map[string]string) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID),
			Scope: session.ScopePack, Line: d.Line, Column: d.Column, Message: d.Message}
	}
	return out
}

func convertBlockDiagnostics(in []block.Diagnostic, paths map[string]string) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID),
			Scope: session.ScopePack, Line: d.Line, Column: d.Column, Message: d.Message}
	}
	return out
}

// writeCheckTable prints diagnostics as a text table plus one summary line --
// what `check` shows a person, as opposed to what `--json` shows a program.
//
// `check` is the lint/CI entry point and it used to have exactly one output: a
// pretty-printed JSON array, on stdout, with no summary of any kind. A person
// running it on a pack with one problem read a screenful of braces to find one
// "message" field, and a person running it on a healthy pack read "[]" and had
// to know that meant success. Neither is a thing the other commands here do --
// `types` and `version` have printed a table/line by default and kept their
// JSON behind --json since they existed. This brings check into line with them.
//
// The columns are fixed-width up to the file, and the message runs to the end
// of the line unwrapped. Wrapping was deliberately not done: these messages
// carry paths, identifiers and Molang, and a terminal's own wrap keeps them
// copy-pasteable while a hand-rolled one at some assumed width does not.
func writeCheckTable(w io.Writer, diags []Diagnostic) {
	if len(diags) > 0 {
		fmt.Fprintf(w, "%-8s %-40s %s\n", "LEVEL", "FILE", "MESSAGE")
		for _, d := range diags {
			fmt.Fprintf(w, "%-8s %-40s %s\n", d.Level, checkTableLocation(d), d.Message)
		}
		fmt.Fprintln(w)
	}
	fmt.Fprintln(w, checkSummary(diags))
}

// checkTableLocation is the FILE column: the path, with the 1-based line and
// column appended when the diagnostic carries them, in the file:line:col form
// every editor and every terminal already knows how to jump to.
func checkTableLocation(d Diagnostic) string {
	if d.Line <= 0 {
		return d.FileID
	}
	if d.Column <= 0 {
		return fmt.Sprintf("%s:%d", d.FileID, d.Line)
	}
	return fmt.Sprintf("%s:%d:%d", d.FileID, d.Line, d.Column)
}

// checkSummary is the one line that says how it went.
//
// It counts all three levels, and it prints all three even at zero, because a
// summary that hides its zeroes makes the reader work out which number is
// missing. "notes" rather than "info" is the plural that reads as English in a
// sentence with errors and warnings in it; the level string itself stays "info"
// on the wire, where it is an identifier rather than prose.
//
// Exit code is decided by the errors count alone and by nothing else here --
// see cmdCheck. A summary that implied otherwise (an "ok"/"failed" word) would
// be a second place for that rule to live.
func checkSummary(diags []Diagnostic) string {
	var errors, warnings, notes int
	for _, d := range diags {
		switch d.Level {
		case LevelError:
			errors++
		case LevelWarning:
			warnings++
		default:
			notes++
		}
	}
	return fmt.Sprintf("%d %s, %d %s, %d %s",
		errors, plural(errors, "error"), warnings, plural(warnings, "warning"), notes, plural(notes, "note"))
}

func plural(n int, word string) string {
	if n == 1 {
		return word
	}
	return word + "s"
}
