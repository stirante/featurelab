// single_block_allowlist_bits_test.go pins one detail of the engine's shared
// placement allow-list check that this port did not model: before comparing a
// world block against a may_replace / may_attach_to descriptor, the engine
// forces that block's update_bit and persistent_bit to 0.
//
// It only shows up on leaves, which are the blocks that carry those two states
// -- and leaves are exactly what a may_replace list names when a feature is
// meant to grow through a canopy. The consequence runs in BOTH directions, and
// the second one is the counter-intuitive half:
//
//   - a descriptor written with update_bit=false matches a world block whose
//     update_bit is 1, because the block's bit is cleared first;
//   - a descriptor written with update_bit=TRUE therefore matches NOTHING,
//     because no block still has the bit set by the time the comparison runs.
//
// The same normalization already exists in this port for the tree feature's
// radial block-group write (features/tree.go's normalizeForMayReplace). It was
// missing from single_block_feature, whose may_replace and may_attach_to both
// go through the same shared check in the game.
package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/wgen"
)

// leavesWith returns oak_leaves carrying the two bits at the given values.
func leavesWith(pal *block.Palette, update, persistent bool) block.ID {
	return pal.Get("minecraft:oak_leaves", map[string]block.StateValue{
		"update_bit":     update,
		"persistent_bit": persistent,
	})
}

// sbWithMayReplace builds a single_block_feature whose may_replace is a single
// {name, states} descriptor.
func sbWithMayReplace(t *testing.T, pal *block.Palette, states map[string]any) *SingleBlockFeature {
	t.Helper()
	f := buildSB(t, pal, map[string]any{
		"places_block": "minecraft:stone",
		"may_replace": []any{
			map[string]any{"name": "minecraft:oak_leaves", "states": states},
		},
	})
	sb, ok := f.(*SingleBlockFeature)
	if !ok {
		t.Fatalf("buildSB returned %T, want *SingleBlockFeature", f)
	}
	return sb
}

func TestSingleBlock_AllowListClearsUpdateBitOnTheWorldBlock(t *testing.T) {
	pal := block.NewPalette()
	v := sbVolume(pal)
	pos := wgen.BlockPos{}

	// The world block has the bit SET -- which is what freshly written tree
	// leaves look like before the block tick clears it.
	v.SetBlock(pos, leavesWith(pal, true, false))

	sb := sbWithMayReplace(t, pal, map[string]any{"update_bit": false})
	if !sb.passesAllowList(v, pos) {
		t.Error("may_replace{update_bit:false} did not match a world block with update_bit=1; " +
			"the engine clears that bit on the world block before comparing, so this should match")
	}
}

func TestSingleBlock_AllowListClearsPersistentBitOnTheWorldBlock(t *testing.T) {
	pal := block.NewPalette()
	v := sbVolume(pal)
	pos := wgen.BlockPos{}

	v.SetBlock(pos, leavesWith(pal, false, true))

	sb := sbWithMayReplace(t, pal, map[string]any{"persistent_bit": false})
	if !sb.passesAllowList(v, pos) {
		t.Error("may_replace{persistent_bit:false} did not match a world block with persistent_bit=1; " +
			"the engine clears that bit on the world block before comparing, so this should match")
	}
}

// The half that reads like a bug and is not. Because the normalization happens
// to the WORLD block and not to the descriptor, a descriptor that asks for the
// bit to be SET can never be satisfied -- there is no block left with it set.
// An author who writes it gets a may_replace list that silently matches
// nothing, which is worth a tool being able to tell them.
func TestSingleBlock_AllowListCannotMatchAnAskedForSetBit(t *testing.T) {
	pal := block.NewPalette()
	v := sbVolume(pal)
	pos := wgen.BlockPos{}

	v.SetBlock(pos, leavesWith(pal, true, false))

	sb := sbWithMayReplace(t, pal, map[string]any{"update_bit": true})
	if sb.passesAllowList(v, pos) {
		t.Error("may_replace{update_bit:true} matched, but the engine clears update_bit on the " +
			"world block first, so nothing can still have it set at comparison time")
	}
}

// A descriptor naming states the normalization does not touch must keep
// working exactly as before -- the fix must not become a blanket state-stripper.
func TestSingleBlock_AllowListLeavesOtherStatesAlone(t *testing.T) {
	pal := block.NewPalette()
	v := sbVolume(pal)
	pos := wgen.BlockPos{}

	// A stated block whose state is neither of the two bits.
	v.SetBlock(pos, pal.Get("minecraft:oak_log", map[string]block.StateValue{"pillar_axis": "y"}))

	f := buildSB(t, pal, map[string]any{
		"places_block": "minecraft:stone",
		"may_replace": []any{
			map[string]any{"name": "minecraft:oak_log", "states": map[string]any{"pillar_axis": "x"}},
		},
	})
	sb := f.(*SingleBlockFeature)
	if sb.passesAllowList(v, pos) {
		t.Error("may_replace{pillar_axis:x} matched a block with pillar_axis=y; " +
			"only update_bit and persistent_bit are normalized")
	}
}
