package block

import (
	"embed"
	"encoding/json"
	"io/fs"
	"sort"
	"strings"
	"sync"
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

// ---------------------------------------------------------------------------
// The catalogue as a NAME TABLE
// ---------------------------------------------------------------------------

// vanillaNamesOnce guards vanillaNames, built on first use and never rebuilt:
// the catalogue is embedded at build time and cannot change while the process
// runs.
var (
	vanillaNamesOnce sync.Once
	vanillaNames     map[string]struct{}
)

// VanillaBlockNames is the set of every block id in the embedded vanilla
// catalogue, canonicalised.
//
// It exists so KnowsBlockName can answer for vanilla WITHOUT depending on
// anybody having called LoadBlockTags first. pack.Load stacks DefaultBlocks()
// under every real pack load, so in production the tag index happens to carry
// the same names -- but a Palette is also built by hand, by tests and by hosts
// that want no pack at all, and a "this block does not exist" warning whose
// truth depends on which loader ran first is a warning that fires on
// minecraft:diamond_block. Reading the embedded catalogue directly removes the
// ordering from the answer entirely.
//
// The identifier is read out of each file's own
// minecraft:block.description.identifier rather than derived from its
// filename: the filename spelling is the generator's convention, and a table
// that silently empties out when that convention changes is worse than one
// that costs a parse.
//
// Returned as the live map, not a copy -- it is read-only by contract and this
// is called once per unknown-looking name.
func VanillaBlockNames() map[string]struct{} {
	vanillaNamesOnce.Do(func() {
		files := DefaultBlocks()
		vanillaNames = make(map[string]struct{}, len(files))
		for _, f := range files {
			var doc struct {
				Block struct {
					Description struct {
						Identifier string `json:"identifier"`
					} `json:"description"`
				} `json:"minecraft:block"`
			}
			if err := json.Unmarshal([]byte(f.Text), &doc); err != nil {
				continue
			}
			if id := doc.Block.Description.Identifier; id != "" {
				vanillaNames[canonicalName(id)] = struct{}{}
			}
		}
	})
	return vanillaNames
}
