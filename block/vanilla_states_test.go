package block

import (
	"reflect"
	"sort"
	"testing"
)

// TestVanillaBlockKnown_ThreeAnswers is the distinction the whole table turns
// on: "declares this state", "known and does not declare it", and "unknown".
// Collapsing the last two is exactly the bug this catalogue exists to stop --
// a pack's own block must not be read as a stateless vanilla one.
func TestVanillaBlockKnown_ThreeAnswers(t *testing.T) {
	if !VanillaBlockKnown("minecraft:torch") {
		t.Error("minecraft:torch should be a known vanilla block type")
	}
	if !VanillaBlockKnown("minecraft:stone") {
		t.Error("minecraft:stone should be KNOWN -- it declares no states, which is not the same thing")
	}
	if VanillaBlockStates("minecraft:stone") != nil {
		t.Error("minecraft:stone should declare no states")
	}
	if VanillaBlockKnown("xyz:custom_block") {
		t.Error("a pack's own block must not be known to the vanilla catalogue")
	}
	if !VanillaBlockKnown("torch") {
		t.Error("an un-namespaced name should canonicalise to minecraft: like everywhere else in this package")
	}
}

// TestLookupVanillaState_Rows checks the rows the three call sites read,
// chosen for the properties each one exercises: a plain enumeration, a
// default that is NOT the domain's first value, a narrowed integer domain, a
// widened one, and a wide bitfield.
func TestLookupVanillaState_Rows(t *testing.T) {
	cases := []struct {
		name, key string
		count     int
		def       StateValue
	}{
		// The block that motivated the rotate.go gate: a bare torch carries
		// this state through its type, not through anything a pack wrote.
		{"minecraft:torch", "torch_facing_direction", 6, "unknown"},
		// A default that is not index 0 -- a freshly-placed chest faces north
		// while the state's domain starts at south.
		{"minecraft:chest", "minecraft:cardinal_direction", 4, "north"},
		{"minecraft:oak_log", "pillar_axis", 3, "y"},
		// Narrowed: rail_direction has ten values, but a powered rail has six.
		{"minecraft:golden_rail", "rail_direction", 6, float64(0)},
		// Widened: the only type in the catalogue that takes a state past its
		// own domain.
		{"minecraft:chalkboard", "direction", 16, float64(0)},
		// A 64-value bitfield whose default is every face at once.
		{"minecraft:glow_lichen", "multi_face_direction_bits", 64, float64(63)},
	}
	for _, tc := range cases {
		state, ok := LookupVanillaState(tc.name, tc.key)
		if !ok {
			t.Errorf("%s should declare %s", tc.name, tc.key)
			continue
		}
		if state.ValueCount != tc.count {
			t.Errorf("%s %s: ValueCount = %d, want %d", tc.name, tc.key, state.ValueCount, tc.count)
		}
		if state.Default != tc.def {
			t.Errorf("%s %s: Default = %v, want %v", tc.name, tc.key, state.Default, tc.def)
		}
	}
	if _, ok := LookupVanillaState("minecraft:stone", "direction"); ok {
		t.Error("minecraft:stone declares no states, so it declares no direction")
	}
	if _, ok := LookupVanillaState("xyz:custom_block", "direction"); ok {
		t.Error("an unknown block type declares nothing")
	}
}

func TestVanillaStateValues(t *testing.T) {
	cases := []struct {
		name, key string
		want      []StateValue
	}{
		{"minecraft:oak_log", "pillar_axis", []StateValue{"y", "x", "z"}},
		{"minecraft:chest", "minecraft:cardinal_direction", []StateValue{"south", "west", "north", "east"}},
		{"minecraft:golden_rail", "rail_data_bit", []StateValue{false, true}},
		{"minecraft:golden_rail", "rail_direction", []StateValue{float64(0), float64(1), float64(2), float64(3), float64(4), float64(5)}},
	}
	for _, tc := range cases {
		if got := VanillaStateValues(tc.name, tc.key); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("VanillaStateValues(%q, %q) = %v, want %v", tc.name, tc.key, got, tc.want)
		}
	}
	if got := VanillaStateValues("minecraft:chalkboard", "direction"); len(got) != 16 || got[15] != float64(15) {
		t.Errorf("a widened integer domain should run 0..15, got %v", got)
	}
	if got := VanillaStateValues("minecraft:stone", "pillar_axis"); got != nil {
		t.Errorf("VanillaStateValues on a state the type does not declare = %v, want nil", got)
	}
}

// TestVanillaStateTable_Invariants is the whole-table check. Every accessor
// above reads one row; this one asserts the properties every row has to hold,
// so that a regenerated table with a broken row fails here rather than in
// whichever feature happened to read it.
func TestVanillaStateTable_Invariants(t *testing.T) {
	if len(vanillaBlockStateTable) < 1000 {
		t.Fatalf("catalogue holds %d block types -- too few for this to be the real table", len(vanillaBlockStateTable))
	}
	withStates := 0
	for name, declared := range vanillaBlockStateTable {
		if len(declared) > 0 {
			withStates++
		}
		if !sort.SliceIsSorted(declared, func(i, j int) bool { return declared[i].key < declared[j].key }) {
			t.Errorf("%s: declared states are not sorted by key", name)
		}
		seen := map[string]bool{}
		for _, state := range declared {
			if seen[state.key] {
				t.Errorf("%s declares %s twice", name, state.key)
			}
			seen[state.key] = true
			if _, ok := vanillaStateDomains[state.key]; !ok {
				t.Errorf("%s declares %s, which has no entry in the domain table", name, state.key)
			}
			if state.count < 1 {
				t.Errorf("%s %s: value count is %d", name, state.key, state.count)
			}
			values := VanillaStateValues(name, state.key)
			if len(values) != state.count {
				t.Errorf("%s %s: %d legal values derived for a count of %d", name, state.key, len(values), state.count)
			}
			found := false
			for _, v := range values {
				if v == state.def {
					found = true
					break
				}
			}
			if !found {
				// This is the check the planted-failure exercise trips: a
				// default that is not one of the type's own legal values is
				// not a value the game could ever have given the block.
				t.Errorf("%s %s: default %v is not one of its %d legal values %v", name, state.key, state.def, len(values), values)
			}
		}
	}
	if withStates < 500 {
		t.Errorf("only %d block types declare a state -- the table looks truncated", withStates)
	}
}
