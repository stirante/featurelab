// docs.ts -- the sidebar's documentation panel: the long form behind each section's one `?`.
//
// The same shape as the node inspector's `.flg-ins-docs` (apps/vscode/src/graph/inspector.ts,
// renderDocs): a panel with `✕`, `‹ Back to overview`, a large section title, and one entry per
// control -- a glyph for its kind, the name, badges, the one-sentence summary, then the detail.
// It is REBUILT here rather than imported from there because the inspector's panel is a closure
// inside createNodeInspector over the graph's NodeForm/catalogue types, and it lives in
// apps/vscode -- which this package cannot depend on without inverting the dependency both app
// shells (VS Code and the Wails desktop app) rely on: they import frontend/, never the other way.
//
// Opening and closing this panel writes nothing and moves no row: it is appended to <body> and
// fixed over the area to the LEFT of the sidebar (the 3D view's side), never over a control --
// the reader compares a control against its explanation with both on screen. That is the
// inspector's own placement (it floats over the graph canvas beside its form); the one
// difference is a width cap, so the preview the controls describe stays partly visible instead
// of disappearing entirely behind text about it.
import { h } from './dom.js'

export interface DocBadge {
  kind: 'default' | 'range' | 'wire' | 'inert' | 'host'
  label: string
  /** A sentence for the badge's own tooltip, where the label alone is terse. */
  title?: string
}

export interface DocEntry {
  /** The control's label, as the row shows it. */
  name: string
  /** One glyph for the kind of control, text so it inherits the theme's colour. */
  glyph: string
  kindLabel: string
  badges?: readonly DocBadge[]
  /** The one sentence the row's tooltip also carries. */
  summary: string
  /** Everything that used to be a paragraph under the control, as paragraphs here. */
  detail?: readonly string[]
  /** Plain facts: what blank means, the accepted range. */
  facts?: readonly string[]
}

export interface DocSection {
  /** Matches the section's own id (`.fl-section[data-section-id]`), or names a region that
   * has no collapsible section of its own (the readout above them). */
  id: string
  title: string
  /** Paragraphs about the section as a whole, before its entries. */
  intro?: readonly string[]
  entries: readonly DocEntry[]
}

export interface DocsPanelOptions {
  /** The element the panel is placed beside -- the sidebar's own scroll container. A function
   * because the panel root may not be attached to it yet when the panel is built. */
  anchor: () => HTMLElement
  /** The overview's heading and sub-heading. */
  title: string
  subtitle?: string
  /** Computed on every open, so a section can name live things (the preset list, the selected
   * preset) rather than a value frozen at construction. */
  sections: () => readonly DocSection[]
  /** Called after open/close so the caller can mirror `aria-expanded` onto its `?` buttons. */
  onChange?: (openSection: string | null, open: boolean) => void
  /** Where focus goes when the panel closes from the keyboard: the `?` of the section that was
   * open, or the first one. */
  helpButtonFor?: (sectionId: string | null) => HTMLElement | null
}

export interface DocsPanelHandle {
  open(sectionId: string | null): void
  close(refocus: boolean): void
  /** Opens `sectionId`, or closes the panel if that section is what is already open. */
  toggle(sectionId: string): void
  readonly openSection: string | null
  readonly isOpen: boolean
  dispose(): void
}

/** The kind glyphs, one per shape of control the sidebar draws. */
export const DOC_GLYPH = {
  select: '≡',
  toggle: '✓',
  number: '#',
  text: 'Aa',
  slider: '↔',
  button: '▶',
  readout: '∑',
} as const

/** Widest the panel gets: a comfortable measure for prose, and room left for the preview. */
const MAX_WIDTH_PX = 640

export function createDocsPanel(opts: DocsPanelOptions): DocsPanelHandle {
  let el: HTMLElement | null = null
  let openSection: string | null = null
  let isOpen = false

  function place(): void {
    if (el === null) return
    const rect = opts.anchor().getBoundingClientRect()
    const roomLeft = Math.max(0, rect.left)
    const style = el.style
    if (roomLeft >= 240) {
      const width = Math.min(roomLeft, MAX_WIDTH_PX)
      style.left = `${Math.round(rect.left - width)}px`
      style.width = `${Math.round(width)}px`
    } else {
      // No room beside it: over the sidebar itself, which is still the inspector's fallback.
      style.left = `${Math.round(rect.left)}px`
      style.width = `${Math.round(rect.width)}px`
    }
    style.top = `${Math.round(rect.top)}px`
    style.height = `${Math.round(rect.height)}px`
  }

  function onResize(): void {
    place()
  }

  function paragraph(text: string, className = 'fl-doc-p'): HTMLElement {
    return h('p', className, text)
  }

  function entryEl(entry: DocEntry): HTMLElement {
    const article = h('article', 'fl-doc')
    article.dataset.key = entry.name
    const head = h('div', 'fl-doc-head')
    const glyph = h('span', 'fl-doc-glyph', entry.glyph)
    glyph.setAttribute('role', 'img')
    glyph.setAttribute('aria-label', entry.kindLabel)
    glyph.title = entry.kindLabel
    head.append(glyph, h('h3', 'fl-doc-name', entry.name))
    article.append(head)
    const badges = h('div', 'fl-doc-badges')
    for (const badge of entry.badges ?? []) {
      const pill = h('span', 'fl-doc-badge', badge.label)
      pill.dataset.badge = badge.kind
      if (badge.title !== undefined) pill.title = badge.title
      badges.append(pill)
    }
    badges.append(h('span', undefined, entry.kindLabel))
    article.append(badges)
    article.append(paragraph(entry.summary))
    for (const text of entry.detail ?? []) article.append(paragraph(text))
    for (const fact of entry.facts ?? []) article.append(paragraph(fact, 'fl-doc-fact'))
    return article
  }

  function render(): void {
    if (el === null) return
    const scrollTop = el.querySelector('.fl-docs-body')?.scrollTop ?? 0
    const sections = opts.sections()
    const section = openSection === null ? undefined : sections.find((s) => s.id === openSection)
    el.replaceChildren()

    const bar = h('div', 'fl-docs-bar')
    const close = h('button', 'fl-docs-close', '✕') as HTMLButtonElement
    close.type = 'button'
    close.setAttribute('aria-label', 'Close the documentation')
    close.title = 'Close the documentation'
    close.addEventListener('click', () => handle.close(true))
    bar.append(close)
    if (section !== undefined) {
      const back = h('button', 'fl-docs-back', '‹ Back to overview') as HTMLButtonElement
      back.type = 'button'
      back.title = 'Back to the overview of every section'
      back.addEventListener('click', () => handle.open(null))
      bar.append(back)
    }
    el.append(bar)

    const body = h('div', 'fl-docs-body')
    if (section === undefined) {
      el.append(h('h2', 'fl-docs-title', opts.title))
      if (opts.subtitle !== undefined) el.append(h('p', 'fl-docs-sub', opts.subtitle))
      const list = h('div', 'fl-docs-list')
      for (const candidate of sections) {
        const item = h('button', 'fl-docs-item') as HTMLButtonElement
        item.type = 'button'
        item.setAttribute('aria-label', `Explain ${candidate.title}`)
        item.append(h('span', 'fl-docs-item-name', candidate.title))
        const count = candidate.entries.length
        item.append(h('span', 'fl-docs-item-count', `${count} ${count === 1 ? 'control' : 'controls'}`))
        item.addEventListener('click', () => handle.open(candidate.id))
        list.append(item)
      }
      body.append(list)
    } else {
      el.append(h('h2', 'fl-docs-title', section.title))
      if (opts.subtitle !== undefined) el.append(h('p', 'fl-docs-sub', opts.subtitle))
      for (const text of section.intro ?? []) body.append(paragraph(text))
      for (const entry of section.entries) body.append(entryEl(entry))
    }
    el.append(body)
    body.scrollTop = scrollTop
  }

  const handle: DocsPanelHandle = {
    get openSection() {
      return openSection
    },
    get isOpen() {
      return isOpen
    },
    open(sectionId: string | null): void {
      openSection = sectionId
      isOpen = true
      if (el === null) {
        el = h('aside', 'fl-docs')
        el.id = 'fl-docs'
        el.setAttribute('role', 'complementary')
        el.setAttribute('aria-label', 'Documentation')
        el.tabIndex = -1
        el.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          handle.close(true)
        })
        document.body.append(el)
        window.addEventListener('resize', onResize)
      }
      place()
      render()
      opts.onChange?.(openSection, true)
    },
    close(refocus: boolean): void {
      const was = openSection
      openSection = null
      isOpen = false
      if (el !== null) {
        el.remove()
        el = null
        window.removeEventListener('resize', onResize)
      }
      opts.onChange?.(null, false)
      if (refocus) opts.helpButtonFor?.(was)?.focus()
    },
    toggle(sectionId: string): void {
      if (isOpen && openSection === sectionId) handle.close(true)
      else handle.open(sectionId)
    },
    dispose(): void {
      handle.close(false)
    },
  }
  return handle
}
