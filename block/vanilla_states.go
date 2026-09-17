package block

// vanilla_states.go is the read side of the per-block-type STATE catalogue --
// the table that answers "can a block of THIS type ever carry THAT state, and
// what value does it have when nobody has set one?".
//
// Everything in this package before it worked one level down, on a single
// placed block: block.Palette interns any (name, states) pair a pack asks for
// and never asks whether the type could really carry those states. That is the
// right model for a palette, and it is exactly the wrong model for the three
// questions the engine asks about a block's TYPE rather than about one placed
// instance:
//
//   - rotate.go's transform gate ("does this type declare that state") --
//     which is why a bare places_block: "minecraft:torch" used not to rotate
//     here even though the engine rotates it;
//   - state.go's WithIntState ("is this state on this type at all, and how
//     wide is its domain here") -- a state a type does not declare cannot be
//     set on it, and several types narrow a state's domain;
//   - features/horizontal_tree_decoration.go's two required-state gates, which
//     the engine refuses the whole placement over.
//
// All three used to stand in for the answer with a guess, each documented
// where it stood. This table replaces the guess.
//
// ---- Provenance ----
//
// The state names and their value domains agree exactly with Mojang's own
// published block metadata, metadata/vanilladata_modules/mojang-blocks.json in
// the Mojang/bedrock-samples repository, which is the game's own published list
// of every block's state list and every state's legal values: over the block ids
// present in both, no state set differs, and every state's value list matches
// value-for-value, in order. That is a checkable claim about a public file,
// and it is the reason the names and domains here are not an approximation.
//
// The defaults have no counterpart in that file. A def below is the value a
// freshly-placed block of that type carries for that state -- the value the
// game gives it when a pack writes the block's name and says nothing about
// its states. Most are the first value of the state's own domain; twenty-seven
// of them, over twenty-six block types, are not, and those are the interesting
// ones (a chest faces north, not south;
// a dripstone hangs; suspicious sand is placed hanging; glow lichen starts on
// all six faces).
//
// ---- What "unknown" means, and why it is not "no states" ----
//
// The catalogue covers vanilla block types. Ask it about anything else -- a
// pack's own custom block, a legacy id that is only an alias for a real type,
// a block added to the game after this catalogue was generated -- and it says
// UNKNOWN, which is a third answer, distinct from "declares no states". Every
// caller here has to handle it, and each of the three does so by falling back
// to precisely the behaviour it had before this file existed. That keeps a
// custom block behaving exactly as it did rather than being silently treated
// as a stateless vanilla one.
//
// The table itself is generated: see cmd/genvanillastates and
// block/vanilla_states_table.go.

// vanillaStateKind is how a state's values are spelled in block JSON, which
// is also what makes its domain derivable from a count: an integer state's
// values are its own indices, a boolean's are false then true, and an
// enumeration's are the ordered strings in its domain.
type vanillaStateKind uint8

const (
	vanillaStateInt vanillaStateKind = iota
	vanillaStateBool
	vanillaStateEnum
)

// vanillaStateDomain is one state's legal values, held once per state NAME
// rather than once per (block, state) pair.
type vanillaStateDomain struct {
	kind vanillaStateKind
	// values is the ordered enumeration spellings; nil for integer and
	// boolean states, whose values are implied by kind and count.
	values []StateValue
}

// vanillaBlockState is one state a vanilla block type declares: the JSON key,
// how many legal values it has ON THIS TYPE (a type may narrow, and one
// widens), and the value a freshly-placed block of the type carries.
type vanillaBlockState struct {
	key   string
	count int
	def   StateValue
}

// VanillaState is one declared state, as callers outside this package see it.
type VanillaState struct {
	// Key is the JSON state key, exactly as block JSON spells it -- including
	// the "minecraft:" prefix on the states that carry one.
	Key string
	// ValueCount is how many legal values the state has on this block type.
	// The legal values themselves are VanillaStateValues.
	ValueCount int
	// Default is the value a freshly-placed block of this type carries for
	// the state.
	Default StateValue
}

// VanillaBlockKnown reports whether name is a vanilla block type this
// catalogue covers. A false answer is "nothing is known about this type",
// NOT "this type declares no states" -- see this file's header.
func VanillaBlockKnown(name string) bool {
	_, ok := vanillaBlockStateTable[canonicalName(name)]
	return ok
}

// LookupVanillaState returns the state key as the vanilla block type name
// declares it. ok is false both when the type is unknown and when it is known
// and does not declare that state; a caller that must tell those apart asks
// VanillaBlockKnown first, and every caller in this repo does.
func LookupVanillaState(name, key string) (VanillaState, bool) {
	declared, _ := vanillaDeclaredStates(name)
	state, ok := findVanillaState(declared, key)
	if !ok {
		return VanillaState{}, false
	}
	return VanillaState{Key: state.key, ValueCount: state.count, Default: state.def}, true
}

// VanillaStateValues returns the legal values of key on block type name, in
// the game's own order, or nil when the type does not declare it. The result
// must not be modified: for an enumeration it shares the catalogue's own
// slice.
func VanillaStateValues(name, key string) []StateValue {
	declared, _ := vanillaDeclaredStates(name)
	state, ok := findVanillaState(declared, key)
	if !ok {
		return nil
	}
	domain := vanillaStateDomains[key]
	switch domain.kind {
	case vanillaStateEnum:
		if state.count <= len(domain.values) {
			return domain.values[:state.count]
		}
	case vanillaStateBool:
		return []StateValue{false, true}
	}
	values := make([]StateValue, state.count)
	for i := range values {
		values[i] = float64(i)
	}
	return values
}

// VanillaBlockStates returns every state block type name declares, ordered by
// key, or nil when the type is unknown or declares none. Ask VanillaBlockKnown
// to tell those two apart.
func VanillaBlockStates(name string) []VanillaState {
	declared, _ := vanillaDeclaredStates(name)
	if len(declared) == 0 {
		return nil
	}
	out := make([]VanillaState, 0, len(declared))
	for _, state := range declared {
		out = append(out, VanillaState{Key: state.key, ValueCount: state.count, Default: state.def})
	}
	return out
}

// vanillaDeclaredStates is the package-internal lookup rotate.go's transform
// gate and state.go's WithIntState both start from: the type's whole declared
// set, plus whether the type is known at all. Both callers ask about several
// keys against one block, so they take the slice once and search it rather
// than going back to the map per key.
func vanillaDeclaredStates(name string) ([]vanillaBlockState, bool) {
	declared, known := vanillaBlockStateTable[canonicalName(name)]
	return declared, known
}

// findVanillaState searches a type's declared set. The sets are tiny -- eight
// states is the widest in the catalogue -- so a linear scan beats hashing and
// keeps the table free of a second index.
func findVanillaState(declared []vanillaBlockState, key string) (vanillaBlockState, bool) {
	for _, state := range declared {
		if state.key == key {
			return state, true
		}
	}
	return vanillaBlockState{}, false
}
