package features

import (
	"strconv"
	"testing"

	"github.com/stirante/featurelab/random"
)

// TestDistributionDrawCounts pins the number of draws each distribution kind spends, including
// the degenerate extents where the count collapses. It exists because docs/wiki/scatter-feature.md
// prints this exact table and got three of its rows wrong -- "gaussian: always two draws,
// regardless of range" (it spends none when the half is zero), "inverse_gaussian: 2 (rarely 3)"
// (it spends one when the half is zero), and a no-draw catalogue that omitted both.
//
// A wrong draw COUNT is worse than a wrong value: it shifts every later feature in the same
// chunk. Nothing about the placed block looks wrong, so the only way to catch it is to count.
func TestDistributionDrawCounts(t *testing.T) {
	cases := []struct {
		name  string
		kind  DistKind
		min   int
		max   int
		draws int
		why   string
	}{
		{"none", DistNone, 5, 9, 0, "a bare number or Molang string is evaluated, never drawn"},

		{"uniform/degenerate", DistUniform, 5, 5, 0, "max is not > min, so the bound would be 0"},
		{"uniform", DistUniform, 5, 7, 1, ""},

		// half = (max-min)>>1, drawn twice. A half of 0 means NextIntBound(0), which returns
		// without consuming a draw -- so a gaussian axis narrower than 2 spends nothing at all.
		{"gaussian/half-0 equal", DistGaussian, 5, 5, 0, "half is 0, and a bound of 0 does not draw"},
		{"gaussian/half-0 width-1", DistGaussian, 5, 6, 0, "half is still 0 -- width 1 rounds down"},
		{"gaussian", DistGaussian, 5, 7, 2, ""},

		// Same two draws, plus an unconditional NextBoolean tie-break. When the half is 0 the two
		// draws vanish and only the tie-break survives, so the count is 1 and never 0.
		{"inverse_gaussian/half-0", DistInverseGaussian, 5, 5, 1, "only the tie-break survives"},
		{"inverse_gaussian/half-0 width-1", DistInverseGaussian, 5, 6, 1, ""},
		{"inverse_gaussian", DistInverseGaussian, 5, 7, 3, "two halves plus the tie-break"},

		// nextIntInclusive skips its draw only when max < min. max == min still calls
		// NextIntBound(1), which DOES draw -- so triangle never degenerates to fewer than two.
		{"triangle/equal", DistTriangle, 5, 5, 2, "max == min still draws: nextIntInclusive skips only when max < min"},
		{"triangle", DistTriangle, 5, 8, 2, ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tr := random.NewTracer(random.New(1))
			EvalCoordinateRange(CoordinateRange{Kind: c.kind}, c.min, c.max, nil, tr)
			if got := len(tr.Draws); got != c.draws {
				msg := ""
				if c.why != "" {
					msg = " (" + c.why + ")"
				}
				t.Errorf("[%d,%d] spent %d draws, want %d%s", c.min, c.max, got, c.draws, msg)
			}
		})
	}
}

// TestNextIntInclusive_OnlySkipsWhenMaxIsBelowMin pins the boundary the wiki had off by one.
// The engine's own test is a strictly-less-than comparison -- so an inclusive range
// whose ends are EQUAL still spends a draw on NextIntBound(1).
func TestNextIntInclusive_OnlySkipsWhenMaxIsBelowMin(t *testing.T) {
	for _, c := range []struct {
		min, max, draws int
	}{
		{5, 4, 0}, // max < min: no draw
		{5, 5, 1}, // max == min: NextIntBound(1), which draws and returns 0
		{5, 6, 1},
	} {
		tr := random.NewTracer(random.New(1))
		if got := nextIntInclusive(tr, c.min, c.max); got < c.min || got > max(c.max, c.min) {
			t.Errorf("nextIntInclusive(%d, %d) = %d, outside its own range", c.min, c.max, got)
		}
		if got := len(tr.Draws); got != c.draws {
			t.Errorf("nextIntInclusive(%d, %d) spent %d draws, want %d", c.min, c.max, got, c.draws)
		}
	}
}

// TestParseMolangValue_ANumberAndItsStringSpellingAgree pins the fix for a divergence that was
// invisible precisely because it only shows up in the digits nobody looks at.
//
// Every Molang value in the engine is a float32 (see molang-go/eval/float32.go's derivation). A
// Molang field written as the STRING "0.1" went through molang-go and came back rounded; the same
// field written as the JSON NUMBER 0.1 was stored and returned as a raw float64, never touching
// molang-go at all. Two spellings of one value, two answers.
func TestParseMolangValue_ANumberAndItsStringSpellingAgree(t *testing.T) {
	for _, v := range []float64{0.1, 0.2, 1.0 / 3.0, -0.7, 3.14159265358979, 1e-8, 16777217} {
		num, err := ParseMolangValue(v)
		if err != nil {
			t.Fatalf("ParseMolangValue(%v): %v", v, err)
		}
		str, err := ParseMolangValue(strconv.FormatFloat(v, 'g', 17, 64))
		if err != nil {
			t.Fatalf("ParseMolangValue(%q): %v", strconv.FormatFloat(v, 'g', 17, 64), err)
		}
		got := num.Evaluate(nil)
		want := str.Evaluate(nil)
		if got != want {
			t.Errorf("%v: as a number = %v, as a string = %v -- the two spellings must agree", v, got, want)
		}
		// And the value really is the float32 one, not the float64 that was there before.
		if got != float64(float32(v)) {
			t.Errorf("%v evaluated to %v, want the float32 rounding %v", v, got, float64(float32(v)))
		}
	}
}
