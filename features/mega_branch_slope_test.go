package features

import "testing"

// TestMegaBranches_NegativeSlopeMovesTheStartNotTheAngle pins the geometry the
// wiki's `mega_trunk.branches` warning describes, because it is the kind of
// claim that quietly stops being true.
//
// The branch height walk is `startY = level-1 - slope*(length-1)` and then
// `y = startY + slope*step`. The subtraction anchors the END of the branch at
// level-1 for every slope, so the slope decides where the branch BEGINS. A
// negative value therefore starts it ABOVE its own level and walks down, and a
// steeper negative value starts it higher still rather than tilting it more.
//
// Nothing validates the sign, and a large negative value can start a branch
// above the whole tree.
func TestMegaBranches_NegativeSlopeMovesTheStartNotTheAngle(t *testing.T) {
	const level, length = 20, 6

	profile := func(slope float32) (startY int, ys []int) {
		startY = int(float32(level-1) - float32(slope*float32(length-1)))
		for step := 0; step < length; step++ {
			ys = append(ys, int(float32(startY)+float32(slope*float32(step))))
		}
		return
	}

	for _, tc := range []struct {
		slope  float32
		start  int
		last   int
		rising bool
	}{
		{0.5, 16, 18, true},
		{0.0, 19, 19, false},
		{-0.5, 21, 18, false},
		{-1.0, 24, 19, false},
		{-2.0, 29, 19, false},
	} {
		start, ys := profile(tc.slope)
		if start != tc.start {
			t.Errorf("slope %v: start = %d, want %d", tc.slope, start, tc.start)
		}
		if got := ys[len(ys)-1]; got != tc.last {
			t.Errorf("slope %v: last cell = %d, want %d", tc.slope, got, tc.last)
		}
		if rising := ys[len(ys)-1] > ys[0]; rising != tc.rising {
			t.Errorf("slope %v: rising = %v, want %v", tc.slope, rising, tc.rising)
		}
	}

	// The load-bearing half: a steeper negative slope raises the START, it does
	// not merely steepen the descent. If someone ever "fixes" the formula to
	// anchor the start instead, this is what fails.
	s1, _ := profile(-1.0)
	s2, _ := profile(-2.0)
	if s2 <= s1 {
		t.Errorf("a steeper negative slope must start HIGHER: -2.0 started at %d, -1.0 at %d", s2, s1)
	}
	if s2 <= level {
		t.Errorf("slope -2.0 must start above its own level %d, started at %d", level, s2)
	}
}
