// Package jigsaw loads data-driven jigsaw structures (worldgen/ folders of a behavior pack),
// assembles them the way the game does and places the pieces.
// Behaviour follows Bedrock 1.26.70.21.
package jigsaw

import (
	"github.com/stirante/featurelab/block"
)

const unlimitedDistance = 0x7FFFFFFF

const (
	projectionRigid = iota
	projectionTerrainMatching
)

const (
	heightmapNone = iota
	heightmapWorldSurface
	heightmapOceanFloor
)

type elementKind int

const (
	elementEmpty elementKind = iota
	elementSingle
	elementFeature
)

type poolElement struct {
	kind          elementKind
	location      string
	feature       string
	processorList string
	projection    int
}

type templatePool struct {
	identifier string
	fileID     string
	fallback   string
	elements   []*poolElement
}

type heightAnchor struct {
	kind  string
	value int
}

type heightProvider struct {
	uniform  bool
	min, max heightAnchor
}

type Structure struct {
	Identifier        string
	FileID            string
	StartPool         string
	StartJigsawName   string
	MaxDepth          int
	StartHeight       heightProvider
	Projection        int
	PaddingBottom     int
	PaddingTop        int
	MaxHorizontal     int
	MaxVertical       int
	Aliases           map[string]string
	HasRandomAliases  bool
	TerrainAdaptation string
	ApplyWaterlogging bool
	HasBiomeFilters   bool
	Step              string
}

type structureSet struct {
	identifier string
	fileID     string
	structures []string
}

// predicate is one input_predicate or location_predicate of a rule processor.
type predicate func(id block.ID, palette *block.Palette, rng *javaRandom) bool

type positionTest func(world, pivot [3]int, rng *javaRandom) bool

type rule struct {
	input    predicate
	location predicate
	position positionTest
	output   block.Descriptor
}

// processorContext is what one block being placed shows to processors.
type processorContext struct {
	local        [3]int
	world        [3]int
	pivot        [3]int
	blockEntity  map[string]any
	palette      *block.Palette
	worldBlockAt func(pos [3]int) block.ID
	heightAt     func(x, z int) int
	warn         func(message string, pos [3]int)
}

// processor changes the block about to be placed or drops it by returning false.
type processor func(id block.ID, world *[3]int, ctx *processorContext) (block.ID, bool)
