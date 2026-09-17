// Command gencolors derives block/vanilla/colors.json, a per-block (and,
// where the data has it, per-face) preview colour table, from the official
// vanilla resource-pack data and textures. It does not vendor any texture
// into the repository: -texture-root always points at a local, external
// checkout. See internal/gencolors's package doc for how to obtain one.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/stirante/featurelab/internal/gencolors"
)

func main() {
	textureRoot := flag.String("texture-root", "", "bedrock-samples resource_pack directory, e.g. .../bedrock-samples/resource_pack (required)")
	rpBlocks := flag.String("rp-blocks", "scripts/vanilla-extract/rp/rp_blocks.json", "vanilla resource-pack blocks.json")
	terrainTexture := flag.String("terrain-texture", "scripts/vanilla-extract/rp/terrain_texture.json", "vanilla resource-pack terrain_texture.json")
	blocksDir := flag.String("blocks-dir", "block/vanilla/blocks", "already-generated per-block catalogue directory (read for its list of block IDs only)")
	out := flag.String("out", "block/vanilla/colors.json", "output colour-table JSON path")
	flag.Parse()

	if *textureRoot == "" {
		fmt.Fprintln(os.Stderr, "gencolors: -texture-root is required")
		os.Exit(2)
	}

	summary, err := gencolors.Generate(gencolors.Config{
		TextureRoot:        *textureRoot,
		RPBlocksPath:       *rpBlocks,
		TerrainTexturePath: *terrainTexture,
		BlocksDir:          *blocksDir,
		OutputPath:         *out,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "gencolors:", err)
		os.Exit(1)
	}
	fmt.Printf("considered %d blocks: %d got a colour, %d did not (%d texture keys unavailable)\n",
		summary.Blocks, summary.BlocksWithColor, summary.BlocksWithoutColor, summary.UnavailableTextures)
}
