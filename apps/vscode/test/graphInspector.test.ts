// graphInspector.test.ts -- covers src/graph/inspector.ts, the sidebar that edits a node.
//
// Two halves, the same split graphRender.test.ts uses and for the same reason:
//
//   1. PURE. The decisions -- which rows are shown and which are offered, what an exclusive
//      group's choice is, which spelling a value is written in, what a variant swap emits, how a
//      list element's rows are re-pointed at real data, what the sections are and what each
//      section's documentation lists -- are plain functions and are tested as plain functions,
//      in node.
//   2. REAL BROWSER. The rest runs the bundled module in Playwright's Chromium against the
//      stylesheet the module itself exports, at the sidebar's REAL width, because what remains is
//      DOM and paint: is a row really one line, does hovering really move nothing, does the
//      documentation panel really sit beside the form and never over a control. jsdom answers
//      none of those -- it resolves no custom properties and measures nothing.
//
// THE CONTRACT THIS FILE PINS, after the panel was rebuilt for being usable:
//
//   - A row is `label | control`, ONE LINE, and the panel contains NO explanatory prose: no
//     hint under a control, no default spelled out, no note about how a value is written.
//   - The one-sentence explanation is a native tooltip (`title`) on the row.
//   - One `?` per section opens the documentation PANEL beside the form, and nothing that
//     documents a control may ever overlap that control's box.
//   - A diagnostic about the author's own file stays, one line, under its row.
//
// THE FIXTURE IS REAL DATA. test/fixtures/graph-sample.json is `featurelab graph` output over the
// wiki example pack, and `wiki:acacia_branching_tree` is the case that motivated this module.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildNodeForm, type FormRow, type NodeForm } from '../src/graph/forms.js'
import {
  acceptsMolang,
  chanceSpellingOf,
  coordinateSpellingOf,
  docEntriesFor,
  docEntryOf,
  docPathOf,
  edgeFieldDocEntry,
  edgeFieldHome,
  edgeFieldTooltip,
  elementRows,
  existsAt,
  materialisedEdit,
  exclusiveChoices,
  fieldsOf,
  isScalarList,
  isSectionRow,
  isSet,
  kindGlyph,
  kindLabel,
  listLength,
  newElementValue,
  newWeightedEntry,
  newWeightedSpelling,
  parseDocMarkdown,
  parseDocSpans,
  parseStateValue,
  pathKey,
  plainDocText,
  rangeSpellingOf,
  readBlockValue,
  readDocMarkdown,
  readWeightedEntry,
  resolvePath,
  sectionDocEntries,
  sectionsOf,
  splitRows,
  tooltipFor,
  variantSwapEdits,
  writeBlockValue,
  writeRangeValue,
  INSPECTOR_STYLESHEET,
} from '../src/graph/inspector.js'
import { lookupFieldDoc } from '../src/graph/docs/catalog.js'
import { catalogedTypeIds, typeSpec, type FieldKind, type FieldSpec } from '../src/graph/typeCatalog.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const inspectorPath = path.join(dir, '..', 'src', 'graph', 'inspector.ts')
const samplePath = path.join(dir, 'fixtures', 'graph-sample.json')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SampleNode {
  id: string
  typeId?: string
  file?: string
  formatVersion?: string
  coverage?: string
  coverageNote?: string
  fields?: Record<string, unknown>
}

const SAMPLE = JSON.parse(readFileSync(samplePath, 'utf-8')) as { nodes: SampleNode[] }

function sampleNode(id: string): SampleNode {
  const node = SAMPLE.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`${id} is not in graph-sample.json`)
  return node
}

/** The form for one node of the real sample, exactly as the host would build it. */
function formFor(id: string): NodeForm {
  const node = sampleNode(id)
  return buildNodeForm({
    typeId: node.typeId ?? '',
    ...(node.formatVersion === undefined ? {} : { formatVersion: node.formatVersion }),
    ...(node.fields === undefined ? {} : { fields: node.fields }),
    ...(node.coverage === undefined ? {} : { coverage: node.coverage }),
    ...(node.coverageNote === undefined ? {} : { coverageNote: node.coverageNote }),
  })
}

// Presentation order, with the bare key first -- see the comment where the catalogue sorts them.
const TRUNK_VARIANTS = ['trunk', 'acacia_trunk', 'cherry_trunk', 'fallen_trunk', 'fancy_trunk', 'mangrove_trunk', 'mega_trunk', 'poplar_trunk']

function rowFor(form: NodeForm, key: string): FormRow {
  const row = form.rows.find((candidate) => candidate.spec.key === key && candidate.spec.availability === 'available')
  if (row === undefined) throw new Error(`no available row for ${key}`)
  return row
}

// ---------------------------------------------------------------------------
// 1. Pure: what is shown, what is a choice, what is written
// ---------------------------------------------------------------------------

describe('an exclusive group is one choice, not N fields', () => {
  const form = formFor('wiki:acacia_branching_tree')
  const choices = exclusiveChoices(form.rows, form.typeId)

  it('collects the eight trunk variants into a single required choice with one answer', () => {
    const trunk = choices.find((choice) => choice.name === 'trunk')
    expect(trunk).toBeDefined()
    expect(trunk!.members.map((member) => member.spec.key)).toEqual(TRUNK_VARIANTS)
    expect(trunk!.required).toBe(true)
    expect(trunk!.selected).toBe('acacia_trunk')
    expect(trunk!.conflicts).toEqual([])
    expect(trunk!.doc.length).toBeGreaterThan(0)
  })

  it('reports the canopy group as optional -- "none" is a legal answer there and not for trunk', () => {
    const canopy = choices.find((choice) => choice.name === 'canopy')
    expect(canopy!.required).toBe(false)
    expect(canopy!.selected).toBe('acacia_canopy')
    expect(canopy!.members.length).toBe(12)
  })

  it('names every written member when two are, which is the state the engine refuses', () => {
    const node = sampleNode('wiki:acacia_branching_tree')
    const twoTrunks = buildNodeForm({
      typeId: node.typeId!,
      formatVersion: node.formatVersion!,
      fields: { ...node.fields, fancy_trunk: {} },
    })
    const trunk = exclusiveChoices(twoTrunks.rows, twoTrunks.typeId).find((choice) => choice.name === 'trunk')!
    expect(trunk.conflicts).toEqual(['acacia_trunk', 'fancy_trunk'])
    expect(twoTrunks.notices.some((notice) => notice.level === 'error' && notice.message.includes('trunk'))).toBe(true)
  })

  it('none of the group members is drawn as an ordinary row', () => {
    const split = splitRows(form.rows, new Set())
    const keys = [...split.shown, ...split.addable, ...split.hidden].map((row) => row.spec.key)
    for (const variant of TRUNK_VARIANTS) expect(keys).not.toContain(variant)
  })

  it('swapping a variant removes the old key and starts the new one empty', () => {
    expect(variantSwapEdits('acacia_trunk', 'cherry_trunk')).toEqual([
      { path: ['acacia_trunk'], value: undefined },
      { path: ['cherry_trunk'], value: {} },
    ])
    expect(variantSwapEdits('acacia_canopy', null)).toEqual([{ path: ['acacia_canopy'], value: undefined }])
    expect(variantSwapEdits(null, 'canopy')).toEqual([{ path: ['canopy'], value: {} }])
    expect(variantSwapEdits('trunk', 'trunk')).toEqual([])
  })
})

describe('an unset optional field is offered, not drawn as an empty box', () => {
  it('shows what is set and what is required, and offers the rest', () => {
    const form = formFor('wiki:nether_cave_demo')
    const split = splitRows(form.rows, new Set())
    const shown = split.shown.map((row) => row.spec.key)
    const addable = split.addable.map((row) => row.spec.key)
    expect(shown).toContain('fill_with')
    expect(shown).toContain('width_modifier')
    expect(addable).toContain('height_limit')
    expect(addable).toContain('y_scale')
    expect(shown).not.toContain('height_limit')
    expect(new Set([...shown, ...addable, ...split.hidden.map((r: FormRow) => r.spec.key)]).size).toBe(
      new Set(form.rows.filter((r) => r.spec.exclusiveGroup === undefined).map((r) => r.spec.key)).size,
    )
  })

  it('keeps a required key on screen even when nobody set it -- the file does not load without it', () => {
    const form = buildNodeForm({ typeId: 'minecraft:geode_feature', formatVersion: '1.21.110', fields: {} })
    const split = splitRows(form.rows, new Set())
    expect(split.shown.map((row) => row.spec.key)).toContain('filler')
    expect(split.shown.every((row) => row.spec.required || isSet(row) || row.problems.length > 0)).toBe(true)
    expect(split.addable.map((row) => row.spec.key)).toEqual(['inner_placements'])
  })

  it('moves a revealed key into the shown list without anything being written', () => {
    const form = formFor('wiki:nether_cave_demo')
    const target = rowFor(form, 'height_limit')
    const revealed = splitRows(form.rows, new Set([pathKey(target.path)]))
    expect(revealed.shown.map((row) => row.spec.key)).toContain('height_limit')
    expect(revealed.addable.map((row) => row.spec.key)).not.toContain('height_limit')
    expect(revealed.shown.find((row) => row.spec.key === 'height_limit')!.present).toBe(false)
  })

  it('shows a key the file WROTE that its format_version does not accept, with the reason', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:snap_to_surface_feature',
      formatVersion: '1.21.110',
      fields: { search_range: 4, surface: 'floor' },
    })
    const split = splitRows(form.rows, new Set())
    const shown = split.shown.filter((row) => row.spec.key === 'search_range')
    expect(shown.length).toBe(1)
    expect(shown[0]!.spec.availability).toBe('too-new')
    expect(shown[0]!.spec.availabilityNote).toContain('search_range')
    expect(split.hidden.map((row) => row.spec.key)).not.toContain('search_range')
  })

  it('does not draw -- or offer, or file away -- a key that is inapplicable AND absent', () => {
    // scatter's five parameters moved into a nested `distribution` object at 1.21.10. A 1.21.110
    // file using the nested object is entirely correct, and nothing of the flat keys is shown.
    const form = formFor('wiki:pumpkin_patch')
    expect(form.formatVersion.raw).toBe('1.21.110')
    const split = splitRows(form.rows, new Set())
    const flat = ['scatter_chance', 'coordinate_eval_order', 'x', 'y', 'z']
    for (const key of flat) {
      expect(split.shown.map((row) => row.spec.key)).not.toContain(key)
      expect(split.addable.map((row) => row.spec.key)).not.toContain(key)
    }
    expect(split.hidden.map((row) => row.spec.key).sort()).toEqual([...flat].sort())
    expect(split.hidden.every((row) => !isSet(row) && row.spec.availability !== 'available')).toBe(true)
    const distribution = split.shown.find((row) => row.spec.key === 'distribution')
    expect(distribution).toBeDefined()
    expect(distribution!.spec.availability).toBe('available')
  })

  it('hides a too-new key nobody wrote, in every nested level as well as the top', () => {
    const scatter = buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: '1.13.0', fields: { x: 0 } })
    const scatterSplit = splitRows(scatter.rows, new Set())
    expect(scatterSplit.shown.map((row) => row.spec.key)).not.toContain('distribution')
    expect(scatterSplit.addable.map((row) => row.spec.key)).not.toContain('distribution')
    expect(scatterSplit.hidden.map((row) => row.spec.key)).toContain('distribution')

    const block = buildNodeForm({
      typeId: 'minecraft:single_block_feature',
      formatVersion: '1.21.0',
      fields: { places_block: 'minecraft:stone', enforce_placement_rules: true, enforce_survivability_rules: true, may_attach_to: { top: [] } },
    })
    const attach = block.rows.find((row) => row.spec.key === 'may_attach_to')!
    const inner = attach.editor.control === 'group' ? splitRows(attach.editor.rows, new Set()) : null
    expect(inner).not.toBeNull()
    expect(inner!.shown.map((row) => row.spec.key)).not.toContain('diagonal')
    expect(inner!.addable.map((row) => row.spec.key)).not.toContain('diagonal')
    expect(inner!.hidden.map((row) => row.spec.key)).toContain('diagonal')
  })

  it('a nested group splits the same way as the top level', () => {
    const form = formFor('wiki:hanging_roots_ceiling_block')
    const attach = rowFor(form, 'may_attach_to')
    expect(attach.editor.control).toBe('group')
    const rows = attach.editor.control === 'group' ? attach.editor.rows : []
    const split = splitRows(rows, new Set())
    expect(split.shown.map((row) => row.spec.key)).toEqual(['top'])
    expect(split.addable.length).toBeGreaterThan(5)
  })
})

describe('a primary field is a row even when nobody set it', () => {
  // The report behind this: a freshly created scatter, valid, showed a `distribution` section
  // that was nothing but "+ Add a field (5)". x, y, z and scatter_chance are optional to the
  // engine and they are what a scatter IS; a section that shows nothing until a dropdown is
  // opened and guessed at reads as broken.

  function freshScatter(version: string, fields: Record<string, unknown> = {}): NodeForm {
    return buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: version, fields })
  }

  it('draws the axes and the chance of a fresh scatter, unset, and offers only the eval order', () => {
    const form = freshScatter('1.21.110')
    const distribution = rowFor(form, 'distribution')
    expect(distribution.present).toBe(false)
    const rows = distribution.editor.control === 'group' ? distribution.editor.rows : []
    const split = splitRows(rows, new Set())
    expect(split.shown.map((row) => row.spec.key)).toEqual(['scatter_chance', 'x', 'y', 'z'])
    expect(split.shown.every((row) => !row.present && row.spec.primary === true)).toBe(true)
    expect(split.addable.map((row) => row.spec.key)).toEqual(['coordinate_eval_order'])
    // And the section itself is drawn, though nothing in it is written: the group is required.
    expect(sectionsOf(form, new Set()).map((section) => section.title)).toEqual(['General', 'distribution'])
  })

  it('draws the same four flat on the body of an older file, where the file keeps them', () => {
    const form = freshScatter('1.13.0')
    const split = splitRows(form.rows, new Set())
    for (const key of ['scatter_chance', 'x', 'y', 'z']) expect(split.shown.map((row) => row.spec.key)).toContain(key)
    expect(split.hidden.map((row) => row.spec.key)).toContain('distribution')
  })

  it('never draws a primary key the file\'s version does not accept', () => {
    // The flat spellings are primary too, and at 1.21.110 they are still not part of the form.
    const form = freshScatter('1.21.110')
    const split = splitRows(form.rows, new Set())
    for (const key of ['scatter_chance', 'x', 'y', 'z']) {
      expect(split.shown.map((row) => row.spec.key)).not.toContain(key)
      expect(split.addable.map((row) => row.spec.key)).not.toContain(key)
      expect(split.hidden.map((row) => row.spec.key)).toContain(key)
    }
  })

  it('marks primary sparingly: the keys an author sets almost every time, and no more', () => {
    // The audit, pinned. "Primary" is not "important" -- it is "a section with only this hidden
    // reads as broken". Adding one here is a decision worth a line in the catalogue.
    const primaries: string[] = []
    const walk = (typeId: string, fields: readonly FieldSpec[], trail: string): void => {
      for (const field of fields) {
        const here = `${trail}${field.key}`
        if (field.primary === true) primaries.push(`${typeId} ${here}${field.until === undefined ? '' : ` (before ${field.until})`}`)
        if (field.entry !== undefined) walk(typeId, field.entry, `${here}.`)
      }
    }
    for (const id of catalogedTypeIds()) walk(id, typeSpec(id)!.fields, '')
    expect(primaries.sort()).toEqual(
      [
        // A scatter is its axes and its gate, in both spellings the format has had.
        'minecraft:scatter_feature distribution.scatter_chance',
        'minecraft:scatter_feature distribution.x',
        'minecraft:scatter_feature distribution.y',
        'minecraft:scatter_feature distribution.z',
        'minecraft:scatter_feature scatter_chance (before 1.21.10)',
        'minecraft:scatter_feature x (before 1.21.10)',
        'minecraft:scatter_feature y (before 1.21.10)',
        'minecraft:scatter_feature z (before 1.21.10)',
        // A rule without these is live and inert; a rule for every biome is the rare one.
        'minecraft:feature_rule conditions.minecraft:biome_filter',
        'minecraft:feature_rule distribution',
        'minecraft:feature_rule distribution.iterations',
        'minecraft:feature_rule distribution.x',
        'minecraft:feature_rule distribution.y',
        'minecraft:feature_rule distribution.z',
        // A vein with no replace rules places nothing.
        'minecraft:ore_feature replace_rules',
      ].sort(),
    )
    // Every one of them is optional -- a required key is drawn already, and marking it would be
    // saying the same thing twice.
    for (const id of catalogedTypeIds()) {
      const check = (fields: readonly FieldSpec[]): void => {
        for (const field of fields) {
          if (field.primary === true) expect(field.required, `${id} ${field.key}`).toBe(false)
          if (field.entry !== undefined) check(field.entry)
        }
      }
      check(typeSpec(id)!.fields)
    }
  })

  it('draws a rule\'s distribution as a section with its count and axes, though none is written', () => {
    const form = buildNodeForm({ typeId: 'minecraft:feature_rule', formatVersion: '1.21.110', fields: { conditions: { placement_pass: 'surface_pass' } } })
    const sections = sectionsOf(form, new Set())
    expect(sections.map((section) => section.title)).toEqual(['General', 'conditions', 'distribution'])
    const distribution = sections[2]!
    expect(distribution.row!.present).toBe(false)
    const split = splitRows(distribution.rows, new Set())
    expect(split.shown.map((row) => row.spec.key)).toEqual(['iterations', 'x', 'y', 'z'])
    expect(split.addable.map((row) => row.spec.key)).toEqual(['scatter_chance', 'coordinate_eval_order'])
  })
})

describe('a value the graph carries on an edge is drawn where the file keeps it', () => {
  it('puts iterations in the distribution section of a nested file and in General of a flat one', () => {
    const nested = buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: '1.21.110', fields: {} })
    expect(edgeFieldHome(sectionsOf(nested, new Set()))).toBe('group:["distribution"]')
    const flat = buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: '1.13.0', fields: { x: 1 } })
    expect(edgeFieldHome(sectionsOf(flat, new Set()))).toBe('general')
    // The real sample, which is nested.
    expect(edgeFieldHome(sectionsOf(formFor('wiki:pumpkin_patch'), new Set()))).toBe('group:["distribution"]')
  })

  it('documents it the way a catalogued field is documented, without a catalogue entry to orphan', () => {
    const entry = edgeFieldDocEntry('iterations')
    expect(entry.name).toBe('iterations')
    expect(entry.badges.map((badge) => badge.kind)).toEqual(['required', 'molang'])
    expect(entry.blocks.length).toBeGreaterThan(1)
    const tip = edgeFieldTooltip('iterations')
    expect(tip.split('\n')[0]).toBe('iterations')
    expect(tip).not.toContain('`')
    // The type catalogue still does not have it: it is an edge, and the edge's editor writes it.
    expect(lookupFieldDoc('minecraft:scatter_feature', 'distribution.iterations')).toBeUndefined()
  })
})

describe('the engine\'s spellings are read and written, never normalised behind the author', () => {
  it('recognises all three range spellings and writes the object one with the keys the engine reads', () => {
    expect(rangeSpellingOf(4)).toBe('number')
    expect(rangeSpellingOf([1, 3])).toBe('array')
    expect(rangeSpellingOf({ range_min: 1, range_max: 3 })).toBe('object')
    expect(rangeSpellingOf({ min: 1, max: 3 })).toBeNull()

    expect(writeRangeValue(2, 2, 'number')).toBe(2)
    expect(writeRangeValue(1, 3, 'array')).toEqual([1, 3])
    expect(writeRangeValue(1, 3, 'object')).toEqual({ range_min: 1, range_max: 3 })
    expect(writeRangeValue(1, 3, 'number')).toEqual({ range_min: 1, range_max: 3 })
    expect(JSON.stringify(writeRangeValue(1, 3, 'object'))).not.toContain('"min"')
  })

  it('takes a block descriptor apart into the spelling it was written in, and puts it back', () => {
    expect(readBlockValue('example:stone')).toEqual({ spelling: 'name', name: 'example:stone', states: [], tags: '' })
    expect(readBlockValue({ tags: "q.any_tag('stone')" }).spelling).toBe('tags')
    const withStates = readBlockValue({ name: 'example:log', states: { pillar_axis: 'y' } })
    expect(withStates.spelling).toBe('name-and-states')
    expect(withStates.states).toEqual([['pillar_axis', 'y']])

    expect(writeBlockValue({ spelling: 'name', name: 'example:stone', states: [], tags: '' })).toBe('example:stone')
    expect(writeBlockValue({ spelling: 'name-and-states', name: 'example:log', states: [['pillar_axis', 'y']], tags: '' })).toEqual({
      name: 'example:log',
      states: { pillar_axis: 'y' },
    })
    expect(writeBlockValue({ spelling: 'tags', name: '', states: [], tags: 'q.any_tag()' })).toEqual({ tags: 'q.any_tag()' })
    expect(writeBlockValue({ spelling: 'name', name: '  ', states: [], tags: '' })).toBeUndefined()
    expect(writeBlockValue({ spelling: 'name-and-states', name: 'example:log', states: [['', 'y']], tags: '' })).toEqual({ name: 'example:log' })
  })

  it('types a block state the way the engine does, rather than making everything a string', () => {
    expect(parseStateValue('true')).toBe(true)
    expect(parseStateValue('false')).toBe(false)
    expect(parseStateValue('3')).toBe(3)
    expect(parseStateValue('-1')).toBe(-1)
    expect(parseStateValue('y')).toBe('y')
    expect(parseStateValue('1.5')).toBe('1.5')
  })

  it('reads a weighted entry in both spellings real packs write', () => {
    expect(readWeightedEntry({ block: 'example:a', weight: 3 })).toEqual({ spelling: 'object', block: 'example:a', weight: 3 })
    const pair = readWeightedEntry(['example:cave_vines', 1])
    expect(pair).toEqual({ spelling: 'pair', block: 'example:cave_vines', weight: 1 })
    const sample = sampleNode('wiki:cave_vines').fields!['body_blocks'] as unknown[]
    expect(readWeightedEntry(sample[0]).spelling).toBe('pair')
  })

  it('never offers a weighted-entry spelling the key refuses', () => {
    expect(newWeightedSpelling(['pair', 'object'], ['example:a', 2])).toBe('pair')
    expect(newWeightedSpelling(['pair', 'object'], { block: 'example:a', weight: 2 })).toBe('object')
    expect(newWeightedSpelling(['pair'], { block: 'example:a', weight: 2 })).toBe('pair')
    expect(newWeightedSpelling(['object'], ['example:a', 2])).toBe('object')
    expect(newWeightedSpelling(['pair'], undefined)).toBe('pair')
    expect(newWeightedSpelling(['object'], undefined)).toBe('object')

    expect(newWeightedEntry('pair', 'example:a')).toEqual(['example:a', 1])
    expect(newWeightedEntry('object', 'example:a')).toEqual({ block: 'example:a', weight: 1 })
    expect(newWeightedEntry('pair')).toEqual(['', 1])
  })

  it('reads which spelling a chance and an axis are in', () => {
    expect(chanceSpellingOf(50)).toBe('percent')
    expect(chanceSpellingOf('math.random(0, 100)')).toBe('percent')
    expect(chanceSpellingOf({ numerator: 1, denominator: 4 })).toBe('fraction')
    expect(coordinateSpellingOf(5)).toBe('scalar')
    expect(coordinateSpellingOf({ distribution: 'uniform', extent: [-5, 5] })).toBe('object')
  })
})

describe('list elements are re-pointed at the real data', () => {
  const form = formFor('wiki:diamond_vein')
  const fields = fieldsOf(form)

  it('rebuilds the node\'s fields out of the form, which is all a list needs to draw itself', () => {
    const written = Object.keys(sampleNode('wiki:diamond_vein').fields!).filter((k) => k !== 'description')
    expect(Object.keys(fields).sort()).toEqual(written.sort())
    expect(fields['count']).toBe(sampleNode('wiki:diamond_vein').fields!['count'])
    expect(Object.keys(fields)).not.toContain('description')
  })

  it('binds each element of a group list to its own values', () => {
    const rules = rowFor(form, 'replace_rules')
    expect(rules.editor.control).toBe('group-list')
    const template = rules.editor.control === 'group-list' ? rules.editor.entry : []
    expect(listLength(rules.value)).toBe(1)
    const rows = elementRows(template, rules.path, 0, fields)
    const places = rows.find((row) => row.spec.key === 'places_block')!
    expect(places.path).toEqual(['replace_rules', 0, 'places_block'])
    expect(places.value).toBe('minecraft:diamond_ore')
    expect(places.present).toBe(true)
    expect(places.problems).toEqual([])
  })

  it('addresses a tuple slot of an ARRAY element by index, not by the string key it is catalogued as', () => {
    const plant = formFor('wiki:cave_vines')
    const plantFields = fieldsOf(plant)
    const dist = rowFor(plant, 'height_distribution')
    const template = dist.editor.control === 'group-list' ? dist.editor.entry : []
    const rows = elementRows(template, dist.path, 1, plantFields)
    expect(rows.map((row) => row.path)).toEqual([
      ['height_distribution', 1, 0],
      ['height_distribution', 1, 1],
    ])
    expect(rows[0]!.value).toEqual([2, 7])
    expect(rows[1]!.value).toBe(3)
  })

  it('binds a bare-value list element to the element itself', () => {
    const search = formFor('wiki:search_pumpkin_down')
    const searchFields = fieldsOf(search)
    const volume = rowFor(search, 'search_volume')
    const min = volume.editor.control === 'group' ? volume.editor.rows.find((row) => row.spec.key === 'min')! : undefined
    const template = min?.editor.control === 'group-list' ? min.editor.entry : []
    const rows = elementRows(template, min!.path, 1, searchFields)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.path).toEqual(['search_volume', 'min', 1])
    expect(rows[0]!.value).toBe(-10)
    expect(isSet(rows[0]!)).toBe(true)
    expect(isScalarList(template)).toBe(true)
  })

  it('resolves and probes paths without confusing an absent key for a null one', () => {
    const root = { a: [1, null], b: { c: 0 } }
    expect(resolvePath(root, ['a', '1'])).toEqual(['a', 1])
    expect(resolvePath(root, ['b', 'c'])).toEqual(['b', 'c'])
    expect(existsAt(root, ['a', 1])).toBe(true)
    expect(existsAt(root, ['a', 2])).toBe(false)
    expect(existsAt(root, ['b', 'missing'])).toBe(false)
  })

  it('starts a new element as the empty shape rather than a plausible body', () => {
    const rules = rowFor(form, 'replace_rules')
    const template = rules.editor.control === 'group-list' ? rules.editor.entry : []
    expect(newElementValue(template)).toEqual({})
    expect(isScalarList(template)).toBe(false)
    const search = formFor('wiki:search_pumpkin_down')
    const volume = rowFor(search, 'search_volume')
    const min = volume.editor.control === 'group' ? volume.editor.rows.find((row) => row.spec.key === 'min')! : undefined
    const bare = min?.editor.control === 'group-list' ? min.editor.entry : []
    expect(newElementValue(bare)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 1b. Pure: the Markdown the documentation catalogue actually emits
// ---------------------------------------------------------------------------

describe('the documentation Markdown, and only the part of it the catalogue writes', () => {
  it('renders a code span, and binds it before a strong run', () => {
    expect(parseDocSpans('With the default `none` every child runs.')).toEqual([
      { kind: 'text', text: 'With the default ' },
      { kind: 'code', text: 'none' },
      { kind: 'text', text: ' every child runs.' },
    ])
    expect(parseDocSpans('`a ** b`')).toEqual([{ kind: 'code', text: 'a ** b' }])
  })

  it('renders the "Not established." lead as strong -- the catalogue\'s only use of bold', () => {
    expect(parseDocSpans('**Not established.** Accepted here.')).toEqual([
      { kind: 'strong', text: 'Not established.' },
      { kind: 'text', text: ' Accepted here.' },
    ])
  })

  it('emphasises a WHOLE paragraph and never a run inside one', () => {
    const [facts] = parseDocMarkdown('_optional -- absent: none_')
    expect(facts).toEqual({ emphasis: true, spans: [{ kind: 'text', text: 'optional -- absent: none' }] })
    const [inner] = parseDocMarkdown('_optional -- absent: 1 -- a bare fixed_grid/jittered_grid axis_')
    expect(inner!.emphasis).toBe(true)
    expect(inner!.spans[0]!.text).toContain('fixed_grid/jittered_grid')
    const [prose] = parseDocMarkdown('Side counting reaches min_sides_must_attach, not auto_rotate.')
    expect(prose!.emphasis).toBe(false)
    expect(prose!.spans).toEqual([{ kind: 'text', text: 'Side counting reaches min_sides_must_attach, not auto_rotate.' }])
  })

  it('leaves an unpaired delimiter as text', () => {
    expect(parseDocSpans('At least one of the three can_place_on_* flags must be on.')).toEqual([
      { kind: 'text', text: 'At least one of the three can_place_on_* flags must be on.' },
    ])
    expect(parseDocSpans('an opening ` with no closer')).toEqual([{ kind: 'text', text: 'an opening ` with no closer' }])
    expect(parseDocSpans('**unclosed strong')).toEqual([{ kind: 'text', text: '**unclosed strong' }])
  })

  it('splits on blank lines and folds a wrapped line into its paragraph', () => {
    const blocks = parseDocMarkdown('One line.\n\nA paragraph that was\nassembled from two source lines.')
    expect(blocks).toHaveLength(2)
    expect(blocks[1]!.spans[0]!.text).toBe('A paragraph that was assembled from two source lines.')
  })

  it('lifts the leading lone code span off as a title', () => {
    const { title, blocks } = readDocMarkdown('`early_out`\n\nWhether the list stops early.\n\n_optional_')
    expect(title).toBe('early_out')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.spans[0]!.text).toBe('Whether the list stops early.')
    expect(readDocMarkdown('Just prose.').title).toBeNull()
    expect(readDocMarkdown('`a` and `b`').title).toBeNull()
  })

  it('flattens a sentence to plain text for a tooltip, which renders no markup', () => {
    expect(plainDocText('Chance to skip a block that would sit next to `depth`.')).toBe('Chance to skip a block that would sit next to depth.')
    expect(plainDocText('**Not established.** Accepted\nhere.')).toBe('Not established. Accepted here.')
  })
})

// ---------------------------------------------------------------------------
// 1c. Pure: sections, and what each one documents
// ---------------------------------------------------------------------------

describe('the panel is a column of sections, one `?` each', () => {
  it('bottoms out four key levels deep, and the last two levels are scalars', () => {
    // The measurement the nesting rule is built on, taken rather than imagined.
    let deepest = 0
    let deepestPath = ''
    const walk = (fields: readonly FieldSpec[], depth: number, trail: string): void => {
      for (const field of fields) {
        const here = `${trail}.${field.key}`
        if (depth > deepest) {
          deepest = depth
          deepestPath = here
        }
        if (field.entry !== undefined && field.entry.length > 0) walk(field.entry, depth + 1, here)
      }
    }
    for (const id of catalogedTypeIds()) {
      const spec = typeSpec(id)
      if (spec !== undefined) walk(spec.fields, 0, id)
    }
    expect(deepest).toBe(3)
    expect(deepestPath).toMatch(/(extent|intervals)\.$/)
  })

  it('makes a tree General, then its trunk and canopy choices, in the catalogue\'s order', () => {
    const form = formFor('wiki:acacia_branching_tree')
    const sections = sectionsOf(form, new Set())
    expect(sections.map((section) => [section.kind, section.title])).toEqual([
      ['general', 'General'],
      ['choice', 'trunk'],
      ['choice', 'canopy'],
    ])
    // The trunk section's rows are the WRITTEN variant's members, so the section edits the
    // variant's body directly under the chooser rather than nesting it under its own key.
    const trunk = sections[1]!
    expect(trunk.choice!.selected).toBe('acacia_trunk')
    expect(trunk.rows.map((row) => row.spec.key)).toContain('trunk_height')
    // General holds no variant and no group that became a section of its own.
    for (const row of sections[0]!.rows) expect(row.spec.exclusiveGroup).toBeUndefined()
  })

  it('makes every drawn top-level group a section, and offers an undrawn one from General', () => {
    const form = formFor('wiki:pumpkin_patch')
    const sections = sectionsOf(form, new Set())
    expect(sections.map((section) => section.title)).toEqual(['General', 'distribution'])
    expect(sections[1]!.row!.spec.key).toBe('distribution')
    expect(isSectionRow(sections[1]!.row!)).toBe(true)

    const block = buildNodeForm({ typeId: 'minecraft:single_block_feature', formatVersion: '1.21.110', fields: { places_block: 'example:a' } })
    const before = sectionsOf(block, new Set())
    expect(before.map((section) => section.title)).toEqual(['General'])
    // Unset and optional, so it is an offer in General...
    const attach = rowFor(block, 'may_attach_to')
    expect(splitRows(before[0]!.rows, new Set()).addable.map((row) => row.spec.key)).toContain('may_attach_to')
    // ...and a section the moment the author reveals it, with nothing written.
    const after = sectionsOf(block, new Set([pathKey(attach.path)]))
    expect(after.map((section) => section.title)).toEqual(['General', 'may_attach_to'])
    expect(splitRows(after[0]!.rows, new Set([pathKey(attach.path)])).addable.map((row) => row.spec.key)).not.toContain('may_attach_to')
  })

  it('files the keys the catalogue does not model into a section of their own', () => {
    const form = buildNodeForm({ typeId: 'minecraft:ore_feature', formatVersion: '1.21.110', fields: { count: 3, mystery: 1 } })
    const sections = sectionsOf(form, new Set())
    expect(sections[sections.length - 1]!.kind).toBe('extras')
    expect(sections[sections.length - 1]!.rows.map((row) => row.spec.key)).toEqual(['mystery'])
  })
})

describe('what a section\'s documentation lists', () => {
  it('documents a choice as one entry with every variant as a value, then the written variant\'s fields', () => {
    const form = formFor('wiki:acacia_branching_tree')
    const trunk = sectionsOf(form, new Set()).find((section) => section.key === 'choice:trunk')!
    const entries = sectionDocEntries(form, trunk)
    expect(entries[0]!.name).toBe('trunk')
    expect(entries[0]!.badges.map((badge) => badge.kind)).toEqual(['required'])
    expect(entries[0]!.values.map((value) => value.name)).toEqual(TRUNK_VARIANTS)
    // Every variant has its own sentence, not just a name.
    for (const value of entries[0]!.values) expect(value.blocks.length).toBeGreaterThan(0)
    // The same name appears as the mode and as a value -- `trunk` the choice, `trunk` the plain
    // variant -- and neither is de-duplicated away.
    expect(entries[0]!.values.some((value) => value.name === 'trunk')).toBe(true)
    // The written variant's fields follow, parents before members, named by their path.
    const names = entries.slice(1).map((entry) => `${entry.parent}${entry.name}`)
    expect(names).toContain('trunk_height')
    expect(names).toContain('trunk_height.base')
    expect(names.indexOf('trunk_height')).toBeLessThan(names.indexOf('trunk_height.base'))
  })

  it('documents a group with its version band and every nested axis parameter', () => {
    const form = formFor('wiki:pumpkin_patch')
    const distribution = sectionsOf(form, new Set()).find((section) => section.key.startsWith('group:'))!
    const entries = sectionDocEntries(form, distribution)
    const head = entries[0]!
    expect(head.name).toBe('distribution')
    expect(head.glyph).toBe(kindGlyph('group'))
    expect(head.badges.map((badge) => badge.label)).toEqual(['required', '1.21.10+'])
    const names = entries.map((entry) => `${entry.parent}${entry.name}`)
    expect(names).toContain('x')
    expect(names).toContain('x.distribution')
    expect(names).toContain('x.extent')
    // An enum's values are all there, each with a sentence.
    const kind = entries.find((entry) => `${entry.parent}${entry.name}` === 'x.distribution')!
    expect(kind.values.map((value) => value.name)).toContain('fixed_grid')
    expect(kind.values.every((value) => value.blocks.length > 0)).toBe(true)
    // A Molang-taking field says so.
    const chance = entries.find((entry) => entry.name === 'scatter_chance')!
    expect(chance.badges.map((badge) => badge.kind)).toContain('molang')
    expect(chance.facts.some((fact) => fact.startsWith('Absent:'))).toBe(true)
  })

  it('lists a version-gated key the form hides, with its band, because this is documentation of the type', () => {
    const form = buildNodeForm({ typeId: 'minecraft:snap_to_surface_feature', formatVersion: '1.21.110', fields: { surface: 'floor' } })
    const general = sectionsOf(form, new Set())[0]!
    const entries = sectionDocEntries(form, general)
    const gated = entries.find((entry) => entry.name === 'search_range')
    expect(gated).toBeDefined()
    expect(gated!.badges.some((badge) => badge.kind === 'version' && /\+$/.test(badge.label))).toBe(true)
  })

  it('records a behaviour that is NOT established as a badge and a lead, never as an empty entry', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:single_block_feature',
      formatVersion: '1.21.110',
      fields: { places_block: 'example:lantern', may_not_attach_to: { min_sides_must_attach: 2 } },
    })
    const section = sectionsOf(form, new Set()).find((candidate) => candidate.title === 'may_not_attach_to')!
    const entry = sectionDocEntries(form, section).find((candidate) => candidate.name === 'min_sides_must_attach')!
    expect(entry.badges.map((badge) => badge.kind)).toContain('unestablished')
    expect(entry.blocks[0]!.spans[0]).toEqual({ kind: 'strong', text: 'Not established.' })
    expect(tooltipFor(form.typeId, rowFor(form, 'may_not_attach_to'))).not.toContain('`')
  })

  it('gives every kind a glyph and says which kinds take Molang', () => {
    const kinds: FieldKind[] = ['block', 'blockList', 'weightedBlockList', 'range', 'enum', 'boolean', 'number', 'integer', 'molangOrNumber', 'chance', 'string', 'group', 'groupList', 'coordinate', 'json']
    for (const kind of kinds) {
      expect(kindGlyph(kind).length).toBeGreaterThan(0)
      expect(kindGlyph(kind).length).toBeLessThanOrEqual(2)
      expect(kindLabel(kind).length).toBeGreaterThan(0)
    }
    expect(acceptsMolang('molangOrNumber')).toBe(true)
    expect(acceptsMolang('chance')).toBe(true)
    expect(acceptsMolang('integer')).toBe(false)
  })

  it('makes the tooltip the key and the catalogue\'s one sentence, in plain text', () => {
    const form = formFor('wiki:cave_demo')
    const row = rowFor(form, 'width_modifier')
    const summary = lookupFieldDoc(form.typeId, 'width_modifier')!.entry!.summary
    const tip = tooltipFor(form.typeId, row)
    expect(tip.split('\n')[0]).toBe('width_modifier')
    expect(tip).toContain(plainDocText(summary))
    expect(tip).not.toContain('`')
    // No sentence, just the key -- never an empty tooltip.
    const bare: FormRow = { ...row, spec: { ...row.spec, key: 'nothing_known', doc: undefined }, path: ['nothing_known'] }
    expect(tooltipFor(form.typeId, bare)).toBe('nothing_known')
    expect(docEntryOf(form.typeId, row).blocks.length).toBeGreaterThan(0)
    expect(docEntriesFor(form.typeId, [row])).toHaveLength(1)
  })

  it('keys the documentation by the path with indices dropped', () => {
    expect(docPathOf(['replace_rules', 0, 'may_replace'])).toBe('replace_rules.may_replace')
    expect(docPathOf(['distribution', 'x', 'distribution'])).toBe('distribution.x.distribution')
  })
})

describe('the stylesheet', () => {
  it('declares no raw colour outside its variable block', () => {
    const offenders: string[] = []
    let inVariableBlock = false
    const lines = INSPECTOR_STYLESHEET.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? '').replace(/\/\*.*?\*\//g, '').trim()
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
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\(/.test(line) || /\bhsla?\(/.test(line)) offenders.push(`line ${i + 1}: ${line}`)
    }
    expect(offenders).toEqual([])
  })

  it('reads every colour it uses out of a --vscode-* property', () => {
    const declared = [...INSPECTOR_STYLESHEET.matchAll(/--fli-[a-z-]+:\s*([^;]+);/g)].map((match) => match[1] as string)
    expect(declared.length).toBeGreaterThan(10)
    for (const value of declared) expect(value).toContain('var(--vscode-')
  })
})

// ---------------------------------------------------------------------------
// 2. Real browser: the panel a person actually looks at
// ---------------------------------------------------------------------------

/** A trimmed but real Dark+ palette, injected as `--vscode-*` on <html> exactly as the webview
 * host injects it. */
const DARK_THEME: Record<string, string> = {
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-editorHoverWidget-background': '#1f1f1f',
  '--vscode-editorHoverWidget-border': '#454545',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-input-placeholderForeground': '#989898',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-button-secondaryBackground': '#313131',
  '--vscode-button-secondaryForeground': '#cccccc',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-textPreformat-foreground': '#d7ba7d',
  '--vscode-textCodeBlock-background': '#2a2a2a',
  '--vscode-editorError-foreground': '#f14c4c',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-charts-blue': '#4e94ce',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

/** Every property the stylesheet reads, given a colour no palette would produce. Against this,
 * any rendered colour that fails to move between it and Dark+ is a colour something baked in. */
function sentinelTheme(): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  for (const name of Object.keys(DARK_THEME)) {
    if (name.endsWith('-family') || name.endsWith('-size')) {
      out[name] = DARK_THEME[name] as string
      continue
    }
    const n = i * 7 + 11
    out[name] = `rgb(${((n * 13) % 200) + 20}, ${((n * 29) % 200) + 20}, ${((n * 53) % 200) + 20})`
    i++
  }
  return out
}

/** The module under test, plus the two things the browser half needs beside it: the edge editor
 * an `iterations` row is drawn over (the host constructs it; here the page does), and the Molang
 * control's own stylesheet, which the host installs next to the inspector's. */
async function bundleInspector(): Promise<string> {
  const result = await esbuild.build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(inspectorPath)}`,
        `export { MolangEdgeEditor } from ${JSON.stringify(path.join(dir, '..', 'src', 'graph', 'molangEdge.ts'))}`,
        `export { MOLANG_FIELD_STYLESHEET } from ${JSON.stringify(path.join(dir, '..', 'src', 'graph', 'molangField.ts'))}`,
      ].join('\n'),
      resolveDir: path.dirname(inspectorPath),
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
  if (!output) throw new Error('esbuild produced no output bundling src/graph/inspector.ts')
  return output.text
}

interface EmittedChange {
  label: string
  path: (string | number)[]
  edits: { path: (string | number)[]; value: unknown }[]
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** The sidebar's real width in the graph editor's shell, with the padding #flg-side gives it. */
const SIDEBAR_WIDTH = 320

describe('node inspector: real Chromium DOM, interaction and theming', () => {
  let browser: Browser
  let server: { port: number; close: () => void }
  let moduleSource: string

  beforeAll(async () => {
    moduleSource = await bundleInspector()
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/inspector.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(moduleSource)
        return
      }
      // The graph editor's own shape: a canvas that takes the width and a sidebar of the width
      // media/graph.css and graphPanel.ts give it, so every measurement here is at the width an
      // author gets.
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0}#body{position:absolute;inset:0;display:flex}#canvas{flex:1 1 auto;min-width:0;position:relative;overflow:hidden}#side{flex:0 0 ${SIDEBAR_WIDTH}px;min-width:0;overflow-y:auto;padding:10px 12px;box-sizing:border-box}</style>
</head><body><div id="body"><div id="canvas"></div><div id="side"></div></div>
<script type="module">
import * as m from '/inspector.js'
window.FLI = m
const style = document.createElement('style')
style.textContent = m.INSPECTOR_STYLESHEET
document.head.append(style)
// The host installs the Molang control's stylesheet beside the inspector's; so does this page.
const molang = document.createElement('style')
molang.textContent = m.MOLANG_FIELD_STYLESHEET
document.head.append(molang)
window.__ready = true
</script>
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

  /** Loads the harness and draws `form`. The form is built HERE, in node, by the same
   * buildNodeForm the extension calls, and handed over as data -- so the browser half is testing
   * this module's rendering and nothing else. */
  /** An `iterations` edge for the node, built in the page the way webview/graph.ts builds one
   * for the edge panel: the same MolangEdgeEditor class, the value and the path the graph
   * builder would report, an offline validator. */
  interface EdgeIterations {
    value: string | null
    fieldPath: string
  }

  async function load(
    form: NodeForm,
    opts: { theme?: Record<string, string>; nodeId?: string; docsHost?: boolean; height?: number; iterations?: EdgeIterations } = {},
  ): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 900, height: opts.height ?? 1400 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 10_000 })
    await page.evaluate((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
    }, opts.theme ?? DARK_THEME)
    await page.evaluate(
      ({ payload, id, hosted, iterations }) => {
        const api = (window as unknown as { FLI: Record<string, unknown> }).FLI
        const create = api['createNodeInspector'] as (form: unknown, options: unknown) => { element: HTMLElement }
        const changes: unknown[] = []
        ;(window as unknown as { changes: unknown[] }).changes = changes
        // What the EDGE's editor emitted -- the writes the host would turn into applyEdits at
        // `fieldPath`. Kept apart from `changes` so a test can say which path a value took.
        const edgeChanges: unknown[] = []
        ;(window as unknown as { edgeChanges: unknown[] }).edgeChanges = edgeChanges
        let edgeFields: unknown[] = []
        if (iterations !== null) {
          const Editor = api['MolangEdgeEditor'] as new (input: unknown, options: unknown) => { onChange(listener: (change: unknown) => void): () => void }
          const editor = new Editor(
            {
              edge: { from: id, to: 'example:placed', kind: 'scatter', jsonPath: '$["minecraft:scatter_feature"].places_feature', required: true },
              field: 'iterations',
              value: iterations.value,
              fieldPath: iterations.fieldPath,
              origin: { x: 0, y: 0, z: 0 },
            },
            { validator: { validate: async () => ({}) }, schedule: (run: () => void) => (run(), () => {}) },
          )
          editor.onChange((change) => edgeChanges.push(change))
          ;(window as unknown as { edgeEditor: unknown }).edgeEditor = editor
          edgeFields = [{ key: 'iterations', editor }]
        }
        const view = create(payload, {
          nodeId: id,
          ...(hosted ? { docsHost: document.getElementById('canvas') } : {}),
          edgeFields,
          onChange: (change: { edits: { path: unknown; value: unknown }[]; path: unknown; label: string }) => {
            // `undefined` does not survive JSON, and "remove the key" is exactly the case this
            // module exists to keep distinct from writing null -- so it is spelled out here.
            changes.push({
              label: change.label,
              path: change.path,
              edits: change.edits.map((edit) => ({ path: edit.path, value: edit.value === undefined ? '<remove>' : edit.value })),
            })
          },
        })
        ;(window as unknown as { view: unknown }).view = view
        document.getElementById('side')!.append(view.element)
      },
      {
        payload: JSON.parse(JSON.stringify(form)) as unknown,
        id: opts.nodeId ?? 'example:node',
        hosted: opts.docsHost !== false,
        iterations: opts.iterations ?? null,
      },
    )
    return page
  }

  async function changesOf(page: Page): Promise<EmittedChange[]> {
    return (await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { changes: unknown[] }).changes)))) as EmittedChange[]
  }

  /** What the edge's own editor emitted: `{ kind, value }` per change, with the edge dropped. */
  async function edgeChangesOf(page: Page): Promise<{ kind: string; value?: unknown; annotation?: unknown }[]> {
    return (await page.evaluate(() =>
      JSON.parse(
        JSON.stringify(
          ((window as unknown as { edgeChanges: { kind: string; value?: unknown; annotation?: unknown }[] }).edgeChanges).map((change) => ({
            kind: change.kind,
            ...(change.value === undefined ? {} : { value: change.value }),
            ...(change.annotation === undefined ? {} : { annotation: change.annotation }),
          })),
        ),
      ),
    )) as { kind: string; value?: unknown; annotation?: unknown }[]
  }

  /** The value the EDGE holds now, read off its editor -- the one place the truth lives. */
  async function edgeText(page: Page): Promise<string> {
    return page.evaluate(() => (window as unknown as { edgeEditor: { view(): { text: string } } }).edgeEditor.view().text)
  }

  /** Every control in the form, with its box. */
  async function controlBoxes(page: Page): Promise<{ name: string; box: Box }[]> {
    return page.$$eval('.flg-inspector input, .flg-inspector select, .flg-inspector textarea, .flg-inspector button', (els) =>
      els
        .map((el) => {
          const rect = el.getBoundingClientRect()
          return { name: `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.id}]`, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
        })
        .filter((entry) => entry.box.width > 0 && entry.box.height > 0),
    )
  }

  // -------------------------------------------------------------------------
  // The shape of a row
  // -------------------------------------------------------------------------

  it('draws every row as one line: label in the gutter, control filling the rest', async () => {
    // Measured on the hardest type there is, at the real sidebar width. The ONE exception is a
    // raw-JSON box, which is a multi-line control by nature and the only one in the panel.
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      const rows = await page.$$eval('.flg-ins-row', (els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect()
          const line = parseFloat(getComputedStyle(el).fontSize) * 1.4
          const label = el.querySelector(':scope > .flg-ins-key')?.getBoundingClientRect()
          const control = el.querySelector(':scope > .flg-ins-control')?.getBoundingClientRect()
          return {
            key: (el as HTMLElement).dataset['key'] ?? el.textContent?.trim().slice(0, 16) ?? '',
            lines: rect.height / line,
            json: el.querySelector('textarea') !== null,
            width: rect.width,
            labelRight: label === undefined ? null : label.right,
            controlLeft: control === undefined || control.width === 0 ? null : control.left,
            sameLine: label !== undefined && control !== undefined && control.width > 0 ? Math.abs(label.top + label.height / 2 - (control.top + control.height / 2)) < 8 : true,
          }
        }),
      )
      expect(rows.length).toBeGreaterThan(30)
      const tall = rows.filter((row) => !row.json && row.lines >= 2).map((row) => `${row.key}: ${row.lines.toFixed(2)} lines`)
      expect(tall).toEqual([])
      // The label sits left of the control, on the same line, and nothing pokes out of the
      // sidebar: the control column is never wider than what it was given.
      for (const row of rows) {
        if (row.labelRight !== null && row.controlLeft !== null) expect(row.labelRight).toBeLessThanOrEqual(row.controlLeft)
        expect(row.sameLine).toBe(true)
        expect(row.width).toBeLessThanOrEqual(SIDEBAR_WIDTH)
      }
      // And the panel never scrolls sideways.
      const overflow = await page.locator('.flg-inspector').evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    } finally {
      await page.close()
    }
  }, 60_000)

  it('lines every control up on one vertical edge, however deep its key is nested', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      // `base` is three key levels down and `trunk_width` is one; both boxes start on the same
      // x, because a nested row gives up as much gutter as its indent took.
      const base = await page.locator('.flg-ins-row[data-key="base"] > .flg-ins-control').boundingBox()
      const width = await page.locator('.flg-ins-row[data-key="trunk_width"] > .flg-ins-control').boundingBox()
      expect(Math.abs(base!.x - width!.x)).toBeLessThan(2)
      // The label is right-aligned against the control: its text ends where the gutter does.
      const label = await page.locator('.flg-ins-row[data-key="base"] > .flg-ins-key').boundingBox()
      expect(base!.x - (label!.x + label!.width)).toBeLessThan(10)
      // A nested group is a heading row with its members indented under it, not a box.
      expect(await page.locator('.flg-ins-row[data-key="trunk_height"]').getAttribute('data-depth')).toBe('0')
      expect(await page.locator('.flg-ins-row[data-key="base"]').getAttribute('data-depth')).toBe('1')
      expect(await page.locator('.flg-ins-row[data-key="trunk_height"]').getAttribute('role')).toBe('group')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('contains no explanatory prose: labels, controls and the author\'s own problems, nothing else', async () => {
    for (const id of ['wiki:acacia_branching_tree', 'wiki:pumpkin_patch', 'wiki:cave_vines', 'wiki:nether_cave_demo']) {
      const page = await load(formFor(id))
      try {
        // None of the old prose surfaces exists, by class or by sentence.
        for (const gone of ['.flg-ins-hint', '.flg-ins-tip', '.flg-ins-tips', '.flg-ins-doccard', '.flg-ins-footnote', '.flg-ins-doc', '.flg-ins-valuenote']) {
          expect(await page.locator(`.flg-inspector ${gone}`).count(), gone).toBe(0)
        }
        const text = (await page.locator('.flg-inspector').textContent()) ?? ''
        expect(text).not.toMatch(/Left out:/)
        expect(text).not.toMatch(/not in this editor's catalogue/)
        // Every visible text run outside a diagnostic is a label, a key, a number or a button's
        // word -- never a sentence. Forty characters is well past the longest key.
        const long = await page.$$eval('.flg-inspector', (els) => {
          const out: string[] = []
          const walker = document.createTreeWalker(els[0]!, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const parent = (node as Text).parentElement
            if (parent === null || parent.closest('.flg-ins-notice, .flg-ins-problem, .flg-ins-warn, option') !== null) continue
            const text = (node.textContent ?? '').trim()
            if (text.length > 40) out.push(text)
          }
          return out
        })
        expect(long).toEqual([])
      } finally {
        await page.close()
      }
    }
  }, 90_000)

  it('carries the one-sentence explanation as a native tooltip on the row', async () => {
    const page = await load(formFor('wiki:cave_demo'))
    try {
      const row = page.locator('.flg-ins-row[data-key="width_modifier"]')
      const title = (await row.getAttribute('title')) ?? ''
      const summary = lookupFieldDoc('minecraft:cave_carver_feature', 'width_modifier')!.entry!.summary
      expect(title.split('\n')[0]).toBe('width_modifier')
      expect(title).toContain(plainDocText(summary))
      // The control inherits the row's tooltip: an input with no title of its own shows its
      // nearest ancestor's, so hovering the box after a while shows the sentence too.
      expect(await row.locator('input').first().getAttribute('title')).toBeNull()
      // Every documented row has one, and none hands Markdown to the browser.
      const titles = await page.$$eval('.flg-ins-row[data-key]', (els) => els.map((el) => el.getAttribute('title') ?? ''))
      expect(titles.filter((text) => text.includes('\n')).length).toBeGreaterThan(3)
      const markdown = await page.$$eval('[title]', (els) => els.map((el) => el.getAttribute('title') ?? '').filter((text) => text.includes('`') || text.includes('**')))
      expect(markdown).toEqual([])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('changes no geometry anywhere when a row is hovered', async () => {
    // The invariant behind two separate bug reports: reading the form must never move it. Every
    // row's box and every control's box are the same hovered and not, and so is the panel's
    // scroll height.
    const page = await load(formFor('wiki:pumpkin_patch'))
    try {
      const snapshot = async (): Promise<string> =>
        page.evaluate(() =>
          JSON.stringify(
            [...document.querySelectorAll('.flg-inspector .flg-ins-row, .flg-inspector input, .flg-inspector select, .flg-inspector button')].map((el) => {
              const rect = el.getBoundingClientRect()
              return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
            }),
          ),
        )
      const before = await snapshot()
      const panelBefore = await page.locator('.flg-inspector').evaluate((el) => el.scrollHeight)
      const rows = page.locator('.flg-ins-row')
      const count = await rows.count()
      expect(count).toBeGreaterThan(5)
      for (let i = 0; i < count; i++) {
        await rows.nth(i).hover({ position: { x: 4, y: 2 } })
        expect(await snapshot()).toBe(before)
      }
      // Hovering the controls themselves, not just the row's edge.
      for (const selector of ['.flg-ins-row[data-key="distribution"] select', '.flg-ins-row[data-key="extent"] input', '.flg-ins-mode']) {
        await page.locator(selector).first().hover()
        expect(await snapshot()).toBe(before)
      }
      expect(await page.locator('.flg-inspector').evaluate((el) => el.scrollHeight)).toBe(panelBefore)
    } finally {
      await page.close()
    }
  }, 60_000)

  it('never lets anything that documents a control overlap that control', async () => {
    // The thing that kept regressing, pinned as geometry: with the documentation open for every
    // section in turn, no documentation element and no diagnostic line intersects any control's
    // box.
    const forms = [formFor('wiki:acacia_branching_tree'), formFor('wiki:pumpkin_patch'), formFor('wiki:cave_vines')]
    for (const form of forms) {
      const page = await load(form)
      try {
        const helps = page.locator('.flg-ins-help')
        const sections = await helps.count()
        expect(sections).toBeGreaterThan(0)
        for (let i = 0; i < sections; i++) {
          await helps.nth(i).click()
          const docs = await page.locator('.flg-ins-docs').boundingBox()
          expect(docs).not.toBeNull()
          expect(docs!.width).toBeGreaterThan(200)
          const controls = await controlBoxes(page)
          expect(controls.length).toBeGreaterThan(5)
          const covered = controls.filter((control) => overlaps(control.box, docs!)).map((control) => control.name)
          expect(covered, `documentation for section ${i} covers controls`).toEqual([])
          // Diagnostics as well: a problem line sits under its row, never over its box.
          const notes = await page.$$eval('.flg-inspector .flg-ins-problem, .flg-inspector .flg-ins-warn', (els) =>
            els.map((el) => {
              const rect = el.getBoundingClientRect()
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            }),
          )
          for (const note of notes) {
            expect(controls.filter((control) => overlaps(control.box, note)).map((control) => control.name)).toEqual([])
          }
          // The form itself did not move to make room.
          const side = await page.locator('.flg-inspector').boundingBox()
          expect(side!.width).toBeGreaterThan(SIDEBAR_WIDTH - 30)
          expect(overlaps(side!, docs!)).toBe(false)
        }
      } finally {
        await page.close()
      }
    }
  }, 120_000)

  // -------------------------------------------------------------------------
  // Editing: every control still writes what it wrote
  // -------------------------------------------------------------------------

  it('draws a tree_feature as one trunk choice and one canopy choice, not nine boxes', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      // No variant key is a row: the written one's BODY is drawn under the chooser, and the
      // other seven are options of it.
      // (`[data-kind]` is every FIELD row; the chooser's own `variant` row carries the group's
      // name as its key and no kind.)
      const variantRows = await page.$$eval(
        '.flg-ins-row[data-kind]',
        (els, variants) => els.map((el) => (el as HTMLElement).dataset['key']).filter((key): key is string => key !== undefined && (variants as string[]).includes(key)),
        TRUNK_VARIANTS,
      )
      expect(variantRows).toEqual([])

      const trunk = page.locator('[data-group="trunk"] select').first()
      const options = await trunk.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))
      expect(options).toEqual(TRUNK_VARIANTS)
      expect(await trunk.inputValue()).toBe('acacia_trunk')
      expect(await page.locator('[data-group="trunk"] .flg-ins-row[data-key="trunk_height"]').count()).toBe(1)

      // The canopy group is optional, so it has a reachable "none" and the trunk group does not.
      const canopy = await page.locator('[data-group="canopy"] select').first().locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))
      expect(canopy).toHaveLength(13)
      expect(canopy).toContain('')
      expect(options).not.toContain('')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('switching the trunk variant emits both writes, in order, as one change', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      await page.locator('[data-group="trunk"] select').first().selectOption('cherry_trunk')
      const changes = await changesOf(page)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.edits).toEqual([
        { path: ['acacia_trunk'], value: '<remove>' },
        { path: ['cherry_trunk'], value: {} },
      ])
      expect(changes[0]!.label).toContain('cherry_trunk')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('uses a raw JSON box ONLY where the sub-schema was not sourced', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      const kinds = await page.$$eval('textarea', (els) => els.map((el) => (el.closest('[data-kind]') as HTMLElement | null)?.dataset['kind'] ?? '(no row)'))
      expect(kinds.length).toBeGreaterThan(0)
      expect([...new Set(kinds)]).toEqual(['json'])
      // The reason the shape is not modelled is the box's tooltip, not a paragraph beside it.
      expect(((await page.locator('textarea').first().getAttribute('title')) ?? '').length).toBeGreaterThan(20)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('labels a range with the keys the engine actually reads, on one line', async () => {
    const page = await load(formFor('wiki:cave_demo'))
    try {
      const row = page.locator('.flg-ins-row[data-key="y_scale"]')
      // Two boxes, named `range_min` and `range_max` -- as bound labels for a screen reader and
      // as placeholders for everyone else. Not min/max: given those the engine reports the
      // members missing and runs a zero-width range.
      const labels = await row.locator('label.flg-ins-sublabel').allTextContents()
      expect(labels).toEqual(['range_min', 'range_max'])
      const bound = await row.locator('label.flg-ins-sublabel').evaluateAll((els) => els.map((el) => document.getElementById((el as HTMLLabelElement).htmlFor)?.tagName.toLowerCase() ?? null))
      expect(bound).toEqual(['input', 'input'])
      expect(await row.locator('input[type="number"]').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).placeholder))).toEqual(['range_min', 'range_max'])
      // The spelling is the row's mode menu, whose option names the object keys in full.
      const spellings = await row.locator('select.flg-ins-spell option').allTextContents()
      expect(spellings.some((text) => text.includes('range_min') && text.includes('range_max'))).toBe(true)
      expect(spellings.join(' ')).not.toMatch(/\{min, max\}/)

      // Editing one end writes the whole range in the spelling the file already used.
      await row.locator('input[type="number"]').first().fill('3')
      await row.locator('input[type="number"]').first().press('Enter')
      const changes = await changesOf(page)
      expect(changes[0]!.edits).toEqual([{ path: ['y_scale'], value: { range_min: 3, range_max: 1 } }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('keeps a Molang-or-number field as free text, so the expression spelling stays reachable', async () => {
    const page = await load(formFor('wiki:cave_demo'))
    try {
      const box = page.locator('.flg-ins-row[data-key="width_modifier"] input').first()
      expect(await box.getAttribute('type')).toBe('text')
      await box.fill('math.random(0, 1)')
      await box.press('Enter')
      await box.fill('4')
      await box.press('Enter')
      await box.fill('')
      await box.press('Enter')
      const changes = await changesOf(page)
      expect(changes.map((change) => change.edits[0]!.value)).toEqual(['math.random(0, 1)', 4, '<remove>'])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('gives a boolean three states, because absent is not false', async () => {
    const page = await load(formFor('wiki:vegetation_patch_floor'))
    try {
      const options = await page.$$eval('.flg-ins-row[data-key="waterlogged"] input[type="radio"]', (els) =>
        els.map((el) => ({ value: (el as HTMLInputElement).value, checked: (el as HTMLInputElement).checked })),
      )
      expect(options.map((option) => option.value)).toEqual(['true', 'false', 'absent'])
      expect(options.find((option) => option.checked)!.value).toBe('false')

      // The radio is inside its pill and off screen; the pill is what a person clicks.
      await page.locator('.flg-ins-row[data-key="waterlogged"] .flg-ins-seg-option', { hasText: 'unset' }).click()
      const changes = await changesOf(page)
      expect(changes[0]!.edits).toEqual([{ path: ['waterlogged'], value: '<remove>' }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('hides unset optional keys behind one "Add a field" select, and adding one writes nothing by itself', async () => {
    const page = await load(formFor('wiki:nether_cave_demo'))
    try {
      const offer = page.locator('select.flg-ins-addfield').first()
      expect(await offer.locator('option').first().textContent()).toMatch(/^\+ Add a field \(\d+\)$/)
      expect(await page.locator('.flg-ins-row[data-key="height_limit"]').count()).toBe(0)
      // The offer carries each key's sentence as its option tooltip and nothing else on screen.
      const option = offer.locator('option', { hasText: 'height_limit' })
      expect(((await option.getAttribute('title')) ?? '').startsWith('height_limit')).toBe(true)

      await offer.selectOption({ label: 'height_limit' })

      // The control is on screen, marked as not written, and NOTHING has been written.
      const row = page.locator('.flg-ins-row[data-key="height_limit"]')
      expect(await row.count()).toBe(1)
      expect(await row.getAttribute('data-state')).toBe('unset')
      expect(await changesOf(page)).toEqual([])
      // ...and focus went to it, so the author can type straight away.
      expect(await page.evaluate(() => document.activeElement?.closest('[data-key]')?.getAttribute('data-key') ?? '')).toBe('height_limit')

      await row.locator('input').first().fill('12')
      await row.locator('input').first().press('Enter')
      const changes = await changesOf(page)
      expect(changes[0]!.edits).toEqual([{ path: ['height_limit'], value: 12 }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('makes what is SET obvious at a glance, and keeps what absent means for the documentation', async () => {
    const page = await load(formFor('wiki:nether_cave_demo'))
    try {
      const states = await page.$$eval('.flg-ins-row', (els) => els.map((el) => ({ key: (el as HTMLElement).dataset['key'], state: (el as HTMLElement).dataset['state'] })))
      expect(states.find((row) => row.key === 'fill_with')!.state).toBe('set')
      expect(states.some((row) => row.state === 'set')).toBe(true)
      // The default is not on the form. It is in the panel, under the key, as "Absent: ...".
      expect((await page.locator('.flg-inspector').textContent()) ?? '').not.toContain('Left out')
      await page.locator('[data-section="general"] .flg-ins-help').click()
      const entry = page.locator('.flg-ins-doc[data-key="y_scale"]')
      expect(await entry.count()).toBe(1)
      expect(await entry.locator('.flg-ins-doc-fact').first().textContent()).toMatch(/^Absent: /)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('shows the form\'s notices and a row\'s problems, one line each, rather than swallowing them', async () => {
    const broken = buildNodeForm({
      typeId: 'minecraft:cave_carver_feature',
      formatVersion: '1.21.110',
      fields: { y_scale: { min: 1, max: 2 }, fill_with: 'example:stone' },
    })
    const page = await load(broken)
    try {
      const row = page.locator('.flg-ins-row[data-key="y_scale"]')
      expect(await row.getAttribute('data-problem')).toBe('yes')
      // The problem is the next line after the row -- visible, one line, whole text as tooltip.
      const problem = page.locator('.flg-ins-problem').first()
      expect(await problem.textContent()).toContain('range_min')
      expect(await problem.getAttribute('title')).toBe(await problem.textContent())
      const rowBox = await row.boundingBox()
      const problemBox = await problem.boundingBox()
      expect(problemBox!.y).toBeGreaterThanOrEqual(rowBox!.y + rowBox!.height - 1)
      expect(problemBox!.height).toBeLessThan(24)

      const gated = buildNodeForm({ typeId: 'minecraft:multi_block_feature', formatVersion: '1.21.10', fields: {} })
      const second = await load(gated)
      try {
        const notices = await second.$$eval('.flg-ins-notice', (els) => els.map((el) => el.textContent ?? ''))
        expect(notices.length).toBeGreaterThan(0)
        expect(notices.some((text) => text.startsWith('Error: '))).toBe(true)
      } finally {
        await second.close()
      }
    } finally {
      await page.close()
    }
  }, 60_000)

  it('folds a page-long notice to one line instead of burying the controls under it', async () => {
    const page = await load(formFor('wiki:hanging_roots_ceiling_block'))
    try {
      const folded = page.locator('details.flg-ins-notice').first()
      expect(await folded.count()).toBe(1)
      const summary = folded.locator('summary')
      expect(((await summary.textContent()) ?? '').startsWith('Note: ')).toBe(true)
      const box = await summary.boundingBox()
      expect(box!.height).toBeLessThan(24)
      // The whole note is still there, one click away, and as the line's tooltip.
      const full = (await folded.locator('p').textContent()) ?? ''
      expect(full.length).toBeGreaterThan(((await summary.textContent()) ?? '').length)
      expect(await summary.getAttribute('title')).toBe(full)
      const firstRow = await page.locator('.flg-ins-row').first().boundingBox()
      expect(firstRow!.y).toBeLessThan(200)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('shows a key the file WROTE that this format_version does not accept, with the reason', async () => {
    const page = await load(
      buildNodeForm({
        typeId: 'minecraft:snap_to_surface_feature',
        formatVersion: '1.21.110',
        fields: { search_range: 4, surface: 'floor' },
      }),
    )
    try {
      const row = page.locator('.flg-ins-row[data-key="search_range"]')
      expect(await row.count()).toBe(1)
      expect(await row.getAttribute('data-state')).toBe('unavailable')
      const note = await page.locator('.flg-ins-warn').first().textContent()
      expect(note).toContain('search_range')
      const disabled = await page.$$eval('.flg-ins-row[data-state="unavailable"] input', (els) => els.map((el) => (el as HTMLInputElement).disabled))
      expect(disabled.length).toBeGreaterThan(0)
      expect(disabled.every(Boolean)).toBe(true)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('says nothing at all about the five flat scatter keys a 1.21.110 file never wrote', async () => {
    const page = await load(formFor('wiki:rng_scatter_evalorder_xyz'))
    try {
      for (const key of ['scatter_chance', 'coordinate_eval_order', 'x', 'y', 'z']) {
        const paths = await page.$$eval('.flg-ins-row', (els, k) => els.map((el) => (el as HTMLElement).dataset['path']).filter((path) => path === JSON.stringify([k])), key)
        expect(paths).toEqual([])
      }
      expect(await page.locator('[data-section="group:[\\"distribution\\"]"]').count()).toBe(1)
      expect(await page.locator('.flg-ins-warn').count()).toBe(0)
      expect(await page.getByText('Not accepted at this format_version').count()).toBe(0)
      // The nested object really is the one on screen, with its own parameters under it.
      expect(await page.locator('.flg-ins-row[data-key="coordinate_eval_order"]').count()).toBe(1)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('edits a block descriptor in all three spellings, with its states as real rows', async () => {
    const page = await load(formFor('wiki:vegetation_patch_floor'))
    try {
      const row = page.locator('.flg-ins-row[data-key="ground_block"]')
      // The spelling is the row's mode menu: a glyph at the end of the line with the native
      // select over it, so it costs nothing and stays a keyboard control.
      const spelling = row.locator('select.flg-ins-spell').first()
      expect(await spelling.getAttribute('aria-label')).toMatch(/how this block is written/)
      expect(await spelling.inputValue()).toBe('name')

      await spelling.selectOption('name-and-states')
      // Switching the SPELLING writes nothing on its own -- it changes what is on screen.
      expect(await changesOf(page)).toEqual([])

      await page.locator('button[aria-label="Add a block state to ground_block"]').click()
      // A state is a row: a name and a value, typed the way the engine types them.
      const state = page.locator('.flg-ins-row', { hasText: 'state 1' }).first()
      const boxes = state.locator('input[type="text"]')
      expect(await boxes.count()).toBe(2)
      await boxes.nth(0).fill('example_state')
      await boxes.nth(0).press('Enter')
      await boxes.nth(1).fill('true')
      await boxes.nth(1).press('Enter')
      const changes = await changesOf(page)
      expect(changes[changes.length - 1]!.edits[0]!.path).toEqual(['ground_block'])
      expect(changes[changes.length - 1]!.edits[0]!.value).toEqual({ name: 'minecraft:grass_block', states: { example_state: true } })
    } finally {
      await page.close()
    }
  }, 45_000)

  it('adds a weighted entry in a spelling the key accepts, with or without one to copy', async () => {
    const page = await load(formFor('wiki:cave_vines'))
    try {
      await page.locator('button[aria-label="Add an entry to body_blocks"]').click()
      expect((await changesOf(page))[0]!.edits).toEqual([{ path: ['body_blocks', 1], value: ['', 1] }])
      // An entry is one line: a block, its mode, its weight.
      const entry = page.locator('[data-path=\'["body_blocks",0]\']')
      expect(await entry.locator('input[placeholder="weight"]').count()).toBe(1)
    } finally {
      await page.close()
    }

    const empty = await load(buildNodeForm({ typeId: 'minecraft:growing_plant_feature', formatVersion: '1.21.110', fields: { body_blocks: [] } }))
    try {
      // Written-and-empty is a file the engine refuses, and the row's problem says so. That is
      // the ONLY sentence about it: no hint explaining what to add.
      const row = empty.locator('.flg-ins-row[data-key="body_blocks"]')
      expect(await row.getAttribute('data-problem')).toBe('yes')
      expect(await empty.locator('.flg-ins-row[data-key="body_blocks"] + .flg-ins-row-note .flg-ins-problem').textContent()).toMatch(/empty array/)
      expect(await empty.locator('.flg-ins-hint').count()).toBe(0)
      await empty.locator('button[aria-label="Add an entry to body_blocks"]').click()
      expect((await changesOf(empty))[0]!.edits).toEqual([{ path: ['body_blocks', 0], value: ['', 1] }])
    } finally {
      await empty.close()
    }
  }, 60_000)

  it('starts a list-only block key as a list, not as one block box', async () => {
    // Reported on snap_to_surface: adding allowed_surface_blocks drew a lone block text box, and
    // the row's own validation then said it must be a list -- the control offered exactly the
    // spelling the game refuses there.
    const page = await load(buildNodeForm({ typeId: 'minecraft:snap_to_surface_feature', formatVersion: '1.21.110', fields: { feature_to_snap: 'a:b', vertical_search_range: 4 } }))
    try {
      await page.locator('select[aria-label="Add a field"]').first().selectOption('allowed_surface_blocks')
      const row = page.locator('.flg-ins-row[data-key="allowed_surface_blocks"]')
      await row.waitFor()
      expect(await row.locator('input[type="text"]').count(), 'a list-only key drew a single block box').toBe(0)
      expect(await row.getAttribute('data-problem')).not.toBe('yes')
      await page.locator('button[aria-label="Add a block to allowed_surface_blocks"]').click()
      expect((await changesOf(page))[0]!.edits).toEqual([{ path: ['allowed_surface_blocks'], value: [''] }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('edits a weighted key written as a single block instead of blanking it', async () => {
    const page = await load(buildNodeForm({ typeId: 'minecraft:single_block_feature', formatVersion: '1.21.110', fields: { places_block: 'example:lantern' } }))
    try {
      const row = page.locator('.flg-ins-row[data-kind="weightedBlockList"]').first()
      expect(await row.locator('input[type="text"]').first().inputValue()).toBe('example:lantern')
      // Promoting it to a list is a mode of the same row, and carries the block across in the
      // spelling THIS key takes.
      await row.locator('select.flg-ins-spell').selectOption('list')
      expect((await changesOf(page))[0]!.edits).toEqual([{ path: ['places_block'], value: [{ block: 'example:lantern', weight: 1 }] }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('edits a list of objects element by element, and can add and remove one', async () => {
    const page = await load(formFor('wiki:diamond_vein'))
    try {
      const entry = page.locator('[data-path=\'["replace_rules",0]\']')
      expect(await entry.count()).toBe(1)
      // Element zero's own values, as rows under a numbered heading, each with its own label.
      const places = page.locator('.flg-ins-row[data-key="places_block"]')
      const name = places.locator('input[type="text"]').first()
      expect(await name.inputValue()).toBe('minecraft:diamond_ore')
      expect(await places.locator('label.flg-ins-key').getAttribute('for')).toBe(await name.getAttribute('id'))

      await page.locator('button[aria-label="Add an entry to replace_rules"]').click()
      let changes = await changesOf(page)
      expect(changes[0]!.edits).toEqual([{ path: ['replace_rules', 1], value: {} }])

      await page.locator('button[aria-label="Remove entry 1 from replace_rules"]').click()
      changes = await changesOf(page)
      expect(changes[1]!.edits).toEqual([{ path: ['replace_rules', 0], value: '<remove>' }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('draws a list of bare numbers as chips on one line with one shared add button', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      const row = page.locator('.flg-ins-row[data-key="intervals"]')
      const chips = row.locator('.flg-ins-chip')
      expect(await chips.count()).toBe(2)
      expect(await chips.nth(0).locator('button.flg-ins-x').getAttribute('aria-label')).toBe('Remove entry 1 from intervals')
      const add = row.locator('button[aria-label="Add an entry to intervals"]')
      expect(await add.count()).toBe(1)
      const lines = await row.evaluate((el) => el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).fontSize) * 1.4))
      expect(lines).toBeLessThan(2)
      await add.click()
      expect((await changesOf(page))[0]!.edits).toEqual([{ path: ['acacia_trunk', 'trunk_height', 'intervals', 2], value: 0 }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('keeps the remove affordance in the keyboard path while it is out of the way', async () => {
    const page = await load(formFor('wiki:cave_demo'))
    try {
      const drop = page.locator('.flg-ins-row[data-key="fill_with"] > button.flg-ins-x').first()
      expect(await drop.getAttribute('aria-label')).toBe('Remove fill_with')
      expect(await drop.evaluate((el) => getComputedStyle(el).display)).not.toBe('none')
      expect(await drop.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
      await drop.focus()
      expect(await drop.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      await page.keyboard.press('Enter')
      expect((await changesOf(page))[0]!.edits).toEqual([{ path: ['fill_with'], value: '<remove>' }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('gives every control an accessible name and keeps the panel reachable from the keyboard', async () => {
    const page = await load(formFor('wiki:ceiling_slab_scatter'))
    try {
      await page.locator('.flg-ins-help').first().click()
      const unnamed = await page.$$eval('input, select, textarea, button', (els) =>
        els
          .filter((el) => {
            const id = el.getAttribute('id')
            const labelled = el.getAttribute('aria-label') !== null || (id !== null && document.querySelector(`label[for="${id}"]`) !== null)
            const wrapped = el.closest('label') !== null
            return !labelled && !wrapped
          })
          .map((el) => `${el.tagName.toLowerCase()}:${el.className}`),
      )
      expect(unnamed).toEqual([])
      await page.keyboard.press('Escape')
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Tab')
      const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? '')
      expect(['input', 'select', 'textarea', 'button', 'summary']).toContain(focused)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('takes every colour from the theme, in the panel, the controls and the documentation', async () => {
    const sentinel = sentinelTheme()
    const page = await load(formFor('wiki:diamond_vein'), { theme: sentinel })
    try {
      await page.locator('[data-section="general"] .flg-ins-help').click()
      const painted = await page.evaluate(() => {
        const pick = (selector: string): Record<string, string> => {
          const el = document.querySelector(selector)
          if (el === null) return {}
          const style = getComputedStyle(el)
          return { color: style.color, background: style.backgroundColor, border: style.borderTopColor }
        }
        return {
          panel: pick('.flg-inspector'),
          input: pick('.flg-ins-input'),
          key: pick('.flg-ins-key'),
          add: pick('.flg-ins-add'),
          docs: pick('.flg-ins-docs'),
          code: pick('.flg-ins-doc-name'),
          required: pick('.flg-ins-badge[data-badge="required"]'),
        }
      })
      expect(painted.input.background).toBe(sentinel['--vscode-input-background'])
      expect(painted.input.color).toBe(sentinel['--vscode-input-foreground'])
      expect(painted.panel.background).toBe(sentinel['--vscode-editorWidget-background'])
      expect(painted.key.color).toBe(sentinel['--vscode-foreground'])
      expect(painted.add.color).toBe(sentinel['--vscode-charts-blue'])
      expect(painted.docs.background).toBe(sentinel['--vscode-editorWidget-background'])
      expect(painted.code.color).toBe(sentinel['--vscode-textPreformat-foreground'])
      expect(painted.required.color).toBe(sentinel['--vscode-editorError-foreground'])
      for (const value of [painted.input.background, painted.panel.background, painted.docs.background]) expect(value).not.toBe('rgba(0, 0, 0, 0)')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('redraws for a new form without losing where the reader was', async () => {
    const page = await load(formFor('wiki:nether_cave_demo'))
    try {
      await page.locator('select.flg-ins-addfield').first().selectOption({ label: 'height_limit' })
      expect(await page.locator('.flg-ins-row[data-key="height_limit"]').count()).toBe(1)
      await page.locator('[data-section="general"] .flg-ins-help').click()
      expect(await page.locator('.flg-ins-docs').count()).toBe(1)

      const next = formFor('wiki:nether_cave_demo')
      await page.evaluate((payload) => {
        ;(window as unknown as { view: { update(form: unknown): void } }).view.update(payload)
      }, JSON.parse(JSON.stringify(next)) as unknown)

      // The revealed control and the open documentation are where the reader was, not what the
      // file says, so they survive.
      expect(await page.locator('.flg-ins-row[data-key="height_limit"]').count()).toBe(1)
      expect(await page.locator('.flg-ins-docs').count()).toBe(1)

      // A different type is a different panel, and keeps none of it.
      await page.evaluate((payload) => {
        ;(window as unknown as { view: { update(form: unknown): void } }).view.update(payload)
      }, JSON.parse(JSON.stringify(formFor('wiki:diamond_vein'))) as unknown)
      expect(await page.locator('.flg-ins-row[data-key="height_limit"]').count()).toBe(0)
      expect(await page.locator('.flg-ins-row[data-key="count"]').count()).toBe(1)
      expect(await page.locator('.flg-ins-docs').count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  // -------------------------------------------------------------------------
  // A fresh scatter: the axes are rows, and the count is where the file keeps it
  // -------------------------------------------------------------------------

  const NESTED_ITERATIONS: EdgeIterations = { value: '10', fieldPath: '$["minecraft:scatter_feature"].distribution.iterations' }

  function freshScatterForm(fields: Record<string, unknown> = {}, version = '1.21.110'): NodeForm {
    return buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: version, fields })
  }

  it('draws a fresh scatter\'s axes and chance as empty rows with their defaults as placeholders, and writes nothing for it', async () => {
    const page = await load(freshScatterForm())
    try {
      const section = page.locator('[data-section="group:[\\"distribution\\"]"]')
      expect(await section.count()).toBe(1)
      const keys = await section.locator('.flg-ins-row[data-key]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['key']))
      expect(keys).toEqual(['scatter_chance', 'x', 'y', 'z'])
      for (const key of ['x', 'y', 'z']) {
        const row = section.locator(`.flg-ins-row[data-key="${key}"]`)
        expect(await row.getAttribute('data-state')).toBe('unset')
        const box = row.locator('input.flg-ins-input').first()
        expect(await box.inputValue()).toBe('')
        expect(await box.getAttribute('placeholder')).toBe('0')
        // Nothing to remove: the key is not written.
        expect(await row.locator('button.flg-ins-x').count()).toBe(0)
      }
      expect(await section.locator('.flg-ins-row[data-key="scatter_chance"] input.flg-ins-input').first().getAttribute('placeholder')).toBe('100')
      expect(await section.locator('select.flg-ins-addfield option').first().textContent()).toBe('+ Add a field (1)')
      // Drawing the rows is not an edit.
      expect(await changesOf(page)).toEqual([])

      // Typing into one writes that key under distribution, building distribution on the way.
      const x = section.locator('.flg-ins-row[data-key="x"] input.flg-ins-input').first()
      await x.fill('5')
      await x.press('Enter')
      expect((await changesOf(page))[0]!.edits).toEqual([{ path: ['distribution'], value: { x: 5 } }])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('writes a primary axis narrowly once distribution exists, and clearing it removes the key', async () => {
    const page = await load(freshScatterForm({ distribution: { x: 5 } }))
    try {
      const section = page.locator('[data-section="group:[\\"distribution\\"]"]')
      const y = section.locator('.flg-ins-row[data-key="y"] input.flg-ins-input').first()
      await y.fill('math.random(-2, 2)')
      await y.press('Enter')
      const x = section.locator('.flg-ins-row[data-key="x"] input.flg-ins-input').first()
      expect(await x.inputValue()).toBe('5')
      expect(await section.locator('.flg-ins-row[data-key="x"]').getAttribute('data-state')).toBe('set')
      await x.fill('')
      await x.press('Enter')
      expect((await changesOf(page)).map((change) => change.edits[0])).toEqual([
        { path: ['distribution', 'y'], value: 'math.random(-2, 2)' },
        { path: ['distribution', 'x'], value: '<remove>' },
      ])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('shows iterations in the distribution section as the edge\'s own editor: one value, two places to reach it', async () => {
    const page = await load(freshScatterForm({ distribution: {} }), { iterations: NESTED_ITERATIONS })
    try {
      const section = page.locator('[data-section="group:[\\"distribution\\"]"]')
      const row = section.locator('.flg-ins-row[data-key="iterations"]')
      expect(await row.count()).toBe(1)
      // First in the section, as it is first in the file; required, as the engine has it.
      expect(await section.locator('.flg-ins-row[data-key]').first().getAttribute('data-key')).toBe('iterations')
      expect(await row.getAttribute('data-kind')).toBe('molang')
      expect(await row.getAttribute('data-state')).toBe('set')
      expect(await row.locator('.flg-ins-req').count()).toBe(1)
      expect(((await row.getAttribute('title')) ?? '').split('\n')[0]).toBe('iterations')
      // Nowhere else: not also a row of General, not a raw-JSON extra.
      expect(await page.locator('.flg-ins-row[data-key="iterations"]').count()).toBe(1)

      // It IS the Molang control -- the highlighted layer and the completion list are there --
      // drawn bare: the row is its label and the mode menu is its format choice.
      const box = row.locator('textarea')
      expect(await box.inputValue()).toBe('10')
      expect(await box.getAttribute('aria-label')).toBe('iterations')
      expect(await row.locator('.flg-molang-ink').count()).toBe(1)
      expect(await row.locator('.flg-molang-popup').count()).toBe(1)
      expect(await row.locator('.flg-molang-caption, .flg-molang-keep, .flg-molang-note').count()).toBe(0)
      expect(await row.locator('select.flg-ins-spell option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))).toEqual(['minify', 'keep'])

      // Editing it here changes the value the EDGE holds, through the edge's editor, and emits
      // no InspectorChange: there is no second path to the file.
      await box.fill('12')
      await box.press('Tab')
      expect(await edgeChangesOf(page)).toEqual([{ kind: 'value', value: '12' }])
      expect(await edgeText(page)).toBe('12')
      expect(await changesOf(page)).toEqual([])

      // The format choice reaches the editor too, as the directive it records.
      await row.locator('select.flg-ins-spell').selectOption('keep')
      expect((await edgeChangesOf(page))[1]).toMatchObject({ kind: 'annotate', annotation: { name: 'molang-format', args: ['keep'] } })

      // A redraw -- the host's round trip -- draws the same editor's value again.
      await page.evaluate((payload) => {
        ;(window as unknown as { view: { update(form: unknown): void } }).view.update(payload)
      }, JSON.parse(JSON.stringify(freshScatterForm({ distribution: { x: 1 } }))) as unknown)
      expect(await section.locator('.flg-ins-row[data-key="iterations"] textarea').inputValue()).toBe('12')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('keeps the count in General for a flat older file, beside the flat axes', async () => {
    const page = await load(freshScatterForm({ x: 0 }, '1.13.0'), { iterations: { value: '3', fieldPath: '$["minecraft:scatter_feature"].iterations' } })
    try {
      expect(await page.locator('[data-section="general"] .flg-ins-row[data-key="iterations"]').count()).toBe(1)
      expect(await page.locator('[data-section="general"] .flg-ins-row[data-key="x"]').count()).toBe(1)
      expect(await page.locator('[data-section^="group:"]').count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('keeps the Molang row inside the row contract: label on its first line, nothing under it, no prose', async () => {
    const page = await load(freshScatterForm({ distribution: {} }), { iterations: NESTED_ITERATIONS })
    try {
      const section = page.locator('[data-section="group:[\\"distribution\\"]"]')
      const row = section.locator('.flg-ins-row[data-key="iterations"]')
      const line = await row.evaluate((el) => parseFloat(getComputedStyle(el).fontSize) * 1.4)
      const rowBox = (await row.boundingBox())!
      // A one-line expression is a short row: the control grew to its content, not to three rows.
      expect(rowBox.height / line).toBeLessThan(2.6)
      const label = (await row.locator(':scope > .flg-ins-key').boundingBox())!
      const box = (await row.locator('textarea').boundingBox())!
      expect(Math.abs(label.y - box.y)).toBeLessThan(10)
      expect(label.x + label.width).toBeLessThanOrEqual(box.x)
      // The next row starts below it: nothing is drawn under the field.
      const next = (await section.locator('.flg-ins-row[data-key="scatter_chance"]').boundingBox())!
      expect(next.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1)

      // A long expression grows to the ceiling and scrolls past it, inside the sidebar.
      await row.locator('textarea').fill(`${Array.from({ length: 40 }, (_, i) => `variable.v${i} = ${i};`).join('\n')}\nreturn 1;`)
      const grown = (await row.locator('textarea').boundingBox())!
      expect(grown.height).toBeGreaterThan(box.height)
      expect(grown.height).toBeLessThanOrEqual(0.4 * 1400 + 2)
      expect(await row.locator('textarea').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
      expect(await page.locator('.flg-inspector').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)

      // No prose anywhere in the panel, the field included; the ink layer holds the author's own
      // expression, which is not prose either.
      const long = await page.$$eval('.flg-inspector', (els) => {
        const out: string[] = []
        const walker = document.createTreeWalker(els[0]!, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = (node as Text).parentElement
          if (parent === null || parent.closest('.flg-ins-notice, .flg-ins-problem, .flg-ins-warn, option, .flg-molang-ink') !== null) continue
          const text = (node.textContent ?? '').trim()
          if (text.length > 40) out.push(text)
        }
        return out
      })
      expect(long).toEqual([])
    } finally {
      await page.close()
    }
  }, 45_000)

  // -------------------------------------------------------------------------
  // The documentation panel
  // -------------------------------------------------------------------------

  function aggregateForm(): NodeForm {
    return buildNodeForm({ typeId: 'minecraft:aggregate_feature', formatVersion: '1.21.110', fields: { early_out: 'first_success' } })
  }

  it('has exactly one `?` per section, at the right end of the heading', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      expect(await page.locator('.flg-ins-help').count()).toBe(await page.locator('.flg-ins-section').count())
      expect(await page.locator('.flg-ins-row .flg-ins-help').count()).toBe(0)
      const heading = await page.locator('.flg-ins-section-head').first().boundingBox()
      const help = await page.locator('.flg-ins-section-head .flg-ins-help').first().boundingBox()
      expect(help!.x + help!.width).toBeGreaterThan(heading!.x + heading!.width - 30)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('opens the documentation beside the form, in the host it was given, without moving a row', async () => {
    const page = await load(aggregateForm())
    try {
      const rowsBefore = await page.$$eval('.flg-ins-row', (els) => els.map((el) => JSON.stringify(el.getBoundingClientRect())))
      const help = page.locator('[data-section="general"] .flg-ins-help')
      await help.click()
      expect(await help.getAttribute('aria-expanded')).toBe('true')
      const docs = page.locator('#canvas > .flg-ins-docs')
      expect(await docs.count()).toBe(1)
      // Header: close, back, then the section's name as the title.
      expect(await docs.locator('.flg-ins-docs-bar > button').first().getAttribute('aria-label')).toMatch(/Close/)
      expect(await docs.locator('.flg-ins-docs-back').textContent()).toMatch(/Back to overview/)
      expect(await docs.locator('.flg-ins-docs-title').textContent()).toBe('General')
      // The form did not move.
      expect(await page.$$eval('.flg-ins-row', (els) => els.map((el) => JSON.stringify(el.getBoundingClientRect())))).toEqual(rowsBefore)
      expect(await changesOf(page)).toEqual([])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('lists every field of the section with a glyph, badges, its detail and every enum value', async () => {
    const page = await load(aggregateForm())
    try {
      await page.locator('[data-section="general"] .flg-ins-help').click()
      const entry = page.locator('.flg-ins-doc[data-key="early_out"]')
      expect(await entry.count()).toBe(1)
      expect(await entry.locator('.flg-ins-doc-glyph').textContent()).toBe(kindGlyph('enum'))
      const text = (await entry.textContent()) ?? ''
      // Rendered as elements, never as backticks and asterisks.
      expect(text).not.toContain('`')
      expect(text).not.toContain('**')
      expect(await entry.locator('.flg-ins-doc-p code').allTextContents()).toContain('none')
      // Every value, each with its own sentence.
      expect(await entry.locator('.flg-ins-doc-vname').allTextContents()).toEqual(['none', 'first_success', 'first_failure'])
      expect(await entry.locator('.flg-ins-doc-value').nth(1).textContent()).toContain('Children after it are never asked')
      expect(await entry.locator('.flg-ins-doc-fact').first().textContent()).toMatch(/^Absent: /)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('badges what changes what an author writes: required, Molang, the version band', async () => {
    const page = await load(formFor('wiki:pumpkin_patch'))
    try {
      await page.locator('[data-section="group:[\\"distribution\\"]"] .flg-ins-help').click()
      const head = page.locator('.flg-ins-doc').first()
      expect(await head.locator('.flg-ins-doc-name').textContent()).toBe('distribution')
      const badges = await head.locator('.flg-ins-badge').evaluateAll((els) => els.map((el) => [(el as HTMLElement).dataset['badge'], el.textContent]))
      expect(badges).toEqual([
        ['required', 'required'],
        ['version', '1.21.10+'],
      ])
      const chance = page.locator('.flg-ins-doc[data-key="scatter_chance"]')
      expect(await chance.locator('.flg-ins-badge[data-badge="molang"]').textContent()).toBe('Molang')
      // Nested members are named by their path under the section.
      expect(await page.locator('.flg-ins-doc-parent').allTextContents()).toContain('x.')
    } finally {
      await page.close()
    }
  }, 45_000)

  it('documents a choice with every variant, and the same name may be the mode and a value', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      await page.locator('[data-group="trunk"] .flg-ins-help').click()
      expect(await page.locator('.flg-ins-docs-title').textContent()).toBe('trunk')
      const head = page.locator('.flg-ins-doc').first()
      expect(await head.locator('.flg-ins-doc-name').textContent()).toBe('trunk')
      expect(await head.locator('.flg-ins-doc-vname').allTextContents()).toEqual(TRUNK_VARIANTS)
      expect(await page.locator('.flg-ins-doc[data-key="trunk_height"]').count()).toBe(1)
    } finally {
      await page.close()
    }
  }, 45_000)

  it('navigates: back to the overview, another section from there, Escape closes with focus returned', async () => {
    const page = await load(formFor('wiki:acacia_branching_tree'))
    try {
      const help = page.locator('[data-section="general"] .flg-ins-help')
      await help.focus()
      await page.keyboard.press('Enter')
      expect(await page.locator('.flg-ins-docs-title').textContent()).toBe('General')

      await page.locator('.flg-ins-docs-back').click()
      // The overview names every section of this type.
      expect(await page.locator('.flg-ins-docs-item-name').allTextContents()).toEqual(['General', 'trunk', 'canopy'])
      expect(await page.locator('.flg-ins-docs-back').count()).toBe(0)
      await page.locator('.flg-ins-docs-item', { hasText: 'canopy' }).click()
      expect(await page.locator('.flg-ins-docs-title').textContent()).toBe('canopy')
      expect(await page.locator('[data-group="canopy"] .flg-ins-help').getAttribute('aria-expanded')).toBe('true')
      expect(await help.getAttribute('aria-expanded')).toBe('false')

      await page.locator('.flg-ins-docs').focus()
      await page.keyboard.press('Escape')
      expect(await page.locator('.flg-ins-docs').count()).toBe(0)
      expect(await page.evaluate(() => document.activeElement?.closest('[data-section]')?.getAttribute('data-section') ?? '')).toBe('choice:canopy')
      // Reading the documentation is not an edit.
      expect(await changesOf(page)).toEqual([])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('floats over the area beside the form when no host is given, and still covers no control', async () => {
    const page = await load(formFor('wiki:cave_demo'), { docsHost: false })
    try {
      await page.locator('[data-section="general"] .flg-ins-help').click()
      const docs = page.locator('body > .flg-ins-docs')
      expect(await docs.count()).toBe(1)
      expect(await docs.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
      const box = await docs.boundingBox()
      const side = await page.locator('#side').boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(side!.x + 1)
      expect(box!.width).toBeGreaterThan(300)
      const covered = (await controlBoxes(page)).filter((control) => overlaps(control.box, box!))
      expect(covered).toEqual([])
    } finally {
      await page.close()
    }
  }, 45_000)

  it('disposes without leaving its element or its documentation behind', async () => {
    const page = await load(formFor('wiki:diamond_vein'))
    try {
      await page.locator('.flg-ins-help').first().click()
      const removed = await page.evaluate(() => {
        const view = (window as unknown as { view: { element: HTMLElement; dispose(): void } }).view
        view.dispose()
        return { attached: document.body.contains(view.element), children: view.element.childElementCount, docs: document.querySelectorAll('.flg-ins-docs').length }
      })
      expect(removed.attached).toBe(false)
      expect(removed.children).toBe(0)
      expect(removed.docs).toBe(0)
    } finally {
      await page.close()
    }
  }, 45_000)
})

// ---------------------------------------------------------------------------
// Writing under a parent the file has not got
// ---------------------------------------------------------------------------

describe('an edit under an unwritten parent builds the containers it needs', () => {
  // Reported twice from opposite ends, same cause both times. The round-trip writer inserts only
  // ONE level deep -- deliberately, because it cannot know whether a missing `$.a.b` wants an
  // object or an array. This module can know, because forms.ts gives it every segment.
  //
  // The second report shows the size of it: on a fresh scatter `distribution` is absent until
  // something is put in it, so every axis, the chance and the eval order all failed to write and
  // the whole section looked inert.

  it('writes the missing parent, carrying the value inside it', () => {
    expect(materialisedEdit({}, ['distribution', 'x'], 4)).toEqual({ path: ['distribution'], value: { x: 4 } })
  })

  it('builds every missing level at once, keys as objects and indices as arrays', () => {
    expect(materialisedEdit({}, ['distribution', 'x', 'extent', 0], 8)).toEqual({
      path: ['distribution'],
      value: { x: { extent: [8] } },
    })
  })

  it('stops at the deepest thing the file HAS, and edits narrowly from there', () => {
    // The other half, and the one that matters for not losing work: rewriting a parent that is
    // already there would throw away every key in it the panel is not showing.
    expect(materialisedEdit({ distribution: { iterations: 4 } }, ['distribution', 'x'], 1)).toEqual({
      path: ['distribution', 'x'],
      value: 1,
    })
    expect(materialisedEdit({ distribution: { x: { extent: [0, 0] } } }, ['distribution', 'x', 'extent', 1], 9)).toEqual({
      path: ['distribution', 'x', 'extent', 1],
      value: 9,
    })
  })

  it('leaves a top-level key alone -- its parent is the body, which always exists', () => {
    expect(materialisedEdit({}, ['project_input_to_floor'], true)).toEqual({
      path: ['project_input_to_floor'],
      value: true,
    })
  })

  it('never materialises a REMOVAL', () => {
    // Creating a container in order to delete from it would write the file to say something the
    // author never said.
    expect(materialisedEdit({}, ['distribution', 'x'], undefined)).toEqual({
      path: ['distribution', 'x'],
      value: undefined,
    })
  })
})
