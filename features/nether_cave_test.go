package features

import (
	"fmt"
	"math"
	"reflect"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

type netherScriptedRandom struct {
	seed       uint32
	ints       []int32
	intIndex   int
	bounds     []int
	boundIndex int
	floats     []float64
	floatIndex int
	events     []string
	setSeeds   []uint32
}

func (r *netherScriptedRandom) NextInt() int32 {
	if r.intIndex >= len(r.ints) {
		panic("unexpected NextInt")
	}
	v := r.ints[r.intIndex]
	r.intIndex++
	r.events = append(r.events, "int")
	return v
}

func (r *netherScriptedRandom) NextIntBound(bound int) int {
	v := 0
	if r.boundIndex < len(r.bounds) {
		v = r.bounds[r.boundIndex]
	}
	r.boundIndex++
	r.events = append(r.events, fmt.Sprintf("bound(%d)", bound))
	return v
}

func (r *netherScriptedRandom) NextFloat() float64 {
	if r.floatIndex >= len(r.floats) {
		panic("unexpected NextFloat")
	}
	v := r.floats[r.floatIndex]
	r.floatIndex++
	r.events = append(r.events, "float")
	return v
}

func (r *netherScriptedRandom) NextDouble() float64           { panic("unexpected NextDouble") }
func (r *netherScriptedRandom) NextBoolean() bool             { panic("unexpected NextBoolean") }
func (r *netherScriptedRandom) NextUnsignedInt(uint32) uint32 { panic("unexpected NextUnsignedInt") }
func (r *netherScriptedRandom) SetSeed(seed uint32) {
	r.seed = seed
	r.setSeeds = append(r.setSeeds, seed)
}
func (r *netherScriptedRandom) GetSeed() uint32 { return r.seed }

var _ random.IRandom = (*netherScriptedRandom)(nil)

func TestNetherCavePlace_289ChunkWindowAndCINCOddMaker(t *testing.T) {
	const baseSeed = uint32(0x12345678)
	rnd := &netherScriptedRandom{seed: baseSeed, ints: []int32{-3, -5}}
	f := &NetherCaveFeature{identifier: "test", config: NetherCaveFeatureConfig{WidthModifier: constMolang(0)}}
	ctx := &wgen.PlacementContext{Origin: wgen.BlockPos{X: 3 * 16, Z: -2 * 16}, Random: rnd}

	gotOrigin := f.Place(ctx)
	if gotOrigin == nil || *gotOrigin != ctx.Origin {
		t.Fatalf("Place origin = %#v, want engaged %#v", gotOrigin, ctx.Origin)
	}
	if len(rnd.setSeeds) != 17*17 {
		t.Fatalf("SetSeed calls = %d, want 289", len(rnd.setSeeds))
	}

	// Independently spell Java's trunc-toward-zero nextInt()/2*2+1. For -3/-5 this yields
	// -1/-3; substituting CaveFeature's plain |1 yields -3/-5 and fails every seed assertion.
	rawA, rawB := int32(-3), int32(-5)
	a := uint32((rawA / 2 * 2) + 1)
	b := uint32((rawB / 2 * 2) + 1)
	want := make([]uint32, 0, 289)
	for ncx := 3 - 8; ncx <= 3+8; ncx++ {
		for ncz := -2 - 8; ncz <= -2+8; ncz++ {
			want = append(want, (uint32(int32(ncx))*a+uint32(int32(ncz))*b)^baseSeed)
		}
	}
	if !reflect.DeepEqual(rnd.setSeeds, want) {
		t.Fatalf("289 reseed grid differs: first got=%#x want=%#x, last got=%#x want=%#x",
			rnd.setSeeds[0], want[0], rnd.setSeeds[len(rnd.setSeeds)-1], want[len(want)-1])
	}
}

func TestNetherCaveAddFeature_SamplesRangesBeforeEarlyOut(t *testing.T) {
	rnd := &netherScriptedRandom{
		bounds: []int{2, 1, 0, 0},
		floats: []float64{0.1, 0.2, 0.3},
	}
	cfg := NetherCaveFeatureConfig{
		WidthModifier: constMolang(0), SkipCarveChance: 5,
		FloorLevelMin: 10, FloorLevelMax: 20,
		HorizontalRadiusMultiplierMin: 30, HorizontalRadiusMultiplierMax: 50,
		VerticalRadiusMultiplierMin: 70, VerticalRadiusMultiplierMax: 100,
	}
	NetherCaveAddFeature(&wgen.PlacementContext{}, cfg, rnd, CaveChunkPos{}, CaveChunkPos{})
	want := []string{"bound(10)", "bound(3)", "bound(2)", "bound(5)", "float", "float", "float"}
	if !reflect.DeepEqual(rnd.events, want) {
		t.Fatalf("draw order = %v, want %v", rnd.events, want)
	}
}

type netherTunnelCapture struct {
	yaw, pitch, thickness float32
	params                CaveCarvingParameters
}

func TestNetherCaveAddFeature_FreshTunnelParametersEveryRound(t *testing.T) {
	rnd := &netherScriptedRandom{
		bounds: []int{2, 1, 1, 0, 2, 50, 3, 0, 2},
		floats: []float64{
			0.1, 0.2, 0.3, // floor, horizontal, vertical
			0.4,                // mocked addRoom's caller float
			0.1, 0.2, 0.3, 0.4, // tunnel round 1
			0.5, 0.6, 0.7, 0.8, // tunnel round 2
			0.9, 0.1, 0.2, 0.3, // tunnel round 3
		},
		ints: []int32{11, 12, 13, 14},
	}
	cfg := NetherCaveFeatureConfig{
		WidthModifier: constMolang(0), SkipCarveChance: 5,
		FloorLevelMin: 10, FloorLevelMax: 20,
		HorizontalRadiusMultiplierMin: 30, HorizontalRadiusMultiplierMax: 50,
		VerticalRadiusMultiplierMin: 70, VerticalRadiusMultiplierMax: 100,
	}
	var captures []netherTunnelCapture
	room := func(_ *wgen.PlacementContext, _ NetherCaveFeatureConfig, r random.IRandom, _ CaveChunkPos, _ CaveVec3, p CaveCarvingParameters) {
		if p.FloorLevel != 11 || p.HorizontalRadiusMultiplier != 34 || p.VerticalRadiusMultiplier != 79 {
			t.Fatalf("range sample mapping/order = %+v, want floor=11 horizontal=34 vertical=79", p)
		}
		r.NextFloat()
		r.NextInt()
	}
	tunnel := func(_ *wgen.PlacementContext, _ NetherCaveFeatureConfig, r random.IRandom, _ CaveChunkPos, _ CaveVec3, thickness, yaw, pitch float32, start, distance int, scale float32, p CaveCarvingParameters) {
		captures = append(captures, netherTunnelCapture{yaw: yaw, pitch: pitch, thickness: thickness, params: p})
		if start != 0 || distance != 0 || scale != 0.5 {
			t.Fatalf("tunnel fixed args = start %d distance %d scale %v", start, distance, scale)
		}
		r.NextInt()
	}
	netherCaveAddFeatureWith(&wgen.PlacementContext{}, cfg, rnd, CaveChunkPos{}, CaveChunkPos{}, room, tunnel)

	if len(captures) != 3 {
		t.Fatalf("tunnel rounds = %d, want 3", len(captures))
	}
	wantThickness := []float32{2, 4.4, 1.4}
	wantYawDraw := []float32{0.1, 0.5, 0.9}
	for i, got := range captures {
		if math.Abs(float64(got.thickness-wantThickness[i])) > 1e-6 {
			t.Errorf("round %d thickness = %v, want %v", i, got.thickness, wantThickness[i])
		}
		wantYaw := wantYawDraw[i] * float32(math.Pi) * 2
		if math.Abs(float64(got.yaw-wantYaw)) > 1e-6 {
			t.Errorf("round %d yaw = %v, want %v", i, got.yaw, wantYaw)
		}
	}
}

func TestNetherCaveTunnel_CarveRollZeroSkipsAndRoomsDrawNone(t *testing.T) {
	zero := &netherScriptedRandom{bounds: []int{0}}
	if netherCaveCarveThisStep(false, zero) {
		t.Fatal("tunnel roll 0 carved; nether's inverted sense requires it to skip")
	}
	if !reflect.DeepEqual(zero.events, []string{"bound(4)"}) {
		t.Fatalf("tunnel roll events = %v, want one bound(4)", zero.events)
	}
	nonzero := &netherScriptedRandom{bounds: []int{3}}
	if !netherCaveCarveThisStep(false, nonzero) {
		t.Fatal("tunnel roll 3 skipped; every nonzero roll must carve")
	}
	room := &netherScriptedRandom{}
	if !netherCaveCarveThisStep(true, room) || len(room.events) != 0 {
		t.Fatalf("room carve decision drew or skipped: result/events = true/%v", room.events)
	}
}

func TestNetherCaveLavaScan_InteriorSparseEdgeDense(t *testing.T) {
	pal := block.NewPalette()
	netherrack := pal.Get("minecraft:netherrack", nil)
	lava := pal.Get("minecraft:lava", nil)
	v := volume.New(volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 16, SizeY: 128, SizeZ: 16}, pal, netherrack)
	ctx := &wgen.PlacementContext{API: v}

	v.SetBlock(wgen.BlockPos{X: 1, Y: 15, Z: 1}, lava)
	if netherCaveHasLava(ctx, 0, 2, 10, 20, 0, 2) {
		t.Fatal("interior mid-Y lava was scanned; interior columns must check only yHi+2,yLo-1,yLo-2")
	}
	v.SetBlock(wgen.BlockPos{X: 0, Y: 15, Z: 1}, lava)
	if !netherCaveHasLava(ctx, 0, 2, 10, 20, 0, 2) {
		t.Fatal("edge mid-Y lava was missed; edge columns must scan the full expanded Y range")
	}
}

func TestBuildNetherCaveFeature_RequiresFillWith(t *testing.T) {
	pal := block.NewPalette()
	ctx := &BuildContext{Identifier: "test", Palette: pal}
	if _, err := buildNetherCaveFeature(map[string]any{}, ctx); err == nil {
		t.Fatal("omitted fill_with succeeded; the port must refuse the game's unsafe null default")
	}
	f, err := buildNetherCaveFeature(map[string]any{"fill_with": "minecraft:air"}, ctx)
	if err != nil {
		t.Fatalf("required fill_with build failed: %v", err)
	}
	if _, ok := f.(*NetherCaveFeature); !ok {
		t.Fatalf("builder returned %T, want *NetherCaveFeature", f)
	}
}

// TestNetherCaveCarve_IsOriginIndependent pins the chunk-local -> world-space conversion the
// carve loop and the lava pre-scan both need. The game carves in chunk-local coordinates;
// featurelab's block API is world-space. Before the conversion was
// added, an identical tunnel carved 742 cells in chunk (0,0) and ZERO in any other chunk,
// because every write landed at world X/Z 0..15. Every other carve test in this file uses chunk
// (0,0), where local and world coincide -- which is exactly why nothing caught it. This one MUST
// stay at a non-zero origin.
func TestNetherCaveCarve_IsOriginIndependent(t *testing.T) {
	carve := func(chunkX, chunkZ int) int {
		pal := block.NewPalette()
		netherrack := pal.Get("minecraft:netherrack", nil)
		air := pal.Get("minecraft:air", nil)
		ox, oz := chunkX*16, chunkZ*16
		v := volume.New(volume.Bounds{MinX: ox, MinY: 0, MinZ: oz, SizeX: 16, SizeY: 128, SizeZ: 16}, pal, netherrack)
		for x := ox; x < ox+16; x++ {
			for z := oz; z < oz+16; z++ {
				for y := 0; y < 128; y++ {
					v.SetBlock(wgen.BlockPos{X: x, Y: y, Z: z}, netherrack)
				}
			}
		}
		ctx := &wgen.PlacementContext{API: v}
		cfg := NetherCaveFeatureConfig{WidthModifier: constMolang(0), FillWith: air}
		center := CaveVec3{X: float32(ox + 8), Y: 40, Z: float32(oz + 8)}
		NetherCaveAddTunnel(ctx, cfg, random.New(0xC0FFEE), CaveChunkPos{X: chunkX, Z: chunkZ},
			center, 4, 0.5, 0, 0, 0, 0.5, CaveCarvingParameters{})
		n := 0
		for x := ox; x < ox+16; x++ {
			for z := oz; z < oz+16; z++ {
				for y := 0; y < 128; y++ {
					if v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z}) == air {
						n++
					}
				}
			}
		}
		return n
	}

	atOrigin := carve(0, 0)
	if atOrigin == 0 {
		t.Fatal("the chunk-(0,0) control carved nothing; the harness, not the carver, is broken")
	}
	for _, chunk := range [][2]int{{6, 0}, {0, 6}, {-4, 3}} {
		if got := carve(chunk[0], chunk[1]); got != atOrigin {
			t.Errorf("chunk (%d,%d) carved %d cells, chunk (0,0) carved %d; the same tunnel "+
				"relative to its own chunk must carve identically at every origin",
				chunk[0], chunk[1], got, atOrigin)
		}
	}
}
