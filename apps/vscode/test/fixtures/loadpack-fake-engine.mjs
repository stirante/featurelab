#!/usr/bin/env node
// loadpack-fake-engine.mjs -- a second fake `serve` stand-in (see fake-engine.mjs's own doc
// comment for the pattern), this one modelling loadPack/generate specifically:
// previewController.test.ts drives it to prove PreviewController's own caching policy (load
// once per root, reloadPack() always re-issues, reloadPackFile() takes the single-file route
// and falls back to a full load when the engine refuses) without needing the real Go binary.
import * as readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

let loadCount = 0
let reloadFileCount = 0

/** The three pack catalogues a real `generate` response carries, plus the engine's own
 * `omitCatalogs` behaviour: present when the request did not ask for them to be dropped, and
 * explicitly null when it did (a null field, never a missing key -- see wire.GenerateParams's
 * OmitCatalogs). PreviewController caches them across requests, so a test can tell the two
 * cases apart by what comes back. */
function catalogs(params) {
  if (params?.omitCatalogs) return { entries: null, ruleEntries: null, biomeEntries: null }
  return {
    entries: [{ fileId: 'a.json', identifier: 'test:a', typeId: 'minecraft:single_block_feature' }],
    ruleEntries: [{ fileId: 'r.json', identifier: 'test:r.fr', rule: null }],
    biomeEntries: [{ fileId: 'b.json', identifier: 'test:b', biome: null }],
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch {
    process.stdout.write(JSON.stringify({ id: null, error: { message: 'malformed request' } }) + '\n')
    return
  }

  switch (req.method) {
    case 'loadPack':
      loadCount++
      process.stdout.write(JSON.stringify({ id: req.id, result: { warnings: [], featureCount: 1, structureCount: 0, ruleCount: 0, biomeCount: 0 } }) + '\n')
      break
    case 'reloadFile':
      // The real engine refuses any path it cannot account for -- outside the pack, belonging
      // to another pack, a kind it never loaded -- and PreviewController's whole safety story
      // is that ANY such refusal falls back to a full loadPack. A path containing 'refuse' is
      // this fixture's stand-in for every one of those, since which paths a real pack contains
      // is the Go side's business (cmd/featurelab/serve_test.go covers it), not this seam's.
      reloadFileCount++
      if (String(req.params?.path ?? '').includes('refuse')) {
        process.stdout.write(JSON.stringify({ id: req.id, error: { message: 'not a file this pack was loaded from -- reload the whole pack instead' } }) + '\n')
        break
      }
      // Same result shape loadPack answers with -- see loadPackResult/packResult in serve.go:
      // a client is meant to be able to use the two interchangeably.
      process.stdout.write(JSON.stringify({ id: req.id, result: { warnings: [], featureCount: 1, structureCount: 0, ruleCount: 0, biomeCount: 0 } }) + '\n')
      break
    case 'generate':
      process.stdout.write(JSON.stringify({ id: req.id, result: { echo: 'generate', params: req.params ?? {}, ...catalogs(req.params) } }) + '\n')
      break
    case 'generateGrown':
      // Mirrors the real engine's wire.GrownGenerateOutput shape closely enough for
      // previewController.test.ts to assert PreviewController.generateGrown reaches THIS
      // method (not plain "generate") and forwards params verbatim -- grown/preGrowBounds are
      // fixed stand-ins, not derived from params, since this fixture only needs to prove the
      // request-shaping/caching seam, not the engine's own grow geometry (covered at the Go
      // level by wire/grow_test.go).
      process.stdout.write(JSON.stringify({ id: req.id, result: { echo: 'generateGrown', params: req.params ?? {}, grown: true, preGrowBounds: { minX: -4, minY: 0, minZ: -4, sizeX: 8, sizeY: 8, sizeZ: 8 }, ...catalogs(req.params) } }) + '\n')
      break
    case 'loadCount':
      process.stdout.write(JSON.stringify({ id: req.id, result: { loadCount, reloadFileCount } }) + '\n')
      break
    case 'environments':
      // Two entries is enough to prove PreviewController.listEnvironments round-trips the
      // engine's real response shape (id/label/description/defaults/materials/buildsSea/biome/
      // biomeTags)
      // rather than a hand-rolled stub -- previewController.test.ts asserts against this
      // literal shape.
      process.stdout.write(
        JSON.stringify({
          id: req.id,
          result: [
            {
              id: 'plains',
              label: 'Plains',
              description: 'Gently rolling grass over dirt and stone.',
              defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: 44 },
              materials: { topMaterial: 'minecraft:grass_block', midMaterial: 'minecraft:dirt', foundationMaterial: 'minecraft:stone', seaFloorMaterial: 'minecraft:gravel', seaMaterial: 'minecraft:water', seaFloorDepth: 0 },
              buildsSea: false,
              biome: 'plains',
              biomeTags: ['animal', 'monster', 'overworld', 'plains', 'bee_habitat'],
            },
            {
              id: 'void',
              label: 'Void',
              description: 'Nothing at all.',
              defaults: { sizeX: 32, sizeY: 48, sizeZ: 32, minY: -8 },
              materials: { topMaterial: 'minecraft:air', midMaterial: 'minecraft:air', foundationMaterial: 'minecraft:air', seaFloorMaterial: 'minecraft:air', seaMaterial: 'minecraft:air', seaFloorDepth: 0 },
              buildsSea: false,
              biome: 'void',
              biomeTags: [],
            },
          ],
        }) + '\n',
      )
      break
    default:
      process.stdout.write(JSON.stringify({ id: req.id, error: { message: `unknown method ${req.method}` } }) + '\n')
  }
})
