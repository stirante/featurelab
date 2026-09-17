// create.test.ts -- making a node, end to end.
//
// Every assertion here is about an OUTCOME: a file that exists on disk with the contents the
// engine wrote, a card drawn on the canvas, a position in graph coordinates, a sentence in the
// status line. Nothing asserts that a message of some type was posted -- a message is a
// mechanism and would keep passing after the feature broke, which is exactly how the
// expand-and-never-collapse bug survived a green suite on both halves.
//
// See harness.ts for what is real (the built webview under the real CSP, the real GraphPanel,
// the real engine over a temp copy of the pack) and what is not.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeStub.js'))

import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from '../../src/graph/render.js'
import { closeSharedBrowser, openJourney, JOURNEY_TIMEOUT_MS, type Journey } from './harness.js'

/** Every journey opened in this file, so a test that throws still gets its temp pack, its
 * engine process and its browser context torn down. */
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

/** Opens the creation menu's first-level category. The category is opened with the KEYBOARD --
 * arrow to it, Enter -- because a mouse click on a category row does nothing at all. That is a
 * product bug, not a harness limitation, and it is pinned by its own test at the bottom of this
 * file rather than worked around silently here. Arrowing and pressing Enter is a real way a
 * person opens a menu, so the rest of the journey is still driven the way a person drives it. */
async function openCategory(j: Journey, index: number): Promise<void> {
  for (let i = 0; i < index; i++) await j.page.keyboard.press('ArrowDown')
  await j.page.keyboard.press('Enter')
}

// Positions in the first-level category list, which is PALETTE_CATEGORIES in order. They are
// indices because the menu is arrowed through; a category added above one of these moves it, which
// is what happened when feature rules became creatable and gained a category of their own.
const PATTERNS = 0
const PLACE_BLOCKS = 2
const SCATTER_AND_SPREAD = 4

/** A compound's own file carries its recorded settings as a `//` comment, which the game's
 * parser and the engine both accept and JSON.parse does not. */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('creating a node', () => {
  it(
    'a created scatter is a file the engine accepts, not one it refuses',
    async () => {
      // A real pack ended up with a scatter this editor had written and the engine would not
      // load: flat `iterations` and no `distribution` at all, in a 1.21.110 file where the flat
      // keys do not exist and `distribution` is required. The author could not repair it either,
      // because writing into an absent `distribution` was silently refused -- so the section they
      // needed looked inert. Both halves are fixed; this is the guard.
      //
      // It asserts through the ENGINE, not against the catalogue. A test that checks the seeded
      // body against the same table that produced it agrees with itself and proves nothing about
      // whether the file loads.
      const j = await journey()
      await j.openCreationMenu()
      await openCategory(j, SCATTER_AND_SPREAD)
      await j.clickMenuRow('Scatter')
      await j.waitForNode('wiki:scatter_1')

      const body = (JSON.parse(j.read('features/scatter_1.json')) as Record<string, Record<string, unknown>>)[
        'minecraft:scatter_feature'
      ]
      expect(body).toBeDefined()
      // The version-correct shape: the nested object exists, and the legacy spellings are not
      // beside it. Writing both is how a file loads in one band and silently ignores half its
      // settings in the other.
      expect(body).toHaveProperty('distribution')
      expect(body).not.toHaveProperty('iterations')
      expect(body).not.toHaveProperty('x')

      // The two REQUIRED keys, asserted on the file. This journey used to pass on a scatter the
      // engine refused twice over: it checked that the panel did not say "refused" or "must be an
      // object", and the engine's actual messages were "places_feature must be a non-empty feature
      // reference string" and "distribution.iterations must be a number or Molang string" --
      // neither matched, so a file that did not load read as a pass. The seed wrote neither key:
      // `places_feature` is an edge and `iterations` rides on that edge, so the type catalogue the
      // seed reads from describes neither.
      expect(body!['places_feature'], 'a scatter without places_feature is refused').toEqual(expect.any(String))
      expect((body!['distribution'] as Record<string, unknown>)['iterations'], 'a scatter without iterations is refused').toBeDefined()

      // And the engine agrees: nothing on screen says this pack now holds a file it refused.
      const shown = await j.sideText()
      expect(shown).not.toMatch(/scatter_1\.json/)
      expect(shown.toLowerCase()).not.toMatch(/refused|must be an object/)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a plain feature picked from the palette exists afterwards, selected, with a file behind it',
    async () => {
      const j = await journey()

      // Nothing is selected to begin with, so the panel is showing the overview rather than a
      // node's fields.
      expect(await j.selectedNodeId()).toBeNull()
      expect(j.exists('features/single_block_1.json')).toBe(false)

      await j.openCreationMenu()
      await openCategory(j, PLACE_BLOCKS)
      await j.clickMenuRow('Single block')

      // The node exists because its FILE exists. The engine wrote it, re-read the pack and
      // handed back a graph that contains it; nothing here was drawn optimistically.
      await j.waitForNode('wiki:single_block_1')
      expect(j.exists('features/single_block_1.json')).toBe(true)
      const written = JSON.parse(j.read('features/single_block_1.json')) as Record<string, unknown>
      expect(written['format_version']).toBe('1.21.110')
      expect(written['minecraft:single_block_feature']).toMatchObject({
        description: { identifier: 'wiki:single_block_1' },
      })

      // It is selected, it is on screen, and the panel is showing ITS fields rather than the
      // overview it was showing a moment ago.
      expect(await j.selectedNodeId()).toBe('wiki:single_block_1')
      // The identifier is read off the rename box rather than out of the panel's text: the
      // inspector no longer repeats it as a heading over the input that already holds it.
      expect(await j.page.locator('#flg-side input[aria-label="Identifier"]').inputValue()).toBe('wiki:single_block_1')
      expect(await j.status()).toContain('Created wiki:single_block_1')
      expect(await j.statusIsError()).toBe(false)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a feature dragged onto a spot lands on that spot, not where the layout would have put it',
    async () => {
      const j = await journey()

      // Two drops, at two points chosen here rather than by any layout. The camera MOVES
      // between them -- creating a node centres the view on it -- so the second drop also
      // proves the conversion reads the camera at drop time rather than at menu-open time.
      const drops = [
        { x: 420, y: 300 },
        { x: 760, y: 620 },
      ]
      const landed: { x: number; y: number }[] = []
      const expected: { x: number; y: number }[] = []

      for (const [index, drop] of drops.entries()) {
        await j.openCreationMenu()
        await openCategory(j, PLACE_BLOCKS)
        // Where the pointer is, in graph coordinates, at the moment of the drop. Written out
        // rather than imported so this is an independent statement of where the author pointed.
        const { camera, origin } = await j.viewportState()
        expected.push({
          x: camera.x + (drop.x - origin.x) / camera.zoom - GRAPH_NODE_WIDTH / 2,
          y: camera.y + (drop.y - origin.y) / camera.zoom - GRAPH_NODE_HEIGHT / 2,
        })
        await j.dragMenuRowTo('Single block', drop)
        const id = `wiki:single_block_${index + 1}`
        await j.waitForNode(id)
        landed.push(await j.graphPosition(id))
      }

      // The box is centred on the point it was released over, to the pixel. A node the layout
      // placed would be on the layout's own grid; landing within a pixel of two arbitrary
      // points, twice, under two different cameras, is not something a layout does by accident.
      for (const [index, at] of landed.entries()) {
        const want = expected[index]
        expect(want).toBeDefined()
        expect(Math.abs(at.x - (want?.x ?? NaN))).toBeLessThan(1.5)
        expect(Math.abs(at.y - (want?.y ?? NaN))).toBeLessThan(1.5)
      }
      // And the two really are in different places, which is the whole claim.
      expect(Math.abs((landed[1]?.x ?? 0) - (landed[0]?.x ?? 0))).toBeGreaterThan(100)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a compound comes back as ONE collapsed node, its generated children hidden and its edges re-pointed at it',
    async () => {
      const j = await journey()
      const drawnBefore = (await j.nodeIds()).length

      await j.openCreationMenu()
      await openCategory(j, PATTERNS)
      await j.clickMenuRow('Steps')
      await j.waitForNode('wiki:steps_1')

      // THREE files were written: the compound and the two features it expands into. This is
      // the half the unit tests already cover -- it is here because the interesting question is
      // what the canvas does with them.
      expect(j.exists('features/steps_1.json')).toBe(true)
      expect(j.exists('features/steps_1__item_0.json')).toBe(true)
      expect(j.exists('features/steps_1__aggregate.json')).toBe(true)

      // ONE node, not three. The children are on disk and in the engine's graph, and the canvas
      // does not draw them.
      const drawn = await j.nodeIds()
      expect(drawn.filter((id) => id.startsWith('wiki:steps_1'))).toEqual(['wiki:steps_1'])
      expect(drawn).not.toContain('wiki:steps_1__item_0')
      expect(drawn).not.toContain('wiki:steps_1__aggregate')

      // The placeholder the seeded steps node points at is NOT drawn, and that is the current
      // contract rather than an oversight. It used to be: the ghost appeared as a dangling
      // reference, and because the placeholder is one shared constant, every unfinished thing in
      // the pack resolved to that same node and arrived joined to everything else made that
      // minute. A user building a pack from scratch reported exactly that.
      //
      // What replaces it is a slot the compound says it is waiting for -- see
      // src/graph/incomplete.ts. The file still holds a loadable reference, asserted below,
      // because omitting the key makes the engine refuse the file and a refused file has no node
      // to put a badge on.
      expect(drawn).not.toContain('example:replace_me')
      const child = JSON.parse(j.read('features/steps_1__item_0.json')) as Record<string, { places_feature?: string }>
      expect(child['minecraft:scatter_feature']?.places_feature).toBe('example:replace_me')
      const owner = JSON.parse(stripLineComments(j.read('features/steps_1.json'))) as Record<string, { places_feature?: string }>
      expect(owner['minecraft:scatter_feature']?.places_feature).toBe('wiki:steps_1__aggregate')

      const edges = await j.edges()
      // No edge leaves it: its one delegation is the placeholder, which is not drawn.
      expect(edges.filter((e) => e.from === 'wiki:steps_1')).toHaveLength(0)
      // Nothing is drawn leaving a node that is not there. An edge from a hidden child would be
      // a line starting in empty space, and an edge into the removed ghost would be one ending
      // in it.
      for (const edge of edges) expect(drawn).toContain(edge.from)

      // A compound is ONE node on the canvas. One, not two: the placeholder it points at used to
      // arrive as a second node, and that is what is gone.
      expect((await j.nodeIds()).length).toBe(drawnBefore + 1)

      // And the panel is showing it AS a compound -- its own settings, not the scatter it
      // happens to expand into.
      expect(await j.selectedNodeId()).toBe('wiki:steps_1')
      const side = await j.sideText()
      expect(side).toContain('Steps')
      expect(side).toContain('Show what it produced')

      // And it says what it is still waiting for, which is what took the ghost's place. Phrased
      // as the next action, not as a fault in the file.
      expect(side).toMatch(/Needs a feature/)
      expect(side).not.toMatch(/unresolved|dangling/i)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'opening a compound up shows the features it produced, and folding it back hides them again',
    async () => {
      const j = await journey()
      await j.openCreationMenu()
      await openCategory(j, PATTERNS)
      await j.clickMenuRow('Steps')
      await j.waitForNode('wiki:steps_1')

      // This is the journey the shipped bug was on: a compound that expanded into files and
      // could not be collapsed again. Expanding and re-collapsing is a way of LOOKING, so it
      // must not touch a file or need a round trip -- and the files are checked after both, to
      // say so.
      const filesBefore = j.featureFiles()

      await j.page.locator('#flg-side button', { hasText: 'Show what it produced' }).click()
      await j.waitForNode('wiki:steps_1__item_0')
      expect(await j.nodeIds()).toContain('wiki:steps_1__aggregate')

      await j.page.locator('#flg-side button', { hasText: 'Hide what it produced' }).click()
      await j.waitForNodeGone('wiki:steps_1__item_0')
      expect(await j.nodeIds()).not.toContain('wiki:steps_1__aggregate')
      expect(await j.nodeIds()).toContain('wiki:steps_1')

      expect(j.featureFiles()).toEqual(filesBefore)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('refusing to create', () => {
  it(
    'a name that is already taken is refused, the panel says so, and the file in the way is untouched',
    async () => {
      const j = await journey()

      // Somebody else's file, at the path the editor is about to compose, written after the
      // panel read the pack -- so the panel does not know about it and will propose exactly
      // that name. This is not contrived: a second window, a git checkout and a generator all
      // do this, and it is the commonest refusal the engine has.
      const squatter = '{\n  "format_version": "1.21.110",\n  "minecraft:single_block_feature": {\n    "description": { "identifier": "wiki:not_yours" },\n    "places_block": "minecraft:obsidian"\n  }\n}\n'
      j.write('features/single_block_1.json', squatter)
      const nodesBefore = await j.nodeIds()

      await j.openCreationMenu()
      await openCategory(j, PLACE_BLOCKS)
      await j.clickMenuRow('Single block')

      // The panel SAYS so, in the status line, as an error.
      const said = await j.waitForStatus(/already exists/)
      expect(said).toContain('features/single_block_1.json')
      expect(said).toContain('nothing was written')
      expect(await j.statusIsError()).toBe(true)

      // And nothing changed: the file in the way still holds what it held, and the canvas shows
      // exactly the nodes it showed before -- no optimistically drawn node for a file that was
      // never written.
      expect(j.read('features/single_block_1.json')).toBe(squatter)
      expect(await j.nodeIds()).toEqual(nodesBefore)
      expect(await j.selectedNodeId()).toBeNull()

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a type the engine cannot build is listed and refuses to be picked, with the reason',
    async () => {
      const j = await journey()
      await j.openCreationMenu()
      await openCategory(j, PLACE_BLOCKS)

      // Nothing is hidden for being unusable -- a type someone knows exists has to be findable,
      // and an empty space where it should be teaches them the editor is broken. So it is
      // listed, disabled, with the reason.
      const blocked = j.page.locator('.flp-row[aria-disabled="true"]').first()
      await expect.poll(() => blocked.count(), { timeout: 20_000 }).toBeGreaterThan(0)
      expect(((await blocked.locator('.flp-row-name').textContent()) ?? '').length).toBeGreaterThan(0)
      // The reason, in words, on the row itself.
      expect(((await blocked.locator('.flp-row-blocked').textContent()) ?? '').length).toBeGreaterThan(0)

      const filesBefore = j.featureFiles()
      // `force` only because Playwright refuses to click anything carrying aria-disabled; the
      // press itself is a real one, and pressing a blocked row is exactly what a person does
      // when they have not read the reason yet.
      await blocked.click({ force: true })
      // A blocked row is still pressable -- that is how its reason gets announced -- and it
      // still creates nothing. The menu stays open and no file appears.
      await expect.poll(() => j.page.locator('.flp-menu:not([hidden])').count(), { timeout: 20_000 }).toBe(1)
      expect(j.featureFiles()).toEqual(filesBefore)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// A pinned product bug
// ---------------------------------------------------------------------------

/**
 * CLICKING A CATEGORY IN THE CREATION MENU DOES NOTHING.
 *
 * The menu's only pointer entry point is `list`'s `pointerdown` handler, and its first line is
 * `if (event.button !== 0 || row.target.kind !== 'item') return` -- so a press on a CATEGORY row
 * is dropped before anything happens, and `activate()` (which handles `kind === 'category'` by
 * opening it) is only ever reached from the keyboard handler or from the end of a drag. The
 * category rows carry `aria-haspopup="listbox"`, a chevron and hover styling, so the intent is
 * not in doubt; the guard is simply too early.
 *
 * palette.ts's own tests cover the MODEL -- which categories exist, what is disabled and why --
 * and cannot see this, because the model is fine. It only shows up when a pointer is used.
 *
 * Was marked `it.fails`, which passes while the bug is there and starts FAILING once it is
 * fixed -- at which point delete the `.fails` and the comment, and use a click in openCategory
 * above.
 */
it(
  'clicking a category row in the creation menu opens that category',
  async () => {
    const j = await journey()
    await j.openCreationMenu()
    await j.clickMenuRow('Place blocks')
    // Opening "Place blocks" replaces the category list with that category's types.
    await j.page.waitForSelector('.flp-row .flp-row-id', { timeout: 5_000 })
  },
  JOURNEY_TIMEOUT_MS,
)
