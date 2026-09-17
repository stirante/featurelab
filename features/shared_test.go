package features

import (
	"strings"
	"testing"
	"time"

	"github.com/stirante/featurelab/wgen"
)

// shared_test.go exercises WithRecursionGuard's two budgets (features/shared.go) -- in particular
// the diagnostic TEXT a user actually sees when either one trips, which is the whole point of the
// determinism-legibility work these tests pin: a DelegationBudgetExceeded truncation is reproducible
// (a pure delegation count, no wall-clock component), while a PlacementDeadlineExceeded truncation
// is NOT (it depends on how fast this particular run happened to be) -- see both error types' own
// doc comments in shared.go. A user must be able to tell the two apart from the message alone,
// without reading this file or shared.go.

// shardStubFeature is a minimal wgen.IFeature -- WithRecursionGuard's own inProgress map is keyed
// on the wrapper instance, so any comparable IFeature value works; this file only needs one that
// never actually gets invoked (fn is what WithRecursionGuard calls, not wrapper.Place itself).
type sharedStubFeature struct{ id string }

func (s *sharedStubFeature) TypeID() string     { return "test:shared_stub" }
func (s *sharedStubFeature) Identifier() string { return s.id }
func (s *sharedStubFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	return nil
}

var _ wgen.IFeature = (*sharedStubFeature)(nil)

// resetDelegationGuardState restores shared.go's package-level budget state to "no budget armed",
// both before and after a test that arms one -- these are process-global vars, so a test that
// forgets to clean up after itself would leak a budget into every OTHER test in this package that
// happens to call WithRecursionGuard afterward (composite-feature Place() tests throughout this
// package all go through it indirectly).
func resetDelegationGuardState(t *testing.T) {
	t.Helper()
	SetDelegationBudgetMs(nil, nil)
	t.Cleanup(func() { SetDelegationBudgetMs(nil, nil) })
}

// TestDelegationBudgetExceeded_Error_StatesReproducible pins the count-based budget's own
// diagnostic text: it must describe itself as reproducible/count-based, the positive half of the
// contrast this project's determinism policy draws against the wall-clock deadline below.
func TestDelegationBudgetExceeded_Error_StatesReproducible(t *testing.T) {
	e := &DelegationBudgetExceeded{Budget: 10, Attempted: 11}
	msg := e.Error()
	if !strings.Contains(msg, "reproducible") {
		t.Errorf("DelegationBudgetExceeded.Error() = %q, want it to state it is reproducible", msg)
	}
	if !strings.Contains(msg, "count") {
		t.Errorf("DelegationBudgetExceeded.Error() = %q, want it to describe itself as count-based", msg)
	}
}

// TestPlacementDeadlineExceeded_Error_StatesNotReproducibleAndPointsAtCountBudget pins the
// wall-clock deadline's own diagnostic text: it must say plainly that its own truncation point is
// NOT reproducible (unlike DelegationBudgetExceeded above), and must point a user who wants a
// reproducible truncation limit at the count-based budget instead -- exactly what the task asked
// this diagnostic to make legible, so a preview that changed because THIS run happened to be slow
// is never mistaken for one that changed because of a code edit or a different seed.
func TestPlacementDeadlineExceeded_Error_StatesNotReproducibleAndPointsAtCountBudget(t *testing.T) {
	e := &PlacementDeadlineExceeded{Delegations: 42, LimitMs: 8000}
	msg := e.Error()
	if !strings.Contains(msg, "NOT REPRODUCIBLE") {
		t.Errorf("PlacementDeadlineExceeded.Error() = %q, want it to state NOT REPRODUCIBLE plainly", msg)
	}
	if !strings.Contains(msg, "delegation budget") {
		t.Errorf("PlacementDeadlineExceeded.Error() = %q, want it to point at the count-based delegation budget as the deterministic alternative", msg)
	}
	if !strings.Contains(msg, "8000") {
		t.Errorf("PlacementDeadlineExceeded.Error() = %q, want the configured limit (8000ms) to appear", msg)
	}
}

// TestWithRecursionGuard_DeadlineExceeded_PanicsWithDistinguishingMessage is the end-to-end
// behavioral proof: arming ONLY a wall-clock deadline (no count budget) and letting it elapse must
// panic with a *PlacementDeadlineExceeded whose own Error() carries the NOT REPRODUCIBLE text --
// not a generic error, and not silently truncated with no explanation. delegationBudget==nil means
// delegationsUsed is never incremented by WithRecursionGuard itself (see shared.go), so the
// `delegationsUsed&0x3ff == 0` deadline-check cadence fires on every single call in this
// configuration -- the very first WithRecursionGuard call after the deadline elapses trips it.
func TestWithRecursionGuard_DeadlineExceeded_PanicsWithDistinguishingMessage(t *testing.T) {
	resetDelegationGuardState(t)

	limitMs := 1
	SetDelegationBudgetMs(nil, &limitMs)
	time.Sleep(5 * time.Millisecond) // guarantee the 1ms deadline has genuinely elapsed

	wrapper := &sharedStubFeature{id: "test:deadline"}

	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected WithRecursionGuard to panic once its wall-clock deadline elapsed, got no panic")
		}
		e, ok := r.(*PlacementDeadlineExceeded)
		if !ok {
			t.Fatalf("panic value = %T (%v), want *PlacementDeadlineExceeded", r, r)
		}
		if !strings.Contains(e.Error(), "NOT REPRODUCIBLE") {
			t.Errorf("PlacementDeadlineExceeded.Error() = %q, want NOT REPRODUCIBLE stated plainly", e.Error())
		}
	}()

	WithRecursionGuard(wrapper, func() *wgen.BlockPos {
		t.Fatal("fn must not run -- the deadline should have panicked before calling it")
		return nil
	})
}

// TestWithRecursionGuard_CountBudgetAlone_NeverPanicsOnDeadlineMessage: a sanity check that a count
// budget with NO wall-clock deadline armed (SetDelegationBudget, this project's own recommended
// "reproducible truncation" path) never produces a PlacementDeadlineExceeded, only ever the
// count-based DelegationBudgetExceeded -- the two must stay genuinely distinct failure modes, not
// just distinct message text on what could otherwise be the same trigger.
func TestWithRecursionGuard_CountBudgetAlone_NeverPanicsOnDeadlineMessage(t *testing.T) {
	resetDelegationGuardState(t)

	budget := 2
	SetDelegationBudget(&budget)

	wrapper1 := &sharedStubFeature{id: "test:a"}
	wrapper2 := &sharedStubFeature{id: "test:b"}
	wrapper3 := &sharedStubFeature{id: "test:c"}

	// Two calls stay within budget.
	WithRecursionGuard(wrapper1, func() *wgen.BlockPos { return nil })
	WithRecursionGuard(wrapper2, func() *wgen.BlockPos { return nil })

	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected the third call to trip the count budget")
		}
		if _, ok := r.(*DelegationBudgetExceeded); !ok {
			t.Fatalf("panic value = %T (%v), want *DelegationBudgetExceeded (never *PlacementDeadlineExceeded, no deadline was armed)", r, r)
		}
	}()
	WithRecursionGuard(wrapper3, func() *wgen.BlockPos { return nil })
}

// tickSink keeps the loop in BenchmarkTickDeadline from being optimised away wholesale, and gives
// the baseline something to do that costs the same as what the ticked loop does around the call.
var tickSink int

// BenchmarkTickDeadline measures the ONE thing that decides whether the leaf half of the
// wall-clock deadline was worth adding: what a TickDeadline call costs when nothing is wrong.
// These calls sit in the hottest loops in this project (a single cave carve makes ~36,500 of
// them), so a fix that is cheap in principle and expensive in practice would be a bad trade --
// the pathological placement it bounds is rare and the ordinary one it taxes is every run.
//
// Read the three together, not any one alone:
//
//   - unarmed vs. baseline is what a caller who armed only the count budget pays -- the golden
//     digest harness, every test in this package, any library caller wanting reproducibility.
//   - armed vs. unarmed must be ~zero. If arming the deadline is measurably more expensive than
//     not arming it, the clock is being read inside the loop and the countdown is not working.
//   - baseline is the empty loop, i.e. how much of the difference is the loop itself.
//
// An empty loop exaggerates the cost: measured this way the call is around half a nanosecond,
// but against real work it is far cheaper than that ratio suggests, because the decrement and its
// perfectly-predicted branch overlap with everything else in flight. goldentest's
// BenchmarkCarvePlacement is the end-to-end counterpart and shows the whole-carve effect sitting
// below that benchmark's own run-to-run noise.
func BenchmarkTickDeadline(b *testing.B) {
	b.Run("baseline/no-call", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			tickSink++
		}
	})
	b.Run("unarmed", func(b *testing.B) {
		SetDelegationBudgetMs(nil, nil)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			TickDeadline("bench")
			tickSink++
		}
	})
	b.Run("armed", func(b *testing.B) {
		limit := 3_600_000 // an hour: armed, never reachable, so this times the tick and nothing else
		SetDelegationBudgetMs(nil, &limit)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			TickDeadline("bench")
			tickSink++
		}
		b.StopTimer()
		SetDelegationBudgetMs(nil, nil)
	})
}
