// commandFeedback.test.ts -- what a person SEES between running one of this extension's
// commands and getting an answer, and what they are told when there isn't one.
//
// WHY THIS SUITE EXISTS. Both commands could reach an end where nothing whatsoever appeared:
// "Feature Lab: Open Feature Graph" on a JSON file outside a pack threw straight past its own
// handler (resolvePackRoot THROWS; the handler tested its result for null), and every engine
// failure that happened before a panel existed had nowhere to go. The report was "I could not
// get the node editor to open" with nothing on screen saying why, and it was reproducible in one
// gesture.
//
// So every assertion here is about the SENTENCE, the BUTTON on it, and the LOG -- never about
// which function was called. A test that checked `showErrorMessage` had been invoked would pass
// on a message nobody can act on, which is most of the way to the bug it is guarding.
//
// It drives the REAL src/extension.ts: activate() registers the real command bodies into the
// mock's command table (fixtures/vscodeMock.ts), and the tests invoke them the way VS Code
// would. Nothing here re-implements a command.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscodeMock from './fixtures/vscodeMock.js'
import { activate, deactivate } from '../src/extension.js'
import { forgetEngineProbes } from '../src/engineCheck.js'
import { forgetStaleEngineReports } from '../src/extension.js'
import { SHOW_LOG } from '../src/log.js'

const FEATURE_JSON = JSON.stringify(
  { format_version: '1.21.110', 'minecraft:single_block_feature': { description: { identifier: 'wiki:lamp' } } },
  null,
  2,
)

/** Every temp directory a test made, removed afterwards. */
const temporary: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

/** A behaviour pack on disk: a manifest, a features/ directory, and whatever files are asked
 * for. Real files, because resolvePackRoot walks the real filesystem and a fake one would be
 * testing the fake. */
function makePack(files: Record<string, string> = {}): string {
  const root = tempDir('fl-pack-')
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"format_version":2}', 'utf8')
  fs.mkdirSync(path.join(root, 'features'), { recursive: true })
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }
  return root
}

function makeDocument(fsPath: string) {
  const text = fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf8') : '{}'
  return {
    uri: { fsPath, scheme: 'file', toString: () => `file://${fsPath}` },
    fileName: fsPath,
    languageId: 'json',
    getText: () => text,
    lineCount: text.split('\n').length,
    lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
  }
}

/** Opens `fsPath` in the (mock) editor and starts the extension, the way a window that already
 * had that file open would. */
function openAndActivate(fsPath: string | undefined, extensionPath: string): void {
  vscodeMock.window.activeTextEditor = fsPath === undefined ? undefined : { document: makeDocument(fsPath) }
  activate({
    subscriptions: [],
    extensionPath,
    extensionUri: new vscodeMock.MockUri(extensionPath),
  } as unknown as import('vscode').ExtensionContext)
}

async function run(command: string): Promise<void> {
  const handler = vscodeMock.registeredCommands.get(command)
  expect(handler, `${command} is not registered`).toBeDefined()
  await handler?.()
}

/** Waits for the command to have created its panel, then plays the part of the webview
 * reporting that its script is running.
 *
 * POLLED, never slept on. The panel is created after an engine probe and a pack load, both of
 * which are real child processes: a fixed sleep is a guess about how long those take on a
 * machine that is also running thirty other test files, and a guess that is wrong produces a
 * failure about a missing panel rather than about the thing under test. */
async function webviewReports(what: string, since: number): Promise<vscodeMock.MockWebviewPanel> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const panel = vscodeMock.createdPanels[since]
    if (panel !== undefined) {
      panel.webview.simulateMessage({ type: 'ready' })
      return panel
    }
    if (Date.now() > deadline) throw new Error(`the command never created a webview panel for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Every error sentence shown, joined -- the thing a person actually read. */
function shownErrors(): string {
  return vscodeMock.errorMessages.map((m) => m.message).join('\n')
}

function loggedText(): string {
  return vscodeMock.outputLines.join('\n')
}

beforeEach(() => {
  vscodeMock.resetMock()
  forgetEngineProbes()
  forgetStaleEngineReports()
  vscodeMock.mockConfig['binaryPath'] = ''
})

afterEach(() => {
  deactivate()
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  vi.clearAllMocks()
})

describe('a command run with no engine to run it with', () => {
  it('names the path it looked for the engine at, and offers the log', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    // An extension directory with no bin/ in it -- exactly what a source checkout that has not
    // run "npm run build:binary" looks like, which is the commonest way to hit this.
    const extensionPath = tempDir('fl-ext-')
    openAndActivate(path.join(pack, 'features', 'lamp.json'), extensionPath)

    await run('featurelab.openGraph')

    const expectedPath = path.join(extensionPath, 'bin', process.platform === 'win32' ? 'featurelab.exe' : 'featurelab')
    expect(shownErrors()).toContain(expectedPath)
    expect(shownErrors()).toMatch(/engine executable is missing/i)
    // Naming the path is not enough on its own: without a way to reach the remedy, a user is
    // left with a path and no idea what to put there.
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
    // And the remedy really is in the log, written BEFORE the notification -- so a user who
    // presses the button lands on the explanation rather than on an empty panel.
    expect(loggedText()).toMatch(/featurelab\.binaryPath/)
    expect(loggedText()).toMatch(/npm run build:binary/)
  })

  it('says the same thing for the preview command, which had the same hole', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    const extensionPath = tempDir('fl-ext-')
    openAndActivate(path.join(pack, 'features', 'lamp.json'), extensionPath)

    await run('featurelab.previewFeature')

    expect(shownErrors()).toMatch(/engine executable is missing/i)
    expect(shownErrors()).toContain(extensionPath)
  })

  it('reveals the log when the user presses the button on the notification', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))
    // The user presses "Show log".
    vscodeMock.messageAnswers.error = SHOW_LOG

    await run('featurelab.openGraph')
    // The notification's promise settles a tick after the command returns.
    await new Promise((resolve) => setImmediate(resolve))

    expect(vscodeMock.outputShown.count).toBeGreaterThan(0)
  })

  it('reveals the log from the Show Log command, so the button is not the only way in', async () => {
    openAndActivate(undefined, tempDir('fl-ext-'))
    await run('featurelab.showLog')
    expect(vscodeMock.outputShown.count).toBe(1)
  })
})

describe('a command run on a file that is not in a pack', () => {
  it('names the file and says it is not inside a behaviour pack', async () => {
    // A JSON file in a directory with no manifest.json and none of the pack subdirectories --
    // the ordinary "I opened some other JSON file and pressed the button" case.
    const loose = tempDir('fl-loose-')
    const file = path.join(loose, 'tsconfig.json')
    fs.writeFileSync(file, '{"compilerOptions":{}}', 'utf8')
    openAndActivate(file, tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    // This is the exact gesture that used to produce NOTHING: resolvePackRoot throws, and the
    // handler tested its result for null.
    expect(vscodeMock.errorMessages).toHaveLength(1)
    expect(shownErrors()).toContain(file)
    expect(shownErrors()).toMatch(/not inside a behaviour pack/i)
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
    // The long form -- what was looked for and where -- belongs in the log, not the sentence.
    expect(loggedText()).toMatch(/manifest\.json/)
  })

  it('says it for the preview command too, before opening a panel that could only show it', async () => {
    const loose = tempDir('fl-loose-')
    const file = path.join(loose, 'settings.json')
    fs.writeFileSync(file, '{}', 'utf8')
    openAndActivate(file, tempDir('fl-ext-'))

    await run('featurelab.previewFeature')

    expect(shownErrors()).toContain(file)
    expect(shownErrors()).toMatch(/not inside a behaviour pack/i)
    // No panel: a preview whose only content would be "this file is not in a pack" is a window
    // to close, not an answer.
    expect(vscodeMock.createdPanels).toHaveLength(0)
  })

})

// ---------------------------------------------------------------------------
// The report this section exists for: "I typed Feature Lab and the only thing offered was Show
// Log." A window opened on a pack FOLDER has no editor, so the palette's `editorLangId` gate hid
// both panel commands -- and Open Feature Graph, had it been reachable, would have refused for
// want of an editor it never actually needed. The manifest half is manifestSurface.test.ts's; this
// is the half that has to still work once the gate is gone.
// ---------------------------------------------------------------------------
describe('the feature graph, in a window opened on a pack folder with nothing in the editor', () => {
  /** A window whose folders are exactly these paths. */
  function openFolders(...folders: string[]): void {
    vscodeMock.workspace.workspaceFolders = folders.map((f) => ({ uri: new vscodeMock.MockUri(f) }))
  }

  it('works out the pack from the folder, so no file has to be opened first', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    openFolders(pack)
    // No editor at all -- the exact state of a window that has just opened a folder.
    openAndActivate(undefined, tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    // It got as far as needing an engine, which is proof it found a pack: the old code refused
    // before ever looking. (This checkout may have no engine built, so the engine failure is
    // the expected end -- what matters is that it is not "open a file first".)
    expect(shownErrors()).not.toMatch(/editor/i)
    expect(loggedText()).toContain(pack)
  })

  it('finds a pack one level down, for the parent folder the README warns about opening', async () => {
    // The layout everybody actually has: a repository holding BP/ and RP/ side by side. Opening
    // the parent is the documented mistake, and refusing to find the pack inside it is a worse
    // answer than finding it.
    const parent = tempDir('fl-repo-')
    const bp = path.join(parent, 'behaviour_pack')
    fs.mkdirSync(path.join(bp, 'features'), { recursive: true })
    fs.writeFileSync(path.join(bp, 'manifest.json'), '{"format_version":2}', 'utf8')
    fs.mkdirSync(path.join(parent, 'resource_pack'), { recursive: true })
    openFolders(parent)
    openAndActivate(undefined, tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(loggedText()).toContain(bp)
  })

  it('says what to do when the window holds no pack at all, rather than naming an editor', async () => {
    const empty = tempDir('fl-empty-')
    openFolders(empty)
    openAndActivate(undefined, tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(shownErrors()).toMatch(/no behaviour pack was found/i)
    expect(shownErrors()).toContain(empty)
    // The remedy is named in the sentence: a message that only says "not found" leaves somebody
    // guessing at what would count.
    expect(shownErrors()).toMatch(/manifest\.json|features\//)
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
  })

  it('asks for the pack folder when no folder is open either', async () => {
    openAndActivate(undefined, tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(shownErrors()).toMatch(/open your behaviour pack folder/i)
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
  })

  it('still asks for a file for the PREVIEW, and points at the graph instead', async () => {
    // Not an oversight that this one refuses: a preview is of ONE feature, and a folder cannot
    // say which. What it can do is name the command that does work from here.
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    openFolders(pack)
    openAndActivate(undefined, tempDir('fl-ext-'))

    await run('featurelab.previewFeature')

    expect(shownErrors()).toMatch(/open a feature JSON file in the editor first/i)
    expect(shownErrors()).toMatch(/Open Feature Graph/)
  })
})

describe('a command run against an engine that will not run', () => {
  it('names the path and points at the setting that changes it', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    // A file that exists and is not an executable. binaryResolver only proves a file is THERE;
    // this is the whole of what engineCheck.ts was added for.
    const notAnEngine = path.join(tempDir('fl-bin-'), 'featurelab-notreally')
    fs.writeFileSync(notAnEngine, 'this is not a program\n', 'utf8')
    vscodeMock.mockConfig['binaryPath'] = notAnEngine
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(shownErrors()).toContain(notAnEngine)
    expect(shownErrors()).toMatch(/would not run|could not be loaded/i)
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
    expect(loggedText()).toContain(notAnEngine)
  })
})

/** The engine this extension ships, if this checkout has built one. The success-path tests need
 * a real one and there is nothing honest to put in its place -- a fake engine would make "the
 * command still works" a statement about the fake. */
const BUILT_ENGINE = path.resolve(
  __dirname,
  '..',
  'bin',
  process.platform === 'win32' ? 'featurelab.exe' : 'featurelab',
)
const haveEngine = fs.existsSync(BUILT_ENGINE)

describe.skipIf(!haveEngine)('a command that works', () => {
  beforeEach(() => {
    // The mock's default wait is 5s, which is plenty for a one-feature pack on an idle machine
    // and not plenty when this file runs beside thirty others, several of which are driving
    // their own Chromium. A wait that expires here fails as "the engine would not answer",
    // which says nothing about the thing under test.
    vscodeMock.mockConfig['requestTimeoutMs'] = 60_000
  })
  afterEach(() => {
    vscodeMock.mockConfig['requestTimeoutMs'] = 5000
  })

  it('opens the graph, logs what it drew, and shows no error', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    vscodeMock.mockConfig['binaryPath'] = BUILT_ENGINE
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    // Started, not awaited: the panel's webview has to report `ready` before the host asks for a
    // graph, and in a real window that happens while the command is still waiting. Driving it in
    // that order is the point -- the command must not return before there is something on screen.
    const running = run('featurelab.openGraph')
    const panel = await webviewReports('the graph', 0)
    await running

    expect(vscodeMock.errorMessages, `unexpected error: ${shownErrors()}`).toHaveLength(0)
    // What it drew, in the log, with the version of the engine that drew it.
    expect(loggedText()).toMatch(/drew 1 node\(s\)/)
    expect(loggedText()).toContain(BUILT_ENGINE)
    // "1 feature file(s) loaded", not "1 feature(s)". The count changed MEANING -- it is now what
    // built, with fileCounts carrying what was read -- and the log says which of the two it is
    // printing. This runs against the engine binary that is actually built, which may predate
    // fileCounts; without the second number the phrase has no "of", which is the honest answer
    // for an engine that did not say rather than a gap invented on its behalf.
    expect(loggedText()).toMatch(/Pack loaded: 1 feature file\(s\) loaded/)
    // And the graph really went to the webview, rather than the command merely claiming success.
    const posted = panel.webview.postedMessages.map((m) => (m as { type?: string }).type)
    expect(posted).toContain('graph')
  }, 60_000)

  it('warns, rather than failing, when the pack has nothing in it to preview', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    // The file is in the pack; the pack's features/ directory is then emptied, which is what a
    // pack somebody has just created looks like.
    fs.rmSync(path.join(pack, 'features', 'lamp.json'))
    vscodeMock.mockConfig['binaryPath'] = BUILT_ENGINE
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    const running = run('featurelab.previewFeature')
    await webviewReports('the preview', 0)
    await running

    // An empty pack is a real state somebody is working towards, not a failure -- so it is said
    // in words and the panel still opens, rather than being refused.
    expect(vscodeMock.warningMessages.map((m) => m.message).join('\n')).toMatch(
      /declares no features and no feature rules/i,
    )
    expect(vscodeMock.warningMessages[0]?.actions).toContain(SHOW_LOG)
    // And the run that then found nothing to place is reported as itself, naming the file the
    // command was about -- not as "the command failed unexpectedly", and not only as text
    // inside a panel that had just appeared.
    expect(shownErrors()).toMatch(/could not preview lamp\.json/)
    // The sentence is short; the reason is in the log, under the full path of the file it is
    // about, which is what a "Show log" button has to land somebody on.
    expect(loggedText()).toContain(path.join(pack, 'features', 'lamp.json'))
    expect(loggedText()).toMatch(/The first run for .* failed:/)
  }, 60_000)
})

describe('what a command says while it is working', () => {
  it('raises one progress notification naming the command, and reports each step into it', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    // process.execPath is a real executable that is not featurelab: it runs (so the engine check
    // passes -- "it ran and did not understand `version`" is a working older engine, not a
    // broken one) and then fails to serve, which is exactly the run that has to stay visible
    // from start to finish.
    vscodeMock.mockConfig['binaryPath'] = process.execPath
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(vscodeMock.progressCalls.map((c) => c.title)).toContain('Feature Lab: opening the feature graph')
    // The steps are what turn a five-second wait from a hang into a sequence.
    expect(vscodeMock.progressReports).toContain('checking the engine')
    expect(vscodeMock.progressReports).toContain('loading the pack')
    // And the wait is abandonable, because it is a wait on an engine this extension cannot
    // interrupt -- see progress.ts's RunOptions.
    expect(vscodeMock.progressCalls.find((c) => c.title === 'Feature Lab: opening the feature graph')?.cancellable).toBe(true)
  })

  it('shows the status-bar spinner while a command runs and takes it down afterwards', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    vscodeMock.mockConfig['binaryPath'] = process.execPath
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    const spinner = vscodeMock.statusBarItems[0]
    expect(spinner, 'no status-bar item was ever created').toBeDefined()
    // It said what it was doing while it was up...
    expect(spinner?.shown.join('\n')).toMatch(/opening the feature graph/)
    // ...and it is not still spinning now that the command is over.
    expect(spinner?.visible).toBe(false)
  })

  it('logs the engine path it chose and the pack root it detected', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    vscodeMock.mockConfig['binaryPath'] = process.execPath
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(loggedText()).toContain(`Engine binary: ${process.execPath}`)
    expect(loggedText()).toContain(`Pack root: ${pack}`)
    expect(loggedText()).toContain(path.join(pack, 'features', 'lamp.json'))
  })

  it('ends in a visible error when the engine cannot load the pack, rather than an empty panel', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    vscodeMock.mockConfig['binaryPath'] = process.execPath
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(vscodeMock.errorMessages.length).toBeGreaterThan(0)
    expect(shownErrors()).toContain(pack)
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
  })

  it("puts the engine's own output in the log, verbatim, rather than only in a crash summary", async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    // `node serve` fails with a real message on stderr. Whatever the engine says while it is
    // coming up is the one piece of direct evidence about why it will not work, and it used to
    // be collected into a buffer that was read only if the process died.
    vscodeMock.mockConfig['binaryPath'] = process.execPath
    openAndActivate(path.join(pack, 'features', 'lamp.json'), tempDir('fl-ext-'))

    await run('featurelab.openGraph')

    expect(loggedText()).toContain('engine:')
    // Node's own words for "there is no file called serve here", not a paraphrase of them.
    expect(loggedText()).toMatch(/Cannot find module|MODULE_NOT_FOUND/)
  })
})

// ---------------------------------------------------------------------------
// AN ENGINE IN bin/ THAT IS NOT THE ONE THIS EXTENSION SHIPPED.
//
// bin/ is chosen by `process.platform` and nothing else, so one checkout opened on two kinds of
// host ends up with both spellings in it -- `featurelab.exe` from the Windows window and
// `featurelab` from the Remote-WSL one -- and only whichever host last ran "npm run
// build:binary" has a current engine. The other picks up whatever its spelling last pointed at,
// runs it, and said nothing whatsoever. Every engine feature missing after that reads as a
// broken editor.
//
// "Too old" is defined as "does not report this extension's own version", because the bundled
// engine is stamped with exactly that (scripts/build-binary.mjs) -- see bundledEngineFreshness
// for why the rule is equality rather than a comparison. It is a WARNING and the engine is used
// anyway; refusing to start over a version string would be worse than the silence it replaces.
// ---------------------------------------------------------------------------

/** An extension directory whose bin/ holds a "featurelab" that really does run -- a copy of the
 * node binary already running this test. It answers the probe (it starts, and exits non-zero
 * complaining about a script called "version"), which is precisely the case in question: a file
 * that RUNS and is not the engine this build shipped. A stub that could not start would be
 * testing the wrong branch. */
function extensionWithForeignEngine(version: string): string {
  const root = tempDir('fl-ext-')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'featurelab', version }), 'utf8')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  placeRunnableBinary(path.join(root, 'bin', process.platform === 'win32' ? 'featurelab.exe' : 'featurelab'))
  return root
}

/** The node binary, copied ONCE per run and hard-linked after that. The node executable is
 * ~80 MB on Windows and these tests need three of it; copying each time costs more than the
 * assertions do. A link is a different name for the same file, which is exactly what is wanted. */
let masterBinary: string | null = null
let masterBinaryDir: string | null = null
afterAll(() => {
  if (masterBinaryDir !== null) fs.rmSync(masterBinaryDir, { recursive: true, force: true, maxRetries: 3 })
  masterBinaryDir = null
  masterBinary = null
})
function placeRunnableBinary(destination: string): void {
  if (masterBinary === null) {
    // Deliberately NOT one of the per-test temp directories: those are removed after every
    // test, and this one has to outlive them or the second test pays for the copy again.
    masterBinaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-engine-'))
    masterBinary = path.join(masterBinaryDir, 'engine')
    fs.copyFileSync(process.execPath, masterBinary)
  }
  try {
    fs.linkSync(masterBinary, destination)
  } catch {
    // A different volume, or a filesystem with no hard links. Correctness over speed.
    fs.copyFileSync(masterBinary, destination)
  }
}

function shownWarnings(): string {
  return vscodeMock.warningMessages.map((m) => m.message).join('\n')
}

describe('a bundled engine that is not the one this extension shipped', () => {
  it('says so, names the path, and uses it anyway', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    const extensionPath = extensionWithForeignEngine('0.1.1')
    openAndActivate(path.join(pack, 'features', 'lamp.json'), extensionPath)

    await run('featurelab.openGraph')

    const bundled = path.join(extensionPath, 'bin', process.platform === 'win32' ? 'featurelab.exe' : 'featurelab')
    expect(shownWarnings()).toContain(bundled)
    expect(shownWarnings()).toMatch(/not the one this extension shipped/i)
    // Used anyway: the command went on to drive it, and failed for its own reasons rather than
    // being refused up front over a version string.
    expect(shownWarnings()).toMatch(/being used anyway/i)
    // The remedy is in the log, where the button on the notification leads.
    expect(loggedText()).toMatch(/npm run build:binary/)
  })

  it('says it once per window, not once per command', async () => {
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    openAndActivate(path.join(pack, 'features', 'lamp.json'), extensionWithForeignEngine('0.1.1'))

    await run('featurelab.openGraph')
    await run('featurelab.openGraph')
    await run('featurelab.previewFeature')

    const said = vscodeMock.warningMessages.filter((m) => /not the one this extension shipped/i.test(m.message))
    expect(said).toHaveLength(1)
  })

  it('never questions an engine pinned with featurelab.binaryPath', async () => {
    // THE CASE THIS MUST NOT BREAK. Pointing at an older engine on purpose is the documented
    // reason the setting exists -- and it is deliberately not required to be called anything in
    // particular, so there is no version this extension could hold it to in the first place.
    const pack = makePack({ 'features/lamp.json': FEATURE_JSON })
    const pinned = path.join(tempDir('fl-bin-'), process.platform === 'win32' ? 'featurelab-0.0.9.exe' : 'featurelab-0.0.9')
    placeRunnableBinary(pinned)
    vscodeMock.mockConfig['binaryPath'] = pinned
    openAndActivate(path.join(pack, 'features', 'lamp.json'), extensionWithForeignEngine('0.1.1'))

    await run('featurelab.openGraph')

    expect(shownWarnings()).not.toMatch(/not the one this extension shipped/i)
  })
})

// ---------------------------------------------------------------------------
// Refreshing the block textures with nothing to refresh.
// ---------------------------------------------------------------------------
describe('the block-texture refresh command', () => {
  it('is registered at activation, so a declined machine has a route back in the palette', () => {
    openAndActivate(undefined, tempDir('fl-ext-'))
    expect([...vscodeMock.registeredCommands.keys()]).toContain('featurelab.refreshBlockTextures')
  })

  it('refuses in words when there is no preview open, naming the command that opens one', async () => {
    openAndActivate(undefined, tempDir('fl-ext-'))

    await run('featurelab.refreshBlockTextures')

    expect(shownErrors()).toMatch(/no preview open/i)
    expect(shownErrors()).toMatch(/Preview Feature/)
    expect(vscodeMock.errorMessages[0]?.actions).toContain(SHOW_LOG)
  })
})
