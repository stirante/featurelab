// packpaths.go makes a session diagnostic's fileId the SAME string every other
// client-facing shape in this repo uses for the same file.
//
// The divergence it closes was visible in one editor window: the graph canvas
// and `check` both said `features/broken.json`, while the preview's own
// diagnostics -- which come from here -- said `broken.json`. Neither was
// wrong-by-accident; they were two spellings with two sources. A loader's
// SourceFile ID is relative to its KIND's directory ("broken.json"), and
// wire.GraphNode.File/wire.GraphDiagnostic.FileID are relative to the PACK
// root ("features/broken.json"). cmd/featurelab respells them on the
// `loadPack`/`check` path (see packRelativeIDs there) and nothing respelled
// them on the generate path, so the same file arrived at the same client under
// two names and every client had to normalise for itself.
//
// The respelling is done HERE, at the one boundary every generate diagnostic
// crosses, and it is done per asset kind -- see packpath.Index for why one
// shared index would be wrong -- using the same internal/packpath the graph
// builder computes wire.GraphNode.File with.
//
// Config.PackDir is what switches it on. Left empty (a caller that has only
// source files and no pack root, which every test in this package and the
// goldentest harness are) nothing is respelled and the ids are exactly what
// they always were.
package session

import (
	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/internal/packpath"
	"github.com/stirante/featurelab/rules"
	"github.com/stirante/featurelab/structures"
)

// packPaths is one path index per asset kind: SourceFile ID -> pack-relative
// path. A zero packPaths respells nothing, which is what a run with no pack
// root gets.
type packPaths struct {
	features   map[string]string
	structures map[string]string
	rules      map[string]string
	biomes     map[string]string
	blocks     map[string]string
}

// feature/structure/rule/biome/block each return the pack-relative spelling of
// one fileID of that kind, or the id unchanged when there is nothing to respell
// it with (see packpath.Lookup).
func (p packPaths) feature(fileID string) string   { return packpath.Lookup(p.features, fileID) }
func (p packPaths) structure(fileID string) string { return packpath.Lookup(p.structures, fileID) }
func (p packPaths) rule(fileID string) string      { return packpath.Lookup(p.rules, fileID) }
func (p packPaths) biome(fileID string) string     { return packpath.Lookup(p.biomes, fileID) }
func (p packPaths) block(fileID string) string     { return packpath.Lookup(p.blocks, fileID) }

// pathsFor returns this Workspace's path index for packDir, building it at most
// once per (pack root, set of loaded files).
//
// Cached rather than rebuilt per generate because a generate is the repeated
// operation this whole type exists to make cheap: the index is one map entry
// per source file, and a large add-on has thousands of them, on a path that
// otherwise touches no file list at all. Update() drops the cache because that
// is the only thing that changes the answer -- see there.
func (w *Workspace) pathsFor(packDir string) packPaths {
	if packDir == "" {
		return packPaths{}
	}
	if w.pathsBuilt && w.pathsDir == packDir {
		return w.pathsCache
	}
	w.pathsCache = packPaths{
		features:   packpath.Index(packDir, w.featureFiles, func(f features.SourceFile) (string, string) { return f.ID, f.AbsPath }),
		structures: packpath.Index(packDir, w.structureFiles, func(f structures.SourceFile) (string, string) { return f.ID, f.AbsPath }),
		rules:      packpath.Index(packDir, w.ruleFiles, func(f rules.SourceFile) (string, string) { return f.ID, f.AbsPath }),
		biomes:     packpath.Index(packDir, w.biomeFiles, func(f biomes.SourceFile) (string, string) { return f.ID, f.AbsPath }),
		blocks:     packpath.Index(packDir, w.blockFiles, func(f block.SourceFile) (string, string) { return f.ID, f.AbsPath }),
	}
	w.pathsDir = packDir
	w.pathsBuilt = true
	return w.pathsCache
}
