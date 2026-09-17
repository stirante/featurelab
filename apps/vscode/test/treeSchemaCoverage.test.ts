// Does the tree schema describe the trees that actually exist?
//
// Every other test over these modules asks whether the catalogue is well-formed: specs have the
// right shape, keys are not duplicated, required is marked. All of that can be true of a
// catalogue describing a type nobody writes. This one asks the only question a pack author
// cares about -- open a real tree, and is every key in it something the editor can show a
// control for, or does it fall back to a text box?
//
// It matters because the fallback is silent. A key the catalogue does not know is not an error:
// the form simply has nothing to draw for it, and the author gets raw JSON with no statement
// that anything is missing. So the drift this catches has no other symptom.
//
// The fixture is real output of `featurelab graph` over this repo's own fixture pack, and its
// four trees happen to use four different trunk variants -- which is why it is worth asserting
// against rather than against trees written for a test.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TREE_TRUNK_FIELDS, trunkVariantFields } from '../src/graph/treeTrunks'

const here = path.dirname(fileURLToPath(import.meta.url))

interface GraphNode {
  id: string
  typeId?: string
  fields?: Record<string, unknown>
}

function trees(): GraphNode[] {
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'graph-sample.json'), 'utf8')
  const graph = JSON.parse(raw) as { nodes: GraphNode[] }
  return graph.nodes.filter((n) => n.typeId === 'minecraft:tree_feature')
}

describe('the tree catalogue against the trees in the fixture pack', () => {
  it('finds trees to check, so a silent pass cannot look like success', () => {
    // The specific way a sweep in this repo has been broken before: it stopped matching
    // anything and reported clean.
    expect(trees().length).toBeGreaterThanOrEqual(4)
  })

  it('describes every key written inside every trunk variant that is actually used', () => {
    const variantKeys = new Set(TREE_TRUNK_FIELDS.map((f) => f.key))
    const checked: string[] = []

    for (const tree of trees()) {
      for (const [key, body] of Object.entries(tree.fields ?? {})) {
        if (!variantKeys.has(key)) continue
        const specs = trunkVariantFields(key) ?? []
        const known = new Set(specs.map((s) => s.key))
        const written = Object.keys((body ?? {}) as Record<string, unknown>)
        const undescribed = written.filter((k) => !known.has(k))

        expect(
          undescribed,
          `${tree.id} writes ${key}.${undescribed.join(', ')}, which the catalogue does not ` +
            'describe -- the form will fall back to raw JSON for it, and say nothing about why',
        ).toEqual([])
        checked.push(`${tree.id}:${key}`)
      }
    }

    // Four trees, four different trunk variants, which is what makes this fixture worth the
    // assertion: a pack where every tree used the same variant would prove far less.
    expect(checked.length).toBeGreaterThanOrEqual(4)
  })

  it('leaves no trunk variant as an undescribed text box', () => {
    // The state this whole catalogue exists to leave behind: eight variants, every one of them
    // a `json` box holding whatever the author typed.
    const boxes = TREE_TRUNK_FIELDS.filter((f) => f.kind === 'json').map((f) => f.key)
    expect(boxes).toEqual([])
  })
})
