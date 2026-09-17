// Command genatlas builds the two artifacts a textured preview consumes --
// atlas.png and atlas.json -- from a resource pack, and writes them where the
// engine looks for them.
//
// With no flags at all it does the whole thing: resolve a vanilla resource
// pack through the same package the hosts use (an explicit local checkout, or
// the per-user cache, or, only with -download, a fetch that announces itself
// first), pack every texture in it, and write the result into the atlas cache
// directory that `featurelab serve`'s "atlas" method reads.
//
// It is not a build step and its output is never committed: the pixels are
// Mojang's. -out defaults to the per-user cache directory for exactly that
// reason; pointing it inside this repository would be a mistake.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/stirante/featurelab/internal/atlas"
	"github.com/stirante/featurelab/vanillaassets"
	"github.com/stirante/featurelab/wire"
)

func main() {
	root := flag.String("root", "", "resource_pack directory to read textures from (default: resolve a vanilla one via the vanillaassets cache)")
	out := flag.String("out", "", "directory to write atlas.png and atlas.json into (default: the atlas cache directory `featurelab serve` reads)")
	tag := flag.String("tag", "", "provenance label recorded in atlas.json (default: the pinned bedrock-samples tag)")
	source := flag.String("source", "vanilla", "\"vanilla\" or \"pack\": which kind of resource pack -root is")
	download := flag.Bool("download", false, "permit fetching the vanilla assets if they are not already cached; a notice is printed first")
	blocks := flag.String("blocks", "", "override the blocks.json to read texture bindings from")
	fallbackBlocks := flag.String("fallback-blocks", "scripts/vanilla-extract/rp/rp_blocks.json",
		"blocks.json to fall back to when the resource pack has none of its own")
	cell := flag.Int("cell", 16, "atlas cell size in texels")
	border := flag.Int("border", 1, "duplicated-edge border texels around each cell (-1 for none)")
	flag.Parse()

	if err := run(*root, *out, *tag, *source, *blocks, *fallbackBlocks, *cell, *border, *download); err != nil {
		fmt.Fprintln(os.Stderr, "genatlas:", err)
		os.Exit(1)
	}
}

func run(root, out, tag, source, blocks, fallbackBlocks string, cell, border int, download bool) error {
	if root == "" {
		resolved, err := vanillaassets.Resolve(context.Background(), vanillaassets.Options{Download: download})
		if err != nil {
			return fmt.Errorf("%w\n(pass -root to point at a resource_pack directory you already have, or -download to permit a fetch)", err)
		}
		root = resolved
		if tag == "" {
			tag = vanillaassets.PinnedTag
		}
	}
	if out == "" {
		dir, err := wire.AtlasDir()
		if err != nil {
			return err
		}
		out = dir
	}

	built, err := atlas.Build(atlas.Options{
		Root:               root,
		Tag:                tag,
		Source:             source,
		BlocksPath:         blocks,
		FallbackBlocksPath: fallbackBlocks,
		Cell:               cell,
		Border:             border,
	})
	if err != nil {
		return err
	}
	if err := built.WriteDir(out); err != nil {
		return err
	}

	s, t := built.Stats, built.Table
	fmt.Printf("wrote %s\n", out)
	fmt.Printf("atlas   %dx%d: %d texture cells plus the white fallback cell (index %d), %d+2*%d each, in a %dx%d grid; %d bytes of png\n",
		t.Width, t.Height, s.CellsPacked, t.White, t.Cell, t.Border, t.Cols, t.Rows, len(built.PNG))
	fmt.Printf("textures %d keys reaching %d paths: %d packed, %d paths and %d keys unresolved\n",
		s.TextureKeys, s.TexturePaths, s.CellsPacked, s.TexturePathsBad, s.TextureKeysBad)
	fmt.Printf("blocks   %d considered: %d with all six faces, %d partial, %d with no resource-pack binding\n",
		s.Blocks, s.BlocksFull, s.BlocksPartial, s.BlocksMissing)
	fmt.Printf("tinting  %d cells measure greyscale: %d block faces got a tint channel, %d are grey with no tint source in the pack\n",
		s.GreyCells, s.TintedFaces, s.UntintedGrey)
	if s.TexturePathsBad > 0 || s.BlocksMissing > 0 {
		fmt.Printf("         every miss is listed in atlas.json under \"misses\"\n")
	}
	return nil
}
