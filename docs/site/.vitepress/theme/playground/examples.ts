// The playground's examples, and the pack each one runs in.
//
// Every example is a file from the fixture pack the site's figures are rendered from
// (docs/wiki/tools/fixtures), read at build time, so an example on a page and the picture next
// to it are the same JSON and cannot drift apart. The fixture pack's feature files are small
// (about 23 KB, a few KB compressed), so all of them come along: that is what lets an edited
// example name any other fixture and have it resolve. They ride in the theme chunk rather than
// a lazy one so the server render already has the example's text in the editor.

// Features only: the playground runs one feature at the bench origin, and has no world for a
// feature rule to decorate chunk by chunk.
const raw = import.meta.glob('../../../../wiki/tools/fixtures/features/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Pack-relative path ("features/x.json") -> text. */
export const fixtures: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([key, text]) => [key.slice(key.indexOf('/fixtures/') + '/fixtures/'.length), text]),
)

export interface Example {
  id: string
  title: string
  /** The file shown in the editor. Everything it places is found by identifier (see packFor). */
  main: string
  /** Chosen on the panel before the first run: the preset and seed the site's picture of this
   * fixture was rendered with, so the first result matches the page. */
  env: string
  seed: number
}

export const EXAMPLES: Example[] = [
  { id: 'scatter', title: 'Scatter: a pumpkin patch', main: 'features/scatter_pumpkin_patch.json', env: 'plains', seed: 9 },
  { id: 'single_block', title: 'Single block: one pumpkin', main: 'features/single_block_pumpkin.json', env: 'plains', seed: 1 },
  { id: 'weighted_random', title: 'Weighted random: one of two', main: 'features/weighted_pick_feature.json', env: 'plains', seed: 1 },
  { id: 'aggregate', title: 'Aggregate: two features at once', main: 'features/aggregate_pumpkin_pair.json', env: 'plains', seed: 9 },
  { id: 'vegetation_patch', title: 'Vegetation patch on the floor', main: 'features/vegetation_patch_floor.json', env: 'plains', seed: 1 },
  { id: 'fancy_oak', title: 'Tree: fancy oak', main: 'features/tree_fancy_oak.json', env: 'plains', seed: 3 },
  { id: 'acacia', title: 'Tree: acacia branching', main: 'features/tree_acacia_branching.json', env: 'plains', seed: 3 },
  { id: 'fallen_log', title: 'Fallen log with leaf litter', main: 'features/horizontal_tree_decoration_scene.json', env: 'plains', seed: 1 },
  // No ore, geode or carver: what they do is inside solid rock, and their pictures on the site
  // are cut-aways framed by hand. Here the first thing a reader would see is an unbroken slab.
]

export function findExample(id: string | undefined): Example {
  return EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0]!
}

/** The identifier a feature or rule file declares, read without trusting the file to parse:
 * the reader is typing into it. */
export function identifierOf(text: string): string | null {
  return /"identifier"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null
}

/** Is this file a feature rule rather than a feature? Someone will paste one in; they get told
 * where to run it instead of an engine error about a missing feature. */
export function isRuleFile(text: string): boolean {
  return /"minecraft:feature_rules"\s*:/.test(text)
}

const byIdentifier = new Map<string, string>()
for (const [p, text] of Object.entries(fixtures)) {
  const id = identifierOf(text)
  if (id) byIdentifier.set(id, p)
}

/** The pack a run sends: the edited file, plus every fixture it reaches by identifier, and
 * everything those reach in turn.
 *
 * Nothing else goes in. The whole fixture pack would make every edit resolve, but it would also
 * put fifty unrelated files' warnings in the Diagnostics list and fifty features in the picker,
 * and a reader trying to understand one feature does not need either. A reference to something
 * that is not a fixture stays unresolved, and the engine says so, which is the honest answer.
 *
 * The edited file shadows the fixture it came from: whatever identifier it declares now, the
 * original is not sent alongside it. */
export function packFor(mainPath: string, mainText: string): Record<string, string> {
  const files: Record<string, string> = { [mainPath]: mainText }
  const own = identifierOf(mainText)
  const queue = [mainText]
  while (queue.length > 0) {
    const text = queue.pop()!
    for (const m of text.matchAll(/"([a-z0-9_.-]+:[a-z0-9_./-]+)"/gi)) {
      const p = byIdentifier.get(m[1]!)
      if (!p || p === mainPath || m[1] === own || p in files) continue
      files[p] = fixtures[p]!
      queue.push(fixtures[p]!)
    }
  }
  return files
}
