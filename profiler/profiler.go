// Package profiler is a per-run worldgen profiler: counts how many times
// each cell is written, by which feature, and totals entered/blocksWritten/
// delegations/self+inclusive time per feature identifier. Off by default
// (see ProfilingActive) -- every hot path this touches (volume.Volume's
// SetBlockAt, features' WithRecursionGuard) is guarded by reading
// ProfilingActive directly (a package-level var, not a function call) so
// the disabled cost of those TWO hooks is one boolean read and a branch not
// taken -- no allocation, no map lookup, no time.Now() call.
//
// See the "## Attribution model" section below for how a write gets
// attributed to the right feature, and "## Always-on delegation chain" for
// the one hot path that is deliberately NOT free when profiling is off,
// with the measured cost to prove it.
//
// ## Attribution model
//
// The obvious design instruments only when profiling is enabled: wrap every
// feature instance the library built by MUTATING its own place method, so
// every existing reference to that instance (a resolver's internal map, a
// composite's captured target) transparently sees the wrapped version.
//
// Go has no equivalent of mutating an interface value's method set in
// place. An earlier version of this package worked around that with
// InstrumentFeature (below): wrap a feature in a NEW wgen.IFeature whose
// Place brackets the call with PushFeatureFrame/PopFeatureFrame, and have
// features.Library.ArmProfiling replace every entry in its resolver map
// with the wrapped version so nested Resolve calls picked it up too. That
// mechanism is GONE now: it only ever ran when profiling was requested, so
// the delegation chain -- needed for every diagnostic naming which nested
// feature actually failed, not just the root one -- did not exist with
// profiling off. Re-arming a cached, reused features.Library (session/
// workspace.go's whole reason to exist) on every call would also have
// double-wrapped it, corrupting counts; the actual old code dodged that by
// throwaway-rebuilding the library whenever profiling was on, paying a real
// parse cost every "serve" generate call that asked for it.
//
// Every concrete feature type's own Place method (features/*.go) now calls
// PushFeatureFrame/PopFeatureFrame directly, as its own first and last
// actions -- which buys the same attribution without needing a wrapper at
// all, since there is no wrapping: the call is simply always there. InstrumentFeature is kept only as a small standalone utility (this
// package's own tests use it to bracket a hand-rolled fixture without
// depending on the features package) -- production code no longer calls it.
//
// Once a call is correctly bracketed by PushFeatureFrame/PopFeatureFrame
// and composite delegation calls RecordDelegation, the accounting below
// gives an exact call stack: whichever feature's Place is actually running
// when RecordWrite fires is the one credited with the write -- a leaf
// feature invoked through three levels of aggregate/scatter/weighted_random
// gets its own writes attributed to it, not to its outermost ancestor.
//
// RecordDelegation records one "delegation" per guarded call, attributed to
// the WRAPPER (the composite doing the delegating, i.e. its own `this`/
// receiver) -- distinct from entered/blocksWritten/self time, which come
// from Push/PopFeatureFrame. A wrapper that delegates 900k times without
// ever writing a block shows up heavy on Delegations, not on
// BlocksWritten -- that distinction is the whole point (see the task this
// was built against: "a wrapper that delegates 900k times is a different
// problem from a leaf that writes 900k blocks"). RecordDelegation stays
// gated on ProfilingActive -- delegation counts are a profiling-only
// statistic, not part of the always-on chain.
//
// ## Always-on delegation chain
//
// A diagnostic raised deep inside a delegation chain (features/shared.go's
// LogFailure, a budget-exceeded panic) needs to say not just what failed
// but the full root-to-leaf path that reached it -- and it needs that
// EQUALLY with profiling off, since arming full profiling (BeginProfiling's
// touchCounts array sized to the whole volume, plus a stats map) is not
// something a normal, non-diagnostic run should have to pay for just to get
// a readable failure message.
//
// PushFeatureFrame/PopFeatureFrame below therefore split into two tiers:
// the identifier+typeID pair is pushed/popped onto `stack` UNCONDITIONALLY
// (a two-string struct append/truncate), and CurrentChain reads that stack
// at any point -- including profiling off. The heavier bookkeeping (the
// statsByIdentifier map lookup, Entered++, time.Now()/time.Since() for
// self/inclusive timing, the cellAttribution map RecordWrite touches) stays
// exactly as gated on ProfilingActive as it always was.
//
// This means the frame stack is NOT free when profiling is off, unlike
// RecordWrite/RecordDelegation's single boolean check -- something has to
// run on every Place call to keep the chain accurate, and an append/defer
// pair is the cheapest mechanism available without reintroducing the
// wrapping this package just got rid of. Measured cost (profiler_test.go's
// BenchmarkPushPopFeatureFrame_ProfilingOff, AMD Ryzen 5 5600X, go test
// -bench, profiling off throughout): a PushFeatureFrame/PopFeatureFrame
// pair costs roughly 15-20ns -- one small struct literal, one slice
// append, one slice truncate, no map lookup, no time.Now() call. Small
// next to a single map lookup (tens of ns), and did not move goldentest's
// BenchmarkScatterPlacement (a real placement through this exact code
// path) outside that benchmark's own run-to-run noise band: ~19-27us/op
// before this change, ~16-19us/op after, across several 3-second runs --
// i.e. this pair's ~15-20ns is roughly 0.1% of one ordinary placement's
// total cost. Reported honestly, measured, rather than assumed free.
//
// ## Stops
//
// RecordStop credits the innermost frame with a gate that ended its work early (an iterations
// expression that rounded to 0, a conditional_list entry whose condition was 0, a biome filter
// that rejected), aggregated into FeatureProfileStats.Stops.
//
// Stops are the one thing here an ORDINARY run needs: "placed nothing" is only actionable once
// something says which gate said no. They therefore have their own arming tier, independent of
// full profiling -- BeginStops/EndStops, gated by StopsActive, which every stop site reads
// INSTEAD of ProfilingActive (BeginProfiling raises StopsActive too, so a profiled run fills both
// stores and profile.features[].stops keeps its exact former contents).
//
// The stops tier costs what full profiling deliberately does not: no touchCounts array sized to
// the volume, no per-cell attribution map, no stats map, no time.Now(). All it keeps is one flat
// slice of (identifier, reason, ordinal) rows, appended to at most maxTrackedStopRows times and
// searched hint-first, so a gate that trips a million times is one integer increment per trip
// after the first. An unarmed run is unchanged: one already-false boolean read at each site.
//
// Measured, not assumed: a refused gate costs ~4 ns with the tier off and ~19 ns with it on, so
// arming it adds ~15 ns per refusal -- and a placement that refuses 10,000 times, the densest
// case that can be built, goes from 4.29 ms to 4.46 ms. Full profiling on that same placement
// costs ~2.1 ms more, an order of magnitude above this, which is the whole reason the two tiers
// are separate and only this one is always on. Both numbers, their spread, and how to reproduce
// them are in the benchmarks themselves: BenchmarkStopHit (stops_test.go, this package) and
// features.BenchmarkStopSites.
package profiler

import (
	"fmt"
	"sort"
	"time"

	"github.com/stirante/featurelab/rle"
	"github.com/stirante/featurelab/wgen"
)

// FeatureProfileStats is one feature identifier's accumulated stats for a
// profiling run.
type FeatureProfileStats struct {
	Identifier string `json:"identifier"`
	TypeID     string `json:"typeId"`
	// Entered is the number of times this feature's Place was actually
	// invoked (top-level or nested).
	Entered int `json:"entered"`
	// BlocksWritten is blocks written while this feature's Place was the
	// innermost one executing.
	BlocksWritten int `json:"blocksWritten"`
	// Delegations is the number of times THIS feature, as a composite,
	// delegated into a sub-feature via a recursion guard -- includes
	// delegations whose target ultimately wrote nothing.
	Delegations int `json:"delegations"`
	// SelfMs is wall-clock time spent in this feature's own Place body,
	// excluding time spent in nested Place calls (those are attributed to
	// the nested feature's own self time).
	SelfMs float64 `json:"selfMs"`
	// InclusiveMs is wall-clock time from entry to return of this
	// feature's Place, including nested calls.
	InclusiveMs float64 `json:"inclusiveMs"`
	// Stops is every place this feature declined to go on -- a gate that
	// evaluated against it, a reference that did not resolve -- one row per
	// distinct (reason, ordinal), in first-recorded order. See RecordStop.
	Stops []StopStat `json:"stops,omitempty"`
}

// StopStat is one kind of early stop inside one feature, aggregated over the
// run.
type StopStat struct {
	// Reason is a stable code: chance_zero, chance_failed, iterations_zero,
	// condition_false, biome_filter_rejected, height_difference_rejected,
	// surface_threshold_rejected, search_exhausted, no_surface,
	// no_selection, sequence_first_failure, unresolved_reference,
	// recursion_guard.
	Reason string `json:"reason"`
	// Detail is the FIRST occurrence's human-readable explanation, with the
	// value that was evaluated ("iterations = 0 (from 0.3)"). Later
	// occurrences only add to Count.
	Detail string `json:"detail"`
	Count  int    `json:"count"`
	// Ordinal is the entry index the stop applies to (a conditional_list
	// entry, a sequence position), or nil when it applies to the whole
	// feature. A pointer so a real index of 0 is still encoded.
	Ordinal *int `json:"ordinal,omitempty"`
}

// StopRow is one aggregated stop on the top-level `stops` array an ordinary generate response
// carries (session.Result.Stops) -- a StopStat plus the identifier of the feature the stop was
// credited to, since that array is flat rather than nested under a per-feature row the way
// ProfileResult.Features is. Rows are merged by (identifier, reason, ordinal) with summed counts
// and the FIRST detail, heaviest first; see EndStops.
type StopRow struct {
	Identifier string `json:"identifier"`
	Reason     string `json:"reason"`
	Detail     string `json:"detail"`
	Count      int    `json:"count"`
	// Ordinal is the entry index the stop applies to, omitted when it applies to the whole
	// feature -- same meaning and same pointer-so-zero-encodes reason as StopStat.Ordinal.
	Ordinal *int `json:"ordinal,omitempty"`
}

// Stop reason codes, as StopStat.Reason carries them on the wire. Declared here, once, so the
// features that record a stop name a constant rather than repeating a string.
const (
	StopChanceZero               = "chance_zero"
	StopChanceFailed             = "chance_failed"
	StopIterationsZero           = "iterations_zero"
	StopConditionFalse           = "condition_false"
	StopBiomeFilterRejected      = "biome_filter_rejected"
	StopHeightDifferenceRejected = "height_difference_rejected"
	StopSurfaceThresholdRejected = "surface_threshold_rejected"
	StopSearchExhausted          = "search_exhausted"
	StopNoSurface                = "no_surface"
	StopNoSelection              = "no_selection"
	StopSequenceFirstFailure     = "sequence_first_failure"
	StopUnresolvedReference      = "unresolved_reference"
	StopRecursionGuard           = "recursion_guard"
)

// NoOrdinal is RecordStop's "applies to the whole feature" ordinal.
const NoOrdinal = -1

// CellAttribution is sparse per-cell attribution as three parallel slices:
// entry i means feature FeatureIdentifiers[Feature[i]] wrote cell Cell[i],
// Count[i] times.
type CellAttribution struct {
	Cell    []uint32 `json:"cell"`
	Feature []uint16 `json:"feature"`
	Count   []uint32 `json:"count"`
}

// ProfileResult is everything collected between a BeginProfiling/
// EndProfiling pair.
type ProfileResult struct {
	// TouchCounts uses the same indexing as the volume's own data slice --
	// total writes per cell while profiling was active (i.e. during
	// feature/rule placement, not a one-off environment build that runs
	// before any feature frame is pushed).
	//
	// Run-length encoded on the wire (see CellCounts and package
	// featurelab-go/rle): this is the single largest field a response can
	// carry -- 10.6 MB of JSON at 96x384x96 -- and on a typical run it is
	// one long run of zeros with a few touched cells in it. In Go it is an
	// ordinary []uint32 and indexes as one.
	TouchCounts CellCounts `json:"touchCounts"`
	// FeatureIdentifiers is index -> identifier, referenced by
	// Attribution.Feature -- kept separate from Features below because
	// that slice is a display concern to re-sort (heaviest-first etc.).
	FeatureIdentifiers []string `json:"featureIdentifiers"`
	// Features is one row per feature identifier entered at least once
	// this run, in first-entered order (unsorted -- heaviest-first sorting
	// is a display concern).
	Features    []FeatureProfileStats `json:"features"`
	Attribution CellAttribution       `json:"attribution"`
}

// ProfilingActive is read directly (not via a function call) on the hot
// paths this profiler instruments -- see this package's doc comment.
// Mutated only by BeginProfiling/EndProfiling. Not safe for concurrent
// generation runs: one profiling run at a time, package-level state.
var ProfilingActive = false

// StopsActive gates stop recording, and is what every stop site reads (directly, not via a
// function call, for the same reason ProfilingActive is) before building a detail string -- see
// this package's "## Stops" doc comment. Raised by BeginStops, and also by BeginProfiling (which
// restores whatever it found on EndProfiling, so the two tiers nest in either order). Mutated
// only by those four functions.
var StopsActive = false

type frame struct {
	identifier string
	typeID     string
	// featureIndex/startedAt/childMs are meaningful only while ProfilingActive was true at Push
	// time -- see this package's "Always-on delegation chain" doc comment. PushFeatureFrame
	// leaves them zero-valued when profiling is off, so the only per-call cost with profiling off
	// is the identifier/typeID struct literal itself and the stack append/truncate.
	featureIndex int
	startedAt    time.Time
	// childMs is elapsed time already credited to nested frames,
	// subtracted from this frame's own elapsed time at pop to get its
	// self time.
	childMs float64
}

// ChainFrame is one entry in the delegation chain CurrentChain returns -- a feature's identifier
// and type, root-first. Tagged for the wire contract (featurelab-go/wire's package doc comment)
// since a session.Diagnostic's chain is built directly from this.
type ChainFrame struct {
	Identifier string `json:"identifier"`
	TypeID     string `json:"typeId"`
}

// attributionKeySpan is the stride of the flat attribution key: distinct
// (cell, feature) pairs are tracked in one map keyed by
// cell*attributionKeySpan + featureIndex rather than a nested map, one hash
// op per write instead of two. 2^20 comfortably exceeds any real pack's
// feature count.
const attributionKeySpan = int64(1) << 20

var (
	stack              []frame
	statsByIdentifier  = map[string]*FeatureProfileStats{}
	featureIndexOf     = map[string]int{}
	featureIdentifiers []string
	touchCounts        []uint32
	cellAttribution    map[int64]uint32
)

// stopEntry is one row of the always-on stops store -- the light tier's entire state. Ordinal is
// a plain int here (NoOrdinal for "whole feature") rather than StopStat's pointer: nothing
// escapes to JSON until EndStops converts it, so the store itself stays allocation-free.
type stopEntry struct {
	identifier string
	reason     string
	detail     string
	ordinal    int
	count      int
}

var (
	// lightStops is append-only within one BeginStops/EndStops pair, so a *stopEntry taken by
	// findLightStop stays valid for as long as its caller holds it (no append in between).
	lightStops []stopEntry
	// lightStopHint is the index of the last row hit. A gate that trips in a loop hits the same
	// row every time, so checking this first turns the usual case into one compare.
	lightStopHint int
	// stopsActiveBeforeProfiling is what EndProfiling restores StopsActive to -- so a profiled
	// run nested inside an armed stops run (session.generate's ordering) does not disarm the
	// outer one when it ends.
	stopsActiveBeforeProfiling bool
)

// MaxStopRows caps the top-level `stops` array EndStops returns. A pathological pack can stop at
// hundreds of distinct gates; a response is not the place to enumerate them, and a reader only
// ever acts on the heaviest few (the preview panel shows one line and "(+N more)").
const MaxStopRows = 32

// maxTrackedStopRows caps the store itself, so a run that somehow reaches thousands of DISTINCT
// (identifier, reason, ordinal) triples cannot grow the slice (or the scan) without bound. Well
// above any real pack's distinct-gate count, and far enough above MaxStopRows that the rows that
// survive the sort are the true heaviest ones.
const maxTrackedStopRows = 256

// BeginStops arms the cheap, always-on stop tier for one run: from here until EndStops, every
// stop site records into the flat store described in this package's "## Stops" doc comment.
// Unlike BeginProfiling it allocates nothing up front and is independent of it -- both may be
// armed at once (see StopsActive).
func BeginStops() {
	lightStops = lightStops[:0]
	lightStopHint = 0
	StopsActive = true
}

// EndStops disarms the stops tier and returns its rows: merged by (identifier, reason, ordinal)
// with summed counts and the first detail (the merge happens at record time), ordered most-hit
// first with ties in first-recorded order, and capped at MaxStopRows. nil when nothing stopped.
func EndStops() []StopRow {
	StopsActive = false
	entries := lightStops
	lightStops = nil
	lightStopHint = 0
	if len(entries) == 0 {
		return nil
	}
	rows := make([]StopRow, len(entries))
	for i, e := range entries {
		rows[i] = StopRow{Identifier: e.identifier, Reason: e.reason, Detail: e.detail, Count: e.count}
		if e.ordinal != NoOrdinal {
			o := e.ordinal
			rows[i].Ordinal = &o
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Count > rows[j].Count })
	if len(rows) > MaxStopRows {
		rows = rows[:MaxStopRows]
	}
	return rows
}

// findLightStop returns the store's row for this triple, or nil if it has none.
func findLightStop(identifier, reason string, ordinal int) *stopEntry {
	if lightStopHint < len(lightStops) {
		if e := &lightStops[lightStopHint]; e.ordinal == ordinal && e.reason == reason && e.identifier == identifier {
			return e
		}
	}
	for i := range lightStops {
		if e := &lightStops[i]; e.ordinal == ordinal && e.reason == reason && e.identifier == identifier {
			lightStopHint = i
			return e
		}
	}
	return nil
}

// findStopStat is findLightStop for one feature's profiling-tier rows.
func findStopStat(stats *FeatureProfileStats, reason string, ordinal int) *StopStat {
	// Linear: a feature has a handful of distinct stop kinds at most.
	for i := range stats.Stops {
		if s := &stats.Stops[i]; s.Reason == reason && ordinalOf(s) == ordinal {
			return s
		}
	}
	return nil
}

func statsFor(identifier, typeID string) *FeatureProfileStats {
	s, ok := statsByIdentifier[identifier]
	if !ok {
		s = &FeatureProfileStats{Identifier: identifier, TypeID: typeID}
		statsByIdentifier[identifier] = s
		featureIndexOf[identifier] = len(featureIdentifiers)
		featureIdentifiers = append(featureIdentifiers, identifier)
	}
	return s
}

// BeginProfiling arms the profiler for one generation run. cellCount should
// be len(volume.Data()) / the volume's total cell count. Pairs with
// EndProfiling.
func BeginProfiling(cellCount int) {
	stack = nil
	statsByIdentifier = map[string]*FeatureProfileStats{}
	featureIndexOf = map[string]int{}
	featureIdentifiers = nil
	touchCounts = make([]uint32, cellCount)
	cellAttribution = map[int64]uint32{}
	ProfilingActive = true
	// A profiled run records into BOTH stop tiers, so profile.features[].stops and the top-level
	// rows say the same thing. An ALREADY-armed stops tier (session.generate arms one for every
	// run) is left exactly as it is -- not reset, not disarmed on the way out -- so profiling
	// nested inside it neither loses its rows nor ends its run early.
	stopsActiveBeforeProfiling = StopsActive
	if !StopsActive {
		BeginStops()
	}
}

// EndProfiling disarms the profiler and returns everything collected since
// the matching BeginProfiling call.
func EndProfiling() ProfileResult {
	ProfilingActive = false
	// Only the tier BeginProfiling itself armed is torn down here; one it merely joined keeps
	// both its flag and its rows, and ends on its own EndStops.
	if !stopsActiveBeforeProfiling {
		lightStops = nil
		lightStopHint = 0
	}
	StopsActive = stopsActiveBeforeProfiling
	tc := touchCounts
	if tc == nil {
		tc = []uint32{}
	}
	attr := cellAttribution
	if attr == nil {
		attr = map[int64]uint32{}
	}
	cell := make([]uint32, len(attr))
	feature := make([]uint16, len(attr))
	count := make([]uint32, len(attr))
	i := 0
	for key, c := range attr {
		cell[i] = uint32(key / attributionKeySpan)
		feature[i] = uint16(key % attributionKeySpan)
		count[i] = c
		i++
	}
	features := make([]FeatureProfileStats, 0, len(featureIdentifiers))
	for _, id := range featureIdentifiers {
		if s, ok := statsByIdentifier[id]; ok {
			features = append(features, *s)
		}
	}
	ids := make([]string, len(featureIdentifiers))
	copy(ids, featureIdentifiers)
	result := ProfileResult{
		TouchCounts:        tc,
		FeatureIdentifiers: ids,
		Features:           features,
		Attribution:        CellAttribution{Cell: cell, Feature: feature, Count: count},
	}
	stack = nil
	touchCounts = nil
	cellAttribution = nil
	return result
}

// PushFeatureFrame pushes a frame for a feature's own Place call beginning right now -- called
// unconditionally by every concrete feature type's own Place method (features/*.go), regardless
// of ProfilingActive, so the delegation chain (CurrentChain) is always accurate -- see this
// package's "Always-on delegation chain" doc comment. The heavier profiling-only bookkeeping
// (stats map lookup, Entered++, time.Now()) only runs while ProfilingActive is true.
func PushFeatureFrame(identifier, typeID string) {
	f := frame{identifier: identifier, typeID: typeID}
	if ProfilingActive {
		stats := statsFor(identifier, typeID)
		stats.Entered++
		f.featureIndex = featureIndexOf[identifier]
		f.startedAt = time.Now()
	}
	stack = append(stack, f)
}

// PopFeatureFrame pops the frame pushed by the matching PushFeatureFrame. With profiling off this
// is just the stack truncation (see PushFeatureFrame). With profiling on it also folds the
// frame's elapsed time into that feature's self/inclusive totals and credits the elapsed time to
// the new top frame's childMs (so that frame's own self time excludes it).
func PopFeatureFrame() {
	if len(stack) == 0 {
		return
	}
	f := stack[len(stack)-1]
	stack = stack[:len(stack)-1]
	if !ProfilingActive {
		return
	}
	inclusive := float64(time.Since(f.startedAt)) / float64(time.Millisecond)
	if stats, ok := statsByIdentifier[f.identifier]; ok {
		self := inclusive - f.childMs
		if self < 0 {
			self = 0
		}
		stats.SelfMs += self
		stats.InclusiveMs += inclusive
	}
	if len(stack) > 0 {
		stack[len(stack)-1].childMs += inclusive
	}
}

// CurrentChain returns a snapshot of the delegation chain right now: every feature whose Place
// call is currently active on the Go call stack, root first, the currently-executing (deepest)
// feature last. Always accurate regardless of ProfilingActive -- see this package's "Always-on
// delegation chain" doc comment. A diagnostic raised while this is non-empty can name the exact
// feature that raised it (the last entry) as well as the full path that reached it, not just
// whichever top-level feature/rule the caller originally selected.
//
// Returns a fresh copy safe to retain past the next Push/PopFeatureFrame call (e.g. across a
// panic unwind, where every enclosing frame's deferred PopFeatureFrame runs after a diagnostic
// has already captured this).
func CurrentChain() []ChainFrame {
	if len(stack) == 0 {
		return nil
	}
	out := make([]ChainFrame, len(stack))
	for i, f := range stack {
		out[i] = ChainFrame{Identifier: f.identifier, TypeID: f.typeID}
	}
	return out
}

// AppendChain appends the current delegation chain to dst (root first, same
// order and content as CurrentChain) and returns the extended slice -- the
// buffer-reusing counterpart of CurrentChain for hot callers that only read
// the frames synchronously and then discard them (session's per-failure
// diagnostic dedup, which can run once per failed placement attempt --
// ~1M times in a pathological run). Callers that RETAIN the chain past the
// next Push/PopFeatureFrame (panic paths) must keep using CurrentChain,
// whose fresh-copy contract exists for exactly that.
func AppendChain(dst []ChainFrame) []ChainFrame {
	for _, f := range stack {
		dst = append(dst, ChainFrame{Identifier: f.identifier, TypeID: f.typeID})
	}
	return dst
}

// InstrumentFeature returns a wgen.IFeature wrapping feature so every call
// to its Place, from any call site, is bracketed by PushFeatureFrame/
// PopFeatureFrame. See this package's doc comment ("Attribution model") for
// why this returns a new value rather than mutating feature in place, and
// what that means for who is responsible for making nested resolution see
// the wrapped instance.
func InstrumentFeature(feature wgen.IFeature) wgen.IFeature {
	return &instrumentedFeature{inner: feature}
}

type instrumentedFeature struct {
	inner wgen.IFeature
}

func (f *instrumentedFeature) TypeID() string     { return f.inner.TypeID() }
func (f *instrumentedFeature) Identifier() string { return f.inner.Identifier() }

func (f *instrumentedFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	PushFeatureFrame(f.inner.Identifier(), f.inner.TypeID())
	defer PopFeatureFrame()
	return f.inner.Place(ctx)
}

// RecordDelegation is called from a composite feature's recursion guard
// (features.WithRecursionGuard) for every guarded delegation -- see FeatureProfileStats.Delegations's doc comment
// for what this counts and why it's kept separate from Entered/
// BlocksWritten. No-ops when profiling is off.
func RecordDelegation(wrapperIdentifier, wrapperTypeID string) {
	if !ProfilingActive {
		return
	}
	statsFor(wrapperIdentifier, wrapperTypeID).Delegations++
}

// RecordStop notes that the innermost feature on the stack stopped short:
// reason is one of StopStat.Reason's codes, detail the evaluated value that
// caused it, ordinal the entry it applies to or NoOrdinal. Aggregates by
// (reason, ordinal), keeping the first detail. Records into whichever tiers
// are armed -- the always-on stops store, the profiling store, or both (see
// this package's "## Stops" doc comment). No-ops when neither is armed or
// nothing is on the stack.
//
// Callers guard with `if profiler.StopsActive` themselves, so building
// detail (usually a fmt.Sprintf) costs nothing on an unarmed run.
func RecordStop(reason, detail string, ordinal int) {
	if len(stack) == 0 {
		return
	}
	identifier := stack[len(stack)-1].identifier
	if StopsActive {
		if e := findLightStop(identifier, reason, ordinal); e != nil {
			// Reached when StopCounted declined to claim the hit because the OTHER tier had no
			// row for it yet; this tier's count still owes one.
			e.count++
		} else if len(lightStops) < maxTrackedStopRows {
			lightStops = append(lightStops, stopEntry{
				identifier: identifier, reason: reason, detail: detail, ordinal: ordinal, count: 1,
			})
			lightStopHint = len(lightStops) - 1
		}
	}
	if !ProfilingActive {
		return
	}
	stats, ok := statsByIdentifier[identifier]
	if !ok {
		return
	}
	if s := findStopStat(stats, reason, ordinal); s != nil {
		s.Count++
		return
	}
	stop := StopStat{Reason: reason, Detail: detail, Count: 1}
	if ordinal != NoOrdinal {
		o := ordinal
		stop.Ordinal = &o
	}
	stats.Stops = append(stats.Stops, stop)
}

// StopCounted is RecordStop without the detail: if (reason, ordinal) already has a row on the
// innermost frame it adds one to its count and returns true, and the caller is done. False means
// the caller must RecordStop it -- the only time a detail string is worth building, since only
// the first one is kept. Also true when there is nothing to record into (nothing armed, empty
// stack). Lets a stop hit once per iteration skip the fmt.Sprintf on every hit after the first:
//
//	if profiler.StopsActive && !profiler.StopCounted(reason, i) {
//		profiler.RecordStop(reason, fmt.Sprintf(...), i)
//	}
//
// Counts are only applied once EVERY armed tier has a row to apply them to: a tier still missing
// one sends the caller to RecordStop, which credits the row this call deliberately left alone.
// That is what keeps the two tiers' counts equal even though they are reached separately.
func StopCounted(reason string, ordinal int) bool {
	if len(stack) == 0 {
		return true
	}
	identifier := stack[len(stack)-1].identifier
	var light *stopEntry
	if StopsActive {
		light = findLightStop(identifier, reason, ordinal)
		// A full store drops this triple entirely (light stays nil, nothing to count) rather
		// than sending the caller off to build a detail for a row that will never exist.
		if light == nil && len(lightStops) < maxTrackedStopRows {
			return false
		}
	}
	var stat *StopStat
	if ProfilingActive {
		// A missing stats bucket means this identifier never entered under the profiler, so
		// there is nothing to record into on this tier -- not a reason to ask for a detail.
		if stats, ok := statsByIdentifier[identifier]; ok {
			if stat = findStopStat(stats, reason, ordinal); stat == nil {
				return false
			}
		}
	}
	if light != nil {
		light.count++
	}
	if stat != nil {
		stat.Count++
	}
	return true
}

func ordinalOf(s *StopStat) int {
	if s.Ordinal == nil {
		return NoOrdinal
	}
	return *s.Ordinal
}

// RecordWrite is called from the volume's SetBlockAt for every in-bounds
// write while profiling is active (guarded there by the same
// ProfilingActive check, so this function itself never needs to re-check
// it). Increments the cell's total touch count unconditionally, and --
// only while a feature's Place is on the stack, i.e. not during a one-off
// environment build that runs before any feature frame is pushed --
// attributes the write to whichever feature is innermost right now.
func RecordWrite(cellIndex int) {
	touchCounts[cellIndex]++
	if len(stack) == 0 {
		return
	}
	f := stack[len(stack)-1]
	if stats, ok := statsByIdentifier[f.identifier]; ok {
		stats.BlocksWritten++
	}
	key := int64(cellIndex)*attributionKeySpan + int64(f.featureIndex)
	cellAttribution[key]++
}

// CellCounts is ProfileResult.TouchCounts's wire type: one write count per cell, run-length
// encoded on the wire. See session.CellIDs for the same treatment of the block arrays, and
// package featurelab-go/rle for the encoding itself.
type CellCounts []uint32

// MarshalJSON run-length encodes the counts.
func (c CellCounts) MarshalJSON() ([]byte, error) {
	return rle.Marshal(len(c), func(i int) int64 { return int64(c[i]) })
}

// UnmarshalJSON accepts the encoded shape and the dense array older responses carry.
func (c *CellCounts) UnmarshalJSON(data []byte) error {
	values, err := rle.Unmarshal(data)
	if err != nil {
		return fmt.Errorf("touchCounts: %w", err)
	}
	if values == nil {
		*c = nil
		return nil
	}
	out := make(CellCounts, len(values))
	for i, v := range values {
		out[i] = uint32(v)
	}
	*c = out
	return nil
}
