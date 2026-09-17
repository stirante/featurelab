// graphMolangField.test.ts -- the half of the new field that has no DOM: what MolangEdgeEditor
// does once it knows about the two spellings of an expression, and what the highlighter says about
// a piece of text.
//
// The control itself (the layer behind the textarea, the completion popup, the checkbox) is not
// here and cannot be: this package's vitest config is `environment: 'node'` with no jsdom, and a
// jsdom of the alignment between two boxes would be a mock of the one thing that has to be
// measured in a real browser. That is test/journeys/molangEdge.test.ts's job, in Chromium, on the
// built bundle. What IS here is everything decidable without pixels -- and the rules below are the
// ones a renderer would otherwise have to re-derive.
import { describe, expect, it } from 'vitest'

import {
  MOLANG_FORMAT_DIRECTIVE,
  MOLANG_FORMAT_KEEP,
  MOLANG_FORMAT_MINIFY,
  MolangEdgeEditor,
  type MolangEdgeChange,
  type MolangEdgeInput,
} from '../src/graph/molangEdge.js'
import { highlightMolang } from '../src/graph/molangHints.js'

const SCATTER = {
  from: 'wiki:patch',
  to: 'wiki:thing',
  kind: 'scatter',
  jsonPath: '$.minecraft:scatter_feature.places_feature',
  required: true,
}
const ITERATIONS_PATH = '$.minecraft:scatter_feature.distribution.iterations'

/** An editor over one scatter's `iterations`, with the offline half wired and the engine stubbed
 * out -- the same shape webview/graph.ts builds, which is what makes these rules the product's. */
function editorFor(value: string | null, input: Partial<MolangEdgeInput> = {}): {
  editor: MolangEdgeEditor
  changes: MolangEdgeChange[]
} {
  const editor = new MolangEdgeEditor(
    {
      edge: SCATTER,
      field: 'iterations',
      value,
      fieldPath: ITERATIONS_PATH,
      origin: { x: 0, y: 0, z: 0 },
      ...input,
    },
    { validator: { validate: async () => ({}) }, schedule: (run) => (run(), () => {}) },
  )
  const changes: MolangEdgeChange[] = []
  editor.onChange((c) => changes.push(c))
  return { editor, changes }
}

const ONE_LINER = "v.trunk=4+math.random_integer(0,3);v.lean=(q.noise(v.originx/64,v.originz/64)>0.3)*2;return 1;"

describe('what the author sees when they open an expression', () => {
  it('is the formatted spelling, not the one line the file holds', () => {
    const { editor } = editorFor(ONE_LINER)
    const text = editor.view().text
    expect(text).toContain('\n')
    expect(text.split('\n')).toHaveLength(3)
    expect(text.startsWith('v.trunk = 4 + math.random_integer(0, 3);')).toBe(true)
  })

  it('is not, by that alone, an unsaved change', () => {
    // THE BUG THIS PINS. `dirty` used to mean "the draft differs from the committed text", and
    // reformatting on open makes that true of every expression in the pack. Every edge anybody
    // clicked would have been rewritten the moment they clicked away from it -- a pack-wide
    // reformat triggered by browsing.
    const { editor, changes } = editorFor(ONE_LINER)
    expect(editor.view().dirty).toBe(false)
    expect(editor.commit()).toBe(false)
    expect(changes).toEqual([])
  })

  it('writes the compact spelling back, by default', () => {
    const { editor, changes } = editorFor('14')
    editor.setText('v.x = 1;\nreturn v.x + 2;')
    expect(editor.view().dirty).toBe(true)
    expect(editor.view().writeValue).toBe('v.x=1;return v.x+2;')
    expect(editor.commit()).toBe(true)
    expect(changes).toEqual([{ kind: 'value', field: 'iterations', edge: SCATTER, value: 'v.x=1;return v.x+2;' }])
  })

  it('leaves an expression it cannot lay out exactly as the author wrote it', () => {
    // Half-typed text reaches the file whenever somebody clicks away mid-edit, and the one
    // guarantee that matters there is that nothing was changed on their behalf.
    const { editor, changes } = editorFor('14')
    editor.setText('q.noise(1,')
    editor.commit()
    expect(changes).toEqual([{ kind: 'value', field: 'iterations', edge: SCATTER, value: 'q.noise(1,' }])
    expect(editor.view().formattable).toBe(false)
  })

  it('lays the text out again when asked, and says whether that changed anything', () => {
    const { editor } = editorFor('14')
    editor.setText('v.a=1;v.b=2;return 1;')
    expect(editor.reformat()).toBe(true)
    expect(editor.view().text).toBe('v.a = 1;\nv.b = 2;\nreturn 1;')
    expect(editor.reformat()).toBe(false)
  })
})

describe('the format choice', () => {
  it('is off unless the file says otherwise, and then the file gets one line', () => {
    const { editor } = editorFor(ONE_LINER)
    expect(editor.view().keepFormatted).toBe(false)
    expect(editor.view().writeValue).toBe(ONE_LINER)
  })

  it('is read back off a directive on the EXPRESSION path', () => {
    const { editor } = editorFor(ONE_LINER, {
      annotations: [
        { name: MOLANG_FORMAT_DIRECTIVE, args: [MOLANG_FORMAT_KEEP], jsonPath: ITERATIONS_PATH, line: 4 },
      ],
    })
    expect(editor.view().keepFormatted).toBe(true)
    // And now the file receives what the box shows, which is the whole point of the choice.
    expect(editor.view().writeValue).toBe(editor.view().text)
    expect(editor.view().writeValue).toContain('\n')
  })

  it('ignores a directive of the same name on somebody else\'s path', () => {
    const { editor } = editorFor(ONE_LINER, {
      annotations: [
        { name: MOLANG_FORMAT_DIRECTIVE, args: [MOLANG_FORMAT_KEEP], jsonPath: '$.somewhere.else', line: 2 },
      ],
    })
    expect(editor.view().keepFormatted).toBe(false)
  })

  it('records a change as a directive on the expression, and nothing else', () => {
    // Nothing else is load-bearing: two writes to one file from one click would be two round trips
    // through a host that does not serialise them, and the second would be rewriting an expression
    // the author never touched.
    const { editor, changes } = editorFor(ONE_LINER)
    expect(editor.setKeepFormatted(true)).toBe(true)
    expect(changes).toEqual([
      {
        kind: 'annotate',
        edge: SCATTER,
        jsonPath: ITERATIONS_PATH,
        annotation: { name: MOLANG_FORMAT_DIRECTIVE, args: [MOLANG_FORMAT_KEEP] },
      },
    ])
  })

  it('writes the off state out too, rather than removing the directive', () => {
    const { editor, changes } = editorFor(ONE_LINER, {
      annotations: [
        { name: MOLANG_FORMAT_DIRECTIVE, args: [MOLANG_FORMAT_KEEP], jsonPath: ITERATIONS_PATH, line: 4 },
      ],
    })
    expect(editor.setKeepFormatted(false)).toBe(true)
    expect(changes[0]).toMatchObject({ annotation: { args: [MOLANG_FORMAT_MINIFY] } })
  })

  it('does nothing when set to what it already is', () => {
    const { editor, changes } = editorFor(ONE_LINER)
    expect(editor.setKeepFormatted(false)).toBe(false)
    expect(changes).toEqual([])
  })

  it('changes what the NEXT commit writes, and commits nothing itself', () => {
    const { editor, changes } = editorFor('14')
    editor.setText('v.a = 1;\nreturn 2;')
    editor.setKeepFormatted(true)
    expect(changes.filter((c) => c.kind === 'value')).toEqual([])
    editor.commit()
    expect(changes.filter((c) => c.kind === 'value')).toEqual([
      { kind: 'value', field: 'iterations', edge: SCATTER, value: 'v.a = 1;\nreturn 2;' },
    ])
  })
})

describe('the directives that were already in the contract', () => {
  it('are read from either the edge path or the expression path', () => {
    // Both are "on this edge" to a person reading the file, and they are adjacent lines. An author
    // who put their note above the wrong one of the two should not silently get nothing.
    for (const jsonPath of [SCATTER.jsonPath, ITERATIONS_PATH]) {
      const { editor } = editorFor('0', {
        annotations: [{ name: 'idiom', args: ['condition'], jsonPath, line: 3 }],
      })
      expect(editor.view().declaredIdiom, jsonPath).toBe('condition')
    }
  })
})

describe('highlighting', () => {
  /** The kind assigned to `needle` in `source`, so a case reads as the claim it is making. */
  function kindOf(source: string, needle: string): string | undefined {
    const at = source.indexOf(needle)
    return highlightMolang(source, { field: 'iterations' }).find(
      (s) => s.offset === at && s.length === needle.length,
    )?.kind
  }

  it('colours the six worldgen queries as queries', () => {
    for (const name of ['noise', 'has_biome_tag', 'any_tag', 'all_tags', 'heightmap', 'above_top_solid']) {
      expect(kindOf(`query.${name}(1, 2)`, `query.${name}`), name).toBe('query')
    }
  })

  it('agrees with the diagnostic about a query the engine does not register', () => {
    // THE RULE. `unreachable-query` is an ERROR the editor already reports -- the real game refuses
    // to tokenize a file carrying one -- so a highlighter that painted it in the same colour as a
    // real query would have the field saying two different things about one word, and the
    // prettier of the two would be the wrong one.
    expect(kindOf('query.block_property(1)', 'query.block_property')).toBe('query-unknown')
    expect(kindOf('query.is_daytime', 'query.is_daytime')).toBe('query-unknown')
    expect(kindOf('q.noise(1, 2)', 'q.noise')).toBe('query')
  })

  it('separates a variable the engine publishes from one it has never heard of', () => {
    expect(kindOf('v.originx', 'v.originx')).toBe('variable')
    // Legal, and not something this catalogue can vouch for. Not coloured as confirmed, not marked
    // as wrong -- see MolangHighlightKind.
    expect(kindOf('v.trunk_height', 'v.trunk_height')).toBe('variable-other')
  })

  it('vouches for a variable the validator saw written upstream', () => {
    const spans = highlightMolang('v.trunk_height', { field: 'iterations', scopeWrites: ['trunk_height'] })
    expect(spans[0]?.kind).toBe('variable')
  })

  it('does not flag a math function the catalogue deliberately omits', () => {
    // MATH_ARITY leaves out the thirty ease_* functions on purpose. A highlighter that read that
    // omission as "this name is wrong" would be reporting an error on the strength of a list that
    // says it is incomplete.
    expect(kindOf('math.floor(1.5)', 'math.floor')).toBe('function')
    expect(kindOf('math.ease_in_sine(0, 1, 0.5)', 'math.ease_in_sine')).toBe('plain')
  })

  it('treats a string as one span, whatever is inside it', () => {
    const source = "query.any_tag('a + b, c = d')"
    const span = highlightMolang(source, { field: 'condition' }).find((s) => s.kind === 'string')
    expect(source.slice(span!.offset, span!.offset + span!.length)).toBe("'a + b, c = d'")
  })

  it('covers every character of every token exactly once, with no overlap', () => {
    const source = "v.x = q.has_biome_tag('warm ocean') ? math.max(1, -2) : 0;"
    let end = 0
    for (const span of highlightMolang(source, { field: 'condition' })) {
      expect(span.offset).toBeGreaterThanOrEqual(end)
      end = span.offset + span.length
      expect(end).toBeLessThanOrEqual(source.length)
    }
  })

  it('keeps colouring text that is only half typed', () => {
    // Every keystroke leaves the field in a state like these, and a highlighter that blanked on
    // them would flicker the colour off under the author's hands.
    for (const halfTyped of ['q.', 'query.nois', "q.any_tag('for", 'v.x = ']) {
      expect(highlightMolang(halfTyped, { field: 'iterations' }).length, halfTyped).toBeGreaterThan(0)
    }
    expect(kindOf('query.nois', 'query.nois')).toBe('query-unknown')
  })

  it('calls Molang\'s own words keywords rather than names', () => {
    expect(kindOf('return 1;', 'return')).toBe('keyword')
    expect(kindOf('loop(3, {v.x = 1;});', 'loop')).toBe('keyword')
  })
})
