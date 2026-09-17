// nether_cave.go ports minecraft:nether_cave_carver_feature. It is deliberately NOT built on
// CaveAddFeature/CaveAddTunnel: the nether carver owns its own placement, carve-shape, room and
// tunnel steps, with a different draw cadence, a different walk and an inline carve.
//
// The two carvers are close enough to invite sharing and different enough that sharing would be
// wrong. Two of the differences are easy to miss:
//
//   - This carver's five trigonometry calls all go through the engine's own sine and cosine
//     tables (see enginemath.go), while the overworld carver's structurally identical
//     walk calls plain libm at the same five points. The split is per class and there is no way
//     to guess it.
//   - This carver writes its fill block with NO null check, unlike the overworld carver, which
//     is why `fill_with` is REQUIRED here and optional
//     there -- see buildNetherCaveFeature.
package features

import (
	"fmt"
	"math"

	molang "github.com/stirante/molang-go"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"
)

const (
	netherCaveCarverTypeID = "minecraft:nether_cave_carver_feature"
	netherCaveRange        = 8
	netherCaveCountBound   = 10
	netherCaveYBound       = 128
	netherCaveRoomBound    = 4
	netherCaveTunnelBound  = 4
	netherCaveDecayBound   = 6
	netherCaveCarveBound   = 4
)

type NetherCaveFeatureConfig struct {
	FillWith                                                     block.ID
	WidthModifier                                                *MolangExpr
	SkipCarveChance                                              int
	HorizontalRadiusMultiplierMin, HorizontalRadiusMultiplierMax float32
	VerticalRadiusMultiplierMin, VerticalRadiusMultiplierMax     float32
	FloorLevelMin, FloorLevelMax                                 float32
}

type NetherCaveFeature struct {
	identifier string
	config     NetherCaveFeatureConfig
}

func (f *NetherCaveFeature) TypeID() string     { return netherCaveCarverTypeID }
func (f *NetherCaveFeature) Identifier() string { return f.identifier }

// carverOddMaker is Java's nextInt/2*2+1 after truncation toward zero: the engine implements the
// division adjustment as an increment on a negative value, then sets the low bit. It is the
// odd-maker form EVERY carver's placement routine uses -- the overworld carver, and therefore the
// underwater carver that inherits it, included.
//
// The negative branch is dead code on every reachable input: the engine's core
// unbounded integer draw is an unsigned right shift of one raw draw, so it is never negative and
// carverOddMaker(v) == uint32(v)|1 for every real draw. Kept in this form because it is what the
// engine computes, and because it stays correct if a future IRandom ever yields negatives.
func carverOddMaker(v int32) uint32 {
	if v < 0 {
		v++
	}
	return uint32(v) | 1
}

// Place mirrors the nether cave carver's placement routine. It always returns an engaged origin.
func (f *NetherCaveFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, netherCaveCarverTypeID)
	defer profiler.PopFeatureFrame()

	rnd := ctx.Random
	baseSeed := rnd.GetSeed()
	a := carverOddMaker(rnd.NextInt()) // draw 1
	b := carverOddMaker(rnd.NextInt()) // draw 2

	chunkX := ctx.Origin.X >> 4
	chunkZ := ctx.Origin.Z >> 4
	target := CaveChunkPos{X: chunkX, Z: chunkZ}
	for ncx := chunkX - netherCaveRange; ncx <= chunkX+netherCaveRange; ncx++ {
		for ncz := chunkZ - netherCaveRange; ncz <= chunkZ+netherCaveRange; ncz++ {
			TickDeadline("carving the chunk neighbourhood a carver reaches into")
			seed := uint32(int32(ncx))*a + uint32(int32(ncz))*b
			rnd.SetSeed(seed ^ baseSeed)
			NetherCaveAddFeature(ctx, f.config, rnd, target, CaveChunkPos{X: ncx, Z: ncz})
		}
	}
	origin := ctx.Origin
	return &origin
}

func netherSampleRange(min, max float32, rnd random.IRandom) float32 {
	if min == max {
		return min
	}
	// The inner float32() is an FMA barrier: `min + d*(max-min)` is the shape Go
	// may contract into a single FMA (one rounding where the engine has two), and
	// gc does on arm64 -- confirmed by FMADDS in `GOARCH=arm64 go build -gcflags=-S`
	// before this conversion existed. See cave.go's CaveFloatRangeValue for the full
	// note; TestCarversHaveNoFusedMultiplyAdd pins it.
	return min + float32(float32(rnd.NextFloat())*(max-min))
}

type netherCaveRoomFunc func(*wgen.PlacementContext, NetherCaveFeatureConfig, random.IRandom, CaveChunkPos, CaveVec3, CaveCarvingParameters)
type netherCaveTunnelFunc func(*wgen.PlacementContext, NetherCaveFeatureConfig, random.IRandom, CaveChunkPos, CaveVec3, float32, float32, float32, int, int, float32, CaveCarvingParameters)

// NetherCaveAddFeature mirrors the nether cave carver's carve-shape step. The three range samples
// intentionally precede the early-out, and tunnel parameters are redrawn per round.
func NetherCaveAddFeature(ctx *wgen.PlacementContext, cfg NetherCaveFeatureConfig, rnd random.IRandom, target, source CaveChunkPos) {
	netherCaveAddFeatureWith(ctx, cfg, rnd, target, source, NetherCaveAddRoom, NetherCaveAddTunnel)
}

func netherCaveAddFeatureWith(ctx *wgen.PlacementContext, cfg NetherCaveFeatureConfig, rnd random.IRandom, target, source CaveChunkPos, addRoom netherCaveRoomFunc, addTunnel netherCaveTunnelFunc) {
	v1 := rnd.NextIntBound(netherCaveCountBound)
	v2 := rnd.NextIntBound(v1 + 1)
	count := rnd.NextIntBound(v2 + 1)
	skip := rnd.NextIntBound(cfg.SkipCarveChance)
	floor := netherSampleRange(cfg.FloorLevelMin, cfg.FloorLevelMax, rnd)
	horizontal := netherSampleRange(cfg.HorizontalRadiusMultiplierMin, cfg.HorizontalRadiusMultiplierMax, rnd)
	vertical := netherSampleRange(cfg.VerticalRadiusMultiplierMin, cfg.VerticalRadiusMultiplierMax, rnd)
	params := CaveCarvingParameters{
		HorizontalRadiusMultiplier: horizontal,
		VerticalRadiusMultiplier:   vertical,
		FloorLevel:                 floor,
	}
	if skip != 0 || count < 1 {
		return
	}

	for i := 0; i < count; i++ {
		TickDeadline("carving one chunk's worth of carver rooms and tunnels")
		z := source.Z*16 + rnd.NextIntBound(16)
		y := rnd.NextIntBound(netherCaveYBound)
		x := source.X*16 + rnd.NextIntBound(16)
		center := CaveVec3{X: float32(x), Y: float32(y), Z: float32(z)}

		rounds := 1
		if rnd.NextIntBound(netherCaveRoomBound) == 0 {
			addRoom(ctx, cfg, rnd, target, center, params)
			tr := rnd.NextIntBound(netherCaveTunnelBound)
			if tr < 0 {
				continue
			}
			rounds = tr + 1
		}

		for round := 0; round < rounds; round++ {
			// float32(): FMA barrier. `x*pi*2` is all multiplies and still fuses --
			// gc strength-reduces the *2 into an add and contracts the pi multiply
			// into it. Checked in gc's own arm64 output, not reasoned about.
			yaw := float32(float32(rnd.NextFloat())*float32(math.Pi)) * 2
			pitch := (float32(rnd.NextFloat()) - 0.5) * 2 / 8
			t1 := float32(rnd.NextFloat()) * 2
			t2 := float32(rnd.NextFloat())
			thickness := (t1 + t2) * 2
			addTunnel(ctx, cfg, rnd, target, center, thickness, yaw, pitch, 0, 0, 0.5, params)
		}
	}
}

func netherCaveCarveThisStep(room bool, rnd random.IRandom) bool {
	return room || rnd.NextIntBound(netherCaveCarveBound) != 0
}

// NetherCaveAddRoom mirrors the nether cave carver's room step: one caller-generator draw.
func NetherCaveAddRoom(ctx *wgen.PlacementContext, cfg NetherCaveFeatureConfig, rnd random.IRandom, chunk CaveChunkPos, center CaveVec3, params CaveCarvingParameters) {
	thickness := 1 + float32(float32(rnd.NextFloat())*6) // inner float32(): FMA barrier
	NetherCaveAddTunnel(ctx, cfg, rnd, chunk, center, thickness, 0, 0, -1, -1, 0.5, params)
}

func netherCaveDiggable(pal wgen.IPaletteView, id block.ID) bool {
	name := pal.NameOf(id)
	return name == "minecraft:netherrack" || name == "minecraft:grass_block" || caveGroupDirt.has(pal, id)
}

// netherCaveHasLava takes WORLD-space X/Z bounds. The engine's own scan is chunk-local, but
// featurelab's block API is world-space, so the caller adds the chunk origin before calling.
func netherCaveHasLava(ctx *wgen.PlacementContext, xLo, xHi, yLo, yHi, zLo, zHi int) bool {
	pal := ctx.API.Palette()
	isLava := func(x, y, z int) bool {
		if uint32(y) > 127 { // raw unsigned 0x7f guard
			return false
		}
		name := pal.NameOf(ctx.API.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}))
		return name == "minecraft:lava" || name == "minecraft:flowing_lava"
	}

	for x := xLo; x <= xHi; x++ {
		for z := zLo; z <= zHi; z++ {
			edge := x == xLo || x == xHi || z == zLo || z == zHi
			if edge {
				for y := yHi + 2; y >= yLo-2; y-- {
					if isLava(x, y, z) {
						return true
					}
				}
				continue
			}
			if isLava(x, yHi+2, z) || isLava(x, yLo-1, z) || isLava(x, yLo-2, z) {
				return true
			}
		}
	}
	return false
}

// NetherCaveAddTunnel mirrors the nether cave carver's tunnel step. It takes exactly one draw
// from rnd to seed its local generator; recursion chains by passing that local generator on.
func NetherCaveAddTunnel(
	ctx *wgen.PlacementContext,
	cfg NetherCaveFeatureConfig,
	rnd random.IRandom,
	chunk CaveChunkPos,
	center CaveVec3,
	thickness, yaw, pitch float32,
	startStep, distance int,
	scale float32,
	params CaveCarvingParameters,
) {
	localRnd := random.New(uint32(rnd.NextInt()))
	if distance <= 0 {
		distance = 112 - localRnd.NextIntBound(28)
	}
	half := distance / 2
	step := startStep
	if startStep == -1 {
		step = half
	}
	branchStep := localRnd.NextIntBound(half) + distance/4
	decaySelector := localRnd.NextIntBound(netherCaveDecayBound)
	if step >= distance {
		return
	}

	room := startStep == -1
	decay := float32(0.7)
	if decaySelector == 0 {
		decay = 0.92
	}
	turnA, turnB := float32(0), float32(0)
	pos := center
	chunkCenterX := chunk.X*16 + 8
	chunkCenterZ := chunk.Z*16 + 8
	// Built ONCE for the whole walk, deliberately -- see caveMolangContext -- so successive
	// per-step draws advance through one stream. And built only when the expression will read
	// it: a constant width_modifier, by far the common case, never touches the context, and
	// seeding a generator per walk for nothing was measurably a tenth of a carve.
	var molangCtx *molang.Context
	if !cfg.WidthModifier.IsConstant() {
		molangCtx = caveMolangContext(ctx, localRnd.GetSeed())
	}

	for {
		// One step is at most one bounded ellipsoid carve (chunk-local X/Z, Y clamped to 2..119),
		// so the thing worth bounding is the NUMBER of steps -- see cave.go's CaveAddTunnel for
		// the same reasoning at more length. NetherCaveAddRoom reaches this loop too (it is a
		// one-shot call into this same walk), so it needs no separate tick of its own.
		TickDeadline("walking a carver tunnel")
		// EngineSin/EngineCos, NOT math.Sin: this carver's five trig calls
		// all go through the engine's own sine and cosine tables -- 65536
		// entries each, see enginemath.go. This differs from cave.go, whose
		// otherwise identical walk uses plain libm.
		//
		// The multiply-then-divide order below is the engine's own.
		taper := EngineSin(float32(step) * float32(math.Pi) / float32(distance))
		widthModifier := float32(cfg.WidthModifier.Evaluate(molangCtx))
		// float32(): FMA barriers throughout this walk -- see netherSampleRange.
		// radiusY's own product is wrapped too: gc otherwise sinks it into the
		// `pos.Y -/+ radiusY` bounds below and emits FMSUBS/FMADDS there.
		radiusXZ := float32(taper*(thickness+widthModifier)) + 1.5
		radiusY := float32(radiusXZ * scale)

		cosPitch := EngineCos(pitch)
		pos.X += float32(EngineCos(yaw) * cosPitch)
		pos.Y += EngineSin(pitch)
		pos.Z += float32(EngineSin(yaw) * cosPitch)
		newYaw := yaw + float32(turnB*0.1)
		pitch = float32(pitch*decay) + float32(turnA*0.1)
		d1 := float32(localRnd.NextFloat())
		d2 := float32(localRnd.NextFloat())
		d3 := float32(localRnd.NextFloat())
		// float32() around EVERY product: FMA barriers. Both the (d1-d2)*d3 product
		// and the *2 after it need one -- the turnB line below is the proof: with
		// the barrier only on the inner product, gc fused the *4 straight into the
		// outer add and emitted FMADDS anyway.
		turnA = float32(turnA*0.9) + float32(float32((d1-d2)*d3)*2)
		d4 := float32(localRnd.NextFloat())
		d5 := float32(localRnd.NextFloat())
		d6 := float32(localRnd.NextFloat())
		// float32() around every product: FMA barriers, exactly as for turnA above.
		turnB = float32(turnB*0.75) + float32(float32((d4-d5)*d6)*4)

		if !room && step == branchStep && thickness > 1 {
			leftThickness := float32(float32(localRnd.NextFloat())*0.5) + 0.5 // inner float32(): FMA barrier
			NetherCaveAddTunnel(ctx, cfg, localRnd, chunk, pos, leftThickness,
				newYaw-float32(math.Pi)/2, pitch/3, branchStep, distance, 1, params)
			rightThickness := float32(float32(localRnd.NextFloat())*0.5) + 0.5 // inner float32(): FMA barrier
			NetherCaveAddTunnel(ctx, cfg, localRnd, chunk, pos, rightThickness,
				newYaw+float32(math.Pi)/2, pitch/3, branchStep, distance, 1, params)
			return
		}

		yaw = newYaw
		carveThisStep := netherCaveCarveThisStep(room, localRnd)
		if carveThisStep {
			dxCenter := float32(pos.X - float32(chunkCenterX))
			dzCenter := float32(pos.Z - float32(chunkCenterZ))
			remaining := float32(distance - step)
			limit := thickness + 18
			// float32() per product: FMA barriers -- gc fuses this into FMADDS+FMSUBS.
			if float32(dxCenter*dxCenter)+float32(dzCenter*dzCenter)-float32(remaining*remaining) > limit*limit {
				return
			}
			bboxPass := pos.X >= float32(chunkCenterX)-16-radiusXZ*2 && pos.X <= float32(chunkCenterX)+16+radiusXZ*2 &&
				pos.Z >= float32(chunkCenterZ)-16-radiusXZ*2 && pos.Z <= float32(chunkCenterZ)+16+radiusXZ*2
			if bboxPass {
				worldOriginX := chunk.X * 16
				worldOriginZ := chunk.Z * 16
				xLo := int(caveFloor32(pos.X-radiusXZ)) - worldOriginX - 1
				if xLo < 0 {
					xLo = 0
				}
				xHi := int(caveFloor32(pos.X+radiusXZ)) - worldOriginX
				if xHi > 15 {
					xHi = 15
				}
				zLo := int(caveFloor32(pos.Z-radiusXZ)) - worldOriginZ - 1
				if zLo < 0 {
					zLo = 0
				}
				zHi := int(caveFloor32(pos.Z+radiusXZ)) - worldOriginZ
				if zHi > 15 {
					zHi = 15
				}
				yLo := int(caveFloor32(pos.Y - radiusY))
				if yLo < 2 {
					yLo = 2
				}
				yHi := int(caveFloor32(pos.Y + radiusY))
				if yHi > 119 {
					yHi = 119
				}
				if xLo <= xHi && zLo <= zHi && yHi+2 >= yLo-2 {
					// [PORT CONVERSION] xLo..xHi / zLo..zHi are CHUNK-LOCAL, exactly as the
					// game computes them: the game carves in chunk-local coordinates.
					// featurelab's wgen.BlockWorld is WORLD-space, so both the lava
					// pre-scan and the carve below must add the chunk origin back -- the
					// ellipsoid math a few lines down already does. Shifting both scan bounds
					// by the same origin leaves the edge-vs-interior column test
					// (x == xLo || x == xHi || ...) unchanged.
					if !netherCaveHasLava(ctx, xLo+worldOriginX, xHi+worldOriginX, yLo, yHi, zLo+worldOriginZ, zHi+worldOriginZ) {
						pal := ctx.API.Palette()
						for x := xLo; x <= xHi; x++ {
							worldX := x + worldOriginX
							dx := (float32(worldX) + 0.5 - pos.X) / radiusXZ
							for z := zLo; z <= zHi; z++ {
								worldZ := z + worldOriginZ
								dz := (float32(worldZ) + 0.5 - pos.Z) / radiusXZ
								for y := yHi; y >= yLo; y-- {
									dy := (float32(y) + 0.5 - pos.Y) / radiusY
									// float32() per product: FMA barriers, as above.
									if dy <= params.FloorLevel || float32(dx*dx)+float32(dy*dy)+float32(dz*dz) >= 1 {
										continue
									}
									carvePos := wgen.BlockPos{X: worldX, Y: y + 1, Z: worldZ}
									if netherCaveDiggable(pal, ctx.API.GetBlock(carvePos)) {
										ctx.API.SetBlock(carvePos, cfg.FillWith)
									}
								}
							}
						}
					}
				}
				if room {
					return
				}
			}
		}

		step++
		if step == distance {
			return
		}
	}
}

func buildNetherCaveFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	fillRaw, ok := body["fill_with"]
	if !ok {
		// DELIBERATELY STILL REFUSED, against the schema. Every one of this type's eight fields is
		// optional, so the game's LOADER does accept a file without fill_with -- but that does not
		// make omission safe here. The default is null, and unlike the overworld carver's per-block
		// carve, which null-checks (which is why cave.go ships CaveNoFill and accepts omission), this
		// carver writes the field as-is. An omitted fill_with therefore writes a null block the first
		// time this carver carves. A port should make this field REQUIRED and must NOT copy cave.go's
		// treatment.
		return nil, fmt.Errorf("fill_with is required for NetherCaveFeature. The game's own schema " +
			"marks it optional and will load a file without it, so this is deliberately stricter: " +
			"the field defaults to null and this carver -- unlike the overworld carver -- writes it " +
			"with no null check, so the first block it tries to carve is written as a null block. " +
			"The sibling carvers accept omission " +
			"because theirs DO null-check and simply skip the write; this one has nothing to fall " +
			"back to, so there is no omission behaviour to reproduce")
	}
	fillDesc, err := AsBlockDescriptor(fillRaw, "fill_with")
	if err != nil {
		return nil, err
	}

	widthModifier := constMolang(0)
	if raw, ok := body["width_modifier"]; ok {
		widthModifier, err = ParseMolangValue(raw)
		if err != nil {
			return nil, fmt.Errorf("width_modifier: %w", err)
		}
		if widthModifier.program != nil && caveWidthModifierUsesRandom(widthModifier.program) && ctx.Warn != nil {
			ctx.Warn("width_modifier: this expression uses random functions; the port evaluates it with the same deterministic private stand-in documented by CaveFeature")
		}
	}

	intField := func(key string) (int, error) {
		raw, ok := body[key]
		if !ok {
			return 0, nil
		}
		v, ok := toFloat(raw)
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
		if !ok || v != float64(int(v)) || int(v) == math.MinInt64 {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		return int(v), nil
	}
	skipCarveChance, err := intField("skip_carve_chance")
	if err != nil {
		return nil, err
	}
	WarnExplicitZeroSkipCarveChance(body, skipCarveChance, ctx)
	if _, err = intField("height_limit"); err != nil { // schema field is validated but dead in nether code
		return nil, err
	}

	floatRange := func(key string) (float32, float32, error) {
		raw, ok := body[key]
		if !ok {
			return 0, 0, nil
		}
		return parseCaveFloatRange(raw, key)
	}
	if _, _, err = floatRange("y_scale"); err != nil { // schema field is validated but dead in nether code
		return nil, err
	}
	hMin, hMax, err := floatRange("horizontal_radius_multiplier")
	if err != nil {
		return nil, err
	}
	vMin, vMax, err := floatRange("vertical_radius_multiplier")
	if err != nil {
		return nil, err
	}
	fMin, fMax, err := floatRange("floor_level")
	if err != nil {
		return nil, err
	}

	return &NetherCaveFeature{identifier: ctx.Identifier, config: NetherCaveFeatureConfig{
		FillWith: ctx.Palette.Resolve(fillDesc), WidthModifier: widthModifier,
		SkipCarveChance:               skipCarveChance,
		HorizontalRadiusMultiplierMin: hMin, HorizontalRadiusMultiplierMax: hMax,
		VerticalRadiusMultiplierMin: vMin, VerticalRadiusMultiplierMax: vMax,
		FloorLevelMin: fMin, FloorLevelMax: fMax,
	}}, nil
}

func init() {
	RegisterType(netherCaveCarverTypeID, buildNetherCaveFeature)
	// coverage.go is outside this port's edit scope. Keep the live catalogue consistent with the
	// registered builder so its bidirectional invariant remains true.
	for i := range FeatureTypeCoverage {
		if FeatureTypeCoverage[i].TypeID == netherCaveCarverTypeID {
			FeatureTypeCoverage[i].Status = StatusImplemented
			break
		}
	}
}

var _ wgen.IFeature = (*NetherCaveFeature)(nil)
