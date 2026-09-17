// treeCanopies.test.ts -- the guards on the twelve canopy variant bodies.
//
// Two jobs, and they are different enough to be worth naming separately.
//
// THE FIRST is the contract a consumer relies on. These FieldSpecs are going to be spliced into
// `minecraft:tree_feature` and walked by the form renderer and by the hover catalogue's own
// coverage test, and both of those walks assume things this file checks rather than hopes for:
// every spec well-formed, no key written twice inside one variant, every field carrying an
// explanation, every enum value carrying one too. The docs catalogue's coverage test asserts
// EXACT totals, so a field arriving here without an entry breaks that build rather than this one
// -- which is precisely why it is checked here, where the failure names the field.
//
// THE SECOND is pinning the handful of facts most likely to be quietly "corrected" later by
// somebody reading a neighbouring variant and assuming the two agree. They mostly do not. The
// bare `canopy` key is a real shape and not a default; `canopy_offset` is the one object in this
// group spelled min/max while every range-typed key is spelled range_min/range_max; two variants
// have no `leaf_block` at all; two variants carry a `canopy_decoration` that is a different
// object on each. Each of those has a test that fails loudly if it is flattened.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BRANCH_CANOPY_HOST_KEY,
  BRANCH_CANOPY_HOST_TRUNKS,
  TREE_CANOPY_DOCS,
  TREE_CANOPY_FIELDS,
  TREE_CANOPY_VALUE_DOCS,
  TREE_CANOPY_VARIANT_KEYS,
} from '../src/graph/treeCanopies'
import { DELEGATION_KEYS, type FieldSpec } from '../src/graph/typeCatalog'
import { ABSOLUTE_PATH_PATTERN, EXTRA_BANNED_WORDS, SOURCE_FILE_PATTERN, TOOLING_WORDS, readGoGuard, word } from './fixtures/languageGuard'

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface Walked {
  path: string
  spec: FieldSpec
}

/** Every field, nested ones included, as a dotted path -- the same shape the docs catalogue's own
 * walk produces, so what passes here passes there. */
function walk(fields: readonly FieldSpec[], prefix = ''): Walked[] {
  const out: Walked[] = []
  for (const spec of fields) {
    const path = prefix === '' ? spec.key : `${prefix}.${spec.key}`
    out.push({ path, spec })
    if (spec.entry !== undefined) out.push(...walk(spec.entry, path))
  }
  return out
}

const ALL = walk(TREE_CANOPY_FIELDS)
const VARIANTS = new Map(TREE_CANOPY_FIELDS.map((f) => [f.key, f]))

function entryOf(key: string): readonly FieldSpec[] {
  const spec = VARIANTS.get(key)
  if (spec === undefined) throw new Error(`no canopy variant "${key}"`)
  if (spec.entry === undefined) throw new Error(`canopy variant "${key}" has no body`)
  return spec.entry
}

function keysOf(key: string): string[] {
  return entryOf(key).map((f) => f.key)
}

function subSpec(variant: string, key: string): FieldSpec {
  const found = entryOf(variant).find((f) => f.key === key)
  if (found === undefined) throw new Error(`canopy variant "${variant}" has no key "${key}"`)
  return found
}

// ---------------------------------------------------------------------------
// The shape a consumer relies on
// ---------------------------------------------------------------------------

describe('the walk itself', () => {
  it('is looking at all twelve variants and a real body inside each', () => {
    expect(TREE_CANOPY_FIELDS).toHaveLength(12)
    expect(TREE_CANOPY_FIELDS.map((f) => f.key)).toEqual([...TREE_CANOPY_VARIANT_KEYS])
    for (const variant of TREE_CANOPY_VARIANT_KEYS) {
      expect(entryOf(variant).length, `${variant} has an empty body`).toBeGreaterThan(0)
    }
    // A sweep that quietly stopped finding things would look exactly like a clean run.
    expect(ALL.length).toBeGreaterThanOrEqual(80)
  })
})

describe('every spec is well-formed', () => {
  it('gives every field a non-empty key and a kind the renderer knows', () => {
    const kinds = new Set([
      'block', 'blockList', 'weightedBlockList', 'range', 'enum', 'boolean', 'number', 'integer',
      'molangOrNumber', 'chance', 'string', 'group', 'groupList', 'coordinate', 'json',
    ])
    for (const { path, spec } of ALL) {
      expect(spec.key, `${path}: empty key`).not.toBe('')
      expect(kinds.has(spec.kind), `${path}: unknown kind ${spec.kind}`).toBe(true)
      expect(typeof spec.required, `${path}: required is not a boolean`).toBe('boolean')
      expect(spec.source, `${path}: no source`).toBeDefined()
    }
  })

  it('gives the kinds that need sub-fields exactly those, and the others none', () => {
    for (const { path, spec } of ALL) {
      if (spec.kind === 'group' || spec.kind === 'groupList') {
        expect(spec.entry, `${path}: a ${spec.kind} with no sub-fields is an empty box`).toBeDefined()
        expect(spec.entry?.length, `${path}: empty sub-field list`).toBeGreaterThan(0)
      } else {
        expect(spec.entry, `${path}: kind ${spec.kind} should not carry sub-fields`).toBeUndefined()
      }
    }
  })

  it('gives every enum its values and every json box its reason', () => {
    for (const { path, spec } of ALL) {
      if (spec.kind === 'enum') {
        expect(spec.values?.length, `${path}: an enum with no values`).toBeGreaterThan(0)
      }
      if (spec.kind === 'json') {
        expect(spec.unsourced, `${path}: a raw-JSON box must say why it is one`).toBeDefined()
      }
    }
  })

  it('keeps min below max wherever both are given', () => {
    for (const { path, spec } of ALL) {
      if (spec.min !== undefined && spec.max !== undefined) {
        expect(spec.min, `${path}: min above max`).toBeLessThanOrEqual(spec.max)
      }
    }
  })

  it('never writes one key twice inside a single variant', () => {
    for (const variant of TREE_CANOPY_VARIANT_KEYS) {
      const keys = keysOf(variant)
      expect(new Set(keys).size, `${variant} repeats a key: ${keys.join(', ')}`).toBe(keys.length)
    }
    // And no path repeats anywhere, nested ones included.
    const paths = ALL.map((f) => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('puts every variant in the canopy exclusive group and makes none of them required on its own', () => {
    for (const spec of TREE_CANOPY_FIELDS) {
      expect(spec.exclusiveGroup, `${spec.key}`).toBe('canopy')
      // The GROUP may be required; no single member of it may be, or a form would demand two
      // mutually exclusive keys at once.
      expect(spec.required, `${spec.key}`).toBe(false)
      expect(spec.kind).toBe('group')
    }
  })

  it('marks the keys the feature refuses to load without', () => {
    // Spot-checked against the shape of each variant rather than counted: a required key here is
    // one whose absence stops the tree being built at all.
    expect(subSpec('canopy', 'leaf_block').required).toBe(true)
    expect(subSpec('canopy', 'canopy_offset').required).toBe(true)
    expect(subSpec('canopy', 'min_width').required).toBe(false)
    expect(subSpec('acacia_canopy', 'canopy_size').required).toBe(true)
    expect(subSpec('acacia_canopy', 'simplify_canopy').required).toBe(false)
    expect(subSpec('mega_canopy', 'core_width').required).toBe(true)
    expect(subSpec('mega_canopy', 'base_radius').required).toBe(false)
    expect(subSpec('random_spread_canopy', 'leaf_blocks').required).toBe(true)
    expect(subSpec('poplar_canopy', 'radius').required).toBe(true)
    expect(subSpec('poplar_canopy', 'trunk_width').required).toBe(false)
    // Every variant has at least one required key -- a body that can be left entirely empty would
    // mean the choice of variant carried no information.
    for (const variant of TREE_CANOPY_VARIANT_KEYS) {
      expect(entryOf(variant).some((f) => f.required), `${variant} requires nothing`).toBe(true)
    }
  })

  it('gives an absent-key default to every optional key that has one', () => {
    for (const { path, spec } of ALL) {
      // A required key has no absent-key behaviour to describe, EXCEPT where it is required by
      // this editor and optional in the game -- those carry the explanation in `default`.
      if (spec.required) continue
      // The twelve variant keys themselves are the members of a one-of choice. What leaving them
      // all out means belongs to the group, not to any one member.
      if (spec.exclusiveGroup !== undefined) continue
      expect(spec.default, `${path}: optional with nothing said about leaving it out`).toBeDefined()
    }
  })

  it('carries no delegation key -- no canopy names another feature', () => {
    for (const { path, spec } of ALL) {
      expect(DELEGATION_KEYS.has(spec.key), `${path} is a delegation key and belongs on an edge`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Documentation coverage
// ---------------------------------------------------------------------------

describe('every field is documented', () => {
  it('has an entry for every path, and no entry for a path that does not exist', () => {
    const paths = new Set(ALL.map((f) => f.path))
    const missing = [...paths].filter((p) => TREE_CANOPY_DOCS[p] === undefined).sort()
    expect(
      missing,
      'the hover catalogue asserts EXACT totals, so a field with no entry breaks that build rather\n' +
        'than this one. Write the entry next to the field.',
    ).toEqual([])
    const stray = Object.keys(TREE_CANOPY_DOCS).filter((p) => !paths.has(p)).sort()
    expect(stray, 'an entry for a field nobody offers is prose nobody will ever read').toEqual([])
  })

  it('has an entry for every value of every enum', () => {
    const missing: string[] = []
    for (const { path, spec } of ALL) {
      if (spec.kind !== 'enum') continue
      for (const value of spec.values ?? []) {
        if (TREE_CANOPY_VALUE_DOCS[path]?.[value] === undefined) missing.push(`${path}=${value}`)
      }
    }
    expect(missing).toEqual([])
    // And nothing documented for a value no field offers.
    for (const [path, values] of Object.entries(TREE_CANOPY_VALUE_DOCS)) {
      const spec = ALL.find((f) => f.path === path)?.spec
      expect(spec?.kind, `${path} has value docs but is not an enum`).toBe('enum')
      for (const value of Object.keys(values)) {
        expect(spec?.values, `${path}=${value} is documented but not offered`).toContain(value)
      }
    }
  })

  it('writes sentences rather than filler', () => {
    const entries = [
      ...Object.entries(TREE_CANOPY_DOCS).map(([k, e]) => [k, e] as const),
      ...Object.entries(TREE_CANOPY_VALUE_DOCS).flatMap(([path, values]) =>
        Object.entries(values).map(([value, e]) => [`${path}=${value}`, e] as const),
      ),
    ]
    for (const [location, entry] of entries) {
      expect(entry.summary.length, `${location}: summary too short to say anything`).toBeGreaterThan(24)
      expect(entry.summary.endsWith('.'), `${location}: summary is not a sentence`).toBe(true)
      // "The canopy_size field." is the counter being gamed, not documentation.
      expect(/^The [a-z_]+ field\.$/.test(entry.summary), `${location}: summary is filler`).toBe(false)
      if (entry.detail !== undefined) {
        expect(entry.detail, `${location}: detail repeats the summary`).not.toBe(entry.summary)
        expect(entry.detail.length, `${location}: detail too short to be worth reading`).toBeGreaterThan(40)
      }
    }
  })

  it('never leans on a doc entry to restate a FieldSpec.doc beside it', () => {
    for (const { path, spec } of ALL) {
      if (spec.doc === undefined) continue
      expect(TREE_CANOPY_DOCS[path]?.summary, path).not.toBe(spec.doc)
      expect(TREE_CANOPY_DOCS[path]?.detail, path).not.toBe(spec.doc)
    }
  })

  it('declares nothing unestablished, because nothing here is', () => {
    // Every key below was read where its variant's body is parsed. If that ever stops being true
    // the entry gets `unestablished: true` and this expectation is edited deliberately.
    const guessed = Object.entries(TREE_CANOPY_DOCS)
      .filter(([, entry]) => entry.unestablished === true)
      .map(([path]) => path)
    expect(guessed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The facts most likely to be got wrong later
// ---------------------------------------------------------------------------

describe('the bare `canopy` key', () => {
  it('is a real variant with its own keys, not a default that resolves to another shape', () => {
    const keys = keysOf('canopy')
    expect(keys).toEqual([
      'leaf_block',
      'canopy_offset',
      'min_width',
      'canopy_slope',
      'variation_chance',
      'canopy_decoration',
    ])
    // Nothing it has is shared with the shape it looks most like.
    expect(keys).not.toContain('canopy_height')
    expect(keys).not.toContain('canopy_radius')
    expect(keys).not.toContain('base_radius')
  })

  it('spells canopy_offset min/max, and it is NOT a range', () => {
    const offset = subSpec('canopy', 'canopy_offset')
    expect(offset.kind).toBe('group')
    expect(offset.entry?.map((f) => f.key)).toEqual(['min', 'max'])
    expect(offset.entry?.every((f) => f.required)).toBe(true)
    // If this ever becomes kind 'range' the form starts asking for range_min/range_max, the
    // engine finds neither, and the canopy silently places nothing.
    expect(offset.kind).not.toBe('range')
  })
})

describe('range-typed keys', () => {
  // Every one of these reads range_min/range_max. Given min/max the engine logs an error and
  // substitutes a zero-width range: the file loads in game and the field does nothing.
  const EXPECTED_RANGES = [
    'canopy.canopy_decoration.num_steps',
    'cherry_canopy.height',
    'cherry_canopy.radius',
    'mangrove_canopy.canopy_height',
    'mangrove_canopy.canopy_radius',
    'mangrove_canopy.canopy_decoration.decoration_blocks_sequence.count',
    'mega_canopy.canopy_height',
    'mega_pine_canopy.canopy_height',
    'pine_canopy.canopy_height',
    'poplar_canopy.height',
    'random_spread_canopy.canopy_height',
    'random_spread_canopy.canopy_radius',
    'spruce_canopy.lower_offset',
    'spruce_canopy.max_radius',
    'spruce_canopy.upper_offset',
  ]

  it('are exactly these, and every one of them is kind range', () => {
    const actual = ALL.filter((f) => f.spec.kind === 'range').map((f) => f.path).sort()
    expect(actual).toEqual([...EXPECTED_RANGES].sort())
  })

  it('does not make the keys that merely look like ranges into ranges', () => {
    // Same-sounding, differently typed. roofed_canopy's canopy_height is a plain integer while
    // four other variants spell the same word as a range; fancy_canopy's height and radius are
    // plain integers while cherry_canopy's are ranges.
    expect(subSpec('roofed_canopy', 'canopy_height').kind).toBe('integer')
    expect(subSpec('fancy_canopy', 'height').kind).toBe('integer')
    expect(subSpec('fancy_canopy', 'radius').kind).toBe('integer')
    expect(subSpec('pine_canopy', 'base_radius').kind).toBe('integer')
  })
})

describe('the variants do not share a sub-schema', () => {
  it('gives two variants no leaf_block at all', () => {
    const without = TREE_CANOPY_VARIANT_KEYS.filter((k) => !keysOf(k).includes('leaf_block'))
    expect(without.sort()).toEqual(['mangrove_canopy', 'random_spread_canopy'])
    // Those two take a weighted list instead, and it is not optional.
    for (const variant of without) {
      expect(subSpec(variant, 'leaf_blocks').kind).toBe('weightedBlockList')
      expect(subSpec(variant, 'leaf_blocks').required).toBe(true)
    }
  })

  it('gives the two canopy_decoration objects genuinely different bodies', () => {
    const plain = subSpec('canopy', 'canopy_decoration')
    const mangrove = subSpec('mangrove_canopy', 'canopy_decoration')
    const plainKeys = plain.entry?.map((f) => f.key) ?? []
    const mangroveKeys = mangrove.entry?.map((f) => f.key) ?? []
    expect(plainKeys).not.toEqual(mangroveKeys)
    // The generic canopy's own decoration takes a single block and only grows downward.
    expect(plainKeys).toEqual(['decoration_block', 'decoration_chance', 'num_steps', 'step_direction'])
    expect(plain.entry?.find((f) => f.key === 'step_direction')?.values).toEqual(['down'])
    expect(plain.entry?.find((f) => f.key === 'num_steps')?.kind).toBe('range')
    // The mangrove one takes a sequence and four directions, and its num_steps does nothing.
    expect(mangroveKeys).toContain('decoration_blocks_sequence')
    expect(mangrove.entry?.find((f) => f.key === 'step_direction')?.values).toEqual(['down', 'up', 'out', 'away'])
    expect(mangrove.entry?.find((f) => f.key === 'num_steps')?.kind).toBe('integer')
  })

  it('keeps core_width on exactly the three trunk-sized shapes', () => {
    const withCore = TREE_CANOPY_VARIANT_KEYS.filter((k) => keysOf(k).includes('core_width')).sort()
    expect(withCore).toEqual(['mega_canopy', 'mega_pine_canopy', 'roofed_canopy'])
    for (const variant of withCore) expect(subSpec(variant, 'core_width').required).toBe(true)
  })

  it('keeps simplify_canopy off mega_pine_canopy, which has no such key', () => {
    expect(keysOf('acacia_canopy')).toContain('simplify_canopy')
    expect(keysOf('mega_canopy')).toContain('simplify_canopy')
    expect(keysOf('mega_pine_canopy')).not.toContain('simplify_canopy')
  })
})

describe('the defaults that are the opposite of the obvious guess', () => {
  it('defaults both base_radius keys to 2 and the pine step modifier to 3.5', () => {
    expect(subSpec('mega_canopy', 'base_radius').default).toBe('2')
    expect(subSpec('mega_pine_canopy', 'base_radius').default).toBe('2')
    expect(subSpec('mega_pine_canopy', 'radius_step_modifier').default).toBe('3.5')
  })

  it('makes pine_canopy.base_radius required even though the mega shapes default theirs', () => {
    expect(subSpec('pine_canopy', 'base_radius').required).toBe(true)
    expect(subSpec('mega_canopy', 'base_radius').required).toBe(false)
  })

  it('asks for the four keys the game treats as optional but gives no established fallback', () => {
    const asked = [
      ['fancy_canopy', 'radius'],
      ['spruce_canopy', 'upper_offset'],
      ['roofed_canopy', 'outer_radius'],
      ['roofed_canopy', 'inner_radius'],
    ] as const
    for (const [variant, key] of asked) {
      const spec = subSpec(variant, key)
      expect(spec.required, `${variant}.${key}`).toBe(true)
      // Required, but the reason is not "the game refuses the file" -- so it has to say so.
      expect(spec.default, `${variant}.${key} must explain why it is asked for`).toMatch(/optional/)
    }
  })

  it('lets outer_radius go to -1, which means skip the floor and the roof', () => {
    expect(subSpec('roofed_canopy', 'outer_radius').min).toBe(-1)
    expect(subSpec('roofed_canopy', 'inner_radius').min).toBe(0)
    expect(subSpec('roofed_canopy', 'canopy_height').min).toBe(0)
  })

  it('keeps cherry_canopy pinned to a one-block trunk and its two ranges off the floor', () => {
    const width = subSpec('cherry_canopy', 'trunk_width')
    expect([width.min, width.max]).toEqual([1, 1])
    expect(subSpec('cherry_canopy', 'height').min).toBe(4)
    expect(subSpec('cherry_canopy', 'radius').min).toBe(3)
  })

  it('records the two keys that are accepted and then have no effect', () => {
    for (const spec of [
      subSpec('poplar_canopy', 'trunk_width'),
      subSpec('mangrove_canopy', 'canopy_decoration').entry?.find((f) => f.key === 'num_steps') as FieldSpec,
    ]) {
      expect(spec.required).toBe(false)
    }
    expect(TREE_CANOPY_DOCS['mangrove_canopy.canopy_decoration.num_steps']?.summary).toMatch(/no effect/)
  })

  it('says out loud that poplar spends its side-hole roll even at the default of 0', () => {
    const spec = subSpec('poplar_canopy', 'side_hole_chance')
    expect(spec.required).toBe(false)
    expect(spec.default).toMatch(/^0 /)
    expect(TREE_CANOPY_DOCS['poplar_canopy.side_hole_chance']?.detail).toMatch(/roll happens/)
  })
})

describe('variation_chance stays a raw-JSON box, and says why', () => {
  it('is the only one, and its reason names all three spellings it accepts', () => {
    const boxes = ALL.filter((f) => f.spec.kind === 'json').map((f) => f.path)
    expect(boxes).toEqual(['canopy.variation_chance'])
    const reason = subSpec('canopy', 'variation_chance').unsourced ?? ''
    expect(reason).toMatch(/numerator/)
    expect(reason).toMatch(/array/)
    expect(reason).toMatch(/per canopy layer/)
  })
})

describe('poplar_canopy is the new one', () => {
  it('is flagged as new to a game build without claiming a format_version gate', () => {
    const spec = VARIANTS.get('poplar_canopy')
    expect(spec?.introducedInBuild).toMatch(/1\.26\.50\.24/)
    expect(spec?.since, 'a gate nobody has established must not be asserted').toBeUndefined()
    // And it is the only one carrying that flag.
    expect(TREE_CANOPY_FIELDS.filter((f) => f.introducedInBuild !== undefined).map((f) => f.key)).toEqual(['poplar_canopy'])
  })

  it('takes its radius as a weighted list of whole numbers, not a range', () => {
    const radius = subSpec('poplar_canopy', 'radius')
    expect(radius.kind).toBe('groupList')
    expect(radius.entry?.map((f) => f.key)).toEqual(['value', 'weight'])
    expect(radius.entry?.find((f) => f.key === 'value')?.required).toBe(true)
    expect(radius.entry?.find((f) => f.key === 'weight')?.default).toBe('1')
  })
})

describe('branch_canopy', () => {
  it('is a host for this same twelve-way choice, not a thirteenth variant', () => {
    expect(TREE_CANOPY_VARIANT_KEYS).not.toContain(BRANCH_CANOPY_HOST_KEY)
    expect(BRANCH_CANOPY_HOST_KEY).toBe('branch_canopy')
    // It sits under a trunk's `branches`, on the three trunks that grow branches.
    expect([...BRANCH_CANOPY_HOST_TRUNKS].sort()).toEqual(['acacia_trunk', 'cherry_trunk', 'mega_trunk'])
    for (const trunk of BRANCH_CANOPY_HOST_TRUNKS) expect(trunk.endsWith('_trunk')).toBe(true)
  })

  it('is not a feature reference, so it is not an edge in the graph', () => {
    expect(DELEGATION_KEYS.has(BRANCH_CANOPY_HOST_KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The language rule
// ---------------------------------------------------------------------------
//
// Every string above is rendered into a hover card a pack author reads, so the same rule
// docsLanguage.test.ts applies to the rest of the catalogue applies here: a hover states what the
// game DOES and says nothing about internal tooling. Once these entries are folded into the
// catalogue that guard covers them automatically. Until then it cannot see them, so the same check
// runs here, against the same vocabulary, read from the same place rather than copied.

describe('entries state behaviour only', () => {
  // Tooling words that must never appear in user-facing text, and the Go guard's patterns -- read
  // from features/userfacing_strings_test.go via fixtures/languageGuard.ts.
  const goGuard = readGoGuard()
  const bannedWords = goGuard.words
  const addressPattern = goGuard.address
  const symbolPattern = goGuard.qualifiedName
  // Additions specific to this surface, mirroring the ones docsLanguage.test.ts carries.
  const extraBanned = EXTRA_BANNED_WORDS
  const sourceFilePattern = SOURCE_FILE_PATTERN
  const absolutePathPattern = ABSOLUTE_PATH_PATTERN

  const scanned: { location: string; text: string }[] = []
  for (const [path, entry] of Object.entries(TREE_CANOPY_DOCS)) {
    scanned.push({ location: `${path} (summary)`, text: entry.summary })
    if (entry.detail !== undefined) scanned.push({ location: `${path} (detail)`, text: entry.detail })
  }
  for (const [path, values] of Object.entries(TREE_CANOPY_VALUE_DOCS)) {
    for (const [value, entry] of Object.entries(values)) {
      scanned.push({ location: `${path}=${value} (summary)`, text: entry.summary })
      if (entry.detail !== undefined) scanned.push({ location: `${path}=${value} (detail)`, text: entry.detail })
    }
  }

  it('read a real vocabulary, and is scanning a real list', () => {
    expect(bannedWords).toContain(TOOLING_WORDS[0])
    expect(bannedWords).toContain(word('v', 'table'))
    expect(symbolPattern.source).toContain('::')
    expect(scanned.length).toBeGreaterThanOrEqual(150)
    expect(scanned.every((s) => s.text.length > 0)).toBe(true)
  })

  it('uses none of the banned vocabulary and carries no address, symbol, file name or path', () => {
    const leaks: string[] = []
    for (const { location, text } of scanned) {
      for (const word of [...bannedWords, ...extraBanned]) {
        if (text.includes(word)) leaks.push(`${location}: contains ${JSON.stringify(word)}`)
      }
      const address = addressPattern.exec(text)
      if (address !== null) leaks.push(`${location}: address-shaped token ${JSON.stringify(address[0])}`)
      const symbol = symbolPattern.exec(text)
      if (symbol !== null) leaks.push(`${location}: names the symbol ${JSON.stringify(symbol[0])}`)
      const file = sourceFilePattern.exec(text)
      if (file !== null) leaks.push(`${location}: cites the source file ${JSON.stringify(file[0])}`)
      const leaked = absolutePathPattern.exec(text)
      if (leaked !== null) leaks.push(`${location}: contains the path ${JSON.stringify(leaked[0])}`)
    }
    expect(
      leaks,
      'a hover card must say what the engine DOES, never how that was established. Rewrite the\n' +
        'sentence in terms of the behaviour an author can see.',
    ).toEqual([])
  })

  it('also keeps the FieldSpec strings clean, which the catalogue guard does not reach', () => {
    // `default` and `unsourced` are rendered into the same hover, and nothing else scans them.
    const leaks: string[] = []
    for (const { path, spec } of ALL) {
      const texts: readonly (readonly [string, string | undefined])[] = [
        ['default', spec.default],
        ['unsourced', spec.unsourced],
        ['doc', spec.doc],
        ['introducedInBuild', spec.introducedInBuild],
      ]
      for (const [what, text] of texts) {
        if (text === undefined) continue
        for (const word of [...bannedWords, ...extraBanned]) {
          if (text.includes(word)) leaks.push(`${path}.${what}: contains ${JSON.stringify(word)}`)
        }
        if (sourceFilePattern.test(text)) leaks.push(`${path}.${what}: cites a source file`)
        if (symbolPattern.test(text)) leaks.push(`${path}.${what}: names a symbol`)
        if (absolutePathPattern.test(text)) leaks.push(`${path}.${what}: contains a path`)
      }
    }
    expect(leaks).toEqual([])
  })
})
