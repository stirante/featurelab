package vanillaassets

import "flag"

// RegisterFlags gives a command the flag half of "a flag and/or an env var",
// so that every host spells these the same way rather than each inventing its
// own name for them.
//
// It is deliberately not wired into any subcommand here: nothing in this
// repository renders a texture yet, and a flag that does nothing is worse than
// no flag. Whichever command first needs a resource pack calls this, and gets
// -vanilla-pack, -vanilla-download and -vanilla-tag for free.
//
// The environment variables (EnvPack, EnvDownload, EnvCache) still apply and
// still win where they are documented to: they are what makes an offline or
// proxied machine work regardless of which host process -- CLI, extension,
// desktop app -- is driving the engine.
func RegisterFlags(fs *flag.FlagSet, opts *Options) {
	fs.StringVar(&opts.Dir, "vanilla-pack", opts.Dir,
		"an existing bedrock-samples resource_pack directory to use instead of downloading one "+
			"(the directory containing textures/blocks; also settable as "+EnvPack+")")
	fs.BoolVar(&opts.Download, "vanilla-download", opts.Download,
		"permit downloading Mojang's sample resource pack ("+PinnedTag+", about 150 MB transferred) into the "+
			"per-user cache if it is not there already; without this, and without -vanilla-pack, "+
			"the preview draws flat colours (also settable as "+EnvDownload+")")
	fs.StringVar(&opts.Tag, "vanilla-tag", opts.Tag,
		"bedrock-samples release tag to download (default "+PinnedTag+")")
}
