// dom.ts -- tiny declarative DOM helpers shared by panel.ts's sections (h/row/makeSection/
// numberInput/iconButton/readInt/clamp), so panel.ts doesn't have to redeclare them once per
// section. Pulled into their own module because panel.ts is already large once it owns both
// the view controls it always had AND the generation-config controls (see that file's header
// comment) -- splitting helpers out keeps each file's own job legible without forking the
// *package* (frontend/ is still the one place both app shells import from).

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** One label+control row, the basic unit every section is built from: one line, nothing under
 * it. `title` is the row's one-sentence explanation, carried as the native tooltip on the ROW
 * (not the label) so a control with no title of its own inherits it -- hovering the box shows
 * the same sentence as hovering the label, and nothing about the row's geometry changes on
 * hover. Anything longer than a sentence belongs in the section's `?` documentation (see
 * makeSection's `onHelp`), never in a paragraph beneath the control. */
export function row(label: string, control: HTMLElement, title?: string): HTMLElement {
  const r = h('div', 'fl-row')
  const l = h('label', 'fl-row-label', label)
  if (title) r.title = title
  r.append(l, control)
  return r
}

/** A collapsible section: a head (the clickable caret+title toggle, and -- when `onHelp` is
 * given -- exactly one `?` at the right end that opens that section's documentation) and a
 * body. `collapsedSet` is the shared persisted set of collapsed section ids (see panel.ts's
 * PersistedPanelState) -- toggling a section adds/removes its id and calls `onToggle`
 * (panel.ts wires this to its own `save()`) so "remember which sections are open across
 * regenerations" holds without this module knowing anything about persistence itself.
 *
 * The toggle and the `?` are SIBLING buttons inside `.fl-section-head` rather than one nested
 * in the other (a button inside a button is not valid HTML and the inner one never receives
 * the click); `.fl-section-header` keeps its name because every harness and test that expands
 * a section clicks it by that class. */
export function makeSection(
  id: string,
  title: string,
  collapsedSet: Set<string>,
  onToggle: () => void,
  onHelp?: () => void,
): { section: HTMLElement; body: HTMLElement; header: HTMLButtonElement; help: HTMLButtonElement | null } {
  const section = h('section', 'fl-section')
  section.dataset.sectionId = id
  const head = h('div', 'fl-section-head')
  const header = h('button', 'fl-section-header') as HTMLButtonElement
  header.type = 'button'
  const caret = h('span', 'fl-caret', '▸')
  const titleEl = h('span', 'fl-section-title-text', title)
  header.append(caret, titleEl)
  head.append(header)
  let help: HTMLButtonElement | null = null
  if (onHelp) {
    help = h('button', 'fl-help', '?') as HTMLButtonElement
    help.type = 'button'
    help.setAttribute('aria-label', `Explain ${title}`)
    help.title = `Explain ${title}`
    help.setAttribute('aria-expanded', 'false')
    help.addEventListener('click', onHelp)
    head.append(help)
  }
  const body = h('div', 'fl-section-body')

  const collapsed = collapsedSet.has(id)
  section.classList.toggle('fl-collapsed', collapsed)
  header.setAttribute('aria-expanded', String(!collapsed))

  header.addEventListener('click', () => {
    const isCollapsed = section.classList.toggle('fl-collapsed')
    header.setAttribute('aria-expanded', String(!isCollapsed))
    if (isCollapsed) collapsedSet.add(id)
    else collapsedSet.delete(id)
    onToggle()
  })

  section.append(head, body)
  return { section, body, header, help }
}

export function numberInput(value: number, opts: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
  const input = h('input', 'fl-num-input') as HTMLInputElement
  input.type = 'number'
  input.value = String(value)
  if (opts.min !== undefined) input.min = String(opts.min)
  if (opts.max !== undefined) input.max = String(opts.max)
  input.step = String(opts.step ?? 1)
  return input
}

/** Like `numberInput`, but represents "no opinion" (omitted on the wire) as a genuinely EMPTY
 * input rather than any numeric value -- including 0, which is a legitimate value for several
 * of this app's own optional wire fields (minY, seaFloorDepth, and now the Budget section's
 * writeBudget/delegationBudget/placementTimeLimitMs) and must stay distinguishable from "not
 * given". Pair with `readOptionalInt` to read it back. */
export function optionalNumberInput(value: number | null, opts: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
  const input = h('input', 'fl-num-input') as HTMLInputElement
  input.type = 'number'
  input.value = value === null ? '' : String(value)
  if (opts.min !== undefined) input.min = String(opts.min)
  if (opts.max !== undefined) input.max = String(opts.max)
  input.step = String(opts.step ?? 1)
  return input
}

export function textInput(value: string, placeholder?: string): HTMLInputElement {
  const input = h('input', 'fl-text-input') as HTMLInputElement
  input.type = 'text'
  input.value = value
  if (placeholder) input.placeholder = placeholder
  return input
}

export function checkboxInput(checked: boolean): HTMLInputElement {
  const input = h('input', 'fl-checkbox') as HTMLInputElement
  input.type = 'checkbox'
  input.checked = checked
  return input
}

export function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = h('button', 'fl-icon-btn') as HTMLButtonElement
  btn.type = 'button'
  btn.textContent = text
  btn.title = title
  btn.addEventListener('click', onClick)
  return btn
}

export function readInt(input: HTMLInputElement, fallback: number): number {
  const n = Math.round(Number(input.value))
  return Number.isFinite(n) ? n : fallback
}

/** Reads an `optionalNumberInput` back -- a blank/whitespace-only value is "no opinion" (null),
 * distinct from any entered number including 0. An unparseable NON-blank value falls back to
 * `fallback` (same defensive posture as `readInt`) rather than silently becoming "no opinion". */
export function readOptionalInt(input: HTMLInputElement, fallback: number | null): number | null {
  if (input.value.trim() === '') return null
  const n = Math.round(Number(input.value))
  return Number.isFinite(n) ? n : fallback
}

export function readFloat(input: HTMLInputElement, fallback: number): number {
  const n = Number(input.value)
  return Number.isFinite(n) ? n : fallback
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
