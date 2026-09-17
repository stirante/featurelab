package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/stirante/featurelab/internal/genvanillablocks"
)

func main() {
	ids := flag.String("ids", "scripts/vanilla-extract/blockcolor_extract.json", "vanilla block id JSON")
	colors := flag.String("colors", "scripts/vanilla-extract/name_color_v2.json", "unvalidated vanilla map-colour JSON")
	palette := flag.String("palette", "scripts/vanilla-extract/mapcolor_palette.json", "vanilla map-colour palette JSON")
	rpBlocks := flag.String("rp-blocks", "", "vanilla resource-pack blocks.json (required)")
	out := flag.String("out", "block/vanilla", "generated behaviour-pack directory")
	flag.Parse()

	if *rpBlocks == "" {
		fmt.Fprintln(os.Stderr, "genvanillablocks: -rp-blocks is required")
		os.Exit(2)
	}
	summary, err := genvanillablocks.Generate(genvanillablocks.Config{
		IDsPath:      *ids,
		ColorsPath:   *colors,
		PalettePath:  *palette,
		RPBlocksPath: *rpBlocks,
		OutputDir:    *out,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "genvanillablocks:", err)
		os.Exit(1)
	}
	fmt.Printf("generated %d blocks (%d resource matches, %d untrusted colours, %d ambiguous, %d without RGB)\n",
		summary.Blocks, summary.ResourceMatches, summary.Colors, summary.AmbiguousColors, summary.MissingColorRGB)
}
