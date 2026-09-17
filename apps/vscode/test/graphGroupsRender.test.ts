// graphGroupsRender.test.ts -- the renderer's half of feature groups, in real Chromium against
// the real media/graph.css, the way graphRender.test.ts drives everything else in render.ts.
//
// What is asserted here is geometry and gesture: that an expanded group's frame is drawn around
// its members and behind them, that dragging its header carries every member and reports each,
// that a collapsed group is one card with the name and the count on it, and that the two ways of
// building a multi-selection -- ctrl+click and a shift+drag marquee -- produce one. What a group
// MEANS is graph/groups.ts's and is tested there; what the panel does with one is the journey's.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, type GraphEdgeWire, type GraphFrameWire, type GraphNodeWire, type GraphWire } from '../src/graph/render.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const renderPath = path.join(dir, '..', 'src', 'graph', 'render.ts')
const cssPath = path.join(dir, '..', 'media', 'graph.css')

const THEME: Record<string, string> = {
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-widget-border': '#313131',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-list-activeSelectionBackground': '#04395e',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-editorError-foreground': '#f14c4c',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-textPreformat-foreground': '#d7ba7d',
  '--vscode-charts-blue': '#4fc1ff',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-lines': '#5a5a5a',
  '--vscode-font-family': 'system-ui, sans-serif',
  '--vscode-editor-font-family': 'Consolas, monospace',
  '--vscode-font-size': '13px',
}

function edge(from: string, to: string, kind: GraphEdgeWire['kind'], ordinal = 0): GraphEdgeWire {
  return { from, to, kind, ordinal, jsonPath: `$.${kind}[${String(ordinal)}]`, required: false }
}

/** Four plain features in a 2x2 grid: a and d down the left, b and c down the right. */
function grid(): { graph: GraphWire; positions: Array<[string, { x: number; y: number }]> } {
  const nodes: GraphNodeWire[] = ['ex:a', 'ex:b', 'ex:c', 'ex:d'].map((id) => ({ id, typeId: 'minecraft:aggregate_feature', file: `features/${id.slice(3)}.json`, coverage: 'implemented' }))
  const graph: GraphWire = {
    nodes,
    edges: [edge('ex:a', 'ex:b', 'aggregate'), edge('ex:b', 'ex:c', 'aggregate'), edge('ex:d', 'ex:c', 'aggregate')],
    roots: ['ex:a', 'ex:d'],
  }
  return {
    graph,
    positions: [
      ['ex:a', { x: 40, y: 40 }],
      ['ex:b', { x: 440, y: 40 }],
      ['ex:c', { x: 440, y: 240 }],
      ['ex:d', { x: 40, y: 240 }],
    ],
  }
}

/** The same pack with b and c folded into one card standing where b was. */
function folded(): { graph: GraphWire; positions: Array<[string, { x: number; y: number }]> } {
  const base = grid()
  const card: GraphNodeWire = { id: 'group:pair', group: { id: 'pair', name: 'The Pair', count: 2 } }
  return {
    graph: {
      nodes: [base.graph.nodes[0]!, card, base.graph.nodes[3]!],
      edges: [edge('ex:a', 'group:pair', 'aggregate'), edge('ex:d', 'group:pair', 'aggregate')],
      roots: ['ex:a', 'ex:d'],
    },
    positions: [
      ['ex:a', { x: 40, y: 40 }],
      ['group:pair', { x: 440, y: 40 }],
      ['ex:d', { x: 40, y: 240 }],
    ],
  }
}

const PAIR_FRAME: GraphFrameWire = { groupId: 'pair', name: 'The Pair', memberIds: ['ex:b', 'ex:c'] }

async function bundleRenderModule(): Promise<string> {
  const result = await esbuild.build({ entryPoints: [renderPath], bundle: true, platform: 'browser', format: 'esm', target: 'es2021', write: false, logLevel: 'silent' })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild produced no output bundling src/graph/render.ts')
  return output.text
}

interface Recorded {
  via: string
  s?: { kind?: string; nodeId?: string; nodeIds?: string[]; groupId?: string } | null
  moves?: Array<{ nodeId: string; position: { x: number; y: number }; from: { x: number; y: number } }>
  groupId?: string
  collapsed?: boolean
}

describe('graph render: feature groups', () => {
  let browser: Browser
  let server: { port: number; close: () => void }
  let moduleSource: string
  let css: string

  beforeAll(async () => {
    moduleSource = await bundleRenderModule()
    css = readFileSync(cssPath, 'utf-8')
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/graph.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(moduleSource)
        return
      }
      if (req.url === '/graph.css') {
        res.setHeader('Content-Type', 'text/css')
        res.end(css)
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/graph.css">
<style>html,body{height:100%;margin:0}#host{position:absolute;inset:0}</style>
</head><body><div id="host"></div>
<script type="module">import * as m from '/graph.js'; window.FLG = m; window.__ready = true;</script>
</body></html>`)
    })
    server = await new Promise((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, () => {
        const { port } = httpServer.address() as AddressInfo
        resolve({ port, close: () => httpServer.close() })
      })
    })
    browser = await chromium.launch()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  async function load(scene: { graph: GraphWire; positions: Array<[string, { x: number; y: number }]> }, frames: GraphFrameWire[]): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await page.goto(`http://127.0.0.1:${server.port}/`)
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, { timeout: 10_000 })
    await page.evaluate((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value)
    }, THEME)
    await page.evaluate(
      ({ graph, positions, frames }) => {
        const api = (window as unknown as { FLG: Record<string, unknown> }).FLG
        const create = api.createGraphView as (host: HTMLElement, options?: unknown) => Record<string, unknown>
        const view = create(document.getElementById('host')!)
        const events: unknown[] = []
        ;(window as unknown as { view: typeof view; events: unknown[] }).view = view
        ;(window as unknown as { events: unknown[] }).events = events
        ;(view.onSelect as (l: (s: unknown) => void) => void)((s) => events.push({ via: 'onSelect', s }))
        ;(view.onActivate as (l: (s: unknown) => void) => void)((s) => events.push({ via: 'onActivate', s }))
        ;(view.onNodeMove as (l: (m: unknown) => void) => void)((m) => events.push({ via: 'onNodeMove', moves: m }))
        ;(view.onGroupToggle as (l: (g: string, c: boolean) => void) => void)((groupId, collapsed) => events.push({ via: 'onGroupToggle', groupId, collapsed }))
        ;(view.render as (g: unknown, p: Map<string, unknown>, f: unknown) => void)(graph, new Map(positions as Array<[string, unknown]>), frames)
      },
      { graph: scene.graph, positions: scene.positions, frames },
    )
    return page
  }

  async function events(page: Page): Promise<Recorded[]> {
    return page.evaluate(() => JSON.parse(JSON.stringify((window as never as { events: unknown[] }).events)) as Recorded[])
  }

  it('an expanded group is a frame around its members, behind them, named in its header', async () => {
    const page = await load(grid(), [PAIR_FRAME])
    try {
      const frame = page.locator('.flg-frame[data-group-id="pair"]')
      expect(await frame.count()).toBe(1)
      expect(await frame.locator('.flg-frame-name').textContent()).toBe('The Pair')

      const box = (await frame.boundingBox())!
      const b = (await page.locator('.flg-node[data-node-id="ex:b"]').boundingBox())!
      const c = (await page.locator('.flg-node[data-node-id="ex:c"]').boundingBox())!
      const a = (await page.locator('.flg-node[data-node-id="ex:a"]').boundingBox())!
      // Contains both members with room to spare, and does not reach the non-member beside them.
      expect(box.x).toBeLessThan(b.x)
      expect(box.y).toBeLessThan(b.y)
      expect(box.x + box.width).toBeGreaterThan(c.x + c.width)
      expect(box.y + box.height).toBeGreaterThan(c.y + c.height)
      expect(box.x).toBeGreaterThan(a.x + a.width)

      // BEHIND: a press in the middle of a member lands on the member, not on the frame.
      const under = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.flg-node, .flg-frame')?.className ?? '', { x: b.x + b.width / 2, y: b.y + b.height / 2 })
      expect(under).toContain('flg-node')
      // And a press on the frame's empty interior reaches the canvas, so panning still works there.
      const interior = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.className ?? '', { x: b.x - 6, y: c.y - 30 })
      expect(interior).not.toContain('flg-frame')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('clicking the header selects the group; dragging it carries every member and reports each once', async () => {
    const page = await load(grid(), [PAIR_FRAME])
    try {
      const head = page.locator('.flg-frame[data-group-id="pair"] .flg-frame-head')
      await head.click({ position: { x: 20, y: 10 }, timeout: 4000 })
      let seen = await events(page)
      expect(seen.find((e) => e.via === 'onSelect')?.s).toEqual({ kind: 'group', groupId: 'pair' })
      expect(await head.evaluate((el) => el.classList.contains('flg-selected'))).toBe(true)

      const before = await page.$$eval('.flg-node', (els) => Object.fromEntries(els.map((e) => [(e as HTMLElement).dataset.nodeId, { x: parseFloat((e as HTMLElement).style.left), y: parseFloat((e as HTMLElement).style.top) }])))
      const frameBefore = (await page.locator('.flg-frame[data-group-id="pair"]').boundingBox())!
      const at = (await head.boundingBox())!
      await page.mouse.move(at.x + 20, at.y + 10)
      await page.mouse.down()
      await page.mouse.move(at.x + 120, at.y + 70, { steps: 6 })
      await page.mouse.up()

      const after = await page.$$eval('.flg-node', (els) => Object.fromEntries(els.map((e) => [(e as HTMLElement).dataset.nodeId, { x: parseFloat((e as HTMLElement).style.left), y: parseFloat((e as HTMLElement).style.top) }])))
      // Both members moved by the same offset; the two non-members did not move at all.
      const db = { x: after['ex:b']!.x - before['ex:b']!.x, y: after['ex:b']!.y - before['ex:b']!.y }
      const dc = { x: after['ex:c']!.x - before['ex:c']!.x, y: after['ex:c']!.y - before['ex:c']!.y }
      expect(db.x).toBeGreaterThan(60)
      expect(db).toEqual(dc)
      expect(after['ex:a']).toEqual(before['ex:a'])
      expect(after['ex:d']).toEqual(before['ex:d'])
      // The frame followed.
      const frameAfter = (await page.locator('.flg-frame[data-group-id="pair"]').boundingBox())!
      expect(frameAfter.x - frameBefore.x).toBeCloseTo(db.x, 0)

      seen = await events(page)
      const moves = seen.filter((e) => e.via === 'onNodeMove')
      expect(moves).toHaveLength(1)
      expect(moves[0]!.moves!.map((m) => m.nodeId).sort()).toEqual(['ex:b', 'ex:c'])
      // The release did not also re-select anything.
      expect(seen.filter((e) => e.via === 'onSelect')).toHaveLength(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a collapsed group is one stacked card with the name and count, and its chevron or a double-click asks to expand', async () => {
    const page = await load(folded(), [])
    try {
      const card = page.locator('.flg-node.flg-node-group[data-node-id="group:pair"]')
      expect(await card.count()).toBe(1)
      expect(await card.locator('.flg-node-id').textContent()).toBe('The Pair')
      expect(await card.locator('.flg-node-group-count').textContent()).toBe('2 features')
      // Same box as a feature card: it sits in the same layout and takes the same edges.
      const box = (await card.boundingBox())!
      expect(Math.round(box.width)).toBe(GRAPH_NODE_WIDTH)
      expect(Math.round(box.height)).toBe(GRAPH_NODE_HEIGHT)
      // Both re-pointed edges are drawn into it.
      expect(await page.$$eval('.flg-edge', (els) => els.length)).toBe(2)
      expect(await page.locator('.flg-chip[aria-label*="to group:pair"]').count()).toBe(2)

      await card.click({ position: { x: 60, y: 20 }, timeout: 4000 })
      await card.locator('.flg-group-chevron').click({ timeout: 4000 })
      await card.dblclick({ position: { x: 60, y: 20 }, timeout: 4000 })
      const seen = await events(page)
      expect(seen.find((e) => e.via === 'onSelect')?.s).toEqual({ kind: 'group', groupId: 'pair' })
      const toggles = seen.filter((e) => e.via === 'onGroupToggle')
      expect(toggles.length).toBeGreaterThanOrEqual(2)
      expect(toggles.every((t) => t.groupId === 'pair' && t.collapsed === false)).toBe(true)
      // A double-click on a group card is "expand", never "open a file it does not have".
      expect(seen.some((e) => e.via === 'onActivate')).toBe(false)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('ctrl+click adds to and removes from a multi-selection, which is always two or more', async () => {
    const page = await load(grid(), [])
    try {
      await page.locator('.flg-node[data-node-id="ex:a"]').click({ timeout: 4000 })
      await page.locator('.flg-node[data-node-id="ex:d"]').click({ modifiers: ['Control'], timeout: 4000 })
      let selected = await page.$$eval('.flg-node.flg-selected', (els) => els.map((e) => (e as HTMLElement).dataset.nodeId).sort())
      expect(selected).toEqual(['ex:a', 'ex:d'])
      let seen = await events(page)
      expect(seen.at(-1)?.s).toEqual({ kind: 'nodes', nodeIds: ['ex:a', 'ex:d'] })

      await page.locator('.flg-node[data-node-id="ex:d"]').click({ modifiers: ['Control'], timeout: 4000 })
      selected = await page.$$eval('.flg-node.flg-selected', (els) => els.map((e) => (e as HTMLElement).dataset.nodeId))
      expect(selected).toEqual(['ex:a'])
      seen = await events(page)
      expect(seen.at(-1)?.s?.kind).toBe('node')

      // Escape clears the lot.
      await page.locator('.flg-node[data-node-id="ex:b"]').click({ modifiers: ['Control'], timeout: 4000 })
      await page.locator('.flg-graph').press('Escape')
      expect(await page.$$eval('.flg-node.flg-selected', (els) => els.length)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('shift+drag on empty canvas selects the cards it touches; a plain drag still pans', async () => {
    const page = await load(grid(), [])
    try {
      const host = (await page.locator('.flg-graph').boundingBox())!
      // From empty canvas below the left column, up and left across a and d but short of b.
      const from = { x: host.x + 340, y: host.y + 380 }
      const to = { x: host.x + 20, y: host.y + 20 }
      await page.keyboard.down('Shift')
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 5 })
      expect(await page.locator('.flg-marquee').isVisible()).toBe(true)
      await page.mouse.up()
      await page.keyboard.up('Shift')
      expect(await page.locator('.flg-marquee').isVisible()).toBe(false)
      const selected = await page.$$eval('.flg-node.flg-selected', (els) => els.map((e) => (e as HTMLElement).dataset.nodeId).sort())
      expect(selected).toEqual(['ex:a', 'ex:d'])
      const cameraAfterMarquee = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number } } }).view.getCamera().x)
      expect(cameraAfterMarquee).toBe(0)

      // Without shift the same gesture pans and selects nothing new.
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x - 80, from.y - 40, { steps: 4 })
      await page.mouse.up()
      const cameraAfterPan = await page.evaluate(() => (window as never as { view: { getCamera(): { x: number } } }).view.getCamera().x)
      expect(cameraAfterPan).toBeGreaterThan(50)
      const seen = await events(page)
      expect(seen.filter((e) => e.via === 'onSelect')).toHaveLength(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('dragging one card of a multi-selection carries the rest of it', async () => {
    const page = await load(grid(), [])
    try {
      await page.locator('.flg-node[data-node-id="ex:a"]').click({ timeout: 4000 })
      await page.locator('.flg-node[data-node-id="ex:d"]').click({ modifiers: ['Control'], timeout: 4000 })
      const a = (await page.locator('.flg-node[data-node-id="ex:a"]').boundingBox())!
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
      await page.mouse.down()
      await page.mouse.move(a.x + a.width / 2 + 90, a.y + a.height / 2 + 30, { steps: 6 })
      await page.mouse.up()
      const seen = await events(page)
      const move = seen.find((e) => e.via === 'onNodeMove')
      expect(move?.moves!.map((m) => m.nodeId).sort()).toEqual(['ex:a', 'ex:d'])
      const [first, second] = move!.moves!
      expect(first!.position.x - first!.from.x).toBeCloseTo(second!.position.x - second!.from.x, 5)
    } finally {
      await page.close()
    }
  }, 30_000)
})
