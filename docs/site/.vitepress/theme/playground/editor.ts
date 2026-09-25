// The playground's JSON editor is a plain <textarea>. A code editor component would be the
// largest thing on the page after the engine itself, and what a reader needs here is small:
// indentation that behaves, Enter that keeps it, and the line a syntax error is on.

const INDENT = '  '

/** Inserts `text` over the current selection. execCommand keeps the browser's own undo history
 * (Ctrl+Z undoes a Tab like any other keystroke); setRangeText is the fallback where it is gone. */
function insert(ta: HTMLTextAreaElement, text: string): void {
  ta.focus()
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

/** Indents (or, with `out`, outdents) every line the selection touches, keeping them selected. */
function shiftLines(ta: HTMLTextAreaElement, out: boolean): void {
  const value = ta.value
  const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1
  let end = ta.selectionEnd
  // A selection ending at the very start of a line does not include that line.
  if (end > start && value[end - 1] === '\n') end--
  const lineEnd = value.indexOf('\n', end)
  const stop = lineEnd < 0 ? value.length : lineEnd
  const lines = value.slice(start, stop).split('\n')
  const shifted = lines.map((l) => (out ? l.replace(/^ {1,2}/, '') : INDENT + l)).join('\n')
  ta.setSelectionRange(start, stop)
  insert(ta, shifted)
  ta.setSelectionRange(start, start + shifted.length)
}

export interface KeyResult {
  /** The reader asked to run (Ctrl/Cmd+Enter). */
  run?: boolean
}

/** Tab leaves the textarea only right after Escape, the convention code editors use so that a
 * keyboard user is never trapped in a field where Tab means "indent". */
let escapeArmed = false

export function handleEditorKey(ev: KeyboardEvent, ta: HTMLTextAreaElement): KeyResult {
  if (ev.key === 'Escape') {
    escapeArmed = true
    return {}
  }
  const armed = escapeArmed
  escapeArmed = false

  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault()
    // The shared panel also runs on Ctrl+Enter, from a document-level listener. Stopping here
    // makes one keystroke one run.
    ev.stopPropagation()
    return { run: true }
  }

  if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    if (armed) return {}
    ev.preventDefault()
    const multiLine = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')
    if (ev.shiftKey || multiLine) shiftLines(ta, ev.shiftKey)
    else insert(ta, INDENT)
    return {}
  }

  if (ev.key === 'Enter' && !ev.shiftKey && !ev.altKey) {
    ev.preventDefault()
    const value = ta.value
    const pos = ta.selectionStart
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1
    const indent = /^[ \t]*/.exec(value.slice(lineStart, pos))![0]
    const before = value.slice(lineStart, pos).trimEnd().slice(-1)
    const after = value.slice(ta.selectionEnd).trimStart()[0]
    if (before === '{' || before === '[') {
      const closes = (before === '{' && after === '}') || (before === '[' && after === ']')
      if (closes) {
        // Between a pair: open a line inside it and put the closer on its own line.
        insert(ta, `\n${indent}${INDENT}\n${indent}`)
        const caret = ta.selectionStart - indent.length - 1
        ta.setSelectionRange(caret, caret)
      } else {
        insert(ta, `\n${indent}${INDENT}`)
      }
    } else {
      insert(ta, `\n${indent}`)
    }
    return {}
  }
  return {}
}

export interface JsonProblem {
  line: number
  column: number
  message: string
}

/** The first syntax error in `text`, as the game would see it, or null.
 *
 * Not JSON.parse, for two reasons. The game reads pack JSON with `//` and `/* *\/` comments
 * allowed and a trailing comma NOT allowed (the engine does the same; see jsonc/strip.go), and
 * JSON.parse rejects the first and has no special word for the second. And browsers disagree
 * about saying where: Chrome gives a position for some errors and not others, Safari never
 * does. A reader needs the line every time, so this walks the text itself. */
export function jsonProblem(text: string): JsonProblem | null {
  let i = 0
  const fail = (at: number, message: string): never => {
    throw Object.assign(new Error(message), { at })
  }
  const skip = (): void => {
    for (;;) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') i++
      else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        if (end < 0) fail(i, 'This comment is never closed with */')
        i = end + 2
      } else return
    }
  }
  const describe = (at: number): string => (at >= text.length ? 'the file ends' : `found ${JSON.stringify(text[at])}`)
  const string = (): void => {
    const start = i++
    for (;;) {
      const c = text[i]
      if (c === undefined || c === '\n') fail(start, 'This string is never closed with a "')
      if (c === '"') {
        i++
        return
      }
      i += c === '\\' ? 2 : 1
    }
  }
  const value = (): void => {
    skip()
    const c = text[i]
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      i++
      skip()
      if (text[i] === close) {
        i++
        return
      }
      for (;;) {
        skip()
        if (c === '{') {
          if (text[i] !== '"') fail(i, `Expected a key in double quotes, ${describe(i)}`)
          string()
          skip()
          if (text[i] !== ':') fail(i, `Expected ':' after the key, ${describe(i)}`)
          i++
        }
        value()
        skip()
        if (text[i] === ',') {
          const comma = i++
          skip()
          if (text[i] === close) fail(comma, `Trailing comma: remove the comma before '${close}' (the game does not accept one)`)
          continue
        }
        if (text[i] === close) {
          i++
          return
        }
        fail(i, `Expected ',' or '${close}', ${describe(i)}`)
      }
    }
    if (c === '"') return string()
    const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64))
    if (!m) fail(i, `Expected a value, ${describe(i)}`)
    i += m![0].length
  }
  try {
    value()
    skip()
    if (i < text.length) fail(i, `Unexpected text after the end of the JSON, ${describe(i)}`)
    return null
  } catch (err) {
    const at = (err as { at?: number }).at ?? 0
    const before = text.slice(0, at)
    return {
      line: before.split('\n').length,
      column: at - before.lastIndexOf('\n'),
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

