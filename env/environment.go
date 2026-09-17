package env

import (
	"fmt"
	"math"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
)

// EnvironmentID names one of the presets ENVIRONMENTS below defines.
type EnvironmentID string

const (
	EnvVoid                 EnvironmentID = "void"
	EnvUndergroundStone     EnvironmentID = "underground_stone"
	EnvUndergroundDeepslate EnvironmentID = "underground_deepslate"
	EnvUndergroundMixed     EnvironmentID = "underground_mixed"
	EnvPlains               EnvironmentID = "plains"
	EnvForest               EnvironmentID = "forest"
	EnvDesert               EnvironmentID = "desert"
	EnvOcean                EnvironmentID = "ocean"
	EnvNether               EnvironmentID = "nether"
	EnvEnd                  EnvironmentID = "end"
)

// EnvironmentDefaults is a preset's default volume shape. minX/minZ are
// not part of this: session.Generate derives those from the configured
// origin, under its "volume follows the origin" rule.
type EnvironmentDefaults struct {
	SizeX, SizeY, SizeZ int
	MinY                int
}

// MaterialSlots is the six fields Bedrock's minecraft:surface_builder
// component exposes, and the vocabulary a preset's own native terrain is
// recast in terms of. The full "material slots -> terrain builder" pipeline:
// source 1 is a preset's own EnvironmentPreset.Materials below, source 2 is
// a loaded pack biome's surface_builder -- resolved outside this package,
// see MergeMaterialSlots's doc comment for the seam -- and source 3 is
// MaterialOverride, always available and always winning per-field over
// whichever of 1/2 is active.
type MaterialSlots struct {
	TopMaterial        string
	MidMaterial        string
	FoundationMaterial string
	SeaFloorMaterial   string
	SeaMaterial        string
	SeaFloorDepth      float64
}

// ResolvedMaterials is MaterialSlots with every block name interned to a
// block.ID -- what an EnvironmentPreset.Build actually consumes. Built once
// per generation by InternMaterialSlots.
type ResolvedMaterials struct {
	Top, Mid, Foundation, SeaFloor, Sea block.ID
	SeaFloorDepth                       int
}

// midMaterialDepth (env/plains.go) is the depth of the mid_material band
// below top_material before falling through to foundation_material -- the
// game's ~3-6 noise-varied range, without reproducing the noise
// itself.

// MaterialOverride is a per-field partial MaterialSlots -- source 3 of
// MaterialSlots's own pipeline doc comment. A field left nil falls back to
// whichever of source 1 (a preset's native MaterialSlots) / source 2 (a
// loaded pack biome -- resolved outside this package, which feeds its
// surface_builder into MergeMaterialSlots as `base` the same way a preset's
// native slots do) is active.
type MaterialOverride struct {
	TopMaterial        *string
	MidMaterial        *string
	FoundationMaterial *string
	SeaFloorMaterial   *string
	SeaMaterial        *string
	SeaFloorDepth      *float64
}

// MergeMaterialSlots merges an override onto a base: override wins
// per-field; a nil override returns base unchanged.
func MergeMaterialSlots(base MaterialSlots, override *MaterialOverride) MaterialSlots {
	if override == nil {
		return base
	}
	out := base
	if override.TopMaterial != nil {
		out.TopMaterial = *override.TopMaterial
	}
	if override.MidMaterial != nil {
		out.MidMaterial = *override.MidMaterial
	}
	if override.FoundationMaterial != nil {
		out.FoundationMaterial = *override.FoundationMaterial
	}
	if override.SeaFloorMaterial != nil {
		out.SeaFloorMaterial = *override.SeaFloorMaterial
	}
	if override.SeaMaterial != nil {
		out.SeaMaterial = *override.SeaMaterial
	}
	if override.SeaFloorDepth != nil {
		out.SeaFloorDepth = *override.SeaFloorDepth
	}
	return out
}

// InternMaterialSlots interns every block-name slot into palette, warning
// (never rejecting) for a name this tool doesn't recognize -- see
// block.IsKnownBlockName's doc comment for exactly what "recognized" means
// here. A typo'd or addon-private material still resolves (as
// minecraft:air's neighbouring placeholder id would in a renderer), it
// just doesn't look like a silent, unremarked success. warn
// may be nil to skip the recognized-name check entirely.
func InternMaterialSlots(palette *block.Palette, slots MaterialSlots, warn func(message string)) ResolvedMaterials {
	intern := func(field, name string) block.ID {
		if warn != nil {
			trimmed := strings.TrimSpace(name)
			canonical := trimmed
			if !strings.Contains(trimmed, ":") {
				canonical = "minecraft:" + trimmed
			}
			if !block.IsKnownBlockName(canonical) {
				warn(fmt.Sprintf("%s %q is not a block this tool recognizes — it will render as a placeholder colour", field, name))
			}
		}
		return palette.Get(name, nil)
	}
	depth := int(math.Round(slots.SeaFloorDepth))
	if depth < 0 {
		depth = 0
	}
	return ResolvedMaterials{
		Top:           intern("topMaterial", slots.TopMaterial),
		Mid:           intern("midMaterial", slots.MidMaterial),
		Foundation:    intern("foundationMaterial", slots.FoundationMaterial),
		SeaFloor:      intern("seaFloorMaterial", slots.SeaFloorMaterial),
		Sea:           intern("seaMaterial", slots.SeaMaterial),
		SeaFloorDepth: depth,
	}
}

// EnvironmentPreset is one synthetic test environment.
type EnvironmentPreset struct {
	ID          EnvironmentID
	Label       string
	Description string
	Defaults    EnvironmentDefaults
	// Materials is this preset's own native material identity -- source 1
	// of MaterialSlots's pipeline (see that type's doc comment). Every
	// preset has one, even presets (void, nether, end) whose Build doesn't
	// model a top/mid/foundation split -- for those, all three point at the
	// same single material, so overriding any of them still does
	// something visible.
	Materials MaterialSlots
	// BuildsSea is true for a preset whose Build actually models a sea: a
	// sea_material column, a sea_floor_material seabed, and a sea_floor_depth
	// band under it. "ocean" alone. Everything else ignores all
	// three sea slots, and a caller that sets one gets told so rather than
	// watching it do nothing -- see InertSeaSlotOverrides (landform.go).
	BuildsSea bool
	// Landform is what this preset's Build promises to produce, checked against
	// what it actually produced -- see the Landform type (landform.go) for the
	// two silent degenerations this exists to catch and why the check has to be
	// per preset rather than blanket.
	Landform Landform
	Build    func(v *volume.Volume, seed int32, materials ResolvedMaterials)
	// DefaultOriginY is the default Y for the feature's placement origin.
	// Surface presets sit the origin on the ground; underground presets
	// bury it mid-volume.
	DefaultOriginY func(v *volume.Volume) int
	// Biome/BiomeTags are this preset's default query.has_biome_tag/
	// any_tag/all_tags identity -- the exact minecraft:tags component
	// arrays from the real shipped vanilla *.biome.json files.
	Biome     string
	BiomeTags []string
}

// --- helpers shared by the preset builders below ---------------------------

// undergroundDefaults/surfaceDefaults are the two default volume shapes
// every preset below picks from.
var undergroundDefaults = EnvironmentDefaults{SizeX: 32, SizeY: 48, SizeZ: 32, MinY: -32}
var surfaceDefaults = EnvironmentDefaults{SizeX: 32, SizeY: 48, SizeZ: 32, MinY: 44}

// nativeSlots is shorthand for a preset's native MaterialSlots --
// seaFloorMaterial/seaMaterial default to plain gravel/water since most
// presets never touch either field, but every preset still needs *some*
// value there (no preset besides "void" ever overrides the sea defaults).
func nativeSlots(top, mid, foundation string) MaterialSlots {
	return MaterialSlots{
		TopMaterial: top, MidMaterial: mid, FoundationMaterial: foundation,
		SeaFloorMaterial: "minecraft:gravel", SeaMaterial: "minecraft:water", SeaFloorDepth: 0,
	}
}

// --- presets -----------------------------------------------------------

// ENVIRONMENTS is every preset this package defines, in presentation order.
var ENVIRONMENTS = []EnvironmentPreset{
	{
		ID:          EnvVoid,
		Label:       "Void",
		Description: "Nothing at all. Shows exactly which blocks the feature writes, with no environment interaction.",
		Defaults:    EnvironmentDefaults{SizeX: 32, SizeY: 48, SizeZ: 32, MinY: -8},
		Materials: MaterialSlots{
			TopMaterial: "minecraft:air", MidMaterial: "minecraft:air", FoundationMaterial: "minecraft:air",
			SeaFloorMaterial: "minecraft:air", SeaMaterial: "minecraft:air", SeaFloorDepth: 0,
		},
		// Promises nothing, deliberately -- "nothing at all" is the whole
		// preset, so an all-air bench is the correct result and the landform
		// check must never fire here (see the Landform type's own doc comment
		// for why a blanket air/solid rule would be wrong).
		Landform: Landform{},
		Build:    func(v *volume.Volume, seed int32, materials ResolvedMaterials) {},
		DefaultOriginY: func(v *volume.Volume) int {
			return v.MinY() + v.SizeY()/3
		},
		// No tags at all -- matches this preset's own "no environment
		// interaction" purpose: a feature relying on has_biome_tag should
		// visibly fail/no-op here, not silently match something.
		Biome:     "void",
		BiomeTags: []string{},
	},
	{
		ID:          EnvUndergroundStone,
		Label:       "Underground — stone",
		Description: "Solid stone with scattered ore blobs. For ore features and anything that carves.",
		Defaults:    EnvironmentDefaults{SizeX: 32, SizeY: 48, SizeZ: 32, MinY: 8},
		Materials:   nativeSlots("minecraft:stone", "minecraft:stone", "minecraft:stone"),
		// Solid by design and open space is NOT promised: an all-stone bench is
		// exactly what "solid stone" means, and a feature that carves makes its
		// own.
		Landform: Landform{Solid: true, Advice: "This preset fills the entire volume, so an empty bench means the volume itself has no cells to fill -- check --size."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			b := loadBlocks(v)
			solidFill(v, func(x, y, z int) block.ID { return materials.Foundation })
			scatterOres(v, seed, b, materials.Foundation, b.Deepslate)
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.MinY() + v.SizeY()/2 },
		// Caves don't have a distinct biome identity in this simulator --
		// they inherit whatever surface biome sits above them, so this
		// reuses 'plains' (the default surface preset).
		Biome:     "plains",
		BiomeTags: []string{"animal", "monster", "overworld", "plains", "bee_habitat"},
	},
	{
		ID:          EnvUndergroundDeepslate,
		Label:       "Underground — deepslate",
		Description: "Solid deepslate with deepslate ore variants, at vanilla deep-cave depth.",
		Defaults:    EnvironmentDefaults{SizeX: 32, SizeY: 48, SizeZ: 32, MinY: -56},
		// This preset's whole point is demonstrating deepslate depth, so
		// its native "foundation" IS deepslate (unlike every other preset,
		// where foundation means "the stone-like fill").
		Materials: nativeSlots("minecraft:deepslate", "minecraft:deepslate", "minecraft:deepslate"),
		Landform:  Landform{Solid: true, Advice: "This preset fills the entire volume, so an empty bench means the volume itself has no cells to fill -- check --size."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			b := loadBlocks(v)
			solidFill(v, func(x, y, z int) block.ID {
				if y <= v.MinY() {
					return b.Bedrock
				}
				return materials.Foundation
			})
			scatterOres(v, seed, b, b.Stone, materials.Foundation)
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.MinY() + v.SizeY()/2 },
		Biome:          "plains",
		BiomeTags:      []string{"animal", "monster", "overworld", "plains", "bee_habitat"},
	},
	{
		ID:          EnvUndergroundMixed,
		Label:       "Underground — stone/deepslate transition",
		Description: "Spans y=0 so you can see how a feature behaves across the deepslate boundary.",
		Defaults:    undergroundDefaults,
		Materials:   nativeSlots("minecraft:stone", "minecraft:stone", "minecraft:stone"),
		Landform:    Landform{Solid: true, Advice: "This preset fills the entire volume, so an empty bench means the volume itself has no cells to fill -- check --size."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			b := loadBlocks(v)
			solidFill(v, func(x, y, z int) block.ID {
				return stoneOrDeepslate(seed, x, y, z, b, materials.Foundation)
			})
			scatterOres(v, seed, b, materials.Foundation, b.Deepslate)
		},
		DefaultOriginY: func(v *volume.Volume) int { return 0 },
		Biome:          "plains",
		BiomeTags:      []string{"animal", "monster", "overworld", "plains", "bee_habitat"},
	},
	{
		ID:          EnvPlains,
		Label:       "Plains",
		Description: "Gently rolling grass over dirt and stone. The default for surface features.",
		Defaults:    surfaceDefaults,
		Materials:   nativeSlots("minecraft:grass_block", "minecraft:dirt", "minecraft:stone"),
		Landform:    Landform{Solid: true, Air: true, Advice: "Terrain is built at a fixed world height (around y=63) and clamped into the volume, so a --min-y well above or below that, or a very short --size Y, can leave the bench all sky or all ground: bring --min-y back towards the preset default (44) and give --size Y room for the surface."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			b := loadBlocks(v)
			buildPlainsColumns(v, seed, b, materials.Top, materials.Mid, materials.Foundation)
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.GetHeight(0, 0) },
		Biome:          "plains",
		BiomeTags:      []string{"animal", "monster", "overworld", "plains", "bee_habitat"},
	},
	{
		ID:          EnvForest,
		Label:       "Forest",
		Description: "Plains terrain scattered with oak trees, for testing features that must fit around cover.",
		Defaults:    EnvironmentDefaults{SizeX: surfaceDefaults.SizeX, SizeY: 56, SizeZ: surfaceDefaults.SizeZ, MinY: surfaceDefaults.MinY},
		Materials:   nativeSlots("minecraft:grass_block", "minecraft:dirt", "minecraft:stone"),
		Landform:    Landform{Solid: true, Air: true, Advice: "Terrain is built at a fixed world height (around y=63) and clamped into the volume, so a --min-y well above or below that, or a very short --size Y, can leave the bench all sky or all ground: bring --min-y back towards the preset default (44) and give --size Y room for the surface."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			b := loadBlocks(v)
			buildPlainsColumns(v, seed, b, materials.Top, materials.Mid, materials.Foundation)
			// Trees are fixed oak scenery, not part of the material-slots
			// vocabulary -- unaffected by materials. Seed derivation goes
			// through random.DeriveSeed's own single documented scheme
			// (random/derive.go) -- DomainEnvForestTrees is registered there
			// as a LEGACY domain reproducing this exact `seed ^ 0x7a3e`
			// formula bit for bit, so this migration changes nothing about
			// which trees a given seed produces.
			rng := NewEnvRandom(random.DeriveSeed(uint32(seed), random.DomainEnvForestTrees))
			trees := int(math.Round(float64(v.SizeX()*v.SizeZ()) / 70))
			for i := 0; i < trees; i++ {
				x := v.MinX() + 2 + rng.NextIntBound(maxInt(1, v.SizeX()-4))
				z := v.MinZ() + 2 + rng.NextIntBound(maxInt(1, v.SizeZ()-4))
				// Keep a clear ring around the origin so the feature under
				// test stays visible.
				if absInt(x) <= 3 && absInt(z) <= 3 {
					continue
				}
				plantOakTree(v, rng, x, v.GetHeight(x, z)-1, z, b)
			}
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.GetHeight(0, 0) },
		Biome:          "forest",
		BiomeTags:      []string{"animal", "forest", "monster", "overworld", "bee_habitat"},
	},
	{
		ID:          EnvDesert,
		Label:       "Desert",
		Description: "Sand over sandstone over stone. For cactus, dead bush, well and dune-relative features.",
		Defaults:    surfaceDefaults,
		Materials:   nativeSlots("minecraft:sand", "minecraft:sand", "minecraft:stone"),
		Landform:    Landform{Solid: true, Air: true, Advice: "Terrain is built at a fixed world height (around y=64) and clamped into the volume, so a --min-y well above or below that, or a very short --size Y, can leave the bench all sky or all ground: bring --min-y back towards the preset default (44) and give --size Y room for the surface."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			b := loadBlocks(v)
			for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
				for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
					top := surfaceHeight(v, seed, x, z, 64, 3)
					// The sandstone band (y > top-9) is fixed desert
					// scenery, not one of the six editable slots --
					// top_material/mid_material still drive the sand above
					// it, and foundation_material still drives the plain
					// stone/deepslate below it.
					buildColumn(v, x, z, top, materials.Top, materials.Mid, midMaterialDepth, func(y int) block.ID {
						if y > top-9 {
							return b.Sandstone
						}
						return stoneOrDeepslate(seed, x, y, z, b, materials.Foundation)
					})
				}
			}
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.GetHeight(0, 0) },
		Biome:          "desert",
		BiomeTags: []string{
			"desert", "monster", "overworld",
			"spawns_gold_rabbits", "spawns_warm_variant_farm_animals", "spawns_warm_variant_frogs",
		},
	},
	{
		ID:          EnvOcean,
		Label:       "Ocean floor",
		Description: "Sand and gravel seabed under a full water column, for underwater features.",
		Defaults:    EnvironmentDefaults{SizeX: surfaceDefaults.SizeX, SizeY: 48, SizeZ: surfaceDefaults.SizeZ, MinY: 30},
		Materials:   nativeSlots("minecraft:sand", "minecraft:sand", "minecraft:stone"),
		// The one preset with a sea, so the one preset for which
		// sea_material/sea_floor_material/sea_floor_depth mean anything --
		// everywhere else those three are reported inert rather than silently
		// ignored (see EnvironmentPreset.BuildsSea and InertSeaSlotOverrides).
		BuildsSea: true,
		// Flooded by design: the water column runs to sea level, so a bench with
		// no air in it is this preset working, not failing. Solid is promised --
		// "seabed" is the half a feature stands on.
		Landform: Landform{Solid: true, Advice: "The seabed is built around y=48 under a water column that runs to y=62, so a --min-y above the water line leaves the bench with no seabed in it: bring --min-y back towards the preset default (30) and give --size Y room for the seabed."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			b := loadBlocks(v)
			const seaLevel = 62
			for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
				for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
					top := surfaceHeight(v, seed, x, z, 48, 3)
					rock := func(y int) block.ID {
						return stoneOrDeepslate(seed, x, y, z, b, materials.Foundation)
					}
					// sea_floor_depth, honoured: a real band of
					// sea_floor_material that many blocks thick, measured DOWN
					// from the seabed surface, which is the plain reading of the
					// name and of Bedrock's minecraft:surface_builder.
					//
					// Depth 0 -- every preset's native value, so every default
					// run -- keeps the 25% single-block dither this preset has
					// always used to speckle gravel through the sand, and the
					// output is byte for byte what it was before the slot did
					// anything. A positive depth means the author asked for a
					// real band, so the band replaces the dither rather than
					// fighting it: dithering the surface of a deliberate
					// three-block gravel bed would just make the bed look
					// broken.
					if materials.SeaFloorDepth > 0 {
						buildSeabedColumn(v, x, z, top, materials.SeaFloor, materials.Mid, materials.SeaFloorDepth, 3, rock)
					} else {
						surface := materials.Top
						if hashNoise2D(seed^0x9c1, x, z) < 0.25 {
							surface = materials.SeaFloor
						}
						buildColumn(v, x, z, top, surface, materials.Mid, 3, rock)
					}
					yTop := seaLevel
					if v.MaxY()-1 < yTop {
						yTop = v.MaxY() - 1
					}
					for y := top + 1; y <= yTop; y++ {
						v.SetBlockAt(x, y, z, materials.Sea)
					}
				}
			}
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.GetHeight(0, 0) },
		Biome:          "ocean",
		BiomeTags:      []string{"monster", "ocean", "overworld"},
	},
	{
		ID:          EnvNether,
		Label:       "Nether",
		Description: "Solid netherrack with a hollowed cavern, for nether-pass features.",
		Defaults:    EnvironmentDefaults{SizeX: 32, SizeY: 48, SizeZ: 32, MinY: 24},
		Materials:   nativeSlots("minecraft:netherrack", "minecraft:netherrack", "minecraft:netherrack"),
		// "Solid netherrack with a hollowed cavern" is a promise of BOTH, and
		// the cavern is the half that vanishes: floor and ceiling below are
		// hardcoded offsets from the volume's own edges, and they cross.
		Landform: Landform{Solid: true, Air: true, Advice: "The cavern is carved from 12 blocks above the volume floor to 8 below its ceiling, so those two cross once --size Y reaches 20 and the netherrack closes up completely; the floor's noise eats a few rows more on top of that. Raise --size Y (the default is 48; below 22 no cavern survives at all, and it is only a sliver for some way above that), or pick a different --env."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			floor := v.MinY() + 12
			ceiling := v.MaxY() - 8
			b := loadBlocks(v)
			solidFill(v, func(x, y, z int) block.ID {
				if y >= floor && y < ceiling {
					return b.Air
				}
				return materials.Foundation
			})
			for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
				for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
					top := int(math.Round(float64(floor)+fractalNoise2D(seed, x, z, 16)*4)) - 1
					for y := v.MinY(); y <= top; y++ {
						v.SetBlockAt(x, y, z, materials.Foundation)
					}
				}
			}
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.GetHeight(0, 0) },
		// Bedrock's nether biome keeps its legacy id `hell`.
		Biome: "hell",
		BiomeTags: []string{
			"nether", "nether_wastes", "spawn_endermen", "spawn_few_piglins", "spawn_ghast",
			"spawn_magma_cubes", "spawns_nether_mobs", "spawn_zombified_piglin", "spawns_warm_variant_farm_animals",
		},
	},
	{
		ID:          EnvEnd,
		Label:       "End island",
		Description: "A floating end-stone island surrounded by void, for sky-pass features.",
		Defaults:    EnvironmentDefaults{SizeX: 32, SizeY: 48, SizeZ: 32, MinY: 44},
		Materials:   nativeSlots("minecraft:end_stone", "minecraft:end_stone", "minecraft:end_stone"),
		// "A floating end-stone island surrounded by void" promises both, and
		// this is the preset that loses the island: the distance below is
		// measured from world (0,0) while the bench follows --origin, so the
		// island stays put and the bench walks away from it.
		Landform: Landform{Solid: true, Air: true, Advice: "This island is measured from world (0,0) while the bench follows --origin, so an origin more than about min(sizeX, sizeZ) * 0.42 blocks away (roughly 13 at the default 32x48x32) leaves the bench floating in empty void beside it. Move --origin back towards 0, widen --size, or pick an --env whose ground follows the origin -- every other preset's does."},
		Build: func(v *volume.Volume, seed int32, materials ResolvedMaterials) {
			centreY := v.MinY() + v.SizeY()/2
			radius := math.Min(float64(v.SizeX()), float64(v.SizeZ())) * 0.42
			for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
				for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
					d := math.Hypot(float64(x)+0.5, float64(z)+0.5)
					wobble := fractalNoise2D(seed, x, z, 10) * 3
					if d > radius+wobble-1.5 {
						continue
					}
					thickness := int(math.Max(1, math.Round((1-d/(radius+wobble))*7)))
					for y := centreY - thickness; y <= centreY; y++ {
						v.SetBlockAt(x, y, z, materials.Foundation)
					}
				}
			}
		},
		DefaultOriginY: func(v *volume.Volume) int { return v.GetHeight(0, 0) },
		Biome:          "the_end",
		BiomeTags:      []string{"the_end", "spawns_cold_variant_farm_animals", "spawns_cold_variant_frogs"},
	},
}

var environmentsByID = func() map[EnvironmentID]*EnvironmentPreset {
	m := make(map[EnvironmentID]*EnvironmentPreset, len(ENVIRONMENTS))
	for i := range ENVIRONMENTS {
		m[ENVIRONMENTS[i].ID] = &ENVIRONMENTS[i]
	}
	return m
}()

// GetEnvironment looks up a preset by id. ok is false for an id no preset
// defines, so a caller can fail loudly with its own diagnostic instead of a
// panic reaching all the way out of a library call.
func GetEnvironment(id EnvironmentID) (EnvironmentPreset, bool) {
	p, ok := environmentsByID[id]
	if !ok {
		return EnvironmentPreset{}, false
	}
	return *p, true
}

func absInt(a int) int {
	if a < 0 {
		return -a
	}
	return a
}
