package main

import (
	"flag"

	"github.com/stirante/featurelab/pack"
)

// packFlags registers the four pack-location flags shared by every
// subcommand that loads a pack (generate, check) -- --pack names the pack
// root; each of --features/--structures/--rules/--biomes independently
// overrides that kind's conventional Dir/<name> subdirectory, exactly
// matching pack.Options's own fields.
type packFlags struct {
	dir, features, structures, rules, biomes string
}

func (f *packFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&f.dir, "pack", "", "pack root directory (expects features/, structures/, feature_rules/, biomes/ subdirs)")
	fs.StringVar(&f.features, "features", "", "override the features subdirectory")
	fs.StringVar(&f.structures, "structures", "", "override the structures subdirectory")
	fs.StringVar(&f.rules, "rules", "", "override the feature_rules subdirectory")
	fs.StringVar(&f.biomes, "biomes", "", "override the biomes subdirectory")
}

func (f *packFlags) options() pack.Options {
	return pack.Options{
		Dir:           f.dir,
		FeaturesDir:   f.features,
		StructuresDir: f.structures,
		RulesDir:      f.rules,
		BiomesDir:     f.biomes,
	}
}
