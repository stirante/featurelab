// form.ts -- the settings panel for a COLLAPSED compound node.
//
// WHAT THIS IS FOR. spec.ts states the design in its header: the parameters are the source and
// the subgraph is derived, and a collapsed compound "has to show the author their own inputs".
// Without this module it does not. Selecting a `steps` hands the generic inspector the
// underlying scatter's schema, and the author is shown `x`, `y`, `z` and an `iterations` string
// holding a generated counter reset and step count -- the machinery, not the list of steps they
// wrote. That string is not even editable in any useful sense: the branch guards repeat the same
// indices in other files, so changing it there desynchronises the compound from itself.
//
// So this file draws LoopParams, StepsParams, PlacementGuardParams and ColumnParams,
// and nothing else. `CollapsedCompoundView.formParams` is its input -- the parameters as the
// compound's own spec validated them -- and a new parameter OBJECT is its only output.
//
// WHAT IT OWNS AND WHAT IT DOES NOT. It owns DOM. It writes nothing, mutates nothing it was
// handed, and re-expands nothing: every edit leaves as a `CompoundParamsChange` carrying the new
// parameters, and the host expands the compound and writes the files. That direction is
// inspector.ts's, for inspector.ts's reason -- the file on disk is the source of truth and a
// sidebar keeping its own copy is a sidebar that eventually writes it over somebody's work.
//
// It does hold a DRAFT, and that is not the same thing. A refused edit has to leave the author's
// own text on screen where they can fix it; a draft that was thrown away on refusal would delete
// the keystrokes that caused it. The draft is replaced wholesale by `update()`, which is what the
// host calls after it has written and re-read.
//
// VALIDATION IS THE COMPOUND'S OWN. Every edit goes through `CompoundSpec.validate`, and where a
// `formatVersion` is supplied, through `CompoundSpec.expand` as well -- some refusals (a setup
// script with no terminating `;`, a count that is a statement sequence) exist only at expansion
// time, and a form that emitted those would hand the host a plan it cannot apply. Nothing here
// re-implements a rule: a refusal is rendered verbatim, never swallowed, and no change is
// reported for an edit that was refused.
//
// THE TWO COUPLINGS THIS FILE EXISTS TO GET RIGHT, both of which are invisible in the JSON:
//
//   1. LOOP. The per-iteration step script is written into whichever axis `coordinateEvalOrder`
//      names FIRST -- loop.ts picks `coordinateEvalOrder.at(0)` and exports `firstEvaluatedAxis`
//      so that a form does not guess. The order control and the step script therefore live in ONE
//      fieldset, the script's label names the axis it lands in and changes as the order does, the
//      axis that carries it is marked in the coordinate list, and the change label spells the move
//      out. A panel that offered the order as a plain dropdown across the room from the script
//      would let somebody reorder the axes and leave the bookkeeping running at the wrong point of
//      the loop -- which no schema check can see and no diff makes obvious.
//
//   2. COLUMN. `levelVariable` and `step` exist only in the bottom-up shape, and the spec refuses
//      them in the other rather than flipping the order to suit. So they are not OFFERED in the
//      other: choosing top-down while either is set does not silently drop them and does not
//      quietly refuse either -- it names what would be lost and asks for a second, deliberate
//      click. Both directions of that coupling are visible before anything happens.
//
// MOLANG IS FREE TEXT, EVERYWHERE. A count, a condition, a bound, a coordinate: every one of them
// is a full expression evaluated against a shared scope, and real packs lean on it -- a count of 0
// is how a branch is skipped, and an assignment inside the count is how a child is set up. There
// is not one spin-box in this file, because a spin-box makes that unwritable. The single genuinely
// numeric parameter (`scatterChance`) is still a text box, so that clearing it can mean "not
// written" rather than "zero".
//
// COLOUR. Every colour comes from a `--vscode-*` custom property through the `--flcf-*` variables
// the stylesheet declares, the form controls' own included: an `<input>` that sets no colours
// renders as a white native widget in a dark panel.
//
// THE STYLESHEET IS A STRING EXPORT, and `installCompoundFormStyles` copies the nonce off a style
// element the document was served with, as palette.ts does -- the panel runs under a
// Content-Security-Policy whose style-src is a nonce, and a runtime `<style>` without one is
// refused silently and the panel renders as unstyled text.
//
// UNTRUSTED TEXT. Every string drawn here comes out of a pack's own JSON. Nothing is assigned
// through innerHTML -- textContent and setAttribute only.

import { COMPOUND_KIND_NOTES, type BlockSpec, type ColumnOrder, type CompoundKind, type CompoundSpec } from './spec'
import { COORDINATE_EVAL_ORDERS, DEFAULT_COORDINATE_EVAL_ORDER, firstEvaluatedAxis, type Axis } from './loop'
import { formatStateValue, parseStateValue, readBlockValue, writeBlockValue, type BlockView } from '../inspector'
import type { Refusal } from '../idioms'

// ---------------------------------------------------------------------------
// What goes in and what comes out
// ---------------------------------------------------------------------------

/**
 * What the form is drawn from.
 *
 * Structurally a subset of `CollapsedCompoundView`, so a caller passes the view straight in. It is
 * a subset rather than the view itself because the form has no use for the children, the drift or
 * the expansion, and a parameter it does not read is a parameter a test has to invent.
 *
 * `formParams` is the validated parameters and is the form's real input. `rawParams` is what was
 * recorded, and is used only when `formParams` is null -- the spec rejected what is in the file,
 * and the author still has to see, and be able to repair, their own text.
 */
export interface CompoundFormSource {
  readonly kind: CompoundKind
  readonly identifier: string
  /** `CompoundSpec.title`. Falls back to the kind when the view has none. */
  readonly title?: string | undefined
  /** `CompoundSpec.summary`, shown under the title. */
  readonly summary?: string | undefined
  /** `CollapsedCompoundView.formParams`. */
  readonly formParams: unknown
  /** `CollapsedCompoundView.rawParams`. Only read when `formParams` is null. */
  readonly rawParams?: unknown
}

/**
 * One edit, carrying the WHOLE new parameter object.
 *
 * Not a path and a value, which is what inspector.ts emits, and the difference is not cosmetic: a
 * compound's parameters are not a document the host splices into. They are re-expanded as a unit,
 * and several of the couplings above change two fields at once (an order switch that drops a level
 * variable, a step reordering that renumbers every branch), so an edit that arrived as one field
 * would let a host apply half of one.
 *
 * `params` has been through the compound's own `validate`, so it is canonical: keys in the spec's
 * order, blank optionals dropped, nothing unknown riding along.
 */
export interface CompoundParamsChange {
  readonly kind: CompoundKind
  readonly identifier: string
  /** The new parameters, validated by the compound's own spec. */
  readonly params: unknown
  /** What they were, so a host can diff or undo without keeping its own copy. */
  readonly previous: unknown
  /** One line saying what the author did, fit for a status line or an undo entry. */
  readonly label: string
}

export type CompoundParamsListener = (change: CompoundParamsChange) => void

export interface CompoundFormOptions {
  /** The compound's own spec. Every edit is checked through its `validate`. */
  readonly spec: CompoundSpec<unknown>
  /** Where every accepted edit goes. Never called for an edit that was refused. */
  readonly onChange: CompoundParamsListener
  /**
   * When given, an edit is also put through `CompoundSpec.expand` before it is reported.
   *
   * Several refusals live only there -- a setup script that does not terminate its last statement,
   * a count that is a statement sequence, an identifier that would not name a file. Reporting an
   * edit that expand would refuse hands the host a plan it cannot apply, and the author finds out
   * one layer further from the box they typed in.
   */
  readonly formatVersion?: string | undefined
  /** Shown under the heading. */
  readonly file?: string | undefined
  readonly ariaLabel?: string | undefined
  /** Called with every refusal as well as rendering it, for a host that logs them. */
  readonly onRefuse?: ((refusal: Refusal) => void) | undefined
  /** Defaults to the global `document`; a test harness passes its own. */
  readonly document?: Document | undefined
}

export interface CompoundForm {
  /** The element this form owns, appended to the host. Do not reparent it. */
  readonly element: HTMLElement
  /** The parameters as the panel currently holds them -- validated, or the refused draft. */
  readonly params: unknown
  /** The standing refusal, or null. Non-null means `params` is not safe to expand. */
  readonly refusal: Refusal | null
  /** Redraws for freshly recorded parameters -- what a host calls after it wrote and re-read. */
  update(next: CompoundFormSource): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Drafts -- a lenient READING of a parameter object, for display only
// ---------------------------------------------------------------------------
//
// Nothing below decides whether anything is valid. A draft exists so that a control can be drawn
// over parameters the spec has just REFUSED, which is the state the panel is in whenever the file
// holds something the compound cannot read, and the state it is in for as long as somebody is
// halfway through typing. Every field reads as the empty string when it is absent or the wrong
// type, and the empty string is written back as an absent key -- so a draft never invents a value
// and never destroys one it could not display.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Drops the blank optionals, so a cleared box removes its key rather than writing `""`. */
function withOptional(base: Record<string, unknown>, optional: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(optional)) {
    if (value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    out[key] = value
  }
  return out
}

export interface LoopDraft {
  readonly count: string
  readonly places: string
  readonly setup: string
  readonly step: string
  readonly x: string
  readonly y: string
  readonly z: string
  /** '' means the key is not written, which the engine reads as `xzy`. */
  readonly coordinateEvalOrder: string
  /** Kept as text so that clearing it means "not written" rather than zero. */
  readonly scatterChance: string
  readonly projectInputToFloor: boolean | undefined
}

export function readLoopDraft(params: unknown): LoopDraft {
  const raw = isRecord(params) ? params : {}
  const chance = raw['scatterChance']
  return {
    count: text(raw['count']),
    places: text(raw['places']),
    setup: text(raw['setup']),
    step: text(raw['step']),
    x: text(raw['x']),
    y: text(raw['y']),
    z: text(raw['z']),
    coordinateEvalOrder: text(raw['coordinateEvalOrder']),
    scatterChance: typeof chance === 'number' ? String(chance) : text(chance),
    projectInputToFloor: typeof raw['projectInputToFloor'] === 'boolean' ? raw['projectInputToFloor'] : undefined,
  }
}

/**
 * A number, or the text itself when it is not one.
 *
 * The unparseable text is passed through rather than dropped, so the refusal the author reads is
 * the spec's own ("`scatterChance` must be a finite number...") rather than a silent disappearance.
 */
function numberOrText(value: string): unknown {
  if (value.trim() === '') return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : value
}

export function writeLoopDraft(draft: LoopDraft): unknown {
  return withOptional(
    { count: draft.count, places: draft.places },
    {
      setup: draft.setup,
      step: draft.step,
      x: draft.x,
      y: draft.y,
      z: draft.z,
      coordinateEvalOrder: draft.coordinateEvalOrder,
      scatterChance: numberOrText(draft.scatterChance),
      projectInputToFloor: draft.projectInputToFloor,
    },
  )
}

export interface StepsDraft {
  readonly steps: readonly string[]
  readonly setup: string
}

export function readStepsDraft(params: unknown): StepsDraft {
  const raw = isRecord(params) ? params : {}
  const steps = Array.isArray(raw['steps']) ? raw['steps'] : []
  return { steps: steps.map((entry) => text(entry)), setup: text(raw['setup']) }
}

export function writeStepsDraft(draft: StepsDraft): unknown {
  return withOptional({ steps: [...draft.steps] }, { setup: draft.setup })
}

/**
 * One attach map -- `may_attach_to` / `may_not_attach_to`.
 *
 * The map's values are `unknown` in the contract and the engine reads several shapes for them, so
 * the faces are kept as (name, value) pairs in the order the file wrote them and only the shapes
 * this panel can actually draw are drawn. A face holding something else keeps its value untouched
 * and is shown as a read-only summary -- see the note in `renderAttachMap`.
 */
export interface AttachDraft {
  readonly faces: readonly (readonly [string, unknown])[]
}

function readAttachDraft(value: unknown): AttachDraft | null {
  if (!isRecord(value)) return null
  return { faces: Object.entries(value).map(([face, entry]) => [face, entry] as const) }
}

function writeAttachDraft(draft: AttachDraft | null): Record<string, unknown> | undefined {
  if (draft === null) return undefined
  const out: Record<string, unknown> = {}
  for (const [face, value] of draft.faces) out[face] = value
  return out
}

export interface GuardDraft {
  readonly places: string
  readonly init: string
  /** null means the key is not written, which the expansion fills in as bedrock. */
  readonly probeBlock: BlockView | null
  readonly mayReplace: readonly BlockView[]
  readonly mayAttachTo: AttachDraft | null
  readonly mayNotAttachTo: AttachDraft | null
}

export function readGuardDraft(params: unknown): GuardDraft {
  const raw = isRecord(params) ? params : {}
  const replace = Array.isArray(raw['mayReplace']) ? raw['mayReplace'] : []
  return {
    places: text(raw['places']),
    init: text(raw['init']),
    probeBlock: raw['probeBlock'] === undefined ? null : readBlockValue(raw['probeBlock']),
    mayReplace: replace.map((entry) => readBlockValue(entry)),
    mayAttachTo: readAttachDraft(raw['mayAttachTo']),
    mayNotAttachTo: readAttachDraft(raw['mayNotAttachTo']),
  }
}

/**
 * A BlockView as a `BlockSpec`, never as the `{tags}` descriptor.
 *
 * spec.ts's BlockSpec is a name or `{name, states}` and placementGuard.ts refuses anything else, so
 * a control here must not be able to produce a third shape.
 */
function blockSpecOf(view: BlockView): BlockSpec | undefined {
  const written = writeBlockValue({ ...view, spelling: view.states.length > 0 ? 'name-and-states' : 'name', tags: '' })
  if (typeof written === 'string') return written
  if (isRecord(written) && typeof written['name'] === 'string') {
    const states = written['states']
    return isRecord(states) ? { name: written['name'], states } : { name: written['name'] }
  }
  return undefined
}

export function writeGuardDraft(draft: GuardDraft): unknown {
  const probe = draft.probeBlock === null ? undefined : blockSpecOf(draft.probeBlock)
  const replace = draft.mayReplace.map((view) => blockSpecOf(view)).filter((spec): spec is BlockSpec => spec !== undefined)
  return withOptional(
    { places: draft.places },
    {
      probeBlock: probe,
      mayReplace: replace.length > 0 ? replace : undefined,
      mayAttachTo: writeAttachDraft(draft.mayAttachTo),
      mayNotAttachTo: writeAttachDraft(draft.mayNotAttachTo),
      init: draft.init,
    },
  )
}

export interface ColumnDraft {
  readonly places: string
  readonly maxY: string
  readonly minY: string
  readonly setup: string
  /** '' means the key is not written, which the engine reads as top-down. */
  readonly order: ColumnOrder | ''
  readonly levelVariable: string
  readonly step: string
}

export function readColumnDraft(params: unknown): ColumnDraft {
  const raw = isRecord(params) ? params : {}
  const order = raw['order']
  return {
    places: text(raw['places']),
    maxY: text(raw['maxY']),
    minY: text(raw['minY']),
    setup: text(raw['setup']),
    order: order === 'top-down' || order === 'bottom-up' ? order : '',
    levelVariable: text(raw['levelVariable']),
    step: text(raw['step']),
  }
}

export function writeColumnDraft(draft: ColumnDraft): unknown {
  return withOptional(
    { places: draft.places, maxY: draft.maxY },
    {
      minY: draft.minY,
      setup: draft.setup,
      order: draft.order,
      levelVariable: draft.levelVariable,
      step: draft.step,
    },
  )
}

// ---------------------------------------------------------------------------
// The couplings, as pure functions
// ---------------------------------------------------------------------------

/** Moves one element of a list, returning a new list. Out-of-range moves return the list as it was. */
export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out
  const [item] = out.splice(from, 1)
  if (item === undefined) return [...list]
  out.splice(to, 0, item)
  return out
}

/**
 * Which axis a loop's per-iteration step script is written into.
 *
 * Delegates to loop.ts's `firstEvaluatedAxis`, which exists for exactly this caller. Restating the
 * rule here -- even as "just take the first character" -- would be a second copy of it, and the
 * two would part company the first time the schema grew a seventh order.
 */
export function stepAxisOf(order: string): Axis {
  return firstEvaluatedAxis(order === '' ? undefined : order)
}

/** The order as the engine reads it: the written one, or the schema's own default. */
export function effectiveEvalOrder(order: string): string {
  return order === '' ? DEFAULT_COORDINATE_EVAL_ORDER : order
}

/**
 * The sentence an order change owes the author.
 *
 * The step script does not sit in a field called `step` in the generated file -- it is concatenated
 * in front of the first evaluated coordinate -- so changing the order MOVES it. Saying so at the
 * moment of the change is the whole point of keeping the two controls together.
 */
export function describeStepMove(previous: string, next: string, hasStep: boolean): string {
  const from = stepAxisOf(previous)
  const to = stepAxisOf(next)
  const order = effectiveEvalOrder(next)
  if (!hasStep || from === to) return `Evaluate the coordinates ${order}`
  return `Evaluate the coordinates ${order} -- the step script moves from ${from} to ${to}`
}

/** Which column fields the spec will accept for this order. Both belong to the counter shape. */
export function columnFieldsFor(order: ColumnOrder | ''): { readonly levelVariable: boolean; readonly step: boolean } {
  const bottomUp = order === 'bottom-up'
  return { levelVariable: bottomUp, step: bottomUp }
}

/**
 * What choosing `next` would discard, given the draft as it stands.
 *
 * Empty means the switch is free. Non-empty means the panel must say what is lost and take a second
 * click for it: the spec refuses `levelVariable` and `step` outside the counter shape rather than
 * flipping the order to suit them, and the mirror image of that refusal is that this form must not
 * drop them behind the author's back either. Both would be a change nobody asked for.
 */
export function columnOrderSwitchLoss(draft: ColumnDraft, next: ColumnOrder): readonly string[] {
  const allowed = columnFieldsFor(next)
  const lost: string[] = []
  if (!allowed.levelVariable && draft.levelVariable.trim() !== '') lost.push('levelVariable')
  if (!allowed.step && draft.step.trim() !== '') lost.push('step')
  return lost
}

/** The draft with everything the new order cannot carry removed. */
export function columnWithOrder(draft: ColumnDraft, next: ColumnOrder): ColumnDraft {
  const allowed = columnFieldsFor(next)
  return {
    ...draft,
    order: next,
    levelVariable: allowed.levelVariable ? draft.levelVariable : '',
    step: allowed.step ? draft.step : '',
  }
}

/** Step N of M, said as execution order, because that is what the position means. */
export function describeStepPosition(index: number, total: number): string {
  if (total === 1) return 'The only step.'
  if (index === 0) return 'Runs first.'
  if (index === total - 1) return 'Runs last.'
  return `Runs ${index + 1}${ordinalSuffix(index + 1)}.`
}

function ordinalSuffix(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

/**
 * Exported as a string for the reason palette.ts and inspector.ts export theirs: media/graph.css
 * belongs to the renderer, and a panel whose styling lives in another package's file is a panel
 * that renders unstyled the first time somebody vendors the module on its own.
 *
 * The theming rule is the one the other two follow. Every semantic variable is declared ONCE, on
 * the root class, as `var(--vscode-<name>, <fallback>)`, and every rule below reads only `--flcf-*`.
 * Nothing below the variable block names a colour; `transparent` and `currentColor` are keywords.
 */
export const COMPOUND_FORM_STYLESHEET = `
.flcf-form {
  --flcf-fg: var(--vscode-foreground, #cccccc);
  --flcf-fg-muted: var(--vscode-descriptionForeground, rgba(204, 204, 204, 0.7));
  --flcf-bg: var(--vscode-editorWidget-background, #252526);
  --flcf-input-bg: var(--vscode-input-background, #3c3c3c);
  --flcf-input-fg: var(--vscode-input-foreground, #cccccc);
  --flcf-input-border: var(--vscode-input-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  --flcf-placeholder: var(--vscode-input-placeholderForeground, rgba(204, 204, 204, 0.5));
  --flcf-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));
  --flcf-focus: var(--vscode-focusBorder, #007fd4);
  --flcf-accent: var(--vscode-charts-blue, #4e94ce);
  --flcf-button-bg: var(--vscode-button-secondaryBackground, rgba(255, 255, 255, 0.08));
  --flcf-button-fg: var(--vscode-button-secondaryForeground, #cccccc);
  --flcf-hover: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
  --flcf-code-fg: var(--vscode-textPreformat-foreground, #ce9178);
  --flcf-code-bg: var(--vscode-textCodeBlock-background, rgba(255, 255, 255, 0.06));
  --flcf-error: var(--vscode-editorError-foreground, #f14c4c);
  --flcf-warning: var(--vscode-editorWarning-foreground, #cca700);
  --flcf-font: var(--vscode-font-family, -apple-system, 'Segoe UI', system-ui, sans-serif);
  --flcf-mono: var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Consolas, monospace);
  --flcf-font-size: var(--vscode-font-size, 13px);

  font-family: var(--flcf-font);
  font-size: var(--flcf-font-size);
  line-height: 1.4;
  color: var(--flcf-fg);
  background: var(--flcf-bg);
  padding: 10px 12px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  overflow-x: hidden;
}

.flcf-title { margin: 0; font-size: 1.05em; font-weight: 600; overflow-wrap: anywhere; }
.flcf-kind {
  font-family: var(--flcf-mono);
  color: var(--flcf-code-fg);
  overflow-wrap: anywhere;
}
.flcf-meta { color: var(--flcf-fg-muted); font-size: 0.92em; overflow-wrap: anywhere; }
.flcf-summary-line { color: var(--flcf-fg-muted); font-size: 0.95em; overflow-wrap: anywhere; margin: 0; }

.flcf-refusal {
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid var(--flcf-error);
  background: var(--flcf-code-bg);
  font-size: 0.95em;
  overflow-wrap: anywhere;
}
/* The level is spelled out as well as coloured: a high-contrast theme can flatten the palette, and
   "refused" must not differ from "note" by hue alone. */
.flcf-refusal-label { font-weight: 600; }
.flcf-refusal-code { font-family: var(--flcf-mono); color: var(--flcf-fg-muted); }

.flcf-note {
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid var(--flcf-border);
  background: var(--flcf-code-bg);
  font-size: 0.93em;
  overflow-wrap: anywhere;
}
.flcf-note-warning { border-left-color: var(--flcf-warning); }

.flcf-section { display: flex; flex-direction: column; gap: 4px; margin: 0; border: 0; padding: 0; }
.flcf-section-title {
  margin: 6px 0 0;
  padding: 0;
  font-size: 0.85em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--flcf-fg-muted);
}

.flcf-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 0 6px 8px;
  border-top: 1px solid var(--flcf-border);
  border-left: 2px solid transparent;
}
.flcf-field[data-state='set'] { border-left-color: var(--flcf-accent); }
.flcf-label { font-family: var(--flcf-mono); font-weight: 600; overflow-wrap: anywhere; }
.flcf-field[data-state='unset'] .flcf-label { font-weight: 400; color: var(--flcf-fg-muted); }
.flcf-req { color: var(--flcf-error); }
.flcf-hint { margin: 1px 0 0; color: var(--flcf-fg-muted); font-size: 0.9em; overflow-wrap: anywhere; }
.flcf-hint-strong { color: var(--flcf-fg); }
.flcf-value { font-family: var(--flcf-mono); color: var(--flcf-fg-muted); overflow-wrap: anywhere; }

.flcf-input,
.flcf-select,
.flcf-area {
  font: inherit;
  font-family: var(--flcf-mono);
  color: var(--flcf-input-fg);
  background: var(--flcf-input-bg);
  border: 1px solid var(--flcf-input-border);
  border-radius: 2px;
  padding: 2px 6px;
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  flex: 0 0 auto;
}
.flcf-input::placeholder,
.flcf-area::placeholder { color: var(--flcf-placeholder); }
.flcf-select option { color: var(--flcf-input-fg); background: var(--flcf-input-bg); }
.flcf-area { resize: vertical; min-height: 3.2em; }
.flcf-input:focus-visible,
.flcf-select:focus-visible,
.flcf-area:focus-visible,
.flcf-button:focus-visible,
.flcf-summary:focus-visible { outline: 1px solid var(--flcf-focus); outline-offset: 1px; }

.flcf-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.flcf-line > .flcf-input { flex: 1 1 8ch; width: auto; }
.flcf-line > .flcf-select { flex: 0 1 auto; width: auto; }

.flcf-button {
  font: inherit;
  color: var(--flcf-button-fg);
  background: var(--flcf-button-bg);
  border: 1px solid var(--flcf-border);
  border-radius: 3px;
  padding: 1px 8px;
  cursor: pointer;
}
.flcf-button:hover { background: var(--flcf-hover); }
.flcf-button[disabled] { opacity: 0.5; cursor: default; }
.flcf-button-quiet { background: transparent; border-color: transparent; color: var(--flcf-fg-muted); }
.flcf-button-quiet:hover:not([disabled]) { background: var(--flcf-hover); color: var(--flcf-fg); }

.flcf-list { display: flex; flex-direction: column; gap: 6px; }
.flcf-item {
  border: 1px solid var(--flcf-border);
  border-radius: 3px;
  padding: 2px 8px 8px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.flcf-item-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.flcf-ordinal {
  font-family: var(--flcf-mono);
  font-weight: 600;
  border: 1px solid var(--flcf-accent);
  border-radius: 8px;
  padding: 0 7px;
  color: var(--flcf-fg);
}
.flcf-position { font-size: 0.88em; color: var(--flcf-fg-muted); overflow-wrap: anywhere; }
.flcf-item-actions { display: flex; gap: 2px; margin-left: auto; }

.flcf-choice { border: 1px solid var(--flcf-border); border-radius: 3px; padding: 2px 8px 8px; margin: 0; }
.flcf-choice-legend { font-weight: 600; font-family: var(--flcf-mono); padding: 0 4px; }
.flcf-option {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  padding: 3px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}
.flcf-option:hover { background: var(--flcf-hover); }
.flcf-option[data-checked='yes'] { border-color: var(--flcf-accent); background: var(--flcf-code-bg); }
.flcf-option:focus-within { outline: 1px solid var(--flcf-focus); outline-offset: 1px; }
.flcf-option input { accent-color: var(--flcf-accent); margin: 3px 0 0; }
.flcf-option-body { display: flex; flex-direction: column; gap: 1px; }
.flcf-option-name { font-family: var(--flcf-mono); }
.flcf-option-why { font-size: 0.88em; color: var(--flcf-fg-muted); overflow-wrap: anywhere; }

/* The coupled pair: the evaluation order and the script it carries are one control, drawn as one
   box, because they cannot be edited independently without breaking the loop silently. */
.flcf-coupled { border: 1px solid var(--flcf-accent); border-radius: 3px; padding: 2px 8px 8px; margin: 0; }
.flcf-coupled-legend { font-weight: 600; padding: 0 4px; }
.flcf-carries { color: var(--flcf-fg); font-size: 0.9em; overflow-wrap: anywhere; margin: 2px 0 0; }
.flcf-axis-mark {
  font-size: 0.82em;
  border: 1px solid var(--flcf-accent);
  border-radius: 8px;
  padding: 0 6px;
  color: var(--flcf-fg);
}

.flcf-empty { color: var(--flcf-fg-muted); font-size: 0.92em; margin: 0; }
.flcf-unmodelled { border-left: 2px solid var(--flcf-warning); padding-left: 8px; }
.flcf-summary { cursor: pointer; color: var(--flcf-fg-muted); font-size: 0.92em; padding: 2px 0; }
.flcf-summary:hover { color: var(--flcf-fg); }
`

/**
 * Adds the stylesheet to a document once.
 *
 * A webview serves the page under a Content-Security-Policy whose style-src is a nonce, and a
 * `<style>` created at runtime carries none -- so it is refused, nothing is logged where the author
 * would look, and the panel renders as unstyled text. The nonce is copied off a style element the
 * document was SERVED with, which is the only element on the page that legitimately has one. Where
 * there is none to copy -- a plain page, a test harness -- the element is appended anyway, because
 * such a page has no policy to violate.
 */
export function installCompoundFormStyles(doc: Document = document): void {
  const id = 'flcf-compound-form-styles'
  if (doc.getElementById(id) !== null) return
  const style = doc.createElement('style')
  style.id = id
  const served = doc.querySelector('style[nonce]') as HTMLStyleElement | null
  const nonce = served?.nonce ?? ''
  if (nonce !== '') style.nonce = nonce
  style.textContent = COMPOUND_FORM_STYLESHEET
  doc.head.append(style)
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** The prose each compound's own module already wrote. Never restated here. */
function kindNote(kind: CompoundKind): string {
  return COMPOUND_KIND_NOTES[kind]
}

let instanceCounter = 0

/**
 * Builds the settings form for one collapsed compound.
 *
 * ONE entry point, taking the recorded parameters and a change callback, returning `element`,
 * `update` and `dispose` -- the shape createNodeInspector and createGraphView use, so a host wires
 * it in one line and tears it down in one.
 */
export function createCompoundForm(initial: CompoundFormSource, options: CompoundFormOptions): CompoundForm {
  const doc = options.document ?? document
  installCompoundFormStyles(doc)

  const uid = `flcf${++instanceCounter}`
  let ids = 0
  const nextId = (): string => `${uid}-${++ids}`

  const root = doc.createElement('div')
  root.className = 'flcf-form'
  root.setAttribute('role', 'group')
  root.dataset['kind'] = initial.kind
  root.setAttribute('aria-label', options.ariaLabel ?? `${initial.title ?? initial.kind} settings`)

  let source = initial
  /** The parameter object the controls are drawn over. Replaced, never mutated in place. */
  let draft: unknown = initial.formParams ?? initial.rawParams ?? {}
  let refusal: Refusal | null = null
  /** A column order switch that would discard fields, waiting for the deliberate second click. */
  let pendingOrder: ColumnOrder | null = null
  let disposed = false

  // The recorded parameters are put through the spec before anything is drawn. When the file holds
  // something the compound cannot read, `formParams` is null and the author has to be told why
  // before they start typing into it -- not after their first edit bounces.
  {
    const checked = callValidate(options.spec, draft)
    if (!checked.ok) refusal = checked.refusal
  }

  // ---- focus ---------------------------------------------------------------
  // Every rebuild replaces the subtree, so a control keeps its place only if it is found again by
  // name. `data-fkey` is that name: it is derived from the field's identity (a path plus an index)
  // rather than from its position, so the focus follows a step that MOVED rather than staying on
  // whatever landed in its slot -- which is the one thing that makes reorder buttons usable from
  // the keyboard at all.

  interface FocusMark {
    readonly key: string
    readonly start: number | null
    readonly end: number | null
  }

  function captureFocus(): FocusMark | null {
    const active = doc.activeElement
    if (!(active instanceof HTMLElement) || !root.contains(active)) return null
    const holder = active.closest('[data-fkey]')
    if (!(holder instanceof HTMLElement)) return null
    const key = holder.dataset['fkey']
    if (key === undefined) return null
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      return { key, start: active.selectionStart, end: active.selectionEnd }
    }
    return { key, start: null, end: null }
  }

  function restoreFocus(mark: FocusMark | null): void {
    if (mark === null) return
    const holder = root.querySelector(`[data-fkey="${cssEscape(mark.key)}"]`)
    if (!(holder instanceof HTMLElement)) return
    holder.focus()
    if ((holder instanceof HTMLInputElement || holder instanceof HTMLTextAreaElement) && mark.start !== null) {
      try {
        holder.setSelectionRange(mark.start, mark.end ?? mark.start)
      } catch {
        // Some input types refuse a selection range. The focus is the part that matters and it is
        // already restored.
      }
    }
  }

  /** Enough of CSS.escape for the keys built here, which are ASCII words, digits and separators. */
  function cssEscape(value: string): string {
    return value.replace(/["\\]/g, '\\$&')
  }

  // ---- the commit path -----------------------------------------------------

  function callValidate(
    spec: CompoundSpec<unknown>,
    params: unknown,
  ): { readonly ok: true; readonly params: unknown } | { readonly ok: false; readonly refusal: Refusal } {
    try {
      return spec.validate(params)
    } catch {
      return {
        ok: false,
        refusal: {
          code: 'params-malformed',
          reason: `The ${source.kind} settings could not be checked -- validating them raised an error, so nothing was changed.`,
          nodes: [source.identifier],
        },
      }
    }
  }

  /**
   * One edit.
   *
   * The compound's own spec decides. On a refusal the DRAFT keeps what was typed -- the author has
   * to be able to see and repair the text that caused it -- the refusal is rendered, and `onChange`
   * is not called, so a host never receives parameters the compound already rejected.
   */
  function commit(params: unknown, label: string): void {
    if (disposed) return
    const previous = draft
    const checked = callValidate(options.spec, params)
    if (!checked.ok) {
      draft = params
      refusal = checked.refusal
      pendingOrder = null
      rebuild()
      options.onRefuse?.(checked.refusal)
      return
    }
    if (options.formatVersion !== undefined) {
      const expanded = callExpand(checked.params, options.formatVersion)
      if (expanded !== null) {
        draft = params
        refusal = expanded
        pendingOrder = null
        rebuild()
        options.onRefuse?.(expanded)
        return
      }
    }
    draft = checked.params
    refusal = null
    pendingOrder = null
    rebuild()
    options.onChange({ kind: source.kind, identifier: source.identifier, params: checked.params, previous, label })
  }

  /** The expansion refusal, or null. Never throws: a spec that does is a refusal of its own. */
  function callExpand(params: unknown, formatVersion: string): Refusal | null {
    try {
      const result = options.spec.expand(source.identifier, params, formatVersion)
      return result.ok ? null : result.refusal
    } catch {
      return {
        code: 'params-malformed',
        reason: `The ${source.kind} settings could not be expanded -- building the subgraph from them raised an error, so nothing was changed.`,
        nodes: [source.identifier],
      }
    }
  }

  // ---- small DOM helpers ---------------------------------------------------

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag)
    if (className !== undefined) node.className = className
    if (content !== undefined) node.textContent = content
    return node
  }

  function hint(content: string, strong = false): HTMLElement {
    return el('p', strong ? 'flcf-hint flcf-hint-strong' : 'flcf-hint', content)
  }

  function button(label: string, ariaLabel: string, onClick: () => void, opts?: { quiet?: boolean; disabled?: boolean }): HTMLButtonElement {
    const node = el('button', opts?.quiet === true ? 'flcf-button flcf-button-quiet' : 'flcf-button', label)
    node.type = 'button'
    node.setAttribute('aria-label', ariaLabel)
    if (opts?.disabled === true) node.disabled = true
    else node.addEventListener('click', onClick)
    return node
  }

  function section(title: string, children: readonly HTMLElement[]): HTMLElement {
    const node = el('section', 'flcf-section')
    const heading = el('h3', 'flcf-section-title', title)
    node.append(heading, ...children)
    node.setAttribute('aria-label', title)
    return node
  }

  interface FieldOptions {
    readonly label: string
    readonly fkey: string
    readonly value: string
    readonly required?: boolean
    readonly placeholder?: string
    readonly hint?: string
    readonly multiline?: boolean
    readonly onCommit: (value: string) => void
  }

  /**
   * A labelled free-text box.
   *
   * Free text is not a shortcut. Every Molang-valued parameter in the contract is a full expression
   * evaluated against a shared scope, and the parameters that are not Molang (a feature reference, a
   * variable name) are not numbers either. `change` rather than `input`: a commit round-trips
   * through the host and comes back as a fresh panel, and doing that per keystroke would fight the
   * person typing.
   */
  function field(opts: FieldOptions): HTMLElement {
    const wrap = el('div', 'flcf-field')
    const set = opts.value.trim() !== ''
    wrap.dataset['state'] = set ? 'set' : 'unset'
    wrap.dataset['field'] = opts.fkey

    const id = nextId()
    const label = el('label', 'flcf-label', opts.label)
    label.htmlFor = id
    if (opts.required === true) {
      const star = el('span', 'flcf-req', ' *')
      star.title = 'Required'
      label.append(star)
    }
    wrap.append(label)

    const control = opts.multiline === true ? el('textarea', 'flcf-area') : el('input', 'flcf-input')
    if (control instanceof HTMLInputElement) {
      control.type = 'text'
      control.spellcheck = false
    } else {
      control.spellcheck = false
      control.rows = 2
    }
    control.id = id
    control.value = opts.value
    control.dataset['fkey'] = opts.fkey
    if (opts.placeholder !== undefined) control.placeholder = opts.placeholder
    control.addEventListener('change', () => opts.onCommit(control.value))
    wrap.append(control)

    if (opts.hint !== undefined) wrap.append(hint(opts.hint))
    return wrap
  }

  interface SelectOption {
    readonly value: string
    readonly label: string
  }

  function selectField(opts: {
    label: string
    fkey: string
    value: string
    options: readonly SelectOption[]
    hint?: string
    onCommit: (value: string) => void
  }): HTMLElement {
    const wrap = el('div', 'flcf-field')
    wrap.dataset['state'] = opts.value === '' ? 'unset' : 'set'
    wrap.dataset['field'] = opts.fkey
    const id = nextId()
    const label = el('label', 'flcf-label', opts.label)
    label.htmlFor = id
    const select = el('select', 'flcf-select')
    select.id = id
    select.dataset['fkey'] = opts.fkey
    for (const option of opts.options) {
      const node = doc.createElement('option')
      node.value = option.value
      node.textContent = option.label
      select.append(node)
    }
    select.value = opts.value
    select.addEventListener('change', () => opts.onCommit(select.value))
    wrap.append(label, select)
    if (opts.hint !== undefined) wrap.append(hint(opts.hint))
    return wrap
  }

  interface ItemOptions {
    readonly ordinal: string
    readonly position: string
    readonly moveUp: (() => void) | null
    readonly moveDown: (() => void) | null
    readonly remove: () => void
    readonly moveUpLabel: string
    readonly moveDownLabel: string
    readonly removeLabel: string
  }

  /**
   * One element of an ordered list, with its position stated and its move controls beside it.
   *
   * The ordinal and the sentence under it are both drawn because the number alone does not say what
   * the order MEANS -- in a steps node it is execution order, and an author who has to work that out from the arrows is being asked to remember the
   * contract rather than read it.
   */
  function listItem(opts: ItemOptions, body: readonly HTMLElement[]): HTMLElement {
    const item = el('fieldset', 'flcf-item')
    const head = el('div', 'flcf-item-head')
    const legend = el('legend', 'flcf-ordinal', opts.ordinal)
    head.append(el('span', 'flcf-position', opts.position))
    const actions = el('div', 'flcf-item-actions')
    actions.append(
      button('\u2191', opts.moveUpLabel, opts.moveUp ?? (() => undefined), { quiet: true, disabled: opts.moveUp === null }),
      button('\u2193', opts.moveDownLabel, opts.moveDown ?? (() => undefined), { quiet: true, disabled: opts.moveDown === null }),
      button('Remove', opts.removeLabel, opts.remove, { quiet: true }),
    )
    head.append(actions)
    item.append(legend, head, ...body)
    return item
  }

  function renderRefusal(value: Refusal): HTMLElement {
    const node = el('p', 'flcf-refusal')
    node.setAttribute('role', 'alert')
    node.append(el('span', 'flcf-refusal-label', 'Refused. '), doc.createTextNode(value.reason), doc.createTextNode(' '))
    node.append(el('span', 'flcf-refusal-code', `(${value.code})`))
    return node
  }

  function note(content: string, warning = false): HTMLElement {
    return el('p', warning ? 'flcf-note flcf-note-warning' : 'flcf-note', content)
  }

  // ---- loop ----------------------------------------------------------------

  function renderLoop(): HTMLElement[] {
    const model = readLoopDraft(draft)
    const parts: HTMLElement[] = []
    const stepAxis = stepAxisOf(model.coordinateEvalOrder)

    parts.push(
      section('What runs, and how often', [
        field({
          label: 'Count',
          fkey: 'count',
          value: model.count,
          required: true,
          placeholder: 'math.random_integer(2, 5)',
          hint: 'Molang, evaluated once. It is an expression and not a number on purpose: a count of 0 is how a branch is skipped.',
          onCommit: (value) => commit(writeLoopDraft({ ...model, count: value }), 'Change the count'),
        }),
        field({
          label: 'Places',
          fkey: 'places',
          value: model.places,
          required: true,
          placeholder: 'example:oak_tree',
          hint: 'The feature each iteration places.',
          onCommit: (value) => commit(writeLoopDraft({ ...model, places: value }), 'Change what the loop places'),
        }),
        field({
          label: 'Setup script',
          fkey: 'setup',
          value: model.setup,
          multiline: true,
          placeholder: 'v.i = 0;',
          hint: 'Molang that runs once, before the first iteration. Leave it empty for none.',
          onCommit: (value) => commit(writeLoopDraft({ ...model, setup: value }), 'Change the setup script'),
        }),
      ]),
    )

    // THE COUPLED PAIR. The order and the script are one control, in one box, because the script is
    // written into whichever axis the order names first -- there is no field in the generated file
    // called `step`. Changing the order here moves the script, and the box says which axis it is in
    // both before and after.
    const coupled = el('fieldset', 'flcf-coupled')
    coupled.append(el('legend', 'flcf-coupled-legend', 'Evaluation order and the per-iteration script'))
    coupled.append(
      hint(
        'These two are one setting. The script runs in whichever coordinate is evaluated FIRST, so changing the order ' +
          'moves it -- which is why you cannot change one without seeing the other.',
      ),
    )
    coupled.append(
      selectField({
        label: 'coordinate_eval_order',
        fkey: 'coordinateEvalOrder',
        value: model.coordinateEvalOrder,
        options: [
          { value: '', label: `Not written -- evaluated as ${DEFAULT_COORDINATE_EVAL_ORDER}` },
          ...COORDINATE_EVAL_ORDERS.map((order) => ({ value: order, label: order })),
        ],
        hint: `Leaving it out is not the same as writing it: an absent order is evaluated as ${DEFAULT_COORDINATE_EVAL_ORDER}.`,
        onCommit: (value) =>
          commit(
            writeLoopDraft({ ...model, coordinateEvalOrder: value }),
            describeStepMove(model.coordinateEvalOrder, value, model.step.trim() !== ''),
          ),
      }),
    )
    coupled.append(
      el(
        'p',
        'flcf-carries',
        model.step.trim() === ''
          ? `No script yet. One written here would run in ${stepAxis}, the first coordinate this order evaluates.`
          : `The script below runs in ${stepAxis}, the first coordinate this order evaluates.`,
      ),
    )
    coupled.append(
      field({
        label: `Per-iteration script (runs in ${stepAxis})`,
        fkey: 'step',
        value: model.step,
        multiline: true,
        placeholder: 'v.i = v.i + 1;',
        hint: `Molang that runs at the top of every iteration. It is written in front of the ${stepAxis} coordinate, so it needs to end in ";".`,
        onCommit: (value) => commit(writeLoopDraft({ ...model, step: value }), 'Change the per-iteration script'),
      }),
    )
    parts.push(section('Iteration', [coupled]))

    const axes: readonly Axis[] = ['x', 'y', 'z']
    const axisFields: HTMLElement[] = axes.map((axis) => {
      const node = field({
        label: axis,
        fkey: `axis.${axis}`,
        value: model[axis],
        placeholder: '0',
        hint:
          axis === stepAxis
            ? `Molang. This is the first coordinate evaluated, so the per-iteration script above runs here first and this value is what it returns. An empty axis returns 0.`
            : 'Molang. An axis nobody writes is a zero-width axis at the origin.',
        onCommit: (value) => commit(writeLoopDraft({ ...model, [axis]: value } as LoopDraft), `Change the ${axis} coordinate`),
      })
      if (axis === stepAxis) {
        const label = node.querySelector('.flcf-label')
        if (label instanceof HTMLElement) label.append(el('span', 'flcf-axis-mark', ' carries the script'))
        node.dataset['carries'] = 'step'
      }
      return node
    })
    parts.push(section('Coordinates', axisFields))

    parts.push(
      section('Placement', [
        field({
          label: 'scatter_chance',
          fkey: 'scatterChance',
          value: model.scatterChance,
          placeholder: 'not written',
          hint: 'A bare number here is a PERCENT: 1.5 means 1.5%, not 150%. Leave it empty to not write the key.',
          onCommit: (value) => commit(writeLoopDraft({ ...model, scatterChance: value }), 'Change the scatter chance'),
        }),
        selectField({
          label: 'project_input_to_floor',
          fkey: 'projectInputToFloor',
          value: model.projectInputToFloor === undefined ? '' : String(model.projectInputToFloor),
          options: [
            { value: '', label: 'Not written' },
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ],
          hint: 'Three states, not two: not written is its own answer and is not the same as writing false.',
          onCommit: (value) =>
            commit(
              writeLoopDraft({ ...model, projectInputToFloor: value === '' ? undefined : value === 'true' }),
              value === '' ? 'Stop writing project_input_to_floor' : `Set project_input_to_floor to ${value}`,
            ),
        }),
      ]),
    )
    return parts
  }

  // ---- steps ---------------------------------------------------------------

  function renderSteps(): HTMLElement[] {
    const model = readStepsDraft(draft)
    const parts: HTMLElement[] = []

    parts.push(
      note(
        'Every step runs at the same position, in this order, and one that fails does not stop the rest. ' +
          'Moving a step changes the order things are placed in.',
      ),
    )

    const items: HTMLElement[] = model.steps.map((step, index) => {
      const total = model.steps.length
      const moveTo = (to: number, how: string): void =>
        commit(writeStepsDraft({ ...model, steps: moveInList(model.steps, index, to) }), `Move step ${index + 1} ${how}`)
      return listItem(
        {
          ordinal: String(index + 1),
          position: describeStepPosition(index, total),
          moveUp: index === 0 ? null : () => moveTo(index - 1, 'earlier'),
          moveDown: index === total - 1 ? null : () => moveTo(index + 1, 'later'),
          remove: () => commit(writeStepsDraft({ ...model, steps: model.steps.filter((_, i) => i !== index) }), `Remove step ${index + 1}`),
          moveUpLabel: `Move step ${index + 1} before step ${index}`,
          moveDownLabel: `Move step ${index + 1} after step ${index + 2}`,
          removeLabel: `Remove step ${index + 1}`,
        },
        [
          field({
            label: 'Places',
            fkey: `step.${index}`,
            value: step,
            required: true,
            placeholder: 'example:oak_tree',
            hint: 'The feature this step places.',
            onCommit: (value) =>
              commit(
                writeStepsDraft({ ...model, steps: model.steps.map((each, i) => (i === index ? value : each)) }),
                `Change step ${index + 1}`,
              ),
          }),
        ],
      )
    })

    const list = el('div', 'flcf-list')
    if (items.length === 0) {
      list.append(el('p', 'flcf-empty', 'No steps yet. A steps node with none has nothing to run and cannot be expanded.'))
    } else {
      list.append(...items)
    }
    list.append(button('Add a step', 'Add a step at the end of the list', () => commit(writeStepsDraft({ ...model, steps: [...model.steps, ''] }), 'Add a step')))
    parts.push(section(`Steps -- ${model.steps.length} in order`, [list]))

    parts.push(
      section('Setup', [
        field({
          label: 'Setup script',
          fkey: 'setup',
          value: model.setup,
          multiline: true,
          placeholder: 'v.attempt = 0;',
          hint: 'Molang that runs once, before the first step. Leave it empty for none.',
          onCommit: (value) => commit(writeStepsDraft({ ...model, setup: value }), 'Change the setup script'),
        }),
      ]),
    )
    return parts
  }

  // ---- placement guard -----------------------------------------------------

  /** The faces the attachment test is asked about, in the engine's own order. */
  const ATTACH_FACES: readonly string[] = ['top', 'bottom', 'north', 'east', 'south', 'west', 'sides', 'all', 'diagonal']

  function blockControl(opts: {
    label: string
    fkey: string
    view: BlockView
    hint?: string
    onCommit: (view: BlockView) => void
    onRemove?: () => void
  }): HTMLElement {
    const wrap = el('div', 'flcf-field')
    wrap.dataset['state'] = opts.view.name.trim() === '' ? 'unset' : 'set'
    wrap.dataset['field'] = opts.fkey
    const id = nextId()
    const head = el('div', 'flcf-line')
    const label = el('label', 'flcf-label', opts.label)
    label.htmlFor = id
    head.append(label)
    if (opts.onRemove !== undefined) head.append(button('Remove', `Remove ${opts.label}`, opts.onRemove, { quiet: true }))
    wrap.append(head)

    const name = el('input', 'flcf-input')
    name.type = 'text'
    name.id = id
    name.spellcheck = false
    name.value = opts.view.name
    name.placeholder = 'minecraft:stone'
    name.dataset['fkey'] = `${opts.fkey}.name`
    name.setAttribute('aria-label', `${opts.label}: block name`)
    name.addEventListener('change', () => opts.onCommit({ ...opts.view, name: name.value }))
    wrap.append(name)
    if (opts.hint !== undefined) wrap.append(hint(opts.hint))

    for (const [index, pair] of opts.view.states.entries()) {
      const [stateKey, stateValue] = pair
      const line = el('div', 'flcf-line')
      const keyBox = el('input', 'flcf-input')
      keyBox.type = 'text'
      keyBox.value = stateKey
      keyBox.spellcheck = false
      keyBox.placeholder = 'state'
      keyBox.dataset['fkey'] = `${opts.fkey}.state.${index}.key`
      keyBox.setAttribute('aria-label', `${opts.label}: name of block state ${index + 1}`)
      keyBox.addEventListener('change', () =>
        opts.onCommit({
          ...opts.view,
          states: opts.view.states.map((each, i) => (i === index ? ([keyBox.value, each[1]] as const) : each)),
        }),
      )
      const valueBox = el('input', 'flcf-input')
      valueBox.type = 'text'
      valueBox.value = formatStateValue(stateValue)
      valueBox.spellcheck = false
      valueBox.placeholder = 'value'
      valueBox.dataset['fkey'] = `${opts.fkey}.state.${index}.value`
      valueBox.setAttribute('aria-label', `${opts.label}: value of block state ${index + 1}`)
      valueBox.addEventListener('change', () =>
        opts.onCommit({
          ...opts.view,
          states: opts.view.states.map((each, i) => (i === index ? ([each[0], parseStateValue(valueBox.value)] as const) : each)),
        }),
      )
      line.append(
        keyBox,
        valueBox,
        button('Remove', `Remove block state ${index + 1} of ${opts.label}`, () => opts.onCommit({ ...opts.view, states: opts.view.states.filter((_, i) => i !== index) }), {
          quiet: true,
        }),
      )
      wrap.append(line)
    }
    wrap.append(
      button('Add a block state', `Add a block state to ${opts.label}`, () => opts.onCommit({ ...opts.view, states: [...opts.view.states, ['', ''] as const] }), {
        quiet: true,
      }),
    )
    return wrap
  }

  function renderAttachMap(
    model: GuardDraft,
    which: 'mayAttachTo' | 'mayNotAttachTo',
    title: string,
    explain: string,
  ): HTMLElement {
    const map = model[which]
    const body: HTMLElement[] = [hint(explain)]

    if (map === null) {
      body.push(
        button(`Add ${title.toLowerCase()}`, `Add the ${title.toLowerCase()} to this guard`, () =>
          commit(writeGuardDraft({ ...model, [which]: { faces: [['top', []]] } } as GuardDraft), `Add ${title.toLowerCase()}`),
        ),
      )
      return section(title, body)
    }

    for (const [index, entry] of map.faces.entries()) {
      const [face, value] = entry
      const replaceFace = (next: readonly (readonly [string, unknown])[], label: string): void =>
        commit(writeGuardDraft({ ...model, [which]: { faces: next } } as GuardDraft), label)

      const item = el('fieldset', 'flcf-item')
      const head = el('div', 'flcf-item-head')
      item.append(el('legend', 'flcf-ordinal', face))
      head.append(
        button('Remove', `Remove the ${face} test`, () => replaceFace(map.faces.filter((_, i) => i !== index), `Remove the ${face} test`), {
          quiet: true,
        }),
      )
      item.append(head)

      if (face === 'min_sides_must_attach' || face === 'auto_rotate') {
        // Not a face: these two ride in the same object and are a count and a flag.
        if (face === 'auto_rotate') {
          item.append(
            selectField({
              label: 'auto_rotate',
              fkey: `${which}.${face}`,
              value: typeof value === 'boolean' ? String(value) : '',
              options: [
                { value: '', label: 'Not written' },
                { value: 'true', label: 'true' },
                { value: 'false', label: 'false' },
              ],
              hint: 'Absent behaves as true, so leaving it out and writing false are different files.',
              onCommit: (next) =>
                replaceFace(
                  next === ''
                    ? map.faces.filter((_, i) => i !== index)
                    : map.faces.map((each, i) => (i === index ? ([each[0], next === 'true'] as const) : each)),
                  'Change auto_rotate',
                ),
            }),
          )
        } else {
          item.append(
            field({
              label: 'min_sides_must_attach',
              fkey: `${which}.${face}`,
              value: typeof value === 'number' ? String(value) : text(value),
              hint: 'Only the four cardinal sides count against this.',
              onCommit: (next) => {
                const parsed = numberOrText(next)
                replaceFace(
                  parsed === undefined
                    ? map.faces.filter((_, i) => i !== index)
                    : map.faces.map((each, i) => (i === index ? ([each[0], parsed] as const) : each)),
                  parsed === undefined ? 'Stop writing min_sides_must_attach' : 'Change min_sides_must_attach',
                )
              },
            }),
          )
        }
        body.push(item)
        continue
      }

      const blocks = Array.isArray(value) ? value : value === undefined ? [] : [value]
      const drawable = blocks.every((block) => typeof block === 'string' || isRecord(block))
      if (!drawable) {
        // A shape this panel has no control for. It is shown, read-only, and kept byte for byte --
        // NOT dropped into an editable JSON box, which would be this module giving up and calling it
        // a feature. The honest answer is to say which key it is and leave it alone.
        const unmodelled = el('div', 'flcf-unmodelled')
        unmodelled.append(hint(`This editor has no control for what "${face}" holds, so it is shown as written and left untouched.`, true))
        unmodelled.append(el('div', 'flcf-value', JSON.stringify(value)))
        item.append(unmodelled)
        body.push(item)
        continue
      }

      const views = blocks.map((block) => readBlockValue(block))
      views.forEach((view, blockIndex) => {
        item.append(
          blockControl({
            label: `Block ${blockIndex + 1}`,
            fkey: `${which}.${face}.${blockIndex}`,
            view,
            onCommit: (next) =>
              replaceFace(
                map.faces.map((each, i) =>
                  i === index
                    ? ([each[0], views.map((v, j) => (j === blockIndex ? blockSpecOf(next) : blockSpecOf(v))).filter((s) => s !== undefined)] as const)
                    : each,
                ),
                `Change a block of the ${face} test`,
              ),
            onRemove: () =>
              replaceFace(
                map.faces.map((each, i) =>
                  i === index
                    ? ([each[0], views.filter((_, j) => j !== blockIndex).map((v) => blockSpecOf(v)).filter((s) => s !== undefined)] as const)
                    : each,
                ),
                `Remove a block from the ${face} test`,
              ),
          }),
        )
      })
      if (views.length === 0) item.append(el('p', 'flcf-empty', 'No blocks named yet, so this face matches nothing.'))
      item.append(
        button('Add a block', `Add a block to the ${face} test`, () =>
          replaceFace(
            map.faces.map((each, i) =>
              i === index ? ([each[0], [...views.map((v) => blockSpecOf(v)).filter((s) => s !== undefined), 'minecraft:stone']] as const) : each,
            ),
            `Add a block to the ${face} test`,
          ),
        ),
      )
      body.push(item)
    }

    const used = new Set(map.faces.map(([face]) => face))
    const addable = [...ATTACH_FACES, 'min_sides_must_attach', 'auto_rotate'].filter((face) => !used.has(face))
    if (addable.length > 0) {
      const line = el('div', 'flcf-line')
      const select = el('select', 'flcf-select')
      select.dataset['fkey'] = `${which}.add`
      select.setAttribute('aria-label', `Which face to add to ${title.toLowerCase()}`)
      for (const face of addable) {
        const option = doc.createElement('option')
        option.value = face
        option.textContent = face
        select.append(option)
      }
      line.append(
        select,
        button('Add', `Add the selected face to ${title.toLowerCase()}`, () => {
          const face = select.value
          const seed: unknown = face === 'auto_rotate' ? true : face === 'min_sides_must_attach' ? 4 : []
          commit(writeGuardDraft({ ...model, [which]: { faces: [...map.faces, [face, seed] as const] } } as GuardDraft), `Add the ${face} test`)
        }),
      )
      body.push(line)
    }
    body.push(
      button(`Remove ${title.toLowerCase()}`, `Remove the whole ${title.toLowerCase()}`, () =>
        commit(writeGuardDraft({ ...model, [which]: null } as GuardDraft), `Remove ${title.toLowerCase()}`),
      ),
    )
    return section(title, body)
  }

  function renderGuard(): HTMLElement[] {
    const model = readGuardDraft(draft)
    const parts: HTMLElement[] = []

    // What this compound IS. The probe is a QUESTION, not a build: block placement predicates are
    // the only way to ask whether a position satisfies an attachment test, so the guard places a
    // throwaway block to run the test and deletes it again. A form that called it "the block this
    // builds" would be describing something the author never asked for, and would teach them to
    // expect that block to survive -- which it never does.
    parts.push(
      note(
        'This is a test, not a build. The probe block is placed only to ask whether the position passes the block ' +
          'predicates below, and it is removed immediately afterwards -- nothing it writes survives. Your feature is ' +
          'placed only where the test passed.',
      ),
    )

    parts.push(
      section('What is placed', [
        field({
          label: 'Places',
          fkey: 'places',
          value: model.places,
          required: true,
          placeholder: 'example:vine_patch',
          hint: 'The feature placed where the test passes.',
          onCommit: (value) => commit(writeGuardDraft({ ...model, places: value }), 'Change what the guard places'),
        }),
        field({
          label: 'Init',
          fkey: 'init',
          value: model.init,
          placeholder: 'example:clear_the_spot',
          hint: 'An optional feature that runs before the test. Leave it empty for none.',
          onCommit: (value) => commit(writeGuardDraft({ ...model, init: value }), value.trim() === '' ? 'Remove the init feature' : 'Change the init feature'),
        }),
      ]),
    )

    const probe: HTMLElement[] = []
    if (model.probeBlock === null) {
      probe.push(hint('Not written, so the test runs with the default probe block. It is placed to run the test and removed again.'))
      probe.push(
        button('Choose a probe block', 'Write an explicit probe block', () =>
          commit(writeGuardDraft({ ...model, probeBlock: { spelling: 'name', name: 'minecraft:bedrock', states: [], tags: '' } }), 'Choose a probe block'),
        ),
      )
    } else {
      probe.push(
        blockControl({
          label: 'Probe block',
          fkey: 'probeBlock',
          view: model.probeBlock,
          hint: 'Placed to run the test, then removed. It never survives, so it is not part of what you are building.',
          onCommit: (view) => commit(writeGuardDraft({ ...model, probeBlock: view }), 'Change the probe block'),
          onRemove: () => commit(writeGuardDraft({ ...model, probeBlock: null }), 'Stop writing a probe block'),
        }),
      )
    }
    parts.push(section('The probe', probe))

    const replace: HTMLElement[] = [
      hint('The test passes at a position where the block already there is one of these. An empty list does not test replacement.'),
    ]
    model.mayReplace.forEach((view, index) => {
      replace.push(
        blockControl({
          label: `Block ${index + 1}`,
          fkey: `mayReplace.${index}`,
          view,
          onCommit: (next) => commit(writeGuardDraft({ ...model, mayReplace: model.mayReplace.map((each, i) => (i === index ? next : each)) }), 'Change a replaceable block'),
          onRemove: () => commit(writeGuardDraft({ ...model, mayReplace: model.mayReplace.filter((_, i) => i !== index) }), 'Remove a replaceable block'),
        }),
      )
    })
    replace.push(
      button('Add a block', 'Add a block the probe may replace', () =>
        commit(
          writeGuardDraft({ ...model, mayReplace: [...model.mayReplace, { spelling: 'name', name: 'minecraft:air', states: [], tags: '' }] }),
          'Add a replaceable block',
        ),
      ),
    )
    parts.push(section('May replace', replace))

    parts.push(
      renderAttachMap(
        model,
        'mayAttachTo',
        'Must attach to',
        'The test passes only where the named faces touch one of these blocks.',
      ),
    )
    parts.push(
      renderAttachMap(
        model,
        'mayNotAttachTo',
        'Must not attach to',
        'The test fails where the named faces touch one of these blocks.',
      ),
    )
    return parts
  }

  // ---- column --------------------------------------------------------------

  function renderColumn(): HTMLElement[] {
    const model = readColumnDraft(draft)
    const parts: HTMLElement[] = []
    const order: ColumnOrder = model.order === '' ? 'top-down' : model.order
    const allowed = columnFieldsFor(model.order)

    parts.push(
      section('What is placed, and between which levels', [
        field({
          label: 'Places',
          fkey: 'places',
          value: model.places,
          required: true,
          placeholder: 'example:vine_block',
          hint: 'The feature put at every level.',
          onCommit: (value) => commit(writeColumnDraft({ ...model, places: value }), 'Change what the column places'),
        }),
        field({
          label: 'Lowest level (minY)',
          fkey: 'minY',
          value: model.minY,
          placeholder: '0',
          hint: 'Molang. Included. Leave it empty for 0.',
          onCommit: (value) => commit(writeColumnDraft({ ...model, minY: value }), 'Change the lowest level'),
        }),
        field({
          label: 'Stop below (maxY)',
          fkey: 'maxY',
          value: model.maxY,
          required: true,
          placeholder: '6',
          hint:
            'Molang. NOT included -- the range is half-open, so the highest level placed is one below this. ' +
            'minY 0 and maxY 6 places six levels, 0 through 5.',
          onCommit: (value) => commit(writeColumnDraft({ ...model, maxY: value }), 'Change the upper bound'),
        }),
        field({
          label: 'Setup script',
          fkey: 'setup',
          value: model.setup,
          multiline: true,
          placeholder: 'v.grown = 0;',
          hint: 'Molang that runs once, before the first level. Leave it empty for none.',
          onCommit: (value) => commit(writeColumnDraft({ ...model, setup: value }), 'Change the setup script'),
        }),
      ]),
    )

    // THE ORDER. Not cosmetic: the direction decides which placement wins an overlapping cell, the
    // order the levels draw random numbers, and the position the whole thing reports back. Each
    // option says what it gets you and what it costs, because from the outside the two look like the
    // same column.
    const choice = el('fieldset', 'flcf-choice')
    choice.append(el('legend', 'flcf-choice-legend', 'order'))
    choice.append(
      hint(
        'Two different worlds, not a preference: the direction decides which placement wins where levels overlap and in ' +
          'what order the levels draw their random numbers.',
      ),
    )
    const groupName = nextId()
    const options: readonly { value: ColumnOrder; why: string }[] = [
      {
        value: 'top-down',
        why: 'Builds from the top level down. Nothing runs per level, so the placed feature cannot be told which level it is on.',
      },
      {
        value: 'bottom-up',
        why: 'Builds from the bottom level up, counting as it goes. Only this one can name the level for the placed feature to read.',
      },
    ]
    for (const option of options) {
      const wrap = el('label', 'flcf-option')
      wrap.dataset['checked'] = order === option.value ? 'yes' : 'no'
      const radio = el('input')
      radio.type = 'radio'
      radio.name = groupName
      radio.value = option.value
      radio.checked = order === option.value
      radio.dataset['fkey'] = `order.${option.value}`
      radio.addEventListener('change', () => {
        if (!radio.checked) return
        const lost = columnOrderSwitchLoss(model, option.value)
        if (lost.length > 0) {
          // Never silently. The spec refuses these fields outside the counter shape rather than
          // flipping the order to suit them; dropping them here without saying so would be the same
          // invisible change from the other direction.
          pendingOrder = option.value
          rebuild()
          return
        }
        commit(writeColumnDraft(columnWithOrder(model, option.value)), `Build the column ${option.value}`)
      })
      const body = el('div', 'flcf-option-body')
      body.append(el('span', 'flcf-option-name', option.value), el('span', 'flcf-option-why', option.why))
      wrap.append(radio, body)
      choice.append(wrap)
    }
    if (model.order === '') {
      choice.append(hint('Not written. An absent order builds top-down; choosing it here writes the key.'))
    }
    if (pendingOrder !== null) {
      const lost = columnOrderSwitchLoss(model, pendingOrder)
      const warn = el('div', 'flcf-note flcf-note-warning')
      warn.setAttribute('role', 'alert')
      const one = lost.length === 1
      warn.append(
        doc.createTextNode(
          `A ${pendingOrder} column has no per-level counter, so ${lost.join(' and ')} cannot come with it. ` +
            `Switching discards ${one ? 'that setting' : 'those settings'}, and nothing here can put ${one ? 'it' : 'them'} back.`,
        ),
      )
      const confirm = pendingOrder
      warn.append(
        button(
          `Switch to ${confirm} and drop ${lost.join(' and ')}`,
          `Switch to ${confirm}, discarding ${lost.join(' and ')}`,
          () => commit(writeColumnDraft(columnWithOrder(model, confirm)), `Build the column ${confirm}, dropping ${lost.join(' and ')}`),
        ),
      )
      warn.append(
        button('Keep it as it is', 'Cancel the order change', () => {
          pendingOrder = null
          rebuild()
        }, { quiet: true }),
      )
      choice.append(warn)
    }
    parts.push(section('Direction', [choice]))

    // The two counter-shape fields. Not offered in the other shape, because the spec refuses them
    // there -- a control that is drawn only to bounce is a control that teaches people to distrust
    // the panel. What stands in their place is the reason.
    if (allowed.levelVariable || allowed.step) {
      parts.push(
        section('Per-level', [
          field({
            label: 'Level variable',
            fkey: 'levelVariable',
            value: model.levelVariable,
            placeholder: 'level',
            hint: 'The name the placed feature reads to find out which level it is on. A bare name gets the variable prefix.',
            onCommit: (value) => commit(writeColumnDraft({ ...model, levelVariable: value }), 'Change the level variable'),
          }),
          field({
            label: 'Per-level script',
            fkey: 'step',
            value: model.step,
            multiline: true,
            placeholder: 'v.grown = v.grown + 1;',
            hint: 'Molang that runs once per level, before the feature is placed there.',
            onCommit: (value) => commit(writeColumnDraft({ ...model, step: value }), 'Change the per-level script'),
          }),
        ]),
      )
    } else {
      parts.push(
        section('Per-level', [
          hint(
            'Nothing runs per level in a top-down column: its levels are a distribution rather than a loop, so there is no ' +
              'counter to name and no slot to run a script in. Build the column bottom-up to get both.',
            true,
          ),
        ]),
      )
    }
    return parts
  }

  // ---- assembly ------------------------------------------------------------

  function rebuild(): void {
    if (disposed) return
    const mark = captureFocus()
    const parts: HTMLElement[] = []

    const header = el('header', 'flcf-section')
    header.append(el('h2', 'flcf-title', source.title ?? source.kind))
    header.append(el('div', 'flcf-kind', `${source.kind} -- ${source.identifier}`))
    if (options.file !== undefined) header.append(el('div', 'flcf-meta', options.file))
    if (source.summary !== undefined && source.summary !== '') header.append(el('p', 'flcf-summary-line', source.summary))
    header.append(el('p', 'flcf-summary-line', kindNote(source.kind)))
    parts.push(header)

    if (source.formParams === null && refusal !== null) {
      parts.push(
        note(
          'These are the settings as the file records them. They are shown so you can repair them; until they are accepted ' +
            'nothing here is written.',
          true,
        ),
      )
    }
    if (refusal !== null) parts.push(renderRefusal(refusal))

    switch (source.kind) {
      case 'loop':
        parts.push(...renderLoop())
        break
      case 'steps':
        parts.push(...renderSteps())
        break
      case 'placement-guard':
        parts.push(...renderGuard())
        break
      case 'column':
        parts.push(...renderColumn())
        break
    }

    root.replaceChildren(...parts)
    restoreFocus(mark)
  }

  rebuild()

  return {
    element: root,
    get params(): unknown {
      return draft
    },
    get refusal(): Refusal | null {
      return refusal
    },
    update(next: CompoundFormSource): void {
      if (disposed) return
      source = next
      draft = next.formParams ?? next.rawParams ?? {}
      pendingOrder = null
      root.dataset['kind'] = next.kind
      const checked = callValidate(options.spec, draft)
      refusal = checked.ok ? null : checked.refusal
      rebuild()
    },
    dispose(): void {
      disposed = true
      // Every listener this module registers is on an element inside `root`, so dropping the
      // subtree drops them all; there is nothing on window or document to unhook.
      root.replaceChildren()
      root.remove()
    },
  }
}
