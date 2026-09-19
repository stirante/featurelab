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

// ===========================================================================
// THE FILE MOVING UNDER AN OPEN EDITOR
// ===========================================================================
//
// THE BUG. The host caches one editor per edge so that clicking away and coming back does not
// throw away the caret and the draft, and that cache never looked at the value again. Select
// wiki:pumpkin_patch with iterations = 14; something else -- a save in the text editor, an undo,
// another panel's write -- makes the file say 999. The chip on the edge, rebuilt from the new
// graph, reads 999 correctly. The box a foot away still reads 14. Type one character, click
// away, and `142` is posted over the top of the 999: no conflict, no warning, and nothing on
// screen that could have told anybody.
//
// The fix has to be symmetrical or it is the same bug pointed the other way: a reseed that
// always took the file would delete whatever the author was in the middle of typing. So a clean
// box adopts the file, a dirty one keeps its text AND says what it is about to overwrite.
describe('when the file changes under an open expression', () => {
  it('does nothing at all when the value is the one the editor already has', () => {
    // The commonest case by far: this is what comes back after the editor's own write.
    const { editor } = editorFor('14')
    expect(editor.reseed('14')).toBe('unchanged')
    expect(editor.view().text).toBe('14')
    expect(editor.view().conflict).toBeNull()
  })

  it('takes the new value when the box has nothing uncommitted in it', () => {
    const { editor, changes } = editorFor('14')
    expect(editor.view().text).toBe('14')
    expect(editor.reseed('999')).toBe('adopted')
    expect(editor.view().text).toBe('999')
    expect(editor.view().dirty).toBe(false)
    expect(editor.view().conflict).toBeNull()
    // And nothing was written on the way: adopting the file is not an edit to it.
    expect(changes).toEqual([])
  })

  it('is not fooled by the reformatting it does on open', () => {
    // Opening an expression lays it out for reading, so the draft differs from the file's bytes
    // for every edge anybody looks at. If THAT counted as dirty, browsing a pack would raise a
    // conflict on every selection.
    const { editor } = editorFor(ONE_LINER)
    expect(editor.view().text).toContain('\n')
    expect(editor.view().dirty).toBe(false)
    expect(editor.reseed('7')).toBe('adopted')
    expect(editor.view().text).toBe('7')
  })

  it('keeps what the author typed, and says the file moved', () => {
    const { editor, changes } = editorFor('14')
    editor.setText('142')
    expect(editor.reseed('999')).toBe('conflict')

    // 1. The typing is still there. This is the half that a "the file always wins" fix loses.
    expect(editor.view().text).toBe('142')
    expect(editor.view().conflict).toEqual({ fileValue: '999' })
    // 2. It is still unsaved -- and now it is unsaved OVER something.
    expect(editor.view().dirty).toBe(true)
    // 3. And that is said, in words, naming the value the file actually holds.
    const problem = editor.view().problems.find((p) => p.code === 'external-change')
    expect(problem, 'the file moved under a draft and nothing said so').toBeDefined()
    expect(problem!.message).toContain('999')
    expect(problem!.severity).toBe('warning')
    // 4. With both answers offered, and neither taken.
    expect(problem!.actions?.map((a) => a.kind)).toContain('take-file-value')
    expect(problem!.actions?.map((a) => a.kind)).toContain('keep-draft')
    expect(changes, 'reseeding wrote to the file').toEqual([])
  })

  it("lets the author take the file's version, which abandons the edit", () => {
    const { editor, changes } = editorFor('14')
    editor.setText('142')
    editor.reseed('999')
    const problem = editor.view().problems.find((p) => p.code === 'external-change')!
    editor.invokeAction(problem.actions!.find((a) => a.kind === 'take-file-value')!)
    expect(editor.view().text).toBe('999')
    expect(editor.view().dirty).toBe(false)
    expect(editor.view().conflict).toBeNull()
    // Nothing was written: taking what the file already says is not a change to it.
    expect(changes).toEqual([])
    expect(editor.commit()).toBe(false)
  })

  it('lets the author keep theirs, and then writes theirs -- knowingly', () => {
    const { editor, changes } = editorFor('14')
    editor.setText('142')
    editor.reseed('999')
    editor.invokeAction({ kind: 'keep-draft', label: 'Keep mine' })
    expect(editor.view().conflict).toBeNull()
    expect(editor.view().problems.some((p) => p.code === 'external-change')).toBe(false)
    expect(editor.view().text).toBe('142')
    // THE POINT OF THE WHOLE EXERCISE. The overwrite still happens -- it is the author's file and
    // their decision -- but it happens after they have been told what they are overwriting.
    expect(editor.commit()).toBe(true)
    expect(changes).toEqual([{ kind: 'value', field: 'iterations', edge: SCATTER, value: '142' }])
  })

  it('stops asking once the edit has been committed', () => {
    const { editor } = editorFor('14')
    editor.setText('142')
    editor.reseed('999')
    expect(editor.commit()).toBe(true)
    expect(editor.view().conflict).toBeNull()
  })

  it('handles the key being removed from the file entirely', () => {
    const { editor } = editorFor('14', { field: 'condition', edge: { ...SCATTER, required: false } })
    editor.setText('1')
    expect(editor.reseed(null)).toBe('conflict')
    expect(editor.view().problems.find((p) => p.code === 'external-change')!.message).toContain('no value')
  })
})

// ===========================================================================
// ESCAPE
// ===========================================================================
//
// Every other way out of this box COMMITS: Tab, clicking anywhere else, selecting another node.
// An author who started typing and thought better of it had no gesture that meant "no" -- Escape
// with the completion list closed did nothing at all.
describe('abandoning an edit', () => {
  it('puts back exactly what the file holds', () => {
    const { editor, changes } = editorFor('14')
    editor.setText('math.random_integer(1, 4)')
    expect(editor.view().dirty).toBe(true)
    expect(editor.revert()).toBe(true)
    expect(editor.view().text).toBe('14')
    expect(editor.view().dirty).toBe(false)
    expect(changes).toEqual([])
  })

  it('reports that it did nothing when there was nothing to abandon', () => {
    // So a key handler can let Escape go on meaning whatever else it means in the panel around
    // the box -- clearing the selection, closing a gesture -- instead of swallowing it.
    const { editor } = editorFor('14')
    expect(editor.revert()).toBe(false)
  })

  it('answers a conflict by taking the file, which is the safe half', () => {
    const { editor } = editorFor('14')
    editor.setText('142')
    editor.reseed('999')
    expect(editor.revert()).toBe(true)
    expect(editor.view().text).toBe('999')
    expect(editor.view().conflict).toBeNull()
  })
})

// ===========================================================================
// THE TWO MODES
// ===========================================================================
//
// `14` and `math.random(1, 4)` are the same box and were the same PIXELS: nothing anywhere said
// which of the two you had, and the stepper the editor computes for the first had never been
// drawn. The control is still always a text field -- see molangEdge.ts on why a spin box can
// express one of the three idioms `iterations` is used for -- so the difference is an adornment,
// and the way back from an expression to a count is a remembered number rather than a guess.
describe('a count and an expression are different things to be looking at', () => {
  it('offers a stepper exactly while the text is a bare count', () => {
    const { editor } = editorFor('14')
    expect(editor.view().stepper).toEqual({ value: 14, min: 0, step: 1 })
    editor.setText('math.random_integer(1, 4)')
    expect(editor.view().stepper).toBeNull()
  })

  it('remembers the count, so there is a way back from an expression', () => {
    const { editor } = editorFor('14')
    editor.insertTemplate('setup')
    expect(editor.view().stepper).toBeNull()
    expect(editor.view().lastNumber).toBe(14)
    expect(editor.useNumber()).toBe(true)
    expect(editor.view().text).toBe('14')
  })

  it('refuses the way back when it has never seen a count', () => {
    const { editor } = editorFor('math.random_integer(1, 4)')
    expect(editor.view().lastNumber).toBeNull()
    expect(editor.useNumber()).toBe(false)
  })

  // THE MODE IS THE VALUE'S, NOT THE KEY'S. `stepper` used to be computed only when the field was
  // `iterations`, so every other slot this editor drives -- a conditional edge's `condition`, and
  // through the node inspector both ends of an `extent`, a `width_modifier` and a
  // `scatter_chance` -- reported `expression` whatever was in it. Two modes that cannot be told
  // apart on five slots out of six is not two modes.
  it('reads the mode off the text on a condition, the same as on a count', () => {
    const { editor } = editorFor('1', { field: 'condition' })
    expect(editor.view().stepper).toEqual({ value: 1, step: 1 })
    editor.setText('q.noise(1, 2) > 0.4')
    expect(editor.view().stepper).toBeNull()
    editor.setText('-5')
    expect(editor.view().stepper).toEqual({ value: -5, step: 1 })
  })

  it('floors a COUNT at zero and leaves every other slot unbounded -- the slot half of the rule', () => {
    // A count cannot be negative and this editor says so on its own account. An extent end
    // routinely is, and a floor borrowed from the count would refuse to step it down.
    expect(editorFor('4').editor.view().stepper).toEqual({ value: 4, min: 0, step: 1 })
    expect(editorFor('4', { field: 'condition' }).editor.view().stepper).toEqual({ value: 4, step: 1 })
    // A slot that knows its own schema bounds states them, and they are carried verbatim.
    const bounded = editorFor('50', { field: 'condition', numeric: { min: 0, max: 100, step: 5 } })
    expect(bounded.editor.view().stepper).toEqual({ value: 50, min: 0, max: 100, step: 5 })
  })

  it('does not offer a way BACK to the number it is already holding', () => {
    // `width_modifier: 0` offered "Back to 0" while showing 0, which is what a mode inferred from
    // the key name looks like from the outside.
    const { editor } = editorFor('0', { field: 'condition' })
    const view = editor.view()
    expect(view.stepper).not.toBeNull()
    expect(view.lastNumber).toBe(0)
    // The renderer hides the way back whenever the text IS a number; both halves are stated here
    // because it is the pair that was wrong.
    expect(view.stepper !== null && view.lastNumber !== null).toBe(true)
  })
})

// ===========================================================================
// SYNTAX, WITH NO ENGINE BEHIND IT
// ===========================================================================
//
// WHY THESE ARE HERE RATHER THAN IN GO. `featurelab serve` dispatches loadPack, reloadFile,
// generate, generateGrown, regenerate, renameFeature, deleteFeature, createFiles, applyEdits,
// annotate, annotateBatch, graph, types, environments and atlas. Not one of them compiles a
// Molang expression, so MolangEdgeValidator has nothing to be wired to and the webview passes a
// stub that answers {} to everything. Until that method exists, every expression below reached a
// pack file with ZERO diagnostics, while the note under the box cheerfully explained that "the
// file gets one compact line".
//
// Every check here is one whose answer does not depend on the pack, which is what makes it safe
// to make in the editor rather than in the engine: brackets have to match under any grammar. The
// two that genuinely need the engine -- "this reads a name nothing writes" and "this is what it
// comes out as at your origin" -- are still unanswered, and still say so by being absent rather
// than by being guessed at.
describe('the expressions that used to reach a pack file in silence', () => {
  const codesFor = (text: string): string[] => editorFor(text).editor.view().problems.map((p) => p.code)

  it('catches a call that was never closed', () => {
    const problem = editorFor('math.random(1, ').editor.view().problems.find((p) => p.code === 'unbalanced')
    expect(problem, 'math.random(1, was accepted').toBeDefined()
    expect(problem!.severity).toBe('error')
    expect(problem!.span).toEqual({ offset: 11, length: 4 })
    // ONE error, not two. The trailing comma is also true, and saying both teaches the reader
    // that half of what this panel says is noise.
    expect(codesFor('math.random(1, ')).not.toContain('dangling-operator')
  })

  it('catches brackets that do not match at all', () => {
    expect(codesFor('}{ ] ,, +')).toContain('unbalanced')
  })

  it('catches a bracket closed by the wrong one', () => {
    expect(codesFor('math.max(1, 2]')).toContain('unbalanced')
  })

  it('catches a quote that never closes', () => {
    expect(codesFor("query.has_biome_tag('forest")).toContain('unterminated-string')
  })

  it('catches an expression that ends on an operator', () => {
    for (const text of ['4 +', 'variable.x = 1; return 2 *', '1 ==']) {
      expect(codesFor(text), text).toContain('dangling-operator')
    }
  })

  it('catches a string used as a number', () => {
    // Molang compares strings with == and != and does nothing else with them: there is no
    // concatenation and no conversion, so this is a type error rather than a value.
    expect(codesFor("'hello' + 1")).toContain('string-arithmetic')
    expect(codesFor("1 - 'hello'")).toContain('string-arithmetic')
  })

  it('says nothing about the same strings used the way Molang allows', () => {
    for (const text of ["query.has_biome_tag('forest')", "query.has_biome_tag('a', 1, 2, 3) == 1"]) {
      expect(codesFor(text), text).not.toContain('string-arithmetic')
    }
  })

  it('leaves every expression a real pack writes alone', () => {
    // A syntax check that is wrong about valid Molang is worse than none: it is how people learn
    // to scroll past everything this panel says.
    const structural = ['unbalanced', 'unterminated-string', 'dangling-operator', 'string-arithmetic']
    for (const text of [
      '14',
      '0',
      'math.random_integer(3, 9)',
      '(query.noise(variable.originx / 128, variable.originz / 128) > 0.4) * 4',
      'variable.trunk_height = 4 + math.random_integer(0, 3); return 1;',
      "query.has_biome_tag('minecraft:forest', variable.originx, variable.originy, variable.originz) * 2",
      ONE_LINER,
    ]) {
      expect(codesFor(text).filter((code) => structural.includes(code)), `${text} was reported as broken`).toEqual([])
    }
  })

  it('does not pile on while somebody is half way through a call', () => {
    // The box reports as you type. Being told about the unclosed bracket inside one is correct
    // and is what an editor does; being told three things about it is a panel people stop
    // reading.
    const codes = codesFor('q.noise(v.originx')
    expect(codes.filter((c) => c === 'unbalanced')).toHaveLength(1)
    expect(codes).not.toContain('dangling-operator')
  })
})
