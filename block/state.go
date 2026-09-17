package block

// state.go is the "read a placed block's live state, modify a sub-field,
// derive a new block.ID" capability this repo's block.Palette previously had
// no representation for -- the single missing capability four
// independent feature investigations (multiface_feature, mega_canopy,
// mega_pine_canopy, the mega trunk -- see featurelab-go/features/coverage.go's
// minecraft:multiface_feature entry and features/tree.go's mega-trunk
// survey) stopped at from different directions. Every feature this port
// implements before this file only ever resolved a STATIC block.Descriptor
// to a block.ID via Palette.Resolve/Get; none needed to read an
// already-placed block's live state back and re-derive an ID from it.
//
// ---- What the game does, and how this file mirrors it ----
//
// The game's own primitive is a named, bounded block state: a field a block
// type can expose, read and written per block. The multiface block's worldgen
// placement shows the shape: if the block being placed shares this multiface
// block's own block type AND that type declares the multiface direction-bits
// state, it reads the EXISTING block's current int value for that state, then
// -- once a placement direction clears a multiface-support check -- ORs in the
// bit for the new face and writes the combined bits back. The result: if the
// write succeeds it yields the NEW block; if it fails, it yields the ORIGINAL
// block UNCHANGED, not a zero value, not a crash, not a silently-clamped value.
// WithIntState below mirrors that exact fallback shape.
//
// The multiface direction-bits state has the JSON state key
// "multi_face_direction_bits" and a declared VALUE COUNT of 64 (compare "lit",
// a boolean-shaped state with a value count of 2). That is the declared
// CARDINALITY of this one state, 64 legal integer values, 0 through 63
// inclusive, matching exactly the all-faces multiface mask of 63 (the six
// multiface bits are DOWN=1, UP=2, SOUTH=4, WEST=8, NORTH=16, EAST=32, with
// SIDES=60, ALL=63 -- a plain 6-independent-bits domain). It is NOT a 64-entry
// lookup table; no such table exists.
//
// The multiface mask-to-face-list expansion is NOT part of this capability and
// was NOT ported here: it decodes a mask into the ordered list of set Facing
// values (DOWN=0, UP=1, NORTH=2, SOUTH=3, WEST=4, EAST=5, tested in
// EAST/WEST/SOUTH/NORTH/UP/DOWN order), and it serves the SEPARATE multiface
// spreader growth subsystem, which features/coverage.go's
// minecraft:multiface_feature entry already documents as out of scope (the
// same class family sculk_patch_feature's own unported spreader belongs to).
// Recorded here because it is part of this capability's own shape, not because
// it is shipped.
//
// The persistent-bit and update-bit states -- the fields the mega trunk's own
// decoration pass mutates per features/tree.go's survey -- were known to exist
// well before their value counts were. Until those were known, both were
// deliberately NOT defined as a StateField here: guessing "2" (plausible for a
// "*_bit" name) would be exactly the silent approximation this project's
// standard forbids. Their own doc comment below records what closed it.
//
// ---- The API shape, and why ----
//
// StateField + StateInt + WithIntState is deliberately NOT a general
// block-state system. It names the individual states this port's features
// actually read and write, and says of each "field X is a bounded integer
// with exactly N legal values", so that a derivation can be checked against
// that bound with the game's own fallback behavior on an illegal value. That is what ships below.
//
// What it deliberately did NOT have, until block/vanilla_states.go, is the
// other half of the question: which TYPES declare a state, and how wide it is
// on each of them. This file used to record that as out of reach ("this
// palette's open intern-any-pair model has no permutation catalog to consult"),
// and WithIntState now consults exactly that catalogue -- see its own doc
// comment for the two checks and for what still falls back for a block type
// the catalogue does not know.

// StateField identifies one bounded-integer block state by its JSON state key
// and legal integer domain [0, ValueCount) -- a state is defined by its name
// and its value count. See this file's package-level doc comment for the
// multiface direction-bits state.
type StateField struct {
	Key        string
	ValueCount int
}

// MultiFaceDirectionBits is the multiface direction-bits state, JSON key
// "multi_face_direction_bits", ValueCount 64 (see this file's package doc
// comment). The multiface block's worldgen placement reads and re-derives this
// field when placing a new face onto an already-placed multiface block (vines,
// glow lichen, sculk vein).
var MultiFaceDirectionBits = StateField{Key: "multi_face_direction_bits", ValueCount: 64}

// PersistentBit is the persistent-bit state and UpdateBit the update-bit
// state, closing the gap this file's package doc comment left open. Both are
// defined with a value count of 2:
//
//   - "persistent_bit": value count 2.
//   - "update_bit": value count 2.
//
// i.e. both are ordinary boolean-shaped integer states with domain {0,1}, like
// "lit". That is known, not a "plausible for a *_bit name" assumption.
//
// Defining them here does NOT by itself port the radial block-group write or
// the mega trunk's own decoration pass (see features/tree.go's header for the
// full account of what those do with these two fields, and what part of that
// is now representable versus what still isn't).
var PersistentBit = StateField{Key: "persistent_bit", ValueCount: 2}
var UpdateBit = StateField{Key: "update_bit", ValueCount: 2}

// GrowingPlantAge is the growing-plant age state, JSON key
// "growing_plant_age", ValueCount 26.
//
// Which block types actually carry it: exactly the three cave-vines block
// types (cave vines, cave vines body with berries, cave vines head with
// berries). Weeping and twisting vines do NOT carry this state (they use their
// own weeping_vines_age/twisting_vines_age keys); see features/growing_plant.go
// for what that means for the age field.
var GrowingPlantAge = StateField{Key: "growing_plant_age", ValueCount: 26}

// FacingDirection is the facing-direction state, JSON key "facing_direction",
// ValueCount 6. 6 matches this codebase's own Facing encoding exactly (Down=0,
// Up=1, North=2, South=3, West=4, East=5 -- same source as
// partially_exposed_blob.go's partiallyExposedBlobFacingOffsets and
// sculk_patch.go's sculkFacingOffsets).
//
// The geode feature, when placing an inner block, checks whether the picked
// block's type declares facing_direction and, only when true, derives a new
// block with that state set -- otherwise the picked block is placed completely
// unchanged. features/geode.go's consumer of this field applies WithIntState to
// whichever block inner_placements picks, and WithIntState is now that gate: a
// picked block whose TYPE does not declare facing_direction comes back
// unchanged, which is the game's own branch. Worth knowing about the vanilla
// case, because it is not the obvious one: an amethyst cluster's type declares
// minecraft:block_face and NO facing_direction at all, so a vanilla geode's own
// inner placements take that unchanged branch. See features/geode.go's header
// for the full account of what this closes and what (the block's own
// block-type-specific placement check) it still does not.
var FacingDirection = StateField{Key: "facing_direction", ValueCount: 6}

// StateInt reads block id's current value for field, coerced from this
// palette's JSON-number StateValue convention (float64 -- see
// AsBlockDescriptor in features/shared.go, the same convention every
// Descriptor.States value already goes through). ok is false when the
// entry carries no value at all for field.Key, or the stored value is not a
// JSON number -- both are "this block doesn't currently expose that state",
// which is exactly what a caller needs to know before attempting
// WithIntState. This is the "read a placed block's live state back" half of
// the capability: mechanically, Entry(id).States[field.Key] was already
// reachable before this file existed (block.Entry's States map is exported),
// but every existing caller only ever wrote a state, never read one back off
// an interned entry -- StateInt is that missing read path, named and typed
// to the bounded-integer state shape rather than a raw map
// lookup.
//
// It deliberately does NOT fall back to the block type's default value now
// that block/vanilla_states.go knows what that is. StateInt's question is
// about the PLACED block -- "is a value written here" -- and every caller uses
// the false answer as "leave this block alone", which is a decision about the
// instance. A caller that wants the other question, "what would this type's
// value be if nobody had written one", asks LookupVanillaState for the type's
// default; folding the two together behind one call would change what several
// existing callers mean without any of them saying so.
// A flag state has two representations here and both are legitimate: the
// per-type catalogue in vanilla_states_table.go declares one as a Go bool,
// while pack JSON and NBT deliver the same state as a number. This used to
// accept only the number, and so reported "no such state" for a state that
// was plainly present -- which is a silent failure, because every caller
// treats !ok as "this block does not have that state" and skips its work.
// That is how the update_bit/persistent_bit normalization in tree.go came to
// be a no-op on catalogue-shaped blocks without anything failing.
//
// The rest of the package already coerces between the two forms wherever it
// compares them (sameStateValue, truthyStateValue in tags.go); this brings
// the integer read into line with them rather than inventing a third rule.
func (p *Palette) StateInt(id ID, field StateField) (int, bool) {
	v, ok := p.Entry(id).States[field.Key]
	if !ok {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		return int(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// WithIntState derives a new interned ID from id with field's value replaced
// by newValue, mirroring the multiface block's worldgen placement and its
// read-modify-write-back shape (see this file's package doc
// comment):
// compute a candidate new value for a bounded state field, ask for the
// resulting block, and fall back to the ORIGINAL block, unchanged, if the
// candidate is illegal -- not a zero ID, not a panic, not a silently-clamped
// value. That fallback is exactly WithIntState's own
// contract: when ok is false, the returned ID *is* id, verbatim.
//
// There are two domain checks, and until block/vanilla_states.go existed this
// could only make the first:
//
//  1. field.ValueCount -- the state's own declared width
//     (MultiFaceDirectionBits's doc comment). This
//     is the width the state has anywhere it appears.
//  2. What the BLOCK'S OWN TYPE says. Setting a state fails on a type
//     that does not declare the state at all, and several types declare a
//     state
//     NARROWER than the state itself (a powered rail's rail_direction has six
//     values where the state has ten). Both make an otherwise-in-range value
//     illegal on that particular block. This file used to record that
//     rejection as unreachable -- "this palette's open intern-any-pair model
//     has no permutation catalog to consult" -- and it is exactly what the
//     per-block-type state catalogue answers.
//
// So: for a vanilla block type, a state the type does not declare is refused
// outright (the block comes back unchanged, which is what the game does
// with a failed state write), and the domain checked is the type's own, not
// the state's. For a block type the catalogue does not know -- a pack's own
// block -- the check falls back to field.ValueCount alone, exactly as before,
// because nothing is known about what that type declares.
func (p *Palette) WithIntState(id ID, field StateField, newValue int) (ID, bool) {
	entry := p.Entry(id)
	limit := field.ValueCount
	if declared, known := vanillaDeclaredStates(entry.Name); known {
		state, declares := findVanillaState(declared, field.Key)
		if !declares {
			return id, false
		}
		limit = state.count
	}
	if newValue < 0 || newValue >= limit {
		return id, false
	}
	states := make(map[string]StateValue, len(entry.States)+1)
	for k, v := range entry.States {
		states[k] = v
	}
	states[field.Key] = float64(newValue)
	return p.intern(entry.Name, states), true
}
