// stops_test.go pins the always-on stop tier (BeginStops/EndStops, StopsActive) that an ordinary
// generate runs in -- the aggregation, the ordering, the two caps, and the fact that a profiled
// run fills BOTH tiers with the same counts. The end-to-end check (a real pack whose scatter
// stops, generated without profiling) lives in session/stops_test.go, which is where a Result is
// in scope.
package profiler_test

import (
	"fmt"
	"testing"

	"github.com/stirante/featurelab/profiler"
)

// hitStop is the call-site idiom every feature uses, verbatim: check the flag, let StopCounted
// claim a repeat hit, and only build a detail for the first one.
func hitStop(reason, detail string, ordinal int) {
	if profiler.StopsActive && !profiler.StopCounted(reason, ordinal) {
		profiler.RecordStop(reason, detail, ordinal)
	}
}

// rowOf returns the single row for (identifier, reason, ordinal), or fails.
func rowOf(t *testing.T, rows []profiler.StopRow, identifier, reason string, ordinal int) profiler.StopRow {
	t.Helper()
	var found []profiler.StopRow
	for _, r := range rows {
		got := profiler.NoOrdinal
		if r.Ordinal != nil {
			got = *r.Ordinal
		}
		if r.Identifier == identifier && r.Reason == reason && got == ordinal {
			found = append(found, r)
		}
	}
	if len(found) != 1 {
		t.Fatalf("rows for (%s, %s, %d) = %+v, want exactly one; all rows: %+v", identifier, reason, ordinal, found, rows)
	}
	return found[0]
}

func TestStops_CountedWithoutProfiling(t *testing.T) {
	profiler.BeginStops()
	profiler.PushFeatureFrame("test:scatter", "minecraft:scatter_feature")
	for i := 0; i < 412; i++ {
		hitStop(profiler.StopIterationsZero, fmt.Sprintf("iterations = 0 (hit %d)", i), profiler.NoOrdinal)
	}
	profiler.PopFeatureFrame()
	rows := profiler.EndStops()

	if profiler.ProfilingActive {
		t.Error("ProfilingActive must stay false -- the stop tier arms nothing else")
	}
	if profiler.StopsActive {
		t.Error("EndStops must disarm StopsActive")
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want exactly one", rows)
	}
	r := rows[0]
	if r.Identifier != "test:scatter" || r.Reason != profiler.StopIterationsZero || r.Count != 412 {
		t.Errorf("row = %+v, want test:scatter/iterations_zero x412", r)
	}
	if r.Detail != "iterations = 0 (hit 0)" {
		t.Errorf("detail = %q, want the FIRST occurrence's", r.Detail)
	}
	if r.Ordinal != nil {
		t.Errorf("ordinal = %d, want omitted for a whole-feature stop", *r.Ordinal)
	}
}

// TestStops_UnarmedRecordsNothing pins the other half of the contract: nothing armed, nothing
// collected -- the cost an ordinary caller that never asks for stops pays is the flag read only.
func TestStops_UnarmedRecordsNothing(t *testing.T) {
	profiler.PushFeatureFrame("test:scatter", "minecraft:scatter_feature")
	hitStop(profiler.StopIterationsZero, "iterations = 0", profiler.NoOrdinal)
	// Even a caller that ignores the flag and records unconditionally must not accumulate state.
	profiler.RecordStop(profiler.StopIterationsZero, "iterations = 0", profiler.NoOrdinal)
	profiler.PopFeatureFrame()

	if rows := profiler.EndStops(); rows != nil {
		t.Errorf("rows = %+v, want none without BeginStops", rows)
	}
}

// TestStops_MergeBySourceReasonOrdinal pins what a row IS: one per (identifier, reason, ordinal),
// merged across separate entries into the same feature, split by every part of the triple.
func TestStops_MergeBySourceReasonOrdinal(t *testing.T) {
	profiler.BeginStops()
	for entry := 0; entry < 2; entry++ {
		// Two separate Place calls on the same feature -- their counts belong to one row.
		profiler.PushFeatureFrame("test:list", "minecraft:conditional_list")
		hitStop(profiler.StopConditionFalse, "condition = 0, entry 0", 0)
		hitStop(profiler.StopConditionFalse, "condition = 0, entry 0 again", 0)
		hitStop(profiler.StopConditionFalse, "condition = 0, entry 1", 1)
		hitStop(profiler.StopUnresolvedReference, "test:missing not found", 0)
		profiler.PushFeatureFrame("test:leaf", "minecraft:single_block_feature")
		hitStop(profiler.StopConditionFalse, "a different feature's", 0)
		profiler.PopFeatureFrame()
		profiler.PopFeatureFrame()
	}
	rows := profiler.EndStops()

	if len(rows) != 4 {
		t.Fatalf("rows = %+v, want 4 distinct (identifier, reason, ordinal) triples", rows)
	}
	if r := rowOf(t, rows, "test:list", profiler.StopConditionFalse, 0); r.Count != 4 ||
		r.Detail != "condition = 0, entry 0" {
		t.Errorf("entry 0 row = %+v, want count 4 and the first detail", r)
	}
	if r := rowOf(t, rows, "test:list", profiler.StopConditionFalse, 1); r.Count != 2 {
		t.Errorf("entry 1 row = %+v, want count 2 -- a different ordinal is a different row", r)
	}
	if r := rowOf(t, rows, "test:list", profiler.StopUnresolvedReference, 0); r.Count != 2 {
		t.Errorf("unresolved row = %+v, want count 2 -- a different reason is a different row", r)
	}
	if r := rowOf(t, rows, "test:leaf", profiler.StopConditionFalse, 0); r.Count != 2 {
		t.Errorf("leaf row = %+v, want count 2 -- the stop belongs to the INNERMOST feature", r)
	}
	// Ordinal 0 must survive as a real 0 rather than vanishing into "whole feature".
	if r := rowOf(t, rows, "test:list", profiler.StopConditionFalse, 0); r.Ordinal == nil || *r.Ordinal != 0 {
		t.Errorf("ordinal = %v, want a present 0", r.Ordinal)
	}
}

// TestStops_HeaviestFirstAndCapped drives far more distinct stops than any real pack can, from
// both directions at once: past the internal tracking cap AND past MaxStopRows.
func TestStops_HeaviestFirstAndCapped(t *testing.T) {
	const distinct = 400
	profiler.BeginStops()
	profiler.PushFeatureFrame("test:many", "minecraft:aggregate_feature")
	for i := 0; i < distinct; i++ {
		for hit := 0; hit <= i; hit++ { // reason i is hit i+1 times
			hitStop(fmt.Sprintf("reason_%03d", i), "first", profiler.NoOrdinal)
		}
	}
	profiler.PopFeatureFrame()
	rows := profiler.EndStops()

	if len(rows) != profiler.MaxStopRows {
		t.Fatalf("len(rows) = %d, want the cap %d", len(rows), profiler.MaxStopRows)
	}
	for i := 1; i < len(rows); i++ {
		if rows[i-1].Count < rows[i].Count {
			t.Fatalf("rows not most-hit first: %+v", rows)
		}
	}
	// The rows that survive are the heaviest ones the store actually tracked -- the tracking cap
	// is high enough that they are genuinely heavy, never a count of one.
	if rows[0].Count <= 1 {
		t.Errorf("heaviest row = %+v, want a real count", rows[0])
	}
}

// TestStops_TiesKeepFirstRecordedOrder pins the sort as stable: equal counts stay in the order
// they were first seen, so a response does not reshuffle between two identical runs.
func TestStops_TiesKeepFirstRecordedOrder(t *testing.T) {
	profiler.BeginStops()
	profiler.PushFeatureFrame("test:many", "minecraft:aggregate_feature")
	for i := 0; i < 5; i++ {
		hitStop(fmt.Sprintf("reason_%d", i), "first", profiler.NoOrdinal)
	}
	profiler.PopFeatureFrame()
	rows := profiler.EndStops()

	for i, r := range rows {
		if want := fmt.Sprintf("reason_%d", i); r.Reason != want {
			t.Fatalf("rows[%d].Reason = %s, want %s (first-recorded order): %+v", i, r.Reason, want, rows)
		}
	}
}

// TestStops_ProfilingFillsBothTiers is the compatibility pin: arming the profiler inside an armed
// stops run leaves profile.features[].stops exactly as it was AND yields the same counts on the
// top-level rows, and ending the profiler does not disarm the stops tier under it.
func TestStops_ProfilingFillsBothTiers(t *testing.T) {
	profiler.BeginStops()
	profiler.BeginProfiling(1)
	profiler.PushFeatureFrame("test:scatter", "minecraft:scatter_feature")
	for i := 0; i < 7; i++ {
		hitStop(profiler.StopIterationsZero, fmt.Sprintf("iterations = 0 (hit %d)", i), profiler.NoOrdinal)
	}
	profiler.PopFeatureFrame()
	result := profiler.EndProfiling()
	if !profiler.StopsActive {
		t.Error("EndProfiling disarmed the stops tier it was nested inside")
	}
	rows := profiler.EndStops()

	if len(result.Features) != 1 || len(result.Features[0].Stops) != 1 {
		t.Fatalf("profile features = %+v, want one feature with one stop", result.Features)
	}
	stat := result.Features[0].Stops[0]
	if stat.Reason != profiler.StopIterationsZero || stat.Count != 7 || stat.Detail != "iterations = 0 (hit 0)" {
		t.Errorf("profile stop = %+v, want iterations_zero x7 with the first detail", stat)
	}
	r := rowOf(t, rows, "test:scatter", profiler.StopIterationsZero, profiler.NoOrdinal)
	if r.Count != stat.Count || r.Detail != stat.Detail {
		t.Errorf("top-level row %+v disagrees with the profile's %+v", r, stat)
	}
}

// TestStops_ProfilingAloneStillRecords pins the tier the profiler has always had: BeginProfiling
// on its own raises StopsActive, so a caller that only ever profiles (this package's own older
// tests, features/stops_test.go) keeps working untouched.
func TestStops_ProfilingAloneStillRecords(t *testing.T) {
	profiler.BeginProfiling(1)
	if !profiler.StopsActive {
		t.Fatal("BeginProfiling must raise StopsActive")
	}
	profiler.PushFeatureFrame("test:scatter", "minecraft:scatter_feature")
	hitStop(profiler.StopChanceZero, "scatter_chance = 0%", profiler.NoOrdinal)
	hitStop(profiler.StopChanceZero, "later detail", profiler.NoOrdinal)
	profiler.PopFeatureFrame()
	result := profiler.EndProfiling()

	if profiler.StopsActive {
		t.Error("EndProfiling must restore StopsActive to what it found")
	}
	if len(result.Features) != 1 || len(result.Features[0].Stops) != 1 ||
		result.Features[0].Stops[0].Count != 2 {
		t.Fatalf("profile features = %+v, want one chance_zero stop counted twice", result.Features)
	}
	// Nothing armed the stops tier, so it collected nothing to hand back.
	if rows := profiler.EndStops(); rows != nil {
		t.Errorf("rows = %+v, want none without BeginStops", rows)
	}
}

// BenchmarkStopHit is the per-hit cost of the always-on tier: one gate refusing over and over,
// which is the only thing arming stops adds to a run (nothing else in the engine touches it).
// unarmed is the same site with the tier off -- the flag read the sites have always done.
//
// # Measured
//
//	go test ./profiler/ -run XXX -bench BenchmarkStopHit -benchtime=2s -count=7
//	go1.26.4, windows/amd64, AMD Ryzen 5 5600X, machine otherwise idle
//
//	unarmed        4.1 ns/op   (7 runs, 3.1 - 4.6)
//	stops-only    19.3 ns/op   (7 runs, 15.0 - 20.8)
//	profiling=on  44.6 ns/op   (7 runs, 41.0 - 89.2)
//
// Medians of seven, with the full spread beside each, because the spread is part of the result
// here: quoting one run of this benchmark as "the" number is not safe. On this same box, with
// other work running alongside it, stops-only read 28 ns and unarmed read 151 ns -- and a
// reading taken that way is what makes two people disagree about a cost neither of them
// measured wrong. Re-measure the same way (idle machine, -count>=5, take the median) before
// treating a new number as a change.
//
// So the always-on tier costs about 15 ns per refused gate, and about 25 ns less than the
// profiling tier it deliberately sits below. features.BenchmarkStopSites puts the same cost in
// a whole placement's terms -- 10,000 refusals in one Place call, the densest a stop site gets,
// moves that call from 4.29 ms to 4.46 ms -- and those two agree: ~0.17 ms / 10,000 is ~17 ns
// each.
//
// # Worth it
//
// Yes, and not marginally. "The preview is empty" is the single most common thing a person
// looks at this tool to explain, and the stop rows are the whole answer to it: which gate said
// no, how many times. Fifteen nanoseconds buys that on every run, with nothing to turn on and
// nothing to reproduce twice -- against a preview that costs milliseconds and a person who
// costs minutes. Making it opt-in would mean the first run of the run that mattered never has
// it, which is exactly when it is needed.
func BenchmarkStopHit(b *testing.B) {
	b.Run("unarmed", func(b *testing.B) {
		profiler.PushFeatureFrame("bench:list", "minecraft:conditional_list")
		defer profiler.PopFeatureFrame()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			hitStop(profiler.StopConditionFalse, "condition = 0", 0)
		}
	})
	b.Run("stops-only", func(b *testing.B) {
		profiler.BeginStops()
		defer profiler.EndStops()
		profiler.PushFeatureFrame("bench:list", "minecraft:conditional_list")
		defer profiler.PopFeatureFrame()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			hitStop(profiler.StopConditionFalse, "condition = 0", 0)
		}
	})
	b.Run("profiling=on", func(b *testing.B) {
		profiler.BeginProfiling(1)
		defer profiler.EndProfiling()
		profiler.PushFeatureFrame("bench:list", "minecraft:conditional_list")
		defer profiler.PopFeatureFrame()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			hitStop(profiler.StopConditionFalse, "condition = 0", 0)
		}
	})
}
