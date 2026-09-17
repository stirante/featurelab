package goldentest

import "testing"

// reportAndAssert is shared by every digest baseline in this package, so it
// lives in its own always-present file: a helper defined only in an optional,
// locally-kept test file would leave a plain checkout unable to build this
// package's tests at all.

// digestPath is where goldengen writes the digest for the pack at
// FEATURELAB_PACK_DIR. It is local output, not part of the repository, and
// every reader treats its absence as normal.
const digestPath = `testdata/feature_placement_digest.json`

// reportAndAssert logs r's summary and turns it into pass or fail. Both
// baselines call it, so a divergence means the same thing and is reported the
// same way whichever pack found it.
//
// Everything here except the final block only LOGS, and `go test` hides logs
// for passing tests, so without the assertions the suite would stay green at
// any match rate -- including zero. The whole point of a golden dump is that a
// divergence fails loudly; a report nobody is forced to read is worse than no
// check, because it looks like one.
func reportAndAssert(tb testing.TB, title string, r *CompareReport) {
	tb.Helper()

	tb.Logf("=== %s ===", title)
	tb.Logf("in-scope (entire delegation chain covered): %d", r.InScope)
	tb.Logf("  build failed in Go:        %d", r.BuildFailed)
	tb.Logf("  missing from golden:       %d", r.MissingFromDigest)
	tb.Logf("  not pinned by reference:   %d", r.RefExcluded)
	tb.Logf("  budget hit in Go only:     %d", r.BudgetMismatch)
	tb.Logf("  BOTH write+draw match:     %d", r.BothMatch)
	tb.Logf("  write matched, draw not:   %d", r.WriteOnlyMatch)
	tb.Logf("  draw matched, write not:   %d", r.DrawOnlyMatch)
	tb.Logf("  NEITHER matched:           %d", r.NeitherMatch)
	tb.Logf("  returned-position mismatch: %d", r.ReturnedMismatch)
	tb.Logf("  scope mismatch:            %d", r.ScopeMismatch)
	for _, m := range r.FirstMismatches {
		tb.Logf("MISMATCH: %s", m)
	}
	for _, m := range r.ScopeMismatches {
		tb.Logf("SCOPE MISMATCH: %s", m)
	}

	if r.Compared() == 0 {
		tb.Fatalf("no in-scope features were compared -- something is wrong with pack loading or scope detection")
	}

	if failed := r.Failed(); failed > 0 {
		// Spell out which hash MOVED, not which one matched. This line used to read
		// "(write-only N, draw-only N, neither N)" using the field names, where WriteOnlyMatch
		// means "the write hash matched and the DRAW hash moved" -- so a pure write divergence
		// printed as "draw-only 1", which reads as the alarm condition (the RNG moved) when it is
		// the opposite. It cost a real reader a wrong conclusion; say what moved instead.
		tb.Errorf("%d of %d in-scope features diverge from the golden reference "+
			"(%d moved DRAWS only, %d moved WRITES only, %d moved both)",
			failed, r.Compared(), r.WriteOnlyMatch, r.DrawOnlyMatch, r.NeitherMatch)
	}
	if r.ReturnedMismatch > 0 {
		tb.Errorf("%d features returned a different placement position than the reference", r.ReturnedMismatch)
	}
	if r.ScopeMismatch > 0 {
		// temp./variable. cross feature boundaries, so a scope divergence surfaces as a
		// wrong placement somewhere else entirely and much later.
		tb.Errorf("%d features left a different Molang scope than the reference", r.ScopeMismatch)
	}
	if r.BuildFailed > 0 {
		tb.Errorf("%d in-scope features failed to build in Go but are pinned in the reference", r.BuildFailed)
	}
	if r.BudgetMismatch > 0 {
		tb.Errorf("%d features hit a budget in Go that the reference completed", r.BudgetMismatch)
	}
	if r.MissingFromDigest > 0 {
		tb.Errorf("%d in-scope features have no golden entry and were silently skipped", r.MissingFromDigest)
	}

	// Every in-scope chain must land in exactly one bucket. If the totals stop adding up,
	// some path acquired a `continue` that drops chains without accounting for them, and
	// the headline count would then overstate what was actually verified.
	if r.Accounted() != r.InScope {
		tb.Errorf("bucket totals (%d) do not account for all %d in-scope chains -- %d unaccounted for",
			r.Accounted(), r.InScope, r.InScope-r.Accounted())
	}
}
