// viewport.ts -- what the camera can see, and therefore what has to exist in the DOM.
//
// Pure arithmetic over world rectangles. No DOM, no camera object, no knowledge of cards or
// edges: render.ts owns the elements and this file owns the question "is it worth keeping one".
// Split out for the same reason layout.ts is split out -- the interesting part is a handful of
// comparisons that can be checked without a browser, and burying them inside a 3800-line render
// pass is how a culling bug becomes unreproducible.
//
// # Why cull at all, and why a margin
//
// The pack this editor is for is 3531 cards and 4580 edges. Every edge is four SVG paths (casing,
// line, arrowhead, fat invisible hit path) plus an HTML chip, and every card is about ten
// elements, so drawing all of it is roughly 71,000 live DOM nodes -- of which, at any readable
// zoom, a few hundred are on screen. The other 70,000 cost nothing to LOOK at and a great deal to
// keep: every whole-document style invalidation (a class on the canvas root, a zoom band flip)
// walks them, and every layout pass measures them.
//
// The margin is what stops culling from becoming its own performance problem. Attaching and
// detaching elements at the exact viewport edge would churn on every frame of a pan, so the set
// is computed for a rectangle LARGER than the viewport and recomputed only when the viewport
// leaves it (see `encloses`). A pan inside the margin therefore costs what it always cost: one
// transform on one element.
//
// The margin is a FRACTION of the viewport plus a floor, not a fixed number of world units. At
// zoom 4 a fixed margin of a few hundred units is a fraction of a card; at zoom 0.01 it is
// invisible next to a 30,000-unit world. A fraction of the viewport is the same amount of
// "slightly off screen" at every scale, which is what the margin is actually for.

/** A rectangle in WORLD units -- the same space GraphRect uses. Kept structurally identical to
 * GraphRect on purpose: render.ts passes its own rects in without converting. */
export interface WorldRect {
  x: number
  y: number
  w: number
  h: number
}

/** How much wider than the viewport the kept region is, per side, as a fraction of the viewport.
 *
 * 0.5 means the kept band extends half a screen past every edge, i.e. the culled set survives a
 * pan of half a viewport before it has to be recomputed. Chosen against the two costs it trades:
 * larger keeps more elements alive (the thing culling exists to avoid), smaller recomputes more
 * often (a linear pass over the graph, which at pack size is a fraction of a millisecond). Half a
 * screen is about ten pan gestures' worth of slack at typical trackpad speeds. */
export const CULL_MARGIN_FRACTION = 0.5

/** A floor on the margin, in world units, so a viewport that is momentarily tiny (a panel being
 * dragged narrow, a measurement taken before layout) still keeps a usable band around itself
 * rather than culling everything but a sliver. Roughly two card widths. */
export const CULL_MARGIN_MIN = 480

/** The world rectangle a camera shows in a viewport of `widthPx` x `heightPx`.
 *
 * The camera's x/y is the world point at the viewport's top-left corner and `zoom` is screen
 * pixels per world unit, which is exactly what render.ts's applyCamera writes into the transform
 * -- so this is the inverse of that one line and nothing else. */
export function viewportRect(camera: { x: number; y: number; zoom: number }, widthPx: number, heightPx: number): WorldRect {
  const zoom = camera.zoom > 0 && Number.isFinite(camera.zoom) ? camera.zoom : 1
  return { x: camera.x, y: camera.y, w: Math.max(0, widthPx) / zoom, h: Math.max(0, heightPx) / zoom }
}

/** The rectangle grown by the cull margin -- the region whose contents are kept in the DOM. */
export function keepRect(view: WorldRect, fraction = CULL_MARGIN_FRACTION, floor = CULL_MARGIN_MIN): WorldRect {
  const mx = Math.max(view.w * fraction, floor)
  const my = Math.max(view.h * fraction, floor)
  return { x: view.x - mx, y: view.y - my, w: view.w + mx * 2, h: view.h + my * 2 }
}

/** Do these two rectangles share any area? Touching edges do not count -- an element exactly one
 * unit off screen is off screen, and the margin is what gives it room anyway. */
export function overlaps(a: WorldRect, b: WorldRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Is `inner` entirely inside `outer`? This is the hysteresis test: while the viewport is still
 * inside the band that was culled for, the culled set is still correct and nothing is recomputed. */
export function encloses(outer: WorldRect, inner: WorldRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

/** The bounding box of a set of points, which for an edge is its four Bezier control points.
 *
 * A cubic is entirely contained in the convex hull of its control points, so the control-point
 * box is a CORRECT over-estimate of the curve's extent -- never too small, which is the only
 * direction that matters here: a box that is too small hides an edge that should be drawn, and a
 * box that is slightly too large keeps one that could have been left out. Flattening the curve to
 * find the true extrema would be exact and would cost a great deal more per edge, for a rectangle
 * that differs by a few tens of units on a canvas whose margin is hundreds. */
export function hullRect(points: ReadonlyArray<{ x: number; y: number }>): WorldRect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** The rectangle that contains both, or the other one when either is empty. Used to fold a
 * self-loop's arc (which reaches well above its own card) into that card's extent. */
export function unionRect(a: WorldRect, b: WorldRect): WorldRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
