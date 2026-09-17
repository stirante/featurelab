// reachability.test.ts -- does every capability this editor advertises have a click path?
//
// THIS IS THE TEST THE MOLANG BUG SHOULD HAVE FAILED.
//
// src/graph/molangEdge.ts is a seven-hundred-line editor for the expression on a scatter edge.
// It had thirty-seven passing tests. It was imported by NOTHING in webview/graph.ts, so there
// was no click path to it anywhere in the product: the user clicked the edge, got a tooltip, and
// could not edit. Green tests, real module, zero reachability. Every other suite in this repo
// was blind to it BY CONSTRUCTION -- graphPalette.test.ts and its siblings bundle ONE module and
// drive it directly, which can never answer "is this module wired into the app".
//
// So this file asks the one question none of them can, and asks it of the REAL SHIPPED ARTEFACTS
// rather than of the source tree:
//
//   1. DOES IT SHIP? Every module under src/graph/ must appear in the sources of a bundle in
//      dist/. Read off the built sourcemaps, which esbuild writes from what actually contributed
//      output -- so a module that is imported but whose every export is tree-shaken away counts
//      as absent, correctly.
//
//   2. CAN IT BE REACHED BY HAND? Every entry the editor's own palette model advertises must be
//      findable as a row in the live creation menu, in Chromium, driven by typing. Every
//      compound kind the code declares must be one of those rows and must be usable.
//
//   3. CAN EVERYTHING IT DRAWS BE MADE? Every feature type the real engine puts in a real pack's
//      graph must be a type the editor can create. This is the one that catches a whole KIND of
//      thing being read-only.
//
// WHERE THE LISTS COME FROM, and why there is not one written down here. Every list in this file
// is derived from something that moves on its own:
//
//   - the modules, from the filesystem and from the built sourcemaps;
//   - the palette entries, from buildPaletteModel() over the coverage table the REAL engine
//     binary prints, so a type the engine gains appears here the day it appears there;
//   - the compound kinds, from the exported COMPOUND_KINDS;
//   - the drawn types, from a real `featurelab graph` over the fixture pack.
//
// A hand-kept array would be updated by whoever remembered, which is the same person who would
// have remembered to wire the module up. That is not a check; it is a second copy of the
// mistake.
//
// WHAT TO DO WHEN THIS GOES RED. Not add an exemption. A module that ships, is tested, and
// cannot be reached is either a feature nobody can use or dead weight in a bundle every user
// downloads, and both of those are fixed by a decision -- wire it in, or delete it -- rather than
// by an entry in a list here. The failure messages name the module and say which.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeStub.js'))

import { buildPaletteModel, type PaletteItem } from '../../src/graph/palette.js'
import { COMPOUND_KINDS } from '../../src/graph/compounds/spec.js'
import type { CoverageRow } from '../../src/graph/typeCatalog.js'
import {
  closeSharedBrowser,
  engineBinaryPath,
  ensureBundleBuilt,
  openJourney,
  FIXTURE_PACK,
  JOURNEY_TIMEOUT_MS,
  type Journey,
} from './harness.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..', '..')

const open: Journey[] = []

afterEach(async () => {
  for (const j of open.splice(0)) await j.dispose()
})

afterAll(async () => {
  await closeSharedBrowser()
})

async function journey(): Promise<Journey> {
  const started = await openJourney()
  open.push(started)
  return started
}

// ---------------------------------------------------------------------------
// 1. Does it ship?
// ---------------------------------------------------------------------------

/** Every .ts file under src/graph, as a repo-relative posix path. */
function graphModules(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(appRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('src/graph')
  return out.sort()
}

/** Every source file that contributed to a bundle in dist/, from the bundles' own sourcemaps.
 *
 * The sourcemap and not an esbuild metafile computed here: a metafile describes a build this
 * test just invented, and would still be green if the shipped config stopped building a module
 * in. These are the maps beside the .js files the extension actually loads. */
function shippedSources(): Set<string> {
  const shipped = new Set<string>()
  const dist = path.join(appRoot, 'dist')
  for (const name of fs.readdirSync(dist)) {
    if (!name.endsWith('.js.map')) continue
    const map = JSON.parse(fs.readFileSync(path.join(dist, name), 'utf8')) as { sources?: string[] }
    for (const source of map.sources ?? []) {
      shipped.add(path.posix.normalize(path.posix.join('dist', source.split(path.sep).join('/'))))
    }
  }
  return shipped
}

/** Whether a module has anything to ship at all. A file whose every export is a type or an
 * interface produces no output and legitimately appears in no bundle -- not because nothing uses
 * it, but because there is nothing of it left after compilation. Read out of the source rather
 * than listed here, so a module that grows its first runtime export starts being checked without
 * anybody noticing it should be. */
function hasRuntimeExports(rel: string): boolean {
  const text = fs.readFileSync(path.join(appRoot, rel), 'utf8')
  const stripped = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  return /^export\s+(?!type\s|interface\s)/m.test(stripped)
}

describe('every module under src/graph ships in a bundle', () => {
  it('nothing is built, tested and then left out of everything the extension loads', () => {
    // Built here rather than trusted: reading a stale dist/ would make this test assert about a
    // bundle nobody has any more, in the one direction that produces a false green.
    ensureBundleBuilt()
    const shipped = shippedSources()
    expect(shipped.size, 'no sourcemaps in dist/ -- nothing was read').toBeGreaterThan(10)

    const unreachable = graphModules().filter((rel) => hasRuntimeExports(rel) && !shipped.has(rel))

    expect(
      unreachable,
      `these modules have runtime exports and appear in NO bundle under dist/, so nothing a user ` +
        `installs can reach them. Either wire each one into webview/graph.ts (or src/extension.ts, ` +
        `whichever it belongs to) or delete it -- a module that ships nowhere and passes its own ` +
        `tests is the exact shape of the bug this file exists for.`,
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Can it be reached by hand?
// ---------------------------------------------------------------------------

/** The coverage table the REAL engine binary prints -- the same rows the panel fetches over
 * JSON-RPC and hands to buildPaletteModel. Taken from the binary so a type the engine gains
 * turns up here on its own. */
function engineCoverage(): CoverageRow[] {
  const result = spawnSync(engineBinaryPath(), ['types', '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`featurelab types --json failed: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout) as { types?: CoverageRow[] }
  const rows = parsed.types ?? []
  if (rows.length === 0) throw new Error('featurelab types --json returned no rows')
  return rows
}

/** Everything the palette advertises.
 *
 * Built with NO format_version, deliberately. A version gate changes whether an entry is
 * `enabled`; it never removes one -- palette.ts lists a blocked entry with its reason rather than
 * hiding it, and says why in its own header. So the item SET is version-independent, and asking
 * for it without a version gets the whole set without this test having to know which pack it is
 * about to look at. */
function advertisedItems(): PaletteItem[] {
  return [...buildPaletteModel({ coverage: engineCoverage() }).items]
}

/** What a person types to find one entry: its `minecraft:` id, or the compound's kind. Both are
 * an exact-id match in filterPalette, which ranks them first. */
function queryFor(item: PaletteItem): string {
  return item.typeId ?? item.compound ?? item.title
}

describe('every entry the palette advertises can be found in the live menu', () => {
  it(
    'each one is a row somebody can type their way to, in the real bundle, in a browser',
    async () => {
      const j = await journey()
      const items = advertisedItems()
      expect(items.length, 'the palette model is empty, so this test is checking nothing').toBeGreaterThan(20)

      await j.openCreationMenu()
      const filter = j.page.locator('.flp-filter')
      await filter.waitFor({ state: 'visible', timeout: 20_000 })

      const missing: string[] = []
      for (const item of items) {
        await filter.fill(queryFor(item))
        // `data-item-id` is the menu's own identity for a row, set from the model's `id`. Using
        // it means this loop cannot drift from the model by a word of presentation.
        const row = j.page.locator(`.flp-row[data-item-id=${JSON.stringify(item.id)}]`)
        if ((await row.count()) === 0) missing.push(`${item.id} (${item.title})`)
      }

      expect(
        missing,
        `these entries are in the palette MODEL and produce no row in the menu, so there is no ` +
          `way to pick them. The model is what the editor advertises; a row is the only way to ` +
          `act on it.`,
      ).toEqual([])

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'every compound kind the code declares is offered, and offered as usable',
    async () => {
      // COMPOUND_KINDS is exhaustive by construction -- webview/graph.ts holds a
      // Record<CompoundKind, CompoundSpec> so a sixth kind fails to compile rather than becoming
      // a menu entry that does nothing. That catches a kind with no implementation. It does not
      // catch an implementation with no way in, which is this.
      const j = await journey()
      expect(COMPOUND_KINDS.length).toBeGreaterThan(0)

      await j.openCreationMenu()
      const filter = j.page.locator('.flp-filter')
      await filter.waitFor({ state: 'visible', timeout: 20_000 })

      const unreachable: string[] = []
      for (const kind of COMPOUND_KINDS) {
        await filter.fill(kind)
        const row = j.page.locator(`.flp-row[data-item-id=${JSON.stringify(`compound:${kind}`)}]`)
        if ((await row.count()) === 0) {
          unreachable.push(`${kind}: no row in the menu`)
          continue
        }
        // A compound is built out of other features and carries no coverage status of its own, so
        // there is no honest reason for one to be listed and blocked. If one ever is, the reason
        // belongs in the failure.
        if ((await row.first().getAttribute('aria-disabled')) === 'true') {
          unreachable.push(`${kind}: listed but disabled -- ${(await row.first().textContent()) ?? ''}`)
        }
      }

      expect(unreachable, 'a declared compound kind that cannot be picked').toEqual([])
      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 3. Can everything it draws be made?
// ---------------------------------------------------------------------------

/** Every `typeId` the real engine puts in the real fixture pack's graph. Read by running the
 * binary, so this is what the editor is actually asked to draw. */
function drawnTypeIds(): string[] {
  const result = spawnSync(engineBinaryPath(), ['graph', '--pack', FIXTURE_PACK], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`featurelab graph failed: ${result.stderr}`)
  const graph = JSON.parse(result.stdout) as { nodes?: { typeId?: string }[] }
  const ids = new Set<string>()
  for (const node of graph.nodes ?? []) if (node.typeId) ids.add(node.typeId)
  return [...ids].sort()
}

describe('every kind of node the editor draws is a kind it can create', () => {
  it('nothing in a real pack is drawable but not makeable', () => {
    // An editor that renders a kind of thing and cannot produce one is not an editor of that
    // thing -- it is a viewer with an inconsistent story. The author has to leave, write the JSON
    // by hand, and come back, which is the state this whole panel exists to end.
    //
    // Derived from a real graph of a real pack rather than from a list, because the point is to
    // notice a kind NOBODY thought about. A hand-kept list of "kinds the editor supports" would
    // have been written by the same person who did not think about it.
    const drawn = drawnTypeIds()
    expect(drawn.length, 'the fixture pack produced no typed nodes').toBeGreaterThan(10)

    const creatable = new Set(advertisedItems().map((item) => item.typeId).filter((id): id is string => id !== undefined))
    const viewOnly = drawn.filter((typeId) => !creatable.has(typeId))

    expect(
      viewOnly,
      `the editor draws nodes of these types and offers no way to create one. Each needs a ` +
        `palette entry AND a creation path that puts the file where that kind of file lives -- ` +
        `onCreate in webview/graph.ts writes every new node to features/<name>.json through ` +
        `featureFilePath(), which is the right answer for exactly one of the kinds a pack holds.`,
    ).toEqual([])
  })
})
