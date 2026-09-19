// manifestSurface.test.ts -- when this extension wakes up, what it offers once it has, and how it
// presents itself in a list of thousands.
//
// WHY THIS SUITE EXISTS. Three first-run findings, none of them visible from inside a running
// window:
//
//   - It activated on `onLanguage:json` alone. A pack's files are routinely `.jsonc` (Bedrock JSON
//     carries comments, and people map it with files.associations), and a window opened on a pack
//     FOLDER has no active editor at all -- so for those users the extension simply did not exist.
//   - Its commands were in the palette unconditionally, including the ones that need an open
//     graph panel, so running one was how you found out it could not work.
//   - Its Marketplace entry had no keywords, one placeholder category and a description that
//     predated half the product.
//
// The manifest is the only place any of that is decidable, so this suite reads it. The paired
// behaviour -- that every contributed command is really registered -- is bundleActivation.test.ts's,
// which reads the same file rather than a list kept in a test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscodeMock from './fixtures/vscodeMock.js'
import { activate, deactivate } from '../src/extension.js'
import { GraphPanel } from '../src/graphPanel.js'
import { SHOW_LOG } from '../src/log.js'

interface Manifest {
  description: string
  categories: string[]
  keywords?: string[]
  icon?: string
  activationEvents: string[]
  contributes: {
    commands: { command: string; title: string }[]
    menus: Record<string, { command: string; when?: string }[]>
    keybindings: { command: string; key: string; mac?: string; when?: string }[]
    configuration: { properties: Record<string, { default?: unknown; description?: string }> }
  }
}

const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest

describe('when the extension wakes up', () => {
  it('activates for every language a pack file plausibly has, not only "json"', () => {
    for (const language of ['json', 'jsonc', 'json5']) {
      expect(manifest.activationEvents, `a .${language} pack file would never start this extension`).toContain(
        `onLanguage:${language}`,
      )
    }
  })

  it('activates on the SHAPE of the workspace, for a window opened on a folder with no editor', () => {
    // The report was a user with only the pack folder open getting nothing at all: no editor means
    // no language, so no onLanguage event ever fires. A features/ directory full of JSON is the
    // cheapest description of "this is a pack" that VS Code can test without starting anything.
    const byShape = manifest.activationEvents.filter((e) => e.startsWith('workspaceContains:'))
    expect(byShape.length).toBeGreaterThan(0)
    expect(byShape.join('\n')).toMatch(/features\//)
    // And not on something every repository has -- an activation event that fires for any project
    // with a manifest.json is an extension that starts in every window.
    expect(byShape.some((e) => e === 'workspaceContains:manifest.json')).toBe(false)
  })

  it('activates for a panel VS Code is bringing back, so a reloaded window is not left with two dead tabs', () => {
    // A restored webview is thrown away when nothing claims its view type -- and nothing can
    // claim it while the extension is asleep. VS Code fires `onWebviewPanel:<viewType>` for
    // exactly this, and the two ids have to match the serializers extension.ts registers
    // (panelState.test.ts pins that half against GraphPanel.VIEW_TYPE / PreviewPanel.VIEW_TYPE).
    expect(manifest.activationEvents).toContain('onWebviewPanel:featurelab.graph')
    expect(manifest.activationEvents).toContain('onWebviewPanel:featurelab.preview')
  })
})

describe('what the palette offers', () => {
  const palette = manifest.contributes.menus['commandPalette'] ?? []
  const whenFor = (command: string): string | undefined => palette.find((e) => e.command === command)?.when

  it('offers the two panel commands unconditionally, because they are the whole product', () => {
    // THIS ASSERTION IS THE REVERSE OF WHAT IT USED TO BE, and the reversal is the finding.
    //
    // Both were gated on `editorLangId =~ /^(json|jsonc|json5)$/`, which reads as tidy and is
    // catastrophic: a window opened on a pack FOLDER has no editor, so it has no editorLangId,
    // so typing "Feature Lab" in the palette offered "Show Log" and nothing else. There is no
    // view, no walkthrough, no keybinding that works without an editor and no other entry point
    // -- so for a newcomer the extension had none at all, which is exactly the public complaint
    // that it could not be started.
    //
    // The gate was also unnecessary on its own terms. The graph is about a PACK, and now finds
    // one from the window's folders (see extension.ts's requireGraphPackRoot); the preview does
    // need a file and says so, in a sentence naming the command that does not. A command that
    // explains itself beats a command nobody can find.
    for (const command of ['featurelab.previewFeature', 'featurelab.openGraph']) {
      expect(
        whenFor(command),
        `${command} is gated in the palette: a window with no editor open cannot find it`,
      ).toBeUndefined()
    }
  })

  it('leaves both panel commands reachable with no editor open at all', () => {
    // The same fact from the other side, and the one worth stating literally: whatever entries
    // the palette section grows, neither of these may ever depend on an editor being open.
    const gated = palette.filter(
      (e) =>
        (e.command === 'featurelab.previewFeature' || e.command === 'featurelab.openGraph') &&
        typeof e.when === 'string' &&
        /editor/i.test(e.when),
    )
    expect(gated.map((e) => e.command)).toEqual([])
  })

  it('offers the panel-only commands only while a graph is open', () => {
    // These act on the active graph panel. Offering them with no panel open means the only way to
    // learn they cannot work is to run one and read a refusal.
    for (const command of ['featurelab.undo', 'featurelab.redo', 'featurelab.retryGraph']) {
      expect(whenFor(command), `${command} has no commandPalette entry`).toBe('featurelab.graphOpen')
    }
  })

  it('leaves Show Log always available, because it is what a failure points at', () => {
    expect(whenFor('featurelab.showLog')).toBeUndefined()
  })

  it('titles every command so it is findable by typing "Feature Lab"', () => {
    for (const command of manifest.contributes.commands) {
      expect(command.title, `${command.command} is not findable under the product name`).toMatch(/^Feature Lab: /)
    }
  })
})

describe('what the request timeout setting says it does', () => {
  const timeout = manifest.contributes.configuration.properties['featurelab.requestTimeoutMs']

  it('says it measures SILENCE, not total time', () => {
    // The old description said "how long to wait for the engine to respond", and that is what it
    // did: a `graph` over an 11250-feature pack takes 42.8s on the shipped binary and was killed
    // at 30s while the engine was reading files and saying so once a second. The deadline now
    // runs from the last progress notification (engineProcess.ts's RequestTimeoutError), and a
    // setting whose description still described the old rule would be a second bug.
    expect(timeout?.description ?? '').toMatch(/silent|silence/i)
    expect(timeout?.description ?? '').toMatch(/progress/i)
  })

  it('still names generate\'s own floor, which is a separate promise the panel makes', () => {
    expect(timeout?.description ?? '').toMatch(/floor/i)
    expect(timeout?.default).toBe(30000)
  })
})

describe("the graph panel's own keybindings", () => {
  const bindings = manifest.contributes.keybindings

  it('binds VS Code\'s own undo key, scoped to the graph panel having focus', () => {
    const undo = bindings.find((b) => b.command === 'featurelab.undo')
    expect(undo, 'Ctrl+Z does nothing in the graph panel').toBeDefined()
    expect(undo?.key).toBe('ctrl+z')
    expect(undo?.mac).toBe('cmd+z')
    // Scoped by the panel's OWN view type: a binding on ctrl+z with a looser `when` would take the
    // key away from the text editor, which is the one place it already worked.
    expect(undo?.when).toBe(`activeWebviewPanelId == '${GraphPanel.VIEW_TYPE}' && !featurelab.graphTyping`)
  })

  it('binds redo both ways round, because both are in people\'s fingers', () => {
    const redo = bindings.filter((b) => b.command === 'featurelab.redo')
    expect(redo.map((b) => b.key).sort()).toEqual(['ctrl+shift+z', 'ctrl+y'])
    for (const binding of redo) expect(binding.when).toContain(GraphPanel.VIEW_TYPE)
  })

  it('stands down while the author is typing into the panel, on every history key', () => {
    // THE REPORT: Ctrl+Z in the rename box, or halfway through a Molang expression, did not undo
    // the typing -- it reverted the last write to the pack. VS Code's webview shim treats undo
    // and redo as keys the HOST owns: it calls preventDefault on them, so the text control's own
    // undo never happens, and forwards the keydown to the workbench, which runs this binding.
    //
    // A `when` clause cannot see inside a webview, so it cannot ask where the keyboard is. The
    // panel has to say so -- a `typingFocus` message, which extension.ts turns into
    // `featurelab.graphTyping` -- and the binding negates that. The webview also stops the key in
    // the capture phase, but that depends on where VS Code's shim attaches its own listener,
    // which is an implementation detail of the editor; this is the half that does not.
    for (const binding of bindings.filter((b) => b.command === 'featurelab.undo' || b.command === 'featurelab.redo')) {
      expect(
        binding.when,
        `${binding.command} on ${binding.key} still fires while a text box in the panel has focus`,
      ).toContain('!featurelab.graphTyping')
    }
  })

  it('scopes every graph binding to the graph, so none of them is global', () => {
    for (const binding of bindings) {
      expect(binding.when, `${binding.command} on ${binding.key} is bound unconditionally`).toBeDefined()
    }
  })
})

describe('how the extension presents itself in a listing', () => {
  it('describes what it is now, not only what it did first', () => {
    // The old one said "Live preview for Bedrock worldgen feature/rule JSON" and predated the node
    // editor entirely -- half the product, and the half the screenshots are of.
    expect(manifest.description).toMatch(/node editor/i)
    expect(manifest.description).toMatch(/preview/i)
    expect(manifest.description.length).toBeGreaterThan(60)
  })

  it('carries keywords somebody would actually search for', () => {
    const keywords = (manifest.keywords ?? []).map((k) => k.toLowerCase())
    expect(keywords).toContain('minecraft')
    expect(keywords).toContain('bedrock')
    expect(keywords).toContain('worldgen')
  })

  it('is filed under something more specific than "Other"', () => {
    expect(manifest.categories.length).toBeGreaterThan(1)
    expect(manifest.categories).not.toEqual(['Other'])
  })

  it('has a changelog for the Marketplace to show', () => {
    // VS Code picks CHANGELOG.md up by name; there is no manifest field for it. A Marketplace page
    // with no changelog tab is most of what "looks abandoned" means.
    expect(
      fs.existsSync(path.join(root, 'CHANGELOG.md')),
      'apps/vscode/CHANGELOG.md is missing -- the Marketplace page has no changelog tab without it',
    ).toBe(true)
  })

  it('has an icon, and one that is really on disk', () => {
    // vsce fails on a missing icon -- at release time, long after the edit that broke it. An
    // extension with no icon at all gets the grey placeholder, which is the other half of "the
    // Marketplace page looks abandoned".
    expect(manifest.icon, 'no "icon" field: the listing would show the default placeholder').toBeDefined()
    expect(
      fs.existsSync(path.join(root, manifest.icon ?? '')),
      `the "icon" field names ${String(manifest.icon)}, which is not there`,
    ).toBe(true)
  })

  it('tells vsce where the README\'s images really live', () => {
    // vsce rewrites relative image paths against the REPOSITORY root, and this extension lives in
    // apps/vscode -- so docs/graph-full.png resolves to <repo>/docs/..., which is the wiki, and
    // every screenshot on the Marketplace page 404s. Invisible until the page is published.
    const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> })
      .scripts
    expect(scripts['package']).toContain('--baseImagesUrl')
    expect(scripts['package']).toContain('apps/vscode')
  })
})

describe('a history command run with no graph open', () => {
  const temporary: string[] = []

  beforeEach(() => {
    vscodeMock.resetMock()
    vscodeMock.mockConfig['binaryPath'] = ''
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-ext-'))
    temporary.push(extensionPath)
    activate({
      subscriptions: [],
      extensionPath,
      extensionUri: new vscodeMock.MockUri(extensionPath),
    } as unknown as import('vscode').ExtensionContext)
  })

  afterEach(() => {
    deactivate()
    for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    vi.clearAllMocks()
  })

  it('registers Undo and Redo at activation, so the keybinding has something to reach', () => {
    expect([...vscodeMock.registeredCommands.keys()]).toEqual(
      expect.arrayContaining(['featurelab.undo', 'featurelab.redo', 'featurelab.retryGraph']),
    )
  })

  it('says so in words, with the log button every other message has', async () => {
    await vscodeMock.registeredCommands.get('featurelab.undo')?.()

    expect(vscodeMock.warningMessages.map((m) => m.message).join('\n')).toMatch(/no feature graph open to undo in/i)
    expect(vscodeMock.warningMessages[0]?.actions).toContain(SHOW_LOG)
  })

  it('refuses a retry the same way, naming the command that would make one possible', async () => {
    await vscodeMock.registeredCommands.get('featurelab.retryGraph')?.()

    const said = vscodeMock.errorMessages.map((m) => m.message).join('\n')
    expect(said).toMatch(/no feature graph open to retry/i)
    expect(said).toMatch(/Open Feature Graph/)
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
  })
})

// ---------------------------------------------------------------------------
// The one gesture that can undo a block-texture decline.
//
// The engine records "Never" beside the atlas so that no host asks twice -- correct, and it
// meant the only way back was `featurelab textures -download` in a terminal. A user of this
// extension never sees that binary: it is resolved on their behalf, it is not on their PATH, and
// nothing in the UI ever named the flag. So the decision was, in practice, permanent. The
// command is what makes it a decision instead of an accident.
// ---------------------------------------------------------------------------
describe('the way back into block textures', () => {
  it('is contributed as a palette command, because a CLI flag is not a route back', () => {
    const refresh = manifest.contributes.commands.find((c) => c.command === 'featurelab.refreshBlockTextures')
    expect(refresh, 'featurelab.refreshBlockTextures is not in the manifest').toBeDefined()
    expect(refresh?.title).toMatch(/^Feature Lab: /)
  })

  it('is offered unconditionally, since a declined machine has no panel-state to gate on', () => {
    const palette = manifest.contributes.menus['commandPalette'] ?? []
    expect(palette.find((e) => e.command === 'featurelab.refreshBlockTextures')?.when).toBeUndefined()
  })
})
