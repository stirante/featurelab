// grow.go -- the geometry behind "grow to fit and regenerate" (see wire's package doc comment,
// "Grow-and-regenerate", for the full two-call flow this feeds and why it produces a genuinely
// DIFFERENT run rather than a wider view of the same one). This file only computes the larger
// bench's dimensions; wire.RunGenerateGrown/RunGenerateGrownFromWorkspace own actually running
// generate a second time against them.
package session

import "github.com/stirante/featurelab/volume"

// maxGrownAxisSize caps how far GrowBounds will ever grow a single axis -- a safety valve, not a
// realistic limit: realistic features spill at most a few dozen blocks past the bench edge, so
// this cap only matters if an
// overflow position is pathologically far away (a bug, or a feature deliberately writing whole
// chunks away) -- growing to THAT would allocate a volume of gigabytes for no useful preview.
// GrowBounds still returns a valid (if incomplete) size rather than erroring in that case; the
// caller's own diagnostics/writesOutOfBounds count on the regenerated result still tells the
// truth about whatever remains uncaptured.
const maxGrownAxisSize = 2048

// GrowBounds computes the SizeX/SizeY/SizeZ/MinY a fresh generate() call at the SAME
// (originX, originZ) must use so its resulting volume bounds contain both the bench described by
// (minX, sizeX, minY, sizeY, minZ, sizeZ) -- a just-finished run's own bounds -- and every
// position in overflow (volume.Volume.Overflow, the just-finished run's captured out-of-bounds
// writes).
//
// Horizontal growth stays centered on (originX, originZ), mirroring generate()'s own bounds
// formula exactly (MinX = OriginX - SizeX/2, MinZ = OriginZ - SizeZ/2 -- see that function's own
// doc comment) -- only the SIZE grows; the placement origin itself never moves, so the regenerated
// run stays comparable (same origin, same seed) even though its reads/writes will differ once the
// bench around that origin is bigger. Vertical growth is a plain MinY/SizeY extension, since
// MinY is never centered (generate() reads it directly).
//
// Never returns a size smaller than the input bench in any axis, even when overflow is empty --
// callers should not invoke this when overflow is empty in the first place (see
// wire.runGenerateGrown, which only grows when there is something to grow for), but this function
// makes no assumption about that and is safe to call regardless.
func GrowBounds(minX, sizeX, minY, sizeY, minZ, sizeZ, originX, originZ int, overflow []volume.OverflowBlock) (newSizeX, newSizeY, newSizeZ, newMinY int) {
	minXReq, maxXReq := minX, minX+sizeX-1
	minYReq, maxYReq := minY, minY+sizeY-1
	minZReq, maxZReq := minZ, minZ+sizeZ-1
	for _, b := range overflow {
		if b.X < minXReq {
			minXReq = b.X
		}
		if b.X > maxXReq {
			maxXReq = b.X
		}
		if b.Y < minYReq {
			minYReq = b.Y
		}
		if b.Y > maxYReq {
			maxYReq = b.Y
		}
		if b.Z < minZReq {
			minZReq = b.Z
		}
		if b.Z > maxZReq {
			maxZReq = b.Z
		}
	}

	newSizeX = growCenteredSize(sizeX, originX, minXReq, maxXReq)
	newSizeZ = growCenteredSize(sizeZ, originZ, minZReq, maxZReq)

	newMinY = minY
	if minYReq < newMinY {
		newMinY = minYReq
	}
	maxY := minY + sizeY - 1
	if maxYReq > maxY {
		maxY = maxYReq
	}
	newSizeY = maxY - newMinY + 1
	if newSizeY < sizeY {
		newSizeY = sizeY
	}
	if newSizeY > maxGrownAxisSize {
		newSizeY = maxGrownAxisSize
	}
	return newSizeX, newSizeY, newSizeZ, newMinY
}

// growCenteredSize returns the smallest size >= originalSize (capped at maxGrownAxisSize) such
// that [origin-size/2, origin-size/2+size-1] (integer division, matching generate()'s own
// MinX/MinZ formula) contains [reqMin, reqMax]. Grows by 2 at a time to preserve the rough
// left/right symmetry that formula already has around origin; a realistic overflow sits at
// most a few dozen blocks past the bench edge, so this loop runs a
// handful of iterations, never more than maxGrownAxisSize/2.
func growCenteredSize(originalSize, origin, reqMin, reqMax int) int {
	size := originalSize
	for size < maxGrownAxisSize {
		minX := origin - size/2
		maxX := minX + size - 1
		if minX <= reqMin && maxX >= reqMax {
			return size
		}
		size += 2
	}
	return maxGrownAxisSize
}
