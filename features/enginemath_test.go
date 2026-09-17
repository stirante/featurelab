package features

import (
	"math"
	"testing"
)

// TestEngineSinScaleIsTheEngineConstant pins the one immediate everything
// else derives from. If this moves, nothing below means anything.
func TestEngineSinScaleIsTheEngineConstant(t *testing.T) {
	if got := math.Float32bits(engineSinScale); got != 0x4622F983 {
		t.Fatalf("engineSinScale bits = 0x%08X, want 0x4622F983", got)
	}
	if float64(engineSinScale) != 10430.3779296875 {
		t.Fatalf("engineSinScale = %v, want 10430.3779296875", engineSinScale)
	}
	// It is 65536/2pi only to float32 precision -- SMALLER than the exact
	// value. The table is built by dividing by THIS, not by multiplying by
	// the exact turn.
	if float64(engineSinScale) >= 65536/(2*math.Pi) {
		t.Fatalf("engineSinScale should be below the exact 65536/2pi = %v", 65536/(2*math.Pi))
	}
}

// TestEngineSinTableIsBuiltTheEngineWay pins the CONTENTS against the
// game's own formula, sinf(float32(i) / scale) -- not
// against sin(i * 2pi / 65536), which is the natural guess and is wrong
// for two thirds of the entries.
func TestEngineSinTableIsBuiltTheEngineWay(t *testing.T) {
	tab := engineSinTable()
	if len(tab) != 65536 {
		t.Fatalf("table has %d entries, want 65536", len(tab))
	}
	for _, i := range []int{0, 1, 2, 16384, 32768, 49152, 65535, 12345} {
		want := float32(math.Sin(float64(float32(i) / engineSinScale)))
		if tab[i] != want {
			t.Errorf("SIN[%d] = %v, want %v", i, tab[i], want)
		}
	}
	// And it is measurably NOT the inferred spelling: if a future edit
	// "simplifies" the build back to i*2pi/65536, this fires.
	differs := 0
	for i := range tab {
		if tab[i] != float32(math.Sin(float64(i)*2*math.Pi/65536)) {
			differs++
		}
	}
	if differs < 40000 {
		t.Fatalf("only %d entries differ from the i*2pi/65536 spelling; the table "+
			"looks like it was rebuilt the inferred way (expected ~43378)", differs)
	}
}

// TestEngineSinIsQuantisedNotComputed is the property that actually
// matters: the result is one of 65536 stored samples, so a whole band of
// nearby angles returns the IDENTICAL float. A libm sine never does that.
func TestEngineSinIsQuantisedNotComputed(t *testing.T) {
	// 1/scale ~= 9.587e-5 radians per entry, so two angles a tenth of that
	// apart must land on the same entry somewhere.
	const base = 1.0
	step := 1 / float64(engineSinScale) / 10
	same := 0
	for k := 0; k < 10; k++ {
		if EngineSin(float32(base+float64(k)*step)) == EngineSin(float32(base)) {
			same++
		}
	}
	if same < 5 {
		t.Fatalf("only %d of 10 sub-entry-width offsets returned the same value; "+
			"this does not look like a table lookup", same)
	}
	// And the divergence from a real sine is the ~1e-4 the whole change is about.
	maxD := 0.0
	for k := 0; k <= 100000; k++ {
		x := float32(float64(k) / 100000 * 2 * math.Pi)
		if d := math.Abs(float64(EngineSin(x)) - math.Sin(float64(x))); d > maxD {
			maxD = d
		}
	}
	if maxD < 5e-5 || maxD > 2e-4 {
		t.Fatalf("max |EngineSin - math.Sin| over one turn = %.4e, want order 1e-4", maxD)
	}
}

// TestEngineCosIsTheSameTableAQuarterTurnOn pins the scale-then-add-then-
// truncate ORDER: the 16384 is added to the SCALED index, in float32, before the
// truncation. Adding pi/2 to the angle instead gives a different entry.
func TestEngineCosIsTheSameTableAQuarterTurnOn(t *testing.T) {
	for _, x := range []float32{0, 0.3, 1, -1, 2.5, 6.28, -6.28} {
		want := engineSinTableAt(float32(x*engineSinScale) + 16384)
		if got := EngineCos(x); got != want {
			t.Errorf("EngineCos(%v) = %v, want %v", x, got, want)
		}
	}
	if EngineCos(0) != engineSinTable()[16384] {
		t.Errorf("EngineCos(0) = %v, want SIN[16384] = %v", EngineCos(0), engineSinTable()[16384])
	}
}

// TestFcvtzsTruncatesTowardZero is the trap. The conversion is NOT floor, and the
// difference is only visible for negative angles -- which carver pitch and
// yaw both reach. A floor-based port agrees on every positive angle and
// then disagrees on essentially every negative one.
func TestFcvtzsTruncatesTowardZero(t *testing.T) {
	cases := []struct {
		in   float32
		want int32
	}{
		{0, 0}, {0.9, 0}, {1.9, 1}, {-0.9, 0}, {-1.9, -1}, {-1, -1},
	}
	for _, c := range cases {
		if got := fcvtzs(c.in); got != c.want {
			t.Errorf("fcvtzs(%v) = %d, want %d (truncate toward zero, not floor)", c.in, got, c.want)
		}
	}
	// NaN -> 0, and saturation rather than wrapping.
	if got := fcvtzs(float32(math.NaN())); got != 0 {
		t.Errorf("fcvtzs(NaN) = %d, want 0", got)
	}
	if got := fcvtzs(float32(math.Inf(1))); got != math.MaxInt32 {
		t.Errorf("fcvtzs(+Inf) = %d, want MaxInt32", got)
	}
	if got := fcvtzs(float32(math.Inf(-1))); got != math.MinInt32 {
		t.Errorf("fcvtzs(-Inf) = %d, want MinInt32", got)
	}
	if got := fcvtzs(1e20); got != math.MaxInt32 {
		t.Errorf("fcvtzs(1e20) = %d, want MaxInt32 (saturate, not wrap)", got)
	}

	// The observable consequence, stated as a value: a small negative
	// angle reads the entry ONE NEARER ZERO than a floor would, so the two
	// spellings disagree.
	x := float32(-0.001)
	idx := float32(x * engineSinScale)
	trunc := uint32(fcvtzs(idx)) & engineSinTableMask
	floor := uint32(int32(math.Floor(float64(idx)))) & engineSinTableMask
	if trunc == floor {
		t.Fatal("chose a test angle where truncation and floor agree; the case is not being exercised")
	}
	if EngineSin(x) != engineSinTable()[trunc] {
		t.Error("EngineSin does not use the truncating index")
	}
}

// TestEngineTrigNeverPanicsOnHostileAngles: the AND makes every index
// legal, so no author-supplied number can index out of the table.
func TestEngineTrigNeverPanicsOnHostileAngles(t *testing.T) {
	for _, x := range []float32{
		0, -0, 1e30, -1e30, float32(math.Inf(1)), float32(math.Inf(-1)),
		float32(math.NaN()), math.MaxFloat32, -math.MaxFloat32, 1e-30,
	} {
		_ = EngineSin(x)
		_ = EngineCos(x)
	}
}
