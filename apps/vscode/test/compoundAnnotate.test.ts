import { describe, expect, it } from 'vitest'
import { hasCompoundAnnotation, withCompoundAnnotation } from '../src/graph/compounds/annotate'
import { COMPOUND_DIRECTIVE, decodeCompoundParams } from '../src/graph/compounds/spec'

const FILE = `{
  "format_version": "1.21.10",
  "minecraft:scatter_feature": {
    "description": { "identifier": "example:demo" },
    "iterations": 1
  }
}
`

describe('withCompoundAnnotation', () => {
  it('puts the directive above the TYPE key, not at the top of the file', () => {
    // This is the whole correctness question. A directive attaches to the member that follows
    // it, so at the top of the file it describes the format_version string -- which is what an
    // earlier version of the contract specified, and which was only caught by reading the graph
    // the engine produced. Above the type key it lands on the body key, the same root every
    // edge JSONPath in the file starts from.
    const out = withCompoundAnnotation(FILE, 'loop', { count: '1', places: 'example:x' })
    const lines = out.split('\n')
    const directive = lines.findIndex((l) => l.includes(`@featurelab:${COMPOUND_DIRECTIVE}`))
    const version = lines.findIndex((l) => l.includes('format_version'))
    const typeKey = lines.findIndex((l) => l.includes('"minecraft:scatter_feature"'))
    expect(directive).toBeGreaterThan(version)
    expect(directive).toBeLessThan(typeKey)
  })

  it('writes parameters that decode back to what went in, spaces and all', () => {
    // A Molang condition contains spaces, and a directive's arguments are whitespace-split --
    // which is why the parameters travel as the comment body rather than as arguments. If that
    // ever regresses, a loop's count comes back cut into pieces.
    const params = { count: 'q.above_top_solid_block > 4 ? 2 : 0', places: 'example:a' }
    const out = withCompoundAnnotation(FILE, 'loop', params)
    const body = out.split('\n').find((l) => l.includes('{"count"'))
    expect(body).toBeDefined()
    expect(decodeCompoundParams(body!.replace(/^\s*\/\/\s*/, ''))).toEqual(params)
  })

  it('keeps the file valid JSON once its comments are removed', () => {
    const out = withCompoundAnnotation(FILE, 'column', { places: 'example:x', maxY: '4' })
    const stripped = out.replace(/^\s*\/\/.*$/gm, '')
    expect(() => JSON.parse(stripped)).not.toThrow()
    expect(JSON.parse(stripped)['minecraft:scatter_feature'].iterations).toBe(1)
  })

  it('returns the file untouched when there is no type key to attach to', () => {
    // Not an error: the file still loads, it just cannot be collapsed later. Refusing to create
    // a node because its provenance could not be recorded would trade a working feature for a
    // bookkeeping entry.
    const odd = '{ "format_version": "1.21.10" }\n'
    expect(withCompoundAnnotation(odd, 'loop', {})).toBe(odd)
  })

  it('reports an annotation that is already there, so a regenerate does not write a second', () => {
    const once = withCompoundAnnotation(FILE, 'loop', { count: '1' })
    expect(hasCompoundAnnotation(FILE)).toBe(false)
    expect(hasCompoundAnnotation(once)).toBe(true)
  })

  it('preserves the indentation of the key it attaches to', () => {
    const out = withCompoundAnnotation(FILE, 'steps', { steps: ['example:a'] })
    const directive = out.split('\n').find((l) => l.includes('@featurelab:'))
    expect(directive!.startsWith('  //')).toBe(true)
  })
})

describe('the annotation line itself', () => {
  it('keeps the parameters on exactly one line, whatever is in them', () => {
    // This moved here from the one compound that used to write its own directive. The property
    // belongs to whoever writes the line: `Annotation.Text` is the following comment LINES, so
    // a wrapped JSON object is read back as several of them and the parameters come apart. A
    // multi-line body is not a formatting preference, it is data loss.
    const params = {
      setup: 'v.a = 1;\nv.b = 2;',
      count: 'q.x > 1 && q.y < 2 ? 3 : 0',
      places: 'example:a',
    }
    const out = withCompoundAnnotation(FILE, 'loop', params)
    const commentLines = out.split('\n').filter((l) => l.trim().startsWith('//'))
    // Exactly two: the directive, and one body line.
    expect(commentLines).toHaveLength(2)
    expect(commentLines[1]).not.toContain('\n')
    // And the newline inside the parameter survives, escaped, rather than breaking the line.
    const decoded = decodeCompoundParams(commentLines[1]!.replace(/^\s*\/\/\s*/, '')) as typeof params
    expect(decoded.setup).toBe(params.setup)
  })
})
