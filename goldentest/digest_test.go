// digest_test.go covers the digest file's own serialisation, as distinct from the two suites that
// compare a whole pack against a baseline. What lives here is the small, easy-to-overlook decisions
// about how a value is written down -- the kind that no end-to-end suite can fail on, because both
// sides of its comparison go through the same encoder.
package goldentest

import (
	"math"
	"testing"
)

// TestJSONSafeNumber_FoldsNegativeZero pins the fold, and — the half that matters — pins that the
// digest FILE and the digest GENERATOR agree about it.
//
// Before the fold they did not: regeneration wrote -0 for 66 scope values where the committed
// baseline had 0, and no test could see it, because scopeValueEqual compares with `==` and IEEE 754
// says -0.0 == 0.0. A drift no test can see is one that accumulates until someone regenerates for an
// unrelated reason and silently commits it.
func TestJSONSafeNumber_FoldsNegativeZero(t *testing.T) {
	got := jsonSafeNumber(math.Copysign(0, -1))
	f, ok := got.(float64)
	if !ok {
		t.Fatalf("jsonSafeNumber(-0) returned %T, want float64", got)
	}
	if math.Signbit(f) {
		t.Fatalf("jsonSafeNumber(-0) kept the sign bit; the digest file would say -0 where "+
			"regeneration and the committed baseline must agree, got %v", f)
	}

	// A control, so this cannot pass by folding everything: an ordinary negative is untouched.
	if v := jsonSafeNumber(-1.5); v != -1.5 {
		t.Fatalf("jsonSafeNumber(-1.5) = %v, want -1.5", v)
	}

	// And the reason the fold is safe: the comparison could never tell the two apart anyway, so
	// nothing that used to be detectable stops being detectable. If this assertion ever fails,
	// scopeValueEqual has become sign-aware and the fold in jsonSafeNumber must come out with it.
	if !scopeValueEqual(math.Copysign(0, -1), 0.0) {
		t.Fatal("scopeValueEqual now distinguishes -0 from 0 -- the fold in jsonSafeNumber has to " +
			"be removed at the same time, or the test can fail on a difference the file cannot record")
	}
}
