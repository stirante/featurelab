// alias_postsplit_test.go pins what a PRE-FLATTENING block name means when it
// is written with no states.
//
// `minecraft:log` does not name a block any more -- the game split it into
// oak_log, spruce_log, birch_log and jungle_log, and the old name survives only
// as an alias. Written WITH its discriminator (`old_log_type: oak`) the alias
// picks one target and the descriptor becomes that block. Written WITHOUT one
// there is nothing to pick, and this port used to leave the name literal, so it
// matched no block at all.
//
// The engine does not need the discriminator for this. It keeps the list of
// types the name was split into and accepts any of them -- but only where the
// comparison is the descriptor-level one. The type-only and exact comparisons
// resolve such a descriptor down to a single concrete block instead and never
// consult the list, which is why the expansion here is gated on MatchPartial.
package block

import "testing"

func matchSetOf(t *testing.T, p *Palette, names ...string) MatchSet {
	t.Helper()
	descs := make([]Descriptor, 0, len(names))
	for _, n := range names {
		descs = append(descs, Descriptor{Name: n})
	}
	return p.NewMatchSet(descs, nil, nil, nil)
}

func TestBareLegacyNameMatchesEveryBlockItWasSplitInto(t *testing.T) {
	p := NewPalette()
	set := matchSetOf(t, p, "minecraft:log")

	for _, name := range []string{
		"minecraft:oak_log", "minecraft:spruce_log",
		"minecraft:birch_log", "minecraft:jungle_log",
	} {
		if !set.Contains(p.Get(name, nil)) {
			t.Errorf("a bare minecraft:log descriptor did not match %s, which is one of the "+
				"types that name was split into", name)
		}
	}
}

func TestBareLegacyNameDoesNotMatchUnrelatedBlocks(t *testing.T) {
	p := NewPalette()
	set := matchSetOf(t, p, "minecraft:log")

	for _, name := range []string{
		"minecraft:stone",
		"minecraft:oak_leaves",
		// log2's targets are a different alias's split list.
		"minecraft:acacia_log",
		"minecraft:dark_oak_log",
	} {
		if set.Contains(p.Get(name, nil)) {
			t.Errorf("a bare minecraft:log descriptor matched %s, which it was not split into", name)
		}
	}
}

func TestBareLegacyLeavesNameMatchesItsOwnSplitsOnly(t *testing.T) {
	p := NewPalette()
	set := matchSetOf(t, p, "minecraft:leaves")

	if !set.Contains(p.Get("minecraft:birch_leaves", nil)) {
		t.Error("a bare minecraft:leaves descriptor did not match minecraft:birch_leaves")
	}
	if set.Contains(p.Get("minecraft:acacia_leaves", nil)) {
		t.Error("a bare minecraft:leaves descriptor matched minecraft:acacia_leaves, which belongs " +
			"to leaves2")
	}
}

// The split list carries no states, so a split block matches whatever states it
// happens to carry -- the comparison is by name.
func TestBareLegacyNameIgnoresTheSplitBlocksStates(t *testing.T) {
	p := NewPalette()
	set := matchSetOf(t, p, "minecraft:leaves")

	stated := p.Get("minecraft:oak_leaves", map[string]StateValue{
		"update_bit": true, "persistent_bit": true,
	})
	if !set.Contains(stated) {
		t.Error("a bare minecraft:leaves descriptor did not match oak_leaves carrying states; " +
			"a bare name is every state at every value")
	}
}

// The gate. Ore's replace_rules and allowed_surface_blocks resolve a descriptor
// to one concrete block and compare that; they never consult the post-split
// list. Expanding there would be inventing behaviour the engine does not have.
func TestPostSplitExpansionIsPartialModeOnly(t *testing.T) {
	p := NewPalette()
	oak := p.Get("minecraft:oak_log", nil)

	if !matchSetOf(t, p, "minecraft:log").Contains(oak) {
		t.Fatal("precondition failed: MatchPartial should expand")
	}
	for _, mode := range []struct {
		name string
		mode MatchMode
	}{{"MatchType", MatchType}, {"MatchExact", MatchExact}} {
		set := matchSetOf(t, p, "minecraft:log").WithMode(mode.mode)
		if set.Contains(oak) {
			t.Errorf("%s expanded a bare legacy name to its post-split types; only the "+
				"descriptor-level comparison does that", mode.name)
		}
	}
}

// A name that is not an alias must not gain an expansion, and the descriptor
// spelled WITH its discriminator must keep working the way it already did:
// the alias spends the discriminator and the descriptor becomes one block.
func TestNonAliasAndDiscriminatedFormsAreUnchanged(t *testing.T) {
	p := NewPalette()

	plain := matchSetOf(t, p, "minecraft:stone")
	if plain.Contains(p.Get("minecraft:oak_log", nil)) {
		t.Error("a bare minecraft:stone descriptor matched an unrelated block")
	}

	picked := p.NewMatchSet([]Descriptor{{
		Name:   "minecraft:log",
		States: map[string]StateValue{"old_log_type": "spruce"},
	}}, nil, nil, nil)
	if !picked.Contains(p.Get("minecraft:spruce_log", nil)) {
		t.Error("minecraft:log with old_log_type=spruce did not match minecraft:spruce_log")
	}
	if picked.Contains(p.Get("minecraft:oak_log", nil)) {
		t.Error("minecraft:log with old_log_type=spruce matched minecraft:oak_log; the " +
			"discriminator picks ONE target, it does not expand to all of them")
	}
}
