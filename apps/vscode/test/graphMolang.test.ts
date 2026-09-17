// graphMolang.test.ts -- the edge Molang editor (src/graph/molangEdge.ts) and its offline name
// catalogue (src/graph/molangHints.ts).
//
// Four things this suite exists to pin, all of them rules the module would quietly break
// without a test rather than fail loudly:
//
//  1. ALL THREE `iterations` idioms stay first-class. Counting, gating by evaluating to 0, and
//     setting up `variable.*` for the placed feature are equally legal, so the control is a
//     text field that keeps a stepper only while a stepper is lossless -- never a spin-box that
//     makes the other two harder to write than plain text.
//  2. THE CATALOGUE IS CLOSED. Exactly the six queries worldgen registers and the six variables
//     the engine publishes. A completion list that grows an entity-side query is a regression,
//     because the real game rejects an unknown query name at tokenize time.
//  3. AN UNWRITTEN READ REACHES THE EDGE. The engine's headline diagnostic has to appear in
//     view().problems, spanned, with a fix -- not in a list somewhere else.
//  4. A ZERO IS NEVER CALLED DEAD. Any evaluation shown says "at this origin", names it, and
//     points at the origin control -- unless the expression's own text proves nothing in it can
//     vary, which is the only case allowed to speak unconditionally.
//
// The Go validator is stubbed throughout (that is what MolangEdgeValidator is for), and the
// debounce is injected as run-now, so nothing here needs the engine, a pack, or a timer.
import { describe, expect, it, vi } from 'vitest'
import {
  MolangEdgeEditor,
  ITERATIONS_TEMPLATES,
  type EdgeProblem,
  type MolangEdgeChange,
  type MolangEdgeRef,
  type MolangEdgeValidator,
  type MolangValidateRequest,
  type MolangValidateResponse,
} from '../src/graph/molangEdge.js'
import {
  PUBLISHED_VARIABLES,
  WORLDGEN_QUERIES,
  analyseIterations,
  completionsAt,
  localProblems,
  scanMolang,
} from '../src/graph/molangHints.js'

const SCATTER_EDGE: MolangEdgeRef = {
  from: 'wiki:pumpkin_patch',
  to: 'wiki:pumpkin',
  kind: 'scatter',
  jsonPath: '$.minecraft:scatter_feature.distribution',
  required: true,
}

const CONDITIONAL_EDGE: MolangEdgeRef = {
  from: 'wiki:isle_top',
  to: 'wiki:isle_grass',
  kind: 'conditional',
  jsonPath: '$.minecraft:conditional_list.conditional_features[0]',
  required: false,
}

const ORIGIN_ZERO = { x: 0, y: 0, z: 0 }

/** A validator that answers with whatever `response` says and records every request, so a test
 * can assert on the request shape as well as the view it produces. */
function stubValidator(response: MolangValidateResponse | ((req: MolangValidateRequest) => MolangValidateResponse)): {
  validator: MolangEdgeValidator
  requests: MolangValidateRequest[]
} {
  const requests: MolangValidateRequest[] = []
  return {
    requests,
    validator: {
      validate: async (req) => {
        requests.push(req)
        return typeof response === 'function' ? response(req) : response
      },
    },
  }
}

/** Runs the debounce immediately: this suite is about what the editor decides, never about how
 * long it waits to decide it. */
const now = (run: () => void): (() => void) => {
  run()
  return () => {}
}

function makeEditor(
  overrides: Partial<{
    edge: MolangEdgeRef
    field: 'condition' | 'iterations'
    value: string | null
    origin: { x: number; y: number; z: number }
    annotations: { name: string; args?: string[]; jsonPath: string }[]
    response: MolangValidateResponse | ((req: MolangValidateRequest) => MolangValidateResponse)
  }> = {},
): { editor: MolangEdgeEditor; requests: MolangValidateRequest[]; changes: MolangEdgeChange[] } {
  const edge = overrides.edge ?? SCATTER_EDGE
  const { validator, requests } = stubValidator(overrides.response ?? {})
  const editor = new MolangEdgeEditor(
    {
      edge,
      field: overrides.field ?? 'iterations',
      value: overrides.value ?? null,
      origin: overrides.origin ?? ORIGIN_ZERO,
      ...(overrides.annotations === undefined ? {} : { annotations: overrides.annotations }),
    },
    { validator, schedule: now },
  )
  const changes: MolangEdgeChange[] = []
  editor.onChange((c) => changes.push(c))
  return { editor, requests, changes }
}

function problem(problems: readonly EdgeProblem[], code: string): EdgeProblem | undefined {
  return problems.find((p) => p.code === code)
}

// ---------------------------------------------------------------------------
// 1. The three iterations idioms
// ---------------------------------------------------------------------------

describe('iterations: all three idioms are first-class', () => {
  it('classifies a bare count, and offers a stepper only for it', () => {
    const { editor } = makeEditor({ value: '4' })
    const view = editor.view()
    expect(view.idioms).toContain('count')
    expect(view.stepper).toEqual({ value: 4, min: 0, step: 1 })
  })

  it('drops the stepper the moment the expression stops being a bare number', () => {
    const { editor } = makeEditor({ value: '4' })
    editor.setText('(query.noise(variable.originx / 128, variable.originz / 128) > 0.4) * 4')
    const view = editor.view()
    // The whole point of an adornment rather than a mode: the control is still the same text
    // field, it has simply stopped pretending a number can represent this.
    expect(view.stepper).toBeNull()
    expect(view.text).toContain('query.noise')
    expect(view.idioms).toContain('condition')
  })

  it('recognises the setup idiom and lists the variables the placed feature can read', () => {
    const { editor } = makeEditor({ value: 'variable.trunk_height = 4 + math.random_integer(0, 3); return 1;' })
    const view = editor.view()
    expect(view.idioms).toContain('setup')
    expect(view.writes).toEqual(['trunk_height'])
  })

  it('recognises setup and counting at once -- the idioms are a set, not a mode', () => {
    const analysis = analyseIterations('variable.n = 3; return variable.n > 1 ? 4 : 0;')
    expect(analysis.idioms).toContain('setup')
    expect(analysis.idioms).toContain('condition')
    expect(analysis.writes).toEqual(['n'])
  })

  it('catches the specific way the setup idiom misfires: a sequence with no return is 0', () => {
    // molang-go's TestStatementSequenceDefaultsToZero: "t.x = 1; t.x = 2;" evaluates to 0. An
    // author who writes only the setup half silently turns their scatter off.
    const problems = localProblems('variable.trunk_height = 5;', 'iterations')
    const found = problem(problems as EdgeProblem[], 'sequence-without-return')
    expect(found?.message).toContain('return')
    expect(analyseIterations('variable.trunk_height = 5;').sequenceWithoutReturn).toBe(true)
    // ... and does NOT fire once the author counts as well.
    expect(localProblems('variable.trunk_height = 5; return 3;', 'iterations')).toHaveLength(0)
  })

  it('seeds the two non-obvious idioms from a template, without committing them', () => {
    const { editor, changes } = makeEditor({ value: '4' })
    expect(ITERATIONS_TEMPLATES.map((t) => t.id).sort()).toEqual(['condition', 'setup'])
    editor.insertTemplate('setup')
    expect(editor.view().idioms).toContain('setup')
    expect(editor.view().dirty).toBe(true)
    // A template is a starting point the author edits, so nothing has been written to the file.
    expect(changes).toHaveLength(0)
  })

  it('refuses to remove a required iterations, and keeps nil distinct from "1.0" on a condition', () => {
    const { editor: scatter } = makeEditor({ value: '4' })
    expect(scatter.clear()).toBe(false)

    const { editor: conditional, changes } = makeEditor({
      edge: CONDITIONAL_EDGE,
      field: 'condition',
      value: 'query.has_biome_tag(\'forest\')',
    })
    expect(conditional.clear()).toBe(true)
    // null, not "1.0": the contract keeps "the author wrote no condition" distinct from "the
    // author wrote always-true", and an editor is not allowed to collapse that for them.
    expect(changes).toEqual([{ kind: 'value', field: 'condition', edge: CONDITIONAL_EDGE, value: null }])
    expect(conditional.view().absent).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. The closed name catalogue
// ---------------------------------------------------------------------------

describe('available names: exactly what worldgen reaches', () => {
  it('offers the six worldgen queries and nothing else', () => {
    const completions = completionsAt('query.', 'query.'.length, { field: 'iterations' })
    expect(completions.map((c) => c.label).sort()).toEqual(
      ['above_top_solid', 'all_tags', 'any_tag', 'has_biome_tag', 'heightmap', 'noise'].sort(),
    )
    expect(WORLDGEN_QUERIES).toHaveLength(6)
  })

  it('offers the six published variables, plus whatever the engine says was written upstream', () => {
    const bare = completionsAt('v.', 'v.'.length, { field: 'iterations' })
    expect(bare.map((c) => c.label).sort()).toEqual(PUBLISHED_VARIABLES.map((v) => v.name).sort())

    const withScope = completionsAt('v.', 'v.'.length, { field: 'iterations', scopeWrites: ['trunk_height'] })
    expect(withScope.map((c) => c.label)).toContain('trunk_height')
  })

  it('keeps the author\'s own namespace spelling when completing a member', () => {
    const source = 'v.ori'
    const [first] = completionsAt(source, source.length, { field: 'iterations' })
    // Replaces only the member, so `v.` survives and the file's house style is not rewritten.
    expect(first?.replaceOffset).toBe(2)
    expect(first?.insertText).not.toContain('.')
  })

  it('reports an unreachable query as an error, because the real game refuses to load it', () => {
    const problems = localProblems('query.block_property(\'x\') * 4', 'iterations')
    const found = problem(problems as EdgeProblem[], 'unreachable-query')
    expect(found?.severity).toBe('error')
    expect(found?.message).toContain('Failed to resolve query')
    // Spanned so the renderer can underline the name rather than the whole field.
    expect(found?.span).toEqual({ offset: 0, length: 'query.block_property'.length })
  })

  it('reports a wrong argument count, which the engine answers with a silent 0', () => {
    const found = problem(localProblems('query.noise(variable.originx)', 'iterations') as EdgeProblem[], 'query-arity')
    expect(found?.message).toContain('passes 1')
  })

  // has_biome_tag is the one query whose accepted counts are a set with a hole in it: 1, 3 and
  // 4, but not 2. The catalogue described it as taking exactly one for a long time, which meant
  // the editor put a warning under every coordinate form -- the only form that can look at a
  // neighbouring column, and therefore the only form edge blending can be built out of.
  describe('has_biome_tag, whose arity is a set and not a range', () => {
    const arity = (source: string) => problem(localProblems(source, 'condition') as EdgeProblem[], 'query-arity')

    it('accepts the origin form and both coordinate forms', () => {
      expect(arity("query.has_biome_tag('forest')")).toBeUndefined()
      expect(arity("query.has_biome_tag('forest', 10, 20)")).toBeUndefined()
      expect(arity("query.has_biome_tag('forest', 10, 68, 20)")).toBeUndefined()
    })

    it('still refuses two arguments, the count that falls in the hole', () => {
      // A range of 1..4 would wave this through. The engine recognises no such form and
      // answers 0, so it has to be caught here or not at all.
      expect(arity("query.has_biome_tag('forest', 10)")?.message).toContain('passes 2')
    })

    it('warns separately that the three-argument form is a y=0 lookup, not a 2D one', () => {
      const found = problem(
        localProblems("query.has_biome_tag('forest', 10, 20)", 'condition') as EdgeProblem[],
        'biome-tag-y-zero',
      )
      // Accepted by the engine, so it is deliberately NOT an arity complaint -- the point is
      // that it works and answers about the wrong place.
      expect(found).toBeDefined()
      expect(found?.message).toContain('forces y to 0')
      expect(found?.message).toContain('above_top_solid')
      expect(arity("query.has_biome_tag('forest', 10, 20)")).toBeUndefined()
    })

    it('leaves the four-argument form alone, since that is the shape blending wants', () => {
      expect(
        problem(
          localProblems("query.has_biome_tag('forest', 10, 68, 20)", 'condition') as EdgeProblem[],
          'biome-tag-y-zero',
        ),
      ).toBeUndefined()
    })

    it('says of any_tag and all_tags that they cannot be pointed at another column', () => {
      // Every argument is read as a tag name, so a trailing x/z is silently two junk tags.
      // The hover is the only place an author can learn that, which is why it is asserted.
      for (const name of ['any_tag', 'all_tags']) {
        const hint = WORLDGEN_QUERIES.find((q) => q.name === name)
        expect(hint?.doc).toContain("run's own origin")
      }
      expect(WORLDGEN_QUERIES.find((q) => q.name === 'has_biome_tag')?.argCounts).toEqual([1, 3, 4])
    })
  })

  it('warns that worldx is not this scatter\'s position inside iterations', () => {
    // A scatter publishes only originx/y/z before evaluating iterations; worldx/y/z are written
    // per axis, per iteration, afterwards.
    const found = problem(localProblems('variable.worldx / 16', 'iterations') as EdgeProblem[], 'world-var-in-iterations')
    expect(found?.message).toContain('variable.originx')
    // On a condition all six ARE published from the origin, so the same text is fine there.
    expect(localProblems('variable.worldx / 16', 'condition')).toHaveLength(0)
  })

  it('does not mistake a tag string, or a comparison, for code', () => {
    expect(scanMolang("query.has_biome_tag('v.not_a_ref')").map((r) => r.member)).toEqual(['has_biome_tag'])
    expect(scanMolang('variable.originx >= 4').every((r) => !r.write)).toBe(true)
    expect(scanMolang('variable.originx = 4')[0]?.write).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. The unwritten-read diagnostic, at the edge
// ---------------------------------------------------------------------------

describe('unwritten reads are surfaced on the edge', () => {
  it('renders the engine\'s unwritten read as a spanned, fixable problem', async () => {
    const { editor } = makeEditor({
      field: 'condition',
      edge: CONDITIONAL_EDGE,
      value: 'variable.trunk_height > 3',
      response: {
        unwrittenReads: [
          { name: 'variable.trunk_height', span: { offset: 0, length: 22 }, detail: 'the long engine explanation' },
        ],
      },
    })
    await editor.whenSettled()
    const found = problem(editor.view().problems, 'unwritten-read')
    expect(found).toBeDefined()
    expect(found?.span).toEqual({ offset: 0, length: 22 })
    expect(found?.detail).toBe('the long engine explanation')
    // The consequence that makes this the headline bug, stated where the author is looking.
    expect(found?.message).toContain('stops the expression')
    expect(found?.actions?.map((a) => a.kind)).toContain('insert-fallback')
    expect(editor.view().status).toBe('problems')
  })

  it('applies the ?? guard the engine itself recommends', async () => {
    const { editor } = makeEditor({
      field: 'condition',
      edge: CONDITIONAL_EDGE,
      value: 'variable.trunk_height > 3',
      response: { unwrittenReads: [{ name: 'variable.trunk_height' }] },
    })
    await editor.whenSettled()
    const fix = editor.view().problems.flatMap((p) => p.actions ?? []).find((a) => a.kind === 'insert-fallback')
    editor.invokeAction(fix!)
    expect(editor.view().text).toBe('(variable.trunk_height > 3) ?? 0')
  })

  it('sends an edge-identified, origin-carrying request', async () => {
    const { editor, requests } = makeEditor({ value: '4', origin: { x: 128, y: 70, z: -64 } })
    await editor.whenSettled()
    expect(requests[0]).toMatchObject({
      field: 'iterations',
      expression: '4',
      edge: { from: SCATTER_EDGE.from, to: SCATTER_EDGE.to, kind: 'scatter', jsonPath: SCATTER_EDGE.jsonPath },
      origin: { x: 128, y: 70, z: -64 },
    })
  })

  it('drops a response that describes text the author has moved past', async () => {
    // Out-of-order responses are the standard way a live field starts showing diagnostics about
    // something that is no longer written in it.
    let resolveSlow: (r: MolangValidateResponse) => void = () => {}
    const slow = new Promise<MolangValidateResponse>((resolve) => {
      resolveSlow = resolve
    })
    let call = 0
    const validator: MolangEdgeValidator = {
      validate: async () => {
        call++
        return call === 1 ? slow : {}
      },
    }
    const editor = new MolangEdgeEditor(
      { edge: SCATTER_EDGE, field: 'iterations', value: '4', origin: ORIGIN_ZERO },
      { validator, schedule: now },
    )
    editor.setText('8')
    await editor.whenSettled()
    resolveSlow({ unwrittenReads: [{ name: 'variable.stale' }] })
    await slow
    expect(problem(editor.view().problems, 'unwritten-read')).toBeUndefined()
  })

  it('reports a validator failure as an engine problem, not a verdict on the expression', async () => {
    const validator: MolangEdgeValidator = { validate: () => Promise.reject(new Error('engine exited')) }
    const editor = new MolangEdgeEditor(
      { edge: SCATTER_EDGE, field: 'iterations', value: '4', origin: ORIGIN_ZERO },
      { validator, schedule: now },
    )
    await editor.whenSettled()
    const found = problem(editor.view().problems, 'engine')
    expect(found?.severity).toBe('info')
    expect(found?.message).toContain('could not be checked')
  })
})

// ---------------------------------------------------------------------------
// 4. Origin sensitivity: "did not run" is never "is dead"
// ---------------------------------------------------------------------------

describe('a zero is reported at an origin, not as a death', () => {
  it('phrases an origin-gated zero as "at this origin" and points at the origin control', async () => {
    const { editor, changes } = makeEditor({
      value: '(variable.originx / 16 == math.floor(variable.originx / 16)) * 4',
      response: { evaluation: { value: 0, originUsed: ORIGIN_ZERO } },
    })
    await editor.whenSettled()
    const view = editor.view()
    expect(view.evaluation?.summary).toBe('0 at this origin (0,0,0)')
    const found = problem(view.problems, 'zero-at-origin')
    expect(found?.severity).toBe('info')
    expect(found?.message).toContain('at this origin (0,0,0)')
    expect(found?.message).not.toContain('dead')
    expect(found?.message).toContain('0,0,0 and true elsewhere')

    const action = found?.actions?.find((a) => a.kind === 'reveal-origin')
    expect(action).toBeDefined()
    editor.invokeAction(action!)
    expect(changes).toContainEqual({ kind: 'reveal', edge: SCATTER_EDGE, target: 'origin-control' })
  })

  it('names the zero-iterations outcome as configuration, distinct from a chance rejection', async () => {
    const { editor } = makeEditor({
      value: '(variable.originz > 100) * 2',
      response: { evaluation: { value: 0, originUsed: ORIGIN_ZERO } },
    })
    await editor.whenSettled()
    expect(problem(editor.view().problems, 'zero-at-origin')?.detail).toContain('scatter_chance')
  })

  it('speaks unconditionally only when the text itself proves nothing can vary', async () => {
    const { editor } = makeEditor({ value: '2 - 2', response: { evaluation: { value: 0, originUsed: ORIGIN_ZERO } } })
    await editor.whenSettled()
    const found = problem(editor.view().problems, 'zero-at-origin')
    expect(found?.severity).toBe('warning')
    expect(found?.message).toContain('0 for every run')
  })

  it('attributes a biome-gated zero to the biome rather than sending the author to the origin', async () => {
    const { editor } = makeEditor({
      field: 'condition',
      edge: CONDITIONAL_EDGE,
      value: "query.has_biome_tag('forest')",
      response: { evaluation: { value: 0, originUsed: ORIGIN_ZERO } },
    })
    await editor.whenSettled()
    const found = problem(editor.view().problems, 'zero-at-origin')
    expect(found?.message).toContain('biome')
    expect(found?.actions?.some((a) => a.kind === 'reveal-origin')).toBe(false)
  })

  it('calls an RNG-driven zero luck', async () => {
    const { editor } = makeEditor({
      value: 'math.random_integer(0, 0)',
      response: { evaluation: { value: 0, originUsed: ORIGIN_ZERO } },
    })
    await editor.whenSettled()
    expect(problem(editor.view().problems, 'zero-at-origin')?.message).toContain('luck')
  })

  it('honours @featurelab:ignore inactive-branch, and can write one', async () => {
    const { editor, changes } = makeEditor({
      value: '(variable.originx > 500) * 4',
      annotations: [{ name: 'ignore', args: ['inactive-branch'], jsonPath: SCATTER_EDGE.jsonPath }],
      response: { evaluation: { value: 0, originUsed: ORIGIN_ZERO } },
    })
    await editor.whenSettled()
    const view = editor.view()
    // Suppressed, but still listed as suppressed: a renderer can show a muted marker, and the
    // notice does not simply vanish without trace.
    expect(problem(view.problems, 'zero-at-origin')).toBeUndefined()
    expect(view.suppressed).toContain('zero-at-origin')

    const { editor: loud } = makeEditor({
      value: '(variable.originx > 500) * 4',
      response: { evaluation: { value: 0, originUsed: ORIGIN_ZERO } },
    })
    const sink: MolangEdgeChange[] = []
    loud.onChange((c) => sink.push(c))
    await loud.whenSettled()
    const annotate = problem(loud.view().problems, 'zero-at-origin')?.actions?.find((a) => a.kind === 'annotate-ignore')
    loud.invokeAction(annotate!)
    expect(sink).toContainEqual({
      kind: 'annotate',
      edge: SCATTER_EDGE,
      annotation: { name: 'ignore', args: ['inactive-branch'] },
    })
    expect(changes).toHaveLength(0)
  })

  it('reports the origin the ENGINE used, not the one currently in the panel', async () => {
    const { editor } = makeEditor({
      value: 'variable.originx',
      response: { evaluation: { value: 0, originUsed: { x: 0, y: 0, z: 0 } } },
    })
    await editor.whenSettled()
    // A response that raced an origin change must not be relabelled with the new origin.
    expect(editor.view().evaluation?.origin).toEqual(ORIGIN_ZERO)
  })

  it('honours an explicit @featurelab:idiom declaration over inference', () => {
    const { editor } = makeEditor({
      value: '4',
      annotations: [{ name: 'idiom', args: ['setup-script'], jsonPath: SCATTER_EDGE.jsonPath }],
    })
    expect(editor.view().declaredIdiom).toBe('setup-script')
  })
})

// ---------------------------------------------------------------------------
// Editing lifecycle
// ---------------------------------------------------------------------------

describe('editing lifecycle', () => {
  it('does not write the file while typing, and writes once on commit', () => {
    const { editor, changes } = makeEditor({ value: '4' })
    editor.setText('8')
    editor.setText('80')
    expect(changes).toHaveLength(0)
    expect(editor.view().dirty).toBe(true)
    expect(editor.commit()).toBe(true)
    expect(changes).toEqual([{ kind: 'value', field: 'iterations', edge: SCATTER_EDGE, value: '80' }])
    expect(editor.commit()).toBe(false)
  })

  it('marks the view stale while the draft is ahead of the last answer', async () => {
    const { editor } = makeEditor({ value: '4', response: {} })
    await editor.whenSettled()
    const validating = new MolangEdgeEditor(
      { edge: SCATTER_EDGE, field: 'iterations', value: '4', origin: ORIGIN_ZERO },
      { validator: { validate: () => new Promise(() => {}) }, schedule: now },
    )
    expect(validating.view().status).toBe('validating')
  })

  it('re-validates when the origin moves, because every answer is about one origin', async () => {
    const { editor, requests } = makeEditor({ value: 'variable.originx' })
    await editor.whenSettled()
    editor.setOrigin({ x: 256, y: 64, z: 256 })
    await editor.whenSettled()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.origin).toEqual({ x: 256, y: 64, z: 256 })
  })

  it('starts no engine work after dispose', async () => {
    const validate = vi.fn(async () => ({}))
    const editor = new MolangEdgeEditor(
      { edge: SCATTER_EDGE, field: 'iterations', value: '4', origin: ORIGIN_ZERO },
      { validator: { validate }, schedule: now },
    )
    await editor.whenSettled()
    editor.dispose()
    editor.setText('9')
    // Only the constructor's own validation ran: an edge that has left the canvas does not keep
    // the engine busy.
    expect(validate).toHaveBeenCalledTimes(1)
  })

  it('reports an empty required iterations as an error without asking the engine', () => {
    const { editor, requests } = makeEditor({ value: '4' })
    editor.setText('')
    expect(problem(editor.view().problems, 'empty-required')?.severity).toBe('error')
    expect(requests).toHaveLength(1)
  })
})
