// Package packpath spells one file of a loaded pack the way every
// client-facing shape in this repo spells it: relative to the pack root, with
// POSIX separators.
//
// It exists because three different layers have to arrive at the SAME string
// for the same file and none of them can import the others:
//
//   - wire.GraphNode.File and wire.GraphDiagnostic.FileID (a renderer is
//     promised it can join a diagnostic onto the node whose File matches),
//   - cmd/featurelab's `check`/`loadPack` diagnostics, and
//   - session.Result.Diagnostics, which the preview renders -- and which used
//     to be the odd one out, reporting the loader's kind-relative SourceFile
//     id ("broken.json") for the same file the other two spelled
//     "features/broken.json". One file, two spellings, and every client left
//     to normalise for itself.
//
// wire.PackRelativePath is still the name most of this repo calls it by and
// still the documentation of the contract; it delegates here so that session,
// which wire imports and therefore cannot import back, computes the identical
// string rather than a second implementation of it.
package packpath

import "path/filepath"

// Relative returns absPath spelled relative to packDir, with POSIX
// separators.
//
// Returns "" for anything it cannot answer -- no pack root, no path, or a Rel
// that fails (different volumes on Windows, most plausibly), and for the
// embedded vanilla block catalogue, whose "path" is inside a build-time FS and
// names nothing on disk. A caller keeps the id it already had: no more wrong
// than it was, and better than a path to nowhere.
func Relative(packDir, absPath string) string {
	if packDir == "" || absPath == "" {
		return ""
	}
	rel, err := filepath.Rel(packDir, absPath)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(rel)
}

// Index indexes ONE asset kind's source files by the SourceFile ID its
// diagnostics are reported under, mapping each to the pack-relative path that
// same file is spelled by everywhere a client can act on it.
//
// ONE index PER ASSET KIND, never one shared index, because a SourceFile ID is
// unique only WITHIN its kind: the loader derives it relative to the kind's own
// directory, so a pack that holds both features/thing.json and
// feature_rules/thing.json has two files whose id is "thing.json". A single map
// keyed by id would hand a rule's error the feature's path, and be right often
// enough for nobody to notice.
//
// An id with no entry keeps the spelling it had -- see Lookup.
func Index[T any](packDir string, files []T, split func(T) (id, absPath string)) map[string]string {
	if packDir == "" || len(files) == 0 {
		return nil
	}
	out := make(map[string]string, len(files))
	for _, f := range files {
		id, absPath := split(f)
		if id == "" {
			continue
		}
		if rel := Relative(packDir, absPath); rel != "" {
			out[id] = rel
		}
	}
	return out
}

// Lookup is the read Index exists for. A miss returns fileID unchanged, which
// is the honest answer for three real cases: a pack with no root (one kind
// loaded through an override) where there is nothing to be relative TO; the
// embedded vanilla block catalogue, whose files are not on disk at all; and a
// diagnostic whose FileID names something that was never a source file --
// cmd/featurelab's "(pack)", which names no file and must stay exactly that.
func Lookup(paths map[string]string, fileID string) string {
	if rel, ok := paths[fileID]; ok {
		return rel
	}
	return fileID
}
