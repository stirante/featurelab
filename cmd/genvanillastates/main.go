package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/stirante/featurelab/internal/genvanillastates"
)

func main() {
	registry := flag.String("registry", "", "block-state registry JSON (required; schema in internal/genvanillastates)")
	out := flag.String("out", "block/vanilla_states_table.go", "generated Go catalogue")
	flag.Parse()

	if *registry == "" {
		fmt.Fprintln(os.Stderr, "genvanillastates: -registry is required")
		os.Exit(2)
	}
	summary, err := genvanillastates.Generate(genvanillastates.Config{
		RegistryPath: *registry,
		OutputPath:   *out,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "genvanillastates:", err)
		os.Exit(1)
	}
	fmt.Printf("generated %d block types (%d declaring states, %d declarations, %d distinct states)\n",
		summary.Blocks, summary.WithStates, summary.Declarations, summary.States)
}
