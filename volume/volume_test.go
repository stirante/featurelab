// volume_test.go covers the profiler write hook added to SetBlockAt -- the
// per-write half of the profiler's accounting (see profiler/profiler.go's
// header). The profiler package's own tests
// (profiler/profiler_test.go) cover the profiler's accounting in depth;
// this file only pins that the hook in THIS package (a) fires exactly once
// per in-bounds write while profiling is active, (b) is skipped for
// out-of-bounds writes (the hook sits after the bounds early return),
// and (c) is a true no-op -- not just
// "records nothing" but doesn't even get called -- while profiling is off.
package volume

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

func testVolume() (*Volume, *block.Palette) {
	p := block.NewPalette()
	v := New(Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 4, SizeY: 4, SizeZ: 4}, p, block.AirID)
	return v, p
}

func TestSetBlockRecordsTouchesWhenProfilingActive(t *testing.T) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)

	profiler.BeginProfiling(len(v.Data()))
	defer func() {
		if profiler.ProfilingActive {
			profiler.EndProfiling()
		}
	}()

	v.SetBlock(wgen.BlockPos{X: 1, Y: 1, Z: 1}, stone)
	v.SetBlock(wgen.BlockPos{X: 1, Y: 1, Z: 1}, stone)
	v.SetBlock(wgen.BlockPos{X: 2, Y: 2, Z: 2}, stone)

	result := profiler.EndProfiling()

	idx1 := v.index(1, 1, 1)
	idx2 := v.index(2, 2, 2)
	if result.TouchCounts[idx1] != 2 {
		t.Errorf("touch count at (1,1,1) = %d, want 2", result.TouchCounts[idx1])
	}
	if result.TouchCounts[idx2] != 1 {
		t.Errorf("touch count at (2,2,2) = %d, want 1", result.TouchCounts[idx2])
	}
	total := 0
	for _, c := range result.TouchCounts {
		if c > 0 {
			total++
		}
	}
	if total != 2 {
		t.Errorf("distinct touched cells = %d, want 2", total)
	}
}

func TestSetBlockOutOfBoundsDoesNotTouch(t *testing.T) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)

	profiler.BeginProfiling(len(v.Data()))
	ok := v.SetBlock(wgen.BlockPos{X: 99, Y: 99, Z: 99}, stone)
	result := profiler.EndProfiling()

	if ok {
		t.Fatal("out-of-bounds SetBlock should return false")
	}
	for i, c := range result.TouchCounts {
		if c != 0 {
			t.Fatalf("touch count at cell %d = %d, want 0 (out-of-bounds write must not be counted)", i, c)
		}
	}
}

func TestSetBlockDoesNotTouchWhenProfilingOff(t *testing.T) {
	if profiler.ProfilingActive {
		t.Fatal("profiler must be off at test start")
	}
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)

	// No BeginProfiling call at all -- SetBlock must behave identically to
	// a plain write (return true, update data/columnTop) and must not
	// panic despite the package-level touchCounts/cellAttribution slices
	// being nil (RecordWrite is only ever called when ProfilingActive is
	// true, so it never sees the "never armed" nil state -- pinning that
	// invariant here).
	ok := v.SetBlock(wgen.BlockPos{X: 1, Y: 1, Z: 1}, stone)
	if !ok {
		t.Fatal("in-bounds SetBlock should return true")
	}
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 1, Z: 1}); got != stone {
		t.Fatalf("GetBlock = %v, want %v", got, stone)
	}
}

// --- Out-of-bounds overflow capture ---------------------------------------------------------
//
// See volume.go's OverflowBlock/Volume.Overflow doc comments: an out-of-bounds SetBlockAt call
// is still dropped from `data` (read semantics -- GetBlock/Contains -- are completely
// unchanged), but is now also captured into an overflow store instead of being silently lost.

func TestOverflowEmptyWhenNothingSpills(t *testing.T) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)
	v.SetBlock(wgen.BlockPos{X: 1, Y: 1, Z: 1}, stone)

	got := v.Overflow()
	if got == nil {
		t.Fatal("Overflow() must never return nil, even when nothing has spilled")
	}
	if len(got) != 0 {
		t.Fatalf("Overflow() = %v, want empty", got)
	}
}

func TestOverflowCapturesOutOfBoundsWrite(t *testing.T) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)

	ok := v.SetBlock(wgen.BlockPos{X: 99, Y: 1, Z: 1}, stone)
	if ok {
		t.Fatal("out-of-bounds SetBlock should still return false")
	}
	if v.WritesOutOfBounds != 1 {
		t.Fatalf("WritesOutOfBounds = %d, want 1", v.WritesOutOfBounds)
	}

	overflow := v.Overflow()
	if len(overflow) != 1 {
		t.Fatalf("Overflow() = %v, want exactly 1 captured block", overflow)
	}
	got := overflow[0]
	if got.X != 99 || got.Y != 1 || got.Z != 1 || got.ID != stone {
		t.Fatalf("Overflow()[0] = %+v, want {X:99 Y:1 Z:1 ID:%v}", got, stone)
	}

	// Read semantics are completely untouched by the capture: the out-of-bounds cell still
	// reads as the volume's OOB sentinel (air, in testVolume's case), never the captured
	// block -- growing what is CAPTURED must never change what a feature mid-placement SEES.
	if got := v.GetBlock(wgen.BlockPos{X: 99, Y: 1, Z: 1}); got != block.AirID {
		t.Fatalf("GetBlock at a captured-but-out-of-bounds cell = %v, want AirID (unchanged read semantics)", got)
	}
	if v.Contains(wgen.BlockPos{X: 99, Y: 1, Z: 1}) {
		t.Fatal("Contains must still report false for a captured out-of-bounds position")
	}
}

func TestOverflowRepeatWriteToSameCellUpdatesInPlace(t *testing.T) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)
	dirt := p.Get("minecraft:dirt", nil)

	v.SetBlock(wgen.BlockPos{X: 99, Y: 1, Z: 1}, stone)
	v.SetBlock(wgen.BlockPos{X: 99, Y: 1, Z: 1}, dirt)
	v.SetBlock(wgen.BlockPos{X: -50, Y: 1, Z: 1}, stone)

	if v.WritesOutOfBounds != 3 {
		t.Fatalf("WritesOutOfBounds = %d, want 3 (every ATTEMPT counts, even a repeat)", v.WritesOutOfBounds)
	}
	overflow := v.Overflow()
	if len(overflow) != 2 {
		t.Fatalf("Overflow() = %v, want exactly 2 distinct captured cells (last write wins per cell)", overflow)
	}
	if overflow[0].X != 99 || overflow[0].ID != dirt {
		t.Fatalf("Overflow()[0] = %+v, want the LAST write to (99,1,1) (dirt), in first-seen order", overflow[0])
	}
	if overflow[1].X != -50 || overflow[1].ID != stone {
		t.Fatalf("Overflow()[1] = %+v, want (-50,1,1)=stone", overflow[1])
	}
}

// BenchmarkSetBlockAt_InBounds is the "cheap when nothing spills" proof this package's overflow
// store (recordOverflow, Overflow) is held to -- see Volume's own doc comment ("the write path
// stays held to the same 'off costs nothing' standard as the profiler hook it sits beside").
// Every write here is IN bounds, so recordOverflow's lazy map/slice is never even reached; -
// benchmem must show 0 allocs/op, proving the overflow store adds no per-write cost to the path
// that matters (in-bounds writes are the overwhelming majority of any real run).
func BenchmarkSetBlockAt_InBounds(b *testing.B) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		v.SetBlock(wgen.BlockPos{X: i % 4, Y: 1, Z: 1}, stone)
	}
}

// BenchmarkSetBlockAt_OutOfBounds_RepeatCell is the corresponding cost of the OUT-of-bounds
// path once something DOES spill, repeatedly hitting the SAME out-of-bounds cell (the
// last-write-wins in-place update path, recordOverflow's map lookup + slice index, never a
// growing append) -- included for contrast with the in-bounds benchmark above, not because this
// path needs to be as cheap (it is off the hot path by construction: an out-of-bounds write is
// already a dropped write before this feature existed).
func BenchmarkSetBlockAt_OutOfBounds_RepeatCell(b *testing.B) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		v.SetBlock(wgen.BlockPos{X: 99, Y: 1, Z: 1}, stone)
	}
}

func TestOverflowClearedByRestore(t *testing.T) {
	v, p := testVolume()
	stone := p.Get("minecraft:stone", nil)
	snap := v.Snapshot()

	v.SetBlock(wgen.BlockPos{X: 99, Y: 1, Z: 1}, stone)
	if len(v.Overflow()) != 1 {
		t.Fatal("expected one captured overflow block before Restore")
	}

	v.Restore(snap)
	if v.WritesOutOfBounds != 0 {
		t.Fatalf("WritesOutOfBounds after Restore = %d, want 0", v.WritesOutOfBounds)
	}
	if got := v.Overflow(); len(got) != 0 {
		t.Fatalf("Overflow() after Restore = %v, want empty -- a fresh baseline must not leak a previous run's captured blocks", got)
	}
}

// TestResetOutOfBoundsAccounting_ClearsTheCountersAndLeavesTheBlocks pins the half of Restore
// that session.Generate needs after building the bench environment.
//
// The bug it guards against: the environment builder writes into the same volume the feature
// will, so its spill outside the bounds bumps the same counter -- and every consumer reads that
// counter as the FEATURE's. `--env end --size 32x10x32 --origin 0,46,0` attributed 36 end_stone
// writes, one row below the floor, to a feature that placed nothing, told the author "that is
// expected for a feature that works on neighbouring chunks", and under --grow expanded the bench
// and regenerated on the strength of it.
func TestResetOutOfBoundsAccounting_ClearsTheCountersAndLeavesTheBlocks(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	v := New(Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 4, SizeY: 4, SizeZ: 4}, pal, block.AirID)

	inside := wgen.BlockPos{X: 1, Y: 1, Z: 1}
	v.SetBlock(inside, stone)
	v.SetBlock(wgen.BlockPos{X: 1, Y: -1, Z: 1}, stone) // below the floor
	v.SetBlock(wgen.BlockPos{X: 9, Y: 1, Z: 1}, stone)  // past the east wall

	if v.WritesOutOfBounds != 2 {
		t.Fatalf("WritesOutOfBounds = %d, want 2 -- the premise of this test", v.WritesOutOfBounds)
	}
	if len(v.Overflow()) == 0 {
		t.Fatal("the overflow store is empty -- the premise of this test")
	}

	v.ResetOutOfBoundsAccounting()

	if v.WritesOutOfBounds != 0 {
		t.Errorf("WritesOutOfBounds = %d after reset, want 0", v.WritesOutOfBounds)
	}
	if got := len(v.Overflow()); got != 0 {
		t.Errorf("overflow store still holds %d entries after reset", got)
	}
	// The blocks must survive: this is the environment the feature is about to be placed into.
	if got := v.GetBlock(inside); got != stone {
		t.Errorf("the in-bounds block was disturbed: got %v, want %v -- reset must not touch the world", got, stone)
	}
}

// TestSetBlockAt_OutOfRangeWriteNeverRaisesColumnHeight pins the invariant the
// deleted FillLayers broke (see volume.go, where its body used to be): a write
// that lands NOWHERE must not raise the column it aimed at.
//
// Direction matters here, not just the number. FillLayers's bug pointed the
// wrong way in the most damaging possible direction: given a Y span entirely
// outside the volume it wrote nothing, and then raised every column to
// MaxY()-1 anyway -- so an empty bench reported a solid ceiling to
// query.heightmap and query.above_top_solid, for every column, for the rest of
// the run. A feature asking "where is the ground?" would have been told "just
// under the roof" and placed there. So this test asserts the height stays at
// the EMPTY sentinel, and would fail on any value above it -- a test that only
// checked "the block is not there" would have passed against FillLayers.
func TestSetBlockAt_OutOfRangeWriteNeverRaisesColumnHeight(t *testing.T) {
	pal := block.NewPalette()
	stone := pal.Get("minecraft:stone", nil)
	v := New(Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 4, SizeY: 4, SizeZ: 4}, pal, block.AirID)

	// Every one of these is out of range in Y -- above the ceiling and below
	// the floor -- which is exactly the span FillLayers skipped writing and
	// then accounted for as if it had written.
	for _, y := range []int{-100, -1, 4, 5, 1000} {
		for z := 0; z < 4; z++ {
			for x := 0; x < 4; x++ {
				v.SetBlockAt(x, y, z, stone)
			}
		}
	}

	for z := 0; z < 4; z++ {
		for x := 0; x < 4; x++ {
			// GetHeight is columnTop+1, so an untouched column reads MinY.
			if got := v.GetHeight(x, z); got != v.MinY() {
				t.Errorf("GetHeight(%d, %d) = %d after writes that all fell outside the volume, want %d (empty) -- a phantom surface", x, z, got, v.MinY())
			}
			if got := v.GetHeightmapAt(x, z); got != v.MinY() {
				t.Errorf("GetHeightmapAt(%d, %d) = %d, want %d (empty) -- query.heightmap would report ground that was never written", x, z, got, v.MinY())
			}
			if got := v.GetAboveTopSolidAt(x, z); got != v.MinY() {
				t.Errorf("GetAboveTopSolidAt(%d, %d) = %d, want %d (empty) -- query.above_top_solid would report ground that was never written", x, z, got, v.MinY())
			}
		}
	}
}
