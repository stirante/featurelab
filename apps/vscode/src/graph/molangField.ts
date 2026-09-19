// molangField.ts -- the CONTROL for one Molang expression: a text box that highlights what is in
// it, completes what you are typing, and says how the file is going to be spelled.
//
// # Why this is a module and not twenty more lines in webview/graph.ts
//
// It is DOM, so it does not belong in molangEdge.ts, which is deliberately pixel-free. It is also
// three hundred lines of caret arithmetic, layer alignment and key handling, none of which is
// about graphs -- and webview/graph.ts is the one file where every graph module meets, which is
// the worst place in the codebase for a self-contained lump of behaviour to hide. src/graph
// already holds DOM-owning siblings for exactly this reason (inspector.ts, forms.ts, search.ts,
// palette.ts, compounds/form.ts), each shipping its own stylesheet constant, and this follows
// them.
//
// # The highlighting, and the trap in it
//
// A <textarea> cannot colour its own content, so the text is painted TWICE: a <pre> behind, in
// colour, and the real textarea in front with transparent text and a visible caret. The whole
// technique lives or dies on the two layers laying text out identically -- the moment the font,
// the padding, the border width, the wrapping mode or the line height differ by a pixel, the
// caret walks away from the glyphs it is supposed to be sitting in, and a caret in the wrong
// place is worse than no colour at all.
//
// So the metrics are not COPIED between the two elements, they are SHARED: both carry
// `.flg-edge-molang`, the same class that has always styled this field, and every metric property
// is set there and nowhere else. The per-layer classes below may only set colour, position and
// paint order. A test asserts the computed metrics are equal, because a rule added to the wrong
// selector is exactly the kind of mistake that looks fine until somebody types a long line.
//
// Two smaller traps, handled the same way -- by removing the situation rather than compensating
// for it:
//
//   - A SCROLLBAR inside the textarea narrows its content box and nothing narrows the <pre>'s, so
//     the two wrap at different columns. The field therefore GROWS to fit its content and never
//     scrolls: `resize` is off and the height follows the text. The side panel scrolls instead,
//     which is where a reader expects to scroll anyway.
//   - A TRAILING NEWLINE is laid out by a textarea and collapsed by a <pre>, so the last line of
//     colour ends up one row above the caret. The ink layer always ends in a newline of its own.
//
// # The completion popup
//
// `MolangEdgeEditor.completions(offset)` has existed, tested, since the editor was written, fed
// with the variables a parent scatter writes upstream, and nothing ever called it. It is a list
// of candidates with replace ranges; everything about turning that into a popup -- when to open,
// what wins a keystroke, where the caret lands afterwards -- is here.
//
// The rule that governs all of it: THE POPUP MAY NEVER SWALLOW ORDINARY TYPING. It takes a key
// only while it is open and only for the five keys that mean something to a list (Up, Down,
// Enter, Tab, Escape); every other key, and all five while it is closed, reach the textarea
// untouched. It opens only where the caret is inside a name, so finishing a call with `)` does
// not pop a list over the next thing the author wants to read.
import {
  ITERATIONS_TEMPLATES,
  MolangEdgeEditor,
  type EdgeAction,
  type EdgeProblem,
  type EdgeProblemCode,
  type MolangCompletion,
} from './molangEdge.js'
import { highlightMolang, type MolangHighlightSpan } from './molangHints.js'

/** How many candidates the list shows at once. Beyond this it scrolls: a popup taller than the
 * panel it lives in covers the diagnostics the author is presumably reading. */
const VISIBLE_ROWS = 8


export interface MolangFieldOptions {
  /** The field's accessible name -- 'iterations' or 'condition'. */
  label: string
  /** Called after anything changes the draft text, so the surrounding panel can repaint the
   * diagnostics it owns. Never called for a change this field made to its own appearance. */
  onChanged?: () => void
  /** Called when the field has lost focus and the editor has been asked to commit. The panel owns
   * what a commit MEANS (posting to the host); this only says when. */
  onCommit?: () => void
  /** What is drawn around the text box. `full` -- the default, and the edge panel's shape -- is
   * the caption above, the "keep the line breaks" checkbox below and its one-line note. `bare`
   * is the box and its completion list and NOTHING else, for a host that draws its own label and
   * offers the format choice its own way: the node inspector, whose rows are `label | control`
   * with no prose, puts the choice in the row's mode menu and the caption in the gutter. The
   * format choice itself is still the editor's (`setKeepFormatted`), so nothing is lost -- only
   * where it is reached from. */
  chrome?: 'full' | 'bare'
  /** Fill the height the host gives the field instead of growing to the text. For a panel whose
   * whole job is this one expression -- the edge panel -- where a box sized to three lines leaves
   * most of the column empty under a setup script that needs scrolling. The host has to give the
   * field a height (a flex column that reaches the bottom of the panel); the box then takes
   * whatever is left after the caption, the format choice and the host's own diagnostics. */
  fill?: boolean
  /** Draw the editor's diagnostics -- message, long form, span and the actions each one offers --
   * under the box. Off by default only because two hosts drew their own before this existed; a
   * host that turns it on stops drawing its own, or the reader gets each problem twice.
   *
   * The actions are the reason this belongs to the control and not to a panel. `EdgeProblem`
   * has carried them since the editor was written and nothing had ever drawn one, so "this reads
   * a name nothing writes" arrived with a `Guard with ?? 0` nobody could press. */
  problems?: boolean
  /** What the last profiled run measured about THIS expression, in the run's own words -- a host
   * with a profile passes `describeStop(...).label`. Repeated here, under the field, because the
   * engine's answer to "why did this place nothing" was rendering at the top of the panel with
   * three sections between it and the box it is about, and on the edge panel -- the one place
   * with a real editor in it -- it was not rendered at all.
   *
   * A function rather than a string: the panel repaints on every keystroke and the run does not
   * change, but the host is the only thing that knows which run is current. */
  engineNote?: () => string | null
  /** Diagnostics this host has decided do not apply to the slot it is drawing.
   *
   * One caller, one code: a feature_rule's `distribution.iterations` is the same language, the
   * same idioms and the same mistakes as a scatter's -- so it wants `field: 'iterations'` and
   * everything that comes with it -- but it is OPTIONAL there, where an absent key means "this
   * rule places nothing" rather than a file that will not load. `empty-required` is phrased for
   * the scatter and is simply untrue of the rule. */
  suppress?: readonly EdgeProblemCode[]
  /** The box, its diagnostics, the mode word and the stepper -- and none of the rest: no template
   * menu, no "Back to N", no "the file will get" line.
   *
   * For a slot that is one of SEVERAL on a row -- both ends of a scatter axis's `extent`, drawn
   * as chips on one line in a 320px column. Those ends are Molang by the same rules as anything
   * else here and were accepting `}{` in silence, which is what this is for; they are also two
   * numbers side by side in the narrowest column on screen, and four rows of adornment over two
   * two-character values is a panel nobody can read.
   *
   * What it keeps is chosen by what the reader cannot otherwise get at this size. The diagnostics
   * stay, because being told the file will not load is the entire reason the control changed. The
   * MODE stays, because `15` and `query.noise(1, 2)` are different things to be looking at and
   * this was the only slot left where they looked identical -- and the stepper with it, because a
   * number you cannot nudge here while you can nudge the same number one row up is the same
   * inconsistency in a second form. The three that go are the three that are wide: the template
   * menu is an `iterations` idiom an extent end has no use for, "Back to 12" is a button as wide
   * as the chip it sits in, and the write line is a sentence. */
  compact?: boolean
  /** Whether the panel around this control is in the middle of being taken out of the document
   * and put back. Consulted on blur, and only there. See the long note in `onBlur`: a host that
   * empties its sidebar to redraw it blurs whatever the author was typing in, and that blur is
   * the document changing rather than anybody deciding anything -- so it must not write the file.
   *
   * Left out, every blur counts as a decision, which is right for a host that never reparents
   * this control (the edge panel is repainted in place and never rebuilt). */
  hostRedrawing?: () => boolean
  /** What an EMPTY box shows: the documented default for the key, the way every other unset row
   * in the node inspector shows one. Needed because this control replaced plain inputs that had
   * one, and a slot whose absent value means something specific ("100 -- always scatters") loses
   * that the moment the box goes blank. */
  placeholder?: string
}

export interface MolangField {
  /** The whole control -- label, text box, ink layer, popup, checkbox. */
  readonly element: HTMLElement
  /** The textarea itself, for a caller that needs to focus it. */
  readonly input: HTMLTextAreaElement
  /** Re-reads the editor and repaints. Safe to call at any time; it leaves the caret alone unless
   * the text itself changed underneath it. */
  refresh(): void
  dispose(): void
}

/** True when the caret sits inside, or immediately after, a name -- the only place a completion
 * list is wanted.
 *
 * The alternative (open whenever the text changed) pops a list over the panel after every `)` and
 * every `,`, which is the behaviour people turn completion off to escape. */
function insideAName(source: string, offset: number): boolean {
  const before = source[offset - 1]
  if (before === undefined) return false
  return /[A-Za-z0-9_.]/.test(before)
}

/** One element with a class and some text. Every string that reaches the page goes through
 * `textContent`, never `innerHTML`: catalogue prose, completion labels and the author's own
 * expression all end up here, and the last of those is text a person typed. */
function withText(tag: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function button(className: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.textContent = text
  el.title = title
  el.setAttribute('aria-label', title)
  // mousedown is deliberately NOT prevented here the way it is on a completion row: these
  // buttons change the text and the author is done with the box, so letting blur commit first is
  // the right order. The one exception is the stepper, which is a repeated press -- see below.
  el.addEventListener('click', onClick)
  return el
}

/**
 * One diagnostic, drawn whole: the line, the long form when there is one, and a button for every
 * action it offers.
 *
 * Exported because two panels draw this list and a second spelling of it is how the same problem
 * comes to read differently depending on where you are standing. See MolangFieldOptions.problems.
 */
export function renderMolangProblem(
  problem: EdgeProblem,
  onAction: (action: EdgeAction) => void,
  onReveal?: (span: { offset: number; length: number }) => void,
): HTMLElement {
  const box = document.createElement('div')
  box.className = `flg-molang-problem flg-molang-problem-${problem.severity}`
  // The severity is a WORD as well as a colour. Three levels distinguished by hue alone are
  // three identical boxes to a reader who cannot name the hue, and to a screenshot.
  box.setAttribute('role', problem.severity === 'error' ? 'alert' : 'status')
  const head = document.createElement('div')
  head.className = 'flg-molang-problem-head'
  head.append(withText('span', 'flg-molang-problem-mark', problem.severity === 'error' ? 'Error: ' : problem.severity === 'warning' ? 'Warning: ' : ''))
  head.append(document.createTextNode(problem.message))
  box.append(head)
  // THE LONG FORM IS FOLDED. `detail` is a paragraph -- the engine's own explanation of an
  // unresolved read, the whole argument about why a zero at one origin is not a dead branch --
  // and this panel is the narrowest column on screen. Drawn open it is the wall of text the
  // sidebar was rebuilt to get rid of; not drawn at all is where it has been since it was
  // written. `<details>` is the answer with no state to keep and no script to run: collapsed by
  // default, announced as a disclosure, opened by the reader who wants it.
  if (problem.detail !== undefined && problem.detail !== '') {
    const more = document.createElement('details')
    more.className = 'flg-molang-problem-more'
    more.append(withText('summary', 'flg-molang-problem-why', 'Why this matters'))
    more.append(withText('div', 'flg-molang-problem-detail', problem.detail))
    box.append(more)
  }
  const actions = problem.actions ?? []
  // AN ACTION ABOUT THE DRAFT MAY NOT BE PRECEDED BY A COMMIT OF IT.
  //
  // `button` below deliberately lets blur happen first, because for most of these the author is
  // done with the box and saving what they typed is the right order. It is exactly wrong for the
  // conflict: with the caret still in the box -- which is where a redraw puts it back -- the
  // mousedown blurred the field, the blur committed the draft, and only then did the click
  // arrive. "Use the file's version" therefore wrote the draft to the file and then "reverted"
  // to it, so the button did the precise opposite of what it says; "Keep mine" wrote without
  // being asked; and "Show the JSON", which changes nothing at all, wrote too.
  //
  // So a problem that offers a choice BETWEEN the draft and the file keeps the keyboard where it
  // is until the choice has been made. Detected from the actions rather than from the code,
  // because it is the actions that are about the draft.
  const decidesDraft = actions.some((action) => action.kind === 'take-file-value' || action.kind === 'keep-draft')
  const actionButton = (action: EdgeAction): HTMLButtonElement => {
    const el = button('flg-molang-action', action.label, action.label, () => onAction(action))
    if (decidesDraft) el.addEventListener('mousedown', (event) => event.preventDefault())
    return el
  }
  // `span` -- which characters the problem is ABOUT -- has been on every diagnostic since the
  // editor was written and had never been drawn, so "this call takes 2 arguments" arrived with
  // no indication of which of the three calls on screen it meant. Shown by SELECTING the range
  // in the box rather than by painting a second mark over the two layers that are already there:
  // the selection is the browser's own, it survives scrolling and wrapping for free, and it
  // leaves the caret where the author would want to start typing the fix.
  if (problem.span !== undefined && onReveal !== undefined) {
    const span = problem.span
    const row = document.createElement('div')
    row.className = 'flg-molang-problem-actions'
    const show = button('flg-molang-action', 'Show me where', 'Show me where: select the part of the expression this problem is about.', () => onReveal(span))
    // mousedown prevented, for the reason the completion rows prevent it: a click on a control
    // outside the box blurs the box first, and blur here commits and re-lays-out the text -- so
    // by the time the click arrived, the offsets this button is holding were offsets into a
    // string that had moved.
    show.addEventListener('mousedown', (event) => event.preventDefault())
    row.append(show)
    for (const action of actions) row.append(actionButton(action))
    box.append(row)
    return box
  }
  if (actions.length > 0) {
    const row = document.createElement('div')
    row.className = 'flg-molang-problem-actions'
    for (const action of actions) row.append(actionButton(action))
    box.append(row)
  }
  return box
}

export function createMolangField(editor: MolangEdgeEditor, options: MolangFieldOptions): MolangField {
  const element = document.createElement('div')
  element.className = 'flg-molang-field'
  const bare = options.chrome === 'bare'
  const fill = options.fill === true
  if (fill) element.classList.add('flg-molang-fill')

  if (!bare) element.append(withText('div', 'flg-molang-caption', options.label))

  const stack = document.createElement('div')
  stack.className = 'flg-molang-stack'
  element.append(stack)

  // The order of these two in the DOM is the paint order, and the textarea has to be second so
  // its caret and its selection draw over the colour rather than under it.
  const ink = document.createElement('pre')
  ink.className = 'flg-edge-molang flg-molang-ink'
  ink.setAttribute('aria-hidden', 'true')

  const input = document.createElement('textarea')
  input.className = 'flg-edge-molang flg-molang-input'
  input.rows = 3
  input.spellcheck = false
  input.setAttribute('aria-label', options.label)
  // A text box with a list attached is a combobox, and aria-expanded is only meaningful on one.
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocorrect', 'off')
  // Needs its own colour: this textarea paints its text transparent so the ink layer behind can
  // show through, and a placeholder inherits that unless the stylesheet says otherwise.
  if (options.placeholder !== undefined) input.placeholder = options.placeholder

  const popup = document.createElement('ul')
  popup.className = 'flg-molang-popup'
  popup.setAttribute('role', 'listbox')
  popup.hidden = true

  stack.append(ink, input, popup)

  // -- what is IN the box, and what can be done about it ---------------------
  //
  // THE TWO MODES. `iterations` is a text field and always will be -- see molangEdge.ts's header
  // on why a spin-box can express one of the three idioms real packs use it for -- but "a count"
  // and "an expression" are still different things to be looking at, and `14` and
  // `math.random(1, 4)` were rendered identically, in the same box, with nothing anywhere saying
  // which one you had. So the mode is STATED, in a word, and each mode brings the help that only
  // makes sense in it: a count gets the up/down the editor has always computed (`view.stepper`),
  // an expression gets the seeds for the two idioms nobody guesses (ITERATIONS_TEMPLATES) and a
  // way back to a plain number.
  //
  // Below the box rather than above it, for the reason the format choice is: the textarea stays
  // the first editable thing in the panel, which is where a keyboard lands.
  const adorn = document.createElement('div')
  adorn.className = 'flg-molang-adorn'
  const mode = withText('span', 'flg-molang-mode', '')
  const steppers = document.createElement('span')
  steppers.className = 'flg-molang-stepper'
  const templates = document.createElement('select')
  templates.className = 'flg-molang-templates'
  templates.setAttribute('aria-label', 'Insert a pattern')
  const templateHead = document.createElement('option')
  templateHead.value = ''
  templateHead.textContent = 'Insert a pattern…'
  templates.append(templateHead)
  for (const template of ITERATIONS_TEMPLATES) {
    const option = document.createElement('option')
    option.value = template.id
    option.textContent = template.label
    // Backticks stripped: `title` is handed to the browser as plain text and this editor's rule
    // is that nothing hands Markdown to a native tooltip. The catalogue writes its prose in
    // Markdown because it is also rendered as such elsewhere.
    option.title = template.doc.replace(/`/g, '')
    templates.append(option)
  }
  const toNumber = button('flg-molang-tonumber', 'Use a plain number', '', () => {
    if (!editor.useNumber()) return
    paint()
    options.onChanged?.()
    input.focus()
  })
  const compact = options.compact === true
  // THE MODE IS NOT AN ADORNMENT. `compact` used to drop this row whole, and an `extent` end --
  // drawn in compact chrome, and one of the commonest places in the panel that a person types a
  // number -- became the ONE slot where `15` and `query.noise(1, 2)` looked alike: same box, same
  // two layers, nothing anywhere saying which of the two you had and no way to nudge the one that
  // is a number. That is the inconsistency the mode word was introduced to remove, reintroduced
  // one row lower down.
  //
  // So compact keeps the two things that ARE the distinction -- the word and the stepper -- and
  // still leaves out the three that made four rows of chrome over a two-character value: the
  // `iterations` template menu (which an extent end has no use for), the "Back to N" button
  // (whose label is as wide as the chip) and the "the file will get" line. One short row, not
  // four. See MolangFieldOptions.compact.
  if (compact) {
    adorn.classList.add('flg-molang-adorn-compact')
    adorn.append(mode, steppers)
  } else {
    adorn.append(mode, steppers, templates, toNumber)
  }
  element.append(adorn)

  /** Nudges a bare count. Only ever reachable while `view.stepper` is non-null, i.e. while the
   * text IS the number -- so this can never be a lossy view of something else. */
  function nudge(delta: number): void {
    const stepper = editor.view().stepper
    if (stepper === null) return
    // Clamped to whatever the SLOT said it accepts, and to nothing when it said nothing -- an
    // `extent` end is routinely negative and a floor of 0 there would refuse to move. Rounded to
    // the step's own precision because 0.1 + 0.2 is not 0.3 in binary, and a nudge that writes
    // 0.30000000000000004 into somebody's pack is a worse bug than the one it was fixing.
    const raw = stepper.value + delta * stepper.step
    const decimals = (String(stepper.step).split('.')[1] ?? '').length
    const rounded = decimals === 0 ? raw : Number(raw.toFixed(decimals))
    const floored = stepper.min === undefined ? rounded : Math.max(stepper.min, rounded)
    const next = stepper.max === undefined ? floored : Math.min(stepper.max, floored)
    editor.setText(String(next))
    paint()
    options.onChanged?.()
  }
  const down = button('flg-molang-step', '−', 'One fewer', () => nudge(-1))
  const up = button('flg-molang-step', '+', 'One more', () => nudge(1))
  // The stepper is the one pair of buttons that must NOT let blur happen first: it is pressed
  // repeatedly, and a commit (and the pack reload behind it) between every press would be a
  // round trip per click.
  for (const el of [down, up]) el.addEventListener('mousedown', (event) => event.preventDefault())
  steppers.append(down, up)

  templates.addEventListener('change', () => {
    const picked = templates.value
    templates.value = ''
    if (picked === '') return
    if (!editor.insertTemplate(picked as 'condition' | 'setup')) return
    paint()
    options.onChanged?.()
    input.focus()
  })

  // -- what the file is going to receive, and whether it has yet -------------
  //
  // `writeValue` -- the exact bytes a commit would put in the JSON -- has been on the view since
  // the editor was written so that a renderer could show the author their file instead of asking
  // them to trust it, and nothing ever read it. The note beside the box said "the file gets one
  // compact line" and left the reader to imagine which one.
  const writeLine = document.createElement('div')
  writeLine.className = 'flg-molang-write'
  if (!compact) element.append(writeLine)

  // -- what the engine measured about THIS expression ------------------------
  const engineLine = document.createElement('div')
  engineLine.className = 'flg-molang-engine'
  element.append(engineLine)

  // -- the format choice ----------------------------------------------------
  //
  // Below the box, not above it: it is a statement about what happens to the text, and a control
  // that comes first reads as something you have to decide before you may type. Placing it after
  // the textarea also keeps the textarea the first editable control in the panel, which is where
  // a keyboard lands and what anything looking for "the field" will find.
  const keepRow = document.createElement('label')
  keepRow.className = 'flg-molang-keep'
  const keep = document.createElement('input')
  keep.type = 'checkbox'
  keepRow.append(keep, withText('span', 'flg-molang-keep-text', 'Keep the line breaks in the file'))

  const keepNote = withText('div', 'flg-molang-note', '')
  // Under `bare` neither reaches the DOM; `keep` still tracks the editor's choice so a host
  // reading it gets the truth, and the listener below is never wired.
  if (!bare) element.append(keepRow, keepNote)

  // -- the diagnostics, when this field owns them ---------------------------
  const problemList = document.createElement('div')
  problemList.className = 'flg-molang-problems'
  /** The signature of the list currently drawn -- see the rebuild guard in paint(). */
  let problemsDrawn: string | null = null
  const suppressedLine = withText('div', 'flg-molang-suppressed', '')
  if (options.problems === true) element.append(problemList, suppressedLine)

  // -- painting -------------------------------------------------------------

  function paintInk(text: string): void {
    const spans: MolangHighlightSpan[] = highlightMolang(text, { field: editor.view().field })
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const span of spans) {
      if (span.offset > cursor) fragment.append(document.createTextNode(text.slice(cursor, span.offset)))
      const piece = document.createElement('span')
      piece.className = `flg-mo-${span.kind}`
      piece.textContent = text.slice(span.offset, span.offset + span.length)
      fragment.append(piece)
      cursor = span.offset + span.length
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)))
    // A textarea lays out the empty line after a trailing newline; a <pre> does not. Without this
    // the ink is one row short and every caret on the last line sits below its own glyphs.
    fragment.append(document.createTextNode('\n'))
    ink.replaceChildren(fragment)
  }

  /** Grows the box to its content, up to the ceiling the stylesheet sets, and scrolls past it.
   *
   * Growing is what keeps a short expression from sitting in a three-row well with a scrollbar
   * for two lines of text. The ceiling is what keeps a long one -- a setup script is routinely a
   * dozen statements -- from becoming the whole sidebar and pushing the diagnostics, the
   * checkbox and everything else off the bottom.
   *
   * Both layers are sized here rather than only the textarea. They are two boxes holding the same
   * text in the same metrics, and every alignment bug this field has had came from changing one
   * of them and not the other. */
  function fitHeight(): void {
    // `fill` USED TO MEAN "take the whole column", and it took it whether or not there was
    // anything to put in it: a two-character `14` was given a 276x484 box in a 696px panel,
    // which is most of the sidebar spent on two glyphs and the diagnostics pushed under the
    // fold. What the request behind `fill` actually was -- "a setup script should not scroll
    // inside a three-line well while the column below it is empty" -- is satisfied by growing to
    // the CONTENT from a three-row floor and letting the stylesheet's ceiling take over past
    // that. So the measurement below is the same in both modes now, and `fill` only changes
    // which ceiling applies (see .flg-molang-fill in the stylesheet).
    const styles = getComputedStyle(input)
    const borders = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth)
    input.style.height = '0px'
    input.style.height = `${input.scrollHeight + borders}px`
    // The browser has already clamped to max-height by now, so this reads the painted height
    // rather than the wanted one -- which is exactly what the ink layer has to match.
    ink.style.height = `${input.getBoundingClientRect().height}px`
  }

  function syncScroll(): void {
    ink.scrollTop = input.scrollTop
    ink.scrollLeft = input.scrollLeft
  }

  function paint(): void {
    const view = editor.view()
    // Assigned only when it actually differs: writing a textarea's own value back into it moves
    // the caret to the end, and `paint` runs on every repaint of the surrounding panel.
    if (input.value !== view.text) input.value = view.text
    paintInk(input.value)
    fitHeight()
    syncScroll()
    keep.checked = view.keepFormatted
    keepNote.textContent = view.formattable
      ? view.keepFormatted
        ? 'The file will keep this layout.'
        : 'The file gets one compact line; this box shows it laid out.'
      : 'This expression is left exactly as written -- it is not something this editor can lay out.'

    // -- the mode, and the help that belongs to it --------------------------
    const isNumber = view.stepper !== null
    const isIterations = view.field === 'iterations'
    element.dataset['mode'] = isNumber ? 'number' : 'expression'
    element.dataset['dirty'] = view.dirty ? 'yes' : 'no'
    mode.textContent = isNumber ? 'number' : view.text.trim() === '' ? 'empty' : 'expression'
    // "count" belongs to `iterations` and to nothing else. A width_modifier is not a count and a
    // scatter_chance is not a count, and the mode is offered on all of them now -- see
    // MolangEdgeView.stepper on why the mode is read off the text rather than off the key.
    const noun = isIterations ? 'count' : 'number'
    mode.title = isNumber
      ? `A plain ${noun}. Type an operator, a query or a variable and this becomes an expression -- ` +
        'the box is the same box either way.'
      : 'A Molang expression, evaluated once per run. It can count, it can gate on a test, and it ' +
        'can set variables the placed feature reads.'
    steppers.hidden = !isNumber
    // The two non-obvious idioms are an `iterations` thing; a condition has one job.
    templates.hidden = isNumber || !isIterations
    toNumber.hidden = isNumber || view.lastNumber === null
    if (!toNumber.hidden) {
      const back = String(view.lastNumber)
      toNumber.textContent = `Back to ${back}`
      const title = `Replace this expression with the ${noun} ${back}. Escape puts the expression back.`
      toNumber.title = title
      toNumber.setAttribute('aria-label', title)
    }

    // -- what the file is going to receive ----------------------------------
    //
    // Only when it would differ from what is on screen, or when there is an edit waiting to be
    // written. A line repeating the box back to the reader, on every field, is furniture.
    const differs = view.writeValue !== view.text
    if (view.dirty) {
      writeLine.textContent = differs
        ? `Not saved yet. The file will get: ${view.writeValue}`
        : 'Not saved yet. Tab or click away to save it; Escape puts back what the file holds.'
      writeLine.title = differs ? view.writeValue : ''
      writeLine.hidden = false
    } else if (differs && view.text.trim() !== '') {
      writeLine.textContent = `The file holds: ${view.writeValue}`
      writeLine.title = view.writeValue
      writeLine.hidden = false
    } else {
      writeLine.textContent = ''
      writeLine.hidden = true
    }

    // -- what the engine said -----------------------------------------------
    //
    // The editor's own evaluation first when there is one, then whatever the host's last
    // profiled run measured about this very key. Two different questions -- "what does this come
    // out as at the preview origin" and "what did the run that just finished do" -- and the
    // second is the one that exists today, because nothing wires a validator.
    const lines: string[] = []
    if (view.evaluation !== null) lines.push(view.evaluation.summary)
    const measured = options.engineNote?.() ?? null
    if (measured !== null && measured !== '') lines.push(measured)
    engineLine.textContent = lines.join(' · ')
    engineLine.hidden = lines.length === 0

    // -- the diagnostics ----------------------------------------------------
    //
    // A silenced check is not the same as no check. An author who wrote
    // `@featurelab:ignore inactive-branch` a month ago is owed a muted line saying so, or the
    // panel is quietly lying about how much it looked at.
    suppressedLine.textContent =
      view.suppressed.length === 0
        ? ''
        : `${view.suppressed.length} check${view.suppressed.length === 1 ? '' : 's'} silenced here by @featurelab:ignore (${view.suppressed.join(', ')}).`
    suppressedLine.hidden = view.suppressed.length === 0
    if (options.problems !== true) return
    const shown = view.problems.filter((problem) => !(options.suppress ?? []).includes(problem.code))
    // Rebuilt only when the LIST changed, not on every keystroke. `paint` runs per character
    // now, and a rebuild throws away state the DOM is holding on the reader's behalf: an opened
    // "Why this matters" disclosure would fold itself back up under their hands.
    const signature = JSON.stringify(shown.map((p) => [p.code, p.severity, p.message]))
    if (signature === problemsDrawn) return
    problemsDrawn = signature
    problemList.replaceChildren(
      ...shown.map((problem) =>
        renderMolangProblem(
          problem,
          (action) => {
            editor.invokeAction(action)
            paint()
            options.onChanged?.()
          },
          (span) => {
            input.focus()
            input.setSelectionRange(span.offset, Math.min(span.offset + span.length, input.value.length))
            syncScroll()
          },
        ),
      ),
    )
  }

  // -- completion -----------------------------------------------------------

  let candidates: MolangCompletion[] = []
  let active = 0

  function closePopup(): void {
    if (popup.hidden) return
    popup.hidden = true
    popup.replaceChildren()
    candidates = []
    input.removeAttribute('aria-activedescendant')
    input.setAttribute('aria-expanded', 'false')
  }

  function renderPopup(): void {
    popup.replaceChildren()
    candidates.forEach((candidate, index) => {
      const row = document.createElement('li')
      row.className = index === active ? 'flg-molang-option flg-molang-option-active' : 'flg-molang-option'
      row.id = `flg-molang-option-${index}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', index === active ? 'true' : 'false')
      const head = document.createElement('div')
      head.className = 'flg-molang-option-head'
      head.append(withText('span', `flg-molang-option-label flg-mo-${candidate.kind}`, candidate.label))
      if (candidate.detail !== '') head.append(withText('span', 'flg-molang-option-detail', candidate.detail))
      row.append(head)
      // The prose is the reason this list is worth having: the catalogue carries a real paragraph
      // per name -- what a query answers, whether a variable is even set here -- and a list of
      // bare identifiers would teach nobody anything. Only the active row shows it, because eight
      // paragraphs at once is a wall.
      if (index === active && candidate.documentation !== '') {
        row.append(withText('div', 'flg-molang-option-doc', candidate.documentation))
      }
      // mousedown, not click: click arrives after blur, and blur closes the popup and commits.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        active = index
        accept()
      })
      popup.append(row)
    })
    input.setAttribute('aria-expanded', 'true')
    const current = popup.children[active]
    if (current !== undefined) {
      input.setAttribute('aria-activedescendant', current.id)
      ;(current as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  }

  function openPopup(force: boolean): void {
    const offset = input.selectionStart ?? input.value.length
    // A selection is not a caret, and completing over one would delete text the author is looking
    // at rather than text they were typing.
    if (input.selectionStart !== input.selectionEnd) return closePopup()
    if (!force && !insideAName(input.value, offset)) return closePopup()
    const found = editor.completions(offset)
    if (found.length === 0) return closePopup()
    candidates = found
    active = 0
    popup.hidden = false
    renderPopup()
    placePopup(offset)
  }

  /** Under the caret's line, for a filling box. Below the whole box -- where the list goes when
   * the box is its text's height -- is off the bottom of the panel once the box reaches it.
   *
   * The caret is found in the INK layer, not the textarea: a textarea has no way to ask where a
   * character is, and the ink holds the same text wrapped in the same metrics, already scrolled
   * to match. */
  function placePopup(offset: number): void {
    // Wanted in BOTH modes now, not only the filling one. The reason it was gated on `fill` was
    // that a box sized to its text is short enough for "below the whole box" to be right -- which
    // stopped being true for the inspector the moment a setup script grew one there too. It
    // degrades to the stylesheet's `top: 100%` whenever the caret cannot be located.
    let remaining = offset
    const walker = document.createTreeWalker(ink, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    while (node !== null && remaining > node.data.length) {
      remaining -= node.data.length
      node = walker.nextNode() as Text | null
    }
    if (node === null) {
      popup.style.top = ''
      return
    }
    const range = document.createRange()
    range.setStart(node, Math.min(remaining, node.data.length))
    range.collapse(true)
    const caret = range.getClientRects()[0] ?? range.getBoundingClientRect()
    const box = stack.getBoundingClientRect()
    const below = caret.bottom - box.top + 2
    // Flip above the line when the list would run out of the box.
    const height = popup.getBoundingClientRect().height
    const top = below + height > box.height && caret.top - box.top - height - 2 >= 0 ? caret.top - box.top - height - 2 : below
    popup.style.top = `${Math.max(0, top)}px`
  }

  function move(delta: number): void {
    if (candidates.length === 0) return
    active = (active + delta + candidates.length) % candidates.length
    renderPopup()
  }

  /** Puts the active candidate in the text, replacing exactly the range the candidate named.
   *
   * The range comes from the completion and is NOT recomputed here: `replaceOffset` /
   * `replaceLength` are how molangHints says "keep the namespace spelling this author was already
   * using and change only the member", and a caller that re-derived the range from the caret
   * would quietly undo that. */
  function accept(): void {
    const candidate = candidates[active]
    if (candidate === undefined) return
    const text = input.value
    const before = text.slice(0, candidate.replaceOffset)
    const after = text.slice(candidate.replaceOffset + candidate.replaceLength)
    const next = before + candidate.insertText + after
    const caret = before.length + candidate.insertText.length
    input.value = next
    input.setSelectionRange(caret, caret)
    editor.setText(next)
    closePopup()
    paintInk(next)
    fitHeight()
    options.onChanged?.()
  }

  // -- events ---------------------------------------------------------------

  const onInput = (): void => {
    editor.setText(input.value)
    // The WHOLE control, not only the ink. It used to repaint the coloured layer and the height
    // and nothing else, which was right while the box was the only thing this control drew --
    // and wrong the moment it also drew the mode, the stepper, what the file is going to get and
    // the diagnostics: every one of those described the text as it had been when the panel was
    // last rebuilt. paint() assigns the textarea's value only when it actually differs, so this
    // cannot move the caret.
    paint()
    openPopup(false)
    options.onChanged?.()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
      event.preventDefault()
      openPopup(true)
      return
    }
    // ESCAPE, AND THE ORDER OF ITS TWO MEANINGS.
    //
    // With the list open it closes the list and does nothing else -- that is the promise the
    // header makes, and it is what lets somebody dismiss a popup without losing their place.
    // With the list closed it ABANDONS THE EDIT, which is the gesture this box had no spelling
    // for at all: Tab commits, clicking away commits, selecting another node commits, and
    // Escape did nothing, leaving the text on screen, uncommitted and unmarked.
    //
    // Both in ONE handler. They were briefly two listeners on the same element, and that is a
    // trap: stopPropagation does not stop a second listener on the SAME target, so the first
    // closed the popup and the second immediately saw a closed popup and reverted. Pressing
    // Escape to dismiss a completion list threw the edit away.
    if (event.key === 'Escape') {
      if (!popup.hidden) {
        event.preventDefault()
        event.stopPropagation()
        closePopup()
        return
      }
      // Nothing to abandon: let Escape go on meaning whatever it means in the panel around this
      // box -- clearing the selection, closing a gesture.
      if (!editor.revert()) return
      event.preventDefault()
      event.stopPropagation()
      paint()
      options.onChanged?.()
      return
    }
    // EVERY branch below is guarded on the popup being open. While it is closed this listener
    // does nothing at all, which is the promise the header makes: Tab and Enter go on meaning
    // what they mean in a text box.
    if (popup.hidden) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        return
      case 'Enter':
      case 'Tab':
        event.preventDefault()
        // stopPropagation as well: Tab would otherwise also be the graph's own focus move, and
        // accepting a completion would send the author to the next control.
        event.stopPropagation()
        accept()
        return
      default:
        return
    }
  }

  const onBlur = (): void => {
    closePopup()
    // A BLUR IS NOT ALWAYS A DECISION, AND ONLY A DECISION MAY WRITE THE FILE.
    //
    // Committing on blur is right for the gestures that mean "I am done here" -- Tab, a click
    // elsewhere, selecting another node. It is wrong for the blur a REDRAW causes, and the node
    // inspector causes one on every graph: the host empties the sidebar (`sideHost.replaceChildren()`
    // in webview/graph.ts) and Chromium fires this handler, synchronously, from inside that call.
    //
    // What that cost, measured on the real bundle: with a draft in the box and the file changed
    // underneath it, the redraw that carried the new value ALSO fired this handler, which wrote
    // the draft straight over the value that had just arrived -- no gesture, no warning. And
    // because a commit leaves the editor clean, the `reseed` that followed a few lines later
    // found nothing left to protect, adopted the file's value in silence, and the conflict that
    // is the entire point of reseed was never raised. The box then showed the author's text over
    // an editor holding the file's, which is the worst of the three possible states.
    //
    // The edge panel never hit this because it is repainted in place and never reparented; that
    // is why one of the two Molang paths had the conflict and the other did not.
    //
    // `isConnected` catches a detach that has already happened; `hostRedrawing` is the host
    // saying it is about to do one, which is the case that actually fires here -- the element is
    // still linked at the instant Chromium dispatches the blur.
    if (!input.isConnected || options.hostRedrawing?.() === true) return
    // Commit BEFORE reformatting. The two are independent -- the file receives the same bytes
    // either way, since the spelling that reaches it is derived from the draft rather than copied
    // from it -- but committing first means a failure to lay the text out cannot cost the author
    // their edit.
    const committed = editor.view().dirty && editor.commit()
    if (committed) options.onCommit?.()
    const relaid = editor.reformat()
    // Repainted after a COMMIT as well as after a relayout. The commit is what makes the box
    // clean, and the "not saved yet" mark is drawn from that -- so a commit that happened to
    // leave the text exactly as it was left the mark on a box with nothing unsaved in it.
    if (committed || relaid) {
      paint()
      options.onChanged?.()
    }
  }

  const onScroll = (): void => syncScroll()

  const onKeepChange = (): void => {
    editor.setKeepFormatted(keep.checked)
    paint()
    options.onChanged?.()
  }

  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKeyDown)
  input.addEventListener('blur', onBlur)
  input.addEventListener('scroll', onScroll)
  // No listener on click. Moving the caret into the middle of a name is not a request for a list
  // of names -- it is somebody about to read or select something, and a popup covering the panel
  // is in the way. The list appears while TYPING, and on Ctrl+Space for somebody who wants it.
  if (!bare) keep.addEventListener('change', onKeepChange)

  paint()

  return {
    element,
    input,
    refresh: paint,
    dispose: () => {
      closePopup()
      input.removeEventListener('input', onInput)
      input.removeEventListener('keydown', onKeyDown)
      input.removeEventListener('blur', onBlur)
      input.removeEventListener('scroll', onScroll)
      keep.removeEventListener('change', onKeepChange)
    },
  }
}

/**
 * The field's styles.
 *
 * READ THE METRIC RULE BEFORE ADDING ANYTHING HERE. `.flg-edge-molang` -- which both the textarea
 * and the ink layer carry -- owns every property that affects where a glyph lands: the font, its
 * size and weight, letter-spacing, word-spacing, tab-size, line-height, padding, border width,
 * box-sizing, and the wrapping mode. `.flg-molang-input` and `.flg-molang-ink` may set colour,
 * position, paint order and nothing else. A metric set on one of those two is a caret that drifts
 * from its glyphs, silently, on some text nobody tried.
 *
 * The palette is entirely VS Code theme variables, so the field reads in a light theme and a dark
 * one without knowing which it is in. Every one has a fallback, because a variable the running
 * theme does not define resolves to nothing and takes the whole declaration with it.
 */
export const MOLANG_FIELD_STYLESHEET = `
  .flg-molang-field { display: flex; flex-direction: column; gap: 4px; }
  .flg-molang-caption { font-size: 0.9em; opacity: 0.9; }
  .flg-molang-stack { position: relative; }

  /* A FILLING HOST RAISES THE CEILING; it does not raise the floor.
     The box grows to its text from three rows (the floor on the shared class below) and stops at
     a ceiling. In a panel whose whole job is this one expression, that ceiling can be most of the
     column -- a real setup script is a dozen statements and there is nothing else competing for
     the space. What it must NOT do is take the column when there is nothing to put in it: a
     two-character count in a 484px box was most of the sidebar spent on two glyphs, with the
     diagnostics under the fold. flex: 0 1 auto is the whole difference. */
  .flg-molang-fill { flex: 0 1 auto; min-height: 0; }
  .flg-molang-fill .flg-molang-stack { min-height: 0; }
  .flg-molang-fill .flg-edge-molang { max-height: 65vh; }

  /* ---- the mode, and the help that belongs to it -------------------------------- */
  .flg-molang-adorn { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
  .flg-molang-mode {
    font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em;
    padding: 0 5px; border-radius: 8px; flex: 0 0 auto; cursor: help;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
    color: var(--vscode-descriptionForeground, inherit);
  }
  /* The two modes differ in a WORD first -- see paint() -- and in colour second, so the
     difference survives a screenshot, a high-contrast theme and a reader who cannot name a hue. */
  .flg-molang-field[data-mode='number'] .flg-molang-mode {
    border-color: var(--vscode-debugTokenExpression-number, #b5cea8);
    color: var(--vscode-debugTokenExpression-number, #b5cea8);
  }
  .flg-molang-field[data-mode='expression'] .flg-molang-mode {
    border-color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
    color: var(--vscode-symbolIcon-functionForeground, #dcdcaa);
  }
  /* THE SAME ROW, SIZED FOR A CHIP. Two extent ends share one 320px column, so the compact
     adornment is the mode and the stepper and nothing else (see createMolangField), shrunk to
     what fits beside a sibling and allowed to wrap rather than push the chip wider than its
     share. Everything about it is the full-size row's, only smaller: the same word, the same two
     colours, the same buttons -- a second spelling of the mode is how one slot comes to read
     differently from the one above it, which is the fault this exists to fix. */
  .flg-molang-adorn-compact { gap: 3px; margin-top: 2px; }
  .flg-molang-adorn-compact .flg-molang-mode { font-size: 0.7em; padding: 0 4px; letter-spacing: 0; }
  .flg-molang-adorn-compact .flg-molang-step { min-width: 16px; padding: 0 3px; font-size: 0.75em; }
  .flg-molang-stepper { display: inline-flex; gap: 2px; flex: 0 0 auto; }
  .flg-molang-stepper[hidden], .flg-molang-templates[hidden], .flg-molang-tonumber[hidden] { display: none; }
  .flg-molang-step, .flg-molang-tonumber, .flg-molang-action {
    font: inherit; font-size: 0.85em; cursor: pointer;
    padding: 0 6px; border-radius: 2px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
  }
  .flg-molang-step { min-width: 22px; font-family: var(--vscode-editor-font-family, monospace); }
  .flg-molang-step:hover, .flg-molang-tonumber:hover, .flg-molang-action:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .flg-molang-step:focus-visible, .flg-molang-tonumber:focus-visible, .flg-molang-action:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
  }
  .flg-molang-templates {
    font: inherit; font-size: 0.85em; flex: 1 1 8em; min-width: 0; max-width: 100%;
    color: var(--vscode-dropdown-foreground, inherit);
    background: var(--vscode-dropdown-background, transparent);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,0.4)));
    border-radius: 2px;
  }

  /* ---- what the file gets, and whether it has had it yet ------------------------ */
  .flg-molang-write {
    font-size: 0.85em; opacity: 0.75; min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .flg-molang-write[hidden], .flg-molang-engine[hidden], .flg-molang-suppressed[hidden] { display: none; }
  /* A DIRTY BOX SAYS SO. Not a colour alone: the line under it changes its words too, and the
     edge is what survives a theme with no accent colour. */
  .flg-molang-field[data-dirty='yes'] .flg-molang-write {
    opacity: 1; color: var(--vscode-editorWarning-foreground, #cca700);
  }
  .flg-molang-field[data-dirty='yes'] .flg-molang-input {
    outline: 1px dashed var(--vscode-editorWarning-foreground, #cca700); outline-offset: -1px;
  }
  .flg-molang-field[data-dirty='yes'] .flg-molang-input:focus {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
  }
  .flg-molang-engine {
    font-size: 0.85em; opacity: 0.85; min-width: 0;
    color: var(--vscode-descriptionForeground, inherit);
  }
  .flg-molang-suppressed { font-size: 0.8em; opacity: 0.6; }

  /* ---- the diagnostics ---------------------------------------------------------- */
  .flg-molang-problems { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .flg-molang-problem {
    font-size: 0.88em; min-width: 0;
    border-left: 2px solid transparent; padding: 2px 0 2px 6px;
  }
  .flg-molang-problem-error { border-left-color: var(--vscode-editorError-foreground, #f14c4c); }
  .flg-molang-problem-warning { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
  .flg-molang-problem-info { border-left-color: var(--vscode-editorInfo-foreground, #3794ff); }
  .flg-molang-problem-head { overflow-wrap: break-word; }
  .flg-molang-problem-mark { font-weight: 600; }
  .flg-molang-problem-error .flg-molang-problem-mark { color: var(--vscode-editorError-foreground, #f14c4c); }
  .flg-molang-problem-warning .flg-molang-problem-mark { color: var(--vscode-editorWarning-foreground, #cca700); }
  .flg-molang-problem-more { margin-top: 2px; }
  .flg-molang-problem-why { cursor: pointer; opacity: 0.7; font-size: 0.95em; }
  .flg-molang-problem-why:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .flg-molang-problem-detail { opacity: 0.75; margin-top: 2px; overflow-wrap: break-word; }
  .flg-molang-problem-actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }

  /* Metrics for BOTH layers. See the note above. */
  .flg-edge-molang {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    font-weight: normal;
    font-style: normal;
    letter-spacing: normal;
    word-spacing: normal;
    line-height: 1.45;
    tab-size: 2;
    text-indent: 0;
    text-transform: none;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 4px 6px;
    margin: 0;
    width: 100%;
    box-sizing: border-box;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    overflow: hidden auto;
    /* Three rows' worth, the size this field has always been. It lives on the SHARED class
       rather than on the textarea because it is a metric, and metrics that exist on one layer
       and not the other are the whole failure mode this stylesheet is arranged to prevent. The
       ink layer is stretched to the stack and so is unaffected either way. */
    min-height: calc(4.35em + 10px);
    /* And a ceiling, so a real setup script does not push everything below it off the panel.
       A whole setup script runs to a dozen statements; grown to its content that is the entire
       sidebar, with the diagnostics and the checkbox somewhere past the bottom edge.

       scrollbar-gutter: stable is on the SHARED class and is the load-bearing half. Once the
       box can scroll, the textarea's scrollbar narrows its content box while the ink layer's is
       unchanged -- and two content boxes of different widths wrap the same text differently, so
       the caret drifts away from the glyphs it is sitting in. Reserving the gutter on both
       layers keeps the two widths equal whether or not a bar is showing. */
    max-height: 40vh;
    scrollbar-gutter: stable;
  }

  .flg-molang-ink {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 0;
    pointer-events: none;
    border-color: transparent;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
  }
  .flg-molang-input {
    position: relative;
    z-index: 1;
    display: block;
    resize: none;
    background: transparent;
    color: transparent;
    caret-color: var(--vscode-editorCursor-foreground, var(--vscode-input-foreground));
  }
  .flg-molang-input::selection { background: var(--vscode-editor-selectionBackground, rgba(100, 150, 220, 0.35)); }
  /* The one thing in this box that is NOT painted by the ink layer, so it is the one thing that
     has to be given back the colour the rule above takes away. */
  .flg-molang-input::placeholder {
    color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground, #8a8a8a));
    opacity: 1;
  }
  .flg-molang-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  /* The token palette. query-unknown is the one that is not a colour choice: the editor already
     reports an unreachable query as an ERROR, and colouring it like a real one would have the
     field contradicting its own diagnostic. */
  .flg-mo-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .flg-mo-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .flg-mo-operator { color: var(--vscode-symbolIcon-operatorForeground, #d4d4d4); }
  .flg-mo-punct { color: var(--vscode-input-foreground); opacity: 0.75; }
  .flg-mo-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
  .flg-mo-query { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
  .flg-mo-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
  .flg-mo-variable { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }
  .flg-mo-variable-other { color: var(--vscode-input-foreground); }
  .flg-mo-plain { color: var(--vscode-input-foreground); }
  .flg-mo-query-unknown {
    color: var(--vscode-editorError-foreground, #f14c4c);
    text-decoration: underline wavy var(--vscode-editorError-foreground, #f14c4c);
    text-underline-offset: 2px;
  }

  .flg-molang-popup {
    position: absolute;
    top: 100%; left: 0; right: 0;
    z-index: 40;
    margin: 2px 0 0 0;
    padding: 2px;
    list-style: none;
    max-height: ${VISIBLE_ROWS * 40}px;
    overflow-y: auto;
    background: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background, #252526));
    border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-editorWidget-border, #454545));
    border-radius: 3px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .flg-molang-option { padding: 3px 6px; border-radius: 2px; cursor: pointer; }
  .flg-molang-option-active {
    background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground, #04395e));
  }
  .flg-molang-option-head { display: flex; gap: 8px; align-items: baseline; }
  .flg-molang-option-label { font-family: var(--vscode-editor-font-family, monospace); }
  .flg-molang-option-detail {
    font-size: 0.85em; opacity: 0.7; flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .flg-molang-option-doc { font-size: 0.85em; opacity: 0.8; margin-top: 2px; white-space: normal; }

  .flg-molang-keep { display: flex; align-items: flex-start; gap: 6px; font-size: 0.9em; cursor: pointer; }
  .flg-molang-keep input { margin: 2px 0 0 0; flex: 0 0 auto; }
  .flg-molang-note { font-size: 0.85em; opacity: 0.7; }
`
