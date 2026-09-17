package block

import (
	"embed"
	"io/fs"
	"sort"
	"strings"
)

// vanillaBlocksFS embeds the generated vanilla block catalogue
// (block/vanilla/blocks/**/*.json, see cmd/genvanillablocks) directly into
// the engine. Embedding (rather than reading block/vanilla/blocks off disk
// at a path relative to the process's working directory) gives this
// "vanilla knowledge" table the same guarantee every other one in this
// package already has (blockKinds, simpleBlockAliases, ...): available
// regardless of where the binary is invoked from, with no separate
// deployment step to keep in sync.
//
//go:embed vanilla/blocks
var vanillaBlocksFS embed.FS

// vanillaBlocksRoot is vanillaBlocksFS's embedded root -- factored out so
// DefaultBlocks's own trimming of it into a SourceFile.ID stays obviously
// in sync with the //go:embed directive above.
const vanillaBlocksRoot = "vanilla/blocks"

// DefaultBlocks returns the generated vanilla block catalogue as
// SourceFiles, sorted by ID -- the same shape and "path relative to the
// blocks/ root, forward-slashed" ID convention pack.Load produces for a
// user pack's own blocks/ directory (see that package's walkText). This is
// what makes the vanilla catalogue a DEFAULT pack rather than a separate
// code path: a caller that wants it loaded through the exact same pipeline
// a user pack's own block files go through (LoadBlockTags, and whatever
// else consumes []SourceFile in the future) just prepends this slice to
// its own, rather than the engine special-casing "vanilla" anywhere deeper.
//
// Every call re-reads the embedded FS and re-allocates -- this is not
// hot-path code (called at most once per pack load, mirroring the cost of
// walking a real blocks/ directory), so there is no caching to keep
// correct.
func DefaultBlocks() []SourceFile {
	var out []SourceFile
	// The embedded FS is fixed at build time from a real directory that
	// exists (verified by go:build itself failing if vanilla/blocks were
	// ever removed), so a walk error here would mean a corrupt build, not
	// a normal runtime condition -- nothing meaningful to do but stop
	// collecting rather than return a silently partial catalogue.
	err := fs.WalkDir(vanillaBlocksFS, vanillaBlocksRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".json") {
			return nil
		}
		data, err := vanillaBlocksFS.ReadFile(path)
		if err != nil {
			return err
		}
		id := strings.TrimPrefix(path, vanillaBlocksRoot+"/")
		out = append(out, SourceFile{ID: id, AbsPath: path, Text: string(data)})
		return nil
	})
	if err != nil {
		panic("block: embedded vanilla catalogue is unreadable: " + err.Error())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
