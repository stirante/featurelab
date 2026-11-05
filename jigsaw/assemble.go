package jigsaw

import (
	"fmt"
	"sort"

	"github.com/stirante/featurelab/nbt"
)

const (
	minInt32Bound = -0x80000000
	maxInt32Bound = 2147483646
)

var featureMarker = connector{name: "minecraft:bottom", target: "minecraft:bottom", pool: "minecraft:empty", facing: facingDown}

type piece struct {
	element  *poolElement
	pos      [3]int
	rotation int
	box      box
}

type space struct {
	region   box
	children []box
}

type queued struct {
	priority int
	sequence int
	piece    int
	space    int
	depth    int
}

type assembly struct {
	library   *Library
	structure *Structure
	rng       *javaRandom
	resolve   func(element *poolElement) *template
	heightAt  func(x, z, kind int) int
	warn      func(message string)
	minY      int
	maxY      int
	pieces    []piece
	spaces    []space
	queue     []queued
	sequence  int
}

// assemble builds the structure from its start pool. The
// returned error says why nothing generates, the way the game logs or silently gives up.
func (a *assembly) assemble(chunkX, chunkZ int) error {
	s := a.structure
	y := s.StartHeight.sample(a.rng, a.minY, a.maxY)
	pos := [3]int{chunkX * 16, y, chunkZ * 16}
	rotation := a.rng.nextInt(4)
	pool := a.library.pools[a.aliased(s.StartPool)]
	if pool == nil {
		return fmt.Errorf("no pool named %q", s.StartPool)
	}
	if len(pool.elements) == 0 {
		return fmt.Errorf("start pool %q has no elements", s.StartPool)
	}
	element := pool.elements[a.rng.nextInt(len(pool.elements))]
	if s.StartJigsawName != "" {
		anchor, ok := a.namedAnchor(element, s.StartJigsawName)
		if !ok {
			return fmt.Errorf("couldn't find anchor named %q", s.StartJigsawName)
		}
		rotated := rotatedLocal(anchor.pos, rotation)
		pos = [3]int{pos[0] - rotated[0], pos[1] - rotated[1], pos[2] - rotated[2]}
	}
	bounds := boundingBox(a.elementSize(element), pos, rotation)
	centerX := bounds.minX + halved(bounds.maxX-bounds.minX+1)
	centerZ := bounds.minZ + halved(bounds.maxZ-bounds.minZ+1)
	startY := pos[1]
	if s.Projection != heightmapNone {
		startY = a.heightAt(centerX, centerZ, s.Projection) + y
	}
	dy := startY - 1 - bounds.minY
	bounds = bounds.shiftedY(dy)
	pos[1] += dy
	if (s.PaddingBottom != 0 || s.PaddingTop != 0) && (a.minY+s.PaddingBottom > bounds.minY || a.maxY-s.PaddingTop < bounds.maxY) {
		return fmt.Errorf("the start piece does not fit between the dimension padding limits")
	}
	if s.MaxDepth <= 0 {
		return nil
	}
	a.pieces = append(a.pieces, piece{element: element, pos: pos, rotation: rotation, box: bounds})
	a.spaces = append(a.spaces, space{region: a.outerRegion(centerX, startY, centerZ)})
	a.spaces[0].children = append(a.spaces[0].children, bounds)
	a.push(0, 0, 0, 0)
	for len(a.queue) > 0 {
		a.placeChildren(a.pop())
	}
	return nil
}

func (a *assembly) outerRegion(x, y, z int) box {
	s := a.structure
	return box{
		minX: max(x-s.MaxHorizontal, minInt32Bound),
		minY: max(y-s.MaxVertical, a.minY+s.PaddingBottom),
		minZ: max(z-s.MaxHorizontal, minInt32Bound),
		maxX: min(x+s.MaxHorizontal, maxInt32Bound) + 1,
		maxY: min(a.maxY-s.PaddingTop, y+s.MaxVertical+1),
		maxZ: min(z+s.MaxHorizontal, maxInt32Bound) + 1,
	}
}

func halved(value int) int {
	if value >= 0 {
		return value >> 1
	}
	return (value + 1) >> 1
}

func (h heightProvider) sample(rng *javaRandom, minY, maxY int) int {
	low := h.min.resolve(minY, maxY)
	if !h.uniform {
		return low
	}
	high := h.max.resolve(minY, maxY)
	if high < low {
		return low
	}
	return low + rng.nextInt(high-low+1)
}

func (a heightAnchor) resolve(minY, maxY int) int {
	switch a.kind {
	case "above_bottom":
		return minY + a.value
	case "below_top":
		return maxY - 1 - a.value
	}
	return a.value
}

func (a *assembly) aliased(pool string) string {
	if target, ok := a.structure.Aliases[pool]; ok {
		return target
	}
	return pool
}

func (a *assembly) push(priority, pieceIndex, spaceIndex, depth int) {
	a.queue = append(a.queue, queued{priority: priority, sequence: a.sequence, piece: pieceIndex, space: spaceIndex, depth: depth})
	a.sequence++
}

// pop takes the highest priority first and the oldest entry among equals.
func (a *assembly) pop() queued {
	best := 0
	for i, entry := range a.queue {
		chosen := a.queue[best]
		if entry.priority > chosen.priority || (entry.priority == chosen.priority && entry.sequence < chosen.sequence) {
			best = i
		}
	}
	entry := a.queue[best]
	a.queue = append(a.queue[:best], a.queue[best+1:]...)
	return entry
}

func (a *assembly) connectors(element *poolElement) []connector {
	switch element.kind {
	case elementFeature:
		return []connector{featureMarker}
	case elementSingle:
		if t := a.resolve(element); t != nil {
			return t.connectors
		}
	}
	return nil
}

func (a *assembly) elementSize(element *poolElement) nbt.Vec3Int {
	if element.kind == elementSingle {
		if t := a.resolve(element); t != nil {
			return t.size
		}
	}
	if element.kind == elementFeature {
		return nbt.Vec3Int{X: 1, Y: 1, Z: 1}
	}
	return nbt.Vec3Int{}
}

func (a *assembly) shuffledIndexes(count int) []int {
	indexes := make([]int, count)
	for i := range indexes {
		indexes[i] = i
	}
	for n := count; n >= 2; n-- {
		j := a.rng.nextInt(n)
		indexes[n-1], indexes[j] = indexes[j], indexes[n-1]
	}
	return indexes
}

// shuffledConnectors orders a piece's jigsaw blocks for one placement.
func (a *assembly) shuffledConnectors(list []connector) []int {
	indexes := a.shuffledIndexes(len(list))
	sort.SliceStable(indexes, func(i, j int) bool {
		return list[indexes[i]].selectionPriority > list[indexes[j]].selectionPriority
	})
	return indexes
}

func (a *assembly) namedAnchor(element *poolElement, name string) (connector, bool) {
	list := a.connectors(element)
	for _, index := range a.shuffledConnectors(list) {
		if list[index].name == name {
			return list[index], true
		}
	}
	return connector{}, false
}

func isEmptyPoolName(name string) bool {
	return name == "minecraft:empty" || name == "empty"
}

// poolFor looks up the pool a connector aims at. usable is false when
// the game logs a broken pool and skips the connector.
func (a *assembly) poolFor(name string) (pool *templatePool, fallback *templatePool, usable bool) {
	name = a.aliased(name)
	pool = a.library.pools[name]
	if pool == nil || len(pool.elements) == 0 {
		if !isEmptyPoolName(name) {
			a.warn(fmt.Sprintf("empty or non-existent pool: %q", name))
			return nil, nil, false
		}
		if pool == nil {
			return nil, nil, true
		}
	}
	fallback = a.library.pools[pool.fallback]
	if fallback == nil && !isEmptyPoolName(pool.fallback) {
		a.warn(fmt.Sprintf("non-existent fallback pool: %q", pool.fallback))
		return nil, nil, false
	}
	if fallback != nil && len(fallback.elements) == 0 && !isEmptyPoolName(pool.fallback) {
		a.warn(fmt.Sprintf("empty fallback pool: %q", pool.fallback))
		return nil, nil, false
	}
	return pool, fallback, true
}

// placeChildren attaches pieces to one piece's connectors.
func (a *assembly) placeChildren(entry queued) {
	parent := a.pieces[entry.piece]
	list := a.connectors(parent.element)
	nested := -1
	for _, connectorIndex := range a.shuffledConnectors(list) {
		c := list[connectorIndex]
		front := rotatedFacing(c.facing, parent.rotation)
		position := addPos(rotatedLocal(c.pos, parent.rotation), parent.pos)
		target := addPos(position, facingStep[front])
		pool, fallback, usable := a.poolFor(c.pool)
		if !usable {
			continue
		}
		spaceIndex := entry.space
		if parent.box.containsPoint(target) {
			if nested < 0 {
				a.spaces = append(a.spaces, space{region: parent.box})
				nested = len(a.spaces) - 1
			}
			spaceIndex = nested
		}
		candidates := a.candidates(pool, fallback, entry.depth)
		a.tryCandidates(entry, parent, c, front, position, target, spaceIndex, candidates)
	}
}

func (a *assembly) candidates(pool, fallback *templatePool, depth int) []*poolElement {
	var out []*poolElement
	if pool != nil && depth != a.structure.MaxDepth {
		for _, index := range a.shuffledIndexes(len(pool.elements)) {
			out = append(out, pool.elements[index])
		}
	}
	if fallback != nil {
		for _, index := range a.shuffledIndexes(len(fallback.elements)) {
			out = append(out, fallback.elements[index])
		}
	}
	return out
}

func (a *assembly) shuffledRotations() [4]int {
	rotations := [4]int{0, 1, 2, 3}
	for n := 4; n >= 2; n-- {
		j := a.rng.nextInt(n)
		rotations[n-1], rotations[j] = rotations[j], rotations[n-1]
	}
	return rotations
}

func canAttach(parent connector, parentRotation int, parentFront int, child connector, childRotation int, ignoreName bool) bool {
	if !ignoreName && parent.target != child.name {
		return false
	}
	if facingOpposite[rotatedFacing(child.facing, childRotation)] != parentFront {
		return false
	}
	if parentFront > facingUp || !parent.aligned {
		return true
	}
	return topFace(parent, parentRotation) == topFace(child, childRotation)
}

func (a *assembly) tryCandidates(entry queued, parent piece, c connector, front int, position, target [3]int, spaceIndex int, candidates []*poolElement) {
	parentRigid := parent.element.projection == projectionRigid
	firstFree, haveFirstFree := 0, false
	relativeY := position[1] - parent.box.minY
	for _, candidate := range candidates {
		if candidate.kind == elementEmpty {
			return
		}
		list := a.connectors(candidate)
		size := a.elementSize(candidate)
		for _, rotation := range a.shuffledRotations() {
			for _, childIndex := range a.shuffledConnectors(list) {
				child := list[childIndex]
				if !canAttach(c, parent.rotation, front, child, rotation, candidate.kind == elementFeature) {
					continue
				}
				local := rotatedLocal(child.pos, rotation)
				origin := [3]int{target[0] - local[0], target[1] - local[1], target[2] - local[2]}
				bounds := boundingBox(size, origin, rotation)
				var placeY int
				if candidate.projection == projectionRigid && parentRigid {
					placeY = relativeY + facingStep[front][1] - local[1] + parent.box.minY
				} else {
					if !haveFirstFree {
						firstFree = a.heightAt(position[0], position[2], heightmapWorldSurface)
						haveFirstFree = true
					}
					placeY = firstFree - local[1]
				}
				dy := placeY - bounds.minY
				bounds = bounds.shiftedY(dy)
				if !a.fits(spaceIndex, bounds) {
					continue
				}
				a.spaces[spaceIndex].children = append(a.spaces[spaceIndex].children, bounds)
				origin[1] += dy
				a.pieces = append(a.pieces, piece{element: candidate, pos: origin, rotation: rotation, box: bounds})
				if entry.depth < a.structure.MaxDepth {
					a.push(c.placementPriority, len(a.pieces)-1, spaceIndex, entry.depth+1)
				}
				return
			}
		}
	}
}

func (a *assembly) fits(spaceIndex int, bounds box) bool {
	target := a.spaces[spaceIndex]
	if !target.region.containsBox(bounds) {
		return false
	}
	for _, child := range target.children {
		if child.intersects(bounds) {
			return false
		}
	}
	return true
}

func addPos(a, b [3]int) [3]int {
	return [3]int{a[0] + b[0], a[1] + b[1], a[2] + b[2]}
}
