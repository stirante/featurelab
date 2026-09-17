// Command goldengen regenerates a goldentest digest baseline from this
// repo's own Go engine -- the baseline is that engine's own output, not an
// independent authority. See the goldentest package doc comment for exactly
// what that baseline is, and is not, evidence of.
//
// Run it deliberately, from the repo root, whenever a change is meant to
// alter placement behaviour and the new behaviour should become the new
// regression baseline. For the committed fixture pack that TestFixtureDigest
// checks (and that CI runs):
//
//	go run ./goldentest/cmd/goldengen -pack fixture
//
// which writes goldentest/testdata/fixture_placement_digest.json. For the
// pack at $FEATURELAB_PACK_DIR:
//
//	go run ./goldentest/cmd/goldengen -pack external
//
// which writes goldentest/testdata/feature_placement_digest.json (local
// output, not part of the repository). Pass -out to write somewhere else,
// e.g. for a before/after diff without touching the pinned file.
//
// This is deliberately NOT wired into `go test` or any other automated path
// -- a baseline that silently re-pins itself every run proves nothing.
// Before committing a re-pin: diff the old and new digest, and be able to
// name exactly which chains changed and why. If anything changed that you
// can't explain, that's a signal to stop and investigate, not to pin over it.
// Both digests come from identical code -- the only difference is which pack
// is loaded and where the file lands.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/stirante/featurelab/goldentest"
)

// defaultOut is each baseline's pinned digest path, used when -out is not
// given. Keyed by -pack so the two can never be crossed by accident: writing
// one pack's digest over the other's would look like an enormous regression
// the next time either is checked.
var defaultOut = map[string]string{
	"external": "goldentest/testdata/feature_placement_digest.json",
	"fixture":  "goldentest/testdata/fixture_placement_digest.json",
}

func main() {
	packKind := flag.String("pack", "external",
		`which baseline to regenerate: "external" (the pack at $FEATURELAB_PACK_DIR) or "fixture" (the committed public pack at `+
			goldentest.FixturePackRel+", checked by TestFixtureDigest)")
	out := flag.String("out", "",
		"path to write the regenerated digest to (default: the pinned digest for -pack; relative paths resolve against the current working directory -- run from the repo root)")
	flag.Parse()

	if _, ok := defaultOut[*packKind]; !ok {
		fmt.Fprintf(os.Stderr, "goldengen: unknown -pack %q (want \"external\" or \"fixture\")\n", *packKind)
		os.Exit(2)
	}
	if *out == "" {
		*out = defaultOut[*packKind]
	}

	setup := goldentest.SetupHarness
	if *packKind == "fixture" {
		setup = goldentest.SetupFixtureHarness
	}
	h, err := setup()
	if err != nil {
		fmt.Fprintln(os.Stderr, "goldengen: setting up harness:", err)
		os.Exit(1)
	}

	digest, err := goldentest.Regenerate(h)
	if err != nil {
		fmt.Fprintln(os.Stderr, "goldengen: regenerating digest:", err)
		os.Exit(1)
	}

	data, err := json.MarshalIndent(digest, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "goldengen: marshaling digest:", err)
		os.Exit(1)
	}
	data = append(data, '\n')

	if err := os.WriteFile(*out, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "goldengen: writing digest:", err)
		os.Exit(1)
	}

	fmt.Printf("goldengen: wrote %s\n", *out)
	fmt.Printf("  pinnable (features):    %d\n", len(digest.Features))
	fmt.Printf("  not pinnable (budget):  %d\n", len(digest.NotPinnable))
	fmt.Printf("  total in-scope chains:  %d\n", len(digest.Features)+len(digest.NotPinnable))
}
