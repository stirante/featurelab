package block

import "testing"

// TestStateInt_ReadsPlacedBlockState is the "read a placed block's live
// state back" half of the capability -- StateInt on a freshly-interned
// multi-face-direction-bits entry must return exactly what was interned,
// and report ok=false when the field isn't present at all (vine has no
// concept of "the mask isn't set" other than "the key is absent").
func TestStateInt_ReadsPlacedBlockState(t *testing.T) {
	p := NewPalette()

	// SOUTH(4) | WEST(8) = 12 -- an arbitrary already-placed multiface
	// state, the multiface south and west bits.
	id := p.Get("minecraft:glow_lichen", map[string]StateValue{"multi_face_direction_bits": float64(12)})

	got, ok := p.StateInt(id, MultiFaceDirectionBits)
	if !ok || got != 12 {
		t.Fatalf("StateInt(vine#12) = (%v, %v), want (12, true)", got, ok)
	}

	airGot, airOK := p.StateInt(AirID, MultiFaceDirectionBits)
	if airOK {
		t.Fatalf("StateInt(air, MultiFaceDirectionBits) = (%v, true), want ok=false (air has no such field)", airGot)
	}
}

// TestWithIntState_ModifiesSubFieldAndReDerivesID is the "modify a
// sub-field and derive a new block from it" half: start with an existing
// placed block carrying SOUTH(4), OR in EAST(32) the way the multiface
// block's worldgen placement derivation does at its own state write, and
// confirm the derived ID is a NEW, distinct,
// correctly-stated entry -- while the ORIGINAL id's own entry is completely
// unaffected (Palette entries are interned once and never mutated in
// place).
func TestWithIntState_ModifiesSubFieldAndReDerivesID(t *testing.T) {
	p := NewPalette()

	const south = 4 // the south multiface mask
	const east = 32 // the east multiface mask

	original := p.Get("minecraft:glow_lichen", map[string]StateValue{"multi_face_direction_bits": float64(south)})

	existingBits, ok := p.StateInt(original, MultiFaceDirectionBits)
	if !ok || existingBits != south {
		t.Fatalf("StateInt(original) = (%v, %v), want (%v, true)", existingBits, ok, south)
	}

	derived, ok := p.WithIntState(original, MultiFaceDirectionBits, existingBits|east)
	if !ok {
		t.Fatalf("WithIntState(original, south|east) ok=false, want true")
	}
	if derived == original {
		t.Fatalf("WithIntState derived the same ID as original; expected a distinct re-interned entry")
	}

	derivedBits, ok := p.StateInt(derived, MultiFaceDirectionBits)
	if !ok || derivedBits != south|east {
		t.Fatalf("StateInt(derived) = (%v, %v), want (%v, true)", derivedBits, ok, south|east)
	}

	// The original entry must be untouched -- Palette never mutates an
	// already-interned Entry in place.
	origBits, ok := p.StateInt(original, MultiFaceDirectionBits)
	if !ok || origBits != south {
		t.Fatalf("StateInt(original) after WithIntState = (%v, %v), want (%v, true) -- original entry must be unmutated", origBits, ok, south)
	}

	if p.NameOf(derived) != "minecraft:glow_lichen" {
		t.Errorf("NameOf(derived) = %q, want minecraft:glow_lichen", p.NameOf(derived))
	}
}

// TestWithIntState_PreservesOtherStates confirms modifying one field
// doesn't clobber sibling states on the same entry -- WithIntState clones
// the full States map, not just the one key.
func TestWithIntState_PreservesOtherStates(t *testing.T) {
	p := NewPalette()
	id := p.Get("minecraft:glow_lichen", map[string]StateValue{
		"multi_face_direction_bits": float64(4),
		"some_other_state":          "kept",
	})

	derived, ok := p.WithIntState(id, MultiFaceDirectionBits, 12)
	if !ok {
		t.Fatalf("WithIntState ok=false, want true")
	}
	states := p.StatesOf(derived)
	if states["some_other_state"] != "kept" {
		t.Errorf("sibling state clobbered: states = %#v", states)
	}
}

// TestWithIntState_OutOfRange is the out-of-range behaviour required
// alongside read/modify/derive: the multiface block's worldgen placement
// derivation falls back to the ORIGINAL, unmodified block when the block
// type's state write fails -- not a zero ID, not a panic, not a
// silently-clamped value.
// WithIntState mirrors that: ok is false and the returned ID is exactly
// the input id, for both above-range and negative values.
func TestWithIntState_OutOfRange(t *testing.T) {
	p := NewPalette()
	id := p.Get("minecraft:glow_lichen", map[string]StateValue{"multi_face_direction_bits": float64(30)})

	cases := []int{64, 65, 1000, -1, -100}
	for _, v := range cases {
		got, ok := p.WithIntState(id, MultiFaceDirectionBits, v)
		if ok {
			t.Errorf("WithIntState(id, MultiFaceDirectionBits, %d) ok=true, want false (ValueCount=%d, domain is [0,%d))", v, MultiFaceDirectionBits.ValueCount, MultiFaceDirectionBits.ValueCount)
		}
		if got != id {
			t.Errorf("WithIntState(id, MultiFaceDirectionBits, %d) = %v, want unchanged id %v", v, got, id)
		}
	}

	// The boundary values are legal: 0 and ValueCount-1 (63).
	if _, ok := p.WithIntState(id, MultiFaceDirectionBits, 0); !ok {
		t.Errorf("WithIntState(id, MultiFaceDirectionBits, 0) ok=false, want true (0 is in domain)")
	}
	if _, ok := p.WithIntState(id, MultiFaceDirectionBits, 63); !ok {
		t.Errorf("WithIntState(id, MultiFaceDirectionBits, 63) ok=false, want true (63 is in domain, ValueCount-1)")
	}
}

// TestWithIntState_InterningIsDeterministic confirms WithIntState composes
// correctly with the palette's existing interning: deriving the same
// (name, states) pair twice, whether via two WithIntState calls or a direct
// Get, must yield the same ID -- this capability doesn't bypass or
// duplicate the palette's own dedup.
func TestWithIntState_InterningIsDeterministic(t *testing.T) {
	p := NewPalette()
	base := p.Get("minecraft:glow_lichen", map[string]StateValue{"multi_face_direction_bits": float64(4)})

	a, ok := p.WithIntState(base, MultiFaceDirectionBits, 12)
	if !ok {
		t.Fatalf("WithIntState ok=false, want true")
	}
	b, ok := p.WithIntState(base, MultiFaceDirectionBits, 12)
	if !ok {
		t.Fatalf("WithIntState ok=false, want true")
	}
	if a != b {
		t.Errorf("WithIntState(base, 12) called twice produced different IDs: %v vs %v", a, b)
	}

	direct := p.Get("minecraft:glow_lichen", map[string]StateValue{"multi_face_direction_bits": float64(12)})
	if a != direct {
		t.Errorf("WithIntState(base, 12) = %v, want same ID as a direct Get of the equivalent (name,states) pair %v", a, direct)
	}

	sizeBefore := p.Size()
	if _, ok := p.WithIntState(base, MultiFaceDirectionBits, 12); !ok {
		t.Fatalf("WithIntState ok=false, want true")
	}
	if p.Size() != sizeBefore {
		t.Errorf("Palette grew on a repeat WithIntState call: size %d -> %d", sizeBefore, p.Size())
	}
}

// TestPersistentBitAndUpdateBit_AreBooleanShaped confirms both newly
// registered fields (see this package's state.go doc comment for the
// derivation: each is registered with a value count of 2) accept exactly
// {0,1} and reject everything else, using the same read/modify/derive shape
// already proven for MultiFaceDirectionBits above.
func TestPersistentBitAndUpdateBit_AreBooleanShaped(t *testing.T) {
	for _, field := range []StateField{PersistentBit, UpdateBit} {
		p := NewPalette()
		id := p.Get("minecraft:oak_leaves", map[string]StateValue{field.Key: float64(0)})

		if got, ok := p.StateInt(id, field); !ok || got != 0 {
			t.Fatalf("%s: StateInt = (%v, %v), want (0, true)", field.Key, got, ok)
		}

		derived, ok := p.WithIntState(id, field, 1)
		if !ok {
			t.Fatalf("%s: WithIntState(id, 1) ok=false, want true", field.Key)
		}
		if got, ok := p.StateInt(derived, field); !ok || got != 1 {
			t.Fatalf("%s: StateInt(derived) = (%v, %v), want (1, true)", field.Key, got, ok)
		}

		for _, bad := range []int{2, 3, 64, -1} {
			if got, ok := p.WithIntState(id, field, bad); ok || got != id {
				t.Errorf("%s: WithIntState(id, %d) = (%v, %v), want (id, false) -- ValueCount=2, domain is {0,1}", field.Key, bad, got, ok)
			}
		}
	}
}

// TestFacingDirection_DomainIsSixValues confirms FacingDirection (see this package's state.go
// doc comment for the derivation: it is registered with a value count of 6) accepts exactly
// [0,6) -- the same six-value Facing domain already established elsewhere in this codebase
// (Down=0, Up=1, North=2, South=3, West=4, East=5 -- partially_exposed_blob.go's own source)
// -- and rejects
// everything else, using the same read/modify/derive shape already proven above.
func TestFacingDirection_DomainIsSixValues(t *testing.T) {
	p := NewPalette()
	// A dropper, not an amethyst cluster: the state catalogue says a cluster's
	// type declares minecraft:block_face and no facing_direction at all, so
	// the engine could not set this state on one. Its siblings here are the
	// dropper's own.
	id := p.Get("minecraft:dropper", map[string]StateValue{
		"facing_direction": float64(0),
		"triggered_bit":    false,
	})

	if got, ok := p.StateInt(id, FacingDirection); !ok || got != 0 {
		t.Fatalf("StateInt = (%v, %v), want (0, true)", got, ok)
	}

	for _, v := range []int{0, 1, 2, 3, 4, 5} {
		derived, ok := p.WithIntState(id, FacingDirection, v)
		if !ok {
			t.Fatalf("WithIntState(id, %d) ok=false, want true -- ValueCount=6, domain is [0,6)", v)
		}
		if got, ok := p.StateInt(derived, FacingDirection); !ok || got != v {
			t.Fatalf("StateInt(derived) = (%v, %v), want (%d, true)", got, ok, v)
		}
		// The sibling authored state must survive alongside the derived one -- see
		// TestWithIntState_PreservesOtherStates for the same contract proven generically.
		if states := p.StatesOf(derived); states["triggered_bit"] != false {
			t.Errorf("WithIntState(id, %d): sibling state clobbered: %+v", v, states)
		}
	}

	for _, bad := range []int{6, 7, 64, -1} {
		if got, ok := p.WithIntState(id, FacingDirection, bad); ok || got != id {
			t.Errorf("WithIntState(id, %d) = (%v, %v), want (id, false) -- ValueCount=6, domain is [0,6)", bad, got, ok)
		}
	}
}

// TestWithIntState_RefusesAStateTheTypeDoesNotDeclare is the rejection this
// file recorded for months as out of reach: the engine's state write fails on a block type
// that does not declare the state, and the engine keeps the original block.
// A vine is the case that matters, because this port has been setting
// multi_face_direction_bits on one -- a vine's type declares
// vine_direction_bits and nothing else, so the engine could never have.
func TestWithIntState_RefusesAStateTheTypeDoesNotDeclare(t *testing.T) {
	p := NewPalette()
	vine := p.Get("minecraft:vine", nil)
	got, ok := p.WithIntState(vine, MultiFaceDirectionBits, 4)
	if ok {
		t.Errorf("a vine's type declares vine_direction_bits, not multi_face_direction_bits; ok=true, want false")
	}
	if got != vine {
		t.Errorf("a refused derivation must return the input id verbatim; got %v, want %v", got, vine)
	}

	// The same call on a type that DOES declare it still works, so the
	// rejection is about the type and not about the state.
	if _, ok := p.WithIntState(p.Get("minecraft:glow_lichen", nil), MultiFaceDirectionBits, 4); !ok {
		t.Error("glow lichen declares multi_face_direction_bits and must accept a value in its domain")
	}

	// And a block type the catalogue knows nothing about keeps the old
	// behaviour: nothing is known about what it declares, so only the state's
	// own width is checked.
	if _, ok := p.WithIntState(p.Get("pack:custom_vine", nil), MultiFaceDirectionBits, 4); !ok {
		t.Error("a pack's own block must keep the state-width-only check")
	}
}

// TestWithIntState_UsesTheTypesOwnDomainWidth is the other half: several types
// declare a state NARROWER than the state itself. rail_direction has ten
// values on an ordinary rail and six on a powered one, so 6..9 is legal on the
// first and illegal on the second -- a distinction field.ValueCount alone
// cannot make.
func TestWithIntState_UsesTheTypesOwnDomainWidth(t *testing.T) {
	railDirection := StateField{Key: "rail_direction", ValueCount: 10}
	p := NewPalette()

	rail := p.Get("minecraft:rail", nil)
	golden := p.Get("minecraft:golden_rail", nil)

	for _, v := range []int{0, 5} {
		if _, ok := p.WithIntState(rail, railDirection, v); !ok {
			t.Errorf("rail_direction %d is legal on both rails; ok=false on minecraft:rail", v)
		}
		if _, ok := p.WithIntState(golden, railDirection, v); !ok {
			t.Errorf("rail_direction %d is legal on both rails; ok=false on minecraft:golden_rail", v)
		}
	}
	for _, v := range []int{6, 9} {
		if _, ok := p.WithIntState(rail, railDirection, v); !ok {
			t.Errorf("rail_direction %d is within an ordinary rail's ten values; ok=false", v)
		}
		if _, ok := p.WithIntState(golden, railDirection, v); ok {
			t.Errorf("rail_direction %d is outside a powered rail's six values; ok=true, want false", v)
		}
	}
}

// TestStateFieldsAgreeWithTheCatalogue cross-checks the five StateFields this
// file declares by hand against the generated per-type catalogue: no type may
// declare one of them wider than the field says it is, and at least one type
// must declare it at exactly that width. A field whose ValueCount had been
// read wrong would show up here as one side or the other failing.
func TestStateFieldsAgreeWithTheCatalogue(t *testing.T) {
	fields := []StateField{MultiFaceDirectionBits, PersistentBit, UpdateBit, GrowingPlantAge, FacingDirection}
	for _, field := range fields {
		widest, declarers := 0, 0
		for name, declared := range vanillaBlockStateTable {
			state, ok := findVanillaState(declared, field.Key)
			if !ok {
				continue
			}
			declarers++
			if state.count > field.ValueCount {
				t.Errorf("%s declares %s with %d values, wider than StateField's %d",
					name, field.Key, state.count, field.ValueCount)
			}
			if state.count > widest {
				widest = state.count
			}
		}
		if declarers == 0 {
			t.Errorf("no vanilla block type declares %s at all", field.Key)
			continue
		}
		if widest != field.ValueCount {
			t.Errorf("the widest type-level domain for %s is %d, but StateField says %d",
				field.Key, widest, field.ValueCount)
		}
	}
}
