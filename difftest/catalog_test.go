package difftest

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/features"
)

// TestCatalogCoversEveryPublicType: every feature type the engine registers, except the ones
// deliberately out of scope, has at least one differential test.
func TestCatalogCoversEveryPublicType(t *testing.T) {
	cat, err := BuildCatalog("..")
	if err != nil {
		t.Fatal(err)
	}
	counts := TypeCounts(cat.Tests)
	for _, e := range features.FeatureTypeCoverage {
		if e.Status == features.StatusOutOfScope {
			continue
		}
		if counts[e.TypeID] == 0 {
			t.Errorf("no difftest for %s", e.TypeID)
		}
	}
	seen := map[string]bool{}
	for _, tt := range cat.Tests {
		if seen[tt.ID] {
			t.Errorf("duplicate test id %s", tt.ID)
		}
		seen[tt.ID] = true
		if tt.Source == "catalog" {
			if _, ok := cat.Files["features/"+tt.FeatureID[len(Namespace)+1:]+".json"]; !ok {
				t.Errorf("%s: no feature file for %s", tt.ID, tt.FeatureID)
			}
		}
	}
}

// TestGeneratedIsCurrent keeps difftest/generated (which the game side installs as a
// behaviour pack) in step with the catalog: run `go run ./difftest/cmd/difftest gen` after
// changing it.
func TestGeneratedIsCurrent(t *testing.T) {
	cat, err := BuildCatalog("..")
	if err != nil {
		t.Fatal(err)
	}
	norm := func(b []byte) []byte { return bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n")) }
	for path, data := range cat.Files {
		got, err := os.ReadFile(filepath.Join("generated", "pack", filepath.FromSlash(path)))
		if err != nil {
			t.Errorf("%s: %v (regenerate with `go run ./difftest/cmd/difftest gen`)", path, err)
			continue
		}
		if !bytes.Equal(norm(got), norm(data)) {
			t.Errorf("%s is stale (regenerate with `go run ./difftest/cmd/difftest gen`)", path)
		}
	}
}

// TestFillCommandsRespectTheLimit: every /fill the runner sends fits the game's 32768 blocks.
func TestFillCommandsRespectTheLimit(t *testing.T) {
	for _, b := range []Box{box(0, 0, 0, 200, 70, 200), box(0, 0, 0, 10, 10, 10), box(-40, -64, -40, 40, 60, 40)} {
		total := 0
		for _, p := range splitBox(b) {
			if p.Volume() > MaxFillVolume {
				t.Fatalf("piece %v holds %d blocks", p, p.Volume())
			}
			total += p.Volume()
		}
		if total != b.Volume() {
			t.Fatalf("pieces of %v cover %d blocks, want %d", b, total, b.Volume())
		}
	}
}

// TestMetricsOnKnownShape measures a hand-built placement.
func TestMetricsOnKnownShape(t *testing.T) {
	before := &Region{Min: [3]int{0, 0, 0}, Size: [3]int{5, 5, 5}, Names: []string{"minecraft:air", "stone"}, Cells: make([]int32, 125)}
	for i := 0; i < 25; i++ {
		before.Cells[i] = 1 // stone floor at y=0
	}
	after := &Region{Min: before.Min, Size: before.Size,
		Names: []string{"minecraft:air", "minecraft:stone", "oak_leaves", "minecraft:oak_log"},
		Cells: append([]int32(nil), before.Cells...)}
	set := func(x, y, z int, id int32) { after.Cells[(y*5+z)*5+x] = id }
	set(2, 1, 2, 3)
	set(2, 2, 2, 3)
	set(1, 3, 2, 2)
	set(3, 3, 2, 2)
	set(0, 0, 0, 0) // carved
	m, err := ComputeMetrics(before, after, [3]int{2, 1, 2})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{"placed": 4, "removed": 1, "leaves": 2, "logs": 2, "logTop": 1, "top": 2,
		"leafExtent[+2]": 1, "leafWidthX": 3, "clusters": 2, "block:minecraft:oak_leaves": 2, "bbox.dy": 4}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s = %v, want %v", k, m[k], v)
		}
	}
}

// TestCompareFlagsAShift: a clear shift is gross, the same distribution is not.
func TestCompareFlagsAShift(t *testing.T) {
	mk := func(base float64) []Metrics {
		var out []Metrics
		for i := 0; i < 30; i++ {
			out = append(out, Metrics{"success": 1, "leaves": base + float64(i%7)})
		}
		return out
	}
	m := &Manifest{Tests: []*Test{{ID: "a"}, {ID: "b"}}}
	e := &Results{Tests: map[string]*TestResult{"a": {ID: "a", Placements: mk(60)}, "b": {ID: "b", Placements: mk(60)}}}
	g := &Results{Tests: map[string]*TestResult{"a": {ID: "a", Placements: mk(400)}, "b": {ID: "b", Placements: mk(61)}}}
	rep := Compare(m, e, g, "e", "g")
	got := map[string]string{}
	for _, tc := range rep.Tests {
		got[tc.ID] = tc.Severity
	}
	if got["a"] != SevGross || got["b"] != SevOK {
		t.Fatalf("severities = %v, want a gross and b ok", got)
	}
}
