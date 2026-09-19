// docsCatalog.test.ts -- the coverage and safety guards on the hover documentation.
//
// "Every parameter and every value is documented" is the point of src/graph/docs/catalog.ts, and a
// point like that is worth nothing as an aspiration. So it is a test: this file walks every
// TypeSpec the type catalogue registers, every field inside it including the nested ones, and every
// value of every enum, and fails when one of them has no explanation anywhere.
//
// WHAT COUNTS AS DOCUMENTED, and why the bar is where it is:
//
//   - an entry in catalog.ts, or
//   - typeCatalog's own FieldSpec.doc, which is deliberately accepted. Several of those already
//     say the thing that matters better than a second paragraph would, and a coverage test that
//     forced a duplicate would produce exactly the duplicate it forced -- two half-maintained
//     sentences about one key, drifting apart.
//
// An entry may also declare itself `unestablished`, and that passes. That is not a loophole, it is
// the honest answer to a key whose behaviour nobody has pinned down: a documented gap sends an
// author to check, an invented explanation tells them not to bother. The pinned list below is what
// stops it becoming a habit -- adding one is a deliberate edit to this file.
//
// What does NOT pass is filler. "The distribution field." satisfies a naive counter and teaches
// nobody anything, so there is a shape check on every summary, and a check that no entry is a
// verbatim copy of the FieldSpec.doc it sits next to.

import { describe, expect, it } from 'vitest'
import {
  catalogedTypeIds,
  typeSpec,
  type FieldSpec,
} from '../src/graph/typeCatalog'
import {
  allDocEntries,
  fieldSpecAt,
  lookupFieldDoc,
  lookupValueDoc,
  renderFieldDoc,
  renderValueDoc,
} from '../src/graph/docs/catalog'

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface WalkedField {
  typeId: string
  path: string
  spec: FieldSpec
}

/** Every field of every catalogued type, nested ones included, as (typeId, dotted path).
 *
 * A field whose `key` is the empty string is skipped -- and that is a real decision, not an
 * oversight. Those are the anonymous ELEMENTS of a positional array (scatter's `extent`, search's
 * `search_volume.min`): they have no key for a hover to sit on and no key for a doc table to be
 * keyed by. What they need said is said on the array field that owns them, and that field IS
 * walked. Their own sub-fields, if any, are still walked through. */
function walkFields(): WalkedField[] {
  const out: WalkedField[] = []
  const recurse = (typeId: string, fields: readonly FieldSpec[], prefix: string): void => {
    for (const spec of fields) {
      if (spec.key === '') {
        if (spec.entry !== undefined) recurse(typeId, spec.entry, prefix)
        continue
      }
      const path = prefix === '' ? spec.key : `${prefix}.${spec.key}`
      out.push({ typeId, path, spec })
      if (spec.entry !== undefined) recurse(typeId, spec.entry, path)
    }
  }
  for (const typeId of catalogedTypeIds()) {
    const spec = typeSpec(typeId)
    if (spec === undefined) throw new Error(`catalogedTypeIds() offered ${typeId}, which typeSpec() does not know`)
    recurse(typeId, spec.fields, '')
  }
  return out
}

/** The (typeId, path, value) triples an enum field puts in front of an author. Deduplicated on
 * (typeId, path, value): scatter registers the same axis keys twice, once nested under
 * `distribution` and once flat for files below 1.21.10, and both resolve to the same doc. */
function walkEnumValues(): { typeId: string; path: string; value: string }[] {
  const seen = new Set<string>()
  const out: { typeId: string; path: string; value: string }[] = []
  for (const field of walkFields()) {
    if (field.spec.kind !== 'enum') continue
    const values = field.spec.values
    expect(values, `${field.typeId} ${field.path} is an enum with no values`).toBeDefined()
    for (const value of values ?? []) {
      const id = `${field.typeId}|${field.path}|${value}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ typeId: field.typeId, path: field.path, value })
    }
  }
  return out
}

const FIELDS = walkFields()
const ENUM_VALUES = walkEnumValues()

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('the walk itself', () => {
  it('is looking at the whole catalogue and not at a fragment of it', () => {
    // The specific way a sweep goes wrong is that it silently stops finding things -- the run then
    // looks exactly like a clean one. These floors are not targets, they are tripwires.
    expect(catalogedTypeIds().length).toBeGreaterThanOrEqual(27)
    expect(FIELDS.length).toBeGreaterThanOrEqual(140)
    expect(ENUM_VALUES.length).toBeGreaterThanOrEqual(50)
  })

  it('reaches fields nested inside groups', () => {
    const paths = FIELDS.map((f) => f.path)
    expect(paths).toContain('may_attach_to.auto_rotate')
    expect(paths).toContain('distribution.x.distribution')
    expect(paths).toContain('constraints.block_intersection.block_allowlist')
  })
})

describe('every parameter is documented', () => {
  it('has an explanation for every field of every catalogued type', () => {
    const undocumented: string[] = []
    for (const field of FIELDS) {
      const doc = lookupFieldDoc(field.typeId, field.path)
      if (doc === undefined || !doc.documented) {
        undocumented.push(`${field.typeId} ${field.path}`)
      }
    }
    expect(
      undocumented,
      'these fields have neither a catalog.ts entry nor a FieldSpec.doc. Write one, or mark the\n' +
        'entry unestablished and add it to the pinned list in this file -- do not write filler.',
    ).toEqual([])
  })

  it('resolves every field path to the FieldSpec it names', () => {
    for (const field of FIELDS) {
      expect(fieldSpecAt(field.typeId, field.path), `${field.typeId} ${field.path}`).toBeDefined()
    }
  })
})

describe('every value is documented', () => {
  it('has an explanation for every value of every enum field', () => {
    const undocumented: string[] = []
    for (const { typeId, path, value } of ENUM_VALUES) {
      const doc = lookupValueDoc(typeId, path, value)
      if (doc === undefined || !doc.documented) undocumented.push(`${typeId} ${path} = ${value}`)
    }
    expect(
      undocumented,
      'these enum values have no value doc. A value in a dropdown with nothing behind it is the\n' +
        'exact gap this catalogue exists to close.',
    ).toEqual([])
  })
})

describe('the coverage numbers', () => {
  // Pinned so that a field added to typeCatalog without a doc, or a doc deleted, is a failure with
  // a number in it rather than a silent drift. Update them when the catalogue genuinely grows.
  it('documents every field and every value', () => {
    const documentedFields = FIELDS.filter((f) => lookupFieldDoc(f.typeId, f.path)?.documented === true)
    const documentedValues = ENUM_VALUES.filter(
      (v) => lookupValueDoc(v.typeId, v.path, v.value)?.documented === true,
    )
    expect(documentedFields.length).toBe(FIELDS.length)
    expect(documentedValues.length).toBe(ENUM_VALUES.length)
    // The totals themselves, pinned. Coverage being 100% is the assertion above; these two numbers
    // are what make a field QUIETLY DISAPPEARING from typeCatalog -- or a doc table being gutted --
    // fail with a number in it instead of passing as a smaller, still-complete catalogue.
    // 241 -> 472 and 85 -> 114 as the tree was sourced: first its trunk and canopy variants, then
    // base_cluster and mangrove_roots. They had
    // been twenty raw-JSON boxes carrying a note that their key sets were never transcribed; each
    // is now a real set of controls, and every one of the 217 new fields arrived with its own
    // entry -- which is what this assertion is for. A number that only ever goes up silently is
    // not a coverage check.
    // 472 -> 494 and 114 -> 150 when minecraft:feature_rule was catalogued: 22 fields (its
    // conditions and its distribution, the latter sharing scatter's own axis definitions rather
    // than restating them) and 36 values -- the twelve placement passes, plus the axis
    // distributions and evaluation orders that come with the shared definitions.
    expect({ fields: FIELDS.length, values: ENUM_VALUES.length }).toEqual({ fields: 494, values: 150 })
  })

  it('carries its own prose for most fields rather than leaning on FieldSpec.doc', () => {
    // Not a coverage requirement -- a shape one. If this ever collapses toward zero, the catalogue
    // has become an empty shell that passes its coverage test on typeCatalog's back.
    const withOwnEntry = FIELDS.filter((f) => lookupFieldDoc(f.typeId, f.path)?.entry !== undefined)
    const specDocOnly = FIELDS.filter((f) => {
      const doc = lookupFieldDoc(f.typeId, f.path)
      return doc?.entry === undefined && doc?.spec?.doc !== undefined
    })
    expect(withOwnEntry.length).toBeGreaterThan(FIELDS.length / 2)
    // The fields this catalogue deliberately leaves to typeCatalog, because its own `doc` already
    // answers "what is this and what would I write". Pinned as a list rather than a count so that
    // adding to it is visible: every name here is a decision not to say more.
    expect(specDocOnly.map((f) => `${f.typeId} ${f.path}`).sort()).toEqual(
      [
        'minecraft:geode_feature base_crack_size',
        'minecraft:geode_feature generate_crack_chance',
        'minecraft:ore_feature replace_rules',
        // `coordinate_eval_order` used to be here, on both spellings. It has a shared entry now:
        // the mechanism its six values all rest on is said once, on the field, instead of being
        // generated into each value's own paragraph. See SHARED_FIELD_DOCS in catalog.ts.
        'minecraft:scatter_feature distribution.scatter_chance',
        'minecraft:scatter_feature scatter_chance',
        'minecraft:single_block_feature enforce_placement_rules',
        'minecraft:single_block_feature enforce_survivability_rules',
        'minecraft:single_block_feature may_attach_to.auto_rotate',
        'minecraft:single_block_feature may_attach_to.min_sides_must_attach',
        'minecraft:snap_to_surface_feature allow_non_air_placement',
        'minecraft:structure_template_feature constraints.block_intersection.block_allowlist',
        'minecraft:structure_template_feature constraints.leveled.max_steepness',
      ].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// Quality of the entries
// ---------------------------------------------------------------------------

describe('no entry is filler', () => {
  const FILLER = /^(the|a|an)\s+[a-z_0-9 ]+\s+(field|key|value|parameter|setting|option)\.?$/i

  it('gives every summary a sentence that says something', () => {
    for (const { location, entry } of allDocEntries()) {
      expect(entry.summary, `${location}: summary must end in a full stop`).toMatch(/\.$/)
      expect(entry.summary.length, `${location}: summary is too short to be saying anything`).toBeGreaterThanOrEqual(24)
      expect(entry.summary, `${location}: summary is one line`).not.toContain('\n')
      expect(
        FILLER.test(entry.summary),
        `${location}: "${entry.summary}" restates the key name and tells the author nothing`,
      ).toBe(false)
    }
  })

  it('gives every detail enough room to be worth reading', () => {
    for (const { location, entry } of allDocEntries()) {
      if (entry.detail === undefined) continue
      expect(entry.detail.length, `${location}: detail is too short to add anything`).toBeGreaterThanOrEqual(40)
      expect(entry.detail, `${location}: detail repeats the summary verbatim`).not.toBe(entry.summary)
    }
  })

  it('never duplicates the FieldSpec.doc it sits beside', () => {
    // The two halves are rendered together. A copy is not extra information, it is the same
    // sentence twice and two places to forget to update.
    for (const field of FIELDS) {
      const doc = lookupFieldDoc(field.typeId, field.path)
      const own = doc?.entry
      const specDoc = field.spec.doc
      if (own === undefined || specDoc === undefined) continue
      expect(own.summary, `${field.typeId} ${field.path}`).not.toBe(specDoc)
      expect(own.detail, `${field.typeId} ${field.path}`).not.toBe(specDoc)
    }
  })
})

describe('unestablished entries', () => {
  // Every entry that admits it cannot explain something, pinned by location. Adding one is meant to
  // cost an edit here, so that "mark it unestablished" never quietly becomes the cheap way out.
  const EXPECTED_UNESTABLISHED: readonly string[] = [
    // The schema hangs min_sides_must_attach and auto_rotate off BOTH attach objects. Only the
    // copies inside may_attach_to are known to be read; what the may_not_attach_to copies do is
    // genuinely open, and both wrong guesses cost an author real time.
    'minecraft:single_block_feature field may_not_attach_to.min_sides_must_attach',
    'minecraft:single_block_feature field may_not_attach_to.auto_rotate',
  ]

  it('are exactly the ones this file names', () => {
    const actual = allDocEntries()
      .filter(({ entry }) => entry.unestablished === true)
      .map(({ location }) => location)
      .sort()
    expect(actual).toEqual([...EXPECTED_UNESTABLISHED].sort())
  })

  it('say what is not known rather than trailing off', () => {
    for (const { location, entry } of allDocEntries()) {
      if (entry.unestablished !== true) continue
      expect(entry.detail, `${location}: an unestablished entry must say what would settle it`).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// The lookup API
// ---------------------------------------------------------------------------

describe('lookup', () => {
  it('shares one entry across every type that has the field', () => {
    const cave = lookupFieldDoc('minecraft:cave_carver_feature', 'floor_level')
    const nether = lookupFieldDoc('minecraft:nether_cave_carver_feature', 'floor_level')
    const underwater = lookupFieldDoc('minecraft:underwater_cave_carver_feature', 'floor_level')
    expect(cave?.source).toBe('shared')
    expect(cave?.entry).toBe(nether?.entry)
    expect(cave?.entry).toBe(underwater?.entry)
  })

  it('lets a type override a shared entry', () => {
    const shared = lookupFieldDoc('minecraft:multi_block_feature', 'may_replace')
    const own = lookupFieldDoc('minecraft:single_block_feature', 'may_replace')
    expect(shared?.source).toBe('shared')
    expect(own?.source).toBe('type')
    expect(own?.entry).not.toBe(shared?.entry)
  })

  it('tells the scatter parameter object from the per-axis distribution kind', () => {
    // Both are spelled `distribution`, one nested inside the other. This is the case that decides
    // the whole resolution order, so it is pinned rather than left to hold by luck.
    const group = lookupFieldDoc('minecraft:scatter_feature', 'distribution')
    const kind = lookupFieldDoc('minecraft:scatter_feature', 'distribution.x.distribution')
    expect(group?.entry).toBeDefined()
    expect(kind?.entry).toBeDefined()
    expect(group?.entry).not.toBe(kind?.entry)
    expect(group?.spec?.kind).toBe('group')
    expect(kind?.spec?.kind).toBe('enum')
  })

  it('documents fixed_grid in the terms the author needs', () => {
    const doc = lookupValueDoc('minecraft:scatter_feature', 'distribution.x.distribution', 'fixed_grid')
    expect(doc?.documented).toBe(true)
    const text = `${doc?.entry?.summary} ${doc?.entry?.detail}`
    expect(text).toMatch(/step_size/)
    expect(text).toMatch(/grid_offset/)
    // The result wraps by the extent's width plus one -- the fact that makes a grid axis behave
    // unlike every other kind, and the one a hover has to carry.
    expect(text).toMatch(/wrap/i)
    // And the honest caveat, which must survive any rewrite of this entry.
    expect(text).toMatch(/not established/i)
  })

  it('reaches the same doc through the flat pre-1.21.10 spelling', () => {
    const nested = lookupValueDoc('minecraft:scatter_feature', 'distribution.z.distribution', 'jittered_grid')
    const flat = lookupValueDoc('minecraft:scatter_feature', 'z.distribution', 'jittered_grid')
    expect(flat?.entry).toBe(nested?.entry)
  })

  it('resolves a path that carries array indices', () => {
    const indexed = lookupFieldDoc('minecraft:ore_feature', 'replace_rules.0.may_replace')
    const plain = lookupFieldDoc('minecraft:ore_feature', 'replace_rules.may_replace')
    expect(indexed?.path).toBe('replace_rules.may_replace')
    expect(indexed?.entry).toBe(plain?.entry)
  })

  it('keeps a positional tuple slot distinct from an array index', () => {
    const slot = lookupFieldDoc('minecraft:growing_plant_feature', 'height_distribution.0.0')
    expect(slot?.path).toBe('height_distribution.0')
    expect(slot?.spec?.kind).toBe('range')
  })

  it('returns undefined for a type or a path it does not know', () => {
    expect(lookupFieldDoc('minecraft:beards_and_shavers', 'anything')).toBeUndefined()
    expect(lookupFieldDoc('minecraft:geode_feature', 'no_such_key')).toBeUndefined()
    expect(lookupValueDoc('minecraft:geode_feature', 'no_such_key', 'x')).toBeUndefined()
  })

  it('reports an undocumented value of a real field rather than pretending it does not exist', () => {
    const doc = lookupValueDoc('minecraft:snap_to_surface_feature', 'surface', 'not_a_value')
    expect(doc).toBeDefined()
    expect(doc?.documented).toBe(false)
  })
})

describe('rendering', () => {
  it('shows this catalogue and the schema facts together', () => {
    const doc = lookupFieldDoc('minecraft:snap_to_surface_feature', 'surface')
    expect(doc).toBeDefined()
    const md = renderFieldDoc(doc as NonNullable<typeof doc>)
    expect(md).toContain('`surface`')
    // our prose
    expect(md).toContain('Which surface the scan is looking for.')
    // typeCatalog's own doc, verbatim, not restated by us
    expect(md).toContain('The default is FLOOR')
    // and the fact sheet
    expect(md).toMatch(/absent: floor/)
  })

  it('renders a value hover', () => {
    const doc = lookupValueDoc('minecraft:snap_to_surface_feature', 'surface', 'random_horizontal')
    const md = renderValueDoc(doc as NonNullable<typeof doc>)
    expect(md).toContain('`random_horizontal`')
    expect(md).toMatch(/FLOOR or CEILING/)
  })
})

// ---------------------------------------------------------------------------
// No orphans
// ---------------------------------------------------------------------------

describe('every entry is reachable', () => {
  it('has no doc keyed to a path or value that does not exist', () => {
    // A typo in a table key is invisible: the entry is simply never found, and the coverage test
    // above then fails somewhere else entirely (or, worse, the key is also covered by a shared
    // entry and nothing fails at all). So every entry has to be reachable from the walk.
    const reachableFields = new Set(FIELDS.map((f) => `${f.typeId}|${f.path}`))
    const reachableValues = new Set(ENUM_VALUES.map((v) => `${v.typeId}|${v.path}|${v.value}`))
    const orphans: string[] = []

    for (const { location, entry } of allDocEntries()) {
      const typeMatch = /^(minecraft:[a-z_]+) (field|value) (.+)$/.exec(location)
      if (typeMatch === null) continue // a shared entry; checked below
      const [, typeId, kind, rest] = typeMatch as unknown as [string, string, string, string]
      if (kind === 'field') {
        if (!reachableFields.has(`${typeId}|${rest}`)) orphans.push(location)
      } else {
        const eq = rest.lastIndexOf('=')
        const path = rest.slice(0, eq)
        const value = rest.slice(eq + 1)
        if (!reachableValues.has(`${typeId}|${path}|${value}`)) orphans.push(location)
      }
      expect(entry).toBeDefined()
    }
    expect(orphans, 'these entries are keyed to something the type catalogue does not have').toEqual([])
  })

  it('has no shared entry that nothing uses', () => {
    const usedFieldKeys = new Set<string>()
    for (const f of FIELDS) {
      usedFieldKeys.add(f.path)
      usedFieldKeys.add(f.path.split('.').pop() as string)
    }
    const unused: string[] = []
    for (const { location } of allDocEntries()) {
      const m = /^shared field (.+)$/.exec(location)
      if (m === null) continue
      if (!usedFieldKeys.has(m[1] as string)) unused.push(location)
    }
    expect(unused, 'these shared entries are keyed to a field key nothing has').toEqual([])
  })
})
