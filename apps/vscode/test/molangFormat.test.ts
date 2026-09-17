// molangFormat.test.ts -- the formatter's correctness bar, which is not "does it look nice".
//
// This file exists because the thing it tests writes to somebody's pack. A formatter that gets one
// unusual expression wrong does not produce an ugly file, it produces a BROKEN one, and the author
// finds out when a feature stops placing in a world they have been building for a month. So the
// interesting assertions here are not examples of good output -- they are the three properties
// that make corruption unreachable, checked over a corpus rather than over three cases somebody
// thought of:
//
//   1. minify(format(x)) === minify(x)        -- the two spellings say the same thing
//   2. format(format(x)) === format(x)        -- formatting settles
//   3. tokens(f(x)) === tokens(x), or f(x) === x for both f
//
// The corpus is built by COMBINING shapes rather than by listing expressions, so it covers pairs
// nobody would have written down: a unary minus inside a call inside a ternary, a tag string with
// a space in it next to an assignment, a statement sequence whose last statement is a block. The
// examples further down are there to pin the readable output a person actually sees; they are the
// smaller half of this file on purpose.
import { describe, expect, it } from 'vitest'

import {
  formatMolang,
  isFormattable,
  minifyMolang,
  tokenizeMolang,
} from '../src/graph/molangFormat.js'

/** The token stream as the guard sees it. Two strings with the same signature say the same thing;
 * two with different signatures do not, whatever they look like. */
function signature(source: string): string | null {
  const tokens = tokenizeMolang(source)
  return tokens === null ? null : tokens.map((t) => `${t.kind}:${t.text}`).join('|')
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** Fragments that appear in real worldgen Molang, each exercising something a naive rewriter gets
 * wrong. Combined below rather than used alone. */
const ATOMS = [
  '1',
  '0.5',
  '.5',
  '14',
  '-3',
  '!v.flag',
  'v.originx',
  'variable.trunk_height',
  'q.noise(v.originx / 128, v.originz / 128)',
  'query.heightmap(v.originx, v.originz)',
  "query.has_biome_tag('minecraft:forest')",
  // A tag with a space in it, which is the whole reason string literals are copied verbatim.
  "query.any_tag('warm ocean', 'deep warm ocean')",
  'math.random_integer(0, 3)',
  'math.clamp(v.originy, 0, 64)',
  'math.mod(v.originx, 32) == 0',
  '(v.originy > 60) * 4',
  'v.a ?? 0',
  '1 - -1',
]

const COMBINERS: readonly ((a: string, b: string) => string)[] = [
  (a, b) => `${a} + ${b}`,
  (a, b) => `${a} * ${b}`,
  (a, b) => `(${a}) > (${b})`,
  (a, b) => `${a} > 0 ? ${b} : 0`,
  (a, b) => `math.max(${a}, ${b})`,
  (a, b) => `v.x = ${a}; return ${b};`,
  (a, b) => `v.x = ${a}; v.y = ${b}; return v.x + v.y;`,
  (a, b) => `${a} ?? ${b}`,
  (a, b) => `loop(3, {v.n = v.n + ${a};}); return ${b};`,
]

/** Every atom, every pair under every combiner, plus a handful of whole expressions in the shape a
 * real pack writes them -- one long line, no spaces, several statements. */
function corpus(): string[] {
  const out: string[] = [...ATOMS]
  for (const combine of COMBINERS) {
    for (let i = 0; i < ATOMS.length; i++) {
      out.push(combine(ATOMS[i]!, ATOMS[(i + 7) % ATOMS.length]!))
      out.push(combine(ATOMS[i]!, ATOMS[(i + 3) % ATOMS.length]!))
    }
  }
  out.push(
    "v.trunk=4+math.random_integer(0,3);v.lean=(q.noise(v.originx/64,v.originz/64)>0.3)*2;v.canopy=v.trunk+2;return q.has_biome_tag('minecraft:forest')?1:0;",
    'variable.height=math.clamp(query.above_top_solid(variable.originx,variable.originz)+1,0,256);return 1;',
    '(query.noise(variable.originx / 128, variable.originz / 128) > 0.4) * 4',
  )
  // The same corpus again, already laid out, so every property is also checked starting from
  // formatted input rather than only from compact input.
  return [...out, ...out.map(formatMolang)]
}

const CORPUS = corpus()

/** Text this module must refuse outright. Every one is something a field really holds -- mid-typing
 * or from a pack doing something this scanner has no rule for. */
const UNSCANNABLE = [
  'v.',
  "query.has_biome_tag('unterminated",
  '1e5',
  '(1 + 2',
  'v.x = 1)',
  'v.x = "double quoted"',
  'v.x = 1 @ 2',
  'v.a.',
  '3px',
]

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe('the properties that make a corrupted expression unreachable', () => {
  it('never changes what an expression SAYS -- every output has the input\'s token stream, or is the input', () => {
    for (const source of CORPUS) {
      const before = signature(source)
      for (const [name, result] of [
        ['format', formatMolang(source)],
        ['minify', minifyMolang(source)],
      ] as const) {
        if (result === source) continue
        expect(
          signature(result),
          `${name} changed what this expression says:\n  in:  ${JSON.stringify(source)}\n  out: ${JSON.stringify(result)}`,
        ).toBe(before)
      }
    }
  })

  it('minify(format(x)) === minify(x) for every expression in the corpus', () => {
    for (const source of CORPUS) {
      expect(
        minifyMolang(formatMolang(source)),
        `formatting then minifying differs from minifying: ${JSON.stringify(source)}`,
      ).toBe(minifyMolang(source))
    }
  })

  it('formatting is idempotent', () => {
    for (const source of CORPUS) {
      const once = formatMolang(source)
      expect(formatMolang(once), `formatting did not settle: ${JSON.stringify(source)}`).toBe(once)
    }
  })

  it('minifying is idempotent', () => {
    for (const source of CORPUS) {
      const once = minifyMolang(source)
      expect(minifyMolang(once), `minifying did not settle: ${JSON.stringify(source)}`).toBe(once)
    }
  })

  it('returns text it cannot scan EXACTLY as it was given', () => {
    for (const source of UNSCANNABLE) {
      expect(formatMolang(source), `format mangled ${JSON.stringify(source)}`).toBe(source)
      expect(minifyMolang(source), `minify mangled ${JSON.stringify(source)}`).toBe(source)
      expect(isFormattable(source), `${JSON.stringify(source)} was reported as formattable`).toBe(false)
    }
  })

  it('never touches the inside of a string literal', () => {
    // Tag names hold spaces, colons and capitals, and a rewriter that normalised any of those
    // would change which biomes a feature places in -- silently, because the expression would
    // still compile and still evaluate, to the wrong answer.
    const tags = ["'minecraft:forest'", "'warm ocean'", "'  leading and trailing  '", "'a,b,c'", "'x = y'", "'1 + 1'"]
    for (const tag of tags) {
      for (const source of [`query.any_tag(${tag})`, `v.x = ${tag} == ${tag};`, `query.has_biome_tag(${tag}, 1, 2, 3)`]) {
        expect(formatMolang(source)).toContain(tag)
        expect(minifyMolang(source)).toContain(tag)
      }
    }
  })

  it('drops whitespace it is free to drop, and only that', () => {
    // `variable.trunk_height = ` scans perfectly well -- a name and an operator -- so it is NOT in
    // the refused list above, and the trailing space goes. That is the right answer and worth
    // pinning: the rewrites are pure functions of the token stream, so input whitespace has no
    // way to survive, and the only reason this is safe is that they run on load and on blur and
    // never under a moving caret.
    expect(formatMolang('variable.trunk_height = ')).toBe('variable.trunk_height =')
    expect(formatMolang('   v.x   =   1   ')).toBe('v.x = 1')
  })

  it('leaves an empty expression empty', () => {
    expect(formatMolang('')).toBe('')
    expect(minifyMolang('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// What a person actually sees
// ---------------------------------------------------------------------------

describe('the readable form', () => {
  it('puts one statement on each line', () => {
    expect(formatMolang('v.a=1;v.b=2;return v.a+v.b;')).toBe('v.a = 1;\nv.b = 2;\nreturn v.a + v.b;')
  })

  it('indents a block', () => {
    expect(formatMolang('loop(10,{v.x=v.x+1;});')).toBe('loop(10, {\n  v.x = v.x + 1;\n});')
  })

  it('keeps a call tight against its name and spaces its arguments', () => {
    expect(formatMolang('math.random_integer(3,9)')).toBe('math.random_integer(3, 9)')
    expect(formatMolang('query.noise(v.originx/128,v.originz/128)>0.4')).toBe(
      'query.noise(v.originx / 128, v.originz / 128) > 0.4',
    )
  })

  it('does not put a space after a minus that is negating rather than subtracting', () => {
    expect(formatMolang('-5')).toBe('-5')
    expect(formatMolang('v.x*-1')).toBe('v.x * -1')
    expect(formatMolang('v.x - -1')).toBe('v.x - -1')
    expect(formatMolang('!v.flag')).toBe('!v.flag')
  })

  it('spaces a grouping parenthesis but not a call parenthesis', () => {
    expect(formatMolang('2*(1+2)')).toBe('2 * (1 + 2)')
    expect(formatMolang('math.max(1,2)')).toBe('math.max(1, 2)')
  })

  it('lays out the long one-liner a real pack writes', () => {
    const real =
      "v.trunk=4+math.random_integer(0,3);v.lean=(q.noise(v.originx/64,v.originz/64)>0.3)*2;return q.has_biome_tag('minecraft:forest')?1:0;"
    expect(formatMolang(real)).toBe(
      'v.trunk = 4 + math.random_integer(0, 3);\n' +
        'v.lean = (q.noise(v.originx / 64, v.originz / 64) > 0.3) * 2;\n' +
        "return q.has_biome_tag('minecraft:forest') ? 1 : 0;",
    )
  })
})

describe('the compact form', () => {
  it('is one line with no space it can do without', () => {
    expect(minifyMolang('v.a = 1;\nv.b = 2;\nreturn v.a + v.b;')).toBe('v.a=1;v.b=2;return v.a+v.b;')
  })

  it('keeps the one space a keyword needs', () => {
    // `return1` is a name, not a return of 1. This is the case a regex-based minifier gets wrong.
    expect(minifyMolang('return 1;')).toBe('return 1;')
    expect(minifyMolang('v.x = 1; return v.x;')).toBe('v.x=1;return v.x;')
  })

  it('keeps two operators from fusing into a third', () => {
    for (const [source, notExpected] of [
      ['v.x - -1', '--'],
      ['v.x + +1', '++'],
      ['v.x - +1', '-+'],
    ] as const) {
      expect(minifyMolang(source)).not.toContain(notExpected)
      expect(signature(minifyMolang(source))).toBe(signature(source))
    }
  })

  it('does not separate operators that cannot fuse', () => {
    expect(minifyMolang('v.a && !v.b')).toBe('v.a&&!v.b')
    expect(minifyMolang('v.x * -1')).toBe('v.x*-1')
  })
})

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

describe('the scanner', () => {
  it('reads a dotted name as one token, so no spacing rule can ever split it', () => {
    expect(tokenizeMolang('variable.trunk_height')?.map((t) => [t.kind, t.text])).toEqual([
      ['name', 'variable.trunk_height'],
    ])
  })

  it('reads a string as one token, quotes included, however it is spelled inside', () => {
    expect(tokenizeMolang("q.any_tag('a b, c')")?.map((t) => t.text)).toEqual([
      'q.any_tag',
      '(',
      "'a b, c'",
      ')',
    ])
  })

  it('gives up on a digit run that butts into a letter, rather than splitting it', () => {
    // `1e5` would scan as `1` then `e5`, and a formatter free to put a space between them would
    // turn an exponent into two tokens. Refusing the text is the only safe answer this scanner can
    // give without knowing whether the engine reads exponents.
    expect(tokenizeMolang('1e5')).toBeNull()
  })

  it('gives up on unbalanced brackets', () => {
    expect(tokenizeMolang('math.max(1, 2')).toBeNull()
    expect(tokenizeMolang('math.max(1, 2))')).toBeNull()
    expect(tokenizeMolang('loop(2, {v.x = 1;)}')).toBeNull()
  })

  it('keeps going in lenient mode, which is what the highlighter needs', () => {
    // Everything a field holds between one keystroke and the next has to come back as SOMETHING,
    // or the colour blinks off while the author types.
    for (const halfTyped of ['v.', "q.any_tag('for", 'math.max(1,', '1e']) {
      const tokens = tokenizeMolang(halfTyped, { lenient: true })
      expect(tokens, halfTyped).not.toBeNull()
      expect(tokens!.map((t) => t.text).join('')).toBe(halfTyped.replace(/\s/g, ''))
    }
  })

  it('reports offsets into the ORIGINAL text, so a highlighter can lay spans over it', () => {
    const source = "  v.x = q.any_tag('a')  "
    for (const token of tokenizeMolang(source) ?? []) {
      expect(source.slice(token.offset, token.offset + token.text.length)).toBe(token.text)
    }
  })
})
