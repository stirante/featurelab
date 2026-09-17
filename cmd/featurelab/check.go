package main

import (
	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/rules"
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
	var out []Diagnostic
	for _, w := range loaded.Warnings {
		out = append(out, Diagnostic{Level: "warning", FileID: packDiagnosticFileID, Message: w})
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

	palette := block.NewPalette()
	// Load the pack's own block tags BEFORE building the feature library:
	// buildXxxFeature (a may_replace/may_attach_to/etc. predicate) checks
	// tag resolvability against this data at build time -- see
	// features.ResolveMatchSet -- so loading it after would make every
	// pack-declared (including custom-namespaced) tag look unresolved.
	out = append(out, convertBlockDiagnostics(palette.LoadBlockTags(loaded.Blocks), blockPaths)...)

	structureLib := structures.BuildLibrary(loaded.Structures, palette)
	out = append(out, convertStructureDiagnostics(structureLib.Diagnostics, structurePaths)...)

	featureLib := features.BuildLibrary(loaded.Features, palette, structureLib)
	out = append(out, convertFeatureDiagnostics(featureLib.Diagnostics, featurePaths)...)

	// Rules raise features.Diagnostic (see rules.FeatureRuleLibrary), so the
	// TYPE cannot tell these from the line above -- the index passed is the
	// only thing that does, and it is the whole reason a rule's message names
	// feature_rules/x.json rather than borrowing features/x.json.
	ruleLib := rules.BuildFeatureRuleLibrary(loaded.Rules)
	out = append(out, convertFeatureDiagnostics(ruleLib.Diagnostics, rulePaths)...)

	biomeLib := biomes.BuildLibrary(loaded.Biomes)
	out = append(out, convertBiomeDiagnostics(biomeLib.Diagnostics, biomePaths)...)

	return out
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
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID), Message: d.Message}
	}
	return out
}

func convertStructureDiagnostics(in []structures.Diagnostic, paths map[string]string) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID), Message: d.Message}
	}
	return out
}

func convertBiomeDiagnostics(in []biomes.Diagnostic, paths map[string]string) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID), Message: d.Message}
	}
	return out
}

func convertBlockDiagnostics(in []block.Diagnostic, paths map[string]string) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: packRelativeFileID(paths, d.FileID), Message: d.Message}
	}
	return out
}
