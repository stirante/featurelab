// panelCss.test.ts -- guards against a panel.css contrast bug:
// button.fl-diag-position's text colour was accidentally set to var(--fl-focus-border), a
// BORDER token with no text-contrast guarantee (VS Code only promises focusBorder looks sane as
// a 1px outline) -- several real themes ship a dark/desaturated focusBorder, which made the
// button's own "⌖ (x, y, z)" label functionally invisible against the diagnostic's tinted
// background. Parses the raw stylesheet text rather than rendering it, so this catches a future
// regression (or the same copy-paste mistake landing in a new rule -- see this file's second
// test, the "audit the rest of panel.css" half of that task) without needing a browser/computed-
// style environment.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS_PATH = fileURLToPath(new URL('../src/ui/panel.css', import.meta.url))
const css = readFileSync(CSS_PATH, 'utf8')
const FORCED = '@media (forced-colors: active)'

describe('panel.css: no border token used as a text colour', () => {
  it('button.fl-diag-position paints its text with a foreground/link token, not a border token', () => {
    const ruleMatch = css.match(/button\.fl-diag-position\s*\{([^}]*)\}/)
    expect(ruleMatch).not.toBeNull()
    const body = ruleMatch![1]!
    // Negative lookbehind excludes `background-color:`/`border-color:` (this rule has neither,
    // but the check should stay correct if one is ever added) -- only a plain `color:` counts.
    const colorDecl = body.match(/(?<![-\w])color:\s*([^;]+);/)
    expect(colorDecl).not.toBeNull()
    expect(colorDecl![1]).not.toMatch(/border/i)
    expect(colorDecl![1]).toContain('--fl-link-fg')
  })

  it('no rule anywhere in the file sets a plain `color:` to a variable with "border" in its name', () => {
    // Broad audit, not just the one known offender -- the rest of panel.css is checked
    // for the same mistake. A border/focus token is fine for
    // border-color/outline/background (plenty of legitimate uses below) -- only `color:` (actual
    // text paint) is being checked here.
    const colorDecls = [...css.matchAll(/(?<![-\w])color:\s*([^;]+);/g)].map((m) => m[1]!)
    expect(colorDecls.length).toBeGreaterThan(0) // sanity: the file does have `color:` rules to check
    for (const decl of colorDecls) {
      expect(decl).not.toMatch(/--fl-[a-z-]*border/i)
    }
  })
})

// The three structural facts below are the ones a rendered check cannot state as a rule: the
// browser suite (apps/vscode/test/panelLayout.test.ts) measures the RESULT in both token sets
// and in forced colors, which is what proves the numbers; this file states the mechanism, so a
// future edit that reintroduces the same shape fails here with the reason attached.

describe('panel.css: the light-mode block is a fallback, not an override', () => {
  /** The body of `@media (prefers-color-scheme: light) { ... }`, braces balanced. */
  function lightBlock(): string {
    const start = css.indexOf('@media (prefers-color-scheme: light)')
    expect(start).toBeGreaterThan(-1)
    const open = css.indexOf('{', start)
    let depth = 0
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (depth === 0) return css.slice(open + 1, i)
      }
    }
    throw new Error('unbalanced @media block')
  }

  // THE BUG: `--fl-bg: #ffffff` inside this block is a LATER declaration at the same
  // specificity, not a fallback -- custom properties do not fall through. Measured with
  // --vscode-sideBar-background: #f8f8f8 and --vscode-foreground: #3b3b3b set, .fl-panel still
  // computed rgb(255,255,255) / rgb(30,30,30): every light VS Code theme the user had chosen,
  // high-contrast ones included, was painted over with this one hardcoded palette. The block's
  // own comment asserted the opposite ("a real VS Code webview never reaches this block").
  it('declares every token through var(--vscode-*, literal), never as a bare literal', () => {
    const body = lightBlock()
    const declarations = [...body.matchAll(/(--fl-[a-z-]+)\s*:\s*([^;]+);/g)]
    expect(declarations.length).toBeGreaterThan(10) // sanity: the block does declare tokens
    for (const [, name, value] of declarations) {
      expect(value!.trim(), `${name!} in the light block`).toMatch(/^var\(--vscode-/)
    }
  })

  it('still supplies a light literal for a host that has no --vscode-* at all', () => {
    // The one thing this block is FOR (Wails, or the stylesheet loaded standalone): each
    // declaration's innermost fallback has to be the light value, not the dark one it would
    // otherwise inherit from the .fl-panel block above.
    const body = lightBlock()
    expect(body).toMatch(/--fl-fg:\s*var\(--vscode-foreground,\s*#1e1e1e\)/)
    expect(body).toMatch(/--fl-bg:\s*var\(--vscode-sideBar-background,\s*var\(--vscode-editor-background,\s*#ffffff\)\)/)
  })
})

describe('panel.css: a warning colour is not automatically a text colour', () => {
  // The same lesson panelCss's first suite records for focusBorder, one token later.
  // editorWarning.foreground's contract is a squiggle and a gutter icon; Light Modern ships
  // #bf8803, which is 3.12:1 as text on this panel's white (and 2.79:1 for the Diagnostics
  // section title on its own tinted head) while Dark Modern's identical token passes at 7.69:1.
  it('mixes a text-weight variant out of the raw token and the theme’s own foreground', () => {
    const decl = css.match(/--fl-warning-text-fg:\s*([^;]+);/)
    expect(decl).not.toBeNull()
    // Mixed toward --fl-fg, which is the one colour the theme guarantees is readable against
    // this background -- whichever direction "readable" happens to be in that theme.
    expect(decl![1]).toMatch(/color-mix\(in srgb,\s*var\(--fl-warning-fg\)\s*\d+%,\s*var\(--fl-fg\)\)/)
  })

  it('paints no text with the raw warning token', () => {
    // Backgrounds, borders and the notice's left rule may use it; `color:` may not. This is the
    // audit half -- the same shape as the --fl-*border check above, for the token that got the
    // lesson second.
    const colorDecls = [...css.matchAll(/(?<![-\w])color:\s*([^;]+);/g)].map((m) => m[1]!)
    const offenders = colorDecls.filter((decl) => /var\(--fl-warning-fg\)/.test(decl))
    expect(offenders).toEqual([])
  })

  it('quiets text by mixing toward the background, never with disabledForeground or opacity', () => {
    // --fl-input-disabled-fg is rgba(30,30,30,0.4) in Light Modern: .fl-stat-value's own figure
    // measured 2.46:1 light / 3.69:1 dark while the panel was still asking for it to be read.
    // The graph panel's --flg-fg-dim treatment (78% of the theme's fg into the theme's bg) is
    // 5.4:1 light / 6.7:1 dark, and follows a high-contrast theme instead of ignoring it.
    expect(css).toMatch(/--fl-fg-dim:\s*color-mix\(in srgb,\s*var\(--fl-fg\)\s*78%,\s*var\(--fl-bg\)\)/)
    expect(css).toMatch(/--fl-vp-fg-dim:\s*color-mix\(in srgb,\s*var\(--fl-vp-fg\)\s*78%,\s*var\(--fl-vp-bg\)\)/)
    const inertStat = css.match(/\.fl-stat\[aria-disabled='true'\]\s*\{([^}]*)\}/)
    expect(inertStat).not.toBeNull()
    expect(inertStat![1]).toMatch(/color:\s*var\(--fl-fg-dim\)/)
    // The overlay's quiet text no longer reaches past --fl-* to a --vscode-* muted token.
    const gizmoText = css.match(/\.fl-vp-scale,\s*\n\.fl-vp-hint,\s*\n\.fl-vp-keys\s*\{([^}]*)\}/)
    expect(gizmoText).not.toBeNull()
    expect(gizmoText![1]).toMatch(/color:\s*var\(--fl-vp-fg-dim\)/)
  })
})

describe('panel.css: forced colors keeps the on-states visible', () => {
  /** The body of the `@media (forced-colors: active)` block. */
  function forcedColorsBlock(): string {
    const start = css.indexOf('@media (forced-colors: active)')
    expect(start, 'panel.css has no forced-colors block').toBeGreaterThan(-1)
    const open = css.indexOf('{', start)
    let depth = 0
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (depth === 0) return css.slice(open + 1, i)
      }
    }
    throw new Error('unbalanced @media block')
  }

  // .fl-vp-btn-on's ONLY visible marker is `box-shadow: inset 0 -2px`, and box-shadow computes
  // to `none` under forced colors -- measured as `vpBtnOnBoxShadow: "none"`, with Grid, Textures
  // and Projection each looking identical on and off. aria-pressed survived; the picture did not.
  it('re-says every box-shadow-only marker in system colours', () => {
    const body = forcedColorsBlock()
    for (const marker of ['.fl-vp-btn-on', '.fl-stat-on', '.fl-diag-item.fl-diag-revealed']) {
      expect(body, `${marker} has no forced-colors treatment`).toContain(marker)
    }
    // Highlight/HighlightText/CanvasText are what forced colors honours from a stylesheet;
    // a --fl-* token there would simply be replaced.
    const onState = body.match(/\.fl-vp-btn-on\s*\{([^}]*)\}/)
    expect(onState).not.toBeNull()
    expect(onState![1]).toMatch(/background-color:\s*Highlight/)
    expect(onState![1]).not.toMatch(/var\(--fl-/)
  })
})

// ---------------------------------------------------------------------------------------------
// `opacity` IS NOT A TEXT COLOUR, which is the same lesson as the two above, one mechanism later.
// The rendered-pixel suites (apps/vscode/test/panelLayout.test.ts, test/viewport.test.ts) own the
// NUMBERS; this file owns the mechanism, so that an edit which reintroduces the shape fails here
// with the reason attached rather than only as a ratio in a browser run.
//
// Two properties of `opacity` made it the wrong tool, and both are invisible to a stylesheet
// reader:
//   - it COMPOSITES, so two quieting rules on one element multiply. `.fl-row-label` carried 0.85
//     and `.fl-row-inert > .fl-row-label` carried 0.45; the product painted an inert control's
//     own label at 2.40:1 in Light Modern.
//   - it is invisible to getComputedStyle().color, so the previous round of contrast work --
//     which resolved computed colours and composited them over ancestor backgrounds -- reported
//     `.fl-diag-type` and `.fl-diag-file` as passing at 5.06:1 while they painted 2.89:1 and
//     2.23:1.
describe('panel.css: quiet text is quieted with a colour, never with opacity', () => {
  /** Every rule in the file as (selector, body), with COMMENTS STRIPPED FIRST -- this file's
   * comments quote the very declarations being audited ("was `opacity: 0.85`"), so a parser that
   * keeps them reports the explanation as the offence. */
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const forcedStart = bare.includes(FORCED) ? bare.indexOf(FORCED) : bare.length
  function rulesFor(selector: string): string[] {
    return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m.index ?? 0) < forcedStart && m[1]!.split(',').some((s) => s.trim() === selector))
      .map((m) => m[2]!)
  }

  // The surfaces measured failing, plus the two general rules that were multiplying into them.
  // A `color:` where an `opacity:` used to be is the whole fix.
  for (const selector of ['.fl-diag-type', '.fl-diag-file', '.fl-diag-chain .fl-diag-chain-sep', '.fl-diag-empty', '.fl-row-label', '.fl-row-inert > .fl-row-label', '.fl-note']) {
    it(`${selector} states a colour and no opacity`, () => {
      // The forced-colors block is exempt throughout: there the system palette replaces every
      // colour this file could name, so `opacity` is the only dimming left that means anything.
      const bodies = rulesFor(selector)
      expect(bodies.length, `no rule for ${selector} outside forced-colors`).toBeGreaterThan(0)
      const combined = bodies.join(' ')
      expect(combined, `${selector} still dims with opacity`).not.toMatch(/(?<![-\w])opacity\s*:/)
      expect(combined, `${selector} names no text colour`).toMatch(/(?<![-\w])color\s*:/)
    })
  }

  it('gives a diagnostic row that already spends its contrast on hue no second dim', () => {
    // --fl-diag-quiet-fg resolves to currentColor on an error/warning row, and currentColor in a
    // `color:` declaration is the INHERITED colour -- i.e. the row's own. --fl-warning-text-fg
    // measures 5.06:1 on that row's tint in Light Modern, and 78% of it is 3.30:1.
    expect(bare).toMatch(/--fl-diag-quiet-fg:\s*var\(--fl-fg-dim\)/)
    const override = rulesFor('.fl-diag-item.fl-diag-warning')
    expect(override.length, 'no warning override for --fl-diag-quiet-fg').toBeGreaterThan(0)
    expect(override.join(' ')).toMatch(/--fl-diag-quiet-fg:\s*currentColor/)
    expect(rulesFor('.fl-diag-item.fl-diag-error').join(' ')).toMatch(/--fl-diag-quiet-fg:\s*currentColor/)
  })

  // The gizmo was the one block in the overlay column with no surface of its own, so its two
  // labels were measured against whatever the SCENE rendered -- 1.67:1 light / 1.43:1 dark over a
  // grass-green block. Every sibling in that column already paints --fl-vp-bg. The sweep, not
  // just the one offender: .fl-vp itself is deliberately transparent (it must not eat a drag
  // meant for the camera), so each text-bearing block in it states its own background.
  // apps/vscode/test/viewport.test.ts measures the result in both themes.
  for (const selector of ['.fl-vp-controls', '.fl-vp-notice', '.fl-vp-legend', '.fl-vp-pill', '.fl-vp-gizmo']) {
    it(`${selector} paints its own surface rather than the canvas behind it`, () => {
      const bodies = rulesFor(selector)
      expect(bodies.length, `no rule for ${selector}`).toBeGreaterThan(0)
      expect(bodies.join(' '), `${selector} paints no background`).toMatch(/background:\s*var\(--fl-vp-bg\)/)
    })
  }
})
