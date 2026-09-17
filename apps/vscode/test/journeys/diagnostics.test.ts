// diagnostics.test.ts -- what the editor shows about the files it could not read.
//
// THIS SUITE IS EXPECTED TO BE RED, except the last test. The engine reports every problem it
// hit while loading a pack (wire.Graph.Diagnostics), src/previewController.ts shapes them
// defensively into GraphDiagnostic[], and src/graphPanel.ts lifts them to the top of the `graph`
// message it posts -- with a comment saying it does so precisely so that "the thing that draws
// them can be about drawing them". Nothing draws them. `diagnostics` does not appear anywhere in
// webview/graph.ts.
//
// WHAT THAT COSTS. An error diagnostic means the engine REFUSED the file, so nothing in it
// reached the graph -- previewController.ts's own comment on GraphDiagnostic spells out the
// consequence: "the graph silently draws a pack minus the file someone just wrote, and the only
// way to find out why is to run `check` from a terminal". The author's symptom is a node that is
// not there. The editor knows exactly which file and exactly why, and says nothing.
//
// This is the same shape as the Molang bug one layer further up: a complete, tested, shipped
// contract with no consumer. graphDiagnostics() has its own unit tests (graphDiagnostics.test.ts)
// and they pass. A test that bundles one module can never ask whether anything reads it.
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

/** A file the engine will refuse: truncated mid-value, which is what a crashed editor, a bad
 * merge and an interrupted generator all leave behind. Nothing in it reaches the graph. */
const REFUSED = 'features/half_written.json'
const REFUSED_TEXT = '{\n  "format_version": "1.21.110",\n  "minecraft:single_block_feature": {\n    "places_block":'

function withARefusedFile(packRoot: string): void {
  fs.writeFileSync(`${packRoot}/${REFUSED}`, REFUSED_TEXT, 'utf8')
}

/** Everything the panel is showing, as a person would read it: the toolbar, the canvas, the side
 * panel and the status line. Deliberately the WHOLE panel and not a selector -- where a
 * diagnostic belongs on screen is a design decision nobody has made yet, and a test that demanded
 * one particular home for it would be pinning a guess. Anywhere a reader would see it counts. */
async function visibleText(j: Journey): Promise<string> {
  return j.page.evaluate(() => {
    const seen: string[] = []
    const walk = (el: Element): void => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return
      if ((el as HTMLElement).hidden) return
      for (const child of el.children) walk(child)
      if (el.children.length === 0 && el.textContent) seen.push(el.textContent)
      const title = el.getAttribute('title')
      if (title) seen.push(title)
      const label = el.getAttribute('aria-label')
      if (label) seen.push(label)
    }
    walk(document.getElementById('flg-root') ?? document.body)
    return seen.join('\n')
  })
}

describe('a pack with a file the engine refused', () => {
  it(
    'says so, names the file, and says what was wrong with it',
    async () => {
      const j = await journey({ prepare: withARefusedFile })

      // The rest of the pack loaded, which is the whole reason this is easy to miss: fifty-odd
      // nodes are drawn and the panel looks entirely healthy.
      expect((await j.nodeIds()).length).toBeGreaterThan(20)

      const shown = await visibleText(j)

      // 1. The file is NAMED. "Some files could not be read" sends the author to run `check` in
      //    a terminal, which is the state this contract was added to end.
      expect(shown, 'nothing on screen names the file the engine refused').toContain('half_written.json')

      // 2. And the reason is there, in the engine's own words. The author needs to know it is
      //    malformed JSON rather than an unknown feature type -- those are different fixes.
      expect(shown.toLowerCase()).toMatch(/json|could not be read|refused|invalid/)

      // 3. It reads as a problem, not as a note. An error diagnostic means a file in this pack
      //    is not loaded at all.
      const flagged = await j.page.evaluate(() => {
        const root = document.getElementById('flg-root')
        if (root === null) return false
        return [...root.querySelectorAll('*')].some(
          (el) =>
            (el.textContent ?? '').includes('half_written.json') &&
            (el.className.toString().includes('error') ||
              el.getAttribute('role') === 'alert' ||
              el.className.toString().includes('problem') ||
              el.className.toString().includes('warning')),
        )
      })
      expect(flagged, 'the file is mentioned somewhere but not marked as a problem').toBe(true)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a warning about a file that DID load is shown against the node it is about',
    async () => {
      // The fixture pack raises two of these on its own: two trees set `may_grow_through` on a
      // trunk kind this tool does not consult, so they will stop short of where the game would
      // grow them. The file loaded and the node is drawn -- so unlike the refusal above, there is
      // somewhere obvious for this to live: on the card it is about.
      //
      // NOTE on the contract while this is red. GraphDiagnostic documents `fileId` as
      // "pack-relative, the same spelling a graph node's `file` carries, so a renderer can put a
      // message beside the node it belongs to". It is not: the engine reports
      // `tree_acacia_branching.json` while the node reports `features/tree_acacia_branching.json`.
      // Whoever wires this up joins the two and finds nothing matches. Reported separately; this
      // journey is written against the promise, and the promise includes the join working.
      const j = await journey()
      await j.clickNode('wiki:acacia_branching_tree')

      // Matched on a distinctive phrase from the ENGINE's own message, not on the field name:
      // `may_grow_through` is a field of this tree and is already on screen as a label, so a
      // looser match would pass without a single diagnostic having been rendered.
      const side = await j.sideText()
      expect(side, 'the node says nothing about the warning the engine raised for its file').toMatch(
        /does not consult it in this tool|stop short here where the game would grow through/,
      )

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('what a refused file does today', () => {
  // GREEN. The half that works: a refusal does not take the editor down with it, and the node
  // from the refused file is genuinely absent rather than half-drawn. Pinned because "the pack
  // still opens" is the property that makes the missing message survivable rather than fatal,
  // and it would be easy to lose while adding the message.
  it(
    'the rest of the pack still opens, and the refused file contributes no node',
    async () => {
      const j = await journey({ prepare: withARefusedFile })

      const drawn = await j.nodeIds()
      expect(drawn.length).toBeGreaterThan(20)
      expect(drawn).toContain('wiki:pumpkin_patch')
      // Not there under any name: a refused file is not loaded, so it has no identifier to be
      // drawn under -- which is exactly why the message has to name the FILE and not a node.
      expect(drawn.some((id) => id.includes('half_written'))).toBe(false)

      // The panel is not in an error state. It looks, to a reader, like a pack with one fewer
      // feature in it than they wrote.
      expect(await j.statusIsError()).toBe(false)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
