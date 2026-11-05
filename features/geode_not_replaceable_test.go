package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

func geodeForTagTest(t *testing.T, pal *block.Palette) *GeodeFeature {
	t.Helper()
	ctx := &BuildContext{Palette: pal, Identifier: "test:geode", FileID: "test:geode", Warn: func(string) {}}
	built, err := buildGeodeFeature(geodeMinimalBody(map[string]any{"invalid_blocks_threshold": float64(1000)}), ctx)
	if err != nil {
		t.Fatalf("buildGeodeFeature: %v", err)
	}
	return built.(*GeodeFeature)
}

func TestGeode_KeepsATaggedBlockInsideItsShell(t *testing.T) {
	v, pal, origin := newGeodeTestVolume(10)
	stone := pal.Get("minecraft:stone", nil)
	if got := placeTestGeode(geodeForTagTest(t, pal), v, origin, random.New(9)); got == nil {
		t.Fatal("control Place() = nil, want success")
	}
	if v.GetBlock(origin) == stone {
		t.Fatal("the control geode left its origin as stone, so this test proves nothing")
	}

	v, pal, origin = newGeodeTestVolume(10)
	chest := pal.Get("minecraft:chest", nil)
	v.SetBlockUnbudgeted(origin, chest)
	if got := placeTestGeode(geodeForTagTest(t, pal), v, origin, random.New(9)); got == nil {
		t.Fatal("Place() = nil, want success")
	}
	if got := v.GetBlock(origin); got != chest {
		t.Errorf("origin = %s, want the chest kept", pal.NameOf(got))
	}
}

func TestGeode_NothingWritableFails(t *testing.T) {
	pal := block.NewPalette()
	chest := pal.Get("minecraft:chest", nil)
	bounds := volume.Bounds{MinX: -14, MinY: 40, MinZ: -14, SizeX: 29, SizeY: 40, SizeZ: 29}
	v := volume.New(bounds, pal, chest)
	for x := -14; x <= 14; x++ {
		for y := 40; y < 80; y++ {
			for z := -14; z <= 14; z++ {
				v.SetBlockUnbudgeted(wgen.BlockPos{X: x, Y: y, Z: z}, chest)
			}
		}
	}
	if got := placeTestGeode(geodeForTagTest(t, pal), v, wgen.BlockPos{X: 0, Y: 60, Z: 0}, random.New(9)); got != nil {
		t.Errorf("Place() = %v, want nil when every cell is tagged", got)
	}
}

func TestSetBlockSafe(t *testing.T) {
	pal := block.NewPalette()
	bounds := volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 2, SizeY: 2, SizeZ: 2}
	v := volume.New(bounds, pal, pal.Get("minecraft:stone", nil))
	dirt := pal.Get("minecraft:dirt", nil)
	if !setBlockSafe(v, pal, wgen.BlockPos{}, dirt) {
		t.Error("write over stone = false, want true")
	}
	v.SetBlockUnbudgeted(wgen.BlockPos{}, pal.Get("minecraft:bedrock", nil))
	if setBlockSafe(v, pal, wgen.BlockPos{}, dirt) {
		t.Error("write over bedrock = true, want false")
	}
	if setBlockSafe(v, pal, wgen.BlockPos{X: 9}, dirt) {
		t.Error("write outside the volume = true, want false")
	}
}
