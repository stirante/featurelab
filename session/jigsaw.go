package session

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/jigsaw"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wgen"
)

func buildJigsawLibrary(palette *block.Palette, templates *structures.Library, featureLib *features.Library, sources []jigsaw.Sources) *jigsaw.Library {
	var src jigsaw.Sources
	if len(sources) > 0 {
		src = sources[0]
	}
	lib := jigsaw.BuildLibrary(src, palette)
	var resolver wgen.FeatureResolver
	if featureLib != nil {
		resolver = featureLib
	}
	lib.Diagnostics = append(lib.Diagnostics, lib.Check(templates, resolver)...)
	return lib
}

func convertJigsawDiagnostics(in []jigsaw.Diagnostic) []Diagnostic {
	out := make([]Diagnostic, len(in))
	for i, d := range in {
		out[i] = Diagnostic{Level: d.Level, FileID: d.FileID, Scope: ScopePack, Count: 1, Message: d.Message}
	}
	return out
}

// jigsawDimensionHeight is the world height assembly checks against. It is the dimension's, not
// the bench volume's, because the height limits decide which pieces fit and so change the draws.
func jigsawDimensionHeight(environment env.EnvironmentID) (minY, maxY int) {
	switch environment {
	case env.EnvNether:
		return 0, 128
	case env.EnvEnd:
		return 0, 256
	}
	return -64, 320
}

func describeJigsawStructures(lib *jigsaw.Library) string {
	identifiers := lib.Identifiers()
	if len(identifiers) == 0 {
		return "none"
	}
	return fmt.Sprintf("%d: %s", len(identifiers), strings.Join(identifiers, ", "))
}
