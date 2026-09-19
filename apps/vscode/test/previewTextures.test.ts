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
import { PreviewPanel, TEXTURES_DECLINED_REASON, TEXTURES_DISABLED_REASON } from '../src/previewPanel.js'
import {
  notesForPalette,
  notesFromAtlas,
  summarizeUnresolved,
  unresolvedFromAtlas,
  TextureBuilder,
  TextureCommandError,
  type TextureResultWire,
  type TextureStatusWire,
} from '../src/textures.js'
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

/** The last thing the panel was told about block textures -- PanelHandle.setTextureStatus's own
 * wire message. The panel can already tell WHETHER it can draw them; this is the host saying
 * why not, which is the half nothing else in this extension can supply. */
function textureStatus(): { available?: boolean; reason?: string } | undefined {
  return lastPanel()
    .webview.postedMessages.filter((m): m is { type: string; available?: boolean; reason?: string } => (m as { type: string }).type === 'textureStatus')
    .pop()
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

  it('prepares nothing at all when featurelab.blockTextures is off -- and says so', async () => {
    vscodeMock.mockConfig.blockTextures = false
    const textures = makeBuilder(status())
    open(makeController(), textures)
    await settle()

    // Nothing is looked for, fetched, built or asked about. That half of the setting is exactly
    // what it always was.
    expect(textures.status).not.toHaveBeenCalled()
    expect(downloadPrompts()).toBe(0)
    expect(postedTypes()).not.toContain('atlas')
    // What is new is that the panel is TOLD. Its "Block textures" row is otherwise a checkbox
    // that cannot be ticked with no explanation anywhere near it -- the one shape a setting must
    // never take. Named, so somebody can go and find it.
    expect(textureStatus()).toEqual({ type: 'textureStatus', available: false, reason: TEXTURES_DISABLED_REASON })
    expect(TEXTURES_DISABLED_REASON).toContain('featurelab.blockTextures')
    // Said, not warned: somebody switched this off on purpose.
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('tells the panel an atlas is on its way, and never tells it to draw with it', async () => {
    const textures = makeBuilder(status({ state: 'ready', needsDownload: false, detail: 'ready' }))
    open(makeController(), textures)
    await settle()

    // `available: true` means "I have delivered one", and nothing more. Whether textures are
    // actually drawn is the panel's own switch and the preference behind it (frontend/src/ui/
    // panel.ts) -- a host that turned them on here would overrule a choice somebody made in the
    // sidebar two minutes ago.
    expect(textureStatus()).toEqual({ type: 'textureStatus', available: true })
    // And the order matters: the atlas first, the verdict after it.
    const types = postedTypes()
    expect(types.indexOf('atlas')).toBeLessThan(types.indexOf('textureStatus'))
  })

  it('gives the panel the real reason in each of the ways this can fail', async () => {
    // Declined: the row says so, and says how to undo it -- but nothing interrupts anybody. This
    // machine was asked once and answered.
    const declined = makeBuilder(status({ state: 'declined', detail: 'asked once and declined' }))
    open(makeController(), declined)
    await settle()
    expect(textureStatus()).toMatchObject({ available: false, reason: TEXTURES_DECLINED_REASON })
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled()

    // A dismissed question decides nothing -- it comes back with the next preview -- but the row
    // still has to say why it is inert right now, and the engine's own sentence is what says it.
    vscodeMock.messageAnswers.information = undefined
    const dismissed = makeBuilder(status())
    open(makeController(), dismissed)
    await settle()
    expect(textureStatus()).toMatchObject({ available: false, reason: status().detail })

    // A build that failed: the engine's sentence, not an exit code.
    vscodeMock.messageAnswers.information = 'Download'
    const broken = makeBuilder(status())
    ;(broken.build as ReturnType<typeof vi.fn>).mockRejectedValue(new TextureCommandError('block textures could not be built', 'dial tcp: lookup failed'))
    open(makeController(), broken)
    await settle()
    expect(textureStatus()?.reason).toContain('lookup failed')
    expect(textureStatus()?.available).toBe(false)

    // And the atlas that was built but cannot be fetched from the engine.
    const unreadable = makeController()
    unreadable.loadAtlas.mockRejectedValue(new Error('no atlas has been built'))
    open(unreadable, makeBuilder(status({ state: 'ready', needsDownload: false })))
    await settle()
    expect(textureStatus()).toMatchObject({ available: false, reason: expect.stringContaining('no atlas has been built') })
    expect(postedTypes()).not.toContain('atlas')
  })

  // The ordinary case is the one the build path never covers: the atlas was built last week, this
  // preview finds it ready and builds nothing, and every pack block whose texture key never
  // resolved draws as a flat colour with nothing anywhere saying which ones or why.
  it('reports the unresolved textures the atlas itself carries, with no build in sight', async () => {
    const controller = makeController({
      table: { version: 1, blocks: {} },
      png: 'AA==',
      // wire.AtlasOutput's own two fields, beside `table` and `png` -- see unresolvedFromAtlas.
      unresolved: [{ block: 'myaddon:slate', face: 'north', texture: 'myaddon:slate_side', reason: 'the sentence', code: 'key-not-declared' }],
      unresolvedTotal: 4,
    })
    open(controller, makeBuilder(status({ state: 'ready', needsDownload: false })))
    await settle()

    const joined = vscodeMock.outputLines.join('\n')
    // The ENGINE's count leads, not the length of its capped sample.
    expect(joined).toContain('4 block face(s) in this pack have no image in the atlas')
    expect(joined).toContain('terrain_texture.json (1):')
    expect(joined).toContain('myaddon:slate (north face, texture "myaddon:slate_side")')
    expect(joined).toContain('... and 3 more not shown.')
  })

  it('tolerates an engine whose atlas carries no such rows at all', async () => {
    // The extension resolves whatever `featurelab` binary it finds on disk, so an engine that
    // predates the field is an ordinary thing to be talking to.
    open(makeController(), makeBuilder(status({ state: 'ready', needsDownload: false })))
    await settle()

    expect(postedTypes()).toContain('atlas')
    expect(vscodeMock.outputLines.join('\n')).not.toContain('face, texture')
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

  // "3 blocks with an unresolved texture" describes a preview that is drawing those blocks as
  // flat colours -- which is exactly what a machine with no atlas at all draws. The count on its
  // own cannot tell those two apart, and the two reasons behind it have two different fixes.
  it('says which pack textures did not resolve and why, and how many more there were', async () => {
    const textures = makeBuilder(status({ state: 'stale', needsDownload: false }))
    ;(textures.build as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: status({ state: 'ready', needsDownload: false }),
      pack: {
        dir: '/pack',
        resourcePack: '/packs/MyAddon_rp',
        how: 'manifest dependency',
        blocks: 3,
        fully: 1,
        shapeCube: 0,
        untextured: 2,
        textures: 4,
        reused: 1,
        unresolved: [
          { block: 'myaddon:limestone', face: 'up', texture: 'myaddon:limestone', reason: 'no [.png .tga] found for textures/blocks/limestone', code: 'image-missing' },
          { block: 'myaddon:slate', face: 'north', texture: 'myaddon:slate_side', reason: 'a sentence about terrain_texture.json', code: 'key-not-declared' },
        ],
        unresolvedTotal: 7,
      },
    } satisfies TextureResultWire)
    open(makeController(), textures)
    await settle()

    const joined = vscodeMock.outputLines.join('\n')
    // Seven, not two: the build's own list is capped exactly as the atlas's is, so the same rule
    // about which number a person reads applies on this route too.
    expect(joined).toContain('7 block face(s) in this pack have no image in the atlas')
    expect(joined).toContain('myaddon:limestone (up face, texture "myaddon:limestone")')
    // The two rows are two different fixes, and the codes are what say so -- a PNG that was never
    // exported and a key nobody declared look identical in the preview.
    expect(joined).toContain('usually a PNG that was never exported (1):')
    expect(joined).toContain('terrain_texture.json (1):')
    expect(joined).toContain('... and 5 more not shown.')
    expect(joined).toContain('/packs/MyAddon_rp')
  })

  // The single most likely reason a whole pack draws flat: its resource pack was never located,
  // so not one texture key could resolve. Saying nothing makes that look like a broken feature.
  it('says so when no resource pack was found at all', async () => {
    const textures = makeBuilder(status({ state: 'stale', needsDownload: false }))
    ;(textures.build as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: status({ state: 'ready', needsDownload: false }),
      pack: { dir: '/pack', blocks: 12, fully: 0, shapeCube: 0, untextured: 12, textures: 0, reused: 0 },
    } satisfies TextureResultWire)
    open(makeController(), textures)
    await settle()

    expect(vscodeMock.outputLines.join('\n')).toContain('No resource pack was found for this pack')
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

describe('unresolved textures carried by the atlas', () => {
  const row = { block: 'a:b', face: 'up', texture: 'a:b_top', reason: 'no .png found', code: 'image-missing' }

  it('reads them from the top level of the atlas response, where wire.AtlasOutput puts them', () => {
    expect(unresolvedFromAtlas({ table: { version: 1 }, png: 'AA==', unresolved: [row], unresolvedTotal: 57 })).toEqual({ rows: [row], total: 57 })
  })

  it('treats absence as "nothing unresolved", which is what omitempty makes it', () => {
    // Both fields are omitempty on the Go side, so an atlas that textured everything is the
    // response it always was -- and so is one from an engine too old to record any of this.
    expect(unresolvedFromAtlas({ table: { version: 1 }, png: 'AA==' })).toEqual({ rows: [], total: 0 })
    expect(unresolvedFromAtlas(null)).toEqual({ rows: [], total: 0 })
    expect(unresolvedFromAtlas('nonsense')).toEqual({ rows: [], total: 0 })
  })

  it('never lets the capped sample stand in for the count', () => {
    // 20 rows and a total of 57 must read as 57. The cap is blocktextures.UnresolvedLimit, and a
    // pack with no resource pack at all has one row per face of every block it defines.
    const rows = Array.from({ length: 20 }, (_r, i) => ({ ...row, block: `a:b${String(i)}` }))
    const answer = unresolvedFromAtlas({ unresolved: rows, unresolvedTotal: 57 })
    expect(answer.total).toBe(57)
    expect(summarizeUnresolved(answer.rows, answer.total)[0]).toContain('57 block face(s)')
    expect(summarizeUnresolved(answer.rows, answer.total).pop()).toBe('  ... and 37 more not shown.')
    // A total the engine did not send, or one below what actually arrived, falls back to the rows
    // in hand rather than printing a negative remainder.
    expect(unresolvedFromAtlas({ unresolved: [row] }).total).toBe(1)
    expect(unresolvedFromAtlas({ unresolved: [row], unresolvedTotal: 0 }).total).toBe(1)
  })

  it('drops a malformed row rather than the atlas it arrived on', () => {
    // Textures are an enhancement: a bad entry in a diagnostic list must never cost somebody
    // their preview.
    expect(unresolvedFromAtlas({ unresolved: [row, { block: 'a:c' }, null], unresolvedTotal: 2 })).toEqual({ rows: [row], total: 2 })
    // An empty code is not a token -- carrying it as one would put a row into a group keyed on
    // the empty string instead of under its own sentence.
    expect(unresolvedFromAtlas({ unresolved: [{ ...row, code: '' }] }).rows[0]).toEqual({ block: 'a:b', face: 'up', texture: 'a:b_top', reason: 'no .png found' })
  })

  it('groups the sample by code, and falls back to the sentence for anything it does not know', () => {
    const lines = summarizeUnresolved(
      [
        { block: 'a:x', face: 'up', texture: 'a:x_top', reason: 'the sentence for x', code: 'key-not-declared' },
        { block: 'a:y', face: 'north', texture: 'a:y_side', reason: 'the sentence for y', code: 'key-not-declared' },
        { block: 'a:z', face: 'up', texture: 'a:z', reason: 'something nobody here has heard of', code: 'invented-tomorrow' },
      ],
      3,
    )
    const joined = lines.join('\n')
    // The CODE's phrase, which names the fix, rather than either row's prose -- the tokens are a
    // closed vocabulary and the sentences are English the engine is free to reword.
    expect(joined).toContain('the key is missing from the resource pack’s terrain_texture.json (2):')
    expect(joined).toContain('a:x (up face, texture "a:x_top")')
    // ...and an unknown token is one more group, never an error: that tolerance is what lets the
    // engine name a new failure mode without breaking this.
    expect(joined).toContain('something nobody here has heard of (1):')
    // Nothing was capped, so nothing claims to be a sample.
    expect(joined).not.toContain('sample')
    expect(joined).not.toContain('more not shown')
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

// ---------------------------------------------------------------------------
// COMING BACK TO A PACK LATER: the two things about block textures that used to be settled
// forever in a panel's first second.
//
// ensureTextures had exactly one caller -- the webview's `ready` message. So the atlas a panel
// drew was whatever the machine happened to have when the tab opened, and:
//
//   - repainting a texture with the preview open changed nothing for the rest of the session,
//     even though the engine detects that edit perfectly well (it restales the atlas by CONTENT
//     hash, precisely because a repainted 16x16 PNG usually keeps its size and often its mtime);
//   - "Never" was recorded by the ENGINE, beside the atlas, so that no host asks twice -- which
//     left a CLI flag as the only way to take it back. A decision somebody can only reverse in a
//     terminal is not a reversible decision.
//
// Both are now reachable from inside the editor: a re-check after every generate, and a command.
// ---------------------------------------------------------------------------

/** A builder whose `status` answers a different thing each call, so a test can make the atlas go
 * stale (or a decline get lifted) UNDERNEATH an open panel -- which is the whole subject here and
 * is not expressible with a stub that answers the same thing forever. */
function makeChangingBuilder(states: TextureStatusWire[], built: TextureStatusWire = status({ state: 'ready', needsDownload: false })) {
  const result: TextureResultWire = { status: built }
  let call = 0
  return {
    status: vi.fn(async () => states[Math.min(call++, states.length - 1)] as TextureStatusWire),
    build: vi.fn(async () => result),
    decline: vi.fn(async () => {}),
  } as unknown as TextureBuilder & { status: ReturnType<typeof vi.fn>; build: ReturnType<typeof vi.fn>; decline: ReturnType<typeof vi.fn> }
}

/** Drives a regenerate the way the panel's own controls do, then lets everything settle. */
async function regenerate(): Promise<void> {
  lastPanel().webview.simulateMessage({ type: 'generate', params: { feature: 'wiki:poplar_tree', env: 'plains' } })
  await settle()
}

function atlasPosts(): number {
  return lastPanel().webview.postedMessages.filter((m) => (m as { type: string }).type === 'atlas').length
}

function textureStatusPosts(): number {
  return lastPanel().webview.postedMessages.filter((m) => (m as { type: string }).type === 'textureStatus').length
}

describe('an atlas that changes while the panel is open', () => {
  it('is re-checked after a regenerate, and a stale one is rebuilt from assets already here', async () => {
    // Ready when the tab opened; stale by the next save, because a texture was repainted. The
    // rebuild needs no network (the vanilla assets are cached -- needsDownload is false), so
    // nothing is asked and nothing is fetched.
    const textures = makeChangingBuilder([
      status({ state: 'ready', needsDownload: false, detail: 'ready' }),
      status({ state: 'stale', needsDownload: false, detail: 'built before this pack changed' }),
    ])
    open(makeController(), textures)
    await settle()
    expect(textures.build).not.toHaveBeenCalled()

    await regenerate()

    expect(textures.status.mock.calls.length).toBeGreaterThan(1)
    expect(textures.build).toHaveBeenCalledTimes(1)
    expect(textures.build.mock.calls[0]?.[0]).toMatchObject({ download: false })
    // And the new sheet actually reaches the webview -- a rebuild nobody is handed is the same
    // as no rebuild at all.
    expect(atlasPosts()).toBe(2)
    expect(downloadPrompts()).toBe(0)
  })

  it('says nothing and re-sends nothing when the atlas has not moved', async () => {
    // This fires on EVERY save. The atlas is a base64 PNG; re-posting it per keystroke-burst
    // for a picture the webview is already holding would make the fix worse than the bug.
    const textures = makeChangingBuilder([status({ state: 'ready', needsDownload: false, detail: 'ready' })])
    open(makeController(), textures)
    await settle()
    const before = atlasPosts()

    await regenerate()
    await regenerate()

    expect(atlasPosts()).toBe(before)
  })

  it('never puts the download question in front of someone who was editing', async () => {
    // A background re-check that could raise a modal would interrupt a person mid-save over a
    // 150 MB fetch they did not ask for. The question belongs to the panel's first run and to
    // the command; this path only ever reports.
    const textures = makeChangingBuilder([
      status({ state: 'ready', needsDownload: false, detail: 'ready' }),
      status({ state: 'missing', needsDownload: true, detail: 'the atlas directory was deleted' }),
    ])
    open(makeController(), textures)
    await settle()

    await regenerate()

    expect(downloadPrompts()).toBe(0)
    expect(textures.build).not.toHaveBeenCalled()
    // But it does say where things stand, because the state genuinely changed.
    expect(textureStatus()).toMatchObject({ available: false })
  })

  it('leaves a declined machine alone, and does not repeat the answer back on every save', async () => {
    const textures = makeChangingBuilder([status({ state: 'declined', detail: 'asked once and declined' })])
    open(makeController(), textures)
    await settle()
    const saidOnce = textureStatusPosts()

    await regenerate()
    await regenerate()

    expect(downloadPrompts()).toBe(0)
    expect(textures.build).not.toHaveBeenCalled()
    expect(textureStatusPosts()).toBe(saidOnce)
  })
})

describe('the way back after "Never"', () => {
  it('asks again when the user runs the refresh command, and a build lifts the decline', async () => {
    // THE FINDING. The engine records the decline next to the atlas so that no host asks twice,
    // and undoes it on any successful build ("building is the answer to the question a decline
    // postponed", blocktextures.Ensure). So the route back was always there -- there was just
    // nothing in this editor that could take it.
    vscodeMock.messageAnswers.information = 'Download'
    const textures = makeChangingBuilder([status({ state: 'declined', detail: 'asked once and declined', needsDownload: true })])
    const panel = open(makeController(), textures)
    await settle()
    expect(downloadPrompts()).toBe(0)

    await panel.refreshTextures()
    await settle()

    expect(downloadPrompts()).toBe(1)
    expect(textures.build).toHaveBeenCalledTimes(1)
    expect(textures.build.mock.calls[0]?.[0]).toMatchObject({ download: true })
    expect(postedTypes()).toContain('atlas')
  })

  it('records the decline again if they say no a second time', async () => {
    vscodeMock.messageAnswers.information = 'Never'
    const textures = makeChangingBuilder([status({ state: 'declined', detail: 'asked once and declined', needsDownload: true })])
    const panel = open(makeController(), textures)
    await settle()

    await panel.refreshTextures()
    await settle()

    expect(textures.decline).toHaveBeenCalledTimes(1)
    expect(textures.build).not.toHaveBeenCalled()
  })

  it('tells the user where to find that command, rather than naming a CLI flag they have never run', async () => {
    // The sentence is the feature. "Run featurelab textures -download" is an instruction to open
    // a terminal, find a binary this extension resolved on their behalf and remember a flag --
    // which is why the decline read as permanent.
    const textures = makeChangingBuilder([status({ state: 'declined', detail: 'asked once and declined' })])
    open(makeController(), textures)
    await settle()

    expect(textureStatus()?.reason).toBe(TEXTURES_DECLINED_REASON)
    expect(TEXTURES_DECLINED_REASON).toContain('Refresh Block Textures')
  })

  it('re-delivers a ready atlas on demand, because "refresh" has to do something visible', async () => {
    const textures = makeChangingBuilder([status({ state: 'ready', needsDownload: false, detail: 'ready' })])
    const panel = open(makeController(), textures)
    await settle()
    const before = atlasPosts()

    await panel.refreshTextures()
    await settle()

    expect(atlasPosts()).toBe(before + 1)
  })

  it('says so out loud when the command runs with block textures switched off in settings', async () => {
    // A command that does nothing and says nothing is a command a user reports as broken. The
    // panel row says it too, but the person is looking at the palette, not at the sidebar.
    vscodeMock.mockConfig.blockTextures = false
    const textures = makeChangingBuilder([status({ state: 'ready', needsDownload: false })])
    const panel = open(makeController(), textures)
    await settle()

    await panel.refreshTextures()
    await settle()

    expect(vscodeMock.window.showWarningMessage).toHaveBeenCalled()
    expect(String(vscodeMock.window.showWarningMessage.mock.calls[0]?.[0])).toContain(TEXTURES_DISABLED_REASON)
    expect(textures.build).not.toHaveBeenCalled()
  })
})
