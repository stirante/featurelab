package pack

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLoad_OnFileReadIsCalledOncePerFileWithItsKind covers the hook a long-lived server uses to
// say how far along a load is -- see Options.OnFileRead, and cmd/featurelab/notify.go for what
// it is for.
func TestLoad_OnFileReadIsCalledOncePerFileWithItsKind(t *testing.T) {
	dir := t.TempDir()
	writeProgressFile(t, filepath.Join(dir, "features", "a.json"), `{}`)
	writeProgressFile(t, filepath.Join(dir, "features", "nested", "b.json"), `{}`)
	writeProgressFile(t, filepath.Join(dir, "feature_rules", "r.json"), `{}`)
	writeProgressFile(t, filepath.Join(dir, "biomes", "b.json"), `{}`)
	writeProgressFile(t, filepath.Join(dir, "blocks", "x.json"), `{}`)

	counts := map[string]int{}
	var order []string
	loaded, err := Load(Options{Dir: dir, OnFileRead: func(kind string) {
		counts[kind]++
		if len(order) == 0 || order[len(order)-1] != kind {
			order = append(order, kind)
		}
	}})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	want := map[string]int{"features": 2, "feature_rules": 1, "biomes": 1, "blocks": 1}
	for kind, n := range want {
		if counts[kind] != n {
			t.Errorf("OnFileRead(%q) called %d times, want %d", kind, counts[kind], n)
		}
	}
	if counts["structures"] != 0 {
		t.Errorf("OnFileRead(\"structures\") called %d times for a pack with no structures directory", counts["structures"])
	}
	// The hook must count what was actually READ, not what ended up in the Pack: the block list
	// carries the embedded vanilla catalogue as well, and a progress count that included it would
	// jump by hundreds for a pack with one blocks file.
	if len(loaded.Blocks) <= counts["blocks"] {
		t.Fatalf("test assumes the vanilla block catalogue is stacked under the pack's own files")
	}

	// One kind at a time, in Load's own order, so a host can name the phase rather than only a
	// running total.
	if len(order) != 4 {
		t.Errorf("phases = %v, want one run per kind", order)
	}
}

// TestLoad_NoHookIsTheDefault pins that the hook is opt-in: the walkers nil-check rather than
// call through a closure that does nothing, several thousand times per load.
func TestLoad_NoHookIsTheDefault(t *testing.T) {
	dir := t.TempDir()
	writeProgressFile(t, filepath.Join(dir, "features", "a.json"), `{}`)
	if _, err := Load(Options{Dir: dir}); err != nil {
		t.Fatalf("Load with no OnFileRead: %v", err)
	}
}

// TestLoad_OnFileReadCountsBinaryStructuresToo -- structures are walked by a different function
// from the text kinds, and a hook wired into only one of them would under-report exactly the
// packs with the most files.
func TestLoad_OnFileReadCountsBinaryStructuresToo(t *testing.T) {
	dir := t.TempDir()
	writeProgressFile(t, filepath.Join(dir, "structures", "s.mcstructure"), "not really nbt")
	n := 0
	if _, err := Load(Options{Dir: dir, OnFileRead: func(kind string) {
		if kind == "structures" {
			n++
		}
	}}); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if n != 1 {
		t.Errorf("structures counted = %d, want 1", n)
	}
}

func writeProgressFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
