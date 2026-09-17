// attribution.test.ts -- select a node and the preview highlights its blocks; click a block and
// the graph points back at what placed it. End to end, by mouse, over a real pack, through both
// real panels and the real engine.
//
// THIS IS THE TEST src/graph/attribution.ts NEVER HAD.
//
// That module is seven hundred lines with its own thorough suite (test/graphAttribution.test.ts,
// forty-odd cases over a literal profile), and until this file existed nothing in the product
// imported it: green tests, real module, no click path. reachability.test.ts is what found it,
// and molangEdge.ts is the same shape of bug one iteration earlier. A suite that imports the
// index and calls cellsWrittenBy proves the index is correct; it cannot prove a person can get
// an answer out of it, and "a person can get an answer out of it" is the entire feature.
//
// SO EVERY ASSERTION HERE IS ABOUT SOMETHING SOMEBODY SEES:
//
//   - the readout in the preview's own shell, naming the node and a block count;
//   - the number of cells the viewer's overlay is actually painting;
//   - which node card the graph ends up with selected, and what its status line says.
//
// And every action is a real one: a toolbar button clicked, a node card clicked, a radio in the
// sidebar checked, a key pressed, and a left click on a WebGL canvas that raycasts against
// geometry the real engine produced. There is no seam here where a message is posted by hand.
//
// WHY THE FANCY OAK. It is a feature nothing in this pack delegates to, so selecting it previews
// the feature ITSELF rather than a rule above it (webview/graph.ts's previewFor walks upward for
// a rule and finds none) -- and a tree writes dozens of blocks inside the bench, so there is
// something to highlight and something to click. The two rules this fixture pack does have both
// place outside the previewed volume, which is a fine thing for a pack to do and a useless thing
// to point a highlight at.
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

/** A tree feature no rule and no other feature in the fixture pack reaches. */
const TREE = 'wiki:fancy_oak_tree'
/** A feature two feature rules both place. Selecting it previews the RULE, not the feature. */
const UNDER_A_RULE = 'wiki:rng_marker'

/** Turns on the graph's "Preview on select" toggle -- the button that makes selecting a node
 * open it in the live preview, off until asked for because running a feature is not free. It is
 * also, and not by coincidence, the only gesture in this editor that makes a preview ask the
 * engine for a profile. */
async function turnOnPreviewOnSelect(j: Journey): Promise<void> {
  const toggle = j.page.locator('#flg-toolbar button', { hasText: 'Preview on select' }).first()
  await toggle.waitFor({ state: 'visible', timeout: 20_000 })
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-pressed'), { timeout: 20_000 }).toBe('true')
}

describe('selecting a node highlights the blocks it placed', () => {
  it(
    'the preview names the node, counts its blocks, and paints them',
    async () => {
      const j = await journey({ withPreview: true })
      await turnOnPreviewOnSelect(j)
      await j.clickNode(TREE)

      const preview = await j.preview()
      // The readout is in previewPanel.ts's OWN shell, not the shared panel -- see
      // renderShellHtml. If the CSP ever drops that inline style block again, the element is
      // still there and this still passes, which is why the cell count below is asserted too:
      // one of these is about the words, the other is about the picture.
      const text = await preview.waitForAttribution(new RegExp(`${TREE}: \\d+ block`))
      expect(text).toContain(TREE)
      expect(text).toMatch(/\d+ block\(s\)/)
      expect(text).toMatch(/\d+ write\(s\)/)

      // What the viewer is actually painting, read off the viewer. A readout saying "79 blocks"
      // over an empty overlay is exactly the failure a text-only assertion cannot see.
      const painted = await preview.attributionCellCount()
      expect(painted).toBeGreaterThan(0)
      expect(text).toContain(painted.toLocaleString())

      expect(j.problems()).toEqual([])
      expect(preview.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'the profile is asked for because THIS is what asked for it, and not otherwise',
    async () => {
      // The constraint that pays for the whole feature: profiling costs the engine real work, so
      // it must be a consequence of somebody wanting attribution rather than something every
      // preview starts paying. The only gesture that turns it on is the one above.
      const j = await journey({ withPreview: true })
      await turnOnPreviewOnSelect(j)
      await j.clickNode(TREE)

      const preview = await j.preview()
      await preview.waitForAttribution(new RegExp(`${TREE}: \\d+ block`))

      // EVERY request this panel has made, not just one: a panel opened for attribution asks for
      // the profile on its very first run, so there is no unprofiled run to be found here at all.
      expect(preview.requests.length).toBeGreaterThan(0)
      for (const params of preview.requests) {
        expect(params).toMatchObject({ profile: true })
      }
      // And it asked for the FEATURE the author selected -- nothing about attribution changed
      // what is being previewed.
      expect(preview.requests[0]).toMatchObject({ feature: TREE })

      expect(preview.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a node the preview cannot attribute says so, and leaves the preview working',
    async () => {
      // wiki:rng_marker is placed by a feature rule, so selecting it previews the RULE -- and
      // that rule scatters across a chunk and lands every one of its writes outside the bench.
      // Nothing is attributed, which is an ANSWER and not a failure: the preview still draws its
      // result, the overlay paints nothing, and the readout says the node placed no blocks
      // rather than going blank or reporting an error nobody can act on.
      const j = await journey({ withPreview: true })
      await turnOnPreviewOnSelect(j)
      await j.clickNode(UNDER_A_RULE)
      expect(await j.status()).toMatch(/Previewing wiki:rng_rule_[ab]\.fr/)

      const preview = await j.preview()
      await preview.waitForAttribution(new RegExp(`${UNDER_A_RULE} placed no blocks`))
      expect(await preview.attributionCellCount()).toBe(0)

      // The preview itself is unharmed -- a result was drawn, nothing reported an error.
      expect(preview.problems()).toEqual([])
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('clicking a block finds the node that placed it', () => {
  it(
    'a left click in the 3D view selects the placing node back in the graph',
    async () => {
      const j = await journey({ withPreview: true })
      await turnOnPreviewOnSelect(j)
      await j.clickNode(TREE)

      const preview = await j.preview()
      await preview.waitForAttribution(new RegExp(`${TREE}: \\d+ block`))

      // Hide the terrain and reframe -- what a person does to look at their feature rather than
      // the ground it was planted in, and what leaves the tree as the only thing a click can
      // land on. Both are real controls: a radio in the sidebar, and the viewer's own R key.
      await preview.hideEnvironment()
      await preview.frameContent()

      // Deselect in the graph first, so what follows cannot be the selection that was already
      // there. Clicking empty canvas is how a person clears a selection.
      const empty = await j.emptyCanvasPoint()
      await j.page.mouse.click(empty.x, empty.y)
      await expect.poll(() => j.selectedNodeId(), { timeout: 20_000 }).toBeNull()

      const answer = await preview.clickUntilAttributed()
      expect(answer).toContain(TREE)
      // The position is named, because "which block" is half of the answer.
      expect(answer).toMatch(/at -?\d+, -?\d+, -?\d+/)

      // ...and the graph is where the answer is read: the node card, selected, with the status
      // line saying why it moved.
      await expect.poll(() => j.selectedNodeId(), { timeout: 20_000 }).toBe(TREE)
      expect(await j.sideText()).toContain(TREE)
      expect(await j.status()).toMatch(new RegExp(`That block was placed by .*${TREE}`))

      // The graph selecting a node must NOT bounce back out as another preview request -- that
      // is the whole point of GraphView.setSelection not emitting, and of the bridge's own
      // duplicate check. If it did, this list would keep growing.
      const previewRequests = j.posted.filter((m) => m.type === 'previewNode')
      expect(previewRequests.length).toBe(1)

      expect(j.problems()).toEqual([])
      expect(preview.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
