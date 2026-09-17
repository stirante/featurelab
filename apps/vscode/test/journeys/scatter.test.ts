// scatter.test.ts -- setting up a scatter from scratch, end to end.
//
// The journey a pack author reported as impossible: create a scatter, and then "work with
// distribution". The panel drew the section with nothing in it -- every axis was optional and so
// sat behind "Add a field" -- and the one value the file DID hold in it, `iterations`, was drawn
// on the canvas edge instead and nowhere in the section named after it.
//
// Every assertion here is about an OUTCOME on disk or on screen, over the real bundle, the real
// host and the real engine (see harness.ts). The first journey is the fix for the axes. The
// second pins the half that needs the host: the inspector can draw the edge's own `iterations`
// editor in the section, but only once webview/graph.ts hands the edge in -- until it does, the
// journey is marked `it.fails`, the same way this directory has pinned every other promise the
// product did not yet keep.
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

/** The creation menu's first-level categories are arrowed through -- see create.test.ts on why
 * a click on a category row is not an option yet. */
const SCATTER_AND_SPREAD = 4

async function aFreshScatter(j: Journey): Promise<void> {
  await j.openCreationMenu()
  for (let i = 0; i < SCATTER_AND_SPREAD; i++) await j.page.keyboard.press('ArrowDown')
  await j.page.keyboard.press('Enter')
  await j.clickMenuRow('Scatter')
  await j.waitForNode('wiki:scatter_1')
  expect(await j.selectedNodeId()).toBe('wiki:scatter_1')
}

/** The distribution section of the inspector, by the section key inspector.ts gives a group. */
function distributionSection(j: Journey) {
  return j.page.locator('#flg-side [data-section=\'group:["distribution"]\']')
}

/** The text box of one row of the distribution section. */
function axis(j: Journey, key: string) {
  return distributionSection(j).locator(`.flg-ins-row[data-key=${JSON.stringify(key)}] input.flg-ins-input`).first()
}

function scatterBody(j: Journey): Record<string, unknown> {
  const file = JSON.parse(j.read('features/scatter_1.json')) as Record<string, Record<string, unknown>>
  return file['minecraft:scatter_feature'] ?? {}
}

describe('setting up a scatter from scratch', () => {
  it(
    'a fresh scatter shows its axes in the distribution section, and setting one reaches the file',
    async () => {
      const j = await journey()
      await aFreshScatter(j)

      // The section is there, and the axes are IN it as rows -- empty, with the default as the
      // placeholder -- rather than behind "Add a field". This is the thing that was missing.
      const section = distributionSection(j)
      await expect.poll(() => section.count(), { timeout: 20_000 }).toBe(1)
      for (const key of ['x', 'y', 'z', 'scatter_chance']) {
        expect(await section.locator(`.flg-ins-row[data-key=${JSON.stringify(key)}]`).count(), key).toBe(1)
      }
      expect(await axis(j, 'x').inputValue()).toBe('')
      expect(await axis(j, 'x').getAttribute('placeholder')).toBe('0')

      // Drawing them wrote nothing: the file is as the engine created it.
      const before = j.read('features/scatter_1.json')
      expect(scatterBody(j)['distribution']).not.toHaveProperty('x')

      // Setting x, the way a person does: type, Tab away.
      const redraws = await j.graphCount()
      await axis(j, 'x').fill('5')
      await axis(j, 'x').press('Tab')
      await j.waitForRedraw(redraws)

      // The file changed, in the place the file keeps it, and nothing else in it moved.
      const body = scatterBody(j)
      expect(body['distribution']).toMatchObject({ x: 5 })
      expect(body).not.toHaveProperty('x')
      expect(await j.statusIsError()).toBe(false)
      expect(j.read('features/scatter_1.json')).not.toBe(before)

      // And the panel shows what the file says, read back through the engine.
      expect(await axis(j, 'x').inputValue()).toBe('5')
      expect(await j.selectedNodeId()).toBe('wiki:scatter_1')

      // The engine still accepts the file: nothing on screen says otherwise.
      const shown = await j.sideText()
      expect(shown.toLowerCase()).not.toMatch(/refused|must be an object/)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  /**
   * The count is reachable from the distribution section, as the SAME editor the edge carries.
   *
   * This journey was written before the host wired it, marked `it.fails`, and describes the
   * promise rather than the mechanism: the section shows `iterations`, typing into it reaches
   * the file, and it is one value -- not a second copy that the edge's own editor could disagree
   * with. webview/graph.ts now hands the inspector that editor (scatterEdgeFields), from the same
   * one-slot cache and through the same single subscription the edge panel uses.
   */
  it(
    'the count is editable from the distribution section, and it is the same value the edge carries',
    async () => {
      const j = await journey()
      await aFreshScatter(j)

      const section = distributionSection(j)
      await expect.poll(() => section.count(), { timeout: 20_000 }).toBe(1)
      const count = section.locator('.flg-ins-row[data-key="iterations"] textarea')
      expect(await count.count()).toBe(1)
      const written = scatterBody(j)['distribution'] as Record<string, unknown>
      expect(await count.inputValue()).toBe(String(written['iterations']))

      const redraws = await j.graphCount()
      await count.fill('7')
      await count.press('Tab')
      await j.waitForRedraw(redraws)
      expect((scatterBody(j)['distribution'] as Record<string, unknown>)['iterations']).toBe('7')
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('editing the same node more than once', () => {
  it(
    'a second edit builds on the first instead of erasing it',
    async () => {
      // Reported as "I picked gaussian, clicked + beside extent, and nothing happens". What
      // actually happened was worse than nothing: the + ERASED gaussian.
      //
      // With a node selected, the panel kept the form it built when the node was clicked, and was
      // never rebuilt from the graphs that came back after each write. So the second edit was
      // computed against the file as it had been before the first. An edit under a parent that
      // stale snapshot believed missing then wrote that parent whole -- `x` replaced by
      // `{extent: [0]}`, gaussian gone -- and every later + did the same again, reading the same
      // old snapshot, so it also appeared to do nothing.
      //
      // Asserted on the FILE after every step, because every one of these steps looked fine on
      // screen.
      const j = await journey()
      await aFreshScatter(j)
      const x = (): Record<string, unknown> =>
        (((scatterBody(j)['distribution'] ?? {}) as Record<string, unknown>)['x'] ?? {}) as Record<string, unknown>

      await j.page.getByLabel('x: how this axis is written').first().selectOption('object')

      await distributionSection(j).locator('.flg-ins-row[data-key="distribution"] select').last().selectOption('gaussian')
      await expect.poll(() => x()['distribution'], { timeout: 20_000 }).toBe('gaussian')

      // extent is [min, max] and nothing else, so one + writes both ends.
      await j.page.getByLabel('Fill extent with 2 entries').first().click()
      await expect.poll(() => JSON.stringify(x()['extent']), { timeout: 20_000 }).toBe('[0,0]')
      // The regression itself: the first edit survives the second.
      expect(x()['distribution'], 'adding to extent erased the distribution chosen a moment before').toBe('gaussian')

      // A full pair offers no way to grow it to three, or shrink it to one.
      const extentRow = distributionSection(j).locator('.flg-ins-row[data-key="extent"]').last()
      await expect.poll(() => extentRow.locator('input').count(), { timeout: 20_000 }).toBe(2)
      expect(await extentRow.getByLabel(/^Fill extent|^Add an entry to extent/).count(), 'a full extent still offers +').toBe(0)
      expect(await extentRow.getByLabel(/^Remove entry/).count(), 'one end of a full extent can be removed').toBe(0)

      // And a third edit, on one end of the pair, still builds on both before it.
      const max = extentRow.locator('input').nth(1)
      await max.fill('16')
      await max.press('Tab')
      await expect.poll(() => JSON.stringify(x()['extent']), { timeout: 20_000 }).toBe('[0,16]')
      expect(x()['distribution']).toBe('gaussian')

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
