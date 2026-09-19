// multiSelection.test.ts -- what a marquee selection is FOR, and the two questions that are
// asked before something cannot be taken back.
//
// THE FINDING THIS FILE PINS. Dragging a box around twenty-nine nodes offered exactly one thing
// to do with them: "Group" -- and on a pack with no groups in it yet, that was the only control
// in the panel. Everything else the editor can do it could only do to one node, so the selection
// had to be abandoned to use it, which makes a marquee a way of counting nodes rather than a way
// of choosing them.
//
// AND THE ONE-WAY DOOR. Editing any node of a collapsed compound discards its recorded settings
// forever. The panel printed an amber paragraph about that and then let the first keystroke
// through, which is a warning in the sense that a sign is a lock. `classifyEdit` has existed in
// compounds/collapse.ts for this exact moment, with a comment saying it is what the command layer
// asks before it decides whether to prompt; nothing asked it. These journeys drive the real
// webview against the real engine, because both of these are about what a person can reach with
// a pointer, not about what a function returns.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeStub.js'))

import { closeSharedBrowser, openJourney, JOURNEY_TIMEOUT_MS, type Journey } from './harness.js'

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

/** Drags a marquee across the whole canvas, the way somebody selecting "these ones" does: shift
 * held, primary button, starting on background rather than on a card.
 *
 * Fit first, because a marquee can only catch what is drawn, and the view does not open fitted. */
async function selectEverything(j: Journey): Promise<number> {
  await j.page.locator('#flg-toolbar button', { hasText: /^Fit$/ }).click()
  await j.page.waitForTimeout(150)
  const box = await j.page.locator('#flg-canvas').boundingBox()
  if (!box) throw new Error('the canvas has no box')

  await j.page.keyboard.down('Shift')
  await j.page.mouse.move(box.x + 4, box.y + 4)
  await j.page.mouse.down({ button: 'left' })
  // Three steps, not a teleport: the marquee is drawn on move and a single jump can be delivered
  // as no move at all.
  await j.page.mouse.move(box.x + box.width / 3, box.y + box.height / 3, { steps: 4 })
  await j.page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 8 })
  await j.page.mouse.up({ button: 'left' })
  await j.page.keyboard.up('Shift')

  await j.page.locator('#flg-side .flg-multi-duplicate').waitFor({ state: 'visible', timeout: 5000 })
  const heading = (await j.page.locator('#flg-side').textContent()) ?? ''
  const matched = /(\d+) selected/.exec(heading)
  if (!matched) throw new Error(`no multi-selection panel: ${heading.slice(0, 200)}`)
  return Number(matched[1])
}

describe('a marquee selection is something you can act on', () => {
  it(
    'offers duplicate, copy, paste and delete -- not only "Group"',
    async () => {
      const j = await journey()
      const count = await selectEverything(j)
      expect(count).toBeGreaterThan(2)

      const side = j.page.locator('#flg-side')
      // The four a selection is usually FOR.
      expect(await side.locator('.flg-multi-duplicate').textContent()).toBe('Duplicate')
      expect(await side.locator('.flg-multi-copy').textContent()).toBe('Copy')
      expect(await side.locator('.flg-multi-paste').textContent()).toBe('Paste')
      expect(await side.locator('.flg-multi-delete').textContent()).toBe('Delete')
      // Plus the cheap arrangement pair, which is one batch of the move the drag path sends.
      expect(await side.locator('.flg-multi-align-x').count()).toBe(1)
      expect(await side.locator('.flg-multi-distribute').count()).toBe(1)

      // Paste is offered but not armed: nothing has been copied. An enabled button that does
      // nothing is worse than a disabled one that says why.
      expect(await side.locator('.flg-multi-paste').isDisabled()).toBe(true)

      // And what reviewers liked is still here: grouping, by name.
      expect(await side.locator('.flg-group-make').textContent()).toBe('Group')

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'duplicating a selection writes one new file per selected feature, in one message',
    async () => {
      const j = await journey()
      const count = await selectEverything(j)
      const before = j.featureFiles()

      // How many of the selection are actually files this editor writes -- the button says so
      // itself, because a marquee also catches vanilla references and group cards.
      const label = (await j.page.locator('#flg-side .flg-multi-duplicate').getAttribute('title')) ?? ''
      const writable = Number(/Write (\d+) new feature file/.exec(label)?.[1] ?? '0')
      expect(writable).toBeGreaterThan(1)
      expect(writable).toBeLessThanOrEqual(count)

      const posted = j.waitForPost('the duplicate batch', (m) => m.type === 'create')
      await j.page.locator('#flg-side .flg-multi-duplicate').click()
      const message = await posted

      // ONE message carrying N files, not N messages: the other end is a file write and a
      // refresh, and N of those is N redraws of a graph that is only right after the last one.
      expect((message['files'] as unknown[]).length).toBe(writable)

      await j.waitForStatus(/Duplicating \d+ features?/)
      await expect
        .poll(() => j.featureFiles().length, { timeout: 15_000 })
        .toBe(before.length + writable)

      // Every new file is a new name. Colliding would have the engine silently pick one of two.
      const added = j.featureFiles().filter((f) => !before.includes(f))
      expect(new Set(added).size).toBe(writable)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'asks before deleting more than one thing, and writes nothing until it is answered',
    async () => {
      const j = await journey()
      await selectEverything(j)
      const before = j.featureFiles()

      await j.page.locator('#flg-side .flg-multi-delete').click()
      // The question, in the shape the panel's other two questions use.
      const confirm = j.page.locator('#flg-side .flg-confirm')
      await confirm.waitFor({ state: 'visible', timeout: 5000 })
      expect(await confirm.textContent()).toMatch(/Delete \d+ features and their files\?/)

      // Nothing has been asked of the host: pressing Delete is raising a question, not answering
      // one, and the single-node path only asks when the ENGINE refuses.
      expect(j.posted.filter((m) => m.type === 'deleteFeature')).toEqual([])
      expect(j.featureFiles()).toEqual(before)

      // Walking away is an answer, and the safe one.
      await j.page.locator('#flg-side .flg-confirm button', { hasText: /^Cancel$/ }).click()
      await j.waitForStatus(/were left alone/)
      expect(j.posted.filter((m) => m.type === 'deleteFeature')).toEqual([])
      expect(j.featureFiles()).toEqual(before)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'copies a selection and pastes it back as new files',
    async () => {
      const j = await journey()
      await selectEverything(j)
      await j.page.locator('#flg-side .flg-multi-copy').click()
      await j.waitForStatus(/Copied \d+ features?/)

      // Copying writes nothing. It is the half of copy-and-paste that people undo by not pasting.
      const before = j.featureFiles()
      expect(j.posted.filter((m) => m.type === 'create')).toEqual([])

      const paste = j.page.locator('#flg-side .flg-multi-paste')
      await paste.waitFor({ state: 'visible' })
      expect(await paste.isDisabled()).toBe(false)
      const posted = j.waitForPost('the paste batch', (m) => m.type === 'create')
      await paste.click()
      const message = await posted
      expect((message['files'] as unknown[]).length).toBeGreaterThan(0)
      await expect.poll(() => j.featureFiles().length, { timeout: 15_000 }).toBeGreaterThan(before.length)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('ejecting a compound', () => {
  /** A Steps compound, expanded so its generated children are on the canvas. */
  async function compoundWithChildrenShowing(j: Journey): Promise<void> {
    await j.openCreationMenu()
    // Patterns is the first category; the menu is arrowed into the way create.test.ts does it.
    await j.page.keyboard.press('Enter')
    await j.clickMenuRow('Steps')
    await j.waitForNode('wiki:steps_1')
    await j.page.locator('#flg-side button', { hasText: 'Show what it produced' }).click()
    await j.waitForNode('wiki:steps_1__item_0')
  }

  it(
    'asks before the first edit that turns it back into ordinary nodes, and writes nothing meanwhile',
    async () => {
      const j = await journey()
      await compoundWithChildrenShowing(j)

      // A generated child. Editing THIS is what discards the compound's settings -- the graph
      // it was expanded into becomes the only record of it, and the parameters are not in it.
      await j.clickNode('wiki:steps_1__item_0')
      const field = j.page.locator('#flg-side .flg-ins-row[data-key="x"] textarea.flg-molang-input').first()
      await field.waitFor({ state: 'visible', timeout: 5000 })
      const editsBefore = j.posted.filter((m) => m.type === 'applyEdits').length

      await field.fill('3')
      await field.press('Tab')

      const confirm = j.page.locator('#flg-side .flg-confirm')
      await confirm.waitFor({ state: 'visible', timeout: 5000 })
      const text = (await confirm.textContent()) ?? ''
      // The sentence is the one collapse.ts writes, not a paraphrase of it: it names the
      // compound, says the settings are discarded, and says nothing can bring them back.
      expect(text).toMatch(/wiki:steps_1/)
      expect(text).toMatch(/cannot be undone/i)
      // And which nodes stop being one node, by name rather than as a count.
      expect(text).toContain('wiki:steps_1__item_0')

      // NOTHING was written. This is the whole point: the old panel let the keystroke through
      // and then told you about it.
      expect(j.posted.filter((m) => m.type === 'applyEdits').length).toBe(editsBefore)

      // Keeping it is the quiet answer, and it abandons the edit rather than applying it.
      await j.page.locator('#flg-side .flg-confirm button', { hasText: /Keep it as a pattern/ }).click()
      await j.waitForStatus(/still a steps/i)
      expect(j.posted.filter((m) => m.type === 'applyEdits').length).toBe(editsBefore)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'goes through with it when the answer is yes, and sends exactly the edit that raised the question',
    async () => {
      const j = await journey()
      await compoundWithChildrenShowing(j)
      await j.clickNode('wiki:steps_1__item_0')
      const field = j.page.locator('#flg-side .flg-ins-row[data-key="x"] textarea.flg-molang-input').first()
      await field.waitFor({ state: 'visible', timeout: 5000 })
      await field.fill('3')
      await field.press('Tab')

      const posted = j.waitForPost('the edit that was held', (m) => m.type === 'applyEdits')
      await j.page.locator('#flg-side .flg-eject-confirm').click()
      const message = await posted
      // The held edit, replayed -- not a reconstruction of it.
      expect((message['edits'] as { json: string }[])[0]?.json).toBe('3')
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
