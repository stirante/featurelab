// molangFormat.ts -- one scanner over Molang source text, and the two rewrites built on it:
// `formatMolang` for the screen and `minifyMolang` for the file.
//
// # Why a pack needs both spellings of the same expression
//
// Real packs write a scatter's setup script as one enormous line -- several `v.* = ...;`
// assignments, a ternary or two, `math.*` calls, a trailing `return ...;` -- because JSON has no
// other shape to put it in. That line is the correct thing to have on disk (it is what diffs,
// what the game reads, and what every other tool in the pack expects) and it is unreadable in a
// three-row text box. So the editor shows the formatted text and the file receives the minified
// one, and these two functions are the only place either transformation happens.
//
// # The correctness bar, and how it is met
//
// A formatter that mangles one unusual expression is worse than no formatter at all, because the
// mangling lands in somebody's pack and the pack is the thing they cannot get back. So the rule
// here is absolute: EVERY OUTPUT EITHER HAS THE SAME TOKEN STREAM AS ITS INPUT OR IS ITS INPUT,
// BYTE FOR BYTE. Nothing in between is reachable.
//
// It is enforced structurally rather than by care:
//
//  1. `tokenize` is STRICT. Anything it does not recognise -- an unterminated string, a stray
//     `"`, `1e5` (a digit run followed by a letter, which this scanner would split), a `.` with
//     no member after it, an unbalanced bracket -- makes it return null, and both functions then
//     return their input untouched. Half-typed and unusual text is left alone by construction.
//  2. Both rewrites are pure functions of the token stream: input whitespace is discarded, never
//     inspected. So two inputs with the same tokens produce the same output.
//  3. Every candidate output is RE-TOKENIZED and compared to the input's stream before it is
//     returned. If the two differ in any way the candidate is thrown away and the input is
//     returned. This is what makes a spacing bug cost a missed minification instead of a
//     corrupted file.
//
// Three properties follow from those, and are tested as properties rather than as examples:
//
//   - `minify(format(x)) === minify(x)` for every x. `format` deliberately bails whenever
//     `minify` would (see formatMolang), so the two can never disagree about which inputs they
//     decline -- the one way that identity could otherwise break.
//   - `format(format(x)) === format(x)`.
//   - an input that cannot be tokenized comes back identical from both.
//
// # String literals
//
// Single-quoted strings are the one place Molang holds text a human chose -- a biome tag is
// `'minecraft:forest'` and can contain spaces -- so a string token is copied out verbatim,
// quotes included, and nothing in this file ever looks inside one. molangHints.ts's `maskStrings`
// is the same rule expressed for a scanner that only needs offsets; this one needs the bytes.

/** What a token IS, for the purposes of spacing. Deliberately coarse: this file decides where
 * whitespace may go, not what an expression means, and a grammar would be a second parser to
 * keep in step with the engine's. */
export type MolangTokenKind =
  /** A single-quoted literal, quotes included, copied verbatim. */
  | 'string'
  /** A digit run, possibly with one decimal point. */
  | 'number'
  /** An identifier, INCLUDING its dots: `variable.originx` and `return` are each one token. Dots
   * are folded in so no spacing rule ever has to special-case them, and so a trailing `.` (the
   * state a field is in while somebody types `v.`) is a scanning failure rather than a token. */
  | 'name'
  /** `+ - * / % ! < > = ? :` and the multi-character forms below. */
  | 'operator'
  /** `( ) [ ] { } , ;` -- the characters that structure rather than combine. */
  | 'punct'
  /** Lenient scanning only: one character this scanner has no rule for. Never produced by a
   * strict scan, which returns null instead. */
  | 'unknown'

export interface MolangToken {
  kind: MolangTokenKind
  /** The source text of this token, verbatim. */
  text: string
  /** Offset into the ORIGINAL source, so a highlighter can lay spans over it. */
  offset: number
}

/** Every multi-character operator, longest first so the scan is maximal-munch.
 *
 * `->` is here although worldgen Molang has no use for it: an operator this file does not know is
 * an operator it would split into two, and the re-tokenize guard would then refuse to touch the
 * whole expression. Knowing one too many costs nothing. */
const MULTI_OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '??', '->'] as const
const SINGLE_OPERATORS = '+-*/%!<>=?:'
const PUNCTUATION = '()[]{},;'
const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' }

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isNameStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_'
}

function isNamePart(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch)
}

export interface TokenizeOptions {
  /**
   * Keep going past text this scanner has no rule for, emitting it as `unknown`, instead of
   * giving up.
   *
   * For the HIGHLIGHTER, and for nothing else. A field being typed into spends most of its life
   * holding text that is not yet valid -- `v.`, a string with no closing quote, half a number --
   * and a highlighter that blanked itself on every one of those would flicker the colour off and
   * on under the author's hands. The rewrites use the strict scan, where "I do not recognise
   * this" has to mean "do not touch it".
   */
  lenient?: boolean
}

/**
 * Splits `source` into tokens.
 *
 * Returns null when the text cannot be scanned confidently and `lenient` is not set: an
 * unterminated string, a character with no rule, a digit run butting straight into a letter
 * (`1e5` -- exponent notation this scanner would silently split into `1` and `e5`), a name ending
 * in a dot, or brackets that do not balance. Every one of those is a reason to leave the author's
 * text exactly as they wrote it.
 */
export function tokenizeMolang(source: string, options: TokenizeOptions = {}): MolangToken[] | null {
  const lenient = options.lenient === true
  const tokens: MolangToken[] = []
  const stack: string[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++
      continue
    }
    if (ch === "'") {
      const close = source.indexOf("'", i + 1)
      if (close < 0) {
        // Still being typed, or genuinely broken. Either way the bytes after the quote are text
        // somebody wrote and not code, so a strict scan refuses the whole expression.
        if (!lenient) return null
        tokens.push({ kind: 'string', text: source.slice(i), offset: i })
        i = source.length
        continue
      }
      tokens.push({ kind: 'string', text: source.slice(i, close + 1), offset: i })
      i = close + 1
      continue
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i
      while (i < source.length && isDigit(source[i]!)) i++
      if (source[i] === '.') {
        i++
        while (i < source.length && isDigit(source[i]!)) i++
      }
      // `1e5`, `3px`: a number running straight into a name. This scanner would split it, the
      // rewrites would then be free to put a space in the middle, and the result would be a
      // different expression. Refuse the text instead.
      if (i < source.length && isNameStart(source[i]!)) {
        if (!lenient) return null
        while (i < source.length && isNamePart(source[i]!)) i++
        tokens.push({ kind: 'unknown', text: source.slice(start, i), offset: start })
        continue
      }
      tokens.push({ kind: 'number', text: source.slice(start, i), offset: start })
      continue
    }
    if (isNameStart(ch)) {
      const start = i
      for (;;) {
        while (i < source.length && isNamePart(source[i]!)) i++
        if (source[i] === '.' && isNameStart(source[i + 1] ?? '')) {
          i++
          continue
        }
        break
      }
      if (source[i] === '.') {
        // `v.` -- a namespace with nothing after it, which is what a field holds for the moment
        // between typing the dot and typing the member.
        if (!lenient) return null
        i++
        tokens.push({ kind: 'unknown', text: source.slice(start, i), offset: start })
        continue
      }
      tokens.push({ kind: 'name', text: source.slice(start, i), offset: start })
      continue
    }
    const two = source.slice(i, i + 2)
    if ((MULTI_OPERATORS as readonly string[]).includes(two)) {
      tokens.push({ kind: 'operator', text: two, offset: i })
      i += 2
      continue
    }
    if (SINGLE_OPERATORS.includes(ch)) {
      tokens.push({ kind: 'operator', text: ch, offset: i })
      i++
      continue
    }
    if (PUNCTUATION.includes(ch)) {
      if (OPENERS[ch] !== undefined) stack.push(OPENERS[ch]!)
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (stack.pop() !== ch && !lenient) return null
      }
      tokens.push({ kind: 'punct', text: ch, offset: i })
      i++
      continue
    }
    if (!lenient) return null
    tokens.push({ kind: 'unknown', text: ch, offset: i })
    i++
  }
  // An unclosed bracket means the expression is mid-edit. Formatting it would have to guess at an
  // indent level that does not exist yet, and minifying it would produce a compact version of
  // something that is not an expression.
  if (!lenient && stack.length > 0) return null
  return tokens
}

/** True when the token at `index` is a PREFIX operator rather than a binary one -- the `-` of
 * `-5` and the `!` of `!v.x`, which take no space after them.
 *
 * Decided from what precedes it, which is the only information available without a parser and is
 * enough: a `-` can only be binary after something a value can end with. */
function isPrefix(tokens: readonly MolangToken[], index: number): boolean {
  const token = tokens[index]
  if (token === undefined || token.kind !== 'operator') return false
  if (token.text !== '-' && token.text !== '!' && token.text !== '+') return false
  const previous = tokens[index - 1]
  if (previous === undefined) return true
  if (previous.kind === 'operator') return true
  if (previous.kind === 'punct') return previous.text !== ')' && previous.text !== ']' && previous.text !== '}'
  return false
}

/** Whether two adjacent operators would fuse into a different operator with no space between
 * them: `=` then `=` is `==`, `-` then `>` is `->`. The `+`/`-` pairs are included although
 * Molang has no `++` or `--`, because a reader (and possibly a parser) would see one. */
function operatorsWouldFuse(left: string, right: string): boolean {
  const joint = left.slice(-1) + right.slice(0, 1)
  if (MULTI_OPERATORS.some((op) => op.startsWith(joint))) return true
  return '+-'.includes(joint[0]!) && '+-'.includes(joint[1]!)
}

/** The token stream as a comparable string. Used only for the guard, so it has to distinguish
 * everything a rewrite could accidentally change -- which is the text and the kind of every
 * token, in order, and nothing about where they were. */
function signature(tokens: readonly MolangToken[]): string {
  return tokens.map((t) => `${t.kind} ${t.text}`).join('')
}

/** Returns `candidate` when it scans back to exactly `tokens`, and null otherwise.
 *
 * THE GUARD. Every spacing rule in this file is a judgement call and any of them could be wrong
 * about some expression nobody has written yet; this is the one thing that is not a judgement
 * call. A rewrite that changed what the text says cannot get past it, so the cost of a spacing
 * bug is an expression that does not get reformatted rather than one that stops working. */
function verified(candidate: string, tokens: readonly MolangToken[]): string | null {
  const round = tokenizeMolang(candidate)
  if (round === null) return null
  return signature(round) === signature(tokens) ? candidate : null
}

/** Builds the one-line form from a token stream. Pure in the token stream: no input whitespace
 * reaches it, which is what makes `minify(format(x)) === minify(x)` hold. */
function compact(tokens: readonly MolangToken[]): string {
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const previous = tokens[i - 1]
    if (previous !== undefined && spaceRequired(previous, token)) out += ' '
    out += token.text
  }
  return out
}

/** The only two places a minified expression may keep a space.
 *
 * Both are cases where removing it would fuse two tokens into one: `return 1` would become the
 * name `return1`, and `a - -1` would become `a--1`. Everything else is joined. */
function spaceRequired(previous: MolangToken, token: MolangToken): boolean {
  const valueish = (t: MolangToken): boolean => t.kind === 'name' || t.kind === 'number'
  if (valueish(previous) && valueish(token)) return true
  if (previous.kind === 'operator' && token.kind === 'operator') {
    return operatorsWouldFuse(previous.text, token.text)
  }
  return false
}

/**
 * The one-line form, for the file.
 *
 * Returns `source` unchanged when it cannot be scanned, or when the compacted text does not scan
 * back to the same tokens. A caller may therefore always write the result: it is either the same
 * expression spelled shorter, or the author's own bytes.
 */
export function minifyMolang(source: string): string {
  const tokens = tokenizeMolang(source)
  if (tokens === null) return source
  return verified(compact(tokens), tokens) ?? source
}

/** Where a space goes in the READABLE form. Generous by comparison with `spaceRequired`: this one
 * is about a person reading three rows of a text box, not about bytes.
 *
 * The rules, in the order they are applied:
 *   - nothing before a `,` `;` `)` `]`, and nothing after a `(` `[`;
 *   - nothing after a prefix `-` or `!`, so `-5` stays `-5`;
 *   - no space before a `(` that FOLLOWS A NAME, which is what distinguishes the call
 *     `math.max(1, 2)` from the grouping `2 * (1 + 2)`;
 *   - a space on both sides of every other operator, and after every comma;
 *   - a space between two things that would otherwise touch.
 */
function spacePreferred(previous: MolangToken | undefined, token: MolangToken, previousIsPrefix: boolean): boolean {
  if (previous === undefined) return false
  if (token.text === ',' || token.text === ';' || token.text === ')' || token.text === ']') return false
  if (previous.text === '(' || previous.text === '[') return false
  if (previousIsPrefix) return false
  if (token.text === '(' || token.text === '[') {
    return !(previous.kind === 'name' || previous.text === ')' || previous.text === ']')
  }
  return true
}

/**
 * The readable form, for the screen: one statement per line, nested blocks indented.
 *
 * Returns `source` unchanged for anything it cannot scan, AND for anything `minifyMolang` would
 * decline. That second condition looks like over-caution and is the thing that makes
 * `minify(format(x)) === minify(x)` true for every input rather than for most of them: if the two
 * functions could disagree about which expressions they refuse, an expression minify gave up on
 * would still be reformatted, and minifying the formatted text would then return the FORMATTED
 * text where minifying the original returned the original.
 */
export function formatMolang(source: string): string {
  const tokens = tokenizeMolang(source)
  if (tokens === null) return source
  if (verified(compact(tokens), tokens) === null) return source

  const lines: string[] = []
  let current = ''
  let indent = 0
  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed.length > 0) lines.push('  '.repeat(Math.max(indent, 0)) + trimmed)
    current = ''
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const previous = tokens[i - 1]
    const previousIsPrefix = i > 0 && isPrefix(tokens, i - 1)
    if (token.text === ';') {
      current += ';'
      flush()
      continue
    }
    if (token.text === '{') {
      if (spacePreferred(previous, token, previousIsPrefix)) current += ' '
      current += '{'
      flush()
      indent++
      continue
    }
    if (token.text === '}') {
      flush()
      indent--
      current = '}'
      continue
    }
    if (spacePreferred(previous, token, previousIsPrefix)) current += ' '
    current += token.text
  }
  flush()
  return verified(lines.join('\n'), tokens) ?? source
}

/** True when `source` scans, i.e. when the two rewrites above will actually do something.
 *
 * Exported for the UI, which offers the "keep this readable in the file" choice only where it
 * means anything: on text the formatter has declined, the formatted and minified spellings are
 * the same bytes and the checkbox would be a control that does nothing. */
export function isFormattable(source: string): boolean {
  const tokens = tokenizeMolang(source)
  if (tokens === null) return false
  return verified(compact(tokens), tokens) !== null
}
