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
  labelFor(l, control)
  return r
}

let labelSeq = 0

/** Points `label` at the form control it names with a real `for`/`id` pair.
 *
 * A `<label>` only announces, and only grows a click target, when it is actually associated with
 * a control -- wrapping or adjacency is not association. Every row here put the two side by side
 * and stopped there, so a screen reader read "Size X" and then, separately, an unnamed spinbox,
 * and clicking the word did nothing.
 *
 * `control` is frequently a WRAPPER (the Budget section's input+badge, a radio group), so the
 * first form control inside it is what gets the id. A wrapper with none -- a radio group, where
 * each option carries its own label already -- is left alone rather than pointed at something
 * arbitrary. An id already present is never overwritten. */
export function labelFor(label: HTMLLabelElement, control: HTMLElement): void {
  const target =
    control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement
      ? control
      : control.querySelector('input, select, textarea')
  if (!(target instanceof HTMLElement)) return
  // A radio group's own first option is not what the group's label names -- pointing at it would
  // turn a click on the word "Environment" into a click on "Solid".
  if (target instanceof HTMLInputElement && target.type === 'radio') return
  if (target.id === '') target.id = `fl-c${String(++labelSeq)}`
  label.htmlFor = target.id
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

/** Marks a control INERT WITHOUT REMOVING IT FROM THE PAGE.
 *
 * `disabled` does three things at once: it greys the control, it stops the activation, and it
 * takes the control out of the tab order along with its accessible name. The third is a problem
 * whenever the NAME IS THE REASON -- and in this panel it always is, because the standing rule
 * here is that an inert control carries its explanation as its own tooltip/label ("no texture
 * atlas has been built for this machine…", "this run turned no cells to air…"). A keyboard or
 * screen-reader user could not read any of those sentences at the one moment they were worth
 * reading. Measured: four controls (the CARVED chip, "Block textures", "Show heatmap" and the
 * viewport's Textures button) were unreachable, each holding its own explanation.
 *
 * `aria-disabled` is the ARIA practices' answer: the control stays focusable and keeps its name,
 * reads as "dimmed"/"unavailable", and its activation is made a no-op instead -- which is what
 * `guardInertActivation` below does, and what a caller checking `isInert` in its own click
 * handler does. */
export function setInert(el: HTMLElement, inert: boolean): void {
  if (inert) el.setAttribute('aria-disabled', 'true')
  else el.removeAttribute('aria-disabled')
}

export function isInert(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true'
}

let reasonSeq = 0

/** Gives an inert control the sentence that says WHY, as a real accessible DESCRIPTION.
 *
 * `setInert` above only says a control is unavailable. It does not say what `disabled` used to
 * say by accident, which is the half that matters: every inert control in this panel has an
 * explanation attached, and until this helper existed that explanation lived in the ROW's
 * `title` -- an attribute on a wrapper `<div>`, which is not the control's name, not its
 * description, and reachable by nothing but a mouse hover. Measured on the built bundle: the
 * accessible description of "Block textures" and of "Show heatmap" was the empty string while
 * both were inert, and the one element that did hold the texture sentence (the texture note)
 * had no `id` for anything to point at.
 *
 * `visible` is that element, when there is one: a sentence already on screen is described from
 * where it is, rather than duplicated into a second hidden copy an AT would read out twice. It
 * is used only when it is actually rendered -- `aria-describedby` pointing at a `display: none`
 * element produces NO description, so a hidden note falls back to the hidden span like any
 * other control with nowhere to put its reason.
 *
 * `title` is left to the caller: it is the pointer-user's copy of the same sentence, and an
 * explicit `aria-describedby` outranks it for everyone else. */
export function setInertReason(control: HTMLElement, reason: string, visible?: HTMLElement | null): void {
  const owned = control.nextElementSibling instanceof HTMLElement && control.nextElementSibling.dataset.flReasonFor === control.id ? control.nextElementSibling : null
  const rendered = visible !== null && visible !== undefined && visible.style.display !== 'none' && !visible.hidden && visible.textContent !== ''
  if (reason === '' && !rendered) {
    control.removeAttribute('aria-describedby')
    owned?.remove()
    return
  }
  if (rendered) {
    owned?.remove()
    if (visible.id === '') visible.id = `fl-reason${String(++reasonSeq)}`
    control.setAttribute('aria-describedby', visible.id)
    return
  }
  if (control.id === '') control.id = `fl-c${String(++labelSeq)}`
  const span = owned ?? h('span', 'fl-sr-only')
  span.dataset.flReasonFor = control.id
  if (span.id === '') span.id = `fl-reason${String(++reasonSeq)}`
  span.textContent = reason
  if (owned === null) control.after(span)
  control.setAttribute('aria-describedby', span.id)
}

/** Makes activation a no-op while `setInert(el, true)` holds -- install once, at construction.
 *
 * `preventDefault` on the click is what cancels a checkbox's activation behaviour, which is also
 * what suppresses the `change` event the caller listens to, so an inert checkbox neither flips
 * nor reports. It covers the keyboard too: Space on a focused checkbox dispatches exactly this
 * click. */
export function guardInertActivation(el: HTMLElement): void {
  el.addEventListener('click', (ev) => {
    if (isInert(el)) ev.preventDefault()
  })
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
