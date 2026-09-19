// @vitest-environment jsdom
// viewportOverlay.test.ts -- the controls that sit ON the 3D view.
//
// They live in their own module precisely so they can be tested here: VoxelViewer needs a WebGL
// context jsdom does not provide, while the overlay is DOM and callbacks and nothing else. What
// the viewer contributes -- which callback does what to the camera -- is exercised by the
// Chromium harness (apps/vscode/test/viewport.test.ts) against the real bundle.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_GRACE_MS, createViewportOverlay, formatElapsed } from '../src/ui/viewportOverlay.js'
import type { ViewportOverlayHandle, ViewportOverlayOptions } from '../src/ui/viewportOverlay.js'

// The REAL stylesheet -- see panel.test.ts's own comment on this. Loaded here because one of the
// assertions below is about the overlay not stealing pointer events from the camera, which is a
// pure CSS fact.
const PANEL_CSS = readFileSync(join(process.cwd(), 'src/ui/panel.css'), 'utf8')
const styleEl = document.createElement('style')
styleEl.textContent = PANEL_CSS
document.head.append(styleEl)

function makeOverlay(overrides: Partial<ViewportOverlayOptions> = {}): {
  host: HTMLElement
  overlay: ViewportOverlayHandle
  opts: { [K in keyof ViewportOverlayOptions]: ReturnType<typeof vi.fn> }
} {
  const host = document.createElement('div')
  document.body.append(host)
  const opts = {
    onFrame: vi.fn(),
    onCycleEnvironment: vi.fn(),
    onToggleGrid: vi.fn(),
    onToggleProjection: vi.fn(),
    onToggleTextures: vi.fn(),
  }
  const overlay = createViewportOverlay(host, { ...opts, ...overrides })
  return { host, overlay, opts }
}

function buttonLabelled(host: HTMLElement, pattern: RegExp): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('.fl-vp-btn')].find((b) => pattern.test(b.getAttribute('aria-label') ?? ''))!
}

beforeEach(() => {
  document.body.textContent = ''
  document.body.append(styleEl)
})

describe('viewport overlay: the controls a viewport needs are on the viewport', () => {
  it('puts frame, environment, grid, projection and textures on the canvas, and frames on click', () => {
    const { host, opts } = makeOverlay()
    const buttons = [...host.querySelectorAll('.fl-vp-btn')]
    expect(buttons.length).toBe(5)
    // Every one of them is announced -- an overlay of unlabelled glyphs is worse than no overlay.
    for (const b of buttons) expect(b.getAttribute('aria-label')).toBeTruthy()

    buttonLabelled(host, /Frame view/).dispatchEvent(new Event('click'))
    expect(opts.onFrame).toHaveBeenCalledTimes(1)
    buttonLabelled(host, /Environment/).dispatchEvent(new Event('click'))
    expect(opts.onCycleEnvironment).toHaveBeenCalledTimes(1)
    buttonLabelled(host, /Grid/).dispatchEvent(new Event('click'))
    expect(opts.onToggleGrid).toHaveBeenCalledTimes(1)
    buttonLabelled(host, /[Pp]erspective|[Oo]rthographic/).dispatchEvent(new Event('click'))
    expect(opts.onToggleProjection).toHaveBeenCalledTimes(1)
  })

  // Four bare glyphs whose only names were native tooltips is a puzzle: nothing on screen said
  // what any of them did until a pointer had already rested on one.
  it('writes each control name into the overlay itself, not only into a tooltip', () => {
    const { host } = makeOverlay()
    const labels = [...host.querySelectorAll('.fl-vp-btn .fl-vp-btn-label')].map((el) => el.textContent)
    expect(labels).toEqual(['Frame', 'Solid', 'Grid', 'Camera', 'Textures'])
    // The full sentence still lives on aria-label, so the visible word is not read out twice.
    for (const el of host.querySelectorAll('.fl-vp-btn-label')) expect(el.getAttribute('aria-hidden')).toBe('true')
  })

  // The key hint used to be parked permanently in the corner of every preview -- furniture to
  // everyone who had already read it, and competing with the scene for attention.
  it('keeps the 1/3/7 key hint available on demand rather than always on screen', () => {
    const { host } = makeOverlay()
    const hint = host.querySelector('.fl-vp-hint') as HTMLElement
    const keys = host.querySelector('.fl-vp-keys') as HTMLButtonElement
    expect(hint.hidden).toBe(true)
    expect(keys.getAttribute('aria-expanded')).toBe('false')

    keys.dispatchEvent(new Event('click'))
    expect(hint.hidden).toBe(false)
    expect(keys.getAttribute('aria-expanded')).toBe('true')
    expect(hint.textContent).toContain('1 front')
    expect(hint.textContent).toContain('3 side')
    expect(hint.textContent).toContain('7 top')
    expect(hint.textContent).toMatch(/R frames/)

    keys.dispatchEvent(new Event('click'))
    expect(hint.hidden).toBe(true)
  })

  it('shows the camera basis and the bench size, so something says which way is up and how big', () => {
    const { host, overlay } = makeOverlay()
    overlay.setScale('32×48×32')
    expect((host.querySelector('.fl-vp-scale') as HTMLElement).textContent).toBe('32×48×32')

    // Straight-on front view: +X to the right, +Y up (negative in screen space), +Z at the viewer.
    overlay.setAxes({ x: { x: 1, y: 0 }, y: { x: 0, y: -1 }, z: { x: 0, y: 0 } })
    const lines = [...host.querySelectorAll('.fl-vp-axes line')]
    expect(lines.length).toBe(3)
    expect(Number(lines[0]!.getAttribute('x2'))).toBeGreaterThan(Number(lines[0]!.getAttribute('x1')))
    expect(Number(lines[1]!.getAttribute('y2'))).toBeLessThan(Number(lines[1]!.getAttribute('y1')))
    // An axis pointing at the viewer foreshortens to nothing rather than disappearing from the
    // DOM -- the gizmo is a readout of the real camera, including the degenerate cases.
    expect(Number(lines[2]!.getAttribute('y2'))).toBe(Number(lines[2]!.getAttribute('y1')))
  })

  it('mirrors the sidebar rather than keeping its own idea of the state', () => {
    const { host, overlay } = makeOverlay()
    const grid = buttonLabelled(host, /Grid/)
    overlay.sync({ environmentMode: 'ghost', showGrid: true, projection: 'perspective', texturesEnabled: false, texturesAvailable: false })
    expect(grid.getAttribute('aria-pressed')).toBe('true')
    expect(buttonLabelled(host, /Environment/).getAttribute('aria-label')).toMatch(/see-through/)

    overlay.sync({ environmentMode: 'hidden', showGrid: false, projection: 'orthographic', texturesEnabled: false, texturesAvailable: false })
    expect(grid.getAttribute('aria-pressed')).toBe('false')
    expect(buttonLabelled(host, /Environment/).getAttribute('aria-label')).toMatch(/hidden/)
    expect(buttonLabelled(host, /[Oo]rthographic/).getAttribute('aria-pressed')).toBe('true')
  })

  it('lets a drag meant for the camera through: only the controls themselves take the pointer', () => {
    const { host } = makeOverlay()
    const overlayEl = host.querySelector('.fl-vp') as HTMLElement
    expect(getComputedStyle(overlayEl).pointerEvents).toBe('none')
    expect(getComputedStyle(host.querySelector('.fl-vp-controls') as HTMLElement).pointerEvents).toBe('auto')
  })
})

// The switch that turns textures on used to exist only in the editor's settings.json -- two
// windows away from the flat colours it changes.
// Five buttons drawn in the top-left corner of the picture were five separate tab stops, and --
// because the overlay was appended to the canvas's parent, after #fl-sidebar -- they were stops
// 51 to 55 of 56. The graph panel had already solved both halves.
describe('viewport overlay: the toolbar is one tab stop, in the place it is looked at', () => {
  it('is a toolbar with a roving tabindex, not five stops under a group', () => {
    const { host } = makeOverlay()
    const controls = host.querySelector('.fl-vp-controls') as HTMLElement
    expect(controls.getAttribute('role')).toBe('toolbar')
    expect(controls.getAttribute('aria-label')).toMatch(/viewport/i)
    // The container around the whole overlay is no longer the thing claiming to be the controls.
    expect((host.querySelector('.fl-vp') as HTMLElement).getAttribute('aria-label')).not.toBe('Viewport controls')

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.fl-vp-btn')]
    expect(buttons.length).toBe(5)
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1)
    expect(buttons.filter((b) => b.tabIndex === -1)).toHaveLength(4)
    expect(buttons[0]!.tabIndex).toBe(0)
  })

  it('moves the stop with the arrow keys, Home and End, and never off the inert button', () => {
    const { host } = makeOverlay()
    const controls = host.querySelector('.fl-vp-controls') as HTMLElement
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.fl-vp-btn')]
    const press = (from: HTMLButtonElement, key: string): void => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      from.dispatchEvent(ev)
    }
    const stop = (): number => buttons.findIndex((b) => b.tabIndex === 0)

    press(buttons[0]!, 'ArrowRight')
    expect(stop()).toBe(1)
    press(buttons[1]!, 'ArrowLeft')
    expect(stop()).toBe(0)
    // Wraps rather than dead-ending, which is what makes a five-button toolbar usable with one
    // key rather than four.
    press(buttons[0]!, 'ArrowLeft')
    expect(stop()).toBe(4)
    press(buttons[4]!, 'Home')
    expect(stop()).toBe(0)
    press(buttons[0]!, 'End')
    // The last button is the aria-disabled Textures one, and the rotation includes it ON
    // PURPOSE: its label is the only place its reason is written.
    expect(stop()).toBe(4)
    expect(buttons[4]!.getAttribute('aria-disabled')).toBe('true')

    // A key the toolbar does not own is left alone -- Tab in particular, or the toolbar becomes
    // a keyboard trap.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    buttons[4]!.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)

    // Focusing one directly (a click, or shift-tabbing back in) makes THAT one the stop, so Tab
    // returns to where the user was rather than to where the arrows left off.
    buttons[2]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(stop()).toBe(2)
    expect(controls.contains(buttons[2]!)).toBe(true)
  })

  it('goes immediately after the element it is anchored to, not at the end of the host', () => {
    const host = document.createElement('div')
    const canvas = document.createElement('canvas')
    const sidebar = document.createElement('div')
    sidebar.id = 'fl-sidebar'
    host.append(canvas, sidebar)
    document.body.append(host)
    createViewportOverlay(host, {
      anchor: canvas,
      onFrame: vi.fn(),
      onCycleEnvironment: vi.fn(),
      onToggleGrid: vi.fn(),
      onToggleProjection: vi.fn(),
    })
    // canvas, overlay, sidebar -- which is what puts the toolbar's tab stop where the toolbar is
    // drawn instead of after every control in the sidebar.
    expect([...host.children].map((el) => el.tagName + (el.id ? `#${el.id}` : el.className ? `.${el.className}` : ''))).toEqual(['CANVAS', 'DIV.fl-vp', 'DIV#fl-sidebar'])
  })

  it('still appends when there is no anchor, or the anchor is not in the host', () => {
    const { host } = makeOverlay()
    expect(host.lastElementChild?.className).toBe('fl-vp')
    const other = document.createElement('div')
    const host2 = document.createElement('div')
    host2.append(document.createElement('span'))
    document.body.append(host2)
    createViewportOverlay(host2, {
      anchor: other,
      onFrame: vi.fn(),
      onCycleEnvironment: vi.fn(),
      onToggleGrid: vi.fn(),
      onToggleProjection: vi.fn(),
    })
    expect(host2.lastElementChild?.className).toBe('fl-vp')
  })
})

describe('viewport overlay: the texture switch is where the flat colours are', () => {
  it('is inert, and says which of the two reasons it is inert for, until an atlas exists', () => {
    const { host, overlay, opts } = makeOverlay()
    const btn = buttonLabelled(host, /textures|flat colours/i)
    // aria-disabled, not `disabled`: this button's aria-label IS the explanation, and `disabled`
    // takes the button -- and therefore the sentence -- out of the tab order at exactly the
    // moment it is worth reading. See ViewportOverlayHandle.sync's own comment.
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.getAttribute('aria-label')).toMatch(/no texture atlas has been built/i)
    btn.dispatchEvent(new Event('click'))
    // The activation is a NO-OP -- reachable, readable, and it still does not pretend to switch
    // something that does not exist.
    expect(opts.onToggleTextures).not.toHaveBeenCalled()
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    overlay.sync({ environmentMode: 'solid', showGrid: true, projection: 'perspective', texturesEnabled: false, texturesAvailable: true })
    expect(btn.hasAttribute('aria-disabled')).toBe(false)
    expect(btn.getAttribute('aria-label')).toMatch(/Click to draw the pack’s block textures/)
    btn.dispatchEvent(new Event('click'))
    expect(opts.onToggleTextures).toHaveBeenCalledTimes(1)
  })

  it('reads as pressed only while textures are actually being drawn', () => {
    const { host, overlay } = makeOverlay()
    const btn = buttonLabelled(host, /textures|flat colours/i)
    overlay.sync({ environmentMode: 'solid', showGrid: true, projection: 'perspective', texturesEnabled: true, texturesAvailable: true })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.classList.contains('fl-vp-btn-on')).toBe(true)
    expect(btn.getAttribute('aria-label')).toMatch(/Block textures on/)
  })
})

// The attribution overlay would turn part of the preview blue-violet and say what that meant
// only in a readout under the canvas -- which is not where anybody looks when a picture changes
// colour.
describe('viewport overlay: a legend for the colours on the view', () => {
  it('is absent entirely when there are no overlay colours to explain', () => {
    const { host, overlay } = makeOverlay()
    const legend = host.querySelector('.fl-vp-legend') as HTMLElement
    expect(legend.hidden).toBe(true)
    overlay.setLegend([])
    expect(legend.hidden).toBe(true)
    expect(legend.children.length).toBe(0)
  })

  it('draws one swatch and label per entry, in the colour it was given', () => {
    const { host, overlay } = makeOverlay()
    overlay.setLegend([
      { swatch: '#6b73ff', label: 'wiki:trunk', detail: '12 blocks', title: 'Cells this writer wrote.' },
      { swatch: '#2ec5d9', label: 'wiki:canopy', detail: '1,284 blocks' },
    ])
    const legend = host.querySelector('.fl-vp-legend') as HTMLElement
    expect(legend.hidden).toBe(false)
    const rows = [...legend.querySelectorAll('.fl-vp-legend-row')]
    expect(rows.map((r) => r.querySelector('.fl-vp-legend-label')?.textContent)).toEqual(['wiki:trunk', 'wiki:canopy'])
    expect(rows.map((r) => r.querySelector('.fl-vp-legend-detail')?.textContent)).toEqual(['12 blocks', '1,284 blocks'])
    expect((rows[0]!.querySelector('.fl-vp-swatch') as HTMLElement).style.background).toContain('rgb(107, 115, 255)')
    expect((rows[0]! as HTMLElement).title).toBe('Cells this writer wrote.')
    // Announced as a list, so a screen reader reads it as a key rather than as loose text.
    expect(legend.getAttribute('role')).toBe('list')
    expect(rows[0]!.getAttribute('role')).toBe('listitem')
  })

  it('draws a ramp entry as a gradient rather than as one of its ends', () => {
    const { host, overlay } = makeOverlay()
    overlay.setLegend([{ swatch: ['#198c8c', '#f2d926', '#d91a1a'], label: 'writes per cell', detail: '1 → 7' }])
    const swatch = host.querySelector('.fl-vp-swatch') as HTMLElement
    expect(swatch.style.background).toContain('linear-gradient')
  })

  // The legend row is 126px of a name that wants 174, so the selected writer's identifier was
  // ellipsised -- and the only tooltip in reach was the row's generic "Cells this writer wrote
  // in the run on screen", which answers a different question. The name was unrecoverable.
  it('carries the writer’s real name on the label, so a truncated one can still be read', () => {
    const { host, overlay } = makeOverlay()
    overlay.setLegend([
      { swatch: '#6b73ff', label: 'wiki:vegetation_patch_ceiling_demo', detail: '1,284 blocks', title: 'Cells this writer wrote in the run on screen.' },
      { swatch: '#c9f294', label: 'wiki:trunk', detail: '12 blocks' },
    ])
    const labels = [...host.querySelectorAll<HTMLElement>('.fl-vp-legend-label')]
    // Both questions -- what is it called, and what does the colour mean -- from one hover.
    expect(labels[0]!.title).toBe('wiki:vegetation_patch_ceiling_demo — Cells this writer wrote in the run on screen.')
    // ...and the name alone when the row has nothing else to say.
    expect(labels[1]!.title).toBe('wiki:trunk')
  })

  // "Click a block to find what placed it" was the only route to the attribution answer, and it
  // needed a mouse: the rows carried each writer's name and count as text, but as list items
  // with no tab stop.
  it('makes a writer\u2019s row a control that frames and selects its own cells', () => {
    const { host, overlay } = makeOverlay()
    const framed: string[] = []
    overlay.setLegend([
      { swatch: '#6b73ff', label: 'wiki:trunk', detail: '12 blocks', title: 'Cells this writer wrote.', onActivate: () => framed.push('trunk'), actionLabel: 'Frame and select the cells wiki:trunk wrote' },
      { swatch: '#c9f294', label: 'wiki:canopy', detail: '1,284 blocks', onActivate: () => framed.push('canopy') },
      // Not a writer: nothing to select, so it stays a label.
      { swatch: '#ff5a3c', label: 'carved', detail: 'turned to air' },
    ])
    const rows = [...host.querySelectorAll('.fl-vp-legend-row')]
    // The list semantics survive -- the control is INSIDE the list item, so the legend still
    // reads as a key rather than as a row of buttons.
    expect(rows.map((r) => r.getAttribute('role'))).toEqual(['listitem', 'listitem', 'listitem'])
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.fl-vp-legend-btn')]
    expect(buttons).toHaveLength(2)
    expect(rows[2]!.querySelector('.fl-vp-legend-btn')).toBeNull()

    // Named by what activating it DOES, with the count, so the row is as informative spoken as
    // it is on screen.
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Frame and select the cells wiki:trunk wrote (12 blocks)')
    // ...and a row with no actionLabel of its own still gets a sentence rather than a glyph.
    expect(buttons[1]!.getAttribute('aria-label')).toBe('Frame and select the cells wiki:canopy wrote (1,284 blocks)')

    // One selection at a time: the pressed row is always the one being looked at.
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    buttons[1]!.dispatchEvent(new Event('click'))
    expect(framed).toEqual(['canopy'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    buttons[0]!.dispatchEvent(new Event('click'))
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    // And it says what it did, in the overlay's one polite region.
    expect((host.querySelector('.fl-vp-announce') as HTMLElement).textContent).toBe('wiki:trunk framed \u2014 12 blocks')

    // The swatch and the label still live in the row, now inside the control.
    expect(buttons[0]!.querySelector('.fl-vp-legend-label')?.textContent).toBe('wiki:trunk')
    expect(buttons[0]!.querySelector('.fl-vp-swatch')).not.toBeNull()
  })

  it('replaces the previous legend rather than appending to it', () => {
    const { host, overlay } = makeOverlay()
    overlay.setLegend([{ swatch: '#6b73ff', label: 'one' }])
    overlay.setLegend([{ swatch: '#2ec5d9', label: 'two' }])
    const legend = host.querySelector('.fl-vp-legend') as HTMLElement
    expect([...legend.querySelectorAll('.fl-vp-legend-label')].map((el) => el.textContent)).toEqual(['two'])
  })
})

// The readout under the canvas is the best writing in the panel and the easiest thing in the
// window to miss -- and when a run places nothing, the 3D view does not change at all.
describe('viewport overlay: the one-line answer, on the view', () => {
  it('shows and clears one line, and announces it', () => {
    const { host, overlay } = makeOverlay()
    const notice = host.querySelector('.fl-vp-notice') as HTMLElement
    expect(notice.hidden).toBe(true)
    expect(notice.getAttribute('role')).toBe('status')

    overlay.setNotice({ text: 'Placed nothing · chance roll failed — 0.05 ×412', tone: 'empty', title: 'Another seed may pass.' })
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toBe('Placed nothing · chance roll failed — 0.05 ×412')
    expect(notice.title).toBe('Another seed may pass.')

    overlay.setNotice(null)
    expect(notice.hidden).toBe(true)
    expect(notice.textContent).toBe('')
    expect(notice.hasAttribute('title')).toBe(false)
  })

  it('marks a cut-off run differently from an empty one', () => {
    const { host, overlay } = makeOverlay()
    const notice = host.querySelector('.fl-vp-notice') as HTMLElement
    overlay.setNotice({ text: 'Partial result', tone: 'warn' })
    expect(notice.classList.contains('fl-vp-notice-warn')).toBe(true)
    overlay.setNotice({ text: 'Placed nothing', tone: 'empty' })
    expect(notice.classList.contains('fl-vp-notice-warn')).toBe(false)
  })
})

describe('viewport overlay: busy reads as busy, not as broken', () => {
  it('shows a pill with elapsed time, and hides it again when the run settles', () => {
    const { host, overlay } = makeOverlay()
    const pill = host.querySelector('.fl-vp-pill') as HTMLElement
    expect(pill.hidden).toBe(true)

    overlay.setBusy(true)
    expect(pill.hidden).toBe(false)
    overlay.setElapsed(1234)
    expect((host.querySelector('.fl-vp-pill-text') as HTMLElement).textContent).toBe('Generating… 1.2 s')

    overlay.setBusy(false)
    expect(pill.hidden).toBe(true)
    // The next run starts from "Generating…", never from the last run's stale duration.
    expect((host.querySelector('.fl-vp-pill-text') as HTMLElement).textContent).toBe('Generating…')
  })

  // The pill WAS the live region while setElapsed rewrote it ten times a second: 30 polite
  // mutations in three seconds, and 16 more in the four after Cancel. A polite queue does not
  // coalesce that -- it backs up and reads out seconds from a run that ended long ago.
  it('announces the transitions and not the clock', () => {
    const { host, overlay } = makeOverlay()
    const pill = host.querySelector('.fl-vp-pill') as HTMLElement
    const announcer = host.querySelector('.fl-vp-announce') as HTMLElement
    // The clock is no longer in a live region at all.
    expect(pill.hasAttribute('role')).toBe(false)
    expect(pill.hasAttribute('aria-live')).toBe(false)
    expect(announcer.getAttribute('role')).toBe('status')
    expect(announcer.getAttribute('aria-live')).toBe('polite')

    // A whole run's worth of ticking produces ONE announcement -- the start.
    const seen: string[] = []
    const record = (): void => {
      const text = announcer.textContent ?? ''
      if (seen[seen.length - 1] !== text) seen.push(text)
    }
    overlay.setBusy(true)
    record()
    for (let ms = 0; ms <= 3000; ms += 100) {
      overlay.setElapsed(ms)
      record()
    }
    expect(seen).toEqual(['Generating…'])
    // ...and the pill itself still counts, on screen, where a clock belongs.
    expect((host.querySelector('.fl-vp-pill-text') as HTMLElement).textContent).toBe('Generating… 3.0 s')

    overlay.setBusy(false)
    expect(announcer.textContent).toBe('')
  })

  it('announces a cancellation once, and its silence once, however long the clock runs', () => {
    const { host, overlay } = makeOverlay()
    const announcer = host.querySelector('.fl-vp-announce') as HTMLElement
    const cancel = host.querySelector('.fl-vp-cancel') as HTMLButtonElement
    overlay.setCancelHandler(vi.fn())
    overlay.setBusy(true)
    overlay.setElapsed(1000)

    const seen: string[] = []
    const record = (): void => {
      const text = announcer.textContent ?? ''
      if (seen[seen.length - 1] !== text) seen.push(text)
    }
    record()
    cancel.dispatchEvent(new Event('click'))
    record()
    for (let ms = 1100; ms <= 1000 + CANCEL_GRACE_MS + 4000; ms += 100) {
      overlay.setElapsed(ms)
      record()
    }
    // Two sentences for the whole cancellation, not one per tick -- the pill's own text is what
    // goes on counting the silence (see the escalation test below).
    expect(seen).toEqual(['Generating…', 'Cancelling…', `Cancelling… the engine has not replied after ${formatElapsed(CANCEL_GRACE_MS)}`])
  })

  // The sentence this overlay cannot know -- what the run produced -- belongs to whoever does
  // know it (panel.ts's .fl-sr-status), and this is the region it can say it in.
  it('lets a host say one sentence into that region and nothing else', () => {
    const { host, overlay } = makeOverlay()
    const announcer = host.querySelector('.fl-vp-announce') as HTMLElement
    overlay.announce('135 placed, 0 carved, 0 replaced, in 1.0 ms.')
    expect(announcer.textContent).toBe('135 placed, 0 carved, 0 replaced, in 1.0 ms.')
  })

  it('offers Cancel only to a host that can actually cancel', () => {
    const { host, overlay } = makeOverlay()
    const cancel = host.querySelector('.fl-vp-cancel') as HTMLButtonElement
    overlay.setBusy(true)
    // No handler armed: the button is not there at all, rather than there and inert.
    expect(cancel.hidden).toBe(true)

    const onCancel = vi.fn()
    overlay.setCancelHandler(onCancel)
    expect(cancel.hidden).toBe(false)
    cancel.dispatchEvent(new Event('click'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    overlay.setCancelHandler(null)
    expect(cancel.hidden).toBe(true)
  })

  // Cancel used to change nothing at all: the timer went on counting and the button stayed live,
  // so the only available readings were "the click missed" and "this cannot be cancelled".
  it('acknowledges the Cancel click, stops the timer, and settles when the host replies', () => {
    const { host, overlay } = makeOverlay()
    const onCancel = vi.fn()
    const cancel = host.querySelector('.fl-vp-cancel') as HTMLButtonElement
    const text = host.querySelector('.fl-vp-pill-text') as HTMLElement
    overlay.setCancelHandler(onCancel)
    overlay.setBusy(true)
    overlay.setElapsed(1200)
    expect(text.textContent).toBe('Generating… 1.2 s')

    cancel.focus()
    cancel.dispatchEvent(new Event('click'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(text.textContent).toBe('Cancelling…')
    expect(cancel.getAttribute('aria-disabled')).toBe('true')
    // ...and FOCUS IS STILL ON IT. `cancelBtn.disabled = true` fired while the button held
    // focus, which dropped focus to <body>, so pressing Enter on Cancel sent the caret to the
    // top of the document and the next Tab restarted from the end of the overlay.
    expect(document.activeElement).toBe(cancel)

    // The timer must not overwrite the acknowledgement on its next tick.
    overlay.setElapsed(2400)
    expect(text.textContent).toBe('Cancelling…')

    // A second click cannot re-ask -- there is nothing a second request could add.
    cancel.dispatchEvent(new Event('click'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    // Only the host ends it: a result, an error, or a dead engine, all of which clear busy.
    overlay.setBusy(false)
    expect((host.querySelector('.fl-vp-pill') as HTMLElement).hidden).toBe(true)
    expect(cancel.hasAttribute('aria-disabled')).toBe(false)
    expect(text.textContent).toBe('Generating…')
  })

  // "Cancelling…" was unbounded: a host that never replied left that word on the pill forever
  // (held for eight seconds in the review, with no change of any kind), which is the same dead
  // end the un-acknowledged click was -- nothing on screen distinguished "still stopping the
  // run" from "nobody is listening".
  it('stops promising and starts reporting when a cancellation goes unanswered', () => {
    const { host, overlay } = makeOverlay()
    const cancel = host.querySelector('.fl-vp-cancel') as HTMLButtonElement
    const text = host.querySelector('.fl-vp-pill-text') as HTMLElement
    overlay.setCancelHandler(vi.fn())
    overlay.setBusy(true)
    overlay.setElapsed(2_000)
    cancel.dispatchEvent(new Event('click'))
    expect(text.textContent).toBe('Cancelling…')

    // Inside the grace period it stays a plain acknowledgement -- an escalation on every
    // ordinary cancel would be noise.
    overlay.setElapsed(2_000 + CANCEL_GRACE_MS - 100)
    expect(text.textContent).toBe('Cancelling…')

    // Past it, the silence itself becomes the readout, counting in the same clock.
    overlay.setElapsed(2_000 + CANCEL_GRACE_MS)
    expect(text.textContent).toBe(`Cancelling… no reply after ${formatElapsed(CANCEL_GRACE_MS)}`)
    overlay.setElapsed(2_000 + 8_000)
    expect(text.textContent).toBe('Cancelling… no reply after 8.0 s')

    // It still never re-arms the button: asking twice does not make a silent host answer.
    expect(cancel.getAttribute('aria-disabled')).toBe('true')

    // And the host's reply still ends it, from any of those states.
    overlay.setBusy(false)
    expect(text.textContent).toBe('Generating…')

    // The next run starts its own clock -- the previous cancellation's elapsed reading must not
    // leak into it and make a fresh cancel escalate immediately.
    overlay.setBusy(true)
    overlay.setElapsed(200)
    cancel.dispatchEvent(new Event('click'))
    overlay.setElapsed(400)
    expect(text.textContent).toBe('Cancelling…')
  })

  it('formats elapsed time to a fixed width, so a running number does not make the pill twitch', () => {
    expect(formatElapsed(0)).toBe('0.0 s')
    expect(formatElapsed(450)).toBe('0.5 s')
    expect(formatElapsed(12_000)).toBe('12.0 s')
    // Defensive: a clock that went backwards, or a NaN, reads as zero rather than as "NaN s".
    expect(formatElapsed(-5)).toBe('0.0 s')
    expect(formatElapsed(Number.NaN)).toBe('0.0 s')
  })
})

// The VS Code shell owns a write-attribution readout of its own (#fl-attribution), and styled it
// `position: absolute; top: 8px; left: 8px; z-index: 5` -- the same corner as .fl-vp-controls,
// one layer above it. Whenever it showed, it covered the whole toolbar: 152x25px of overlap, the
// toolbar's full width and 78% of its height, with the buttons still taking clicks underneath,
// so the only symptom was two unreadable things.
describe('viewport overlay: a host’s own status line joins the column instead of floating over it', () => {
  it('puts the adopted element in the flex column, between the notice and the legend', () => {
    const { host, overlay } = makeOverlay()
    const readout = document.createElement('div')
    readout.id = 'fl-attribution'
    readout.style.position = 'absolute'
    readout.style.top = '8px'
    readout.style.left = '8px'
    document.body.append(readout)

    overlay.adoptStatus(readout)

    const column = host.querySelector('.fl-vp') as HTMLElement
    expect(readout.parentElement).toBe(column)
    const order = [...column.children].map((el) => el.id || el.className)
    expect(order.indexOf('fl-attribution')).toBeGreaterThan(order.findIndex((c) => c.includes('fl-vp-notice')))
    expect(order.indexOf('fl-attribution')).toBeLessThan(order.findIndex((c) => c.includes('fl-vp-legend')))
  })

  it('takes it out of absolute positioning, which is the whole reason it could overlap', () => {
    const { overlay } = makeOverlay()
    const readout = document.createElement('div')
    readout.style.position = 'absolute'
    overlay.adoptStatus(readout)
    // Inline, because the shell's rule is keyed on an id and outranks any class this stylesheet
    // could add -- see adoptStatus's own doc comment.
    expect(readout.style.position).toBe('static')
    expect(readout.classList.contains('fl-vp-status')).toBe(true)
    expect(readout.style.maxWidth).not.toBe('')
  })

  it('leaves what the element SAYS to its owner', () => {
    const { overlay } = makeOverlay()
    const readout = document.createElement('div')
    readout.setAttribute('role', 'status')
    readout.setAttribute('aria-live', 'polite')
    readout.textContent = 'wiki:trunk: 12 block(s), 12 write(s).'
    readout.hidden = false
    overlay.adoptStatus(readout)
    expect(readout.getAttribute('role')).toBe('status')
    expect(readout.getAttribute('aria-live')).toBe('polite')
    expect(readout.textContent).toBe('wiki:trunk: 12 block(s), 12 write(s).')
    expect(readout.hidden).toBe(false)
  })
})
