// search_feature.go implements minecraft:search_feature. The placement
// dispatches on the 6-valued search_axis enum (unchanged across both game
// versions) into a triple-nested search. Every candidate is placed through
// a transactional wrapper: writes are buffered and only committed
// (TransactionalTarget.apply) once required_successes is reached; an
// exhausted search discards the transaction entirely, so a partial write
// that is not undone would diverge in the writes hash rather than the
// draws -- see transactionalTarget below.
package features

import (
	"fmt"
	"math"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const searchTypeID = "minecraft:search_feature"

// searchAxisValues mirrors the search feature's axis enum -- see module header.
var searchAxisValues = map[string]int{"-x": 0, "+x": 1, "-y": 2, "+y": 3, "-z": 4, "+z": 5}

type searchLoopRole struct {
	axis string // "x" | "y" | "z"
	sign int    // +1 | -1
}

type searchAxisPlan struct {
	outer, mid, inner searchLoopRole
}

// searchAxisPlans is the per-axis (outer, mid, inner) role/sign table, keyed
// by the search feature's own axis enum int (0-5) rather than the JSON string, so
// the builder parses the enum once.
//
// The placement dispatches on the axis and walks an outer, a mid and an
// inner range; each range is built from the search_volume AABB's own min and
// max, and whether each range is ascending or descending gives the step's
// sign. The outer range is the outermost loop and the inner range the
// innermost. When the three counters are mapped back onto x/y/z, the x family
// (axes 0,1) takes its x offset from the outer counter, and the y and z
// families take it from the middle one; that agrees with all six rows below.
//
//	axis        outer   mid   inner
//	0 (-x)      x-      z-    y+
//	1 (+x)      x+      z+    y+
//	2 (-y)      y-      x-    z+
//	3 (+y)      y+      x+    z+
//	4 (-z)      z-      x+    y+
//	5 (+z)      z+      x-    y+
//
// Two patterns worth naming, because neither is guessable: the innermost loop
// is ALWAYS ascending, and the middle loop follows the outer loop's sign for
// the x and y families but INVERTS it for the z family (axes 4 and 5).
var searchAxisPlans = map[int]searchAxisPlan{
	0: {outer: searchLoopRole{"x", -1}, mid: searchLoopRole{"z", -1}, inner: searchLoopRole{"y", 1}},
	1: {outer: searchLoopRole{"x", 1}, mid: searchLoopRole{"z", 1}, inner: searchLoopRole{"y", 1}},
	2: {outer: searchLoopRole{"y", -1}, mid: searchLoopRole{"x", -1}, inner: searchLoopRole{"z", 1}},
	3: {outer: searchLoopRole{"y", 1}, mid: searchLoopRole{"x", 1}, inner: searchLoopRole{"z", 1}},
	4: {outer: searchLoopRole{"z", -1}, mid: searchLoopRole{"x", 1}, inner: searchLoopRole{"y", 1}},
	5: {outer: searchLoopRole{"z", 1}, mid: searchLoopRole{"x", -1}, inner: searchLoopRole{"y", 1}},
}

type searchAxisRange struct{ min, max int }

type searchRanges struct{ x, y, z searchAxisRange }

func (r searchRanges) byAxis(axis string) searchAxisRange {
	switch axis {
	case "x":
		return r.x
	case "y":
		return r.y
	default:
		return r.z
	}
}

func applyAxisOffset(pos wgen.BlockPos, axis string, val int) wgen.BlockPos {
	switch axis {
	case "x":
		pos.X += val
	case "y":
		pos.Y += val
	case "z":
		pos.Z += val
	}
	return pos
}

// iterateInclusive walks r.min..r.max inclusive, ascending when sign > 0,
// descending otherwise.
//
// An INVERTED range (max < min) yields no positions. It used to CRASH: the capacity expression
// `r.max-r.min+1` goes negative once max < min-1, and `make([]int, 0, negative)` panics with
// "makeslice: cap out of range". A user reached that with a plausible typo -- writing a downward
// search as {"min": [0,0,0], "max": [0,-3,0]}, which is the shipped fixture's own
// {"min":[0,-10,0], "max":[0,0,0]} with the two swapped -- and got a raw Go stack trace from the
// CLI, or an opaque "internal error" through serve, while `featurelab check` passed the file
// without a word.
//
// Yielding nothing is the conservative reading: an empty visit list makes the search find no
// candidate and the feature decline, which is a describable outcome. What the ENGINE does with an
// inverted search_volume has not been established -- a do-while would visit one cell,
// a normalised AABB would visit the whole box -- so buildSearchFeature warns rather than this
// silently choosing. See the warning there.
//
// The SAME expression has a second way to go negative that the inversion test above does not
// cover, and it panics identically: `max-min+1` OVERFLOWS once the span exceeds int64, so
// {"min": [0,-9223372036854775000,0], "max": [0,0,0]} -- max is not below min, the range is not
// inverted -- still reaches make() with a negative capacity. The realistic way to write that is
// not the literal: `int(f)` on a float64 outside int64's range is implementation-defined and
// lands on math.MinInt64 on amd64, so "search a very long way down" spelled `-1e300` becomes
// exactly that min. buildSearchFeature refuses such a volume with a message naming the span
// (which is the useful place to say it, because nothing can be searched either way); this guard
// is here so the function itself cannot panic for a caller that did not go through the builder.
//
// NOTHING IS MATERIALISED any more, and that is the third crash this one expression produced.
// This used to build the whole visit list up front, so `{"min": [0,0,0], "max": [0,1e18,0]}` --
// a legal, non-inverted, non-overflowing volume -- reached `make([]int, 0, 1000000000000000000)`
// and panicked with "makeslice: cap out of range" before visiting a single position, and a
// merely-large span such as 1e9 allocated 8GB to walk a volume the engine walks with
// counters. The engine has no list: its search is three nested counters over the
// AABB. Walking it the same way costs nothing and removes the allocation as a failure mode
// entirely -- a span that is simply enormous is now a long loop, which is what it is in the game
// too, rather than a crash unique to this port.
//
// forEachInclusive yields the identical sequence, in the identical order, that the old slice held;
// visit returns false to stop early (the required_successes commit path).
func forEachInclusive(r searchAxisRange, sign int, visit func(v int) bool) {
	if r.max < r.min {
		return
	}
	if span := r.max - r.min; span < 0 || span == math.MaxInt64 {
		return
	}
	if sign > 0 {
		for v := r.min; v <= r.max; v++ {
			if !visit(v) {
				return
			}
		}
		return
	}
	for v := r.max; v >= r.min; v-- {
		if !visit(v) {
			return
		}
	}
}

// iterateInclusive materialises what forEachInclusive yields. Kept for the tests that pin this
// axis walk's boundaries directly; Place does not use it.
func iterateInclusive(r searchAxisRange, sign int) []int {
	var out []int
	forEachInclusive(r, sign, func(v int) bool {
		out = append(out, v)
		return true
	})
	return out
}

// transactionalTarget mirrors the engine's transactional write behaviour
// -- see module header. Buffers writes against an in-memory map; GetBlock
// reads back its own buffered writes (so a multi-step delegate sees its own
// prior writes within the same search attempt); apply() flushes everything
// to the real API in insertion order; discarding the wrapper without
// calling apply() (the exhausted-search path) leaves the real API
// untouched.
type transactionalTarget struct {
	inner  wgen.BlockWorld
	writes map[wgen.BlockPos]block.ID
	order  []wgen.BlockPos
	// dropped holds writes the real API would have REFUSED (out of bounds). They are replayed at
	// apply() time so the overflow store still sees them, but never read back by GetBlock.
	dropped []pendingWrite
	// budget is inner's own write-budget accounting, reached through an optional interface so
	// this package need not depend on volume/. nil when inner does not do budget accounting at
	// all (test doubles, other API implementations), in which case writes are simply not charged
	// -- the same as before this seam existed.
	budget budgetedTarget
}

// budgetedTarget is the slice of *volume.Volume this wrapper needs to keep the write budget alive
// across a buffered write: charge the ATTEMPT when the delegate makes it, replay WITHOUT charging
// again when the search commits. Without it the budget was inert inside a search --
// WritesAttempted stayed 0 across six delegate writes -- so a runaway delegate reached inside a
// search_feature what it could not reach outside one.
type budgetedTarget interface {
	ChargeWrite(pos wgen.BlockPos)
	SetBlockUnbudgeted(pos wgen.BlockPos, id block.ID) bool
}

func newTransactionalTarget(inner wgen.BlockWorld) *transactionalTarget {
	t := &transactionalTarget{inner: inner, writes: make(map[wgen.BlockPos]block.ID)}
	if b, ok := inner.(budgetedTarget); ok {
		t.budget = b
	}
	return t
}

func (t *transactionalTarget) GetBlock(p wgen.BlockPos) block.ID {
	if id, ok := t.writes[p]; ok {
		return id
	}
	return t.inner.GetBlock(p)
}

// SetBlock buffers the write and reports the SAME success the unwrapped API would have reported.
// It used to return true unconditionally, so any delegate that keys success off SetBlock's bool --
// single_block.go's "Block could not be placed" step 12 is the one in this repo -- saw success
// inside a search where the identical call outside one saw failure, and the search then committed
// and returned a position having written nothing.
//
// The unwrapped decision is exactly Contains: *volume.Volume drops an out-of-bounds write and
// returns false. An out-of-bounds write is still charged against the budget and still replayed at
// apply() time so the overflow store keeps recording it, but it is NOT added to the readable
// buffer -- GetBlock must keep reading through to the real world there, because the real world
// never accepted it.
func (t *transactionalTarget) SetBlock(p wgen.BlockPos, id block.ID) bool {
	if t.budget != nil {
		t.budget.ChargeWrite(p)
	}
	if !t.inner.Contains(p) {
		t.dropped = append(t.dropped, pendingWrite{pos: p, id: id})
		return false
	}
	if _, exists := t.writes[p]; !exists {
		t.order = append(t.order, p)
	}
	t.writes[p] = id
	return true
}

type pendingWrite struct {
	pos wgen.BlockPos
	id  block.ID
}

func (t *transactionalTarget) GetHeight(x, z int) int      { return t.inner.GetHeight(x, z) }
func (t *transactionalTarget) GetHeightmapAt(x, z int) int { return t.inner.GetHeightmapAt(x, z) }
func (t *transactionalTarget) GetAboveTopSolidAt(x, z int) int {
	return t.inner.GetAboveTopSolidAt(x, z)
}
func (t *transactionalTarget) MinY() int                     { return t.inner.MinY() }
func (t *transactionalTarget) MaxY() int                     { return t.inner.MaxY() }
func (t *transactionalTarget) Contains(p wgen.BlockPos) bool { return t.inner.Contains(p) }
func (t *transactionalTarget) Palette() wgen.IPaletteView    { return t.inner.Palette() }

// apply flushes every buffered write to the real API, in insertion order, WITHOUT charging the
// budget a second time -- SetBlock already charged each attempt when the delegate made it.
// Out-of-bounds writes are replayed too: the real API drops them, but doing so is what keeps its
// WritesOutOfBounds counter and overflow store accurate for a committed search.
func (t *transactionalTarget) apply() {
	set := t.inner.SetBlock
	if t.budget != nil {
		set = t.budget.SetBlockUnbudgeted
	}
	for _, p := range t.order {
		set(p, t.writes[p])
	}
	for _, w := range t.dropped {
		set(w.pos, w.id)
	}
}

var _ wgen.BlockWorld = (*transactionalTarget)(nil)

// SearchFeature is minecraft:search_feature.
type SearchFeature struct {
	identifier        string
	placesFeatureRef  string
	ranges            searchRanges
	axisValue         int
	requiredSuccesses int
	resolver          wgen.IFeatureResolver
}

func (f *SearchFeature) TypeID() string     { return searchTypeID }
func (f *SearchFeature) Identifier() string { return f.identifier }

// FeatureRefs exposes the single delegated feature reference for the static
// delegation-chain walk.
func (f *SearchFeature) FeatureRefs() []string { return []string{f.placesFeatureRef} }

// Place mirrors the search feature's placement: triple-nested search over
// search_volume, delegating through a transactional wrapper, committing (and
// returning immediately) once required_successes is reached, discarding the
// whole transaction on exhaustion. Zero direct RNG calls anywhere here --
// every draw happens inside whatever the delegated target.Place() does.
func (f *SearchFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, searchTypeID)
	defer profiler.PopFeatureFrame()

	target := f.resolver.Resolve(f.placesFeatureRef)
	// Unresolved wrapped feature and an exhausted search share the SAME
	// generic message in the engine (both end in the same failure path) -- see
	// header.
	if target == nil {
		LogFailure(ctx, searchTypeID, "Could not find a valid position for the feature")
		if profiler.StopsActive && !profiler.StopCounted(profiler.StopUnresolvedReference, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopUnresolvedReference, f.placesFeatureRef+" not found"+SuggestFeatureRef(f.resolver, f.placesFeatureRef), profiler.NoOrdinal)
		}
		return nil
	}
	if !IsAllowedToPlaceFeature(f) {
		LogFailure(ctx, searchTypeID, "Cannot place internal feature")
		if profiler.StopsActive {
			profiler.RecordStop(profiler.StopRecursionGuard, "already placing", profiler.NoOrdinal)
		}
		return nil
	}

	plan := searchAxisPlans[f.axisValue]
	wrapped := newTransactionalTarget(ctx.API)
	origin := ctx.Origin

	successCount := 0
	var lastResult *wgen.BlockPos

	// Three nested counters, exactly as the engine's search is, rather than three materialised lists --
	// see forEachInclusive. `done` carries the required_successes early exit back out through all
	// three levels, which is what the `return lastResult` inside the old triple `for` did directly.
	done := false
	forEachInclusive(f.ranges.byAxis(plan.outer.axis), plan.outer.sign, func(outerVal int) bool {
		forEachInclusive(f.ranges.byAxis(plan.mid.axis), plan.mid.sign, func(midVal int) bool {
			forEachInclusive(f.ranges.byAxis(plan.inner.axis), plan.inner.sign, func(innerVal int) bool {
				candidate := origin
				candidate = applyAxisOffset(candidate, plan.outer.axis, outerVal)
				candidate = applyAxisOffset(candidate, plan.mid.axis, midVal)
				candidate = applyAxisOffset(candidate, plan.inner.axis, innerVal)

				// MolangScope/Random are the SAME shared objects, only api
				// (-> the transactional wrapper) and origin (-> the
				// candidate) differ from the outer context.
				//
				// Clearing Molang is what keeps that true: WithOrigin copies
				// the cached bridge context by reference, and it was built
				// from the OUTER ctx.API, so leaving it in place would have
				// the delegate's query.heightmap/above_top_solid read a
				// different world than its writes go to (see
				// wgen.PlacementContext.Molang's invariant). Cheap: the
				// rebuild is pure map/closure setup with NO RNG draws, it
				// happens once per candidate only if the delegate evaluates
				// Molang at all, and wgen's own provenance check would now
				// force the same rebuild anyway -- this line states the
				// intent at the site that breaks the invariant.
				subCtx := ctx.WithOrigin(candidate)
				subCtx.API = wrapped
				subCtx.Molang = nil
				result := WithRecursionGuard(f, func() *wgen.BlockPos { return target.Place(subCtx) })
				if result != nil {
					lastResult = result
					successCount++
					if successCount == f.requiredSuccesses {
						wrapped.apply()
						done = true
						return false
					}
				}
				return true
			})
			return !done
		})
		return !done
	})
	if done {
		return lastResult
	}

	// Exhausted without reaching required_successes -- transaction
	// discarded, matching the engine, which never commits on this path.
	LogFailure(ctx, searchTypeID, "Could not find a valid position for the feature")
	if profiler.StopsActive && !profiler.StopCounted(profiler.StopSearchExhausted, profiler.NoOrdinal) {
		profiler.RecordStop(profiler.StopSearchExhausted,
			fmt.Sprintf("%d of %d required successes", successCount, f.requiredSuccesses), profiler.NoOrdinal)
	}
	return nil
}

func parseSearchAxisTriple(raw any, jsonPath string) (int, int, int, error) {
	arr, ok := raw.([]any)
	if !ok || len(arr) != 3 {
		return 0, 0, 0, fmt.Errorf("%s must be a [x, y, z] array of 3 numbers", jsonPath)
	}
	vals := [3]int{}
	for i, v := range arr {
		f, ok := v.(float64)
		if !ok {
			return 0, 0, 0, fmt.Errorf("%s must be a [x, y, z] array of 3 numbers", jsonPath)
		}
		vals[i] = int(f)
	}
	return vals[0], vals[1], vals[2], nil
}

func buildSearchFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	placesFeature, ok := body["places_feature"].(string)
	if !ok || placesFeature == "" {
		return nil, fmt.Errorf("places_feature must be a non-empty feature reference string")
	}
	volume, ok := body["search_volume"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("search_volume must be an object")
	}
	minX, minY, minZ, err := parseSearchAxisTriple(volume["min"], "search_volume.min")
	if err != nil {
		return nil, err
	}
	maxX, maxY, maxZ, err := parseSearchAxisTriple(volume["max"], "search_volume.max")
	if err != nil {
		return nil, err
	}
	ranges := searchRanges{
		x: searchAxisRange{min: minX, max: maxX},
		y: searchAxisRange{min: minY, max: maxY},
		z: searchAxisRange{min: minZ, max: maxZ},
	}
	// An inverted axis -- max below min -- is a plausible typo rather than an exotic one: a
	// downward search is written {"min": [0,-10,0], "max": [0,0,0]}, and swapping the two is the
	// obvious mistake. It used to crash the tool outright (see iterateInclusive), and `check`
	// passed the file in silence. It now searches nothing, and says so, because "this feature
	// places nothing anywhere" is not something to discover by elimination.
	//
	// What the ENGINE does here has not been established: a do-while over the volume
	// would visit exactly one cell, a normalised AABB would visit the whole box. The warning says
	// that too, so nobody reads this port's choice as a finding.
	for _, axis := range []struct {
		name string
		r    searchAxisRange
	}{{"x", ranges.x}, {"y", ranges.y}, {"z", ranges.z}} {
		// The non-inverted way `max-min+1` goes negative: it OVERFLOWS. REFUSED rather than
		// warned, because unlike an inverted axis there is no sensible thing to do with the
		// volume -- this port materialises each axis's positions (see iterateInclusive) and a
		// span this wide has no representation at all, let alone one that fits in memory. The
		// realistic spelling is not the 19-digit literal: Go's `int(f)` on a float64 outside
		// int64's range is implementation-defined and lands on math.MinInt64 here, so writing
		// "a very long way down" as -1e300 produces exactly this. Saying so is the point --
		// before this the author got `panic: makeslice: cap out of range` and a raw Go stack
		// trace, with `featurelab check` passing the file in silence, same as the inverted case.
		//
		// Inert for every volume that works today: a span that fits in an int is untouched, and
		// every span that does not already crashed here.
		if axis.r.max >= axis.r.min {
			if span := axis.r.max - axis.r.min; span < 0 || span == math.MaxInt64 {
				return nil, fmt.Errorf("search_volume's %s axis runs from %d to %d, a span too wide "+
					"to represent -- this tool walks the volume position by position and there is no "+
					"number of positions that large. If you meant \"search a long way\", write the "+
					"real distance: the shipped downward search is min: [0,-10,0], max: [0,0,0]. "+
					"(A very large or very small number such as 1e300 also arrives here as this "+
					"value: it does not fit in an integer and wraps.)",
					axis.name, axis.r.min, axis.r.max)
			}
		}
		if axis.r.max < axis.r.min && ctx.Warn != nil {
			ctx.Warn(fmt.Sprintf("%s: search_volume's %s axis runs from %d down to %d -- max is below "+
				"min, so this volume contains no positions and the search visits nothing. Did you mean "+
				"to swap them? (A downward search is min: [0,-10,0], max: [0,0,0].) What the real game "+
				"does with an inverted volume has not been established here, so do not read this tool's "+
				"answer as the engine's",
				ctx.Identifier, axis.name, axis.r.min, axis.r.max))
		}
	}

	// search_axis is REQUIRED by the engine's schema, so rejecting an absent
	// key matches what the game does with such a file. For the record the
	// default is search_axis 3 ("+y") and required_successes 1 -- but no JSON
	// can reach the search_axis default, since the key cannot be omitted.
	axisRaw, isString := body["search_axis"].(string)
	axisValue, known := searchAxisValues[axisRaw]
	if !isString || !known {
		return nil, fmt.Errorf("search_axis must be one of -x, +x, -y, +y, -z, +z (got %#v)", body["search_axis"])
	}

	// required_successes is optional in the schema, and its default is 1.
	//
	// ZERO IS ACCEPTED. This used to refuse it as "must be a positive integer", but nothing in
	// this repo records a schema minimum for the field -- it has a default, not a bound -- so
	// that refusal was this port being stricter than the game, and it cost the author the whole file over a value the game very likely loads.
	// What 0 then DOES here: Place() compares successCount for EQUALITY after incrementing it,
	// so a counter that starts at 0 and is only tested at 1 or more can never match, the search
	// runs to exhaustion, the transaction is discarded and the feature declines. That is a
	// describable outcome, so it is warned about rather than refused. Caveat stated plainly:
	// whether the engine's own test is `==` or `>=` has NOT been established -- every reachable
	// config so far has required_successes >= 1, where the two are indistinguishable, so nothing
	// forced the question. Under `>=` the game would instead commit on the first success, i.e.
	// behave like 1. Negatives are still refused: no reading of either comparison makes a
	// negative count mean anything an author could have intended.
	requiredSuccesses := 1
	if raw, present := body["required_successes"]; present {
		f, ok := toFloat(raw)
		if !ok || f < 0 || f != float64(int(f)) {
			return nil, fmt.Errorf("required_successes must be a non-negative integer (got %#v)", raw)
		}
		requiredSuccesses = int(f)
		if requiredSuccesses == 0 && ctx.Warn != nil {
			ctx.Warn("required_successes is 0: this port's success counter is compared for " +
				"equality only after it has been incremented, so it can never equal 0 -- the " +
				"search will run to exhaustion, discard its buffered writes and place nothing. " +
				"Whether the real game compares with == (same as here) or >= (in which case 0 " +
				"behaves like 1 and commits on the first success) is not established. Write 1 if " +
				"you meant \"commit as soon as one placement works\".")
		}
	}

	return &SearchFeature{
		identifier:        ctx.Identifier,
		placesFeatureRef:  placesFeature,
		ranges:            ranges,
		axisValue:         axisValue,
		requiredSuccesses: requiredSuccesses,
		resolver:          ctx.Resolver,
	}, nil
}

func init() {
	RegisterType(searchTypeID, buildSearchFeature)
}

var _ wgen.IFeature = (*SearchFeature)(nil)
