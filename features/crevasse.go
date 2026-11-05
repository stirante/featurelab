// crevasse.go is minecraft:crevasse_feature, new in game version 1.26.70.
// Fields and placement follow the game's crevasse feature.
package features

import (
	"fmt"
	"math"
	"sort"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

const crevasseTypeID = "minecraft:crevasse_feature"

const (
	crevasseHeadingStep = float32(0.05)
	crevasseFullTurn    = float32(6.2831855)
	crevasseHalfTurn    = float32(3.1415927)
	crevasseTaperAmount = float32(0.6)
	crevasseSteepStep   = 1
	crevasseSearchReach = 4
	crevasseMinRadius   = float32(0.5)
)

// crevasseCarvable is the carver list: what a crevasse may carve.
var crevasseCarvable = map[string]bool{
	"minecraft:stone": true, "minecraft:granite": true, "minecraft:diorite": true, "minecraft:andesite": true,
	"minecraft:tuff": true, "minecraft:deepslate": true, "minecraft:calcite": true, "minecraft:dirt": true,
	"minecraft:coarse_dirt": true, "minecraft:mud": true, "minecraft:podzol": true, "minecraft:mycelium": true,
	"minecraft:grass_block": true, "minecraft:dirt_with_roots": true, "minecraft:hardened_clay": true,
	"minecraft:white_terracotta": true, "minecraft:orange_terracotta": true, "minecraft:magenta_terracotta": true,
	"minecraft:light_blue_terracotta": true, "minecraft:yellow_terracotta": true, "minecraft:lime_terracotta": true,
	"minecraft:pink_terracotta": true, "minecraft:gray_terracotta": true, "minecraft:light_gray_terracotta": true,
	"minecraft:cyan_terracotta": true, "minecraft:purple_terracotta": true, "minecraft:blue_terracotta": true,
	"minecraft:brown_terracotta": true, "minecraft:green_terracotta": true, "minecraft:red_terracotta": true,
	"minecraft:black_terracotta": true, "minecraft:sandstone": true, "minecraft:chiseled_sandstone": true,
	"minecraft:cut_sandstone": true, "minecraft:smooth_sandstone": true, "minecraft:red_sandstone": true,
	"minecraft:chiseled_red_sandstone": true, "minecraft:cut_red_sandstone": true,
	"minecraft:smooth_red_sandstone": true, "minecraft:sand": true, "minecraft:red_sand": true,
	"minecraft:suspicious_sand": true, "minecraft:iron_ore": true, "minecraft:deepslate_iron_ore": true,
	"minecraft:raw_iron_block": true, "minecraft:copper_ore": true, "minecraft:deepslate_copper_ore": true,
	"minecraft:raw_copper_block": true, "minecraft:snow": true, "minecraft:snow_layer": true,
	"minecraft:packed_ice": true, "minecraft:gravel": true, "minecraft:sulfur": true, "minecraft:cinnabar": true,
}

type crevasseColumn struct {
	x, y, z int
	depth   int
	surface block.ID
}

type crevasseKey struct{ x, z int }

// N, E, S, W: facings 2, 5, 3, 4.
var crevasseSides = []crevasseKey{{0, -1}, {1, 0}, {0, 1}, {-1, 0}}

type CrevasseFeature struct {
	identifier   string
	pal          *block.Palette
	air          block.ID
	maxLength    int
	maxWidth     int
	minFootprint int
	twistiness   float32
	carveMin     int
	carveMax     int
	fillMin      int
	fillMax      int
	surface      block.ID
	hasSurface   bool
	fill         block.ID
	hasFill      bool
}

func (f *CrevasseFeature) TypeID() string     { return crevasseTypeID }
func (f *CrevasseFeature) Identifier() string { return f.identifier }

func crevasseIsSolid(pal wgen.PaletteView, id block.ID) bool {
	return block.IsSolidBlocking(pal.NameOf(id), pal.StatesOf(id))
}

func crevasseCanCarve(pal wgen.PaletteView, id block.ID) bool {
	return crevasseCarvable[pal.NameOf(id)]
}

// crevasseFindSurface finds the highest solid carvable block within
// four of y with an empty block right above it.
func crevasseFindSurface(api wgen.BlockWorld, x, y, z int) (int, block.ID, bool) {
	pal := api.Palette()
	low := max(y-crevasseSearchReach, api.MinY())
	if y+crevasseSearchReach < api.MinY() {
		return 0, 0, false
	}
	aboveEmpty := pal.IsAir(api.GetBlock(wgen.BlockPos{X: x, Y: y + crevasseSearchReach + 1, Z: z}))
	for yy := y + crevasseSearchReach; yy >= low; yy-- {
		id := api.GetBlock(wgen.BlockPos{X: x, Y: yy, Z: z})
		if aboveEmpty && crevasseIsSolid(pal, id) && crevasseCanCarve(pal, id) {
			return yy, id, true
		}
		aboveEmpty = pal.IsAir(id)
	}
	return 0, 0, false
}

func crevasseDepthBelow(api wgen.BlockWorld, x, surfaceY, z, maxDepth int) int {
	if maxDepth < 2 {
		return 0
	}
	pal := api.Palette()
	count := 1
	for count < maxDepth {
		id := api.GetBlock(wgen.BlockPos{X: x, Y: surfaceY - count, Z: z})
		if !crevasseIsSolid(pal, id) || !crevasseCanCarve(pal, id) {
			break
		}
		count++
	}
	return count - 1
}

func crevasseStampDisc(api wgen.BlockWorld, columns map[crevasseKey]*crevasseColumn, cx, cy, cz int, radius float32, depth int) {
	reach := int(math.Ceil(float64(radius)))
	for bx := cx - reach; bx <= cx+reach; bx++ {
		TickDeadline("carving a crevasse as wide as its max_width asks")
		for bz := cz - reach; bz <= cz+reach; bz++ {
			dx, dz := bx-cx, bz-cz
			if float32(dx*dx+dz*dz) > radius*radius {
				continue
			}
			key := crevasseKey{bx, bz}
			if _, taken := columns[key]; taken {
				continue
			}
			y, surface, found := crevasseFindSurface(api, bx, cy, bz)
			if !found {
				continue
			}
			columns[key] = &crevasseColumn{x: bx, y: y, z: bz, depth: crevasseDepthBelow(api, bx, y, bz, depth), surface: surface}
		}
	}
}

func (f *CrevasseFeature) walkSide(api wgen.BlockWorld, rnd random.RandomSource, columns map[crevasseKey]*crevasseColumn, origin wgen.BlockPos, heading float32, carveDepth int) {
	half := f.maxLength / 2
	curve := float32(0)
	px, pz := float32(origin.X), float32(origin.Z)
	yRef := origin.Y
	for i := 0; i < half; i++ {
		TickDeadline("walking a crevasse as long as its max_length asks")
		px += float32(math.Cos(float64(heading)))
		pz += float32(math.Sin(float64(heading)))
		// *** RNG CALLS *** a gaussian draw is NextFloat minus NextFloat, first draw on the left.
		first := float32(rnd.NextFloat())
		second := float32(rnd.NextFloat())
		gaussian := first - second
		scale := float32(rnd.NextFloat()) // *** RNG CALL ***
		curve = curve*0.5 + gaussian*scale*f.twistiness
		x := int(math.Floor(float64(px)))
		z := int(math.Floor(float64(pz)))
		heading += curve * crevasseHeadingStep

		y, _, found := crevasseFindSurface(api, x, yRef, z)
		if !found {
			continue
		}
		taper := 1 - (float32(i)/float32(half))*crevasseTaperAmount
		radius := max(crevasseMinRadius, float32(f.maxWidth)*0.5*taper)
		depth := int(float32(carveDepth) * taper)
		crevasseStampDisc(api, columns, x, y, z, radius, depth)
		yRef = y
	}
}

func crevasseHasSteepNeighbor(columns map[crevasseKey]*crevasseColumn, col *crevasseColumn) bool {
	for _, side := range crevasseSides {
		other, ok := columns[crevasseKey{col.x + side.x, col.z + side.z}]
		if !ok {
			continue
		}
		if d := other.y - col.y; d > crevasseSteepStep || d < -crevasseSteepStep {
			return true
		}
	}
	return false
}

// crevasseKeepConnected keeps the columns reachable from the origin over gentle steps. It says how
// many stayed; 0 when the origin column itself is missing or steep.
func crevasseKeepConnected(columns map[crevasseKey]*crevasseColumn, origin wgen.BlockPos) int {
	start := crevasseKey{origin.X, origin.Z}
	first, ok := columns[start]
	if !ok || crevasseHasSteepNeighbor(columns, first) {
		return 0
	}
	visited := map[crevasseKey]bool{start: true}
	queue := []crevasseKey{start}
	for len(queue) > 0 {
		TickDeadline("connecting the columns of a crevasse")
		at := queue[0]
		queue = queue[1:]
		for _, side := range crevasseSides {
			next := crevasseKey{at.x + side.x, at.z + side.z}
			col, exists := columns[next]
			if !exists || visited[next] || crevasseHasSteepNeighbor(columns, col) {
				continue
			}
			visited[next] = true
			queue = append(queue, next)
		}
	}
	for key := range columns {
		if !visited[key] {
			delete(columns, key)
		}
	}
	return len(visited)
}

func (f *CrevasseFeature) setSafe(api wgen.BlockWorld, pos wgen.BlockPos, id block.ID) {
	setBlockSafe(api, f.pal, pos, id)
}

// sealSides: a soft block beside a cell about to change becomes
// the column's own surface, unless it is carved itself or already the incoming block.
func (f *CrevasseFeature) sealSides(api wgen.BlockWorld, columns map[crevasseKey]*crevasseColumn, col *crevasseColumn, y int, incoming block.ID) {
	pal := api.Palette()
	for _, side := range crevasseSides {
		pos := wgen.BlockPos{X: col.x + side.x, Y: y, Z: col.z + side.z}
		neighbour := api.GetBlock(pos)
		if crevasseIsSolid(pal, neighbour) {
			continue
		}
		other, ok := columns[crevasseKey{pos.X, pos.Z}]
		if ok && y >= other.y-other.depth && y <= other.y {
			continue
		}
		if pal.NameOf(neighbour) != pal.NameOf(incoming) {
			f.setSafe(api, pos, col.surface)
		}
	}
}

func crevasseTouchesLiquid(api wgen.BlockWorld, col *crevasseColumn, y int) bool {
	pal := api.Palette()
	for _, side := range crevasseSides {
		if pal.IsLiquid(api.GetBlock(wgen.BlockPos{X: col.x + side.x, Y: y, Z: col.z + side.z})) {
			return true
		}
	}
	return false
}

func (f *CrevasseFeature) carveColumn(api wgen.BlockWorld, columns map[crevasseKey]*crevasseColumn, col *crevasseColumn, fillLevel int) {
	pal := api.Palette()
	bottom := col.y - col.depth
	stoppedAtTop := false
	for y := col.y; y >= bottom; y-- {
		pos := wgen.BlockPos{X: col.x, Y: y, Z: col.z}
		if f.hasFill && y <= fillLevel {
			f.sealSides(api, columns, col, y, f.fill)
			f.setSafe(api, pos, f.fill)
			if y == bottom {
				belowPos := wgen.BlockPos{X: col.x, Y: y - 1, Z: col.z}
				below := api.GetBlock(belowPos)
				if !crevasseIsSolid(pal, below) && pal.NameOf(below) != pal.NameOf(f.fill) {
					f.setSafe(api, belowPos, col.surface)
				}
			}
			continue
		}
		if crevasseTouchesLiquid(api, col, y) {
			stoppedAtTop = y == col.y
			break
		}
		f.sealSides(api, columns, col, y, f.air)
		f.setSafe(api, pos, f.air)
	}
	top := wgen.BlockPos{X: col.x, Y: col.y, Z: col.z}
	if f.hasSurface && !stoppedAtTop && api.GetBlock(top) != f.surface {
		f.setSafe(api, top, f.surface)
	}
}

func (f *CrevasseFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, crevasseTypeID)
	defer profiler.PopFeatureFrame()

	api, rnd, origin := ctx.API, ctx.Random, ctx.Origin

	carveDepth := treeIntRangeValueInclusive(f.carveMin, f.carveMax, rnd) // *** RNG CALL (0 or 1) ***
	if origin.Y <= carveDepth+api.MinY() {
		return nil
	}
	baseAngle := float32(rnd.NextFloat()) * crevasseFullTurn           // *** RNG CALL ***
	fillDepth := treeIntRangeValueInclusive(f.fillMin, f.fillMax, rnd) // *** RNG CALL (0 or 1) ***

	columns := map[crevasseKey]*crevasseColumn{}
	for k := 0; k < 2; k++ {
		f.walkSide(api, rnd, columns, origin, baseAngle+float32(k)*crevasseHalfTurn, carveDepth)
	}

	if kept := crevasseKeepConnected(columns, origin); kept < f.minFootprint || kept == 0 {
		return nil
	}

	ordered := make([]*crevasseColumn, 0, len(columns))
	lowest := math.MaxInt
	for _, col := range columns {
		ordered = append(ordered, col)
		lowest = min(lowest, col.y)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].x != ordered[j].x {
			return ordered[i].x < ordered[j].x
		}
		return ordered[i].z < ordered[j].z
	})

	fillLevel := min(lowest-1, origin.Y-fillDepth)
	for _, col := range ordered {
		TickDeadline("carving the columns of a crevasse")
		f.carveColumn(api, columns, col, fillLevel)
	}
	result := origin
	return &result
}

func parseCrevasseInt(body map[string]any, key string, lo, hi, def int) (int, error) {
	raw, present := body[key]
	if !present {
		return def, nil
	}
	value, ok := raw.(float64)
	if !ok {
		return 0, fmt.Errorf("%s must be a number", key)
	}
	if int(value) < lo || int(value) > hi {
		return 0, fmt.Errorf("%s is %d, outside the %d to %d the game accepts", key, int(value), lo, hi)
	}
	return int(value), nil
}

func parseCrevasseRange(body map[string]any, key string, lo, hi, defMin, defMax int) (int, int, error) {
	raw, present := body[key]
	if !present {
		return defMin, defMax, nil
	}
	rangeMin, rangeMax, err := parseTreeIntRange(raw, key)
	if err != nil {
		return 0, 0, err
	}
	if rangeMin < lo || rangeMax > hi {
		return 0, 0, fmt.Errorf("%s is %d to %d, outside the %d to %d the game accepts", key, rangeMin, rangeMax, lo, hi)
	}
	return rangeMin, rangeMax, nil
}

func parseCrevasseBlock(body map[string]any, key string, ctx *BuildContext) (block.ID, bool, error) {
	raw, present := body[key]
	if !present {
		return 0, false, nil
	}
	desc, err := AsBlockDescriptor(raw, key)
	if err != nil {
		return 0, false, err
	}
	id := ctx.Palette.Resolve(desc)
	if ctx.Palette.IsAir(id) {
		return 0, false, nil
	}
	return id, true, nil
}

func buildCrevasseFeature(body map[string]any, ctx *BuildContext) (wgen.PlaceableFeature, error) {
	f := &CrevasseFeature{identifier: ctx.Identifier, twistiness: 4, pal: ctx.Palette, air: ctx.Palette.Get("minecraft:air", nil)}
	var err error
	if f.maxLength, err = parseCrevasseInt(body, "max_length", 4, 16, 16); err != nil {
		return nil, err
	}
	if f.maxWidth, err = parseCrevasseInt(body, "max_width", 2, 8, 4); err != nil {
		return nil, err
	}
	if f.minFootprint, err = parseCrevasseInt(body, "min_footprint", 1, 32, 10); err != nil {
		return nil, err
	}
	if raw, present := body["twistiness"]; present {
		value, ok := raw.(float64)
		if !ok {
			return nil, fmt.Errorf("twistiness must be a number")
		}
		if value < 0 || value > 16 {
			return nil, fmt.Errorf("twistiness is %v, outside the 0 to 16 the game accepts", value)
		}
		f.twistiness = float32(value)
	}
	if f.carveMin, f.carveMax, err = parseCrevasseRange(body, "carve_depth", 4, 32, 6, 10); err != nil {
		return nil, err
	}
	if f.fillMin, f.fillMax, err = parseCrevasseRange(body, "fill_depth", 0, 32, 4, 6); err != nil {
		return nil, err
	}
	if f.surface, f.hasSurface, err = parseCrevasseBlock(body, "surface_block", ctx); err != nil {
		return nil, err
	}
	if f.fill, f.hasFill, err = parseCrevasseBlock(body, "fill_block", ctx); err != nil {
		return nil, err
	}
	return f, nil
}

func init() {
	RegisterType(crevasseTypeID, buildCrevasseFeature)
}

var _ wgen.PlaceableFeature = (*CrevasseFeature)(nil)
