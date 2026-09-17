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
// that rejected), aggregated into FeatureProfileStats.Stops. Like RecordDelegation it is
// profiling-only, and every call site checks ProfilingActive itself before formatting a detail.
package profiler

import (
	"fmt"
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
}

// EndProfiling disarms the profiler and returns everything collected since
// the matching BeginProfiling call.
func EndProfiling() ProfileResult {
	ProfilingActive = false
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
// (reason, ordinal), keeping the first detail. No-ops when profiling is off
// or nothing is on the stack.
//
// Callers guard with `if profiler.ProfilingActive` themselves, so building
// detail (usually a fmt.Sprintf) costs nothing on a normal run.
func RecordStop(reason, detail string, ordinal int) {
	if !ProfilingActive || len(stack) == 0 {
		return
	}
	f := stack[len(stack)-1]
	stats, ok := statsByIdentifier[f.identifier]
	if !ok {
		return
	}
	// Linear: a feature has a handful of distinct stop kinds at most.
	for i := range stats.Stops {
		s := &stats.Stops[i]
		if s.Reason == reason && ordinalOf(s) == ordinal {
			s.Count++
			return
		}
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
// the first one is kept. Also true when there is nothing to record into (profiling off, empty
// stack). Lets a stop hit once per iteration skip the fmt.Sprintf on every hit after the first:
//
//	if profiler.ProfilingActive && !profiler.StopCounted(reason, i) {
//		profiler.RecordStop(reason, fmt.Sprintf(...), i)
//	}
func StopCounted(reason string, ordinal int) bool {
	if !ProfilingActive || len(stack) == 0 {
		return true
	}
	stats, ok := statsByIdentifier[stack[len(stack)-1].identifier]
	if !ok {
		return true
	}
	for i := range stats.Stops {
		s := &stats.Stops[i]
		if s.Reason == reason && ordinalOf(s) == ordinal {
			s.Count++
			return true
		}
	}
	return false
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
