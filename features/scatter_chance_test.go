// scatter_chance_test.go pins what the game does with a scatter_chance it does not like
// (1.26.50.24): which values are rewritten at load time, and how the chance gate treats the
// result. The code these tests justify is in distribution.go.
//
// Ordinary scatter_chance values -- 1/10, 6/10, 1/2, or percents like 10, 50 or 100 -- are
// accepted unchanged, so the regression digests never reach these cases; that is exactly why
// they are pinned here.
package features

import (
	"testing"

	"github.com/stirante/featurelab/random"
)

// countingRNG counts draws and answers NextIntBound with a value it is told to give, so a test
// can assert both the OUTCOME of a gate and whether it spent the generator at all.
type countingRNG struct {
	random.IRandom
	bounded int
	draws   int
	bounds  []int
}

func (c *countingRNG) NextIntBound(bound int) int {
	c.draws++
	c.bounds = append(c.bounds, bound)
	return c.bounded
}

// NextFloat is the percent gate's own draw. It answers 0.5 (a 50% roll) so a test can spend it
// deliberately; what the tests below assert about it is the COUNT, not the value.
func (c *countingRNG) NextFloat() float64 {
	c.draws++
	return 0.5
}

func parseChance(t *testing.T, raw any) (ChanceSpec, []string) {
	t.Helper()
	var warnings []string
	spec, err := ParseScatterChance(raw, func(m string) { warnings = append(warnings, m) })
	if err != nil {
		t.Fatalf("ParseScatterChance(%v): %v", raw, err)
	}
	return spec, warnings
}

// TestScatterChance_ZeroNumeratorFallsThroughToThePercentDefault is the case that prompted the
// investigation: {"numerator": 0, "denominator": 100} reads like "never" and always scatters.
// The game gets there by FALLING THROUGH to the percent field, which this form never writes, so
// the field still holds its default of 100 -- not by short-circuiting on the failed gate.
func TestScatterChance_ZeroNumeratorFallsThroughToThePercentDefault(t *testing.T) {
	spec, warnings := parseChance(t, map[string]any{"numerator": 0.0, "denominator": 100.0})
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none -- denominator 100 IS greater than numerator 0", warnings)
	}
	rnd := &countingRNG{}
	if !ShouldScatter(spec, nil, rnd) {
		t.Fatal("0/100 did not scatter; the game's failed fraction gate reads the percent field, which defaults to 100")
	}
	if rnd.draws != 0 {
		t.Fatalf("draws = %d, want 0 -- a percent of 100 scatters without touching the generator", rnd.draws)
	}
}

// TestScatterChance_ConstantZeroPercentIsRewrittenTo100 is the sharper half of the same shape:
// a bare `scatter_chance: 0` is rejected by the game's own validation with a content error and
// replaced by 100, so it always scatters. This bench used to answer "never scatter", which is
// the exact opposite.
func TestScatterChance_ConstantZeroPercentIsRewrittenTo100(t *testing.T) {
	for _, raw := range []any{0.0, -5.0, 100.5, false} {
		spec, warnings := parseChance(t, raw)
		if len(warnings) != 1 {
			t.Fatalf("scatter_chance %v: warnings = %v, want exactly one saying the game rewrites it", raw, warnings)
		}
		rnd := &countingRNG{}
		if !ShouldScatter(spec, nil, rnd) {
			t.Fatalf("scatter_chance %v did not scatter, but the game replaces a bad constant with 100", raw)
		}
		if rnd.draws != 0 {
			t.Fatalf("scatter_chance %v: draws = %d, want 0", raw, rnd.draws)
		}
	}
}

// TestScatterChance_ValidPercentIsUntouched guards the rewrite above from swallowing the values
// the game accepts -- the boundary is (0, 100], so 100 stays 100 and a plain 50 still draws.
func TestScatterChance_ValidPercentIsUntouched(t *testing.T) {
	spec, warnings := parseChance(t, 50.0)
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none for a 50%% chance", warnings)
	}
	rnd := &countingRNG{}
	ShouldScatter(spec, nil, rnd)
	if rnd.draws != 1 {
		t.Fatalf("draws = %d, want exactly one NextFloat-driven draw for a percent strictly between 0 and 100", rnd.draws)
	}

	if _, warnings := parseChance(t, 100.0); len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none -- 100 is the top of the accepted range, not past it", warnings)
	}
}

// TestScatterChance_DenominatorNotGreaterThanNumeratorBecomesOne pins the other rewrite: the
// game reports it and stores a denominator of 1 rather than refusing the file.
func TestScatterChance_DenominatorNotGreaterThanNumeratorBecomesOne(t *testing.T) {
	spec, warnings := parseChance(t, map[string]any{"numerator": 3.0, "denominator": 2.0})
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly one naming the denominator", warnings)
	}
	if spec.Denominator != 1 || spec.Numerator != 3 {
		t.Fatalf("spec = %d/%d, want 3/1 (numerator stored either way, denominator forced to 1)",
			spec.Numerator, spec.Denominator)
	}
	rnd := &countingRNG{}
	if !ShouldScatter(spec, nil, rnd) {
		t.Fatal("3/1 must always pass")
	}
	if len(rnd.bounds) != 1 || rnd.bounds[0] != 1 {
		t.Fatalf("draw bounds = %v, want exactly one draw bounded by the rewritten denominator 1", rnd.bounds)
	}
}

// TestScatterChance_NumeratorAndDenominatorAreInts pins the width. The game stores both
// as 32-bit integers, so a fractional numerator is truncated before the gate ever sees it: {1.5, 4} is a
// one-in-four chance, not the two-in-four this bench used to run.
func TestScatterChance_NumeratorAndDenominatorAreInts(t *testing.T) {
	spec, _ := parseChance(t, map[string]any{"numerator": 1.5, "denominator": 4.0})
	if spec.Numerator != 1 || spec.Denominator != 4 {
		t.Fatalf("spec = %d/%d, want 1/4", spec.Numerator, spec.Denominator)
	}
	// A draw of 1 loses a 1-in-4 gate and would have won the old 1.5-in-4 one.
	rnd := &countingRNG{bounded: 1}
	if ShouldScatter(spec, nil, rnd) {
		t.Fatal("a draw of 1 must lose a 1-in-4 gate; the numerator was not truncated")
	}
}

// TestScatterDistribution_NegativeIterationsBecomesOne pins the third rewrite in the same fill
// step. It is not a chance case, but it is the same "report it and use a fallback" shape and
// the same validation step, and this bench used to place nothing where the game places once.
func TestScatterDistribution_NegativeIterationsBecomesOne(t *testing.T) {
	var warnings []string
	dist, err := ParseScatterDistribution(map[string]any{
		"iterations": -4.0, "x": 0.0, "y": 0.0, "z": 0.0,
	}, "distribution", func(m string) { warnings = append(warnings, m) })
	if err != nil {
		t.Fatalf("ParseScatterDistribution: %v", err)
	}
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly one naming iterations", warnings)
	}
	if got := dist.Iterations.Evaluate(nil); got != 1 {
		t.Fatalf("iterations = %v, want 1", got)
	}
}
