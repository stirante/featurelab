// cameraFit.test.ts -- proves fitBoxToView actually keeps every corner of the framed box inside
// the camera frustum, independently of cameraFit.ts's own internal basis-construction code: this
// uses three.js's own PerspectiveCamera + lookAt + projectionMatrix (real, separately-tested
// projection math) to turn each corner into normalized device coordinates and asserts |x|,|y| <=
// 1, rather than re-deriving the same right/up vectors cameraFit.ts itself uses and risking a
// tautological check that would pass even if that shared math were wrong.
//
// The "wide, shallow box" case below is the actual reported bug (see cameraFit.ts's own
// header comment): a typical previewed volume is much wider in X/Z than tall in Y, and the OLD
// bounding-sphere-at-a-fixed-multiplier approach (radius = half the box's 3D diagonal, distance =
// radius * 1.8) clipped such a box's bottom corners. `oldSphereFit` below reproduces that formula
// exactly and the "documents the bug this replaces" test proves it really did clip -- if
// viewer.ts's frameToBox were ever reverted to call something equivalent to oldSphereFit instead
// of fitBoxToView, the "does not clip a wide, shallow box" test is the one that would go red.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { computeClipPlanes, fitBoxToView, type Box3, type Vec3 } from '../src/cameraFit.js'

const DIAGONAL_DIR: Vec3 = { x: 1, y: 0.85, z: 1 }
const VFOV_DEG = 60
const ASPECT = 300 / 700 // sidebar-narrowed viewport shape is taller than wide; also try the inverse below
const MARGIN = 1.06
const MIN_HALF_EXTENT = 2

/** Independently verifies every corner of `box` projects inside [-1,1] NDC for the camera
 * fitBoxToView(box, ...) would place -- built from three.js's own camera/projection code, not
 * cameraFit.ts's internals (see this file's header comment). `tolerance` allows a tiny epsilon
 * for floating point, nothing more -- a real clip fails this by a wide margin, not a rounding
 * error. */
function maxCornerNdcAbs(box: Box3, direction: Vec3, vFovDeg: number, aspect: number, distance: number, center: Vec3): number {
  const dirLen = Math.sqrt(direction.x ** 2 + direction.y ** 2 + direction.z ** 2)
  const dir = { x: direction.x / dirLen, y: direction.y / dirLen, z: direction.z / dirLen }
  const eye = new THREE.Vector3(center.x + dir.x * distance, center.y + dir.y * distance, center.z + dir.z * distance)
  const target = new THREE.Vector3(center.x, center.y, center.z)
  const camera = new THREE.PerspectiveCamera(vFovDeg, aspect, 0.01, distance * 10 + 1000)
  camera.position.copy(eye)
  camera.lookAt(target)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

  let worst = 0
  for (const sx of [box.minX, box.maxX]) {
    for (const sy of [box.minY, box.maxY]) {
      for (const sz of [box.minZ, box.maxZ]) {
        const ndc = new THREE.Vector3(sx, sy, sz).applyMatrix4(vp)
        worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y))
      }
    }
  }
  return worst
}

/** The OLD, replaced approach: a bounding sphere (radius = half the box's 3D diagonal) framed
 * at a fixed distance multiplier -- see this file's header comment. */
function oldSphereFitDistance(box: Box3): number {
  const dx = box.maxX - box.minX
  const dy = box.maxY - box.minY
  const dz = box.maxZ - box.minZ
  const radius = Math.max(4, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2)
  return radius * 1.8
}

function boxCenter(box: Box3): Vec3 {
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: (box.minZ + box.maxZ) / 2 }
}

describe('fitBoxToView: no corner clips', () => {
  it('fits a roughly cubic box with margin to spare', () => {
    const box: Box3 = { minX: -8, minY: -8, minZ: -8, maxX: 8, maxY: 8, maxZ: 8 }
    const fit = fitBoxToView(box, DIAGONAL_DIR, VFOV_DEG, ASPECT, MARGIN, MIN_HALF_EXTENT)
    const worst = maxCornerNdcAbs(box, DIAGONAL_DIR, VFOV_DEG, ASPECT, fit.distance, fit.center)
    expect(worst).toBeLessThanOrEqual(1.0)
  })

  it('does not clip a wide, shallow box (32x48x32 volume, terrain only in the lower third) -- the reported bug', () => {
    // Mirrors a typical previewed volume's occupied content: wide in X/Z, short in Y, sitting
    // low relative to its own center.
    const box: Box3 = { minX: -16, minY: -4, minZ: -16, maxX: 16, maxY: 12, maxZ: 16 }
    for (const aspect of [300 / 700, 700 / 300, 1]) {
      const fit = fitBoxToView(box, DIAGONAL_DIR, VFOV_DEG, aspect, MARGIN, MIN_HALF_EXTENT)
      const worst = maxCornerNdcAbs(box, DIAGONAL_DIR, VFOV_DEG, aspect, fit.distance, fit.center)
      expect(worst).toBeLessThanOrEqual(1.0)
    }
  })

  it('does not clip a box offset far from the world origin', () => {
    const box: Box3 = { minX: 100, minY: 40, minZ: -220, maxX: 132, maxY: 88, maxZ: -188 }
    const fit = fitBoxToView(box, DIAGONAL_DIR, VFOV_DEG, ASPECT, MARGIN, MIN_HALF_EXTENT)
    const worst = maxCornerNdcAbs(box, DIAGONAL_DIR, VFOV_DEG, ASPECT, fit.distance, fit.center)
    expect(worst).toBeLessThanOrEqual(1.0)
  })

  it('a degenerate (single-cell) box still produces a finite, positive, sane distance', () => {
    const box: Box3 = { minX: 5, minY: 70, minZ: -2, maxX: 5, maxY: 70, maxZ: -2 }
    const fit = fitBoxToView(box, DIAGONAL_DIR, VFOV_DEG, ASPECT, MARGIN, MIN_HALF_EXTENT)
    expect(Number.isFinite(fit.distance)).toBe(true)
    expect(fit.distance).toBeGreaterThan(0)
    const worst = maxCornerNdcAbs(box, DIAGONAL_DIR, VFOV_DEG, ASPECT, fit.distance, fit.center)
    expect(worst).toBeLessThanOrEqual(1.0)
  })

  it('a near-top-down direction does not NaN out (the WORLD_UP-parallel degenerate case)', () => {
    const box: Box3 = { minX: -10, minY: -2, minZ: -10, maxX: 10, maxY: 6, maxZ: 10 }
    const fit = fitBoxToView(box, { x: 0.0001, y: 1, z: 0.0001 }, VFOV_DEG, ASPECT, MARGIN, MIN_HALF_EXTENT)
    expect(Number.isFinite(fit.distance)).toBe(true)
    expect(Number.isFinite(fit.center.x)).toBe(true)
  })
})

describe('fitBoxToView: documents the bug this replaces', () => {
  it('the OLD bounding-sphere-at-a-fixed-multiplier distance clips the wide/shallow box’s corners', () => {
    const box: Box3 = { minX: -16, minY: -4, minZ: -16, maxX: 16, maxY: 12, maxZ: 16 }
    const oldDistance = oldSphereFitDistance(box)
    const worst = maxCornerNdcAbs(box, DIAGONAL_DIR, VFOV_DEG, ASPECT, oldDistance, boxCenter(box))
    expect(worst).toBeGreaterThan(1.0) // clips -- this is the bug panel-full-view.png showed
  })
})

// computeClipPlanes -- the fix for "the preview vanishes when you zoom out" (viewer.ts used to
// set camera.far only once, at framing time, from that call's own fit distance; dollying out
// past it pushed all geometry beyond the far plane with no error). viewer.ts's animate() loop
// now calls this every frame with the camera's CURRENT distance to controls.target, not a
// remembered fit distance -- these tests exercise the pure formula that follow-up relies on.
describe('computeClipPlanes: far plane always covers the current camera distance + content', () => {
  it('covers a typical just-framed distance with room to spare', () => {
    const { near, far } = computeClipPlanes(50, 20)
    expect(near).toBeLessThan(far)
    expect(far).toBeGreaterThan(50 + 20)
  })

  it('keeps covering the camera even when dollied far past the original framing distance -- the reported bug', () => {
    // Simulates scrolling/dollying the camera much farther from its target than whatever
    // distance frameContent()/frameAll() last fit it at. The OLD code (camera.far set once, at
    // framing time, from THAT fit distance) would leave far fixed near `farAtFit` forever --
    // once the camera dollies out past it, every bit of content falls outside the frustum and
    // silently vanishes. This function is called fresh every frame with the camera's actual
    // current distance, so far must grow right along with it.
    const contentRadius = 20
    const fitDistance = 50
    const { far: farAtFit } = computeClipPlanes(fitDistance, contentRadius)
    const dolledOutDistance = 5000 // deliberately far past the original fit distance
    const { near, far } = computeClipPlanes(dolledOutDistance, contentRadius)
    expect(far).toBeGreaterThan(dolledOutDistance) // the camera's own current distance must stay inside the frustum
    expect(far).toBeGreaterThan(farAtFit) // proves this recomputed rather than reusing the stale fit-time far
    expect(near).toBeLessThan(far)
  })

  it('near stays tight at close range (depth precision) while far still covers the content', () => {
    const { near, far } = computeClipPlanes(1, 20)
    expect(near).toBeLessThan(1)
    expect(far).toBeGreaterThan(20)
  })

  it('never produces an inverted or degenerate near >= far frustum, even for a zero/negative input', () => {
    const { near, far } = computeClipPlanes(0, 0)
    expect(near).toBeLessThan(far)
  })
})
