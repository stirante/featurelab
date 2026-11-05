package block

import "strings"

// rotateDirection turns a direction by quarter turns.
// 24 means "no horizontal direction" and maps to itself.
var rotateDirection = [4][25]int{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24},
	{1, 2, 3, 0, 5, 4, 8, 6, 9, 7, 11, 10, 14, 12, 15, 13, 19, 18, 16, 17, 21, 22, 23, 20, 24},
	{2, 3, 0, 1, 4, 5, 9, 8, 7, 6, 10, 11, 15, 14, 13, 12, 17, 16, 19, 18, 22, 23, 20, 21, 24},
	{3, 0, 1, 2, 5, 4, 7, 9, 6, 8, 11, 10, 13, 15, 12, 14, 18, 19, 17, 16, 23, 20, 21, 22, 24},
}

const noHorizontalDirection = 24

type rotationMapping struct {
	value     StateValue
	direction int
}

type rotationFamily struct {
	key      string
	mappings []rotationMapping
}

var directionMappings = []rotationMapping{{float64(2), 0}, {float64(3), 1}, {float64(0), 2}, {float64(1), 3}}

var facingNameMappings = []rotationMapping{{"north", 0}, {"east", 1}, {"south", 2}, {"west", 3}, {"down", 24}, {"up", 24}}

var legacyFacingMappings = []rotationMapping{{float64(2), 0}, {float64(5), 1}, {float64(3), 2}, {float64(4), 3}, {float64(0), 24}, {float64(1), 24}}

// rotationFamilies map state values to directions:
// the first matching value gives the direction, the
// direction is rotated, the first matching direction gives the new value.
var rotationFamilies = []rotationFamily{
	{"portal_axis", []rotationMapping{{"z", 0}, {"x", 1}, {"z", 2}, {"x", 3}, {"unknown", 24}}},
	{"minecraft:cardinal_direction", []rotationMapping{{"north", 0}, {"east", 1}, {"south", 2}, {"west", 3}}},
	{"minecraft:facing_direction", facingNameMappings},
	{"minecraft:block_face", facingNameMappings},
	{"direction", directionMappings},
	{"facing_direction", legacyFacingMappings},
	{"rail_direction", []rotationMapping{
		{float64(0), 4}, {float64(1), 5}, {float64(4), 18}, {float64(2), 16}, {float64(5), 19},
		{float64(3), 17}, {float64(9), 23}, {float64(6), 20}, {float64(7), 21}, {float64(8), 22},
	}},
	{"torch_facing_direction", []rotationMapping{
		{"north", 0}, {"east", 1}, {"south", 2}, {"west", 3}, {"top", 24}, {"unknown", 24},
	}},
	{"weirdo_direction", []rotationMapping{{float64(3), 0}, {float64(0), 1}, {float64(2), 2}, {float64(1), 3}}},
	{"coral_direction", []rotationMapping{{float64(2), 0}, {float64(1), 1}, {float64(3), 2}, {float64(0), 3}}},
	{"lever_direction", []rotationMapping{
		{"north", 0}, {"east", 1}, {"south", 2}, {"west", 3},
		{"down_east_west", 5}, {"down_north_south", 4}, {"up_east_west", 11}, {"up_north_south", 10},
	}},
	{"pillar_axis", []rotationMapping{{"z", 0}, {"x", 1}, {"z", 2}, {"x", 3}, {"y", 24}}},
	{"orientation", []rotationMapping{
		{"down_east", 6}, {"down_north", 7}, {"down_south", 8}, {"down_west", 9},
		{"up_east", 12}, {"up_north", 13}, {"up_south", 14}, {"up_west", 15},
		{"west_up", 3}, {"east_up", 1}, {"north_up", 0}, {"south_up", 2},
	}},
}

var wallConnectionKeys = [4]string{"wall_connection_type_north", "wall_connection_type_east", "wall_connection_type_south", "wall_connection_type_west"}

var connectionKeys = [4]string{"minecraft:connection_north", "minecraft:connection_east", "minecraft:connection_south", "minecraft:connection_west"}

// Trapdoors store their direction in a different order.
var trapdoorToDirection = [4]int{3, 1, 0, 2}
var directionToTrapdoor = [4]int{2, 1, 3, 0}

// RotateBlock turns a block's states for a structure rotation with no mirror:
// rotation counts clockwise quarter turns seen from above. Unlike SetBlockDirection, which sets a
// state from a direction, this one rotates the value the block already has.
func (p *Palette) RotateBlock(id ID, rotation int) ID {
	rotation &= 3
	if rotation == 0 {
		return id
	}
	entry := p.Entry(id)
	if len(entry.States) == 0 {
		return id
	}
	next := make(map[string]StateValue, len(entry.States))
	for k, v := range entry.States {
		next[k] = v
	}
	changed := false
	for _, family := range rotationFamilies {
		value, ok := next[family.key]
		if !ok {
			continue
		}
		rotated := rotateFamilyValue(family, value, rotation)
		if family.key == "direction" && isTrapdoorName(entry.Name) {
			rotated = rotateTrapdoorDirection(value, rotation)
		}
		if rotated != value {
			next[family.key] = rotated
			changed = true
		}
	}
	changed = rotateIntState(next, "ground_sign_direction", func(v int) int { return (v + 4*rotation) % 16 }) || changed
	changed = rotateIntState(next, "vine_direction_bits", func(v int) int { return rotateFourBits(v, rotation) }) || changed
	changed = rotateIntState(next, "multi_face_direction_bits", func(v int) int { return v&3 | rotateFourBits(v>>2, rotation)<<2 }) || changed
	changed = rotateConnections(next, wallConnectionKeys, rotation) || changed
	changed = rotateConnections(next, connectionKeys, rotation) || changed
	if !changed {
		return id
	}
	return p.intern(entry.Name, next)
}

func rotateFamilyValue(family rotationFamily, value StateValue, rotation int) StateValue {
	for _, from := range family.mappings {
		if from.value != value {
			continue
		}
		if from.direction == noHorizontalDirection {
			return value
		}
		direction := rotateDirection[rotation][from.direction]
		for _, to := range family.mappings {
			if to.direction == direction {
				return to.value
			}
		}
		return value
	}
	return value
}

func rotateTrapdoorDirection(value StateValue, rotation int) StateValue {
	number, ok := value.(float64)
	if !ok || number < 0 || number > 3 {
		return value
	}
	direction := StateValue(float64(trapdoorToDirection[int(number)]))
	rotated := rotateFamilyValue(rotationFamily{"direction", directionMappings}, direction, rotation).(float64)
	return float64(directionToTrapdoor[int(rotated)])
}

func isTrapdoorName(name string) bool {
	return strings.HasSuffix(name, "trapdoor")
}

func rotateFourBits(value, rotation int) int {
	value &= 15
	return (value<<rotation | value>>(4-rotation)) & 15
}

func rotateIntState(states map[string]StateValue, key string, rotate func(int) int) bool {
	number, ok := states[key].(float64)
	if !ok {
		return false
	}
	rotated := float64(rotate(int(number)))
	if rotated == number {
		return false
	}
	states[key] = rotated
	return true
}

func rotateConnections(states map[string]StateValue, keys [4]string, rotation int) bool {
	var old [4]StateValue
	for i, key := range keys {
		value, ok := states[key]
		if !ok {
			return false
		}
		old[i] = value
	}
	changed := false
	for i, key := range keys {
		value := old[(i-rotation+4)%4]
		if value != old[i] {
			changed = true
		}
		states[key] = value
	}
	return changed
}

// BlockHasTag reports whether the block's name carries a block tag.
func (p *Palette) BlockHasTag(id ID, tag string) bool {
	return p.blockHasTag(p.Entry(id).Name, tag)
}
