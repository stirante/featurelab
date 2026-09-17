// The headline claim of the compound design, tested end to end: a compound expands into a
// subgraph of ordinary features, records its own parameters on the way out, and comes back as
// ONE node when the pack is read again.
//
// Each half is covered on its own -- the specs have their expansion tests, collapse.ts has its
// view tests -- and each half passing says nothing about the join. The join is where this
// design can fail silently: four of the compounds wrote subgraphs with no annotation at
// all, every one of their own tests passed, and the only symptom was that reopening a pack
// showed the machinery instead of the node. A missing annotation is indistinguishable from a
// hand-written pack, so nothing anywhere reported a problem.
import { describe, expect, it } from 'vitest'
import { hasCompoundAnnotation, withCompoundAnnotation } from '../src/graph/compounds/annotate'
import { buildCompoundView, type CompoundRegistry } from '../src/graph/compounds/collapse'
import { COMPOUND_KINDS, type CompoundKind, type CompoundSpec } from '../src/graph/compounds/spec'
import { loopCompound } from '../src/graph/compounds/loop'
import { stepsCompound } from '../src/graph/compounds/steps'
import { placementGuardSpec } from '../src/graph/compounds/placementGuard'
import { columnCompound } from '../src/graph/compounds/column'
import { ParseAnnotationsShim } from './fixtures/parseAnnotations'

const REGISTRY: CompoundRegistry = {
  loop: loopCompound as unknown as CompoundSpec<unknown>,
  steps: stepsCompound as unknown as CompoundSpec<unknown>,
  'placement-guard': placementGuardSpec as unknown as CompoundSpec<unknown>,
  column: columnCompound as unknown as CompoundSpec<unknown>,
}

/** The seed the editor creates each kind with. Kept identical to webview/graph.ts's own. */
function seed(kind: CompoundKind): unknown {
  const places = 'example:replace_me'
  switch (kind) {
    case 'loop': return { count: '1', places }
    case 'steps': return { steps: [places] }
    case 'placement-guard': return { places, mayReplace: ['minecraft:air'] }
    case 'column': return { places, maxY: '1' }
  }
}

const VERSION = '1.21.110'

describe('compound round trip: expand, annotate, collapse', () => {
  for (const kind of COMPOUND_KINDS) {
    it(`${kind}: every generated child is hidden and the compound is one node`, () => {
      const spec = REGISTRY[kind]!
      const identifier = `example:demo_${kind.replace('-', '_')}`
      const validated = spec.validate(seed(kind))
      expect(validated.ok, `${kind} refused its own seed: ${validated.ok ? '' : validated.refusal.reason}`).toBe(true)
      if (!validated.ok) return
      const result = spec.expand(identifier, validated.params, VERSION)
      expect(result.ok, `${kind} could not expand: ${result.ok ? '' : result.refusal.reason}`).toBe(true)
      if (!result.ok) return

      // What the editor writes to disk: the compound's own file carries the annotation, its
      // children do not.
      const files = result.expansion.operations
        .filter((op): op is Extract<typeof op, { op: 'createFile' }> => op.op === 'createFile')
        .map((op) => ({
          id: op.identifier,
          typeId: op.typeId,
          contents:
            op.identifier === identifier && !hasCompoundAnnotation(op.contents)
              ? withCompoundAnnotation(op.contents, kind, validated.params)
              : op.contents,
        }))
      expect(files.some((f) => f.id === identifier)).toBe(true)

      // What the graph builder would then report: a node per file, annotations parsed out of
      // the comments of each.
      const nodes = files.map((f) => ({
        id: f.id,
        typeId: f.typeId,
        file: `features/${f.id.split(':')[1]}.json`,
        formatVersion: VERSION,
        fields: bodyOf(f.contents, f.typeId),
        annotations: ParseAnnotationsShim(f.contents),
      }))

      const view = buildCompoundView({ graph: { nodes } as never, registry: REGISTRY })
      const compounds = view.compounds.filter((c) => c.identifier === identifier)
      expect(compounds, `${kind} was not recognised as a compound after a round trip`).toHaveLength(1)

      // Every generated child is hidden, and the compound itself never is.
      const generated = files.map((f) => f.id).filter((id) => id !== identifier)
      for (const child of generated) {
        expect(view.hiddenNodeIds, `${kind}: ${child} was left visible`).toContain(child)
      }
      expect(view.hiddenNodeIds).not.toContain(identifier)
    })
  }
})

/** The feature body, as GraphNode.Fields carries it: the type key's object minus description. */
function bodyOf(contents: string, typeId: string): Record<string, unknown> {
  const parsed = JSON.parse(contents.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>
  const body = { ...((parsed[typeId] ?? {}) as Record<string, unknown>) }
  delete body.description
  return body
}
