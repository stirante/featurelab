// molangEdge.test.ts -- editing the Molang that lives ON AN EDGE, by clicking the edge.
//
// THE BUG THIS EXISTS FOR. src/graph/molangEdge.ts is a complete editor for exactly this: a
// scatter's `iterations` and a conditional_list entry's `condition` (wire.GraphEdge.Iterations /
// .Condition). Seven hundred lines, thirty-seven passing tests, a documented change contract,
// offline diagnostics, idiom detection, one-click templates. It shipped imported by NOTHING in
// webview/graph.ts. There was no click path to it anywhere in the product: the user clicked the
// edge, the edge highlighted, a tooltip on the chip told them what the expression was, and the
// side panel showed them the pack OVERVIEW -- the identical panel shown when nothing is selected.
// They could not change the expression from the editor at all.
//
// WHY NOTHING CAUGHT IT. graphMolang.test.ts bundles molangEdge.ts and drives the controller
// directly. It is a good suite and it was all green throughout. It cannot fail for the reason
// this one would, because it never asks whether anything CALLS the module. No test in this repo
// did, before reachability.test.ts -- read that file's header, it is the general form of this
// bug and this is its first instance.
//
// These journeys were written against the promise while the editor did not keep it, and were red
// for it. The wiring landed (webview/graph.ts's edgePanel) and they went green without being
// changed, which is the only kind of evidence that a test was about the product and not about
// the shape of the code that happened to be there. They stay as the regression guard.
//
// HOW THIS IS WRITTEN, and why it mattered more here than anywhere else. When these were written
// the control that now holds the expression did not exist, so there was no id, class or
// structure to aim at -- and inventing one would have been worse than useless: it would have
// pinned whatever the test's author guessed, gone red on a rename, and gone GREEN on a control
// that was present but disabled. So every assertion is behavioural:
//
//   - "an editable element whose value contains the expression" -- found by BEING editable
//     (harness.editables), not by a selector;
//   - "typing into it changes the file on disk" -- the outcome, not a posted message.
//
// The control turned out to be a <textarea>, which no selector written in advance would have
// guessed, and these passed on it unmodified. Keep it that way: do not replace the searches
// below with the class names the current implementation happens to use.
import * as fs from 'node:fs'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeStub.js'))

import { closeSharedBrowser, openJourney, JOURNEY_TIMEOUT_MS, type Editable, type Journey } from './harness.js'

const open: Journey[] = []

async function journey(...args: Parameters<typeof openJourney>): Promise<Journey> {
  const started = await openJourney(...args)
  open.push(started)
  return started
}

afterEach(async () => {
  for (const j of open.splice(0)) await j.dispose()
})

afterAll(async () => {
  await closeSharedBrowser()
})

// -- the edge under test ----------------------------------------------------
//
// A scatter and the feature it places, which is the commonest edge in any pack. The fixture
// pack's scatters all carry a bare number, and a bare number is the ONE case a spin-box could
// have covered -- so the pack is prepared with a real expression instead, because the whole
// argument for molangEdge.ts is the cases a spin-box cannot express. See that file's header.
const SCATTER = 'wiki:pumpkin_patch'
const SCATTER_FILE = 'features/scatter_pumpkin_patch.json'
const SCATTER_EDGE = '$.minecraft:scatter_feature.places_feature'
const ITERATIONS = 'math.random_integer(3, 9)'

function withIterations(expression: string) {
  return (packRoot: string): void => {
    const file = `${packRoot}/${SCATTER_FILE}`
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      'minecraft:scatter_feature': { distribution: Record<string, unknown> }
    }
    json['minecraft:scatter_feature'].distribution['iterations'] = expression
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8')
  }
}

// A conditional_list entry and its `condition`, the other field wire.GraphEdge carries Molang in.
const CONDITIONAL = 'wiki:conditional_list_example'
const CONDITIONAL_FILE = 'features/conditional_list_example.json'
const CONDITIONAL_EDGE = '$.minecraft:conditional_list.conditional_features[0].places_feature'

/** The editable controls whose value contains `text`. The question a person asks -- "is the
 * expression in something I can type in?" -- with no opinion about what that something is. */
function holding(editables: readonly Editable[], text: string): Editable[] {
  return editables.filter((e) => e.editable && e.value.includes(text))
}

/** What went wrong, in the failure message, rather than `expected 0 to be greater than 0`. */
function whatThePanelOffers(editables: readonly Editable[]): string {
  if (editables.length === 0) return 'the panel has no editable controls at all'
  return `the panel's editable controls hold: ${JSON.stringify(editables.filter((e) => e.editable).map((e) => e.value))}`
}

describe('editing the Molang on a scatter edge', () => {
  it(
    'clicking the edge offers the expression in something a person can type in, and typing reaches the file',
    async () => {
      const j = await journey({ prepare: withIterations(ITERATIONS) })

      // The click lands on the line and the edge highlights -- which was the whole of what
      // worked before the editor was wired in. Everything after this point is what was missing.
      await j.clickEdge(SCATTER, SCATTER_EDGE)
      expect(await j.selectedEdge()).toEqual({ from: SCATTER, jsonPath: SCATTER_EDGE })

      // 1. The panel is about the EDGE. It used to be the pack overview -- the identical panel
      //    shown when nothing at all is selected, so selecting an edge told the reader nothing.
      const side = await j.sideText()
      expect(side).toContain(SCATTER)
      expect(side, 'selecting an edge still shows the "nothing selected" overview').not.toContain('Starts here')

      // 2. The expression is in something editable. Not a label, not a tooltip: a control.
      const editables = await j.editables()
      const withText = holding(editables, ITERATIONS)
      expect(withText.length, `no editable control holds ${ITERATIONS} -- ${whatThePanelOffers(editables)}`).toBeGreaterThan(0)

      // 3. Typing a new expression into it reaches the file. The engine re-reads the pack and
      //    hands back a graph, so the edge itself has to carry the new text afterwards too --
      //    which is what makes this an edit rather than a box that forgets.
      //
      //    WHAT REACHES THE FILE IS THE COMPACT SPELLING, and the difference between the two
      //    strings below is the whole point of the format/minify feature: the editor lays an
      //    expression out for reading and writes it back as the one line a pack file holds. The
      //    assertion is on the minified text rather than on what was typed because asserting on
      //    what was typed would be asserting that this feature is off.
      const control = j.page.locator(withText[0]!.selector)
      await control.fill('math.random_integer(5, 12)')
      await control.press('Tab')

      await expect
        .poll(() => j.read(SCATTER_FILE).includes('math.random_integer(5,12)'), { timeout: 20_000 })
        .toBe(true)
      expect(j.read(SCATTER_FILE)).not.toContain(ITERATIONS)

      // And the host was asked to change the scatter's OWN file, not the file of the feature it
      // places -- checked alongside the file rather than instead of it.
      const request = j.posted.find(
        (m) => (m.type === 'applyEdits' || m.type === 'create') && JSON.stringify(m).includes('random_integer(5,12)'),
      )
      expect(request, 'nothing was posted to the host at all').toBeDefined()
      expect(JSON.stringify(request)).toContain('scatter_pumpkin_patch.json')

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    "an expression the editor knows places nothing is called out where it is being typed",
    async () => {
      // `iterations` used as a SETUP step is one of the three load-bearing idioms molangEdge.ts
      // exists for, and the specific way it misfires is a statement sequence with no `return`:
      // it evaluates to 0, so the scatter silently places nothing. localProblems() already
      // catches exactly this offline, with no engine and no round trip. The author has to be
      // told while they are typing it, because afterwards the symptom is an empty world.
      const j = await journey({ prepare: withIterations('variable.height = 5;') })

      await j.clickEdge(SCATTER, SCATTER_EDGE)
      const side = await j.sideText()
      expect(side.toLowerCase()).toMatch(/nothing|zero|0 iterations|return/)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('editing the Molang on a conditional edge', () => {
  it(
    "clicking the edge offers the entry's condition in something a person can type in",
    async () => {
      const j = await journey()
      const before = j.read(CONDITIONAL_FILE)
      expect(before).toContain('"condition"')

      await j.clickEdge(CONDITIONAL, CONDITIONAL_EDGE)
      expect(await j.selectedEdge()).toEqual({ from: CONDITIONAL, jsonPath: CONDITIONAL_EDGE })

      // A condition is OPTIONAL, and the contract keeps "the author wrote none" distinct from a
      // written "1.0" -- so the control has to exist even where the key is absent, or there is
      // no way to add one. Here the key is present, which is the easier half.
      const editables = await j.editables()
      const usable = editables.filter((e) => e.editable)
      expect(usable.length, `selecting a conditional edge offers nothing to edit -- ${whatThePanelOffers(editables)}`).toBeGreaterThan(0)

      const control = j.page.locator(usable[0]!.selector)
      await control.fill('query.noise(1, 2) > 0.4')
      await control.press('Tab')

      // Minified on the way in, as above. `query.noise(1, 2) > 0.4` is what the box shows.
      await expect
        .poll(() => j.read(CONDITIONAL_FILE).includes('query.noise(1,2)>0.4'), { timeout: 20_000 })
        .toBe(true)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('what the canvas itself does with an edge', () => {
  // Selection and the chip are the foundation the panel above is hung from: without them there
  // is nothing for a click to reach. Pinned in the same file so they cannot be broken by
  // somebody working on the panel and noticed only when the panel stops opening.
  it(
    'the edge highlights and its chip states the iteration count',
    async () => {
      const j = await journey({ prepare: withIterations(ITERATIONS) })

      // Nothing is selected to start with.
      expect(await j.selectedEdge()).toBeNull()

      await j.clickEdge(SCATTER, SCATTER_EDGE)
      expect(await j.selectedEdge()).toEqual({ from: SCATTER, jsonPath: SCATTER_EDGE })

      // The chip beside the line states the expression in a tooltip and in an accessible name.
      // It is read-only and stays that way -- it is a label on a line, not a control.
      const chip = j.page.locator(`.flg-chip[aria-label*=${JSON.stringify(`from ${SCATTER} to`)}]`).first()
      await chip.waitFor({ state: 'attached', timeout: 20_000 })
      expect((await chip.getAttribute('title')) ?? '').not.toBe('')

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

// ===========================================================================
// The field as an EDITOR: formatted on screen, compact in the file, coloured,
// completing, and remembering which of the two spellings the author asked for.
// ===========================================================================
//
// Every one of these drives the real bundle in Chromium with the mouse and the keyboard, for the
// reason this whole directory exists: a complete, well-tested Molang editor once shipped wired to
// nothing, and no unit suite in this repo could fail for that. molangFormat.test.ts proves the
// rewrites are safe; graphMolangField.test.ts proves the editor makes the right decisions. Only
// these can say a person can reach any of it.

/** A setup script in the shape a real pack writes one: several statements, a trailing `return`,
 * and not one space anywhere. Unreadable in three rows, which is the problem being solved. */
const ONE_LINER = "v.trunk=4+math.random_integer(0,3);v.lean=(q.noise(v.originx/64,v.originz/64)>0.3)*2;return v.trunk;"

/** The control holding the expression, found by BEING editable rather than by a selector -- the
 * rule this file's header sets out. */
async function expressionBox(j: Journey): Promise<Editable> {
  const editables = await j.editables()
  const box = editables.find((e) => e.editable && e.tag === 'textarea')
  if (box === undefined) throw new Error(`the panel offers no text box -- ${whatThePanelOffers(editables)}`)
  return box
}

/** The tick box the panel offers, found by being a checkbox a person can click. */
async function formatChoice(j: Journey): Promise<Editable> {
  const editables = await j.editables()
  const found = editables.find((e) => e.editable && e.inputType === 'checkbox')
  if (found === undefined) throw new Error(`the panel offers no checkbox -- ${whatThePanelOffers(editables)}`)
  return found
}

describe('an expression is readable on screen and compact in the file', () => {
  it(
    'opens laid out over several lines while the file still holds one',
    async () => {
      const j = await journey({ prepare: withIterations(ONE_LINER) })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const box = await expressionBox(j)
      // What the author sees: three statements, three lines, spaced.
      expect(box.value.split('\n'), `the box holds ${JSON.stringify(box.value)}`).toHaveLength(3)
      expect(box.value).toContain('v.trunk = 4 + math.random_integer(0, 3);')

      // What the file holds: exactly what it held. Opening an expression must not rewrite it --
      // otherwise browsing a pack reformats every edge anybody clicks on.
      expect(j.read(SCATTER_FILE)).toContain(ONE_LINER)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'writes back one compact line when the author edits it',
    async () => {
      const j = await journey({ prepare: withIterations(ONE_LINER) })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const control = j.page.locator((await expressionBox(j)).selector)
      await control.fill('v.a = 1;\nv.b = 2;\nreturn v.a + v.b;')
      await control.press('Tab')

      await expect
        .poll(() => j.read(SCATTER_FILE).includes('v.a=1;v.b=2;return v.a+v.b;'), { timeout: 20_000 })
        .toBe(true)
      // And not as three lines escaped into the JSON string, which is what a field that wrote its
      // own text back verbatim would have produced.
      expect(j.read(SCATTER_FILE)).not.toContain('\\n')

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('the tick box that opts one expression out of being compacted', () => {
  it(
    'writes a directive into the file, and the file then keeps the layout',
    async () => {
      const j = await journey({ prepare: withIterations(ONE_LINER) })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      // It says what it does in the author's terms. "Minify" is the implementation's word.
      const choice = await formatChoice(j)
      expect(choice.label.toLowerCase()).toContain('line breaks')
      expect(choice.label.toLowerCase()).toContain('file')

      await j.page.locator(choice.selector).click()

      // 1. The choice is recorded IN THE FILE, as a comment, so it survives the session. This is
      //    the half that was unreachable: the editor had an `annotate` change kind, jsonc could
      //    write a directive, and there was no method between the two.
      await expect
        .poll(() => j.read(SCATTER_FILE).includes('@featurelab:molang-format keep'), { timeout: 20_000 })
        .toBe(true)
      // On the expression, not on the delegation -- it is a statement about the iterations text.
      expect(j.read(SCATTER_FILE)).toMatch(/@featurelab:molang-format keep[\s\S]*"iterations"/)

      // 2. And it changes what the file receives. Same gesture as the test above, opposite result.
      const control = j.page.locator((await expressionBox(j)).selector)
      await control.fill('v.a=1;v.b=2;return v.a+v.b;')
      await control.press('Tab')

      await expect
        .poll(() => j.read(SCATTER_FILE).includes('v.a = 1;\\nv.b = 2;\\nreturn v.a + v.b;'), { timeout: 20_000 })
        .toBe(true)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'is read back off the file, so the next person to open the pack gets the same answer',
    async () => {
      // The directive written by hand, which is the state the pack is in after somebody else
      // ticked the box and committed. Nothing about this depends on the session that wrote it.
      const j = await journey({
        prepare: (packRoot) => {
          withIterations(ONE_LINER)(packRoot)
          const file = `${packRoot}/${SCATTER_FILE}`
          fs.writeFileSync(
            file,
            fs
              .readFileSync(file, 'utf8')
              .replace('"iterations"', '// @featurelab:molang-format keep\n      "iterations"'),
            'utf8',
          )
        },
      })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const choice = await formatChoice(j)
      expect(await j.page.locator(choice.selector).isChecked()).toBe(true)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('completion', () => {
  it(
    'offers the names the engine actually answers, explains them, and replaces the right range',
    async () => {
      const j = await journey({ prepare: withIterations('14') })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const control = j.page.locator((await expressionBox(j)).selector)
      await control.click()
      await control.fill('')
      // Typed, key by key, because WHEN the list opens is part of what is being tested.
      await control.pressSequentially('q.nois')

      // Found by ARIA role, which is how a screen reader finds it -- not by a class this test
      // invented.
      const options = j.page.locator('#flg-side [role="option"]')
      await options.first().waitFor({ state: 'visible', timeout: 10_000 })
      const listed = (await j.page.locator('#flg-side [role="listbox"]').textContent()) ?? ''
      // The catalogue's own prose, which is the reason the field can teach somebody Molang.
      expect(listed).toContain('query.noise(x, z)')
      expect(listed.toLowerCase()).toContain('simplex noise')

      await control.press('Enter')

      // The namespace the author was already typing survives -- `q.`, not `query.` -- because the
      // completion replaces only the member. And Enter accepted rather than inserting a newline.
      await expect.poll(() => control.inputValue(), { timeout: 10_000 }).toBe('q.noise')
      expect(await options.count()).toBe(0)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'never swallows ordinary typing',
    async () => {
      const j = await journey({ prepare: withIterations('14') })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const control = j.page.locator((await expressionBox(j)).selector)
      await control.click()
      await control.fill('')
      await control.pressSequentially('q.nois')
      const options = j.page.locator('#flg-side [role="option"]')
      await options.first().waitFor({ state: 'visible', timeout: 10_000 })

      // Escape closes the list and nothing else: the text is untouched and the panel stays open.
      await control.press('Escape')
      await expect.poll(() => options.count(), { timeout: 10_000 }).toBe(0)
      expect(await control.inputValue()).toBe('q.nois')

      // Carrying on typing keeps working, list open or not.
      await control.pressSequentially('e(1, 2)')
      expect(await control.inputValue()).toBe('q.noise(1, 2)')
      // And a caret sitting after a `)` does not pop a list over the panel.
      expect(await options.count()).toBe(0)

      // Tab with the list closed still means "leave the field", which is what commits.
      await control.press('Tab')
      await expect.poll(() => j.read(SCATTER_FILE).includes('q.noise(1,2)'), { timeout: 20_000 }).toBe(true)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('syntax highlighting', () => {
  /** The two layers, measured in the live page: the textarea a person types into, and whatever
   * element is painting the same text in colour behind it. Found by CONTENT -- an element holding
   * the same string as the box -- because a selector would pass on a layer that had drifted out of
   * alignment as happily as on one that had not. */
  async function layers(j: Journey): Promise<{
    metrics: Record<string, { input: string; ink: string }>
    boxes: { input: Record<string, number>; ink: Record<string, number> }
    colouredTokens: { text: string; className: string }[]
  }> {
    return j.page.evaluate(() => {
      const input = document.querySelector('#flg-side textarea') as HTMLTextAreaElement | null
      if (input === null) throw new Error('no text box in the panel')
      const candidates = ([...document.querySelectorAll('#flg-side *')] as HTMLElement[]).filter(
        (el) => el !== input && el.children.length > 0 && el.textContent?.trim() === input.value.trim(),
      )
      // The INNERMOST match, which is the element actually painting the glyphs. Ancestors hold the
      // same text and come first in document order, and measuring one of those would compare the
      // text box against a wrapper -- a test that passes or fails for reasons unrelated to
      // alignment. (This is not hypothetical: the first version of this helper measured the
      // wrapper, and the panel's body font made it fail.)
      const ink = candidates[candidates.length - 1]
      if (ink === undefined) throw new Error('nothing is painting the expression behind the box')
      // Every property that decides WHERE A GLYPH LANDS. A difference in any one of them is a
      // caret that walks away from its own text.
      const properties = [
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing',
        'lineHeight', 'tabSize', 'textIndent', 'textTransform', 'whiteSpace', 'overflowWrap',
        'wordBreak', 'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      ]
      const a = getComputedStyle(input) as unknown as Record<string, string>
      const b = getComputedStyle(ink) as unknown as Record<string, string>
      const metrics: Record<string, { input: string; ink: string }> = {}
      for (const key of properties) metrics[key] = { input: a[key] ?? '', ink: b[key] ?? '' }
      const box = (el: Element): Record<string, number> => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      return {
        metrics,
        boxes: { input: box(input), ink: box(ink) },
        colouredTokens: [...ink.querySelectorAll('*')].map((el) => ({
          text: el.textContent ?? '',
          className: (el as HTMLElement).className,
        })),
      }
    })
  }

  it(
    'lays its colour out in exactly the same place as the text it is colouring',
    async () => {
      // THE FAILURE THIS GUARDS. The colour lives in a second element behind a transparent
      // textarea, and the moment the two disagree about a font, a padding, a border or a wrapping
      // rule the caret drifts away from the glyphs -- which is worse than no colour at all, and is
      // invisible until somebody types a line long enough to wrap.
      const j = await journey({
        prepare: withIterations(
          // Long enough to wrap in a 320px panel, so the two layers have to agree about where a
          // line BREAKS and not merely about where one starts.
          "v.a=query.has_biome_tag('minecraft:forest')+query.heightmap(v.originx,v.originz)+math.random_integer(0,9);return v.a;",
        ),
      })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const { metrics, boxes } = await layers(j)
      for (const [key, pair] of Object.entries(metrics)) {
        expect(pair.ink, `${key} differs between the text and the colour behind it`).toBe(pair.input)
      }
      for (const side of ['x', 'y', 'width', 'height'] as const) {
        expect(
          Math.abs((boxes.ink[side] ?? 0) - (boxes.input[side] ?? 0)),
          `the coloured layer's ${side} is not the text box's`,
        ).toBeLessThanOrEqual(0.5)
      }

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'agrees with the diagnostic about a name the engine does not have',
    async () => {
      // `unreachable-query` is an ERROR the panel already reports -- the real game refuses to
      // tokenize a file carrying one. A highlighter that painted it like a real query would be the
      // more prominent of two contradictory answers, and the wrong one.
      const j = await journey({ prepare: withIterations("query.block_property('x') + query.noise(1, 2)") })
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const { colouredTokens } = await layers(j)
      const good = colouredTokens.find((t) => t.text === 'query.noise')
      const bad = colouredTokens.find((t) => t.text === 'query.block_property')
      expect(good, 'query.noise was not coloured at all').toBeDefined()
      expect(bad, 'query.block_property was not coloured at all').toBeDefined()
      expect(bad!.className, 'a query the engine does not register is coloured as if it were real').not.toBe(
        good!.className,
      )

      // ...and the panel says so in words, in the same panel, at the same time.
      expect((await j.sideText()).toLowerCase()).toContain('not one of the six queries')

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('coming back to an edge', () => {
  it(
    'still writes exactly once',
    async () => {
      // THE BUG THIS PINS. The editor outlives the panel -- it is cached so that leaving and
      // returning does not throw away the caret and the draft -- so a panel that subscribed to it
      // afresh on every render stacked listeners on one editor. Select an edge, look at something
      // else, come back, and every commit from then on posted twice; so did every tick of the
      // format box, which means the directive was written, and the pack reloaded, twice per click.
      // Nothing visible fails, because both writes say the same thing.
      const j = await journey({ prepare: withIterations('14') })

      await j.clickEdge(SCATTER, SCATTER_EDGE)
      await j.clickNode(SCATTER)
      await j.clickEdge(SCATTER, SCATTER_EDGE)

      const control = j.page.locator((await expressionBox(j)).selector)
      await control.fill('7')
      await control.press('Tab')

      // Written as a string, which is what this editor has always done with a Molang field --
      // a bare count and an expression go through the same slot.
      await expect.poll(() => j.read(SCATTER_FILE).includes('"iterations": "7"'), { timeout: 20_000 }).toBe(true)
      // Only one edit was made in this journey, so every applyEdits post is a copy of it.
      const writes = j.posted.filter((m) => m.type === 'applyEdits')
      expect(writes, `the edit was posted ${writes.length} times`).toHaveLength(1)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('the expression box on the edge panel', () => {
  it(
    'takes the height of the panel instead of three lines of it',
    async () => {
      // Reported as "the Molang window should maximise vertically". The box grew to its text up
      // to a ceiling, so a two-line condition sat in a three-line well at the top of an otherwise
      // empty column, and a setup script scrolled inside a box a fraction of the space it had.
      const j = await journey({ prepare: withIterations(ITERATIONS) })
      await j.clickEdge(SCATTER, SCATTER_EDGE)
      const { selector } = await expressionBox(j)
      const { side, box } = await j.page.evaluate((selector) => {
        const side = document.getElementById('flg-side')!.getBoundingClientRect()
        const box = document.querySelector(selector)!.getBoundingClientRect()
        return { side: { bottom: side.bottom, height: side.height }, box: { bottom: box.bottom, height: box.height } }
      }, selector)
      expect(box.height, `the box is ${box.height}px of a ${side.height}px panel`).toBeGreaterThan(side.height * 0.5)
      expect(box.bottom, 'the box runs past the bottom of the panel').toBeLessThanOrEqual(side.bottom + 1)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
