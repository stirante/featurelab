package jigsaw

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
)

const (
	blockStructureBlock = "minecraft:structure_block"
	blockJigsaw         = "minecraft:jigsaw"
	blockStructureVoid  = "minecraft:structure_void"
	blockAir            = "minecraft:air"
)

var processorParsers map[string]func(l *Library, raw map[string]any, listID string) (processor, error)

func init() {
	processorParsers = map[string]func(l *Library, raw map[string]any, listID string) (processor, error){
		"minecraft:block_ignore":     parseBlockIgnore,
		"minecraft:rule":             parseRuleProcessor,
		"minecraft:protected_blocks": parseProtectedBlocks,
		"minecraft:capped":           parseCapped,
	}
}

func (l *Library) parseProcessor(raw map[string]any, listID string) (processor, error) {
	processorType, _ := raw["processor_type"].(string)
	parse, ok := processorParsers[processorType]
	if !ok {
		return nil, fmt.Errorf("unknown processor_type %q", processorType)
	}
	return parse(l, raw, listID)
}

func parseBlockIgnore(l *Library, raw map[string]any, _ string) (processor, error) {
	list, ok := raw["blocks"].([]any)
	if !ok {
		return nil, fmt.Errorf("blocks must be a list")
	}
	names := make(map[string]bool, len(list))
	for i, entry := range list {
		desc, err := parseDescriptor(entry)
		if err != nil {
			return nil, fmt.Errorf("blocks[%d]: %w", i, err)
		}
		names[desc.Name] = true
	}
	return func(id block.ID, _ *[3]int, ctx *processorContext) (block.ID, bool) {
		return id, !names[ctx.palette.NameOf(id)]
	}, nil
}

func parseProtectedBlocks(_ *Library, raw map[string]any, _ string) (processor, error) {
	tag, ok := raw["value"].(string)
	if !ok {
		return nil, fmt.Errorf("value must name a block tag")
	}
	return func(id block.ID, world *[3]int, ctx *processorContext) (block.ID, bool) {
		return id, !ctx.palette.BlockHasTag(ctx.worldBlockAt(*world), tag)
	}, nil
}

func parseCapped(l *Library, raw map[string]any, listID string) (processor, error) {
	delegate, ok := raw["delegate"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("delegate must be a processor object")
	}
	inner, err := l.parseProcessor(delegate, listID)
	if err != nil {
		return nil, fmt.Errorf("delegate: %w", err)
	}
	l.unmodelled[listID] = append(l.unmodelled[listID], "minecraft:capped has no limit here: its delegate runs on every block")
	return inner, nil
}

func parseRuleProcessor(l *Library, raw map[string]any, _ string) (processor, error) {
	list, ok := raw["rules"].([]any)
	if !ok {
		return nil, fmt.Errorf("rules must be a list")
	}
	rules := make([]rule, 0, len(list))
	for i, entry := range list {
		object, ok := entry.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("rules[%d] is not an object", i)
		}
		built, err := parseRule(object)
		if err != nil {
			return nil, fmt.Errorf("rules[%d]: %w", i, err)
		}
		rules = append(rules, built)
	}
	return func(id block.ID, world *[3]int, ctx *processorContext) (block.ID, bool) {
		rng := newJavaRandom(blockPosSeed(world[0], world[1], world[2]))
		worldBlock := ctx.worldBlockAt(*world)
		for _, r := range rules {
			if r.input(id, ctx.palette, rng) && r.location(worldBlock, ctx.palette, rng) && r.position(*world, ctx.pivot, rng) {
				return ctx.palette.Resolve(r.output), true
			}
		}
		return id, true
	}, nil
}

func parseRule(raw map[string]any) (rule, error) {
	var r rule
	var err error
	if r.input, err = parsePredicate(raw["input_predicate"]); err != nil {
		return r, fmt.Errorf("input_predicate: %w", err)
	}
	if r.location, err = parsePredicate(raw["location_predicate"]); err != nil {
		return r, fmt.Errorf("location_predicate: %w", err)
	}
	if r.position, err = parsePositionTest(raw["position_predicate"]); err != nil {
		return r, fmt.Errorf("position_predicate: %w", err)
	}
	if r.output, err = parseDescriptor(raw["output_state"]); err != nil {
		return r, fmt.Errorf("output_state: %w", err)
	}
	return r, nil
}

var predicateParsers = map[string]func(raw map[string]any) (predicate, error){
	"minecraft:always_true": func(map[string]any) (predicate, error) {
		return func(block.ID, *block.Palette, *javaRandom) bool { return true }, nil
	},
	"minecraft:block_match": func(raw map[string]any) (predicate, error) {
		desc, err := parseDescriptor(raw["block"])
		if err != nil {
			return nil, err
		}
		return func(id block.ID, palette *block.Palette, _ *javaRandom) bool {
			return palette.NameOf(id) == desc.Name
		}, nil
	},
	"minecraft:blockstate_match": func(raw map[string]any) (predicate, error) {
		desc, err := parseDescriptor(raw["block_state"])
		if err != nil {
			return nil, err
		}
		return func(id block.ID, palette *block.Palette, _ *javaRandom) bool {
			return statesMatch(id, desc, palette)
		}, nil
	},
	"minecraft:random_block_match": func(raw map[string]any) (predicate, error) {
		desc, err := parseDescriptor(raw["block"])
		if err != nil {
			return nil, err
		}
		probability, ok := raw["probability"].(float64)
		if !ok {
			return nil, fmt.Errorf("probability must be a number")
		}
		return func(id block.ID, palette *block.Palette, rng *javaRandom) bool {
			return palette.NameOf(id) == desc.Name && rng.nextFloat() < float32(probability)
		}, nil
	},
	"minecraft:random_blockstate_match": func(raw map[string]any) (predicate, error) {
		desc, err := parseDescriptor(raw["block_state"])
		if err != nil {
			return nil, err
		}
		probability, ok := raw["probability"].(float64)
		if !ok {
			return nil, fmt.Errorf("probability must be a number")
		}
		return func(id block.ID, palette *block.Palette, rng *javaRandom) bool {
			return statesMatch(id, desc, palette) && rng.nextFloat() < float32(probability)
		}, nil
	},
	"minecraft:tag_match": func(raw map[string]any) (predicate, error) {
		tag, ok := raw["tag"].(string)
		if !ok {
			return nil, fmt.Errorf("tag must be a string")
		}
		return func(id block.ID, palette *block.Palette, _ *javaRandom) bool {
			return palette.BlockHasTag(id, tag)
		}, nil
	},
}

func parsePredicate(raw any) (predicate, error) {
	if raw == nil {
		return func(block.ID, *block.Palette, *javaRandom) bool { return true }, nil
	}
	object, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("must be an object")
	}
	predicateType, _ := object["predicate_type"].(string)
	parse, ok := predicateParsers[predicateType]
	if !ok {
		return nil, fmt.Errorf("unknown predicate_type %q", predicateType)
	}
	return parse(object)
}

func statesMatch(id block.ID, desc block.Descriptor, palette *block.Palette) bool {
	if palette.NameOf(id) != desc.Name {
		return false
	}
	states := palette.StatesOf(id)
	for key, want := range desc.States {
		if states[key] != want {
			return false
		}
	}
	return true
}

var axisIndexes = map[string]int{"x": 0, "y": 1, "z": 2}

func parsePositionTest(raw any) (positionTest, error) {
	if raw == nil {
		return func([3]int, [3]int, *javaRandom) bool { return true }, nil
	}
	object, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("must be an object")
	}
	switch object["predicate_type"] {
	case "minecraft:always_true":
		return func([3]int, [3]int, *javaRandom) bool { return true }, nil
	case "minecraft:axis_aligned_linear_pos":
		axisName, _ := object["axis"].(string)
		axis, known := axisIndexes[strings.ToLower(axisName)]
		if !known {
			return nil, fmt.Errorf("unknown axis %q", axisName)
		}
		minDistance, err := intField(object, "min_distance", 0)
		if err != nil {
			return nil, err
		}
		maxDistance, err := intField(object, "max_distance", 0)
		if err != nil {
			return nil, err
		}
		minChance, _ := object["min_chance"].(float64)
		maxChance, _ := object["max_chance"].(float64)
		return func(world, pivot [3]int, rng *javaRandom) bool {
			distance := world[axis] - pivot[axis]
			if distance < 0 {
				distance = -distance
			}
			return rng.nextFloat() <= clampedLerp(float32(minChance), float32(maxChance), inverseLerp(float32(distance), float32(minDistance), float32(maxDistance)))
		}, nil
	}
	return nil, fmt.Errorf("unknown predicate_type %v", object["predicate_type"])
}

func inverseLerp(value, low, high float32) float32 {
	return (value - low) / (high - low)
}

func clampedLerp(low, high, delta float32) float32 {
	if delta < 0 {
		return low
	}
	if delta > 1 {
		return high
	}
	return low + delta*(high-low)
}

func dropStructureBlock(id block.ID, _ *[3]int, ctx *processorContext) (block.ID, bool) {
	return id, ctx.palette.NameOf(id) != blockStructureBlock
}

// jigsawReplacement turns a jigsaw block into its final_state.
func jigsawReplacement(id block.ID, world *[3]int, ctx *processorContext) (block.ID, bool) {
	if ctx.palette.NameOf(id) != blockJigsaw {
		return id, true
	}
	if len(ctx.blockEntity) == 0 {
		ctx.warn("a jigsaw block has no block entity data, so it stays a jigsaw block", *world)
		return id, true
	}
	final, _ := ctx.blockEntity["final_state"].(string)
	desc := parseFinalState(final)
	if desc.Name == blockStructureVoid {
		return id, false
	}
	return ctx.palette.Resolve(desc), true
}

func parseFinalState(text string) block.Descriptor {
	if text == "" {
		return block.Descriptor{Name: blockAir}
	}
	name, rest, hasStates := strings.Cut(text, "[")
	desc := block.Descriptor{Name: withNamespace(strings.TrimSpace(name))}
	if !hasStates {
		return desc
	}
	rest = strings.TrimSuffix(strings.TrimSpace(rest), "]")
	if rest == "" {
		return desc
	}
	desc.States = map[string]block.StateValue{}
	for _, pair := range strings.Split(rest, ",") {
		key, value, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		desc.States[strings.Trim(strings.TrimSpace(key), `"`)] = parseStateLiteral(strings.TrimSpace(value))
	}
	return desc
}

func parseStateLiteral(text string) block.StateValue {
	if strings.HasPrefix(text, `"`) {
		return strings.Trim(text, `"`)
	}
	var number float64
	if _, err := fmt.Sscanf(text, "%g", &number); err == nil {
		return number
	}
	switch text {
	case "true":
		return float64(1)
	case "false":
		return float64(0)
	}
	return text
}

func terrainMatching(id block.ID, world *[3]int, ctx *processorContext) (block.ID, bool) {
	world[1] = ctx.heightAt(world[0], world[2]) - 1 + ctx.local[1]
	return id, true
}
