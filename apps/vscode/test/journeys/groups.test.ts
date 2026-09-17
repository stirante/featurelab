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
      await j.page.evaluate((id: string) => {
        ;(window as unknown as { __flgView?: { focusNode(id: string): void } }).__flgView?.focusNode(id)
      }, MARKER)
      await j.page.locator('.flg-frame[data-group-id="markers"] .flg-frame-head').click({ position: { x: 20, y: 10 }, ...WAIT })
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
