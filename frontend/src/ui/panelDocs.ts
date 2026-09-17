// panelDocs.ts -- the long form of every sidebar control, read by the `?` on each section head
// (see docs.ts for the panel that renders it, dom.ts's makeSection for the button).
//
// This is where the sidebar's explanatory prose went. A row is one line -- label and control --
// and its one-sentence explanation is the row's native tooltip; everything longer, and every
// standing fact about how the tool works ("a grown run is a different placement", "the sea
// slots do nothing under a preset with no sea", "budgets are per run, not settings"), lives
// here and only here. What stays in the panel itself is what is about THIS run.
//
// Computed on demand rather than declared once: the Environment section names the live preset
// list, and the Materials section names the preset that is selected right now and the ones
// that would honour the sea slots -- read off the same `environments` list the dropdown is
// built from, so the documentation can never name a preset the dropdown does not have.
import type { EnvironmentOptionWire } from '../protocol.js'
import { ENGINE_DEFAULT_DELEGATION_BUDGET, ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS, ENGINE_DEFAULT_WRITE_BUDGET } from '../protocol.js'
import { DOC_GLYPH, type DocEntry, type DocSection } from './docs.js'

export interface PanelDocsContext {
  environments: readonly EnvironmentOptionWire[]
  /** The selected preset's id. */
  env: string
  /** Whether this host wired the grow-and-regenerate action (PanelOptions.onGrowRegenerate). */
  canGrow: boolean
  /** Whether this host wired "Reload files" (PanelOptions.onReloadFiles). */
  canReload: boolean
}

const n = (v: number): string => v.toLocaleString('en-US')

/** The preset labels whose terrain builder models a sea, joined the way session.go joins its
 * own warning (" and "), so the two read as one voice. */
export function seaPresetLabels(environments: readonly EnvironmentOptionWire[]): string {
  const labels = environments.filter((e) => e.buildsSea).map((e) => e.label)
  return labels.length > 0 ? labels.join(' and ') : 'no preset in this list'
}

/** The one sentence a greyed-out sea slot carries as its own tooltip under a preset that builds
 * no sea -- names the preset and the ones that would honour it, and says the value is kept.
 * Exported so the Materials section and its test read the same sentence. */
export function inertSeaSlotTitle(presetLabel: string, environments: readonly EnvironmentOptionWire[]): string {
  return `Not sent: ${presetLabel} builds no sea (only ${seaPresetLabels(environments)} does) — the value is kept for when you switch back.`
}

const HOST_BADGE = (canDo: boolean, what: string) =>
  canDo ? [] : [{ kind: 'host' as const, label: 'not in this host', title: `${what} is not wired in this preview host yet, so the control is disabled.` }]

export function panelDocs(ctx: PanelDocsContext): DocSection[] {
  const preset = ctx.environments.find((e) => e.id === ctx.env)
  const presetLabel = preset?.label ?? ctx.env
  const seaPresets = seaPresetLabels(ctx.environments)

  const readout: DocSection = {
    id: 'readout',
    title: 'Result',
    intro: [
      'The three tiles are the run\'s own counts: blocks placed, blocks carved to air, and blocks replaced. They dim while a request is in flight, and a PARTIAL RESULT badge appears when a budget or the time limit cut the run short.',
    ],
    entries: [
      {
        name: 'Grow every run',
        glyph: DOC_GLYPH.toggle,
        kindLabel: 'toggle',
        badges: HOST_BADGE(ctx.canGrow, 'Grow to fit'),
        summary: 'Every regenerate grows the bench to fit whatever spilled outside it, then places again at the larger size.',
        detail: [
          'Sticky: it applies to every regenerate this panel drives, a save-triggered one included, until it is switched off. The bench is refit fresh from each run\'s own overflow, never frozen from an earlier grow.',
          'A grown run is a different placement -- different reads, possibly different RNG draws -- not the same result seen wider. The status line under the tiles says whether this particular run needed growing.',
          'This is a view preference, so it survives a new panel; the one-shot button below applies to exactly one request.',
        ],
      },
      {
        name: 'Grow to fit & regenerate',
        glyph: DOC_GLYPH.button,
        kindLabel: 'action',
        badges: HOST_BADGE(ctx.canGrow, 'Grow to fit'),
        summary: 'Grows the bench once to fit every out-of-bounds block the last run captured, then places again.',
        detail: [
          'Shown only while the current result has writes outside the bench. The very next regenerate reverts to the ungrown bench -- turn on "Grow every run" to keep it grown.',
        ],
      },
      {
        name: 'Writes outside the bench',
        glyph: DOC_GLYPH.readout,
        kindLabel: 'status',
        summary: 'How many writes landed outside the bench this run, and how many of them were captured.',
        detail: [
          'Captured blocks are drawn in magenta in the 3D view while the View section\'s "Show overflow" is on. Showing them changes nothing about what the feature did; only growing the bench does.',
        ],
      },
    ],
  }

  const feature: DocSection = {
    id: 'feature',
    title: 'Feature / Rule',
    entries: [
      {
        name: 'Preview',
        glyph: DOC_GLYPH.select,
        kindLabel: 'choice',
        summary: 'Preview one feature on its own, or a feature rule with its placement pass and conditions.',
        detail: ['The Feature and Rule pickers are populated from the loaded pack on every result; the opened file wins over whatever a previous panel had selected.'],
      },
      {
        name: 'Filter',
        glyph: DOC_GLYPH.text,
        kindLabel: 'text',
        summary: 'Narrows whichever list is visible to identifiers containing this text.',
      },
      {
        name: 'Feature',
        glyph: DOC_GLYPH.select,
        kindLabel: 'choice',
        summary: 'The feature the next run places; its type and file show on the line beneath.',
      },
      {
        name: 'Rule',
        glyph: DOC_GLYPH.select,
        kindLabel: 'choice',
        summary: 'The feature rule the next run evaluates; a rule that failed to build is greyed out.',
        detail: ['The line beneath names the feature the rule places and its placement pass.'],
      },
      {
        name: 'Origin X / Origin Z',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        summary: 'The placement origin\'s world X and Z; Y is the height the preset resolves.',
        detail: ['Sent only once either has been edited -- untouched, the preset chooses.'],
        facts: ['Blank: the preset\'s own origin'],
      },
      {
        name: 'Seed',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        summary: 'The world seed for the run; the same seed reproduces the same run.',
        detail: [
          'A placement can fail purely on luck -- a scatter_chance gate that did not roll -- and a different seed is the only way to act on that diagnostic. Random picks a new one and regenerates.',
        ],
        facts: ['Blank: the preset\'s default seed', '0 is a real seed, not "unset"'],
      },
      {
        name: 'Repeat count',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        summary: 'How many times the placement is attempted in one run.',
        facts: ['Accepted: 1 to 16'],
      },
      {
        name: 'Reload files',
        glyph: DOC_GLYPH.button,
        kindLabel: 'action',
        badges: HOST_BADGE(ctx.canReload, 'Reload files'),
        summary: 'Re-reads every feature, rule and biome file of the pack, then regenerates.',
      },
    ],
  }

  const environment: DocSection = {
    id: 'environment',
    title: 'Environment',
    intro: [
      'The bench: the preset terrain the feature is placed into, and its size. Changing the preset resets Size X/Y/Z and Min Y to that preset\'s own defaults; anything you type afterwards is kept until the next preset change.',
    ],
    entries: [
      {
        name: 'Preset',
        glyph: DOC_GLYPH.select,
        kindLabel: 'choice',
        summary: 'The terrain the feature is placed into, from the engine\'s own preset list.',
        detail:
          ctx.environments.length > 0
            ? ctx.environments.map((e) => `${e.label}: ${e.description}${e.buildsSea ? ' Builds a sea, so the Materials section\'s sea slots apply.' : ''}`)
            : ['The preset list has not arrived from the engine yet.'],
      },
      {
        name: 'Size X / Size Y / Size Z',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        summary: 'The bench\'s extent in blocks along each axis.',
        facts: ['Accepted: 4 to 512'],
      },
      {
        name: 'Min Y',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        summary: 'The bench floor in world Y, sent with the next request.',
        detail: ['Unrelated to the View section\'s "Min Y (cut)", which is a display-only slice of the result already on screen.'],
      },
    ],
  }

  const materials: DocSection = {
    id: 'materials',
    title: 'Materials',
    intro: [
      'The terrain\'s minecraft:surface_builder slots. What shows is what the engine will build: the selected pack biome\'s own materials when one is selected, else the preset\'s native ones; a value you type here wins per slot over either. Only slots you have edited are sent.',
      `Sea floor material, Sea material and Sea floor depth do nothing under a preset that builds no sea -- today only ${seaPresets} does: its water column, its seabed, and the sea floor band beneath it. Under any other preset those three are greyed out and held back from the request, so the engine never has to warn about them after the run. Anything typed in them is kept and sent again the moment a sea-building preset is selected.`,
      `Selected now: ${presetLabel}${preset === undefined ? '' : preset.buildsSea ? ' (builds a sea)' : ' (builds no sea)'}.`,
    ],
    entries: [
      { name: 'Top material', glyph: DOC_GLYPH.text, kindLabel: 'block', summary: 'surface_builder top_material: the surface layer of the terrain.' },
      { name: 'Mid material', glyph: DOC_GLYPH.text, kindLabel: 'block', summary: 'surface_builder mid_material: the layer under the surface.' },
      { name: 'Foundation material', glyph: DOC_GLYPH.text, kindLabel: 'block', summary: 'surface_builder foundation_material: everything beneath the mid layer.' },
      {
        name: 'Sea floor material',
        glyph: DOC_GLYPH.text,
        kindLabel: 'block',
        badges: [{ kind: 'inert', label: 'sea presets only', title: `Honoured only under ${seaPresets}.` }],
        summary: 'surface_builder sea_floor_material: the seabed band under the water column.',
      },
      {
        name: 'Sea material',
        glyph: DOC_GLYPH.text,
        kindLabel: 'block',
        badges: [{ kind: 'inert', label: 'sea presets only', title: `Honoured only under ${seaPresets}.` }],
        summary: 'surface_builder sea_material: the water column itself.',
      },
      {
        name: 'Sea floor depth',
        glyph: DOC_GLYPH.number,
        kindLabel: 'number',
        badges: [{ kind: 'inert', label: 'sea presets only', title: `Honoured only under ${seaPresets}.` }],
        summary: 'surface_builder sea_floor_depth: how deep the seabed band goes.',
      },
      {
        name: 'Reset to preset materials',
        glyph: DOC_GLYPH.button,
        kindLabel: 'action',
        summary: 'Clears every material override, the kept sea slots included; the preset\'s (or pack biome\'s) own materials come back.',
      },
    ],
  }

  const biome: DocSection = {
    id: 'biome',
    title: 'Biome',
    intro: [
      'Two independent knobs: a pack biome, which changes the terrain materials the preview builds, and a tags-only override of what the feature\'s biome queries see.',
    ],
    entries: [
      {
        name: 'Pack biome',
        glyph: DOC_GLYPH.select,
        kindLabel: 'choice',
        summary: 'A biome from the loaded pack, by identifier; its own surface_builder materials layer over the preset\'s.',
        detail: [
          'Precedence per slot: a Materials override you typed, then the selected pack biome, then the preset. A biome file that failed to parse is listed but greyed out. A selection the reloaded pack no longer defines is dropped.',
        ],
        facts: ['Blank: the preset\'s own biome and materials'],
      },
      {
        name: 'Biome tags',
        glyph: DOC_GLYPH.text,
        kindLabel: 'text',
        summary: 'Comma-separated tags for query.has_biome_tag / any_tag / all_tags, independent of the pack biome.',
        detail: ['Until edited it only shows the tags that are in effect -- the selected pack biome\'s, else the preset\'s -- and sends nothing.'],
      },
      {
        name: 'Clear (use preset defaults)',
        glyph: DOC_GLYPH.button,
        kindLabel: 'action',
        summary: 'Drops the pack biome and the tag override; the preset\'s own biome comes back.',
      },
    ],
  }

  const budget: DocSection = {
    id: 'budget',
    title: 'Budget',
    intro: [
      'Per-run placement budgets, not permanent settings. Raise one to get a single heavy feature through while you watch, then clear it again: a permanently raised limit only means an accidental infinite recursion grinds for a minute instead of failing fast. Every new panel starts with all three blank.',
      'Blank uses the engine\'s own default, shown as the field\'s placeholder; an OVERRIDE badge marks a field that will be sent. A budget diagnostic offers a one-click "double it and regenerate" in the Diagnostics section.',
    ],
    entries: [
      {
        name: 'Write budget',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        badges: [{ kind: 'default', label: `default ${n(ENGINE_DEFAULT_WRITE_BUDGET)}` }],
        summary: 'Maximum block writes before the run is aborted as a runaway, non-converging chain.',
      },
      {
        name: 'Delegation budget',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        badges: [{ kind: 'default', label: `default ${n(ENGINE_DEFAULT_DELEGATION_BUDGET)}` }],
        summary: 'Maximum feature-to-feature delegation calls before the run is aborted.',
      },
      {
        name: 'Time limit (ms)',
        glyph: DOC_GLYPH.number,
        kindLabel: 'whole number',
        badges: [{ kind: 'default', label: `default ${n(ENGINE_DEFAULT_PLACEMENT_TIME_LIMIT_MS)} ms` }],
        summary: 'Wall-clock milliseconds the engine may spend placing before the run is cut off as partial.',
        detail: [
          'In VS Code the extension\'s own featurelab.requestTimeoutMs is a separate wait; when this limit exceeds it, the extension raises its wait to match and a status line under these fields says so, so a slow-but-successful run is never reported as a dead engine.',
        ],
      },
    ],
  }

  const view: DocSection = {
    id: 'view',
    title: 'View',
    intro: ['How to look at the result already on screen. Nothing here sends a request; these settings follow you into the next panel.'],
    entries: [
      {
        name: 'Min Y (cut) / Max Y (cut)',
        glyph: DOC_GLYPH.slider,
        kindLabel: 'range',
        summary: 'Hides everything below or above this world Y in the result.',
        detail: [
          'A display-only slice, unrelated to the Environment section\'s "Min Y" (the bench floor sent with the request). Untouched, it always spans the whole of whatever result arrives; once dragged, your cut is remembered and restored when a wider result comes back.',
        ],
      },
      {
        name: 'Environment',
        glyph: DOC_GLYPH.select,
        kindLabel: 'choice',
        summary: 'How the untouched terrain around the feature is drawn: solid, see-through, or not at all.',
      },
      {
        name: 'Show carved',
        glyph: DOC_GLYPH.toggle,
        kindLabel: 'toggle',
        summary: 'Draws the cells the feature turned to air as a translucent tinted volume.',
        detail: ['On by default: turned off, carved cells render as nothing, which understates a terraform-style feature that works mostly by excavation.'],
      },
      {
        name: 'Show heatmap',
        glyph: DOC_GLYPH.toggle,
        kindLabel: 'toggle',
        summary: 'Colours each touched cell by how many writes hit it, cool for one through hot for this run\'s maximum.',
        detail: ['Needs profiling enabled on the request that produced the current result -- see the Profiler section.'],
      },
      {
        name: 'Show overflow',
        glyph: DOC_GLYPH.toggle,
        kindLabel: 'toggle',
        summary: 'Draws the writes that landed outside the bench in magenta.',
        detail: ['Capture is automatic and showing it changes nothing about the run; "Grow to fit & regenerate" above the sections is the separate action that does.'],
      },
      { name: 'Show grid', glyph: DOC_GLYPH.toggle, kindLabel: 'toggle', summary: 'Draws the bench\'s outline and floor grid.' },
      {
        name: 'Frame view (R)',
        glyph: DOC_GLYPH.button,
        kindLabel: 'action',
        summary: 'Fits the camera to what is occupied right now, respecting the Y cut.',
      },
      {
        name: 'Frame volume (Shift+R)',
        glyph: DOC_GLYPH.button,
        kindLabel: 'action',
        summary: 'Fits the camera to the whole bench, air included, to see where the feature sits in the box it was asked to fill.',
      },
    ],
  }

  const diagnostics: DocSection = {
    id: 'diagnostics',
    title: 'Diagnostics',
    intro: [
      'Everything the engine had to say about this run, errors first. Each names the feature that actually failed -- not the one you ran -- with the delegation chain down to it; a chain segment that is a loaded feature is a link that selects it in the Feature picker, and a diagnostic tied to one cell has a position that moves the camera there.',
      'A budget diagnostic carries a one-click fix that doubles the budget it hit and regenerates.',
    ],
    entries: [],
  }

  const profiler: DocSection = {
    id: 'profiler',
    title: 'Profiler',
    entries: [
      {
        name: 'Enable profiling',
        glyph: DOC_GLYPH.toggle,
        kindLabel: 'toggle',
        summary: 'Records per-cell write counts and per-feature cost on the next run.',
        detail: ['Off by default because it adds overhead. Turn it on, then regenerate, to fill the table below and enable the View section\'s heatmap.'],
      },
      {
        name: 'Feature table',
        glyph: DOC_GLYPH.readout,
        kindLabel: 'table',
        summary: 'Every feature the run entered, with how often, how many blocks it wrote, how many delegations it made, and its self and inclusive time; click a column to sort.',
      },
    ],
  }

  return [readout, feature, environment, materials, biome, budget, view, diagnostics, profiler]
}
