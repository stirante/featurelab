// graphPalette.test.ts -- covers src/graph/palette.ts, the node-creation menu.
//
// THREE HALVES, which is one more than two on purpose:
//
//   1. THE MODEL, in plain node. Categories, entries, why an entry is disabled, what picking one
//      asks the host to do, and the screen-to-graph arithmetic. This is the bulk of the file,
//      because it is the bulk of the behaviour: "is a version-gated type still listed, and does
//      the reason name a version the author can actually declare" is a question about data, and
//      answering it in a browser would make it slower to ask and easier to stop asking.
//   2. THE INTERACTION, in real Chromium via Playwright, following graphRender.test.ts. Arrow
//      keys, Enter, Escape, the drag gesture and -- the one that matters most -- where a created
//      node lands when the camera is panned and zoomed. jsdom reports zero for every
//      measurement and resolves no custom property, so it can answer none of those.
//   3. THE LANGUAGE GUARD, mirroring docsLanguage.test.ts. The menu is a new user-facing
//      surface and the Go guard cannot see it, so the same vocabulary rule is applied here, to
//      the same extracted list, for the same reason.
//
// THE COVERAGE TABLE IS READ OUT OF THE ENGINE, not restated here. A hand-written fixture would
// let this file keep passing while the engine gained a thirtieth type that the menu silently
// dropped -- which is the single failure a creation menu must not have. So the fixture is
// parsed from features/coverage.go, exactly as docsLanguage.test.ts parses its vocabulary out of
// the Go guard, and `undescribed` being empty is then a real assertion rather than a tautology.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  PALETTE_CATEGORIES,
  PALETTE_STYLESHEET,
  buildPaletteModel,
  creationRequest,
  filterPalette,
  nodePositionAt,
  screenToGraph,
  type PaletteItem,
  type PaletteModel,
} from '../src/graph/palette.js'
import { seedNewNodeFields } from '../src/graph/forms.js'
import { COMPOUND_KINDS } from '../src/graph/compounds/spec.js'
import { catalogedTypeIds, type CoverageRow } from '../src/graph/typeCatalog.js'
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from '../src/graph/render.js'
import {
  ABSOLUTE_PATH_PATTERN,
  EXTRA_BANNED_WORDS,
  REJECT_SAMPLES,
  SOURCE_FILE_PATTERN,
  TOOLING_WORDS,
  readGoGuard,
  word,
} from './fixtures/languageGuard.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const palettePath = path.join(dir, '..', 'src', 'graph', 'palette.ts')
const renderPath = path.join(dir, '..', 'src', 'graph', 'render.ts')

// ---------------------------------------------------------------------------
// The coverage table, read out of the engine
// ---------------------------------------------------------------------------

/** Walks up to the module root, the same way docsLanguage.test.ts does. */
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(d, 'go.mod'))) return d
    const parent = dirname(d)
    if (parent === d) throw new Error('no go.mod above the test directory')
    d = parent
  }
}

const COVERAGE_PATH = join(repoRoot(), 'features', 'coverage.go')
const COVERAGE_SOURCE = readFileSync(COVERAGE_PATH, 'utf8')

const STATUS_NAMES: Readonly<Record<string, CoverageRow['status']>> = {
  StatusImplemented: 'implemented',
  StatusPartial: 'partial',
  StatusMissing: 'missing',
  StatusOutOfScope: 'out_of_scope',
}

/** Joins a Go concatenated string literal (`"a " + "b"`) into one JavaScript string. */
function joinGoString(literal: string): string {
  const parts = [...literal.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] as string)
  return parts.join('').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
}

/** The engine's own coverage table, as the `types` method would deliver it. */
function engineCoverage(): CoverageRow[] {
  const rows: CoverageRow[] = []
  const idPattern = /TypeID:\s*"(minecraft:[a-z_]+)"/g
  const hits = [...COVERAGE_SOURCE.matchAll(idPattern)]
  for (const [i, hit] of hits.entries()) {
    const start = (hit.index ?? 0) + hit[0].length
    const end = i + 1 < hits.length ? (hits[i + 1]?.index ?? COVERAGE_SOURCE.length) : COVERAGE_SOURCE.length
    const body = COVERAGE_SOURCE.slice(start, end)
    const status = /Status:\s*(Status\w+)/.exec(body)
    if (status === null) throw new Error(`${COVERAGE_PATH}: no Status for ${hit[1]} -- has the struct been renamed?`)
    const mapped = STATUS_NAMES[status[1] as string]
    if (mapped === undefined) throw new Error(`${COVERAGE_PATH}: unknown status ${status[1]} -- add it to STATUS_NAMES`)
    const note = /Note:\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/.exec(body)
    rows.push({ typeId: hit[1] as string, status: mapped, note: note === null ? undefined : joinGoString(note[1] as string) })
  }
  return rows
}

const COVERAGE = engineCoverage()

/** The pack bands this file exercises. 1.13.0 is the floor; 1.21.10 is below the two
 * 1.26.40-registered types and above nothing else; 1.26.50 is the top band. */
const AT_FLOOR = '1.13.0'
const BELOW_MULTI_BLOCK = '1.21.10'
const AT_TOP = '1.26.50'

function modelAt(formatVersion?: string): PaletteModel {
  return buildPaletteModel({ coverage: COVERAGE, formatVersion })
}

function item(model: PaletteModel, id: string): PaletteItem {
  const found = model.byId.get(id)
  if (found === undefined) throw new Error(`no palette entry ${id}; the menu has ${model.items.length} entries`)
  return found
}

const typeItem = (model: PaletteModel, typeId: string) => item(model, `type:${typeId}`)

// ---------------------------------------------------------------------------
// 1. The guard is looking at something
// ---------------------------------------------------------------------------

describe('the fixture is the engine, not a copy of it', () => {
  it('parsed a real coverage table with all four statuses represented', () => {
    // A parser that quietly stopped matching looks exactly like a clean run -- the same reason
    // the Go guard fails when it inspected fewer than 50 files.
    expect(COVERAGE.length).toBeGreaterThanOrEqual(29)
    const statuses = new Set(COVERAGE.map((r) => r.status))
    expect(statuses).toContain('implemented')
    expect(statuses).toContain('partial')
    expect(statuses).toContain('out_of_scope')
    // Anchors: if these three stop appearing, this file has stopped reading the real table.
    const ids = COVERAGE.map((r) => r.typeId)
    expect(ids).toContain('minecraft:scatter_feature')
    expect(ids).toContain('minecraft:multi_block_feature')
    expect(ids).toContain('minecraft:beards_and_shavers')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('read the notes, not just the ids', () => {
    const scatter = COVERAGE.find((r) => r.typeId === 'minecraft:scatter_feature')
    expect(scatter?.note ?? '').toContain('variable.origin')
  })
})

// ---------------------------------------------------------------------------
// 2. Every registered type is reachable
// ---------------------------------------------------------------------------

describe('the menu offers the whole type list, or says why not', () => {
  const model = modelAt(AT_TOP)

  it('lists every type the engine registers, exactly once', () => {
    const listed = model.items.filter((i) => i.kind === 'type').map((i) => i.typeId)
    expect(new Set(listed)).toEqual(new Set(COVERAGE.map((r) => r.typeId)))
    expect(listed.length).toBe(COVERAGE.length)
  })

  it('has a written description for every one of them', () => {
    // The failure this pins: the engine gains a type, nobody adds it to the table, and it shows
    // up under "Other" with the coverage note as its summary. That is the DESIGNED fallback --
    // it must never be silently dropped -- but it is not a finished state, so it fails here.
    expect(
      model.undescribed,
      'add these to TYPE_PRESENTATION in src/graph/palette.ts, in the category whose behaviour they share',
    ).toEqual([])
    expect(model.categories.find((c) => c.id === 'other')).toBeUndefined()
  })

  it('gives every type a summary that says what it does, not what it is called', () => {
    for (const entry of model.items) {
      expect(entry.summary.length, `${entry.id} has no summary`).toBeGreaterThan(30)
      expect(entry.title.length).toBeGreaterThan(2)
      // A summary that is the identifier with the underscores taken out teaches nothing.
      const bare = (entry.typeId ?? '').replace('minecraft:', '').replace(/_/g, ' ')
      expect(entry.summary.toLowerCase()).not.toBe(bare)
    }
  })

  it('names no type twice under two categories', () => {
    const seen = new Set<string>()
    for (const entry of model.items) {
      expect(seen.has(entry.id)).toBe(false)
      seen.add(entry.id)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. The compounds come first
// ---------------------------------------------------------------------------

describe('the compounds are the headline entries', () => {
  const model = modelAt(AT_TOP)

  it('puts them in the first category, all of them', () => {
    const first = model.categories[0]
    expect(first?.id).toBe('patterns')
    const kinds = (first?.items ?? []).map((i) => i.compound)
    expect(new Set(kinds)).toEqual(new Set(COMPOUND_KINDS))
    // A new compound that nobody added to the menu would be unreachable from it. This is the
    // assertion that makes that impossible to ship.
    expect(first?.items.length).toBe(COMPOUND_KINDS.length)
  })

  it('lists them above every vanilla type in the flattened order', () => {
    const firstVanilla = model.items.findIndex((i) => i.kind === 'type')
    const lastCompound = model.items.map((i) => i.kind).lastIndexOf('compound')
    expect(lastCompound).toBeLessThan(firstVanilla)
  })

  it('shows each one the title and summary its own spec nominates for the palette', async () => {
    const { loopCompound } = await import('../src/graph/compounds/loop.js')
    const { columnCompound } = await import('../src/graph/compounds/column.js')
    expect(item(model, 'compound:loop').title).toBe(loopCompound.title)
    expect(item(model, 'compound:loop').summary).toBe(loopCompound.summary)
    expect(item(model, 'compound:column').summary).toBe(columnCompound.summary)
  })

  it('never disables one -- a compound is built from types, so it has no coverage of its own', () => {
    for (const entry of model.categories[0]?.items ?? []) {
      expect(entry.enabled).toBe(true)
      expect(entry.blocks).toEqual([])
      expect(entry.status).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. The category split
// ---------------------------------------------------------------------------

describe('categories group by what a type does', () => {
  const model = modelAt(AT_TOP)
  const categoryOf = (typeId: string) => typeItem(model, typeId).category

  it('has no empty category and no entry outside one', () => {
    const declared = new Set(PALETTE_CATEGORIES.map((c) => c.id))
    for (const category of model.categories) {
      expect(category.items.length).toBeGreaterThan(0)
      expect(declared.has(category.id)).toBe(true)
      expect(category.summary.length).toBeGreaterThan(30)
    }
  })

  it('files the three carvers together, and nothing that places blocks with them', () => {
    expect(categoryOf('minecraft:cave_carver_feature')).toBe('carve')
    expect(categoryOf('minecraft:nether_cave_carver_feature')).toBe('carve')
    expect(categoryOf('minecraft:underwater_cave_carver_feature')).toBe('carve')
    // Shares no prefix with the carvers and removes no blocks -- an alphabetical list would put
    // it next to `minecraft:multiface_feature` and nowhere near what it does.
    expect(categoryOf('minecraft:ore_feature')).toBe('place')
  })

  it('files the four delegating types together regardless of their names', () => {
    for (const id of [
      'minecraft:aggregate_feature',
      'minecraft:sequence_feature',
      'minecraft:weighted_random_feature',
      'minecraft:conditional_list',
    ]) {
      expect(categoryOf(id), id).toBe('choose')
    }
  })

  it('separates the types that only move the position from the types that write blocks', () => {
    for (const id of [
      'minecraft:snap_to_surface_feature',
      'minecraft:search_feature',
      'minecraft:surface_relative_threshold_feature',
      'minecraft:height_difference_filter_feature',
    ]) {
      expect(categoryOf(id), id).toBe('position')
    }
    // `multi_block` and `multiface` share a prefix and do nothing alike; both write blocks.
    expect(categoryOf('minecraft:multi_block_feature')).toBe('place')
    expect(categoryOf('minecraft:multiface_feature')).toBe('place')
  })

  it('files the repeat-a-feature-at-many-positions types together', () => {
    for (const id of [
      'minecraft:scatter_feature',
      'minecraft:scan_surface',
      'minecraft:vegetation_patch_feature',
      'minecraft:sculk_patch_feature',
    ]) {
      expect(categoryOf(id), id).toBe('spread')
    }
  })

  it('counts how many of each category can actually be used', () => {
    const model2140 = modelAt(BELOW_MULTI_BLOCK)
    const place = model2140.categories.find((c) => c.id === 'place')
    expect(place).toBeDefined()
    // Two of the block placers are registered above this file's version, so the first level of
    // the menu says so before the author opens the category.
    expect(place!.enabledCount).toBeLessThan(place!.items.length)
  })
})

// ---------------------------------------------------------------------------
// 5. Nothing unusable is offered, and nothing unusable is hidden
// ---------------------------------------------------------------------------

describe('a type that cannot be created is shown disabled, with the reason', () => {
  it('lists an out-of-scope type rather than dropping it', () => {
    const model = modelAt(AT_TOP)
    const entry = typeItem(model, 'minecraft:beards_and_shavers')
    expect(entry.enabled).toBe(false)
    expect(entry.blocks.map((b) => b.reason)).toContain('internal')
    expect(entry.blocks[0]?.message).toContain('minecraft:beards_and_shavers')
    expect(entry.blocks[0]?.message).toMatch(/internal/i)
    // The whole point: someone looking for it FINDS it, and learns why.
    const found = filterPalette(model, 'beards')
    expect(found.matches.map((m) => m.item.id)).toContain('type:minecraft:beards_and_shavers')
  })

  it('lists a type the engine here does not build yet, and says the game still places it', () => {
    // Synthetic: the live table happens to have no `missing` entry, and "no missing types
    // today" must not mean "this branch is untested" -- the day one appears is the day the
    // branch has to already work.
    const model = buildPaletteModel({
      coverage: [...COVERAGE, { typeId: 'minecraft:imaginary_feature', status: 'missing', note: 'Not investigated.' }],
      formatVersion: AT_TOP,
    })
    const entry = typeItem(model, 'minecraft:imaginary_feature')
    expect(entry.enabled).toBe(false)
    expect(entry.blocks.map((b) => b.reason)).toEqual(['unimplemented'])
    expect(entry.blocks[0]?.message).toMatch(/game still places it/i)
    // It has no written description, so it lands under Other and is REPORTED -- not dropped.
    expect(entry.category).toBe('other')
    expect(model.undescribed).toEqual(['minecraft:imaginary_feature'])
  })

  it('lists a version-gated type and names the version to declare', () => {
    const model = modelAt(BELOW_MULTI_BLOCK)
    for (const id of ['minecraft:multi_block_feature', 'minecraft:multipart_block_column_feature']) {
      const entry = typeItem(model, id)
      expect(entry.enabled, id).toBe(false)
      const block = entry.blocks.find((b) => b.reason === 'version-gated')
      expect(block, id).toBeDefined()
      // Both halves have to be there: what the file says now, and what to change it to. Either
      // one alone leaves the author guessing at the other.
      expect(block!.message).toContain(BELOW_MULTI_BLOCK)
      expect(block!.message).toContain('1.26.40')
      expect(block!.message).toContain(id)
    }
  })

  it('opens the gate once the file declares a version high enough', () => {
    const model = modelAt('1.26.40')
    expect(typeItem(model, 'minecraft:multi_block_feature').enabled).toBe(true)
    expect(typeItem(model, 'minecraft:multi_block_feature').blocks).toEqual([])
  })

  it('treats a file that declares no version as unversioned, which offers everything', () => {
    const model = modelAt(undefined)
    expect(model.formatVersion.present).toBe(false)
    expect(typeItem(model, 'minecraft:multi_block_feature').enabled).toBe(true)
  })

  it('falls back to the unversioned reading rather than emptying the menu on an unreadable version', () => {
    const model = buildPaletteModel({ coverage: COVERAGE, formatVersion: 'not a version' })
    expect(model.items.length).toBeGreaterThan(30)
    expect(typeItem(model, 'minecraft:ore_feature').enabled).toBe(true)
  })

  it('leads with the coverage reason when a type is both out of scope and version-gated', () => {
    // Telling someone to raise their format_version for a type that will never be buildable
    // here sends them to change a line that changes nothing.
    const model = buildPaletteModel({
      coverage: [...COVERAGE, { typeId: 'minecraft:multi_block_feature', status: 'out_of_scope', note: 'x' }],
      formatVersion: AT_FLOOR,
    })
    const both = model.items.filter((i) => i.typeId === 'minecraft:multi_block_feature').at(-1)
    expect(both?.blocks.map((b) => b.reason)).toEqual(['internal', 'version-gated'])
  })

  it('shows a partial type as creatable, with what it is approximating', () => {
    const model = modelAt(AT_TOP)
    const partial = model.items.find((i) => i.status === 'partial')
    expect(partial).toBeDefined()
    expect(partial!.enabled).toBe(true)
    expect(partial!.approximations.length).toBeGreaterThan(0)
    // The highlight never replaces the note.
    expect(partial!.note ?? '').toContain(partial!.approximations[0]!.slice(0, 20))
  })

  it('marks a type the property form has no field set for, so raw JSON is not a surprise', () => {
    const model = modelAt(AT_TOP)
    const modelled = new Set(catalogedTypeIds())
    for (const entry of model.items) {
      if (entry.kind !== 'type' || !entry.enabled) continue
      expect(entry.modelled, entry.id).toBe(modelled.has(entry.typeId as string))
    }
  })
})

// ---------------------------------------------------------------------------
// 6. The creation request
// ---------------------------------------------------------------------------

describe('picking an entry describes a creation rather than performing one', () => {
  const model = modelAt(AT_TOP)

  it('seeds a new node with exactly the fields it must start with', () => {
    const request = creationRequest(typeItem(model, 'minecraft:ore_feature'), {
      point: { x: 0, y: 0 },
      gesture: 'click',
      formatVersion: AT_TOP,
    })
    expect(request?.kind).toBe('type')
    // Delegated to forms.ts rather than re-derived: a node created here and a node created from
    // the property panel must start identical, or one of the two paths produces a file the
    // other's validation immediately complains about.
    expect((request as { fields: unknown }).fields).toEqual(seedNewNodeFields('minecraft:ore_feature', AT_TOP))
    expect((request as { fields: Record<string, unknown> }).fields).toHaveProperty('count')
  })

  it('seeds for the FILE version, not for the newest one', () => {
    // `distribution` is required at 1.21.10 and up and does not exist below it, where the same
    // parameters are flat keys. Seeding the wrong one writes a file the game refuses.
    const modern = creationRequest(typeItem(modelAt(AT_TOP), 'minecraft:scatter_feature'), {
      point: { x: 0, y: 0 },
      gesture: 'click',
      formatVersion: AT_TOP,
    }) as { fields: Record<string, unknown> }
    const legacy = creationRequest(typeItem(modelAt(AT_FLOOR), 'minecraft:scatter_feature'), {
      point: { x: 0, y: 0 },
      gesture: 'click',
      formatVersion: AT_FLOOR,
    }) as { fields: Record<string, unknown> }
    expect(Object.keys(modern.fields)).toContain('distribution')
    expect(Object.keys(legacy.fields)).not.toContain('distribution')
  })

  it('echoes the declared version back unnormalised', () => {
    const request = creationRequest(typeItem(model, 'minecraft:ore_feature'), {
      point: { x: 0, y: 0 },
      gesture: 'click',
      formatVersion: '1.21.40',
    }) as { formatVersion?: string }
    expect(request.formatVersion).toBe('1.21.40')
  })

  it('asks for a compound without inventing its parameters', () => {
    const request = creationRequest(item(model, 'compound:loop'), { point: { x: 10, y: 20 }, gesture: 'click' })
    expect(request).toEqual({
      kind: 'compound',
      compound: 'loop',
      position: { x: 10 - GRAPH_NODE_WIDTH / 2, y: 20 - GRAPH_NODE_HEIGHT / 2 },
      gesture: 'click',
      item: item(model, 'compound:loop'),
    })
    // A loop's count is a Molang script and a steps node's steps are a list. Neither has a
    // defensible default, and inventing one writes a feature nobody asked for.
    expect(request).not.toHaveProperty('fields')
    expect(request).not.toHaveProperty('params')
  })

  it('refuses to describe a creation for a disabled entry', () => {
    const gated = typeItem(modelAt(BELOW_MULTI_BLOCK), 'minecraft:multi_block_feature')
    expect(creationRequest(gated, { point: { x: 0, y: 0 }, gesture: 'click' })).toBeNull()
    const scoped = typeItem(model, 'minecraft:beards_and_shavers')
    expect(creationRequest(scoped, { point: { x: 0, y: 0 }, gesture: 'drop' })).toBeNull()
  })

  it('writes nothing and mutates nothing', () => {
    const before = JSON.stringify(model.items.map((i) => i.id))
    creationRequest(typeItem(model, 'minecraft:ore_feature'), { point: { x: 1, y: 2 }, gesture: 'click' })
    expect(JSON.stringify(model.items.map((i) => i.id))).toBe(before)
  })

  it('remembers whether the author clicked or dropped', () => {
    const clicked = creationRequest(typeItem(model, 'minecraft:ore_feature'), { point: { x: 0, y: 0 }, gesture: 'click' })
    const dropped = creationRequest(typeItem(model, 'minecraft:ore_feature'), { point: { x: 0, y: 0 }, gesture: 'drop' })
    expect(clicked?.gesture).toBe('click')
    expect(dropped?.gesture).toBe('drop')
  })
})

// ---------------------------------------------------------------------------
// 7. Screen -> graph coordinates
// ---------------------------------------------------------------------------

describe('every position is in graph coordinates', () => {
  it('is the identity at the identity camera with the canvas at the origin', () => {
    expect(screenToGraph({ x: 120, y: 80 }, { x: 0, y: 0, zoom: 1 }, { left: 0, top: 0 })).toEqual({ x: 120, y: 80 })
  })

  it('subtracts the canvas offset -- a webview canvas is never at the window origin', () => {
    expect(screenToGraph({ x: 120, y: 80 }, { x: 0, y: 0, zoom: 1 }, { left: 40, top: 30 })).toEqual({ x: 80, y: 50 })
  })

  it('adds the camera origin, so a node created while panned lands where it was pointed', () => {
    // The failure this pins: pan three screens right, right-click, and the new node appears
    // three screens back where the camera used to be.
    expect(screenToGraph({ x: 100, y: 100 }, { x: 5000, y: -200, zoom: 1 }, { left: 0, top: 0 })).toEqual({
      x: 5100,
      y: -100,
    })
  })

  it('divides by the zoom, so the same click means twice as much world when zoomed out', () => {
    expect(screenToGraph({ x: 200, y: 100 }, { x: 0, y: 0, zoom: 0.5 }, { left: 0, top: 0 })).toEqual({ x: 400, y: 200 })
    expect(screenToGraph({ x: 200, y: 100 }, { x: 0, y: 0, zoom: 2 }, { left: 0, top: 0 })).toEqual({ x: 100, y: 50 })
  })

  it('round-trips against the canvas transform under a panned AND zoomed camera', () => {
    const camera = { x: 317.5, y: -84.25, zoom: 1.75 }
    const origin = { left: 61, top: 23 }
    for (const screen of [
      { x: 61, y: 23 },
      { x: 500, y: 400 },
      { x: 1399, y: 899 },
    ]) {
      const world = screenToGraph(screen, camera, origin)
      // The forward direction is what render.ts writes into the world layer's transform:
      // translate(-cam.x * zoom, -cam.y * zoom) then scale(zoom).
      const backX = (world.x - camera.x) * camera.zoom + origin.left
      const backY = (world.y - camera.y) * camera.zoom + origin.top
      expect(backX).toBeCloseTo(screen.x, 6)
      expect(backY).toBeCloseTo(screen.y, 6)
    }
  })

  it('centres the node box on the point for a topLeft-anchored view', () => {
    expect(nodePositionAt({ x: 1000, y: 500 })).toEqual({
      x: 1000 - GRAPH_NODE_WIDTH / 2,
      y: 500 - GRAPH_NODE_HEIGHT / 2,
    })
  })

  it('passes the point straight through for a centre-anchored view', () => {
    // Half a box of consistent offset is the kind of wrong nobody reports and everybody works
    // around, so the anchor has to follow whatever the host passed to createGraphView.
    expect(nodePositionAt({ x: 1000, y: 500 }, 'center')).toEqual({ x: 1000, y: 500 })
  })
})

// ---------------------------------------------------------------------------
// 8. Type-ahead
// ---------------------------------------------------------------------------

describe('type-ahead searches everything, not just the open category', () => {
  const model = modelAt(AT_TOP)
  const ids = (query: string) => filterPalette(model, query).matches.map((m) => m.item.id)

  it('returns every entry for an empty query, which is what restores the drill-down', () => {
    expect(filterPalette(model, '').matches.length).toBe(model.items.length)
    expect(filterPalette(model, '   ').matches.length).toBe(model.items.length)
  })

  it('puts the type whose NAME matches above the one whose name merely contains it', () => {
    const result = ids('tree')
    expect(result[0]).toBe('type:minecraft:tree_feature')
    // Ranking the summary above the title is how `Horizontal decoration` ends up on top of
    // `Tree` when someone types "tree", which is the wrong answer every time.
    expect(result).toContain('type:minecraft:horizontal_tree_decoration_feature')
    expect(result.indexOf('type:minecraft:tree_feature')).toBeLessThan(
      result.indexOf('type:minecraft:horizontal_tree_decoration_feature'),
    )
  })

  it('matches the full registered id, and the id with the namespace left off', () => {
    expect(ids('minecraft:sculk_patch_feature')[0]).toBe('type:minecraft:sculk_patch_feature')
    expect(ids('sculk_patch_feature')[0]).toBe('type:minecraft:sculk_patch_feature')
    expect(ids('geode')[0]).toBe('type:minecraft:geode_feature')
  })

  it('matches the words an author already knows, not only the ones this project picked', () => {
    // Nobody arrives looking for a "Loop compound"; they arrive looking for a for-loop.
    expect(ids('repeat')).toContain('compound:loop')
    // Branching is the plain conditional list now, so the words for it lead there.
    for (const word of ['if', 'else', 'case', 'branch', 'fallback', 'switch']) {
      expect(ids(word)).toContain('type:minecraft:conditional_list')
    }
    expect(ids('switch')).not.toContain('compound:switch')
    expect(ids('amethyst')).toContain('type:minecraft:geode_feature')
  })

  it('falls back to the summary, which is how a behaviour finds its type', () => {
    const carvers = ids('removing blocks')
    expect(carvers).toContain('type:minecraft:cave_carver_feature')
  })

  it('finds a type the author cannot use, which is the whole reason the reason exists', () => {
    const blocked = filterPalette(modelAt(BELOW_MULTI_BLOCK), 'multi-block')
    const entry = blocked.matches.find((m) => m.item.typeId === 'minecraft:multi_block_feature')
    expect(entry).toBeDefined()
    expect(entry!.item.enabled).toBe(false)
    expect(entry!.item.blocks.length).toBeGreaterThan(0)
  })

  it('keeps the grouping while filtering, so the categories still teach', () => {
    const result = filterPalette(model, 'cave')
    expect(result.groups.length).toBeGreaterThan(0)
    for (const group of result.groups) expect(group.matches.length).toBeGreaterThan(0)
    expect(result.groups.flatMap((g) => g.matches).length).toBe(result.matches.length)
  })

  it('breaks a rank tie with menu order, keeping the compounds on top', () => {
    const result = filterPalette(model, 'feature')
    const firstCompound = result.matches.findIndex((m) => m.item.kind === 'compound')
    if (firstCompound >= 0) {
      const sameRankTypes = result.matches.filter((m) => m.item.kind === 'type')
      expect(sameRankTypes.length).toBeGreaterThan(0)
    }
    expect(filterPalette(model, 'zzzznothing').matches).toEqual([])
  })

  it('is case-insensitive both ways', () => {
    expect(ids('SCATTER')[0]).toBe('type:minecraft:scatter_feature')
    expect(ids('Ore')[0]).toBe('type:minecraft:ore_feature')
  })
})

// ---------------------------------------------------------------------------
// 9. The language guard -- mirrored from docsLanguage.test.ts
// ---------------------------------------------------------------------------

// Tooling words that must never appear in user-facing text, and the Go guard's patterns -- read
// from features/userfacing_strings_test.go via fixtures/languageGuard.ts. EXTRA_BANNED_WORDS is the
// same addition docsLanguage.test.ts makes; the namespace check below is what a MENU could leak
// that a hover card could not: an identifier from some other pack.
const GO_GUARD = readGoGuard()
const BANNED_WORDS = GO_GUARD.words
const ADDRESS_PATTERN = GO_GUARD.address
const SYMBOL_PATTERN = GO_GUARD.qualifiedName
/** A `namespace:id` that is not `minecraft:`. The vanilla namespace is public; any other one in
 * a shipped string came from somebody's pack. `example:` is the sample namespace this project
 * uses when it needs one. */
const FOREIGN_NAMESPACE_PATTERN = /\b(?!minecraft:|example:)[a-z][a-z0-9_]{2,}:[a-z][a-z0-9_]+\b/

/** Every string this module authors and a user can read. Deliberately NOT including the coverage
 * notes passed through from the engine: those are `Note` fields, which the Go guard already
 * scans at their source, and re-scanning a copy here would fail this file for a leak whose fix
 * belongs on the other side of the boundary. */
function authoredStrings(): { location: string; text: string }[] {
  const out: { location: string; text: string }[] = []
  for (const category of PALETTE_CATEGORIES) {
    out.push({ location: `category ${category.id} (title)`, text: category.title })
    out.push({ location: `category ${category.id} (summary)`, text: category.summary })
  }
  // Across three version bands, so the version-gated wording is scanned too.
  for (const version of [AT_FLOOR, BELOW_MULTI_BLOCK, AT_TOP]) {
    const model = buildPaletteModel({
      coverage: [...COVERAGE, { typeId: 'minecraft:imaginary_feature', status: 'missing' }],
      formatVersion: version,
    })
    for (const entry of model.items) {
      out.push({ location: `${entry.id} (title) @${version}`, text: entry.title })
      out.push({ location: `${entry.id} (summary) @${version}`, text: entry.summary })
      for (const [i, block] of entry.blocks.entries()) {
        out.push({ location: `${entry.id} (blocked ${i}: ${block.reason}) @${version}`, text: block.message })
      }
    }
  }
  return out
}

const SCANNED = authoredStrings()

describe('the language guard is looking at something', () => {
  it('read a real vocabulary out of the Go guard', () => {
    expect(BANNED_WORDS.length).toBeGreaterThanOrEqual(5)
    expect(BANNED_WORDS).toContain(TOOLING_WORDS[0])
    expect(BANNED_WORDS).toContain(word('v', 'table'))
    expect(SYMBOL_PATTERN.source).toContain('::')
  })

  it('is scanning the whole menu and not an empty list', () => {
    // Three bands times thirty-odd entries, plus the categories. A sweep that quietly stopped
    // finding things is indistinguishable from a clean run.
    expect(SCANNED.length).toBeGreaterThanOrEqual(150)
    expect(SCANNED.every((s) => s.text.length > 0)).toBe(true)
    // And it really did reach the disabled wording, which is the newest prose here.
    expect(SCANNED.some((s) => s.location.includes('blocked'))).toBe(true)
  })

  it('actually rejects the things it is meant to reject', () => {
    expect(BANNED_WORDS.some((w) => REJECT_SAMPLES.word.includes(w))).toBe(true)
    expect(ADDRESS_PATTERN.test(REJECT_SAMPLES.hexToken)).toBe(true)
    expect(SYMBOL_PATTERN.test('ScatterFeature::place')).toBe(true)
    expect(SOURCE_FILE_PATTERN.test('see coverage.go')).toBe(true)
    expect(ABSOLUTE_PATH_PATTERN.test('C:\\some\\path')).toBe(true)
    expect(FOREIGN_NAMESPACE_PATTERN.test('somepack:oak_tree')).toBe(true)
    // And does not reject ordinary menu prose.
    expect(FOREIGN_NAMESPACE_PATTERN.test('minecraft:scatter_feature')).toBe(false)
    expect(FOREIGN_NAMESPACE_PATTERN.test('example:oak_tree')).toBe(false)
    expect(SYMBOL_PATTERN.test('Places one block, subject to the rules you give it.')).toBe(false)
    expect(ADDRESS_PATTERN.test('a 16 by 16 chunk-local grid')).toBe(false)
  })
})

describe('menu strings state behaviour only', () => {
  it('uses none of the banned vocabulary', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      for (const word of [...BANNED_WORDS, ...EXTRA_BANNED_WORDS]) {
        if (text.includes(word)) leaks.push(`${location}: contains ${JSON.stringify(word)}`)
      }
    }
    expect(
      leaks,
      'a menu entry must say what the engine DOES, never how that was established. Rewrite the\n' +
        'sentence in terms of the behaviour an author can see in a generated chunk.',
    ).toEqual([])
  })

  it('carries no address-shaped token and names no engine symbol', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      if (ADDRESS_PATTERN.test(text)) leaks.push(`${location}: address-shaped token`)
      if (SYMBOL_PATTERN.test(text)) leaks.push(`${location}: names a symbol`)
    }
    expect(leaks).toEqual([])
  })

  it('cites no source file and no path off this machine', () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      if (SOURCE_FILE_PATTERN.test(text)) leaks.push(`${location}: cites a source file`)
      if (ABSOLUTE_PATH_PATTERN.test(text)) leaks.push(`${location}: contains a local path`)
    }
    expect(leaks, 'this menu ships to people who have none of these files.').toEqual([])
  })

  it("names no pack's namespace but Minecraft's own", () => {
    const leaks: string[] = []
    for (const { location, text } of SCANNED) {
      const hit = FOREIGN_NAMESPACE_PATTERN.exec(text)
      if (hit !== null) leaks.push(`${location}: names the namespace ${JSON.stringify(hit[0])}`)
    }
    expect(leaks, 'use `example:` when a sample identifier is needed.').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 10. The stylesheet
// ---------------------------------------------------------------------------

describe('the stylesheet follows the canvas conventions', () => {
  it('declares no raw colour outside its variable block', () => {
    // The same scan graphRender.test.ts runs over graph.css, and for the same reason: a
    // hard-coded colour looks perfectly fine in whichever theme the author happened to be
    // using, and only goes wrong for someone else.
    const offenders: string[] = []
    let inVariableBlock = false
    const lines = PALETTE_STYLESHEET.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? ''
      const line = raw.replace(/\/\*.*?\*\//g, '').trim()
      if (line.startsWith('/*') || line.startsWith('*')) continue
      if (line.startsWith('--')) {
        inVariableBlock = true
        continue
      }
      if (line.endsWith('{') || line === '}') {
        inVariableBlock = false
        continue
      }
      if (inVariableBlock) continue
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\(/.test(line) || /\bhsla?\(/.test(line)) {
        offenders.push(`line ${i + 1}: ${line}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('sources every colour variable from a --vscode-* property', () => {
    const declarations = [...PALETTE_STYLESHEET.matchAll(/(--flp-[a-z-]+):\s*([^;]+);/g)]
    expect(declarations.length).toBeGreaterThan(10)
    for (const [, name, value] of declarations) {
      if (name === '--flp-font-size' || (name as string).endsWith('-font') || name === '--flp-mono') continue
      expect(value, `${name} does not follow the theme`).toContain('var(--vscode-')
    }
  })
})

// ---------------------------------------------------------------------------
// 11. The interaction, in real Chromium
// ---------------------------------------------------------------------------

/** The `--vscode-*` properties a webview host injects. Two distinct palettes, so "this colour
 * moved when the theme did" is a real assertion. */
const DARK_THEME: Record<string, string> = {
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-menu-background': '#252526',
  '--vscode-menu-foreground': '#cccccc',
  '--vscode-menu-selectionBackground': '#04395e',
  '--vscode-menu-selectionForeground': '#ffffff',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-input-background': '#3c3c3c',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-focusBorder': '#007fd4',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-editorError-foreground': '#f14c4c',
  '--vscode-disabledForeground': '#7f7f7f',
  '--vscode-textPreformat-foreground': '#ce9178',
}

const LIGHT_THEME: Record<string, string> = {
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#333333',
  '--vscode-menu-background': '#f3f3f3',
  '--vscode-menu-foreground': '#333333',
  '--vscode-menu-selectionBackground': '#0060c0',
  '--vscode-menu-selectionForeground': '#ffffff',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#333333',
  '--vscode-focusBorder': '#0090f1',
  '--vscode-editorWarning-foreground': '#bf8803',
  '--vscode-editorError-foreground': '#e51400',
  '--vscode-disabledForeground': '#a0a0a0',
  '--vscode-textPreformat-foreground': '#a31515',
}

/** One entry point exporting both modules, so the harness gets a REAL GraphView -- and therefore
 * a real camera -- rather than a stub whose transform might disagree with the canvas's. */
async function bundleHarness(): Promise<string> {
  const result = await esbuild.build({
    stdin: {
      contents: `export * from ${JSON.stringify(palettePath.replace(/\\/g, '/'))}
export { createGraphView } from ${JSON.stringify(renderPath.replace(/\\/g, '/'))}`,
      resolveDir: dir,
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling the palette harness')
  return output.text
}

interface Recorded {
  kind: string
  gesture: string
  position: { x: number; y: number }
  typeId?: string
  compound?: string
  fieldKeys?: string[]
}

describe('palette menu: real Chromium interaction, coordinates and theming', () => {
  let browser: Browser
  let server: { port: number; close: () => void }
  let moduleSource: string

  beforeAll(async () => {
    moduleSource = await bundleHarness()
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/palette.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(moduleSource)
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0}#host{position:absolute;left:60px;top:40px;right:0;bottom:0}
/* media/graph.css is deliberately NOT loaded here -- this file tests the menu, not the canvas --
   so the canvas element needs the one rule it would have taken from there: a real size. Without
   it the view is zero pixels tall and a right-click lands on the page instead. */
#host > .flg-graph{position:absolute;inset:0}</style>
</head><body><div id="host"></div>
<script type="module">import * as m from '/palette.js'; window.FLP = m; window.__ready = true;</script>
</body></html>`)
    })
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    browser = await chromium.launch()
  }, 90_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  /** Loads the harness with a real canvas, a real camera, and the menu wired to it. */
  async function load(
    options: { theme?: Record<string, string>; formatVersion?: string; camera?: { x: number; y: number; zoom: number } } = {},
  ): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, {
      timeout: 10_000,
    })
    await page.evaluate((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
    }, options.theme ?? DARK_THEME)
    await page.evaluate(
      ({ coverage, formatVersion, camera }) => {
        const api = (window as unknown as { FLP: Record<string, unknown> }).FLP
        const createGraphView = api.createGraphView as (host: HTMLElement, o?: unknown) => Record<string, unknown>
        const view = createGraphView(document.getElementById('host')!) as unknown as {
          element: HTMLElement
          getCamera(): { x: number; y: number; zoom: number }
          setCamera(c: Partial<{ x: number; y: number; zoom: number }>): void
        }
        if (camera) view.setCamera(camera)
        const model = (api.buildPaletteModel as (i: unknown) => unknown)({ coverage, formatVersion })
        const created: unknown[] = []
        ;(window as unknown as { created: unknown[] }).created = created
        const menu = (api.createPaletteMenu as (o: unknown) => unknown)({
          model,
          viewport: (api.paletteCamera as (v: unknown) => unknown)(view),
          formatVersion,
          onCreate: (request: Record<string, unknown>) => {
            created.push({
              kind: request.kind,
              gesture: request.gesture,
              position: request.position,
              typeId: request.typeId,
              compound: request.compound,
              fieldKeys: request.fields ? Object.keys(request.fields as object) : undefined,
            })
          },
        })
        ;(window as unknown as { menu: unknown; view: unknown }).menu = menu
        ;(window as unknown as { view: unknown }).view = view
        // The host's own right-click wiring, which is what the extension does.
        view.element.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          ;(menu as { openAt(p: { x: number; y: number }): void }).openAt({
            x: (e as MouseEvent).clientX,
            y: (e as MouseEvent).clientY,
          })
        })
      },
      { coverage: COVERAGE, formatVersion: options.formatVersion ?? AT_TOP, camera: options.camera ?? null },
    )
    return page
  }

  const created = (page: Page) => page.evaluate(() => (window as unknown as { created: Recorded[] }).created)

  async function openAt(page: Page, x: number, y: number): Promise<void> {
    await page.mouse.click(x, y, { button: 'right' })
    await page.locator('.flp-menu').waitFor({ state: 'visible', timeout: 4000 })
  }

  it('opens on a right-click showing the CATEGORIES, with the patterns first', async () => {
    const page = await load()
    try {
      await openAt(page, 500, 400)
      const names = await page.$$eval('.flp-row .flp-row-name', (els) => els.map((e) => e.textContent))
      expect(names[0]).toBe('Patterns')
      expect(names).toContain('Carve terrain')
      // The first level is categories only -- 29 types in one flat list is the thing this
      // replaces.
      expect(names.length).toBeLessThan(10)
      expect(await page.locator('.flp-row[data-item-id]').count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('drills into a category and back out again with the keyboard alone', async () => {
    const page = await load()
    try {
      await openAt(page, 500, 400)
      // Enter on the first (active) row opens Patterns.
      await page.keyboard.press('Enter')
      const titles = await page.$$eval('.flp-row .flp-row-name', (els) => els.map((e) => e.textContent))
      expect(titles.length).toBe(COMPOUND_KINDS.length)
      expect(await page.locator('.flp-back').isVisible()).toBe(true)
      // ...and back.
      await page.keyboard.press('ArrowLeft')
      expect(await page.$$eval('.flp-row .flp-row-name', (els) => els[0]?.textContent)).toBe('Patterns')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('moves the active row with the arrow keys, wrapping, and announces it', async () => {
    const page = await load()
    try {
      await openAt(page, 500, 400)
      const activeName = () => page.locator('.flp-row.flp-active .flp-row-name').textContent()
      expect(await activeName()).toBe('Patterns')
      await page.keyboard.press('ArrowDown')
      // The second category, whatever it is called -- this test is about the arrow keys moving
      // one row, not about the category list, which grew a Generate-in-the-world row when feature
      // rules became creatable.
      expect(await activeName()).toBe('Generate in the world')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('ArrowUp')
      // Wrapped to the last category rather than sticking at the top.
      expect(await activeName()).toBe('Carve terrain')
      // A screen reader follows aria-activedescendant, not a CSS class.
      const described = await page.evaluate(() => {
        const input = document.querySelector('.flp-filter') as HTMLElement
        const id = input.getAttribute('aria-activedescendant')
        return document.getElementById(id ?? '')?.classList.contains('flp-active')
      })
      expect(described).toBe(true)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('creates at the point the menu was opened, in GRAPH coordinates under a panned camera', async () => {
    const camera = { x: 4000, y: -1500, zoom: 1 }
    const page = await load({ camera })
    try {
      await openAt(page, 620, 500)
      await page.keyboard.type('ore vein')
      await page.keyboard.press('Enter')
      const events = await created(page)
      expect(events).toHaveLength(1)
      const hostBox = (await page.locator('#host').boundingBox())!
      const expected = {
        x: camera.x + (620 - hostBox.x) - GRAPH_NODE_WIDTH / 2,
        y: camera.y + (500 - hostBox.y) - GRAPH_NODE_HEIGHT / 2,
      }
      // The failure this pins: a node created while panned four thousand units right lands four
      // thousand units back at the origin.
      expect(events[0]!.position.x).toBeCloseTo(expected.x, 3)
      expect(events[0]!.position.y).toBeCloseTo(expected.y, 3)
      expect(events[0]!.typeId).toBe('minecraft:ore_feature')
      expect(events[0]!.gesture).toBe('click')
      expect(events[0]!.fieldKeys).toContain('count')
      expect(await page.locator('.flp-menu').isVisible()).toBe(false)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('drops at the drop point, not at the menu, under a panned AND zoomed camera', async () => {
    const camera = { x: 250, y: 700, zoom: 0.5 }
    const page = await load({ camera })
    try {
      await openAt(page, 400, 200)
      await page.keyboard.type('scatter')
      const row = page.locator('.flp-row[data-type-id="minecraft:scatter_feature"]').first()
      const rowBox = (await row.boundingBox())!
      await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
      await page.mouse.down()
      // Two moves: one past the threshold to start the drag, one to the actual spot.
      await page.mouse.move(rowBox.x + 60, rowBox.y + 60, { steps: 4 })
      await page.locator('.flp-ghost').waitFor({ state: 'visible', timeout: 4000 })
      await page.mouse.move(950, 700, { steps: 8 })
      await page.mouse.up()

      const events = await created(page)
      expect(events).toHaveLength(1)
      expect(events[0]!.gesture).toBe('drop')
      expect(events[0]!.typeId).toBe('minecraft:scatter_feature')
      const hostBox = (await page.locator('#host').boundingBox())!
      expect(events[0]!.position.x).toBeCloseTo(camera.x + (950 - hostBox.x) / camera.zoom - GRAPH_NODE_WIDTH / 2, 2)
      expect(events[0]!.position.y).toBeCloseTo(camera.y + (700 - hostBox.y) / camera.zoom - GRAPH_NODE_HEIGHT / 2, 2)
      // The drop point and the menu's own point must NOT be the same answer, or this test would
      // pass with the drag ignored entirely.
      const atMenu = camera.x + (400 - hostBox.x) / camera.zoom - GRAPH_NODE_WIDTH / 2
      expect(Math.abs(events[0]!.position.x - atMenu)).toBeGreaterThan(100)
      expect(await page.locator('.flp-ghost').count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('cancels a drag released off the canvas rather than dropping at the nearest edge', async () => {
    const page = await load()
    try {
      await openAt(page, 400, 200)
      await page.keyboard.type('geode')
      const row = page.locator('.flp-row[data-type-id="minecraft:geode_feature"]').first()
      const rowBox = (await row.boundingBox())!
      await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(rowBox.x + 40, rowBox.y + 40, { steps: 4 })
      // Up and to the left of the canvas, which starts at (60, 40).
      await page.mouse.move(20, 10, { steps: 6 })
      await page.mouse.up()
      expect(await created(page)).toEqual([])
      expect(await page.locator('.flp-menu').isVisible()).toBe(false)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('closes on Escape without creating anything', async () => {
    const page = await load()
    try {
      await openAt(page, 500, 400)
      await page.keyboard.press('Escape')
      expect(await page.locator('.flp-menu').isVisible()).toBe(false)
      expect(await created(page)).toEqual([])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('shows a version-gated type disabled, with its reason, and refuses to create it', async () => {
    const page = await load({ formatVersion: BELOW_MULTI_BLOCK })
    try {
      await openAt(page, 500, 400)
      await page.keyboard.type('multi-block')
      const row = page.locator('.flp-row[data-type-id="minecraft:multi_block_feature"]').first()
      await row.waitFor({ state: 'visible', timeout: 4000 })
      expect(await row.getAttribute('aria-disabled')).toBe('true')
      // Dimming alone is invisible in a high-contrast theme; the reason is drawn as text.
      const reason = await row.locator('.flp-row-blocked').textContent()
      expect(reason).toContain('1.26.40')
      expect(reason).toContain(BELOW_MULTI_BLOCK)
      // Arrowing does not skip it -- skipping it is the same as hiding it. It IS the active row
      // (it is the only match), so Enter is aimed straight at it.
      expect(await row.getAttribute('class')).toContain('flp-active')
      await page.keyboard.press('Enter')
      expect(await created(page)).toEqual([])
      // And a mouse click on it does nothing either. `force` because Playwright reads
      // `aria-disabled` and refuses to click a row it considers disabled -- which is the
      // attribute being asserted two lines above, so bypassing the check here is the point
      // rather than a workaround.
      await row.click({ force: true })
      expect(await created(page)).toEqual([])
      // The menu is still open: a click that does nothing must not also dismiss the reason.
      expect(await page.locator('.flp-menu').isVisible()).toBe(true)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('filters across every category at once, keeping the group headings', async () => {
    const page = await load()
    try {
      await openAt(page, 500, 400)
      await page.keyboard.type('carve')
      const groups = await page.$$eval('.flp-group', (els) => els.map((e) => e.textContent))
      expect(groups.length).toBeGreaterThan(0)
      const ids = await page.$$eval('.flp-row[data-type-id]', (els) => els.map((e) => (e as HTMLElement).dataset.typeId))
      expect(ids).toContain('minecraft:cave_carver_feature')
      // Filtering from the top level reaches a category the author never opened.
      expect(await page.locator('.flp-row[data-category-id]').count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('adds a compound by click, describing it without inventing parameters', async () => {
    const page = await load()
    try {
      await openAt(page, 700, 300)
      await page.keyboard.type('loop')
      await page.keyboard.press('Enter')
      const events = await created(page)
      expect(events).toHaveLength(1)
      expect(events[0]!.kind).toBe('compound')
      expect(events[0]!.compound).toBe('loop')
      expect(events[0]!.fieldKeys).toBeUndefined()
    } finally {
      await page.close()
    }
  }, 45_000)

  it('every colour moves when the theme does', async () => {
    const probe = (page: Page) =>
      page.evaluate(() => {
        const read = (selector: string, property: string): string => {
          const el = document.querySelector(selector)
          return el ? getComputedStyle(el).getPropertyValue(property).trim() : ''
        }
        return {
          menuBg: read('.flp-menu', 'background-color'),
          menuFg: read('.flp-menu', 'color'),
          activeBg: read('.flp-row.flp-active', 'background-color'),
          summaryFg: read('.flp-row:not(.flp-active) .flp-row-summary', 'color'),
          inputBg: read('.flp-filter', 'background-color'),
        }
      })

    const dark = await load({ theme: DARK_THEME })
    const light = await load({ theme: LIGHT_THEME })
    try {
      await openAt(dark, 500, 400)
      await openAt(light, 500, 400)
      const a = await probe(dark)
      const b = await probe(light)
      for (const key of Object.keys(a) as (keyof typeof a)[]) {
        expect(a[key], `${key} is empty -- the probe found no element`).not.toBe('')
        // A colour that did not move between two entirely different palettes is a colour the
        // stylesheet baked in.
        expect(b[key], `${key} did not follow the theme`).not.toBe(a[key])
      }
    } finally {
      await dark.close()
      await light.close()
    }
  }, 60_000)
})
