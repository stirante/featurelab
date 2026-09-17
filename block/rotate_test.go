package block

import "testing"

// These tests pin the SHAPE of block rotation as much
// as its values, because the shape is where an implementation goes wrong. See
// rotate.go's doc comment for what each expectation means.

// TestSetBlockDirectionFacingTableAllFourDirections is the table packs most
// commonly exercise and the one whose spellings are known in both
// directions (index -> name and name -> index):
// 2/5/3/4 for HorizontalDirection 0/1/2/3, spelled north/east/south/west.
func TestSetBlockDirectionFacingTableAllFourDirections(t *testing.T) {
	dirs := []struct {
		dir  HorizontalDirection
		want string
	}{
		{HorizontalDirectionNorth, "north"},
		{HorizontalDirectionEast, "east"},
		{HorizontalDirectionSouth, "south"},
		{HorizontalDirectionWest, "west"},
	}
	// All three arms that share the facing-direction mapping, plus
	// the two legacy integer forms of the same two enums, so that a change to
	// one row cannot silently drift from the others.
	for _, d := range dirs {
		p := NewPalette()
		// An amethyst cluster, not a lantern: the state catalogue says a
		// lantern's type declares only `hanging`, so the game
		// never opens a block_face arm on one. See the note on
		// TestSetBlockDirectionGateFollowsTheTypeNotTheWrittenStates.
		id := p.Get("minecraft:amethyst_cluster", map[string]StateValue{"minecraft:block_face": "up"})
		got := p.Entry(p.SetBlockDirection(id, d.dir)).States["minecraft:block_face"]
		if got != d.want {
			t.Errorf("HorizontalDirection %d: minecraft:block_face = %v, want %q", d.dir, got, d.want)
		}
	}
}

// TestSetBlockDirectionIsAnAbsoluteSetNotARotation is property 2 of the
// list in rotate.go: the arm never reads the block's current value, so the answer for
// a given HorizontalDirection is the same whatever the block already said. Code
// that read "east" and turned it one quarter would produce something else for
// at least one of these rows -- that is exactly what this table rules out.
func TestSetBlockDirectionIsAnAbsoluteSetNotARotation(t *testing.T) {
	// Every starting value, including the two Facing values (up, down) and the
	// nonsense one real packs have been seen to write
	// ("below"), must land on the same answer for the same direction.
	starts := []string{"north", "east", "south", "west", "up", "down", "below"}
	for _, start := range starts {
		p := NewPalette()
		id := p.Get("minecraft:amethyst_cluster", map[string]StateValue{"minecraft:block_face": start})
		got := p.Entry(p.SetBlockDirection(id, HorizontalDirectionEast)).States["minecraft:block_face"]
		if got != "east" {
			t.Errorf("starting from %q, HorizontalDirection east gave %v, want \"east\" -- "+
				"the rotation is an absolute SET and must not depend on the old value", start, got)
		}
	}

	// The same property on a numeric family, where a "rotate by one quarter"
	// reading is the most tempting: pillar_axis y is not a horizontal axis at
	// all, and the game still sets it to the direction's axis rather than
	// leaving it alone.
	p := NewPalette()
	id := p.Get("minecraft:bone_block", map[string]StateValue{"pillar_axis": "y"})
	if got := p.Entry(p.SetBlockDirection(id, HorizontalDirectionWest)).States["pillar_axis"]; got != "x" {
		t.Errorf("pillar_axis y under HorizontalDirection west = %v, want \"x\"", got)
	}
}

// TestSetBlockDirectionFiresEveryArmCumulatively is property 1: there is no
// dispatch. A block carrying two handled states gets BOTH set in one call --
// not the first one, not the last one.
func TestSetBlockDirectionFiresEveryArmCumulatively(t *testing.T) {
	p := NewPalette()
	id := p.Get("pack:weird_block", map[string]StateValue{
		"minecraft:block_face":         "up",
		"minecraft:cardinal_direction": "north",
		"pillar_axis":                  "y",
		"ground_sign_direction":        float64(7),
		"pack:not_a_direction":         float64(3),
	})
	got := p.Entry(p.SetBlockDirection(id, HorizontalDirectionSouth)).States
	want := map[string]StateValue{
		"minecraft:block_face":         "south",
		"minecraft:cardinal_direction": "south",
		"pillar_axis":                  "z",
		"ground_sign_direction":        float64(8),
		// Untouched: no arm names it, so it survives verbatim.
		"pack:not_a_direction": float64(3),
	}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("state %q = %v, want %v", k, got[k], w)
		}
	}
	if len(got) != len(want) {
		t.Errorf("transform produced %d states, want %d: %v", len(got), len(want), got)
	}
}

// TestSetBlockDirectionPassesThroughUnhandledBlocks is property 3, and it is the
// case the tool already implemented before the tables existed: a block carrying
// none of the sixteen states comes back as the IDENTICAL id -- the game
// leaves such a block untouched.
func TestSetBlockDirectionPassesThroughUnhandledBlocks(t *testing.T) {
	p := NewPalette()
	sizeBefore := p.Size()
	cases := []struct {
		name   string
		states map[string]StateValue
	}{
		{"minecraft:stone", nil},
		{"minecraft:oak_leaves", map[string]StateValue{"persistent_bit": true, "update_bit": false}},
		// "minecraft:vertical_half" was in this tool's old warning list and
		// the game's block rotation does not touch it -- one of the three corrections
		// made to that list. The other, "rotation", moved to
		// TestSetBlockDirectionGateFollowsTheTypeNotTheWrittenStates: a standing
		// banner's TYPE declares ground_sign_direction, so the block does get
		// rotated -- just never on "rotation".
		{"minecraft:oak_slab", map[string]StateValue{"minecraft:vertical_half": "top"}},
	}
	for _, c := range cases {
		id := p.Get(c.name, c.states)
		for d := HorizontalDirectionNorth; d <= HorizontalDirectionWest; d++ {
			if got := p.SetBlockDirection(id, d); got != id {
				t.Errorf("%s under HorizontalDirection %d became %v (%q), want the same id back",
					c.name, d, got, p.Entry(got).CanonicalString())
			}
		}
	}
	if p.Size() != sizeBefore+len(cases) {
		t.Errorf("pass-through interned %d new entries beyond the inputs; it must intern none",
			p.Size()-sizeBefore-len(cases))
	}
}

// TestSetBlockDirectionRailFlattensToZero pins game behaviour that looks
// like a bug and is not: rail_direction's mapping holds only HorizontalDirection 4,
// 5 and 16-23, so all four horizontal directions miss the lookup and
// set the value to 0. The state IS written
// -- so a rail placed by a
// rotating single_block_feature comes out flattened to rail_direction 0, in
// every direction. Do not "fix" this row.
func TestSetBlockDirectionRailFlattensToZero(t *testing.T) {
	for d := HorizontalDirectionNorth; d <= HorizontalDirectionWest; d++ {
		p := NewPalette()
		id := p.Get("minecraft:rail", map[string]StateValue{"rail_direction": float64(6)})
		got := p.Entry(p.SetBlockDirection(id, d)).States["rail_direction"]
		if got != float64(0) {
			t.Errorf("HorizontalDirection %d: rail_direction = %v, want 0", d, got)
		}
	}
}

// TestSetBlockDirectionEveryArmForEveryDirection is the table itself,
// transcribed independently of rotationRows so that a typo in one of them
// does not agree with a typo in the other. Rows are north/east/south/west. The
// details of each row's integer and token
// is in rotate.go's doc comment.
func TestSetBlockDirectionEveryArmForEveryDirection(t *testing.T) {
	cases := []struct {
		key  string
		want [4]StateValue
		why  string
	}{
		{"portal_axis", [4]StateValue{"z", "x", "z", "x"},
			"2/1/2/1, identical to pillar_axis's row"},
		{"minecraft:cardinal_direction", [4]StateValue{"north", "east", "south", "west"},
			"2/3/0/1 through the direction-name order, 0=south 1=west 2=north 3=east"},
		{"minecraft:facing_direction", [4]StateValue{"north", "east", "south", "west"},
			"2/5/3/4, the minecraft:-prefixed built-in"},
		{"minecraft:block_face", [4]StateValue{"north", "east", "south", "west"},
			"2/5/3/4, the state packs most commonly use"},
		{"direction", [4]StateValue{float64(2), float64(3), float64(0), float64(1)},
			"cardinal-direction values, legacy integer spelling"},
		{"facing_direction", [4]StateValue{float64(2), float64(5), float64(3), float64(4)},
			"facing-direction values, legacy integer spelling; a SEPARATE arm from minecraft:facing_direction"},
		{"rail_direction", [4]StateValue{float64(0), float64(0), float64(0), float64(0)},
			"no horizontal entry in the mapping"},
		{"torch_facing_direction", [4]StateValue{"north", "east", "south", "west"},
			"3/2/4/1 over 0=unknown 1=west 2=east 3=north 4=south 5=top"},
		{"ground_sign_direction", [4]StateValue{float64(0), float64(4), float64(8), float64(12)},
			"fixed per direction; note rotation 0 is a sign FACING south"},
		{"weirdo_direction", [4]StateValue{float64(3), float64(0), float64(2), float64(1)},
			"weirdo direction, stairs"},
		{"coral_direction", [4]StateValue{float64(2), float64(1), float64(3), float64(0)},
			"coral direction"},
		{"lever_direction", [4]StateValue{"north", "east", "south", "west"},
			"lever direction 4/1/3/2 over the eight lever forms"},
		{"pillar_axis", [4]StateValue{"z", "x", "z", "x"},
			"pillar-axis state 2/1/2/1 through the pillar-axis order 0=y 1=x 2=z"},
		{"vine_direction_bits", [4]StateValue{float64(4), float64(8), float64(1), float64(2)},
			"fixed per direction; a whole-field SET, not an OR into the existing bits"},
		{"multi_face_direction_bits", [4]StateValue{float64(16), float64(32), float64(4), float64(8)},
			"fixed per direction; matches state.go's multiface north/east/south/west bits"},
		{"orientation", [4]StateValue{"north_up", "east_up", "south_up", "west_up"},
			"orientation 10/9/11/8, the four *_up forms"},
	}
	if len(cases) != len(rotationRows) {
		t.Fatalf("this table has %d rows, rotationRows has %d -- a row was added or "+
			"removed without updating both", len(cases), len(rotationRows))
	}
	for _, c := range cases {
		for d := HorizontalDirectionNorth; d <= HorizontalDirectionWest; d++ {
			p := NewPalette()
			// Seed each arm with a value it can never legally rotate INTO, so
			// a no-op implementation cannot accidentally pass.
			id := p.Get("pack:probe", map[string]StateValue{c.key: "sentinel"})
			got := p.Entry(p.SetBlockDirection(id, d)).States[c.key]
			if got != c.want[d] {
				t.Errorf("%s under HorizontalDirection %d = %v, want %v (%s)", c.key, d, got, c.want[d], c.why)
			}
		}
	}
}

// TestSetBlockDirectionRefusesDirectionsItHasNoTableFor guards the one place this
// file deliberately departs from the game. HorizontalDirection 4-24 have real
// entries in several of these mappings and this tool models only the 0-3
// rows, so anything outside 0-3 returns the block unchanged rather than being
// answered from a guessed row. single_block_feature cannot produce one -- its
// four side attachments use 0/1/2/3 and randomize_rotation draws
// NextUnsignedInt(4) -- so nothing in this tool hits this path today. A future
// caller that can must extend the tables first.
func TestSetBlockDirectionRefusesDirectionsItHasNoTableFor(t *testing.T) {
	p := NewPalette()
	id := p.Get("minecraft:amethyst_cluster", map[string]StateValue{"minecraft:block_face": "up"})
	// 24 is the sentinel that maps Facing to "up" for this family;
	// -1 and 4 are simply outside the modelled rows.
	for _, d := range []HorizontalDirection{-1, 4, 5, 24} {
		if got := p.SetBlockDirection(id, d); got != id {
			t.Errorf("direction %d returned %q; there is no table for it and it must "+
				"return the block unchanged rather than guess", d, p.Entry(got).CanonicalString())
		}
	}
}

// TestAssumedRotationStatesNamesOnlyTheUnsettledSpellings pins what the
// load-time warning in features/single_block.go fires on. The most commonly
// used families are all known, so a pack using only those warns
// zero times; a pack that leans on, say, lever_direction is told that the
// direction is right and the spelling was assumed.
//
// Every case here names a block the state catalogue does NOT know, which is
// the fallback path: the warning is then driven by the states written on the
// block, exactly as it was before the catalogue existed. The catalogue-driven
// path is TestAssumedRotationStatesFollowsTheTypeCatalogue below.
func TestAssumedRotationStatesNamesOnlyTheUnsettledSpellings(t *testing.T) {
	confirmed := []string{
		"minecraft:block_face", "minecraft:cardinal_direction", "pillar_axis",
		"ground_sign_direction", "vine_direction_bits", "multi_face_direction_bits",
	}
	for _, key := range confirmed {
		if got := AssumedRotationStates("pack:custom", map[string]StateValue{key: "x"}); len(got) != 0 {
			t.Errorf("%s is settled end to end and must not warn; got %v", key, got)
		}
	}
	assumed := []string{
		"portal_axis", "minecraft:facing_direction", "direction", "facing_direction",
		"rail_direction", "torch_facing_direction", "weirdo_direction", "coral_direction",
		"lever_direction", "orientation",
	}
	for _, key := range assumed {
		got := AssumedRotationStates("pack:custom", map[string]StateValue{key: "x"})
		if len(got) != 1 || got[0] != key {
			t.Errorf("%s has an assumed spelling and must warn; got %v", key, got)
		}
	}
	if got := AssumedRotationStates("pack:custom", nil); got != nil {
		t.Errorf("a stateless block must produce no warning, got %v", got)
	}
	if got := AssumedRotationStates("pack:custom", map[string]StateValue{"minecraft:block_face": "up", "pack:x": float64(1)}); got != nil {
		t.Errorf("a block carrying only settled states must produce no warning, got %v", got)
	}
}

// TestSetBlockDirectionGateFollowsTheTypeNotTheWrittenStates is the arm gate's
// new contract: it asks what the block's TYPE declares, which is what the
// game asks, instead of what the pack happened to write. Each row here is a
// case where those two answers differ, so each one would have come out the
// other way before block/vanilla_states.go existed.
func TestSetBlockDirectionGateFollowsTheTypeNotTheWrittenStates(t *testing.T) {
	cases := []struct {
		what   string
		name   string
		states map[string]StateValue
		want   map[string]StateValue // states expected after HorizontalDirectionEast
	}{
		{
			// The case the old stand-in was documented as getting wrong: a
			// bare name, no states, a type that declares a rotated one.
			what:   "a bare torch is rotated on the state its type declares",
			name:   "minecraft:torch",
			states: nil,
			want:   map[string]StateValue{"torch_facing_direction": "east"},
		},
		{
			// A banner's type declares ground_sign_direction; "rotation" is
			// not an arm and must survive untouched beside it.
			what:   "a banner is rotated on ground_sign_direction, never on rotation",
			name:   "minecraft:standing_banner",
			states: map[string]StateValue{"rotation": float64(5)},
			want:   map[string]StateValue{"rotation": float64(5), "ground_sign_direction": float64(4)},
		},
		{
			// The other direction: a state a pack writes onto a type that
			// cannot carry it is not a state the game would rotate.
			what:   "a state written on a type that does not declare it is left alone",
			name:   "minecraft:stone",
			states: map[string]StateValue{"direction": float64(3)},
			want:   map[string]StateValue{"direction": float64(3)},
		},
		{
			// A lantern's type declares only `hanging`, which is not an arm,
			// so writing a block_face on one does not make it rotate.
			what:   "a lantern does not rotate -- its type has no rotated state",
			name:   "minecraft:lantern",
			states: map[string]StateValue{"minecraft:block_face": "up"},
			want:   map[string]StateValue{"minecraft:block_face": "up"},
		},
		{
			// A block the catalogue knows nothing about keeps the old
			// stand-in exactly: the written states are the gate.
			what:   "a pack's own block still rotates on what it was written with",
			name:   "pack:custom_lamp",
			states: map[string]StateValue{"minecraft:block_face": "up"},
			want:   map[string]StateValue{"minecraft:block_face": "east"},
		},
	}
	for _, c := range cases {
		p := NewPalette()
		got := p.Entry(p.SetBlockDirection(p.Get(c.name, c.states), HorizontalDirectionEast)).States
		for key, want := range c.want {
			if got[key] != want {
				t.Errorf("%s: %s %s = %v, want %v", c.what, c.name, key, got[key], want)
			}
		}
		if len(got) != len(c.want) {
			t.Errorf("%s: %s ended with states %v, want exactly %v", c.what, c.name, got, c.want)
		}
	}
}

// TestAssumedRotationStatesFollowsTheTypeCatalogue is the load-time warning
// following the gate: a bare torch IS rotated on an inferred spelling, so the
// pack that placed it has to be told, even though it wrote no states at all.
func TestAssumedRotationStatesFollowsTheTypeCatalogue(t *testing.T) {
	if got := AssumedRotationStates("minecraft:torch", nil); len(got) != 1 || got[0] != "torch_facing_direction" {
		t.Errorf("a bare torch is rotated on an assumed spelling and must warn; got %v", got)
	}
	// A chest is rotated too, but on minecraft:cardinal_direction, whose
	// spelling is known end to end -- no warning.
	if got := AssumedRotationStates("minecraft:chest", nil); got != nil {
		t.Errorf("a chest rotates on a settled spelling and must not warn; got %v", got)
	}
	if got := AssumedRotationStates("minecraft:stone", map[string]StateValue{"direction": float64(1)}); got != nil {
		t.Errorf("stone declares no rotated state, so nothing about it is assumed; got %v", got)
	}
}
