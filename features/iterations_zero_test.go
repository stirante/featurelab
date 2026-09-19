package features

// iterations_zero_test.go pins the one thing `iterations: 0` must do: say so.
//
// It is the quietest way a scatter can be dead. The file loads in the game, the
// feature is registered, the distribution runs, the chance gate passes, and the
// iteration loop runs zero times -- at every origin, under every seed. There is
// no failed placement to look at and no error anywhere, so the only signal that
// can exist is a static one.

import (
	"strings"
	"testing"
)

func collectWarnings() (func(string), *[]string) {
	var out []string
	return func(m string) { out = append(out, m) }, &out
}

func TestParseScatterDistribution_ConstantZeroIterationsWarns(t *testing.T) {
	warn, got := collectWarnings()
	if _, err := ParseScatterDistribution(map[string]any{"iterations": 0.0}, "distribution", warn); err != nil {
		t.Fatalf("iterations: 0 must still LOAD -- the game accepts it: %v", err)
	}
	if len(*got) != 1 {
		t.Fatalf("warnings = %v, want exactly one about the zero", *got)
	}
	if !strings.Contains((*got)[0], "places nothing") {
		t.Errorf("the warning does not say what it costs: %q", (*got)[0])
	}
}

// TestParseScatterDistribution_AConstantThatROUNDSToZeroWarnsToo: the run
// rounds before it compares (`int(roundf(raw)) > 0`), so 0.4 is exactly as dead
// as 0 and must not need a second discovery.
func TestParseScatterDistribution_AConstantThatROUNDSToZeroWarnsToo(t *testing.T) {
	warn, got := collectWarnings()
	if _, err := ParseScatterDistribution(map[string]any{"iterations": 0.4}, "distribution", warn); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 1 {
		t.Fatalf("warnings = %v, want one -- 0.4 rounds to 0 iterations at run time", *got)
	}
}

// TestParseScatterDistribution_APositiveCountIsSilent keeps the channel worth
// reading.
func TestParseScatterDistribution_APositiveCountIsSilent(t *testing.T) {
	warn, got := collectWarnings()
	if _, err := ParseScatterDistribution(map[string]any{"iterations": 4.0}, "distribution", warn); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 0 {
		t.Errorf("warnings = %v, want none", *got)
	}
}

// TestParseScatterDistribution_AMolangExpressionIsNotJudged is the restraint
// half. An expression that evaluates to zero at one origin is a fact about that
// run, not about the file -- calling it a defect is the dead-branch mistake
// wire/graphcheck.go's header refuses to make.
func TestParseScatterDistribution_AMolangExpressionIsNotJudged(t *testing.T) {
	warn, got := collectWarnings()
	if _, err := ParseScatterDistribution(map[string]any{"iterations": "math.floor(q.noise(v.worldx, v.worldz))"}, "distribution", warn); err != nil {
		t.Fatal(err)
	}
	for _, m := range *got {
		if strings.Contains(m, "rounds to 0") {
			t.Errorf("a Molang iterations expression was judged statically: %q", m)
		}
	}
}

// TestParseScatterDistribution_ANegativeConstantKeepsItsOwnWarning: the engine
// rewrites a negative to 1 and content-logs it, so that case is already covered
// by a different, more specific sentence and must not also collect this one --
// after the rewrite the value is 1, which is not zero.
func TestParseScatterDistribution_ANegativeConstantKeepsItsOwnWarning(t *testing.T) {
	warn, got := collectWarnings()
	if _, err := ParseScatterDistribution(map[string]any{"iterations": -3.0}, "distribution", warn); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 1 {
		t.Fatalf("warnings = %v, want exactly one (the negative-count rewrite)", *got)
	}
	if strings.Contains((*got)[0], "rounds to 0") {
		t.Errorf("a negative count got the zero-iterations sentence instead of its own: %q", (*got)[0])
	}
}
