package jigsaw

import (
	"fmt"
	"sort"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/nbt"
	"github.com/stirante/featurelab/structures"
)

const (
	facingDown = iota
	facingUp
	facingNorth
	facingSouth
	facingWest
	facingEast
)

var facingOpposite = [6]int{facingUp, facingDown, facingSouth, facingNorth, facingEast, facingWest}

var facingStep = [6][3]int{{0, -1, 0}, {0, 1, 0}, {0, 0, -1}, {0, 0, 1}, {-1, 0, 0}, {1, 0, 0}}

// horizontalFacings runs clockwise, so a structure rotation is an index shift.
var horizontalFacings = [4]int{facingNorth, facingEast, facingSouth, facingWest}

type connector struct {
	pos               [3]int
	name              string
	target            string
	pool              string
	aligned           bool
	placementPriority int
	selectionPriority int
	facing            int
	top               int
}

type template struct {
	size       nbt.Vec3Int
	structure  *structures.ResolvedStructure
	connectors []connector
}

// structureNameFromLocation drops the namespace of a pool element's location: the game looks the
// file up by the path alone, relative to structures/.
func structureNameFromLocation(location string) string {
	path := location
	if _, after, ok := strings.Cut(location, ":"); ok {
		path = after
	}
	if slash := strings.Index(path, "/"); slash >= 0 {
		return path[:slash] + ":" + path[slash+1:]
	}
	return path
}

func buildTemplate(resolved *structures.ResolvedStructure, palette *block.Palette) (*template, error) {
	t := &template{size: resolved.Size, structure: resolved}
	sizeZ, sizeY := resolved.Size.Z, resolved.Size.Y
	cells := make([]int, 0, len(resolved.BlockEntities))
	for cell := range resolved.BlockEntities {
		cells = append(cells, cell)
	}
	sort.Ints(cells)
	for _, cell := range cells {
		paletteIndex := resolved.Layer0[cell]
		if paletteIndex < 0 || int(paletteIndex) >= len(resolved.PaletteIDs) {
			continue
		}
		id := resolved.PaletteIDs[paletteIndex]
		if palette.NameOf(id) != blockJigsaw {
			continue
		}
		c, err := parseConnector(resolved.BlockEntities[cell], palette.StatesOf(id))
		if err != nil {
			return nil, fmt.Errorf("jigsaw block at cell %d: %w", cell, err)
		}
		c.pos = [3]int{cell / (sizeY * sizeZ), (cell / sizeZ) % sizeY, cell % sizeZ}
		t.connectors = append(t.connectors, c)
	}
	return t, nil
}

func parseConnector(data map[string]any, states map[string]block.StateValue) (connector, error) {
	c := connector{
		name:   stringWithFallback(data, "name", "attachement_type"),
		pool:   stringWithFallback(data, "target_pool", "pool"),
		target: stringWithFallback(data, "target", ""),
	}
	c.aligned = data["joint"] == "aligned"
	c.placementPriority = int(numberOf(data["placement_priority"]))
	c.selectionPriority = int(numberOf(data["selection_priority"]))
	facing, ok := states["facing_direction"].(float64)
	if !ok || facing < 0 || facing > 5 {
		return c, fmt.Errorf("facing_direction is %v, not 0-5", states["facing_direction"])
	}
	c.facing = int(facing)
	c.top = int(numberOf(states["rotation"])) & 3
	return c, nil
}

func stringWithFallback(data map[string]any, key, fallback string) string {
	if value, ok := data[key].(string); ok {
		return value
	}
	if fallback == "" {
		return ""
	}
	value, _ := data[fallback].(string)
	return value
}

func numberOf(raw any) float64 {
	switch value := raw.(type) {
	case float64:
		return value
	case int64:
		return float64(value)
	}
	return 0
}

func rotatedFacing(facing, rotation int) int {
	if facing < facingNorth {
		return facing
	}
	for i, horizontal := range horizontalFacings {
		if horizontal == facing {
			return horizontalFacings[(i+rotation)&3]
		}
	}
	return facing
}

// topFace is the top face of a vertical jigsaw block, after
// the structure rotation turned it: up reads the rotation
// state clockwise, down counter-clockwise.
func topFace(c connector, rotation int) int {
	index := c.top
	if c.facing == facingDown {
		index = (4 - c.top) & 3
	}
	return (index + rotation) & 3
}

// rotatedLocal is a local position after a rotation, with a zero origin.
func rotatedLocal(pos [3]int, rotation int) [3]int {
	switch rotation & 3 {
	case 1:
		return [3]int{-pos[2], pos[1], pos[0]}
	case 2:
		return [3]int{-pos[0], pos[1], -pos[2]}
	case 3:
		return [3]int{pos[2], pos[1], -pos[0]}
	}
	return pos
}

type box struct {
	minX, minY, minZ, maxX, maxY, maxZ int
}

// boundingBox is a piece's box after a rotation. Bounds are inclusive.
func boundingBox(size nbt.Vec3Int, origin [3]int, rotation int) box {
	sizeX, sizeZ := size.X, size.Z
	if rotation&1 == 1 {
		sizeX, sizeZ = size.Z, size.X
	}
	lowX, highX := 0, sizeX-1
	lowZ, highZ := 0, sizeZ-1
	switch rotation & 3 {
	case 1:
		lowX, highX = 1-sizeX, 0
	case 2:
		lowX, highX = 1-sizeX, 0
		lowZ, highZ = 1-sizeZ, 0
	case 3:
		lowZ, highZ = 1-sizeZ, 0
	}
	return box{
		minX: origin[0] + lowX, minY: origin[1], minZ: origin[2] + lowZ,
		maxX: origin[0] + highX, maxY: origin[1] + size.Y - 1, maxZ: origin[2] + highZ,
	}
}

func (b box) shiftedY(dy int) box {
	b.minY += dy
	b.maxY += dy
	return b
}

func (b box) containsPoint(p [3]int) bool {
	return p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY && p[2] >= b.minZ && p[2] <= b.maxZ
}

func (b box) containsBox(other box) bool {
	return other.minX >= b.minX && other.maxX <= b.maxX &&
		other.minY >= b.minY && other.maxY <= b.maxY &&
		other.minZ >= b.minZ && other.maxZ <= b.maxZ
}

func (b box) intersects(other box) bool {
	return other.maxX >= b.minX && other.minX <= b.maxX &&
		other.maxZ >= b.minZ && other.minZ <= b.maxZ &&
		other.maxY >= b.minY && other.minY <= b.maxY
}
