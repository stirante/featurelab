// legend.ts -- the key to the drawing.
//
// Twelve glyphs and eight edge signatures ship on this canvas and, until this file, nothing
// anywhere said what any of them meant. That is not a documentation gap, it is a correctness one:
// the whole reason a category is stated as a GLYPH as well as a hue (see media/graph.css's header
// on why colour is never the only carrier) is so the distinction survives a grayscale print and a
// red/green colour deficiency -- and a glyph nobody can decode carries exactly as much as the hue
// it was added to back up. A reader who cannot tell a `sequence` edge from an `aggregate` one is
// one step from believing an unordered list runs in order, which is a silently different
// generated world.
//
// # Three decisions
//
//   - THE EDGE SAMPLES ARE DRAWN WITH THE REAL CLASSES. Each swatch is an actual `<g
//     class="flg-edge flg-edge-scatter">` holding an actual `.flg-edge-line`, so its colour, its
//     width and its dash pattern come from the same stylesheet rules the canvas uses. A legend
//     that redeclared the dashes would be a second copy of them, and the day one moved the legend
//     would start lying -- which is worse than having no legend, because it would be believed.
//   - IT IS DISMISSIBLE AND STARTS CLOSED. It answers a question somebody has once or twice and
//     then stops having; a panel permanently occupying a corner of a canvas whose whole problem
//     is density would be a cost paid forever for a benefit paid once.
//   - EVERY ROW IS A SENTENCE, not a word. "scatter -- places its child at several positions" is
//     the fact somebody opened the legend for; "scatter" alone is the label they could already
//     read off the chip.

/** One row of the category half: the glyph, what it is called, and what it means. The glyph comes
 * from render.ts's CATEGORY_MARK rather than being repeated here -- see `createLegend`. */
interface CategoryRow {
  category: string
  name: string
  meaning: string
}

const CATEGORY_ROWS: readonly CategoryRow[] = [
  { category: 'rule', name: 'Feature rule', meaning: 'Where placement starts: a biome filter and the feature it runs.' },
  { category: 'sequence', name: 'Sequence', meaning: 'Runs its children in order. The order decides the world.' },
  { category: 'aggregate', name: 'Aggregate', meaning: 'Runs all of its children. The listed order means nothing.' },
  { category: 'weighted', name: 'Weighted random', meaning: 'Picks one child, by weight.' },
  { category: 'conditional', name: 'Conditional list', meaning: 'Runs the first child whose condition holds.' },
  { category: 'scatter', name: 'Scatter', meaning: 'Places its child at several positions in the chunk.' },
  { category: 'filter', name: 'Filter', meaning: 'Runs its child only where the block conditions pass.' },
  { category: 'child', name: 'Named slot', meaning: 'A single child in a named field, not a list.' },
  { category: 'leaf', name: 'Leaf', meaning: 'Places blocks itself and delegates to nothing.' },
  { category: 'unresolved', name: 'Unresolved', meaning: 'Delegated to but never defined here. The edge into it dangles, and `is:unresolved` finds every one.' },
  { category: 'external', name: 'Provided by the game', meaning: 'A feature the game ships. It resolves; this pack does not define it.' },
]

/** The edge half. `kind` is the class suffix, so the swatch picks up the shipped dash pattern. */
interface EdgeRow {
  kind: string
  name: string
  meaning: string
}

const EDGE_ROWS: readonly EdgeRow[] = [
  { kind: 'rule', name: 'rule', meaning: 'A feature rule reaching the feature it places.' },
  { kind: 'sequence', name: 'sequence', meaning: 'Ordered. The chip carries the execution position.' },
  { kind: 'aggregate', name: 'aggregate', meaning: 'Unordered. Every child runs; the chip shows no number.' },
  { kind: 'weighted', name: 'weighted', meaning: 'One of several. The chip shows the share.' },
  { kind: 'conditional', name: 'conditional', meaning: 'Taken when its condition holds. The chip carries the Molang.' },
  { kind: 'scatter', name: 'scatter', meaning: 'Repeated placement. The chip carries the iteration count.' },
  { kind: 'filter', name: 'filter', meaning: 'Gated on the blocks already there.' },
  { kind: 'child', name: 'named slot', meaning: 'A single child in a named field. The chip names the field.' },
]

/** Marks that are about a node's STATE rather than its category, and are drawn on the card
 * itself. Listed because they are the other thing on the canvas a reader meets with no key. */
const STATE_ROWS: readonly EdgeRow[] = [
  { kind: 'dangling', name: 'faded edge', meaning: 'Points at something this pack never defines.' },
  { kind: 'external', name: 'thin edge', meaning: 'Points at a feature the game supplies.' },
  { kind: 'cycle', name: 'heavy edge', meaning: 'Part of a delegation cycle. Legal, and worth knowing about.' },
]

/** One row of the keyboard half: the chord, and what pressing it does.
 *
 * THE PANEL IS CALLED "Key" AND HAD NO KEYS IN IT. It explained twenty glyphs and eight line
 * styles -- everything the canvas SHOWS -- and said nothing about the canvas's keyboard, which by
 * now is a full one: the arrows walk the drawing, Alt+Arrow moves a card, F2 steps into a card's
 * own controls, Ctrl+Space builds a selection. Every one of those is announced on the canvas's
 * `aria-keyshortcuts` (render.ts) and therefore reachable by a screen reader and by nobody else.
 * The search box and the Add menu teach their keys where they stand; the canvas is the surface
 * that cannot, because a canvas has no chrome to write on -- so it teaches them here, in the panel
 * already named for them and already bound to `?`.
 *
 * KEPT IN STEP WITH render.ts BY TEST, not by hope: graphRender.test.ts presses these and checks
 * the chords listed here against the `aria-keyshortcuts` the canvas publishes, so a binding that
 * moves takes this table with it. */
interface KeyRow {
  keys: string
  meaning: string
}

const KEY_ROWS: readonly KeyRow[] = [
  { keys: 'Arrows', meaning: 'On a card, moves to the nearest card that way. On the background, pans the view.' },
  { keys: 'Alt+Arrow', meaning: 'Moves the focused card itself, a step at a time. Hold Shift for a longer step.' },
  { keys: 'Home / End', meaning: 'The first and the last card in reading order.' },
  { keys: 'Enter', meaning: 'Selects the focused card on its own, and opens it in the panel beside the canvas.' },
  { keys: 'Ctrl+Space', meaning: 'Adds the focused card to the selection, or takes it back out. This is how a selection is built without a mouse.' },
  { keys: 'F2', meaning: "Steps into the focused card's own controls, one per press, and wraps back to the card." },
  { keys: 'Escape', meaning: 'Drops the selection, or abandons a connection being drawn.' },
  { keys: 'Ctrl+F', meaning: 'The search box, which teaches its own filters once it is open.' },
  { keys: 'Ctrl+G', meaning: 'Groups what is selected, and names it. Ctrl+Shift+G takes a group apart again.' },
  { keys: '+ / -', meaning: 'Zooms in and out around the middle of the view.' },
  { keys: '0', meaning: 'Fit: zooms out until every card is on screen at once.' },
  { keys: '?', meaning: 'Opens and closes this panel.' },
]

/** The chords above, for the test that checks them against what the canvas publishes. */
export const LEGEND_KEYS: readonly string[] = KEY_ROWS.map((row) => row.keys)

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface Legend {
  readonly element: HTMLElement
  readonly open: boolean
  setOpen(next: boolean): void
  toggle(): void
  dispose(): void
}

export interface LegendOptions {
  /** render.ts's CATEGORY_MARK. Passed in rather than imported so this file does not close an
   * import cycle with the module that creates it, and so the glyphs cannot drift: there is one
   * table and the legend reads it. */
  marks: Readonly<Record<string, string>>
  open?: boolean
}

export function createLegend(options: LegendOptions): Legend {
  const element = document.createElement('div')
  element.className = 'flg-legend'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'flg-legend-button'
  // A WORD, not a lone question mark. The trigger sits over the drawing in the bottom-left corner,
  // and a 22px circle with one glyph in it reads as a mark ON the canvas rather than as a control
  // over it -- it was mistaken for a badge on whichever card it happened to be covering. The
  // accessible name below is unchanged and was always right; what was missing was a name anybody
  // could SEE.
  button.textContent = 'Key ?'
  button.title = 'What the glyphs and the line styles mean, and every key this canvas answers to.'
  button.setAttribute('aria-label', 'Show the key to the glyphs, the line styles and the keyboard')

  const panel = document.createElement('div')
  panel.className = 'flg-legend-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Key to the graph and its keyboard')

  const head = document.createElement('div')
  head.className = 'flg-legend-head'
  const title = document.createElement('h3')
  title.className = 'flg-legend-title'
  title.textContent = 'Key'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'flg-legend-close'
  close.textContent = '×'
  close.title = 'Dismiss the key.'
  close.setAttribute('aria-label', 'Dismiss the key')
  head.append(title, close)
  panel.append(head)

  /** THE ROWS ARE BUILT ON FIRST OPEN, not at construction.
   *
   * Two reasons, and the second is the load-bearing one. A key nobody opens should cost nothing:
   * this is forty-odd elements on a canvas whose entire performance story is how few elements are
   * in the document. And the line samples carry the REAL `.flg-edge-*` classes -- that is the
   * whole point of them (see the header) -- which means that while they exist, every selector
   * that asks the document for `.flg-edge-cycle` or `.flg-edge-dangling` finds them too. A legend
   * that quietly changed the answer to "how many dangling edges are drawn" would be a legend that
   * altered the drawing it describes. Built when asked for, and only then. */
  let built = false

  function build(): void {
    if (built) return
    built = true

    const note = document.createElement('p')
    note.className = 'flg-legend-note'
    note.textContent = 'Every colour here is also a glyph and a word, so nothing on the canvas is told by colour alone.'
    panel.append(note)

    panel.append(sectionHeading('Cards'))
    const cards = document.createElement('ul')
    cards.className = 'flg-legend-list'
    for (const row of CATEGORY_ROWS) {
      const item = document.createElement('li')
      item.className = 'flg-legend-row'
      item.dataset['category'] = row.category

      const glyph = document.createElement('span')
      glyph.className = 'flg-legend-glyph'
      glyph.textContent = options.marks[row.category] ?? '?'
      glyph.setAttribute('aria-hidden', 'true')

      const name = document.createElement('span')
      name.className = 'flg-legend-name'
      name.textContent = row.name

      const meaning = document.createElement('span')
      meaning.className = 'flg-legend-meaning'
      meaning.textContent = row.meaning

      item.append(glyph, name, meaning)
      cards.append(item)
    }
    panel.append(cards)

    panel.append(sectionHeading('Lines'))
    const lines = document.createElement('ul')
    lines.className = 'flg-legend-list'
    for (const row of EDGE_ROWS) lines.append(edgeRow(row, `flg-edge flg-edge-${row.kind}`))
    for (const row of STATE_ROWS) lines.append(edgeRow(row, `flg-edge flg-edge-rule flg-edge-${row.kind}`))
    panel.append(lines)

    // LAST, and not because it matters least. The two sections above answer "what am I looking
    // at", which is the question somebody has while the drawing is still strange; this one
    // answers "how do I move", which is the question they have forever afterwards -- and putting
    // it under the glyphs means the reader meets it on the way out of every other visit.
    panel.append(sectionHeading('Keys'))
    const keys = document.createElement('ul')
    keys.className = 'flg-legend-list'
    for (const row of KEY_ROWS) keys.append(keyRow(row))
    panel.append(keys)
  }

  element.append(button, panel)

  let open = options.open ?? false
  if (open) build()

  function apply(): void {
    element.classList.toggle('flg-legend-open', open)
    panel.hidden = !open
    button.setAttribute('aria-expanded', String(open))
  }

  function setOpen(next: boolean): void {
    if (open === next) return
    open = next
    if (open) build()
    apply()
    if (open) close.focus()
    else button.focus()
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    setOpen(!open)
  })
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    setOpen(false)
  })
  // Escape dismisses it, and does not reach the canvas behind -- one Escape, one undo, the same
  // rule the canvas's own gestures follow.
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    setOpen(false)
  })
  element.addEventListener('pointerdown', (event) => event.stopPropagation())
  element.addEventListener('wheel', (event) => event.stopPropagation())
  apply()

  return {
    element,
    get open() {
      return open
    },
    setOpen,
    toggle: () => setOpen(!open),
    dispose: () => element.remove(),
  }
}

function sectionHeading(text: string): HTMLElement {
  const heading = document.createElement('h4')
  heading.className = 'flg-legend-section'
  heading.textContent = text
  return heading
}

/** One keyboard row, in the same three-column grid the other sections use so the names line up
 * into one scannable column down the whole panel. The first cell is the mark column, and a chord
 * has no mark -- it is left empty rather than given a stand-in glyph, which would be a symbol the
 * key itself would then have to explain. */
function keyRow(row: KeyRow): HTMLElement {
  const item = document.createElement('li')
  item.className = 'flg-legend-row flg-legend-row-key'

  const spacer = document.createElement('span')
  spacer.className = 'flg-legend-glyph'
  spacer.setAttribute('aria-hidden', 'true')

  // <kbd>, because that is what this is, and because a screen reader reading the panel aloud
  // then announces "Ctrl plus Space" as a key rather than as a word.
  const name = document.createElement('kbd')
  name.className = 'flg-legend-name flg-legend-key'
  name.textContent = row.keys

  const meaning = document.createElement('span')
  meaning.className = 'flg-legend-meaning'
  meaning.textContent = row.meaning

  item.append(spacer, name, meaning)
  return item
}

/** One line sample, drawn with the SHIPPED classes so its dash, width and hue come from
 * media/graph.css and cannot drift from the canvas. */
function edgeRow(row: EdgeRow, className: string): HTMLElement {
  const item = document.createElement('li')
  item.className = 'flg-legend-row'

  const swatch = document.createElementNS(SVG_NS, 'svg')
  swatch.setAttribute('class', 'flg-legend-swatch')
  swatch.setAttribute('viewBox', '0 0 40 10')
  swatch.setAttribute('aria-hidden', 'true')
  const group = document.createElementNS(SVG_NS, 'g')
  group.setAttribute('class', className)
  const line = document.createElementNS(SVG_NS, 'path')
  line.setAttribute('class', 'flg-edge-line')
  line.setAttribute('d', 'M 1 5 L 39 5')
  group.append(line)
  swatch.append(group)

  const name = document.createElement('span')
  name.className = 'flg-legend-name'
  name.textContent = row.name

  const meaning = document.createElement('span')
  meaning.className = 'flg-legend-meaning'
  meaning.textContent = row.meaning

  item.append(swatch, name, meaning)
  return item
}
