// tooltip.ts -- the short end of the documentation, and the only hover card in the editor.
//
// WHY THIS EXISTS. A count over the rendered panel found 348 native `title` attributes across
// about 1,026 elements, the longest of them 563 characters -- a paragraph, delivered by the
// operating system in a font the theme does not control, after a delay the editor does not
// control, in a box that routinely lands ON TOP of the control it is describing. Meanwhile the
// two controls somebody is most likely to hesitate over, `Delete` and `Fit`, had no title at all.
//
// THE RULE THIS IMPLEMENTS. A long hover gives a normal tooltip. Nothing longer than a tooltip
// belongs in a tooltip -- it belongs in the `?` panel, which is a place you can scroll, select
// text in, and leave open beside the thing it explains. So the body is capped at about two lines
// and the remainder is replaced by a pointer to that panel, rather than being poured into a
// hover card nobody can keep on screen long enough to read.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not replace `title` as the place authors write the
// sentence. Every module in this directory keeps setting `.title`, which means the text stays
// where the language guards can scan it and where a test can read it without hovering; this
// module lifts the attribute off the element only while the pointer is actually over it, and
// puts it back on the way out. An element that never gets hovered is never touched at all.

/** How long the pointer must rest before the card appears.
 *
 * Long enough that crossing a toolbar does not strobe five cards at somebody, short enough that
 * a deliberate hover is answered rather than ignored. */
export const TOOLTIP_DELAY_MS = 700

/** How far the pointer may drift, in CSS pixels, before a shown card is dismissed.
 *
 * Not zero: a pointer resting on a control still reports sub-pixel jitter on some devices, and a
 * card that vanishes because a hand is not perfectly still is a card nobody gets to read. */
export const TOOLTIP_DRIFT_PX = 6

/** The gap kept between the control and the card, so the two never share an edge. */
export const TOOLTIP_GAP_PX = 8

/** Roughly two lines at the card's own width. Prose past this is not shortened, it is CUT and
 * replaced -- see `tooltipBody`. */
export const TOOLTIP_BODY_LIMIT = 100

/** What the `?` panel is called in the one sentence that sends people to it. */
export const TOOLTIP_MORE = 'more in the ? panel'

/** The card's text: the author's sentence if it fits, or the start of it and where the rest is.
 *
 * The cut is at a word boundary and the tail is REPLACED rather than elided, because "..." at the
 * end of a hover card tells a reader that there is more without telling them where to get it,
 * which is how a truncated tooltip becomes a dead end. Two lines is the budget because a hover
 * card is read in the gap between deciding to hesitate and deciding to click.
 */
export function tooltipBody(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= TOOLTIP_BODY_LIMIT) return trimmed
  const cut = trimmed.slice(0, TOOLTIP_BODY_LIMIT)
  const space = cut.lastIndexOf(' ')
  const head = (space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, '')
  return `${head}... ${TOOLTIP_MORE}`
}

export interface TooltipRect {
  x: number
  y: number
  width: number
  height: number
}

export interface TooltipSize {
  width: number
  height: number
}

export interface TooltipViewport {
  width: number
  height: number
}

export interface TooltipPlacement {
  left: number
  top: number
  /** Which side of the control the card ended up on. Carried so a test can assert the fallback
   * was taken rather than inferring it from coordinates. */
  side: 'below' | 'above' | 'right' | 'left'
}

/** Where the card goes: beside the control, never over it, never off screen.
 *
 * A pure function of four rectangles so the one rule that matters -- the card and the control do
 * not overlap -- is checkable without a browser, at every viewport size, including the ones where
 * there is barely room for either. The order of preference is below, above, right, left: reading
 * order first, and the horizontal fallbacks only for a control pinned against both edges, such as
 * a toolbar button in a panel dragged down to nothing.
 */
export function placeTooltip(control: TooltipRect, card: TooltipSize, viewport: TooltipViewport, gap = TOOLTIP_GAP_PX): TooltipPlacement {
  const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, Math.max(0, max)))
  const below = control.y + control.height + gap
  const above = control.y - gap - card.height
  // Left-aligned with the control, then pulled back inside the viewport.
  const left = clamp(control.x, viewport.width - card.width)

  if (below + card.height <= viewport.height) return { left, top: below, side: 'below' }
  if (above >= 0) return { left, top: above, side: 'above' }

  const top = clamp(control.y, viewport.height - card.height)
  const toRight = control.x + control.width + gap
  if (toRight + card.width <= viewport.width) return { left: toRight, top, side: 'right' }
  const toLeft = control.x - gap - card.width
  if (toLeft >= 0) return { left: toLeft, top, side: 'left' }

  // Nowhere fits. Below, clamped, is the least bad: it keeps the card on screen, and the control
  // is at the top of a viewport this small anyway.
  return { left, top: clamp(below, viewport.height - card.height), side: 'below' }
}

/** The card's own styles.
 *
 * Every colour is a theme variable with a fallback, like every other stylesheet in this
 * directory, and the card is `position: fixed` with `pointer-events: none` so that showing one
 * moves nothing and intercepts nothing -- a hover card that reflows the panel under the pointer
 * is a hover card that moves the control out from under the click that was about to happen.
 */
export const TOOLTIP_STYLESHEET = `
.flg-tip {
  position: fixed;
  z-index: 60;
  max-width: 440px;
  padding: 4px 8px;
  font-size: 0.85em;
  line-height: 1.35;
  border-radius: 4px;
  pointer-events: none;
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground, #cccccc));
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, #454545));
  box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
}
.flg-tip[hidden] { display: none; }

/* The card appears; it does not animate in. Under prefers-reduced-motion there is nothing to
   turn off, which is the cheapest way to honour it. */
`

export interface TooltipController {
  /** The card element, once it has been created. */
  readonly element: HTMLElement
  /** Shows the card for `target` immediately, skipping the delay. For tests and for a keyboard
   * focus path, where waiting 700ms after a deliberate Tab would be waiting for nothing. */
  show(target: HTMLElement): void
  hide(): void
  /** The element the card is currently describing, or null. */
  current(): HTMLElement | null
  dispose(): void
}

export interface TooltipOptions {
  delayMs?: number
  /** Where the card is appended. Defaults to the document body. */
  container?: HTMLElement
}

/** Installs the one hover card for a document, and returns the handle that turns it off.
 *
 * ONE of them, for the whole editor. The alternative -- a card per component -- is how two cards
 * end up on screen at once, each explaining the other's control.
 */
export function installTooltips(doc: Document, options: TooltipOptions = {}): TooltipController {
  const delay = options.delayMs ?? TOOLTIP_DELAY_MS
  const card = doc.createElement('div')
  card.className = 'flg-tip'
  card.hidden = true
  // Announced by the control it belongs to, not by itself: the card is a picture of the sentence
  // that is already on the element as `title`, and a live region repeating it would say
  // everything twice to the one person who cannot see the card.
  card.setAttribute('aria-hidden', 'true')
  ;(options.container ?? doc.body).append(card)

  let target: HTMLElement | null = null
  let shown: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let shownAt: { x: number; y: number } | null = null

  function textOf(el: HTMLElement): string {
    return el.dataset['flgTip'] ?? el.getAttribute('title') ?? ''
  }

  /** Takes the native attribute off while the pointer is here, and remembers it verbatim.
   *
   * This is the whole reason two tooltips never appear at once. It is reversed by `release`, so
   * an element that has been hovered is byte-for-byte the element it was before. */
  function capture(el: HTMLElement): void {
    const native = el.getAttribute('title')
    if (native !== null) {
      el.dataset['flgTip'] = native
      el.removeAttribute('title')
    }
  }

  function release(el: HTMLElement): void {
    const held = el.dataset['flgTip']
    if (held !== undefined) {
      el.setAttribute('title', held)
      delete el.dataset['flgTip']
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function hide(): void {
    clearTimer()
    card.hidden = true
    card.textContent = ''
    shown = null
    shownAt = null
    if (target !== null) {
      release(target)
      target = null
    }
  }

  function show(el: HTMLElement): void {
    const text = tooltipBody(textOf(el))
    if (text.length === 0) return
    card.textContent = text
    card.hidden = false
    // Measured after it is in the document and filled, because its height depends on how the
    // text wrapped -- placing from a guessed height is how a card ends up over its control.
    const box = el.getBoundingClientRect()
    const size = card.getBoundingClientRect()
    const at = placeTooltip(
      { x: box.x, y: box.y, width: box.width, height: box.height },
      { width: size.width, height: size.height },
      { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight },
    )
    card.style.left = `${String(Math.round(at.left))}px`
    card.style.top = `${String(Math.round(at.top))}px`
    card.dataset['side'] = at.side
    shown = el
  }

  function bearerOf(node: EventTarget | null): HTMLElement | null {
    if (!(node instanceof Element)) return null
    const found = node.closest('[title], [data-flg-tip]')
    return found instanceof HTMLElement && found !== card ? found : null
  }

  function onOver(event: Event): void {
    const found = bearerOf(event.target)
    if (found === target) return
    hide()
    if (found === null) return
    target = found
    capture(found)
    if (textOf(found).length === 0) return
    timer = setTimeout(() => {
      timer = null
      if (target === found) show(found)
    }, delay)
  }

  function onOut(event: Event): void {
    const to = (event as MouseEvent).relatedTarget
    if (to instanceof Node && target !== null && target.contains(to)) return
    hide()
  }

  /** Movement dismisses a card that is already up.
   *
   * A tooltip answers a hesitation. Once the pointer is travelling again the hesitation is over,
   * and a card that outlives it is just something in the way. Movement BEFORE the card appears is
   * left alone -- restarting the timer on every jitter would mean the card never arrives. */
  function onMove(event: Event): void {
    if (shown === null) return
    const at = event as MouseEvent
    if (shownAt === null) {
      shownAt = { x: at.clientX, y: at.clientY }
      return
    }
    if (Math.abs(at.clientX - shownAt.x) > TOOLTIP_DRIFT_PX || Math.abs(at.clientY - shownAt.y) > TOOLTIP_DRIFT_PX) hide()
  }

  function onKey(event: Event): void {
    if ((event as KeyboardEvent).key === 'Escape') hide()
  }

  // Capture phase: a control that stops a pointer event -- the canvas does, mid-drag -- must not
  // also strand a card on screen.
  doc.addEventListener('pointerover', onOver, true)
  doc.addEventListener('pointerout', onOut, true)
  doc.addEventListener('pointermove', onMove, true)
  doc.addEventListener('pointerdown', hide, true)
  doc.addEventListener('keydown', onKey, true)
  doc.defaultView?.addEventListener('scroll', hide, true)

  return {
    element: card,
    show(el: HTMLElement): void {
      hide()
      target = el
      capture(el)
      show(el)
      shownAt = null
    },
    hide,
    current: () => shown,
    dispose(): void {
      hide()
      doc.removeEventListener('pointerover', onOver, true)
      doc.removeEventListener('pointerout', onOut, true)
      doc.removeEventListener('pointermove', onMove, true)
      doc.removeEventListener('pointerdown', hide, true)
      doc.removeEventListener('keydown', onKey, true)
      doc.defaultView?.removeEventListener('scroll', hide, true)
      card.remove()
    },
  }
}
