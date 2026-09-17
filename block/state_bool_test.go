// state_bool_test.go pins StateInt's reading of a boolean state.
//
// A flag state reaches this package in two shapes and both are legitimate: the
// per-type catalogue declares it as a Go bool, pack JSON and NBT deliver it as
// a number. StateInt used to accept only the number and return ok=false for
// the bool -- which every caller reads as "this block has no such state" and
// responds to by doing nothing at all.
//
// That is the failure mode worth a test: not a wrong answer, but a silent
// skip. The update_bit/persistent_bit normalization in features/tree.go had
// been a no-op on catalogue-shaped blocks for exactly this reason, and nothing
// failed while it was.
package block

import "testing"

func TestStateIntReadsBothRepresentationsOfAFlag(t *testing.T) {
	p := NewPalette()

	cases := []struct {
		what   string
		states map[string]StateValue
		want   int
	}{
		{"bool false", map[string]StateValue{"update_bit": false}, 0},
		{"bool true", map[string]StateValue{"update_bit": true}, 1},
		{"number 0", map[string]StateValue{"update_bit": float64(0)}, 0},
		{"number 1", map[string]StateValue{"update_bit": float64(1)}, 1},
	}
	for _, c := range cases {
		id := p.Get("minecraft:oak_leaves", c.states)
		got, ok := p.StateInt(id, UpdateBit)
		if !ok {
			t.Errorf("%s: StateInt reported the state absent, but it is present as %v",
				c.what, c.states["update_bit"])
			continue
		}
		if got != c.want {
			t.Errorf("%s: StateInt = %d, want %d", c.what, got, c.want)
		}
	}
}

// A state that genuinely is not there must still report absent, and a value of
// a type that is neither form must not be guessed at. The coercion is for two
// spellings of the same thing, not a general cast.
func TestStateIntStillReportsAbsentAndUnreadable(t *testing.T) {
	p := NewPalette()

	bare := p.Get("minecraft:stone", nil)
	if _, ok := p.StateInt(bare, UpdateBit); ok {
		t.Error("StateInt found update_bit on a block that has no states")
	}

	stringy := p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "y"})
	if _, ok := p.StateInt(stringy, StateField{Key: "pillar_axis", ValueCount: 3}); ok {
		t.Error("StateInt read a string state as an integer; it should report it unreadable")
	}
}
