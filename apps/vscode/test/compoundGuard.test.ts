// compoundGuard.test.ts -- the `placement-guard` compound.
//
// The tests are grouped by the property being defended, not by function, and
// each group's comment says what a failure there would mean for an author.

import { describe, expect, it } from 'vitest'

import {
  PLACEMENT_GUARD_CLEANUP_BLOCK,
  PLACEMENT_GUARD_CLEANUP_SUFFIX,
  PLACEMENT_GUARD_DEFAULT_PROBE_BLOCK,
  PLACEMENT_GUARD_EARLY_OUT,
  PLACEMENT_GUARD_PROBE_SUFFIX,
  isPlacementGuardPredicateWrite,
  looksLikePlacementGuardPredicateWrite,
  placementGuardCleanupId,
  placementGuardPredicateIds,
  placementGuardProbeId,
  placementGuardSpec,
} from '../src/graph/compounds/placementGuard'
import { CHILD_ROLES, type PlacementGuardParams } from '../src/graph/compounds/spec'
import type { PlanOperation } from '../src/graph/idioms'

const FV = '1.21.110'

/** The smallest params object that is a real guard: it tests something. */
const MINIMAL: PlacementGuardParams = {
  places: 'wiki:mushroom_cluster',
  mayAttachTo: { bottom: 'minecraft:grass_block' },
}

function ok(params: unknown): PlacementGuardParams {
  const result = placementGuardSpec.validate(params)
  if (!result.ok) throw new Error(`expected valid params, got refusal: ${result.refusal.code} -- ${result.refusal.reason}`)
  return result.params
}

function expand(identifier: string, params: PlacementGuardParams, formatVersion = FV) {
  const result = placementGuardSpec.expand(identifier, params, formatVersion)
  if (!result.ok) throw new Error(`expected an expansion, got refusal: ${result.refusal.code} -- ${result.refusal.reason}`)
  return result.expansion
}

function creates(ops: readonly PlanOperation[]): Extract<PlanOperation, { op: 'createFile' }>[] {
  return ops.filter((o): o is Extract<PlanOperation, { op: 'createFile' }> => o.op === 'createFile')
}

function fileFor(ops: readonly PlanOperation[], identifier: string): Record<string, unknown> {
  const op = creates(ops).find((o) => o.identifier === identifier)
  if (op === undefined) throw new Error(`no createFile for ${identifier}`)
  return JSON.parse(op.contents) as Record<string, unknown>
}

function bodyOf(doc: Record<string, unknown>, typeId: string): Record<string, unknown> {
  const body = doc[typeId]
  if (typeof body !== 'object' || body === null) throw new Error(`document has no ${typeId}`)
  return body as Record<string, unknown>
}

// ---------------------------------------------------------------------------

describe('the spec itself', () => {
  it('declares the kind spec.ts names', () => {
    expect(placementGuardSpec.kind).toBe('placement-guard')
  })

  it('has a title and summary that say what you GET, not how it is built', () => {
    expect(placementGuardSpec.title.length).toBeGreaterThan(0)
    expect(placementGuardSpec.summary.length).toBeGreaterThan(0)
    // spec.ts's own rule for the palette copy: the names were chosen to say
    // what you get. A title naming aggregate/single_block/bedrock would be
    // naming the machinery.
    for (const leak of ['aggregate', 'single_block', 'bedrock', 'first_failure']) {
      expect(placementGuardSpec.title.toLowerCase()).not.toContain(leak)
      expect(placementGuardSpec.summary.toLowerCase()).not.toContain(leak)
    }
  })
})

// ---------------------------------------------------------------------------
// The shape. Getting the child ORDER wrong silently disables the guard, and
// no schema check anywhere can see it.
// ---------------------------------------------------------------------------

describe('the generated subgraph', () => {
  it('is an aggregate with first_failure and exactly probe, cleanup, payload', () => {
    const { operations } = expand('wiki:guarded', MINIMAL)
    const root = bodyOf(fileFor(operations, 'wiki:guarded'), 'minecraft:aggregate_feature')
    expect(root['early_out']).toBe('first_failure')
    expect(root['early_out']).toBe(PLACEMENT_GUARD_EARLY_OUT)
    expect(root['features']).toEqual([
      'wiki:guarded__placement_condition',
      'wiki:guarded__placement_cleanup',
      'wiki:mushroom_cluster',
    ])
  })

  it('puts init FIRST when it is present', () => {
    const { operations } = expand('wiki:guarded', ok({ ...MINIMAL, init: 'wiki:seed_variables' }))
    const root = bodyOf(fileFor(operations, 'wiki:guarded'), 'minecraft:aggregate_feature')
    expect(root['features']).toEqual([
      'wiki:seed_variables',
      'wiki:guarded__placement_condition',
      'wiki:guarded__placement_cleanup',
      'wiki:mushroom_cluster',
    ])
  })

  it('emits NO SLOT AT ALL for an absent init -- not a null, not a placeholder', () => {
    const { operations } = expand('wiki:guarded', MINIMAL)
    const root = bodyOf(fileFor(operations, 'wiki:guarded'), 'minecraft:aggregate_feature')
    const features = root['features'] as unknown[]
    expect(features).toHaveLength(3)
    expect(features).not.toContain(null)
    expect(features).not.toContain('')
    expect(features.every((f) => typeof f === 'string' && f.length > 0)).toBe(true)
    // And nothing anywhere in the bytes mentions an init key.
    const contents = creates(operations).map((o) => o.contents).join('')
    expect(contents).not.toContain('init')
    expect(contents).not.toContain('null')
  })

  it('names the children exactly as spec.ts CHILD_ROLES does', () => {
    const { operations } = expand('wiki:guarded', MINIMAL)
    const ids = creates(operations).map((o) => o.identifier)
    expect(ids).toContain(`wiki:guarded${CHILD_ROLES.guardProbe()}`)
    expect(ids).toContain(`wiki:guarded${CHILD_ROLES.guardCleanup()}`)
    expect(PLACEMENT_GUARD_PROBE_SUFFIX).toBe('__placement_condition')
    expect(PLACEMENT_GUARD_CLEANUP_SUFFIX).toBe('__placement_cleanup')
  })

  it('writes every child as a createFile, each with the format_version it was given', () => {
    const { operations } = expand('wiki:guarded', MINIMAL, '1.21.40')
    expect(operations.every((o) => o.op === 'createFile')).toBe(true)
    for (const op of creates(operations)) {
      const doc = JSON.parse(op.contents) as Record<string, unknown>
      expect(doc['format_version']).toBe('1.21.40')
      expect(op.contents.endsWith('\n')).toBe(true)
      // description.identifier matches the operation's own claim, so a caller
      // can index the new node without re-parsing.
      const body = bodyOf(doc, op.typeId)
      expect((body['description'] as Record<string, unknown>)['identifier']).toBe(op.identifier)
    }
  })

  it('reports every id it creates, in the order it writes them', () => {
    const { operations, creates: created } = expand('wiki:guarded', MINIMAL)
    expect(created).toEqual(creates(operations).map((o) => o.identifier))
    expect(created).toEqual(['wiki:guarded', 'wiki:guarded__placement_condition', 'wiki:guarded__placement_cleanup'])
    // The payload and the init are REFERENCED, never created -- they are the
    // author's own features.
    expect(created).not.toContain('wiki:mushroom_cluster')
  })
})

// ---------------------------------------------------------------------------
// The probe. This is the predicate; everything the author wrote has to reach
// it verbatim or the guard tests something other than what they asked.
// ---------------------------------------------------------------------------

describe('the probe', () => {
  it('places bedrock by default', () => {
    const { operations } = expand('wiki:guarded', MINIMAL)
    const probe = bodyOf(fileFor(operations, 'wiki:guarded__placement_condition'), 'minecraft:single_block_feature')
    expect(probe['places_block']).toBe('minecraft:bedrock')
    expect(probe['places_block']).toBe(PLACEMENT_GUARD_DEFAULT_PROBE_BLOCK)
  })

  it('carries every predicate through under its schema key', () => {
    const params = ok({
      places: 'wiki:payload',
      probeBlock: 'minecraft:barrier',
      mayReplace: ['minecraft:air', { name: 'minecraft:leaves', states: { persistent_bit: false } }],
      mayAttachTo: { bottom: 'minecraft:stone', min_sides_must_attach: 1 },
      mayNotAttachTo: { top: 'minecraft:water' },
    })
    const { operations } = expand('wiki:guarded', params)
    const probe = bodyOf(fileFor(operations, 'wiki:guarded__placement_condition'), 'minecraft:single_block_feature')
    expect(probe['places_block']).toBe('minecraft:barrier')
    expect(probe['may_replace']).toEqual(['minecraft:air', { name: 'minecraft:leaves', states: { persistent_bit: false } }])
    expect(probe['may_attach_to']).toEqual({ bottom: 'minecraft:stone', min_sides_must_attach: 1 })
    expect(probe['may_not_attach_to']).toEqual({ top: 'minecraft:water' })
  })

  it('omits predicate keys the author did not set, rather than writing empty ones', () => {
    const { operations } = expand('wiki:guarded', MINIMAL)
    const probe = bodyOf(fileFor(operations, 'wiki:guarded__placement_condition'), 'minecraft:single_block_feature')
    expect('may_replace' in probe).toBe(false)
    expect('may_not_attach_to' in probe).toBe(false)
    expect('may_attach_to' in probe).toBe(true)
  })

  it('writes the two keys the engine schema REQUIRES on this type', () => {
    // features/single_block.go's parseRequiredBool: omitting either makes a
    // file "the real game would reject". A generated file the game refuses is
    // not worth generating.
    const { operations } = expand('wiki:guarded', MINIMAL)
    for (const id of ['wiki:guarded__placement_condition', 'wiki:guarded__placement_cleanup']) {
      const body = bodyOf(fileFor(operations, id), 'minecraft:single_block_feature')
      expect(body['enforce_placement_rules']).toBe(false)
      expect(body['enforce_survivability_rules']).toBe(false)
    }
  })
})

describe('the cleanup', () => {
  it('is a bare air single_block with NO predicates of its own', () => {
    const { operations } = expand('wiki:guarded', MINIMAL)
    const cleanup = bodyOf(fileFor(operations, 'wiki:guarded__placement_cleanup'), 'minecraft:single_block_feature')
    expect(cleanup['places_block']).toBe('minecraft:air')
    expect(cleanup['places_block']).toBe(PLACEMENT_GUARD_CLEANUP_BLOCK)
    // An empty may_replace is "no constraint" (features/single_block.go's
    // passesAllowList), so the erase cannot fail and strand a probe block.
    expect('may_replace' in cleanup).toBe(false)
    expect('may_attach_to' in cleanup).toBe(false)
    expect('may_not_attach_to' in cleanup).toBe(false)
  })

  it('never inherits the probe block, whatever the author chose', () => {
    const { operations } = expand('wiki:guarded', ok({ ...MINIMAL, probeBlock: { name: 'minecraft:barrier' } }))
    const cleanup = bodyOf(fileFor(operations, 'wiki:guarded__placement_cleanup'), 'minecraft:single_block_feature')
    expect(cleanup['places_block']).toBe('minecraft:air')
  })
})

// ---------------------------------------------------------------------------
// THE EXEMPTION SURFACE. This is the whole reason the module exports more than
// a CompoundSpec: a diagnostics layer that cannot recognise the pair will
// report "places a block that is immediately overwritten" on every open, and
// be wrong every time.
// ---------------------------------------------------------------------------

describe('the diagnostics exemption', () => {
  it('names the probe and cleanup ids a diagnostics layer must exempt', () => {
    expect(placementGuardProbeId('wiki:guarded')).toBe('wiki:guarded__placement_condition')
    expect(placementGuardCleanupId('wiki:guarded')).toBe('wiki:guarded__placement_cleanup')
    expect(placementGuardPredicateIds('wiki:guarded')).toEqual({
      probe: 'wiki:guarded__placement_condition',
      cleanup: 'wiki:guarded__placement_cleanup',
    })
  })

  it('exempts exactly the pair the expansion just wrote, and nothing else', () => {
    const { operations, identifier } = expand('wiki:guarded', MINIMAL)
    const written = creates(operations).map((o) => o.identifier)
    const exempt = written.filter((id) => isPlacementGuardPredicateWrite(id, identifier))
    expect(exempt).toEqual(['wiki:guarded__placement_condition', 'wiki:guarded__placement_cleanup'])
    // The aggregate is not exempt: it places nothing and no such diagnostic
    // applies to it.
    expect(isPlacementGuardPredicateWrite('wiki:guarded', identifier)).toBe(false)
    // Nor is the payload -- the one block write here that IS meant to survive.
    expect(isPlacementGuardPredicateWrite('wiki:mushroom_cluster', identifier)).toBe(false)
  })

  it('does not exempt another guard\'s children', () => {
    // Suffix alone would say yes here. The strong form is keyed on the guard
    // the annotation named, so it says no.
    expect(isPlacementGuardPredicateWrite('wiki:other__placement_condition', 'wiki:guarded')).toBe(false)
    expect(looksLikePlacementGuardPredicateWrite('wiki:other__placement_condition')).toBe(true)
  })

  it('offers the name-only test separately, and it is a hint', () => {
    expect(looksLikePlacementGuardPredicateWrite('wiki:guarded__placement_condition')).toBe(true)
    expect(looksLikePlacementGuardPredicateWrite('wiki:guarded__placement_cleanup')).toBe(true)
    expect(looksLikePlacementGuardPredicateWrite('wiki:guarded')).toBe(false)
    expect(looksLikePlacementGuardPredicateWrite('wiki:guarded__condition_0')).toBe(false)
    // A hand-written feature that happens to end in the suffix reads as a
    // match -- which is exactly why this is documented as suppress-only.
    expect(looksLikePlacementGuardPredicateWrite('wiki:my_own__placement_cleanup')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// What the author is told. The init hazard is the one an editor cannot leave
// unsaid: the guard is inert whenever the init succeeds.
// ---------------------------------------------------------------------------

describe('notes', () => {
  it('always explains that the probe and cleanup are a predicate', () => {
    const { notes } = expand('wiki:guarded', MINIMAL)
    const text = notes.map((n) => n.message).join(' ')
    expect(text).toContain('predicate')
    expect(notes.some((n) => n.message.includes('wiki:guarded__placement_condition'))).toBe(true)
  })

  it('warns that an init in front of the probe defeats first_failure', () => {
    const { notes } = expand('wiki:guarded', ok({ ...MINIMAL, init: 'wiki:seed_variables' }))
    const warning = notes.find((n) => n.level === 'warning' && n.message.includes('wiki:seed_variables'))
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('first_failure')
    // It names the child's own location in idioms.ts's pinned path dialect --
    // which leaves ':' BARE on purpose (jsonc's isBareByte does not list it,
    // because quoting every "minecraft:foo" key would make every path in the
    // editor unreadable). Spelling it `$["minecraft:aggregate_feature"]` here
    // would be the second dialect wire/graph.go warns about.
    expect(warning?.message).toContain('$.minecraft:aggregate_feature.features[2]')
    expect(warning?.message).not.toContain('$["minecraft:aggregate_feature"]')
  })

  it('raises no such warning when there is no init', () => {
    const { notes } = expand('wiki:guarded', MINIMAL)
    expect(notes.some((n) => n.level === 'warning')).toBe(false)
  })

  it('warns when may_not_attach_to is written into a file too old to have the key', () => {
    const params = ok({ ...MINIMAL, mayNotAttachTo: { top: 'minecraft:water' } })
    const old = expand('wiki:guarded', params, '1.21.20')
    const warning = old.notes.find((n) => n.level === 'warning' && n.message.includes('may_not_attach_to'))
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('1.21.40')

    const modern = expand('wiki:guarded', params, '1.21.40')
    expect(modern.notes.some((n) => n.message.includes('may_not_attach_to'))).toBe(false)
  })

  it('mentions the engine\'s min_sides_must_attach default of 4 when sides are named without one', () => {
    const params = ok({ places: 'wiki:payload', mayAttachTo: { sides: 'minecraft:stone' } })
    const { notes } = expand('wiki:guarded', params)
    expect(notes.some((n) => n.message.includes('min_sides_must_attach'))).toBe(true)

    const explicit = expand('wiki:guarded', ok({ places: 'wiki:payload', mayAttachTo: { sides: 'minecraft:stone', min_sides_must_attach: 1 } }))
    expect(explicit.notes.some((n) => n.message.includes('min_sides_must_attach'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validate: rejects without throwing, and accepts both BlockSpec forms.
// ---------------------------------------------------------------------------

describe('validate', () => {
  it('accepts the minimal guard', () => {
    const result = placementGuardSpec.validate(MINIMAL)
    expect(result.ok).toBe(true)
  })

  it('accepts a bare-string block AND the {name, states} form, in both slots', () => {
    expect(placementGuardSpec.validate({ places: 'wiki:p', probeBlock: 'minecraft:barrier', mayReplace: ['minecraft:air'] }).ok).toBe(true)
    expect(
      placementGuardSpec.validate({
        places: 'wiki:p',
        probeBlock: { name: 'minecraft:barrier' },
        mayReplace: [{ name: 'minecraft:leaves', states: { persistent_bit: true } }],
      }).ok,
    ).toBe(true)
  })

  it('drops states that are absent rather than writing an empty object', () => {
    const params = ok({ places: 'wiki:p', probeBlock: { name: 'minecraft:barrier' }, mayAttachTo: { bottom: 'minecraft:stone' } })
    expect(params.probeBlock).toEqual({ name: 'minecraft:barrier' })
    const { operations } = expand('wiki:guarded', params)
    expect(operations[1]?.op === 'createFile' ? operations[1].contents : '').not.toContain('states')
  })

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', []],
    ['no places', { mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['places with no namespace', { places: 'payload', mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['places with two colons', { places: 'a:b:c', mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['places with whitespace', { places: 'wiki:my payload', mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['init that is not an id', { places: 'wiki:p', init: 7, mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['init with no namespace', { places: 'wiki:p', init: 'seed', mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['probeBlock that is a number', { places: 'wiki:p', probeBlock: 3, mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['probeBlock object with no name', { places: 'wiki:p', probeBlock: { states: {} }, mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['probeBlock with non-object states', { places: 'wiki:p', probeBlock: { name: 'minecraft:x', states: 4 }, mayAttachTo: { bottom: 'minecraft:stone' } }],
    ['mayReplace that is not an array', { places: 'wiki:p', mayReplace: 'minecraft:air' }],
    ['mayReplace holding a number', { places: 'wiki:p', mayReplace: [1] }],
    ['mayAttachTo that is an array', { places: 'wiki:p', mayAttachTo: [] }],
    ['mayAttachTo that is empty', { places: 'wiki:p', mayAttachTo: {} }],
    ['mayNotAttachTo that is empty', { places: 'wiki:p', mayNotAttachTo: {} }],
    ['no predicate at all', { places: 'wiki:p' }],
    ['an empty mayReplace and nothing else', { places: 'wiki:p', mayReplace: [] }],
  ])('refuses %s without throwing', (_label: string, params: unknown) => {
    expect(() => placementGuardSpec.validate(params)).not.toThrow()
    const result = placementGuardSpec.validate(params)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.code.length).toBeGreaterThan(0)
      // A refusal's reason is the entire user-visible product of a refusal.
      expect(result.refusal.reason.length).toBeGreaterThan(20)
      expect(result.refusal.reason).toMatch(/[.!]$/)
    }
  })

  it('survives hostile inputs without throwing', () => {
    const hostile: unknown[] = [
      undefined,
      '',
      Symbol('x'),
      () => undefined,
      { places: 'wiki:p', mayAttachTo: { bottom: 'minecraft:stone' }, __proto__: { evil: true } },
      JSON.parse('{"places":"wiki:p","mayAttachTo":{"bottom":"minecraft:stone"},"__proto__":{"evil":true}}'),
      { places: 'wiki:p', mayReplace: [undefined] },
      new Map(),
    ]
    for (const params of hostile) {
      expect(() => placementGuardSpec.validate(params)).not.toThrow()
    }
  })

  it('strips keys it does not know about, so they cannot reach the expansion', () => {
    const params = ok({ places: 'wiki:p', mayAttachTo: { bottom: 'minecraft:stone' }, somethingElse: 'smuggled' })
    expect(Object.keys(params).sort()).toEqual(['mayAttachTo', 'places'])
    const { operations } = expand('wiki:guarded', params)
    expect(creates(operations).map((o) => o.contents).join('')).not.toContain('smuggled')
  })
})

// ---------------------------------------------------------------------------
// expand is PURE and TOTAL.
// ---------------------------------------------------------------------------

describe('expand is pure and total', () => {
  it('gives byte-identical output for the same params, every time', () => {
    const params = ok({
      places: 'wiki:payload',
      init: 'wiki:seed',
      probeBlock: { name: 'minecraft:barrier', states: { a: 1 } },
      mayReplace: ['minecraft:air'],
      mayAttachTo: { bottom: 'minecraft:stone' },
      mayNotAttachTo: { top: 'minecraft:water' },
    })
    const a = expand('wiki:guarded', params)
    const b = expand('wiki:guarded', params)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('does not depend on key order in the params object', () => {
    const a = expand('wiki:guarded', ok({ places: 'wiki:p', mayAttachTo: { bottom: 'minecraft:stone' }, probeBlock: 'minecraft:barrier' }))
    const b = expand('wiki:guarded', ok({ probeBlock: 'minecraft:barrier', mayAttachTo: { bottom: 'minecraft:stone' }, places: 'wiki:p' }))
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('does not mutate the params it was given', () => {
    const params = ok({ places: 'wiki:p', mayReplace: ['minecraft:air'], mayAttachTo: { bottom: 'minecraft:stone' } })
    const before = JSON.stringify(params)
    expand('wiki:guarded', params)
    expect(JSON.stringify(params)).toBe(before)
  })

  it('refuses with ZERO operations rather than returning a partial plan', () => {
    for (const [identifier, formatVersion] of [
      ['guarded', FV],
      ['', FV],
      ['a:b:c', FV],
      ['wiki:has space', FV],
      ['wiki:guarded', ''],
    ] as const) {
      const result = placementGuardSpec.expand(identifier, MINIMAL, formatVersion)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.refusal.reason.length).toBeGreaterThan(20)
        // The contract's own words: "anything it cannot express comes back as
        // a refusal with zero operations rather than a partial plan". There is
        // no operations field on a refusal at all, which is the strongest form
        // of that -- assert the union really is that shape.
        expect('expansion' in result).toBe(false)
      }
    }
  })

  it('never throws, whatever identifier it is handed', () => {
    for (const identifier of ['', ':', 'a:', ':b', 'wiki:guarded', 'wiki:a.b', '::']) {
      expect(() => placementGuardSpec.expand(identifier, MINIMAL, FV)).not.toThrow()
    }
  })

  it('writes each feature to features/<bare id>.json', () => {
    const { operations } = expand('wiki:guarded', MINIMAL)
    expect(creates(operations).map((o) => o.file)).toEqual([
      'features/guarded.json',
      'features/guarded__placement_condition.json',
      'features/guarded__placement_cleanup.json',
    ])
  })

  it('produces files that parse back to exactly the document it claims', () => {
    const { operations } = expand('wiki:guarded', ok({ ...MINIMAL, init: 'wiki:seed' }))
    for (const op of creates(operations)) {
      expect(() => JSON.parse(op.contents)).not.toThrow()
      const doc = JSON.parse(op.contents) as Record<string, unknown>
      expect(Object.keys(doc)).toEqual(['format_version', op.typeId])
    }
  })
})
