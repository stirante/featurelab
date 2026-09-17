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
  MolangEdgeEditor,
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

  const popup = document.createElement('ul')
  popup.className = 'flg-molang-popup'
  popup.setAttribute('role', 'listbox')
  popup.hidden = true

  stack.append(ink, input, popup)

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
    // A filling box is sized by the stylesheet, and the ink layer is stretched to the same stack.
    if (fill) return
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
    if (!fill) return
    let remaining = offset
    const walker = document.createTreeWalker(ink, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    while (node !== null && remaining > node.data.length) {
      remaining -= node.data.length
      node = walker.nextNode() as Text | null
    }
    if (node === null) return
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
    paintInk(input.value)
    fitHeight()
    openPopup(false)
    options.onChanged?.()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
      event.preventDefault()
      openPopup(true)
      return
    }
    // EVERY branch below is guarded on the popup being open. While it is closed this listener
    // does nothing at all, which is the promise the header makes: Escape, Tab and Enter go on
    // meaning what they mean in a text box.
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
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        closePopup()
        return
      default:
        return
    }
  }

  const onBlur = (): void => {
    closePopup()
    // Commit BEFORE reformatting. The two are independent -- the file receives the same bytes
    // either way, since the spelling that reaches it is derived from the draft rather than copied
    // from it -- but committing first means a failure to lay the text out cannot cost the author
    // their edit.
    if (editor.view().dirty && editor.commit()) options.onCommit?.()
    if (editor.reformat()) {
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

  /* Filling the host: field, stack and textarea each take the height left to them. The ceiling
     goes -- it exists so a grown box does not push the panel's other contents away, and a filling
     box is the panel's contents. The floor stays, so a short panel still gets a usable box and
     scrolls. */
  .flg-molang-fill { flex: 1 1 auto; min-height: 0; }
  .flg-molang-fill .flg-molang-stack { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .flg-molang-fill .flg-edge-molang { max-height: none; min-height: 10em; }
  .flg-molang-fill .flg-molang-input { flex: 1 1 auto; }

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
