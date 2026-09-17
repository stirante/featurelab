// compoundColumn.test.ts -- the `column` compound, and above all the two facts about it that no
// schema check can see.
//
// The first is DIRECTION. `order` is not a presentational preference: the fixed_grid shape is
// walked by the scatter's own iteration index, which counts DOWN (features/distribution.go's
// `index := iterations - 1 - i`), while the counter shape increments a variable of its own and
// therefore goes up. Two columns differing only in `order` produce different worlds, so the suite
// pins BOTH generated shapes as exact strings rather than asserting that something plausible came
// out, and pins the refusal that stops `levelVariable` quietly promoting a top-down column to the
// other one.
//
// The second is the FORMAT-VERSION SPLIT at 1.21.10, where a scatter's parameters move into a
// nested `distribution` object. Writing the wrong spelling for the declared version is not
// diagnosed usefully -- the engine drops the unknown member and then fails on a missing required
// `iterations` -- so every shape is asserted on both sides of the split, and a version string that
// cannot be read is asserted to REFUSE rather than throw.
//
// Everything else follows spec.ts's own requirements: expand is pure and total, a refusal carries
// no operations at all, and validate never throws on anything.
import { describe, expect, it } from 'vitest'
import { columnCompound, columnVariables, validateColumnParams } from '../src/graph/compounds/column.js'
import { CHILD_ROLES } from '../src/graph/compounds/spec.js'
import type { ColumnParams, CompoundExpansion, CompoundResult } from '../src/graph/compounds/spec.js'
import type { Refusal } from '../src/graph/idioms.js'

const ID = 'wiki:tall'
const PLACES = 'wiki:slab'
const V = columnVariables(ID)

const OLD = '1.21.0'
const NEW = '1.21.10'

function expansionOf(result: CompoundResult): CompoundExpansion {
  if (!result.ok) throw new Error(`expected an expansion, got a refusal: ${result.refusal.reason}`)
  return result.expansion
}

function refusalOf(result: CompoundResult | { ok: true } | { ok: false; refusal: Refusal }): Refusal {
  if (result.ok) throw new Error('expected a refusal, got a success')
  return result.refusal
}

/** The generated file's body, unwrapped -- and asserted to be a scatter_feature on the way. */
function body(expansion: CompoundExpansion, index = 0): Record<string, unknown> {
  const op = expansion.operations[index]
  if (op === undefined || op.op !== 'createFile') throw new Error(`operation ${index} is not a createFile`)
  const parsed = JSON.parse(op.contents) as Record<string, unknown>
  return parsed['minecraft:scatter_feature'] as Record<string, unknown>
}

/** The distribution parameters, from whichever of the two spellings the file used -- so the same
 * assertion can be made on both sides of the 1.21.10 split. Below it the parameters are flat keys
 * sitting beside `description` and `places_feature`, so those two are dropped here. */
function parameters(expansion: CompoundExpansion, index = 0): Record<string, unknown> {
  const scatter = body(expansion, index)
  const nested = scatter['distribution']
  if (typeof nested === 'object' && nested !== null) return nested as Record<string, unknown>
  const { description: _description, places_feature: _places, ...flat } = scatter
  return flat
}

function expand(params: ColumnParams, version = OLD, identifier = ID): CompoundResult {
  return columnCompound.expand(identifier, params, version)
}

// ---------------------------------------------------------------------------

describe('the spec surface', () => {
  it('declares the kind spec.ts names, and a summary that says what you get', () => {
    expect(columnCompound.kind).toBe('column')
    expect(columnCompound.title.length).toBeGreaterThan(0)
    expect(columnCompound.summary).toMatch(/level|height/i)
  })

  it('names its variables off the identifier, with the namespace stripped and dots flattened', () => {
    expect(columnVariables('wiki:tall')).toEqual({
      min: 'v.tall__min',
      max: 'v.tall__max',
      iterations: 'v.tall__iterations',
      level: 'v.tall__item',
    })
    // The `.` in an identifier would otherwise read as a namespace separator inside the variable.
    expect(columnVariables('wiki:a.b').min).toBe('v.a_b__min')
  })
})

// ---------------------------------------------------------------------------

describe('top-down -- the fixed_grid shape', () => {
  const base: ColumnParams = { places: PLACES, maxY: '12' }

  it('writes ONE scatter when minY is absent', () => {
    const e = expansionOf(expand(base))
    expect(e.kind).toBe('column')
    expect(e.identifier).toBe(ID)
    expect(e.creates).toEqual([ID])
    expect(e.operations).toHaveLength(1)
    const op = e.operations[0]!
    expect(op).toMatchObject({ op: 'createFile', file: 'features/tall.json', identifier: ID, typeId: 'minecraft:scatter_feature' })
  })

  it('builds the bounds, the count and the grid exactly', () => {
    const e = expansionOf(expand(base))
    expect(parameters(e)).toEqual({
      iterations: 'v.tall__min = 0; v.tall__max = 12; v.tall__iterations = v.tall__max - v.tall__min; return v.tall__iterations;',
      x: 0,
      y: { distribution: 'fixed_grid', extent: [0, 'v.tall__iterations - 1'] },
      z: 0,
    })
    expect(body(e)['places_feature']).toBe(PLACES)
  })

  it('concatenates the setup script in front, terminating it when the author did not', () => {
    const withSemicolon = parameters(expansionOf(expand({ ...base, setup: 'v.seed = 3;' })))['iterations']
    expect(withSemicolon).toBe(
      'v.seed = 3; v.tall__min = 0; v.tall__max = 12; v.tall__iterations = v.tall__max - v.tall__min; return v.tall__iterations;',
    )
    // Without the added `;` the two statements would fuse into one expression that does not parse,
    // and the author's only symptom would be a feature that stopped loading.
    const without = parameters(expansionOf(expand({ ...base, setup: '  v.seed = 3  ' })))['iterations']
    expect(without).toBe(withSemicolon)
  })

  it('carries the half-open range and the unconfirmed step_size default as notes', () => {
    const notes = expansionOf(expand(base)).notes
    expect(notes.some((n) => /half-open/i.test(n.message) && /NOT including/.test(n.message))).toBe(true)
    expect(notes.some((n) => /step_size/.test(n.message) && n.level === 'warning')).toBe(true)
    expect(notes.some((n) => /TOP down/.test(n.message))).toBe(true)
  })

  it('writes flat parameters below 1.21.10 and a nested distribution at or above it', () => {
    expect(Object.keys(body(expansionOf(expand(base, OLD))))).toEqual([
      'description',
      'places_feature',
      'iterations',
      'x',
      'y',
      'z',
    ])
    expect(Object.keys(body(expansionOf(expand(base, NEW))))).toEqual(['description', 'places_feature', 'distribution'])
    expect(Object.keys(body(expansionOf(expand(base, '1.26.50'))))).toEqual(['description', 'places_feature', 'distribution'])
    // The nested object holds exactly what the flat keys held.
    expect(parameters(expansionOf(expand(base, NEW)))).toEqual(parameters(expansionOf(expand(base, OLD))))
  })

  it('writes a complete, re-parseable file with description.identifier first and a trailing newline', () => {
    const op = expansionOf(expand(base)).operations[0]!
    if (op.op !== 'createFile') throw new Error('expected a createFile')
    expect(op.contents.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(op.contents) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['format_version', 'minecraft:scatter_feature'])
    expect(parsed['format_version']).toBe(OLD)
    expect(body(expansionOf(expand(base)))['description']).toEqual({ identifier: ID })
  })
})

// ---------------------------------------------------------------------------

describe('top-down -- when minY is a literal zero', () => {
  for (const literal of ['0', '+0', '-0', '0.0', '0.', ' 0 ']) {
    it(`stays a single scatter for minY ${JSON.stringify(literal)}`, () => {
      const e = expansionOf(expand({ places: PLACES, maxY: '12', minY: literal }))
      expect(e.operations).toHaveLength(1)
      expect(parameters(e)['iterations']).toBe(
        `v.tall__min = ${literal.trim()}; v.tall__max = 12; v.tall__iterations = v.tall__max - v.tall__min; return v.tall__iterations;`,
      )
    })
  }
})

describe('top-down -- when minY is anything else', () => {
  // Every one of these is a value that is NOT a bare zero literal. The last two do evaluate to
  // zero, and still take the offset shape: assuming a non-literal is zero is silently wrong, and
  // the outer/inner split is correct even when the expression really is zero.
  for (const expression of ['4', 'v.base', '(0)', 'q.x - q.x', '0e0']) {
    it(`splits into an outer and an inner scatter for minY ${JSON.stringify(expression)}`, () => {
      const e = expansionOf(expand({ places: PLACES, maxY: '12', minY: expression }))
      const childId = `${ID}${CHILD_ROLES.columnInner()}`
      expect(childId).toBe('wiki:tall__column')
      expect(e.creates).toEqual([ID, childId])
      expect(e.operations).toHaveLength(2)
      expect(e.operations[1]).toMatchObject({ op: 'createFile', file: 'features/tall__column.json', identifier: childId })

      // The outer scatter sets up, offsets ONCE, and runs the inner one exactly once.
      expect(body(e, 0)['places_feature']).toBe(childId)
      expect(parameters(e, 0)).toEqual({
        iterations: `v.tall__min = ${expression}; v.tall__max = 12; v.tall__iterations = v.tall__max - v.tall__min; return 1;`,
        x: 0,
        y: 'v.tall__min',
        z: 0,
      })
      // The inner one does the grid, and does no setup of its own.
      expect(body(e, 1)['places_feature']).toBe(PLACES)
      expect(parameters(e, 1)).toEqual({
        iterations: 'return v.tall__iterations;',
        x: 0,
        y: { distribution: 'fixed_grid', extent: [0, 'v.tall__iterations - 1'] },
        z: 0,
      })
    })
  }

  it('gives both files the same format_version and the same flat/nested spelling', () => {
    const e = expansionOf(expand({ places: PLACES, maxY: '12', minY: 'v.base' }, NEW))
    for (const index of [0, 1]) {
      const op = e.operations[index]!
      if (op.op !== 'createFile') throw new Error('expected a createFile')
      expect(JSON.parse(op.contents)['format_version']).toBe(NEW)
      expect(Object.keys(body(e, index))).toEqual(['description', 'places_feature', 'distribution'])
    }
  })

  it('explains the split in a note rather than leaving the extra file unexplained', () => {
    const notes = expansionOf(expand({ places: PLACES, maxY: '12', minY: 'v.base' })).notes
    expect(notes.some((n) => /not a bare zero/.test(n.message) && /wiki:tall__column/.test(n.message))).toBe(true)
  })

  it('refuses when the feature it places is the id the inner scatter would claim', () => {
    const r = refusalOf(expand({ places: 'wiki:tall__column', maxY: '12', minY: 'v.base' }))
    expect(r.code).toBe('id-exists')
    expect(r.reason).toContain('wiki:tall__column')
  })
})

// ---------------------------------------------------------------------------

describe('bottom-up -- the counter shape', () => {
  const base: ColumnParams = { places: PLACES, maxY: '12', order: 'bottom-up' }

  it('seeds the counter at -1, increments it in the first evaluated axis, and reads it in y', () => {
    const e = expansionOf(expand(base))
    expect(e.creates).toEqual([ID])
    expect(e.operations).toHaveLength(1)
    expect(parameters(e)).toEqual({
      iterations:
        'v.tall__item = -1; v.tall__min = 0; v.tall__max = 12; v.tall__iterations = v.tall__max - v.tall__min; return v.tall__iterations;',
      x: 'v.tall__item = v.tall__item + 1; return 0;',
      y: 'v.tall__min + v.tall__item',
      z: 0,
    })
    expect(body(e)['places_feature']).toBe(PLACES)
  })

  it('does not split on a non-zero minY -- the counter shape adds min in y itself', () => {
    const e = expansionOf(expand({ ...base, minY: 'v.base' }))
    expect(e.operations).toHaveLength(1)
    expect(parameters(e)['iterations']).toContain('v.tall__min = v.base;')
    expect(parameters(e)['y']).toBe('v.tall__min + v.tall__item')
  })

  it('puts the setup in front of the counter seed and the step in front of the increment', () => {
    const e = expansionOf(expand({ ...base, setup: 'v.seed = 3', step: 'v.hits = v.hits + 1' }))
    expect(parameters(e)['iterations']).toBe(
      'v.seed = 3; v.tall__item = -1; v.tall__min = 0; v.tall__max = 12; v.tall__iterations = v.tall__max - v.tall__min; return v.tall__iterations;',
    )
    expect(parameters(e)['x']).toBe('v.hits = v.hits + 1; v.tall__item = v.tall__item + 1; return 0;')
  })

  it('never carries the fixed_grid step_size caveat, because it writes no grid', () => {
    const notes = expansionOf(expand(base)).notes
    expect(notes.some((n) => /step_size/.test(n.message))).toBe(false)
    expect(notes.some((n) => /half-open/i.test(n.message))).toBe(true)
    expect(notes.some((n) => /coordinate_eval_order/.test(n.message))).toBe(true)
  })

  it('gates on the format_version the same way', () => {
    expect(Object.keys(body(expansionOf(expand(base, NEW))))).toEqual(['description', 'places_feature', 'distribution'])
    expect(parameters(expansionOf(expand(base, NEW)))).toEqual(parameters(expansionOf(expand(base, OLD))))
  })

  describe('levelVariable', () => {
    it('takes a bare name into variable.*, which is what the placed feature can read', () => {
      const p = parameters(expansionOf(expand({ ...base, levelVariable: 'level' })))
      expect(p['iterations']).toContain('v.level = -1;')
      expect(p['x']).toBe('v.level = v.level + 1; return 0;')
      expect(p['y']).toBe('v.tall__min + v.level')
    })

    for (const name of ['v.level', 'variable.level', 'V.level']) {
      it(`honours an explicit ${JSON.stringify(name)} as typed`, () => {
        const p = parameters(expansionOf(expand({ ...base, levelVariable: name })))
        expect(p['y']).toBe(`v.tall__min + ${name}`)
      })
    }

    it('allows a temp, and says that it is scoped to one evaluation', () => {
      const e = expansionOf(expand({ ...base, levelVariable: 't.level' }))
      expect(parameters(e)['y']).toBe('v.tall__min + t.level')
      expect(e.notes.some((n) => n.level === 'warning' && /temp/.test(n.message))).toBe(true)
    })

    for (const name of ['q.level', 'query.level', 'math.level', '1level', 'v.a.b', 'has space']) {
      it(`refuses ${JSON.stringify(name)}, which the column could not assign`, () => {
        expect(refusalOf(expand({ ...base, levelVariable: name })).code).toBe('molang-invalid')
      })
    }
  })
})

// ---------------------------------------------------------------------------

describe('the two cross-field refusals', () => {
  it('refuses a levelVariable under the default order rather than switching shape', () => {
    const r = refusalOf(expand({ places: PLACES, maxY: '12', levelVariable: 'level' }))
    expect(r.code).toBe('order-sensitive')
    expect(r.reason).toContain('bottom-up')
    // The whole point: it must say that flipping the order would change the world, not just that
    // the field is unsupported.
    expect(r.reason).toMatch(/overlapping cell|RNG/)
  })

  it('refuses a levelVariable under an EXPLICIT top-down too', () => {
    expect(refusalOf(expand({ places: PLACES, maxY: '12', order: 'top-down', levelVariable: 'level' })).code).toBe('order-sensitive')
  })

  it('refuses a step script under top-down', () => {
    const r = refusalOf(expand({ places: PLACES, maxY: '12', step: 'v.hits = v.hits + 1;' }))
    expect(r.code).toBe('order-sensitive')
    expect(r.reason).toContain('bottom-up')
  })

  it('accepts both under bottom-up', () => {
    expect(expand({ places: PLACES, maxY: '12', order: 'bottom-up', levelVariable: 'level', step: 'v.hits = 1;' }).ok).toBe(true)
  })

  it('reports them through validate as well, so a form can refuse before expanding', () => {
    expect(refusalOf(validateColumnParams({ places: PLACES, maxY: '12', levelVariable: 'level' })).code).toBe('order-sensitive')
    expect(refusalOf(validateColumnParams({ places: PLACES, maxY: '12', step: 'v.a = 1;' })).code).toBe('order-sensitive')
  })
})

// ---------------------------------------------------------------------------

describe('validate rejects malformed parameters without throwing', () => {
  const cases: readonly { readonly what: string; readonly value: unknown; readonly code: string }[] = [
    { what: 'null', value: null, code: 'molang-invalid' },
    { what: 'a string', value: 'column', code: 'molang-invalid' },
    { what: 'an array', value: [], code: 'molang-invalid' },
    { what: 'an empty object', value: {}, code: 'id-malformed' },
    { what: 'no places', value: { maxY: '12' }, code: 'id-malformed' },
    { what: 'a places with no namespace', value: { places: 'slab', maxY: '12' }, code: 'id-malformed' },
    { what: 'a places with two colons', value: { places: 'a:b:c', maxY: '12' }, code: 'id-malformed' },
    { what: 'a numeric places', value: { places: 3, maxY: '12' }, code: 'id-malformed' },
    { what: 'no maxY', value: { places: PLACES }, code: 'molang-invalid' },
    { what: 'a numeric maxY', value: { places: PLACES, maxY: 12 }, code: 'molang-invalid' },
    { what: 'an empty maxY', value: { places: PLACES, maxY: '   ' }, code: 'molang-invalid' },
    { what: 'a numeric minY', value: { places: PLACES, maxY: '12', minY: 0 }, code: 'molang-invalid' },
    { what: 'a numeric setup', value: { places: PLACES, maxY: '12', setup: 1 }, code: 'molang-invalid' },
    { what: 'an unknown order', value: { places: PLACES, maxY: '12', order: 'upwards' }, code: 'molang-invalid' },
    { what: 'a numeric levelVariable', value: { places: PLACES, maxY: '12', order: 'bottom-up', levelVariable: 1 }, code: 'molang-invalid' },
    { what: 'an empty levelVariable', value: { places: PLACES, maxY: '12', order: 'bottom-up', levelVariable: ' ' }, code: 'molang-invalid' },
  ]
  for (const c of cases) {
    it(`refuses ${c.what}`, () => {
      const result = validateColumnParams(c.value)
      expect(result.ok).toBe(false)
      expect(refusalOf(result).code).toBe(c.code)
      // A refusal's reason is the entire user-visible product of a refusal.
      expect(refusalOf(result).reason.length).toBeGreaterThan(20)
    })
  }

  it('accepts a minimal column and normalises the optional fields it drops', () => {
    const result = validateColumnParams({ places: ` ${PLACES} `, maxY: '12', minY: '  ', setup: '' })
    if (!result.ok) throw new Error(result.refusal.reason)
    expect(result.params).toEqual({ places: PLACES, maxY: '12' })
  })

  it('survives every exotic value without throwing', () => {
    for (const value of [undefined, 0, false, Symbol.iterator, () => 1, new Date(), { places: {}, maxY: [] }]) {
      expect(() => validateColumnParams(value)).not.toThrow()
      expect(validateColumnParams(value).ok).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------

describe('expand is total', () => {
  it('refuses a malformed format_version instead of throwing', () => {
    for (const version of ['banana', '1', '1.2.3.4.5', '1.x.0']) {
      const r = refusalOf(expand({ places: PLACES, maxY: '12' }, version))
      expect(r.code).toBe('no-format-version')
    }
  })

  it('refuses an absent format_version, which a generated file cannot be written without', () => {
    expect(refusalOf(expand({ places: PLACES, maxY: '12' }, '')).code).toBe('no-format-version')
    expect(refusalOf(expand({ places: PLACES, maxY: '12' }, '   ')).code).toBe('no-format-version')
  })

  it('refuses a malformed identifier of its own', () => {
    for (const identifier of ['', 'tall', 'wiki:', ':tall', 'a:b:c', 'wiki:t all']) {
      expect(refusalOf(expand({ places: PLACES, maxY: '12' }, OLD, identifier)).code).toBe('id-malformed')
    }
  })

  it('refuses a column that places itself', () => {
    expect(refusalOf(expand({ places: ID, maxY: '12' })).code).toBe('cycle')
  })

  it('re-validates the parameters, because a decoded annotation reaches it as anything', () => {
    const junk = { maxY: 12 } as unknown as ColumnParams
    const result = expand(junk)
    expect(result.ok).toBe(false)
  })

  it('produces ZERO operations on every refusal', () => {
    // The refusal branch of CompoundResult has no `operations` at all, which is the structural
    // version of "a refusal is never a partial plan". Asserted rather than assumed, because a
    // half-written expansion is exactly the failure this contract exists to prevent.
    const refusals = [
      expand({ places: PLACES, maxY: '12' }, 'banana'),
      expand({ places: PLACES, maxY: '12', levelVariable: 'level' }),
      expand({ places: ID, maxY: '12' }),
      expand({ places: 'slab', maxY: '12' }),
    ]
    for (const r of refusals) {
      expect(r.ok).toBe(false)
      expect(r).not.toHaveProperty('expansion')
    }
  })
})

describe('expand is pure', () => {
  const every: readonly ColumnParams[] = [
    { places: PLACES, maxY: '12' },
    { places: PLACES, maxY: '12', minY: '4', setup: 'v.seed = 1;' },
    { places: PLACES, maxY: 'q.heightmap + 3', minY: 'v.base', order: 'top-down' },
    { places: PLACES, maxY: '12', order: 'bottom-up', levelVariable: 'level', step: 'v.hits = v.hits + 1;' },
  ]

  it('gives the same operations in the same order for the same parameters', () => {
    for (const params of every) {
      for (const version of [OLD, NEW]) {
        const first = expansionOf(expand(params, version))
        const second = expansionOf(expand({ ...params }, version))
        expect(second).toEqual(first)
        expect(second.operations.map((o) => o.file)).toEqual(first.operations.map((o) => o.file))
      }
    }
  })

  it('lists creates in the order the files are written', () => {
    for (const params of every) {
      const e = expansionOf(expand(params))
      expect(e.creates).toEqual(
        e.operations.map((o) => {
          if (o.op !== 'createFile') throw new Error('a column only creates files')
          return o.identifier
        }),
      )
    }
  })
})
