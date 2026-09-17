// splitter.ts -- the resizable, collapsible divider between the viewer canvas and the sidebar,
// shared by both app shells (apps/vscode/webview/main.ts, apps/desktop/frontend/src/main.ts) --
// see createSplitter's own doc comment. Neither shell hardcodes a real sidebar width in its own
// CSS anymore, only a plain fallback for the instant before this module's script runs (see each
// host's own `#fl-sidebar` rule) -- this module owns the width from then on, persisted the same
// best-effort way panel.ts persists section-open/closed state (see STORAGE_KEY below, a sibling
// key to panel.ts's own STORAGE_KEY, never the same object). It never touches the viewer or
// camera directly: resizing/collapsing only ever changes `sidebar`'s own CSS box, which each
// host's own ResizeObserver (observing the CANVAS, set up by the host, not here) is what
// actually calls `viewer.resize()` in reaction to -- and `VoxelViewer.resize()` only ever
// touches `camera.aspect`/the renderer's pixel size, never `camera.position`/`controls.target`
// (see viewer.ts's own `resize()` vs `frameAll()`). That split is what keeps "regenerate on
// save without losing camera position" true even across a drag, a collapse, or an expand.
//
// # Why the sidebar was "too generous" in the first place
//
// Both hosts previously hardcoded `#fl-sidebar { flex: 0 0 320px }` / `340px` directly in their
// own shell CSS -- fine in a full-width editor tab, but the ONE fixed number regardless of how
// narrow the actual host window/column/side-panel was. Measured empirically (not guessed): at a 700px-wide webview the 3D view already shrank to a
// 360px-wide canvas; at 420px wide it shrank to just 80px -- the exact "tiny preview" the user
// reported. The canvas's own ResizeObserver-driven resize() was never the bug (verified: its
// backing buffer already tracked its CSS box exactly, at every width tested) -- the sidebar
// simply never gave the canvas a chance to be anything but a sliver in a narrow host. This
// module's default (see DEFAULT_SIDEBAR_WIDTH) is deliberately narrower than either old fixed
// value, and MIN_SIDEBAR_WIDTH/MAX_SIDEBAR_WIDTH keep a drag from making either side unusably
// small no matter how the user drags or how narrow the host window already is.
const STORAGE_KEY = 'featurelab.layout.v1'

/** Default width for a first-ever run (nothing in localStorage yet) -- narrower than either
 * host's own old hardcoded 320/340px fixed sidebar, since "give the 3D view the dominant share
 * of the panel" needs to hold by default, not just once a user
 * discovers the drag handle. */
export const DEFAULT_SIDEBAR_WIDTH = 300
/** Floor a drag (or a persisted value from a since-narrowed host) can shrink the sidebar to.
 * Below this, `.fl-row-label`'s own fixed 108px width plus a section's own border/padding
 * leaves so little room for a row's control that `.fl-radio-group`'s own options -- no
 * `white-space: nowrap` by design, since a select/text input's own text is already handled by
 * ellipsis/shrinking, not wrapping -- start wrapping to a second line, which WOULD grow that
 * row's height and reintroduce exactly the class of clipping bug
 * apps/vscode/test/panelLayout.test.ts guards against (see that file's own "verify at a few
 * widths, including the narrowest allowed" test, which asserts against this exact constant). */
export const MIN_SIDEBAR_WIDTH = 240
/** Ceiling a drag can grow the sidebar to -- this is a control panel, not a document; past this
 * width it's only ever eating canvas space no control inside it needs. */
export const MAX_SIDEBAR_WIDTH = 560
/** Floor on the CANVAS side of the split, enforced by clamping how far a drag (or a narrow host
 * window) is allowed to push the sidebar -- the 3D view must never be squeezed away to nothing
 * the way the pre-fix fixed-width sidebar could (see this file's header comment). */
export const MIN_CANVAS_WIDTH = 160

interface PersistedLayout {
  width: number
  collapsed: boolean
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function loadPersisted(key: string): PersistedLayout | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    if (!isFiniteNumber(obj.width) || typeof obj.collapsed !== 'boolean') return null
    return { width: obj.width, collapsed: obj.collapsed }
  } catch {
    // localStorage unavailable (quota, private mode, a webview host that restricts it) --
    // persistence is best-effort, same posture as panel.ts's own loadPersisted().
    return null
  }
}

function persist(key: string, state: PersistedLayout): void {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // best-effort -- see loadPersisted's own comment.
  }
}

export interface SplitterOptions {
  /** The flex-row container that already directly parents `sidebar` as a flex child (and,
   * typically, the viewer canvas as another, immediately before it) -- the drag handle is
   * inserted as a new sibling immediately before `sidebar`. Both current hosts already have
   * exactly this shape (the VS Code webview's `#fl-root`, the Wails app's `#fl-main`). */
  container: HTMLElement
  /** The sidebar element whose width this owns from here on -- neither host's own CSS should
   * keep fighting this module over `flex`/`flex-basis` once created (a plain, generous
   * fallback for the instant before this constructor runs is fine and expected -- see each
   * host's own `#fl-sidebar` rule). */
  sidebar: HTMLElement
  /** Where this splitter's width and collapsed state are remembered.
   *
   * Defaults to the one key this module has always used, which is right while a host has ONE
   * splitter. It stopped being right when the graph editor grew a sidebar of its own: two
   * different panels, two different useful widths, one key -- so resizing one silently resized
   * the other the next time it opened. A host with more than one names them apart. */
  storageKey?: string
}

export interface SplitterHandle {
  /** True when the sidebar is currently collapsed (hidden, full-width canvas). */
  isCollapsed(): boolean
  /** Hides the sidebar entirely for a full-width preview -- same effect as the user clicking
   * the splitter's own toggle button. No-op if already collapsed. */
  collapse(): void
  /** Restores a collapsed sidebar to its last (persisted) width. No-op if not collapsed. */
  expand(): void
}

/** Inserts a draggable, collapsible divider between `opts.sidebar` and its canvas sibling,
 * owning the sidebar's width from here on -- restored from localStorage (falling back to
 * DEFAULT_SIDEBAR_WIDTH) the same way panel.ts restores section-open/closed state, and
 * persisted again after every drag or collapse/expand. See this file's header comment for why
 * this never touches the viewer/camera directly. */
export function createSplitter(opts: SplitterOptions): SplitterHandle {
  const { container, sidebar } = opts
  const storageKey = opts.storageKey ?? STORAGE_KEY
  const persisted = loadPersisted(storageKey)
  // The user's own intent -- set by a drag (or defaulted), clamped only to the static MIN/MAX
  // bounds. Kept separate from what's actually painted (see effectiveWidth below) so a host
  // window that's TEMPORARILY too narrow to honour it (see this file's header comment for the
  // measured "700px host -> 360px canvas, 420px host -> 80px canvas" case this guards against)
  // doesn't destroy that preference -- widening the host back out snaps to the full preferred
  // width again, it was never overwritten, only visually capped in between.
  let preferredWidth = clamp(isFiniteNumber(persisted?.width) ? persisted!.width : DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  let collapsed = persisted?.collapsed ?? false

  const splitter = document.createElement('div')
  splitter.className = 'fl-splitter'
  splitter.setAttribute('role', 'separator')
  splitter.setAttribute('aria-orientation', 'vertical')

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'fl-splitter-toggle'
  splitter.append(toggle)

  container.insertBefore(splitter, sidebar)

  /** preferredWidth, further clamped down to whatever the CURRENT container can actually
   * afford while still leaving the canvas at least MIN_CANVAS_WIDTH -- this is what keeps a
   * narrow host window (or one that gets dragged narrower after the fact) from ever squeezing
   * the 3D view away to nothing, without requiring the user to notice and manually drag the
   * splitter back every time. Recomputed on demand (container resize, drag, collapse/expand),
   * not cached -- cheap enough (a couple of getBoundingClientRect calls) to not need it. */
  function effectiveWidth(): number {
    const containerWidth = container.getBoundingClientRect().width
    const splitterWidth = splitter.getBoundingClientRect().width || 8
    const maxByContainer = Math.max(MIN_SIDEBAR_WIDTH, containerWidth - MIN_CANVAS_WIDTH - splitterWidth)
    return clamp(preferredWidth, MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, maxByContainer))
  }

  function applySidebarWidth(): void {
    sidebar.style.flex = `0 0 ${effectiveWidth()}px`
  }

  function applyCollapsed(): void {
    splitter.classList.toggle('fl-splitter-collapsed', collapsed)
    // Arrow points the direction the sidebar will move on click: collapsed -> clicking brings
    // it back (points left, toward where it will reappear); expanded -> clicking sends it away
    // (points right, toward the edge it will disappear off).
    toggle.textContent = collapsed ? '◀' : '▶'
    toggle.title = collapsed ? 'Show sidebar' : 'Hide sidebar'
    toggle.setAttribute('aria-label', toggle.title)
    if (collapsed) {
      sidebar.style.display = 'none'
    } else {
      sidebar.style.removeProperty('display')
      applySidebarWidth()
    }
  }

  applyCollapsed()

  // Container-width-aware, not just drag-aware: dragging the VS Code panel, moving this view
  // between the editor area and a side panel, or just narrowing the window all resize
  // #fl-root/#fl-main WITHOUT the user ever touching the splitter -- re-clamp effectiveWidth
  // every time that happens so the sidebar never keeps squeezing the canvas below
  // MIN_CANVAS_WIDTH just because it hasn't been dragged recently.
  const containerResizeObserver = new ResizeObserver(() => {
    if (!collapsed) applySidebarWidth()
  })
  containerResizeObserver.observe(container)

  toggle.addEventListener('click', () => {
    collapsed = !collapsed
    applyCollapsed()
    persist(storageKey, { width: preferredWidth, collapsed })
  })

  let dragging = false
  let startX = 0
  let startWidth = preferredWidth

  splitter.addEventListener('pointerdown', (ev) => {
    if (collapsed || ev.target === toggle) return
    dragging = true
    startX = ev.clientX
    startWidth = effectiveWidth()
    splitter.classList.add('fl-splitter-dragging')
    splitter.setPointerCapture(ev.pointerId)
    ev.preventDefault()
  })

  splitter.addEventListener('pointermove', (ev) => {
    if (!dragging) return
    // The sidebar sits to the right of the splitter in both current hosts -- dragging left
    // (negative dx) grows it, dragging right shrinks it.
    const dx = ev.clientX - startX
    preferredWidth = clamp(startWidth - dx, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
    applySidebarWidth()
  })

  function endDrag(ev: PointerEvent): void {
    if (!dragging) return
    dragging = false
    splitter.classList.remove('fl-splitter-dragging')
    try {
      splitter.releasePointerCapture(ev.pointerId)
    } catch {
      // Already released (e.g. a pointercancel beat us to it) -- fine, nothing left to do.
    }
    persist(storageKey, { width: preferredWidth, collapsed })
  }
  splitter.addEventListener('pointerup', endDrag)
  splitter.addEventListener('pointercancel', endDrag)

  return {
    isCollapsed: () => collapsed,
    collapse: () => {
      if (collapsed) return
      collapsed = true
      applyCollapsed()
      persist(storageKey, { width: preferredWidth, collapsed })
    },
    expand: () => {
      if (!collapsed) return
      collapsed = false
      applyCollapsed()
      persist(storageKey, { width: preferredWidth, collapsed })
    },
  }
}
