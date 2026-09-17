// browse.test.ts -- finding a node, renaming it, deleting it. End to end, by mouse and
// keyboard, over a real pack.
//
// These three are WIRED TODAY. That is exactly why they are pinned here: search, rename and
// delete each live in a module with its own thorough unit suite (graphSearch.test.ts,
// graphLifecycle.test.ts), and none of those suites would notice if webview/graph.ts stopped
// calling into them. src/graph/molangEdge.ts is what that looks like once it has happened -- a
// complete, tested, shipped module that nothing in the editor imports -- and it is the reason
// this directory exists. A journey is the only thing standing between these three and the same
// fate.
//
// Every assertion is about an outcome a person can see or a file they can open. Where the
// posted host message is checked as well, it is checked ALONGSIDE the file, never instead of
// it: see harness.ts's HostMessage for why a message on its own is not enough.
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

/** A feature nothing in the fixture pack delegates to, so deleting it is allowed. */
const UNREFERENCED = 'wiki:diamond_vein'
const UNREFERENCED_FILE = 'features/ore_diamond_vein.json'
/** A feature exactly one other file delegates to, so deleting it is refused and renaming it has
 * to rewrite that other file. */
const REFERENCED = 'wiki:blocked_gold_block'
const REFERENCED_FILE = 'features/blocked_gold_block.json'
const REFERRER_FILE = 'features/conditional_list_early_out.json'
/** A feature exactly one thing delegates to, through a slot that thing CANNOT LOAD WITHOUT -- a
 * scatter's `places_feature`. This is the case that had no way past it at all: the delegation
 * could not be removed without stopping features/ceiling_slab_scatter.json loading, so the whole
 * delete was refused however the author answered. */
const REQUIRED_BY = 'wiki:ceiling_slab_block'
const REQUIRED_BY_FILE = 'features/ceiling_slab_block.json'
const REQUIRING = 'wiki:ceiling_slab_scatter'
const REQUIRING_FILE = 'features/ceiling_slab_scatter.json'
/** graph/compounds/spec.ts's PLACEHOLDER_FEATURE, spelled out rather than imported: this is an
 * assertion about what ends up in somebody's pack file, and a constant that moved would rewrite
 * the assertion along with the product. */
const PLACEHOLDER = 'example:replace_me'

describe('finding a node', () => {
  it(
    'typing a name into the search box narrows the canvas to it and takes you there',
    async () => {
      const j = await journey()
      const everything = (await j.nodeIds()).length
      expect(everything).toBeGreaterThan(20)

      // The search box is part of the toolbar the panel opens with -- nothing has to be opened
      // first, which is the point of putting it there.
      const box = j.page.locator('#flg-search input')
      await box.waitFor({ state: 'visible', timeout: 20_000 })
      await box.click()
      await box.pressSequentially('diamond', { delay: 15 })

      // Typing lists what matched. It does NOT narrow the canvas: the results change on every
      // keystroke, and a canvas that followed would flicker through a different subset of the
      // pack per character.
      const row = j.page.locator('#flg-search .fls-row').first()
      await row.waitFor({ state: 'visible', timeout: 20_000 })
      expect(await j.page.locator('#flg-search .fls-row').first().textContent()).toContain('diamond')
      expect((await j.nodeIds()).length).toBe(everything)

      // Choosing a result selects that node and takes you to it -- a result you cannot act on is
      // a list, not a search.
      await row.click()
      await expect.poll(() => j.selectedNodeId(), { timeout: 20_000 }).toBe(UNREFERENCED)
      // In the rename box, which is where the identifier lives now: the inspector used to repeat
      // it as a heading directly above that input, and the copy that can DO something with the
      // name is the one worth keeping. Found by its accessible name, not by a class.
      expect(await j.page.locator('#flg-side input[aria-label="Identifier"]').inputValue()).toBe(UNREFERENCED)

      // Ctrl+Enter is the deliberate second step: narrow the canvas to the matches and their
      // neighbours, and say so in the status line.
      await box.click()
      await box.press('Control+Enter')
      await expect.poll(async () => (await j.nodeIds()).length, { timeout: 20_000 }).toBeLessThan(everything)
      expect(await j.nodeIds()).toContain(UNREFERENCED)
      expect(await j.status()).toMatch(/Showing \d+ of \d+/)

      // Escape puts the rest of the pack back, which the status line promises in so many words.
      await box.press('Escape')
      await expect.poll(async () => (await j.nodeIds()).length, { timeout: 20_000 }).toBe(everything)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('renaming a node', () => {
  it(
    'a new identifier typed over the old one rewrites the declaration and repoints what delegated to it',
    async () => {
      const j = await journey()
      await j.clickNode(REFERENCED)

      expect(j.read(REFERRER_FILE)).toContain(REFERENCED)

      // The name is the heading of the panel and is an editable field, so renaming is typing
      // over it -- found by the label a screen reader would read out, not by a class.
      const name = j.page.locator('#flg-side input[aria-label="Identifier"]')
      await name.waitFor({ state: 'visible', timeout: 20_000 })
      expect(await name.inputValue()).toBe(REFERENCED)

      const before = await j.graphCount()
      await name.fill('wiki:polished_gold_block')
      await name.press('Enter')
      await j.waitForRedraw(before)

      // The outcome, on disk. The FILE deliberately keeps its name -- a feature's file name is
      // not its identifier, and the engine says so in as many words (only a feature RULE is
      // compared against its file name, and it logs rather than refuses). What has to change is
      // the declaration and every delegation into it: a rename that left the referrer behind
      // would leave the pack with a dangling reference the author never made.
      await expect
        .poll(() => j.read(REFERENCED_FILE).includes('wiki:polished_gold_block'), { timeout: 20_000 })
        .toBe(true)
      expect(j.read(REFERENCED_FILE)).not.toContain(REFERENCED)
      expect(j.read(REFERRER_FILE)).toContain('wiki:polished_gold_block')
      expect(j.read(REFERRER_FILE)).not.toContain(REFERENCED)

      // And on the canvas: the node is there under its new name and gone under the old one.
      await j.waitForNode('wiki:polished_gold_block')
      expect(await j.nodeIds()).not.toContain(REFERENCED)

      // The request that carried it named both ends. Checked alongside the files rather than
      // instead of them -- see this file's header.
      const request = j.posted.find((m) => m.type === 'renameFeature')
      expect(request).toMatchObject({ from: REFERENCED, to: 'wiki:polished_gold_block' })

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a name the editor knows it cannot use is refused before anything is written',
    async () => {
      const j = await journey()
      await j.clickNode(UNREFERENCED)
      const filesBefore = j.featureFiles()

      const name = j.page.locator('#flg-side input[aria-label="Identifier"]')
      await name.fill('wiki:pumpkin_patch') // already somebody else's
      await name.press('Enter')

      // The refusal is shown, the field snaps back to the name that is still true, and nothing
      // on disk moved. A rename onto an existing feature would silently destroy it.
      await j.waitForStatus(/pumpkin_patch|exists|already|taken/i)
      expect(await j.statusIsError()).toBe(true)
      await expect.poll(() => name.inputValue(), { timeout: 20_000 }).toBe(UNREFERENCED)
      expect(j.featureFiles()).toEqual(filesBefore)
      expect(j.posted.some((m) => m.type === 'renameFeature')).toBe(false)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('deleting a node', () => {
  it(
    'deleting a feature nothing uses takes its file and its card away',
    async () => {
      const j = await journey()
      await j.clickNode(UNREFERENCED)
      expect(j.exists(UNREFERENCED_FILE)).toBe(true)

      await j.page.locator('#flg-side button', { hasText: 'Delete' }).click()

      await j.waitForNodeGone(UNREFERENCED)
      await expect.poll(() => j.exists(UNREFERENCED_FILE), { timeout: 20_000 }).toBe(false)
      // Nothing is left selected, because what was selected is not there any more.
      expect(await j.selectedNodeId()).toBeNull()

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'the Delete key removes the selected node, the same way the button does',
    async () => {
      // Reported twice: "klikanie delete na zaznaczony node nie robi nic", then "jako klawisz".
      // The button worked; nothing was bound to the key at all -- `Delete` existed only as the
      // text ON that button.
      const j = await journey()
      await j.clickNode(UNREFERENCED)
      expect(j.exists(UNREFERENCED_FILE)).toBe(true)

      await j.page.keyboard.press('Delete')

      await j.waitForNodeGone(UNREFERENCED)
      await expect.poll(() => j.exists(UNREFERENCED_FILE), { timeout: 20_000 }).toBe(false)
      expect(await j.selectedNodeId()).toBeNull()
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'the Delete key is inert while the caret is in a text field',
    async () => {
      // A shortcut that destroys a file while somebody is editing its name is worse than no
      // shortcut. The caret goes to the END of the rename box so the keypress has no character
      // to remove -- otherwise the test renames the node and then measures the wrong thing,
      // which is exactly what the first version of it did.
      const j = await journey()
      await j.clickNode(UNREFERENCED)
      const rename = j.page.locator('#flg-side input').first()
      await rename.click()
      await j.page.keyboard.press('End')
      await j.page.keyboard.press('Delete')
      await j.page.waitForTimeout(400)

      expect(j.exists(UNREFERENCED_FILE), 'Delete in a text field deleted the node').toBe(true)
      expect(await j.nodeIds()).toContain(UNREFERENCED)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'deleting a feature something still delegates to is refused, and the refusal names the referrer',
    async () => {
      const j = await journey()
      await j.clickNode(REFERENCED)

      await j.page.locator('#flg-side button', { hasText: 'Delete' }).click()

      // The refusal has to NAME what is still using it. "Cannot delete" alone sends the author
      // hunting through the pack for a reference the editor already knows about.
      const said = await j.waitForStatus(/conditional_list_early_out/)
      expect(said).toContain('wiki:conditional_list_early_out')
      expect(await j.statusIsError()).toBe(true)

      // And the file is still there, along with the card and the edge into it.
      expect(j.exists(REFERENCED_FILE)).toBe(true)
      expect(await j.nodeIds()).toContain(REFERENCED)
      expect((await j.edges()).some((e) => e.from === 'wiki:conditional_list_early_out')).toBe(true)
      // Nothing was asked of the host at all: the plan refused locally, which is the point of
      // planning locally.
      expect(j.posted.some((m) => m.type === 'deleteFeature')).toBe(false)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'the refusal offers to go ahead, and says which files that would touch',
    async () => {
      // The refusal used to be the end of the road: the panel always asked with
      // detachReferences: false and never offered the other answer, so a feature anything
      // delegated to could not be deleted from this editor at all. One extra click, not a wall.
      const j = await journey()
      await j.clickNode(REQUIRED_BY)
      await j.page.locator('#flg-side button', { hasText: 'Delete' }).click()

      const go = j.page.getByRole('button', { name: 'Delete anyway' })
      await go.waitFor({ state: 'visible', timeout: 20_000 })

      // The list of referrers is what the author decides FROM, so it is still there in full --
      // beside a plain account of which files going ahead would change.
      const asked = await j.sideText()
      expect(asked).toContain(REQUIRING)
      expect(asked).toContain(REQUIRING_FILE)
      expect(asked).toContain(REQUIRED_BY_FILE)

      // And nothing has happened yet: a question is not a deletion.
      expect(j.exists(REQUIRED_BY_FILE)).toBe(true)
      expect(j.posted.some((m) => m.type === 'deleteFeature')).toBe(false)

      // Cancel means cancel -- the pack, the card and the edge are all exactly as they were.
      await j.page.getByRole('button', { name: 'Cancel' }).click()
      await j.waitForStatus(/left alone/)
      expect(j.exists(REQUIRED_BY_FILE)).toBe(true)
      expect(j.read(REQUIRING_FILE)).toContain(REQUIRED_BY)
      expect(j.posted.some((m) => m.type === 'deleteFeature')).toBe(false)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'going ahead deletes it and leaves the node that needed it saying it needs a feature',
    async () => {
      // THE JOURNEY THIS CHANGE EXISTS FOR. wiki:ceiling_slab_scatter cannot load without a
      // places_feature, so removing that key would break its file and the whole delete used to
      // stop there. Now the reference is pointed at the placeholder: the author gets their
      // deletion, the scatter still loads, and the thing that needs a decision is marked ON THE
      // CARD instead of being described in a refusal they read once.
      const j = await journey()
      await j.clickNode(REQUIRED_BY)
      await j.page.locator('#flg-side button', { hasText: 'Delete' }).click()
      const go = j.page.getByRole('button', { name: 'Delete anyway' })
      await go.waitFor({ state: 'visible', timeout: 20_000 })
      await go.click()

      await j.waitForNodeGone(REQUIRED_BY)
      await expect.poll(() => j.exists(REQUIRED_BY_FILE), { timeout: 20_000 }).toBe(false)

      // The referring file was REWRITTEN, not emptied: the key it cannot load without is still
      // there, naming the stand-in.
      const scatter = j.read(REQUIRING_FILE)
      expect(scatter).toContain('places_feature')
      expect(scatter).toContain(PLACEHOLDER)
      expect(scatter).not.toContain(REQUIRED_BY)

      // And the editor says so where the author will meet it. The node is selected and centred,
      // because its panel is the one with the button that fills the slot -- landing somebody on
      // the fix beats describing it.
      await expect.poll(() => j.selectedNodeId(), { timeout: 20_000 }).toBe(REQUIRING)
      const side = await j.sideText()
      expect(side).toContain('Needs a feature')
      expect(side).toContain('Choose a feature')
      expect(await j.status()).toContain(REQUIRING)

      // No ghost. The placeholder is a presentation concern, not a node: drawing one would put a
      // card nobody made on the canvas, which is the bug graph/incomplete.ts exists to remove.
      expect(await j.nodeIds()).not.toContain(PLACEHOLDER)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('the preview follows the selection, until it is closed', () => {
  it(
    'closing the preview turns "Preview on select" off instead of reopening it on the next click',
    async () => {
      // Reported as "jak raz klikne na Preview on select to nawet po zamknieciu podgladu on
      // wciaz wraca": the toggle stayed on after the panel was shut, so the next node clicked
      // reopened the panel they had just closed, with no way to stop it but closing the graph.
      const j = await journey()
      const toggle = j.page.getByRole('button', { name: 'Preview on select' })
      await toggle.click()
      expect(await toggle.getAttribute('aria-pressed')).toBe('true')

      await j.clickNode(REFERENCED)
      await expect.poll(() => j.posted.filter((m) => m.type === 'previewNode').length, { timeout: 20_000 }).toBe(1)

      // What the extension does when the preview panel this graph opened is disposed.
      j.panel.previewClosed()
      await expect.poll(() => toggle.getAttribute('aria-pressed'), { timeout: 20_000 }).toBe('false')

      // The next click selects, and asks for nothing. The selection and the graph are untouched
      // by the close: it means "I am done looking", not "undo what I was looking at".
      await j.clickNode(UNREFERENCED)
      expect(await j.selectedNodeId()).toBe(UNREFERENCED)
      await j.page.waitForTimeout(500)
      expect(j.posted.filter((m) => m.type === 'previewNode').length).toBe(1)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
