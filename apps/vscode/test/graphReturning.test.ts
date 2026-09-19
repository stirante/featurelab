// graphReturning.test.ts -- what the node editor is like the SECOND time you open a pack.
//
// WHY A SEPARATE FILE. Every finding here was reported against the shipped page -- dist/graph.js
// under the real Content-Security-Policy -- and every one of them is about a panel that is coming
// BACK to something rather than meeting it for the first time. None of them is visible from any
// one module, and none of them is a wrong pixel: in all five the panel drew confidently, the
// status line agreed with it, and the fact that would have changed the reader's mind was on no
// surface at all.
//
//   1. Run VS Code's Format Document over two files carrying a group directive and every group in
//      the pack is gone. The formatter re-encodes through JSON.parse/stringify; comments do not
//      survive that; a group lives in a comment. Groups drawn before: one. After: none, status
//      line unchanged, no notice, no undo entry. Formatting a JSON file is a completely ordinary
//      thing to do, which is what makes this the likeliest way a person loses grouping work.
//   2. Leave the panel on a feature, delete it, reopen: the selection is dropped (right) and the
//      camera it belonged to is restored anyway (wrong), pointing at the hole -- with the name of
//      the missing feature nowhere on the page.
//   3. Move a pack's features/ away and the canvas draws 3 cards of 57 under "Showing the whole
//      graph."
//   4. A revived panel's Undo reads "Nothing to undo" and is aria-disabled -- indistinguishable
//      from a panel that never wrote anything, while the edit is still on disk.
//   5. A group down to its last surviving member draws as an ordinary group.
//
// The rig is graphKeyboard.test.ts's, for the reason its header gives: the shell HTML is the one
// src/graphPanel.ts emits, the script is webview/graph.ts bundled exactly as esbuild.config.mjs
// bundles it, and the theme is served through the CSP rather than around it. What is asserted is
// what is ON THE PAGE -- text a person can read -- because in every one of these the code was
// already doing the right thing and simply not saying so.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(here, '..')
const cssPath = path.join(appRoot, 'media', 'graph.css')
const webviewPath = path.join(appRoot, 'webview', 'graph.ts')

/** Dark Modern, trimmed to what this file needs -- nothing here measures a colour. */
const THEME: Record<string, string> = {
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-widget-border': '#313131',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-editorError-foreground': '#f14c4c',
  '--vscode-textCodeBlock-background': '#2a2a2a',
  '--vscode-charts-blue': '#4e94ce',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

async function bundleWebview(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [webviewPath],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2021',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling webview/graph.ts')
  return (
    `globalThis.__posted = [];\n` +
    `globalThis.acquireVsCodeApi = () => ({\n` +
    `  postMessage: (m) => { globalThis.__posted.push(m) },\n` +
    `  getState: () => undefined,\n` +
    `  setState: () => undefined,\n` +
    `});\n` +
    output.text
  )
}

/** The slice of the wire these tests build by hand. */
interface TestNode {
  id: string
  typeId?: string
  file?: string
  unresolved?: boolean
  annotations?: { name: string; args: string[]; jsonPath: string }[]
}

interface TestGraph {
  nodes: TestNode[]
  edges: { from: string; to: string; kind: string }[]
  roots: string[]
}

/** A `@featurelab:group` directive on a file's root, as the engine reports one. */
function groupDirective(id: string, name: string): { name: string; args: string[]; jsonPath: string } {
  return { name: 'group', args: [id, 'expanded', ...name.split(' ')], jsonPath: '$' }
}

function feature(id: string, annotations?: { name: string; args: string[]; jsonPath: string }[]): TestNode {
  return {
    id,
    typeId: 'minecraft:single_block_feature',
    file: `features/${id.replace(':', '_')}.json`,
    ...(annotations ? { annotations } : {}),
  }
}

/** A small pack: a rule, three features, one edge. Big enough to draw, small enough that every
 * assertion here is about one named thing. */
function pack(annotated: Record<string, { name: string; args: string[]; jsonPath: string }[]> = {}): TestGraph {
  const ids = ['wiki:diamond_vein', 'wiki:gold_vein', 'wiki:emerald_vein']
  return {
    nodes: [
      { id: 'wiki:ore_rule.fr', typeId: 'minecraft:feature_rule', file: 'feature_rules/ore_rule.json' },
      ...ids.map((id) => feature(id, annotated[id])),
    ],
    edges: [{ from: 'wiki:ore_rule.fr', to: 'wiki:diamond_vein', kind: 'rule' }],
    roots: ['wiki:ore_rule.fr'],
  }
}

const PANEL_TIMEOUT_MS = 90_000

describe('coming back to a pack', { timeout: PANEL_TIMEOUT_MS }, () => {
  let browser: Browser
  let server: { port: number; close: () => void }

  beforeAll(async () => {
    const script = await bundleWebview()
    const css = readFileSync(cssPath, 'utf-8')
    const { renderGraphShellHtml } = await import('../src/graphPanel.js')
    const httpServer = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/graph.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(script)
        return
      }
      if (url === '/graph.css') {
        res.setHeader('Content-Type', 'text/css')
        res.end(css)
        return
      }
      if (url.startsWith('/theme-')) {
        res.setHeader('Content-Type', 'text/css')
        res.end(`:root {\n${Object.entries(THEME).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`)
        return
      }
      const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
      res.setHeader('Content-Type', 'text/html')
      res.end(
        renderGraphShellHtml({ nonce: 'testnonce', cspSource: origin, scriptUri: '/graph.js', styleUri: '/graph.css', packLabel: 'fixture' }),
      )
    })
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    browser = await chromium.launch()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  /** A booted page with nothing posted into it yet. */
  async function boot(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    ;(page as unknown as { __errors: string[] }).__errors = errors
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.evaluate(() => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = '/theme-dark.css'
      document.head.append(link)
    })
    await page.waitForFunction(() => (document.getElementById('flg-toolbar')?.children.length ?? 0) > 0, undefined, { timeout: 20_000 })
    return page
  }

  /** Posts a graph message exactly as src/graphPanel.ts posts one. */
  async function sendGraph(page: Page, graph: TestGraph, extra: Record<string, unknown> = {}): Promise<void> {
    await page.evaluate(
      ({ wire, more }) => {
        window.postMessage({ type: 'graph', graph: wire, ...(more as Record<string, unknown>) }, '*')
      },
      { wire: graph, more: extra },
    )
  }

  /** What the host hands a panel it has seen before. */
  async function sendRestore(page: Page, state: unknown): Promise<void> {
    await page.evaluate((saved) => {
      window.postMessage({ type: 'restoreState', key: '/packs/fixture', state: saved }, '*')
    }, state)
  }

  function bannerText(page: Page): Promise<string> {
    return page.evaluate(() => {
      const host = document.getElementById('flg-banner')
      return host === null || host.hidden ? '' : (host.textContent ?? '')
    })
  }

  function statusText(page: Page): Promise<string> {
    return page.evaluate(() => document.getElementById('flg-status')?.textContent ?? '')
  }

  /** Everything a reader can see, as one string. Several of these findings are "the name of the
   * thing is nowhere on the page", and that is only honestly answered by looking at the page. */
  function pageText(page: Page): Promise<string> {
    return page.evaluate(() => document.body.innerText ?? '')
  }

  function noErrors(page: Page): void {
    const errors = (page as unknown as { __errors: string[] }).__errors
    expect(errors, `the panel threw: ${errors.join(' | ')}`).toEqual([])
  }

  // -- 1. A comment-blind formatter deletes every group -----------------------

  describe('a group that vanished out of the files', () => {
    it('names the group and its members when a formatter strips every directive', async () => {
      const page = await boot()
      try {
        const grouped = pack({
          'wiki:diamond_vein': [groupDirective('pumpkins', 'Pumpkins')],
          'wiki:gold_vein': [groupDirective('pumpkins', 'Pumpkins')],
        })
        await sendGraph(page, grouped)
        await page.waitForFunction(() => document.querySelectorAll('.flg-frame').length > 0, undefined, { timeout: 20_000 })
        expect(await bannerText(page), 'a pack with its groups intact has nothing to say').toBe('')

        // Format Document, as VS Code does it: the file is re-encoded through JSON.parse and
        // JSON.stringify, so every comment in it -- and therefore every group -- is gone. The
        // host re-reads the pack and sends the graph that came back.
        await sendGraph(page, pack())
        await page.waitForFunction(() => document.getElementById('flg-banner')?.hidden === false, undefined, { timeout: 20_000 })

        const said = await bannerText(page)
        // THE GROUP, BY THE NAME THE AUTHOR TYPED -- not by its slug, which is a handle they
        // never saw.
        expect(said).toContain('"Pumpkins"')
        // AND THE MEMBERS, because the list of ids is what says which files to look in and which
        // files the text editor's own undo has to reach.
        expect(said).toContain('wiki:diamond_vein')
        expect(said).toContain('wiki:gold_vein')
        // What did it, in words, because "my groups disappeared" is otherwise unattributable.
        expect(said).toMatch(/comment/i)
        expect(said).toMatch(/Format Document/)
        // And it does not offer to put it back: this panel did not write the change.
        expect(said).toMatch(/cannot put it back/)
        expect(await pageText(page)).toContain('Pumpkins')
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('says nothing when the panel itself ungrouped them', async () => {
      const page = await boot()
      try {
        const grouped = pack({
          'wiki:diamond_vein': [groupDirective('ores', 'Ores')],
          'wiki:gold_vein': [groupDirective('ores', 'Ores')],
        })
        await sendGraph(page, grouped)
        await page.waitForFunction(() => document.querySelectorAll('.flg-frame').length > 0, undefined, { timeout: 20_000 })

        // Select the group and ungroup it, which is the panel ASKING for exactly the departure
        // the detector above reports. A warning here would be the editor telling somebody off
        // for pressing the button it drew for them.
        await page.locator('.flg-frame-head').click()
        await page.locator('.flg-group-ungroup').first().click()
        await page.locator('.flg-group-ungroup-confirm').click()
        await sendGraph(page, pack())
        await page.waitForFunction(() => document.querySelectorAll('.flg-frame').length === 0, undefined, { timeout: 20_000 })

        expect(await bannerText(page)).toBe('')
        noErrors(page)
      } finally {
        await page.close()
      }
    })
  })

  // -- 2. Resume with a selection that no longer exists -----------------------

  describe('a saved view whose selection is gone', () => {
    /** The camera the measurement recorded, to the digit. */
    const SAVED_CAMERA = { x: -498.44444444444446, y: -234.44444444444446, zoom: 0.9 }

    async function cameraOf(page: Page): Promise<{ x: number; y: number; zoom: number }> {
      return page.evaluate(() => (window as unknown as { __flgView: { getCamera(): { x: number; y: number; zoom: number } } }).__flgView.getCamera())
    }

    it('restores the camera when the selection is still there', async () => {
      // The control. Everything this fix does is conditional on the selection being gone, and a
      // test that only proves the negative would pass a panel that had stopped restoring
      // anything.
      const page = await boot()
      try {
        await sendRestore(page, { camera: SAVED_CAMERA, selectedNode: 'wiki:diamond_vein' })
        await sendGraph(page, pack())
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
        expect(await cameraOf(page)).toEqual(SAVED_CAMERA)
        expect(await bannerText(page)).toBe('')
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('drops the camera and names the missing feature when it is not there any more', async () => {
      const page = await boot()
      try {
        await sendRestore(page, { camera: SAVED_CAMERA, selectedNode: 'wiki:diamond_vein' })
        // The same pack with that feature deleted.
        const without = pack()
        without.nodes = without.nodes.filter((n) => n.id !== 'wiki:diamond_vein')
        without.edges = []
        await sendGraph(page, without)
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })

        // THE CAMERA IS NOT THE SAVED ONE. It used to be restored to the digit, pointing at the
        // gap the deleted feature left, having also spent `framed` so the opening camera that
        // would have chosen somewhere readable never got to run.
        expect(await cameraOf(page)).not.toEqual(SAVED_CAMERA)
        // AND THE NAME IS ON THE PAGE. It appeared nowhere before -- not in the sidebar, not in
        // the status line, not in a notice.
        expect(await pageText(page)).toContain('wiki:diamond_vein')
        const said = await bannerText(page)
        expect(said).toContain('wiki:diamond_vein')
        expect(said).toMatch(/deleted, or renamed/)
        // And it says what happened to the view, so "why am I somewhere else" has an answer.
        expect(said).toMatch(/where a first open of this pack would put you/)
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('does the same for a rename, which from here is the same event', async () => {
      const page = await boot()
      try {
        await sendRestore(page, { camera: SAVED_CAMERA, selectedNode: 'wiki:diamond_vein' })
        const renamed = pack()
        renamed.nodes = renamed.nodes.map((n) => (n.id === 'wiki:diamond_vein' ? feature('wiki:diamond_lode') : n))
        renamed.edges = []
        await sendGraph(page, renamed)
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
        expect(await cameraOf(page)).not.toEqual(SAVED_CAMERA)
        expect(await bannerText(page)).toContain('wiki:diamond_vein')
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('restores a saved view that selected nothing, exactly as before', async () => {
      const page = await boot()
      try {
        await sendRestore(page, { camera: SAVED_CAMERA })
        await sendGraph(page, pack())
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
        expect(await cameraOf(page)).toEqual(SAVED_CAMERA)
        expect(await bannerText(page)).toBe('')
        noErrors(page)
      } finally {
        await page.close()
      }
    })
  })

  // -- 3. A whole kind the engine read nothing of ----------------------------

  describe('a pack with a directory missing', () => {
    it('says so on the canvas, and stops the status line claiming the whole pack', async () => {
      const page = await boot()
      try {
        // What the engine answers for a pack whose features/ has been renamed away: the rules
        // still load, so the graph is not empty and the empty state never speaks.
        const rulesOnly: TestGraph = {
          nodes: [
            { id: 'wiki:ore_rule.fr', typeId: 'minecraft:feature_rule', file: 'feature_rules/ore_rule.json' },
            { id: 'wiki:diamond_vein', unresolved: true },
          ],
          edges: [{ from: 'wiki:ore_rule.fr', to: 'wiki:diamond_vein', kind: 'rule' }],
          roots: ['wiki:ore_rule.fr'],
        }
        await sendGraph(page, rulesOnly, { packContents: { fileCounts: { features: 0, rules: 1, structures: 0, biomes: 0 } } })
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })

        const said = await bannerText(page)
        expect(said).toMatch(/no feature files/)
        expect(said).toContain('features/')
        // The empty state is still hidden -- this canvas DID draw something, and that is the
        // whole shape of the finding.
        expect(await page.evaluate(() => document.getElementById('flg-empty')?.hidden)).toBe(true)
        // "Showing the whole graph." was true about the graph and false about the pack.
        const status = await statusText(page)
        expect(status).toMatch(/whole of what loaded/)
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('says nothing on an ordinary pack, at any count of structures or biomes', async () => {
      const page = await boot()
      try {
        await sendGraph(page, pack(), { packContents: { fileCounts: { features: 3, rules: 1, structures: 0, biomes: 0 } } })
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
        expect(await bannerText(page)).toBe('')
        expect(await statusText(page)).not.toMatch(/whole of what loaded/)
        noErrors(page)
      } finally {
        await page.close()
      }
    })
  })

  // -- 4. The journal a reload emptied ---------------------------------------

  describe('a revived panel with an empty journal', () => {
    it('says where the history went, under the buttons', async () => {
      const page = await boot()
      try {
        await sendRestore(page, { camera: { x: 0, y: 0, zoom: 1 }, selectedNode: 'wiki:gold_vein' })
        await sendGraph(page, pack())
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })

        // The state the measurement caught: aria-disabled, "Nothing to undo", and an edit still
        // on disk that this panel is no longer offering to put back.
        expect(await page.locator('.flg-history-undo').getAttribute('aria-disabled')).toBe('true')
        expect(await page.locator('.flg-history-label').textContent()).toBe('Nothing to undo')

        const note = page.locator('#flg-history-note')
        expect(await note.isVisible()).toBe(true)
        const text = (await note.textContent()) ?? ''
        expect(text).toMatch(/reopened/)
        expect(text).toMatch(/already saved in the files/)
        // It points at the thing that CAN reach them, which is not this panel.
        expect(text).toMatch(/editor's own Undo/)

        // And it is under the buttons rather than in the row: the toolbar is one line high and
        // this control is in it precisely so it does not move.
        const undoBox = (await page.locator('.flg-history-undo').boundingBox())!
        const noteBox = (await note.boundingBox())!
        expect(noteBox.y).toBeGreaterThanOrEqual(undoBox.y + undoBox.height)

        // Dismissible, and it stays dismissed.
        await page.locator('.flg-history-note-dismiss').click()
        expect(await note.isVisible()).toBe(false)
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('says nothing once this session has written something', async () => {
      const page = await boot()
      try {
        await sendRestore(page, { camera: { x: 0, y: 0, zoom: 1 } })
        await sendGraph(page, pack())
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
        expect(await page.locator('#flg-history-note').isVisible()).toBe(true)
        await page.evaluate(() => {
          window.postMessage({ type: 'history', undo: 'places_block: block name', redo: null }, '*')
        })
        await page.waitForFunction(() => document.getElementById('flg-history-note')?.hidden === true, undefined, { timeout: 20_000 })
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('says nothing at all on a panel that has never been here before', async () => {
      const page = await boot()
      try {
        await sendGraph(page, pack())
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
        // No saved view ever arrived, so "your history started over" would be a claim about a
        // session that never happened.
        expect(await page.locator('#flg-history-note').isVisible()).toBe(false)
        noErrors(page)
      } finally {
        await page.close()
      }
    })
  })

  // -- 5. What is left of a group --------------------------------------------

  describe('a group down to one member', () => {
    it('says so on the frame and in the sidebar', async () => {
      const page = await boot()
      try {
        await sendGraph(page, pack({ 'wiki:diamond_vein': [groupDirective('ores', 'Ores')] }))
        await page.waitForFunction(() => document.querySelectorAll('.flg-frame').length > 0, undefined, { timeout: 20_000 })

        // ON THE FRAME, as a word. A remnant drew as an ordinary group -- frame, name, chevron --
        // and the only thing that could tell the two apart was a reader, so the fact has to be
        // in the text they read rather than in a colour or a border.
        expect(await page.locator('.flg-frame-lone').textContent()).toBe('on its own')
        expect(await page.locator('.flg-frame-head').getAttribute('aria-label')).toMatch(/on its own/)

        // AND IN THE SIDEBAR, where it read "Ores (1)" -- a count that was already right and said
        // nothing.
        const jump = page.locator('.flg-jump-group').first()
        expect(await jump.textContent()).toBe('Ores (1, on its own)')
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('says nothing about a group with two members', async () => {
      const page = await boot()
      try {
        await sendGraph(
          page,
          pack({
            'wiki:diamond_vein': [groupDirective('ores', 'Ores')],
            'wiki:gold_vein': [groupDirective('ores', 'Ores')],
          }),
        )
        await page.waitForFunction(() => document.querySelectorAll('.flg-frame').length > 0, undefined, { timeout: 20_000 })
        expect(await page.locator('.flg-frame-lone').count()).toBe(0)
        expect(await page.locator('.flg-jump-group').first().textContent()).toBe('Ores (2)')
        noErrors(page)
      } finally {
        await page.close()
      }
    })
  })

  // -- The directives, as the page reads them --------------------------------

  describe('a directive the panel used to drop in silence', () => {
    it('warns about one written a line below the opening brace', async () => {
      const page = await boot()
      try {
        await sendGraph(
          page,
          pack({
            'wiki:diamond_vein': [{ name: 'group', args: ['caves', 'expanded', 'Caves'], jsonPath: '$.minecraft:single_block_feature' }],
          }),
        )
        await page.waitForFunction(() => document.querySelectorAll('.flg-node').length > 0, undefined, { timeout: 20_000 })
        // No group -- which was right -- and now a sentence saying why, where before there was
        // neither a group nor a word anywhere.
        expect(await page.locator('.flg-frame').count()).toBe(0)
        expect(await pageText(page)).toMatch(/ABOVE the opening brace/)
        noErrors(page)
      } finally {
        await page.close()
      }
    })

    it('draws a group for @featurelab:Group and says the spelling is wrong', async () => {
      const page = await boot()
      try {
        await sendGraph(
          page,
          pack({
            'wiki:diamond_vein': [{ name: 'Group', args: ['pumpkins', 'expanded', 'Pumpkins'], jsonPath: '$' }],
            'wiki:gold_vein': [groupDirective('pumpkins', 'Pumpkins')],
          }),
        )
        await page.waitForFunction(() => document.querySelectorAll('.flg-frame').length > 0, undefined, { timeout: 20_000 })
        // The engine reads `ignore` fold-insensitively, so dropping this was the two halves of
        // the tool disagreeing about the same bytes.
        expect(await page.locator('.flg-frame-name').textContent()).toBe('Pumpkins')
        expect(await page.locator('.flg-frame-lone').count()).toBe(0)
        // Selecting the group puts the warning where somebody can read it.
        await page.locator('.flg-frame-head').click()
        await page.waitForFunction(() => (document.getElementById('flg-side')?.textContent ?? '').includes('@featurelab:Group'), undefined, {
          timeout: 20_000,
        })
        expect(await pageText(page)).toMatch(/Write it lower case/)
        noErrors(page)
      } finally {
        await page.close()
      }
    })
  })
})
