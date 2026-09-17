// Package volume is a finite, in-memory block world standing in for a chunk
// region during generation. An out-of-bounds write never reaches the grid,
// but it is not discarded either: it is captured into an overflow store (see
// OverflowBlock/Volume.Overflow) so a caller can show what the bench's own
// finite bounds hid, without changing what GetBlock/Contains report to a
// FEATURE mid-placement -- see Volume's own doc comment for why read
// semantics staying untouched is the whole point.
package volume

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

// WriteBudgetExceeded is raised (via panic, recovered by the caller) when a placement exceeds
// Volume.WriteBudget. Attempted is WritesAttempted at the
// moment the panic was raised (always Budget+1: the guard checks AFTER incrementing) -- carried
// explicitly so a diagnostic can say the count actually reached, not just the configured limit.
// Chain/Position are profiler.CurrentChain()/the write's own (x,y,z) captured at the SAME moment,
// before any deferred PopFeatureFrame unwinds the chain -- see profiler.go's "Always-on
// delegation chain" doc comment for why this can't be reconstructed later, after recover().
type WriteBudgetExceeded struct {
	Budget, Attempted int
	Chain             []profiler.ChainFrame
	Position          wgen.BlockPos
}

func (e *WriteBudgetExceeded) Error() string {
	return fmt.Sprintf("write budget hit at %d of %d block writes", e.Attempted, e.Budget)
}

// Bounds is the fixed extent a Volume covers.
type Bounds struct {
	MinX, MinY, MinZ    int
	SizeX, SizeY, SizeZ int
}

// OverflowBlock is one out-of-bounds SetBlock call captured by a Volume's overflow store (see
// Volume.Overflow's doc comment for the store itself). X/Y/Z are absolute world coordinates --
// NOT relative to the volume's own bounds, since a position captured here is by definition
// outside them -- and ID decodes via the same block.Palette every in-bounds cell already uses.
// Tagged lowerCamelCase for the wire contract this type crosses directly as
// session.Result.OverflowBlocks -- see featurelab-go/wire's package doc comment, "Out-of-bounds
// capture".
type OverflowBlock struct {
	X  int      `json:"x"`
	Y  int      `json:"y"`
	Z  int      `json:"z"`
	ID block.ID `json:"id"`
}

// Volume implements wgen.BlockWorld. Reads outside the volume yield OOBBlock (air by
// default) -- read semantics are completely unchanged by the overflow store below: GetBlock/
// Contains behave exactly as they always have, so enlarging what a run CAPTURES never changes
// what a run PRODUCES (that distinction matters: growing
// the volume itself, rather than just recording what fell outside it, would let features read
// real terrain where they used to read the OOB sentinel, silently changing placement decisions
// and RNG draws). Writes outside the volume are still dropped from `data` -- but, unlike before,
// are no longer discarded entirely: see the "Overflow store" section below.
type Volume struct {
	bounds   Bounds
	palette  *block.Palette
	oobBlock block.ID

	data        []block.ID
	columnTop   []int32 // highest non-air Y per column, or minY-1 for empty
	layerStride int

	WritesOutOfBounds int

	// --- Overflow store ---------------------------------------------------------------------
	//
	// overflowIndex/overflowBlocks capture every out-of-bounds SetBlockAt call so a viewer can
	// render what would otherwise be silently lost -- see OverflowBlock's own doc comment and
	// Overflow() below. Both are nil until the first out-of-bounds write, so a run that never
	// leaves the volume (the overwhelming majority) pays exactly what it always paid: the
	// out-of-bounds branch in SetBlockAt is off the hot in-bounds path already (see that
	// method's own doc comment), and nothing on the in-bounds path changed at all -- the write
	// path stays held to the same "off costs nothing" standard as the profiler hook it sits
	// beside (see that hook's own comment, just below).
	//
	// overflowIndex maps a captured world position to its slot in overflowBlocks, so a repeat
	// write to the SAME out-of-bounds cell (e.g. a scatter feature that keeps re-rolling a
	// position just past the edge) updates that slot's id in place -- last write wins, exactly
	// like an in-bounds cell -- instead of growing the slice once per ATTEMPT rather than once
	// per unique cell.
	overflowIndex  map[[3]int]int
	overflowBlocks []OverflowBlock

	// WriteBudget: max SetBlock attempts before placement aborts (panics
	// with *WriteBudgetExceeded), or nil for no limit. The guard is charged in
	// SetBlockAt, the single chokepoint every feature write funnels through.
	WriteBudget     *int
	WritesAttempted int
}

// New builds an empty volume of the given bounds, filled with air.
func New(bounds Bounds, palette *block.Palette, oobBlock block.ID) *Volume {
	stride := bounds.SizeX * bounds.SizeZ
	v := &Volume{
		bounds:      bounds,
		palette:     palette,
		oobBlock:    oobBlock,
		layerStride: stride,
		data:        make([]block.ID, stride*bounds.SizeY),
		columnTop:   make([]int32, stride),
	}
	for i := range v.columnTop {
		v.columnTop[i] = int32(bounds.MinY - 1)
	}
	return v
}

func (v *Volume) MinX() int                  { return v.bounds.MinX }
func (v *Volume) MinY() int                  { return v.bounds.MinY }
func (v *Volume) MinZ() int                  { return v.bounds.MinZ }
func (v *Volume) SizeX() int                 { return v.bounds.SizeX }
func (v *Volume) SizeY() int                 { return v.bounds.SizeY }
func (v *Volume) SizeZ() int                 { return v.bounds.SizeZ }
func (v *Volume) MaxY() int                  { return v.bounds.MinY + v.bounds.SizeY }
func (v *Volume) Palette() wgen.IPaletteView { return v.palette }
func (v *Volume) RawPalette() *block.Palette { return v.palette }

func (v *Volume) index(x, y, z int) int {
	return (y-v.bounds.MinY)*v.layerStride + (z-v.bounds.MinZ)*v.bounds.SizeX + (x - v.bounds.MinX)
}

func (v *Volume) columnIndex(x, z int) int {
	return (z-v.bounds.MinZ)*v.bounds.SizeX + (x - v.bounds.MinX)
}

func (v *Volume) Contains(p wgen.BlockPos) bool {
	return p.X >= v.bounds.MinX && p.X < v.bounds.MinX+v.bounds.SizeX &&
		p.Y >= v.bounds.MinY && p.Y < v.bounds.MinY+v.bounds.SizeY &&
		p.Z >= v.bounds.MinZ && p.Z < v.bounds.MinZ+v.bounds.SizeZ
}

func (v *Volume) containsColumn(x, z int) bool {
	return x >= v.bounds.MinX && x < v.bounds.MinX+v.bounds.SizeX && z >= v.bounds.MinZ && z < v.bounds.MinZ+v.bounds.SizeZ
}

func (v *Volume) GetBlock(p wgen.BlockPos) block.ID {
	if !v.Contains(p) {
		return v.oobBlock
	}
	return v.data[v.index(p.X, p.Y, p.Z)]
}

func (v *Volume) GetBlockAt(x, y, z int) block.ID {
	return v.GetBlock(wgen.BlockPos{X: x, Y: y, Z: z})
}

// SetBlock writes through SetBlockAt: budget-checked (panics with
// *WriteBudgetExceeded past WriteBudget), drops out-of-bounds writes, and
// maintains the per-column height cache columnTop reads/writes rely on.
func (v *Volume) SetBlock(p wgen.BlockPos, id block.ID) bool {
	return v.SetBlockAt(p.X, p.Y, p.Z, id)
}

// ChargeWrite books one SetBlock ATTEMPT against WriteBudget, panicking with
// *WriteBudgetExceeded once the budget is passed. SetBlockAt calls it, so ordinary writes are
// accounted exactly as before; it is separately exported for wrappers that BUFFER a write now and
// land it later (features.transactionalTarget, minecraft:search_feature's own
// transactional-write-target reconstruction). Such a wrapper charges the attempt when it
// buffers and replays through SetBlockUnbudgeted, so a runaway delegate inside a search is
// stopped at the same write count as one outside a search, and a committed search is not charged
// twice for the same write.
//
// Nested searches wrap a transactionalTarget in a transactionalTarget. The inner wrapper's inner
// is not a *Volume, so it does not reach this method and does not charge; its writes are charged
// when it commits into the OUTER wrapper, which does. Later than an unwrapped write, but exactly
// once -- which is the property that matters.
func (v *Volume) ChargeWrite(p wgen.BlockPos) {
	if v.WriteBudget == nil {
		return
	}
	v.WritesAttempted++
	if v.WritesAttempted > *v.WriteBudget {
		panic(&WriteBudgetExceeded{
			Budget: *v.WriteBudget, Attempted: v.WritesAttempted,
			Chain: profiler.CurrentChain(), Position: p,
		})
	}
}

// SetBlockUnbudgeted is SetBlockAt without the ChargeWrite call -- everything else, including the
// out-of-bounds drop, the overflow record and the column-top maintenance, is identical. Only for
// callers that already charged the attempt themselves; see ChargeWrite.
func (v *Volume) SetBlockUnbudgeted(p wgen.BlockPos, id block.ID) bool {
	return v.setBlockAt(p.X, p.Y, p.Z, id)
}

func (v *Volume) SetBlockAt(x, y, z int, id block.ID) bool {
	v.ChargeWrite(wgen.BlockPos{X: x, Y: y, Z: z})
	return v.setBlockAt(x, y, z, id)
}

func (v *Volume) setBlockAt(x, y, z int, id block.ID) bool {
	if !v.Contains(wgen.BlockPos{X: x, Y: y, Z: z}) {
		v.WritesOutOfBounds++
		v.recordOverflow(x, y, z, id)
		return false
	}
	idx := v.index(x, y, z)
	v.data[idx] = id
	col := v.columnIndex(x, z)
	if !v.palette.IsAir(id) {
		if int32(y) > v.columnTop[col] {
			v.columnTop[col] = int32(y)
		}
	} else if int32(y) == v.columnTop[col] {
		scan := y - 1
		for scan >= v.bounds.MinY && v.palette.IsAir(v.data[v.index(x, scan, z)]) {
			scan--
		}
		v.columnTop[col] = int32(scan)
	}
	// Profiler hook (see profiler/profiler.go's header) -- this is
	// the single chokepoint every feature write funnels through, so it's the only place
	// per-cell touch counts can be collected. profiler.ProfilingActive is a package-level
	// var read directly, not a function call, so the disabled cost is one boolean check
	// with no allocation and no map lookup.
	if profiler.ProfilingActive {
		profiler.RecordWrite(idx)
	}
	return true
}

// recordOverflow appends (or, for a repeat write to the same out-of-bounds cell, updates in
// place) one captured OverflowBlock -- see the "Overflow store" section of this type's own doc
// comment. Only ever called from SetBlockAt's out-of-bounds branch, itself off the hot in-bounds
// path, so the lazy map/slice allocation here is paid by runs that actually spill, never by the
// overwhelming majority that don't.
func (v *Volume) recordOverflow(x, y, z int, id block.ID) {
	if v.overflowIndex == nil {
		v.overflowIndex = make(map[[3]int]int)
	}
	key := [3]int{x, y, z}
	if idx, ok := v.overflowIndex[key]; ok {
		v.overflowBlocks[idx].ID = id
		return
	}
	v.overflowIndex[key] = len(v.overflowBlocks)
	v.overflowBlocks = append(v.overflowBlocks, OverflowBlock{X: x, Y: y, Z: z, ID: id})
}

// Overflow returns a copy of every out-of-bounds block captured so far, ordered by first write
// to each unique out-of-bounds cell -- see OverflowBlock's own doc comment. Empty, never nil,
// when nothing has spilled (mirrors Data()'s own "always a real slice" contract) so a caller
// (e.g. encoding/json) never has to special-case nil vs. empty.
func (v *Volume) Overflow() []OverflowBlock {
	out := make([]OverflowBlock, len(v.overflowBlocks))
	copy(out, v.overflowBlocks)
	return out
}

// GetHeight is the Y of the first free cell above the column's topmost
// non-air block.
func (v *Volume) GetHeight(x, z int) int {
	if !v.containsColumn(x, z) {
		return v.bounds.MinY
	}
	return int(v.columnTop[v.columnIndex(x, z)]) + 1
}

func (v *Volume) clampColumn(x, z int) (int, int) {
	cx := x
	if cx < v.bounds.MinX {
		cx = v.bounds.MinX
	}
	if cx > v.bounds.MinX+v.bounds.SizeX-1 {
		cx = v.bounds.MinX + v.bounds.SizeX - 1
	}
	cz := z
	if cz < v.bounds.MinZ {
		cz = v.bounds.MinZ
	}
	if cz > v.bounds.MinZ+v.bounds.SizeZ-1 {
		cz = v.bounds.MinZ + v.bounds.SizeZ - 1
	}
	return cx, cz
}

// GetHeightmapAt backs query.heightmap: same "any non-air counts" cached
// convention as GetHeight, clamped to the nearest in-volume column.
func (v *Volume) GetHeightmapAt(x, z int) int {
	cx, cz := v.clampColumn(x, z)
	return int(v.columnTop[v.columnIndex(cx, cz)]) + 1
}

// GetAboveTopSolidAt backs query.above_top_solid: a live top-down scan for
// the first palette.IsSolid block (liquids/plants skipped), independent of
// the cached columnTop GetHeight/GetHeightmapAt use.
func (v *Volume) GetAboveTopSolidAt(x, z int) int {
	cx, cz := v.clampColumn(x, z)
	for y := v.MaxY() - 1; y >= v.bounds.MinY; y-- {
		if v.palette.IsSolid(v.data[v.index(cx, y, cz)]) {
			return y + 1
		}
	}
	return v.bounds.MinY
}

// FillLayers was deleted, deliberately: it had no caller anywhere in the tree
// (its own doc comment claimed it was "used when building environments"; every
// preset in env/ writes cell by cell through SetBlockAt instead), and it
// carried a latent height-cache bug that only a caller would have exposed --
// given a Y span entirely outside the volume and a non-air block, every write
// was skipped, yet the columnTop pass below the loop still raised EVERY column
// to MaxY()-1. That is a phantom surface: query.heightmap and
// query.above_top_solid would have reported a ceiling of solid ground over a
// bench that is actually empty, for every column, for the whole run. The
// invariant it broke -- a write that lands nowhere must not raise a column --
// is pinned directly on SetBlockAt by
// TestSetBlockAt_OutOfRangeWriteNeverRaisesColumnHeight (volume_test.go), so
// re-introducing a bulk-fill helper with the same shape fails a test rather
// than shipping.

// RecomputeHeights rebuilds columnTop from scratch -- the supported way to
// resynchronize the height cache after a bulk write that bypassed SetBlockAt.
// Unreferenced since FillLayers (its only caller) was deleted just above; kept
// because it is the CORRECT version of the accounting FillLayers got wrong, and
// because any future bulk-fill helper needs exactly this and nothing cheaper.
func (v *Volume) RecomputeHeights() {
	for z := 0; z < v.bounds.SizeZ; z++ {
		for x := 0; x < v.bounds.SizeX; x++ {
			col := z*v.bounds.SizeX + x
			y := v.bounds.MinY + v.bounds.SizeY - 1
			for y >= v.bounds.MinY && v.palette.IsAir(v.data[v.index(v.bounds.MinX+x, y, v.bounds.MinZ+z)]) {
				y--
			}
			v.columnTop[col] = int32(y)
		}
	}
}

// Snapshot is a detached copy of Volume's block ids and height cache.
type Snapshot struct {
	data      []block.ID
	columnTop []int32
}

// Snapshot captures this volume's current state.
//
// It deliberately does NOT touch WritesOutOfBounds or the overflow store; only
// Restore does. See ResetOutOfBoundsAccounting for the caller that needs the
// counters cleared without a restore, and why.
func (v *Volume) Snapshot() Snapshot {
	data := make([]block.ID, len(v.data))
	copy(data, v.data)
	ct := make([]int32, len(v.columnTop))
	copy(ct, v.columnTop)
	return Snapshot{data: data, columnTop: ct}
}

// Restore resets this volume's block ids and height cache from a snapshot
// taken earlier on a volume with the SAME bounds. Also resets
// WritesOutOfBounds to 0, and clears the overflow store (see Overflow) --
// a fresh baseline means a fresh run, so an out-of-bounds write captured
// before this Restore must not leak into whatever runs after it (this is
// what keeps goldentest/harness.go's PlaceOne, which reuses one proto
// Volume across many placements, from attributing one feature's overflow to
// the next).
func (v *Volume) Restore(s Snapshot) {
	copy(v.data, s.data)
	copy(v.columnTop, s.columnTop)
	v.WritesOutOfBounds = 0
	v.overflowIndex = nil
	v.overflowBlocks = nil
}

// ResetOutOfBoundsAccounting zeroes WritesOutOfBounds and clears the overflow
// store WITHOUT touching the blocks -- the half of Restore that a caller wants
// when it has just finished writing the world a feature will be placed into.
//
// Building a bench environment is a write pass like any other, so a preset that
// spills outside the requested bounds bumps the same counter a feature's own
// writes do. Everything downstream reads that counter as the FEATURE's: the
// wire reports writesOutOfBounds and overflowBlocks, the diagnostic says "all N
// writes landed outside the previewed volume ... that is expected for a feature
// that works on neighbouring chunks", and --grow expands the bench and
// regenerates on the strength of it. All of that was reachable with an ordinary
// flag combination and a feature that wrote nothing at all: `--env end --size
// 32x10x32 --origin 0,46,0` attributed 36 end_stone writes, one row below the
// floor, to whatever feature happened to be running.
func (v *Volume) ResetOutOfBoundsAccounting() {
	v.WritesOutOfBounds = 0
	v.overflowIndex = nil
	v.overflowBlocks = nil
}

// Data returns a copy of this volume's current block ids, indexed the same
// way as Diff's masks and a Snapshot's own Data().
func (v *Volume) Data() []block.ID {
	out := make([]block.ID, len(v.data))
	copy(out, v.data)
	return out
}

// Data returns a copy of the block ids this snapshot captured, same
// indexing as Volume.Data().
func (s Snapshot) Data() []block.ID {
	out := make([]block.ID, len(s.data))
	copy(out, s.data)
	return out
}

// Diff classifies every cell where this volume's CURRENT data differs from
// baseline (a snapshot taken earlier on this same volume) into three disjoint
// outcomes, using palette.IsAir:
//   - Added:    baseline was air, current is non-air
//   - Removed:  baseline was non-air, current is air -- "carved out", which
//     reads as nothing in a plain block-id mesh since air draws no geometry
//   - Replaced: both baseline and current are non-air, and differ
//
// Changed is the superset of all three PLUS the one case none of them
// cover: two different air-kind ids (e.g. minecraft:air ->
// minecraft:cave_air) -- a real id-level diff, but neither an add, a
// remove, nor a "block replaced" in any meaningful sense, so it is
// deliberately left out of Added/Removed/Replaced.
func (v *Volume) Diff(baseline Snapshot) Diff {
	length := len(v.data)
	d := Diff{
		Changed:  make([]byte, length),
		Added:    make([]byte, length),
		Removed:  make([]byte, length),
		Replaced: make([]byte, length),
	}
	for i := 0; i < length; i++ {
		before := baseline.data[i]
		after := v.data[i]
		if before == after {
			continue
		}
		d.Changed[i] = 1
		d.ChangedCount++
		beforeAir := v.palette.IsAir(before)
		afterAir := v.palette.IsAir(after)
		switch {
		case beforeAir && !afterAir:
			d.Added[i] = 1
			d.AddedCount++
		case !beforeAir && afterAir:
			d.Removed[i] = 1
			d.RemovedCount++
		case !beforeAir && !afterAir:
			d.Replaced[i] = 1
			d.ReplacedCount++
		}
	}
	return d
}

// Diff is the result of Volume.Diff -- see that method's doc comment for
// exactly what each mask/count means.
type Diff struct {
	// Changed is 1 for any cell whose id differs between the current volume
	// and the baseline.
	Changed []byte
	// Added is 1 for a cell where the baseline was air and the current
	// result is non-air.
	Added []byte
	// Removed is 1 for a cell where the baseline was non-air and the
	// current result is air -- carved out, invisible in a plain block-id
	// mesh (see Volume.Diff's doc comment).
	Removed []byte
	// Replaced is 1 for a cell where both baseline and current are non-air
	// but differ.
	Replaced                                              []byte
	ChangedCount, AddedCount, RemovedCount, ReplacedCount int
}

var _ wgen.BlockWorld = (*Volume)(nil)
