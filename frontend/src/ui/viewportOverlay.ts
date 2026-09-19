// viewportOverlay.ts -- the controls that live ON the 3D view, rather than at the bottom of the
// eighth accordion in the sidebar.
//
// Everything here is DOM and nothing here is three.js: VoxelViewer owns the camera and the scene
// and calls into this module, which is what lets the overlay be tested in jsdom (see
// frontend/test/viewportOverlay.test.ts) while the viewer itself still needs a WebGL context.
//
// # Why these five buttons and not the whole View section
//
// A control belongs here when the answer to "did that do what I wanted" is IN the viewport:
// framing, how the surrounding terrain is drawn, whether the bench outline is on, whether the
// projection is perspective or orthographic, and whether blocks are drawn with their textures.
// Everything else -- the Y cut, the carved and heatmap lenses, the overflow toggle -- stays in
// the sidebar, because its own readout (a count, a slider value, a disabled reason) is there.
// This is deliberately not "the View section, but floating": duplicating a section into an
// overlay is how two copies of one setting start disagreeing.
//
// The sidebar's own rows remain the authority on state; this overlay is fed from them through
// `sync()` and reports its own clicks back out through the `on*` callbacks, so a click here and a
// click there are the same action with two affordances, never two settings.
//
// # The gizmo says which way is up, and how big
//
// A voxel preview with no horizon, no shadows and no reference object gives a viewer nothing to
// judge orientation or scale against -- an axis triad plus the bench's own dimensions is the
// cheapest honest answer to both. The triad is drawn from the camera basis the viewer hands over
// each frame, so it is a readout of the real camera, not a decoration.
//
// # The pill is the busy state
//
// Dimming the canvas to 0.45 made a working preview look like a broken one (the page showed
// through it). The last frame now stays at full opacity and the pill says what is happening,
// for how long, and offers the way out -- see `setBusy`/`setElapsed`/`setCancelHandler`.
//
// # What is SEEN and what is ANNOUNCED are two different streams
//
// The pill was itself a `role=status aria-live=polite` region while `setElapsed` rewrote its
// text ten times a second: 30 mutations in three seconds, and 16 more in the four after Cancel.
// A polite queue does not coalesce that -- it backs up, and the reading a screen reader user
// gets is stale seconds from a run that finished long ago. The pill is now ordinary text, and a
// single visually-hidden announcer (`.fl-vp-announce`) carries the TRANSITIONS only: a run
// started, a cancellation asked for, a cancellation unanswered. Four announcements for a run,
// instead of one every 100ms.

import { h } from './dom.js'

export type OverlayEnvironmentMode = 'solid' | 'ghost' | 'hidden'
export type OverlayProjection = 'perspective' | 'orthographic'

/** The viewer state the overlay mirrors. Pushed in through `sync()`; never inferred here. */
export interface ViewportOverlayState {
  environmentMode: OverlayEnvironmentMode
  showGrid: boolean
  projection: OverlayProjection
  /** Whether block textures are being drawn right now. */
  texturesEnabled: boolean
  /** Whether they COULD be -- i.e. whether an atlas has been decoded. False disables the button
   * and makes it say why, rather than offering a switch that would do nothing. */
  texturesAvailable: boolean
}

export interface ViewportOverlayOptions {
  /** "Frame view" -- the same action as the sidebar's own button and the `R` key. */
  onFrame(): void
  /** Advance solid -> ghost -> hidden -> solid. The viewer applies it and echoes the result back
   * through `sync()`; this module never guesses what the next mode is. */
  onCycleEnvironment(): void
  onToggleGrid(): void
  onToggleProjection(): void
  /** Block textures on/off. Optional only so an older host keeps compiling; the button is
   * present either way and simply inert without it, exactly as it is without an atlas. */
  onToggleTextures?(): void
  /** Where in `host` the overlay goes: it is inserted immediately AFTER this element, rather
   * than appended at the end.
   *
   * This is a tab-order decision, not a layout one -- the overlay is absolutely positioned and
   * looks identical either way. Appended last, it came after the sidebar in the DOM, so the
   * five viewport buttons were tab stops 51-55 of 56 for a toolbar drawn in the top-left corner
   * of the picture. Passed the canvas (which is what VoxelViewer does), the overlay follows the
   * canvas and precedes `#fl-sidebar`, and the toolbar is reached roughly where it is looked
   * at. Omitted, or not a child of `host`, falls back to appending. */
  anchor?: Element | null
}

/** One row of the legend -- a colour, what it means, and optionally how much of it there is.
 *
 * `swatch` is a CSS colour, or an ARRAY of them for a ramp (the heatmap), drawn as a gradient.
 * The colours come from the same tables the geometry is painted from, never retyped here. */
export interface LegendEntry {
  swatch: string | readonly string[]
  label: string
  detail?: string
  title?: string
  /** Makes this row a CONTROL rather than a label.
   *
   * "Click a block to find what placed it" was the only route to the attribution answer, and it
   * needed a mouse. The legend already carried every writer's name and count as text -- so the
   * palette was never colour-alone -- but each row was a `role=listitem` with no tab stop, which
   * put that text out of the keyboard's reach entirely. A row with an action becomes a button
   * that frames and selects the cells it describes; a row with nothing to select (carved, the
   * overflow tint, the heatmap ramp) stays a plain listitem rather than becoming a button that
   * would have to do nothing. */
  onActivate?: () => void
  /** The sentence on an actionable row's button, e.g. "Frame and select the 200 cells
   * wiki:trunk wrote". Ignored without `onActivate`; defaults to a sentence built from the
   * label. */
  actionLabel?: string
}

/** The one-line answer promoted out of the sidebar readout and onto the view -- see `setNotice`. */
export interface OverlayNotice {
  text: string
  /** 'empty' for a run that produced nothing (the case this exists for), 'warn' for one that was
   * cut short. Drives colour only; the words carry the meaning. */
  tone: 'empty' | 'warn'
  title?: string
}

/** The camera basis, already projected to 2D screen directions by the viewer (x right, y DOWN,
 * as SVG wants them). Unit-ish vectors; length carries the foreshortening, which is what makes
 * an axis pointing at the viewer read as short rather than as missing. */
export interface AxisScreenDirections {
  x: { x: number; y: number }
  y: { x: number; y: number }
  z: { x: number; y: number }
}

export interface ViewportOverlayHandle {
  readonly element: HTMLElement
  /** Point the axis triad at wherever the camera is now. */
  setAxes(dirs: AxisScreenDirections): void
  /** The one-line scale readout under the triad -- the bench's own dimensions, e.g. `32×48×32`.
   * Empty string hides it (no volume yet). */
  setScale(text: string): void
  /** Mirrors the sidebar's current view state onto the buttons. */
  sync(state: ViewportOverlayState): void
  /** Shows/hides the busy pill. Hiding it also clears the elapsed readout and any pending
   * cancellation (see `setCancelHandler`), so the next run starts from "Generating…". */
  setBusy(busy: boolean): void
  /** Updates the busy pill's elapsed time, in milliseconds. Ignored while not busy, and ignored
   * once Cancel has been clicked -- a timer still counting up is the opposite of an
   * acknowledgement. */
  setElapsed(ms: number): void
  /** Arms (or disarms, with null) the pill's Cancel button. A host that cannot actually cancel
   * an in-flight request never gets a button that looks live and does nothing. */
  setCancelHandler(fn: (() => void) | null): void
  /** Replaces the legend. An EMPTY list removes it from the view entirely -- the legend is a
   * key to colours currently on screen, so a preview with no overlay colours must have no
   * legend rather than an empty box. */
  setLegend(entries: readonly LegendEntry[]): void
  /** The one-line answer, on the view, next to what it describes. Null hides it. */
  setNotice(notice: OverlayNotice | null): void
  /** Says one short sentence into the overlay's own polite live region, and nothing else.
   *
   * For the transitions a screen reader user cannot otherwise notice -- most importantly the
   * OUTCOME of a run, which this overlay does not itself know (the panel does; see panel.ts's
   * own `.fl-sr-status`, which announces the sidebar's copy). Deliberately narrow: anything that
   * ticks, counts or repeats does not belong here, which is the whole point of the region being
   * separate from the pill. */
  announce(text: string): void
  /** Takes a status line the HOST owns into this overlay's own column, between the notice and
   * the legend.
   *
   * The VS Code shell's write-attribution readout (`#fl-attribution`) was absolutely positioned
   * in the same top-left corner as `.fl-vp-controls`, one z-index higher, so whenever it was
   * showing it was painted straight over the whole toolbar: both unreadable, neither wrong
   * enough to look broken. Rather than push it aside with a margin -- which only moves the
   * collision to whatever lands in that corner next -- it JOINS THE FLOW, so the flex column
   * that already stacks the pill, the notice and the legend stacks this too and nothing in the
   * overlay can ever overlap anything else in it.
   *
   * The host keeps painting it (its own colours, border, role and aria-live); this only decides
   * where it sits, which is why the two properties that made it float are overridden inline --
   * a shell rule keyed on an id outranks anything panel.css can say about a class. */
  adoptStatus(el: HTMLElement): void
  dispose(): void
}

const GIZMO_SIZE = 56
const GIZMO_CENTER = GIZMO_SIZE / 2
const GIZMO_ARM = 18

/** How long a cancellation may sit unanswered before the pill stops promising and starts
 * reporting -- see the `cancelling` comment in `createViewportOverlay`.
 *
 * Three seconds because that is roughly where a request stops reading as "in progress" and
 * starts reading as "stuck": below it an escalation would be noise on every ordinary cancel,
 * above it the user has already decided the button did nothing. */
export const CANCEL_GRACE_MS = 3000

/** `1.2 s`, `0.4 s`, `12.0 s` -- one decimal throughout, so the number's width stops changing
 * after the first tenth of a second and the pill stops twitching. */
export function formatElapsed(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0
  return `${seconds.toFixed(1)} s`
}

/** The environment button's own face and tooltip for each mode -- one table so the glyph and the
 * sentence can never name different modes. */
const ENVIRONMENT_FACE: Readonly<Record<OverlayEnvironmentMode, { glyph: string; name: string; title: string }>> = {
  solid: { glyph: '◧', name: 'Solid', title: 'Environment: solid. Click for see-through.' },
  ghost: { glyph: '◨', name: 'Ghost', title: 'Environment: see-through. Click to hide it.' },
  hidden: { glyph: '◻', name: 'Hidden', title: 'Environment: hidden. Click for solid.' },
}

export function createViewportOverlay(host: HTMLElement, opts: ViewportOverlayOptions): ViewportOverlayHandle {
  const element = h('div', 'fl-vp')
  // Nothing in the overlay may eat a drag meant for the camera: the container is transparent to
  // the pointer and only the actual controls take it back (see panel.css's .fl-vp rules).
  element.setAttribute('role', 'group')
  element.setAttribute('aria-label', 'Viewport overlay')

  // ONE TAB STOP, NOT FIVE. `role="group"` around five buttons is five separate stops, and the
  // measured order put them at 51-55 of 56 -- a toolbar in the top-left corner of the picture,
  // reached last. `role="toolbar"` plus a roving tabindex is what the graph panel already does
  // and what the ARIA practices prescribe: Tab reaches the toolbar, the arrow keys move within
  // it. (See `anchor` below for the other half: the overlay is now placed before the sidebar in
  // the DOM, so the toolbar is reached where it is looked at.)
  const controls = h('div', 'fl-vp-controls')
  controls.setAttribute('role', 'toolbar')
  controls.setAttribute('aria-label', 'Viewport controls')
  controls.setAttribute('aria-orientation', 'horizontal')

  /** One overlay button: a glyph AND a word.
   *
   * A row of unlabelled marks (⤢ ◧ ▦ ⬔ ▤) whose only names were native tooltips is a puzzle, not
   * a toolbar -- nothing on screen said what any of them did until the pointer had already rested
   * on one, and nothing at all said so to a reader who does not use a pointer. The word lives in
   * the overlay itself (`.fl-vp-btn-label`), collapsed to zero width until the button is hovered
   * or focused, so the resting toolbar is still a few small squares over the 3D view and the
   * answer costs no click. The full sentence stays on `title`/`aria-label`.
   *
   * `name` is the visible word; `label` the sentence. */
  function overlayButton(glyph: string, name: string, label: string, onClick: () => void): { btn: HTMLButtonElement; setFace: (glyph: string, name: string, label: string) => void } {
    const btn = h('button', 'fl-vp-btn') as HTMLButtonElement
    btn.type = 'button'
    const glyphEl = h('span', 'fl-vp-btn-glyph', glyph)
    const nameEl = h('span', 'fl-vp-btn-label', name)
    // The word is decorative to a screen reader: aria-label already carries the whole sentence,
    // and letting the label be read too would announce the button's name twice.
    nameEl.setAttribute('aria-hidden', 'true')
    btn.append(glyphEl, nameEl)
    btn.title = label
    btn.setAttribute('aria-label', label)
    // A NO-OP ACTIVATION, not a removed control -- see `sync`'s aria-disabled comment.
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true') return
      onClick()
    })
    return {
      btn,
      setFace(nextGlyph: string, nextName: string, nextLabel: string): void {
        glyphEl.textContent = nextGlyph
        nameEl.textContent = nextName
        btn.title = nextLabel
        btn.setAttribute('aria-label', nextLabel)
      },
    }
  }

  const frame = overlayButton('⤢', 'Frame', 'Frame view (R) — fits the camera to the cells this run touched. Shift+R frames the whole bench.', opts.onFrame)
  const env = overlayButton(ENVIRONMENT_FACE.solid.glyph, ENVIRONMENT_FACE.solid.name, ENVIRONMENT_FACE.solid.title, opts.onCycleEnvironment)
  const grid = overlayButton('▦', 'Grid', 'Grid and bench outline', opts.onToggleGrid)
  const proj = overlayButton('⬔', 'Camera', 'Projection', opts.onToggleProjection)
  // TEXTURES BELONG ON THE VIEWPORT, because the person who needs them is the one looking at
  // flat colours. The switch existed only as a host setting (apps/vscode's
  // featurelab.blockTextures), which is to say: in a JSON file, two windows away from the
  // picture it changes.
  const textures = overlayButton('▤', 'Textures', 'Block textures', () => opts.onToggleTextures?.())
  const frameBtn = frame.btn
  const envBtn = env.btn
  const gridBtn = grid.btn
  const projBtn = proj.btn
  const texturesBtn = textures.btn
  controls.append(frameBtn, envBtn, gridBtn, projBtn, texturesBtn)

  // ---- roving tabindex ---------------------------------------------------------------------
  // Exactly one of the five is a tab stop at any moment; the arrow keys (and Home/End) move the
  // stop. An aria-disabled button STAYS in the rotation on purpose -- its label is where the
  // reason lives ("no texture atlas has been built for this machine…"), which is only useful if
  // it can still be reached.
  const toolbarButtons: readonly HTMLButtonElement[] = [frameBtn, envBtn, gridBtn, projBtn, texturesBtn]
  let rovingIndex = 0
  function setRoving(next: number): void {
    const n = toolbarButtons.length
    rovingIndex = ((next % n) + n) % n
    for (let i = 0; i < n; i++) (toolbarButtons[i] as HTMLButtonElement).tabIndex = i === rovingIndex ? 0 : -1
  }
  setRoving(0)
  controls.addEventListener('keydown', (ev: KeyboardEvent) => {
    const from = toolbarButtons.indexOf(ev.target as HTMLButtonElement)
    if (from < 0) return
    let next: number | null = null
    switch (ev.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = from + 1
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = from - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = toolbarButtons.length - 1
        break
      default:
        return
    }
    ev.preventDefault()
    setRoving(next)
    ;(toolbarButtons[rovingIndex] as HTMLButtonElement).focus()
  })
  // Clicking (or shift-tabbing back into) a button makes THAT one the stop, so Tab returns to
  // where the user last was rather than to whichever one the arrows left behind.
  controls.addEventListener('focusin', (ev: FocusEvent) => {
    const at = toolbarButtons.indexOf(ev.target as HTMLButtonElement)
    if (at >= 0) setRoving(at)
  })

  // ---- the announcer -----------------------------------------------------------------------
  // The one polite live region in this overlay. See this file's header: the pill is not one any
  // more, because a region rewritten ten times a second is a queue, not an announcement.
  const announcer = h('div', 'fl-vp-announce')
  announcer.setAttribute('role', 'status')
  announcer.setAttribute('aria-live', 'polite')
  function say(text: string): void {
    announcer.textContent = text
  }

  // ---- busy pill ---------------------------------------------------------------------------
  // NOT a live region, deliberately. A request starting and finishing is still exactly the kind
  // of thing a screen reader user has no other way to notice -- which is why `announce()` above
  // exists -- but the pill's own text is a clock, and a polite region holding a clock reads out
  // the past. The pill is what is SEEN; the announcer is what is HEARD.
  const pill = h('div', 'fl-vp-pill')
  pill.hidden = true
  const pillText = h('span', 'fl-vp-pill-text', 'Generating…')
  const cancelBtn = h('button', 'fl-vp-cancel', 'Cancel') as HTMLButtonElement
  cancelBtn.type = 'button'
  cancelBtn.hidden = true
  cancelBtn.title = 'Stop this run. The preview keeps showing the last finished result.'
  let cancelHandler: (() => void) | null = null
  /** True from the click until the host settles the request. THE CLICK HAS TO SHOW.
   *
   * Cancel used to leave everything exactly as it was -- the elapsed timer went on counting and
   * the button stayed live -- so the only readings available were "the click missed" and "this
   * cannot be cancelled", and the natural response to both is to click again. Cancelling is a
   * REQUEST to the host (see the webview's own `onCancel`), so the pill says it has been asked
   * for and stops offering to ask again; the host's reply is what ends it, via `setBusy(false)`,
   * because only the host knows whether the run actually stopped. */
  let cancelling = false
  /** The elapsed reading at the instant Cancel was clicked, so the pill can say how long the
   * host has been silent in the same clock it was already counting in. */
  let cancelAskedAtMs = 0
  /** The last elapsed reading pushed in, which is what `cancelAskedAtMs` is measured against --
   * a click is not a tick, so there is no other value to subtract. */
  let lastElapsedMs = 0
  /** True once the escalation below has been announced for the CURRENT cancellation, so the
   * "no reply" sentence is spoken once rather than on every tick after the grace period. */
  let escalationAnnounced = false
  cancelBtn.addEventListener('click', () => {
    if (cancelling || cancelHandler === null) return
    cancelling = true
    cancelAskedAtMs = lastElapsedMs
    escalationAnnounced = false
    pillText.textContent = 'Cancelling…'
    // aria-disabled, NOT `disabled`. Setting `disabled` on a button that currently HOLDS focus
    // drops focus to <body>, so pressing Enter on Cancel sent the caret to the top of the
    // document and the next Tab restarted from the end of the overlay. Inert-but-focusable is
    // both the ARIA practice and the only version where the acknowledgement stays readable to
    // the person who just asked for it. The guard above is what makes the second press a no-op.
    cancelBtn.setAttribute('aria-disabled', 'true')
    say('Cancelling…')
    cancelHandler()
  })
  pill.append(pillText, cancelBtn)

  // ---- axis gizmo --------------------------------------------------------------------------
  const gizmo = h('div', 'fl-vp-gizmo')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'fl-vp-axes')
  svg.setAttribute('viewBox', `0 0 ${GIZMO_SIZE} ${GIZMO_SIZE}`)
  svg.setAttribute('width', String(GIZMO_SIZE))
  svg.setAttribute('height', String(GIZMO_SIZE))
  svg.setAttribute('aria-hidden', 'true')

  function axis(color: string): { line: SVGLineElement; label: SVGTextElement } {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('stroke', color)
    line.setAttribute('stroke-width', '1.5')
    line.setAttribute('stroke-linecap', 'round')
    line.setAttribute('x1', String(GIZMO_CENTER))
    line.setAttribute('y1', String(GIZMO_CENTER))
    line.setAttribute('x2', String(GIZMO_CENTER))
    line.setAttribute('y2', String(GIZMO_CENTER))
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('fill', color)
    label.setAttribute('font-size', '8')
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('dominant-baseline', 'middle')
    svg.append(line, label)
    return { line, label }
  }
  // The three hues are fixed, not theme-derived, for the same reason the overlay colours in
  // colors.ts are: X/Y/Z read as red/green/blue in every 3D tool a pack author has ever used,
  // and a theme that recoloured them would be inventing a private convention.
  const axisX = axis('#e0645a')
  axisX.label.textContent = 'X'
  const axisY = axis('#7ec46a')
  axisY.label.textContent = 'Y'
  const axisZ = axis('#5a9be0')
  axisZ.label.textContent = 'Z'

  const scaleEl = h('div', 'fl-vp-scale', '')
  scaleEl.title = 'Bench size in blocks (X × Y × Z).'
  // The three view snaps have existed since this viewer did, documented only in a source
  // comment. Said here, next to the thing they move -- but ON DEMAND. Parked permanently in the
  // corner of every preview, `1 front · 3 side · 7 top` is a sentence that has already been read
  // by everyone who was going to read it and is furniture to everyone else, and it was competing
  // for attention with the scene. It now hides behind a key button that costs one click and
  // remembers nothing.
  const hint = h('div', 'fl-vp-hint', '1 front · 3 side · 7 top · R frames the feature · Shift+R the bench · with the view focused: arrows orbit, + and − zoom, Enter identifies the block at the centre')
  hint.hidden = true
  const keysBtn = h('button', 'fl-vp-keys', '⌨ keys') as HTMLButtonElement
  keysBtn.type = 'button'
  keysBtn.setAttribute('aria-expanded', 'false')
  keysBtn.title = 'Show the keyboard shortcuts for this view'
  keysBtn.addEventListener('click', () => {
    hint.hidden = !hint.hidden
    keysBtn.setAttribute('aria-expanded', String(!hint.hidden))
    keysBtn.title = hint.hidden ? 'Show the keyboard shortcuts for this view' : 'Hide the keyboard shortcuts'
  })
  gizmo.append(svg, scaleEl, keysBtn, hint)

  // ---- legend ---------------------------------------------------------------------------------
  // WHAT THAT COLOUR MEANS, said where the colour is. The attribution overlay in particular had
  // no legend at all: a preview would turn part of itself blue-violet and the only explanation
  // was a sentence in a readout under the canvas, which is not where anybody looks when a picture
  // changes colour. Every row is driven from the viewer (see VoxelViewer.syncLegend) and exists
  // only while its overlay is actually drawing something, so this is empty -- and absent from the
  // DOM's flow -- for an ordinary preview.
  const legend = h('div', 'fl-vp-legend')
  legend.hidden = true
  legend.setAttribute('role', 'list')
  legend.setAttribute('aria-label', 'What the overlay colours mean')

  // ---- the one-line answer --------------------------------------------------------------------
  // See `setNotice`. role=status, because a run that produced nothing is exactly the result a
  // screen reader user otherwise has no way to notice: the picture simply does not change.
  const notice = h('div', 'fl-vp-notice')
  notice.hidden = true
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')

  element.append(controls, pill, notice, legend, gizmo, announcer)
  const anchor = opts.anchor
  if (anchor && anchor.parentElement === host) anchor.insertAdjacentElement('afterend', element)
  else host.append(element)

  let busy = false

  const handle: ViewportOverlayHandle = {
    element,
    setAxes(dirs: AxisScreenDirections): void {
      for (const [dir, parts] of [
        [dirs.x, axisX],
        [dirs.y, axisY],
        [dirs.z, axisZ],
      ] as const) {
        const ex = GIZMO_CENTER + dir.x * GIZMO_ARM
        const ey = GIZMO_CENTER + dir.y * GIZMO_ARM
        parts.line.setAttribute('x2', ex.toFixed(2))
        parts.line.setAttribute('y2', ey.toFixed(2))
        parts.label.setAttribute('x', (GIZMO_CENTER + dir.x * (GIZMO_ARM + 6)).toFixed(2))
        parts.label.setAttribute('y', (GIZMO_CENTER + dir.y * (GIZMO_ARM + 6)).toFixed(2))
      }
    },
    setScale(text: string): void {
      scaleEl.textContent = text
      scaleEl.hidden = text === ''
    },
    sync(state: ViewportOverlayState): void {
      const face = ENVIRONMENT_FACE[state.environmentMode] ?? ENVIRONMENT_FACE.solid
      env.setFace(face.glyph, face.name, face.title)

      gridBtn.setAttribute('aria-pressed', String(state.showGrid))
      gridBtn.classList.toggle('fl-vp-btn-on', state.showGrid)
      const gridLabel = state.showGrid ? 'Grid on. Click to hide the bench outline and floor grid.' : 'Grid off. Click to show the bench outline and floor grid.'
      grid.setFace('▦', 'Grid', gridLabel)

      const ortho = state.projection === 'orthographic'
      projBtn.setAttribute('aria-pressed', String(ortho))
      projBtn.classList.toggle('fl-vp-btn-on', ortho)
      proj.setFace(
        ortho ? '▣' : '⬔',
        ortho ? 'Flat' : 'Camera',
        ortho
          ? 'Orthographic: no perspective, so equal blocks measure equal. Click for perspective.'
          : 'Perspective. Click for orthographic, where equal blocks measure equal.',
      )

      // An unavailable texture switch SAYS WHY rather than silently doing nothing -- the same
      // rule the sidebar's inert controls follow. It says so with `aria-disabled`, not
      // `disabled`: this button's aria-label IS the explanation ("no texture atlas has been
      // built for this machine…"), and `disabled` took it out of the tab order, which made the
      // sentence unreadable at exactly the moment it was worth reading. The activation is a
      // no-op instead (see overlayButton), which is what the ARIA practices prescribe.
      if (state.texturesAvailable) texturesBtn.removeAttribute('aria-disabled')
      else texturesBtn.setAttribute('aria-disabled', 'true')
      texturesBtn.setAttribute('aria-pressed', String(state.texturesEnabled))
      texturesBtn.classList.toggle('fl-vp-btn-on', state.texturesEnabled)
      textures.setFace(
        '▤',
        'Textures',
        !state.texturesAvailable
          ? 'Block textures are not available: no texture atlas has been built for this machine, so the preview draws one flat colour per block.'
          : state.texturesEnabled
            ? 'Block textures on. Click for flat colours, one per block.'
            : 'Flat colours, one per block. Click to draw the pack’s block textures.',
      )
    },
    setLegend(entries: readonly LegendEntry[]): void {
      legend.textContent = ''
      legend.hidden = entries.length === 0
      const actionable: HTMLButtonElement[] = []
      for (const entry of entries) {
        const row = h('div', 'fl-vp-legend-row')
        row.setAttribute('role', 'listitem')
        if (entry.title) row.title = entry.title
        const swatch = h('span', 'fl-vp-swatch')
        swatch.style.background = typeof entry.swatch === 'string' ? entry.swatch : `linear-gradient(to right, ${entry.swatch.join(', ')})`
        const label = h('span', 'fl-vp-legend-label', entry.label)
        // THE NAME IS THE ANSWER, and the row is narrower than the names it lists: a writer
        // ellipsised to "wiki:vegetation_patch…" names nothing, and the row's own tooltip is a
        // sentence about what the COLOUR means, which is a different question and was the only
        // one reachable. The label now carries itself, with the row's sentence appended so one
        // hover still answers both.
        label.title = entry.title === undefined ? entry.label : `${entry.label} — ${entry.title}`
        const detail = entry.detail === undefined ? null : h('span', 'fl-vp-legend-detail', entry.detail)
        const activate = entry.onActivate
        if (activate === undefined) {
          row.append(swatch, label)
          if (detail) row.append(detail)
        } else {
          // A KEYBOARD ROUTE TO "WHAT PLACED THIS". See LegendEntry.onActivate.
          const btn = h('button', 'fl-vp-legend-btn') as HTMLButtonElement
          btn.type = 'button'
          const sentence = entry.actionLabel ?? `Frame and select the cells ${entry.label} wrote`
          btn.setAttribute('aria-label', entry.detail === undefined ? sentence : `${sentence} (${entry.detail})`)
          btn.setAttribute('aria-pressed', 'false')
          btn.append(swatch, label)
          if (detail) btn.append(detail)
          btn.addEventListener('click', () => {
            // A radio-like selection: one writer is framed at a time, so the pressed row is
            // always the one the camera is actually looking at.
            for (const other of actionable) other.setAttribute('aria-pressed', String(other === btn))
            activate()
            say(entry.detail === undefined ? `${entry.label} framed` : `${entry.label} framed — ${entry.detail}`)
          })
          actionable.push(btn)
          row.append(btn)
        }
        legend.append(row)
      }
    },
    setNotice(next: OverlayNotice | null): void {
      if (next === null) {
        notice.hidden = true
        notice.textContent = ''
        notice.removeAttribute('title')
        return
      }
      notice.textContent = next.text
      notice.classList.toggle('fl-vp-notice-warn', next.tone === 'warn')
      if (next.title) notice.title = next.title
      else notice.removeAttribute('title')
      notice.hidden = false
    },
    adoptStatus(el: HTMLElement): void {
      el.classList.add('fl-vp-status')
      el.style.position = 'static'
      el.style.maxWidth = 'min(46ch, calc(100% - 16px))'
      element.insertBefore(el, legend)
    },
    setBusy(v: boolean): void {
      const was = busy
      busy = v
      pill.hidden = !v
      // A settled request is a settled cancellation: the host has replied (a result, an error,
      // or a dead engine), which is the only thing that can end one -- see `cancelling`.
      cancelling = false
      cancelAskedAtMs = 0
      lastElapsedMs = 0
      escalationAnnounced = false
      cancelBtn.removeAttribute('aria-disabled')
      if (!v) pillText.textContent = 'Generating…'
      // The two TRANSITIONS, announced once each. What the run produced is a separate sentence
      // and a separate announcement, made by whoever knows it: the panel for the sidebar's copy
      // (panel.ts's `.fl-sr-status`), or a host calling `announce()`. Clearing on settle is what
      // lets the NEXT run's identical "Generating…" be announced again.
      if (v && !was) say('Generating…')
      else if (!v && was) say('')
    },
    setElapsed(ms: number): void {
      if (!busy) return
      lastElapsedMs = ms
      if (!cancelling) {
        pillText.textContent = `Generating… ${formatElapsed(ms)}`
        return
      }
      // A CANCELLATION THAT IS NEVER ANSWERED HAS TO SAY SO. "Cancelling…" forever is the same
      // dead end the un-acknowledged click was: after CANCEL_GRACE_MS the pill stops repeating
      // a promise it cannot keep and starts reporting the silence, in the clock it was already
      // counting in, so "the host has not replied" is readable instead of inferable. It still
      // does not re-arm the button -- asking twice does not make a silent host answer -- and it
      // still ends the only way a request can end, with the host's own reply (`setBusy(false)`).
      const since = ms - cancelAskedAtMs
      if (since < CANCEL_GRACE_MS) return
      pillText.textContent = `Cancelling… no reply after ${formatElapsed(since)}`
      // Said ONCE. The pill goes on counting on screen; repeating "no reply after 4.4 s, no
      // reply after 4.5 s…" into a polite queue is the exact behaviour this file stopped doing.
      if (!escalationAnnounced) {
        escalationAnnounced = true
        say(`Cancelling… the engine has not replied after ${formatElapsed(since)}`)
      }
    },
    announce(text: string): void {
      say(text)
    },
    setCancelHandler(fn: (() => void) | null): void {
      cancelHandler = fn
      cancelBtn.hidden = fn === null
    },
    dispose(): void {
      element.remove()
    },
  }
  // Every button's face and label comes from sync(), so the overlay starts in a state it can
  // describe rather than with a placeholder tooltip nobody replaces until something changes.
  handle.sync({ environmentMode: 'solid', showGrid: true, projection: 'perspective', texturesEnabled: false, texturesAvailable: false })
  return handle
}
