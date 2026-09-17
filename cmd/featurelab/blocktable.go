package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/internal/packrender"
	"github.com/stirante/featurelab/internal/rptex"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/vanillaassets"
)

// cmdBlockTable implements the `blocktable` subcommand: read the pack's own
// blocks/**/*.json, resolve every custom block's face textures through the
// pack's OWN resource pack, and print the resulting block table as JSON.
//
// This exists as its own subcommand rather than as extra output on
// `generate` or `check` for two reasons. `check` answers "does this pack
// load cleanly", and using a resource-pack model geometry is not a defect
// in a pack -- putting a hundred "drawn as a full cube" lines in check's
// output would drown the diagnostics that ARE defects and would change what
// its exit code means. And the table is a build artifact: an atlas builder
// wants it, a renderer wants it, and both want it without running a
// placement.
//
// The summary goes to stderr and the table to stdout, so the table can be
// piped somewhere while a human still sees how much of their pack drew.
func cmdBlockTable(args []string) int {
	fs := flag.NewFlagSet("blocktable", flag.ContinueOnError)
	var pf packFlags
	pf.register(fs)
	resourcePack := fs.String("resource-pack", "",
		"the pack's resource pack directory (default: found from the behaviour pack's manifest dependencies, or by directory naming)")
	// Custom blocks reuse vanilla texture keys freely, so a vanilla resource
	// pack is worth consulting for the keys the pack itself does not declare.
	// These are Piece A's own flags, registered rather than reinvented, which
	// is what keeps -vanilla-pack spelled the same in every host -- and they
	// keep its rule that nothing is downloaded without being asked.
	var vanillaOpts vanillaassets.Options
	vanillaassets.RegisterFlags(fs, &vanillaOpts)
	if err := fs.Parse(args); err != nil {
		return 2
	}

	opts := pf.options()
	if opts.Dir == "" && opts.BlocksDir == "" {
		fmt.Fprintln(os.Stderr, "featurelab: blocktable needs --pack (a pack root)")
		return 2
	}
	loaded, err := pack.Load(opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}

	palette := block.NewPalette()
	palette.LoadBlockTags(loaded.Blocks)

	rp, notes, err := pack.FindResourcePack(loaded.Dir, *resourcePack)
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}
	for _, note := range notes {
		fmt.Fprintln(os.Stderr, "featurelab: "+note)
	}

	buildOpts := packrender.Options{Palette: palette}
	if rp != nil {
		buildOpts.TerrainTexturePath = rp.TerrainTexturePath
		buildOpts.TextureRoot = rp.Dir
		buildOpts.ResourcePackDir = rp.Dir
		buildOpts.ResourcePackName = rp.Name
		buildOpts.ResourcePackHow = rp.How
	}
	// A missing vanilla pack is not a failure here: it costs the keys a pack
	// borrowed from vanilla, and nothing else. Say so once and carry on --
	// the same "textures are an enhancement" rule the rest of this feature
	// follows.
	if root, err := vanillaassets.Resolve(context.Background(), vanillaOpts); err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: no vanilla resource pack available ("+err.Error()+
			"); texture keys this pack borrows from vanilla will be listed as unresolved")
	} else {
		buildOpts.VanillaTerrainTexturePath = filepath.Join(root, filepath.FromSlash(rptex.TerrainRelPath))
		buildOpts.VanillaTextureRoot = root
	}

	table, err := packrender.Build(buildOpts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}
	if err := writeJSON(os.Stdout, table); err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: encoding JSON: "+err.Error())
		return 1
	}

	s := table.Summarise()
	fmt.Fprintf(os.Stderr,
		"featurelab: %d block(s) defined by the pack; %d drawn exactly as declared, %d drawn as a full cube (geometry is a resource-pack model), %d with at least one unresolved texture\n",
		s.Blocks, s.Fully, s.ShapeCube, s.Untextured)
	return 0
}
