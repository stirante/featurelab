// underwater_cave.go ports minecraft:underwater_cave_carver_feature. It reuses almost all of
// features/cave.go: the underwater carver differs from the dry one in exactly two methods, its
// carveable-block test and its ellipsoid volume carve, and inherits everything else.
//
// THREE ENGINE CAPABILITIES THIS BENCH ALREADY HAS. The volume carve reaches for three things the
// bench's own world API does not expose under those names; all three collapse to values or calls
// this bench already has, so none of them is a genuinely unresolvable dependency:
//
//  1. The local water level. In production it IGNORES the position it is given and returns the
//     dimension's stored sea level -- 63 for the overworld. So the Y-band gate below is a plain
//     scalar parameter (UnderwaterCaveOverworldSeaLevel), not a callback. The engine reads it
//     three times per position (a skip-gate, the magma/obsidian band and the lava band); this port
//     reads the same constant once, since it never varies by position.
//  2. An in-bounds test: a three-axis 0<=c<dims test against the finite generation volume --
//     exactly what wgen.BlockWorld.Contains already does for this bench.
//  3. A block-level air test, which compares the block against air -- exactly what
//     wgen.IPaletteView.IsAir already does.
//
// PORT SHAPE. The underwater carver behaves exactly like the dry carver in its placement, room,
// tunnel and carve-shape steps; only the volume carve differs. So:
//
//   - UnderwaterCaveFeature.Place, below, is a deliberate byte-identical COPY of CaveFeature.Place
//     (cave.go) -- not independently re-derived, because there is nothing to re-derive: the game
//     behaves identically for both types. Go has no virtual dispatch to hang a shared implementation
//     off of without fighting the TypeID()/Identifier() override this type also needs, so the
//     duplication is deliberate, not an oversight.
//   - CaveAddFeature/CaveAddRoom/CaveAddTunnel are called with CaveConfiguration1_18 UNCHANGED.
//     That is safe because the configuration's carveable-block and surface tests are read ONLY
//     inside CaveCarveBlock, which this type's volume carve never calls, while the tunnel
//     thickness, tunnel length and vertical-position draws -- the three configuration fields the
//     carve-shape, room and tunnel steps DO read -- are the same for every carver in this family
//     regardless of concrete type.
//   - The only real divergence is carveVolume: NewUnderwaterCaveEllipsoidVolume, below. It shares
//     the dry carver's loop shape (X ascending outer, Z ascending, Y descending inner, the same
//     horizontal pre-test and the same inside-test) but never calls CaveCarveBlock at all -- so
//     the dry carve's thin-sand capping, grass relocation and legacy ocean-abort are dead code for
//     every carve this type performs.
//
// THE FULL PER-POSITION ALGORITHM. y here is the CARVE row, one ABOVE the ellipsoid-test row,
// exactly like the dry carver:
//
//	if y >= seaLevel { skip }                              // capability 1, collapsed to a scalar
//	blockAt := api.GetBlock(pos)
//	if !UnderwaterCaveIsDiggable(pal, blockAt) { skip }     // this type's own block list
//	if !oceanConfirmed {                                    // persists across the WHOLE call
//	    if ctx.Biome has the "ocean" tag { oceanConfirmed = true } else { abandon this column }
//	}
//	switch {
//	case y == seaLevel-53:                                  // literal 53, exact
//	    r := rnd.NextFloat()                                 // *** THE ONLY RNG DRAW, this band only
//	    SetBlock(pos, r < 0.25 ? Magma : Obsidian)            // 0.25 exact
//	case y <= seaLevel-54:                                   // literal 54, exact
//	    SetBlock(pos, Lava)                                   // no draw
//	default:
//	    for each of north(z-1)/south(z+1)/west(x-1)/east(x+1), in order:
//	        if api.Contains(neighbourPos) {                   // capability 2
//	            if pal.IsAir(api.GetBlock(pos)) {               // capability 3 -- NOTE: re-fetches
//	                                                             // the CURRENT position's own
//	                                                             // block, not the neighbour's
//	                SetBlock(pos, replaceAirWith)
//	                goto done
//	            }
//	        }
//	    SetBlock(pos, fillWith)   // no in-bounds neighbour, or none read as air
//	}
//
// With overworld seaLevel=63: the magma (25%) / obsidian (75%) layer is y=10, lava fills y<=9, and
// the ordinary digging band (the switch's default case) is y in [11,62].
//
// replace_air_with is a NINTH, OPTIONAL JSON field, on top of the eight the dry carver's schema
// accepts. It is not required and defaults to null, so CaveNoFill represents its omitted/null state
// exactly, just as it does for fill_with.
//
// The underwater carver never uses the carve cache, so the game always runs the placement's
// UNCACHED branch for this type -- this port's uncached architecture is the game's own path here,
// not merely an equivalent one (see cave.go's "PLACEMENT, AND THE CACHE THIS PORT DOES NOT MODEL").
package features

import (
	"fmt"
	"math"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

// UnderwaterCaveOverworldSeaLevel is the production overworld sea level -- see this file's
// header, capability 1. This bench only ever models the overworld (there is no Nether or End
// dimension concept anywhere in this codebase), so buildUnderwaterCaveFeature always uses this
// constant.
//
// setUnlessNull writes id at pos unless id is CaveNoFill, the sentinel standing for a null block
// -- which is what BOTH of this type's block-valued JSON fields hold when omitted. `fill_with`
// and `replace_air_with` are each optional with a null default.
//
// Without this, an omitted field reached api.SetBlock as block.ID(-1) and the real palette PANICKED
// -- "block id is not in the palette" -- on a file the game's own loader accepts. That is not a
// divergence, it is a crash, and it was reachable from a two-line JSON file.
//
// Skipping the write rather than refusing the file at build time is the sibling's answer, applied
// here. `CaveCarveBlock` guards the identical sentinel at features/cave.go's own
// `if fillWith != CaveNoFill`: the game null-checks the block before writing, so an omitted
// `fill_with` carves everything else and never overwrites the position itself. That the
// underwater carver's volume carve guards the same way is an ASSUMPTION, resting on three
// things: the field is deliberately OPTIONAL with a null default, a shipped game does not
// dereference a null on a legal file, and the sibling in the same type family does exactly
// this. If the game turns out to refuse the file instead, the fix is a build-time
// refusal like the Nether carver's required `fill_with`, and this becomes the wrong shape rather
// than the wrong place.
func setUnlessNull(api wgen.BlockWorld, pos wgen.BlockPos, id block.ID) {
	if id == CaveNoFill {
		return
	}
	api.SetBlock(pos, id)
}

// UnderwaterCaveOverworldSeaLevel is the sea level of the only dimension this bench models.
// NewUnderwaterCaveEllipsoidVolume takes seaLevel as an explicit parameter so that a caller
// modelling a different dimension is a pure data change, not a rewrite.
const UnderwaterCaveOverworldSeaLevel = 63

// underwaterMagmaObsidianOffset / underwaterLavaOffset are the two literal depth-below-sea-level
// offsets the volume carve uses verbatim, 53 and 54 -- see this file's header.
// underwaterMagmaChance is the exact threshold: NextFloat() < 0.25 -> magma (25%), else
// obsidian (75%).
const (
	underwaterMagmaObsidianOffset = 53
	underwaterLavaOffset          = 54
	underwaterMagmaChance         = 0.25
)

// underwaterCaveCarverTypeID is minecraft:underwater_cave_carver_feature's own TypeID.
const underwaterCaveCarverTypeID = "minecraft:underwater_cave_carver_feature"

// underwaterGroupTerracotta mirrors the game's terracotta block group, which holds exactly
// these 16 entries: the plain coloured terracottas, with glazed terracotta absent.
var underwaterGroupTerracotta = newCaveNameSet(
	"minecraft:white_terracotta", "minecraft:orange_terracotta",
	"minecraft:magenta_terracotta", "minecraft:light_blue_terracotta",
	"minecraft:yellow_terracotta", "minecraft:lime_terracotta",
	"minecraft:pink_terracotta", "minecraft:gray_terracotta",
	"minecraft:light_gray_terracotta", "minecraft:cyan_terracotta",
	"minecraft:purple_terracotta", "minecraft:blue_terracotta",
	"minecraft:brown_terracotta", "minecraft:green_terracotta",
	"minecraft:red_terracotta", "minecraft:black_terracotta",
)

// underwaterDiggableNamed is the underwater carver's own individually-named block list --
// podzol, grass_block, mycelium, gravel and dirt_with_roots survive from the dry carver's own
// caveDiggableNamed; hardened_clay, water, flowing_water, lava, flowing_lava, obsidian and air
// are ADDED. Compared with CaveIsDiggable1_18's own 21-name list, this DROPS eleven ore/mineral
// names: snow_layer,
// packed_ice, deepslate, calcite, tuff, iron_ore, deepslate_iron_ore, raw_iron_block, copper_ore,
// deepslate_copper_ore, raw_copper_block -- a real, substantively different predicate, not "the dry
// list plus water".
var underwaterDiggableNamed = newCaveNameSet(
	"minecraft:podzol", "minecraft:grass_block", "minecraft:mycelium", "minecraft:gravel",
	"minecraft:dirt_with_roots", "minecraft:hardened_clay",
	"minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava",
	"minecraft:obsidian", "minecraft:air",
)

// UnderwaterCaveIsDiggable mirrors the underwater carver's carveable-block test. It takes ONE
// block and reads no instance state: the volume carve applies it to the block AT the position
// being carved. It is NOT plugged
// into CaveCarverConfig.IsDiggable the way CaveCarveBlock's own gate is -- that field stays
// CaveIsDiggable1_18 for every carver in this family, dry or underwater, because this test's only
// caller anywhere is the volume carve below.
//
// true iff blockAt is stone, OR a member of the dirt group (cave.go's caveGroupDirt), OR one of
// the individually-named blocks above, OR a member of the terracotta group, OR a member of the
// sandstone, red-sandstone or sand groups (cave.go's caveGroupSandstone, caveGroupRedSandstone
// and caveGroupSand, reused unchanged -- these four block-id groups are shared with the dry
// carver, not re-derived).
func UnderwaterCaveIsDiggable(pal wgen.IPaletteView, blockAt block.ID) bool {
	name := pal.NameOf(blockAt)
	if name == "minecraft:stone" {
		return true
	}
	if caveGroupDirt.has(pal, blockAt) {
		return true
	}
	if _, ok := underwaterDiggableNamed[name]; ok {
		return true
	}
	if underwaterGroupTerracotta.has(pal, blockAt) ||
		caveGroupSandstone.has(pal, blockAt) ||
		caveGroupRedSandstone.has(pal, blockAt) ||
		caveGroupSand.has(pal, blockAt) {
		return true
	}
	return false
}

// underwaterNeighbourOffset is one of the four chunk-local X/Z deltas the neighbour test below
// checks. Y is the axis that is NEVER varied -- see this file's header.
type underwaterNeighbourOffset struct{ dx, dz int }

// underwaterNeighbourOffsets is NORTH (z-1), SOUTH (z+1), WEST (x-1), EAST (x+1), in that exact
// order -- the order the volume carve rebuilds the four neighbour positions in.
var underwaterNeighbourOffsets = [4]underwaterNeighbourOffset{
	{dx: 0, dz: -1}, // north
	{dx: 0, dz: 1},  // south
	{dx: -1, dz: 0}, // west
	{dx: 1, dz: 0},  // east
}

// NewUnderwaterCaveEllipsoidVolume returns a CaveEllipsoidVolumeFunc mirroring the underwater
// carver's own ellipsoid volume carve -- see this file's header for the full per-position
// algorithm. config is accepted to match the CaveEllipsoidVolumeFunc signature shared with the
// dry carver, but is genuinely UNUSED here: this carve never calls CaveCarveBlock, the only consumer of the carver configuration's
// carveable-block, surface and legacy fields.
//
// seaLevel is capability 1, collapsed to a plain parameter -- pass
// UnderwaterCaveOverworldSeaLevel (63) for the only production dimension this bench models.
// fillWith/replaceAirWith are the "fill_with" field, shared with the dry carver, and
// "replace_air_with", which only this type has. CaveNoFill represents the null default of
// either.
//
// RNG cadence: EXACTLY ONE rnd.NextFloat() draw per candidate position, and ONLY on the
// y==seaLevel-53 band. There are no other draws anywhere in this function.
func NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith block.ID, seaLevel int) CaveEllipsoidVolumeFunc {
	return func(
		ctx *wgen.PlacementContext,
		config CaveCarverConfig,
		rnd random.IRandom,
		chunk CaveChunkPos,
		center CaveVec3,
		bounds CaveBoundingBox,
		radiusXZ, radiusY float32,
		params CaveCarvingParameters,
	) bool {
		_ = config // genuinely unused -- see this function's own doc comment
		api := ctx.API
		pal := api.Palette()
		lava := pal.Resolve(block.NameDescriptor("minecraft:lava"))
		obsidian := pal.Resolve(block.NameDescriptor("minecraft:obsidian"))
		magma := pal.Resolve(block.NameDescriptor("minecraft:magma"))

		worldOriginX := chunk.X * 16
		worldOriginZ := chunk.Z * 16

		// oceanConfirmed persists across the WHOLE call, exactly like the dry carver's own
		// isUnderwaterCarve accumulator -- once any one position confirms the biome is
		// ocean-tagged, every later column skips the check entirely.
		oceanConfirmed := false
		warnedNoBiome := false

		for x := bounds.MinX; x < bounds.MaxX; x++ {
			worldX := x + worldOriginX
			dx := (float32(worldX) + 0.5 - center.X) / radiusXZ
			for z := bounds.MinZ; z < bounds.MaxZ; z++ {
				worldZ := z + worldOriginZ
				dz := (float32(worldZ) + 0.5 - center.Z) / radiusXZ
				// float32() per product: FMA barriers -- gc contracts dx*dx+dz*dz
				// into one FMADDS on arm64. See cave.go's CaveFloatRangeValue.
				if float32(dx*dx)+float32(dz*dz) >= 1 {
					continue
				}

			yLoop:
				// y is the ELLIPSOID-TEST row; the position actually read, gated and written is ONE
				// ABOVE it (carveY = y+1), and the sea-level gate and both depth bands key off carveY,
				// not y. The engine keeps the carve row one iteration behind the test row here exactly
				// as the dry carver does. Carved rows span [MinY+1 .. MaxY].
				for y := bounds.MaxY - 1; y >= bounds.MinY; y-- {
					dy := (float32(y) + 0.5 - center.Y) / radiusY
					if dy <= params.FloorLevel {
						continue
					}
					// float32() per product: FMA barriers, as above.
					if float32(dx*dx)+float32(dy*dy)+float32(dz*dz) >= 1 {
						continue
					}
					carveY := y + 1

					// Capability 1, the local water level: production ignores the position and always
					// returns the dimension sea level, so only positions strictly below it are ever
					// touched.
					if carveY >= seaLevel {
						continue
					}

					pos := wgen.BlockPos{X: worldX, Y: carveY, Z: worldZ}
					blockAt := api.GetBlock(pos)
					if !UnderwaterCaveIsDiggable(pal, blockAt) {
						continue
					}

					if !oceanConfirmed {
						if ctx.Biome != nil {
							if _, ok := ctx.Biome.Tags[oceanBiomeTag]; ok {
								oceanConfirmed = true
							}
						} else if !warnedNoBiome {
							warnedNoBiome = true
							LogWarning(ctx, underwaterCaveCarverTypeID,
								"no biome was supplied for this placement; the real engine's own "+
									"per-position ocean biome-tag check, which abandons the whole "+
									"column when it fails, can never "+
									"pass without one, so this carve will place nothing -- see "+
									"features/underwater_cave.go's own doc comment", nil)
						}
						if !oceanConfirmed {
							// Column-abandon: the engine's own per-position ocean biome-tag
							// test coming back false abandons this column's WHOLE remaining Y
							// descent, not just this position.
							break yLoop
						}
					}

					switch {
					case carveY == seaLevel-underwaterMagmaObsidianOffset:
						r := float32(rnd.NextFloat()) // *** RNG CALL, exactly once, this band only ***
						fillBlock := obsidian
						if r < underwaterMagmaChance {
							fillBlock = magma
						}
						api.SetBlock(pos, fillBlock)
					case carveY <= seaLevel-underwaterLavaOffset:
						api.SetBlock(pos, lava)
					default:
						// Capabilities 2 and 3, the in-bounds test and the block air test: the
						// first in-bounds neighbour (in NORTH/SOUTH/WEST/EAST order -- see this
						// file's header) whose CURRENT position, not the neighbour's, reads as
						// air gets replaceAirWith; otherwise fillWith. Ported as the literal
						// four-check loop even though this bench's own bounds math makes at
						// least one neighbour always in-bounds here.
						filled := false
						for _, off := range underwaterNeighbourOffsets {
							npos := wgen.BlockPos{X: pos.X + off.dx, Y: pos.Y, Z: pos.Z + off.dz}
							if api.Contains(npos) {
								cur := api.GetBlock(pos)
								if pal.IsAir(cur) {
									setUnlessNull(api, pos, replaceAirWith)
									filled = true
									break
								}
							}
						}
						if !filled {
							setUnlessNull(api, pos, fillWith)
						}
					}
				}
			}
		}
		// Always true, matching the dry carver, whose volume carve returns true on every exit.
		// For this type that is an assumption by analogy -- disclosed rather than silently
		// presumed.
		return true
	}
}

// UnderwaterCaveFeature is minecraft:underwater_cave_carver_feature. See this file's header for
// the shared behaviour that makes Place, below, a deliberate byte-identical copy of
// CaveFeature.Place (cave.go) rather than an independent port.
type UnderwaterCaveFeature struct {
	identifier string

	ellipsoidCfg CaveEllipsoidConfig
	roomCfg      CaveRoomConfig
	featureCfg   CaveFeatureConfig
	carveVolume  CaveEllipsoidVolumeFunc
}

func (f *UnderwaterCaveFeature) TypeID() string     { return underwaterCaveCarverTypeID }
func (f *UnderwaterCaveFeature) Identifier() string { return f.identifier }

// Place mirrors the dry cave carver's placement routine, which this type inherits outright --
// see this file's header for why that means identical code rather than a divergent override,
// and cave.go's "PLACEMENT, AND THE CACHE THIS PORT DOES NOT MODEL" section for the full
// seed-mixing derivation this copy relies on.
func (f *UnderwaterCaveFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, underwaterCaveCarverTypeID)
	defer profiler.PopFeatureFrame()

	rnd := ctx.Random
	baseSeed := rnd.GetSeed() // the stored seed -- no draw
	// Both multipliers use the family's Java odd-maker form -- see carverOddMaker and
	// CaveFeature.Place, whose code this is.
	a := carverOddMaker(rnd.NextInt()) // *** RNG CALL 1 ***
	b := carverOddMaker(rnd.NextInt()) // *** RNG CALL 2 ***

	chunkX := ctx.Origin.X >> 4 // building a chunk position from a block position -- see cave.go
	chunkZ := ctx.Origin.Z >> 4
	target := CaveChunkPos{X: chunkX, Z: chunkZ}

	for ncx := chunkX - 8; ncx <= chunkX+8; ncx++ {
		for ncz := chunkZ - 8; ncz <= chunkZ+8; ncz++ {
			TickDeadline("carving the 17x17 chunk neighbourhood a carver reaches into")
			neighbourSeed := uint32(int32(ncx))*a + uint32(int32(ncz))*b
			neighbourSeed ^= baseSeed
			rnd.SetSeed(neighbourSeed) // *** RNG CALL, reseeds the SAME object, every neighbour ***

			// CaveConfiguration1_18 UNCHANGED -- every concrete type in this family, dry or
			// underwater, runs through the SAME carver configuration; only carveVolume differs
			// here. See this file's header.
			CaveAddFeature(ctx, CaveConfiguration1_18, f.ellipsoidCfg, f.roomCfg, f.featureCfg, rnd,
				target, CaveChunkPos{X: ncx, Z: ncz}, nil, f.carveVolume, nil)
		}
	}

	origin := ctx.Origin
	return &origin
}

// buildUnderwaterCaveFeature parses minecraft:underwater_cave_carver_feature's JSON body: the
// same eight fields buildCaveFeature parses (fill_with, width_modifier, skip_carve_chance,
// height_limit, y_scale, horizontal_radius_multiplier, vertical_radius_multiplier, floor_level,
// with the same defaults, which carry over because this type shares the schema),
// plus the ninth, optional field only this type has, replace_air_with.
func buildUnderwaterCaveFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	fillWith := CaveNoFill
	if fillRaw, ok := body["fill_with"]; ok {
		fillDesc, err := AsBlockDescriptor(fillRaw, "fill_with")
		if err != nil {
			return nil, err
		}
		fillWith = ctx.Palette.Resolve(fillDesc)
	}

	replaceAirWith := CaveNoFill
	if replaceAirRaw, ok := body["replace_air_with"]; ok {
		replaceAirDesc, err := AsBlockDescriptor(replaceAirRaw, "replace_air_with")
		if err != nil {
			return nil, err
		}
		replaceAirWith = ctx.Palette.Resolve(replaceAirDesc)
	}

	widthModifier := constMolang(0)
	if widthRaw, ok := body["width_modifier"]; ok {
		expr, err := ParseMolangValue(widthRaw)
		if err != nil {
			return nil, fmt.Errorf("width_modifier: %w", err)
		}
		if expr.program != nil && caveWidthModifierUsesRandom(expr.program) && ctx.Warn != nil {
			ctx.Warn("width_modifier: this expression contains math.random/math.random_integer/" +
				"math.die_roll/math.die_roll_integer. In the game, those functions in THIS field " +
				"draw from a generator shared across the whole engine that is never seeded, so the " +
				"same world and the same seed give a different width_modifier every time. There is " +
				"nothing stable there to reproduce. This tool instead evaluates the expression " +
				"against a generator derived from your master seed, so the same seed always " +
				"previews the same cave. Use a constant width_modifier if you need the preview and " +
				"the game to agree -- see the identical warning on the overworld cave carver for " +
				"the full explanation.")
		}
		widthModifier = expr
	}

	intField := func(key string) (int, error) {
		raw, ok := body[key]
		if !ok {
			return 0, nil // default -- see this func's own doc comment
		}
		f, ok := toFloat(raw)
		// A value that does not fit in an int is refused here too, and that is not a second check --
		// it closes the only hole in the one above. `f != float64(int(f))` is meant to reject
		// anything that does not survive the conversion, and math.MinInt64 is the single
		// out-of-range value that converts to itself and round-trips back, so it sails through.
		// It is also what Go's implementation-defined float64->int conversion produces on amd64
		// for EVERY number outside int64's range, so `1e300` arrives here as exactly that.
		//
		// What it did then depended on the field. As `skip_carve_chance` or `height_limit` it
		// reached the engine's bounded integer draw as a bound whose low 32 bits are zero and
		// divided by zero,
		// panicking the process (random.Rand.NextIntBound has since narrowed that test to the
		// engine's own 32 bits, so it no longer panics -- it produces a carve whose Y bounds are
		// nonsense and which grinds indefinitely instead). Neither outcome is worth reproducing,
		// and neither is anything the engine can do: its own field is a 32-bit int that could
		// never hold this value in the first place.
		if !ok || f != float64(int(f)) || int(f) == math.MinInt64 {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		return int(f), nil
	}
	skipCarveChance, err := intField("skip_carve_chance")
	if err != nil {
		return nil, err
	}
	WarnExplicitZeroSkipCarveChance(body, skipCarveChance, ctx)
	heightLimit, err := intField("height_limit")
	if err != nil {
		return nil, err
	}

	floatRange := func(key string) (min, max float32, err error) {
		raw, ok := body[key]
		if !ok {
			return 0, 0, nil // default {0,0} -- see this func's own doc comment
		}
		lo, hi, err := parseCaveFloatRange(raw, key)
		if err != nil {
			return 0, 0, err
		}
		return lo, hi, nil
	}
	yScaleMin, yScaleMax, err := floatRange("y_scale")
	if err != nil {
		return nil, err
	}
	horizMin, horizMax, err := floatRange("horizontal_radius_multiplier")
	if err != nil {
		return nil, err
	}
	vertMin, vertMax, err := floatRange("vertical_radius_multiplier")
	if err != nil {
		return nil, err
	}
	floorMin, floorMax, err := floatRange("floor_level")
	if err != nil {
		return nil, err
	}

	carveVolume := NewUnderwaterCaveEllipsoidVolume(fillWith, replaceAirWith, UnderwaterCaveOverworldSeaLevel)

	return &UnderwaterCaveFeature{
		identifier:   ctx.Identifier,
		ellipsoidCfg: CaveEllipsoidConfig{HeightLimit: heightLimit},
		roomCfg: CaveRoomConfig{
			WidthModifier: widthModifier,
			YScaleMin:     yScaleMin,
			YScaleMax:     yScaleMax,
			// CachingEnabled deliberately always false -- same "honest, uncached path" choice as
			// buildCaveFeature, see cave.go PHASE 9's own "ARCHITECTURE DECISION".
			CachingEnabled: false,
		},
		featureCfg: CaveFeatureConfig{
			SkipCarveChance:               skipCarveChance,
			HorizontalRadiusMultiplierMin: horizMin,
			HorizontalRadiusMultiplierMax: horizMax,
			VerticalRadiusMultiplierMin:   vertMin,
			VerticalRadiusMultiplierMax:   vertMax,
			FloorLevelMin:                 floorMin,
			FloorLevelMax:                 floorMax,
		},
		carveVolume: carveVolume,
	}, nil
}

func init() {
	RegisterType(underwaterCaveCarverTypeID, buildUnderwaterCaveFeature)
}

var _ wgen.IFeature = (*UnderwaterCaveFeature)(nil)
