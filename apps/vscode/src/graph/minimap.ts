// minimap.ts -- the whole pack at once, in a corner, so the camera has somewhere to aim.
//
// # Why this exists
//
// The pack this editor is for lays out to about 30,600 x 53,000 world units in 41 disconnected
// components. At a zoom where a card's identifier is readable the viewport covers well under one
// percent of that, so the canvas offers no answer at all to the two questions somebody asks
// constantly: where am I, and where is everything else. Scrolling to find out is not an answer --
// the thing being looked for is by definition off screen.
//
// A minimap answers both without changing the camera, and answers a third one nothing else does:
// how many separate drawings this pack actually is, which on a pack of mostly-unreferenced
// features is the first surprising fact about it.
//
// # What it draws, and what it deliberately does not
//
// ONE FILLED RECTANGLE PER CARD, in the card's category colour, and the camera's own rectangle
// over the top. No edges: at this scale 4580 curves are a single grey wash that hides the cards
// underneath, and the shape a reader is navigating by is the CLUSTERS, not the wiring. No labels,
// for the same reason the far zoom band drops them.
//
// It is a CANVAS, not 3531 divs. The whole point is to be cheap enough to keep up with a pan, and
// a second DOM tree the size of the first one would be the opposite of that. The cards are
// rasterised ONCE into an off-screen canvas when the graph changes, and a camera move only blits
// that image and strokes one rectangle -- so following the camera costs the same whether the pack
// has fifty cards or five thousand.
//
// # Colour
//
// Every colour is read from the `--flg-*` custom properties the stylesheet declares, through
// getComputedStyle on this widget's own element. Nothing here holds a literal colour, for exactly
// the reason media/graph.css holds none: the host re-declares those properties when the user
// switches theme, and a hard-coded swatch would be the one thing on the canvas that did not
// follow. The values are re-read on every full redraw, which is when the graph changed -- a theme
// switch also repaints, because the host restyles the document and the widget redraws with it.

/** A card, as the minimap needs it: a world rectangle and the category that colours it. */
export interface MinimapNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  category: string
  /** Which connected component this card belongs to, when the host knows. At pack size the map
   * draws the components rather than the cards -- see `rasterise`. Cards with no component (or
   * from a host that does not supply one) each count as their own. */
  component?: string
}

export interface MinimapRect {
  x: number
  y: number
  w: number
  h: number
}

export interface MinimapOptions {
  /** Where the camera should be centred, in world units, when the user points at the map. Called
   * on the press and on every move while it is held, so dragging scrubs the camera. */
  onJump: (world: { x: number; y: number }) => void
  /** Starting state. Collapsed is a legitimate preference on a small panel and is remembered by
   * whoever owns the panel, not here -- this widget has no storage. */
  collapsed?: boolean
  /** Longest side of the drawing area, in CSS pixels. */
  size?: number
}

export interface Minimap {
  readonly element: HTMLElement
  /** The graph changed: re-rasterise the cards. */
  setContent(bounds: MinimapRect, nodes: readonly MinimapNode[]): void
  /** The camera moved: move the viewport rectangle. Cheap by construction -- see the header. */
  setViewport(view: MinimapRect): void
  /** Which nodes a search currently matches, or null for "no search running". Non-matching cards
   * are drawn quieter rather than removed: a map that hides what does not match stops being a map
   * of the pack, and the answer "your search is over THERE, in the cluster you are not looking at"
   * needs the rest of the pack drawn to be legible at all. */
  setHighlight(ids: ReadonlySet<string> | null): void
  readonly collapsed: boolean
  setCollapsed(next: boolean): void
  dispose(): void
}

const DEFAULT_SIZE = 200

/** Above this many cards the map draws COMPONENTS AND NOT CARDS. See `rasterise`.
 *
 * The number is where one card stops being a mark. At 3,531 cards the drawing is 30,600 x 53,000
 * world units and the map is 200 x 110 CSS px, so a 232 x 86 card rounds to a third of a pixel
 * and is floored to one -- every card the same size, 33.5% of the map inked, and not one
 * separable cluster in it. That is not a small picture of the pack, it is noise with the pack's
 * aspect ratio. Six hundred is comfortably above the packs whose cards still have area of their
 * own and comfortably below the ones whose cards do not. */
const HULL_MIN_NODES = 600

/** The smallest the camera rectangle is allowed to be drawn, in CSS px. At pack size the true
 * rectangle is 8.3 x 6.1 px -- smaller than the pointer that has to find it, and indistinguishable
 * from the ink it is sitting on. The rectangle is an ANSWER TO "WHERE AM I", and an answer that
 * cannot be seen is not one; it is grown about its own centre, so it still points at the right
 * place and merely admits, honestly, that at this scale the viewport is a dot. */
const VIEWPORT_MIN_PX = 16

/** Where the camera rectangle is drawn on the map, in map pixels, floor included.
 *
 * Its own function because the floor is the whole content of it and a floor is exactly the kind
 * of arithmetic that is easy to get subtly wrong -- grown from a corner instead of from the
 * centre, the mark stops pointing at the place it is about. Pure; minimap.test's arithmetic half
 * checks it without a browser. */
export function viewportMark(view: MinimapRect, bounds: MinimapRect, scale: number): { x: number; y: number; w: number; h: number } {
  const trueW = view.w * scale
  const trueH = view.h * scale
  const w = Math.max(VIEWPORT_MIN_PX, trueW)
  const h = Math.max(VIEWPORT_MIN_PX, trueH)
  return { x: (view.x - bounds.x) * scale - (w - trueW) / 2, y: (view.y - bounds.y) * scale - (h - trueH) / 2, w, h }
}

/** The convex hull of a set of points, counter-clockwise, by Andrew's monotone chain.
 *
 * A hull and not a bounding box: the packer lays a component out as a staircase of layers, and
 * its bounding box is mostly the empty space beside the staircase -- boxes of neighbouring
 * components overlap where the components themselves do not, which would put the clusters back
 * into one wash. Exported for the test that checks it against known points. */
export function convexHull(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return [...points]
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (source: readonly { x: number; y: number }[]): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = []
    for (const p of source) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return [...half(sorted), ...half([...sorted].reverse())]
}

/** The category -> custom-property mapping. Kept beside the categories it names rather than
 * imported from render.ts, because importing render.ts here would close a cycle (render.ts
 * creates the minimap). The list is short, closed by the contract's edge kinds, and the test
 * suite checks every NodeCategory has an entry. */
const CATEGORY_VARIABLE: Record<string, string> = {
  rule: '--flg-kind-rule',
  sequence: '--flg-kind-sequence',
  aggregate: '--flg-kind-aggregate',
  weighted: '--flg-kind-weighted',
  conditional: '--flg-kind-conditional',
  scatter: '--flg-kind-scatter',
  filter: '--flg-kind-filter',
  child: '--flg-kind-child',
  leaf: '--flg-kind-leaf',
  unresolved: '--flg-error-fg',
  external: '--flg-fg-muted',
}

export function createMinimap(options: MinimapOptions): Minimap {
  const size = options.size ?? DEFAULT_SIZE

  const element = document.createElement('div')
  element.className = 'flg-minimap'

  const head = document.createElement('div')
  head.className = 'flg-minimap-head'

  const title = document.createElement('span')
  title.className = 'flg-minimap-title'
  title.textContent = 'Overview'
  head.append(title)

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'flg-minimap-toggle'
  toggle.title = 'Show or hide the overview map of the whole pack.'
  head.append(toggle)

  const body = document.createElement('div')
  body.className = 'flg-minimap-body'

  const canvas = document.createElement('canvas')
  canvas.className = 'flg-minimap-canvas'
  // An image with a description, not a control: everything it can do is also reachable from the
  // canvas itself (arrow keys pan, `0` fits, search jumps), so announcing it as an interactive
  // widget would add a tab stop that leads somewhere a keyboard user can already get.
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Overview of the whole pack. The outlined rectangle is the part currently on screen.')
  body.append(canvas)
  element.append(head, body)

  const context = canvas.getContext('2d')
  /** The cards, rasterised once per graph. A camera move blits this and strokes one rectangle,
   * which is the whole reason following the camera is cheap. */
  const cache = document.createElement('canvas')
  const cacheContext = cache.getContext('2d')

  let bounds: MinimapRect = { x: 0, y: 0, w: 0, h: 0 }
  let nodes: readonly MinimapNode[] = []
  let viewport: MinimapRect | null = null
  let highlight: ReadonlySet<string> | null = null
  let collapsed = options.collapsed ?? false
  let scale = 1
  let drawWidth = 0
  let drawHeight = 0
  let frame = 0
  let disposed = false
  let scrubbing: number | null = null

  /** The palette, read once per redraw rather than once per paint.
   *
   * `getComputedStyle()` is a FORCED STYLE RECALCULATION, and this widget used to call it from
   * inside the rAF that strokes the camera rectangle -- so every pan charged whatever style work
   * the document happened to owe to the minimap's frame. That is not a cost the minimap creates,
   * but it is one a CPU profile blames it for: the first profile taken of a slow card selection
   * put 221 ms under this function, while collapsing the map made the same click no faster at
   * all. The recalc it was flushing belonged to render.ts's quieting (see applyQuieting there).
   *
   * Re-read on setContent and setHighlight, which is when the graph or the theme changed -- a
   * theme switch restyles the document and the host redraws with it. paint() only reads. */
  const palette = new Map<string, string>()

  function readColour(name: string, fallback = 'currentColor'): string {
    const value = getComputedStyle(element).getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }

  function refreshPalette(): void {
    palette.clear()
    palette.set('--flg-focus', readColour('--flg-focus'))
    palette.set('--flg-bg', readColour('--flg-bg', 'transparent'))
    for (const variable of Object.values(CATEGORY_VARIABLE)) palette.set(variable, readColour(variable))
  }

  function colour(name: string, fallback = 'currentColor'): string {
    return palette.get(name) ?? fallback
  }

  /** World -> map pixels. One uniform scale for both axes, so the map is not a distorted picture
   * of the pack: an author reading "this cluster is twice as wide as it is tall" off the map has
   * to be reading a true statement. */
  function fit(): void {
    const ratio = window.devicePixelRatio || 1
    const w = Math.max(1, bounds.w)
    const h = Math.max(1, bounds.h)
    scale = Math.min(size / w, size / h)
    drawWidth = Math.max(1, Math.round(w * scale))
    drawHeight = Math.max(1, Math.round(h * scale))
    canvas.style.width = `${drawWidth}px`
    canvas.style.height = `${drawHeight}px`
    canvas.width = Math.round(drawWidth * ratio)
    canvas.height = Math.round(drawHeight * ratio)
    cache.width = canvas.width
    cache.height = canvas.height
    if (context) context.setTransform(ratio, 0, 0, ratio, 0, 0)
    if (cacheContext) cacheContext.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  /** COMPONENTS AS FILLED HULLS, which is what a map of a pack this size can honestly say.
   *
   * One rectangle per card stops meaning anything long before the pack does: at 3,531 cards the
   * map inked 33.5% of its 200 x 110 px at one floored pixel per card, with no separable cluster
   * anywhere in it. The thing a reader navigates by is the CLUSTER -- "how many separate drawings
   * is this pack, and which one am I in" is the question the map exists for, and the header says
   * so -- so at that size the clusters are what gets drawn: one filled hull per connected
   * component, in the colour of that component's commonest category.
   *
   * The fill is translucent and the outline is not, so overlapping hulls stay countable: two
   * components whose staircases interleave read as two shapes rather than as one darker blob.
   *
   * A SEARCH PUTS THE CARDS BACK, on top, at full strength. "Your hits are over there" is a
   * statement about individual features, and a hull cannot make it. */
  function rasteriseHulls(): void {
    if (!cacheContext) return
    const groups = new Map<string, { points: { x: number; y: number }[]; kinds: Map<string, number> }>()
    for (const node of nodes) {
      const key = node.component ?? node.id
      let group = groups.get(key)
      if (group === undefined) {
        group = { points: [], kinds: new Map() }
        groups.set(key, group)
      }
      const x = (node.x - bounds.x) * scale
      const y = (node.y - bounds.y) * scale
      const w = Math.max(1, node.w * scale)
      const h = Math.max(1, node.h * scale)
      group.points.push({ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h })
      group.kinds.set(node.category, (group.kinds.get(node.category) ?? 0) + 1)
    }
    for (const group of groups.values()) {
      let category = 'leaf'
      let most = -1
      for (const [kind, n] of group.kinds) {
        if (n <= most) continue
        most = n
        category = kind
      }
      const fill = colour(CATEGORY_VARIABLE[category] ?? '--flg-kind-leaf')
      const hull = convexHull(group.points)
      if (hull.length === 0) continue
      cacheContext.beginPath()
      if (hull.length < 3) {
        // A one- or two-card component has no area; a dot is the honest mark for it.
        const p = hull[0]!
        cacheContext.rect(p.x, p.y, Math.max(2, (hull[1]?.x ?? p.x) - p.x), 2)
      } else {
        cacheContext.moveTo(hull[0]!.x, hull[0]!.y)
        for (let i = 1; i < hull.length; i++) cacheContext.lineTo(hull[i]!.x, hull[i]!.y)
        cacheContext.closePath()
      }
      cacheContext.fillStyle = fill
      cacheContext.globalAlpha = 0.4
      cacheContext.fill()
      cacheContext.strokeStyle = fill
      cacheContext.globalAlpha = 0.95
      cacheContext.lineWidth = 1
      cacheContext.stroke()
    }
    cacheContext.globalAlpha = 1
    if (highlight === null) return
    for (const node of nodes) {
      if (!highlight.has(node.id)) continue
      cacheContext.fillStyle = colour(CATEGORY_VARIABLE[node.category] ?? '--flg-kind-leaf')
      cacheContext.fillRect(
        (node.x - bounds.x) * scale,
        (node.y - bounds.y) * scale,
        Math.max(2, node.w * scale),
        Math.max(2, node.h * scale),
      )
    }
  }

  function rasterise(): void {
    if (!cacheContext) return
    const ratio = window.devicePixelRatio || 1
    cacheContext.setTransform(1, 0, 0, 1, 0, 0)
    cacheContext.clearRect(0, 0, cache.width, cache.height)
    cacheContext.setTransform(ratio, 0, 0, ratio, 0, 0)
    if (nodes.length >= HULL_MIN_NODES) {
      rasteriseHulls()
      return
    }
    const fills = new Map<string, string>()
    for (const node of nodes) {
      const category = node.category
      let fill = fills.get(category)
      if (fill === undefined) {
        fill = colour(CATEGORY_VARIABLE[category] ?? '--flg-kind-leaf')
        fills.set(category, fill)
      }
      cacheContext.fillStyle = fill
      // A FLOOR of one pixel per side. A card is 232 x 86 world units and the whole pack is
      // 30,600 wide, so at this size a card rounds to well under a pixel -- and a rectangle of
      // zero width paints nothing at all, which would leave the map blank on exactly the pack it
      // exists for. One pixel is the smallest honest mark; the clusters are what carry the shape.
      const x = (node.x - bounds.x) * scale
      const y = (node.y - bounds.y) * scale
      cacheContext.globalAlpha = highlight === null || highlight.has(node.id) ? 0.85 : 0.18
      cacheContext.fillRect(x, y, Math.max(1, node.w * scale), Math.max(1, node.h * scale))
    }
    cacheContext.globalAlpha = 1
  }

  function paint(): void {
    frame = 0
    if (!context || collapsed) return
    const ratio = window.devicePixelRatio || 1
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.drawImage(cache, 0, 0, drawWidth, drawHeight)
    if (!viewport) return
    // The camera rectangle. Stroked, never filled: a filled overlay would hide the cards it is
    // sitting on, which are the ones the reader is currently looking at.
    //
    // A FLOOR ON ITS SIZE, grown about its own centre. The true rectangle at pack size is
    // 8.3 x 6.1 px: smaller than the pointer looking for it, and lost in the ink underneath.
    // Growing it makes the map say "you are about here", which is true, instead of drawing a
    // mark too small to find -- and it keeps pointing at the same place, because both axes grow
    // symmetrically around the centre of the real viewport.
    const { x, y, w, h } = viewportMark(viewport, bounds, scale)
    context.lineWidth = 1
    context.strokeStyle = colour('--flg-focus')
    context.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
  }

  function schedule(): void {
    if (disposed || frame !== 0 || collapsed) return
    frame = requestAnimationFrame(paint)
  }

  function worldAt(event: PointerEvent): { x: number; y: number } {
    const box = canvas.getBoundingClientRect()
    return {
      x: bounds.x + (event.clientX - box.left) / (scale || 1),
      y: bounds.y + (event.clientY - box.top) / (scale || 1),
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    scrubbing = event.pointerId
    canvas.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
    options.onJump(worldAt(event))
  }

  function onPointerMove(event: PointerEvent): void {
    if (scrubbing !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    options.onJump(worldAt(event))
  }

  function onPointerUp(event: PointerEvent): void {
    if (scrubbing !== event.pointerId) return
    scrubbing = null
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }

  function applyCollapsed(): void {
    element.classList.toggle('flg-minimap-collapsed', collapsed)
    body.hidden = collapsed
    toggle.setAttribute('aria-expanded', String(!collapsed))
    toggle.setAttribute('aria-label', collapsed ? 'Show the overview map' : 'Hide the overview map')
    // A glyph, not an icon font: the canvas ships no assets and a chevron drawn in text is
    // legible at every theme and every zoom the panel can be at.
    toggle.textContent = collapsed ? '▸' : '▾'
    if (!collapsed) schedule()
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  // The press must not also reach the canvas underneath and start a marquee there.
  element.addEventListener('pointerdown', (event) => event.stopPropagation())
  element.addEventListener('wheel', (event) => event.stopPropagation())
  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    collapsed = !collapsed
    applyCollapsed()
  })
  applyCollapsed()

  return {
    element,
    setContent(nextBounds, nextNodes) {
      bounds = nextBounds.w > 0 && nextBounds.h > 0 ? nextBounds : { x: 0, y: 0, w: 1, h: 1 }
      nodes = nextNodes
      element.hidden = nextNodes.length === 0
      refreshPalette()
      fit()
      rasterise()
      schedule()
    },
    setViewport(view) {
      viewport = view
      schedule()
    },
    setHighlight(ids) {
      highlight = ids
      refreshPalette()
      rasterise()
      schedule()
    },
    get collapsed() {
      return collapsed
    },
    setCollapsed(next) {
      if (collapsed === next) return
      collapsed = next
      applyCollapsed()
    },
    dispose() {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      element.remove()
    },
  }
}
