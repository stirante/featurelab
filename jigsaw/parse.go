package jigsaw

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
)

// defaultFallback is the fallback of a pool that writes none.
const defaultFallback = "minecraft:empty"

func (l *Library) loadPool(f SourceFile, body map[string]any, identifier string) error {
	// The game keys a pool on its lowercase name and keeps the first of a duplicate,
	// while a lookup compares the name as written.
	key := strings.ToLower(identifier)
	if first, exists := l.pools[key]; exists {
		l.warnAt(f.ID, fmt.Sprintf("template pool %q is also declared in %s: the game keeps the one it loads first, and this run keeps %s", identifier, first.fileID, first.fileID))
		return nil
	}
	if key != identifier {
		l.warnAt(f.ID, fmt.Sprintf("template pool %q is registered as %q, so a reference spelled with capitals does not find it", identifier, key))
	}
	fallback := defaultFallback
	if value, present := body["fallback"]; present {
		name, ok := value.(string)
		if !ok {
			return fmt.Errorf("fallback must name a template pool")
		}
		fallback = name
	}
	raw, ok := body["elements"].([]any)
	if !ok {
		return fmt.Errorf("template pool %q has no elements list", identifier)
	}
	pool := &templatePool{identifier: identifier, fileID: f.ID, fallback: fallback}
	for i, entry := range raw {
		wrapper, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("elements[%d] is not an object", i)
		}
		weight, err := intField(wrapper, "weight", 1)
		if err != nil {
			return fmt.Errorf("elements[%d]: %w", i, err)
		}
		inner, ok := wrapper["element"].(map[string]any)
		if !ok {
			return fmt.Errorf("elements[%d].element is not an object", i)
		}
		element, err := parseElement(inner)
		if err != nil {
			return fmt.Errorf("elements[%d].element: %w", i, err)
		}
		for w := 0; w < weight; w++ {
			pool.elements = append(pool.elements, element)
		}
	}
	l.pools[key] = pool
	return nil
}

var elementParsers = map[string]func(raw map[string]any, element *poolElement) error{
	"minecraft:empty_pool_element": func(map[string]any, *poolElement) error { return nil },
	"minecraft:single_pool_element": func(raw map[string]any, element *poolElement) error {
		element.kind = elementSingle
		location, ok := raw["location"].(string)
		if !ok || location == "" {
			return fmt.Errorf("location is missing")
		}
		element.location = location
		if value, ok := raw["processors"]; ok {
			list, ok := value.(string)
			if !ok {
				return fmt.Errorf("processors must name a processor list")
			}
			element.processorList = list
		}
		return nil
	},
	"minecraft:feature_pool_element": func(raw map[string]any, element *poolElement) error {
		element.kind = elementFeature
		feature, ok := raw["feature"].(string)
		if !ok || feature == "" {
			return fmt.Errorf("feature is missing")
		}
		element.feature = feature
		return nil
	},
}

func parseElement(raw map[string]any) (*poolElement, error) {
	elementType, _ := raw["element_type"].(string)
	parse, ok := elementParsers[elementType]
	if !ok {
		return nil, fmt.Errorf("unknown element_type %q", elementType)
	}
	element := &poolElement{}
	if err := parse(raw, element); err != nil {
		return nil, err
	}
	switch raw["projection"] {
	case nil, "rigid":
	case "terrain_matching":
		element.projection = projectionTerrainMatching
	default:
		return nil, fmt.Errorf("unknown projection %v", raw["projection"])
	}
	return element, nil
}

var heightmapProjections = map[string]int{"none": heightmapNone, "world_surface": heightmapWorldSurface, "ocean_floor": heightmapOceanFloor}

func (l *Library) loadStructure(f SourceFile, body map[string]any, identifier string) error {
	if _, exists := l.structures[identifier]; exists {
		return fmt.Errorf("jigsaw structure %q is declared in more than one file", identifier)
	}
	s := &Structure{Identifier: identifier, FileID: f.ID, MaxHorizontal: 80, MaxVertical: unlimitedDistance}
	var ok bool
	if s.StartPool, ok = body["start_pool"].(string); !ok || s.StartPool == "" {
		return fmt.Errorf("start_pool is missing")
	}
	s.StartJigsawName, _ = body["start_jigsaw_name"].(string)
	s.TerrainAdaptation, _ = body["terrain_adaptation"].(string)
	s.Step, _ = body["step"].(string)
	_, s.HasBiomeFilters = body["biome_filters"]
	s.ApplyWaterlogging = body["liquid_settings"] == "apply_waterlogging"
	var err error
	if s.MaxDepth, err = intField(body, "max_depth", 0); err != nil {
		return err
	}
	if s.StartHeight, err = parseHeight(body["start_height"]); err != nil {
		return fmt.Errorf("start_height: %w", err)
	}
	if raw, present := body["heightmap_projection"]; present {
		name, _ := raw.(string)
		value, known := heightmapProjections[name]
		if !known {
			return fmt.Errorf("unknown heightmap_projection %v", raw)
		}
		s.Projection = value
	}
	if err := parsePadding(body["dimension_padding"], s); err != nil {
		return err
	}
	if err := parseMaxDistance(body["max_distance_from_center"], s); err != nil {
		return err
	}
	if err := parseAliases(body["pool_aliases"], s); err != nil {
		return err
	}
	if s.HasRandomAliases {
		l.warnAt(f.ID, "random pool aliases are not modelled: the assembly uses each alias's own name")
	}
	l.structures[identifier] = s
	return nil
}

func parsePadding(raw any, s *Structure) error {
	switch value := raw.(type) {
	case nil:
	case float64:
		s.PaddingBottom, s.PaddingTop = int(value), int(value)
	case map[string]any:
		var err error
		if s.PaddingBottom, err = intField(value, "bottom", 0); err != nil {
			return fmt.Errorf("dimension_padding: %w", err)
		}
		if s.PaddingTop, err = intField(value, "top", 0); err != nil {
			return fmt.Errorf("dimension_padding: %w", err)
		}
	default:
		return fmt.Errorf("dimension_padding must be a number or an object")
	}
	return nil
}

func parseMaxDistance(raw any, s *Structure) error {
	switch value := raw.(type) {
	case nil:
	case float64:
		s.MaxHorizontal = int(value)
	case map[string]any:
		var err error
		if s.MaxHorizontal, err = intField(value, "horizontal", s.MaxHorizontal); err != nil {
			return fmt.Errorf("max_distance_from_center: %w", err)
		}
		if s.MaxVertical, err = intField(value, "vertical", s.MaxVertical); err != nil {
			return fmt.Errorf("max_distance_from_center: %w", err)
		}
	default:
		return fmt.Errorf("max_distance_from_center must be a number or an object")
	}
	return nil
}

func parseAliases(raw any, s *Structure) error {
	if raw == nil {
		return nil
	}
	list, ok := raw.([]any)
	if !ok {
		return fmt.Errorf("pool_aliases must be a list")
	}
	s.Aliases = map[string]string{}
	for i, entry := range list {
		alias, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("pool_aliases[%d] is not an object", i)
		}
		from, hasFrom := alias["alias"].(string)
		to, hasTo := alias["target"].(string)
		if hasFrom && hasTo {
			s.Aliases[from] = to
			continue
		}
		s.HasRandomAliases = true
	}
	return nil
}

func parseHeight(raw any) (heightProvider, error) {
	if raw == nil {
		return heightProvider{min: heightAnchor{kind: "absolute"}, max: heightAnchor{kind: "absolute"}}, nil
	}
	object, ok := raw.(map[string]any)
	if !ok {
		return heightProvider{}, fmt.Errorf("must be an object")
	}
	switch object["type"] {
	case "constant":
		anchor, err := parseAnchor(object["value"])
		if err != nil {
			return heightProvider{}, fmt.Errorf("value: %w", err)
		}
		return heightProvider{min: anchor, max: anchor}, nil
	case "uniform":
		low, err := parseAnchor(object["min"])
		if err != nil {
			return heightProvider{}, fmt.Errorf("min: %w", err)
		}
		high, err := parseAnchor(object["max"])
		if err != nil {
			return heightProvider{}, fmt.Errorf("max: %w", err)
		}
		return heightProvider{uniform: true, min: low, max: high}, nil
	}
	return heightProvider{}, fmt.Errorf("unknown type %v", object["type"])
}

func parseAnchor(raw any) (heightAnchor, error) {
	object, ok := raw.(map[string]any)
	if !ok {
		return heightAnchor{}, fmt.Errorf("must be an object")
	}
	for _, kind := range []string{"absolute", "above_bottom", "below_top"} {
		if value, ok := object[kind].(float64); ok {
			return heightAnchor{kind: kind, value: int(value)}, nil
		}
	}
	return heightAnchor{}, fmt.Errorf("needs absolute, above_bottom or below_top")
}

func (l *Library) loadSet(f SourceFile, body map[string]any, identifier string) error {
	set := &structureSet{identifier: identifier, fileID: f.ID}
	raw, ok := body["structures"].([]any)
	if !ok {
		return fmt.Errorf("structure set %q has no structures list", identifier)
	}
	for i, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("structures[%d] is not an object", i)
		}
		name, ok := object["structure"].(string)
		if !ok {
			return fmt.Errorf("structures[%d].structure is missing", i)
		}
		set.structures = append(set.structures, name)
	}
	l.sets = append(l.sets, set)
	return nil
}

func (l *Library) loadProcessorList(f SourceFile, body map[string]any, identifier string) error {
	if _, exists := l.processors[identifier]; exists {
		return fmt.Errorf("processor list %q is declared in more than one file", identifier)
	}
	raw, ok := body["processors"].([]any)
	if !ok {
		return fmt.Errorf("processor list %q has no processors list", identifier)
	}
	list := make([]processor, 0, len(raw))
	for i, entry := range raw {
		object, ok := entry.(map[string]any)
		if !ok {
			return fmt.Errorf("processors[%d] is not an object", i)
		}
		built, err := l.parseProcessor(object, identifier)
		if err != nil {
			return fmt.Errorf("processors[%d]: %w", i, err)
		}
		list = append(list, built)
	}
	l.processors[identifier] = list
	return nil
}

func intField(object map[string]any, key string, fallback int) (int, error) {
	raw, ok := object[key]
	if !ok {
		return fallback, nil
	}
	number, ok := raw.(float64)
	if !ok {
		return 0, fmt.Errorf("%s must be a number", key)
	}
	return int(number), nil
}

func parseDescriptor(raw any) (block.Descriptor, error) {
	switch value := raw.(type) {
	case string:
		return block.Descriptor{Name: withNamespace(value)}, nil
	case map[string]any:
		name, ok := value["name"].(string)
		if !ok {
			return block.Descriptor{}, fmt.Errorf("block name is missing")
		}
		desc := block.Descriptor{Name: withNamespace(name)}
		if states, ok := value["states"].(map[string]any); ok {
			desc.States = make(map[string]block.StateValue, len(states))
			for k, v := range states {
				desc.States[k] = v
			}
		}
		return desc, nil
	}
	return block.Descriptor{}, fmt.Errorf("block must be a name or an object")
}

func withNamespace(name string) string {
	if strings.Contains(name, ":") {
		return name
	}
	return "minecraft:" + name
}
