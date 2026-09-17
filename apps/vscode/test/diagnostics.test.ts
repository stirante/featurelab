// diagnostics.test.ts covers the fileId matching in src/diagnostics.ts. It exists because
// matching only the document basename silently dropped every PLACEMENT-time diagnostic: the
// engine puts the pack loader's basename in fileId for build/parse problems, but the requested
// IDENTIFIER for placement ones. A feature that legitimately places nothing therefore produced
// an empty Problems panel -- the exact case where the explanation matters most.
import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import { updateDiagnostics, type DiagnosticWireLike } from '../src/diagnostics.js'

function fakeDocument() {
  return {
    uri: { toString: () => 'file:///pack/features/pumpkin_patch.json' },
    fileName: '/pack/features/pumpkin_patch.json',
    lineCount: 3,
    lineAt: (_n: number) => ({ text: '  }' }),
  } as unknown as import('vscode').TextDocument
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

  it('ignores an empty id rather than matching diagnostics with an empty fileId', () => {
    const { collection, sets, deletes } = fakeCollection()
    const emptyFileId: DiagnosticWireLike = { level: 'warning', fileId: '', message: 'no file' }
    updateDiagnostics(collection, fakeDocument(), ['pumpkin_patch.json', ''], [emptyFileId])
    expect(sets).toHaveLength(0)
    expect(deletes).toHaveLength(1)
  })
})
