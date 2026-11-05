package jigsaw

import (
	"testing"

	"github.com/stirante/featurelab/block"
)

func TestTerrainMatchingFollowsTheHeightmap(t *testing.T) {
	world := [3]int{3, 90, 4}
	ctx := &processorContext{local: [3]int{0, 2, 0}, heightAt: func(x, z int) int { return x + z + 60 }}
	if _, kept := terrainMatching(1, &world, ctx); !kept {
		t.Fatal("the block must stay")
	}
	if want := 3 + 4 + 60 - 1 + 2; world[1] != want {
		t.Errorf("y = %d, want %d", world[1], want)
	}
}

func TestParseFinalState(t *testing.T) {
	cases := map[string]struct {
		name   string
		states map[string]block.StateValue
	}{
		"":                              {name: blockAir},
		"stone":                         {name: "minecraft:stone"},
		"minecraft:stone":               {name: "minecraft:stone"},
		"minecraft:stone[]":             {name: "minecraft:stone"},
		`minecraft:wool["color"="red"]`: {name: "minecraft:wool", states: map[string]block.StateValue{"color": "red"}},
	}
	for text, want := range cases {
		got := parseFinalState(text)
		if got.Name != want.name {
			t.Errorf("%q: name %q, want %q", text, got.Name, want.name)
		}
		for key, value := range want.states {
			if got.States[key] != value {
				t.Errorf("%q: state %s = %v, want %v", text, key, got.States[key], value)
			}
		}
	}
}

func TestLerpHelpers(t *testing.T) {
	if got := clampedLerp(0, 1, -1); got != 0 {
		t.Errorf("below the range = %v", got)
	}
	if got := clampedLerp(0, 1, 2); got != 1 {
		t.Errorf("above the range = %v", got)
	}
	if got := clampedLerp(0, 2, 0.5); got != 1 {
		t.Errorf("middle = %v", got)
	}
	if got := inverseLerp(5, 0, 10); got != 0.5 {
		t.Errorf("inverseLerp = %v", got)
	}
}

func TestStatesMatchComparesTheNamedStates(t *testing.T) {
	palette := block.NewPalette()
	id := palette.Resolve(block.Descriptor{Name: "minecraft:wool", States: map[string]block.StateValue{"color": "red"}})
	if !statesMatch(id, block.Descriptor{Name: "minecraft:wool"}, palette) {
		t.Error("no states named: the name decides")
	}
	if !statesMatch(id, block.Descriptor{Name: "minecraft:wool", States: map[string]block.StateValue{"color": "red"}}, palette) {
		t.Error("the same state must match")
	}
	if statesMatch(id, block.Descriptor{Name: "minecraft:wool", States: map[string]block.StateValue{"color": "blue"}}, palette) {
		t.Error("another state must not match")
	}
	if statesMatch(id, block.Descriptor{Name: "minecraft:stone"}, palette) {
		t.Error("another block must not match")
	}
}

func TestParseStateLiteral(t *testing.T) {
	cases := map[string]block.StateValue{`"red"`: "red", "3": float64(3), "true": float64(1), "false": float64(0), "word": "word"}
	for text, want := range cases {
		if got := parseStateLiteral(text); got != want {
			t.Errorf("%q = %v, want %v", text, got, want)
		}
	}
}

func TestParseDescriptorWithStates(t *testing.T) {
	desc, err := parseDescriptor(map[string]any{"name": "wool", "states": map[string]any{"color": "red"}})
	if err != nil {
		t.Fatal(err)
	}
	if desc.Name != "minecraft:wool" || desc.States["color"] != "red" {
		t.Errorf("descriptor %+v", desc)
	}
}

func TestConnectorReadsTheOldKeys(t *testing.T) {
	c, err := parseConnector(map[string]any{"attachement_type": "n", "pool": "p", "target": "t", "joint": "aligned", "placement_priority": float64(4), "selection_priority": float64(2)},
		map[string]block.StateValue{"facing_direction": float64(1), "rotation": float64(3)})
	if err != nil {
		t.Fatal(err)
	}
	if c.name != "n" || c.pool != "p" || c.target != "t" || !c.aligned || c.placementPriority != 4 || c.selectionPriority != 2 || c.facing != 1 || c.top != 3 {
		t.Errorf("connector %+v", c)
	}
}
