// diagnostics.test.ts covers the fileId matching in src/diagnostics.ts. It exists because
// matching only the document basename silently dropped every PLACEMENT-time diagnostic: the
// engine puts the pack loader's basename in fileId for build/parse problems, but the requested
// IDENTIFIER for placement ones. A feature that legitimately places nothing therefore produced
// an empty Problems panel -- the exact case where the explanation matters most.
import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import { updateDiagnostics, type DiagnosticWireLike } from '../src/diagnostics.js'

/** Four lines, each a different length, so a range that lands on the wrong one is visible in the
 * assertion rather than coincidentally right. */
const LINES = ['{', '  "format_version": "1.21.0",', '  "minecraft:simple_feature": {', '  }']

function fakeDocument() {
  return {
    uri: { toString: () => 'file:///pack/features/pumpkin_patch.json' },
    fileName: '/pack/features/pumpkin_patch.json',
    lineCount: LINES.length,
    lineAt: (n: number) => ({ text: LINES[n] ?? '' }),
  } as unknown as import('vscode').TextDocument
}

/** The range one diagnostic was marked with, as plain numbers. */
function rangeOf(diagnostic: unknown): { startLine: number; startChar: number; endLine: number; endChar: number } {
  return (diagnostic as { range: { startLine: number; startChar: number; endLine: number; endChar: number } }).range
}

function fakeCollection() {
  const sets: Array<{ uri: unknown; diagnostics: unknown[] }> = []
  const deletes: unknown[] = []
  return {
    collection: {
      set: (uri: unknown, diagnostics: unknown[]) => sets.push({ uri, diagnostics }),
      delete: (uri: unknown) => deletes.push(uri),
      dispose: () => {},
    } as unknown as import('vscode').DiagnosticCollection,
    sets,
    deletes,
  }
}

const buildTime: DiagnosticWireLike = {
  level: 'warning',
  fileId: 'pumpkin_patch.json',
  message: 'places_block[0] carries a directional state',
}
const placement: DiagnosticWireLike = {
  level: 'warning',
  fileId: 'wiki:pumpkin_patch',
  identifier: 'wiki:pumpkin_patch_block',
  message: 'iterations evaluated to zero, so nothing was placed',
}
const unrelated: DiagnosticWireLike = {
  level: 'error',
  fileId: 'some_other_file.json',
  message: 'invalid JSON',
}

describe('updateDiagnostics', () => {
  it('surfaces placement diagnostics, which carry the requested identifier as fileId', () => {
    const { collection, sets } = fakeCollection()
    updateDiagnostics(collection, fakeDocument(), ['pumpkin_patch.json', 'wiki:pumpkin_patch'], [placement])
    expect(sets).toHaveLength(1)
    expect(sets[0]!.diagnostics).toHaveLength(1)
  })

  it('surfaces build-time diagnostics, which carry the basename as fileId', () => {
    const { collection, sets } = fakeCollection()
    updateDiagnostics(collection, fakeDocument(), ['pumpkin_patch.json', 'wiki:pumpkin_patch'], [buildTime])
    expect(sets).toHaveLength(1)
    expect(sets[0]!.diagnostics).toHaveLength(1)
  })

  it('surfaces both kinds at once and still excludes other files', () => {
    const { collection, sets } = fakeCollection()
    updateDiagnostics(
      collection,
      fakeDocument(),
      ['pumpkin_patch.json', 'wiki:pumpkin_patch'],
      [buildTime, placement, unrelated],
    )
    expect(sets[0]!.diagnostics).toHaveLength(2)
  })

  it('clears the collection when nothing matches', () => {
    const { collection, sets, deletes } = fakeCollection()
    updateDiagnostics(collection, fakeDocument(), ['pumpkin_patch.json', 'wiki:pumpkin_patch'], [unrelated])
    expect(sets).toHaveLength(0)
    expect(deletes).toHaveLength(1)
  })

  it('marks the position the engine reported, not the whole file', () => {
    // WHY THIS MATTERS. "invalid JSON at line 2, column 20" used to produce a squiggle over the
    // entire document, which in the Problems panel is a file-level entry: the reader is told
    // their file is broken and then has to find the comma themselves, with the position sitting
    // unread in the message. The engine now sends it structurally as well as in the prose.
    const { collection, sets } = fakeCollection()
    const located: DiagnosticWireLike = {
      level: 'error',
      fileId: 'pumpkin_patch.json',
      scope: 'pack',
      line: 2,
      column: 20,
      message: 'invalid JSON at line 2, column 20: invalid character',
    }
    updateDiagnostics(collection, fakeDocument(), ['pumpkin_patch.json'], [located])
    const range = rangeOf(sets[0]!.diagnostics[0])
    // 1-based on the wire, 0-based in VS Code: line 2 is index 1, column 20 is index 19.
    expect(range.startLine).toBe(1)
    expect(range.startChar).toBe(19)
    // To the end of that line rather than one character: the loader reports where it STOPPED
    // reading, not how much of what follows is wrong, and a one-character mark on a line of JSON
    // reads as a rendering artefact.
    expect(range.endLine).toBe(1)
    expect(range.endChar).toBe(LINES[1]!.length)
  })

  it('marks the line when only a line is known', () => {
    const { collection, sets } = fakeCollection()
    updateDiagnostics(
      collection,
      fakeDocument(),
      ['pumpkin_patch.json'],
      [{ level: 'error', fileId: 'pumpkin_patch.json', line: 3, message: 'something about line 3' }],
    )
    const range = rangeOf(sets[0]!.diagnostics[0])
    expect(range.startLine).toBe(2)
    expect(range.startChar).toBe(0)
  })

  it('still spans the whole file for a diagnostic with no position', () => {
    // Most of them. A refused placement is about a feature, not about a character, and picking a
    // character for it would be a guess wearing the authority of a squiggle.
    const { collection, sets } = fakeCollection()
    updateDiagnostics(collection, fakeDocument(), ['wiki:pumpkin_patch'], [placement])
    const range = rangeOf(sets[0]!.diagnostics[0])
    expect(range.startLine).toBe(0)
    expect(range.startChar).toBe(0)
    expect(range.endLine).toBe(LINES.length - 1)
  })

  it('falls back to the whole file for a line the document does not have', () => {
    // A diagnostic from before an edit that shortened the file. Marking line 99 of a four-line
    // document is not something to attempt; saying "this file" is still true.
    const { collection, sets } = fakeCollection()
    updateDiagnostics(
      collection,
      fakeDocument(),
      ['pumpkin_patch.json'],
      [{ level: 'error', fileId: 'pumpkin_patch.json', line: 99, column: 4, message: 'stale' }],
    )
    const range = rangeOf(sets[0]!.diagnostics[0])
    expect(range.startLine).toBe(0)
    expect(range.endLine).toBe(LINES.length - 1)
  })

  it('clamps a column past the end of its line rather than pointing past it', () => {
    const { collection, sets } = fakeCollection()
    updateDiagnostics(
      collection,
      fakeDocument(),
      ['pumpkin_patch.json'],
      [{ level: 'error', fileId: 'pumpkin_patch.json', line: 1, column: 400, message: 'unexpected end of JSON input' }],
    )
    const range = rangeOf(sets[0]!.diagnostics[0])
    expect(range.startLine).toBe(0)
    expect(range.startChar).toBe(LINES[0]!.length)
    expect(range.endChar).toBe(LINES[0]!.length)
  })

  it('ignores an empty id rather than matching diagnostics with an empty fileId', () => {
    const { collection, sets, deletes } = fakeCollection()
    const emptyFileId: DiagnosticWireLike = { level: 'warning', fileId: '', message: 'no file' }
    updateDiagnostics(collection, fakeDocument(), ['pumpkin_patch.json', ''], [emptyFileId])
    expect(sets).toHaveLength(0)
    expect(deletes).toHaveLength(1)
  })
})
