// groups.test.ts -- grouping features from the canvas, end to end.
//
// A group is written into its members' files as a `@featurelab:group` directive, so every
// assertion here is about the FILES: after each thing a person does in the real editor -- a
// ctrl+click, a name typed into the panel, a Collapse button, an Ungroup -- the pack on disk has
// to say what they did, and the canvas has to show it. The webview, the host, the engine's batch
// annotate and the jsonc removal that leaves no empty line behind are all real; nothing here
// asserts that a message was posted.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeStub.js'))

import { closeSharedBrowser, openJourney, JOURNEY_TIMEOUT_MS, type Journey } from './harness.js'
import * as vscodeStub from './vscodeStub.js'

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

/** Two leaf features the fixture pack has, and a rule that places the first -- the edge that has
 * to be re-pointed at the group's card when the group folds. */
const MARKER = 'wiki:rng_marker'
const MARKER_FILE = 'features/rng_marker.json'
const THRESHOLD = 'wiki:threshold_marker'
const THRESHOLD_FILE = 'features/threshold_marker.json'
const RULE = 'wiki:rng_rule_a.fr'

const WAIT = { timeout: 20_000 }

function directiveIn(j: Journey, file: string): string | null {
  const line = j.read(file).split(/\r?\n/).find((l) => l.includes('@featurelab:group'))
  return line === undefined ? null : line.trim()
}

/** Both members' directives, for polling as a PAIR. The engine writes a batch file by file, so
 * a poll on one file can pass between the two writes and a plain read of the other then sees
 * the previous state -- a race in the test, not in the product. */
function bothDirectives(j: Journey): [string | null, string | null] {
  return [directiveIn(j, MARKER_FILE), directiveIn(j, THRESHOLD_FILE)]
}

/** Ctrl+clicks a second node so both are selected. The first is clicked plainly. */
async function selectBoth(j: Journey): Promise<void> {
  await j.clickNode(MARKER)
  await j.waitForNode(THRESHOLD)
  await j.page.evaluate((id: string) => {
    ;(window as unknown as { __flgView?: { focusNode(id: string): void } }).__flgView?.focusNode(id)
  }, THRESHOLD)
  await j.page.locator(`.flg-node[data-node-id=${JSON.stringify(THRESHOLD)}]`).click({ modifiers: ['Control'], ...WAIT })
  await expect.poll(() => j.sideText(), WAIT).toMatch(/2 selected/)
}

describe('grouping features', () => {
  it(
    'select two, name the group: both files carry the directive, and the canvas frames them',
    async () => {
      const j = await journey()
      const originalMarker = j.read(MARKER_FILE)
      const originalThreshold = j.read(THRESHOLD_FILE)
      expect(originalMarker).not.toContain('@featurelab:group')

      await selectBoth(j)
      // Ctrl+G puts the caret in the name box; the name goes in and Enter makes the group.
      await j.page.keyboard.press('Control+g')
      await expect.poll(() => j.page.evaluate(() => document.activeElement?.id ?? ''), WAIT).toBe('flg-group-name')
      await j.page.keyboard.type('Marker Blocks')
      await j.page.keyboard.press('Enter')

      const made = '// @featurelab:group marker-blocks expanded Marker Blocks'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([made, made])
      // On the ROOT: the first line of the file, above the document, and nothing else touched.
      expect(j.read(MARKER_FILE)).toBe(`// @featurelab:group marker-blocks expanded Marker Blocks\n${originalMarker}`)
      expect(j.read(THRESHOLD_FILE)).toBe(`// @featurelab:group marker-blocks expanded Marker Blocks\n${originalThreshold}`)

      // Drawn as a frame around both, selected, with its panel open on the name.
      await j.page.locator('.flg-frame[data-group-id="marker-blocks"]').waitFor(WAIT)
      expect(await j.page.locator('.flg-frame-head.flg-selected').count()).toBe(1)
      const name = j.page.locator('#flg-side input[aria-label="Group name"]')
      expect(await name.inputValue()).toBe('Marker Blocks')
      expect(await j.sideText()).toMatch(/Members \(2\)/)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'without a mouse at all: Tab in, walk to two cards with the arrows, Ctrl+Space each, Ctrl+G',
    async () => {
      // THE STEP THAT WAS MISSING, against real files and a real engine.
      //
      // Everything after "two cards are selected" -- Ctrl+G, the name box, Enter, collapse,
      // ungroup, the member remove -- has always been keyboard-reachable and is covered by the
      // journeys above. Step one was not: ctrl+click and a marquee were the only two ways to put
      // a second card into a selection, and both are a mouse. An audit tried Ctrl+Enter,
      // Shift+Enter, Ctrl+Space, Shift+Space and Alt+Enter on a second card and got one id back
      // from every one of them, so the whole life cycle was unreachable from the keyboard at its
      // first move. This drives the real panel end to end and then reads the files off disk.
      const j = await journey()
      const originalMarker = j.read(MARKER_FILE)
      const originalThreshold = j.read(THRESHOLD_FILE)
      await j.waitForNode(MARKER)
      await j.waitForNode(THRESHOLD)

      // Tab until the keyboard is on a card. ONE stop for the whole drawing, so this is short --
      // the toolbar in front of it is what the count is made of.
      let presses = 0
      for (let i = 0; i < 40; i++) {
        await j.page.keyboard.press('Tab')
        presses++
        const onCard = await j.page.evaluate(() => document.activeElement?.classList.contains('flg-node') === true)
        if (onCard) break
      }
      expect(await j.page.evaluate(() => document.activeElement?.classList.contains('flg-node')), `Tab never reached a card in ${String(presses)} presses`).toBe(true)

      // Walk to the first of the two, with the arrows, and take it.
      const reach = async (id: string): Promise<void> => {
        const here = async (): Promise<string> => j.page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['nodeId'] ?? '')
        if ((await here()) === id) return
        // A breadth-first walk of the four arrows: the layout is the engine's, so which key gets
        // there is not something this test may assume. Bounded, and it fails with what it found.
        const seen = new Set<string>([await here()])
        for (let step = 0; step < 60; step++) {
          for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
            await j.page.keyboard.press(key)
            presses++
            const at = await here()
            if (at === id) return
            if (!seen.has(at)) {
              seen.add(at)
              break
            }
          }
        }
        throw new Error(`the arrows never reached ${id}; they visited ${[...seen].join(', ')}`)
      }

      await reach(MARKER)
      await j.page.keyboard.press('Control+Space')
      presses++
      await reach(THRESHOLD)
      await j.page.keyboard.press('Control+Space')
      presses++
      // TWO, from the keyboard alone. This is the assertion the whole test exists for.
      await expect.poll(() => j.sideText(), WAIT).toMatch(/2 selected/)

      await j.page.keyboard.press('Control+g')
      presses++
      await expect.poll(() => j.page.evaluate(() => document.activeElement?.id ?? ''), WAIT).toBe('flg-group-name')
      await j.page.keyboard.type('Keyboard Markers')
      await j.page.keyboard.press('Enter')

      const made = '// @featurelab:group keyboard-markers expanded Keyboard Markers'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([made, made])
      expect(j.read(MARKER_FILE)).toBe(`${made}
${originalMarker}`)
      expect(j.read(THRESHOLD_FILE)).toBe(`${made}
${originalThreshold}`)
      await j.page.locator('.flg-frame[data-group-id="keyboard-markers"]').waitFor(WAIT)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'rename, collapse, expand, remove one, ungroup -- each written to every member, and ungroup leaves the files as they were',
    async () => {
      const j = await journey({
        prepare: (packRoot) => {
          // Start already grouped, so this journey is about changing a group and not making one.
          for (const rel of [MARKER_FILE, THRESHOLD_FILE]) {
            const full = path.join(packRoot, rel)
            fs.writeFileSync(full, `// @featurelab:group markers expanded Markers\n${fs.readFileSync(full, 'utf8')}`, 'utf8')
          }
        },
      })
      const originalMarker = j.read(MARKER_FILE).replace(/^.*\n/, '')
      const originalThreshold = j.read(THRESHOLD_FILE).replace(/^.*\n/, '')

      // The group is there to begin with, and clicking its header selects it.
      await j.page.locator('.flg-frame[data-group-id="markers"]').waitFor(WAIT)
      await j.clickGroupHeader('markers')
      const name = j.page.locator('#flg-side input[aria-label="Group name"]')
      await name.waitFor(WAIT)
      expect(await name.inputValue()).toBe('Markers')

      // RENAME: every member rewritten, the id kept.
      await name.fill('Two Markers')
      await name.press('Enter')
      const renamed = '// @featurelab:group markers expanded Two Markers'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([renamed, renamed])

      // COLLAPSE: the files say so, the members are gone from the canvas, one card stands for
      // them, and the rule's edge into a member now points at the card.
      await j.page.locator('#flg-side button', { hasText: 'Collapse' }).click(WAIT)
      const collapsed = '// @featurelab:group markers collapsed Two Markers'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([collapsed, collapsed])
      await j.page.locator('.flg-node.flg-node-group[data-node-id="group:markers"]').waitFor(WAIT)
      expect(await j.nodeIds()).not.toContain(MARKER)
      expect(await j.nodeIds()).not.toContain(THRESHOLD)
      expect(await j.page.locator('.flg-node-group .flg-node-id').textContent()).toBe('Two Markers')
      expect(await j.page.locator('.flg-node-group .flg-node-group-count').textContent()).toBe('2 features')
      expect(await j.page.locator(`.flg-chip[aria-label="rule edge from ${RULE} to group:markers: places"]`).count()).toBe(1)
      // The card is selected and the panel offers the way back.
      expect(await j.sideText()).toMatch(/Members \(2\)/)

      // A hidden member found by search selects the card, not nothing.
      await j.page.keyboard.press('Control+f')
      await j.page.keyboard.type('threshold_marker')
      await j.page.keyboard.press('Enter')
      await expect.poll(() => j.status(), WAIT).toMatch(/inside the collapsed group/)
      expect(await j.page.locator('.flg-node-group.flg-selected').count()).toBe(1)

      // EXPAND, from the panel.
      await j.page.locator('#flg-side button', { hasText: 'Expand' }).click(WAIT)
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([renamed, renamed])
      await j.waitForNode(MARKER)
      await j.waitForNode(THRESHOLD)
      await j.page.locator('.flg-frame[data-group-id="markers"]').waitFor(WAIT)

      // REMOVE ONE MEMBER: its directive goes, the other's stays, no blank line left behind.
      await j.page.locator(`#flg-side button[aria-label="Remove ${THRESHOLD} from group"]`).click(WAIT)
      await expect.poll(() => directiveIn(j, THRESHOLD_FILE), WAIT).toBeNull()
      expect(j.read(THRESHOLD_FILE)).toBe(originalThreshold)
      expect(directiveIn(j, MARKER_FILE)).toBe('// @featurelab:group markers expanded Two Markers')
      await expect.poll(() => j.sideText(), WAIT).toMatch(/Members \(1\)/)

      // UNGROUP, with the inline confirmation: no directive anywhere, and the file is byte for
      // byte what it was before the group existed.
      await j.page.locator('#flg-side button.flg-group-ungroup').click(WAIT)
      await j.page.locator('#flg-side button.flg-group-ungroup-confirm').click(WAIT)
      await expect.poll(() => directiveIn(j, MARKER_FILE), WAIT).toBeNull()
      expect(j.read(MARKER_FILE)).toBe(originalMarker)
      expect(j.read(MARKER_FILE)).not.toMatch(/^\s*\n/)
      await expect.poll(() => j.page.locator('.flg-frame').count(), WAIT).toBe(0)
      // Nothing selected afterwards; the overview is back and lists no groups.
      expect(await j.sideText()).not.toMatch(/Groups/)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'the Group button writes ONE batch, and one undo puts both files back exactly',
    async () => {
      // THE DATA-LOSS BUG. The name box committed on `change` and the Group button planned again
      // from `.value`, and a click does BOTH: pressing Group blurs the input, the blur fires
      // `change`, the first batch goes out -- and then the click handler plans a second create
      // against a graph that already has the first batch's directives folded into it, so
      // slugForGroup finds `markers` taken and makes `markers-2`. Two batches, two ids, both
      // writing the same two files, the second landing on top. The panel showed "Markers"
      // throughout, because the name is all that is drawn, while the files said something else.
      //
      // Worse than the wrong id: the two batches were in flight together, so the second journal
      // entry's `before` was read mid-write. One Ctrl+Z put back a one-member group nobody
      // authored and the next refused, forever.
      //
      // The keyboard route was always fine, which is why this survived review. This is the MOUSE.
      const j = await journey()
      const originalMarker = j.read(MARKER_FILE)
      const originalThreshold = j.read(THRESHOLD_FILE)

      await selectBoth(j)
      const box = j.page.locator('#flg-group-name')
      await box.fill('Markers')
      await j.page.locator('#flg-side button.flg-group-make').click(WAIT)

      const made = '// @featurelab:group markers expanded Markers'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([made, made])

      // ONE batch. This is the assertion the old code fails: it posted two.
      const batches = j.posted.filter((m) => m.type === 'annotateBatch')
      expect(batches, `the webview posted ${String(batches.length)} annotateBatch messages`).toHaveLength(1)
      // ...and it carried the plan's own words, so the history is not called "Annotate 2 file(s)".
      expect(batches[0]?.['label']).toBe('Grouping 2 features as "Markers".')

      // The id is the one the name makes. `markers-2` is the fingerprint of the second write.
      expect(j.read(MARKER_FILE)).not.toContain('markers-2')
      expect(j.read(THRESHOLD_FILE)).not.toContain('markers-2')

      // AND THE HISTORY IS SOUND. One undo, and both files are byte for byte what they were --
      // not a one-member group, and not a refusal.
      await j.page.locator('#flg-history button.flg-history-undo').click(WAIT)
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([null, null])
      expect(j.read(MARKER_FILE)).toBe(originalMarker)
      expect(j.read(THRESHOLD_FILE)).toBe(originalThreshold)
      expect(await j.statusIsError()).toBe(false)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'the toolbar shows undo and redo by name, and both of them work',
    async () => {
      // UNDO HAD NO VISIBLE ROUTE. The toolbar was ["Clear", "Add", "Preview on select", "Fit"];
      // the host had been posting `history`, `undone` and `redone` all along and the webview's
      // dispatcher -- fourteen message types -- handled none of the three. Every field in this
      // editor writes a file with no save step, and the only way to reverse one was a keybinding
      // the panel never mentioned.
      const j = await journey()
      const original = j.read(MARKER_FILE)

      // Nothing has been written yet, and the pair says so rather than hiding.
      const undo = j.page.locator('#flg-history button.flg-history-undo')
      const redo = j.page.locator('#flg-history button.flg-history-redo')
      await undo.waitFor(WAIT)
      // UNAVAILABLE, NOT REMOVED FROM THE KEYBOARD. `aria-disabled` rather than `disabled`: a
      // real `disabled` takes the control out of the tab order, so the state this pair is in
      // most of the time -- nothing to redo -- was a button a keyboard user could never reach
      // to be told why. It still refuses the press; it just does so audibly.
      expect(await undo.getAttribute('aria-disabled')).toBe('true')
      expect(await redo.getAttribute('aria-disabled')).toBe('true')
      expect(await undo.evaluate((el: HTMLButtonElement) => el.disabled)).toBe(false)
      expect(await redo.evaluate((el: HTMLButtonElement) => el.tabIndex)).toBeGreaterThanOrEqual(0)
      // And the sentence beside them is bound to both, so "Undo" is never announced alone.
      expect(await undo.getAttribute('aria-describedby')).toBe('flg-history-label')
      expect(await redo.getAttribute('aria-describedby')).toBe('flg-history-label')
      const label = j.page.locator('#flg-history .flg-history-label')
      expect(await label.getAttribute('aria-live')).toBe('polite')
      expect(await label.textContent()).toBe('Nothing to undo')

      await selectBoth(j)
      await j.page.keyboard.press('Control+g')
      await j.page.keyboard.type('Markers')
      await j.page.keyboard.press('Enter')
      const made = '// @featurelab:group markers expanded Markers'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([made, made])

      // The control now names what it would revert, in the author's words.
      await expect.poll(() => j.page.locator('#flg-history .flg-history-label').textContent(), WAIT).toBe(
        'Grouping 2 features as "Markers".',
      )
      expect(await undo.getAttribute('aria-disabled')).toBeNull()
      expect(await undo.getAttribute('title')).toContain('Grouping 2 features as "Markers".')

      await undo.click(WAIT)
      await expect.poll(() => directiveIn(j, MARKER_FILE), WAIT).toBeNull()
      expect(j.read(MARKER_FILE)).toBe(original)
      // It says what it did, and names the files it put back -- the one question a write nobody
      // typed actually raises.
      await expect.poll(() => j.status(), WAIT).toMatch(/Undid Grouping 2 features as "Markers"\./)
      expect(await j.status()).toContain('rng_marker.json')
      expect(await j.statusIsError()).toBe(false)

      // And back again.
      await expect.poll(() => redo.getAttribute('aria-disabled'), WAIT).toBeNull()
      await redo.click(WAIT)
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([made, made])
      await expect.poll(() => j.status(), WAIT).toMatch(/^Redid /)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a refused undo is said on the canvas, and can be stepped past',
    async () => {
      // TWO FAILURES IN ONE GESTURE. The refusal existed only as a VS Code notification -- the
      // canvas said nothing, the status line went on showing the card count -- and because `undo`
      // refuses BEFORE popping (correctly: a refusal is not an undo), the entry stayed on the
      // stack and every later press met the same wall. The history was unusable for the rest of
      // the session.
      const j = await journey({
        prepare: (packRoot) => {
          for (const rel of [MARKER_FILE, THRESHOLD_FILE]) {
            const full = path.join(packRoot, rel)
            fs.writeFileSync(full, `// @featurelab:group markers expanded Markers\n${fs.readFileSync(full, 'utf8')}`, 'utf8')
          }
        },
      })
      await j.page.locator('.flg-frame[data-group-id="markers"]').waitFor(WAIT)
      await j.clickGroupHeader('markers')
      await j.page.locator('#flg-side button', { hasText: 'Collapse' }).click(WAIT)
      const collapsed = '// @featurelab:group markers collapsed Markers'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([collapsed, collapsed])
      // Wait for the HOST to have finished the write, not just for the bytes to be on disk: the
      // journal takes its `after` snapshot once the engine call returns, and it is that snapshot
      // the edit below has to come after. The history label is posted from the same place.
      await expect.poll(() => j.page.locator('#flg-history .flg-history-label').textContent(), WAIT).toBe('Collapsing "Markers".')

      // Somebody edits a member in a text editor and saves. The journal will not write over that.
      j.write(MARKER_FILE, `${j.read(MARKER_FILE)}\n`)
      await j.notifySaved(MARKER_FILE)

      await j.page.locator('#flg-history button.flg-history-undo').click(WAIT)

      // ON THE CANVAS, as an error, naming the operation in the author's own words rather than
      // as "Annotate 2 file(s)".
      await expect.poll(() => j.status(), WAIT).toMatch(/cannot be undone/)
      expect(await j.status()).toContain('Collapsing "Markers".')
      expect(await j.statusIsError()).toBe(true)
      // Nothing was written: the refusal is a refusal, not a partial revert.
      expect(directiveIn(j, THRESHOLD_FILE)).toBe(collapsed)

      // AND THERE IS A WAY PAST IT. Offered only now, because it is an answer to a sentence the
      // author has just read.
      const skip = j.page.locator('#flg-history button.flg-history-forget')
      await skip.waitFor(WAIT)
      await skip.click(WAIT)
      await expect.poll(() => j.status(), WAIT).toMatch(/was left out of the history/)
      expect(await j.statusIsError()).toBe(false)
      // Forgetting writes nothing at all.
      expect(directiveIn(j, THRESHOLD_FILE)).toBe(collapsed)
      expect(j.read(MARKER_FILE).endsWith('\n\n')).toBe(true)
      // The button goes with the refusal it answered.
      expect(await skip.count()).toBe(0)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a refused name leaves the box usable, and the next good one is written',
    async () => {
      // THE BOX USED TO DIE ON A REFUSAL. `done` was set on the way INTO onCommit, so the first
      // attempt spent the input whatever happened to it: the refusal appeared, the corrected name
      // was typed into a box that had stopped listening, and the status line still showed the old
      // error. Only reselecting the group brought it back. A refusal is not a completion.
      const j = await journey()
      await selectBoth(j)
      await j.page.keyboard.press('Control+g')
      await expect.poll(() => j.page.evaluate(() => document.activeElement?.id ?? ''), WAIT).toBe('flg-group-name')

      // A name that cannot be written: it would close the block comment the directive may sit in.
      await j.page.keyboard.type('Bad */ Name')
      await j.page.keyboard.press('Enter')
      await expect.poll(() => j.status(), WAIT).toMatch(/cannot contain/)
      expect(await j.statusIsError()).toBe(true)
      expect(directiveIn(j, MARKER_FILE)).toBeNull()

      // The same box, corrected, in the same breath.
      const box = j.page.locator('#flg-group-name')
      await box.fill('Good Name')
      await box.press('Enter')

      const made = '// @featurelab:group good-name expanded Good Name'
      await expect.poll(() => bothDirectives(j), WAIT).toEqual([made, made])
      // The status line moved on from the refusal, too.
      expect(await j.statusIsError()).toBe(false)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    '"None" takes a file out of EVERY group it is in, and the node says it carries two',
    async () => {
      // "NONE" USED TO MOVE YOU INTO A DIFFERENT GROUP. A file carrying `patches` then `markers`
      // showed "Patches" on its row; choosing None removed the first directive and left the
      // second, so the feature silently joined the other group with nothing said. The only
      // warning about the two directives was on the winning group's panel -- not on the node,
      // which is where the choice is being made.
      const j = await journey({
        prepare: (packRoot) => {
          const full = path.join(packRoot, MARKER_FILE)
          fs.writeFileSync(
            full,
            `// @featurelab:group patches expanded Patches\n// @featurelab:group markers expanded Markers\n${fs.readFileSync(full, 'utf8')}`,
            'utf8',
          )
          const other = path.join(packRoot, THRESHOLD_FILE)
          fs.writeFileSync(other, `// @featurelab:group markers expanded Markers\n${fs.readFileSync(other, 'utf8')}`, 'utf8')
        },
      })

      await j.clickNode(MARKER)
      const select = j.page.locator('#flg-side .flg-group-row select')
      await select.waitFor(WAIT)
      expect(await select.inputValue()).toBe('patches')
      // The warning is where the person is looking, and says what None is about to do.
      await expect.poll(() => j.sideText(), WAIT).toMatch(/carries 2 group directives/)
      expect(await j.sideText()).toMatch(/removes all of them/)

      await select.selectOption('')

      // BOTH directives gone. Under the old plan the file came back still in "Markers".
      await expect.poll(() => j.read(MARKER_FILE).includes('@featurelab:group'), WAIT).toBe(false)
      // The other group is untouched: this took one file out, not a group apart.
      expect(directiveIn(j, THRESHOLD_FILE)).toBe('// @featurelab:group markers expanded Markers')

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a group that loses a member to a delete says so, and the question asks about it first',
    async () => {
      // LOSING A MEMBER WAS INVISIBLE. Deleting a member is refused for undo by name, which is
      // right -- and then the panel simply read "Members (1)" where it had read "Members (2)",
      // with nothing anywhere saying which one had gone. A group is a statement the author wrote
      // into the pack; a statement that quietly loses a clause is worse than one that fails.
      const j = await journey({
        prepare: (packRoot) => {
          for (const rel of [MARKER_FILE, THRESHOLD_FILE]) {
            const full = path.join(packRoot, rel)
            fs.writeFileSync(full, `// @featurelab:group markers expanded Markers\n${fs.readFileSync(full, 'utf8')}`, 'utf8')
          }
        },
      })
      await j.page.locator('.flg-frame[data-group-id="markers"]').waitFor(WAIT)

      await j.clickNode(THRESHOLD)
      await j.page.locator('#flg-side button', { hasText: 'Delete' }).first().click(WAIT)

      // Something still delegates to it, so the panel asks with the referrer list -- and that
      // question now names the group as well, because a delete takes the feature out of one.
      const anyway = j.page.getByRole('button', { name: 'Delete anyway' })
      await anyway.waitFor(WAIT)
      expect(await j.sideText()).toMatch(/This feature is in "Markers"/)
      await anyway.click(WAIT)
      await j.waitForNodeGone(THRESHOLD)

      // The host's own modal was told too, for the path where the panel does not ask.
      const asked = vscodeStub.shownWarnings.map((m) => m.detail ?? '').join('\n')
      expect(asked === '' || /This feature is in "Markers"/.test(asked)).toBe(true)

      // And the group's panel says what it lost, by name.
      await j.clickGroupHeader('markers')
      await expect.poll(() => j.sideText(), WAIT).toMatch(/Members \(1\)/)
      expect(await j.sideText()).toContain(THRESHOLD)
      expect(await j.sideText()).toMatch(/no longer in "Markers"/)

      // It can be acknowledged, and then it stops saying it.
      await j.page.locator('#flg-side button.flg-group-lost-dismiss').click(WAIT)
      await expect.poll(() => j.sideText(), WAIT).not.toMatch(/no longer in "Markers"/)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'search finds a group by the name the author gave it',
    async () => {
      // Ctrl+F on a group's own name answered "Nothing in this pack matches", while searching a
      // member of a collapsed group worked and even said which group held it -- so the box looked
      // as though it knew about groups and had decided this one did not exist. A group's name is
      // the one name on this canvas somebody chose.
      const j = await journey({
        prepare: (packRoot) => {
          for (const rel of [MARKER_FILE, THRESHOLD_FILE]) {
            const full = path.join(packRoot, rel)
            fs.writeFileSync(full, `// @featurelab:group markers expanded Surface Markers\n${fs.readFileSync(full, 'utf8')}`, 'utf8')
          }
        },
      })
      await j.page.locator('.flg-frame[data-group-id="markers"]').waitFor(WAIT)

      await j.page.keyboard.press('Control+f')
      await j.page.keyboard.type('Surface Markers')

      const rows = j.page.locator('.fls-row')
      await expect.poll(() => rows.count(), WAIT).toBe(2)
      const listed = await rows.allTextContents()
      expect(listed.join('\n')).toContain(MARKER)
      expect(listed.join('\n')).toContain(THRESHOLD)
      // It says why, since neither id spells "Surface".
      expect(listed.join('\n')).toMatch(/group it is in/)

      // And Enter still goes there.
      await j.page.keyboard.press('Enter')
      await expect.poll(() => j.selectedNodeId(), WAIT).toBe(MARKER)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a node can be moved into a group, and a rule can be a member too',
    async () => {
      const j = await journey({
        prepare: (packRoot) => {
          const full = path.join(packRoot, MARKER_FILE)
          fs.writeFileSync(full, `// @featurelab:group markers expanded Markers\n${fs.readFileSync(full, 'utf8')}`, 'utf8')
        },
      })
      const ruleFile = 'feature_rules/rng_rule_a.fr.json'
      await j.clickNode(RULE)
      const select = j.page.locator('#flg-side .flg-group-row select')
      await select.waitFor(WAIT)
      expect(await select.inputValue()).toBe('')
      await select.selectOption('markers')
      await expect.poll(() => directiveIn(j, ruleFile), WAIT).toBe('// @featurelab:group markers expanded Markers')
      await expect.poll(() => j.sideText(), WAIT).toMatch(/Members \(2\)/)

      // And out again, through the same row.
      await j.clickNode(RULE)
      await select.waitFor(WAIT)
      expect(await select.inputValue()).toBe('markers')
      await select.selectOption('')
      await expect.poll(() => directiveIn(j, ruleFile), WAIT).toBeNull()

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
