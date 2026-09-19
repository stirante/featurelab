package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// stopsBenchFiles is a scatter of 10,000 iterations into a conditional_list whose only entry is
// gated off, so every iteration takes the condition_false stop -- the densest a stop site gets.
var stopsBenchFiles = []SourceFile{
	{ID: "bench.scatter.json", Text: `{"format_version":"1.21.110","minecraft:scatter_feature":{
		"description":{"identifier":"bench:scatter"},"places_feature":"bench:list",
		"distribution":{"iterations":10000,"x":0,"y":0,"z":0}}}`},
	{ID: "bench.list.json", Text: `{"format_version":"1.21.110","minecraft:conditional_list":{
		"description":{"identifier":"bench:list"},
		"conditional_features":[{"places_feature":"bench:leaf","condition":"v.originx > 1000000"}]}}`},
	{ID: "bench.leaf.json", Text: `{"format_version":"1.21.110","minecraft:single_block_feature":{
		"description":{"identifier":"bench:leaf"},"places_block":"minecraft:stone"}}`},
}

// BenchmarkStopSites times the scatter above three ways. unarmed is the floor: every stop site is
// a single already-false StopsActive branch. stops-only is what an ordinary generate now runs in
// (profiler.BeginStops, no profiling) and is the number that matters -- 10,000 stops per op, the
// densest a stop site gets, against which the tier's per-hit cost has to disappear. profiling=on
// is the old heavyweight tier, unchanged, for comparison.
//
// # Measured
//
//	go test ./features/ -run XXX -bench BenchmarkStopSites -benchtime=300x -count=9
//	go1.26.4, windows/amd64, AMD Ryzen 5 5600X, machine otherwise idle
//
//	unarmed       4.29 ms/op   (9 runs, 4.12 - 4.98)
//	stops-only    4.46 ms/op   (9 runs, 4.07 - 4.87)
//	profiling=on  6.39 ms/op   (9 runs, 5.63 - 7.80)
//
// Medians of nine, spread beside each. -benchtime=300x rather than a duration: letting the
// framework pick its own iteration count made the two cheap rows land on wildly different
// counts and the stops-only median came out a full millisecond high, an artefact that
// disappeared the moment both rows ran the same number of times.
//
// 10,000 refusals per op, so the tier costs (4.46 - 4.29) / 10,000 = ~17 ns per refused gate --
// agreeing with profiler.BenchmarkStopHit's isolated ~15 ns, which is the point of having both.
// In the terms that matter, the densest stop workload anyone can construct pays ~0.17 ms, about
// 4% of that placement, for a preview that can say which gate emptied it. Full profiling, by
// contrast, costs ~2.1 ms on the same run -- an order of magnitude more, which is why it stays
// opt-in and this tier does not.
func BenchmarkStopSites(b *testing.B) {
	palette := block.NewPalette()
	lib := BuildLibrary(stopsBenchFiles, palette, nil)
	feature := lib.Resolve("bench:scatter")
	if feature == nil {
		b.Fatalf("bench:scatter did not resolve: %+v", lib.Diagnostics)
	}
	vol := volume.New(volume.Bounds{SizeX: 1, SizeY: 1, SizeZ: 1}, palette, block.AirID)
	place := func() {
		feature.Place(&wgen.PlacementContext{API: vol, Random: random.New(1), MolangScope: wgen.NewScope()})
	}
	b.Run("unarmed", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			place()
		}
	})
	b.Run("stops-only", func(b *testing.B) {
		profiler.BeginStops()
		defer profiler.EndStops()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			place()
		}
	})
	b.Run("profiling=on", func(b *testing.B) {
		profiler.BeginProfiling(1)
		defer profiler.EndProfiling()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			place()
		}
	})
}

// TestStopSites_ConditionFalseCountsEveryIteration pins the aggregation through a real library:
// 10,000 gated-off entries are one row with the entry's ordinal, not 10,000 rows.
func TestStopSites_ConditionFalseCountsEveryIteration(t *testing.T) {
	palette := block.NewPalette()
	lib := BuildLibrary(stopsBenchFiles, palette, nil)
	feature := lib.Resolve("bench:scatter")
	if feature == nil {
		t.Fatalf("bench:scatter did not resolve: %+v", lib.Diagnostics)
	}
	vol := volume.New(volume.Bounds{SizeX: 1, SizeY: 1, SizeZ: 1}, palette, block.AirID)
	profiler.BeginProfiling(1)
	feature.Place(&wgen.PlacementContext{API: vol, Random: random.New(1), MolangScope: wgen.NewScope()})
	result := profiler.EndProfiling()

	for _, f := range result.Features {
		switch f.Identifier {
		case "bench:list":
			if len(f.Stops) != 1 {
				t.Fatalf("bench:list stops = %+v, want one row", f.Stops)
			}
			s := f.Stops[0]
			if s.Reason != "condition_false" || s.Count != 10000 || s.Ordinal == nil || *s.Ordinal != 0 {
				t.Errorf("bench:list stop = %+v (ordinal %v), want condition_false x10000 at ordinal 0", s, s.Ordinal)
			}
			if s.Detail != "condition = 0, bench:leaf skipped" {
				t.Errorf("detail = %q", s.Detail)
			}
		case "bench:scatter":
			if len(f.Stops) != 0 {
				t.Errorf("bench:scatter stops = %+v, want none -- the stop belongs to the list", f.Stops)
			}
		}
	}
}
