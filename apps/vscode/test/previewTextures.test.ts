// previewTextures.test.ts -- the first run, as the extension performs it: what PreviewPanel
// does between "this machine has no block textures" and "the preview is drawing them", and
// what it does in each of the four ways that can fail to happen (declined, already declined,
// offline, switched off).
//
// Drives the REAL PreviewPanel against fixtures/vscodeMock.ts and a stub TextureBuilder --
// nothing here spawns a process or touches the network, which is the same rule Piece A set for
// itself and the reason the builder is injectable at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as vscodeMock from './fixtures/vscodeMock.js'
import { PreviewPanel } from '../src/previewPanel.js'
import { notesForPalette, notesFromAtlas, TextureBuilder, TextureCommandError, type TextureResultWire, type TextureStatusWire } from '../src/textures.js'
import type { PreviewController } from '../src/previewController.js'

const FEATURE_JSON = JSON.stringify({
  format_version: '1.19.0',
  'minecraft:tree_feature': { description: { identifier: 'wiki:poplar_tree' } },
})

function makeDocument(fsPath = '/pack/features/thing.json') {
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    fileName: fsPath,
    getText: () => FEATURE_JSON,
    lineCount: 1,
    lineAt: () => ({ text: '' }),
  } as unknown as import('vscode').TextDocument
}

const ATLAS = { table: { version: 1, blocks: { 'pack:lamp': { note: 'drawn as a full cube' } } }, png: 'AA==' }

function makeController(atlas: unknown = ATLAS) {
  return {
    binaryPath: '/nowhere/featurelab',
    generate: vi.fn(async () => ({ diagnostics: [], palette: [{ name: 'pack:lamp' }, { name: 'minecraft:stone' }] })),
    generateGrown: vi.fn(async () => ({ diagnostics: [] })),
    reloadPack: vi.fn(async () => ({ warnings: [], featureCount: 0, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
    reloadPackFile: vi.fn(async () => ({ warnings: [], featureCount: 0, structureCount: 0, ruleCount: 0, biomeCount: 0 })),
    listEnvironments: vi.fn(async () => []),
    loadAtlas: vi.fn(async () => atlas),
  } as unknown as PreviewController & { loadAtlas: ReturnType<typeof vi.fn> }
}

function status(overrides: Partial<TextureStatusWire> = {}): TextureStatusWire {
  return {
    state: 'missing',
    dir: '/cache/featurelab/atlas',
    wantTag: 'v1.26.40.05',
    needsDownload: true,
    notice: 'featurelab: vanilla block textures are not cached yet.\n  Fetching Mojang’s sample resource pack…',
    detail: 'Block textures are not on this machine yet.',
    ...overrides,
  }
}

function makeBuilder(first: TextureStatusWire, built: TextureStatusWire = status({ state: 'ready', needsDownload: false })) {
  const result: TextureResultWire = { status: built, pack: { dir: '/pack', blocks: 67, fully: 43, shapeCube: 24, untextured: 0, textures: 62, reused: 6 } }
  return {
    status: vi.fn(async () => first),
    build: vi.fn(async () => result),
    decline: vi.fn(async () => {}),
  } as unknown as TextureBuilder & { status: ReturnType<typeof vi.fn>; build: ReturnType<typeof vi.fn>; decline: ReturnType<typeof vi.fn> }
}

function open(controller: PreviewController, textures: TextureBuilder) {
  const diagCollection = { set: vi.fn(), delete: vi.fn() } as unknown as import('vscode').DiagnosticCollection
  const panel = new PreviewPanel(
    { extensionUri: vscodeMock.Uri.file('/ext') } as unknown as import('vscode').ExtensionContext,
    controller,
    diagCollection,
    makeDocument(),
    () => {},
    textures,
  )
  lastPanel().webview.simulateMessage({ type: 'ready' })
  return panel
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** How many times the DOWNLOAD question was put -- the modal one carrying the engine's notice.
 * Counted by its modal option rather than by call count, because the same API also carries the
 * ordinary informational message about pack-block notes, which is not a question. */
function downloadPrompts(): number {
  return vscodeMock.window.showInformationMessage.mock.calls.filter((call) => (call[1] as { modal?: boolean } | undefined)?.modal === true).length
}

function lastPanel(): vscodeMock.MockWebviewPanel {
  const panel = vscodeMock.createdPanels[vscodeMock.createdPanels.length - 1]
  if (!panel) throw new Error('no webview panel was created')
  return panel
}

function postedTypes(): string[] {
  return lastPanel().webview.postedMessages.map((m) => (m as { type: string }).type)
}

beforeEach(() => {
  vscodeMock.createdPanels.length = 0
  vscodeMock.outputLines.length = 0
  vscodeMock.messageAnswers.information = undefined
  vscodeMock.mockConfig.blockTextures = true
})

afterEach(() => {
  vscodeMock.mockConfig.blockTextures = false
  vi.restoreAllMocks()
})

describe('PreviewPanel: the first run', () => {
  it('offers the download once, and on "Download" builds and posts the atlas without a restart', async () => {
    vscodeMock.messageAnswers.information = 'Download'
    const controller = makeController()
    const textures = makeBuilder(status())
    open(controller, textures)
    await settle()

    // Asked, with the engine's own notice as the body -- not a paraphrase written in the
    // extension, which is how "we downloaded something, somewhere" happens.
    expect(downloadPrompts()).toBe(1)
    const [, options] = vscodeMock.window.showInformationMessage.mock.calls[0] as unknown as [string, { detail: string }]
    expect(options.detail).toBe(status().notice)

    expect(textures.build).toHaveBeenCalledTimes(1)
    expect(textures.build.mock.calls[0]?.[0]).toMatchObject({ download: true, packRoot: expect.any(String) })
    // The pack under test goes in, or its own blocks stay flat colours.
    expect(String(textures.status.mock.calls[0]?.[0])).toContain('pack')
    expect(postedTypes()).toContain('atlas')
  })

  it('on "Never" records the decline, builds nothing, and says why', async () => {
    vscodeMock.messageAnswers.information = 'Never'
    const controller = makeController()
    const textures = makeBuilder(status())
    open(controller, textures)
    await settle()

    expect(textures.decline).toHaveBeenCalledTimes(1)
    expect(textures.build).not.toHaveBeenCalled()
    expect(postedTypes()).not.toContain('atlas')
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledTimes(1)
  })

  it('a dismissed notification decides nothing: no decline recorded, no download', async () => {
    vscodeMock.messageAnswers.information = undefined
    const textures = makeBuilder(status())
    open(makeController(), textures)
    await settle()

    expect(textures.decline).not.toHaveBeenCalled()
    expect(textures.build).not.toHaveBeenCalled()
  })

  it('never asks again once this machine has declined', async () => {
    const textures = makeBuilder(status({ state: 'declined', detail: 'asked once and declined' }))
    open(makeController(), textures)
    await settle()

    expect(downloadPrompts()).toBe(0)
    expect(textures.build).not.toHaveBeenCalled()
    // Not a warning either: the user already knows, they chose it.
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('does not ask at all when the assets are already on the machine -- it just builds', async () => {
    const textures = makeBuilder(status({ state: 'stale', needsDownload: false, detail: 'built without this pack’s own blocks' }))
    open(makeController(), textures)
    await settle()

    expect(downloadPrompts()).toBe(0)
    expect(textures.build).toHaveBeenCalledTimes(1)
    expect(textures.build.mock.calls[0]?.[0]).toMatchObject({ download: false })
    expect(postedTypes()).toContain('atlas')
  })

  it('a ready atlas is posted with no prompt and no build', async () => {
    const textures = makeBuilder(status({ state: 'ready', needsDownload: false, detail: 'ready' }))
    open(makeController(), textures)
    await settle()

    expect(textures.build).not.toHaveBeenCalled()
    expect(downloadPrompts()).toBe(0)
    expect(postedTypes()).toContain('atlas')
  })

  it('a failed build explains itself once and leaves the preview on flat colours', async () => {
    vscodeMock.messageAnswers.information = 'Download'
    const textures = makeBuilder(status())
    ;(textures.build as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TextureCommandError('block textures could not be built', 'vanilla assets: fetching https://codeload.github.com/…: dial tcp: lookup failed'),
    )
    open(makeController(), textures)
    await settle()

    expect(postedTypes()).not.toContain('atlas')
    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledTimes(1)
    const [warning] = vscodeMock.window.showWarningMessage.mock.calls[0] as unknown as [string]
    expect(warning).toContain('could not be built')
  })

  it('does nothing at all when featurelab.blockTextures is off', async () => {
    vscodeMock.mockConfig.blockTextures = false
    const textures = makeBuilder(status())
    open(makeController(), textures)
    await settle()

    expect(textures.status).not.toHaveBeenCalled()
    expect(downloadPrompts()).toBe(0)
  })

  it('reports the pack-block notes for the blocks this preview actually placed, once', async () => {
    const textures = makeBuilder(status({ state: 'ready', needsDownload: false, detail: 'ready' }))
    open(makeController(), textures)
    await settle()

    expect(vscodeMock.outputLines.some((l) => l.startsWith('pack:lamp:'))).toBe(true)
    // One message, not one per regenerate, and never a diagnostic: a resource-pack model
    // geometry is not a defect in the pack.
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1)
    expect(downloadPrompts()).toBe(0)
  })
})

describe('atlas notes', () => {
  it('reads the per-block notes out of the atlas table', () => {
    expect(notesFromAtlas(ATLAS).get('pack:lamp')).toBe('drawn as a full cube')
    expect(notesFromAtlas(null).size).toBe(0)
    expect(notesFromAtlas({ table: {} }).size).toBe(0)
  })

  it('filters to the blocks a result actually placed, deduplicated and sorted', () => {
    const notes = new Map([
      ['pack:lamp', 'a'],
      ['pack:crate', 'b'],
      ['pack:unused', 'c'],
    ])
    const placed = notesForPalette(notes, [{ name: 'pack:lamp' }, { name: 'pack:crate' }, { name: 'pack:lamp' }, { name: 'minecraft:stone' }])
    expect(placed.map((n) => n.block)).toEqual(['pack:crate', 'pack:lamp'])
  })

  it('says nothing when the result has no palette at all', () => {
    expect(notesForPalette(new Map([['a', 'b']]), undefined)).toEqual([])
  })
})

describe('TextureBuilder', () => {
  // A fake child process: the same two-stream, one-exit-code shape node:child_process gives,
  // with no process behind it. Keeps this suite off both the network and the filesystem.
  function fakeSpawn(exitCode: number, stdout: string, stderr = '') {
    return vi.fn(() => {
      const handlers: Record<string, ((arg: unknown) => void)[]> = {}
      const stream = (text: string) => ({
        setEncoding: () => {},
        on: (event: string, cb: (chunk: string) => void) => {
          if (event === 'data' && text) queueMicrotask(() => cb(text))
        },
      })
      const child = {
        stdout: stream(stdout),
        stderr: stream(stderr),
        on: (event: string, cb: (arg: unknown) => void) => {
          ;(handlers[event] ??= []).push(cb)
          if (event === 'close') queueMicrotask(() => queueMicrotask(() => cb(exitCode)))
        },
      }
      return child as never
    })
  }

  it('parses the engine’s JSON status', async () => {
    const builder = new TextureBuilder('/bin/featurelab', fakeSpawn(0, JSON.stringify(status({ state: 'ready' }))) as never)
    await expect(builder.status('/pack')).resolves.toMatchObject({ state: 'ready' })
  })

  it('turns a non-zero exit into the sentence the engine printed', async () => {
    const builder = new TextureBuilder('/bin/featurelab', fakeSpawn(1, '', 'featurelab: vanilla assets: fetching …: no such host') as never)
    await expect(builder.build({ download: true })).rejects.toThrow(TextureCommandError)
    await expect(builder.build({ download: true })).rejects.toMatchObject({ detail: expect.stringContaining('no such host') })
  })

  it('forwards progress lines whole, one per line', async () => {
    const builder = new TextureBuilder('/bin/featurelab', fakeSpawn(0, '{}', 'featurelab: packing the atlas…\nfeaturelab: 16 MB received\n') as never)
    const seen: string[] = []
    await builder.build({ download: false, onProgress: (line) => seen.push(line) })
    expect(seen).toEqual(['packing the atlas…', '16 MB received'])
  })
})
