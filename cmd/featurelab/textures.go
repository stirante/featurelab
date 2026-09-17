// textures.go implements the `textures` subcommand: the first run, from a
// terminal.
//
// This is the CLI's half of a flow every host shares (blocktextures.Check /
// Ensure / Decline). The three hosts differ only in HOW they ask -- a question
// on a terminal here, a native dialog in the desktop app, a notification in
// the editor -- and not in what they ask, what they fetch, where it lands or
// what they say when it fails. It is also what the VS Code extension shells
// out to: a 150 MB download inside the `serve` request loop would block every
// other request on that process for minutes, and a preview frozen while its
// textures arrive is a worse trade than a second, short-lived process.
//
// Nothing here downloads anything without being told to. With no flags and the
// assets already on the machine it BUILDS -- it does not offer, because there is
// nothing to consent to when no network is involved. The question exists only
// when a fetch does.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/stirante/featurelab/blocktextures"
	"github.com/stirante/featurelab/vanillaassets"
)

func cmdTextures(args []string) int {
	fs := flag.NewFlagSet("textures", flag.ContinueOnError)
	// flag's default usage prints the flag list and nothing else, so `featurelab textures -h`
	// never said what the command DOES -- including the two things a reader most needs and
	// cannot guess: with no flags it BUILDS (rather than offering) when the assets are already
	// local, and a typed "no" is remembered for this machine rather than just for this run.
	fs.Usage = func() {
		out := fs.Output()
		fmt.Fprintln(out, "Usage: featurelab textures [flags]")
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Build the block-texture atlas the preview draws with. With no flags: builds")
		fmt.Fprintln(out, "straight away if Mojang's sample resource pack is already on this machine, and")
		fmt.Fprintln(out, "otherwise asks once before fetching it (about 150 MB). Answering no is")
		fmt.Fprintln(out, "remembered for this machine, and nothing asks again until a build succeeds.")
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Without an atlas the preview draws flat block colours, as it always has.")
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Flags:")
		fs.PrintDefaults()
	}
	packDir := fs.String("pack", "",
		"a pack whose own blocks should be drawn with their own textures as well as vanilla's (default: vanilla only)")
	resourcePack := fs.String("resource-pack", "",
		"that pack's resource pack directory (default: found from the behaviour pack's manifest dependencies, or by directory naming)")
	atlasDir := fs.String("out", "",
		"directory to write atlas.png and atlas.json into (default: the atlas cache directory every host reads)")
	status := fs.Bool("status", false, "report whether block textures are available and exit, changing nothing")
	asJSON := fs.Bool("json", false, "print machine-readable JSON instead of prose (what the editor extension reads)")
	// This help line used to say -yes "does NOT by itself permit a download". That was false, and
	// false about a 150 MB network fetch: the only prompt this command has ASKS whether to
	// download, so answering it yes in advance necessarily permits the fetch. Tested against an
	// empty cache -- `featurelab textures -yes` transfers the lot. The wording is corrected rather
	// than the behaviour, because a -yes that cannot answer the only question there is would do
	// nothing at all; FEATURELAB_VANILLA_DOWNLOAD=0 remains the way to forbid fetching outright.
	yes := fs.Bool("yes", false,
		"answer yes to the download prompt in advance -- this PERMITS fetching Mojang's sample "+
			"resource pack (about 150 MB) if it is not already on this machine. Set "+
			"FEATURELAB_VANILLA_DOWNLOAD=0 to forbid fetching whatever else is passed")
	decline := fs.Bool("decline", false, "record that this machine does not want the download, so nothing asks again")
	rebuild := fs.Bool("rebuild", false, "rebuild even if the atlas is already up to date")
	// Piece A's own flags, registered rather than reinvented: -vanilla-pack,
	// -vanilla-download and -vanilla-tag are spelled the same in every command
	// that can reach a resource pack, and the environment variables behind
	// them keep working for a machine that must never fetch anything.
	var vanillaOpts vanillaassets.Options
	vanillaassets.RegisterFlags(fs, &vanillaOpts)
	// -download is the short spelling of -vanilla-download for the one command
	// whose whole subject is the download.
	download := fs.Bool("download", false,
		"short spelling of -vanilla-download, for this command only: permit fetching Mojang's "+
			"sample resource pack if it is not already on this machine. Setting either one is enough")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *download {
		vanillaOpts.Download = true
	}

	opts := blocktextures.Options{
		Dir:             *atlasDir,
		Vanilla:         vanillaOpts,
		PackDir:         *packDir,
		ResourcePackDir: *resourcePack,
		// Only useful when running from a checkout of this repository; a
		// resource pack that ships its own blocks.json never reaches it.
		FallbackBlocksPath: "scripts/vanilla-extract/rp/rp_blocks.json",
	}

	if *decline {
		if err := blocktextures.Decline(opts); err != nil {
			fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
			return 1
		}
		st := blocktextures.Check(opts)
		if *asJSON {
			return printJSON(st)
		}
		fmt.Println(st.Detail)
		return 0
	}

	st := blocktextures.Check(opts)
	if *status {
		if *asJSON {
			return printJSON(st)
		}
		fmt.Println(st.Detail)
		return 0
	}

	if st.Ready() && !*rebuild {
		if *asJSON {
			return printJSON(st)
		}
		fmt.Println(st.Detail)
		fmt.Println("Nothing to do. Pass -rebuild to build it again anyway.")
		return 0
	}

	// The question, and the one place the CLI differs from the GUI hosts.
	// Asked only when a download is what is being asked for: a machine that
	// already has the assets is not being asked to reach the network, and
	// there is nothing to consent to.
	if st.NeedsDownload && !vanillaOpts.Download {
		// -json means a program is driving this, not a person: it never
		// prompts, so an editor that spawns this to ask "what state am I in"
		// can never hang on a question nobody can see.
		if !*yes && (*asJSON || !interactive()) {
			// Non-interactive and not permitted: say what would happen and
			// what to pass, and exit successfully -- a build script that
			// cannot have textures is not a failed build script.
			if *asJSON {
				return printJSON(st)
			}
			fmt.Println(st.Detail)
			fmt.Println("Pass -download to permit the fetch, or -vanilla-pack <dir> to use a bedrock-samples")
			fmt.Println("resource_pack directory you already have. Nothing was downloaded.")
			return 0
		}
		if !*yes {
			fmt.Println(st.Notice)
			fmt.Println()
			ok, err := ask(os.Stdin, os.Stdout, "Download Mojang's sample block textures now? [y/N] ")
			if !ok {
				// A typed "no" is remembered so nothing asks again; stdin
				// ending without an answer is NOT -- nobody saw the question,
				// and recording a decline for a question nobody was asked is
				// how a machine ends up permanently opted out by accident.
				if err == nil {
					if err := blocktextures.Decline(opts); err != nil {
						fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
					}
					fmt.Println()
				}
				fmt.Println("Not downloading. The preview draws flat block colours, as it always has.")
				fmt.Println("Run `featurelab textures -download` if you change your mind.")
				return 0
			}
		}
		vanillaOpts.Download = true
		opts.Vanilla = vanillaOpts
	}

	// Progress goes to stderr in every mode, including -json: stdout is the
	// machine-readable answer and must stay one JSON document, but a host
	// driving this needs the same "still going" signal a person does -- a
	// 150 MB fetch reporting nothing for two minutes reads as a hang whether
	// a program or a person is watching.
	opts.Progress = func(step string) { fmt.Fprintln(os.Stderr, "featurelab: "+step+"…") }
	result, err := blocktextures.Ensure(context.Background(), opts)
	if err != nil {
		// Offline, refused, a proxy that breaks TLS, an unwritable cache: one
		// error, said once. Non-zero because this command's whole job is the
		// thing that failed -- unlike every other command, where textures are
		// an enhancement and failing to have them changes nothing.
		if *asJSON {
			fail := blocktextures.Check(opts)
			fail.Reason = err.Error()
			fail.Detail = "Block textures could not be built: " +
				strings.TrimRight(err.Error(), ".") + ". The preview draws flat block colours."
			_ = printJSON(fail)
			return 1
		}
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}
	if *asJSON {
		return printJSON(result)
	}
	printTextureResult(os.Stdout, result)
	return 0
}

func printTextureResult(w io.Writer, r *blocktextures.Result) {
	fmt.Fprintln(w, r.Status.Detail)
	s := r.Stats
	// CellsPacked is the vanilla pass only -- see its doc comment. Printed as "N textures packed"
	// it said 1207 for a build that had just packed 124 more of a pack's own, one line above the
	// line saying so, which reads as a contradiction rather than as a breakdown.
	fmt.Fprintf(w, "%d vanilla textures packed for %d blocks (%d with all six faces).\n",
		s.CellsPacked, s.Blocks, s.BlocksFull)
	if r.Pack != nil {
		p := r.Pack
		fmt.Fprintf(w, "This pack: %d block(s) of its own -- %d drawn exactly as declared, %d as a textured cube "+
			"(their geometry is a resource-pack model), %d with an unresolved texture.\n", p.Blocks, p.Fully, p.ShapeCube, p.Untextured)
		fmt.Fprintf(w, "%d of its own textures packed alongside vanilla's; %d texture key(s) it borrows from vanilla needed nothing packed.\n",
			p.Textures, p.Reused)
		if p.ResourcePack != "" {
			fmt.Fprintf(w, "Resource pack: %s (found by %s).\n", p.ResourcePack, p.How)
		}
	}
	// The notes, capped. A host shows only the ones a given preview actually
	// placed -- that filter is the version a person should usually see. This
	// command was asked about the whole pack, so it lists them, but 120
	// identical sentences scroll the summary above off the screen, which helps
	// nobody. Every one of them is in the atlas table, per block, either way.
	const maxListedNotes = 10
	for i, n := range r.Notes {
		if i == maxListedNotes {
			fmt.Fprintf(w, "  ... and %d more, each recorded on its own block in the atlas table.\n", len(r.Notes)-maxListedNotes)
			break
		}
		fmt.Fprintf(w, "  %s: %s\n", n.Block, n.Message)
	}
}

func printJSON(v any) int {
	if err := writeJSON(os.Stdout, v); err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: encoding JSON: "+err.Error())
		return 1
	}
	return 0
}

// interactive reports whether there is a person on the other end of stdin to
// answer a question. A pipe, a CI job or an editor driving this binary gets
// the non-interactive path, which never blocks waiting for an answer nobody
// is going to type.
func interactive() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// ask puts one yes/no question and reads one line. Anything that is not an
// explicit yes is a no: this question is permission to use someone's network
// connection, and a stray newline is not permission.
func ask(in io.Reader, out io.Writer, prompt string) (bool, error) {
	fmt.Fprint(out, prompt)
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && strings.TrimSpace(line) == "" {
		return false, err
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true, nil
	default:
		return false, nil
	}
}
