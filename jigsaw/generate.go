package jigsaw

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wgen"
)

const featureType = "minecraft:jigsaw"

// Feature adapts one structure to wgen.PlaceableFeature so a run goes through the same budgets and
// diagnostics as any feature. The origin picks the chunk: the game starts a structure at the
// chunk corner and only reads the origin's chunk.
type Feature struct {
	Structure  *Structure
	Library    *Library
	Templates  *structures.Library
	Features   wgen.FeatureResolver
	WorldSeed  int64
	MinY, MaxY int
	built      map[*poolElement]*template
}

func (f *Feature) TypeID() string     { return featureType }
func (f *Feature) Identifier() string { return f.Structure.Identifier }

// Place assembles the structure and writes its pieces. It returns the start position, or nil
// when nothing was generated.
func (f *Feature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.Structure.Identifier, featureType)
	defer profiler.PopFeatureFrame()
	f.reportNotes(ctx)
	chunkX, chunkZ := floorDiv16(ctx.Origin.X), floorDiv16(ctx.Origin.Z)
	rng := newJavaRandom(0)
	rng.setLargeFeatureSeed(f.WorldSeed, chunkX, chunkZ)
	warned := map[string]bool{}
	warn := func(message string) {
		if !warned[message] {
			warned[message] = true
			warnOf(ctx, message, nil)
		}
	}
	a := &assembly{
		library: f.Library, structure: f.Structure, rng: rng, minY: f.MinY, maxY: f.MaxY, warn: warn,
		heightAt: func(x, z, kind int) int {
			if kind == heightmapOceanFloor {
				return ctx.API.GetAboveTopSolidAt(x, z)
			}
			return ctx.API.GetHeight(x, z)
		},
		resolve: func(element *poolElement) *template { return f.templateOf(element, warn) },
	}
	if err := a.assemble(chunkX, chunkZ); err != nil {
		if ctx.LogFailure != nil {
			ctx.LogFailure(featureType, fmt.Sprintf("%s generates nothing: %v", f.Structure.Identifier, err), ctx.Origin)
		}
		return nil
	}
	if len(a.pieces) == 0 {
		if ctx.LogFailure != nil {
			ctx.LogFailure(featureType, fmt.Sprintf("%s generates nothing: max_depth is %d", f.Structure.Identifier, f.Structure.MaxDepth), ctx.Origin)
		}
		return nil
	}
	start := a.pieces[0].pos
	pivot := wgen.BlockPos{X: start[0], Y: start[1], Z: start[2]}
	for _, p := range a.pieces {
		f.placePiece(ctx, p, warn)
	}
	return &pivot
}

func (f *Feature) reportNotes(ctx *wgen.PlacementContext) {
	s := f.Structure
	note := func(message string) { warnOf(ctx, message, nil) }
	if s.TerrainAdaptation != "" && s.TerrainAdaptation != "none" {
		note(fmt.Sprintf("terrain_adaptation %q is not modelled: the terrain around the pieces stays as it is", s.TerrainAdaptation))
	}
	if s.HasBiomeFilters {
		note("biome_filters are not evaluated: the bench places the structure in any biome")
	}
	if s.ApplyWaterlogging {
		note("liquid_settings apply_waterlogging is not modelled: the bench has one block layer")
	}
	if s.HasRandomAliases {
		note("random pool aliases are not modelled: each alias stays its own pool name")
	}
}

func warnOf(ctx *wgen.PlacementContext, message string, pos *wgen.BlockPos) {
	if ctx.LogWarning != nil {
		ctx.LogWarning(featureType, message, pos)
	}
}

func floorDiv16(value int) int {
	return value >> 4
}

func (f *Feature) templateOf(element *poolElement, warn func(string)) *template {
	if known, ok := f.built[element]; ok {
		return known
	}
	if f.built == nil {
		f.built = map[*poolElement]*template{}
	}
	f.built[element] = nil
	resolved := f.Templates.Resolve(structureNameFromLocation(element.location))
	if resolved == nil {
		warn(fmt.Sprintf("invalid asset path: the structure %q was not found", element.location))
		return nil
	}
	built, err := buildTemplate(resolved, f.Library.palette)
	if err != nil {
		warn(fmt.Sprintf("structure %q: %v", element.location, err))
		return nil
	}
	f.built[element] = built
	return built
}

func (f *Feature) placePiece(ctx *wgen.PlacementContext, p piece, warn func(string)) {
	switch p.element.kind {
	case elementFeature:
		f.placeFeatureElement(ctx, p, warn)
	case elementSingle:
		f.placeTemplate(ctx, p, warn)
	}
}

// placeFeatureElement runs a feature element: a twister seeded from the position.
func (f *Feature) placeFeatureElement(ctx *wgen.PlacementContext, p piece, warn func(string)) {
	feature := f.Features.Resolve(p.element.feature)
	if feature == nil {
		warn(fmt.Sprintf("feature_pool_element names %q, which is not a feature", p.element.feature))
		return
	}
	child := *ctx
	child.Origin = wgen.BlockPos{X: p.pos[0], Y: p.pos[1], Z: p.pos[2]}
	child.Random = random.New(uint32(blockPosSeed(p.pos[0], p.pos[1], p.pos[2])))
	child.Molang = nil
	feature.Place(&child)
}

// placeTemplate writes one piece: processors see
// the unrotated block at its final position, and the block state turns only afterwards.
func (f *Feature) placeTemplate(ctx *wgen.PlacementContext, p piece, warn func(string)) {
	t := f.templateOf(p.element, warn)
	if t == nil {
		return
	}
	palette := f.Library.palette
	list := f.processorsOf(p.element, warn)
	world := ctx.API
	shared := processorContext{
		pivot:   p.pos,
		palette: palette,
		worldBlockAt: func(pos [3]int) block.ID {
			return world.GetBlock(wgen.BlockPos{X: pos[0], Y: pos[1], Z: pos[2]})
		},
		heightAt: world.GetHeight,
		warn: func(message string, pos [3]int) {
			warnOf(ctx, message, &wgen.BlockPos{X: pos[0], Y: pos[1], Z: pos[2]})
		},
	}
	rotatedIDs := map[block.ID]block.ID{}
	size := t.size
	r := t.structure
	for x := 0; x < size.X; x++ {
		for y := 0; y < size.Y; y++ {
			for z := 0; z < size.Z; z++ {
				cell := x*size.Y*size.Z + y*size.Z + z
				paletteIndex := r.Layer0[cell]
				if paletteIndex < 0 {
					continue
				}
				if int(paletteIndex) >= len(r.PaletteIDs) {
					warn(fmt.Sprintf("structure %q: a cell uses palette entry %d, which does not exist", p.element.location, paletteIndex))
					continue
				}
				id := r.PaletteIDs[paletteIndex]
				local := [3]int{x, y, z}
				pos := addPos(rotatedLocal(local, p.rotation), p.pos)
				blockCtx := shared
				blockCtx.local = local
				blockCtx.world = pos
				blockCtx.blockEntity = r.BlockEntities[cell]
				kept := true
				for _, process := range list {
					if id, kept = process(id, &pos, &blockCtx); !kept {
						break
					}
				}
				if !kept {
					continue
				}
				turned, known := rotatedIDs[id]
				if !known {
					turned = palette.RotateBlock(id, p.rotation)
					rotatedIDs[id] = turned
				}
				world.SetBlock(wgen.BlockPos{X: pos[0], Y: pos[1], Z: pos[2]}, turned)
			}
		}
	}
}

func (f *Feature) processorsOf(element *poolElement, warn func(string)) []processor {
	list := []processor{dropStructureBlock, jigsawReplacement}
	if element.processorList != "" && !isEmptyProcessorName(element.processorList) {
		found, ok := f.Library.processors[element.processorList]
		if !ok {
			warn(fmt.Sprintf("processor list %q does not exist, so the piece is placed without it", element.processorList))
		}
		list = append(list, found...)
		for _, message := range f.Library.unmodelled[element.processorList] {
			warn(fmt.Sprintf("processor list %q: %s", element.processorList, message))
		}
	}
	if element.projection == projectionTerrainMatching {
		list = append(list, terrainMatching)
	}
	return list
}

func isEmptyProcessorName(name string) bool {
	return name == "minecraft:empty" || name == "empty"
}
