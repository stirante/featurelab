package genvanillablocks

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// realConfig builds a Config against the actual checked-in
// inputs (scripts/vanilla-extract/...), the same ones cmd/genvanillablocks
// defaults to, writing into out. Paths are relative to this package's own
// directory (go test's working directory), not the repo root.
func realConfig(out string) Config {
	return Config{
		IDsPath:      filepath.Join("..", "..", "scripts", "vanilla-extract", "blockcolor_extract.json"),
		ColorsPath:   filepath.Join("..", "..", "scripts", "vanilla-extract", "name_color_v2.json"),
		PalettePath:  filepath.Join("..", "..", "scripts", "vanilla-extract", "mapcolor_palette.json"),
		RPBlocksPath: filepath.Join("..", "..", "scripts", "vanilla-extract", "rp", "rp_blocks.json"),
		OutputDir:    out,
	}
}

// TestGenerate_Deterministic is the generator's own determinism guarantee:
// running Generate twice from the identical, unmodified inputs
// must produce byte-identical output -- same file set, same bytes in every
// file, right down to JSON key order (json.MarshalIndent's map key
// ordering, sort.Strings(ordered) driving file iteration order) -- since a
// re-run that reformats or reorders even one existing block's JSON would
// show up as pack-wide, unreviewable churn in block/vanilla/ on every
// regeneration.
func TestGenerate_Deterministic(t *testing.T) {
	outA := filepath.Join(t.TempDir(), "a")
	outB := filepath.Join(t.TempDir(), "b")

	summaryA, err := Generate(realConfig(outA))
	if err != nil {
		t.Fatalf("Generate (run A): %v", err)
	}
	summaryB, err := Generate(realConfig(outB))
	if err != nil {
		t.Fatalf("Generate (run B): %v", err)
	}
	if summaryA != summaryB {
		t.Fatalf("Summary differs between runs: A=%+v B=%+v", summaryA, summaryB)
	}
	if summaryA.Blocks == 0 {
		t.Fatal("Generate produced 0 blocks -- test cannot tell a real determinism failure from a degenerate empty run")
	}

	filesA := collectFiles(t, outA)
	filesB := collectFiles(t, outB)
	if len(filesA) != len(filesB) {
		t.Fatalf("file count differs: A=%d B=%d", len(filesA), len(filesB))
	}
	for i, relA := range filesA {
		relB := filesB[i]
		if relA != relB {
			t.Fatalf("file set differs at index %d: A has %q, B has %q", i, relA, relB)
		}
		bytesA, err := os.ReadFile(filepath.Join(outA, relA))
		if err != nil {
			t.Fatalf("reading run A's %s: %v", relA, err)
		}
		bytesB, err := os.ReadFile(filepath.Join(outB, relB))
		if err != nil {
			t.Fatalf("reading run B's %s: %v", relB, err)
		}
		if string(bytesA) != string(bytesB) {
			t.Fatalf("%s differs between run A and run B -- generator is not deterministic:\n--- A ---\n%s\n--- B ---\n%s", relA, bytesA, bytesB)
		}
	}
}

// collectFiles walks root and returns every regular file's path relative
// to root, forward-slashed and sorted, mirroring pack.Load's own walk
// convention closely enough for a straightforward two-tree comparison.
func collectFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	sort.Strings(out)
	return out
}
