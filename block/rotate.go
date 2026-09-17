package block

import "sort"

// rotate.go is the game's block rotation by a horizontal direction. It is what
// turns "place a torch" into "place a torch pointing off the wall you attached
// to", and minecraft:single_block_feature needs it: any single_block file that
// writes may_attach_to has auto_rotate's default of TRUE live, and the game
// rotates every such placement. Until this file existed the port implemented
// the identity case only and warned.
//
// The behaviour modelled is that of Bedrock 1.26.50.
//
// ---- The shape, and the three things a port gets wrong ----
//
// The rotation has NO DISPATCH. It is a flat, unconditional sequence of 16
// independent arms, each of the same shape:
//
//	if the block's type lacks this arm's state -> skip to the next arm
//	look the direction up in this arm's direction mapping, FIRST MATCH WINS
//	take the mapped state VALUE from the matching entry
//	a miss -> an assertion ("Failed to look up mapping value!") and a value
//	          of 0, i.e. the state is still SET, to zero
//	set the state to that value
//	a failed set keeps the previous block
//
// so:
//
//  1. EVERY arm whose state the block carries fires, in sequence, CUMULATIVELY.
//     A block with two handled states gets both set. There is no "first match
//     wins" between arms -- the first-match-wins is inside one arm's lookup in
//     its own mapping.
//  2. Each arm is an absolute SET, not a rotation. The mapped value depends only
//     on the CommonDirection argument; the block's current value of that state
//     is never read. "Rotate a stair that already faces east by one quarter" is
//     not a thing this function can express.
//  3. A block carrying none of the 16 states comes back UNCHANGED. The identity
//     case is correct, and correct for that reason.
//
// A direction mapping pairs state values with directions; the rotation uses it
// in the direction -> state value sense.
//
// ---- The direction enum ----
//
// 0 = north, 1 = east, 2 = south, 3 = west. Five independent tables that all
// index the enum agree on that order: Facing -> north/east/south/west; vine
// bits 4/8/1/2; multiface 0x10/0x20/4/8; portal axis z/x/z/x; the
// cardinal-direction state's own enum 2/3/0/1 -- and multi_block_feature uses
// the same order. Values 4-23 are the non-horizontal and ascending/diagonal
// forms and 24 is a non-horizontal sentinel; none of them is reachable from
// single_block_feature, and this file deliberately does not model them (see
// "What this file does not do" below).
//
// ---- The sixteen arms ----
//
// Three families share a mapping table (block_face = facing_direction =
// minecraft:facing_direction; direction = minecraft:cardinal_direction), so
// there are 11 distinct tables plus 3 inline forms.
//
//	#   JSON state                       value form
//	1   portal_axis                      mapping table
//	2   minecraft:cardinal_direction     mapping table
//	3   minecraft:facing_direction       mapping table (shared with 4 and 6)
//	4   minecraft:block_face             mapping table (shared with 3 and 6)
//	5   direction                        mapping table (shared with 2)
//	6   facing_direction                 mapping table (shared with 3 and 4)
//	7   rail_direction                   mapping table
//	8   torch_facing_direction           mapping table
//	9   ground_sign_direction            plain int, fixed per direction
//	10  weirdo_direction                 mapping table
//	11  coral_direction                  mapping table
//	12  lever_direction                  mapping table
//	13  pillar_axis                      mapping table
//	14  vine_direction_bits              plain int, fixed per direction
//	15  multi_face_direction_bits        plain int, fixed per direction
//	16  orientation                      mapping table
//
// The INTEGER each arm sets for directions 0/1/2/3 is CONFIRMED for all
// sixteen. What is not uniformly confirmed is the step after that: how the
// integer is spelled in a pack's JSON. See the next section.
//
// ---- Integer -> JSON token: what is CONFIRMED and what is INFERRED ----
//
// The rotation sets an enum or int VALUE; a pack writes a token. Which token
// belongs to which value is a property of the state's own serialisation, which
// is not confirmed for every family. Each row of transformBlockArms carries its
// own label, and this is what those labels mean:
//
// CONFIRMED -- the value->token step is known:
//
//   - minecraft:block_face and its facing-direction spellings: 0=Down 1=Up
//     2=North 3=South 4=West 5=East, in both directions (index -> name and
//     name -> index). (Name lookup is case-insensitive in the game -- this
//     port does not need to be, because the arm never reads the old value.)
//   - minecraft:cardinal_direction: 0=south 1=west 2=north 3=east. Same table
//     support.go's cardinalDirectionFacing already uses.
//   - pillar_axis: 0=y 1=x 2=z. A block state's NBT serialisation maps the
//     state's integer value directly onto its name by position.
//   - ground_sign_direction, vine_direction_bits and multi_face_direction_bits
//     need no spelling at all: these three arms have no enum mapping behind
//     them, i.e. the rotation writes them as plain integers. A plain integer
//     state's JSON value IS the integer. multi_face_direction_bits is
//     independently an integer state in state.go, with ValueCount 64, and its
//     four bit values here (north 16, east 32, south 4, west 8) match the
//     multiface bit constants that file uses.
//
// INFERRED -- the integer is confirmed, the token comes from vanilla state
// definitions. Every one of them is corroborated by the same consistency
// check, which a wrong ordering would fail: the CommonDirection 0 row has to
// land on that family's own "north", the 1 row on its "east", and so on.
//
//   - minecraft:facing_direction shares block_face's CONFIRMED table; only the
//     fact that it is spelled as a string (like the other minecraft:-prefixed
//     built-ins) is inferred.
//   - facing_direction, direction, rail_direction, weirdo_direction and
//     coral_direction are the legacy, un-prefixed states, written as plain
//     integers in vanilla block JSON. The integers below are the confirmed ones;
//     what is inferred is that they are not spelled as words.
//   - portal_axis (0=unknown 1=x 2=z), torch_facing_direction (0=unknown 1=west
//     2=east 3=north 4=south 5=top), lever_direction (0=down_east_west 1=east
//     2=west 3=south 4=north 5=up_north_south 6=up_east_west
//     7=down_north_south) and orientation (0..7 down_east, down_north,
//     down_south, down_west, up_east, up_north, up_south, up_west, then 8..11
//     west_up, east_up, north_up, south_up) are spelled as words and their
//     orders are inferred. portal_axis's confirmed integer row is identical to
//     pillar_axis's (2/1/2/1), whose spelling IS confirmed; orientation's 0..7
//     half is the same ordering the direction cross-check produces
//     independently from that state's own 0-3 and 4-7 halves.
//
// InferredTransformStates reports which of these a given block carries, and
// features/single_block.go warns on it at load time -- so a pack that leans on
// one of the inferred families is told that it did, rather than being handed a
// confident answer.
//
// ---- The gate is a question about the TYPE ----
//
// Each arm asks whether the block's TYPE can ever carry that state, not what
// value the placed instance happens to hold. This file used to stand
// in for that with "the interned entry carries a value for that key", because
// this palette interns any (name, states) pair a pack asks for and had no
// catalogue of what a type declares. block/vanilla_states.go is now that
// catalogue, and the gate asks it: for a vanilla block type, an arm fires when
// the TYPE declares the arm's state, whatever the pack did or did not write.
// Two consequences, and the stand-in had both backwards:
//
//   - a bare places_block: "minecraft:torch" now rotates. The type declares
//     torch_facing_direction, so the arm fires and SETS it, which is what the
//     game does; the stand-in saw no states on the entry and handed the
//     block back unchanged.
//   - a state written onto a type that does not declare it is no longer
//     rotated. Writing direction on minecraft:stone does not make stone
//     directional, and the gate now says so instead of rotating it.
//
// A block type the catalogue does not know -- a pack's own block, or a vanilla
// id newer than the catalogue -- keeps the old stand-in exactly, so nothing
// about a custom block changes. That is the one place this gate is still an
// approximation, and it is now confined to blocks about which nothing is
// known rather than applying to every block.
//
// ---- What this file does not do ----
//
//   - It models directions 0-3 ONLY. Those are the four values
//     single_block_feature can produce (its four side attachments use 0/1/2/3,
//     and randomize_rotation uses a uniform draw over 4). The rows for the
//     rest are NOT here, and TransformBlock returns the block unchanged for any
//     other value -- which is a port-level refusal to guess, NOT game
//     behaviour. One row is worth recording even so, because it is surprising:
//     for the facing-direction families, direction 24 maps to "up", because the
//     entry for Facing 1 matches before the entry for Facing 0 and so "down" is
//     unreachable.
//   - rail_direction at directions 0-3 is NOT an omission. That mapping holds
//     only directions 4, 5 and 16-23, so a rail hit with a horizontal direction
//     misses the lookup, takes the assertion path, and is SET to 0. That is game
//     behaviour and it is modelled as such below.
//   - There is a second form of the rotation taking a Facing instead, which
//     converts it to a direction and then behaves identically.
//     single_block_feature does not use it; it is not ported.

// CommonDirection is the game's direction enum, narrowed to the four
// horizontal values this port models. See this file's doc comment for the
// value order and for why 4-24 are deliberately absent.
type CommonDirection int

// The four horizontal CommonDirection values [CONFIRMED by five mutually
// independent tables; these are the values the single-block feature's four side
// attachments use, and the domain of randomize_rotation's uniform draw over 4].
const (
	CommonDirectionNorth CommonDirection = 0
	CommonDirectionEast  CommonDirection = 1
	CommonDirectionSouth CommonDirection = 2
	CommonDirectionWest  CommonDirection = 3
)

// horizontal reports whether d is one of the four values this port has tables
// for. Everything else is refused rather than guessed at.
func (d CommonDirection) horizontal() bool {
	return d >= CommonDirectionNorth && d <= CommonDirectionWest
}

// transformArm is one arm of the rotation: the JSON state key its non-legacy
// state gate names, and the value it SETS for each of the four horizontal
// CommonDirections. inferred marks the arms whose integer is confirmed but
// whose JSON token is inferred from vanilla state definitions -- see this
// file's doc comment.
type transformArm struct {
	key      string
	values   [4]StateValue
	inferred bool
}

// transformBlockArms is the sixteen arms, IN THE GAME'S OWN ORDER. The order
// does not change the result -- no two arms write the same key, and every arm
// whose state is present fires -- but it is kept because the derivation is
// stated in that order and because iterating a slice keeps this deterministic,
// which iterating the block's own state map would not.
//
// Rows are CommonDirection 0/1/2/3 = north/east/south/west. Integers are stored
// as float64, this palette's JSON-number convention (the same one
// state.go's WithIntState writes).
var transformBlockArms = []transformArm{
	// 1. portal_axis -- 2/1/2/1. Identical to pillar_axis.
	{key: "portal_axis", values: [4]StateValue{"z", "x", "z", "x"}, inferred: true},
	// 2. minecraft:cardinal_direction -- 2/3/0/1, spelled via the direction-name
	// order (0=south 1=west 2=north 3=east). CONFIRMED.
	{key: "minecraft:cardinal_direction", values: [4]StateValue{"north", "east", "south", "west"}},
	// 3. minecraft:facing_direction -- 2/5/3/4. Table CONFIRMED, string form
	// inferred from the other minecraft:-prefixed built-ins.
	{key: "minecraft:facing_direction", values: [4]StateValue{"north", "east", "south", "west"}, inferred: true},
	// 4. minecraft:block_face -- 2/5/3/4, spellings CONFIRMED in both directions
	// (index -> name and name -> index). This is the arm packs most commonly
	// exercise.
	{key: "minecraft:block_face", values: [4]StateValue{"north", "east", "south", "west"}},
	// 5. direction -- 2/3/0/1, legacy integer spelling.
	{key: "direction", values: [4]StateValue{float64(2), float64(3), float64(0), float64(1)}, inferred: true},
	// 6. facing_direction -- 2/5/3/4, legacy integer spelling. This
	// is a DIFFERENT, separately defined state from minecraft:facing_direction
	// above; both arms exist and both fire.
	{key: "facing_direction", values: [4]StateValue{float64(2), float64(5), float64(3), float64(4)}, inferred: true},
	// 7. rail_direction -- the mapping holds only CommonDirection 4, 5 and 16-23,
	// so all four horizontal directions MISS the lookup, hit the assertion path
	// and set 0. Modelled, not "fixed": the game really does flatten a rail to
	// north_south here.
	{key: "rail_direction", values: [4]StateValue{float64(0), float64(0), float64(0), float64(0)}, inferred: true},
	// 8. torch_facing_direction -- 3/2/4/1 (0=unknown 1=west 2=east 3=north
	// 4=south 5=top).
	{key: "torch_facing_direction", values: [4]StateValue{"north", "east", "south", "west"}, inferred: true},
	// 9. ground_sign_direction -- fixed per direction, 0/4/8/12, a plain integer
	// state. Note this row is NOT "the compass direction of the
	// CommonDirection": standing-sign rotation 0 faces south, so a north
	// attachment yields a sign at rotation 0.
	{key: "ground_sign_direction", values: [4]StateValue{float64(0), float64(4), float64(8), float64(12)}},
	// 10. weirdo_direction -- 3/0/2/1 (stairs).
	{key: "weirdo_direction", values: [4]StateValue{float64(3), float64(0), float64(2), float64(1)}, inferred: true},
	// 11. coral_direction -- 2/1/3/0.
	{key: "coral_direction", values: [4]StateValue{float64(2), float64(1), float64(3), float64(0)}, inferred: true},
	// 12. lever_direction -- 4/1/3/2 (0=down_east_west 1=east
	// 2=west 3=south 4=north 5=up_north_south 6=up_east_west 7=down_north_south).
	{key: "lever_direction", values: [4]StateValue{"north", "east", "south", "west"}, inferred: true},
	// 13. pillar_axis -- 2/1/2/1, spelled via the pillar-axis name order
	// (0=y 1=x 2=z). CONFIRMED. A log attached north/south lies along z.
	{key: "pillar_axis", values: [4]StateValue{"z", "x", "z", "x"}},
	// 14. vine_direction_bits -- fixed per direction, 4/8/1/2, a plain integer
	// state. CONFIRMED. Note this is a SET of the whole bitfield, not an OR: a vine
	// already on two faces keeps only the one this direction names.
	{key: "vine_direction_bits", values: [4]StateValue{float64(4), float64(8), float64(1), float64(2)}},
	// 15. multi_face_direction_bits -- fixed per direction, 16/32/4/8, a plain
	// integer state of ValueCount 64 (state.go). Same whole-field SET.
	{key: "multi_face_direction_bits", values: [4]StateValue{float64(16), float64(32), float64(4), float64(8)}},
	// 16. orientation -- 10/9/11/8, i.e. the four *_up forms.
	{key: "orientation", values: [4]StateValue{"north_up", "east_up", "south_up", "west_up"}, inferred: true},
}

// transformGate is one block's answer to every arm's non-legacy state
// question -- see this file's "The gate is a question about the TYPE" section.
// It is taken once per TransformBlock call and asked sixteen times, so the
// catalogue lookup happens once rather than per arm.
type transformGate struct {
	declared []vanillaBlockState   // what the vanilla type declares
	known    bool                  // whether the catalogue knows the type at all
	states   map[string]StateValue // the placed instance's own states, the fallback
}

func newTransformGate(name string, states map[string]StateValue) transformGate {
	declared, known := vanillaDeclaredStates(name)
	return transformGate{declared: declared, known: known, states: states}
}

// declares reports whether this block's TYPE can carry key. For a vanilla type
// that is the catalogue's answer; for a type the catalogue does not know it
// falls back to "the interned entry carries a value for that key", which is
// what this whole file used to do for every block.
func (g transformGate) declares(key string) bool {
	if g.known {
		_, ok := findVanillaState(g.declared, key)
		return ok
	}
	_, ok := g.states[key]
	return ok
}

// TransformBlock is the game's block rotation, for the four
// horizontal directions: every arm whose state the
// block's TYPE declares fires, cumulatively, each one an absolute SET determined
// only by dir. A block whose type declares none of the sixteen states comes back
// as the identical ID, and so does any dir this port has no table for (see the
// file doc comment -- that last part is a refusal to guess, not the game).
func (p *Palette) TransformBlock(id ID, dir CommonDirection) ID {
	if !dir.horizontal() {
		return id
	}
	entry := p.Entry(id)
	gate := newTransformGate(entry.Name, entry.States)
	if !gate.known && len(entry.States) == 0 {
		// An unknown type with no states written on it cannot satisfy the
		// fallback gate for any arm; the catalogue is what makes the same
		// shortcut wrong for a known type (a bare torch has states to set).
		return id
	}
	var next map[string]StateValue
	for _, arm := range transformBlockArms {
		if !gate.declares(arm.key) {
			continue
		}
		if next == nil {
			next = make(map[string]StateValue, len(entry.States))
			for k, v := range entry.States {
				next[k] = v
			}
		}
		next[arm.key] = arm.values[dir]
	}
	if next == nil {
		return id
	}
	return p.intern(entry.Name, next)
}

// InferredTransformStates returns, sorted, the rotation state keys this block
// will actually be rotated on whose JSON token this port INFERRED rather than
// confirmed (see this file's doc comment). It is the load-time warning's input:
// rotation of these blocks is performed, on a confirmed integer, but the word
// or number written for that integer is inferred from vanilla state
// definitions, and a pack leaning on one deserves to know.
//
// It takes the block's NAME as well as its states because the gate it has to
// agree with does: a bare places_block: "minecraft:torch" is rotated on
// torch_facing_direction, which is one of the inferred families, and a warning
// keyed on the written states alone would have gone quiet on exactly the
// blocks the type catalogue newly rotates.
func InferredTransformStates(name string, states map[string]StateValue) []string {
	gate := newTransformGate(name, states)
	if !gate.known && len(states) == 0 {
		return nil
	}
	var out []string
	for _, arm := range transformBlockArms {
		if !arm.inferred {
			continue
		}
		if gate.declares(arm.key) {
			out = append(out, arm.key)
		}
	}
	sort.Strings(out)
	return out
}
