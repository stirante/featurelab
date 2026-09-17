// shellHtml.ts -- loads the REAL renderShellHtml() straight out of apps/vscode/src/
// previewPanel.ts by bundling that module with esbuild (stubbing only its 'vscode' import,
// which renderShellHtml itself never touches -- it's a pure function of its params, see that
// export's own doc comment) instead of any test harness hand-copying the webview shell HTML a
// second time.
//
// This is the fix for the class of bug the CSP regression (previewPanel.ts emitting a
// style-src with no 'unsafe-inline' and no nonce, silently dropping the whole inline <style>
// block in real VS Code) survived several rounds of "verified by screenshot" under: panelLayout.
// test.ts, splitterLayout.test.ts, and scripts/capture-screenshots.mjs each used to embed their
// OWN hand-copied duplicate of the shell HTML, served over plain HTTP with no CSP meta tag at
// all -- so none of the three could ever have exercised (let alone caught) a CSP bug in the
// first place. With this helper, all three obtain their HTML from the one real generator, so a
// harness page and the production page cannot structurally diverge again.
import * as esbuild from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

const dir = path.dirname(fileURLToPath(import.meta.url))
const previewPanelPath = path.join(dir, '..', '..', 'src', 'previewPanel.ts')

// Only the surface previewPanel.ts references at its own module scope / inside code paths
// esbuild can't tree-shake away needs to exist here -- renderShellHtml never calls any of it,
// this is purely so the bundle can load without a real 'vscode' module present (see
// test/fixtures/vscodeMock.ts for the equivalent used by vitest's own module mocking; this one
// has to be a real virtual module because esbuild bundles previewPanel.ts's dependency graph
// eagerly, module load order and all).
const VSCODE_STUB = `
  export const window = {};
  export const workspace = { getConfiguration: () => ({ get: (_k, d) => d }) };
  export const languages = {};
  export class Uri {
    static file(p) { return { fsPath: p } }
    static joinPath(base, ...segments) { return { fsPath: [base.fsPath, ...segments].join('/') } }
  }
  export const ViewColumn = { Beside: 2 };
  export class Diagnostic {}
  export const DiagnosticSeverity = { Error: 0, Warning: 1 };
  export class Range {}
`

const vscodeStubPlugin: esbuild.Plugin = {
  name: 'vscode-stub',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'vscode-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'vscode-stub' }, () => ({ contents: VSCODE_STUB, loader: 'js' }))
  },
}

export interface ShellHtmlParams {
  nonce: string
  cspSource: string
  scriptUri: string
  styleUri: string
  /** Optional here on purpose: this interface is a structural copy of the real one in
   * src/previewPanel.ts, so it cannot be kept in lockstep by the compiler. renderShellHtml
   * defaults a missing value rather than emitting "undefined" into the DOM. */
  workspaceId?: string
}
export type RenderShellHtml = (params: ShellHtmlParams) => string

/** Bundles src/previewPanel.ts (stubbing only its 'vscode' import) and returns its exported
 * `renderShellHtml` -- the exact function the real extension's buildHtml() calls to produce the
 * webview's HTML, CSP meta tag included. An esbuild pass, so callers should invoke this once
 * (e.g. in a `beforeAll`) and reuse the returned function across every test in the file rather
 * than calling it per-test. */
export async function loadRenderShellHtml(): Promise<RenderShellHtml> {
  const result = await esbuild.build({
    entryPoints: [previewPanelPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [vscodeStubPlugin],
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling previewPanel.ts')
  const tmpFile = path.join(os.tmpdir(), `previewPanel-shell-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await fs.writeFile(tmpFile, output.text, 'utf-8')
  try {
    const mod = (await import(pathToFileURL(tmpFile).href)) as { renderShellHtml: RenderShellHtml }
    if (typeof mod.renderShellHtml !== 'function') {
      throw new Error('bundled previewPanel.ts did not export renderShellHtml')
    }
    return mod.renderShellHtml
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
}

/** Same bundle-with-a-vscode-stub trick as loadRenderShellHtml, for previewPanel.ts's other
 * pure export. previewPanel.ts imports 'vscode' at module scope, so a test cannot import it
 * directly -- vitest fails with "Failed to load url vscode" before a single assertion runs. */
export async function loadWorkspaceIdFrom(): Promise<(paths: readonly string[]) => string> {
  const result = await esbuild.build({
    entryPoints: [previewPanelPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [vscodeStubPlugin],
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling previewPanel.ts')
  const tmpFile = path.join(os.tmpdir(), `previewPanel-wsid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await fs.writeFile(tmpFile, output.text, 'utf-8')
  try {
    const mod = (await import(pathToFileURL(tmpFile).href)) as {
      workspaceIdFrom: (paths: readonly string[]) => string
    }
    if (typeof mod.workspaceIdFrom !== 'function') {
      throw new Error('bundled previewPanel.ts did not export workspaceIdFrom')
    }
    return mod.workspaceIdFrom
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
}
