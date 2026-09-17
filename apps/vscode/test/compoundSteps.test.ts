// compoundSteps.test.ts -- the `steps` compound.
//
// What is worth asserting here is narrow and specific. The generated JSON is not interesting as
// JSON; it is interesting because four separate files have to agree on ONE name that appears
// nowhere in the schema (the temp counter), because the child ids may already be in a pack and
// a rename orphans references to them, and because two of the three things this compound exists
// to avoid (`sequence_feature`'s re-targeting and its hard-wired first_failure) are invisible in
// the output -- what proves they are avoided is the SHAPE: aggregate_feature rather than
// sequence_feature, and an outer loop that keeps iterating after a step declines.
//
// So: the counter spelling and its three appearances, the child names, the seed-before-setup
// order, the axis the increment lands in, the early_out, the format_version gate, and totality.
import { describe, expect, it } from 'vitest'

import { CHILD_ROLES, compoundVariable } from '../src/graph/compounds/spec.js'
import { stepsCompound } from '../src/graph/compounds/steps.js'
import { FEATURE_SCHEMA_FLOOR } from '../src/graph/typeCatalog.js'

const FV = '1.21.110'
const LEGACY_FV = '1.21.0'

interface CreateFileOp {
  op: 'createFile'
  file: string
  contents: string
  identifier: string
  typeId: string
}

function expandOk(identifier: string, params: unknown, formatVersion = FV) {
  const validated = stepsCompound.validate(params)
  if (!validated.ok) throw new Error(`validate refused: ${validated.refusal.reason}`)
  const result = stepsCompound.expand(identifier, validated.params, formatVersion)
  if (!result.ok) throw new Error(`expand refused: ${result.refusal.reason}`)
  return result.expansion
}

function files(expansion: { operations: readonly unknown[] }): CreateFileOp[] {
  return expansion.operations as CreateFileOp[]
}

function bodyOf(op: CreateFileOp): { root: Record<string, unknown>; body: Record<string, unknown> } {
  const root = JSON.parse(op.contents) as Record<string, unknown>
  return { root, body: root[op.typeId] as Record<string, unknown> }
}

/** The distribution parameters, wherever this format_version puts them. */
function distOf(op: CreateFileOp): Record<string, unknown> {
  const { body } = bodyOf(op)
  const nested = body['distribution']
  return (nested === undefined ? body : nested) as Record<string, unknown>
}

describe('stepsCompound: the spec surface', () => {
  it('is the steps compound and says what you get rather than how', () => {
    expect(stepsCompound.kind).toBe('steps')
    expect(stepsCompound.title.length).toBeGreaterThan(0)
    expect(stepsCompound.summary).toMatch(/same position/i)
    // The summary is the sentence under the title; it must not be a schema tour.
    expect(stepsCompound.summary).not.toMatch(/scatter|aggregate|molang/i)
  })
})

describe('stepsCompound.validate', () => {
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a string', 'ns:a'],
    ['an array', ['ns:a']],
    ['an object with no steps', {}],
    ['steps that is not a list', { steps: 'ns:a' }],
    ['steps holding a non-string', { steps: ['ns:a', 3] }],
    ['steps holding a blank', { steps: ['ns:a', '   '] }],
    ['an unqualified step', { steps: ['tree'] }],
    ['a step with no namespace half', { steps: [':tree'] }],
    ['a non-string setup', { steps: ['ns:a'], setup: 3 }],
  ]

  for (const [name, params] of rejected) {
    it(`refuses ${name} without throwing`, () => {
      const result = stepsCompound.validate(params)
      expect(result.ok).toBe(false)
      if (result.ok) return
      // A refusal's reason is the whole user-visible product; it is never a code name.
      expect(result.refusal.reason.length).toBeGreaterThan(20)
      expect(result.refusal.reason).not.toMatch(/^[a-z-]+$/)
    })
  }

  it('refuses an empty steps list, because the aggregate it would generate does not load', () => {
    const result = stepsCompound.validate({ steps: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('empty-selection')
    expect(result.refusal.reason).toMatch(/at least one/i)
  })

  it('accepts a minimal node and drops keys that are not parameters', () => {
    const result = stepsCompound.validate({ steps: ['ns:a'], nonsense: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.params).toEqual({ steps: ['ns:a'] })
    expect(Object.keys(result.params)).toEqual(['steps'])
  })

  it('keeps a setup script verbatim', () => {
    const result = stepsCompound.validate({ steps: ['ns:a'], setup: 'v.h = 3;' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.params.setup).toBe('v.h = 3;')
  })

  it('does not alias the caller\'s array', () => {
    const steps = ['ns:a', 'ns:b']
    const result = stepsCompound.validate({ steps })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    steps.push('ns:c')
    expect(result.params.steps).toEqual(['ns:a', 'ns:b'])
  })
})

describe('stepsCompound.expand: the files it writes', () => {
  const params = { steps: ['ns:trunk', 'ns:canopy', 'ns:vines'] }

  it('writes the root, the aggregate, then one scatter per step, in that order', () => {
    const expansion = expandOk('ns:big_tree', params)
    expect(files(expansion).map((op) => op.identifier)).toEqual([
      'ns:big_tree',
      'ns:big_tree__aggregate',
      'ns:big_tree__item_0',
      'ns:big_tree__item_1',
      'ns:big_tree__item_2',
    ])
    expect(expansion.creates).toEqual(files(expansion).map((op) => op.identifier))
    expect(expansion.kind).toBe('steps')
    expect(expansion.identifier).toBe('ns:big_tree')
  })

  it('names children exactly as CHILD_ROLES does, because a pack may already hold those ids', () => {
    const expansion = expandOk('ns:big_tree', params)
    const ids = files(expansion).map((op) => op.identifier)
    expect(ids[1]).toBe(`ns:big_tree${CHILD_ROLES.stepsAggregate()}`)
    expect(ids[2]).toBe(`ns:big_tree${CHILD_ROLES.stepsItem(0)}`)
    expect(ids[4]).toBe(`ns:big_tree${CHILD_ROLES.stepsItem(2)}`)
  })

  it('is every operation a createFile, each in its own file', () => {
    const expansion = expandOk('ns:big_tree', params)
    expect(files(expansion).every((op) => op.op === 'createFile')).toBe(true)
    const paths = files(expansion).map((op) => op.file)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths[0]).toBe('features/big_tree.json')
    expect(paths[2]).toBe('features/big_tree__item_0.json')
  })

  it('carries the format_version it was given into every file, and declares the right type', () => {
    const expansion = expandOk('ns:big_tree', params, '1.21.90')
    for (const op of files(expansion)) {
      const { root, body } = bodyOf(op)
      expect(root['format_version']).toBe('1.21.90')
      expect(Object.keys(root)).toEqual(['format_version', op.typeId])
      expect(body['description']).toEqual({ identifier: op.identifier })
    }
    expect(files(expansion).map((op) => op.typeId)).toEqual([
      'minecraft:scatter_feature',
      'minecraft:aggregate_feature',
      'minecraft:scatter_feature',
      'minecraft:scatter_feature',
      'minecraft:scatter_feature',
    ])
  })

  it('ends every generated file in a newline', () => {
    for (const op of files(expandOk('ns:big_tree', params))) {
      expect(op.contents.endsWith('\n')).toBe(true)
      expect(JSON.parse(op.contents)).toBeTypeOf('object')
    }
  })
})

describe('stepsCompound.expand: the counter', () => {
  it('uses spec.ts\'s own temp spelling, and the same one in all four places', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b'] })
    const counter = compoundVariable('ns:big_tree')
    expect(counter).toBe('t.big_tree__sequence')

    const [root, , item0, item1] = files(expansion)
    const rootDist = distOf(root as CreateFileOp)
    expect(rootDist['iterations']).toContain(counter)
    expect(rootDist['x']).toContain(counter)
    expect(distOf(item0 as CreateFileOp)['iterations']).toBe(`${counter} == 0`)
    expect(distOf(item1 as CreateFileOp)['iterations']).toBe(`${counter} == 1`)
  })

  it('is a temp, never a variable -- the lifetime is one evaluation', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a'] })
    for (const op of files(expansion)) {
      expect(op.contents).not.toMatch(/\bv\.[A-Za-z_]*sequence/)
      expect(op.contents).not.toMatch(/variable\.[A-Za-z_]*sequence/)
    }
  })

  it('replaces the dot in a dotted identifier, because `t.a.b__sequence` is not one name', () => {
    const expansion = expandOk('ns:oak.big', { steps: ['ns:a'] })
    const counter = compoundVariable('ns:oak.big')
    expect(counter).toBe('t.oak_big__sequence')
    expect(distOf(files(expansion)[0] as CreateFileOp)['iterations']).toContain(counter)
  })
})

describe('stepsCompound.expand: the root scatter', () => {
  const counter = 't.big_tree__sequence'

  it('seeds the counter BEFORE the author\'s setup, and returns the step count', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b', 'ns:c'], setup: 'v.h = 3;' })
    expect(distOf(files(expansion)[0] as CreateFileOp)['iterations']).toBe(`${counter} = -1; v.h = 3;return 3;`)
  })

  it('the seed really does come first, so a setup script can read it', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a'], setup: 'v.seen = t.big_tree__sequence;' })
    const iterations = String(distOf(files(expansion)[0] as CreateFileOp)['iterations'])
    expect(iterations.indexOf(`${counter} = -1`)).toBeLessThan(iterations.indexOf('v.seen'))
  })

  it('omits the setup entirely when there is none', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b'] })
    expect(distOf(files(expansion)[0] as CreateFileOp)['iterations']).toBe(`${counter} = -1; return 2;`)
  })

  it('advances the counter in x -- the first axis evaluated under the default xzy -- and offsets nothing', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b'] })
    const dist = distOf(files(expansion)[0] as CreateFileOp)
    expect(dist['x']).toBe(`${counter} = ${counter} + 1; return 0;`)
    expect(dist['y']).toBe(0)
    expect(dist['z']).toBe(0)
    // x has to be written first in the object too: the bookkeeping and the axis are one decision.
    expect(Object.keys(dist)).toEqual(['iterations', 'x', 'y', 'z'])
  })

  it('does not emit coordinate_eval_order, because x is already first under the default', () => {
    for (const op of files(expandOk('ns:big_tree', { steps: ['ns:a'] }))) {
      expect(op.contents).not.toContain('coordinate_eval_order')
    }
  })

  it('delegates to the aggregate, not to the first step', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b'] })
    const { body } = bodyOf(files(expansion)[0] as CreateFileOp)
    expect(body['places_feature']).toBe('ns:big_tree__aggregate')
  })
})

describe('stepsCompound.expand: the aggregate', () => {
  it('is an aggregate_feature and never a sequence_feature', () => {
    // The entire justification for this compound. sequence_feature re-targets each child at the
    // previous child's result and hard-wires first_failure with no schema key to change it
    // (features/aggregate.go); aggregate_feature does neither.
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b'] })
    for (const op of files(expansion)) {
      expect(op.contents).not.toContain('sequence_feature')
      expect(op.contents).not.toContain('first_failure')
    }
    expect((files(expansion)[1] as CreateFileOp).typeId).toBe('minecraft:aggregate_feature')
  })

  it('early-outs on first_success, and lists every step scatter in order', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b', 'ns:c'] })
    const { body } = bodyOf(files(expansion)[1] as CreateFileOp)
    expect(body['early_out']).toBe('first_success')
    expect(body['features']).toEqual(['ns:big_tree__item_0', 'ns:big_tree__item_1', 'ns:big_tree__item_2'])
  })
})

describe('stepsCompound.expand: the step scatters', () => {
  it('guards on the counter and places the author\'s feature', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:trunk', 'ns:canopy'] })
    const [, , item0, item1] = files(expansion)
    expect(bodyOf(item0 as CreateFileOp).body['places_feature']).toBe('ns:trunk')
    expect(bodyOf(item1 as CreateFileOp).body['places_feature']).toBe('ns:canopy')
    expect(distOf(item0 as CreateFileOp)).toEqual({ iterations: 't.big_tree__sequence == 0' })
  })

  it('lets the same feature appear twice -- a step list is not a set', () => {
    const expansion = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:a'] })
    const [, , item0, item1] = files(expansion)
    expect(bodyOf(item0 as CreateFileOp).body['places_feature']).toBe('ns:a')
    expect(bodyOf(item1 as CreateFileOp).body['places_feature']).toBe('ns:a')
    expect(distOf(item0 as CreateFileOp)['iterations']).toBe('t.big_tree__sequence == 0')
    expect(distOf(item1 as CreateFileOp)['iterations']).toBe('t.big_tree__sequence == 1')
  })

  it('handles a single step without degenerating', () => {
    const expansion = expandOk('ns:one', { steps: ['ns:a'] })
    expect(expansion.creates).toEqual(['ns:one', 'ns:one__aggregate', 'ns:one__item_0'])
    expect(distOf(files(expansion)[0] as CreateFileOp)['iterations']).toBe('t.one__sequence = -1; return 1;')
  })
})

describe('stepsCompound.expand: the format_version gate', () => {
  it('writes the nested distribution object at 1.21.10 and above', () => {
    for (const version of ['1.21.10', '1.21.110', '1.22.0']) {
      const { body } = bodyOf(files(expandOk('ns:big_tree', { steps: ['ns:a'] }, version))[0] as CreateFileOp)
      expect(Object.keys(body)).toEqual(['description', 'places_feature', 'distribution'])
      expect((body['distribution'] as Record<string, unknown>)['iterations']).toBeTypeOf('string')
    }
  })

  it('writes flat keys below 1.21.10, where the nested object is not in the schema', () => {
    const { body } = bodyOf(files(expandOk('ns:big_tree', { steps: ['ns:a'] }, LEGACY_FV))[0] as CreateFileOp)
    expect(body['distribution']).toBeUndefined()
    expect(Object.keys(body)).toEqual(['description', 'places_feature', 'iterations', 'x', 'y', 'z'])
  })

  it('applies the same gate to every generated scatter, not only the root', () => {
    const legacy = files(expandOk('ns:big_tree', { steps: ['ns:a'] }, LEGACY_FV))
    expect(bodyOf(legacy[2] as CreateFileOp).body['iterations']).toBe('t.big_tree__sequence == 0')
    const modern = files(expandOk('ns:big_tree', { steps: ['ns:a'] }, FV))
    expect(bodyOf(modern[2] as CreateFileOp).body['iterations']).toBeUndefined()
  })

  it('refuses a format_version it cannot read, or that no schema band matches, with zero operations', () => {
    // '1.12.0' is below FEATURE_SCHEMA_FLOOR: it parses, and a file declaring it still does not
    // load, so writing five of them would be worse than saying no.
    for (const bad of ['', '  ', '1', 'latest', '1.21.x', '1.2.3.4.5', '1.12.0']) {
      const validated = stepsCompound.validate({ steps: ['ns:a'] })
      expect(validated.ok).toBe(true)
      if (!validated.ok) return
      const result = stepsCompound.expand('ns:big_tree', validated.params, bad)
      expect(result.ok, `expected "${bad}" to be refused`).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('no-format-version')
    }
  })

  it('accepts the schema floor itself', () => {
    const { body } = bodyOf(files(expandOk('ns:big_tree', { steps: ['ns:a'] }, FEATURE_SCHEMA_FLOOR))[0] as CreateFileOp)
    expect(body['distribution']).toBeUndefined()
    expect(body['iterations']).toBe('t.big_tree__sequence = -1; return 1;')
  })
})

describe('stepsCompound.expand: pure, total, and never partial', () => {
  it('gives byte-identical operations for the same parameters', () => {
    const params = { steps: ['ns:a', 'ns:b', 'ns:c'], setup: 'v.h = 3;' }
    const first = expandOk('ns:big_tree', params)
    const second = expandOk('ns:big_tree', params)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('does not mutate the parameters it was handed', () => {
    const params = { steps: ['ns:a', 'ns:b'], setup: 'v.h = 3;' }
    const snapshot = JSON.stringify(params)
    expandOk('ns:big_tree', params)
    expect(JSON.stringify(params)).toBe(snapshot)
  })

  it('refuses an identifier that is not namespace:id, with zero operations', () => {
    const validated = stepsCompound.validate({ steps: ['ns:a'] })
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    for (const bad of ['big_tree', '', 'ns:', ':big_tree']) {
      const result = stepsCompound.expand(bad, validated.params, FV)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.refusal.code).toBe('id-malformed')
    }
  })

  it('re-checks its parameters, so a hand-built params object cannot produce a half-plan', () => {
    // expand is reachable with parameters validate never saw (a decoded annotation, say). An
    // empty list must still refuse rather than emit an aggregate the game will not load.
    const result = stepsCompound.expand('ns:big_tree', { steps: [] }, FV)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('empty-selection')
  })

  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [null, undefined, 0, 'x', [], {}, { steps: null }, { steps: [null] }, { steps: ['ns:a'], setup: {} }]
    for (const params of hostile) {
      expect(() => stepsCompound.validate(params)).not.toThrow()
      expect(() => stepsCompound.expand('ns:big_tree', params as never, FV)).not.toThrow()
      expect(() => stepsCompound.expand('ns:big_tree', params as never, '')).not.toThrow()
    }
  })
})

describe('stepsCompound.expand: notes', () => {
  it('says why this is not a sequence_feature, and what the counter is', () => {
    const notes = expandOk('ns:big_tree', { steps: ['ns:a', 'ns:b'] }).notes
    const text = notes.map((n) => n.message).join('\n')
    expect(text).toMatch(/sequence_feature/)
    expect(text).toMatch(/t\.big_tree__sequence/)
    expect(text).toMatch(/coordinate_eval_order/)
    expect(notes.every((n) => n.level === 'info')).toBe(true)
  })

  it('warns when a setup script runs straight into the return', () => {
    const notes = expandOk('ns:big_tree', { steps: ['ns:a'], setup: 'v.h = 3' }).notes
    const warning = notes.find((n) => n.level === 'warning')
    expect(warning).toBeDefined()
    expect(warning?.message).toMatch(/semicolon/)
  })

  it('does not warn when the setup is well formed, or absent', () => {
    expect(expandOk('ns:big_tree', { steps: ['ns:a'], setup: 'v.h = 3; ' }).notes.some((n) => n.level === 'warning')).toBe(false)
    expect(expandOk('ns:big_tree', { steps: ['ns:a'] }).notes.some((n) => n.level === 'warning')).toBe(false)
  })
})
