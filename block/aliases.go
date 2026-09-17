package block

import (
	"sort"
	"strings"
)

// Bedrock resolves block-descriptor names through block aliases. There are two
// relevant forms: direct name aliases, and state-dependent flattening aliases.
// Keep the two forms separate here as the game does.
//
// This table intentionally contains only direct aliases whose exact target is
// confirmed. State-dependent tree aliases live below.
var simpleBlockAliases = map[string]string{
	"minecraft:grass": "minecraft:grass_block",
}

type treeComplexAlias struct {
	discriminator string
	targets       map[string]string
}

// These are the legacy aggregate block aliases used by the shipped vanilla
// tree definitions. Their discriminator states select the flattened block
// type; the discriminator itself is consumed by the alias and is not a state
// on the resulting block.
var treeComplexAliases = map[string]treeComplexAlias{
	"minecraft:log": {
		discriminator: "old_log_type",
		targets: map[string]string{
			"oak": "minecraft:oak_log", "spruce": "minecraft:spruce_log",
			"birch": "minecraft:birch_log", "jungle": "minecraft:jungle_log",
		},
	},
	"minecraft:log2": {
		discriminator: "new_log_type",
		targets: map[string]string{
			"acacia": "minecraft:acacia_log", "dark_oak": "minecraft:dark_oak_log",
		},
	},
	"minecraft:leaves": {
		discriminator: "old_leaf_type",
		targets: map[string]string{
			"oak": "minecraft:oak_leaves", "spruce": "minecraft:spruce_leaves",
			"birch": "minecraft:birch_leaves", "jungle": "minecraft:jungle_leaves",
		},
	},
	"minecraft:leaves2": {
		discriminator: "new_leaf_type",
		targets: map[string]string{
			"acacia": "minecraft:acacia_leaves", "dark_oak": "minecraft:dark_oak_leaves",
		},
	},
}

// complexAliasPostSplitNames returns every block type a pre-flattening name was
// split into. The game keeps this list beside the alias itself and consults
// it when a descriptor carrying only the old name is compared against a block:
// any of the split types satisfies it.
//
// This is NOT the same question as resolveBlockAlias's. That one asks "which
// single block does this descriptor name", needs the discriminator to answer,
// and reports unresolved without one. This one asks "which blocks did this name
// become", which the discriminator has nothing to do with.
func complexAliasPostSplitNames(name string) ([]string, bool) {
	alias, ok := treeComplexAliases[canonicalName(name)]
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(alias.targets))
	for _, target := range alias.targets {
		out = append(out, target)
	}
	sort.Strings(out)
	return out, true
}

// resolveBlockAlias mirrors the game's block alias lookup for the confirmed
// aliases above. It returns unresolved=true only when a known complex alias was
// supplied without a confirmed discriminator value; callers retain the
// original descriptor and record it rather than guessing a target.
func resolveBlockAlias(name string, states map[string]StateValue) (resolvedName string, resolvedStates map[string]StateValue, unresolved bool) {
	canonical := canonicalName(name)
	if target, ok := simpleBlockAliases[canonical]; ok {
		return target, states, false
	}

	alias, ok := treeComplexAliases[canonical]
	if !ok {
		return canonical, states, false
	}
	value, ok := states[alias.discriminator].(string)
	if !ok {
		return canonical, states, true
	}
	target, ok := alias.targets[strings.ToLower(value)]
	if !ok {
		return canonical, states, true
	}

	if len(states) == 1 {
		return target, nil, false
	}
	remaining := make(map[string]StateValue, len(states)-1)
	for key, stateValue := range states {
		if key != alias.discriminator {
			remaining[key] = stateValue
		}
	}
	if len(remaining) == 0 {
		remaining = nil
	}
	return target, remaining, false
}
