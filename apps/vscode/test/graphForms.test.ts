// graphForms.test.ts -- the node property form and the type catalogue it renders from.
//
// The suite is weighted towards the two things that produce a FILE THE GAME REFUSES TO LOAD if
// they are wrong, because neither failure is visible from inside the editor:
//
//   1. The format-version gates. A key registered only above the file's declared version must
//      never be silently offered (the engine drops it with a member-not-in-schema log and the
//      author sees a feature that does nothing) and must never be silently hidden (the author
//      concludes the key does not exist). Every gate this port models -- scatter's flat/nested
//      split at 1.21.10, single_block's modern schema at 1.21.40, snap_to_surface's
//      vertical_search_range -> search_range rename at 1.26.50, and the type-level gate at
//      1.26.40 -- has a test here asserting BOTH directions.
//   2. The create palette. A type marked `missing` or `out_of_scope` must be unreachable, and a
//      `partial` one must carry its coverage note. These are the rules that stop someone
//      authoring, from scratch, against a gap this port has.
//
// Version strings and coverage rows in the fixtures below are the real ones from
// featurelab-go/features (typeavailability.go's bands, coverage.go's statuses and notes), not
// invented values, so a gate that moves in the engine fails here rather than passing quietly.
import { describe, expect, it, vi } from 'vitest'
import type { FieldSpec } from '../src/graph/typeCatalog'
import {
  NodeFormController,
  buildNodeForm,
  createPalette,
  isBlockDescriptor,
  parseMolangOrNumber,
  readAtPath,
  readRange,
  seedNewNodeFields,
  setAtPath,
  validateValue,
  type FormRow,
} from '../src/graph/forms.js'
import {
  ABSENT_FORMAT_VERSION,
  atLeastOrUnversioned,
  catalogedTypeIds,
  compareFormatVersions,
  extractApproximations,
  parseFormatVersion,
  resolveFields,
  typeAvailableAt,
  typeSpec,
  type CoverageRow,
} from '../src/graph/typeCatalog.js'

/** Finds the row for a key, failing loudly rather than returning undefined -- a missing row is
 * always a catalogue bug, and `expect(undefined?.x)` reports it as the wrong thing. */
function row(rows: readonly FormRow[], key: string): FormRow {
  const found = rows.find((candidate) => candidate.spec.key === key)
  if (found === undefined) throw new Error(`no row for "${key}" (have: ${rows.map((r) => r.spec.key).join(', ')})`)
  return found
}

describe('format_version parsing and comparison', () => {
  it('accepts both spellings real packs use', () => {
    expect(parseFormatVersion('1.21.10').parts).toEqual([1, 21, 10])
    expect(parseFormatVersion([1, 21, 10]).parts).toEqual([1, 21, 10])
    expect(parseFormatVersion('1.21.110').raw).toBe('1.21.110')
  })

  it('treats absence as its own state, not as 1.0.0', () => {
    expect(parseFormatVersion(undefined).present).toBe(false)
    expect(parseFormatVersion(null).present).toBe(false)
    expect(parseFormatVersion('').present).toBe(false)
    expect(parseFormatVersion('  ').present).toBe(false)
  })

  it('throws on a value that is present and unparseable, rather than reading it as absent', () => {
    // Reading a typo as "absent" would open every gate in the catalogue on a typo.
    expect(() => parseFormatVersion('1')).toThrow()
    expect(() => parseFormatVersion('1.2.3.4.5')).toThrow()
    expect(() => parseFormatVersion('1.x.0')).toThrow()
    expect(() => parseFormatVersion([1, 21.5, 0])).toThrow()
  })

  it('compares component-wise with missing components counting as zero', () => {
    expect(compareFormatVersions(parseFormatVersion('1.21'), parseFormatVersion('1.21.0'))).toBe(0)
    expect(compareFormatVersions(parseFormatVersion('1.21'), parseFormatVersion('1.21.1'))).toBe(-1)
    expect(compareFormatVersions(parseFormatVersion('1.26.50'), parseFormatVersion('1.26.40'))).toBe(1)
    // 110 > 40 numerically; a string compare would get this backwards, and 1.21.110 is a
    // version real packs actually declare.
    expect(compareFormatVersions(parseFormatVersion('1.21.110'), parseFormatVersion('1.21.40'))).toBe(1)
  })

  it('reads 1.21.110 as ABOVE 1.21.10, which is the pair that breaks silently', () => {
    // The shape that fails without a sound: "1.21.110" < "1.21.10" as strings ('1' sorts before
    // '    // third character), and 1.21.10 is scatter's band boundary while 1.21.110 is the version real
    // packs declare. Get it backwards and a correct modern file is told its five nested
    // parameters were dropped.
    const declared = parseFormatVersion('1.21.110')
    expect(compareFormatVersions(declared, parseFormatVersion('1.21.10'))).toBe(1)
    expect(compareFormatVersions(parseFormatVersion('1.21.10'), declared)).toBe(-1)
    expect(atLeastOrUnversioned(declared, '1.21.10')).toBe(true)
    // ...and the consequence the panel actually reads: at 1.21.110 the nested object is the live
    // spelling and the five flat keys are the superseded one, not the other way round.
    const rows = resolveFields('minecraft:scatter_feature', declared)
    expect(rows.find((f) => f.key === 'distribution')?.availability).toBe('available')
    for (const key of ['scatter_chance', 'coordinate_eval_order', 'x', 'y', 'z']) {
      expect(rows.filter((f) => f.key === key).every((f) => f.availability === 'superseded')).toBe(true)
    }
  })
})

describe('type availability (the coarse gate: which types a file may name at all)', () => {
  it('gates the two types registered above the schema floor', () => {
    for (const typeId of ['minecraft:multi_block_feature', 'minecraft:multipart_block_column_feature']) {
      expect(typeAvailableAt(typeId, parseFormatVersion('1.21.40'))).toBe(false)
      expect(typeAvailableAt(typeId, parseFormatVersion('1.26.40'))).toBe(true)
      expect(typeAvailableAt(typeId, parseFormatVersion('1.26.50'))).toBe(true)
    }
  })

  it('does NOT gate horizontal_tree_decoration_feature, which is new in the same game build but registered at the floor', () => {
    // The asymmetry features/typeavailability.go states outright, because it is easy to guess
    // wrong: new-in-1.26.50 the BUILD is not the same as new-in-1.26.50 the format_version band.
    expect(typeAvailableAt('minecraft:horizontal_tree_decoration_feature', parseFormatVersion('1.13.0'))).toBe(true)
  })

  it('treats an absent version as unversioned rather than as older than everything', () => {
    expect(typeAvailableAt('minecraft:multi_block_feature', ABSENT_FORMAT_VERSION)).toBe(true)
  })
})

describe('per-key version gates: scatter, flat parameters vs the nested distribution (1.21.10)', () => {
  it('offers the nested object and supersedes the flat keys at 1.21.10 and above', () => {
    const rows = resolveFields('minecraft:scatter_feature', parseFormatVersion('1.21.40'))
    expect(rows.find((f) => f.key === 'distribution')?.availability).toBe('available')
    for (const key of ['scatter_chance', 'coordinate_eval_order', 'x', 'y', 'z']) {
      // Only the TOP-LEVEL spellings are the flat ones; the same key names also live inside the
      // nested `distribution` object, which resolveFields returns as that field's `entry`.
      const flat = rows.filter((f) => f.key === key)
      expect(flat.length).toBeGreaterThan(0)
      expect(flat.every((f) => f.availability === 'superseded')).toBe(true)
    }
  })

  it('offers the flat keys and marks the nested object too-new below 1.21.10', () => {
    const rows = resolveFields('minecraft:scatter_feature', parseFormatVersion('1.13.0'))
    const nested = rows.find((f) => f.key === 'distribution')
    expect(nested?.availability).toBe('too-new')
    expect(nested?.availabilityNote).toContain('1.21.10')
    expect(rows.filter((f) => f.key === 'scatter_chance').every((f) => f.availability === 'available')).toBe(true)
  })

  it('does not carry `iterations` at all, in either shape -- it is an edge', () => {
    // wire/graph.go puts a scatter's iterations on GraphEdge, and argues at length that
    // modelling it as a spin-box makes its two real idioms harder to write than plain text.
    for (const version of ['1.13.0', '1.21.40']) {
      expect(resolveFields('minecraft:scatter_feature', parseFormatVersion(version)).some((f) => f.key === 'iterations')).toBe(false)
    }
  })

  it('leaves project_input_to_floor ungated -- it sits outside the split', () => {
    for (const version of ['1.13.0', '1.26.50']) {
      const rows = resolveFields('minecraft:scatter_feature', parseFormatVersion(version))
      expect(rows.find((f) => f.key === 'project_input_to_floor')?.availability).toBe('available')
    }
  })
})

describe('per-key version gates: single_block_feature (1.21.40)', () => {
  it('offers the weighted places_block array only at 1.21.40 and above', () => {
    const modern = resolveFields('minecraft:single_block_feature', parseFormatVersion('1.21.40'))
    const weighted = modern.find((f) => f.key === 'places_block' && f.kind === 'weightedBlockList')
    const single = modern.find((f) => f.key === 'places_block' && f.kind === 'block')
    expect(weighted?.availability).toBe('available')
    expect(single?.availability).toBe('superseded')
  })

  it('offers the single descriptor below 1.21.40, and says why the array is not available', () => {
    const old = resolveFields('minecraft:single_block_feature', parseFormatVersion('1.21.10'))
    const weighted = old.find((f) => f.key === 'places_block' && f.kind === 'weightedBlockList')
    const single = old.find((f) => f.key === 'places_block' && f.kind === 'block')
    expect(single?.availability).toBe('available')
    expect(weighted?.availability).toBe('too-new')
    expect(weighted?.availabilityNote).toContain('1.21.40')
  })

  it('gates randomize_rotation and may_not_attach_to, and the diagonal group key INSIDE may_attach_to', () => {
    const old = resolveFields('minecraft:single_block_feature', parseFormatVersion('1.21.10'))
    expect(old.find((f) => f.key === 'randomize_rotation')?.availability).toBe('too-new')
    expect(old.find((f) => f.key === 'may_not_attach_to')?.availability).toBe('too-new')
    // The parent is ungated while a child is gated -- the case that a top-level-only gate
    // implementation would get wrong.
    const attach = old.find((f) => f.key === 'may_attach_to')
    expect(attach?.availability).toBe('available')
    expect(attach?.entry?.find((sub) => sub.key === 'diagonal')?.availability).toBe('too-new')

    const modern = resolveFields('minecraft:single_block_feature', parseFormatVersion('1.21.40'))
    expect(modern.find((f) => f.key === 'randomize_rotation')?.availability).toBe('available')
    expect(modern.find((f) => f.key === 'may_attach_to')?.entry?.find((sub) => sub.key === 'diagonal')?.availability).toBe('available')
  })

  it("carries may_attach_to's two non-direction keys with their real defaults", () => {
    const attach = resolveFields('minecraft:single_block_feature', parseFormatVersion('1.21.40')).find((f) => f.key === 'may_attach_to')
    expect(attach?.entry?.find((sub) => sub.key === 'auto_rotate')?.default).toBe('true')
    expect(attach?.entry?.find((sub) => sub.key === 'min_sides_must_attach')?.default).toBe('4')
  })
})

describe('per-key version gates: snap_to_surface, a RENAME where no version accepts both names', () => {
  it('uses search_range at 1.26.50 and above', () => {
    const rows = resolveFields('minecraft:snap_to_surface_feature', parseFormatVersion('1.26.50'))
    expect(rows.find((f) => f.key === 'search_range')?.availability).toBe('available')
    const old = rows.find((f) => f.key === 'vertical_search_range')
    expect(old?.availability).toBe('superseded')
    expect(old?.availabilityNote).toContain('search_range')
  })

  it('uses vertical_search_range below 1.26.50, and names the spelling that works', () => {
    const rows = resolveFields('minecraft:snap_to_surface_feature', parseFormatVersion('1.21.110'))
    expect(rows.find((f) => f.key === 'vertical_search_range')?.availability).toBe('available')
    const modern = rows.find((f) => f.key === 'search_range')
    expect(modern?.availability).toBe('too-new')
    expect(modern?.availabilityNote).toContain('vertical_search_range')
  })

  it('exposes exactly one of the two names as available at any version', () => {
    for (const version of ['1.13.0', '1.21.10', '1.21.40', '1.26.40', '1.26.50']) {
      const rows = resolveFields('minecraft:snap_to_surface_feature', parseFormatVersion(version))
      const available = rows.filter((f) => (f.key === 'search_range' || f.key === 'vertical_search_range') && f.availability === 'available')
      expect(available).toHaveLength(1)
    }
  })

  it("defaults `surface` to floor, not ceiling", () => {
    // This port said ceiling until 2026-08-15 and was wrong about it in every build; a form
    // that shows the old default sends the author's feature the other way.
    const surface = resolveFields('minecraft:snap_to_surface_feature', parseFormatVersion('1.26.50')).find((f) => f.key === 'surface')
    expect(surface?.default).toBe('floor')
    expect(surface?.values).toContain('wall')
  })

  it('offers allow_non_air_placement at every version, with the unread gate stated rather than assumed', () => {
    // The coverage note calls it new in game build 1.26.50.24, but whether the SCHEMA gates it
    // on format_version was never established. Asserting a gate nobody read would cost the
    // author a key the game accepts, so it is offered with the caveat attached.
    const field = resolveFields('minecraft:snap_to_surface_feature', parseFormatVersion('1.13.0')).find((f) => f.key === 'allow_non_air_placement')
    expect(field?.availability).toBe('available')
    expect(field?.introducedInBuild).toContain('NOT established')
  })
})

describe('buildNodeForm: what the panel shows for an existing node', () => {
  it('shows a too-new key rather than hiding it, and does not validate it', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:single_block_feature',
      formatVersion: '1.21.10',
      fields: { places_block: 'minecraft:stone', enforce_placement_rules: false, enforce_survivability_rules: false },
    })
    const gated = form.rows.find((r) => r.spec.key === 'randomize_rotation')
    expect(gated).toBeDefined()
    expect(gated?.spec.availability).toBe('too-new')
    // Required-but-disabled must not produce a "you must fill this in" message -- the one
    // message that matters is the version one.
    expect(gated?.problems).toEqual([])
  })

  it('reports a missing required key', () => {
    const form = buildNodeForm({ typeId: 'minecraft:ore_feature', formatVersion: '1.21.40', fields: {} })
    expect(row(form.rows, 'count').problems[0]).toContain('required')
    expect(row(form.rows, 'replace_rules').problems).toEqual([])
  })

  it('keeps an unknown key as raw JSON instead of dropping it', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:fossil_feature',
      formatVersion: '1.21.40',
      fields: { ore_block: 'minecraft:coal_ore', max_empty_corners: 4, some_future_key: { a: 1 } },
    })
    const extra = row(form.extras, 'some_future_key')
    expect(extra.editor.control).toBe('json')
    expect(extra.value).toEqual({ a: 1 })
    // The catalogue being incomplete must never silently delete an author's data.
    expect(extra.spec.unsourced).toContain('not in this editor')
  })

  it('reports a delegation key arriving in Fields as a contract violation, not as a field', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:scatter_feature',
      formatVersion: '1.21.40',
      fields: { places_feature: 'my:thing', distribution: {} },
    })
    expect(form.extras.some((r) => r.spec.key === 'places_feature')).toBe(false)
    expect(form.notices.some((n) => n.key === 'places_feature' && n.message.includes('edge'))).toBe(true)
  })

  it('warns about an absent format_version instead of deleting every modern field', () => {
    const form = buildNodeForm({ typeId: 'minecraft:single_block_feature', formatVersion: '', fields: {} })
    expect(form.notices.some((n) => n.key === 'format_version' && n.level === 'warning')).toBe(true)
    // Unversioned reads as unversioned, not as "older than everything": the modern spelling is
    // the one offered.
    expect(form.rows.find((r) => r.spec.key === 'places_block' && r.spec.kind === 'weightedBlockList')?.spec.availability).toBe('available')
  })

  it('reports an unreadable format_version and still renders a usable form', () => {
    const form = buildNodeForm({ typeId: 'minecraft:ore_feature', formatVersion: '1.x.0', fields: { count: 4 } })
    expect(form.notices.some((n) => n.level === 'error' && n.key === 'format_version')).toBe(true)
    expect(form.rows.length).toBeGreaterThan(0)
  })

  it('flags a type the file version cannot name', () => {
    const form = buildNodeForm({ typeId: 'minecraft:multi_block_feature', formatVersion: '1.21.40', fields: {} })
    expect(form.notices.some((n) => n.level === 'error' && n.message.includes('1.21.40'))).toBe(true)
  })

  it("carries a partial type's coverage note WITHOUT making it a notice", () => {
    const form = buildNodeForm({
      typeId: 'minecraft:sculk_patch_feature',
      formatVersion: '1.21.40',
      fields: {},
      coverage: 'partial',
      coverageNote: 'WHY THIS IS PARTIAL: the spread and growth simulation runs on the engine\'s per-block behaviour system.',
    })
    // It reaches the form, so the documentation panel can show it.
    expect(form.coverage).toBe('partial')
    expect(form.coverageNote).toContain('WHY THIS IS PARTIAL')

    // But it is not a notice. Notices sit above the controls on every selection, and this one is
    // the same paragraph on every node of the type, unchanged by anything the author writes --
    // on some types a page and a half of it. Standing text nobody can act on is how a reader
    // learns to skip the top of this panel, which is also where the notices that ARE about their
    // file live.
    expect(form.notices.some((n) => n.message.includes('WHY THIS IS PARTIAL'))).toBe(false)
  })

  it('enforces tree_feature\'s exactly-one-trunk rule in both directions', () => {
    const none = buildNodeForm({ typeId: 'minecraft:tree_feature', formatVersion: '1.21.40', fields: {} })
    expect(none.notices.some((n) => n.level === 'error' && n.message.includes('trunk variant is required'))).toBe(true)

    const two = buildNodeForm({
      typeId: 'minecraft:tree_feature',
      formatVersion: '1.21.40',
      fields: { trunk: {}, acacia_trunk: {} },
    })
    expect(two.notices.some((n) => n.message.includes('Only one trunk variant'))).toBe(true)

    const one = buildNodeForm({ typeId: 'minecraft:tree_feature', formatVersion: '1.21.40', fields: { acacia_trunk: {} } })
    expect(one.notices.some((n) => n.level === 'error')).toBe(false)
  })

  it('gives a tree variant real controls, not a raw-JSON box', () => {
    // This test used to assert the opposite, and was right to at the time: the variants' key
    // sets had never been transcribed, so a text box with a stated reason was the honest
    // fallback. They are sourced now, so the same assertion would be pinning the gap shut.
    const form = buildNodeForm({
      typeId: 'minecraft:tree_feature',
      formatVersion: '1.21.40',
      fields: { acacia_trunk: { trunk_block: 'minecraft:log' } },
    })
    const trunk = row(form.rows, 'acacia_trunk')
    expect(trunk.editor.control).toBe('group')
    if (trunk.editor.control === 'group') {
      // The keys this variant actually accepts, each one a control of its own.
      const keys = trunk.editor.rows.map((r) => r.spec.key)
      expect(keys).toContain('trunk_height')
      expect(keys).toContain('trunk_width')
      expect(keys).toContain('branches')
      expect(keys.length).toBeGreaterThan(3)
    }
  })

})

describe('typed editors', () => {
  it('gives a block descriptor all three legal spellings', () => {
    const form = buildNodeForm({ typeId: 'minecraft:fossil_feature', formatVersion: '1.21.40', fields: {} })
    const editor = row(form.rows, 'ore_block').editor
    expect(editor.control).toBe('block')
    if (editor.control === 'block') expect(editor.spellings).toEqual(['name', 'name-and-states', 'tags'])
  })

  it('accepts all three block-descriptor spellings and rejects anything else', () => {
    expect(isBlockDescriptor('minecraft:stone')).toBe(true)
    expect(isBlockDescriptor({ name: 'minecraft:log', states: { pillar_axis: 'y' } })).toBe(true)
    expect(isBlockDescriptor({ tags: "q.any_tag('stone')" })).toBe(true)
    expect(isBlockDescriptor({ states: { pillar_axis: 'y' } })).toBe(false)
    expect(isBlockDescriptor(7)).toBe(false)
  })

  it('labels a range with range_min/range_max, and rejects the min/max spelling by name', () => {
    const form = buildNodeForm({ typeId: 'minecraft:sculk_patch_feature', formatVersion: '1.21.40', fields: { extra_growth_chance: { min: 1, max: 3 } } })
    const field = row(form.rows, 'extra_growth_chance')
    expect(field.editor.control).toBe('range')
    if (field.editor.control === 'range') expect(field.editor.objectKeys).toEqual(['range_min', 'range_max'])
    // The engine does not reject {min, max}: it logs and substitutes a degenerate {0,0}, so the
    // file loads in game and then does nothing. Saying that is the whole value of the check.
    expect(field.problems[0]).toContain('range_min')
    expect(field.problems[0]).toContain('zero-width')
  })

  it('reads all three range spellings', () => {
    expect(readRange(5)).toEqual({ min: 5, max: 5 })
    expect(readRange([1, 4])).toEqual({ min: 1, max: 4 })
    expect(readRange({ range_min: 1, range_max: 4 })).toEqual({ min: 1, max: 4 })
    expect(readRange({ min: 1, max: 4 })).toBeNull()
    expect(readRange([1, 2, 3])).toBeNull()
  })

  it('offers an enum as a select over the engine\'s own values, in the engine\'s order', () => {
    const form = buildNodeForm({ typeId: 'minecraft:search_feature', formatVersion: '1.21.40', fields: {} })
    const editor = row(form.rows, 'search_axis').editor
    expect(editor.control).toBe('select')
    if (editor.control === 'select') expect(editor.options).toEqual(['-x', '+x', '-y', '+y', '-z', '+z'])
  })

  it('carries the schema\'s own numeric bounds onto the number control, and enforces them', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:sculk_patch_feature',
      formatVersion: '1.21.40',
      fields: { spread_attempts: 7, cursor_count: 2.5 },
    })
    const attempts = row(form.rows, 'spread_attempts')
    expect(attempts.editor).toEqual({ control: 'number', integer: true, min: 1, max: 4 })
    expect(attempts.problems[0]).toContain('at most 4')
    expect(row(form.rows, 'cursor_count').problems[0]).toContain('whole number')
  })

  it('does not force a Molang-or-number field to one or the other', () => {
    const asNumber = buildNodeForm({ typeId: 'minecraft:cave_carver_feature', formatVersion: '1.21.40', fields: { width_modifier: 0.5 } })
    const asMolang = buildNodeForm({ typeId: 'minecraft:cave_carver_feature', formatVersion: '1.21.40', fields: { width_modifier: 'math.random(0, 1)' } })
    expect(row(asNumber.rows, 'width_modifier').editor.control).toBe('molang-or-number')
    expect(row(asNumber.rows, 'width_modifier').problems).toEqual([])
    expect(row(asMolang.rows, 'width_modifier').problems).toEqual([])
  })

  it('parses a Molang-or-number text box into a number only when it really is one', () => {
    expect(parseMolangOrNumber('3')).toBe(3)
    expect(parseMolangOrNumber(' -2.5 ')).toBe(-2.5)
    expect(parseMolangOrNumber('.5')).toBe(0.5)
    expect(parseMolangOrNumber('math.random(0, 1)')).toBe('math.random(0, 1)')
    expect(parseMolangOrNumber('v.worldy')).toBe('v.worldy')
    // Clearing a box means "remove the key", not "write the empty string" -- an empty string
    // would be compiled as a Molang program.
    expect(parseMolangOrNumber('   ')).toBeUndefined()
  })

  it('accepts both spellings of scatter_chance', () => {
    const percent = buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: '1.13.0', fields: { scatter_chance: 50 } })
    const fraction = buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: '1.13.0', fields: { scatter_chance: { numerator: 1, denominator: 10 } } })
    expect(row(percent.rows, 'scatter_chance').problems).toEqual([])
    expect(row(fraction.rows, 'scatter_chance').problems).toEqual([])
    const bad = buildNodeForm({ typeId: 'minecraft:scatter_feature', formatVersion: '1.13.0', fields: { scatter_chance: { numerator: 1 } } })
    expect(row(bad.rows, 'scatter_chance').problems[0]).toContain('numerator, denominator')
  })

  it('builds nested group rows for a structure_template constraint', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:structure_template_feature',
      formatVersion: '1.21.40',
      fields: { structure_name: 'my:thing', constraints: { block_intersection: { block_allowlist: ['minecraft:air'] } } },
    })
    const constraints = row(form.rows, 'constraints')
    expect(constraints.editor.control).toBe('group')
    if (constraints.editor.control !== 'group') throw new Error('unreachable')
    const intersection = row(constraints.editor.rows, 'block_intersection')
    expect(intersection.editor.control).toBe('group')
    if (intersection.editor.control !== 'group') throw new Error('unreachable')
    // The default that is the opposite of the guess: the NARROW check is what a file that never
    // mentions the key gets.
    expect(row(intersection.editor.rows, 'only_check_intersection_for_motion_blocking_blocks').spec.default).toBe('true')
    expect(row(intersection.editor.rows, 'block_allowlist').path).toEqual(['constraints', 'block_intersection', 'block_allowlist'])
  })
})

// ---------------------------------------------------------------------------
// Weighted block lists. The catalogue gives ONE kind to two keys whose engine parsers accept
// DIFFERENT shapes, and every value below is the real spelling out of
// test/fixtures/graph-sample.json rather than an invented one -- a validator that is stricter
// than the engine paints a red mark on a file that loads, which teaches an author to stop
// reading the panel.
// ---------------------------------------------------------------------------

/** growing_plant_cave_vines.json, verbatim. */
const CAVE_VINES_FIELDS = {
  age: { range_max: 25, range_min: 17 },
  allow_water: false,
  body_blocks: [['minecraft:cave_vines', 1]],
  growth_direction: 'down',
  head_blocks: [['minecraft:cave_vines', 1]],
  height_distribution: [
    [[1, 13], 2],
    [[2, 7], 3],
    [[3, 5], 1],
  ],
} as const

describe('weighted block lists: the pair spelling and the object spelling are different keys', () => {
  it("accepts growing_plant's real [block, weight] pairs without a complaint", () => {
    const form = buildNodeForm({
      typeId: 'minecraft:growing_plant_feature',
      formatVersion: '1.21.110',
      fields: { ...CAVE_VINES_FIELDS },
    })
    expect(row(form.rows, 'body_blocks').problems).toEqual([])
    expect(row(form.rows, 'head_blocks').problems).toEqual([])
    // And nothing else on the form objects to the file either.
    expect(form.rows.flatMap((r) => r.problems)).toEqual([])
  })

  it('rejects the object spelling where the engine reads pairs, naming the shape that works', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:growing_plant_feature',
      formatVersion: '1.21.110',
      fields: { ...CAVE_VINES_FIELDS, body_blocks: [{ block: 'minecraft:cave_vines', weight: 1 }] },
    })
    const problems = row(form.rows, 'body_blocks').problems
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('[block, weight] pairs')
  })

  it('checks the pair length and the weight, because a short pair is simply the wrong shape', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:growing_plant_feature',
      formatVersion: '1.21.110',
      fields: { ...CAVE_VINES_FIELDS, body_blocks: [['minecraft:cave_vines'], ['minecraft:cave_vines', 'heavy']] },
    })
    const problems = row(form.rows, 'body_blocks').problems
    expect(problems[0]).toContain('exactly two values')
    expect(problems[1]).toContain('(weight) must be a number')
  })

  it('refuses an empty list, which the engine refuses too', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:growing_plant_feature',
      formatVersion: '1.21.110',
      fields: { ...CAVE_VINES_FIELDS, head_blocks: [] },
    })
    expect(row(form.rows, 'head_blocks').problems[0]).toContain('empty array')
  })

  it('offers the renderer the entry spelling each key really takes', () => {
    const plant = buildNodeForm({ typeId: 'minecraft:growing_plant_feature', formatVersion: '1.21.110', fields: { ...CAVE_VINES_FIELDS } })
    const body = row(plant.rows, 'body_blocks').editor
    expect(body.control).toBe('weighted-block-list')
    if (body.control !== 'weighted-block-list') throw new Error('unreachable')
    expect(body.entrySpellings).toEqual(['pair'])
    // No descriptor shorthand: growing_plant's parser wants an array and nothing else.
    expect(body.scalar).toBe(false)

    const block = buildNodeForm({
      typeId: 'minecraft:single_block_feature',
      formatVersion: '1.21.110',
      fields: { places_block: 'minecraft:gold_block', enforce_placement_rules: false, enforce_survivability_rules: false },
    })
    const places = row(block.rows, 'places_block').editor
    if (places.control !== 'weighted-block-list') throw new Error('unreachable')
    expect(places.entrySpellings).toEqual(['object'])
    expect(places.scalar).toBe(true)
  })

  it('reads a weight the way the engine does -- a boolean counts as a number', () => {
    expect(validateValue({ key: 'body_blocks', kind: 'weightedBlockList', required: true, source: 'builder-header' }, [['minecraft:cave_vines', true]])).toEqual([])
  })
})

describe('places_block: one key whose accepted spellings widen at 1.21.40', () => {
  const modern = (placesBlock: unknown) =>
    buildNodeForm({
      typeId: 'minecraft:single_block_feature',
      formatVersion: '1.21.110',
      fields: { places_block: placesBlock, enforce_placement_rules: false, enforce_survivability_rules: false },
    })

  it('draws ONE row, not one live row and one that silently does nothing', () => {
    const form = modern('minecraft:gold_block')
    expect(form.rows.filter((r) => r.spec.key === 'places_block')).toHaveLength(1)
    expect(row(form.rows, 'places_block').spec.availability).toBe('available')
    // The version boundary is not lost with the row: it is said once, on the key.
    const notice = form.notices.find((n) => n.key === 'places_block')
    expect(notice?.level).toBe('info')
    expect(notice?.message).toContain('ONE key, not two')
    expect(notice?.message).toContain('1.21.40')
  })

  it('accepts every descriptor spelling real files use at a modern version', () => {
    // blocked_gold_block.json, fallen_log_block.json and single_block_pumpkin.json.
    expect(row(modern('minecraft:gold_block').rows, 'places_block').problems).toEqual([])
    expect(row(modern({ name: 'minecraft:oak_log', states: { pillar_axis: 'x' } }).rows, 'places_block').problems).toEqual([])
    expect(
      row(modern([{ block: 'minecraft:pumpkin', weight: 3 }, { block: 'minecraft:jack_o_lantern', weight: 1 }]).rows, 'places_block').problems,
    ).toEqual([])
  })

  it('says what is wrong with an entry the schema refuses, rather than nothing', () => {
    expect(row(modern([{ block: 'minecraft:pumpkin' }]).rows, 'places_block').problems[0]).toContain('has no weight')
    expect(row(modern(['minecraft:pumpkin']).rows, 'places_block').problems[0]).toContain('bare block descriptor')
    expect(row(modern([{ block: 'minecraft:pumpkin', weight: -1 }]).rows, 'places_block').problems[0]).toContain('must not be negative')
    expect(row(modern([]).rows, 'places_block').problems[0]).toContain('empty array')
  })

  it('keeps the single row below 1.21.40, where the array is the shape that does not load', () => {
    const old = buildNodeForm({
      typeId: 'minecraft:single_block_feature',
      formatVersion: '1.21.10',
      fields: { places_block: [{ block: 'minecraft:pumpkin', weight: 3 }], enforce_placement_rules: false, enforce_survivability_rules: false },
    })
    const places = old.rows.filter((r) => r.spec.key === 'places_block')
    expect(places).toHaveLength(1)
    expect(places[0]?.spec.kind).toBe('block')
    expect(places[0]?.problems[0]).toContain('block name string')
    // The bare descriptor is still fine there -- it is fine at every version.
    const fine = buildNodeForm({
      typeId: 'minecraft:single_block_feature',
      formatVersion: '1.21.10',
      fields: { places_block: 'minecraft:gold_block', enforce_placement_rules: false, enforce_survivability_rules: false },
    })
    expect(row(fine.rows, 'places_block').problems).toEqual([])
  })

  it('leaves a genuine RENAME as two rows -- two names, and the author has to change one', () => {
    const form = buildNodeForm({
      typeId: 'minecraft:snap_to_surface_feature',
      formatVersion: '1.26.50',
      fields: { vertical_search_range: 12 },
    })
    expect(row(form.rows, 'search_range').spec.availability).toBe('available')
    expect(row(form.rows, 'vertical_search_range').spec.availability).toBe('superseded')
    expect(row(form.rows, 'vertical_search_range').spec.availabilityNote).toContain('search_range')
    expect(form.notices.some((n) => n.key === 'search_range' || n.key === 'vertical_search_range')).toBe(false)
  })
})

describe('the create path', () => {
  // A slice of the real coverage table, with the statuses and the note openings
  // features/coverage.go actually carries.
  const coverage: readonly CoverageRow[] = [
    { typeId: 'minecraft:ore_feature', status: 'implemented', note: 'Ore vein placer.' },
    {
      typeId: 'minecraft:single_block_feature',
      status: 'partial',
      note:
        'Places a single block, subject to attachment and rotation rules. ROTATION NOW ROTATES. ' +
        'WHY THIS IS STILL PARTIAL, and it is a narrower gap than it was: the game decides whether to rewrite a state by asking the block TYPE. ' +
        'Write the state out if you want the preview to be right.',
    },
    {
      typeId: 'minecraft:snap_to_surface_feature',
      status: 'partial',
      note: 'Scans for a surface and delegates. STILL APPROXIMATE: a handful of enum states are matched by their documented value names rather than by the numbers the game stores.',
    },
    { typeId: 'minecraft:multi_block_feature', status: 'implemented', note: '' },
    { typeId: 'minecraft:beards_and_shavers', status: 'out_of_scope', note: 'Internal/deprecated.' },
    { typeId: 'minecraft:rect_layout', status: 'out_of_scope', note: 'Internal/deprecated.' },
    { typeId: 'minecraft:some_future_type', status: 'missing', note: 'Registered by the engine, never investigated.' },
  ]

  it('never offers a missing or out_of_scope type, in any state', () => {
    const palette = createPalette(coverage, '1.26.50')
    const offered = palette.map((entry) => entry.typeId)
    expect(offered).not.toContain('minecraft:beards_and_shavers')
    expect(offered).not.toContain('minecraft:rect_layout')
    expect(offered).not.toContain('minecraft:some_future_type')
    expect(offered).toContain('minecraft:ore_feature')
  })

  it('shows a partial type\'s note and the sentences that state what is approximated', () => {
    const palette = createPalette(coverage, '1.26.50')
    const partial = palette.find((entry) => entry.typeId === 'minecraft:snap_to_surface_feature')
    expect(partial?.status).toBe('partial')
    expect(partial?.note).toContain('STILL APPROXIMATE')
    expect(partial?.approximations.some((s) => s.includes('STILL APPROXIMATE'))).toBe(true)
    // An implemented type carries no approximations -- there is nothing to disclose.
    expect(palette.find((entry) => entry.typeId === 'minecraft:ore_feature')?.approximations).toEqual([])
  })

  it('keeps the approximation extraction a highlight, never a filter', () => {
    // A note with no recognised marker must come back whole rather than empty: a partial type
    // whose caveat is phrased unusually is exactly the case where reading all of it matters.
    const whole = extractApproximations('Something entirely unmarked. And a second sentence.')
    expect(whole).toHaveLength(2)
  })

  it('flags, rather than hides, a type the file\'s version cannot name', () => {
    const palette = createPalette(coverage, '1.21.40')
    const gated = palette.find((entry) => entry.typeId === 'minecraft:multi_block_feature')
    // Hiding it would leave the author wondering where the type went; flagging it names the one
    // line they have to change.
    expect(gated).toBeDefined()
    expect(gated?.availableAtVersion).toBe(false)
    expect(gated?.minFormatVersion).toBe('1.26.40')
    expect(createPalette(coverage, '1.26.50').find((e) => e.typeId === 'minecraft:multi_block_feature')?.availableAtVersion).toBe(true)
  })

  it('says when a type has no field catalogue rather than showing an empty form', () => {
    const palette = createPalette([{ typeId: 'minecraft:not_catalogued', status: 'implemented' }], '1.26.50')
    expect(palette[0]?.modelled).toBe(false)
    expect(createPalette(coverage, '1.26.50').find((e) => e.typeId === 'minecraft:ore_feature')?.modelled).toBe(true)
  })

  it('seeds a new node with exactly the required keys for that version', () => {
    const modern = seedNewNodeFields('minecraft:single_block_feature', '1.21.40')
    expect(Object.keys(modern).sort()).toEqual(['enforce_placement_rules', 'enforce_survivability_rules', 'places_block'])
    // Optional keys are left ABSENT: absence and an explicitly written default are not the same
    // thing to the engine, and the author should choose.
    expect(modern).not.toHaveProperty('may_attach_to')
    // The gated spelling is what the seed uses at each version.
    expect(Array.isArray(modern['places_block'])).toBe(true)
    expect(seedNewNodeFields('minecraft:single_block_feature', '1.21.10')['places_block']).toBe('')
  })

  it('seeds numeric placeholders inside the schema\'s own bounds', () => {
    const seeded = seedNewNodeFields('minecraft:sculk_patch_feature', '1.26.50')
    // charge_amount's bound starts at 1; seeding 0 would start the file with a value the engine
    // rejects outright.
    expect(seeded['charge_amount']).toBe(1)
    expect(seeded['spread_attempts']).toBe(1)
    expect(seeded['cursor_count']).toBe(0)
  })

  it('does not seed a one-of variant -- a trunk is a choice, not a default', () => {
    const seeded = seedNewNodeFields('minecraft:tree_feature', '1.21.40')
    expect(Object.keys(seeded)).toEqual([])
  })

  it('produces a seed whose only complaints are the values the author still has to fill in', () => {
    const seeded = seedNewNodeFields('minecraft:multiface_feature', '1.26.50')
    const form = buildNodeForm({ typeId: 'minecraft:multiface_feature', formatVersion: '1.26.50', fields: seeded })
    // Every required key is present, so nothing is reported as missing...
    expect(form.rows.flatMap((r) => r.problems).filter((p) => p.includes('is required'))).toEqual([])
    // ...but the block placeholder is deliberately an empty name, which is a shape, not a value.
    expect(seeded['places_block']).toBe('')
  })
})

describe('editing: immutable updates and change events', () => {
  it('writes, clears and nests without mutating the input', () => {
    const original = { count: 4, replace_rules: [{ places_block: 'minecraft:stone' }] }
    const written = setAtPath(original, ['count'], 9)
    expect(written['count']).toBe(9)
    expect(original.count).toBe(4)

    const nested = setAtPath(original, ['replace_rules', 0, 'places_block'], 'minecraft:deepslate')
    expect(readAtPath(nested, ['replace_rules', 0, 'places_block'])).toBe('minecraft:deepslate')
    expect(original.replace_rules[0]?.places_block).toBe('minecraft:stone')

    // undefined REMOVES the key -- an optional field returning to "absent", which is not the
    // same as the author writing null.
    const cleared = setAtPath(original, ['count'], undefined)
    expect('count' in cleared).toBe(false)
  })

  it('creates the containers a nested write needs', () => {
    const grown = setAtPath({}, ['may_attach_to', 'top'], ['minecraft:stone'])
    expect(grown).toEqual({ may_attach_to: { top: ['minecraft:stone'] } })
  })

  it('emits a change carrying the path, the previous value and the whole Fields object', () => {
    const controller = new NodeFormController({
      typeId: 'minecraft:ore_feature',
      formatVersion: '1.21.40',
      fields: { count: 4 },
    })
    const listener = vi.fn()
    const subscription = controller.onChange(listener)

    controller.setValue(['count'], 12)
    expect(listener).toHaveBeenCalledTimes(1)
    const change = listener.mock.calls[0]?.[0]
    expect(change).toMatchObject({ key: 'count', path: ['count'], previous: 4, value: 12 })
    expect(change.fields).toEqual({ count: 12 })

    subscription.dispose()
    controller.setValue(['count'], 13)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the form after an edit, so validation tracks the new value', () => {
    const controller = new NodeFormController({ typeId: 'minecraft:geode_feature', formatVersion: '1.21.40', fields: { max_radius: 8 } })
    expect(row(controller.form.rows, 'max_radius').problems).toEqual([])
    controller.setValue(['max_radius'], 'eight')
    expect(row(controller.form.rows, 'max_radius').problems[0]).toContain('must be a number')
  })

  it('refuses a path that does not start at a key of Fields', () => {
    const controller = new NodeFormController({ typeId: 'minecraft:ore_feature', formatVersion: '1.21.40', fields: {} })
    expect(() => controller.setValue([0], 1)).toThrow()
  })
})

describe('catalogue integrity', () => {
  it('never lists a delegation key as a field on any type', () => {
    // GraphNode.Fields is defined as the body MINUS the delegation keys; a delegation key here
    // would mean the form and the graph canvas both claim to own the same value.
    const delegations = ['places_feature', 'features', 'conditional_features', 'feature_to_snap', 'feature_to_place', 'feature_to_scan', 'vegetation_feature', 'iterations']
    for (const typeId of catalogedTypeIds()) {
      const keys = (typeSpec(typeId)?.fields ?? []).map((f) => f.key)
      for (const key of delegations) expect(keys, `${typeId} lists the delegation key ${key}`).not.toContain(key)
    }
  })

  it('gives every enum field its values and every gated field a version', () => {
    for (const typeId of catalogedTypeIds()) {
      const walk = (fields: readonly { key: string; kind: string; values?: readonly string[]; since?: string; until?: string; entry?: readonly never[] }[]): void => {
        for (const field of fields) {
          if (field.kind === 'enum') expect(field.values?.length, `${typeId}.${field.key}`).toBeGreaterThan(0)
          if (field.since !== undefined) expect(() => parseFormatVersion(field.since as string)).not.toThrow()
          if (field.until !== undefined) expect(() => parseFormatVersion(field.until as string)).not.toThrow()
          if (field.entry !== undefined) walk(field.entry)
        }
      }
      walk((typeSpec(typeId)?.fields ?? []) as never)
    }
  })

  it('gives every json-kind field a reason it is not modelled', () => {
    // The escape hatch is only acceptable while it says what is missing; an unexplained
    // free-text box is indistinguishable from a forgotten field.
    for (const typeId of catalogedTypeIds()) {
      for (const field of typeSpec(typeId)?.fields ?? []) {
        if (field.kind === 'json') expect(field.unsourced, `${typeId}.${field.key}`).toBeTruthy()
      }
    }
  })

  it('reports nothing for a type it does not catalogue rather than pretending it has no fields', () => {
    const form = buildNodeForm({ typeId: 'minecraft:beards_and_shavers', formatVersion: '1.26.50', fields: { something: 1 } })
    expect(form.rows).toEqual([])
    expect(form.notices.some((n) => n.message.includes('no field catalogue'))).toBe(true)
    expect(form.extras).toHaveLength(1)
  })

  it('validates a value directly, for a caller that has not built a form', () => {
    expect(validateValue({ key: 'x', kind: 'integer', required: false, min: 1, source: 'builder' }, 0)).toHaveLength(1)
    expect(validateValue({ key: 'x', kind: 'integer', required: false, min: 1, source: 'builder' }, 2)).toEqual([])
    expect(validateValue({ key: 'x', kind: 'boolean', required: true, source: 'builder' }, undefined)).toHaveLength(1)
  })
})

describe('validateValue: what the engine accepts, not what looks tidy', () => {
  it('refuses a single block where the engine reads only a list, and accepts it where it takes the shorthand', () => {
    // features/shared.go: AsBlockDescriptorList answers "must be an array" to anything else. Only
    // the attach-map faces and a tree's base_block go through AsBlockDescriptorOrList.
    const listOnly = { key: 'allowed_surface_blocks', kind: 'blockList', required: false, source: 'builder' } as const
    expect(validateValue(listOnly, 'minecraft:stone')).toEqual([expect.stringMatching(/must be a list of blocks.*one-entry list/)])
    expect(validateValue(listOnly, ['minecraft:stone'])).toEqual([])
    const shorthand = { ...listOnly, key: 'top', acceptsSingle: true }
    expect(validateValue(shorthand, 'minecraft:stone')).toEqual([])
    expect(validateValue(shorthand, 5)).toHaveLength(1)
  })

  it('accepts null for a Molang-or-number field, because the engine reads it as 0', () => {
    // features/distribution.go's expression parser has an explicit `case nil` returning the
    // constant 0. A file writing null therefore loads and behaves; a problem here would be a
    // red mark on correct data, which is the one failure mode this validator cannot afford --
    // an author who sees the panel be wrong once stops believing it when it is right.
    const spec: FieldSpec = { key: 'iterations', kind: 'molangOrNumber', required: false, source: 'builder' }
    expect(validateValue(spec, null)).toEqual([])
    expect(validateValue(spec, 3)).toEqual([])
    expect(validateValue(spec, 'q.foo > 1')).toEqual([])
    // An object is still wrong: that one the engine does refuse.
    expect(validateValue(spec, { min: 1 }).length).toBeGreaterThan(0)
  })
})
