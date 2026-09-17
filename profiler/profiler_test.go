// profiler_test.go pins this package's accounting.
//
// Driving the whole thing through a real minecraft:aggregate_feature
// resolved out of a shared library map would need InstrumentFeature (see
// profiler.go's header) to wrap a feature in place; it cannot -- it returns
// a NEW wgen.IFeature, so wiring nested resolution through the wrapped
// instance is the INTEGRATOR's job (features/session, both out of this
// package's scope). These tests therefore use small hand-rolled fixtures --
// leafFeature (draws one RNG value, writes one block, never delegates) and
// wrapperFeature (delegates twice into the SAME leaf identifier at the SAME
// unmodified origin, calling profiler.RecordDelegation itself the way a
// correctly wired recursion guard would) -- built directly against this
// package's own public API, so what's actually pinned is the
// profiler's OWN accounting: same definition of a touch, same attribution
// of a write to whichever feature is innermost when it happens, same
// separate counting of delegations vs. entered/blocksWritten.
//
// This is an external (_test package) test file, not an internal one --
// deliberately, so it can import both profiler and volume (volume imports
// profiler for its write hook) without an import cycle; see profiler.go's
// package doc for the volume hook.
//
// The end-to-end check ("same generate() result whether config.profiling is
// on or off") is deliberately NOT here: it requires the session package,
// which is out of scope for this package's own tests.
package profiler_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// recordingRandom returns pre-scripted NextBoolean values in order and logs
// every call, so tests
// can assert the exact RNG call sequence is identical whether a run went
// through InstrumentFeature or not.
type recordingRandom struct {
	calls    []string
	booleans []bool
	seed     uint32
}

func (r *recordingRandom) NextInt() int32 {
	r.calls = append(r.calls, "NextInt")
	return 0
}

func (r *recordingRandom) NextIntBound(bound int) int {
	r.calls = append(r.calls, fmt.Sprintf("NextIntBound(%d)", bound))
	return 0
}

func (r *recordingRandom) NextFloat() float64 {
	r.calls = append(r.calls, "NextFloat")
	return 0
}

func (r *recordingRandom) NextDouble() float64 {
	r.calls = append(r.calls, "NextDouble")
	return 0
}

func (r *recordingRandom) NextUnsignedInt(bound uint32) uint32 {
	r.calls = append(r.calls, "NextUnsignedInt")
	return 0
}

func (r *recordingRandom) NextBoolean() bool {
	r.calls = append(r.calls, "NextBoolean")
	if len(r.booleans) == 0 {
		panic("recordingRandom: out of scripted booleans")
	}
	b := r.booleans[0]
	r.booleans = r.booleans[1:]
	return b
}

// SetSeed/GetSeed exist only to satisfy random.IRandom (widened for
// CaveFeature); nothing in this file's fixtures calls either.
func (r *recordingRandom) SetSeed(seed uint32) {
	r.calls = append(r.calls, "SetSeed")
	r.seed = seed
}

func (r *recordingRandom) GetSeed() uint32 {
	r.calls = append(r.calls, "GetSeed")
	return r.seed
}

var _ random.IRandom = (*recordingRandom)(nil)

const (
	testLeafTypeID    = "test:profiler_leaf"
	testWrapperTypeID = "test:profiler_aggregate_stub"
)

// leafFeature is a minimal leaf that draws exactly one RNG value and writes exactly one block at its
// origin -- deliberately not a composite (never delegates), so it exercises
// the volume's SetBlockAt profiler hook directly, the same way a real
// minecraft:single_block_feature would.
type leafFeature struct {
	identifier string
	stone      block.ID
}

func (f *leafFeature) TypeID() string     { return testLeafTypeID }
func (f *leafFeature) Identifier() string { return f.identifier }

func (f *leafFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	ctx.Random.NextBoolean()
	ctx.API.SetBlock(ctx.Origin, f.stone)
	p := ctx.Origin
	return &p
}

// wrapperFeature stands in for a composite such as
// minecraft:aggregate_feature: it delegates twice into the SAME leaf
// identifier, both times at the unmodified origin, so both delegations
// write the SAME cell -- a hand-checkable "touched twice, by test:leaf"
// scenario. It calls profiler.RecordDelegation itself, exactly the call a
// correctly wired recursion guard makes (see features/shared.go's
// WithRecursionGuard, which this fixture intentionally does not depend on
// -- see this file's header).
type wrapperFeature struct {
	identifier string
	resolve    func(id string) wgen.IFeature
}

func (f *wrapperFeature) TypeID() string     { return testWrapperTypeID }
func (f *wrapperFeature) Identifier() string { return f.identifier }

func (f *wrapperFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	var last *wgen.BlockPos
	for i := 0; i < 2; i++ {
		target := f.resolve("test:leaf")
		profiler.RecordDelegation(f.identifier, f.TypeID())
		last = target.Place(ctx)
	}
	return last
}

func smallVolume(palette *block.Palette) *volume.Volume {
	return volume.New(volume.Bounds{MinX: -4, MinY: 60, MinZ: -4, SizeX: 8, SizeY: 8, SizeZ: 8}, palette, block.AirID)
}

var origin = wgen.BlockPos{X: 0, Y: 64, Z: 0}

func ctxOf(vol *volume.Volume, rnd random.IRandom) *wgen.PlacementContext {
	return &wgen.PlacementContext{API: vol, Origin: origin, Random: rnd, MolangScope: wgen.NewScope()}
}

// buildLibrary constructs a fresh {test:leaf, test:wrapper} pair wired
// through a resolver closure over lib.
func buildLibrary(palette *block.Palette) (lib map[string]wgen.IFeature, stone block.ID) {
	stone = palette.Get("minecraft:stone", nil)
	lib = map[string]wgen.IFeature{}
	leaf := &leafFeature{identifier: "test:leaf", stone: stone}
	wrapper := &wrapperFeature{identifier: "test:wrapper", resolve: func(id string) wgen.IFeature { return lib[id] }}
	lib["test:leaf"] = leaf
	lib["test:wrapper"] = wrapper
	return lib, stone
}

// instrumentLibrary wraps every entry via profiler.InstrumentFeature and
// replaces the map's own values in place -- the arming step an integrator
// performs, adapted for Go's return-a-new-value InstrumentFeature (see
// profiler.go's header): since wrapperFeature.resolve closes over the SAME
// map, replacing
// entries here means every later Resolve (including nested ones) picks up
// the wrapped version.
func instrumentLibrary(lib map[string]wgen.IFeature) {
	for id, feat := range lib {
		lib[id] = profiler.InstrumentFeature(feat)
	}
}

func TestObservesWithoutAlteringControlFlow(t *testing.T) {
	// Plain run -- no instrumentation at all.
	paletteA := block.NewPalette()
	libA, _ := buildLibrary(paletteA)
	volA := smallVolume(paletteA)
	randomA := &recordingRandom{booleans: []bool{true, false}}
	returnedA := libA["test:wrapper"].Place(ctxOf(volA, randomA))

	// Instrumented run -- fresh library/volume/random with the identical
	// script, exactly like an integrator builds a fresh library and
	// instruments it per generate() call.
	paletteB := block.NewPalette()
	libB, _ := buildLibrary(paletteB)
	volB := smallVolume(paletteB)
	randomB := &recordingRandom{booleans: []bool{true, false}}
	profiler.BeginProfiling(len(volB.Data()))
	instrumentLibrary(libB)
	returnedB := libB["test:wrapper"].Place(ctxOf(volB, randomB))
	profiler.EndProfiling()
	if profiler.ProfilingActive {
		t.Fatal("ProfilingActive should be false after EndProfiling")
	}

	if !reflect.DeepEqual(randomB.calls, randomA.calls) {
		t.Errorf("RNG call sequence diverged: plain=%v instrumented=%v", randomA.calls, randomB.calls)
	}
	if !reflect.DeepEqual(volA.Data(), volB.Data()) {
		t.Errorf("blocks written diverged between plain and instrumented runs")
	}
	if !reflect.DeepEqual(returnedA, returnedB) {
		t.Errorf("returned position diverged: plain=%+v instrumented=%+v", returnedA, returnedB)
	}

	// Sanity: the fixture actually exercised the RNG (two NextBoolean calls,
	// one per delegation) -- otherwise an RNG-call-order regression could
	// pass this test vacuously.
	want := []string{"NextBoolean", "NextBoolean"}
	if !reflect.DeepEqual(randomA.calls, want) {
		t.Fatalf("fixture sanity check failed: got calls %v, want %v", randomA.calls, want)
	}
}

func TestCreditsWritesAndDelegations(t *testing.T) {
	palette := block.NewPalette()
	lib, _ := buildLibrary(palette)
	vol := smallVolume(palette)

	profiler.BeginProfiling(len(vol.Data()))
	instrumentLibrary(lib)
	rnd := &recordingRandom{booleans: []bool{true, true}}
	lib["test:wrapper"].Place(ctxOf(vol, rnd))
	profile := profiler.EndProfiling()

	var leafStats, wrapperStats *profiler.FeatureProfileStats
	for i := range profile.Features {
		switch profile.Features[i].Identifier {
		case "test:leaf":
			leafStats = &profile.Features[i]
		case "test:wrapper":
			wrapperStats = &profile.Features[i]
		}
	}
	if leafStats == nil {
		t.Fatal("no stats recorded for test:leaf")
	}
	if wrapperStats == nil {
		t.Fatal("no stats recorded for test:wrapper")
	}

	// The leaf's own Place ran twice and wrote a block each time -- both
	// writes attributed to the LEAF (the innermost frame when SetBlock
	// fired), not to the wrapper delegating into it.
	if leafStats.Entered != 2 {
		t.Errorf("leaf Entered = %d, want 2", leafStats.Entered)
	}
	if leafStats.BlocksWritten != 2 {
		t.Errorf("leaf BlocksWritten = %d, want 2", leafStats.BlocksWritten)
	}
	if leafStats.Delegations != 0 {
		t.Errorf("leaf Delegations = %d, want 0 (a leaf never delegates)", leafStats.Delegations)
	}

	// The wrapper itself never writes a block directly (aggregate_feature
	// is pure control flow) -- zero BlocksWritten, one Entered (single
	// top-level Place call), and exactly two delegations (one per resolved
	// sub-feature reference).
	if wrapperStats.Entered != 1 {
		t.Errorf("wrapper Entered = %d, want 1", wrapperStats.Entered)
	}
	if wrapperStats.BlocksWritten != 0 {
		t.Errorf("wrapper BlocksWritten = %d, want 0", wrapperStats.BlocksWritten)
	}
	if wrapperStats.Delegations != 2 {
		t.Errorf("wrapper Delegations = %d, want 2", wrapperStats.Delegations)
	}

	// Both writes land on the exact same cell (the wrapper re-targets every
	// sub-feature at the SAME unmodified origin) -- touched twice total,
	// both attributed to test:leaf.
	cellIndex := (origin.Y-vol.MinY())*(vol.SizeX()*vol.SizeZ()) + (origin.Z-vol.MinZ())*vol.SizeX() + (origin.X - vol.MinX())
	if got := int(profile.TouchCounts[cellIndex]); got != 2 {
		t.Errorf("touchCounts[%d] = %d, want 2", cellIndex, got)
	}

	leafIndex := -1
	for i, id := range profile.FeatureIdentifiers {
		if id == "test:leaf" {
			leafIndex = i
		}
	}
	if leafIndex < 0 {
		t.Fatal("test:leaf missing from FeatureIdentifiers")
	}
	var attributedCount uint32
	for i := range profile.Attribution.Cell {
		if int(profile.Attribution.Cell[i]) == cellIndex && int(profile.Attribution.Feature[i]) == leafIndex {
			attributedCount = profile.Attribution.Count[i]
		}
	}
	if attributedCount != 2 {
		t.Errorf("attributed count for (cell, test:leaf) = %d, want 2", attributedCount)
	}

	// No other cell was ever touched.
	totalTouched := 0
	for _, c := range profile.TouchCounts {
		if c > 0 {
			totalTouched++
		}
	}
	if totalTouched != 1 {
		t.Errorf("total touched cells = %d, want 1", totalTouched)
	}
}

// TestOffByDefault pins that ProfilingActive starts false and that RecordDelegation no-ops
// cleanly without a matching BeginProfiling call, and that PushFeatureFrame/PopFeatureFrame don't
// panic and don't flip ProfilingActive on -- a basic sanity check that the package's zero value
// matches "profiling off". Push/PopFeatureFrame are NOT full no-ops any more (see profiler.go's
// "Always-on delegation chain" doc comment: they always maintain the identifier/typeID chain
// CurrentChain reads) -- RecordDelegation/RecordWrite are the two hooks that stay a single
// boolean-read no-op when profiling is off.
func TestOffByDefault(t *testing.T) {
	if profiler.ProfilingActive {
		t.Fatal("ProfilingActive must start false")
	}
	profiler.PushFeatureFrame("test:leaf", testLeafTypeID)
	if chain := profiler.CurrentChain(); len(chain) != 1 || chain[0].Identifier != "test:leaf" {
		t.Errorf("CurrentChain() = %+v, want [{test:leaf %s}] -- the chain must be tracked even with profiling off", chain, testLeafTypeID)
	}
	profiler.PopFeatureFrame()
	if chain := profiler.CurrentChain(); len(chain) != 0 {
		t.Errorf("CurrentChain() after the matching pop = %+v, want empty", chain)
	}
	profiler.RecordDelegation("test:wrapper", testWrapperTypeID)
	if profiler.ProfilingActive {
		t.Fatal("ProfilingActive must remain false without a BeginProfiling call")
	}
}

// BenchmarkPushPopFeatureFrame_ProfilingOff measures the ONE hot path this package's doc comment
// ("Always-on delegation chain") admits is not free when profiling is off: every concrete feature
// type's own Place method now calls PushFeatureFrame/PopFeatureFrame unconditionally, so this pair
// runs on every single Place call in every generation run, profiled or not. Compare against
// RecordWrite/RecordDelegation, which stay a single `if !ProfilingActive { return }` (no
// allocation, no append) and are not separately benchmarked here because there is nothing to
// measure beyond "one boolean read" -- this benchmark exists specifically because Push/Pop's cost
// is NOT that trivial, and the task this was built against ("hold this to the same standard [as
// the write hook], and if it is not free, say so with the measurement") requires reporting the
// real number rather than assuming it's negligible.
func BenchmarkPushPopFeatureFrame_ProfilingOff(b *testing.B) {
	if profiler.ProfilingActive {
		b.Fatal("benchmark must run with profiling off")
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		profiler.PushFeatureFrame("bench:feature", "minecraft:bench_feature")
		profiler.PopFeatureFrame()
	}
}

// TestRecordStop_NoOpWhenOff pins that a stop recorded outside a profiling run leaves nothing
// behind for the next one.
func TestRecordStop_NoOpWhenOff(t *testing.T) {
	profiler.PushFeatureFrame("a", "type:a")
	profiler.RecordStop("iterations_zero", "iterations = 0", profiler.NoOrdinal)
	profiler.PopFeatureFrame()

	profiler.BeginProfiling(1)
	profiler.PushFeatureFrame("a", "type:a")
	profiler.PopFeatureFrame()
	result := profiler.EndProfiling()
	if len(result.Features) != 1 || len(result.Features[0].Stops) != 0 {
		t.Errorf("Features = %+v, want a with no stops", result.Features)
	}
}

// TestRecordStop_AggregatesByReasonAndOrdinal pins the aggregation: one row per (reason, ordinal)
// in first-recorded order, the first detail kept, credited to the innermost frame only.
func TestRecordStop_AggregatesByReasonAndOrdinal(t *testing.T) {
	profiler.BeginProfiling(1)
	profiler.RecordStop("chance_zero", "empty stack", profiler.NoOrdinal) // no frame: dropped
	profiler.PushFeatureFrame("outer", "type:outer")
	profiler.PushFeatureFrame("inner", "type:inner")
	profiler.RecordStop("condition_false", "condition = 0 (first)", 2)
	profiler.RecordStop("condition_false", "condition = 0 (second)", 2)
	profiler.RecordStop("condition_false", "condition = 0", 0)
	profiler.RecordStop("iterations_zero", "iterations = 0", profiler.NoOrdinal)
	profiler.RecordStop("condition_false", "condition = 0 (third)", 2)
	profiler.PopFeatureFrame()
	profiler.PopFeatureFrame()
	result := profiler.EndProfiling()

	var inner, outer profiler.FeatureProfileStats
	for _, f := range result.Features {
		if f.Identifier == "inner" {
			inner = f
		} else {
			outer = f
		}
	}
	if len(outer.Stops) != 0 {
		t.Errorf("outer stops = %+v, want none", outer.Stops)
	}
	if len(inner.Stops) != 3 {
		t.Fatalf("inner stops = %+v, want 3 rows", inner.Stops)
	}
	want := []struct {
		reason, detail string
		count, ordinal int
	}{
		{"condition_false", "condition = 0 (first)", 3, 2},
		{"condition_false", "condition = 0", 1, 0},
		{"iterations_zero", "iterations = 0", 1, profiler.NoOrdinal},
	}
	for i, w := range want {
		s := inner.Stops[i]
		ordinal := profiler.NoOrdinal
		if s.Ordinal != nil {
			ordinal = *s.Ordinal
		}
		if s.Reason != w.reason || s.Detail != w.detail || s.Count != w.count || ordinal != w.ordinal {
			t.Errorf("stop %d = %+v (ordinal %d), want %+v", i, s, ordinal, w)
		}
	}

	raw, err := json.Marshal(inner.Stops)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `[{"reason":"condition_false","detail":"condition = 0 (first)","count":3,"ordinal":2},` +
		`{"reason":"condition_false","detail":"condition = 0","count":1,"ordinal":0},` +
		`{"reason":"iterations_zero","detail":"iterations = 0","count":1}]`
	if string(raw) != wantJSON {
		t.Errorf("JSON = %s\nwant   %s", raw, wantJSON)
	}
}

// TestStopCounted_OnlyAsksForTheFirstDetail pins the lazy-detail pattern call sites use.
func TestStopCounted_OnlyAsksForTheFirstDetail(t *testing.T) {
	if !profiler.StopCounted("iterations_zero", profiler.NoOrdinal) {
		t.Error("StopCounted with profiling off must report true (nothing to record)")
	}
	profiler.BeginProfiling(1)
	profiler.PushFeatureFrame("a", "type:a")
	built := 0
	for i := 0; i < 5; i++ {
		if !profiler.StopCounted("iterations_zero", profiler.NoOrdinal) {
			built++
			profiler.RecordStop("iterations_zero", "iterations = 0", profiler.NoOrdinal)
		}
	}
	profiler.PopFeatureFrame()
	result := profiler.EndProfiling()
	if built != 1 {
		t.Errorf("detail built %d times, want 1", built)
	}
	if stops := result.Features[0].Stops; len(stops) != 1 || stops[0].Count != 5 {
		t.Errorf("stops = %+v, want one row counted 5", stops)
	}
}

// TestFeatureProfileStats_OmitsEmptyStops keeps the wire unchanged for a feature that never
// stopped.
func TestFeatureProfileStats_OmitsEmptyStops(t *testing.T) {
	raw, err := json.Marshal(profiler.FeatureProfileStats{Identifier: "a", TypeID: "type:a"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "stops") {
		t.Errorf("JSON = %s, want no stops key", raw)
	}
}

// TestBeginEndProfilingRoundTrip pins BeginProfiling/EndProfiling's own
// bookkeeping in isolation, independent of any feature fixture: touch
// counts, feature identifier indexing, and attribution key decoding.
func TestBeginEndProfilingRoundTrip(t *testing.T) {
	profiler.BeginProfiling(10)
	if !profiler.ProfilingActive {
		t.Fatal("ProfilingActive must be true after BeginProfiling")
	}
	profiler.PushFeatureFrame("a", "type:a")
	profiler.RecordWrite(3)
	profiler.RecordWrite(3)
	profiler.RecordWrite(7)
	profiler.PopFeatureFrame()

	result := profiler.EndProfiling()
	if profiler.ProfilingActive {
		t.Fatal("ProfilingActive must be false after EndProfiling")
	}
	if len(result.TouchCounts) != 10 {
		t.Fatalf("len(TouchCounts) = %d, want 10", len(result.TouchCounts))
	}
	if result.TouchCounts[3] != 2 || result.TouchCounts[7] != 1 {
		t.Errorf("TouchCounts = %v, want [3]=2 [7]=1", result.TouchCounts)
	}
	if len(result.Features) != 1 || result.Features[0].Identifier != "a" || result.Features[0].BlocksWritten != 3 {
		t.Errorf("unexpected Features: %+v", result.Features)
	}
}
