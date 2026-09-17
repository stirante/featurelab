// featureRuleCatalogue.test.ts -- is the editor's model of a feature RULE the engine's model?
//
// A feature rule is the other half of a pack: a pack of fifty features and no rules generates
// nothing, because a rule is the only thing that attaches a feature to a biome and to a stage of
// chunk generation. The editor draws rules, and until this catalogue entry existed it could
// neither create nor edit one -- so the shortest path to a pack that produced anything at all
// started with leaving the editor and writing JSON by hand.
//
// WHY THIS FILE IS SEPARATE FROM catalogueAgainstEngine.test.ts. That sweep is an argument about
// `features/*.go`: a feature type is registered by a RegisterType call there, its keys are read by
// a builder there, and the extraction is built to read those builders as text. A rule is none of
// those things -- no RegisterType call, no builder, no row in the coverage table. Its schema
// belongs to the rule loader. So the sweep excludes it by name and points here, and here is where
// it is actually checked.
//
// EVERY LIST BELOW IS READ OUT OF THE GO SOURCE, never restated. That is the same choice
// graphPalette.test.ts makes when it parses the coverage table out of features/coverage.go, and it
// is made for the same reason: a hand-copied list would be updated by whoever remembered, which is
// the same person who would have remembered to update the catalogue. The failure this has to catch
// is the engine gaining or reordering a placement pass while the editor's dropdown keeps offering
// the old set -- and a hand-kept copy here would be a second copy of that mistake, not a check on
// it.
//
// WHY THE PASS LIST IS WORTH A TEST AT ALL. It is CLOSED, and getting it wrong is silent. A rule
// naming a pass outside the list still loads: the engine logs an unknown-pass line and then keeps
// the string verbatim, with no substitution and no fallback. Chunk decoration only ever visits the
// passes it knows, so such a rule is inserted, attached to every biome it matches, and then never
// reached. It places nothing, in every chunk, forever. A free-text field, or a dropdown built from
// a stale list, buys exactly that.
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PLACEMENT_PASS,
  PLACEMENT_PASSES,
  PLACEMENT_PASS_VALUES,
  PREGENERATION_PASS,
  PREGENERATION_PASS_TYPE,
  typeSpec,
  type FieldSpec,
} from '../src/graph/typeCatalog.js'
import {
  PLACEHOLDER_FEATURE,
  RULE_BODY_KEY,
  RULE_TYPE_ID,
  bareName,
  featureFilePath,
  newRuleBody,
  nodeBodyKey,
  nodeFilePath,
  ruleFileContents,
  ruleFileNameNote,
  ruleFilePath,
  ruleFileStem,
} from '../src/graph/compounds/spec.js'
import { buildPaletteModel, creationRequest, type PaletteItem } from '../src/graph/palette.js'

// ---------------------------------------------------------------------------
// The rule loader, read as text
// ---------------------------------------------------------------------------

/** Walks up to the module root, the same way graphPalette.test.ts does. */
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(d, 'go.mod'))) return d
    const parent = dirname(d)
    if (parent === d) throw new Error('no go.mod above the test directory')
    d = parent
  }
}

const SCHEMA_PATH = join(repoRoot(), 'rules', 'schema.go')
const SCHEMA_SOURCE = readFileSync(SCHEMA_PATH, 'utf8')
const RULES_PATH = join(repoRoot(), 'rules', 'rules.go')
const RULES_SOURCE = readFileSync(RULES_PATH, 'utf8')

/** The string elements of a `name = []string{...}` declaration, in source order. */
function goStringList(source: string, name: string): string[] {
  const pattern = new RegExp(`${name}\\s*=\\s*\\[\\]string\\{([^}]*)\\}`)
  const found = pattern.exec(source)
  if (found === null) throw new Error(`${name} is no longer a []string literal in the rule loader -- has it been renamed?`)
  const values = [...(found[1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1] as string)
  if (values.length === 0) throw new Error(`${name} parsed as an empty list, which means the scan broke`)
  return values
}

/** The value of a `name = "..."` constant. */
function goStringConst(source: string, name: string): string {
  const found = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(source)
  if (found === null) throw new Error(`${name} is no longer a string constant in the rule loader -- has it been renamed?`)
  return found[1] as string
}

const ENGINE_PASSES = goStringList(SCHEMA_SOURCE, 'placementPasses')
const ENGINE_PREGENERATION_PASS = goStringConst(SCHEMA_SOURCE, 'PregenerationPass')
const ENGINE_PREGENERATION_TYPE = goStringConst(SCHEMA_SOURCE, 'caveCarverTypeID')
const ENGINE_BODY_KEYS = goStringList(SCHEMA_SOURCE, 'bodyKeys')
const ENGINE_DESCRIPTION_KEYS = goStringList(SCHEMA_SOURCE, 'descriptionKeys')
const ENGINE_CONDITIONS_KEYS = goStringList(SCHEMA_SOURCE, 'conditionsKeys')
const ENGINE_DISTRIBUTION_KEYS = goStringList(SCHEMA_SOURCE, 'distributionKeys')

describe('the extraction actually ran', () => {
  // Blunt, and first: everything below is worthless if the scan quietly stopped matching, and a
  // scan that finds nothing looks exactly like a clean run.
  it('read real lists out of the rule loader', () => {
    expect(SCHEMA_SOURCE.length).toBeGreaterThan(1000)
    expect(RULES_SOURCE.length).toBeGreaterThan(1000)
    expect(ENGINE_PASSES.length).toBe(11)
    expect(ENGINE_PASSES).toContain('surface_pass')
    expect(ENGINE_PREGENERATION_PASS).toBe('pregeneration_pass')
    expect(ENGINE_BODY_KEYS).toEqual(['description', 'conditions', 'distribution'])
  })
})

// ---------------------------------------------------------------------------
// The pass enum
// ---------------------------------------------------------------------------

const RULE_SPEC = typeSpec(RULE_TYPE_ID)

function fieldAt(path: readonly string[]): FieldSpec {
  let fields: readonly FieldSpec[] = RULE_SPEC?.fields ?? []
  let found: FieldSpec | undefined
  for (const key of path) {
    found = fields.find((f) => f.key === key)
    if (found === undefined) throw new Error(`the rule catalogue has no field at ${path.join('.')}`)
    fields = found.entry ?? []
  }
  return found as FieldSpec
}

describe('the placement passes are the engine\'s, in the engine\'s order', () => {
  it('catalogues exactly the eleven decoration passes the loader registers', () => {
    // ORDER IS PART OF THE DATA, not presentation. Decoration walks the passes in registration
    // order, so the list doubles as "when in the chunk's life does my rule run" -- sorting it for
    // a dropdown would throw that away, and so this compares sequences, not sets.
    expect([...PLACEMENT_PASSES]).toEqual(ENGINE_PASSES)
  })

  it('offers pregeneration_pass as the twelfth value, after the eleven', () => {
    expect(PREGENERATION_PASS).toBe(ENGINE_PREGENERATION_PASS)
    expect([...PLACEMENT_PASS_VALUES]).toEqual([...ENGINE_PASSES, ENGINE_PREGENERATION_PASS])
    expect(PREGENERATION_PASS_TYPE).toBe(ENGINE_PREGENERATION_TYPE)
  })

  it('puts that list, and only that list, on the placement_pass control', () => {
    const pass = fieldAt(['conditions', 'placement_pass'])
    expect(pass.kind).toBe('enum')
    expect(pass.required).toBe(true)
    expect([...(pass.values ?? [])]).toEqual([...PLACEMENT_PASS_VALUES])
  })

  it('says on the control that an unknown pass fails SILENTLY, because that is the whole reason it is closed', () => {
    // The engine keeps an unrecognised pass string verbatim and decoration never visits it, so the
    // rule loads, attaches, and places nothing forever with no error anywhere. If that sentence is
    // ever deleted from the control, a free-text field becomes a defensible-looking change again.
    const doc = fieldAt(['conditions', 'placement_pass']).doc ?? ''
    expect(doc).toMatch(/loads/i)
    expect(doc).toMatch(/never/i)
    expect(doc).toMatch(/nothing/i)
    // And the loader still behaves that way -- the warning names the pass and keeps going rather
    // than failing the file.
    expect(RULES_SOURCE).toMatch(/IsFeaturePassDefined/)
  })

  it('starts a new rule in a pass that has ground under it', () => {
    // Not the enum's first member. `first_pass` runs before anything else has been added to the
    // chunk, so a rule defaulted there places into a world that is not finished and reads as
    // broken to whoever just created it.
    expect(PLACEMENT_PASSES).toContain(DEFAULT_PLACEMENT_PASS)
    expect(DEFAULT_PLACEMENT_PASS).not.toBe(PLACEMENT_PASSES[0])
  })
})

// ---------------------------------------------------------------------------
// The key set
// ---------------------------------------------------------------------------

/** Every key the catalogue offers for the rule, at any depth, flattened. */
function catalogueKeys(): Set<string> {
  const out = new Set<string>()
  const walk = (fields: readonly FieldSpec[]): void => {
    for (const field of fields) {
      if (field.key !== '') out.add(field.key)
      walk(field.entry ?? [])
    }
  }
  walk(RULE_SPEC?.fields ?? [])
  return out
}

describe('the key set is the schema\'s', () => {
  it('catalogues the rule at all', () => {
    expect(RULE_SPEC, 'typeSpec(minecraft:feature_rule) is undefined, so the panel says "no field catalogue" and a rule cannot be edited').toBeDefined()
  })

  it('offers a control for every key the schema accepts, except the two that are not form fields', () => {
    // `description` is the node's own identity: its `identifier` belongs to the rename control and
    // its `places_feature` is an EDGE on the canvas (the graph builder cuts that one key out of
    // the node's fields where it sits). Modelling either here would give the editor two ways to
    // set one thing, which is the failure this exception exists to prevent -- so the exception is
    // exactly those two names and is checked to still be exactly those two.
    expect([...ENGINE_DESCRIPTION_KEYS].sort()).toEqual(['identifier', 'places_feature'])
    const offered = catalogueKeys()
    const expected = [...ENGINE_BODY_KEYS, ...ENGINE_CONDITIONS_KEYS, ...ENGINE_DISTRIBUTION_KEYS].filter(
      (key) => key !== 'description',
    )
    const missing = expected.filter((key) => !offered.has(key))
    expect(
      missing,
      'the rule schema accepts these and the form offers no control for them, so an author cannot set them and has no way to learn they exist',
    ).toEqual([])
  })

  it('offers no top-level control the schema does not accept', () => {
    const accepted = new Set(ENGINE_BODY_KEYS)
    const offered = (RULE_SPEC?.fields ?? []).map((f) => f.key)
    for (const key of offered) {
      expect(accepted.has(key), `the form offers "${key}", which the rule schema drops unread`).toBe(true)
    }
  })

  it('marks conditions and placement_pass required, and distribution optional, the way the loader does', () => {
    // Not cosmetic. A missing `conditions` or `placement_pass` is a hard failure -- the game
    // refuses the whole file -- while a missing `distribution` LOADS, with an iteration count of
    // zero, and then places nothing in every chunk forever. Those two failures need to read
    // differently, because only one of them is visible without playing the game.
    expect(fieldAt(['conditions']).required).toBe(true)
    expect(fieldAt(['conditions', 'placement_pass']).required).toBe(true)
    expect(fieldAt(['distribution']).required).toBe(false)
    expect(fieldAt(['distribution']).default ?? '').toMatch(/iterations 0/)
  })

  it('keeps iterations a plain field here, unlike on a scatter where it is an edge', () => {
    // wire's graph builder mirrors a scatter's `iterations` onto the connection to the feature it
    // places; a rule has no such edge, so the same key is an ordinary control.
    expect(ENGINE_DISTRIBUTION_KEYS).toContain('iterations')
    expect(fieldAt(['distribution', 'iterations']).kind).toBe('molangOrNumber')
    const scatterDistribution = (typeSpec('minecraft:scatter_feature')?.fields ?? []).find(
      (f) => f.key === 'distribution' && f.kind === 'group',
    )
    expect((scatterDistribution?.entry ?? []).map((f) => f.key)).not.toContain('iterations')
  })

  it('shares scatter\'s own axis definitions rather than restating them', () => {
    // The same object, not a copy that reads the same today. A second transcription of six
    // distribution kinds and six evaluation orders is a second thing to get wrong.
    const scatterDistribution = (typeSpec('minecraft:scatter_feature')?.fields ?? []).find(
      (f) => f.key === 'distribution' && f.kind === 'group',
    )
    const scatterX = (scatterDistribution?.entry ?? []).find((f) => f.key === 'x')
    expect(fieldAt(['distribution', 'x', 'distribution']).values).toBe(
      (scatterX?.entry ?? []).find((f) => f.key === 'distribution')?.values,
    )
  })

  it('gates nothing on format_version, because the rule schema has no bands', () => {
    // One schema, registered once, with no per-key gates and no legacy flat spellings -- which is
    // the opposite of scatter, whose identical distribution object moved out of five flat keys.
    // A `since` or `until` here would hide a key from a file that may perfectly well write it.
    const gated: string[] = []
    const walk = (fields: readonly FieldSpec[], prefix: string): void => {
      for (const field of fields) {
        const path = prefix === '' ? field.key : `${prefix}.${field.key}`
        if (field.since !== undefined || field.until !== undefined) gated.push(path)
        walk(field.entry ?? [], path)
      }
    }
    walk(RULE_SPEC?.fields ?? [], '')
    expect(gated, 'the rule schema has no version bands, so a version-gated field here hides a key the engine accepts').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Where a rule file goes, and what it is called
// ---------------------------------------------------------------------------

describe('the file name is the identifier\'s name half, with ONE extension', () => {
  it('puts a rule in feature_rules/ and a feature in features/', () => {
    expect(ruleFilePath('example:volcano')).toBe('feature_rules/volcano.json')
    expect(featureFilePath('example:volcano')).toBe('features/volcano.json')
    expect(nodeFilePath(RULE_TYPE_ID, 'example:volcano')).toBe('feature_rules/volcano.json')
    expect(nodeFilePath('minecraft:ore_feature', 'example:volcano')).toBe('features/volcano.json')
    expect(nodeFilePath(undefined, 'example:volcano')).toBe('features/volcano.json')
  })

  it('never writes a .fr.json name, because the engine would read it as a different name', () => {
    // THE TRAP, pinned. The engine compares the identifier's name half against the file's own name
    // with ONE extension removed. `feature_rules/volcano.fr.json` therefore reads as `volcano.fr`,
    // which is not `volcano`, and every load logs a mismatch -- so a rule the editor creates must
    // never be written that way.
    expect(ruleFilePath('example:volcano')).not.toMatch(/\.fr\.json$/)
    expect(ruleFileStem('feature_rules/volcano.fr.json')).toBe('volcano.fr')
    expect(ruleFileStem('feature_rules/volcano.json')).toBe('volcano')
  })

  it('and does not "helpfully" strip .fr either, because a rule may honestly be named that', () => {
    // The mirror image, and the reason stripping two extensions would be wrong. The fixture pack's
    // own rule declares `wiki:rng_rule_a.fr` and lives at `feature_rules/rng_rule_a.fr.json`: the
    // name half really is `rng_rule_a.fr`, so that file is CORRECT and a cleverer path builder
    // would have renamed it into a mismatch.
    expect(ruleFilePath('wiki:rng_rule_a.fr')).toBe('feature_rules/rng_rule_a.fr.json')
    expect(ruleFileNameNote('wiki:rng_rule_a.fr', 'feature_rules/rng_rule_a.fr.json')).toBeNull()
  })

  it('takes the name half from the LAST colon, which is what the engine compares', () => {
    expect(bareName('example:volcano')).toBe('volcano')
    expect(bareName('volcano')).toBe('volcano')
    expect(bareName('a:b:c')).toBe('c')
  })

  it('says something useful about a mismatched file instead of refusing to open it', () => {
    // The user's own hand-written `test_rule.fr.json` declaring `wiki:test_rule` is exactly this.
    // A DIAGNOSTIC and not a refusal, because that is what the engine does: it logs the mismatch
    // and loads the rule anyway, so a pack full of these still generates what it should.
    const note = ruleFileNameNote('wiki:test_rule', 'feature_rules/test_rule.fr.json')
    expect(note).not.toBeNull()
    expect(note).toContain('test_rule.fr')
    expect(note).toContain('feature_rules/test_rule.json')
    // It has to say that nothing is broken, or it reads as an error about a file that works.
    expect(note).toMatch(/loads/i)
    // And it says nothing at all about a file that agrees with its identifier.
    expect(ruleFileNameNote('wiki:test_rule', 'feature_rules/test_rule.json')).toBeNull()
    expect(ruleFileNameNote('example:volcano', 'feature_rules\\volcano.json')).toBeNull()
  })

  it('keeps the node type and the file\'s root key apart', () => {
    // Two different strings, and neither is the other with an `s` trimmed: the node names one rule,
    // the file's root key names the collection. A path built from the node's type addresses
    // nothing in a rule file, and the write fails rather than writing to the wrong place.
    expect(RULE_TYPE_ID).toBe('minecraft:feature_rule')
    expect(RULE_BODY_KEY).toBe('minecraft:feature_rules')
    expect(nodeBodyKey(RULE_TYPE_ID)).toBe(RULE_BODY_KEY)
    expect(nodeBodyKey('minecraft:ore_feature')).toBe('minecraft:ore_feature')
  })
})

// ---------------------------------------------------------------------------
// What a newly created rule contains
// ---------------------------------------------------------------------------

describe('a rule created from scratch is one the engine LOADS', () => {
  const body = () => newRuleBody('example:new_rule')

  it('writes every key the loader refuses the file without', () => {
    // Each of these is a hard failure in the engine, not a default: a missing one means the whole
    // file is refused, the rule is never inserted, and nothing it would place appears in game.
    const description = body()['description'] as Record<string, unknown>
    expect(typeof description['identifier']).toBe('string')
    expect(typeof description['places_feature']).toBe('string')
    const conditions = body()['conditions'] as Record<string, unknown>
    expect(PLACEMENT_PASS_VALUES).toContain(conditions['placement_pass'])
  })

  it('writes an iteration count, because the value it would otherwise fall back on is zero', () => {
    // `distribution` is optional to the schema, and a rule without one loads with default
    // parameters: iterations 0. That rule is live, correct and completely inert -- it attaches to
    // its pass and its biomes and then places nothing in every chunk, with no error anywhere. A
    // newly created rule that does nothing until you discover that is not a created rule.
    const distribution = body()['distribution'] as Record<string, unknown>
    expect(distribution).toBeDefined()
    expect(Number(distribution['iterations'])).toBeGreaterThan(0)
  })

  it('names a placeholder feature rather than refusing to exist before one does', () => {
    // THE DELIBERATE CHOICE: unattached-but-loadable, not refused. `places_feature` is required, so
    // "create the rule now, attach it later" is only possible with something in it. Refusing
    // instead would get the order of work backwards -- a pack is as often designed rule-first
    // ("something should generate on beaches") as feature-first -- and would send the author back
    // to a text editor, which is the situation this panel exists to end. The namespace is one no
    // real pack owns, so the result is a VISIBLE dangling edge the canvas already explains, not a
    // silent wrong reference.
    const description = body()['description'] as Record<string, unknown>
    expect(description['places_feature']).toBe(PLACEHOLDER_FEATURE)
    expect(PLACEHOLDER_FEATURE.startsWith('example:')).toBe(true)
  })

  it('roots the file at the plural collection key, with the declared format_version', () => {
    const text = ruleFileContents('example:new_rule', '1.21.110')
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['format_version', RULE_BODY_KEY])
    expect(parsed['format_version']).toBe('1.21.110')
    expect(text.endsWith('\n')).toBe(true)
    // And it lands at a path whose name the identifier will be compared against without complaint.
    expect(ruleFileNameNote('example:new_rule', ruleFilePath('example:new_rule'))).toBeNull()
  })

  it('accepts the pass, the target and the filter a caller supplies', () => {
    const parsed = JSON.parse(
      ruleFileContents('example:new_rule', '1.21.110', {
        placesFeature: 'example:oak',
        placementPass: 'underground_pass',
        biomeFilter: { test: 'has_biome_tag', value: 'volcanic' },
        distribution: { iterations: 4 },
      }),
    ) as Record<string, Record<string, Record<string, unknown>>>
    const rule = parsed[RULE_BODY_KEY] as Record<string, Record<string, unknown>>
    expect(rule['description']?.['places_feature']).toBe('example:oak')
    expect(rule['conditions']).toEqual({
      placement_pass: 'underground_pass',
      'minecraft:biome_filter': { test: 'has_biome_tag', value: 'volcanic' },
    })
    expect(rule['distribution']).toEqual({ iterations: 4 })
  })

  it('leaves the biome filter out entirely when there is none', () => {
    // An empty object would mean the same thing to the engine and read as a setting somebody meant
    // to fill in.
    const conditions = newRuleBody('example:new_rule')['conditions'] as Record<string, unknown>
    expect(Object.keys(conditions)).toEqual(['placement_pass'])
  })
})

// ---------------------------------------------------------------------------
// The menu offers it
// ---------------------------------------------------------------------------

/** The menu, built with no coverage table at all -- a rule has no row in one, and its entry must
 * not depend on the engine having answered yet. */
function ruleItem(formatVersion?: string): PaletteItem {
  const model = buildPaletteModel({ coverage: [], formatVersion })
  const found = model.byId.get(`rule:${RULE_TYPE_ID}`)
  if (found === undefined) {
    throw new Error(`the creation menu has no feature-rule entry; it has ${model.items.length} entries`)
  }
  return found
}

describe('the creation menu can make one', () => {
  it('offers a rule even when the engine has sent no coverage table', () => {
    const item = ruleItem()
    expect(item.kind).toBe('rule')
    expect(item.typeId).toBe(RULE_TYPE_ID)
    expect(item.enabled).toBe(true)
    expect(item.blocks).toEqual([])
  })

  it('is never blocked by a version, because the rule schema has no bands to be blocked by', () => {
    for (const version of ['1.13.0', '1.21.10', '1.26.50', undefined]) {
      expect(ruleItem(version).enabled, `blocked at ${String(version)}`).toBe(true)
    }
  })

  it('is findable by the word somebody would type', () => {
    const item = ruleItem()
    expect(item.title.toLowerCase()).toContain('rule')
    expect(item.keywords).toContain('rule')
    // And it says what a rule is for, for the reader who has only ever made features and does not
    // yet know that the missing half is called a rule.
    expect(item.summary.length).toBeGreaterThan(30)
    expect(item.summary.toLowerCase()).toMatch(/biome|generat/)
  })

  it('describes a creation rather than performing one, like every other entry', () => {
    const request = creationRequest(ruleItem('1.21.110'), { point: { x: 10, y: 20 }, gesture: 'click', formatVersion: '1.21.110' })
    expect(request?.kind).toBe('rule')
    expect(request && 'typeId' in request ? request.typeId : undefined).toBe(RULE_TYPE_ID)
    // Seeded the same way a type is, so a rule created from the menu and one created anywhere else
    // start identical.
    const fields = request && 'fields' in request ? request.fields : {}
    expect(Object.keys(fields)).toEqual(['conditions'])
    expect((fields['conditions'] as Record<string, unknown>)['placement_pass']).toBeDefined()
  })
})
