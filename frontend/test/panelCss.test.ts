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
