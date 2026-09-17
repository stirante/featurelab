package env

import (
	"math"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
)

// Blocks is the small set of interned ids environment building needs.
type Blocks struct {
	Air, Stone, Deepslate, Dirt, Grass, Sand, Sandstone, Water, Gravel, Bedrock, Netherrack, EndStone, Log, Leaves block.ID
}

func loadBlocks(v *volume.Volume) Blocks {
	p := v.RawPalette()
	get := func(name string) block.ID { return p.Get(name, nil) }
	return Blocks{
		Air: get("minecraft:air"), Stone: get("minecraft:stone"), Deepslate: get("minecraft:deepslate"),
		Dirt: get("minecraft:dirt"), Grass: get("minecraft:grass_block"), Sand: get("minecraft:sand"),
		Sandstone: get("minecraft:sandstone"), Water: get("minecraft:water"), Gravel: get("minecraft:gravel"),
		Bedrock: get("minecraft:bedrock"), Netherrack: get("minecraft:netherrack"), EndStone: get("minecraft:end_stone"),
		Log: get("minecraft:oak_log"), Leaves: get("minecraft:oak_leaves"),
	}
}

// stoneOrDeepslate picks the foundation stone by depth: deepslate
// below y=0, stoneBlock above y=8, hash-dithered transition in between.
func stoneOrDeepslate(seed int32, x, y, z int, b Blocks, stoneBlock block.ID) block.ID {
	if y >= 8 {
		return stoneBlock
	}
	if y < 0 {
		return b.Deepslate
	}
	t := float64(y) / 8
	if hashNoise2D(seed^int32(y*0x9e37), x, z) < t {
		return stoneBlock
	}
	return b.Deepslate
}

type oreSpec struct {
	stone, deepslate string
	density, maxSize int
	minY, maxY       int
}

var overworldOres = []oreSpec{
	{"coal_ore", "deepslate_coal_ore", 14, 14, -32, 192},
	{"copper_ore", "deepslate_copper_ore", 8, 12, -16, 96},
	{"iron_ore", "deepslate_iron_ore", 10, 10, -48, 128},
	{"gold_ore", "deepslate_gold_ore", 3, 8, -64, 32},
	{"redstone_ore", "deepslate_redstone_ore", 5, 9, -64, 15},
	{"lapis_ore", "deepslate_lapis_ore", 2, 7, -64, 32},
	{"diamond_ore", "deepslate_diamond_ore", 2, 6, -64, 16},
}

// scatterOres scatters ore veins through the foundation (its own
// EnvRandom stream, independent of any feature's RNG). Seed derivation goes
// through random.DeriveSeed's own single documented scheme (random/
// derive.go) -- DomainEnvOreScatter is registered there as a LEGACY domain
// reproducing this exact `seed ^ 0x0e5e` formula bit for bit, so this
// migration changes nothing about which ore blobs a given seed produces.
func scatterOres(v *volume.Volume, seed int32, b Blocks, stoneHost, deepslateHost block.ID) {
	rng := NewEnvRandom(random.DeriveSeed(uint32(seed), random.DomainEnvOreScatter))
	footprints := float64(v.SizeX()*v.SizeZ()) / (32 * 32)
	if footprints < 1 {
		footprints = 1
	}
	p := v.RawPalette()
	for _, spec := range overworldOres {
		stoneOre := p.Get("minecraft:"+spec.stone, nil)
		deepslateOre := p.Get("minecraft:"+spec.deepslate, nil)
		blobs := int(math.Round(float64(spec.density) * footprints))
		if blobs < 1 {
			blobs = 1
		}
		for i := 0; i < blobs; i++ {
			cx := v.MinX() + rng.NextIntBound(v.SizeX())
			cz := v.MinZ() + rng.NextIntBound(v.SizeZ())
			yLow := maxInt(v.MinY(), spec.minY)
			yHigh := minInt(v.MaxY()-1, spec.maxY)
			if yHigh < yLow {
				continue
			}
			cy := yLow + rng.NextIntBound(yHigh-yLow+1)
			size := 3 + rng.NextIntBound(spec.maxSize-2)
			radius := math.Cbrt(float64(size)) * 0.8
			r := int(math.Ceil(radius))
			for dy := -r; dy <= r; dy++ {
				for dz := -r; dz <= r; dz++ {
					for dx := -r; dx <= r; dx++ {
						if float64(dx*dx+dy*dy+dz*dz) > radius*radius {
							continue
						}
						x, y, z := cx+dx, cy+dy, cz+dz
						host := v.GetBlockAt(x, y, z)
						if host == stoneHost {
							v.SetBlockAt(x, y, z, stoneOre)
						} else if host == deepslateHost {
							v.SetBlockAt(x, y, z, deepslateOre)
						}
					}
				}
			}
		}
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// surfaceHeight is a rounded surface height from fractal noise, clamped
// inside the volume.
func surfaceHeight(v *volume.Volume, seed int32, x, z int, base, amplitude float64) int {
	n := fractalNoise2D(seed, x, z, 24)*0.65 + fractalNoise2D(seed^0x5bd1, x, z, 7)*0.35
	y := int(math.Round(base + (n-0.5)*2*amplitude))
	if y < v.MinY() {
		y = v.MinY()
	}
	if y > v.MaxY()-2 {
		y = v.MaxY() - 2
	}
	return y
}

// buildColumn builds a terrain column: surface block, soil band, then
// bedrock-capped stone.
func buildColumn(v *volume.Volume, x, z, top int, surface, soil block.ID, soilDepth int, rock func(y int) block.ID) {
	for y := v.MinY(); y <= top; y++ {
		switch {
		case y == top:
			v.SetBlockAt(x, y, z, surface)
		case y > top-soilDepth:
			v.SetBlockAt(x, y, z, soil)
		default:
			v.SetBlockAt(x, y, z, rock(y))
		}
	}
}

// buildSeabedColumn is buildColumn with a sea-floor band on top of it: the
// topmost floorDepth blocks of the column are sea_floor_material, then the
// usual mid_material band of soilDepth blocks, then rock. Used by the "ocean"
// preset when sea_floor_depth is set -- see that preset's Build for why depth 0
// keeps the older surface dither instead of coming through here.
//
// The band is measured DOWN from the seabed surface (top), so
// sea_floor_depth: 3 means the three blocks a diver would dig through, not
// three blocks somewhere below the sand.
func buildSeabedColumn(v *volume.Volume, x, z, top int, seaFloor, soil block.ID, floorDepth, soilDepth int, rock func(y int) block.ID) {
	for y := v.MinY(); y <= top; y++ {
		switch {
		case y > top-floorDepth:
			v.SetBlockAt(x, y, z, seaFloor)
		case y > top-floorDepth-soilDepth:
			v.SetBlockAt(x, y, z, soil)
		default:
			v.SetBlockAt(x, y, z, rock(y))
		}
	}
}

const midMaterialDepth = 4

// BuildPlains builds the "plains" preset with its native material slots
// (top=grass_block, mid=dirt, foundation=stone) — the
// one environment the golden-digest test recipe uses. Shares its column
// loop (buildPlainsColumns, env/scenery.go) with the "plains"/"forest"
// entries in ENVIRONMENTS, which pass resolved (possibly overridden)
// materials through the same code path instead of these hardcoded natives.
func BuildPlains(v *volume.Volume, seed int32) {
	b := loadBlocks(v)
	buildPlainsColumns(v, seed, b, b.Grass, b.Dirt, b.Stone)
}

// PlainsBounds is the golden-digest recipe's fixed volume bounds.
var PlainsBounds = volume.Bounds{MinX: -16, MinY: 44, MinZ: -16, SizeX: 32, SizeY: 48, SizeZ: 32}

// PlainsBiomeID/PlainsBiomeTags are the plains preset's biome identity —
// the exact minecraft:plains.biome.json tags component.
const PlainsBiomeID = "plains"

var PlainsBiomeTags = []string{"animal", "monster", "overworld", "plains", "bee_habitat"}

// DefaultOriginY is the plains preset's default origin Y: v.GetHeight(0, 0).
func DefaultOriginY(v *volume.Volume) int { return v.GetHeight(0, 0) }
