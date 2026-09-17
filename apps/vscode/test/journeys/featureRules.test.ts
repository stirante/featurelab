// featureRules.test.ts -- the other half of a pack: the rules that decide WHERE a feature is
// placed.
//
// THIS SUITE IS EXPECTED TO BE RED, except the last test. A feature rule is not a detail of the
// schema -- it is how anything a person makes in this editor ends up in a world at all. A pack
// of fifty features and no rules generates nothing. The editor DRAWS rules (the fixture pack's
// two are nodes on the canvas, with `rule` edges into the features they place, and the pack
// overview counts them in its own first sentence: "55 features, 2 rules decide where they are
// placed"), and it can do nothing else with them:
//
//   1. IT CANNOT CREATE ONE. onCreate in webview/graph.ts ends at
//      `featureFilePath(identifier)` -- `features/<name>.json`, hard-coded, with no branch for
//      any other kind of file. The palette has no entry to reach it with either: buildPaletteModel
//      offers the compounds plus one row per row of the engine's coverage table, and the coverage
//      table is a table of FEATURE types. So the shortest path to a first rule is to leave the
//      editor, write the JSON by hand, and come back.
//
//   2. IT CANNOT EDIT ONE. typeSpec('minecraft:feature_rule') is undefined, so selecting a rule
//      shows "No field catalogue for this type." -- and because renderInspector returns on that
//      branch BEFORE it appends the lifecycle bar, a rule cannot be renamed or deleted from the
//      editor either. Three capabilities, one early return.
//
// Both are written as journeys rather than filed as notes because a note is not a thing that
// turns red when somebody ships the fix and then regresses it.
import * as fs from 'node:fs'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeStub.js'))

import { closeSharedBrowser, openJourney, JOURNEY_TIMEOUT_MS, type Journey } from './harness.js'

const open: Journey[] = []

async function journey(...args: Parameters<typeof openJourney>): Promise<Journey> {
  const started = await openJourney(...args)
  open.push(started)
  return started
}

afterEach(async () => {
  for (const j of open.splice(0)) await j.dispose()
})

afterAll(async () => {
  await closeSharedBrowser()
})

/** A rule the fixture pack already has, and the file it lives in. */
const EXISTING_RULE = 'wiki:rng_rule_a.fr'
const EXISTING_RULE_FILE = 'feature_rules/rng_rule_a.fr.json'

/** The pack-relative paths of every feature-rule file, sorted. */
function ruleFiles(j: Journey): string[] {
  const dir = 'feature_rules'
  if (!j.exists(dir)) return []
  return fs
    .readdirSync(j.file(dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${dir}/${name}`)
}

describe('creating a feature rule', () => {
  it(
    'the creation menu can make one, and it lands in feature_rules with a rule body',
    async () => {
      const j = await journey()
      const before = ruleFiles(j)
      expect(before).toHaveLength(2)

      await j.openCreationMenu()

      // Found by typing what the thing is called, which is how somebody looks for an entry in a
      // menu of thirty. The row is matched on its NAME rather than on the row text: the menu's
      // type-ahead matches summaries too, and three feature types mention the word "rule" in
      // theirs.
      const filter = j.page.locator('.flp-filter')
      await filter.waitFor({ state: 'visible', timeout: 20_000 })
      await filter.fill('rule')
      const row = j.page.locator('.flp-row').filter({ has: j.page.locator('.flp-row-name', { hasText: /rule/i }) }).first()
      // A short wait on purpose: the menu is already open and already filtered, so a row that is
      // going to appear has appeared. Waiting twenty seconds to be told the menu has no such
      // entry only makes the suite slower at saying the same thing.
      await expect
        .poll(() => row.count(), { timeout: 3_000 })
        .toBeGreaterThan(0)
      // Listed and DISABLED would be a defensible answer for something not built yet -- the
      // palette already does that for types the engine cannot place, with the reason on the row.
      // Absent is not: a person who knows rules exist is left believing the editor is broken.
      expect(await row.getAttribute('aria-disabled')).not.toBe('true')
      await row.click()

      // A rule file, under feature_rules, holding a rule -- not a feature with a rule-ish name
      // in the features directory, which is what `featureFilePath()` would produce if it were
      // reached with a rule's identifier.
      await expect.poll(() => ruleFiles(j).length, { timeout: 20_000 }).toBe(3)
      const created = ruleFiles(j).find((f) => !before.includes(f))
      expect(created).toBeDefined()
      const body = JSON.parse(j.read(created!)) as Record<string, Record<string, unknown>>
      expect(Object.keys(body)).toContain('minecraft:feature_rules')
      const rule = body['minecraft:feature_rules'] as { description?: Record<string, unknown> }
      // A rule with no identifier is not loadable and a rule with no places_feature places
      // nothing, so both are part of "created a rule" rather than of filling it in afterwards.
      expect(rule.description?.['identifier']).toEqual(expect.any(String))
      expect(rule.description?.['places_feature']).toEqual(expect.any(String))

      // And it is on the canvas, selected, the way every other creation leaves you.
      const id = String(rule.description?.['identifier'])
      await j.waitForNode(id)
      expect(await j.selectedNodeId()).toBe(id)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('editing a feature rule that already exists', () => {
  it(
    'selecting a rule shows its fields, and they can be changed',
    async () => {
      const j = await journey()
      await j.clickNode(EXISTING_RULE)
      expect(await j.selectedNodeId()).toBe(EXISTING_RULE)

      // Today: "No field catalogue for this type." A rule has four things worth editing -- which
      // feature it places, its placement pass, its biome filter and its distribution -- and the
      // panel offers none of them.
      const editables = await j.editables()
      expect(
        editables.filter((e) => e.editable).length,
        `selecting a rule offers nothing to edit; the panel says: ${JSON.stringify(await j.sideText())}`,
      ).toBeGreaterThan(0)

      const places = editables.find((e) => e.value === 'wiki:rng_marker')
      expect(places, `no control holds the feature this rule places -- it holds ${JSON.stringify(editables.map((e) => e.value))}`).toBeDefined()

      const control = j.page.locator(places!.selector)
      await control.fill('wiki:pumpkin_patch')
      await control.press('Tab')

      await expect.poll(() => j.read(EXISTING_RULE_FILE).includes('wiki:pumpkin_patch'), { timeout: 20_000 }).toBe(true)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )

  it(
    'a rule can be renamed and deleted like anything else on the canvas',
    async () => {
      const j = await journey()
      await j.clickNode(EXISTING_RULE)

      // renderInspector returns on the "no field catalogue" branch before it ever appends the
      // lifecycle bar, so these two controls are missing for a rule for a reason that has
      // nothing to do with either of them.
      const name = j.page.locator('#flg-side input[aria-label="Identifier"]')
      const remove = j.page.locator('#flg-side button', { hasText: 'Delete' })
      expect(await name.count(), 'a rule has no name field').toBe(1)
      expect(await remove.count(), 'a rule has no delete button').toBe(1)

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})

describe('what the editor does with rules today', () => {
  // GREEN. Rules are drawn, counted and connected; only creating and editing them is missing.
  // Pinned so the half that works cannot quietly stop working while the other half is being
  // built.
  it(
    'rules are drawn as nodes, counted in the overview, and joined to the feature they place',
    async () => {
      const j = await journey()

      const drawn = await j.nodeIds()
      expect(drawn).toContain(EXISTING_RULE)
      expect(drawn).toContain('wiki:rng_rule_b.fr')

      // The overview says how many there are, and says what they are FOR -- a count on its own
      // would not tell a reader who has never met a feature rule why they should care.
      expect(await j.sideText()).toMatch(/2 rules decide where they are placed/)

      // And each is joined to the feature it places, so the path from "a rule runs" to "this
      // block appears" is traceable on the canvas.
      const fromRule = (await j.edges()).filter((e) => e.from === EXISTING_RULE)
      expect(fromRule).toHaveLength(1)

      // Double-clicking opens the rule's own file, which is currently the only way to change one.
      await j.activateNode(EXISTING_RULE)
      await expect.poll(() => j.openedDocuments.length, { timeout: 20_000 }).toBe(1)
      expect(j.openedDocuments[0]?.fsPath).toBe(j.file(EXISTING_RULE_FILE))

      expect(j.problems()).toEqual([])
    },
    JOURNEY_TIMEOUT_MS,
  )
})
