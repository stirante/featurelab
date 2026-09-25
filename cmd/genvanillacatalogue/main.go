// Command genvanillacatalogue regenerates block/vanilla_catalogue_table.go from
// the embedded vanilla block catalogue. Run it through `go generate ./block`
// after the catalogue changes (cmd/genvanillablocks); the staleness test in
// internal/genvanillacatalogue fails until it has been.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/internal/genvanillacatalogue"
)

func main() {
	out := flag.String("out", "block/vanilla_catalogue_table.go", "generated Go table")
	flag.Parse()

	src, err := genvanillacatalogue.Render(block.DefaultBlocks())
	if err != nil {
		fmt.Fprintln(os.Stderr, "genvanillacatalogue:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, src, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "genvanillacatalogue:", err)
		os.Exit(1)
	}
}
