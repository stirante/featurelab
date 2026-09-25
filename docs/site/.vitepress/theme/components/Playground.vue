<script setup lang="ts">
// <Playground example="scatter" /> -- edit a feature's JSON and place it, in the page.
//
// The 3D view and the sidebar are the ones the VS Code extension and the desktop app use
// (featurelab-frontend's VoxelViewer and createPanel), fed by the same engine compiled to
// WebAssembly (playground/engine.ts). What the reader sees here is what the editor would show
// them for the same file.
//
// Client-only by construction: the server render is the editor and an empty stage, and
// everything that needs a browser -- three.js, the panel, the engine -- is imported in
// onMounted. `choose` adds a picker over every example (the /playground page uses it).
//
// When the engine loads is deliberate. Not on click: by the time a reader has read the example
// and decided to press Run, the download should be over. Not on page load either: most readers
// of a type page never scroll to the playground. So it starts when the playground comes near
// the viewport, in the browser's next idle moment, and a reader who clicks before it is done is
// told it is still loading and gets their result the moment it is ready.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { EXAMPLES, findExample, fixtures, identifierOf, isRuleFile, packFor } from '../playground/examples'
import { handleEditorKey, jsonProblem, type JsonProblem } from '../playground/editor'
import type { EngineState } from '../playground/engine'

const props = defineProps<{ example?: string; choose?: boolean }>()

const exampleId = ref(findExample(props.example).id)
const example = computed(() => findExample(exampleId.value))
const text = ref(fixtures[example.value.main] ?? '')
const problem = ref<JsonProblem | null>(null)
const engine = ref<EngineState>({ status: 'idle' })
const waiting = ref(false)
const running = ref(false)
const result = ref<{ placed: number; ms: number; errors: string[]; summary: string } | null>(null)
const runError = ref<string | null>(null)
const stageReady = ref(false)

const root = ref<HTMLElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)
const gutter = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const sidebar = ref<HTMLElement | null>(null)

type Frontend = typeof import('featurelab-frontend')
type EngineModule = typeof import('../playground/engine')
const fe = shallowRef<Frontend | null>(null)
let eng: EngineModule | null = null
let viewer: InstanceType<Frontend['VoxelViewer']> | null = null
let panel: ReturnType<Frontend['createPanel']> | null = null
let resizeObserver: ResizeObserver | null = null
let intersection: IntersectionObserver | null = null
let unsubscribe: (() => void) | null = null
let disposed = false

const lineCount = computed(() => text.value.split('\n').length)
const mainPath = computed(() => example.value.main)
const otherFiles = computed(() => Object.keys(packFor(mainPath.value, text.value)).filter((p) => p !== mainPath.value))

const engineLine = computed(() => {
  const s = engine.value
  switch (s.status) {
    case 'idle':
      return waiting.value ? 'Loading the engine…' : ''
    case 'loading':
      return waiting.value ? 'Loading the engine… your preview runs as soon as it is ready.' : 'Loading the engine in the background…'
    case 'ready':
      return ''
    default:
      return s.message ?? ''
  }
})
const engineTitle = computed(() => {
  const t = engine.value.timings
  if (!t) return undefined
  const mb = engine.value.size ? `${(engine.value.size / 1e6).toFixed(1)} MB, ` : ''
  return `Engine ${engine.value.version || ''} (${mb}${t.source}): ready in ${t.totalMs} ms`
})

// ---- editor ----------------------------------------------------------------------------------

let checkTimer = 0
function onInput(): void {
  clearTimeout(checkTimer)
  checkTimer = window.setTimeout(() => {
    problem.value = jsonProblem(text.value)
  }, 250)
}
function onKeydown(ev: KeyboardEvent): void {
  if (!textarea.value) return
  if (handleEditorKey(ev, textarea.value).run) void run()
}
function onScroll(): void {
  if (gutter.value && textarea.value) gutter.value.scrollTop = textarea.value.scrollTop
}
function goToProblem(): void {
  const ta = textarea.value
  const p = problem.value
  if (!ta || !p || p.line < 1) return
  const lines = text.value.split('\n')
  let offset = 0
  for (let i = 0; i < p.line - 1 && i < lines.length; i++) offset += lines[i]!.length + 1
  offset += Math.max(0, p.column - 1)
  ta.focus()
  ta.setSelectionRange(offset, offset)
}
function reset(): void {
  text.value = fixtures[example.value.main] ?? ''
  problem.value = null
}

// ---- the stage: viewer + panel ---------------------------------------------------------------

/** The identifier last handed to the panel's picker. The editor's own identifier is re-seeded
 * only when it CHANGES, so a reader who picked another feature in the panel keeps that choice. */
let seeded: string | null = null
/** Set while this component writes the panel's controls itself, so those writes are not
 * mistaken for the reader asking for a run. */
let applying = false
let defaultsApplied = false

function seedSubject(): void {
  if (!panel) return
  const id = identifierOf(text.value)
  if (!id || id === seeded || isRuleFile(text.value)) return
  applying = true
  try {
    panel.seedOpenedDocument('feature', id)
  } finally {
    applying = false
  }
  seeded = id
}

/** Selects the example's preset and seed on the panel, the ones the page's own picture was made
 * with. The panel has no setter for either (a host normally leaves them to the user), so this
 * sets the two labelled controls the way a person would and lets the panel's own change handling
 * do the rest. If the panel's layout ever changes so they cannot be found, the example runs
 * with the panel's defaults instead, and the smoke test (tools/playground-smoke.mjs) says so. */
function applyExampleDefaults(): void {
  const host = sidebar.value
  if (!host) return
  const control = (label: string): HTMLInputElement | HTMLSelectElement | null => {
    for (const l of host.querySelectorAll<HTMLLabelElement>('label.fl-row-label')) {
      if (l.textContent?.trim() === label && l.htmlFor) {
        const el = host.querySelector<HTMLElement>(`#${CSS.escape(l.htmlFor)}`)
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el
      }
    }
    return null
  }
  applying = true
  try {
    const preset = control('Preset')
    if (preset instanceof HTMLSelectElement && [...preset.options].some((o) => o.value === example.value.env)) {
      preset.value = example.value.env
      preset.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const seed = control('Seed')
    if (seed instanceof HTMLInputElement) {
      seed.value = String(example.value.seed)
      seed.dispatchEvent(new Event('change', { bubbles: true }))
    }
  } finally {
    applying = false
  }
}

async function ensureEnvironments(): Promise<void> {
  if (defaultsApplied || !eng || !panel) return
  const list = JSON.parse(await eng.environments())
  if (disposed || !panel) return
  panel.setEnvironments(list)
  applyExampleDefaults()
  defaultsApplied = true
}

async function mountStage(): Promise<void> {
  if (fe.value || disposed) return
  // The panel's stylesheet is 70 KB. Imported plainly it would join the site's one global
  // stylesheet and every page would download it; as a string it travels with the viewer's own
  // chunk and reaches only pages that have a playground.
  const [frontend, css] = await Promise.all([import('featurelab-frontend'), import('featurelab-frontend/panel.css?inline')])
  if (!document.getElementById('fl-panel-css')) {
    const style = document.createElement('style')
    style.id = 'fl-panel-css'
    style.textContent = css.default
    document.head.append(style)
  }
  if (disposed || !stage.value || !canvas.value || !sidebar.value) return
  fe.value = frontend
  // Its own key: the docs site's sidebar width has nothing to do with the extension's.
  const splitter = frontend.createSplitter({ container: stage.value, sidebar: sidebar.value, storageKey: 'featurelab.layout.docs' })
  if (stage.value.clientWidth < 560) splitter.collapse()
  try {
    viewer = new frontend.VoxelViewer(canvas.value)
  } catch (err) {
    // No WebGL (disabled, blocklisted, or a context limit hit): say so where the result would be.
    runError.value = `This browser could not start the 3D view: ${err instanceof Error ? err.message : String(err)}`
    return
  }
  panel = frontend.createPanel(sidebar.value, {
    viewer,
    // The panel's own controls (preset, size, seed, the picker) re-run, as they do in the
    // extension. Grow-to-fit, Cancel and Reload files are left out: the panel disables a control
    // whose callback is missing, and none of the three means anything for a pack held in a page.
    onConfigChange: (params) => {
      if (!applying) void run(params)
    },
  })
  resizeObserver = new ResizeObserver(() => viewer?.resize())
  resizeObserver.observe(canvas.value)
  seedSubject()
  stageReady.value = true
  if (engine.value.status === 'ready') void ensureEnvironments().catch(() => undefined)
}

// ---- running ---------------------------------------------------------------------------------

let runSeq = 0

async function run(fromPanel?: object): Promise<void> {
  if (!panel || !fe.value || !eng) return
  const seq = ++runSeq
  const before = seeded
  seedSubject()
  let params: object | null = fromPanel && seeded === before ? fromPanel : panel.getGenerateParams()
  runError.value = null
  running.value = true
  panel.setBusy(true)
  try {
    if (engine.value.status !== 'ready') waiting.value = true
    await eng.startEngine()
    waiting.value = false
    if (seq !== runSeq) return
    if (engine.value.status !== 'ready') throw new Error(engine.value.message ?? 'The engine is not available.')
    if (!defaultsApplied) {
      await ensureEnvironments()
      params = panel.getGenerateParams()
    }
    if (isRuleFile(text.value)) {
      throw new Error('This is a feature rule. The playground places one feature at one spot and has no world for a rule to decorate; run rules with the extension or `featurelab generate --rule`.')
    }
    if (!params) throw new Error('This file declares no "identifier", so there is nothing to place. Add one under "description".')
    const files = packFor(mainPath.value, text.value)
    const t0 = performance.now()
    const raw = JSON.parse(await eng.generate(files, params)) as Record<string, unknown>
    const ms = Math.round(performance.now() - t0)
    if (seq !== runSeq || disposed) return
    if (typeof raw.error === 'string') throw new Error(raw.error)
    const decoded = fe.value.decodeGenerateResult(raw)
    panel.setResult(decoded)
    if (viewer && !viewer.hasFramed()) viewer.frameContent()
    // The edited file's own errors, next to the editor. The panel lists every diagnostic; these
    // are the ones a reader typing into this box is most likely to have just caused.
    const errors = decoded.diagnostics
      .filter((d) => d.level === 'error' && (d.fileId === mainPath.value || d.fileId === ''))
      .slice(0, 3)
      .map((d) => d.message)
    const c = decoded.counts
    const parts = [
      [c.placed, 'placed'],
      [c.replaced, 'replaced'],
      [c.carved, 'carved'],
    ].filter(([n]) => (n as number) > 0).map(([n, what]) => `${n === 1 ? '1 block' : `${n} blocks`} ${what}`)
    // "Placed" alone would say an ore vein did nothing: an ore replaces stone, it places into
    // no empty cell. The three are the panel's own three tiles.
    const summary = parts.length > 0 ? `${parts.join(', ')}, in ${ms} ms.` : `Nothing placed (${ms} ms). The Diagnostics section in the sidebar says why.`
    result.value = { placed: c.placed, ms, errors, summary }
  } catch (err) {
    if (seq !== runSeq || disposed) return
    const message = err instanceof Error ? err.message : String(err)
    runError.value = message
    result.value = null
    panel?.setError(message)
  } finally {
    if (seq === runSeq) {
      running.value = false
      waiting.value = false
      panel?.setBusy(false)
    }
  }
}

function onPickExample(): void {
  seeded = null
  reset()
  seedSubject()
  applyExampleDefaults()
  result.value = null
  runError.value = null
  if (engine.value.status === 'ready' && defaultsApplied) void run()
}

// ---- lifecycle -------------------------------------------------------------------------------

/** requestIdleCallback where there is one (Safari has none): after whatever the page is doing. */
function whenIdle(fn: () => void): void {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(fn, { timeout: 2000 })
  else window.setTimeout(fn, 200)
}

function onNear(): void {
  // The viewer first: nothing can be run until it is there, and a 9 MB engine download started
  // alongside it only slows it down.
  void mountStage()
    .catch(() => undefined)
    .finally(() =>
      whenIdle(() => {
        if (!disposed && eng) void eng.startEngine()
      }),
    )
}

onMounted(async () => {
  eng = await import('../playground/engine')
  if (disposed) return
  unsubscribe = eng.subscribeEngine((s) => {
    engine.value = s
    if (s.status === 'ready' && stageReady.value) void ensureEnvironments().catch(() => undefined)
  })
  if ('IntersectionObserver' in window && root.value) {
    intersection = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        intersection?.disconnect()
        intersection = null
        onNear()
      },
      // Early enough that a reader scrolling towards it finds it ready.
      { rootMargin: '600px 0px' },
    )
    intersection.observe(root.value)
  } else {
    onNear()
  }
})

onBeforeUnmount(() => {
  disposed = true
  intersection?.disconnect()
  unsubscribe?.()
  resizeObserver?.disconnect()
  clearTimeout(checkTimer)
  // The engine stays: it is shared with the next page that has a playground.
  viewer?.dispose()
  viewer = null
  panel = null
})
</script>

<template>
  <div
    ref="root"
    class="fl-pg vp-raw"
    :data-engine="engine.status"
    :data-placed="result ? result.placed : undefined"
    :data-run-ms="result ? result.ms : undefined"
  >
    <div class="fl-pg-grid">
      <div class="fl-pg-source">
        <div class="fl-pg-head">
          <select v-if="choose" v-model="exampleId" class="fl-pg-pick" aria-label="Example" @change="onPickExample">
            <option v-for="e in EXAMPLES" :key="e.id" :value="e.id">{{ e.title }}</option>
          </select>
          <code class="fl-pg-file">{{ mainPath }}</code>
          <button type="button" class="fl-pg-reset" title="Put the example back the way it was" @click="reset">Reset</button>
        </div>
        <div class="fl-pg-editor" :class="{ 'has-problem': problem }">
          <div ref="gutter" class="fl-pg-gutter" aria-hidden="true">
            <div v-for="n in lineCount" :key="n" :class="{ bad: problem && problem.line === n }">{{ n }}</div>
          </div>
          <textarea
            ref="textarea"
            v-model="text"
            class="fl-pg-text"
            wrap="off"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            :aria-label="`${mainPath}, editable`"
            aria-describedby="fl-pg-keys"
            @input="onInput"
            @keydown="onKeydown"
            @scroll="onScroll"
          />
        </div>
        <p v-if="problem" class="fl-pg-problem" role="status">
          <button v-if="problem.line > 0" type="button" class="fl-pg-linkish" @click="goToProblem">Line {{ problem.line }}, column {{ problem.column }}</button>
          <span v-if="problem.line > 0">: </span>{{ problem.message }}
        </p>
        <p v-if="otherFiles.length" class="fl-pg-also">
          Also loaded, because this file names them: <code v-for="f in otherFiles" :key="f">{{ f }}</code>
        </p>
        <div class="fl-pg-actions">
          <button type="button" class="fl-pg-run" :disabled="running && !waiting" @click="run()">
            {{ running ? 'Running…' : 'Run preview' }}
          </button>
          <span id="fl-pg-keys" class="fl-pg-keys">Ctrl+Enter runs · Esc then Tab leaves the editor</span>
        </div>
        <p class="fl-pg-status" role="status" aria-live="polite" :title="engineTitle">
          <span v-if="engineLine" :class="{ 'is-bad': engine.status === 'missing' || engine.status === 'failed' }">{{ engineLine }}</span>
          <span v-else-if="runError" class="is-bad">{{ runError }}</span>
          <span v-else-if="result">
            {{ result.summary }}
            <template v-if="result.errors.length"><br /><span v-for="(e, i) in result.errors" :key="i" class="is-bad">{{ e }}<br /></span></template>
          </span>
        </p>
      </div>
      <div ref="stage" class="fl-pg-stage">
        <canvas ref="canvas" class="fl-pg-canvas" />
        <div ref="sidebar" class="fl-pg-sidebar" />
        <div v-if="!result && !running" class="fl-pg-hint" aria-hidden="true">
          <span>Press <strong>Run preview</strong> to place this feature.</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* The shared panel is themed through VS Code's variable names (frontend/src/ui/panel.css);
   outside VS Code it falls back to its own palette. Here they are pointed at the site's tokens
   instead, so the sidebar follows the site's light/dark switch rather than the OS setting. */
.fl-pg {
  --vscode-sideBar-background: var(--vp-c-bg-soft);
  --vscode-editor-background: var(--vp-c-bg);
  --vscode-editorWidget-background: var(--vp-c-bg-elv);
  --vscode-editorWidget-foreground: var(--vp-c-text-1);
  --vscode-foreground: var(--vp-c-text-1);
  --vscode-descriptionForeground: var(--vp-c-text-2);
  --vscode-disabledForeground: var(--vp-c-text-3);
  --vscode-panel-border: var(--vp-c-divider);
  --vscode-widget-border: var(--vp-c-divider);
  --vscode-input-background: var(--vp-c-bg);
  --vscode-input-foreground: var(--vp-c-text-1);
  --vscode-input-border: var(--vp-c-border);
  --vscode-list-hoverBackground: var(--vp-c-default-soft);
  --vscode-toolbar-hoverBackground: var(--vp-c-default-soft);
  --vscode-button-background: var(--vp-button-brand-bg);
  --vscode-button-foreground: var(--vp-button-brand-text);
  --vscode-button-hoverBackground: var(--vp-button-brand-hover-bg);
  --vscode-focusBorder: var(--vp-c-brand-1);
  --vscode-textLink-foreground: var(--vp-c-brand-1);
  --vscode-errorForeground: var(--vp-c-danger-1);
  --vscode-inputValidation-errorBorder: var(--vp-c-danger-1);
  --vscode-inputValidation-errorBackground: var(--vp-c-danger-soft);
  --vscode-inputValidation-warningBorder: var(--vp-c-warning-1);
  --vscode-inputValidation-warningBackground: var(--vp-c-warning-soft);
  --vscode-editorWarning-foreground: var(--vp-c-warning-1);
  --vscode-badge-background: var(--vp-c-default-soft);
  --vscode-badge-foreground: var(--vp-c-text-1);
  --vscode-font-family: var(--vp-font-family-base);
  --vscode-font-size: 13px;
  --vscode-editor-font-family: var(--vp-font-family-mono);

  container-type: inline-size;
  margin: 16px 0 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  overflow: hidden;
  font-size: 14px;
  color: var(--vp-c-text-1);
}

.fl-pg-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.fl-pg-source {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--vp-c-divider);
}
.fl-pg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  min-width: 0;
}
.fl-pg-pick {
  flex: 0 1 auto;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--vp-c-border);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font: inherit;
}
.fl-pg-file {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-2);
}
.fl-pg-reset,
.fl-pg-linkish {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--vp-c-brand-1);
  cursor: pointer;
}
.fl-pg-reset {
  font-size: 13px;
}
.fl-pg-reset:hover,
.fl-pg-linkish:hover {
  text-decoration: underline;
}

.fl-pg-editor {
  display: flex;
  height: 300px;
  border: 1px solid var(--vp-c-border);
  border-radius: 6px;
  background: var(--vp-code-block-bg);
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 20px;
}
.fl-pg-editor:focus-within {
  border-color: var(--vp-c-brand-1);
}
.fl-pg-editor.has-problem {
  border-color: var(--vp-c-danger-1);
}
.fl-pg-gutter {
  flex: 0 0 auto;
  min-width: 36px;
  padding: 8px 6px 8px 0;
  overflow: hidden;
  text-align: right;
  color: var(--vp-c-text-3);
  user-select: none;
  border-right: 1px solid var(--vp-c-divider);
}
.fl-pg-gutter .bad {
  color: var(--vp-c-danger-1);
  font-weight: 700;
}
.fl-pg-text {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 8px 10px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--vp-c-text-1);
  font: inherit;
  line-height: inherit;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}

.fl-pg-problem,
.fl-pg-also,
.fl-pg-status {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
}
.fl-pg-problem {
  color: var(--vp-c-danger-1);
}
.fl-pg-also {
  color: var(--vp-c-text-2);
}
.fl-pg-also code {
  margin-left: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}
.fl-pg-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 8px;
}
.fl-pg-run {
  padding: 6px 16px;
  border: 1px solid var(--vp-button-brand-border);
  border-radius: 20px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.fl-pg-run:hover:not(:disabled) {
  background: var(--vp-button-brand-hover-bg);
}
.fl-pg-run:disabled {
  opacity: 0.7;
  cursor: progress;
}
.fl-pg-keys {
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.fl-pg-status {
  min-height: 1.5em;
  color: var(--vp-c-text-2);
  white-space: pre-line;
}
.fl-pg-status .is-bad {
  color: var(--vp-c-danger-1);
}

.fl-pg-stage {
  position: relative;
  display: flex;
  height: 460px;
  min-width: 0;
}
.fl-pg-canvas {
  flex: 1 1 auto;
  min-width: 0;
  display: block;
  height: 100%;
}
.fl-pg-sidebar {
  flex: 0 0 300px;
  overflow-y: auto;
  border-left: 1px solid var(--vp-c-divider);
}
.fl-pg-hint {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.fl-pg-hint span {
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 13px;
}

/* Wide enough to put the source beside the result: the /playground page, and a wide window. */
@container (min-width: 980px) {
  .fl-pg-grid {
    grid-template-columns: minmax(340px, 2fr) minmax(0, 3fr);
  }
  .fl-pg-source {
    border-bottom: 0;
    border-right: 1px solid var(--vp-c-divider);
  }
  .fl-pg-editor {
    flex: 1 1 auto;
    height: auto;
    min-height: 300px;
  }
  .fl-pg-stage {
    height: 620px;
  }
}
</style>
