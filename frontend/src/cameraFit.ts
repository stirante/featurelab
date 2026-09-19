// cameraFit.ts -- pure geometry for fitting a perspective camera to an axis-aligned box from a
// fixed view direction. Replaces the "bounding sphere at a hand-tuned distance multiplier"
// approach viewer.ts's frameTo() used to use, which is what let the reported bug through:
// distance = radius * 1.8 (radius = half the box's own 3D diagonal) is only a correct fit for a
// box shaped close to a cube -- for a typical previewed volume (wide and shallow, terrain in the
// lower third) the sphere that circumscribes the box is much bigger than the box itself in the
// vertical axis, so a fixed multiplier tuned by eye against one shape either wastes headroom on
// a different one or, as reported, clips it (the previous fix moved the fitted box from
// "whole volume" to "occupied content only", which happened to read fine at the top for the
// terrain shapes it was checked against, but the same fixed-multiplier math still under-fit the
// bottom for others).
//
// This module has no three.js dependency (plain number vector math) so it is unit-testable
// without a WebGL context, the same reasoning contentBounds.ts's own split from viewer.ts
// already documents.

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Box3 {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface FitResult {
  /** The box's own center -- `controls.target` belongs here. */
  center: Vec3
  /** `direction`, normalized -- camera position = center + direction * distance. */
  direction: Vec3
  /** Distance from `center` to the camera along `direction`, already including the requested
   * margin (see `fitBoxToView`'s own `marginFactor` param). */
  distance: number
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(dot(v, v))
  if (len < 1e-9) return { x: 0, y: 0, z: 0 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 }
// Fallback right axis for the degenerate case where `direction` is (anti)parallel to WORLD_UP
// (a straight top/bottom-down view) -- cross(WORLD_UP, direction) is the zero vector there, so
// this module needs SOME other axis to build a right/up basis from. Arbitrary but fixed, so a
// caller framing straight down always gets the same, stable orientation rather than one that
// flips unpredictably from floating-point noise near the pole.
const DEGENERATE_RIGHT: Vec3 = { x: 1, y: 0, z: 0 }

/**
 * Computes the camera placement that frames every corner of `box` without clipping, for a
 * perspective camera positioned at `center + direction * distance` and looking back at `center`
 * (i.e. `direction` points from the framed content TOWARD the camera -- the same convention
 * viewer.ts's old `frameTo(center, radius)` used for its own `dir` constant), with vertical
 * field of view `vFovDegrees` and `aspect` = width / height.
 *
 * Unlike a bounding-sphere fit (distance = sphereRadius * constant), this projects each of the
 * box's 8 corners onto the camera's own right/up/forward axes and solves, per corner, the exact
 * distance at which that corner's projection touches the frustum edge -- then takes the max over
 * all 8, so whichever corner is actually the binding constraint for THIS box's shape and THIS
 * view direction determines the fit. No fixed constant can do that: which corner binds depends
 * on the box's own aspect ratio (see this module's header comment).
 *
 * `marginFactor` scales the mathematically exact fit for a little breathing room (1.0 = content
 * touches the frame edges pixel-for-pixel). `minHalfExtent` floors each axis's half-size before
 * fitting, so a degenerate (single-cell or empty) box still frames a sensible, non-zero volume
 * around its center instead of the camera landing on top of it.
 */
export function fitBoxToView(box: Box3, direction: Vec3, vFovDegrees: number, aspect: number, marginFactor: number, minHalfExtent: number): FitResult {
  const hx = Math.max((box.maxX - box.minX) / 2, minHalfExtent)
  const hy = Math.max((box.maxY - box.minY) / 2, minHalfExtent)
  const hz = Math.max((box.maxZ - box.minZ) / 2, minHalfExtent)
  const center: Vec3 = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: (box.minZ + box.maxZ) / 2 }

  const backward = normalize(direction)
  const nearPole = Math.abs(dot(backward, WORLD_UP)) > 0.999
  const right = normalize(nearPole ? cross(DEGENERATE_RIGHT, backward) : cross(WORLD_UP, backward))
  const camUp = normalize(cross(backward, right))

  const vFov = ((vFovDegrees * Math.PI) / 180) / 2
  const tanV = Math.tan(vFov)
  const tanH = tanV * aspect

  let distance = 0.1
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const rel: Vec3 = { x: sx * hx, y: sy * hy, z: sz * hz }
        // rz: how far this corner sits toward the camera (positive) or away from it (negative)
        // along the view axis, relative to center -- a corner closer to the camera needs LESS
        // lateral distance to hit the same screen-edge angle than one further away, which is
        // exactly the effect a bounding-sphere fit (radius alone, no per-corner depth) cannot
        // capture.
        const rz = dot(rel, backward)
        const ry = Math.abs(dot(rel, camUp))
        const rx = Math.abs(dot(rel, right))
        distance = Math.max(distance, rz + ry / tanV, rz + rx / tanH)
      }
    }
  }
  return { center, direction: backward, distance: distance * marginFactor }
}

/** `sub` is exported only for this module's own tests (corner-vector sanity checks) -- not part
 * of the public fitting API. */
export const __internal = { sub, dot, cross, normalize }

/**
 * Computes a perspective camera's near/far clip planes from its current distance to whatever
 * it's looking at (`distance`, e.g. `camera.position.distanceTo(controls.target)`) and the
 * radius of the content that should stay visible (`contentRadius`, e.g. half the framed
 * volume's own 3D diagonal -- see viewer.ts's `computeBounds`).
 *
 * This is the fix for the reported "preview vanishes when you zoom out" bug: viewer.ts used to
 * set `camera.far` only once, at framing time (frameToBox/setView), computed from THAT call's
 * own fit distance. Dollying the camera out past that fixed far plane -- entirely normal via
 * OrbitControls' scroll-to-zoom, which never touched near/far itself -- pushed every bit of
 * geometry beyond the far plane, so it all silently disappeared with no error, no banner,
 * nothing: from the user's side, "zoom out" looked indistinguishable from "the preview broke".
 * The fix is for a caller (viewer.ts's per-frame animate loop) to call this on every camera
 * move, not just at framing time, so far always covers `distance + contentRadius` regardless of
 * how far the camera has since been dollied.
 *
 * `near` scales with `distance` (rather than a fixed small constant) for the same reason
 * frameToBox/setView already did before this fix: keeping the near/far ratio bounded is what
 * keeps depth-buffer precision usable at close range -- a near plane that stayed fixed at, say,
 * 0.05 while far grew into the thousands (to accommodate a distant dolly) would starve z-buffer
 * precision for anything close to the camera. `+200` on far and the `200` divisor on near match
 * the constants frameToBox/setView already used, kept identical here so behaviour at the moment
 * of framing is unchanged -- only continuous updating on camera movement is new.
 */
export function computeClipPlanes(distance: number, contentRadius: number): { near: number; far: number } {
  const near = Math.max(0.05, distance / 200)
  // The `near + 1` floor guards the (should-not-happen) case of a non-finite or negative
  // contentRadius/distance still producing a valid near < far ordering rather than an inverted
  // or degenerate frustum.
  const far = Math.max(near + 1, distance + contentRadius + 200)
  return { near, far }
}

/** The dolly ceiling for a volume of `contentRadius` -- how far out the camera may be scrolled
 * before OrbitControls stops it.
 *
 * This used to be `max(500, radius * 40)`, which is a limit in name only: forty radii out, a
 * 32x48x32 bench subtends a few dozen pixels, so "zoomed out" and "the preview is empty" look
 * the same, and getting back needs a frame click rather than a scroll. Six radii still leaves
 * comfortable room around a framed fit (`fitBoxToView` lands near two), while keeping the bench
 * an object rather than a speck. The absolute floor is what keeps a tiny volume (radius is
 * itself floored at 4) from becoming unscrollable. */
export function maxDollyDistance(contentRadius: number): number {
  return Math.max(64, contentRadius * 6)
}

/** Whether `inner` sits entirely inside `outer`, allowing `slack` world units of overhang on
 * every side.
 *
 * The test behind viewer.ts's re-frame rule. A preview that framed once and never again is
 * correct right up until the next run puts its content somewhere else -- then the camera is
 * pointed at the space where the last result was, which on screen is indistinguishable from a
 * run that placed nothing. Slack is what stops a result one block taller than the last from
 * yanking the camera on every save: only content that genuinely escaped the framed box counts. */
export function boxContains(outer: Box3, inner: Box3, slack = 0): boolean {
  return (
    inner.minX >= outer.minX - slack &&
    inner.maxX <= outer.maxX + slack &&
    inner.minY >= outer.minY - slack &&
    inner.maxY <= outer.maxY + slack &&
    inner.minZ >= outer.minZ - slack &&
    inner.maxZ <= outer.maxZ + slack
  )
}
