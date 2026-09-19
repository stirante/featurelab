// graphTypingContext.test.ts -- the `featurelab.graphTyping` context key: who sets it, and every
// way it has to come back off again.
//
// WHY THIS SUITE EXISTS. The report was that Ctrl+Z while typing in the graph panel undid the last
// FILE WRITE instead of undoing the typing. package.json binds ctrl+z to `featurelab.undo` while
// the graph panel is the active one, and VS Code's webview shim treats undo and redo as keys the
// host owns: it calls preventDefault on them -- so the text control's own undo never happens --
// and forwards the keydown to the workbench, which runs the command. `panel.undoLastChange()`
// then reverts the last write to the pack.
//
// A `when` clause cannot see inside a webview, so it cannot ask where the keyboard is. The panel
// says so instead, with a `typingFocus` message, and extension.ts turns that into a context key
// the binding negates.
//
// THE SECOND BUG IS THE ONE MOST OF THIS FILE IS ABOUT. A key left stuck on -- a panel closed
// mid-edit, hidden mid-edit, or reloaded mid-edit -- disables undo in the whole window, which is
// worse than the thing being fixed. Every exit from a text box is a test below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscodeMock from './fixtures/vscodeMock.js'
import { GraphPanel, onGraphTypingChanged } from '../src/graphPanel.js'
import { activate, deactivate } from '../src/extension.js'
import type { PreviewController } from '../src/previewController.js'

const temporary: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

/** A pack root with the two things the panel looks at, so a load does not fail for a reason this
 * suite is not about. */
function makePack(): string {
  const root = tempDir('fl-typing-')
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"format_version":2}', 'utf8')
  fs.mkdirSync(path.join(root, 'features'), { recursive: true })
  return root
}

/** The smallest engine the panel will accept. Nothing here is asserted on: this suite is about a
 * context key, and the graph is only what the panel does on the way to being open. */
const engine = {
  graph: () => Promise.resolve({ nodes: [], edges: [], diagnostics: [] }),
  listTypes: () => Promise.resolve({ types: [] }),
  loadPackSummary: () =>
    Promise.resolve({ warnings: [], featureCount: 0, ruleCount: 0, structureCount: 0, biomeCount: 0 }),
  reloadPack: () =>
    Promise.resolve({ warnings: [], featureCount: 0, ruleCount: 0, structureCount: 0, biomeCount: 0 }),
  reloadPackFile: () =>
    Promise.resolve({ warnings: [], featureCount: 0, ruleCount: 0, structureCount: 0, biomeCount: 0 }),
} as unknown as PreviewController

/** A webview panel that DOES fake view state, which the shared mock deliberately does not.
 *
 * The shared MockWebviewPanel has no `active` and no onDidChangeViewState, because with one graph
 * open every other suite gets the same answer either way. This suite is specifically about what
 * happens when a panel stops being the focused one, so it needs the event. */
class ViewStatePanel extends vscodeMock.MockWebviewPanel {
  active = true
  visible = true
  private viewStateHandler: (() => void) | null = null

  onDidChangeViewState(handler: () => void): { dispose(): void } {
    this.viewStateHandler = handler
    return { dispose: () => {} }
  }

  /** What VS Code does when the author clicks into the editor beside the graph, or when the tab
   * is hidden behind another one. */
  simulateViewState(state: { active: boolean; visible?: boolean }): void {
    this.active = state.active
    this.visible = state.visible ?? state.active
    this.viewStateHandler?.()
  }
}

const opened: GraphPanel[] = []

/** Opens a graph panel on a fresh pack, through `revive` because that is the entry point that
 * takes a panel object -- which is how this suite gets one that fakes view state. */
function openPanel(): { panel: GraphPanel; stub: ViewStatePanel } {
  const packRoot = makePack()
  const stub = new ViewStatePanel()
  const panel = GraphPanel.revive(
    stub as unknown as import('vscode').WebviewPanel,
    new vscodeMock.MockUri(packRoot) as unknown as import('vscode').Uri,
    engine,
    packRoot,
    5_000,
    () => {},
    () => {},
  )
  opened.push(panel)
  return { panel, stub }
}

/** Lets the panel's fire-and-forget message handling finish. onDidReceiveMessage cannot be
 * awaited, so this is how a test waits for one without a sleep. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}

let reported: boolean[] = []

beforeEach(() => {
  vscodeMock.resetMock()
  reported = []
  onGraphTypingChanged((typing) => reported.push(typing))
})

afterEach(() => {
  onGraphTypingChanged(null)
  for (const panel of opened.splice(0)) panel.dispose()
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  vi.clearAllMocks()
})

describe('what the panel reports about where the keyboard is', () => {
  it('says so when focus enters a text control, and says so again when it leaves', () => {
    const { stub } = openPanel()

    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })
    expect(reported).toEqual([true])

    stub.webview.simulateMessage({ type: 'typingFocus', typing: false })
    expect(reported).toEqual([true, false])
  })

  it('does not repeat itself, because setContext for an unchanged value is noise', () => {
    const { stub } = openPanel()

    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })
    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })

    expect(reported).toEqual([true])
  })

  it('treats anything but a literal true as not typing, since the webview is the untrusted half', () => {
    const { stub } = openPanel()

    stub.webview.simulateMessage({ type: 'typingFocus' })
    stub.webview.simulateMessage({ type: 'typingFocus', typing: 'yes' })

    expect(reported).toEqual([])
  })
})

describe('the ways a set key has to come back off', () => {
  // Each of these is the same bug from a different direction: `graphTyping` left true is Ctrl+Z
  // doing NOTHING, anywhere, until the window is reloaded.

  it('clears it when the panel stops being the active one', () => {
    const { stub } = openPanel()
    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })

    // Clicking into the editor beside the graph. The webview may never see a focusout for this --
    // the whole iframe loses the keyboard at once -- so the host cannot wait to be told.
    stub.simulateViewState({ active: false })

    expect(reported).toEqual([true, false])
  })

  it('clears it when the panel is hidden behind another tab', () => {
    const { stub } = openPanel()
    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })

    stub.simulateViewState({ active: false, visible: false })

    expect(reported).toEqual([true, false])
  })

  it('clears it when the panel is disposed mid-edit', () => {
    const { panel, stub } = openPanel()
    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })

    panel.dispose()

    expect(reported).toEqual([true, false])
  })

  it("clears it when the webview's script starts again, which is what a restored panel does", async () => {
    const { stub } = openPanel()
    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })

    // retainContextWhenHidden is not a promise: a panel can be torn down and rebuilt, and the new
    // page has nothing focused whatever the old one last said.
    stub.webview.simulateMessage({ type: 'ready' })
    await settle()

    expect(reported).toEqual([true, false])
  })

  it('leaves it set while a SECOND panel is still being typed into', () => {
    // The key is one key for the window but there can be two graphs open. Closing the one nobody
    // was typing in must not take undo away from the one they are.
    const first = openPanel()
    const second = openPanel()
    second.stub.webview.simulateMessage({ type: 'typingFocus', typing: true })
    expect(reported).toEqual([true])

    first.panel.dispose()

    expect(reported).toEqual([true])

    second.panel.dispose()
    expect(reported).toEqual([true, false])
  })
})

describe('the key as the workbench actually sees it', () => {
  const extensionDirs: string[] = []

  beforeEach(() => {
    vscodeMock.mockConfig['binaryPath'] = ''
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-typing-ext-'))
    extensionDirs.push(extensionPath)
    activate({
      subscriptions: [],
      extensionPath,
      extensionUri: new vscodeMock.MockUri(extensionPath),
    } as unknown as import('vscode').ExtensionContext)
  })

  afterEach(() => {
    deactivate()
    for (const dir of extensionDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  /** Every value `setContext` was given for the typing key, in order. */
  function setContextCalls(): unknown[] {
    return vscodeMock.commands.executeCommand.mock.calls
      .filter((call) => call[0] === 'setContext' && call[1] === 'featurelab.graphTyping')
      .map((call) => call[2])
  }

  it('is defined from activation, so the binding is not negating something unset', () => {
    // `!featurelab.graphTyping` on a key nothing has ever set does work in VS Code, but a key with
    // a value is the difference between relying on that and stating it.
    expect(setContextCalls()).toEqual([false])
  })

  it('goes true on a typingFocus from the panel and false again on the way out', () => {
    const { stub } = openPanel()

    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })
    stub.simulateViewState({ active: false })

    expect(setContextCalls()).toEqual([false, true, false])
  })

  it('is put back down by deactivate, so a reload does not come up with undo disabled', () => {
    const { stub } = openPanel()
    stub.webview.simulateMessage({ type: 'typingFocus', typing: true })

    deactivate()

    expect(setContextCalls()[setContextCalls().length - 1]).toBe(false)
  })
})
