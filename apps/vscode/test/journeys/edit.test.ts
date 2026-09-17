// edit.test.ts -- changing something that already exists, end to end, and being refused.
//
// The split from create.test.ts is not cosmetic: creation and editing reach the engine through
// two different methods with deliberately different failure rules (createFiles refuses to
// overwrite, applyEdits refuses to create), and they fail in different places in the panel.
// Keeping them apart means a broken write path cannot hide behind a working create path.
//
// Two of the journeys in here found real faults: when they were written they described a
// promise the editor did not keep, so they were marked `it.fails` -- see the comment on each.
// A journey that cannot be written because the product cannot do the thing is a finding, not
// something to write around. Both faults were then fixed and the marking came off, which is
// the whole point of pinning the promise rather than the behaviour.
import * as fs from 'node:fs'
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

/** A comment in a pack file is not decoration -- the compound nodes keep their own settings in
 * one -- so "the file keeps its comments" is a property an editor has to hold. Written into the
 * COPY, never into docs/wiki/tools/fixtures. */
const NOTE = '// a note the author wrote and expects to keep'

function withANote(rel: string) {
  return (packRoot: string): void => {
    const file = `${packRoot}/${rel}`
    fs.writeFileSync(file, `${NOTE}\n${fs.readFileSync(file, 'utf8')}`, 'utf8')
  }
}

/** The first text box of one inspector row, found by the key it edits. */
function field(j: Journey, key: string) {
  return j.page.locator(`#flg-side [data-key=${JSON.stringify(key)}] input.flg-ins-input`).first()
}

/** Types into a control and commits it the way a person does -- the inspector commits on change,
 * which is blur or Enter, never per keystroke. */
async function type(locator: ReturnType<typeof field>, value: string): Promise<void> {
  await locator.fill(value)
  await locator.press('Tab')
}

describe('editing a field', () => {
  /**
   * NO FIELD EDIT EVER REACHES THE FILE.
   *
   * `wire.GraphNode.File` is documented as "the pack-relative path this node was loaded from",
   * and the whole editor is built on that: GraphPanel keeps a node->file table from it, and both
   * `applyEdits` (host side) and `resolveInPack` (engine side) join it onto the pack root. But
   * the builder fills it from `SourceFile.ID`, which pack.go defines as relative to the KIND's
   * directory -- so a feature loaded from `<pack>/features/blocked_gold_block.json` reports
   * `blocked_gold_block.json`, and every consumer looks for `<pack>/blocked_gold_block.json`.
   *
   * The panel says, for any field a person edits:
   *   applyEdits: reading blocked_gold_block.json: open <pack>\blocked_gold_block.json: ...
   * and the file is left exactly as it was. The same root cause breaks "open this node's file"
   * (below) and "preview on select".
   *
   * Nothing on either side can see this. The Go tests that build a GraphNode spell its File as
   * `features/x.json` by hand (cmd/featurelab/graph_test.go, wire/graphcheck_test.go), and
   * apply_test.go is handed pack-relative paths directly, so both halves agree with each other
   * and neither agrees with the builder. On the TypeScript side graphPanel.ts has no test at
   * all. It only shows up where a real graph meets a real applyEdits, which is here.
   *
   * That marking passes while the bug stands and starts FAILING the moment it is fixed --
   * what happened: the journey found the fault, the fault was fixed, and the marking came off.
   * happens, delete the `.fails` and this comment.
   */
  it(
    'a value typed into the inspector reaches the file, and the file keeps its comments',
    async () => {
      const j = await journey({ prepare: withANote('features/blocked_gold_block.json') })
      await j.clickNode('wiki:blocked_gold_block')
      expect(await field(j, 'places_block').inputValue()).toBe('minecraft:gold_block')

      await type(field(j, 'places_block'), 'minecraft:diamond_block')
      // The round trip has landed once the status line has moved off the edit's own label --
      // either onto the redrawn graph's sentence, or onto a refusal.
      await j.waitForStatus(/Showing|refus|cannot|error|reading/i)

      // The outcome: the file on disk holds the new value, and it still holds everything about
      // the file that was not being edited -- the author's comment first of all.
      const text = j.read('features/blocked_gold_block.json')
      expect(text).toContain('minecraft:diamond_block')
      expect(text).toContain(NOTE)
      expect(text).toContain('"may_replace"')

      // And the panel shows what the file says, read back through the engine rather than
      // remembered from the keystroke: away to another node and back again.
      await j.clickNode('wiki:pumpkin_patch_block')
      await j.clickNode('wiki:blocked_gold_block')
      expect(await field(j, 'places_block').inputValue()).toBe('minecraft:diamond_block')
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'an edit the engine refuses is reported, and the panel does not show a change the file never received',
    async () => {
      const j = await journey({ prepare: withANote('features/blocked_gold_block.json') })
      await j.clickNode('wiki:blocked_gold_block')
      expect(await field(j, 'places_block').inputValue()).toBe('minecraft:gold_block')

      // Somebody deletes the file in another window. Every edit from here has to be refused,
      // and refused visibly -- the alternative is a panel quietly displaying a value that
      // exists nowhere.
      //
      // NOTE, while the path bug above stands: the engine refuses every edit anyway, so this
      // journey cannot currently tell the deletion apart from the bug. It is written to hold
      // either way, and once the path bug is fixed it becomes the genuine test of this refusal.
      j.remove('features/blocked_gold_block.json')
      await type(field(j, 'places_block'), 'minecraft:emerald_block')

      const said = await j.waitForStatus(/blocked_gold_block\.json/)
      expect(await j.statusIsError()).toBe(true)
      expect(said.toLowerCase()).toMatch(/cannot find|no such file|reading/)

      // Nothing was written. Not a recreated file, not a half-applied one.
      expect(j.exists('features/blocked_gold_block.json')).toBe(false)

      // And the graph still shows the node, because the panel was never told to believe in a
      // change: a refusal leaves the picture as it was rather than half-updated.
      expect(await j.nodeIds()).toContain('wiki:blocked_gold_block')
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('editing a compound', () => {
  /** Creates a steps node and waits for it to be drawn and selected. Its own journey is in
   * create.test.ts; here it is a starting position. */
  async function aSteps(j: Journey): Promise<void> {
    await j.openCreationMenu()
    await j.page.keyboard.press('Enter') // Patterns is the first category
    await j.clickMenuRow('Steps')
    await j.waitForNode('wiki:steps_1')
  }

  /** One field of the compound's own parameter form, by the parameter it edits. */
  function param(j: Journey, name: string) {
    return j.page.locator(`#flg-side [data-field=${JSON.stringify(name)}] input`).first()
  }

  it(
    "changing a compound's own parameters rewrites the features it generated",
    async () => {
      const j = await journey()
      await aSteps(j)

      // A new steps node places a placeholder in a namespace no pack owns. It is NOT drawn as a
      // dangling node -- one shared constant meant every unfinished thing in the pack converged
      // on a single ghost -- so what the canvas shows is the compound saying it still needs a
      // feature. Pointing it at something real is the first thing anybody does, and it has to
      // rewrite the GENERATED feature, not the compound's own file.
      expect(await j.nodeIds()).not.toContain('example:replace_me')
      expect(await j.sideText()).toMatch(/Needs a feature/)

      const before = await j.graphCount()
      await type(param(j, 'step.0'), 'wiki:pumpkin_patch')
      await j.waitForRedraw(before)

      const child = JSON.parse(j.read('features/steps_1__item_0.json')) as Record<string, { places_feature?: string }>
      expect(child['minecraft:scatter_feature']?.places_feature).toBe('wiki:pumpkin_patch')

      // The canvas followed: the placeholder is gone, and the compound is still ONE node with
      // its subgraph still hidden.
      // It has stopped saying it needs anything, which is the observable half of "the
      // placeholder is gone" now that the ghost itself is never drawn.
      expect(await j.sideText()).not.toMatch(/Needs a feature/)
      const drawn = await j.nodeIds()
      expect(drawn.filter((id) => id.startsWith('wiki:steps_1'))).toEqual(['wiki:steps_1'])

      // Editing a setting must not move the author somewhere else, even though every one of the
      // compound's files was rewritten underneath it.
      expect(await j.selectedNodeId()).toBe('wiki:steps_1')
      expect(await j.sideText()).toContain('Steps')
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a step added to a steps node produces a new feature, and removing it takes that feature away again',
    async () => {
      const j = await journey()
      await aSteps(j)
      expect(j.exists('features/steps_1__item_1.json')).toBe(false)

      await j.page.locator('#flg-side button[aria-label="Add a step at the end of the list"]').click()
      const added = await j.graphCount()
      await type(param(j, 'step.1'), 'wiki:fancy_oak_tree')
      await j.waitForRedraw(added)

      expect(j.exists('features/steps_1__item_1.json')).toBe(true)
      const child = JSON.parse(j.read('features/steps_1__item_1.json')) as Record<string, { places_feature?: string }>
      expect(child['minecraft:scatter_feature']?.places_feature).toBe('wiki:fancy_oak_tree')

      // Removing the step must take its generated feature with it. A branch left behind is
      // delegated to by nothing and indistinguishable from one somebody wrote by hand.
      const removed = await j.graphCount()
      await j.page.locator('#flg-side button[aria-label="Remove step 2"]').click()
      await j.waitForRedraw(removed)

      expect(j.exists('features/steps_1__item_1.json')).toBe(false)
      expect(j.exists('features/steps_1__item_0.json')).toBe(true)
      expect(await j.nodeIds()).not.toContain('wiki:steps_1__item_1')
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('the rest of the wiring', () => {
  it(
    'selecting a node drives the inspector, and the overview is what is shown when nothing is',
    async () => {
      const j = await journey()

      // Nothing selected: the panel answers the two questions somebody has on opening a pack
      // they did not write, and every answer is a thing to click.
      const overview = await j.sideText()
      expect(overview).toMatch(/\d+ features/)
      expect(overview).toContain('Starts here')
      expect(await j.page.locator('#flg-side .flg-jump').count()).toBeGreaterThan(0)

      // A jump link selects the node it names and takes you to it -- the reason it is a button
      // and not a line of text.
      const jump = j.page.locator('#flg-side .flg-jump').first()
      const target = (await jump.textContent()) ?? ''
      expect(target).not.toBe('')
      await jump.click()
      expect(await j.selectedNodeId()).toBe(target)
      const box = await j.nodeBox(target)
      const canvas = await j.page.locator('#flg-canvas').boundingBox()
      expect(canvas).not.toBeNull()
      expect(box.x).toBeGreaterThan((canvas?.x ?? 0) - box.width)
      expect(box.x).toBeLessThan((canvas?.x ?? 0) + (canvas?.width ?? 0))

      // The panel is now that node's fields, and clicking a different node moves it. Which node
      // the panel is about is read off the rename box, the one place the identifier appears now
      // -- the inspector used to head itself with the same string the input below it held.
      const showing = j.page.locator('#flg-side input[aria-label="Identifier"]')
      expect(await showing.inputValue()).toBe(target)
      await j.clickNode('wiki:blocked_gold_block')
      expect(await j.selectedNodeId()).toBe('wiki:blocked_gold_block')
      expect(await showing.inputValue()).toBe('wiki:blocked_gold_block')
      const side = await j.sideText()
      expect(side).toContain('places_block')
      expect(side).not.toContain('Starts here')
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a card dragged across the canvas keeps its new place, and the pack files are not touched',
    async () => {
      const j = await journey()
      const id = 'wiki:blocked_gold_block'
      await j.clickNode(id)

      const before = await j.graphPosition(id)
      const { camera } = await j.viewportState()
      const box = await j.nodeBox(id)
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await j.page.mouse.move(from.x, from.y)
      await j.page.mouse.down()
      await j.page.mouse.move(from.x + 90, from.y + 70, { steps: 6 })
      await j.page.mouse.up()

      // It went where it was dragged, to within the alignment snap: a drop lands on a
      // neighbour's edge when it is close to one, which is deliberate, so this allows for it
      // rather than pinning the pixel. Where it actually landed is what the next two checks
      // hold the sidecar and the redraw to, and that is the part that matters.
      const after = await j.graphPosition(id)
      expect(after.x - before.x).toBeGreaterThan(90 / camera.zoom - 8)
      expect(after.x - before.x).toBeLessThan(90 / camera.zoom + 8)
      expect(after.y - before.y).toBeGreaterThan(70 / camera.zoom - 8)
      expect(after.y - before.y).toBeLessThan(70 / camera.zoom + 8)

      // The arrangement is saved to the SIDECAR, never into the pack. A position is not
      // something the game reads, so writing one into a feature would show up as a change to
      // the pack in version control every time somebody tidied the canvas.
      await expect.poll(() => j.exists('.featurelab-layout.json'), { timeout: 10_000 }).toBe(true)
      const sidecar = JSON.parse(j.read('.featurelab-layout.json')) as { nodes: Record<string, { x: number; y: number }> }
      expect(sidecar.nodes[id]?.x).toBeCloseTo(after.x, 0)
      expect(sidecar.nodes[id]?.y).toBeCloseTo(after.y, 0)
      expect(j.read('features/blocked_gold_block.json')).not.toContain(String(Math.round(after.x)))

      // And it survives the next redraw, which is the point of writing it down at all.
      const redraws = await j.graphCount()
      await j.panel.refresh()
      await j.waitForRedraw(redraws)
      const later = await j.graphPosition(id)
      expect(later.x).toBeCloseTo(after.x, 0)
      expect(later.y).toBeCloseTo(after.y, 0)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  /**
   * A SAVE MADE OUTSIDE THE PANEL NEVER REACHES THE GRAPH.
   *
   * extension.ts wires `onDidSaveTextDocument` to `GraphPanel.notifyFileSaved`, whose whole
   * stated purpose is that "the JSON is the source of truth, so an edit made in a text editor is
   * as real as one made inside the panel". It calls `refresh()`, which calls
   * `PreviewController.graph()`, which calls `ensurePackLoaded` -- and that returns immediately
   * for a pack that is already loaded. The engine's `graph` method then builds from
   * `state.loaded`, the source files it parsed at load time. Nothing on the path re-reads disk,
   * so the panel redraws the graph it already had.
   *
   * PreviewPanel has the matching method right: its `notifyPackFileSaved` goes through
   * `reloadPackFile`, which is the call that tells the engine to re-read. The graph panel needs
   * the same one (or `reloadPack`) before its refresh.
   *
   * It hides because the engine and the panel share one process: with a preview panel open on
   * the same pack, ITS save handler reloads the file and the graph panel's next refresh
   * accidentally sees the change. With only the graph open -- which is the whole point of the
   * graph -- nothing does.
   *
   * A new file is used here because it is unambiguous, but a changed one is just as stale.
   */
  it(
    'a file saved outside the panel redraws the graph',
    async () => {
      const j = await journey()
      expect(await j.nodeIds()).not.toContain('wiki:hand_written')

      // The JSON is the source of truth, so an edit made in a text editor is as real as one
      // made in the panel. This is what extension.ts's save handler does.
      j.write(
        'features/hand_written.json',
        JSON.stringify(
          {
            format_version: '1.21.110',
            'minecraft:single_block_feature': {
              description: { identifier: 'wiki:hand_written' },
              places_block: 'minecraft:obsidian',
            },
          },
          null,
          2,
        ) + '\n',
      )
      const before = await j.graphCount()
      await j.notifySaved('features/hand_written.json')
      await j.waitForRedraw(before)

      expect(await j.nodeIds()).toContain('wiki:hand_written')
      await j.clickNode('wiki:hand_written')
      expect(await j.sideText()).toContain('wiki:hand_written')
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  /**
   * the same `GraphNode.File` fault as above (see the first test in this file).
   * Double-clicking a node asks the host to open its JSON beside the graph; the host joins the
   * reported file onto the pack root, the path does not exist, and the panel reports
   * "cannot open <pack>\blocked_gold_block.json" instead of opening anything.
   *
   * What this journey can check is limited, and honestly so: there is no VS Code here, so
   * "opened beside the graph" can only be observed as "the host asked to open THIS path, in the
   * column beside" -- see vscodeStub.ts. The path is the part that is wrong, and the path is
   * the part this can see.
   */
  it(
    'double-clicking a node opens the file that node came from',
    async () => {
      const j = await journey()
      await j.activateNode('wiki:blocked_gold_block')
      await expect.poll(() => j.openedDocuments.length, { timeout: 5_000 }).toBe(1)
      expect(j.openedDocuments[0]?.fsPath).toBe(j.file('features/blocked_gold_block.json'))
      expect(j.openedDocuments[0]?.shownIn).toBe(2)
    },
    JOURNEY_TIMEOUT_MS,
  )
})
