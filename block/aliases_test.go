package block

import "testing"

func TestPaletteResolvesConfirmedVanillaBlockAliases(t *testing.T) {
	tests := []struct {
		name       string
		states     map[string]StateValue
		wantName   string
		wantStates map[string]StateValue
	}{
		{name: "minecraft:grass", wantName: "minecraft:grass_block"},
		{name: "minecraft:log", states: map[string]StateValue{"old_log_type": "oak"}, wantName: "minecraft:oak_log"},
		{name: "minecraft:log", states: map[string]StateValue{"old_log_type": "spruce"}, wantName: "minecraft:spruce_log"},
		{name: "minecraft:log", states: map[string]StateValue{"old_log_type": "birch"}, wantName: "minecraft:birch_log"},
		{name: "minecraft:log", states: map[string]StateValue{"old_log_type": "jungle"}, wantName: "minecraft:jungle_log"},
		{name: "minecraft:log2", states: map[string]StateValue{"new_log_type": "acacia"}, wantName: "minecraft:acacia_log"},
		{name: "minecraft:log2", states: map[string]StateValue{"new_log_type": "dark_oak"}, wantName: "minecraft:dark_oak_log"},
		{name: "minecraft:leaves", states: map[string]StateValue{"old_leaf_type": "oak"}, wantName: "minecraft:oak_leaves"},
		{name: "minecraft:leaves", states: map[string]StateValue{"old_leaf_type": "spruce"}, wantName: "minecraft:spruce_leaves"},
		{name: "minecraft:leaves", states: map[string]StateValue{"old_leaf_type": "birch"}, wantName: "minecraft:birch_leaves"},
		{name: "minecraft:leaves", states: map[string]StateValue{"old_leaf_type": "jungle"}, wantName: "minecraft:jungle_leaves"},
		{name: "minecraft:leaves2", states: map[string]StateValue{"new_leaf_type": "acacia"}, wantName: "minecraft:acacia_leaves"},
		{name: "minecraft:leaves2", states: map[string]StateValue{"new_leaf_type": "dark_oak"}, wantName: "minecraft:dark_oak_leaves"},
	}

	for _, test := range tests {
		t.Run(test.name+CanonicalKey("", test.states), func(t *testing.T) {
			palette := NewPalette()
			entry := palette.Entry(palette.Get(test.name, test.states))
			if entry.Name != test.wantName {
				t.Fatalf("resolved name = %q, want %q", entry.Name, test.wantName)
			}
			if got := stateKey(entry.States); got != stateKey(test.wantStates) {
				t.Fatalf("resolved states = %q, want %q", got, stateKey(test.wantStates))
			}
		})
	}
}

func TestPaletteKnownComplexAliasDoesNotGuessUnknownState(t *testing.T) {
	palette := NewPalette()
	states := map[string]StateValue{"old_log_type": "unconfirmed_wood"}
	entry := palette.Entry(palette.Get("minecraft:log", states))
	if entry.Name != "minecraft:log" {
		t.Fatalf("unknown alias resolved to %q; want original minecraft:log", entry.Name)
	}
	want := "minecraft:log#old_log_type=unconfirmed_wood"
	list := palette.UnresolvedAliasList()
	if len(list) != 1 || list[0] != want {
		t.Fatalf("UnresolvedAliasList = %v, want [%s]", list, want)
	}
}
