package wire

import (
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/pack"
)

// scatterFeatureFixedOffsetJSON builds a minimal minecraft:scatter_feature body: exactly one
// iteration, at a FIXED (non-random) offset from origin -- a plain number for x/y/z in
// "distribution" is a constant offset, not a distribution range (see session/profiler_test.go's
// own scatterFeatureFile, which uses the same convention with a zero offset) -- so the resulting
// write position is deterministic and hand-checkable, exactly like a single_block_feature's own
// origin-relative placement, just displaced by (dx,dy,dz).
func scatterFeatureFixedOffsetJSON(identifier, placesFeature string, dx, dy, dz int) string {
	return `{"format_version":"1.21.110","minecraft:scatter_feature":{"description":{"identifier":"` + identifier +
		`"},"places_feature":"` + placesFeature + `","distribution":{"iterations":1,"x":` + itoaGrow(dx) + `,"y":` + itoaGrow(dy) + `,"z":` + itoaGrow(dz) + `}}}`
}

func itoaGrow(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [24]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// TestRunGenerateGrown_NoOverflowLeavesResultUnchanged proves the "nothing to grow for" case: a
// feature that writes only inside the bench produces Grown: false, and the embedded
// GenerateOutput is exactly what a plain RunGenerate call would have produced.
func TestRunGenerateGrown_NoOverflowLeavesResultUnchanged(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "place_diamond.json"), singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))

	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	out, err := RunGenerateGrown(loaded, GenerateParams{Feature: "test:place_diamond", Env: "void"})
	if err != nil {
		t.Fatalf("RunGenerateGrown: %v", err)
	}
	if out.Grown {
		t.Fatal("Grown should be false when nothing spilled")
	}
	if out.PreGrowBounds != nil {
		t.Fatalf("PreGrowBounds should be nil when Grown is false, got %+v", out.PreGrowBounds)
	}
	if out.WritesOutOfBounds != 0 {
		t.Fatalf("WritesOutOfBounds = %d, want 0", out.WritesOutOfBounds)
	}
	if len(out.OverflowBlocks) != 0 {
		t.Fatalf("OverflowBlocks = %v, want empty", out.OverflowBlocks)
	}
}

// TestRunGenerateGrown_CapturesThenGrowsToFit is the end-to-end proof of both halves of this
// repo's out-of-bounds feature: a scatter_feature placing a fixed 100 blocks east of origin, in
// an 8x8x8 bench, spills entirely out of bounds on the FIRST run (captured, not lost -- the
// "capture and display" half) -- and RunGenerateGrown's second, larger run actually contains that
// same world position and places the block for real (the "grow to fit and regenerate" half).
func TestRunGenerateGrown_CapturesThenGrowsToFit(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "leaf.json"), singleBlockFeatureJSON("test:leaf", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "root.json"), scatterFeatureFixedOffsetJSON("test:root", "test:leaf", 100, 0, 0))

	loaded, err := pack.Load(pack.Options{Dir: root})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}

	params := GenerateParams{Feature: "test:root", Env: "void", Origin: "0,0,0", Size: "8x8x8"}

	initial, err := RunGenerate(loaded, params)
	if err != nil {
		t.Fatalf("RunGenerate: %v", err)
	}
	if initial.WritesOutOfBounds != 1 {
		t.Fatalf("initial WritesOutOfBounds = %d, want 1", initial.WritesOutOfBounds)
	}
	if len(initial.OverflowBlocks) != 1 {
		t.Fatalf("initial OverflowBlocks = %v, want exactly 1 captured block", initial.OverflowBlocks)
	}
	captured := initial.OverflowBlocks[0]
	if captured.X != 100 || captured.Y != 0 || captured.Z != 0 {
		t.Fatalf("captured overflow block at (%d,%d,%d), want (100,0,0)", captured.X, captured.Y, captured.Z)
	}
	// The bench itself must be untouched by the capture -- nothing was placed inside it.
	if initial.BlocksPlaced != 0 {
		t.Fatalf("initial BlocksPlaced = %d, want 0 (the only write landed outside the bench)", initial.BlocksPlaced)
	}

	grown, err := RunGenerateGrown(loaded, params)
	if err != nil {
		t.Fatalf("RunGenerateGrown: %v", err)
	}
	if !grown.Grown {
		t.Fatal("Grown should be true -- the initial run captured an overflow block")
	}
	if grown.PreGrowBounds == nil {
		t.Fatal("PreGrowBounds should be non-nil when Grown is true")
	}
	if *grown.PreGrowBounds != initial.Bounds {
		t.Fatalf("PreGrowBounds = %+v, want the original bench's own bounds %+v", *grown.PreGrowBounds, initial.Bounds)
	}

	// The grown bench must actually CONTAIN world position (100,0,0).
	gb := grown.Bounds
	if !(100 >= gb.MinX && 100 < gb.MinX+gb.SizeX && 0 >= gb.MinY && 0 < gb.MinY+gb.SizeY && 0 >= gb.MinZ && 0 < gb.MinZ+gb.SizeZ) {
		t.Fatalf("grown bounds %+v do not contain (100,0,0)", gb)
	}
	if gb.SizeX <= initial.Bounds.SizeX {
		t.Fatalf("grown SizeX = %d, want strictly larger than the original %d", gb.SizeX, initial.Bounds.SizeX)
	}

	// The defining behaviour: the SAME write that was only captured on the first run now
	// actually lands inside the bench on the second, larger run.
	if grown.WritesOutOfBounds != 0 {
		t.Fatalf("grown WritesOutOfBounds = %d, want 0 (the bench now contains the write)", grown.WritesOutOfBounds)
	}
	if grown.BlocksPlaced != 1 {
		t.Fatalf("grown BlocksPlaced = %d, want 1", grown.BlocksPlaced)
	}
}
