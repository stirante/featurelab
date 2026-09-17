// Command featurelab is the headless CLI/protocol binary for featurelab-go
// -- the shared foundation a VS Code extension and a Wails desktop app will
// both drive (neither is built here: this package is binary and protocol
// only).
// Its JSON output is therefore a contract, not a debug dump: stable field
// names, everything a viewer needs (block volume, placed/carved/replaced
// counts, diagnostics, origin/bounds, the seed actually used), nothing only
// reachable by re-parsing prose.
//
// Subcommands:
//
//	generate  run one feature or one rule, print the result as JSON
//	serve     newline-delimited JSON request/response loop over stdin/stdout
//	check     load a pack, print diagnostics, exit non-zero on any error
//	textures  report on, or build, the block-texture atlas a textured preview draws from
//	types     print the minecraft:*_feature coverage table
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/wire"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		printUsage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "generate":
		return cmdGenerate(args[1:])
	case "serve":
		return cmdServe(args[1:])
	case "check":
		return cmdCheck(args[1:])
	case "graph":
		return cmdGraph(args[1:])
	case "blocktable":
		return cmdBlockTable(args[1:])
	case "textures":
		return cmdTextures(args[1:])
	case "types":
		return cmdTypes(args[1:])
	case "-h", "--help", "help":
		printUsage(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "featurelab: unknown subcommand %q\n\n", args[0])
		printUsage(os.Stderr)
		return 2
	}
}

func printUsage(w *os.File) {
	fmt.Fprintln(w, `featurelab -- headless feature/rule preview CLI

Usage:
  featurelab generate --pack <dir> (--feature <id> | --rule <id>) [flags]
  featurelab serve
  featurelab check --pack <dir>
  featurelab graph --pack <dir>
  featurelab blocktable --pack <dir> [--resource-pack <dir>]
  featurelab textures [--pack <dir>] [--status] [--download]
  featurelab types [--json]

Run "featurelab <subcommand> -h" for that subcommand's flags.`)
}

// cmdGenerate implements the `generate` subcommand: load a pack, run one
// feature or rule, print the JSON result to stdout.
func cmdGenerate(args []string) int {
	fs := flag.NewFlagSet("generate", flag.ContinueOnError)
	var pf packFlags
	pf.register(fs)
	feature := fs.String("feature", "", "feature identifier to place")
	rule := fs.String("rule", "", "feature rule identifier to place")
	envName := fs.String("env", "plains", "environment preset id")
	var seedFlag uint
	fs.UintVar(&seedFlag, "seed", 0, "feature seed (default: preset default)")
	origin := fs.String("origin", "", "placement origin \"x,y,z\" (default: x=0,z=0, preset auto Y)")
	size := fs.String("size", "", "volume size \"XxYxZ\" (default: preset default)")
	repeat := fs.Int("repeat", 1, "place this many times, advancing the RNG")
	profile := fs.Bool("profile", false, "collect a per-run profile (touch counts, per-feature cost/delegation attribution) and include it in the JSON output")
	var minYFlag int
	fs.IntVar(&minYFlag, "min-y", 0, "world-floor Y override (default: preset default)")
	biomeID := fs.String("biome-id", "", "select a loaded pack biome by id (fills material slots + biome tags); "+
		"must name a biome the pack actually defines, else a diagnostic is reported (default: no biome selected)")
	biomeTags := fs.String("biome-tags", "", "comma-separated biome tag override, independent of --biome-id (default: preset/biome default)")
	topMaterial := fs.String("top-material", "", "top_material override, e.g. minecraft:grass_block (default: preset default)")
	midMaterial := fs.String("mid-material", "", "mid_material override, e.g. minecraft:dirt (default: preset default)")
	foundationMaterial := fs.String("foundation-material", "", "foundation_material override, e.g. minecraft:stone (default: preset default)")
	seaFloorMaterial := fs.String("sea-floor-material", "", "sea_floor_material override, e.g. minecraft:gravel -- \"ocean\" only, like --sea-floor-depth (default: preset default)")
	seaMaterial := fs.String("sea-material", "", "sea_material override, e.g. minecraft:water -- \"ocean\" only, like --sea-floor-depth (default: preset default)")
	var seaFloorDepthFlag float64
	fs.Float64Var(&seaFloorDepthFlag, "sea-floor-depth", 0, "sea_floor_material band depth override -- how many blocks of sea_floor_material sit under the seabed surface. "+
		"Only the \"ocean\" preset builds a sea, so setting this under any other --env is reported as inert rather than silently ignored (default: preset default)")
	var writeBudgetFlag int
	fs.IntVar(&writeBudgetFlag, "write-budget", 0, "max SetBlock attempts before placement aborts and returns a partial result (default: 4000000)")
	var delegationBudgetFlag int
	fs.IntVar(&delegationBudgetFlag, "delegation-budget", 0, "max nested feature delegations before placement aborts and returns a partial result (default: 2000000)")
	var placementTimeLimitMsFlag int
	fs.IntVar(&placementTimeLimitMsFlag, "placement-time-limit-ms", 0, "wall-clock placement deadline in ms before placement aborts and returns a partial result (default: 8000)")
	grow := fs.Bool("grow", false, "grow to fit and regenerate: if the run captures any out-of-bounds writes, expand the bench to contain them and place AGAIN at the larger size -- "+
		"a genuinely different run (different reads, possibly different RNG outcomes), not a wider view of the first. Output gains \"grown\"/\"preGrowBounds\" fields; "+
		"see featurelab-go/wire's package doc comment (\"Grow-and-regenerate\") for the full contract")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	loaded, err := pack.Load(pf.options())
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}
	for _, w := range loaded.Warnings {
		fmt.Fprintln(os.Stderr, "featurelab: warning: "+w)
	}

	params := wire.GenerateParams{
		Feature: *feature, Rule: *rule, Env: *envName, Origin: *origin, Size: *size,
		BiomeID: *biomeID, Repeat: *repeat, Profile: *profile,
	}
	if *biomeTags != "" {
		for _, part := range strings.Split(*biomeTags, ",") {
			t := strings.TrimSpace(part)
			if t != "" {
				params.BiomeTags = append(params.BiomeTags, t)
			}
		}
	}
	var materials wire.Materials
	haveMaterials := false
	setMaterialString := func(dst **string, value string) {
		if value != "" {
			dst2 := value
			*dst = &dst2
			haveMaterials = true
		}
	}
	setMaterialString(&materials.TopMaterial, *topMaterial)
	setMaterialString(&materials.MidMaterial, *midMaterial)
	setMaterialString(&materials.FoundationMaterial, *foundationMaterial)
	setMaterialString(&materials.SeaFloorMaterial, *seaFloorMaterial)
	setMaterialString(&materials.SeaMaterial, *seaMaterial)
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "seed":
			v := uint32(seedFlag)
			params.Seed = &v
		case "min-y":
			v := minYFlag
			params.MinY = &v
		case "sea-floor-depth":
			v := seaFloorDepthFlag
			materials.SeaFloorDepth = &v
			haveMaterials = true
		case "write-budget":
			v := writeBudgetFlag
			params.WriteBudget = &v
		case "delegation-budget":
			v := delegationBudgetFlag
			params.DelegationBudget = &v
		case "placement-time-limit-ms":
			v := placementTimeLimitMsFlag
			params.PlacementTimeLimitMs = &v
		}
	})
	if haveMaterials {
		params.Materials = &materials
	}

	if *grow {
		grown, err := wire.RunGenerateGrown(loaded, params)
		if err != nil {
			fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
			return 1
		}
		if err := writeJSON(os.Stdout, grown); err != nil {
			fmt.Fprintln(os.Stderr, "featurelab: encoding JSON: "+err.Error())
			return 1
		}
		if diagnosticsHaveError(grown.Diagnostics) {
			return 1
		}
		return 0
	}

	out, err := wire.RunGenerate(loaded, params)
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}
	if err := writeJSON(os.Stdout, out); err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: encoding JSON: "+err.Error())
		return 1
	}
	if diagnosticsHaveError(out.Diagnostics) {
		return 1
	}
	return 0
}

// diagnosticsHaveError reports whether any diagnostic in diags is level "error" -- the SAME gate
// cmdCheck/diagLevelHasError already uses to decide check's exit code, now applied to `generate`
// too (see this package's task notes on exit codes: a one-shot `generate` whose request named an
// identifier the pack does not define, or that hit a write/delegation/time budget, produces at
// least one "error" diagnostic in its own response and must not exit 0 as if it had simply
// succeeded -- check already refuses to look clean in that situation, generate used to). Applied
// uniformly to every "error" diagnostic, not just the unresolved-identifier one added alongside
// this: a single, simple, already-precedented rule ("any error diagnostic fails the run") beats a
// bespoke exemption list that a future diagnostic could silently fall outside of. `serve` never
// calls this -- see methodGenerate/methodGenerateGrown, which return the same Diagnostics inside
// the response body instead of a process exit code, exactly as a long-lived server must.
func diagnosticsHaveError(diags []session.Diagnostic) bool {
	for _, d := range diags {
		if d.Level == "error" {
			return true
		}
	}
	return false
}

// cmdServe implements the `serve` subcommand.
func cmdServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := runServe(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: serve: "+err.Error())
		return 1
	}
	return 0
}

// cmdCheck implements the `check` subcommand: load a pack, print every
// diagnostic as a JSON array, exit non-zero if any is level "error" -- the
// lint/CI entry point.
func cmdCheck(args []string) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	var pf packFlags
	pf.register(fs)
	if err := fs.Parse(args); err != nil {
		return 2
	}

	loaded, err := pack.Load(pf.options())
	if err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
		return 1
	}

	diags := checkPack(loaded)
	if diags == nil {
		diags = []Diagnostic{}
	}
	if err := writeJSON(os.Stdout, diags); err != nil {
		fmt.Fprintln(os.Stderr, "featurelab: encoding JSON: "+err.Error())
		return 1
	}
	if diagLevelHasError(diags) {
		return 1
	}
	return 0
}

// cmdTypes implements the `types` subcommand.
func cmdTypes(args []string) int {
	fs := flag.NewFlagSet("types", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the coverage table as JSON instead of a text table")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *asJSON {
		if err := writeTypesJSON(os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "featurelab: "+err.Error())
			return 1
		}
		return 0
	}
	writeTypesTable(os.Stdout)
	return 0
}

func writeJSON(w *os.File, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
