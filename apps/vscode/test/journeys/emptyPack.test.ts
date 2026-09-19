// emptyPack.test.ts -- what the node editor shows when there is nothing to draw.
//
// This is the journey for the report the feedback work started from: "I could not get the node
// editor to open." The panel HAD opened, every time. What it showed was a blank grey rectangle,
// which is indistinguishable from an editor that failed to start -- and the only thing saying
// otherwise was one line of small text at the bottom edge of the panel, which is exactly where
// somebody who believes the panel is broken is not looking.
//
// So the assertion is the one a person makes: is there a sentence in the middle of the canvas,
// and does it say which of the two situations this is. Real engine, real panel, real Chromium
// page running the real dist/graph.js under the real CSP -- see harness.ts. A unit test over
// the message function (graphEmptyState.test.ts) says the sentence is right; only this says it
// ever reaches the canvas.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeStub.js'))

import * as fs from 'node:fs'
import * as path from 'node:path'
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

/** Empties the copied fixture pack of everything the engine builds a graph from, leaving the
 * directories themselves -- which is what a pack somebody has just created looks like, and what
 * resolvePackRoot still recognises as a pack. */
function emptyEveryFeature(packRoot: string): void {
  for (const dir of ['features', 'feature_rules', 'structures']) {
    const full = path.join(packRoot, dir)
    if (!fs.existsSync(full)) continue
    for (const name of fs.readdirSync(full)) fs.rmSync(path.join(full, name), { recursive: true, force: true })
  }
}

describe('opening the graph on a pack with nothing in it', () => {
  it(
    'says so on the canvas, in words, and says how to make the first node',
    async () => {
      const j = await journey({ prepare: emptyEveryFeature, emptyCanvas: true })

      expect(await j.nodeIds(), 'the fixture was not actually emptied').toHaveLength(0)

      // The thing a person sees, in the middle of the canvas.
      const said = await j.emptyState()
      expect(said).toMatch(/no features and no feature rules/i)
      expect(said).toMatch(/right-click/i)
      // And the status line agrees rather than claiming to be showing a graph.
      expect(await j.status()).toMatch(/nothing to draw/i)
      // Nothing about drawing a blank canvas should be an error: this pack is fine, it is new.
      expect(await j.statusIsError()).toBe(false)
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'takes the message away as soon as there is something to draw',
    async () => {
      const j = await journey({ prepare: emptyEveryFeature, emptyCanvas: true })
      expect(await j.emptyState()).not.toBe('')

      // A feature arrives the way one really does -- a file written and saved.
      j.write(
        'features/lamp.json',
        JSON.stringify(
          {
            format_version: '1.21.110',
            'minecraft:single_block_feature': {
              description: { identifier: 'wiki:lamp' },
              places_block: 'minecraft:glowstone',
              enforce_placement_rules: false,
              enforce_survivability_rules: false,
            },
          },
          null,
          2,
        ),
      )
      await j.notifySaved('features/lamp.json')

      await j.waitForNode('wiki:lamp')
      // The sentence is gone, not merely covered: a "this pack is empty" message left over a
      // pack that now has a node in it is worse than the blank canvas it replaced.
      expect(await j.emptyState()).toBe('')
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('opening the graph on a folder that is not a pack root', () => {
  it(
    'says to check the path, rather than congratulating somebody on their new pack',
    async () => {
      // THE MOST COMMON WAY TO SEE AN EMPTY CANVAS, and for a long time the one the editor
      // answered worst. A directory that is not a pack root loads PERFECTLY: zero features, zero
      // rules, zero diagnostics, no error anywhere. It is indistinguishable, from the graph's own
      // side, from a pack somebody created five seconds ago -- so the canvas said "This pack has
      // no features and no feature rules yet. Right-click anywhere on this canvas to create one."
      // to a person who had opened the wrong folder, and inviting them to right-click would have
      // put a feature file somewhere nothing will ever read it.
      //
      // What tells the two apart is the DIRECTORIES: a new pack has features/ and nothing in it,
      // a wrong folder has no features/ at all. Both the engine's own load warnings and the host's
      // missingFeaturesDirectoryWarning say so, and graph/emptyState.ts reads them. A unit test
      // (graphEmptyState.test.ts) covers the sentence; only this covers the whole path -- engine
      // warning to host to webview to the middle of the canvas.
      const j = await journey({
        prepare: (packRoot) => {
          // Not emptied -- REMOVED. That is the difference the message turns on.
          for (const dir of ['features', 'feature_rules', 'structures']) {
            fs.rmSync(path.join(packRoot, dir), { recursive: true, force: true })
          }
        },
        emptyCanvas: true,
      })

      expect(await j.nodeIds(), 'the fixture still has something in it, so this is the wrong test').toHaveLength(0)

      const said = await j.emptyState()
      // The sentence a person can act on. It is on the CANVAS, in the middle, because somebody who
      // has opened the wrong folder believes the editor is broken and is not reading the status
      // line at the bottom edge.
      expect(said).toMatch(/check that the path points at the pack root/i)
      expect(said).toMatch(/no features\/ directory/i)
      // And NOT the new-pack sentence, which is the whole point: it is the same empty canvas and
      // the opposite advice.
      expect(said).not.toMatch(/no features and no feature rules yet/i)
      expect(said).not.toMatch(/right-click/i)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('opening the graph on a pack whose files will not load', () => {
  it(
    'says the files failed rather than calling the pack empty, and points at the list',
    async () => {
      const j = await journey({
        prepare: (packRoot) => {
          emptyEveryFeature(packRoot)
          // Two files the engine will refuse. A refused file produces no node at all, which is
          // precisely the case that used to be indistinguishable from an empty pack.
          fs.writeFileSync(path.join(packRoot, 'features', 'broken_one.json'), '{ this is not json', 'utf8')
          fs.writeFileSync(path.join(packRoot, 'features', 'broken_two.json'), '{ nor is this', 'utf8')
        },
        emptyCanvas: true,
      })

      expect(await j.nodeIds()).toHaveLength(0)
      const said = await j.emptyState()
      // The count, so the reader knows this is a pack with a problem and not an empty one...
      expect(said).toMatch(/file\(s\) in this pack could not be read/i)
      // ...and where to find out which files, because a message about files you cannot reach
      // from the message is most of the way to no message at all.
      expect(said).toMatch(/list beside this canvas/i)
      expect(said).not.toMatch(/no features and no feature rules/i)
    },
    JOURNEY_TIMEOUT_MS,
  )
})
