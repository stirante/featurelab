// graphAccess.test.ts -- what the node editor is like to use without a mouse, and without the
// eyesight the palette assumes.
//
// WHY THIS FILE IS SEPARATE FROM THE OTHER GRAPH SUITES. Everything here is a claim about the
// SHIPPED page rather than about a module: the real shell HTML that src/graphPanel.ts emits,
// under the real Content-Security-Policy, with media/graph.css and the real webview/graph.ts
// loaded into it, themed with real Dark Modern and Light Modern palettes. Every finding it
// covers was reported against that page and none of them is visible from any one module -- a
// selector losing on specificity, a colour that only fails once a host's variable is substituted
// in, a Tab that leaves a dialog open behind it.
//
// HOW CONTRAST IS MEASURED HERE, which is the part worth being pedantic about. Nothing compares
// hex strings. `contrastOf` asks Chromium for the COMPUTED colour of the element and of every
// background behind it, composites the stack the way a compositor does -- alpha, and `opacity`
// applied to everything an element and its descendants paint -- and runs WCAG 2.x relative
// luminance over the result. A hard-coded expectation would pass a theme swap it should have
// failed, and would say nothing at all about `#3b3b3b99`, which is the actual shape of this
// problem: a colour that is perfectly readable until the host resolves its 60% alpha over a
// near-white panel.
//
// The palettes are pinned by arithmetic rather than by trust: `reproduces the numbers the audit
// measured` re-derives four of the reported failures from these two palettes alone. If a value
// in either palette were wrong, that test fails before any of the others can pass for the wrong
// reason.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(here, '..')
const cssPath = path.join(appRoot, 'media', 'graph.css')
const webviewPath = path.join(appRoot, 'webview', 'graph.ts')

// ---------------------------------------------------------------------------
// The palettes
// ---------------------------------------------------------------------------

/** VS Code's Dark Modern, the default theme, in the variables this page reads. */
const DARK_MODERN: Record<string, string> = {
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-editorWidget-foreground': '#cccccc',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-editorError-foreground': '#f14c4c',
  '--vscode-textPreformat-foreground': '#d7ba7d',
  '--vscode-textCodeBlock-background': '#2a2a2a',
  '--vscode-editorIndentGuide-background': '#404040',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-charts-blue': '#4e94ce',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-lines': '#dadada',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

/** VS Code's Light Modern.
 *
 * `#3b3b3b99` is the value the audit named and where nearly every 3.40:1 reading came from: the
 * two themes do NOT resolve `descriptionForeground` the same way, and that asymmetry is the
 * whole finding. Dark Modern hands the webview an opaque grey; Light Modern hands it the
 * theme's own foreground carrying a `99` alpha byte, which composites to #878787 over a #f8f8f8
 * panel. Written here the way the host writes it rather than pre-flattened, because flattening
 * it is exactly the step the stylesheet cannot do for itself. */
const LIGHT_MODERN: Record<string, string> = {
  ...DARK_MODERN,
  '--vscode-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#3b3b3b99',
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-editorWidget-foreground': '#3b3b3b',
  '--vscode-list-hoverBackground': '#e8e8e8',
  '--vscode-widget-border': '#e5e5e5',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-list-activeSelectionBackground': '#005fb8',
  '--vscode-badge-background': '#cccccc',
  '--vscode-badge-foreground': '#3b3b3b',
  '--vscode-editorWarning-foreground': '#bf8803',
  '--vscode-editorError-foreground': '#e51400',
  '--vscode-textPreformat-foreground': '#a31515',
  '--vscode-textCodeBlock-background': '#f3f3f3',
  '--vscode-editorIndentGuide-background': '#d3d3d3',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-charts-blue': '#1a85ff',
  '--vscode-charts-green': '#388a34',
  '--vscode-charts-purple': '#652d90',
  '--vscode-charts-yellow': '#bf8803',
  '--vscode-charts-red': '#e51400',
  '--vscode-charts-lines': '#616161',
}

const THEMES: readonly [name: string, vars: Record<string, string>][] = [
  ['Dark Modern', DARK_MODERN],
  ['Light Modern', LIGHT_MODERN],
]

/** WCAG 2.x AA for text below 18.66px bold / 24px regular, which is every string in this panel. */
const AA = 4.5
/** WCAG 2.x AA for a non-text indicator: a stripe, a border, a chart line. */
const AA_NON_TEXT = 3

// ---------------------------------------------------------------------------
// The contrast arithmetic, in node, so it can be checked against known answers
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number]

/** Every colour spelling that reaches this code.
 *
 * Hex with or without an alpha byte, because that is how a theme file writes one; `rgb()` and
 * `rgba()`, because that is how `getComputedStyle` answers for an ordinary colour; and
 * `color(srgb r g b / a)` with its 0..1 channels, because that is how Chromium answers for
 * anything that went through `color-mix()` -- which is every derived colour in this stylesheet.
 * Missing that last case does not throw, it silently reads black-on-black, so it is spelled out
 * rather than left to a regex that happens to cover it. */
export function parseColour(input: string): Rgba {
  const text = input.trim()
  if (text.startsWith('#')) {
    const hex = text.slice(1)
    const wide = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    const byte = (i: number): number => Number.parseInt(wide.slice(i * 2, i * 2 + 2), 16)
    return [byte(0), byte(1), byte(2), wide.length >= 8 ? byte(3) / 255 : 1]
  }
  if (text.startsWith('color(')) {
    const inside = text.slice('color('.length).replace(/\)$/, '').trim()
    const space = inside.split(/\s+/)[0]
    if (space !== 'srgb') throw new Error(`cannot read colour ${input}: only the srgb space is handled`)
    const n = inside.slice(space.length).split(/[\s/]+/).filter((p) => p !== '').map(Number)
    if (n.length < 3 || n.some((v) => Number.isNaN(v))) throw new Error(`cannot read colour ${input}`)
    return [n[0]! * 255, n[1]! * 255, n[2]! * 255, n[3] ?? 1]
  }
  const parts = text.replace(/^rgba?\(/, '').replace(/\)$/, '').split(/[\s,/]+/).filter((p) => p !== '')
  const n = parts.map(Number)
  if (n.length < 3 || n.some((v) => Number.isNaN(v))) throw new Error(`cannot read colour ${input}`)
  return [n[0]!, n[1]!, n[2]!, n[3] ?? 1]
}

/** `source` painted over `backdrop` at `alpha`. The backdrop is always opaque by construction
 * here: the walk that produces one starts from the page's own background. */
export function over(source: Rgba, backdrop: Rgba, alpha: number): Rgba {
  const a = Math.max(0, Math.min(1, alpha))
  return [
    source[0] * a + backdrop[0] * (1 - a),
    source[1] * a + backdrop[1] * (1 - a),
    source[2] * a + backdrop[2] * (1 - a),
    1,
  ]
}

/** WCAG 2.x relative luminance. */
export function luminance(colour: Rgba): number {
  const channel = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2])
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('the contrast arithmetic', () => {
  it('reproduces the numbers the audit measured, from the palettes above and nothing else', () => {
    // If any of these four drifts, either the arithmetic is wrong or a palette value is, and
    // every ratio asserted further down is measured against the wrong thing.
    const widget = parseColour(LIGHT_MODERN['--vscode-editorWidget-background']!)

    // Body text in `descriptionForeground` on a panel: the reading behind "status line 3.40,
    // section headings 3.40, lineage kind 3.40, lineage count 3.40, card subtitle 3.40".
    const description = parseColour(LIGHT_MODERN['--vscode-descriptionForeground']!)
    expect(contrast(over(description, widget, description[3]), widget)).toBeCloseTo(3.4, 1)

    // The disabled Undo, which was `foreground` at `opacity: 0.5`, in both themes.
    const lightFace = parseColour(LIGHT_MODERN['--vscode-foreground']!)
    expect(contrast(over(lightFace, widget, 0.5), widget)).toBeCloseTo(2.67, 2)
    const darkWidget = parseColour(DARK_MODERN['--vscode-editorWidget-background']!)
    const darkFace = parseColour(DARK_MODERN['--vscode-foreground']!)
    expect(contrast(over(darkFace, darkWidget, 0.5), darkWidget)).toBeCloseTo(3.59, 2)

    // A quieted card's type line at the old `opacity: 0.35`: `descriptionForeground` resolved
    // over the card's surface, then the whole card faded over the canvas behind it.
    for (const [theme, expected] of [
      [DARK_MODERN, 1.89],
      [LIGHT_MODERN, 1.45],
    ] as const) {
      const canvas = parseColour(theme['--vscode-editor-background']!)
      const surface = parseColour(theme['--vscode-editorWidget-background']!)
      const muted = parseColour(theme['--vscode-descriptionForeground']!)
      const text = over(muted, surface, muted[3])
      const bg = over(surface, canvas, 0.35)
      expect(contrast(over(text, bg, 0.35), bg)).toBeCloseTo(expected, 1)
    }
  })

  it('reads every colour spelling the host and the CSSOM produce', () => {
    expect(parseColour('#fff')).toEqual([255, 255, 255, 1])
    expect(parseColour('#3b3b3b')).toEqual([59, 59, 59, 1])
    expect(parseColour('#3b3b3b99')[3]).toBeCloseTo(0.6, 2)
    expect(parseColour('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1])
    expect(parseColour('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5])
    // What Chromium answers for a `color-mix()` result, which is every derived colour here.
    const mixed = parseColour('color(srgb 0.394431 0.394431 0.394431)')
    expect(mixed[0]).toBeCloseTo(100.58, 1)
    expect(mixed[3]).toBe(1)
    expect(parseColour('color(srgb 0 0 0 / 0.5)')[3]).toBe(0.5)
  })

  it('agrees with the reference values WCAG itself publishes', () => {
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5)
    expect(contrast([255, 255, 255, 1], [255, 255, 255, 1])).toBeCloseTo(1, 5)
    // #767676 on white is the canonical "exactly AA" grey.
    expect(contrast([118, 118, 118, 1], [255, 255, 255, 1])).toBeGreaterThanOrEqual(4.5)
    expect(contrast([119, 119, 119, 1], [255, 255, 255, 1])).toBeLessThan(4.5)
  })
})

// ---------------------------------------------------------------------------
// The stylesheet, as text
// ---------------------------------------------------------------------------

describe('media/graph.css, read as a cascade rather than as a list of declarations', () => {
  const css = readFileSync(cssPath, 'utf-8')

/** graph.css explains itself at length, and several of those explanations quote the exact
 * selector shape they are telling you not to write. A scanner that reads comments fails on the
 * paragraph warning it off. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every class render.ts puts on, takes off, or toggles on the CANVAS ROOT -- read out of the
 * code rather than restated here.
 *
 * WHY IT IS DERIVED. A class on the root is the one place in this document where a class change
 * is a whole-document style recalculation: the canvas keeps all 3,531 cards and all 4,580 edge
 * groups in the DOM whatever the camera is showing, so a rule whose subject is a DESCENDANT of a
 * root state class makes every one of them a candidate every time the state flips. Which classes
 * those are is a fact about render.ts, and the only honest source for it is render.ts. A list
 * typed into a test is a snapshot of the day it was typed, and this one had already gone stale
 * twice.
 *
 * `root.classList.add|remove|toggle('name', 'name2', ...)` is how every one of them is written,
 * and `root` is this module's own name for the canvas root, so the pattern is the code's own
 * vocabulary rather than a convention invented here. A future spelling that this misses shows up
 * as an empty list, which the test asserts against. */
function rootStateClasses(): string[] {
  const source = readFileSync(path.join(appRoot, 'src', 'graph', 'render.ts'), 'utf-8')
  const names = new Set<string>()
  for (const call of source.matchAll(/\broot\.classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    for (const quoted of call[1]!.matchAll(/['"]([a-zA-Z0-9_-]+)['"]/g)) names.add(quoted[1]!)
  }
  // AND THE PER-ELEMENT STATES, for the same reason and from the same source. `flg-quiet` and
  // `flg-node-dim` were moved OFF the root precisely because they cost 280 ms and 226 ms as
  // ancestors; putting either back as the ancestor of something ELSE costs the same again, and
  // nothing about their being per-element stops that from being written. `visual` is this
  // module's name for one drawn thing, so a toggle on `visual.box`, `visual.group` or
  // `visual.chip` is a state that flips under the user's hand on an element the sheet can reach.
  for (const call of source.matchAll(/\bvisual\.(?:box|group|chip)\.classList\.toggle\(([^)]*)\)/g)) {
    for (const quoted of call[1]!.matchAll(/['"]([a-zA-Z0-9_-]+)['"]/g)) names.add(quoted[1]!)
  }
  // Every class in this sheet is namespaced, and a `classList.toggle` call's SECOND argument is a
  // condition that can be a string literal of its own -- `toggle('flg-has-multi', kind ===
  // 'nodes')` contributes a spurious `nodes`. The prefix is what tells an argument that is a class
  // from one that is not.
  return [...names].filter((name) => name.startsWith('flg-')).sort()
}

/** Every class render.ts writes onto something INSIDE the canvas -- one card, one edge, one chip,
 * or one of the fixed layers the world is built out of.
 *
 * WHAT IT IS FOR. `rootStateClasses` can only name classes render.ts already toggles on the root,
 * so the guard built on it is fail-OPEN: a state class invented tomorrow, written without the
 * `.flg-graph` prefix, is a rule nothing in this file has heard of and it passes. This list is the
 * other half of the same question and it is used the other way round -- to say which ancestors are
 * ALLOWED. An ancestor spelled out of these is a scope INSIDE one card, and a rule scoped to one
 * card invalidates one card. An ancestor that is none of them can only be the canvas root wearing
 * something, whatever that something is called, and that is the expensive shape.
 *
 * Fail-CLOSED, which is the whole point: an unknown class as the ancestor of a card is caught by
 * default rather than let through by default.
 *
 * READ OUT OF THE CODE, for the same reason rootStateClasses is. Three spellings, because the
 * renderer has three: `el`/`svg` with a literal class string, the same with a TEMPLATE literal
 * (`flg-edge-${kind}`, which is where every edge and chip variant comes from -- the family prefix
 * is recorded, since the suffix is a value rather than a name), and `classList.add|toggle` on an
 * element that is not the root. The root's own state classes are then taken back out: `root` is
 * the one element in this document that is not inside anything. */
function drawnClasses(): { exact: Set<string>; prefixes: string[] } {
  const source = readFileSync(path.join(appRoot, 'src', 'graph', 'render.ts'), 'utf-8')
  const exact = new Set<string>()
  const prefixes = new Set<string>()
  const take = (token: string): void => {
    const family = /^(flg-[a-z0-9-]*)\$\{/.exec(token)
    if (family) {
      prefixes.add(family[1]!)
      return
    }
    if (/^flg-[a-z0-9-]+$/.test(token)) exact.add(token)
  }
  for (const call of source.matchAll(/\b(?:el|svg|svgEl)\(\s*'[A-Za-z]+'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g)) {
    for (const token of (call[1] ?? call[2] ?? '').split(/\s+/)) take(token)
  }
  for (const call of source.matchAll(/\.classList\.(?:add|toggle|remove)\(([^)]*)\)/g)) {
    for (const quoted of call[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)) take(quoted[1]!)
  }
  for (const name of rootStateClassesOnRoot()) exact.delete(name)
  return { exact, prefixes: [...prefixes] }
}

/** Just the classes toggled on the ROOT, without the per-element ones rootStateClasses folds in.
 * The per-element ones are legitimate ancestors -- `.flg-node.flg-selected .flg-node-head` styles
 * one card -- and only the root's are not. */
function rootStateClassesOnRoot(): string[] {
  const source = readFileSync(path.join(appRoot, 'src', 'graph', 'render.ts'), 'utf-8')
  const names = new Set<string>()
  for (const call of source.matchAll(/\broot\.classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    for (const quoted of call[1]!.matchAll(/['"]([a-zA-Z0-9_-]+)['"]/g)) names.add(quoted[1]!)
  }
  return [...names].filter((name) => name.startsWith('flg-'))
}

/** The classes named in one compound selector. */
function classesIn(compound: string): string[] {
  return [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!)
}

/** Every selector in `text` whose SUBJECT is something the canvas holds thousands of and whose
 * ANCESTOR is the canvas root under some class -- the shape, with no class name in it. */
function rootScopedDescendants(text: string): string[] {
  const { exact, prefixes } = drawnClasses()
  const drawn = (name: string): boolean => exact.has(name) || prefixes.some((p) => name.startsWith(p) && name !== p)
  const out: string[] = []
  for (const selector of selectorsOf(text)) {
    const compounds = selector.split(/\s+|(?=>)|(?<=>)/).filter((part) => part !== '' && !'>+~'.includes(part))
    if (compounds.length < 2) continue
    // The subject has to be one of the many: a rule on the status line or a dialog costs nothing
    // however it is scoped, because there is one of it.
    if (!classesIn(compounds[compounds.length - 1]!).some(drawn)) continue
    // An ancestor may name a card, an edge, a chip, one of their parts or one of the fixed layers
    // -- anything the renderer BUILDS. `.flg-graph` itself is allowed bare, and with an attribute
    // on it: see the zoom band, which is a property of the camera rather than a state under the
    // user's hand. Any other class up there is a state on the root by elimination.
    const strays = compounds
      .slice(0, -1)
      .flatMap(classesIn)
      .filter((name) => !drawn(name) && name !== 'flg-graph')
    if (strays.length > 0) out.push(`${selector} -- .${[...new Set(strays)].join(', .')}`)
  }
  return out
}

/** Every individual selector in the sheet, one per comma-separated piece, at-rules excluded. */
function selectorsOf(text: string): string[] {
  const out: string[] = []
  for (const block of text.matchAll(/^([^{@}\n][^{}]*?)\{/gm)) {
    for (const piece of block[1]!.split(',')) {
      const selector = piece.trim()
      if (selector !== '') out.push(selector)
    }
  }
  return out
}

  it('the status line error state can actually win against #flg-status', () => {
    // THE BUG THIS PINS. `#flg-status { color: ... }` is one id, 1-0-0. `.flg-status-error
    // { color: ... }` is one class, 0-1-0, and loses to it no matter where it sits in the file,
    // so the error state was never painted at all: a refusal and "Saved." rendered identically
    // in both themes. Any rule that means to override a property set on an id selector has to
    // contain an id selector of its own, so that is what is asserted -- not the exact text of
    // one, which would pin a spelling rather than the reason.
    const errorRules = [...stripComments(css).matchAll(/^([^{@}\n][^{}]*?)\{([^{}]*)\}/gm)]
      .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
      .filter((rule) => rule.selector.includes('flg-status-error'))
    expect(errorRules.length).toBeGreaterThan(0)
    for (const rule of errorRules) {
      expect(rule.selector, `${rule.selector} cannot beat #flg-status without an id of its own`).toMatch(/#flg-status/)
    }
  })

  it('never hangs a rule off a STATE CLASS on the canvas root', () => {
    // THE RULE, STATED ONCE AND MECHANICALLY, because stating it as a list of four class names
    // is exactly what let a fifth one through.
    //
    // A rule whose subject is a descendant of a class on `.flg-graph` turns every class change
    // on that root into a style recalculation over every element that could be that subject --
    // and this document keeps all 3,531 cards and all 4,580 edge groups in it whatever the
    // camera shows. Measured on the fixture: `flg-quiet` and `flg-node-dim` cost 280 ms and
    // 226 ms before they were moved onto the elements themselves, and an audit later found
    // `flg-linking-armed` still at 228 ms and `flg-linking` at 102 ms -- nine rules, none of
    // them caught, because the guard named four classes instead of the SHAPE.
    //
    // So the shape is what is rejected: `.flg-graph` combined with any class, anywhere other
    // than in the subject's own compound. Every state this canvas has is already written per
    // element by render.ts, which is why no rule needs it.
    //
    // `.flg-graph[data-zoom-band='...'] .flg-node-*` is deliberately NOT caught, and is the one
    // exception. The zoom band is a property of the CAMERA rather than a state of an
    // interaction; it changes only while the whole canvas is being redrawn anyway, and every one
    // of those rules is about hiding a part of a card that cannot be read at that scale. An
    // attribute is how that difference is spelled in this file -- a CLASS on the root means "a
    // state that toggles under the user's hand", and a class is what this rejects.
    const withoutComments = stripComments(css)
    const rootStateAncestors: string[] = []
    const namedAncestors: string[] = []
    // THE LIST COMES OUT OF THE CODE, because a list written here is a list of the classes that
    // existed on the day it was written. The previous version of this test paired the shape regex
    // below with six names typed by hand, and by the time it was looked at again `flg-has-multi`
    // and `flg-marqueeing` were both being toggled on the root and neither was in it -- the exact
    // failure the shape regex was introduced to stop, reproduced one line lower down. Worse, the
    // two halves covered each other's gaps only by accident: a rule written WITHOUT the
    // `.flg-graph` prefix, `.flg-linking .flg-node { ... }`, is functionally identical and just as
    // expensive, and passed both.
    //
    // So the names are read off render.ts, which is the only thing that can say what a state class
    // on the root IS: whatever `root.classList` is handed. A class invented tomorrow is covered
    // the day it is written, and a class deleted stops being asserted about without anybody having
    // to remember this file.
    const perElement = rootStateClasses()
    expect(perElement.length, 'no root state classes were found in render.ts -- this guard is reading the wrong thing').toBeGreaterThan(4)
    for (const selector of selectorsOf(withoutComments)) {
      const compounds = selector.split(/\s+|(?=>)|(?<=>)/).filter((part) => part !== '' && !'>+~'.includes(part))
      for (const [index, compound] of compounds.entries()) {
        if (index === compounds.length - 1) continue
        if (/\.flg-graph[^ >+~]*\./.test(compound)) rootStateAncestors.push(selector)
        for (const name of perElement) {
          if (compound.includes(name)) namedAncestors.push(selector + ' -- .' + name)
        }
      }
    }
    expect(
      rootStateAncestors,
      'a state class on .flg-graph is being used as an ANCESTOR again. Every one of those is a whole-document style invalidation on an interaction; put the state on the element being styled, the way render.ts already writes flg-quiet, flg-node-dim, flg-link-ok and flg-link-source.',
    ).toEqual([])
    expect(
      namedAncestors,
      `a class render.ts toggles on the canvas root (${perElement.join(', ')}) is being used as an ANCESTOR, with or without .flg-graph in front of it. The prefix is not what makes it expensive -- the invalidation is.`,
    ).toEqual([])
  })

  it('never scopes a card, an edge or a chip to the canvas root, whatever the root is wearing', () => {
    // THE SAME RULE AS ABOVE, TURNED THE RIGHT WAY ROUND. The guard above can only name classes
    // render.ts is ALREADY toggling on the root, so it is fail-open by construction: a brand-new
    // root-state class, written without the `.flg-graph` prefix, is a name nothing in this file
    // has heard of and it passes both halves. Deriving the list better cannot fix that -- the list
    // is of what exists, and the rule is about what somebody writes next.
    //
    // So the question is asked the other way. It is not "is this ancestor a known state class",
    // it is "is this ancestor a scope INSIDE one card" -- a card, an edge, a chip, one of their
    // parts, one of the fixed layers, all of which render.ts BUILDS (see drawnClasses). Anything
    // else in an ancestor compound can only be the root under a class, whatever the class is
    // called, and that is the whole-document invalidation. Unknown is caught, not allowed.
    //
    // `.flg-graph` bare and `.flg-graph[data-zoom-band='...']` stay legal: see the note above on
    // why an ATTRIBUTE on the root is the one exception, and why it is spelled as an attribute.
    expect(
      rootScopedDescendants(stripComments(css)),
      'a rule scopes something the canvas holds thousands of to a class on the canvas ROOT. Every change of that class restyles every card and every edge group in the document; put the state on the element being styled, the way render.ts already writes flg-quiet, flg-node-dim, flg-link-ok and flg-link-source.',
    ).toEqual([])
  })

  it('catches a root state class nobody has invented yet, prefixed or not', () => {
    // The evasion neither half of the named guard can see, and the reason this one is written
    // against a SHAPE. None of these three class names appears in render.ts or in graph.css; two
    // of them do not exist at all. All three are the same whole-document invalidation, and the
    // rule has to reject them without ever having been told their names.
    const invented =
      '.flg-is-connecting .flg-node { opacity: 0.5; }\n' +
      '.flg-graph.flg-rehearsing .flg-node-head { color: red; }\n' +
      '.flg-auditioning .flg-chip-label { display: none; }\n'
    expect(rootScopedDescendants(invented)).toHaveLength(3)
    // And the two shapes that must keep passing: a scope inside one card, and the camera's zoom
    // band, which is an attribute precisely because it is not a state under the user's hand.
    const fine =
      '.flg-node.flg-selected .flg-node-head { color: red; }\n' +
      ".flg-graph[data-zoom-band='far'] .flg-node-body { display: none; }\n" +
      '.flg-node .flg-node-id { font-weight: 600; }\n'
    expect(rootScopedDescendants(fine)).toEqual([])
  })

  it('reads the state classes it guards out of render.ts, including the ones nobody listed', () => {
    // THE GUARD ABOVE IS ONLY WORTH WHAT ITS INPUT IS WORTH, so the input is asserted directly.
    // The version this replaces paired a shape regex with six names typed by hand, and by the
    // time anybody looked, `flg-has-multi` and `flg-marqueeing` were both being toggled on the
    // root and neither was in the list -- the guard was reporting a clean sheet about two classes
    // it had never heard of.
    const derived = rootStateClasses()
    for (const name of ['flg-has-focus', 'flg-has-highlight', 'flg-has-multi', 'flg-linking', 'flg-linking-armed', 'flg-marqueeing', 'flg-quiet', 'flg-node-dim']) {
      expect(derived, `${name} is toggled at runtime and the guard did not find it`).toContain(name)
    }
    // A `toggle`'s condition can be a string, and a string is not a class.
    expect(derived.every((name) => name.startsWith('flg-'))).toBe(true)
  })

  it('rejects a root state class used as an ancestor WITHOUT the .flg-graph prefix', () => {
    // The evasion the shape regex could not see. `.flg-linking .flg-node { ... }` is the same
    // whole-document invalidation as `.flg-graph.flg-linking .flg-node { ... }` -- the prefix is
    // not what makes it expensive, and a rule written the short way passed both halves of the old
    // guard. Exercised against a synthetic sheet, because the real one is (and must stay) clean.
    const offending = '.flg-linking .flg-node { opacity: 0.5; }\n.flg-marqueeing .flg-chip { display: none; }\n'
    const names = rootStateClasses()
    const caught: string[] = []
    for (const selector of selectorsOf(stripComments(offending))) {
      const compounds = selector.split(/\s+|(?=>)|(?<=>)/).filter((part) => part !== '' && !'>+~'.includes(part))
      for (const [index, compound] of compounds.entries()) {
        if (index === compounds.length - 1) continue
        for (const name of names) if (compound.includes(name)) caught.push(selector)
      }
    }
    expect(caught).toHaveLength(2)
  })

  it('quieting is no deeper than 0.6, and shallower again for anyone who asked for contrast', () => {
    const quiet = /\.flg-node\.flg-quiet\s*\{\s*opacity:\s*([\d.]+)/g
    const values = [...css.matchAll(quiet)].map((m) => Number(m[1]))
    expect(values.length).toBeGreaterThanOrEqual(2)
    // The base value, and every override of it, is at least 0.6; nothing in the file re-deepens
    // it. (Measured as a real ratio in the browser section below; this is the flat guarantee.)
    for (const value of values) expect(value).toBeGreaterThanOrEqual(0.6)
  })

  it('the three notice levels differ by something other than a hue', () => {
    const rule = (name: string): string => new RegExp(`\\.flg-notice-${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    const info = rule('info')
    const warning = rule('warning')
    const error = rule('error')
    // Strip the colours; what is left has to differ, or the levels are a hue and nothing else.
    const shape = (body: string): string =>
      body
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d !== '' && !d.includes('color'))
        .sort()
        .join(';')
    expect(shape(info)).not.toBe(shape(warning))
    expect(shape(warning)).not.toBe(shape(error))
    expect(shape(info)).not.toBe(shape(error))
  })
})

// ---------------------------------------------------------------------------
// The real page
// ---------------------------------------------------------------------------

/** The script the page loads: webview/graph.ts, bundled exactly as esbuild.config.mjs bundles it
 * for `dist/graph.js`, with the one thing a browser outside VS Code cannot provide -- the
 * `acquireVsCodeApi` handle -- prepended as a recorder. Nothing else is stubbed: the module's own
 * top-level work, its message switch and every builder in it are the shipped ones. */
async function bundleWebview(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [webviewPath],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling webview/graph.ts')
  return (
    `globalThis.__posted = [];\n` +
    `globalThis.acquireVsCodeApi = () => ({\n` +
    `  postMessage: (m) => { globalThis.__posted.push(m) },\n` +
    `  getState: () => undefined,\n` +
    `  setState: () => undefined,\n` +
    `});\n` +
    output.text
  )
}

function themeStylesheet(vars: Record<string, string>): string {
  return `:root {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`
}

/** What the page is asked for: raw strings, and nothing else.
 *
 * The compositing is done in node, by `flatten` below, against the same `parseColour`/`over`
 * this file already pins against four known answers. An earlier version did the arithmetic
 * inside the page and was wrong in a way that is worth recording: a browser returns
 * `color(srgb ...)` for anything that went through `color-mix()`, a parser that only knows
 * `rgb()` returns NaN for it, and NaN propagates silently through a compositor into a ratio
 * that merely looks odd. Arithmetic that is not tested does not belong in a string. */
const READ_STACK = `(selector) => {
  const el = typeof selector === 'string' ? document.querySelector(selector) : selector
  if (el === null) return null
  const style = getComputedStyle(el)
  const stack = []
  for (let n = el; n !== null; n = n.parentElement) {
    const s = getComputedStyle(n)
    stack.push({ background: s.backgroundColor, opacity: s.opacity })
  }
  return {
    colour: style.color,
    // Root first, which is the order the compositor paints in.
    stack: stack.reverse(),
    text: el.textContent,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
  }
}`

interface Stack {
  colour: string
  stack: { background: string; opacity: string }[]
  text: string
  fontSize: string
  fontWeight: string
}

/** The two colours an element is really seen as: its text, and what is really behind it.
 *
 * Walks the ancestor stack from the document root DOWNWARD, compositing each background onto
 * the one behind it and multiplying in every `opacity` on the way, then composites the
 * element's own text colour onto the result. That is what a compositor does, and it is the only
 * way a reading survives `opacity: 0.6` on a card or a `99` alpha byte on a theme colour. */
function flatten(read: Stack): { foreground: Rgba; background: Rgba } {
  let background: Rgba = [255, 255, 255, 1]
  let alpha = 1
  for (const layer of read.stack) {
    const layerOpacity = Number(layer.opacity)
    alpha *= Number.isFinite(layerOpacity) ? layerOpacity : 1
    const bg = parseColour(layer.background)
    if (bg[3] > 0) background = over(bg, background, bg[3] * alpha)
  }
  const fg = parseColour(read.colour)
  return { foreground: over(fg, background, fg[3] * alpha), background }
}

interface Measured {
  foreground: Rgba
  background: Rgba
  text: string
  fontSize: string
  fontWeight: string
}

function measured(read: Stack): Measured {
  return { ...flatten(read), text: read.text, fontSize: read.fontSize, fontWeight: read.fontWeight }
}

/** Generous, and deliberately so: each test here boots a whole panel -- a bundle, a Chromium
 * page, the real shell, a theme stylesheet and a 57-node graph -- and a tight timeout on that
 * buys nothing but flakes. */
const PANEL_TIMEOUT_MS = 60_000

describe('the graph panel in real Chromium, under its real CSP, in both default themes', { timeout: PANEL_TIMEOUT_MS }, () => {
  let browser: Browser
  let server: { port: number; close: () => void }

  beforeAll(async () => {
    const script = await bundleWebview()
    const css = readFileSync(cssPath, 'utf-8')
    // The REAL shell, from the real generator, with the real CSP in it. A hand-written page here
    // would be the one thing this file must not be: a document that differs from the shipped one.
    const { renderGraphShellHtml } = await import('../src/graphPanel.js')
    const httpServer = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/graph.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(script)
        return
      }
      if (url === '/graph.css') {
        res.setHeader('Content-Type', 'text/css')
        res.end(css)
        return
      }
      if (url.startsWith('/theme-')) {
        res.setHeader('Content-Type', 'text/css')
        res.end(themeStylesheet(url === '/theme-light.css' ? LIGHT_MODERN : DARK_MODERN))
        return
      }
      const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
      res.setHeader('Content-Type', 'text/html')
      res.end(
        renderGraphShellHtml({
          nonce: 'testnonce',
          cspSource: origin,
          scriptUri: '/graph.js',
          styleUri: '/graph.css',
          packLabel: 'fixture',
        }),
      )
    })
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  /** A booted panel: the real shell, the real script, a theme served as a stylesheet from the
   * same origin (through the CSP, not around it), and the fixture pack's real graph in it. */
  async function open(theme: 'dark' | 'light', options: { contrast?: 'more' } = {}): Promise<Page> {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      colorScheme: theme === 'light' ? 'light' : 'dark',
      ...(options.contrast === 'more' ? { contrast: 'more' as const } : {}),
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.evaluate((href) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      document.head.append(link)
    }, `/theme-${theme}.css`)
    await page.waitForFunction(() => document.getElementById('flg-toolbar')?.children.length ?? 0 > 0, undefined, {
      timeout: 15_000,
    })
    const graph = JSON.parse(readFileSync(path.join(here, 'fixtures', 'graph-sample.json'), 'utf-8')) as unknown
    const types = JSON.parse(readFileSync(path.join(here, 'fixtures', 'types-sample.json'), 'utf-8')) as {
      types?: unknown[]
    }
    const coverage = types.types ?? []
    expect(coverage.length, 'the coverage table is empty, so the create menu can never open').toBeGreaterThan(0)
    await page.evaluate(
      ({ wire, rows }) => {
        window.postMessage({ type: 'types', coverage: rows }, '*')
        window.postMessage({ type: 'graph', graph: wire }, '*')
      },
      { wire: graph, rows: coverage },
    )
    await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 15_000 })
    expect(errors, `the panel threw while booting: ${errors.join(' | ')}`).toEqual([])
    return page
  }

  async function measure(page: Page, selector: string): Promise<Measured> {
    const result = (await page.evaluate(`(${READ_STACK})(${JSON.stringify(selector)})`)) as Stack | null
    expect(result, `nothing matched ${selector}`).not.toBeNull()
    return measured(result!)
  }

  async function ratio(page: Page, selector: string): Promise<number> {
    const m = await measure(page, selector)
    return contrast(m.foreground, m.background)
  }

  // -- 1. the status line ---------------------------------------------------

  describe('the status line', () => {
    for (const [name, vars] of THEMES) {
      it(`says "Error" in words and in a stripe, and is not the info colour, in ${name}`, async () => {
        const page = await open(vars === LIGHT_MODERN ? 'light' : 'dark')
        try {
          // The info state first: a graph has just arrived, so the line already carries the
          // camera's own sentence about what is on screen.
          const info = await page.evaluate(() => {
            const el = document.getElementById('flg-status')!
            return { text: el.textContent ?? '', className: el.className }
          })
          expect(info.className).not.toContain('flg-status-error')
          expect(info.text).not.toContain('Error')
          const infoStyle = await page.evaluate(() => {
            const s = getComputedStyle(document.getElementById('flg-status')!)
            return { colour: s.color, width: s.borderLeftWidth, weight: s.fontWeight }
          })

          // The one host message that produces an error line with nothing else changing.
          await page.evaluate(() => {
            window.postMessage({ type: 'editError', message: 'the engine refused this pack' }, '*')
          })
          await page.waitForFunction(() =>
            (document.getElementById('flg-status')?.className ?? '').includes('flg-status-error'),
          )
          const error = await page.evaluate(() => {
            const el = document.getElementById('flg-status')!
            return { text: el.textContent ?? '', className: el.className }
          })

          // THE WORD. Colour is never the only carrier: the level is in the sentence.
          expect(error.text.startsWith('Error: ')).toBe(true)
          expect(error.text).toContain('the engine refused this pack')

          // THE SELECTOR. `.flg-status-error` used to lose to `#flg-status`, so this rendered
          // pixel-identical to the info line. Something measurable has to differ now.
          const stripe = await page.evaluate(() => {
            const s = getComputedStyle(document.getElementById('flg-status')!)
            return { width: s.borderLeftWidth, colour: s.borderLeftColor, weight: s.fontWeight }
          })
          expect(Number.parseFloat(stripe.width)).toBeGreaterThanOrEqual(3)
          expect(Number.parseFloat(stripe.width)).toBeGreaterThan(Number.parseFloat(infoStyle.width))
          expect(stripe.weight).not.toBe(infoStyle.weight)
          const stripeColour = parseColour(stripe.colour)
          const bar = (await measure(page, '#flg-status')).background
          expect(contrast(stripeColour, bar)).toBeGreaterThanOrEqual(AA_NON_TEXT)
        } finally {
          await page.close()
        }
      })

      it(`sets its sentence at 4.5:1 or better in ${name}`, async () => {
        const page = await open(vars === LIGHT_MODERN ? 'light' : 'dark')
        try {
          await page.evaluate(() => {
            window.postMessage({ type: 'editError', message: 'refused' }, '*')
          })
          await page.waitForFunction(() => (document.getElementById('flg-status')?.textContent ?? '') !== '')
          expect(await ratio(page, '#flg-status')).toBeGreaterThanOrEqual(AA)
        } finally {
          await page.close()
        }
      })
    }
  })

  // -- 2. body text ---------------------------------------------------------

  describe('body text', () => {
    /** Everything the audit measured at less than 4.5:1, by the selector it is drawn with. The
     * list is the finding, turned into a fixture: each of these was between 2.67 and 4.07. */
    const BODY_TEXT: readonly [what: string, selector: string][] = [
      ['the status line', '#flg-status'],
      ['a card type line', '.flg-node .flg-node-type'],
      ['a card meta row', '.flg-node .flg-node-meta'],
      ['the overview section labels', '.flg-section'],
      ['the overview prose', '.flg-hint'],
      ['the history label', '.flg-history-label'],
      ['the toolbar label', '#flg-toolbar .flg-add'],
      // A SECOND ROUND, measured off rendered pixels rather than off tokens. Each of these was
      // set in a colour chosen for something other than reading: the card's fan-out count and the
      // sequence chip's ordinal in the host's CHART hues (3.68:1 and 3.22:1 in Light Modern,
      // where `charts-blue` is #1a85ff and `charts-orange` sits on an orange-tinted chip), and
      // the legend button in `descriptionForeground` WITH an `opacity: 0.8` multiplied on top of
      // it (4.45 dark, 2.91 light). The minimap's collapse control was the worst of them at
      // 1.63/1.43, from a fade applied to the whole widget rather than to the map inside it --
      // the one control whose entire job is to be findable by somebody who wants the map gone.
      ['a card fan-out count', '.flg-node .flg-node-fan-out'],
      ['an edge chip label', '.flg-chip-sequence .flg-chip-label'],
      ['the legend button', '.flg-legend-button'],
      ['the minimap collapse control', '.flg-minimap-toggle'],
    ]

    for (const [name, vars] of THEMES) {
      for (const [what, selector] of BODY_TEXT) {
        it(`${what} clears 4.5:1 in ${name}`, async () => {
          const page = await open(vars === LIGHT_MODERN ? 'light' : 'dark')
          try {
            await page.evaluate(() => {
              window.postMessage({ type: 'editError', message: 'refused' }, '*')
            })
            const found = await page.$(selector)
            expect(found, `${selector} is not on the page`).not.toBeNull()
            expect(await ratio(page, selector)).toBeGreaterThanOrEqual(AA)
          } finally {
            await page.close()
          }
        })
      }

      it(`the disabled Undo is readable and still reachable by keyboard in ${name}`, async () => {
        const page = await open(vars === LIGHT_MODERN ? 'light' : 'dark')
        try {
          const undo = '#flg-history .flg-history-undo'
          const state = await page.evaluate((sel) => {
            const el = document.querySelector<HTMLButtonElement>(sel)!
            return { aria: el.getAttribute('aria-disabled'), disabled: el.disabled, tabIndex: el.tabIndex }
          }, undo)
          // With nothing written yet there is nothing to undo, which is the state the audit
          // found: 2.67:1 in Light Modern and out of the tab order entirely.
          expect(state.aria).toBe('true')
          expect(state.disabled).toBe(false)
          expect(state.tabIndex).toBeGreaterThanOrEqual(0)
          expect(await ratio(page, undo)).toBeGreaterThanOrEqual(AA)
        } finally {
          await page.close()
        }
      })
    }
  })

  // -- 3. quieting ----------------------------------------------------------

  describe('selecting one card', () => {
    // WHAT A FADE CAN AND CANNOT BE HELD TO.
    //
    // A quieted card is still content, and no fade reaches 4.5:1: at any opacity a over a light
    // theme the text and the card's own background converge on the canvas behind them, so the
    // ceiling falls with a. That is a property of the technique, not of these numbers -- which
    // is precisely why the technique has to be measured rather than trusted. What IS a defect is
    // where it stood: 1.89:1 in Dark Modern and 1.45:1 in Light Modern, on an ordinary click,
    // over 34 of the fixture's 57 cards. Below about 1.5:1 a line of 11px text is not faint, it
    // is gone.
    //
    // So this suite holds the fade to two things it can actually be held to: it must be a
    // measured, large improvement on what 0.35 gave in the very same page, and a reader whose
    // platform says they want more contrast must get something that clears the 3:1 floor.
    for (const [name, vars] of THEMES) {
      it(`is a large, measured improvement on what 0.35 gave in ${name}`, async () => {
        const page = await open(vars === LIGHT_MODERN ? 'light' : 'dark')
        try {
          const quieted = await selectAndCountQuiet(page)
          expect(quieted, 'selecting a card did not quiet anything, so this measures nothing').toBeGreaterThan(10)
          const now = await worstQuietRatio(page)
          // The same cards, the same theme, the same measurement -- at the opacity this used to
          // ship with. Nothing is hard-coded: the "before" is re-measured here.
          const before = await worstQuietRatio(page, 0.35)
          // What 0.35 gave: 1.99:1 in Dark Modern, 1.61:1 in Light Modern, measured here rather
          // than quoted. Either way it is under the 3:1 floor by a wide margin.
          expect(before).toBeLessThan(2.1)
          expect(now / before).toBeGreaterThan(1.5)
          // And a floor in absolute terms, which 0.6 clears in both themes.
          expect(now).toBeGreaterThanOrEqual(2.4)
        } finally {
          await page.close()
        }
      })

      it(`clears 3:1 for a reader who asked their platform for more contrast, in ${name}`, async () => {
        const page = await open(vars === LIGHT_MODERN ? 'light' : 'dark', { contrast: 'more' })
        try {
          await selectAndCountQuiet(page)
          const opacity = await page.evaluate(
            () => getComputedStyle(document.querySelector('.flg-node.flg-quiet')!).opacity,
          )
          expect(Number(opacity)).toBeGreaterThanOrEqual(0.85)
          expect(await worstQuietRatio(page)).toBeGreaterThanOrEqual(AA_NON_TEXT)
        } finally {
          await page.close()
        }
      })
    }

    it('still quiets: a selected card and its neighbours stay at full strength', async () => {
      const page = await open('dark')
      try {
        await selectAndCountQuiet(page)
        const lit = await page.evaluate(
          () => getComputedStyle(document.querySelector('.flg-node.flg-node-focus')!).opacity,
        )
        const dim = await page.evaluate(
          () => getComputedStyle(document.querySelector('.flg-node.flg-quiet')!).opacity,
        )
        expect(Number(lit)).toBe(1)
        expect(Number(dim)).toBeLessThan(1)
      } finally {
        await page.close()
      }
    })

    /** Clicks a card and reports how many others went quiet.
     *
     * A REAL click, through Playwright, on a card the camera is actually showing. Quieting is
     * deliberately conditional on the selected card being on screen (see paintIncidence): pan
     * away from a selection and the canvas would dim with nothing to contrast against. A
     * synthetic `MouseEvent` on whatever card happens to be first in the document is therefore
     * not a selection this panel acts on. */
    async function selectAndCountQuiet(page: Page): Promise<number> {
      await page.evaluate(() => (window as never as { __flgView: { zoomToFit(): void } }).__flgView.zoomToFit())
      const card = page.locator('.flg-node').first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      await card.click({ timeout: 10_000 })
      // AND WAITS FOR THE FADE TO LAND. The class arrives at once; the opacity does not -- the
      // canvas puts a 120ms transition on it so a selection reads as the canvas quieting rather
      // than flickering. Reading `getComputedStyle().opacity` the instant the class appears
      // gets a number somewhere on the way down, which is not what anybody looks at and is not
      // what this suite is measuring.
      await page.waitForFunction(
        () => {
          const quiet = document.querySelector('.flg-node.flg-quiet')
          return quiet !== null && Number(getComputedStyle(quiet).opacity) < 0.99
        },
        undefined,
        { timeout: 10_000 },
      )
      return page.evaluate(() => document.querySelectorAll('.flg-node.flg-quiet').length)
    }

    /** The worst reading over every quieted card's own type line.
     *
     * `at` overrides the opacity inline before measuring and puts it back afterwards, which is
     * how the "what 0.35 used to give" reading above is taken from the same cards in the same
     * theme rather than from a number somebody wrote down. */
    async function worstQuietRatio(page: Page, at?: number): Promise<number> {
      const readings = (await page.evaluate(`
        (() => {
          const cards = [...document.querySelectorAll('.flg-node.flg-quiet')]
          const at = ${at === undefined ? 'null' : String(at)}
          // The transition is suppressed along with the override, so the reading is of the
          // value asked for rather than of a frame on the way to it.
          if (at !== null) for (const card of cards) { card.style.transition = 'none'; card.style.opacity = String(at) }
          const read = ${READ_STACK}
          const out = cards.map((card) => read(card.querySelector('.flg-node-type'))).filter((m) => m !== null)
          if (at !== null) for (const card of cards) { card.style.opacity = ''; card.style.transition = '' }
          return out
        })()
      `)) as Stack[]
      expect(readings.length).toBeGreaterThan(0)
      return Math.min(...readings.map((read) => {
        const m = flatten(read)
        return contrast(m.foreground, m.background)
      }))
    }
  })

  // -- 4. the create menu ---------------------------------------------------

  describe('the create menu', () => {
    it('says it opens a dialog, and says when one is open', async () => {
      const page = await open('dark')
      try {
        const add = '#flg-toolbar .flg-add'
        expect(await page.getAttribute(add, 'aria-haspopup')).toBe('dialog')
        expect(await page.getAttribute(add, 'aria-expanded')).toBe('false')
        await page.click(add)
        await page.waitForSelector('.flp-menu:not([hidden])')
        expect(await page.getAttribute(add, 'aria-expanded')).toBe('true')
        expect(await page.getAttribute('.flp-menu', 'aria-modal')).toBe('true')
        expect(await page.getAttribute('.flp-menu', 'role')).toBe('dialog')
        await page.keyboard.press('Escape')
        await page.waitForSelector('.flp-menu', { state: 'hidden' })
        expect(await page.getAttribute(add, 'aria-expanded')).toBe('false')
      } finally {
        await page.close()
      }
    })

    it('keeps Tab inside it however many times it is pressed', async () => {
      const page = await open('dark')
      try {
        await page.click('#flg-toolbar .flg-add')
        await page.waitForSelector('.flp-menu:not([hidden])')
        // Two Tabs used to be enough to reach <body> and then the toolbar behind the dialog.
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press('Tab')
          const inside = await page.evaluate(
            () => document.querySelector('.flp-menu')?.contains(document.activeElement) ?? false,
          )
          expect(inside, `Tab number ${i + 1} escaped the dialog`).toBe(true)
        }
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press('Shift+Tab')
          const inside = await page.evaluate(
            () => document.querySelector('.flp-menu')?.contains(document.activeElement) ?? false,
          )
          expect(inside, `Shift+Tab number ${i + 1} escaped the dialog`).toBe(true)
        }
      } finally {
        await page.close()
      }
    })

    it('Escape still closes it after focus has been moved off the filter box', async () => {
      const page = await open('dark')
      try {
        await page.click('#flg-toolbar .flg-add')
        await page.waitForSelector('.flp-menu:not([hidden])')
        // Deliberately put focus somewhere the menu's own handler never hears about, the way a
        // stray click or an assistive technology's focus call would.
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('#flg-toolbar .flg-add')!.focus()
        })
        await page.keyboard.press('Escape')
        await page.waitForSelector('.flp-menu', { state: 'hidden', timeout: 5_000 })
      } finally {
        await page.close()
      }
    })

    it('gives the keyboard back to the button that opened it', async () => {
      const page = await open('dark')
      try {
        await page.focus('#flg-toolbar .flg-add')
        await page.keyboard.press('Enter')
        await page.waitForSelector('.flp-menu:not([hidden])')
        await page.keyboard.press('Escape')
        await page.waitForSelector('.flp-menu', { state: 'hidden' })
        const focused = await page.evaluate(() => document.activeElement?.className ?? '')
        expect(focused).toContain('flg-add')
      } finally {
        await page.close()
      }
    })
  })

  // -- 6. lists that say what they are --------------------------------------

  describe('the overview lists', () => {
    it('name themselves and say what each row will do', async () => {
      const page = await open('dark')
      try {
        const lists = await page.evaluate(() =>
          [...document.querySelectorAll('#flg-side [role="list"]')].map((list) => ({
            name: list.getAttribute('aria-label') ?? '',
            items: list.querySelectorAll('[role="listitem"]').length,
            rows: [...list.querySelectorAll('button')].map((b) => ({
              face: b.textContent ?? '',
              name: b.getAttribute('aria-label') ?? '',
            })),
          })),
        )
        expect(lists.length).toBeGreaterThan(0)
        for (const list of lists) {
          expect(list.name, 'a list with no name').not.toBe('')
          // A `role="list"` whose children are not listitems is a list of nothing.
          expect(list.items).toBe(list.rows.length)
          for (const row of list.rows) {
            expect(row.name).not.toBe('')
            // WCAG 2.5.3: what is written on it has to be the start of what it is called, or
            // "click the one that says X" stops working.
            expect(row.name.startsWith(row.face), `${row.name} does not begin with ${row.face}`).toBe(true)
            // And it has to say what pressing it is FOR, not just repeat the identifier.
            expect(row.name.length).toBeGreaterThan(row.face.length + 4)
          }
        }
      } finally {
        await page.close()
      }
    })

    it('lays out exactly as it did before the wrappers existed', async () => {
      const page = await open('dark')
      try {
        // `display: contents` or the roots turn into a nested column of default-width blocks.
        const same = await page.evaluate(() => {
          const item = document.querySelector<HTMLElement>('#flg-side [role="listitem"]')
          const button = item?.querySelector<HTMLElement>('.flg-jump')
          const column = document.querySelector<HTMLElement>('.flg-overview')
          if (!item || !button || !column) return null
          return {
            wrapper: getComputedStyle(item).display,
            buttonWidth: Math.round(button.getBoundingClientRect().width),
            columnWidth: Math.round(column.getBoundingClientRect().width),
          }
        })
        expect(same?.wrapper).toBe('contents')
        expect(same?.buttonWidth).toBe(same?.columnWidth)
      } finally {
        await page.close()
      }
    })
  })

  // -- 8. undo and redo -----------------------------------------------------

  describe('undo and redo', () => {
    it('announce what they would do, and announce the flip when it changes', async () => {
      const page = await open('dark')
      try {
        const before = await page.evaluate(() => {
          const label = document.getElementById('flg-history-label')!
          const undo = document.querySelector<HTMLButtonElement>('.flg-history-undo')!
          const redo = document.querySelector<HTMLButtonElement>('.flg-history-redo')!
          return {
            live: label.getAttribute('aria-live'),
            text: label.textContent,
            undoDescribes: undo.getAttribute('aria-describedby'),
            redoDescribes: redo.getAttribute('aria-describedby'),
            redoDisabled: redo.disabled,
            redoAria: redo.getAttribute('aria-disabled'),
          }
        })
        expect(before.live).toBe('polite')
        expect(before.text).toBe('Nothing to undo')
        expect(before.undoDescribes).toBe('flg-history-label')
        expect(before.redoDescribes).toBe('flg-history-label')
        // `disabled` took Redo out of the tab order; `aria-disabled` says the same thing and
        // leaves it findable.
        expect(before.redoDisabled).toBe(false)
        expect(before.redoAria).toBe('true')

        // The host says what the history now holds. The element carrying `aria-live` has to be
        // the SAME element afterwards, or the change is not a change to a live region and is
        // never announced.
        const identity = await page.evaluate(() => {
          const el = document.getElementById('flg-history-label')!
          ;(window as never as { __label: Element }).__label = el
          window.postMessage({ type: 'history', undo: 'distribution.x: 3', redo: null }, '*')
          return true
        })
        expect(identity).toBe(true)
        await page.waitForFunction(
          () => document.getElementById('flg-history-label')?.textContent === 'distribution.x: 3',
          undefined,
          { timeout: 5_000 },
        )
        const after = await page.evaluate(() => ({
          same: (window as never as { __label: Element }).__label === document.getElementById('flg-history-label'),
          undoAria: document.querySelector('.flg-history-undo')!.getAttribute('aria-disabled'),
          undoTitle: document.querySelector('.flg-history-undo')!.getAttribute('title'),
        }))
        expect(after.same, 'the live region was replaced, so nothing would be announced').toBe(true)
        expect(after.undoAria).toBeNull()
        expect(after.undoTitle).toContain('distribution.x: 3')
      } finally {
        await page.close()
      }
    })

    it('refuses the click while it is unavailable, rather than merely looking unavailable', async () => {
      const page = await open('dark')
      try {
        // Dispatched rather than clicked through Playwright, which treats `aria-disabled` as
        // disabled and would wait forever for the control this test is about.
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('.flg-history-redo')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
        const asked = await page.evaluate(
          () => ((globalThis as never as { __posted: { type: string }[] }).__posted ?? []).filter((m) => m.type === 'redo').length,
        )
        expect(asked).toBe(0)
      } finally {
        await page.close()
      }
    })
  })
})
