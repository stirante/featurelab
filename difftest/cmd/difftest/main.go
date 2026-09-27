// Command difftest is the offline half of the feature placement differential test suite:
// it generates the test pack and manifest, runs every test in the engine, turns the game
// runner's dumps into the same metrics, and compares the two sides.
//
//	go run ./difftest/cmd/difftest engine                 # gen + engine side -> difftest/out/engine.json
//	go run ./difftest/cmd/difftest compare --game-dumps difftest/out/game_dumps.jsonl
//
// Subcommands: gen, engine, metrics, compare. Run one with -h for its flags.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/stirante/featurelab/difftest"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "gen":
		err = cmdGen(os.Args[2:])
	case "engine":
		err = cmdEngine(os.Args[2:])
	case "metrics":
		err = cmdMetrics(os.Args[2:])
	case "compare":
		err = cmdCompare(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "difftest:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: difftest <gen|engine|metrics|compare> [flags]
  gen      write the test pack and manifest (difftest/generated)
  engine   gen, then place every test in the engine -> difftest/out/engine.json
  metrics  measure the game runner's dumps -> difftest/out/game.json
  compare  compare engine vs game (results JSON, or --game-dumps) -> report.md + report.json`)
}

func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "difftest")); err == nil {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("run from inside the featurelab-go checkout (no go.mod with a difftest/ beside it above %s)", dir)
		}
		dir = parent
	}
}

func defaultPath(root string, parts ...string) string {
	return filepath.Join(append([]string{root, "difftest"}, parts...)...)
}

// generate writes the pack and manifest and returns the manifest.
func generate(root, outDir string) (*difftest.Manifest, error) {
	cat, err := difftest.BuildCatalog(root)
	if err != nil {
		return nil, err
	}
	packDir := filepath.Join(outDir, "pack")
	if err := os.RemoveAll(packDir); err != nil {
		return nil, err
	}
	paths := make([]string, 0, len(cat.Files))
	for p := range cat.Files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		full := filepath.Join(packDir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(full, cat.Files[p], 0o644); err != nil {
			return nil, err
		}
	}
	m := difftest.NewManifest(cat.Tests)
	if err := writeJSON(filepath.Join(outDir, "manifest.json"), m); err != nil {
		return nil, err
	}
	return m, nil
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func cmdGen(args []string) error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("gen", flag.ExitOnError)
	out := fs.String("out", defaultPath(root, "generated"), "output directory (pack/ and manifest.json)")
	fs.Parse(args)
	m, err := generate(root, *out)
	if err != nil {
		return err
	}
	counts := difftest.TypeCounts(m.Tests)
	fmt.Printf("wrote %s: %d tests over %d feature types\n", *out, len(m.Tests), len(counts))
	for _, ty := range difftest.SortedKeys(counts) {
		fmt.Printf("  %-46s %d\n", ty, counts[ty])
	}
	return nil
}

func cmdEngine(args []string) error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("engine", flag.ExitOnError)
	gen := fs.Bool("gen", true, "regenerate the pack and manifest first")
	genDir := fs.String("generated", defaultPath(root, "generated"), "generated pack + manifest directory")
	out := fs.String("out", defaultPath(root, "out", "engine.json"), "results file")
	seedBase := fs.Uint("seed-base", 1, "first feature seed; placement i uses seedBase + 7919*i + 1")
	repeats := fs.Int("repeats", 0, "placements per test (0 = the manifest's)")
	filter := fs.String("tests", "", "comma-separated substrings of test id/type/group to run (default all)")
	vanilla := fs.String("vanilla-structures", os.Getenv("DIFFTEST_VANILLA_STRUCTURES"),
		"vanilla behaviour pack structures/ directory (for fossil_feature; env DIFFTEST_VANILLA_STRUCTURES)")
	quiet := fs.Bool("quiet", false, "only print the summary")
	dumps := fs.String("dumps", "", "also write every placement's regions here, in the game runner's JSONL shape")
	fs.Parse(args)

	var m difftest.Manifest
	if *gen {
		mm, err := generate(root, *genDir)
		if err != nil {
			return err
		}
		m = *mm
	} else if err := readJSON(filepath.Join(*genDir, "manifest.json"), &m); err != nil {
		return err
	}
	tests := difftest.SelectTests(m.Tests, *filter)
	logf := func(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }
	if *quiet {
		logf = nil
	}
	var dumpFile *os.File
	var dumpTo func(difftest.GameDumpLine)
	if *dumps != "" {
		if dumpFile, err = os.Create(*dumps); err != nil {
			return err
		}
		enc := json.NewEncoder(dumpFile)
		dumpTo = func(l difftest.GameDumpLine) { enc.Encode(l) }
	}
	started := time.Now()
	res, err := difftest.RunEngine(&m, tests, difftest.EngineOptions{
		PackDir: filepath.Join(*genDir, "pack"), ExtraStructures: *vanilla,
		SeedBase: uint32(*seedBase), Repeats: *repeats, Log: logf, Dump: dumpTo,
	})
	if dumpFile != nil {
		if err := dumpFile.Close(); err != nil {
			return err
		}
	}
	if err != nil {
		return err
	}
	if err := writeJSON(*out, res); err != nil {
		return err
	}
	placements := 0
	for _, t := range res.Tests {
		placements += len(t.Placements)
	}
	fmt.Printf("engine: %d tests, %d placements in %s -> %s\n", len(tests), placements, time.Since(started).Round(time.Millisecond), *out)
	fmt.Print(difftest.SummarizeResults(res))
	var notes []string
	for _, id := range difftest.SortedKeys(res.Tests) {
		for _, n := range res.Tests[id].Notes {
			if strings.HasPrefix(n, "[error]") || strings.Contains(n, "did not resolve") || strings.Contains(n, "outside the dump") ||
				strings.Contains(n, "left the engine volume") || strings.Contains(n, "stopped") {
				notes = append(notes, fmt.Sprintf("  %s: %s", id, n))
			}
		}
	}
	if len(notes) > 0 {
		fmt.Printf("notes:\n%s\n", strings.Join(notes, "\n"))
	}
	return nil
}

func loadManifest(root, genDir string) (*difftest.Manifest, error) {
	var m difftest.Manifest
	if err := readJSON(filepath.Join(genDir, "manifest.json"), &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func cmdMetrics(args []string) error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("metrics", flag.ExitOnError)
	genDir := fs.String("generated", defaultPath(root, "generated"), "generated pack + manifest directory")
	dumps := fs.String("dumps", defaultPath(root, "out", "game_dumps.jsonl"), "game runner output")
	out := fs.String("out", defaultPath(root, "out", "game.json"), "results file")
	fs.Parse(args)
	m, err := loadManifest(root, *genDir)
	if err != nil {
		return err
	}
	res, err := difftest.GameResults(m, *dumps)
	if err != nil {
		return err
	}
	if err := writeJSON(*out, res); err != nil {
		return err
	}
	fmt.Printf("game: %d tests measured -> %s\n", len(res.Tests), *out)
	fmt.Print(difftest.SummarizeResults(res))
	return nil
}

func cmdCompare(args []string) error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("compare", flag.ExitOnError)
	genDir := fs.String("generated", defaultPath(root, "generated"), "generated pack + manifest directory")
	enginePath := fs.String("engine", defaultPath(root, "out", "engine.json"), "engine results")
	gamePath := fs.String("game", defaultPath(root, "out", "game.json"), "game results (or another engine run standing in for the game)")
	gameDumps := fs.String("game-dumps", "", "measure this game runner JSONL first instead of reading --game")
	outMD := fs.String("out-md", defaultPath(root, "out", "report.md"), "markdown report")
	outJSON := fs.String("out-json", defaultPath(root, "out", "report.json"), "JSON report")
	fs.Parse(args)
	m, err := loadManifest(root, *genDir)
	if err != nil {
		return err
	}
	var engine, game difftest.Results
	if err := readJSON(*enginePath, &engine); err != nil {
		return err
	}
	gameLabel := *gamePath
	if *gameDumps != "" {
		g, err := difftest.GameResults(m, *gameDumps)
		if err != nil {
			return err
		}
		game = *g
		gameLabel = *gameDumps
	} else if err := readJSON(*gamePath, &game); err != nil {
		return err
	}
	rep := difftest.Compare(m, &engine, &game, *enginePath, gameLabel)
	if err := os.MkdirAll(filepath.Dir(*outMD), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(*outMD, []byte(rep.Markdown()), 0o644); err != nil {
		return err
	}
	if err := writeJSON(*outJSON, rep); err != nil {
		return err
	}
	fmt.Printf("compared %d tests: %d gross, %d significant, %d minor, %d caveat, %d ok, %d missing -> %s\n",
		len(rep.Tests), rep.Counts[difftest.SevGross], rep.Counts[difftest.SevSignificant], rep.Counts[difftest.SevMinor],
		rep.Counts[difftest.SevCaveat], rep.Counts[difftest.SevOK], len(rep.Missing), *outMD)
	for _, t := range rep.Tests {
		if t.Severity == difftest.SevGross && t.Worst != nil {
			fmt.Printf("  GROSS %-40s %-22s %s\n", t.ID, t.Worst.Metric, t.Worst.Reason)
		}
	}
	return nil
}
