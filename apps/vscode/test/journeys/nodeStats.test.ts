// nodeStats.test.ts -- what one run measured, on the card of the node that did it.
//
// THE SECOND HALF OF THE REACHABILITY BUG. src/graph/nodeStats.ts is three hundred lines with a
// full suite of its own and, until this file, no importer anywhere in the product: the same shape
// as src/graph/molangEdge.ts before it and src/graph/attribution.ts beside it. A test that
// imports nodeRunStats and checks its arithmetic says nothing about whether a person can ever see
// a number, which is why the suite it already had did not notice.
//
// SO THIS DRIVES THE REAL BUNDLE. The graph panel, the preview panel, the engine, a real pack, and
// a profile produced by an actual run -- reached the only way the product reaches it: the graph's
// own "Preview on select" toggle, which is also the only thing in this editor that asks the engine
// for a profile at all.
//
// WHAT IT PINS, beyond "numbers appear":
//
//   - THE THREE COUNTERS STAY THREE. nodeStats.ts's header argues that entered, blocksWritten and
//     delegations are three different problems and that one blended "cost" would hide the
//     difference between a wrapper delegating 900 000 times and a leaf writing 900 000 blocks.
//     The card is checked for three separate numbers, delegations included at nought -- the case
//     a "only show it when it is interesting" rule would drop, and the case the header is about.
//
//   - A CARD WITH NO STATS IS UNTOUCHED. A preview runs one feature; every other node in the pack
//     was not entered. Those cards get nothing at all -- not a nought, not a placeholder -- and
//     the card that DOES get numbers does not change size when they arrive. A card that grew when
//     a preview finished would move the canvas under a pointer that had not moved.
//
//   - THE EMPTY CASES KEEP THEIR OWN WORDS. "Not entered in this run" and "feature rules are not
//     measured" are nodeStats.ts's sentences, and the assertions quote them rather than some
//     parallel wording invented in the webview -- which is exactly how two descriptions of one
//     state drift apart.
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

/** The feature the run is of: a tree nothing delegates to, so previewing it previews the feature
 * itself, and it writes enough blocks to have something to report. */
const TREE = 'wiki:fancy_oak_tree'
/** A feature that has nothing to do with that run. Never entered by it. */
const ELSEWHERE = 'wiki:amethyst_geode'
/** A feature rule -- which the profiler does not instrument at all, a third state that is neither
 * "ran" nor "did not run". */
const RULE = 'wiki:rng_rule_a.fr'

function card(j: Journey, nodeId: string) {
  return j.page.locator(`.flg-node[data-node-id=${JSON.stringify(nodeId)}]`)
}

/** Clicks the graph's "Preview on select" toggle and returns once it reads as on. The toggle
 * previews whatever is ALREADY selected the moment it goes on, which is what makes this the whole
 * of the setup: select first, then switch it on. */
async function turnOnPreviewOnSelect(j: Journey): Promise<void> {
  const toggle = j.page.locator('#flg-toolbar button', { hasText: 'Preview on select' }).first()
  await toggle.waitFor({ state: 'visible', timeout: 20_000 })
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-pressed'), { timeout: 20_000 }).toBe('true')
}

async function turnOffPreviewOnSelect(j: Journey): Promise<void> {
  const toggle = j.page.locator('#flg-toolbar button', { hasText: 'Preview on select' }).first()
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-pressed'), { timeout: 20_000 }).toBe('false')
}

describe('what a run measured, on the node that did it', () => {
  it(
    'the card grows three separate numbers, and does not grow at all',
    async () => {
      const j = await journey({ withPreview: true })

      // Select first, with nothing previewing: this is the card as it is today, and the height
      // measured here is the one that must not move.
      await j.clickNode(TREE)
      expect(await card(j, TREE).locator('.flg-node-stats').count()).toBe(0)
      const before = await j.nodeBox(TREE)

      await turnOnPreviewOnSelect(j)
      const preview = await j.preview()
      await preview.waitForAttribution(new RegExp(`${TREE}: \\d+ block`))

      const stats = card(j, TREE).locator('.flg-node-stats')
      await stats.waitFor({ state: 'visible', timeout: 20_000 })

      // Three numbers, three elements. Read separately on purpose -- a single blended figure
      // would satisfy "the card says something" and fail the only thing this row is for.
      expect(await stats.locator('.flg-node-stat-writes').textContent()).toMatch(/^\d[\d,]* blk$/)
      expect(await stats.locator('.flg-node-stat-entered').textContent()).toMatch(/^×\d[\d,]*$/)
      // At NOUGHT, and still drawn. A wrapper that hands off relentlessly and one that never
      // hands off at all are the pair this counter exists to separate, and a row that hid the
      // number when it was zero could not tell them apart.
      expect(await stats.locator('.flg-node-stat-delegations').textContent()).toBe('→0')

      // The tree wrote something, and the card says how much rather than that it ran.
      const written = Number(((await stats.locator('.flg-node-stat-writes').textContent()) ?? '').replace(/[^\d]/g, ''))
      expect(written).toBeGreaterThan(0)

      // Each number carries its own explanation, not one shared tooltip: somebody hovering the
      // delegation count is asking about delegations.
      const writeTitle = (await stats.locator('.flg-node-stat-writes').getAttribute('title')) ?? ''
      const delegationTitle = (await stats.locator('.flg-node-stat-delegations').getAttribute('title')) ?? ''
      expect(writeTitle).toMatch(/innermost/)
      expect(delegationTitle).toMatch(/wrote nothing/)
      expect(writeTitle).not.toBe(delegationTitle)

      // AND IT FITS. The card is a fixed 232x86 whose rows are budgeted to the pixel (media/
      // graph.css says so beside the size), so a row that overflowed would be clipped -- and a
      // clipped measurement is a wrong one, silently. Read off the live geometry rather than
      // trusted to the stylesheet.
      const geometry = await j.page.evaluate((selector: string) => {
        const node = document.querySelector(selector) as HTMLElement | null
        const row = node?.querySelector('.flg-node-stats') as HTMLElement | null
        if (node === null || row === null) return null
        const box = node.getBoundingClientRect()
        const rect = row.getBoundingClientRect()
        return {
          inside: rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom,
          // Whether the row itself is being cut off horizontally, as opposed to the fan label
          // beside it, which is allowed to ellipsise.
          clipped: row.scrollWidth > row.clientWidth + 1,
        }
      }, `.flg-node[data-node-id=${JSON.stringify(TREE)}]`)
      expect(geometry).toEqual({ inside: true, clipped: false })

      // AND THE CARD IS THE SAME SIZE. This is the assertion the row's placement exists for: a
      // card that gained a row when the preview finished would shift every card below it and move
      // the canvas under a pointer that had not moved.
      const after = await j.nodeBox(TREE)
      expect(after.height).toBe(before.height)
      expect(after.width).toBe(before.width)

      expect(j.problems()).toEqual([])
      expect(preview.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a node this run never entered is left exactly as it was',
    async () => {
      const j = await journey({ withPreview: true })
      const untouchedBefore = await (async () => {
        await j.clickNode(ELSEWHERE)
        return j.nodeBox(ELSEWHERE)
      })()

      await j.clickNode(TREE)
      await turnOnPreviewOnSelect(j)
      const preview = await j.preview()
      await preview.waitForAttribution(new RegExp(`${TREE}: \\d+ block`))
      await card(j, TREE).locator('.flg-node-stats').waitFor({ state: 'visible', timeout: 20_000 })

      // Nothing on it. Not a nought, not a placeholder, not an empty row -- a pack of fifty-seven
      // cards wearing "0 blk" would teach a reader to stop looking at the row on the one card
      // where it means something.
      await j.clickNode(ELSEWHERE)
      expect(await card(j, ELSEWHERE).locator('.flg-node-stats').count()).toBe(0)
      const untouchedAfter = await j.nodeBox(ELSEWHERE)
      expect(untouchedAfter.height).toBe(untouchedBefore.height)

      // Exactly ONE card in the whole pack carries a row, and it is the one the run was of.
      const carrying = await j.page.$$eval('.flg-node-stats', (rows) =>
        rows.map((r) => (r.closest('.flg-node') as HTMLElement | null)?.dataset['nodeId'] ?? ''),
      )
      expect(carrying).toEqual([TREE])

      expect(j.problems()).toEqual([])
      expect(preview.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('what the run can and cannot say about a node', () => {
  it(
    'the inspector reports the run in its own words, for all three of its empty cases',
    async () => {
      const j = await journey({ withPreview: true })
      await j.clickNode(TREE)
      await turnOnPreviewOnSelect(j)
      const preview = await j.preview()
      await preview.waitForAttribution(new RegExp(`${TREE}: \\d+ block`))
      await card(j, TREE).locator('.flg-node-stats').waitFor({ state: 'visible', timeout: 20_000 })

      // Off again, so selecting the next three nodes is just looking around rather than firing a
      // preview per click -- which is the toggle's own reason for existing.
      await turnOffPreviewOnSelect(j)

      // 1. The node that ran. The panel names the RUN before any number, because these are a
      //    measurement of one placement at one origin and not a property of the feature.
      await j.clickNode(TREE)
      const ran = j.page.locator('#flg-side .flg-run')
      await ran.waitFor({ state: 'visible', timeout: 20_000 })
      expect(await ran.locator('.flg-run-head').textContent()).toMatch(new RegExp(`This run — ${TREE} at origin -?\\d+,-?\\d+,-?\\d+`))
      expect(await ran.textContent()).toMatch(/Wrote [\d,]+ blocks? in this run/)
      expect(await ran.textContent()).toMatch(/entered \d+ time/)

      // 2. A node it never entered. NOT called dead, unused or unreachable -- the panel says what
      //    the run can answer and, in the same breath, what it cannot.
      await j.clickNode(ELSEWHERE)
      const notRun = await j.page.locator('#flg-side .flg-run').textContent()
      expect(notRun).toMatch(/Not entered in this run, at origin -?\d+,-?\d+,-?\d+/)
      expect(notRun).toMatch(/a fact about the run and not about the node/)
      expect(notRun).not.toMatch(/dead|unused|unreachable/i)

      // 3. A feature rule, which the profiler does not instrument at all. Saying "did not run" of
      //    one would be a plain falsehood, and it is a different sentence.
      await j.clickNode(RULE)
      const rule = await j.page.locator('#flg-side .flg-run').textContent()
      expect(rule).toMatch(/Feature rules are not measured by the profiler/)
      expect(rule).not.toMatch(/Not entered in this run/)

      expect(j.problems()).toEqual([])
      expect(preview.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'with no profile anywhere, the graph is the graph it has always been',
    async () => {
      // No preview, so nothing ever asks the engine for a profile -- the whole cost gate. The
      // cards and the inspector must be indistinguishable from the editor before any of this
      // existed: no row, no panel, no empty placeholder implying something failed.
      const j = await journey()
      await j.clickNode(TREE)

      expect(await j.page.locator('.flg-node-stats').count()).toBe(0)
      expect(await j.page.locator('#flg-side .flg-run').count()).toBe(0)
      expect(await j.sideText()).not.toMatch(/This run/)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('where a run stopped', () => {
  it(
    'a scatter whose iterations come out as 0 says so on its card and on the edge nothing went down',
    async () => {
      // Asked for as: when generation did not go on because of some Molang, mark where it stopped
      // -- a scatter whose iterations is 0 being the example. Before, the card showed x1, 0 blk and
      // ->0, which is also what a scatter whose child simply placed nothing looks like.
      const SCATTER = 'wiki:pumpkin_patch'
      const j = await journey({
        withPreview: true,
        prepare: (packRoot: string) => {
          const file = `${packRoot}/features/scatter_pumpkin_patch.json`
          const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { 'minecraft:scatter_feature': { distribution: Record<string, unknown> } }
          json['minecraft:scatter_feature'].distribution['iterations'] = 'math.floor(0.4)'
          fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8')
        },
      })

      await j.clickNode(SCATTER)
      await turnOnPreviewOnSelect(j)

      const badge = card(j, SCATTER).locator('.flg-badge-stop')
      await badge.waitFor({ state: 'visible', timeout: 30_000 })
      expect(await badge.textContent()).toMatch(/iterations = 0/)
      expect(await badge.getAttribute('title')).toMatch(/iterations = 0/)
      expect(await card(j, SCATTER).getAttribute('data-stopped')).toBe('yes')

      const edge = j.page.locator('.flg-edge.flg-edge-scatter.flg-edge-stopped')
      expect(await edge.count(), 'the scatter edge is not marked as the one nothing went down').toBeGreaterThan(0)
      expect(await edge.first().locator('title').textContent()).toMatch(/iterations = 0/)

      // And it goes away with the run.
      await turnOffPreviewOnSelect(j)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
