// treeTrunks.test.ts -- the guards on the tree feature's trunk variant schemas.
//
// Two jobs, and they are different in kind.
//
// FIRST, the shape a consumer relies on. src/graph/treeTrunks.ts exists to be spliced into
// typeCatalog's TypeSpec for `minecraft:tree_feature` and into the hover catalogue's field and
// value tables. Both of those have their own tests, and both of those tests will fail loudly and
// unhelpfully -- "field X is undocumented", "these entries are keyed to something the catalogue
// does not have" -- if this module hands them a malformed spec or a doc table that does not line up
// with it. So the alignment is asserted HERE, where the failure names the actual mistake.
//
// SECOND, the handful of facts most likely to be quietly re-broken. Every one of the pinned facts
// below is something a reasonable person would get wrong from the key names alone, and at least two
// of them HAVE been got wrong in this project before:
//
//   - the bare `trunk` key is the SIMPLE trunk, not a default that becomes another shape;
//   - a range-typed key is spelled range_min / range_max, and `branch_altitude_factor` is the one
//     object in a trunk body that genuinely takes `min` and `max`;
//   - several absent-key defaults are the opposite of the obvious guess -- a fallen trunk's stump
//     defaults to one block rather than none, a decoration without a chance decorates NOTHING, and
//     `step_direction` defaults to down rather than outward.
//
// A test that only checked well-formedness would let every one of those flip silently.

import { describe, expect, it } from 'vitest'
import {
  SIMPLE_TRUNK_KEY,
  TREE_TRUNK_BRANCH_CANOPY_PATHS,
  TREE_TRUNK_DELEGATION_PATHS,
  TREE_TRUNK_DOCS,
  TREE_TRUNK_FIELDS,
  TREE_TRUNK_VALUE_DOCS,
  TREE_TRUNK_VARIANTS,
  trunkVariantFields,
} from '../src/graph/treeTrunks'
import { DELEGATION_KEYS, type FieldSpec } from '../src/graph/typeCatalog'
import { TOOLING_WORDS } from './fixtures/languageGuard'

// ---------------------------------------------------------------------------
// The walk -- the same one the hover catalogue's own coverage test performs
// ---------------------------------------------------------------------------

interface Walked {
  path: string
  spec: FieldSpec
}

/** Every field, nested ones included, as a dotted path. A field whose key is the empty string is an
 * anonymous array element (the entries of `intervals`): it has no key for a doc table to hang on,
 * so it is skipped and its own sub-fields, if it had any, would still be walked. */
function walk(fields: readonly FieldSpec[], prefix = ''): Walked[] {
  const out: Walked[] = []
  for (const spec of fields) {
    if (spec.key === '') {
      if (spec.entry !== undefined) out.push(...walk(spec.entry, prefix))
      continue
    }
    const path = prefix === '' ? spec.key : `${prefix}.${spec.key}`
    out.push({ path, spec })
    if (spec.entry !== undefined) out.push(...walk(spec.entry, path))
  }
  return out
}

const ALL = walk(TREE_TRUNK_FIELDS)
const BY_PATH = new Map(ALL.map((f) => [f.path, f.spec]))

function fieldAt(path: string): FieldSpec {
  const spec = BY_PATH.get(path)
  if (spec === undefined) throw new Error(`no field at ${path} -- the variant body changed shape`)
  return spec
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('the eight trunk variants', () => {
  it('are exactly the keys the engine registers, and there are eight of them', () => {
    expect([...TREE_TRUNK_VARIANTS].sort()).toEqual([
      'acacia_trunk',
      'cherry_trunk',
      'fallen_trunk',
      'fancy_trunk',
      'mangrove_trunk',
      'mega_trunk',
      'poplar_trunk',
      'trunk',
    ])
    expect(TREE_TRUNK_FIELDS).toHaveLength(8)
  })

  it('each appear once at the top level, in the trunk exclusive group', () => {
    expect(TREE_TRUNK_FIELDS.map((f) => f.key)).toEqual([...TREE_TRUNK_VARIANTS])
    for (const field of TREE_TRUNK_FIELDS) {
      expect(field.exclusiveGroup, field.key).toBe('trunk')
      // Not `required`, individually: the GROUP is required, any one member is not.
      expect(field.required, field.key).toBe(false)
      expect(field.kind, field.key).toBe('group')
      expect(field.entry?.length ?? 0, field.key).toBeGreaterThan(0)
    }
  })

  it('no longer hand the author a raw JSON box', () => {
    for (const field of TREE_TRUNK_FIELDS) {
      expect(field.kind, `${field.key} is still unmodelled`).not.toBe('json')
      expect(field.unsourced, field.key).toBeUndefined()
    }
  })

  it('expose each body on its own', () => {
    for (const key of TREE_TRUNK_VARIANTS) {
      expect(trunkVariantFields(key), key).toBeDefined()
    }
    expect(trunkVariantFields('spruce_trunk')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

describe('every spec is well formed', () => {
  it('is looking at a real number of fields, not an empty list', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(60)
  })

  it('carries a key, a kind and a source on every field', () => {
    const kinds = new Set([
      'block',
      'blockList',
      'weightedBlockList',
      'range',
      'enum',
      'boolean',
      'number',
      'integer',
      'molangOrNumber',
      'chance',
      'string',
      'group',
      'groupList',
      'coordinate',
      'json',
    ])
    for (const { path, spec } of ALL) {
      expect(spec.key, path).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(kinds.has(spec.kind), `${path}: unknown kind ${spec.kind}`).toBe(true)
      expect(typeof spec.required, path).toBe('boolean')
      expect(['builder', 'builder-header', 'coverage-note']).toContain(spec.source)
    }
  })

  it('has no duplicate key within any one object', () => {
    const check = (fields: readonly FieldSpec[], where: string): void => {
      const seen = new Set<string>()
      for (const spec of fields) {
        if (spec.key === '') continue
        expect(seen.has(spec.key), `${where}: "${spec.key}" appears twice`).toBe(false)
        seen.add(spec.key)
        if (spec.entry !== undefined) check(spec.entry, where === '' ? spec.key : `${where}.${spec.key}`)
      }
    }
    check(TREE_TRUNK_FIELDS, '')
  })

  it('gives every group and group list an entry set, and nothing else one it cannot use', () => {
    for (const { path, spec } of ALL) {
      if (spec.kind === 'group' || spec.kind === 'groupList' || spec.kind === 'coordinate') {
        expect(spec.entry, `${path} is a ${spec.kind} with no sub-fields`).toBeDefined()
        expect(spec.entry?.length ?? 0, path).toBeGreaterThan(0)
      }
      if (spec.kind === 'enum') {
        expect(spec.values?.length ?? 0, `${path} is an enum with no values`).toBeGreaterThan(0)
      }
      if (spec.kind === 'json') {
        expect(spec.unsourced, `${path} is a JSON box with no reason attached`).toBeDefined()
      }
    }
  })

  it('states a default for every optional key that has one, and none for a required key', () => {
    for (const { path, spec } of ALL) {
      // A required key cannot have an absent-key default -- the file simply does not load.
      if (spec.required) expect(spec.default, `${path} is required but states a default`).toBeUndefined()
      if (spec.min !== undefined && spec.max !== undefined) expect(spec.min, path).toBeLessThanOrEqual(spec.max)
    }
  })

  it('keeps the delegation keys out of the form entirely', () => {
    for (const { path, spec } of ALL) {
      expect(
        DELEGATION_KEYS.has(spec.key),
        `${path} is a delegation key and belongs in the graph as an edge, not in the form`,
      ).toBe(false)
    }
    // And the two that exist are recorded, so their absence is deliberate rather than forgotten.
    expect([...TREE_TRUNK_DELEGATION_PATHS].sort()).toEqual([
      'fallen_trunk.log_decoration_feature',
      'poplar_trunk.log_decoration_feature',
    ])
    for (const path of TREE_TRUNK_DELEGATION_PATHS) {
      expect(BY_PATH.has(path), `${path} was modelled as a field after all`).toBe(false)
      expect(DELEGATION_KEYS.has(path.split('.').slice(-1)[0] as string)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Required keys
// ---------------------------------------------------------------------------

describe('required keys are marked', () => {
  it('requires a trunk block on every single variant', () => {
    for (const key of TREE_TRUNK_VARIANTS) {
      const block = fieldAt(`${key}.trunk_block`)
      expect(block.kind, key).toBe('block')
      expect(block.required, `${key}.trunk_block must be required`).toBe(true)
    }
  })

  it('requires a height on every variant, under the name that variant uses', () => {
    for (const key of TREE_TRUNK_VARIANTS) {
      const heightKey = key === 'fallen_trunk' ? 'log_length' : 'trunk_height'
      expect(fieldAt(`${key}.${heightKey}`).required, `${key}.${heightKey}`).toBe(true)
    }
  })

  it('requires branches on the two shapes that do not load without one', () => {
    expect(fieldAt('cherry_trunk.branches').required).toBe(true)
    expect(fieldAt('fancy_trunk.branches').required).toBe(true)
    // And leaves it optional on the three where it is.
    expect(fieldAt('acacia_trunk.branches').required).toBe(false)
    expect(fieldAt('mega_trunk.branches').required).toBe(false)
    expect(fieldAt('mangrove_trunk.branches').required).toBe(false)
  })

  it('requires the acacia lean, and the diagonal flag inside it', () => {
    expect(fieldAt('acacia_trunk.trunk_lean').required).toBe(true)
    // The flag picks between two different branch routines, so an absent one cannot be defaulted
    // quietly -- the engine refuses the file instead.
    const flag = fieldAt('acacia_trunk.trunk_lean.allow_diagonal_growth')
    expect(flag.kind).toBe('boolean')
    expect(flag.required).toBe(true)
    expect(flag.default).toBeUndefined()
  })

  it('requires a trunk width on exactly the three shapes that build a wide column', () => {
    const widthRequired = TREE_TRUNK_VARIANTS.filter((key) => BY_PATH.get(`${key}.trunk_width`)?.required === true)
    expect([...widthRequired].sort()).toEqual(['acacia_trunk', 'fancy_trunk', 'mega_trunk'])
    for (const key of widthRequired) expect(fieldAt(`${key}.trunk_width`).min, key).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The facts most likely to be got wrong later
// ---------------------------------------------------------------------------

describe('the bare `trunk` key is the SIMPLE trunk', () => {
  it('is a variant in its own right, not a fallback', () => {
    expect(SIMPLE_TRUNK_KEY).toBe('trunk')
    expect(TREE_TRUNK_VARIANTS).toContain('trunk')
  })

  it('takes exactly the five keys of the simple shape', () => {
    expect((trunkVariantFields('trunk') ?? []).map((f) => f.key).sort()).toEqual([
      'can_be_submerged',
      'height_modifier',
      'trunk_block',
      'trunk_decoration',
      'trunk_height',
    ])
  })

  it('has no trunk_width, no trunk_lean and no branches -- the keys that would make it the acacia shape', () => {
    for (const absent of ['trunk_width', 'trunk_lean', 'branches']) {
      expect(BY_PATH.has(`trunk.${absent}`), `trunk.${absent} must not exist`).toBe(false)
    }
  })

  it('is the only shape that takes can_be_submerged, and that key is an option rather than a selector', () => {
    const withSubmerged = TREE_TRUNK_VARIANTS.filter((key) => BY_PATH.has(`${key}.can_be_submerged`))
    expect(withSubmerged).toEqual(['trunk'])
    const submerged = fieldAt('trunk.can_be_submerged')
    expect(submerged.required).toBe(false)
    expect(submerged.default).toMatch(/origin/)
    expect(fieldAt('trunk.can_be_submerged.max_depth').required).toBe(true)
  })

  it('takes a range-typed height, where the acacia and mega shapes take an object', () => {
    expect(fieldAt('trunk.trunk_height').kind).toBe('range')
    expect(fieldAt('poplar_trunk.trunk_height').kind).toBe('range')
    for (const key of ['acacia_trunk', 'mega_trunk', 'cherry_trunk', 'fancy_trunk', 'mangrove_trunk']) {
      expect(fieldAt(`${key}.trunk_height`).kind, key).toBe('group')
    }
  })
})

describe('range-typed keys, and the one object that is not a range', () => {
  it('marks every field the engine reads as range_min / range_max with kind range', () => {
    const expected = [
      'acacia_trunk.branches.branch_length',
      'acacia_trunk.branches.branch_position',
      'acacia_trunk.trunk_lean.lean_height',
      'acacia_trunk.trunk_lean.lean_length',
      'acacia_trunk.trunk_lean.lean_steps',
      'cherry_trunk.branches.branch_end_offset_from_top',
      'cherry_trunk.branches.branch_horizontal_length',
      'cherry_trunk.branches.branch_start_offset_from_top',
      'fallen_trunk.height_modifier',
      'fallen_trunk.log_length',
      'fallen_trunk.stump_height',
      'mangrove_trunk.branches.branch_length',
      'mangrove_trunk.branches.branch_steps',
      'mega_trunk.branches.branch_interval',
      'poplar_trunk.amount_of_foliage_support_branches',
      'poplar_trunk.remaining_trunk_height_above_branches',
      'poplar_trunk.trunk_height',
      'trunk.height_modifier',
      'trunk.trunk_height',
    ]
    const actual = ALL.filter(({ spec }) => spec.kind === 'range')
      .map(({ path }) => path)
      // The decoration sequence's `count` is a range too, and it repeats once per variant; it is
      // checked separately below rather than listed six times here.
      .filter((path) => !path.endsWith('.decoration_blocks_sequence.count'))
      .sort()
    expect(actual).toEqual(expected)
  })

  it('keeps branch_altitude_factor as a plain min/max object, because that one really is spelled that way', () => {
    const factor = fieldAt('mega_trunk.branches.branch_altitude_factor')
    expect(factor.kind).toBe('group')
    expect(factor.required).toBe(true)
    expect((factor.entry ?? []).map((f) => f.key)).toEqual(['min', 'max'])
    for (const sub of factor.entry ?? []) {
      expect(sub.kind, sub.key).toBe('number')
      expect(sub.required, sub.key).toBe(true)
    }
    // And nothing else in a trunk body carries a bare `min` or `max` key, which is what makes this
    // one safe to name as the exception.
    const others = ALL.filter(
      ({ path, spec }) =>
        (spec.key === 'min' || spec.key === 'max') && !path.startsWith('mega_trunk.branches.branch_altitude_factor'),
    )
    expect(others.map((f) => f.path)).toEqual([])
  })
})

describe('the surprising defaults', () => {
  it('defaults a fallen trunk to a one-block stump, not to none', () => {
    expect(fieldAt('fallen_trunk.stump_height').default).toMatch(/\{1, 1\}/)
  })

  it('defaults a decoration chance to nothing placed at all', () => {
    for (const key of TREE_TRUNK_VARIANTS) {
      const chance = BY_PATH.get(`${key}.trunk_decoration.decoration_chance`)
      if (chance === undefined) continue
      expect(chance.required, key).toBe(false)
      expect(chance.default, `${key}: a decoration with no chance must say it decorates nothing`).toMatch(/nothing/)
    }
  })

  it('defaults step_direction to down rather than outward', () => {
    const step = fieldAt('trunk.trunk_decoration.step_direction')
    expect(step.kind).toBe('enum')
    expect(step.values).toEqual(['down', 'up', 'out', 'away'])
    expect(step.default).toBe('down')
  })

  it('defaults the poplar branch ring to four blocks of trunk above it and one to four branches', () => {
    expect(fieldAt('poplar_trunk.remaining_trunk_height_above_branches').default).toMatch(/\{4, 4\}/)
    expect(fieldAt('poplar_trunk.amount_of_foliage_support_branches').default).toMatch(/\{1, 4\}/)
  })

  it('defaults the acacia canopy floor to 3, inside trunk_height rather than trunk_lean', () => {
    const floor = fieldAt('acacia_trunk.trunk_height.min_height_for_canopy')
    expect(floor.required).toBe(false)
    expect(floor.default).toBe('3')
    expect(BY_PATH.has('acacia_trunk.trunk_lean.min_height_for_canopy')).toBe(false)
  })

  it('says outright that an absent branches object does not switch the branch pass off', () => {
    // Both of these shapes run their branch pass regardless and spend its draws; the acacia rolls a
    // chance of zero and the mangrove flips a coin and then grows a zero-length branch. A reader
    // who assumes "absent means disabled" gets the placement after the tree wrong.
    expect(fieldAt('acacia_trunk.branches').default).toMatch(/still runs/)
    expect(fieldAt('mangrove_trunk.branches').default).toMatch(/still runs/)
    // Mega is the one where absence really does mean no branches.
    expect(fieldAt('mega_trunk.branches').default).toMatch(/no branches/)
  })
})

describe('keys the engine accepts and then ignores', () => {
  // Refusing a key the game itself ignores breaks packs for nothing, so all three are modelled as
  // real optional fields whose documentation says they do nothing.
  const INERT = ['mangrove_trunk.trunk_width', 'mangrove_trunk.branches.branch_chance']

  it('accepts them rather than leaving them out', () => {
    for (const path of INERT) {
      expect(BY_PATH.has(path), `${path} should be accepted, not dropped`).toBe(true)
      expect(fieldAt(path).required, path).toBe(false)
    }
    for (const key of TREE_TRUNK_VARIANTS) {
      const steps = BY_PATH.get(`${key}.trunk_decoration.num_steps`)
      if (steps === undefined) continue
      expect(steps.required, key).toBe(false)
    }
  })

  it('says so in the documentation, where an author will see it', () => {
    for (const path of INERT) {
      const entry = TREE_TRUNK_DOCS[path]
      expect(entry, path).toBeDefined()
      expect(`${entry?.summary} ${entry?.detail ?? ''}`, path).toMatch(/changes nothing|no effect/)
    }
  })
})

describe('nested canopies stay out of scope', () => {
  it('leaves branch_canopy as raw JSON with a reason, at exactly the three paths that have one', () => {
    const found = ALL.filter(({ spec }) => spec.key === 'branch_canopy').map(({ path }) => path).sort()
    expect(found).toEqual([...TREE_TRUNK_BRANCH_CANOPY_PATHS].sort())
    for (const path of found) {
      const spec = fieldAt(path)
      expect(spec.kind, path).toBe('json')
      expect(spec.required, path).toBe(false)
      expect(spec.unsourced ?? '', path).toMatch(/canopy/)
    }
  })

  it('is the only raw JSON left in any trunk body', () => {
    const boxes = ALL.filter(({ spec }) => spec.kind === 'json').map(({ path }) => path).sort()
    expect(boxes).toEqual([...TREE_TRUNK_BRANCH_CANOPY_PATHS].sort())
  })
})

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

describe('every field is documented', () => {
  it('has a doc entry for every field path', () => {
    const missing = ALL.filter(({ path }) => TREE_TRUNK_DOCS[path] === undefined).map(({ path }) => path)
    expect(
      missing,
      'the hover catalogue asserts that EVERY field is documented, with exact totals -- a field\n' +
        'arriving without an entry fails that test rather than this one.',
    ).toEqual([])
  })

  it('has no doc entry keyed to something that is not a field', () => {
    const orphans = Object.keys(TREE_TRUNK_DOCS).filter((path) => !BY_PATH.has(path))
    expect(orphans, 'these entries are keyed to a path no trunk variant has').toEqual([])
  })

  it('documents the eight variant keys themselves, replacing the "not catalogued here" entries', () => {
    for (const key of TREE_TRUNK_VARIANTS) {
      const entry = TREE_TRUNK_DOCS[key]
      expect(entry, key).toBeDefined()
      expect(entry?.detail ?? '', key).not.toMatch(/not catalogued here/)
    }
  })

  it('meets the shape the hover catalogue requires of an entry', () => {
    const filler = /^(the|a|an)\s+[a-z_0-9 ]+\s+(field|key|value|parameter|setting|option)\.?$/i
    const entries: [string, { summary: string; detail?: string }][] = [
      ...Object.entries(TREE_TRUNK_DOCS),
      ...Object.entries(TREE_TRUNK_VALUE_DOCS).flatMap(([path, values]) =>
        Object.entries(values).map(([value, entry]): [string, { summary: string; detail?: string }] => [
          `${path} = ${value}`,
          entry,
        ]),
      ),
    ]
    expect(entries.length).toBeGreaterThanOrEqual(80)
    for (const [where, entry] of entries) {
      expect(entry.summary, `${where}: summary must end in a full stop`).toMatch(/\.$/)
      expect(entry.summary.length, `${where}: summary is too short to say anything`).toBeGreaterThanOrEqual(24)
      expect(entry.summary, `${where}: summary is one line`).not.toContain('\n')
      expect(filler.test(entry.summary), `${where}: "${entry.summary}" restates the key name`).toBe(false)
      if (entry.detail !== undefined) {
        expect(entry.detail.length, `${where}: detail is too short to add anything`).toBeGreaterThanOrEqual(40)
        expect(entry.detail, `${where}: detail repeats the summary`).not.toBe(entry.summary)
      }
    }
  })

  it('never repeats a FieldSpec.doc verbatim in the entry beside it', () => {
    for (const { path, spec } of ALL) {
      if (spec.doc === undefined) continue
      const entry = TREE_TRUNK_DOCS[path]
      expect(entry?.summary, path).not.toBe(spec.doc)
      expect(entry?.detail, path).not.toBe(spec.doc)
    }
  })

  it('claims nothing as unestablished, so the hover catalogue\'s pinned list does not move', () => {
    // Every key here was sourced. If a future edit adds one that was not, it has to be pinned in
    // docsCatalog.test.ts by hand -- which is the point of that list, and of this assertion.
    const admitted = Object.entries(TREE_TRUNK_DOCS).filter(([, entry]) => entry.unestablished === true)
    expect(admitted.map(([path]) => path)).toEqual([])
  })
})

describe('every enum value is documented', () => {
  it('covers step_direction at every path that offers it, and nothing else', () => {
    const enums = ALL.filter(({ spec }) => spec.kind === 'enum')
    expect(enums.map(({ path }) => path).sort()).toEqual(Object.keys(TREE_TRUNK_VALUE_DOCS).sort())
    for (const { path, spec } of enums) {
      const table = TREE_TRUNK_VALUE_DOCS[path]
      expect(table, path).toBeDefined()
      for (const value of spec.values ?? []) {
        expect(table?.[value], `${path} = ${value} has no explanation`).toBeDefined()
      }
      expect(Object.keys(table ?? {}).sort()).toEqual([...(spec.values ?? [])].sort())
    }
  })

  it('offers step_direction on exactly the six variants that take a trunk decoration', () => {
    const withDecoration = TREE_TRUNK_VARIANTS.filter((key) => BY_PATH.has(`${key}.trunk_decoration`))
    expect([...withDecoration].sort()).toEqual([
      'acacia_trunk',
      'fallen_trunk',
      'mangrove_trunk',
      'mega_trunk',
      'poplar_trunk',
      'trunk',
    ])
    // The two that do not: a cherry trunk and a fancy trunk take no trunk_decoration.
    expect(BY_PATH.has('cherry_trunk.trunk_decoration')).toBe(false)
    expect(BY_PATH.has('fancy_trunk.trunk_decoration')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The language rule -- the same one docsLanguage.test.ts applies to the shipped catalogue
// ---------------------------------------------------------------------------

describe('strings here state behaviour only', () => {
  const SOURCE_FILE = /\b[A-Za-z_][A-Za-z0-9_]*\.(?:go|ts|cpp|hpp|exe|dll)\b/
  const ADDRESS = /0x[0-9A-Fa-f]{4,}|\b[0-9]{7,}\b/
  const SYMBOL = /[A-Za-z_][A-Za-z0-9_]+(?:<[^<>]*>)?::[~A-Za-z_][A-Za-z0-9_]*/
  // Tooling words that must never appear in user-facing text.
  const BANNED = TOOLING_WORDS

  /** Everything a pack author can end up reading: the doc entries, and the FieldSpec strings that
   * are rendered on the control beside them. */
  function userVisible(): { where: string; text: string }[] {
    const out: { where: string; text: string }[] = []
    for (const [path, entry] of Object.entries(TREE_TRUNK_DOCS)) {
      out.push({ where: `${path} (summary)`, text: entry.summary })
      if (entry.detail !== undefined) out.push({ where: `${path} (detail)`, text: entry.detail })
    }
    for (const [path, values] of Object.entries(TREE_TRUNK_VALUE_DOCS)) {
      for (const [value, entry] of Object.entries(values)) {
        out.push({ where: `${path} = ${value} (summary)`, text: entry.summary })
        if (entry.detail !== undefined) out.push({ where: `${path} = ${value} (detail)`, text: entry.detail })
      }
    }
    for (const { path, spec } of ALL) {
      if (spec.doc !== undefined) out.push({ where: `${path} (spec doc)`, text: spec.doc })
      if (spec.default !== undefined) out.push({ where: `${path} (default)`, text: spec.default })
      if (spec.unsourced !== undefined) out.push({ where: `${path} (unsourced)`, text: spec.unsourced })
    }
    return out
  }

  const STRINGS = userVisible()

  it('is scanning the whole module and not an empty list', () => {
    expect(STRINGS.length).toBeGreaterThanOrEqual(150)
    expect(STRINGS.every((s) => s.text.length > 0)).toBe(true)
  })

  it('cites no source file, address or engine symbol, and uses none of the banned vocabulary', () => {
    const leaks: string[] = []
    for (const { where, text } of STRINGS) {
      if (SOURCE_FILE.test(text)) leaks.push(`${where}: cites a source file`)
      if (ADDRESS.test(text)) leaks.push(`${where}: carries an address-shaped token`)
      if (SYMBOL.test(text)) leaks.push(`${where}: names an engine symbol`)
      for (const word of BANNED) if (text.includes(word)) leaks.push(`${where}: contains ${JSON.stringify(word)}`)
    }
    expect(leaks, 'say what the engine DOES, never how that was established.').toEqual([])
  })
})
