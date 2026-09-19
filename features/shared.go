package features

import (
	"fmt"
	"strings"
	"time"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

// ---------------------------------------------------------------------------
// Recursion guard — follows the engine's own feature-permission gate and
// its recursion guard exactly: keyed on the WRAPPER performing the
// delegation (this, not the resolved callee), which is deliberate rather
// than backwards.
// ---------------------------------------------------------------------------

var inProgress = make(map[wgen.IFeature]bool)

// IsAllowedToPlaceFeature mirrors the engine's feature-permission gate:
// false while wrapper (the feature instance currently delegating) is
// already mid a sub-place() call itself.
func IsAllowedToPlaceFeature(wrapper wgen.IFeature) bool {
	if wrapper == nil {
		return false
	}
	return !inProgress[wrapper]
}

// DelegationBudgetExceeded is raised when the delegation budget runs out. Attempted is delegationsUsed at
// the moment the panic was raised (always Budget+1: the guard checks AFTER incrementing) --
// carried explicitly rather than left implicit so a diagnostic can say the count reached, not
// just the configured limit. Chain is profiler.CurrentChain() captured at the SAME moment, before
// any deferred PopFeatureFrame unwinds it -- see WithRecursionGuard.
//
// REPRODUCIBLE, unlike PlacementDeadlineExceeded below (see that type's own doc comment for the
// full contrast this project's single-master-seed determinism policy draws between the two): this
// budget is a pure delegation COUNT, with no wall-clock component anywhere in WithRecursionGuard's
// own check -- the same seed and the same pack always place the same number of times before hitting
// it, on any machine, under any load, every run. A preview that changes because it now hits (or no
// longer hits) this budget changed because a CODE edit changed how many times something delegates,
// never because of run-to-run timing noise.
type DelegationBudgetExceeded struct {
	Budget, Attempted int
	Chain             []profiler.ChainFrame
}

func (e *DelegationBudgetExceeded) Error() string {
	return fmt.Sprintf(
		"delegation budget hit at %d of %d nested feature placements (count-based -- reproducible: "+
			"the same master seed and pack always hit this at the same count, on any machine)",
		e.Attempted, e.Budget)
}

// MalformedRangeRefusal is a placement this port DECLINES TO GUESS AT: a JSON range whose drawn
// value lands past a point where the real game hits its own debug assert, and where what a
// release build does after that assert is not known. tree.go raises it
// from four such sites (spruce_canopy's lower/upper offsets, mega_canopy's and
// mega_pine_canopy's canopy_height, and placeRadialBlockGroup's negative radius).
//
// The REFUSAL is not new and is not being softened -- refusing rather than inventing behaviour is
// this project's standing position for these four, argued at each site. What changed is the
// DELIVERY. Every one of them used to `panic` with a bare error, and session.go's recover switch
// re-panics anything that is not one of its budget types, so a pack author who wrote
// `"spruce_canopy": {"lower_offset": 5, "upper_offset": 0}` got a raw Go stack trace out of the
// CLI, an opaque "internal error" through serve, and a `featurelab check` that passed the file in
// silence -- the exact failure mode the inverted-search_volume and drawing-tag-predicate fixes
// were written to remove, still live in a third place.
//
// Giving the panic a type it can be recognised by changes nothing about WHEN placement stops,
// WHERE it stops, what has been written by then, or what the RNG has drawn: the panic is raised at
// the identical line under the identical condition and still unwinds the whole placement. Only the
// report at the other end differs -- a diagnostic naming the field instead of a stack trace. Chain
// is captured at the raise site for the same reason the budget errors capture theirs (see
// DelegationBudgetExceeded): by the time a caller's recover() runs, every enclosing Place call's
// deferred PopFeatureFrame has already emptied profiler's stack.
type MalformedRangeRefusal struct {
	// Field names the JSON field whose value produced the malformed range, e.g.
	// "mega_canopy.canopy_height".
	Field string
	// Detail says what the value was and why it cannot be honoured.
	Detail string
	Chain  []profiler.ChainFrame
}

func (e *MalformedRangeRefusal) Error() string {
	return fmt.Sprintf("%s: %s -- this tool refuses rather than guessing: the real game hits its own "+
		"debug assert here, and what a release build does past that assert is not known, "+
		"so any result shown would be invented", e.Field, e.Detail)
}

// RaiseMalformedRange panics with a *MalformedRangeRefusal for field, capturing the delegation
// chain at this point. Never returns.
func RaiseMalformedRange(field, detail string) {
	panic(&MalformedRangeRefusal{Field: field, Detail: detail, Chain: profiler.CurrentChain()})
}

// PlacementDeadlineExceeded is raised when a placement runs past its wall-clock budget: thrown
// when a placement chain runs past the wall-clock deadline armed by
// SetDelegationBudgetMs. LimitMs is the configured deadline (the timeLimitMs SetDelegationBudgetMs
// was last armed with); Chain is profiler.CurrentChain() at the moment of the panic -- see
// DelegationBudgetExceeded's doc comment for why both are captured explicitly rather than left
// for the caller to reconstruct after the stack has already unwound.
//
// NOT REPRODUCIBLE, and this is the one place in this project's whole placement pipeline that is
// genuinely true: WithRecursionGuard's own deadline check reads time.Now(), so WHERE in the
// delegation sequence this fires depends on how fast this particular run was -- a slower or busier
// machine truncates at a different point for the IDENTICAL master seed and pack, while a faster one
// might not hit it at all. That makes a PlacementDeadlineExceeded-truncated preview fundamentally
// different from every other diagnostic in this package: its result is a genuine artifact of run
// timing, not of the seed or of any code change, and must never be mistaken for either. A caller
// that wants "truncate this generation, but reproducibly" should use the count-based
// DelegationBudgetExceeded (SetDelegationBudget, no wall-clock component at all) instead of, or
// alongside, this deadline -- see Error()'s own message, which states this distinction plainly
// because it is exactly the confusion a silent-looking truncation would otherwise cause: a preview
// that changed because THIS run happened to run slow must never look like a preview that changed
// because of a code edit.
type PlacementDeadlineExceeded struct {
	Delegations int
	LimitMs     int
	// Site names the loop that was running when the deadline was noticed, as a short phrase
	// naming the JSON field driving it -- e.g. "scanning the block volume its max_radius covers".
	// Empty for the DELEGATION-site check inside WithRecursionGuard, which has no single loop to
	// name (the delegation chain in Chain already is the answer there).
	//
	// Non-empty means this deadline was tripped by TickDeadline from inside ONE feature's own
	// loop, with no delegation involved -- the case WithRecursionGuard's check structurally could
	// not see (see TickDeadline). Naming the loop is what makes that abort actionable: "placement
	// time limit exceeded" on its own tells an author to raise the limit, which is exactly the
	// wrong move when the real answer is that one field is orders of magnitude too large.
	Site  string
	Chain []profiler.ChainFrame
}

func (e *PlacementDeadlineExceeded) Error() string {
	where := fmt.Sprintf("after %d nested placements", e.Delegations)
	if e.Site != "" {
		// A leaf abort. Say what was running AND that no delegation was involved, because the
		// obvious reading of any budget diagnostic in this tool -- "something is recursing" -- is
		// wrong here and would send an author looking in the wrong file.
		where = fmt.Sprintf("while %s (%d nested placement(s) deep -- this is one feature's own "+
			"loop, not a delegation chain)", e.Site, e.Delegations)
	}
	return fmt.Sprintf(
		"placement wall-clock time limit of %dms hit %s -- TRUNCATED BY THE "+
			"CLOCK, NOT REPRODUCIBLE: this cutoff point depends on how fast this run happened to be, "+
			"so the identical master seed and pack can truncate at a different point (or not at all) "+
			"on a slower/busier machine or a different run; if you need a truncation limit that "+
			"reproduces identically for a given seed, use the count-based delegation budget "+
			"(SetDelegationBudget/DelegationBudgetExceeded) instead",
		e.LimitMs, where)
}

// PlacementCancelled is raised when a placement is abandoned because the caller asked for it to
// stop -- the request it belongs to was cancelled (cmd/featurelab/serve.go's "cancel" method) --
// rather than because any budget was exceeded.
//
// It is NOT a budget and NOT a diagnostic. The other four refusals in this package all describe
// something about the PACK (a chain that will not converge, a field the engine does not define,
// a run too slow for its own clock) and their whole purpose is to leave the author a partial
// result plus an explanation of it. This one describes something about the SESSION: somebody
// pressed Cancel. There is nothing to explain and nothing worth showing, so the caller that
// recovers this discards the run and answers "cancelled" instead of handing back a truncated
// volume that looks like a feature which placed almost nothing.
//
// Site names the loop that noticed, on the same terms as PlacementDeadlineExceeded.Site, and
// exists for the same reason: it is the one thing the chain cannot say.
type PlacementCancelled struct {
	Site  string
	Chain []profiler.ChainFrame
}

func (e *PlacementCancelled) Error() string {
	if e.Site != "" {
		return fmt.Sprintf("placement cancelled while %s", e.Site)
	}
	return "placement cancelled"
}

var (
	delegationBudget *int
	delegationsUsed  int
	// cancelDone is the caller's cancellation signal for the placement currently running, or
	// nil when nothing can cancel this run.
	//
	// A CHANNEL rather than a context.Context, and read rather than stored as a Context, for
	// one reason: this is checked from the hottest loops in the project, and a nil compare
	// followed by a non-blocking receive is the cheapest form the check has. A nil channel is
	// the free path -- which is what every test, every benchmark and the golden digest harness
	// run on, since none of them ever arms one.
	cancelDone <-chan struct{}
	// deadlineAt is nil when no wall-clock deadline is armed -- the golden
	// digest recipe's own SetDelegationBudget(&db) call never arms one, so
	// that path is completely unaffected by this field's existence.
	deadlineAt *time.Time
	// configuredTimeLimitMs mirrors deadlineAt's own "nil means not armed" contract -- kept
	// alongside it purely so a PlacementDeadlineExceeded panic can report the configured limit in
	// milliseconds (the number a caller actually set), not just derive it back from a wall-clock
	// deadline.
	configuredTimeLimitMs *int
)

// SetDelegationBudget arms the count-based budget for one generation, with
// no wall-clock deadline. Pass nil to disable it. Equivalent to
// SetDelegationBudgetMs(budget, nil).
func SetDelegationBudget(budget *int) {
	SetDelegationBudgetMs(budget, nil)
}

// SetDelegationBudgetMs is SetDelegationBudget plus a wall-clock deadline
// timeLimitMs milliseconds from now — the same shape as
// setDelegationBudget(budget, timeLimitMs). Pass nil for either bound to
// disable it.
func SetDelegationBudgetMs(budget *int, timeLimitMs *int) {
	delegationBudget = budget
	delegationsUsed = 0
	if timeLimitMs == nil {
		deadlineAt = nil
		configuredTimeLimitMs = nil
		// Park TickDeadline's countdown on its free path -- see deadlineTickUnarmed. Without
		// this, a run that armed a deadline and then disarmed it would keep whatever small
		// reload the tuner had settled on and go on reading the clock for nothing.
		deadlineTicks = deadlineTickUnarmed
		return
	}
	now := time.Now()
	t := now.Add(time.Duration(*timeLimitMs) * time.Millisecond)
	deadlineAt = &t
	limit := *timeLimitMs
	configuredTimeLimitMs = &limit
	// Arm TickDeadline's countdown from scratch. It MUST be reset here and not left at whatever
	// the previous run (or the package's own unarmed initial value) left behind: a countdown of
	// deadlineTickUnarmed would let a leaf loop run a billion steps before consulting the clock
	// once, which is a deadline in name only. Starting at the floor makes the first tick calibrate
	// the reload against a real measurement instead of guessing.
	deadlineTicks = deadlineTickMin
	deadlineInterval = deadlineTickMin
	deadlineLastRead = now
}

// SetPlacementCancel arms (or, with nil, disarms) the cancellation signal for one placement --
// normally a context's Done channel, from the request the placement is running for. The
// placement aborts with a *PlacementCancelled panic the next time any of this package's
// existing checkpoints runs.
//
// It deliberately does NOT take a context.Context. Nothing in this package wants a deadline,
// a value bag or a second way to express the wall-clock limit SetDelegationBudgetMs already
// owns; all it wants is the one bit of "stop now", and a channel is that bit in the form the
// hot-path check can read for free.
//
// Arming here also kicks TickDeadline's countdown off its unarmed reload, so a run that asked
// for cancellation but not for a wall-clock deadline still notices. Call it AFTER
// SetDelegationBudgetMs, which resets the same countdown.
func SetPlacementCancel(done <-chan struct{}) {
	cancelDone = done
	if done == nil {
		if deadlineAt == nil {
			deadlineTicks = deadlineTickUnarmed
		}
		return
	}
	deadlineTicks = deadlineTickMin
	deadlineInterval = deadlineTickMin
	deadlineLastRead = time.Now()
}

// PlacementCancelRequested reports whether the signal armed by SetPlacementCancel has fired.
// False when nothing is armed.
func PlacementCancelRequested() bool {
	if cancelDone == nil {
		return false
	}
	select {
	case <-cancelDone:
		return true
	default:
		return false
	}
}

// CheckPlacementCancel panics with *PlacementCancelled (naming site) if the caller has asked
// this placement to stop, and does nothing otherwise.
//
// Exported for the ONE loop this package cannot see into: a feature rule's own per-iteration
// scatter walk lives in the rules package and can delegate thousands of times to a feature
// whose Place has no loop of its own and therefore never reaches TickDeadline. Everything
// inside this package is already covered by TickDeadline and WithRecursionGuard and should use
// those rather than calling this directly.
//
// Costs a nil compare when nothing is armed, which is every test, benchmark and golden-digest
// run in this repository.
func CheckPlacementCancel(site string) {
	if !PlacementCancelRequested() {
		return
	}
	panic(&PlacementCancelled{Site: site, Chain: profiler.CurrentChain()})
}

// DelegationsSoFar returns the running delegation count.
func DelegationsSoFar() int { return delegationsUsed }

// ---------------------------------------------------------------------------
// TickDeadline -- the wall-clock deadline's LEAF half.
//
// THE HOLE THIS FILLS. Until this existed, all three of this tool's budgets were blind to a leaf
// feature. The write budget counts SetBlock ATTEMPTS, and every long loop in this package has a
// path that writes nothing (geode's `density < tC4 -> continue`, ore's membership miss, the
// carver's broad-phase reject, tree's every survivability refusal). The delegation budget and the
// deadline were both checked in exactly one place -- WithRecursionGuard, i.e. only when one
// feature delegates to another. A tree, a carver, a geode or an ore vein delegates to nothing, so
// a single pathological field on any of them ran with NOTHING watching it, and the
// `--placement-time-limit-ms` this tool advertises was, for those types, a promise it did not
// keep.
//
// WHY THE CLOCK AND NOT A COUNT. The sibling budgets are counts, and counts are better when they
// are available, because they are reproducible (see DelegationBudgetExceeded). They are NOT
// available here. Every one of these loops is bounded by a JSON field the real engine does not
// bound either -- ore's count, geode's max_radius, a dozen tree fields -- so any iteration ceiling
// would be a number this project invented and then implicitly advertised as the engine's, which is
// the one thing the hostile-input sweep that found this hole refused to do. A wall-clock deadline
// needs no such number: it bounds the WORK without claiming anything about what the engine allows.
//
// WHY IT IS SHAPED AS A COUNTDOWN. These calls sit in the hottest loops in the project (the carver
// alone reaches thousands of room and tunnel steps per placement, each carving a full ellipsoid),
// and a time.Now() per iteration would be its own performance bug -- it is tens of nanoseconds
// against loop bodies that are single-digit nanoseconds. So the fast path is one decrement of one
// package-level int and one branch, and the clock is only read when that counter runs out.
//
// WHAT IT ACTUALLY COSTS, measured rather than argued. The two heaviest ordinary placements in the
// public fixture pack tick ~36,500 times each (wiki:cave_demo, a full 289-chunk carve; and
// wiki:amethyst_geode). Every other fixture is under 500, and the three trees are under 100. At
// the ~0.5ns/call BenchmarkTickDeadline measures for the unarmed fast path in an empty loop, that
// is about 18 microseconds against a carve that takes ~16 milliseconds -- roughly a tenth of one
// percent, and below what goldentest's BenchmarkCarvePlacement can resolve against its own
// run-to-run variance. That ratio is what justifies the call sites being placed one loop level ABOVE
// the innermost cell scan wherever an enclosing loop exists: bounding overshoot to one row of cells
// is enough, and it keeps the tick out of the loops that actually dominate a carve.
//
// WHY THE COUNTDOWN RE-TUNES ITSELF. A fixed N cannot be right for every site at once: the same N
// that keeps the clock read amortized to nothing in ore's inner sphere test (a few ns per step)
// lets the carver's per-tunnel-step site (a whole ellipsoid carve, microseconds per step) overshoot
// the deadline by orders of magnitude. Rather than hand-tuning an N per call site -- eighty numbers
// nobody would keep honest -- the reload is derived from measurement: each clock read compares the
// wall-clock time actually spent since the previous one against deadlineTickTargetNs and rescales
// the reload proportionally. Cheap sites drive it to deadlineTickMax and cost nothing; expensive
// sites drive it to deadlineTickMin and stay responsive. The clamps are what make that safe: the
// reload can never grow past deadlineTickMax, so the deadline cannot be tuned into silence by any
// sequence of measurements, however wrong.
// ---------------------------------------------------------------------------

const (
	// deadlineTickTargetNs is the wall-clock interval TickDeadline aims to leave between two
	// consecutive time.Now() reads. 1ms is three decimal orders below the smallest deadline anyone
	// sets in practice (the default is 8000ms) and four above the cost of the read itself, so the
	// clock is neither a measurable cost nor a coarse one.
	deadlineTickTargetNs = 1_000_000
	// deadlineTickMin/deadlineTickMax clamp the self-tuned reload. The floor is 1 -- read the
	// clock every step -- and that is deliberate rather than lazy: the tuner only ever reaches the
	// floor at a site whose single step already costs milliseconds, where a 50ns clock read is
	// five decimal orders below the noise. A higher floor would buy nothing there and would cap
	// how tightly the deadline can hold at exactly the sites that most need it to. The ceiling is
	// the safety property: however far the tuner is misled, at most deadlineTickMax ticks can pass
	// without the clock being consulted, so a deadline can never be tuned into silence.
	deadlineTickMin = 1
	deadlineTickMax = 1 << 20
	// deadlineTickUnarmed is the reload used when no deadline is armed at all -- the goldentest
	// harness's SetDelegationBudget path, every unit test in this package, and any library caller
	// that wants only the count budget. Large enough that the slow path is entered roughly never,
	// so an unarmed run pays exactly one decrement and one predictable branch per tick and nothing
	// else: no clock read, no allocation, no map.
	deadlineTickUnarmed = 1 << 30
)

var (
	// deadlineTicks counts DOWN to the next clock read. Starts unarmed so that a caller who never
	// touches SetDelegationBudgetMs at all (the digest harness, most tests) is on the free path
	// from the first tick.
	deadlineTicks = deadlineTickUnarmed
	// deadlineInterval is the current reload for deadlineTicks -- see the header above.
	deadlineInterval = deadlineTickMin
	// deadlineLastRead is when the clock was last read, the baseline the reload is tuned against.
	deadlineLastRead time.Time
)

// TickDeadline reports one step of a leaf feature's own loop against the wall-clock placement
// deadline, panicking with *PlacementDeadlineExceeded (naming site) once that deadline has passed.
// It is a no-op, costing one decrement and one branch, whenever no deadline is armed.
//
// site is a short phrase naming what is running, present-participle, and should name the JSON
// FIELD that drives the loop wherever there is one: "scanning the block volume its max_radius
// covers", not "in geode". The identity of the feature itself does not belong in it -- Chain
// carries that, captured at the panic. What Chain cannot carry is which of a feature's several
// loops was the slow one, and that is the whole job of this argument. site is only ever read on
// the slow path, so a constant string here costs nothing per tick.
//
// DELIBERATELY NOT COUNTED AGAINST THE DELEGATION BUDGET. It would be easy to make each tick also
// increment delegationsUsed and get a reproducible count-based bound for free. It would also be
// wrong twice over. It would change what a user-visible number MEANS -- DelegationBudget is
// documented, in the CLI and in the wire protocol, as a count of nested feature placements, and a
// geode that ticks a million times placing one ordinary amethyst geode does not delegate even
// once. And it would abort ordinary placements: that same geode alone would consume a large
// fraction of the 2,000,000 default. The count budget bounds delegation; the clock bounds work;
// conflating them would break the first to duplicate the second.
//
// NOT SAFE FOR CONCURRENT PLACEMENT, exactly like delegationBudget/delegationsUsed/inProgress
// above, and for the same reason: this package's placement model is one placement at a time per
// process. This adds no new constraint, only more state under the existing one.
func TickDeadline(site string) {
	deadlineTicks--
	if deadlineTicks <= 0 {
		tickDeadlineSlow(site)
	}
}

// tickDeadlineSlow is TickDeadline's off-the-hot-path half: read the clock, panic if the deadline
// has passed, otherwise re-tune and reload the countdown. Kept out of line so TickDeadline itself
// stays small enough for the inliner.
func tickDeadlineSlow(site string) {
	if deadlineAt == nil && cancelDone == nil {
		deadlineTicks = deadlineTickUnarmed
		return
	}
	// Checked here, on the countdown's slow half, rather than in TickDeadline itself: that keeps
	// the per-iteration cost of cancellation at exactly zero (the hot path is the same decrement
	// and branch it always was) while still noticing within the ~1ms the countdown is tuned to
	// leave between two clock reads. A user pressing Cancel cannot tell 1ms from 0.
	CheckPlacementCancel(site)
	now := time.Now()
	if deadlineAt != nil && now.After(*deadlineAt) {
		limitMs := 0
		if configuredTimeLimitMs != nil {
			limitMs = *configuredTimeLimitMs
		}
		// Chain captured HERE, at the raise, for the same reason WithRecursionGuard captures its
		// own: every enclosing Place call's deferred PopFeatureFrame has already run by the time
		// a caller's recover() sees this.
		panic(&PlacementDeadlineExceeded{
			Delegations: delegationsUsed, LimitMs: limitMs, Site: site, Chain: profiler.CurrentChain(),
		})
	}

	// Proportional re-tune: scale the reload by (target / measured), so one adjustment lands on
	// the right order of magnitude rather than halving/doubling its way there over many checks.
	// int64 throughout: deadlineInterval*deadlineTickTargetNs reaches ~1e12 at the ceiling, which
	// is fine in a 64-bit int and is not on a 32-bit one.
	elapsed := now.Sub(deadlineLastRead).Nanoseconds()
	if elapsed <= 0 {
		// Below the clock's own resolution -- this site is far cheaper than one timer tick, so
		// there is nothing to scale against. Grow by a bounded factor rather than dividing by
		// zero, and let the next measurement do the real calibration.
		deadlineInterval *= 8
	} else {
		// One step, not a ladder: the measurement says directly how many ticks fit in the target
		// interval, so use it. A ladder (halve/double until it fits) would take several checks to
		// climb, and every check on the way up overshoots by its own reload -- which is exactly
		// how a deadline ends up being noticed a hundred times late. A wildly wrong measurement
		// cannot do damage here because deadlineTickMax bounds the result regardless.
		deadlineInterval = int(int64(deadlineInterval) * deadlineTickTargetNs / elapsed)
	}
	if deadlineInterval < deadlineTickMin {
		deadlineInterval = deadlineTickMin
	}
	if deadlineInterval > deadlineTickMax {
		deadlineInterval = deadlineTickMax
	}
	deadlineLastRead = now
	deadlineTicks = deadlineInterval
}

// WithRecursionGuard runs fn (a delegated target.Place() call) with wrapper
// marked in-progress for the duration — the same shape as the engine's own
// recursion guard: the count-based delegation budget, plus (when armed
// via SetDelegationBudgetMs) a wall-clock deadline checked at the same
// roughly-every-1024-delegations cadence used elsewhere here.
func WithRecursionGuard(wrapper wgen.IFeature, fn func() *wgen.BlockPos) *wgen.BlockPos {
	if delegationBudget != nil {
		delegationsUsed++
		if delegationsUsed > *delegationBudget {
			// profiler.CurrentChain() is captured HERE, before panic unwinds through every
			// enclosing Place call's own deferred PopFeatureFrame -- by the time a caller's
			// recover() runs, the stack this would read is already empty. See profiler.go's
			// "Always-on delegation chain" doc comment.
			panic(&DelegationBudgetExceeded{Budget: *delegationBudget, Attempted: delegationsUsed, Chain: profiler.CurrentChain()})
		}
	}
	if delegationsUsed&0x3ff == 0 {
		// Cancellation rides the same every-1024-delegations cadence the deadline already uses,
		// and for the same reason: a delegating chain that never reaches a leaf loop (so never
		// ticks) still has to be stoppable, and 1024 delegations is short enough to be one of
		// those and long enough to cost nothing.
		CheckPlacementCancel("")
		if deadlineAt != nil && time.Now().After(*deadlineAt) {
			limitMs := 0
			if configuredTimeLimitMs != nil {
				limitMs = *configuredTimeLimitMs
			}
			panic(&PlacementDeadlineExceeded{Delegations: delegationsUsed, LimitMs: limitMs, Chain: profiler.CurrentChain()})
		}
	}
	// Profiler hook (the same call into the profiler package,
	// right before the in-progress flag below) -- counts one "delegation"
	// against wrapper, the composite performing THIS delegation, not the
	// resolved target. Reading profiler.ProfilingActive directly keeps the
	// disabled cost to one already-false check, no allocation, no map
	// lookup.
	if profiler.ProfilingActive {
		profiler.RecordDelegation(wrapper.Identifier(), wrapper.TypeID())
	}
	inProgress[wrapper] = true
	defer delete(inProgress, wrapper)
	return fn()
}

// ---------------------------------------------------------------------------
// Weighted pick -- the game's cumulative-weight walk, shared by the
// single-block feature and the weighted-random feature.
//
// The pick takes one BOUNDED INT draw, with the accumulated total as its
// bound. The game's bounded integer draw returns 0 with NO draw for
// bound == 0 and otherwise computes `raw 32-bit twister value % bound`, the
// exact contract rnd.NextIntBound implements. The same holds in 1.26.50.
//
// Two details that differ from a naive float-draw implementation:
//
//  1. The draw is a bounded integer draw of the total, not a float draw times the total.
//  2. The running totals are truncated to INT at every step. The game's
//     accumulator is `total = (int)(float)((float)total + weight)` per entry,
//     and the subtraction likewise `rem = (int)(float)((float)rem - weight)`.
//     For integer weights that is exact and only the draw type differs; for
//     FRACTIONAL weights the behaviour differs outright -- e.g. two entries of
//     weight 0.5 accumulate to a total of 0 in the game, so nothing is picked
//     at all, where a float accumulator picks one.
//
// The zero-total case DOES NOT SPEND A DRAW. The accumulation runs exactly
// like this:
//
//	an empty candidate list skips everything
//	the running total starts at 0 and lives in an INTEGER
//	per entry: widen the total to float, add this entry's float weight,
//	    then TRUNCATE straight back to an integer -- every entry
//	when the total is 0: skip the draw entirely, remaining = 0
//	otherwise: one bounded integer draw with the total as its bound
//
// The bound really is the truncated total. Note also that the zero-total
// path still ENTERS the subtraction loop with remaining = 0: with every
// weight 0 the running value never goes negative, so the loop runs off the
// end and the feature reports "Feature could not be selected". Nothing is
// picked, and no RNG is consumed on the way to saying so.
// ---------------------------------------------------------------------------

// WeightedPick returns the index of the picked candidate, or -1 if none was
// picked.
func WeightedPick(weights []float64, rnd random.IRandom) int {
	// Per-entry truncation, exactly as the engine accumulates it.
	total := 0
	for _, w := range weights {
		total = int(float32(total) + float32(w))
	}
	remaining := 0
	if total != 0 {
		// *** RNG CALL *** the engine's bounded integer draw, bound = total.
		remaining = rnd.NextIntBound(total)
	}
	for i, w := range weights {
		remaining = int(float32(remaining) - float32(w))
		if remaining < 0 {
			return i
		}
	}
	return -1
}

// ---------------------------------------------------------------------------
// Block-descriptor JSON helpers — asBlockDescriptor/
// asBlockDescriptorList/resolveIds.
// ---------------------------------------------------------------------------

// AsBlockDescriptor normalizes a decoded-JSON value into a block.Descriptor.
//
// EMPTY IS AN ERROR, EVERYWHERE, and this is the one place that says so. The
// game's block-descriptor schema takes a block NAME, and "" is not one: it
// resolves to no block, so the field it was written in does nothing at all --
// a places_block that places nothing, a may_replace entry that matches
// nothing, a base_block that is not a block. An editor writing a
// half-finished row (`+` on a weighted places_block produces
// `{"block": "", "weight": 1}`) produces exactly this, and a file whose only
// problem is invisible is the expensive kind.
//
// It is refused HERE rather than in each field's own parser for the same
// reason blocknames.go sweeps the whole body: a block descriptor appears in
// places_block, in a weighted entry's `block`, in may_replace / may_grow_on /
// may_attach_to / base_block / a structure constraint's allowlist, and in
// thirty other fields across a dozen parsers -- all of which already funnel
// through this function. One check here is the same check in every one of
// them, and there is no next field that can be added without it.
//
// The level matches the neighbouring "places_block must not be an empty
// array": an ERROR, because the game rejects the value rather than accepting
// it and doing nothing. Whitespace counts as empty -- " " is not a block name
// either, and reporting it as one would be a distinction no author can see.
func AsBlockDescriptor(value any, jsonPath string) (block.Descriptor, error) {
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return block.Descriptor{}, emptyBlockNameError(jsonPath)
		}
		return block.Descriptor{Name: v}, nil
	case map[string]any:
		if tags, ok := v["tags"].(string); ok {
			if strings.TrimSpace(tags) == "" {
				return block.Descriptor{}, fmt.Errorf("%s.tags must not be empty -- a tag descriptor is a "+
					"Molang query (for example \"q.any_tag('stone')\"), and an empty one matches no block, "+
					"so this field does nothing", jsonPath)
			}
			return block.Descriptor{IsTags: true, Tags: tags}, nil
		}
		if name, ok := v["name"].(string); ok {
			if strings.TrimSpace(name) == "" {
				return block.Descriptor{}, emptyBlockNameError(jsonPath + ".name")
			}
			var states map[string]block.StateValue
			if rawStates, ok := v["states"]; ok && rawStates != nil {
				m, ok := rawStates.(map[string]any)
				if !ok {
					return block.Descriptor{}, fmt.Errorf("%s.states must be an object", jsonPath)
				}
				states = make(map[string]block.StateValue, len(m))
				for k, sv := range m {
					states[k] = block.StateValue(sv)
				}
			}
			return block.Descriptor{Name: name, States: states}, nil
		}
	}
	return block.Descriptor{}, fmt.Errorf("%s must be a block name string, {name, states?}, or {tags}", jsonPath)
}

// emptyBlockNameError words the empty-block-name refusal once, so the sentence
// is the same whether the author wrote `""`, `{"name": ""}` or pressed `+` in
// an editor and left the new row alone.
func emptyBlockNameError(jsonPath string) error {
	return fmt.Errorf("%s must not be an empty block name -- the game takes a block id here "+
		"(for example \"minecraft:stone\") and rejects \"\", so this field places or matches nothing", jsonPath)
}

// AsBlockDescriptorList parses an array-of-block-descriptors field, tolerating
// absence (-> empty).
func AsBlockDescriptorList(value any, jsonPath string) ([]block.Descriptor, error) {
	if value == nil {
		return nil, nil
	}
	arr, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", jsonPath)
	}
	out := make([]block.Descriptor, len(arr))
	for i, v := range arr {
		d, err := AsBlockDescriptor(v, fmt.Sprintf("%s[%d]", jsonPath, i))
		if err != nil {
			return nil, err
		}
		out[i] = d
	}
	return out, nil
}

// AsBlockDescriptorOrList parses a field that accepts EITHER a single
// block descriptor (string / {name, states?} / {tags}) as shorthand for a
// one-element list, OR a JSON array of block descriptors -- tolerating
// absence (-> empty), same as AsBlockDescriptorList.
//
// This is NOT a general relaxation of AsBlockDescriptorList: it mirrors one
// specific schema shape, and must only be used for the fields that shape
// actually covers.
//
// In the game, each attach-condition face key (e.g. "top") accepts BOTH a
// single block descriptor AND an array of block descriptors. The same rule
// applies to every face -- top/bottom/north/south/east/west/all/sides -- so
// every may_attach_to (and may_not_attach_to, built the same way when
// present) face field accepts a bare descriptor as shorthand for a
// one-element list:
//
//	"may_attach_to": { "east": "example:branch_log", "top": "example:canopy_leaves" }
//
// This either-form shape is the EXCEPTION, not the rule, for "list of block
// descriptor" JSON fields. Each of these accepts ONLY an array:
//   - may_replace: in the single-block feature and the ore feature
//   - allowed_surface_blocks: in the snap-to-surface feature
//   - replaceable_blocks: in the vegetation-patch feature
//   - block_allowlist (aka block_whitelist): in the block-intersection
//     constraint
//
// The tree feature's may_grow_on/may_replace/may_grow_through have not been
// individually confirmed either way; every other "list of block descriptor"
// field outside the attach-condition fields is array-only, so tree.go's
// three AsBlockDescriptorList uses are left strict, consistent with that
// pattern, rather than loosened on assumption. A genuinely malformed value
// (a number, a nested array, an object with neither name nor tags) still
// produces AsBlockDescriptor's own clear, field-named error either way.
func AsBlockDescriptorOrList(value any, jsonPath string) ([]block.Descriptor, error) {
	if value == nil {
		return nil, nil
	}
	if _, isArray := value.([]any); isArray {
		return AsBlockDescriptorList(value, jsonPath)
	}
	d, err := AsBlockDescriptor(value, jsonPath)
	if err != nil {
		return nil, err
	}
	return []block.Descriptor{d}, nil
}

// normalizeAllowListBits forces update_bit and persistent_bit to 0 on a block
// that is about to be compared against a may_replace / may_attach_to style
// descriptor. The engine's placement allow-list check does this to the WORLD
// block, and only to the world block -- the descriptor keeps whatever the pack
// author wrote.
//
// That asymmetry has a consequence worth stating, because it looks like a bug
// in a pack rather than a rule: a descriptor asking for update_bit=true can
// never match anything, since no block still has the bit set by the time the
// comparison runs. See features/single_block_allowlist_bits_test.go.
//
// Only leaves carry these two states, so this is invisible everywhere else --
// and leaves are exactly what a may_replace list names when a feature is meant
// to grow through a canopy.
//
// Each bit is applied independently and only when the block actually exposes
// it: WithIntState on a block with no such state would otherwise invent one.
func normalizeAllowListBits(pal *block.Palette, id block.ID) block.ID {
	if pal == nil {
		return id
	}
	if _, ok := pal.StateInt(id, block.UpdateBit); ok {
		if derived, ok2 := pal.WithIntState(id, block.UpdateBit, 0); ok2 {
			id = derived
		}
	}
	if _, ok := pal.StateInt(id, block.PersistentBit); ok {
		if derived, ok2 := pal.WithIntState(id, block.PersistentBit, 0); ok2 {
			id = derived
		}
	}
	return id
}

// ResolveMatchSet resolves a list of block descriptors for a PREDICATE/
// match-list position (may_replace, may_attach_to, allowed_surface_blocks,
// and similar "is this candidate one of these" fields) into a
// block.MatchSet -- the counterpart of calling ctx.Palette.Resolve directly
// for a PRODUCING position (places_block and similar). field is used only
// to name the JSON field in the diagnostic raised for a tag this port
// cannot resolve from any real source (see block.Palette.NewMatchSet's
// unknownTag callback) -- ctx.Identifier names the feature itself, so the
// message can point at both without the caller repeating that plumbing.
//
// The set compares under block.MatchPartial, which is what the engine does for
// every match list EXCEPT two. Those two call ResolveMatchSetMode and say which
// they are, so the exception is visible at its own call site rather than in a
// table someone has to remember to consult. Read block.MatchMode before adding
// a caller: which comparison applies is a property of the JSON FIELD, and
// picking the wrong one is silent -- an over-strict list makes a feature place
// nothing, which no digest in this repo can distinguish from a feature that was
// never supposed to run.
func ResolveMatchSet(descs []block.Descriptor, ctx *BuildContext, field string) block.MatchSet {
	return resolveMatchSet(descs, ctx, field, block.MatchPartial)
}

// resolveMatchSet is the shared body. The mode reaches it because one of the
// diagnostics it raises is only true for one mode.
func resolveMatchSet(descs []block.Descriptor, ctx *BuildContext, field string, mode block.MatchMode) block.MatchSet {
	set := ctx.Palette.NewMatchSet(descs, func(tagName string) {
		ctx.Warn(fmt.Sprintf(
			"%s (%s): tag %q could not be resolved -- it is declared by neither the loaded pack's own blocks/**/*.json "+
				"nor the small curated approximate vanilla-tag table, so it is treated as never present on any block",
			ctx.Identifier, field, tagName))
	}, func(queryName string) {
		ctx.Warn(fmt.Sprintf(
			"%s (%s): this list calls query.%s, which is not a query a block predicate can answer. "+
				"THE REAL GAME REFUSES THE WHOLE FILE over this: an unknown query name is rejected when "+
				"the expression is tokenised, with \"Failed to resolve query %s. Either the query does "+
				"not exist or it is not supported in this context.\" -- it never reaches evaluation at "+
				"all. This tool is more forgiving: the name reads as 0, so the expression is simply "+
				"false for every block and this entry matches nothing. Only query.any_tag and "+
				"query.all_tags are available in a block predicate; check the spelling (q.any_tags is "+
				"one letter from q.any_tag and parses fine)",
			ctx.Identifier, field, queryName, queryName))
	}, func(expr string) {
		// A predicate that draws is legal Molang, and before this it crashed the process: the
		// evaluator dereferences its RNG without checking and nothing here supplied one.
		// It now gets a deterministic generator seeded from the expression, so a run is
		// reproducible -- which is this project's standing policy for every place the engine's
		// own randomness comes from a source with no world seed (see features/cave.go's header),
		// and which still has to be disclosed, because a preview that reproduces is not a preview
		// that matches.
		ctx.Warn(fmt.Sprintf(
			"%s (%s): this list draws randomness (math.random and friends). This tool evaluates it "+
				"against a generator seeded from the expression text, so the same pack gives the same "+
				"answer every run -- but the real game draws from a process-global source with no "+
				"connection to the world seed, which does not agree with this and does not agree with "+
				"itself between two runs of the game either. Expect different blocks here and there",
			ctx.Identifier, field))
	})
	// A list every one of whose entries failed to build is a restriction this tool cannot
	// evaluate, and it has to be loud, because the alternative failure is silent and the wrong
	// way round. Until this was caught, such a list collapsed to "no list at all" -- every
	// predicate site here reads an empty MatchSet as "no restriction, anything matches" -- so
	// one typo in a may_replace expression turned the strictest possible list into the most
	// permissive one, and a feature written to leave terrain alone carved straight through it
	// with nothing reported anywhere.
	//
	// The set now matches NOTHING instead, which is the safe direction, and this says so. The
	// runtime failure an author would otherwise see ("may_replace rejected this position") is
	// actively misleading here: the list is not the problem, the expression in it is.
	if set.Unbuildable() {
		ctx.Warn(fmt.Sprintf(
			"%s (%s): every entry in this list is a Molang expression this tool could not parse or "+
				"compile, so the list matches NOTHING and this feature will place nothing. Check the "+
				"expression's syntax and its query names -- a misspelled query (q.any_tags instead of "+
				"q.any_tag, say) parses fine and then evaluates to 0 forever.",
			ctx.Identifier, field))
	}
	// A read of a variable a block predicate has nowhere to read from. The engine
	// would END the expression at that read (molang-go's eval/unresolved.go);
	// this tool substitutes 0 and carries on, and this is where it says so.
	// Reported from the expression's own AST at build time rather than per
	// candidate block -- see block.MatchSet.UnsetReads.
	for _, name := range set.UnsetReads() {
		ctx.Warn(fmt.Sprintf(
			"%s (%s): this list reads %s, and a block predicate has no Molang scope to read it "+
				"from -- nothing here ever sets it, whatever the rest of the pack does. In game an "+
				"unresolved read STOPS the expression where it stands, so the entry would be false "+
				"for every block; this tool reads it as 0 and evaluates the rest, which may not "+
				"agree. Guard it with `%s ?? <default>` to say what you meant, or drop it -- only "+
				"query.any_tag and query.all_tags carry information here.",
			ctx.Identifier, field, name, name))
	}
	// A descriptor that spells states out is the one shape this port cannot always
	// decide under MatchPartial. The engine compares the written states against the
	// candidate's real, fully concrete permutation; here a candidate interned with
	// no value for one of those states stands for its type's default, and nothing
	// in this package knows what that default is yet. statesSatisfied answers false
	// there -- the old, stricter behaviour -- so this warns rather than letting an
	// author believe a list is doing something it may not be.
	//
	// Rare in practice: very few descriptors in real packs spell states, and
	// those that do are almost always in a may_replace.
	warnAboutStatedEntries(set, ctx, field, mode)
	return set
}

// warnAboutStatedEntries tells an author what writing states into a match list
// actually costs, which is a different answer for each of the three
// comparisons -- and saying the wrong one is worse than saying nothing, because
// it sends them to rewrite a file that is not broken.
//
// This was that warning: it fired for every mode, said the game compares only
// the states you wrote (true of one mode of three), and claimed this tool has
// no default-state registry to complete an unwritten state with (true until the
// catalogue landed, and false by the time the warning shipped). Three wrong
// statements to every author who tripped it.
func warnAboutStatedEntries(set block.MatchSet, ctx *BuildContext, field string, mode block.MatchMode) {
	if !set.HasStatedEntries() {
		return
	}
	switch mode {
	case block.MatchType:
		// Ore's replace-rule accelerator keeps the block type and throws the
		// states away, so the entry is doing nothing at all.
		ctx.Warn(fmt.Sprintf(
			"%s (%s): an entry in this list spells out block states, and the game IGNORES them "+
				"here -- this field compares the block type alone, so the entry behaves exactly "+
				"as if you had written the bare block name. The states are not narrowing "+
				"anything; drop them, or move the restriction to a field that honours it.",
			ctx.Identifier, field))
	case block.MatchExact:
		ctx.Warn(fmt.Sprintf(
			"%s (%s): an entry in this list spells out block states. This field compares the "+
				"WHOLE block -- the name and every state at its concrete value -- so an entry "+
				"matches only a cell that agrees on every state, not just the ones you wrote. "+
				"A bare block name here means that block's default state, which is usually what "+
				"you want.",
			ctx.Identifier, field))
	default:
		ctx.Warn(fmt.Sprintf(
			"%s (%s): an entry in this list spells out block states. The game compares only the "+
				"states you wrote, against the candidate block's own concrete values, and ignores "+
				"every other state it carries; this tool does the same, filling in a state the "+
				"candidate cell does not carry from that block type's own default. For a block "+
				"this bench does not know -- your pack's own blocks -- there is no default to "+
				"fill in, so such an entry matches only a cell spelled the same way. Writing the "+
				"entry as a bare block name avoids the question entirely, and is what 99.8%% of "+
				"vanilla descriptors do.",
			ctx.Identifier, field))
	}
}

// ResolveMatchSetMode is ResolveMatchSet for the two fields whose comparison is
// NOT the usual partial predicate: ore's replace_rules[].may_replace, which
// compares block TYPE and discards any states the author wrote, and scatter's
// allowed_surface_blocks, which compares the full serialization id -- name and
// every state at its concrete value. Both are stated at their own call sites;
// see block.MatchMode for what the engine does in each case.
func ResolveMatchSetMode(descs []block.Descriptor, ctx *BuildContext, field string, mode block.MatchMode) block.MatchSet {
	return resolveMatchSet(descs, ctx, field, mode).WithMode(mode)
}

// jsonTruthy mirrors JS's Boolean(x) coercion for a decoded-JSON value:
// false for nil/false/0/"" , true otherwise.
func jsonTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

// LogFailure calls ctx.LogFailure if present, at ctx.Origin -- every LogFailure call site in this
// package passes featureType/message only (never a position), so this is the one place that
// attaches WHERE: ctx.Origin at the moment of the call is exactly the position the currently-
// executing feature was attempting to place at, whether that's the top-level origin or a nested
// composite's own re-targeted sub-position (ctx.WithOrigin). The caller-side signature of
// ctx.LogFailure carries the position explicitly (rather than each of the ~20 call sites across
// this package's feature types passing it themselves) so none of them needed to change when this
// field was added.
func LogFailure(ctx *wgen.PlacementContext, featureType, message string) {
	if ctx.LogFailure != nil {
		ctx.LogFailure(featureType, message, ctx.Origin)
	}
}

// LogWarning calls ctx.LogWarning if present -- for a disclosed port gap that fired without
// refusing placement (the feature keeps placing normally either side of the call), never for an
// actual failure (use LogFailure for those). Unlike LogFailure, pos is caller-supplied and may be
// nil: pass nil for a diagnostic about the feature's configuration as a whole (not tied to one
// write attempt), a real position for one that is -- see wgen.PlacementContext.LogWarning's own
// doc comment.
func LogWarning(ctx *wgen.PlacementContext, featureType, message string, pos *wgen.BlockPos) {
	if ctx.LogWarning != nil {
		ctx.LogWarning(featureType, message, pos)
	}
}

// FirstOf returns the first present value among body[aliases[i]], or nil.
// Used where a JSON field's real name is not established, and several
// plausible spellings are accepted.
func FirstOf(body map[string]any, aliases ...string) any {
	for _, key := range aliases {
		if v, ok := body[key]; ok {
			return v
		}
	}
	return nil
}

// describeBlockAt names the block at pos for a diagnostic, e.g. `minecraft:stone`.
//
// Exists because "target does not contain a block from the replace list" is a true sentence
// that tells the reader nothing actionable: the one fact they need is WHICH block is in the
// way. A real investigation into "my rule places nothing" ran for a long time before anyone
// checked what was actually at the target position.
func describeBlockAt(api wgen.BlockWorld, pos wgen.BlockPos) string {
	pal := api.Palette()
	if pal == nil {
		return "an unknown block"
	}
	name := pal.NameOf(api.GetBlock(pos))
	if name == "" {
		return "an unnamed block"
	}
	return name
}

// parseEngineRange reads one of the engine's range objects -- an int range or a float range --
// out of JSON.
//
// Three shapes are accepted, matching the game's validation for a range field, which (as seen
// for the nether cave carver's float ranges) branches exactly three ways.
//
//  1. An OBJECT must have BOTH `range_min` and `range_max` -- the only member names the game
//     accepts. Each value is then bound-checked against the field's own limits, which is where
//     `'range_min' with value '%f' outside valid range [%f, %f]` comes from.
//  2. An ARRAY must have exactly 2 elements. A different size logs `Float range array was not
//     parsed. Float range arrays should have 2 values.` and fails; a 2-element array falls through
//     to the base validator and is accepted.
//  3. Anything else -- in practice a bare number -- also falls through and is accepted, min == max.
//
// **The trap is the object's key names.** Given `{"min": 1, "max": 4}` the engine does NOT reject
// the field: it logs `Missing member(s): "range_min", "range_max" on "%s", defaulting to min/max of
// 0.` and carries on with a DEGENERATE {0,0} range. Nothing hard-fails. For a cave carver that means
// every radius multiplier and y_scale collapses to zero and it silently digs nothing. So min/max is
// REFUSED here rather than reproduced: a bench whose job is to tell an author what the game will do
// with their file must not quietly accept the one spelling that makes the game do nothing.
//
// Do not confuse this with the fields that genuinely DO use `min`/`max`: `canopy_offset`,
// `branch_altitude_factor` and `search_volume` are not Range objects at all, just structs whose two
// members happen to be named min and max, and they keep their own parsers. Mojang's own vanilla tree
// features spell both styles in a single file -- `trunk_height` as range_min/range_max,
// `canopy_offset` and `branch_altitude_factor` as min/max -- which looks inconsistent until you
// notice it tracks the field's underlying type exactly. Across those shipped files every Range-typed field uses
// range_min/range_max, and not one uses min/max.
func parseEngineRange(raw any, jsonPath string) (min, max float64, err error) {
	switch v := raw.(type) {
	case float64:
		return v, v, nil
	case []any:
		if len(v) != 2 {
			return 0, 0, fmt.Errorf("%s is a range array with %d values -- range arrays must have "+
				"exactly 2", jsonPath, len(v))
		}
		lo, loOK := v[0].(float64)
		hi, hiOK := v[1].(float64)
		if !loOK || !hiOK {
			return 0, 0, fmt.Errorf("%s must be a number, a 2-element array, or a "+
				"{range_min, range_max} object", jsonPath)
		}
		return lo, hi, nil
	case map[string]any:
		lo, loOK := v["range_min"].(float64)
		hi, hiOK := v["range_max"].(float64)
		if loOK && hiOK {
			return lo, hi, nil
		}
		_, hasMin := v["min"]
		_, hasMax := v["max"]
		if hasMin || hasMax {
			return 0, 0, fmt.Errorf("%s uses {min, max}, but this field is a range and the engine "+
				"reads only {range_min, range_max} -- given min/max it logs an error and silently "+
				"substitutes a zero-width range, so the file would load in-game and then do nothing",
				jsonPath)
		}
		return 0, 0, fmt.Errorf("%s object must have range_min and range_max", jsonPath)
	}
	return 0, 0, fmt.Errorf("%s must be a number, a 2-element array, or a {range_min, range_max} object", jsonPath)
}
