package main

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/stirante/featurelab/features"
)

// TypesOutput is the `types --json` response shape: the full per-type
// coverage table plus the derived summary counts, both taken directly from
// features.FeatureTypeCoverage/CoverageSummary -- the single source of
// truth coverage.go's own doc comment describes.
type TypesOutput struct {
	Summary features.Summary         `json:"summary"`
	Types   []features.CoverageEntry `json:"types"`
}

func typesOutput() TypesOutput {
	return TypesOutput{Summary: features.CoverageSummary(), Types: features.FeatureTypeCoverage}
}

func writeTypesJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(typesOutput())
}

func writeTypesTable(w io.Writer) {
	out := typesOutput()
	fmt.Fprintf(w, "%-55s %-10s %s\n", "TYPE", "STATUS", "NOTE")
	for _, e := range out.Types {
		fmt.Fprintf(w, "%-55s %-10s %s\n", e.TypeID, e.Status, e.Note)
	}
	fmt.Fprintf(w, "\n%d total: %d implemented, %d partial, %d missing, %d out of scope\n",
		out.Summary.Total, out.Summary.Implemented, out.Summary.Partial, out.Summary.Missing, out.Summary.OutOfScope)
}
