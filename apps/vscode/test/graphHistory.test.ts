// graphHistory.test.ts -- the graph panel's undo, its delete confirmation, its retry and the
// sentences it sends the canvas about the pack itself.
//
// WHY THIS SUITE EXISTS. Four separate reports, one shape: the editor did something irreversible
// and said nothing about it.
//
//   - Typing in an inspector field and pressing Tab rewrote a .json on disk. No dirty state, no
//     save step, no history; Ctrl+Z did nothing.
//   - Deleting a node deleted its file. The confirmation only appeared when something still
//     referred to it -- so the commonest delete, of a node nothing uses, was one click.
//   - A failed load left the panel dead until the window was reloaded.
//   - A pack directory that is not there loads successfully with zero features, so the canvas
//     told the author "this pack declares no features yet" when the real answer was "that is not
//     the pack you meant".
//
// It drives the REAL src/graphPanel.ts, with a controller that writes real files -- because every
// one of the above is a claim about what is on disk afterwards, and a controller that only
// recorded calls would make it a claim about a fake.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import { vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscodeMock from './fixtures/vscodeMock.js'
import { DELETE_CONFIRM, GraphPanel, missingFeaturesDirectoryWarning } from '../src/graphPanel.js'
import type { PreviewController } from '../src/previewController.js'

const temporary: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

function feature(identifier: string): string {
  return JSON.stringify(
    { format_version: '1.21.110', 'minecraft:single_block_feature': { description: { identifier } } },
    null,
    2,
  )
}

/** A pack on disk. Real files: the journal snapshots bytes, so a fake filesystem would be testing
 * the fake. */
function makePack(files: Record<string, string> = {}, options: { features?: boolean } = {}): string {
  const root = tempDir('fl-hist-')
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"format_version":2}', 'utf8')
  if (options.features !== false) fs.mkdirSync(path.join(root, 'features'), { recursive: true })
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }
  return root
}

/** A stand-in for the engine that WRITES. Only the methods GraphPanel reaches for, each doing the
 * smallest real thing that makes the panel's own behaviour observable: applyEdits rewrites the
 * file, createFiles creates them, deleteFeature removes one. */
class FakeEngine {
  /** Every method call, in order, as `name:detail` -- so "did this even reach the engine" is
   * decidable after a cancelled confirmation. */
  readonly calls: string[] = []
  /** Set to a message to make the next graph() reject, the way a pack that will not load does. */
  graphFails: string | null = null
  warnings: string[] = []
  nodes: { id: string; file?: string }[] = []

  graph(): Promise<unknown> {
    this.calls.push('graph')
    if (this.graphFails !== null) return Promise.reject(new Error(this.graphFails))
    return Promise.resolve({ nodes: this.nodes, edges: [], diagnostics: [] })
  }
  listTypes(): Promise<unknown> {
    return Promise.resolve({ types: [] })
  }
  loadPackSummary(): Promise<unknown> {
    return Promise.resolve({ warnings: this.warnings, featureCount: this.nodes.length, ruleCount: 0, structureCount: 0, biomeCount: 0 })
  }
  reloadPack(): Promise<unknown> {
    this.calls.push('reloadPack')
    return Promise.resolve({ warnings: this.warnings, featureCount: 0, ruleCount: 0, structureCount: 0, biomeCount: 0 })
  }
  reloadPackFile(): Promise<unknown> {
    return Promise.resolve({ warnings: this.warnings, featureCount: 0, ruleCount: 0, structureCount: 0, biomeCount: 0 })
  }
  applyEdits(packRoot: string, file: string, edits: readonly { path: string; value?: string }[]): Promise<unknown> {
    this.calls.push(`applyEdits:${file}`)
    const full = path.join(packRoot, file)
    const json = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>
    for (const edit of edits) {
      const key = edit.path.split('.').pop() ?? 'value'
      json[key] = edit.value === undefined ? null : (JSON.parse(edit.value) as unknown)
    }
    fs.writeFileSync(full, JSON.stringify(json, null, 2), 'utf8')
    return Promise.resolve({})
  }
  createFiles(packRoot: string, files: readonly { path: string; contents: string }[]): Promise<unknown> {
    this.calls.push(`createFiles:${files.map((f) => f.path).join(',')}`)
    for (const f of files) {
      const full = path.join(packRoot, f.path)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, f.contents, 'utf8')
    }
    return Promise.resolve({})
  }
  deleteFeature(packRoot: string, id: string): Promise<unknown> {
    this.calls.push(`deleteFeature:${id}`)
    const file = this.nodes.find((n) => n.id === id)?.file
    if (file !== undefined) fs.rmSync(path.join(packRoot, file), { force: true })
    return Promise.resolve({})
  }
  annotate(): Promise<unknown> {
    return Promise.resolve({})
  }
  /** Writes each op's directive onto the file's first line, ONE FILE AT A TIME WITH A YIELD
   * BETWEEN, which is the shape the real engine has: it writes a batch file by file over a pipe,
   * so there is a real moment when the first member of a group carries the new directive and the
   * second still carries the old one.
   *
   * The yield is the whole point of this fake. Two batches handled concurrently interleave here
   * exactly as they do over the real process, and a snapshot taken in that window records a state
   * nobody ever authored. See the interleaving test below. */
  async annotateBatch(packRoot: string, ops: readonly { file: string; args?: readonly string[]; remove?: boolean }[]): Promise<unknown> {
    this.calls.push(`annotateBatch:${ops.map((o) => o.file).join(',')}`)
    let first = true
    for (const op of ops) {
      if (!first) await new Promise((resolve) => setImmediate(resolve))
      first = false
      const full = path.join(packRoot, op.file)
      const body = fs.readFileSync(full, 'utf8').replace(/^\/\/ @featurelab:group[^\n]*\n/, '')
      fs.writeFileSync(full, op.remove === true ? body : `// @featurelab:group ${(op.args ?? []).join(' ')}\n${body}`, 'utf8')
    }
    return {}
  }
  regenerate(): Promise<unknown> {
    return Promise.resolve({})
  }
  renameFeature(): Promise<unknown> {
    return Promise.resolve({})
  }
}

/** Opens a graph panel over `packRoot` and plays the webview reporting that its script is running,
 * which is what makes the panel ask for its first graph. */
async function openPanel(packRoot: string, engine: FakeEngine): Promise<{ panel: GraphPanel; webview: vscodeMock.MockWebview; written: string[] }> {
  const written: string[] = []
  const panel = GraphPanel.show(
    new vscodeMock.MockUri(packRoot) as unknown as import('vscode').Uri,
    engine as unknown as PreviewController,
    packRoot,
    5_000,
    () => {},
    (absPath) => written.push(absPath),
  )
  const created = vscodeMock.createdPanels[vscodeMock.createdPanels.length - 1]
  if (created === undefined) throw new Error('no webview panel was created')
  created.webview.simulateMessage({ type: 'ready' })
  await settle()
  return { panel, webview: created.webview, written }
}

/** Lets every pending microtask-and-timer chain the panel started finish. The panel's message
 * handler is fire-and-forget by design (VS Code's onDidReceiveMessage cannot be awaited), so this
 * is how a test waits for one without a sleep. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}

function postedOfType(webview: vscodeMock.MockWebview, type: string): Record<string, unknown>[] {
  return webview.postedMessages.filter((m): m is Record<string, unknown> => (m as { type?: string })?.type === type)
}

let openPanels: GraphPanel[] = []

beforeEach(() => {
  vscodeMock.resetMock()
  openPanels = []
})

afterEach(() => {
  for (const panel of openPanels.splice(0)) panel.dispose()
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  vi.clearAllMocks()
})

/** Opens a panel and remembers it for teardown -- an undisposed panel keeps its entry in
 * GraphPanel's static table, and the next test's activePanel() would find it. */
async function panelFor(packRoot: string, engine: FakeEngine) {
  const opened = await openPanel(packRoot, engine)
  openPanels.push(opened.panel)
  return opened
}

describe('undoing an edit made in the inspector', () => {
  it('puts the file back to exactly what it was, and redraws from what the file now says', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const file = path.join(pack, 'features', 'lamp.json')
    const before = fs.readFileSync(file, 'utf8')
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({
      type: 'applyEdits',
      file: 'features/lamp.json',
      edits: [{ path: '$.minecraft:single_block_feature.extent', json: '4' }],
      label: 'gaussian: extent 1',
    })
    await settle()
    expect(fs.readFileSync(file, 'utf8')).not.toBe(before)
    expect(panel.pendingUndoLabel()).toBe('gaussian: extent 1')

    const graphsBefore = postedOfType(webview, 'graph').length
    const entry = await panel.undoLastChange()

    expect(entry.label).toBe('gaussian: extent 1')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    // The panel must not go on drawing the edit it just reverted.
    expect(postedOfType(webview, 'graph').length).toBeGreaterThan(graphsBefore)
    expect(panel.pendingUndoLabel()).toBeNull()
    expect(panel.pendingRedoLabel()).toBe('gaussian: extent 1')
  })

  it('tells the canvas what Undo and Redo would do, so a button can say it', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({
      type: 'applyEdits',
      file: 'features/lamp.json',
      edits: [{ path: '$.minecraft:single_block_feature.extent', json: '4' }],
      label: 'lamp: extent 4',
    })
    await settle()

    const history = postedOfType(webview, 'history')
    expect(history[history.length - 1]?.['undo']).toBe('lamp: extent 4')
    await panel.undoLastChange()
    const after = postedOfType(webview, 'history')
    expect(after[after.length - 1]?.['undo']).toBeNull()
    expect(after[after.length - 1]?.['redo']).toBe('lamp: extent 4')
  })

  it('writes an entry even when the webview sent no label, rather than losing the step', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({
      type: 'applyEdits',
      file: 'features/lamp.json',
      edits: [{ path: '$.minecraft:single_block_feature.extent', json: '4' }],
    })
    await settle()

    // Plainer wording, same history. Several webview modules already produce the good sentence and
    // several do not yet forward it; a missing label must cost the sentence, not the undo.
    expect(panel.pendingUndoLabel()).toMatch(/features[\\/]lamp\.json/)
    expect(panel.pendingUndoLabel()).toContain('extent')
  })

  it('undoes a node creation by taking the file away again', async () => {
    const pack = makePack()
    const engine = new FakeEngine()
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({
      type: 'create',
      files: [{ path: 'features/fresh.json', contents: feature('wiki:fresh') }],
      select: 'wiki:fresh',
    })
    await settle()
    expect(fs.existsSync(path.join(pack, 'features', 'fresh.json'))).toBe(true)

    await panel.undoLastChange()

    expect(fs.existsSync(path.join(pack, 'features', 'fresh.json'))).toBe(false)
  })
})

describe('an undo whose file moved on underneath it', () => {
  it('refuses, names the file, and leaves the newer bytes alone', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const file = path.join(pack, 'features', 'lamp.json')
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({
      type: 'applyEdits',
      file: 'features/lamp.json',
      edits: [{ path: '$.minecraft:single_block_feature.extent', json: '4' }],
      label: 'lamp: extent 4',
    })
    await settle()

    // Somebody edits the same file in a text editor and saves.
    const byHand = '{"edited":"by hand"}'
    fs.writeFileSync(file, byHand, 'utf8')

    await expect(panel.undoLastChange()).rejects.toThrow(/lamp\.json has changed since then/)
    await expect(panel.undoLastChange()).rejects.toThrow(/Nothing was written/)
    expect(fs.readFileSync(file, 'utf8')).toBe(byHand)
  })
})

describe('deleting a node', () => {
  it('asks first, every time, and names the file it is about to write', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { webview } = await panelFor(pack, engine)
    // Nothing refers to wiki:lamp. That used to be the case with NO confirmation at all.
    vscodeMock.messageAnswers.warning = DELETE_CONFIRM

    webview.simulateMessage({ type: 'deleteFeature', id: 'wiki:lamp', detachReferences: false })
    await settle()

    const asked = vscodeMock.warningMessages[0]
    expect(asked, 'the delete was not confirmed at all').toBeDefined()
    expect(asked?.message).toBe('Delete wiki:lamp?')
    expect(asked?.modal).toBe(true)
    expect(asked?.detail).toContain('features/lamp.json')
    expect(asked?.detail).toMatch(/cannot be undone from Feature Lab/)
    // The affirmative is the ONLY button offered; Cancel is VS Code's, and is what a dismissed
    // dialog produces. Nothing here treats not answering as consent.
    expect(asked?.actions).toEqual([DELETE_CONFIRM])
    expect(engine.calls).toContain('deleteFeature:wiki:lamp')
    expect(fs.existsSync(path.join(pack, 'features', 'lamp.json'))).toBe(false)
  })

  it('does nothing at all when the question is dismissed', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { webview } = await panelFor(pack, engine)
    // A dismissed modal -- Escape, or clicking away.
    delete vscodeMock.messageAnswers.warning

    webview.simulateMessage({ type: 'deleteFeature', id: 'wiki:lamp', detachReferences: false })
    await settle()

    expect(vscodeMock.warningMessages).toHaveLength(1)
    expect(engine.calls.some((c) => c.startsWith('deleteFeature'))).toBe(false)
    expect(fs.existsSync(path.join(pack, 'features', 'lamp.json'))).toBe(true)
    // And the canvas is told, so the node does not sit in its "deleting" state forever.
    expect(postedOfType(webview, 'deleteCancelled')[0]?.['id']).toBe('wiki:lamp')
  })

  it('says so when it will rewrite the files that still refer to the feature', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { webview } = await panelFor(pack, engine)
    vscodeMock.messageAnswers.warning = DELETE_CONFIRM

    webview.simulateMessage({ type: 'deleteFeature', id: 'wiki:lamp', detachReferences: true })
    await settle()

    expect(vscodeMock.warningMessages[0]?.detail).toMatch(/Every other file that refers to it is rewritten/)
  })

  it('names the group the feature is in, because the delete takes it out of that too', async () => {
    // LOSING A MEMBER WAS INVISIBLE. The delete refusal for undo is correct and loud; what nobody
    // said was that a group the author had written into these very files had just lost a clause.
    // The panel simply read "Members (1)" afterwards. This is the last moment anybody can say no.
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { webview } = await panelFor(pack, engine)
    vscodeMock.messageAnswers.warning = DELETE_CONFIRM

    webview.simulateMessage({ type: 'deleteFeature', id: 'wiki:lamp', detachReferences: false, group: 'Surface Markers' })
    await settle()

    expect(vscodeMock.warningMessages[0]?.detail).toMatch(/This feature is in "Surface Markers"/)
    expect(vscodeMock.warningMessages[0]?.detail).toMatch(/takes it out of that group/)
  })

  it('says nothing about a group for a feature that is in none', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { webview } = await panelFor(pack, engine)
    vscodeMock.messageAnswers.warning = DELETE_CONFIRM

    webview.simulateMessage({ type: 'deleteFeature', id: 'wiki:lamp', detachReferences: false })
    await settle()

    expect(vscodeMock.warningMessages[0]?.detail).not.toMatch(/group/)
  })

  it('blocks undo by name afterwards, instead of reverting the edit before it', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp'), 'features/keep.json': feature('wiki:keep') })
    const keep = path.join(pack, 'features', 'keep.json')
    const engine = new FakeEngine()
    engine.nodes = [
      { id: 'wiki:lamp', file: 'features/lamp.json' },
      { id: 'wiki:keep', file: 'features/keep.json' },
    ]
    const { panel, webview } = await panelFor(pack, engine)
    vscodeMock.messageAnswers.warning = DELETE_CONFIRM

    webview.simulateMessage({
      type: 'applyEdits',
      file: 'features/keep.json',
      edits: [{ path: '$.minecraft:single_block_feature.extent', json: '4' }],
      label: 'keep: extent 4',
    })
    await settle()
    const afterEdit = fs.readFileSync(keep, 'utf8')

    webview.simulateMessage({ type: 'deleteFeature', id: 'wiki:lamp', detachReferences: false })
    await settle()

    await expect(panel.undoLastChange()).rejects.toThrow(/"Delete wiki:lamp" cannot be undone/)
    // The unrelated edit is untouched -- reverting THAT is what recording nothing would have done.
    expect(fs.readFileSync(keep, 'utf8')).toBe(afterEdit)
  })
})

describe('two writes that arrive together', () => {
  /** A group over two files, as the panel's own plan spells it. */
  function groupOps(id: string, name: string): { file: string; path: string; name: string; args: string[] }[] {
    return ['features/a.json', 'features/b.json'].map((file) => ({ file, path: '$', name: 'group', args: [id, 'expanded', name] }))
  }

  async function twoMemberPack(): Promise<{ pack: string; engine: FakeEngine; originals: Record<string, string> }> {
    const pack = makePack({ 'features/a.json': feature('wiki:a'), 'features/b.json': feature('wiki:b') })
    const engine = new FakeEngine()
    engine.nodes = [
      { id: 'wiki:a', file: 'features/a.json' },
      { id: 'wiki:b', file: 'features/b.json' },
    ]
    return {
      pack,
      engine,
      originals: {
        'features/a.json': fs.readFileSync(path.join(pack, 'features', 'a.json'), 'utf8'),
        'features/b.json': fs.readFileSync(path.join(pack, 'features', 'b.json'), 'utf8'),
      },
    }
  }

  it('never snapshots a file mid-write, so both undos put the pack back byte for byte', async () => {
    // THE CORRUPTION THIS IS ABOUT. `onDidReceiveMessage` is fire-and-forget -- VS Code offers no
    // way to await a handler -- so two messages arriving in the same tick used to run their
    // handlers CONCURRENTLY. Both were journalled writes over the same two files, and the second
    // one read its `before` while the first one's engine call was part way through them: what it
    // recorded as "what this file was" was a file halfway between two states nobody authored.
    //
    // What that cost in practice: one Ctrl+Z put back a one-member group that had never existed,
    // and the next refused -- "...a.json has changed since then" -- and went on refusing forever,
    // because undo refuses BEFORE popping and the bytes it wants are never coming.
    //
    // The two messages are posted with NO await between them, which is exactly how the webview's
    // old double-post arrived and how any two fast clicks arrive.
    const { pack, engine, originals } = await twoMemberPack()
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({ type: 'annotateBatch', ops: groupOps('markers', 'Markers'), label: 'Grouping 2 features as "Markers".' })
    webview.simulateMessage({ type: 'annotateBatch', ops: groupOps('markers-2', 'Markers'), label: 'Grouping 2 features as "Markers" again.' })
    await settle()

    // Both landed, in order, and the second is what undo offers first.
    expect(engine.calls.filter((c) => c.startsWith('annotateBatch:'))).toHaveLength(2)
    expect(panel.pendingUndoLabel()).toBe('Grouping 2 features as "Markers" again.')

    // ONE undo lands on the state the FIRST batch left -- not on a mixture of the two.
    await panel.undoLastChange()
    for (const rel of ['features/a.json', 'features/b.json']) {
      expect(fs.readFileSync(path.join(pack, rel), 'utf8'), rel).toBe(`// @featurelab:group markers expanded Markers\n${originals[rel]!}`)
    }

    // ...and the second reaches the original. Under the interleaved version this threw
    // "has changed since then" and kept throwing.
    await panel.undoLastChange()
    for (const rel of ['features/a.json', 'features/b.json']) {
      expect(fs.readFileSync(path.join(pack, rel), 'utf8'), rel).toBe(originals[rel]!)
    }
    expect(panel.pendingUndoLabel()).toBeNull()
  })

  it('records the operation under the name the panel gave it, not "Annotate 2 file(s)"', async () => {
    // EVERY GROUP OPERATION WAS CALLED "Annotate 2 file(s)". That string is what the Undo command
    // in the palette offered, what an undo button's tooltip would say, and -- worst -- what the
    // refusal sentence named, which makes it a sentence about nothing the author did. The
    // webview's plan has always carried its own summary; it simply was not passed.
    const { pack, engine } = await twoMemberPack()
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({ type: 'annotateBatch', ops: groupOps('markers', 'Markers'), label: 'Collapsing "Markers".' })
    await settle()
    expect(panel.pendingUndoLabel()).toBe('Collapsing "Markers".')

    // And a host talking to a webview that sends none still records something rather than nothing.
    webview.simulateMessage({ type: 'annotateBatch', ops: groupOps('markers', 'Markers Two') })
    await settle()
    expect(panel.pendingUndoLabel()).toBe('Annotate 2 file(s)')
  })
})

describe('an undo the journal will not perform', () => {
  async function wedged(): Promise<{ pack: string; panel: GraphPanel; webview: vscodeMock.MockWebview; file: string }> {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    const { panel, webview } = await panelFor(pack, engine)
    webview.simulateMessage({
      type: 'applyEdits',
      file: 'features/lamp.json',
      edits: [{ path: '$.minecraft:single_block_feature.extent', json: '4' }],
      label: 'lamp: extent 4',
    })
    await settle()
    // Somebody edits the same file in a text editor and saves. The journal will not clobber that,
    // by design -- and that refusal is permanent, because the bytes it wants back are gone.
    const file = path.join(pack, 'features', 'lamp.json')
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n`, 'utf8')
    return { pack, panel, webview, file }
  }

  it('puts the refusal on the CANVAS, not only in a notification, and names the step it is stuck on', async () => {
    // A REFUSED UNDO WAS SILENT WHERE THE AUTHOR WAS LOOKING. The sentence was raised for
    // whichever command asked and shown as a VS Code toast; the panel's own status line went on
    // showing the card count, and nothing on the canvas said the word "undo" at all.
    const { panel, webview } = await wedged()

    await expect(panel.undoLastChange()).rejects.toThrow(/cannot be undone/)
    const refusal = postedOfType(webview, 'editError').at(-1)
    expect(refusal?.['message']).toMatch(/"lamp: extent 4" cannot be undone/)
    expect(refusal?.['message']).toMatch(/has changed since then/)
    // The entry it is stuck on rides along, so the panel can offer to leave that one step out.
    // Without it the history is wedged for the rest of the session.
    expect(refusal?.['blockedUndo']).toBe('lamp: extent 4')
  })

  it('stays refused until it is forgotten, and forgetting writes nothing', async () => {
    const { panel, webview, file } = await wedged()
    const edited = fs.readFileSync(file, 'utf8')

    await expect(panel.undoLastChange()).rejects.toThrow(/cannot be undone/)
    // REFUSES FOREVER: undo refuses before popping, on purpose, so the second press meets the same
    // wall. That is correct, and it is why there has to be a way past it.
    await expect(panel.undoLastChange()).rejects.toThrow(/cannot be undone/)
    expect(panel.pendingUndoLabel()).toBe('lamp: extent 4')

    const forgotten = panel.forgetLastChange()
    expect(forgotten?.label).toBe('lamp: extent 4')
    // NOTHING WAS WRITTEN. Forgetting is not an undo and not a redo; the file is exactly as the
    // person who edited it left it.
    expect(fs.readFileSync(file, 'utf8')).toBe(edited)
    expect(panel.pendingUndoLabel()).toBeNull()
    // The panel is told, by name, and the history's new shape goes with it.
    expect(postedOfType(webview, 'historyForgotten').at(-1)?.['label']).toBe('lamp: extent 4')
    expect(postedOfType(webview, 'history').at(-1)).toMatchObject({ undo: null, redo: null })
  })

  it('reaches what came before, once the step in the way has been left out', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp'), 'features/keep.json': feature('wiki:keep') })
    const keep = path.join(pack, 'features', 'keep.json')
    const lamp = path.join(pack, 'features', 'lamp.json')
    const keepOriginal = fs.readFileSync(keep, 'utf8')
    const engine = new FakeEngine()
    engine.nodes = [
      { id: 'wiki:lamp', file: 'features/lamp.json' },
      { id: 'wiki:keep', file: 'features/keep.json' },
    ]
    const { panel, webview } = await panelFor(pack, engine)

    webview.simulateMessage({ type: 'applyEdits', file: 'features/keep.json', edits: [{ path: '$.x', json: '1' }], label: 'keep: x 1' })
    await settle()
    webview.simulateMessage({ type: 'applyEdits', file: 'features/lamp.json', edits: [{ path: '$.x', json: '2' }], label: 'lamp: x 2' })
    await settle()
    fs.writeFileSync(lamp, `${fs.readFileSync(lamp, 'utf8')}\n`, 'utf8')

    await expect(panel.undoLastChange()).rejects.toThrow(/cannot be undone/)
    webview.simulateMessage({ type: 'forgetUndo' })
    await settle()
    // The earlier edit is reachable again, and undoing it does what it always did.
    expect(panel.pendingUndoLabel()).toBe('keep: x 1')
    await panel.undoLastChange()
    expect(fs.readFileSync(keep, 'utf8')).toBe(keepOriginal)
  })

  it('offers nothing to forget when the refusal was that the history is empty', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    const { panel, webview } = await panelFor(pack, engine)

    await expect(panel.undoLastChange()).rejects.toThrow(/waiting to be put back/)
    const refusal = postedOfType(webview, 'editError').at(-1)
    expect(refusal?.['message']).toMatch(/waiting to be put back/)
    // A "Skip this step" button over an empty stack would be a control that means nothing.
    expect(refusal?.['blockedUndo']).toBeUndefined()
    expect(panel.forgetLastChange()).toBeNull()
  })
})

describe('a panel whose pack would not load', () => {
  it('offers a retry rather than going quiet, and retrying draws the graph', async () => {
    const pack = makePack({ 'features/lamp.json': feature('wiki:lamp') })
    const engine = new FakeEngine()
    engine.graphFails = 'features/lamp.json: unexpected token at line 3'
    const { panel, webview } = await panelFor(pack, engine)

    const failure = postedOfType(webview, 'graphError')[0]
    expect(failure?.['message']).toContain('unexpected token')
    // The flag IS the affordance: it is the host promising that a button the canvas draws does
    // something. Without it the panel was dead until the window was reloaded.
    expect(failure?.['retry']).toBe(true)

    // Whatever was wrong is fixed, and the author presses Retry.
    engine.graphFails = null
    engine.nodes = [{ id: 'wiki:lamp', file: 'features/lamp.json' }]
    webview.simulateMessage({ type: 'retry' })
    await settle()

    // A retry reloads the pack first: rebuilding from the copy the engine parsed BEFORE the fix
    // would fail identically and look like a button that does nothing.
    expect(engine.calls).toContain('reloadPack')
    const drawn = postedOfType(webview, 'graph')
    expect(drawn).toHaveLength(1)
    expect(((drawn[0]?.['graph'] as { nodes?: unknown[] })?.nodes ?? []).length).toBe(1)
    expect(panel.pendingUndoLabel()).toBeNull()
  })

  it('carries the pack warnings on the failure too, because a wrong path is why a load usually fails', async () => {
    const pack = makePack({}, { features: false })
    const engine = new FakeEngine()
    engine.graphFails = 'no pack is loaded'
    const { webview } = await panelFor(pack, engine)

    const failure = postedOfType(webview, 'graphError')[0]
    expect((failure?.['packWarnings'] as string[]).join('\n')).toMatch(/not the pack you meant/)
  })
})

describe('what the canvas is told about the pack itself', () => {
  it('says the path is probably wrong, rather than letting "no features yet" stand for it', async () => {
    // A pack root with no features/ directory: loadPack succeeds and finds nothing, which is
    // indistinguishable from an empty pack unless somebody says so.
    const pack = makePack({}, { features: false })
    const engine = new FakeEngine()
    const { webview } = await panelFor(pack, engine)

    const drawn = postedOfType(webview, 'graph')[0]
    const warnings = drawn?.['packWarnings'] as string[]
    expect(warnings.join('\n')).toContain('There is no "features" directory')
    expect(warnings.join('\n')).toMatch(/not the pack you meant/)
  })

  it('says nothing extra about a pack that really is just empty', async () => {
    const pack = makePack()
    const engine = new FakeEngine()
    const { webview } = await panelFor(pack, engine)

    expect(postedOfType(webview, 'graph')[0]?.['packWarnings']).toEqual([])
  })

  it("passes the engine's own load warnings through beside its own", async () => {
    const pack = makePack()
    const engine = new FakeEngine()
    engine.warnings = ['features/broken.json: not a feature']
    const { webview } = await panelFor(pack, engine)

    expect(postedOfType(webview, 'graph')[0]?.['packWarnings']).toEqual(['features/broken.json: not a feature'])
  })
})

describe('missingFeaturesDirectoryWarning', () => {
  it('is null for a pack that has the directory, even an empty one', () => {
    expect(missingFeaturesDirectoryWarning(makePack())).toBeNull()
  })

  it('names the path it looked under, because the path is the thing that is wrong', () => {
    const pack = makePack({}, { features: false })
    expect(missingFeaturesDirectoryWarning(pack)).toContain(pack)
  })
})
