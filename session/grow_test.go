package session

import (
	"testing"

	"github.com/stirante/featurelab/volume"
)

func containsBox(minX, sizeX, minY, sizeY, minZ, sizeZ, x, y, z int) bool {
	return x >= minX && x < minX+sizeX &&
		y >= minY && y < minY+sizeY &&
		z >= minZ && z < minZ+sizeZ
}

func TestGrowBoundsNoOverflowNeverShrinks(t *testing.T) {
	sx, sy, sz, my := GrowBounds(-16, 32, 44, 48, -16, 32, 0, 0, nil)
	if sx != 32 || sy != 48 || sz != 32 || my != 44 {
		t.Fatalf("GrowBounds with no overflow = (%d,%d,%d,%d), want the original bench unchanged (32,48,32,44)", sx, sy, sz, my)
	}
}

func TestGrowBoundsContainsOverflowPastEachEdge(t *testing.T) {
	// Original bench: x in [-16,16), y in [44,92), z in [-16,16), origin (0,*,0).
	overflow := []volume.OverflowBlock{
		{X: 20, Y: 60, Z: 0, ID: 1},  // past +X
		{X: -25, Y: 60, Z: 0, ID: 1}, // past -X
		{X: 0, Y: 60, Z: 22, ID: 1},  // past +Z
		{X: 0, Y: 60, Z: -30, ID: 1}, // past -Z
		{X: 0, Y: 100, Z: 0, ID: 1},  // past +Y
		{X: 0, Y: 10, Z: 0, ID: 1},   // past -Y
	}
	sx, sy, sz, my := GrowBounds(-16, 32, 44, 48, -16, 32, 0, 0, overflow)

	if sx <= 32 || sz <= 32 || sy <= 48 {
		t.Fatalf("GrowBounds did not grow: got size (%d,%d,%d)", sx, sy, sz)
	}

	// New horizontal bench, centered on origin (0,0) exactly like generate()'s own formula.
	newMinX := 0 - sx/2
	newMinZ := 0 - sz/2
	for _, b := range overflow {
		if !containsBox(newMinX, sx, my, sy, newMinZ, sz, b.X, b.Y, b.Z) {
			t.Errorf("grown bench (minX=%d sizeX=%d minY=%d sizeY=%d minZ=%d sizeZ=%d) does not contain overflow block %+v",
				newMinX, sx, my, sy, newMinZ, sz, b)
		}
	}
	// The original bench must still be fully contained too -- grow never shrinks.
	origMaxX, grownMaxX := -16+32-1, newMinX+sx-1
	if newMinX > -16 || grownMaxX < origMaxX {
		t.Errorf("grown X range [%d,%d] does not contain original [-16,%d]", newMinX, grownMaxX, origMaxX)
	}
}

func TestGrowBoundsOffCenterOrigin(t *testing.T) {
	// Origin not at the bench's own center (odd size / off-center origin) -- growth must stay
	// centered on the ORIGIN, not the old bench's own midpoint.
	overflow := []volume.OverflowBlock{{X: 500, Y: 44, Z: 500, ID: 1}}
	sx, sy, sz, my := GrowBounds(90, 20, 40, 10, 90, 20, 100, 100, overflow)
	newMinX := 100 - sx/2
	newMinZ := 100 - sz/2
	if !containsBox(newMinX, sx, my, sy, newMinZ, sz, 500, 44, 500) {
		t.Fatalf("grown bench (minX=%d sizeX=%d minZ=%d sizeZ=%d) does not contain far overflow block", newMinX, sx, newMinZ, sz)
	}
}

func TestGrowBoundsCapsRunawayGrowth(t *testing.T) {
	overflow := []volume.OverflowBlock{{X: 1_000_000, Y: 0, Z: 0, ID: 1}}
	sx, _, _, _ := GrowBounds(-16, 32, 44, 48, -16, 32, 0, 0, overflow)
	if sx != maxGrownAxisSize {
		t.Fatalf("GrowBounds sizeX = %d, want the cap %d for a pathologically distant overflow block", sx, maxGrownAxisSize)
	}
}
