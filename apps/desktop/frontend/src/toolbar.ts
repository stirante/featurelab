// toolbar.ts -- the desktop app's own controls: open a pack directory, pick a feature or
// rule from it, and the environment/seed/origin/size/profile knobs GenerateParams accepts.
// This is generation CONFIGURATION, deliberately NOT part of the shared featurelab-frontend
// package (see that package's ui/panel.ts header comment: pickers and environment presets
// are "the host app's job") -- panel.ts owns only the view/diagnostics/profiler READOUTS a
// result carries.
//
// Every control change calls opts.onGenerate with a freshly-built GenerateParams (debounced
// for free-typed number fields, immediate for selects/checkboxes) -- main.ts is the one
// place that decides what happens with that (call the engine, apply the result), which is
// what keeps this module free of any camera/view-state concern.
import type { EnvironmentOption, GenerateParams, LoadPackResult, PackItem } from './types.js'

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function group(label: string, ...controls: HTMLElement[]): HTMLElement {
  const g = h('div', 'fl-tb-group')
  g.append(h('span', 'fl-tb-label', label), ...controls)
  return g
}

export interface ToolbarOptions {
  onOpenPack: () => void
  /** Called with a freshly-built GenerateParams whenever a control changes AND an item is
   * selected -- null is never passed; callers should simply not be called until there is
   * something to generate. */
  onGenerate: (params: GenerateParams) => void
  /** Called (with the same GenerateParams onGenerate would use) when the user clicks "Grow to
   * fit & regenerate" -- the "grow to fit and regenerate" action (see featurelab-frontend's
   * ui/panel.ts's own onGrowRegenerate doc comment for the full design): the host is expected
   * to drive a DIFFERENT engine call with these params (App.GenerateGrown, not App.Generate)
   * and feed the decoded result back to panel.setResult() same as any other result -- its own
   * `grown`/`preGrowBounds` fields are what make panel.ts render it as a re-run rather than a
   * wider view. This toolbar -- not featurelab-frontend's own panel.ts Feature/Rule pickers --
   * is what actually drives generation config in this app (see this file's own header comment),
   * so THIS is where the grow trigger lives too; panel.ts's own "Grow to fit & regenerate"
   * button stays disabled here (main.ts never passes panel createPanel an onGrowRegenerate of
   * its own) precisely because panel's internal config state is not what a desktop regenerate
   * actually uses. */
  onGrowRegenerate: (params: GenerateParams) => void
}

export interface ToolbarHandle {
  setPackInfo(info: LoadPackResult): void
  /** Shows or clears a banner for a pack-level problem: LoadPack failing, or a background
   * reload (see app.go's handlePackChanged) failing after a file-watcher event. Distinct
   * from featurelab-frontend's own panel.ts error banner, which is about one generate call
   * failing, not the pack itself. */
  setPackError(message: string | null): void
  /** Shows or clears a second, quieter banner for anything about BLOCK TEXTURES: the atlas
   * being built, a download declined, an offline machine that will keep drawing flat colours.
   * Deliberately its own line rather than setPackError's: none of it is a problem with the
   * user's pack, and none of it stops the preview working -- but "the preview looks the same
   * as it always did" with nothing said is indistinguishable from the feature being broken,
   * which is exactly the failure this line exists to prevent. */
  setNotice(message: string | null): void
  setEnvironments(envs: EnvironmentOption[]): void
  setBusy(busy: boolean): void
  /** The current GenerateParams, or null if no feature/rule is selected yet -- main.ts calls
   * this in response to a "pack:changed" event to regenerate with whatever the user last
   * configured, without the toolbar having to know anything about that event itself. */
  getParams(): GenerateParams | null
}

const DEBOUNCE_MS = 350

export function createToolbar(root: HTMLElement, opts: ToolbarOptions): ToolbarHandle {
  root.textContent = ''

  let environments: EnvironmentOption[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const openButton = h('button', undefined, 'Open pack directory…') as HTMLButtonElement
  openButton.type = 'button'
  openButton.addEventListener('click', () => opts.onOpenPack())

  const pathLabel = h('span', 'fl-tb-path', '(no pack open)')

  // See ToolbarHandle.setNotice. Hidden until there is something to say, so an app with
  // textures already built shows nothing at all.
  const noticeBanner = h('div', 'fl-tb-banner fl-tb-banner-notice')
  noticeBanner.style.display = 'none'

  const itemSelect = h('select') as HTMLSelectElement
  itemSelect.disabled = true

  const envSelect = h('select') as HTMLSelectElement

  const seedInput = h('input', 'fl-tb-num') as HTMLInputElement
  seedInput.type = 'number'
  seedInput.min = '0'
  seedInput.placeholder = 'auto'

  const originXInput = h('input', 'fl-tb-num') as HTMLInputElement
  originXInput.type = 'number'
  originXInput.value = '0'
  const originYInput = h('input', 'fl-tb-num') as HTMLInputElement
  originYInput.type = 'number'
  originYInput.placeholder = 'auto'
  const originZInput = h('input', 'fl-tb-num') as HTMLInputElement
  originZInput.type = 'number'
  originZInput.value = '0'

  const sizeXInput = h('input', 'fl-tb-num') as HTMLInputElement
  sizeXInput.type = 'number'
  sizeXInput.min = '1'
  const sizeYInput = h('input', 'fl-tb-num') as HTMLInputElement
  sizeYInput.type = 'number'
  sizeYInput.min = '1'
  const sizeZInput = h('input', 'fl-tb-num') as HTMLInputElement
  sizeZInput.type = 'number'
  sizeZInput.min = '1'

  const profileCheckbox = h('input') as HTMLInputElement
  profileCheckbox.type = 'checkbox'
  profileCheckbox.title =
    'Collect a per-run profile (touch counts, per-feature cost/delegation attribution) and include it in the result. ' +
    'Needed for the View section’s heatmap toggle and the Profiler section’s cost table.'

  const regenButton = h('button', undefined, 'Regenerate') as HTMLButtonElement
  regenButton.type = 'button'
  regenButton.addEventListener('click', () => fireGenerate())

  // "Grow to fit & regenerate" -- see ToolbarOptions.onGrowRegenerate's own doc comment for why
  // this lives on the toolbar (this app's real generation-config surface) rather than relying
  // on featurelab-frontend's own panel.ts button, which stays disabled in this app. Always
  // enabled whenever an item is selected, exactly like "Regenerate" -- clicking it when the
  // last run captured nothing simply reports grown:false (see wire.RunGenerateGrown), never a
  // misleading result.
  const growButton = h('button', undefined, 'Grow to fit & regenerate') as HTMLButtonElement
  growButton.type = 'button'
  growButton.title = 'Expand the bench to include every out-of-bounds block the last run captured, then place AGAIN at the larger size. This is a DIFFERENT run (different reads, possibly different RNG outcomes) -- not the same result seen wider.'
  growButton.addEventListener('click', () => {
    const params = currentParams()
    if (params) opts.onGrowRegenerate(params)
  })

  const packBanner = h('div', 'fl-tb-banner fl-tb-banner-error')
  packBanner.style.display = 'none'

  // Env changes update the size inputs to that preset's defaults ONLY while the size inputs
  // still hold a previous preset's defaults (i.e. the user hasn't hand-edited them) -- once a
  // user types a custom size, switching environments must not silently discard it.
  let sizeIsDefault = true
  envSelect.addEventListener('change', () => {
    const preset = environments.find((e) => e.id === envSelect.value)
    if (preset && sizeIsDefault) {
      sizeXInput.value = String(preset.defaultSizeX)
      sizeYInput.value = String(preset.defaultSizeY)
      sizeZInput.value = String(preset.defaultSizeZ)
    }
    fireGenerate()
  })
  for (const el of [sizeXInput, sizeYInput, sizeZInput]) {
    el.addEventListener('input', () => {
      sizeIsDefault = false
      fireGenerateDebounced()
    })
  }

  itemSelect.addEventListener('change', () => fireGenerate())
  for (const el of [seedInput, originXInput, originYInput, originZInput]) {
    el.addEventListener('input', () => fireGenerateDebounced())
  }
  profileCheckbox.addEventListener('change', () => fireGenerate())

  root.append(
    openButton,
    pathLabel,
    group('Feature / rule', itemSelect),
    group('Env', envSelect),
    group('Seed', seedInput),
    group('Origin', originXInput, originYInput, originZInput),
    group('Size', sizeXInput, sizeYInput, sizeZInput),
    group('Profile', profileCheckbox),
    regenButton,
    growButton,
    packBanner,
    noticeBanner,
  )

  function currentParams(): GenerateParams | null {
    const raw = itemSelect.value
    if (!raw) return null
    const [kind, identifier] = splitItemValue(raw)
    const params: GenerateParams = { env: envSelect.value || undefined, profile: profileCheckbox.checked }
    if (kind === 'feature') params.feature = identifier
    else params.rule = identifier

    if (seedInput.value !== '') params.seed = Number(seedInput.value)

    // GenerateParams.Origin is all-or-nothing ("x,y,z" or unset entirely -- see
    // apps/desktop/generate.go's parseOrigin), but this toolbar lets Y specifically be left
    // blank ("auto", the preset's own default) independent of X/Z. An explicit Y is the only
    // thing that can turn "auto" off, so Origin is only sent at all when Y is given.
    const ox = numOr(originXInput.value, 0)
    const oz = numOr(originZInput.value, 0)
    const oy = originYInput.value !== '' ? Number(originYInput.value) : null
    if (oy !== null) params.origin = `${ox},${oy},${oz}`

    const sx = numOr(sizeXInput.value, 0)
    const sy = numOr(sizeYInput.value, 0)
    const sz = numOr(sizeZInput.value, 0)
    if (sx > 0 && sy > 0 && sz > 0) params.size = `${sx}x${sy}x${sz}`

    return params
  }

  function fireGenerate(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    const params = currentParams()
    if (params) opts.onGenerate(params)
  }

  function fireGenerateDebounced(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(fireGenerate, DEBOUNCE_MS)
  }

  return {
    setPackInfo(info: LoadPackResult): void {
      pathLabel.textContent = info.dir
      pathLabel.title = info.dir
      itemSelect.textContent = ''
      itemSelect.disabled = info.items.length === 0
      const features = info.items.filter((i) => i.kind === 'feature')
      const rules = info.items.filter((i) => i.kind === 'rule')
      appendGroup(itemSelect, 'Features', features)
      appendGroup(itemSelect, 'Rules', rules)
      if (info.warnings.length > 0) {
        packBanner.textContent = info.warnings.join('; ')
        packBanner.className = 'fl-tb-banner fl-tb-banner-warning'
        packBanner.style.display = ''
      } else {
        packBanner.style.display = 'none'
      }
    },
    setPackError(message: string | null): void {
      if (message === null) {
        packBanner.style.display = 'none'
        return
      }
      packBanner.textContent = message
      packBanner.className = 'fl-tb-banner fl-tb-banner-error'
      packBanner.style.display = ''
    },
    setNotice(message: string | null): void {
      if (message === null) {
        noticeBanner.style.display = 'none'
        return
      }
      noticeBanner.textContent = message
      noticeBanner.style.display = ''
    },
    setEnvironments(envs: EnvironmentOption[]): void {
      environments = envs
      envSelect.textContent = ''
      for (const e of envs) {
        const opt = h('option', undefined, e.label || e.id) as HTMLOptionElement
        opt.value = e.id
        opt.title = e.description
        envSelect.append(opt)
      }
      const plains = envs.find((e) => e.id === 'plains') ?? envs[0]
      if (plains) {
        envSelect.value = plains.id
        sizeXInput.value = String(plains.defaultSizeX)
        sizeYInput.value = String(plains.defaultSizeY)
        sizeZInput.value = String(plains.defaultSizeZ)
      }
    },
    setBusy(busy: boolean): void {
      regenButton.disabled = busy
    },
    getParams: currentParams,
  }
}

function splitItemValue(raw: string): [PackItem['kind'], string] {
  const sep = raw.indexOf(':')
  return [raw.slice(0, sep) as PackItem['kind'], raw.slice(sep + 1)]
}

function appendGroup(select: HTMLSelectElement, label: string, items: readonly PackItem[]): void {
  if (items.length === 0) return
  const optgroup = document.createElement('optgroup')
  optgroup.label = label
  for (const item of items) {
    const opt = document.createElement('option')
    opt.value = `${item.kind}:${item.identifier}`
    opt.textContent = item.identifier
    optgroup.append(opt)
  }
  select.append(optgroup)
}

function numOr(raw: string, fallback: number): number {
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}
