// multiblock.go — the pack's own per-block `minecraft:multi_block` block-trait index, built by
// the SAME LoadBlockTags walk (tags.go) that already builds the tag and placement_filter
// indexes. Bedrock 1.26.50; this trait and everything consuming it are new in that version
// (absent from 1.26.40 entirely).
//
// What the trait does in the game:
//
//   - When the multi-block trait is applied to a block type and its enabled flag is set, it
//     adds the built-in multi-block-part state — the block state whose JSON key is
//     "minecraft:multi_block_part" — with exactly partCount legal values, and then adds the
//     multi-block component carrying the part count, the direction and the placement-direction
//     behavior. When the flag is NOT set it only content-logs "Block trait '%s' should enable
//     state '%s' to work properly" and adds nothing.
//   - The multi-block component holds the direction (a Facing index), the part count, and the
//     placement-direction behavior.
//   - This trait is the ONLY source of a multi-block component in the whole game: no vanilla
//     block has one. A multi-block is therefore always a pack-defined custom block carrying this
//     trait, which is why the pack's blocks/**/*.json is the right (and complete) data source
//     for this index.
//
// JSON surface:
//
//		description.traits."minecraft:multi_block": {
//		  "enabled_states": ["minecraft:multi_block_part"],   // required, EXACTLY this one entry
//		  "parts": 2..4,                                      // default 2 (min 2, max 4)
//		  "direction": "up"                                   // default "up";
//		                                                      //  any Facing name, lowercased
//		}
//
//	  - enabled_states: a list whose size is not 1 -> content-log '"minecraft:multi_block" trait
//	    requires exactly one 'enabled_state' to be specified.' and the flag stays 0; a single
//	    entry that is not exactly the multi-block-part state's own name
//	    ("minecraft:multi_block_part") -> content-log 'Invalid state option "%s" for
//	    "minecraft:multi_block" trait.' and the flag stays 0; the exact match sets the flag.
//	  - direction: the string is lowercased and looked up among the Facing names; a miss
//	    content-logs "Invalid value for 'direction': %s" AND CLEARS the trait's enabled flag —
//	    an invalid direction disables the whole trait, it does not fall back to "up".
//	  - "place_behavior"/"part_count" are NOT JSON keys in this version. A JSON-defined block
//	    always gets placement-direction behavior 0, so its part direction never follows its
//	    cardinal_direction state — it is always the trait's fixed `direction`. (Behavior 1 would
//	    read the block's cardinal_direction state; it is unreachable from pack JSON.)
//
// parts out of [2,4] is a schema constraint violation; exactly what the game does with a
// violated constraint is NOT known, so this port takes the conservative reading — diagnostic +
// trait disabled — rather than clamping to a value the author never wrote. Disclosed in the wiki
// page as an approximation.
//
// Facing values (Down=0, Up=1, North=2, South=3, West=4, East=5) match the per-face offset
// table ((0,-1,0),(0,1,0),(0,0,-1),(0,0,1),(-1,0,0),(1,0,0)) and this codebase's established
// convention; the NAME strings are the standard lowercase spellings (INFERRED from the
// case-insensitive lookup plus the game's own block examples using "up" and "west").
package block

import "fmt"

// Facing indices, this codebase's established convention (see e.g. features/multiface.go).
const (
	FacingDown = iota
	FacingUp
	FacingNorth
	FacingSouth
	FacingWest
	FacingEast
)

// FacingOffset is the per-face offset table — the (dx,dy,dz) step for each Facing index.
// Exposed so a consumer stepping "one block along the trait's direction" uses this one table
// rather than a re-derived one.
var FacingOffset = [6][3]int{
	{0, -1, 0}, // Down
	{0, 1, 0},  // Up
	{0, 0, -1}, // North
	{0, 0, 1},  // South
	{-1, 0, 0}, // West
	{1, 0, 0},  // East
}

// facingByName is the Facing name-to-index table as used for the trait's direction
// (lowercased before lookup — this port lowercases at the parse site instead of accepting
// mixed case here, same observable result for the same input).
var facingByName = map[string]int{
	"down":  FacingDown,
	"up":    FacingUp,
	"north": FacingNorth,
	"south": FacingSouth,
	"west":  FacingWest,
	"east":  FacingEast,
}

// MultiBlockPartState is the JSON key of the block state the trait adds to the block type
// — the built-in multi-block-part state, name "minecraft:multi_block_part" (the trait's own
// enabled_states validation compares against exactly this, and the game's own block examples
// write it verbatim). Values are 0..parts-1; 0 is the starting part.
const MultiBlockPartState = "minecraft:multi_block_part"

// CardinalDirectionState is the built-in cardinal-direction state's JSON key — the state the
// minecraft:placement_direction trait can enable, and the one minecraft:multi_block_feature's
// randomize_rotation rewrites.
const CardinalDirectionState = "minecraft:cardinal_direction"

// multiBlockTraitEntry is one block's parsed minecraft:multi_block declaration.
type multiBlockTraitEntry struct {
	// enabled mirrors the trait's own enabled flag: the trait was declared AND its
	// enabled_states/direction/parts all validated. A declared-but-invalid trait leaves this
	// false, matching the game's "warn and add nothing" path.
	enabled   bool
	parts     int
	direction int // Facing index
	// hasCardinal is whether this block's minecraft:placement_direction trait enables the
	// minecraft:cardinal_direction state — the block type's state-presence query stand-in
	// multi_block_feature's randomize_rotation validation needs. Tracked even when the
	// multi_block trait itself is absent/invalid (it is a property of the block, not of this
	// trait), but only ever consulted for enabled multi-blocks today.
	hasCardinal bool
}

// blockMultiBlockData is the pack's own per-block multi_block trait index.
type blockMultiBlockData struct {
	byBlock map[string]multiBlockTraitEntry
}

// parseMultiBlockTraitEntry parses one block file's own description.traits into an entry.
// Called by LoadBlockTags's per-file walk; like the tag and placement_filter entries, a later
// file for the same block id entirely REPLACES an earlier one's entry.
//
// Diagnostics are worded to match the game's own content-log lines (cited in this file's
// header) so an author sees the same complaint here they would see in the game's content log.
func parseMultiBlockTraitEntry(desc map[string]any, fileID string) (multiBlockTraitEntry, []Diagnostic) {
	var entry multiBlockTraitEntry
	var diags []Diagnostic
	traits, _ := desc["traits"].(map[string]any)
	if traits == nil {
		return entry, nil
	}

	// minecraft:placement_direction — only mined for whether it enables cardinal_direction.
	if pd, ok := traits["minecraft:placement_direction"].(map[string]any); ok {
		if es, ok := pd["enabled_states"].([]any); ok {
			for _, s := range es {
				if s == CardinalDirectionState {
					entry.hasCardinal = true
				}
			}
		}
	}

	raw, ok := traits["minecraft:multi_block"].(map[string]any)
	if !ok {
		return entry, nil
	}

	warn := func(msg string) {
		diags = append(diags, Diagnostic{Level: "warning", FileID: fileID, Message: msg})
	}

	// enabled_states — required, exactly ["minecraft:multi_block_part"].
	es, _ := raw["enabled_states"].([]any)
	if len(es) != 1 {
		warn(`"minecraft:multi_block" trait requires exactly one 'enabled_state' to be specified.`)
		return entry, diags
	}
	if s, _ := es[0].(string); s != MultiBlockPartState {
		warn(fmt.Sprintf(`Invalid state option %q for "minecraft:multi_block" trait.`, es[0]))
		return entry, diags
	}

	// parts — default 2, schema range [2,4].
	parts := 2
	if pv, present := raw["parts"]; present {
		f, ok := pv.(float64)
		if !ok || f != float64(int(f)) || int(f) < 2 || int(f) > 4 {
			warn(fmt.Sprintf("minecraft:multi_block.parts must be an integer in [2, 4], got %v -- the trait was ignored", pv))
			return entry, diags
		}
		parts = int(f)
	}

	// direction — default "up"; an invalid value disables the trait (the game clears the
	// enabled flag), it does NOT fall back to the default.
	direction := FacingUp
	if dv, present := raw["direction"]; present {
		s, ok := dv.(string)
		if ok {
			d, found := facingByName[lowerASCII(s)]
			if found {
				direction = d
			} else {
				ok = false
			}
		}
		if !ok {
			warn(fmt.Sprintf("Invalid value for 'direction': %v", dv))
			return entry, diags
		}
	}

	entry.enabled = true
	entry.parts = parts
	entry.direction = direction
	return entry, diags
}

// lowerASCII lowercases A-Z only — the observable behavior of the game's lowercasing for
// the facing names that can ever match (all ASCII).
func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

// MultiBlockTrait reports the enabled minecraft:multi_block trait on the named block (canonical,
// minecraft:-prefixed where the source had no namespace): its part count (2..4) and the Facing
// index parts extend along. ok is false when no blocks were loaded, the block is unknown, or its
// trait was absent or invalid — all of which the game treats identically for placement
// purposes (no multi-block component on the type).
func (p *Palette) MultiBlockTrait(name string) (parts, direction int, ok bool) {
	if p.multiBlockData == nil {
		return 0, 0, false
	}
	e, found := p.multiBlockData.byBlock[name]
	if !found || !e.enabled {
		return 0, 0, false
	}
	return e.parts, e.direction, true
}

// HasCardinalDirectionState reports whether the named block's own minecraft:placement_direction
// trait enables the minecraft:cardinal_direction state — the stand-in for the block type's
// state-presence query on pack-defined blocks. Vanilla blocks that carry the state
// natively are not modeled here; the one consumer (multi_block_feature's randomize_rotation)
// can only ever ask about trait-defined custom blocks, which get the state exclusively through
// this trait.
func (p *Palette) HasCardinalDirectionState(name string) bool {
	if p.multiBlockData == nil {
		return false
	}
	return p.multiBlockData.byBlock[name].hasCardinal
}
