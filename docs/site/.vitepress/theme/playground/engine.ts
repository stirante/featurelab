// The playground engine, as the page sees it: one instance per tab, shared by every <Playground>
// on a page and kept across the site's client-side navigations (this module is loaded once and
// its state lives for the tab). Loading it twice would download and start a 9 MB engine twice.
//
// Nothing here runs at import time and nothing touches `window` until startEngine() is called,
// so the SSR build can import it safely; the component calls it from onMounted.
import { withBase } from 'vitepress'

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'failed'

export interface EngineTimings {
  /** Where the .wasm came from this time. */
  source: string
  manifestMs: number
  /** Fetching Go's wasm_exec.js loader. */
  execMs: number
  /** Download and compile of the .wasm; the two overlap when the browser can stream. */
  fetchMs: number
  compileMs: number
  /** Go runtime start-up, up to the engine saying it is ready. */
  initMs: number
  /** From startEngine() to ready, as the page experienced it. */
  totalMs: number
}

export interface EngineState {
  status: EngineStatus
  /** For 'missing' and 'failed': what went wrong, in words. */
  message?: string
  version?: string
  goVersion?: string
  size?: number
  timings?: EngineTimings
}

interface Manifest {
  wasm: string
  wasmExec: string
  goVersion?: string
  size?: number
}

/** Cache Storage names. The version suffix is this file's cache LAYOUT, not the engine's (the
 * engine's own identity is its hashed file name); bump it only if what is stored changes shape. */
const CACHE_PREFIX = 'featurelab-playground-'
const CACHE_NAME = `${CACHE_PREFIX}v1`

let state: EngineState = { status: 'idle' }
const listeners = new Set<(s: EngineState) => void>()
let worker: Worker | null = null
let starting: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>()

function setState(next: EngineState): void {
  state = next
  for (const fn of listeners) fn(state)
}

export function engineState(): EngineState {
  return state
}

/** Calls `fn` now and on every change; returns the unsubscribe. */
export function subscribeEngine(fn: (s: EngineState) => void): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

/** What a missing manifest means. On the published site it cannot happen (the Pages job builds
 * the engine before the site); locally it is the one step `npm run dev` does not do. */
const MISSING =
  'The playground engine has not been built for this copy of the site. From the repository root run ' +
  '`bash scripts/build-playground.sh docs/site/public/playground`, then reload the page.'

/** Starts loading the engine if nothing has yet, and resolves once it is ready (or has failed,
 * which the state says). Safe to call as often as you like: from every component that scrolls
 * into view, and again on a click. A failed or exited engine is started afresh by the next call. */
export function startEngine(): Promise<void> {
  if (state.status === 'ready' || state.status === 'missing') return Promise.resolve()
  if (starting) return starting
  starting = load().finally(() => {
    starting = null
  })
  return starting
}

async function load(): Promise<void> {
  const t0 = performance.now()
  setState({ status: 'loading' })
  let manifest: Manifest
  try {
    // no-cache: revalidate, so a deploy is picked up on the next page load rather than after
    // the host's ten-minute max-age. It is a few dozen bytes.
    const res = await fetch(withBase('/playground/manifest.json'), { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    manifest = (await res.json()) as Manifest
    if (typeof manifest.wasm !== 'string' || typeof manifest.wasmExec !== 'string') throw new Error('manifest.json names no engine')
  } catch {
    // A dev server answers an unknown path with the site's HTML, so "not JSON" is "not there".
    setState({ status: 'missing', message: MISSING })
    return
  }
  const manifestMs = Math.round(performance.now() - t0)
  const abs = (name: string): string => new URL(withBase(`/playground/${name}`), location.href).href

  worker?.terminate()
  const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'featurelab-engine' })
  worker = w
  await new Promise<void>((resolve) => {
    w.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; [k: string]: unknown }
      switch (msg.type) {
        case 'ready': {
          const t = msg.timings as Omit<EngineTimings, 'manifestMs' | 'totalMs'>
          setState({
            status: 'ready',
            version: String(msg.version ?? ''),
            goVersion: manifest.goVersion,
            size: manifest.size,
            timings: { ...t, manifestMs, totalMs: Math.round(performance.now() - t0) },
          })
          resolve()
          break
        }
        case 'failed':
          setState({ status: 'failed', message: `The engine could not start: ${String(msg.message)}` })
          resolve()
          break
        case 'exited':
          // Go has stopped (a panic, almost always). Every call still waiting gets the reason,
          // and the next Run starts a fresh engine.
          failAll(`The engine stopped: ${String(msg.message)}`)
          setState({ status: 'failed', message: `The engine stopped: ${String(msg.message)}` })
          if (worker === w) worker = null
          resolve()
          break
        case 'reply': {
          const p = pending.get(msg.id as number)
          if (!p) break
          pending.delete(msg.id as number)
          if (msg.ok) p.resolve(String(msg.value))
          else p.reject(new Error(String(msg.message)))
          break
        }
      }
    }
    w.onerror = (ev) => {
      ev.preventDefault()
      failAll(`The engine's worker failed: ${ev.message || 'unknown error'}`)
      setState({ status: 'failed', message: `The engine's worker failed: ${ev.message || 'unknown error'}` })
      if (worker === w) worker = null
      resolve()
    }
    w.postMessage({ type: 'init', wasmUrl: abs(manifest.wasm), wasmExecUrl: abs(manifest.wasmExec), cacheName: CACHE_NAME, cachePrefix: CACHE_PREFIX })
  })
}

function failAll(message: string): void {
  for (const p of pending.values()) p.reject(new Error(message))
  pending.clear()
}

async function call(method: 'generate' | 'environments', files?: Record<string, string>, params?: string): Promise<string> {
  await startEngine()
  if (state.status !== 'ready' || !worker) throw new Error(state.message ?? 'The engine is not available.')
  const id = nextId++
  const w = worker
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ type: 'call', id, method, files, params })
  })
}

/** Runs one generate. `files` maps a pack-relative path ("features/x.json") to its text; the
 * result is the engine's response JSON exactly as `featurelab serve` would send it. */
export function generate(files: Record<string, string>, params: object): Promise<string> {
  return call('generate', files, JSON.stringify(params))
}

let environmentsCache: Promise<string> | null = null

/** The environment presets, as `featurelab serve`'s `environments` method returns them. They
 * are compiled into the engine, so they are asked for once per engine. */
export function environments(): Promise<string> {
  environmentsCache ??= call('environments').catch((err: unknown) => {
    environmentsCache = null
    throw err
  })
  return environmentsCache
}
