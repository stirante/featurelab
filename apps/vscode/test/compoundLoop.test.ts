// Tests for the `loop` compound.
//
// What is worth testing here is not "does it emit a scatter_feature" -- a schema check would
// catch that. It is the two things a schema check CANNOT catch:
//
//   1. the per-iteration step script has to land in the axis `coordinate_eval_order` names
//      first, and a file where it landed in the wrong one is valid JSON, valid against the
//      schema, loads, runs, and places things in the wrong order; and
//   2. a count that did not need to be a string must not become one, because that is a diff on
//      every regenerated file and existing packs are already full of the other spelling.
//
// So the eval-order table is exhaustive over all six permutations plus the absent case, and the
// canonical file is asserted as bytes rather than as a parsed object.

import { describe, expect, it } from 'vitest'
import { formatJsonPath } from '../src/graph/idioms'
import { decodeCompoundParams } from '../src/graph/compounds/spec'
import {
  COORDINATE_EVAL_ORDERS,
  DEFAULT_COORDINATE_EVAL_ORDER,
  firstEvaluatedAxis,
  loopCompound,
  type Axis,
} from '../src/graph/compounds/loop'

const VERSION = '1.21.10'

/** The parameters as an untyped object, so a test can feed `validate` something LoopParams would
 * not allow -- which is the whole point of having a validate. */
function expandRaw(identifier: string, params: unknown, formatVersion: string = VERSION) {
  const checked = loopCompound.validate(params)
  if (!checked.ok) return { ok: false as const, refusal: checked.refusal }
  return loopCompound.expand(identifier, checked.params, formatVersion)
}

function contentsOf(result: ReturnType<typeof expandRaw>): string {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  const [op] = result.expansion.operations
  expect(op?.op).toBe('createFile')
  if (op?.op !== 'createFile') throw new Error('unreachable')
  return op.contents
}

function scatterOf(result: ReturnType<typeof expandRaw>): Record<string, any> {
  const parsed = JSON.parse(contentsOf(result).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
  return parsed['minecraft:scatter_feature']
}

/** The distribution, from whichever of the two spellings the file used. */
function distributionOf(result: ReturnType<typeof expandRaw>): Record<string, any> {
  const scatter = scatterOf(result)
  return (scatter['distribution'] ?? scatter) as Record<string, any>
}

describe('loopCompound identity', () => {
  it('is the loop compound and says what you get rather than how', () => {
    expect(loopCompound.kind).toBe('loop')
    expect(loopCompound.title).toBe('Loop')
    expect(loopCompound.summary.length).toBeGreaterThan(0)
    expect(loopCompound.summary).not.toMatch(/scatter_feature/)
  })
})

// ---------------------------------------------------------------------------
// The rule that cannot be schema-checked
// ---------------------------------------------------------------------------

describe('the step script goes into the first EVALUATED axis', () => {
  const cases: { order: string | undefined; axis: Axis }[] = [
    { order: undefined, axis: 'x' },
    { order: 'xyz', axis: 'x' },
    { order: 'xzy', axis: 'x' },
    { order: 'yxz', axis: 'y' },
    { order: 'yzx', axis: 'y' },
    { order: 'zxy', axis: 'z' },
    { order: 'zyx', axis: 'z' },
  ]

  it('covers every order the engine accepts', () => {
    expect(cases.filter((c) => c.order !== undefined).map((c) => c.order)).toEqual([...COORDINATE_EVAL_ORDERS])
  })

  for (const { order, axis } of cases) {
    it(`puts it in "${axis}" for coordinate_eval_order ${order ?? '(absent)'}`, () => {
      const result = expandRaw('wiki:scan', {
        count: 'v.n',
        places: 'wiki:leaf',
        step: 'v.i = v.i + 1;',
        coordinateEvalOrder: order,
        x: 'v.i',
        y: 'v.i',
        z: 'v.i',
      })
      const distribution = distributionOf(result)
      expect(distribution[axis]).toBe('v.i = v.i + 1;return v.i;')
      // And nowhere else: the other two axes are the author's coordinates, untouched.
      for (const other of ['x', 'y', 'z'] as Axis[]) {
        if (other === axis) continue
        expect(distribution[other]).toBe('v.i')
      }
    })
  }

  it('exposes the same rule to a caller that has to move the script when the order changes', () => {
    expect(firstEvaluatedAxis(undefined)).toBe('x')
    for (const order of COORDINATE_EVAL_ORDERS) {
      expect(firstEvaluatedAxis(order)).toBe(order.charAt(0))
    }
  })

  it('names the axis and the path it wrote the script to, so the author can see it moved', () => {
    const result = expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', step: 'v.i = v.i + 1;', coordinateEvalOrder: 'zyx' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const message = result.expansion.notes.map((n) => n.message).join('\n')
    expect(message).toContain(formatJsonPath([{ key: 'minecraft:scatter_feature' }, { key: 'distribution' }, { key: 'z' }]))
    expect(message).toContain('$.minecraft:scatter_feature.distribution.z')
  })

  it('returns 0 from the step axis when that axis has no coordinate of its own', () => {
    const result = expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', step: 'v.i = v.i + 1;' })
    expect(distributionOf(result)['x']).toBe('v.i = v.i + 1;return 0;')
    expect(distributionOf(result)['y']).toBeUndefined()
    expect(distributionOf(result)['z']).toBeUndefined()
  })
})

describe('the coordinate_eval_order default', () => {
  it('is the SCHEMA default, and is left to the engine rather than written out', () => {
    // features/distribution.go's ParseEvalOrder: an absent key is "xzy", the game's default,
    // pinned behaviourally by features/scatter_semantics_test.go. Hand-written templates often
    // assume "xyz" instead.
    expect(DEFAULT_COORDINATE_EVAL_ORDER).toBe('xzy')
    const result = expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', step: 'v.i = 1;' })
    expect(distributionOf(result)['coordinate_eval_order']).toBeUndefined()
    expect(contentsOf(result)).not.toContain('coordinate_eval_order')
    // Both defaults name x first, so the disagreement is invisible HERE -- which is exactly why
    // the note has to say it out loud instead of a placement test catching it.
    if (!result.ok) throw new Error('unreachable')
    expect(result.expansion.notes.map((n) => n.message).join('\n')).toContain('"xzy"')
  })

  it('writes the order out when the author chose one', () => {
    const result = expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', coordinateEvalOrder: 'yzx' })
    expect(distributionOf(result)['coordinate_eval_order']).toBe('yzx')
  })
})

// ---------------------------------------------------------------------------
// iterations: the count, and the setup script
// ---------------------------------------------------------------------------

describe('iterations', () => {
  it('emits a bare count as a NUMBER, unwrapped, when there is no setup script', () => {
    const distribution = distributionOf(expandRaw('wiki:scan', { count: '5', places: 'wiki:leaf' }))
    expect(distribution['iterations']).toBe(5)
    expect(distribution['iterations']).not.toBe('5')
    expect(distribution['iterations']).not.toBe('return 5;')
  })

  it('passes a non-numeric count through exactly as written', () => {
    const distribution = distributionOf(expandRaw('wiki:scan', { count: 'math.random(1, 4)', places: 'wiki:leaf' }))
    expect(distribution['iterations']).toBe('math.random(1, 4)')
  })

  it('leaves a count that is already a setup script alone', () => {
    const source = "v.scan = 5; return v.scan * v.scan;"
    expect(distributionOf(expandRaw('wiki:scan', { count: source, places: 'wiki:leaf' }))['iterations']).toBe(source)
  })

  it('concatenates a setup script in front of the return with NOTHING between', () => {
    const distribution = distributionOf(expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', setup: 'v.i = -1; ' }))
    expect(distribution['iterations']).toBe('v.i = -1; return 4;')
  })

  it('does not insert a separator between the setup script and the count', () => {
    const distribution = distributionOf(expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', setup: 'v.i = -1;' }))
    expect(distribution['iterations']).toBe('v.i = -1;return 4;')
  })

  it('treats a blank setup script as none', () => {
    const distribution = distributionOf(expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', setup: '   ' }))
    expect(distribution['iterations']).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// The axes, as given
// ---------------------------------------------------------------------------

describe('the coordinates', () => {
  it('writes an axis nobody gave and no script needs not at all', () => {
    const distribution = distributionOf(expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf' }))
    expect(Object.keys(distribution)).toEqual(['iterations'])
  })

  it('writes a bare coordinate as a number and an expression as a string', () => {
    const distribution = distributionOf(expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', x: '0', y: 'v.i', z: '-2' }))
    expect(distribution['x']).toBe(0)
    expect(distribution['y']).toBe('v.i')
    expect(distribution['z']).toBe(-2)
  })

  it('writes the distribution keys in the loader\'s own registration order', () => {
    const distribution = distributionOf(
      expandRaw('wiki:scan', { count: '4', places: 'wiki:leaf', z: '1', y: '1', x: '1', scatterChance: 50, coordinateEvalOrder: 'xyz' }),
    )
    expect(Object.keys(distribution)).toEqual(['iterations', 'scatter_chance', 'coordinate_eval_order', 'x', 'y', 'z'])
  })
})

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

describe('the generated file', () => {
  it('is this, byte for byte', () => {
    const result = expandRaw('wiki:loop', { count: '5', places: 'wiki:leaf' })
    expect(contentsOf(result)).toBe(
      [
        '{',
        '  "format_version": "1.21.10",',
        '  "minecraft:scatter_feature": {',
        '    "description": {',
        '      "identifier": "wiki:loop"',
        '    },',
        '    "places_feature": "wiki:leaf",',
        '    "distribution": {',
        '      "iterations": 5',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('reports one createFile under features/, naming what it defines', () => {
    const result = expandRaw('wiki:loop', { count: '5', places: 'wiki:leaf' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.expansion.kind).toBe('loop')
    expect(result.expansion.identifier).toBe('wiki:loop')
    expect(result.expansion.creates).toEqual(['wiki:loop'])
    expect(result.expansion.operations).toHaveLength(1)
    const [op] = result.expansion.operations
    if (op?.op !== 'createFile') throw new Error('expected a createFile')
    expect(op.file).toBe('features/loop.json')
    expect(op.identifier).toBe('wiki:loop')
    expect(op.typeId).toBe('minecraft:scatter_feature')
    expect(op.contents.endsWith('\n')).toBe(true)
  })

  it('does not write the compound directive -- one writer owns provenance', () => {
    // This module used to splice the directive in itself, directly after the opening brace,
    // and two things were wrong with that.
    //
    // The position: a directive attaches to the member that FOLLOWS it, so above
    // `format_version` it described the version string. The reader refused it as not-at-root
    // and the compound silently would not collapse -- with nothing failing, because a file
    // with no usable annotation is indistinguishable from a hand-written one.
    //
    // And the ownership: one compound of the five did this, so four wrote subgraphs that could
    // never be collapsed again. Provenance is one rule, so compounds/annotate.ts owns it, and
    // it is called by whoever writes the files -- the only caller that can also tell whether a
    // file already carries a directive. Two of the same name on one path is a state the reader
    // has no answer for, and two writers is how that gets made.
    const result = expandRaw('wiki:loop', { count: '4', places: 'wiki:leaf' })
    expect(contentsOf(result)).not.toContain('@featurelab:')
  })
  it('places the body keys that sit outside the version gate outside the distribution', () => {
    const scatter = scatterOf(expandRaw('wiki:loop', { count: '4', places: 'wiki:leaf', projectInputToFloor: true }))
    expect(Object.keys(scatter)).toEqual(['description', 'places_feature', 'project_input_to_floor', 'distribution'])
    expect(scatter['project_input_to_floor']).toBe(true)
  })
})

describe('the format_version decides the scatter shape', () => {
  it('nests the parameters at and above 1.21.10', () => {
    for (const version of ['1.21.10', '1.21.40', '1.26.50']) {
      const scatter = scatterOf(expandRaw('wiki:loop', { count: '4', places: 'wiki:leaf' }, version))
      expect(scatter['distribution']).toEqual({ iterations: 4 })
      expect(scatter['iterations']).toBeUndefined()
    }
  })

  it('writes them flat below 1.21.10, and reports the flat path', () => {
    const result = expandRaw('wiki:loop', { count: '4', places: 'wiki:leaf', setup: 'v.a = 1;' }, '1.13.0')
    const scatter = scatterOf(result)
    expect(scatter['distribution']).toBeUndefined()
    expect(scatter['iterations']).toBe('v.a = 1;return 4;')
    if (!result.ok) throw new Error('unreachable')
    expect(result.expansion.notes.map((n) => n.message).join('\n')).toContain('$.minecraft:scatter_feature.iterations')
  })

  it('echoes the version the caller passed', () => {
    expect(contentsOf(expandRaw('wiki:loop', { count: '4', places: 'wiki:leaf' }, '1.21'))).toContain('"format_version": "1.21"')
  })
})

// ---------------------------------------------------------------------------
// Refusals -- every one of them with zero operations
// ---------------------------------------------------------------------------

describe('validate refuses malformed parameters without throwing', () => {
  const bad: [string, unknown][] = [
    ['not an object', 'loop'],
    ['null', null],
    ['an array', [{ count: '1', places: 'wiki:leaf' }]],
    ['no parameters at all', {}],
    ['no count', { places: 'wiki:leaf' }],
    ['a blank count', { count: '  ', places: 'wiki:leaf' }],
    ['a numeric count', { count: 5, places: 'wiki:leaf' }],
    ['no places', { count: '1' }],
    ['a places with no namespace', { count: '1', places: 'leaf' }],
    ['a places with two colons', { count: '1', places: 'a:b:c' }],
    ['a places with whitespace', { count: '1', places: 'wiki:the leaf' }],
    ['a non-string setup', { count: '1', places: 'wiki:leaf', setup: 4 }],
    ['a blank coordinate', { count: '1', places: 'wiki:leaf', y: '' }],
    ['a seventh eval order', { count: '1', places: 'wiki:leaf', coordinateEvalOrder: 'xxz' }],
    ['an eval order that is not a string', { count: '1', places: 'wiki:leaf', coordinateEvalOrder: 0 }],
    ['a non-numeric scatterChance', { count: '1', places: 'wiki:leaf', scatterChance: '50%' }],
    ['an infinite scatterChance', { count: '1', places: 'wiki:leaf', scatterChance: Number.POSITIVE_INFINITY }],
    ['a non-boolean projectInputToFloor', { count: '1', places: 'wiki:leaf', projectInputToFloor: 'yes' }],
    ['a parameter that does not exist', { count: '1', places: 'wiki:leaf', iterations: '1' }],
  ]

  for (const [what, params] of bad) {
    it(`refuses ${what}`, () => {
      const checked = loopCompound.validate(params)
      expect(checked.ok).toBe(false)
      if (checked.ok) return
      expect(checked.refusal.reason.length).toBeGreaterThan(0)
      // A refusal is a sentence for a person, never a code name with the underscores taken out.
      expect(checked.refusal.reason).not.toBe(checked.refusal.code)
    })
  }

  it('accepts the minimum, and every parameter at once', () => {
    expect(loopCompound.validate({ count: '1', places: 'wiki:leaf' }).ok).toBe(true)
    expect(
      loopCompound.validate({
        count: 'v.n',
        places: 'wiki:leaf',
        setup: 'v.n = 4;',
        step: 'v.i = v.i + 1;',
        x: '0',
        y: 'v.i',
        z: '0',
        coordinateEvalOrder: 'yxz',
        scatterChance: 12.5,
        projectInputToFloor: false,
      }).ok,
    ).toBe(true)
  })

  it('drops a blank setup and step rather than writing an empty script', () => {
    const checked = loopCompound.validate({ count: '1', places: 'wiki:leaf', setup: '', step: '   ' })
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(Object.keys(checked.params)).toEqual(['count', 'places'])
  })
})

describe('expand refuses rather than producing a partial plan', () => {
  const minimal = { count: '4', places: 'wiki:leaf' }

  function expectRefusal(result: ReturnType<typeof expandRaw>, code: string) {
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal.code).toBe(code)
    expect(result.refusal.reason.length).toBeGreaterThan(0)
    // CompoundSpec: "anything it cannot express comes back as a refusal with zero operations
    // rather than a partial plan". There is no operations field on a refusal at all, which is
    // the strongest form of that -- so the check is that the result carries no expansion.
    expect('expansion' in result).toBe(false)
  }

  it('refuses a setup script that does not terminate its last statement', () => {
    expectRefusal(expandRaw('wiki:loop', { ...minimal, setup: 'v.a = 1' }), 'molang-not-composable')
  })

  it('refuses a step script that does not terminate its last statement', () => {
    expectRefusal(expandRaw('wiki:loop', { ...minimal, step: 'v.i = v.i + 1' }), 'molang-not-composable')
  })

  it('refuses to `return` a statement sequence as a count', () => {
    expectRefusal(expandRaw('wiki:loop', { count: 'v.a = 1; 4', places: 'wiki:leaf', setup: 'v.b = 2;' }), 'molang-not-composable')
  })

  it('refuses to `return` a statement sequence as the stepped coordinate', () => {
    expectRefusal(expandRaw('wiki:loop', { ...minimal, step: 'v.i = 1;', x: 'v.a = 2; v.a' }), 'molang-not-composable')
  })

  it('allows a semicolon inside a string, which is not a statement separator', () => {
    const distribution = distributionOf(expandRaw('wiki:loop', { count: "q.has_biome_tag('a;b') ? 4 : 0", places: 'wiki:leaf', setup: 'v.a = 1;' }))
    expect(distribution['iterations']).toBe("v.a = 1;return q.has_biome_tag('a;b') ? 4 : 0;")
  })

  it('refuses a malformed identifier for the compound itself', () => {
    expectRefusal(expandRaw('loop', minimal), 'id-malformed')
    expectRefusal(expandRaw('', minimal), 'id-malformed')
    expectRefusal(expandRaw('wiki:a/b', minimal), 'id-malformed')
  })

  it('refuses a missing or unreadable format_version', () => {
    expectRefusal(expandRaw('wiki:loop', minimal, ''), 'no-format-version')
    expectRefusal(expandRaw('wiki:loop', minimal, '1'), 'no-format-version')
    expectRefusal(expandRaw('wiki:loop', minimal, 'latest'), 'no-format-version')
  })

  it('refuses malformed parameters handed straight to expand, bypassing validate', () => {
    const result = loopCompound.expand('wiki:loop', { count: '4' } as never, VERSION)
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure and total
// ---------------------------------------------------------------------------

describe('expand is pure and total', () => {
  const params = {
    count: 'v.n',
    places: 'wiki:leaf',
    setup: 'v.n = 4;',
    step: 'v.i = v.i + 1;',
    x: 'v.i',
    coordinateEvalOrder: 'xzy',
    scatterChance: 25,
    projectInputToFloor: true,
  }

  it('gives the same operations in the same order for the same parameters', () => {
    const first = expandRaw('wiki:loop', params)
    const second = expandRaw('wiki:loop', params)
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('never throws, whatever it is handed', () => {
    const junk: unknown[] = [undefined, null, 0, '', [], {}, { count: {} }, { places: [] }, new Date(), () => 0]
    for (const value of junk) {
      expect(() => loopCompound.validate(value)).not.toThrow()
      expect(() => loopCompound.expand('wiki:loop', value as never, VERSION)).not.toThrow()
      expect(() => loopCompound.expand('wiki:loop', { count: '1', places: 'wiki:leaf' }, String(value))).not.toThrow()
    }
  })

  it('tells the author when a numeric literal could not keep its spelling', () => {
    const result = expandRaw('wiki:loop', { count: '+5', places: 'wiki:leaf' })
    expect(distributionOf(result)['iterations']).toBe(5)
    if (!result.ok) throw new Error('unreachable')
    expect(result.expansion.notes.some((n) => n.message.includes('+5'))).toBe(true)
  })

  it('says nothing when there is nothing to say', () => {
    const result = expandRaw('wiki:loop', { count: '4', places: 'wiki:leaf', coordinateEvalOrder: 'xzy' })
    if (!result.ok) throw new Error('unreachable')
    expect(result.expansion.notes).toEqual([])
  })
})
