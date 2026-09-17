// bundleActivation.test.ts -- loads the BUILT dist/extension.js the way the extension host
// does and asserts activate() registers the command.
//
// Why this test exists, and why it loads the bundle rather than the source: every other test
// here imports from src/, which the bundler never touched. That left the bundling step itself
// untested, and it broke silently -- esbuild resolved jsonc-parser to its UMD entry, whose
// wrapper passes `require` in as a FUNCTION PARAMETER, so the require("./impl/...") calls
// inside it survived bundling and threw MODULE_NOT_FOUND at activation. The extension host
// reports that as `command 'featurelab.previewFeature' not found` -- a message that names the
// command and says nothing about a module -- with the real stack only in the exthost log.
// A source-level test cannot see any of that. This one fails on it.
import { describe, expect, it } from 'vitest'
import Module from 'node:module'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, '..', 'dist', 'extension.js')

/** The slice of the `vscode` module activate() touches -- nothing more, so the stub doubles
 * as a written record of the extension's activation-time API surface. Growing it is fine when
 * activation legitimately grows; a member added to make an UNEXPECTED call pass is the signal
 * worth stopping on. */
function makeVscodeStub() {
  const registered: string[] = []
  const disposable = { dispose() {} }
  return {
    registered,
    api: {
      commands: {
        registerCommand(id: string) {
          registered.push(id)
          return disposable
        },
      },
      languages: {
        createDiagnosticCollection: () => ({ dispose() {}, set() {}, delete() {} }),
        registerDefinitionProvider: () => disposable,
      },
      workspace: {
        onDidSaveTextDocument: () => disposable,
        getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
        // FeatureDefinitionProvider watches from construction, by design -- see its ctor.
        createFileSystemWatcher: () => ({
          dispose() {},
          onDidCreate: () => disposable,
          onDidChange: () => disposable,
          onDidDelete: () => disposable,
        }),
      },
      window: {
        activeTextEditor: undefined,
        onDidChangeActiveTextEditor: () => disposable,
        showErrorMessage() {},
      },
    },
  }
}

function loadBundle(vscodeApi: unknown): { activate: (ctx: unknown) => void } {
  const loader = Module as unknown as {
    _load: (req: string, parent: unknown, isMain: boolean) => unknown
  }
  const original = loader._load
  loader._load = (req, parent, isMain) =>
    req === 'vscode' ? vscodeApi : original(req, parent, isMain)
  try {
    const require = createRequire(import.meta.url)
    delete require.cache[require.resolve(bundle)]
    return require(bundle) as { activate: (ctx: unknown) => void }
  } finally {
    loader._load = original
  }
}

describe('the built extension bundle', () => {
  it('activates and registers EVERY command package.json contributes', () => {
    // Read from the manifest rather than listed here by name. This test exists because a
    // contributed command that activate() never registers fails at the moment somebody runs it,
    // with "command not found" -- and it named one command, so the second one added later was
    // not covered by the guard written for exactly this. A list kept in a test is a list that
    // goes stale; the manifest is the thing users' menus are built from, so it is the thing to
    // check against.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const manifest = JSON.parse(readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string }[] }
    }
    const contributed = manifest.contributes.commands.map((c) => c.command)
    expect(contributed.length).toBeGreaterThan(1)

    const stub = makeVscodeStub()
    const ext = loadBundle(stub.api)

    expect(typeof ext.activate).toBe('function')
    ext.activate({ subscriptions: [], extensionPath: here, extensionUri: { fsPath: here } })

    for (const command of contributed) {
      expect(stub.registered, `${command} is contributed but activate() never registers it`).toContain(command)
    }
  })

  it('resolves every dependency at bundle time, leaving no runtime require but node builtins and vscode', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const js: string = readFileSync(bundle, 'utf8')
    const requires = [...js.matchAll(/require\d*\("([^"]+)"\)/g)].map((m) => m[1] ?? '')
    const unresolvable = requires.filter((r) => !r.startsWith('node:') && r !== 'vscode')
    expect(unresolvable).toEqual([])
  })
})

describe('what actually ships', () => {
  // The shell HTML references its script and stylesheet by path. If one of those is excluded
  // from the package -- by a .vscodeignore rule written for something else, or simply by being
  // added to a directory nobody thought about -- the extension installs, activates, opens its
  // panel, and renders unstyled or inert. Nothing throws, nothing is logged where an author
  // would look, and it cannot happen on a development machine, where the file is on disk.
  //
  // So this asserts the property that matters: every asset a panel loads is in the package
  // listing vsce would produce. It reads .vscodeignore and applies it, rather than listing
  // expected files, so a new asset is covered the day it is added.
  it('includes every asset the panels load at runtime', () => {
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
    const root = path.resolve(here, '..')

    const ignore = readFileSync(path.join(root, '.vscodeignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))

    /** The subset of .vscodeignore's glob syntax this file actually uses. */
    const excluded = (relative: string): boolean =>
      ignore.some((pattern) => {
        if (pattern.endsWith('/**')) return relative.startsWith(pattern.slice(0, -2))
        if (pattern.startsWith('**/*.')) return relative.endsWith(pattern.slice(4))
        return relative === pattern
      })

    // Every path the two shells hand to asWebviewUri, as dist/media-relative names.
    const assets = ['dist/extension.js', 'dist/webview.js', 'dist/webview.css', 'dist/graph.js', 'media/graph.css']

    for (const asset of assets) {
      expect(existsSync(path.join(root, asset)), `${asset} is referenced but was not built`).toBe(true)
      expect(excluded(asset), `${asset} is referenced by a panel but .vscodeignore keeps it out of the package`).toBe(
        false,
      )
    }
  })
})
