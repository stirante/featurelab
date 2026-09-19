package session

// packpaths_test.go pins Config.PackDir: one file, one spelling, whichever command a client asked.
//
// The divergence it closes was visible in one editor window. The graph canvas and `check` said
// `features/broken.json`; the preview's own diagnostics -- which come from this package -- said
// `broken.json`. Neither was wrong by accident, and every client was left to normalise for
// itself.

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/features"
)

// brokenFeatureFiles is one unparseable feature file, placed under a pack root. The file need not
// exist on disk: a pack-relative path is string math over the absolute path the loader recorded.
func brokenFeatureFiles(root string) []features.SourceFile {
	return []features.SourceFile{{
		ID:      "broken.json",
		AbsPath: filepath.Join(root, "features", "broken.json"),
		// A trailing comma, the commonest way a hand-edited pack file stops parsing.
		Text: "{\"format_version\":\"1.21.110\",\"minecraft:single_block_feature\":{\"description\":{\"identifier\":\"test:broken\"},\"places_block\":\"minecraft:gold_block\",}}",
	}}
}

func TestPackDir_DiagnosticsAreSpelledRelativeToThePackRoot(t *testing.T) {
	root := t.TempDir()
	config := voidFeatureConfig(t, "test:broken")
	config.PackDir = root

	result, err := Generate(config, brokenFeatureFiles(root), nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	want := "features/broken.json"
	var sawFile, sawMessage bool
	for _, d := range result.Diagnostics {
		if d.FileID == want {
			sawFile = true
		}
		if d.FileID == "broken.json" {
			t.Errorf("diagnostic still carries the loader's kind-relative id: %+v", d)
		}
		// The file is QUOTED inside the unresolved-identifier message too ("is declared by X"),
		// and a message naming a file differently from the diagnostic beside it reads as being
		// about a different file.
		if strings.Contains(d.Message, "is declared by ") {
			sawMessage = true
			if !strings.Contains(d.Message, want) {
				t.Errorf("message names the file by another spelling: %q", d.Message)
			}
		}
	}
	if !sawFile {
		t.Errorf("no diagnostic spelled %q; got %+v", want, result.Diagnostics)
	}
	if !sawMessage {
		t.Error("no diagnostic quoted the file that could not be loaded -- the fixture stopped being broken")
	}
}

// Left empty, nothing is respelled. Every caller that has only source files and no pack root --
// this package's own tests, the goldentest harness -- goes on seeing exactly what it always saw.
func TestPackDir_UnsetLeavesTheLoaderIDsAlone(t *testing.T) {
	root := t.TempDir()
	config := voidFeatureConfig(t, "test:broken")

	result, err := Generate(config, brokenFeatureFiles(root), nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	var saw bool
	for _, d := range result.Diagnostics {
		if d.FileID == "broken.json" {
			saw = true
		}
	}
	if !saw {
		t.Errorf("no diagnostic carried the bare loader id; got %+v", result.Diagnostics)
	}
}

// PackDiagnosticsByKind is deliberately NOT respelled: its one caller asks for these by kind
// precisely so it can respell them itself, and doing it twice would be a second place for the
// rule to live.
func TestPackDir_ByKindDiagnosticsKeepTheLoaderIDs(t *testing.T) {
	root := t.TempDir()
	ws := NewWorkspace(brokenFeatureFiles(root), nil, nil, nil, nil)
	config := voidFeatureConfig(t, "test:broken")
	config.PackDir = root
	if _, err := ws.Generate(config); err != nil {
		t.Fatalf("Generate: %v", err)
	}

	byKind := ws.PackDiagnosticsByKind()
	if len(byKind.Features) == 0 {
		t.Fatal("no feature diagnostics for an unparseable feature file")
	}
	for _, d := range byKind.Features {
		if d.FileID != "broken.json" {
			t.Errorf("fileId = %q, want the loader's own id -- this accessor hands over the kind, not the path", d.FileID)
		}
	}
}
