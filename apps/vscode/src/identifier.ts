// identifier.ts -- extracts a feature/rule's kind + identifier from its JSON text, and finds
// the pack root a feature (or rule) file belongs to. Mirrors featurelab/pack's own parsing
// convention exactly (see features/registry.go's parseFile: the one top-level key besides
// "format_version" is the type id, and body.description.identifier is the identifier) so a
// file this extension can preview is exactly a file `featurelab generate --feature <id>` (or
// `--rule <id>`) could also place.
import * as path from 'node:path'
import * as fs from 'node:fs'

export class DocumentParseError extends Error {}

/** Which of panel.ts's two pickers/modes a parsed document belongs in -- 'rule' for a
 * `minecraft:feature_rules` file, 'feature' for anything else recognizable (see
 * parseDocumentIdentifier's own doc comment for why this is derived, not guessed: the type key
 * is what feature_rules.go/registry.go themselves dispatch on). Deliberately the SAME two-value
 * union frontend/src/ui/panel.ts's own `Mode` is (that package exports it for exactly this) --
 * a caller never has to translate between two parallel kind enums. */
export type DocumentKind = 'feature' | 'rule'

export interface ParsedDocumentIdentifier {
  kind: DocumentKind
  identifier: string
  /** The literal top-level type key this was parsed from (e.g. "minecraft:tree_feature",
   * "minecraft:feature_rules") -- exposed for a caller/diagnostic that wants to say more than
   * `kind` alone conveys. */
  typeId: string
}

const RULE_TYPE_ID = 'minecraft:feature_rules'

/** Extracts the identifier AND kind (feature vs rule) from a feature/feature_rules JSON file's
 * text. This is NOT a guess: the top-level key alongside "format_version" is exactly
 * "minecraft:feature_rules" for a rule file and some other "minecraft:*_feature" for a feature
 * file -- the same key featurelab's own registry.go dispatches the SAME file on, so a file
 * this function calls a rule is exactly a file `featurelab generate --rule <id>` would place,
 * never one `--feature <id>` would.
 *
 * Fixes a reported bug: a previous version of this module only ever returned the identifier,
 * silently assuming "feature" -- every caller (previewPanel.ts's tryPostInit/regenerate)
 * therefore posted a RULE file's own identifier as if it were a feature's, seeding it into
 * panel.ts's Feature picker (where it matches nothing) and, when this fell all the way through
 * to an actual request with no lastParams set yet, sending `{feature: <rule id>}` to the engine
 * -- a request that could only ever fail to resolve, and for the wrong reason (feature/rule
 * confusion) even when the identifier itself was perfectly valid.
 *
 * Throws DocumentParseError with a message suitable for showing directly to the user (not a raw
 * JSON.parse stack) when the file isn't a recognizable single-feature/single-rule JSON body. */
export function parseDocumentIdentifier(text: string): ParsedDocumentIdentifier {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    throw new DocumentParseError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new DocumentParseError('expected a JSON object at the top level')
  }
  const obj = root as Record<string, unknown>
  let typeId: string | null = null
  for (const key of Object.keys(obj)) {
    if (key === 'format_version') continue
    typeId = key
    break
  }
  if (typeId === null) {
    throw new DocumentParseError('no feature/rule type key alongside "format_version" -- is this a feature or feature_rules JSON file?')
  }
  const body = obj[typeId]
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DocumentParseError(`"${typeId}" must be an object`)
  }
  const description = (body as Record<string, unknown>).description
  const identifier =
    typeof description === 'object' && description !== null ? (description as Record<string, unknown>).identifier : undefined
  if (typeof identifier !== 'string' || identifier.length === 0) {
    throw new DocumentParseError(`"${typeId}.description.identifier" is missing`)
  }
  return { kind: typeId === RULE_TYPE_ID ? 'rule' : 'feature', identifier, typeId }
}

export class PackRootError extends Error {}

// The conventional subdirectories a Bedrock behaviour pack's Dir layout recognizes -- see
// pack.Options's own convention in featurelab/pack/pack.go (resolvedDir against each of
// these names). Any one of them sitting directly inside a directory is corroborating evidence
// that directory is a pack root, and a file can legitimately be opened from inside ANY of
// them, not just "features" -- see this function's own doc comment for why the previous
// features-only walk was wrong.
const PACK_MARKER_DIRS = ['features', 'structures', 'feature_rules', 'biomes', 'blocks']

/** Whether `filePath` is a file the ENGINE actually loads as part of the pack at `packRoot` --
 * i.e. it sits under one of the five conventional subdirectories pack.Load reads (the same
 * PACK_MARKER_DIRS list above). This is the save-listener's filter: a save inside one of these
 * means the loaded Workspace is now stale and open previews of this pack must reload, while a
 * save of, say, the pack's manifest.json or a README costs nothing to ignore. Deliberately not
 * extension-filtered beyond the directory: structures/ holds binary .mcstructure files, which
 * VS Code can still save through extensions like a hex editor. */
export function isEngineLoadedPackFile(packRoot: string, filePath: string): boolean {
  const rel = path.relative(packRoot, filePath)
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return false
  const segments = rel.split(path.sep)
  const first = segments[0]
  return segments.length > 1 && typeof first === 'string' && PACK_MARKER_DIRS.includes(first)
}

/** Case-SENSITIVE check for whether `dir` directly contains a subdirectory named exactly
 * `name`. Deliberately not `fs.existsSync(path.join(dir, name))`/`fs.statSync` -- both resolve
 * through the OS's own path lookup, which is case-INSENSITIVE by default on Windows (and on
 * macOS's default filesystem), so a plain existence check for "biomes" would silently match a
 * sibling directory actually named "Biomes" -- for example a `Biomes` directory in a project
 * folder containing several unrelated packs (not a pack's own biomes/ subdirectory) sitting
 * beside files that are genuinely outside any pack. Reading the directory's real entries and
 * comparing names exactly avoids that. */
function hasExactChildDir(dir: string, name: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some((entry) => entry.name === name && entry.isDirectory())
}

/**
 * Finds the Bedrock behaviour pack root containing `filePath`. The strongest signal is
 * manifest.json sitting directly in a pack's own root directory -- every real behaviour pack
 * has one, and it wins over any other evidence the instant it's found, checked on every
 * ancestor directory while walking up from the file's own directory. Corroborating evidence
 * (an ancestor whose own basename is one of PACK_MARKER_DIRS -- e.g. the file was opened
 * directly inside `feature_rules/` -- or an ancestor that directly CONTAINS one of those
 * subdirectories) is remembered as a fallback pack root in case no manifest.json is ever
 * found, but is never preferred over an actual manifest.json.
 *
 * This replaces the previous "walk up looking for a directory named exactly features"
 * implementation, which silently handed loadPack the `feature_rules` directory itself as the
 * "pack root" for a file like `.../ExampleAddon_bp/feature_rules/example_rule.main.json` (no
 * ancestor of that file is ever named "features"), producing empty pickers and
 * `"<id>" not found in loaded rule files` errors with no indication the root was ever wrong in
 * the first place. This version handles a file opened from ANY of features/, structures/,
 * feature_rules/, biomes/, or blocks/.
 *
 * Throws PackRootError -- message suitable for showing directly to the user -- when neither
 * signal is found anywhere between the file and the filesystem root, rather than silently
 * falling back to path.dirname(filePath) (the previous behaviour): a wrong guess here doesn't
 * fail at resolution time, it fails later and opaquely, as loadPack reporting nothing found in
 * a directory that was never a pack root to begin with.
 */
export function resolvePackRoot(filePath: string): string {
  let dir = path.dirname(filePath)
  let corroborated: string | null = null
  for (;;) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) {
      return dir
    }
    if (corroborated === null) {
      if (PACK_MARKER_DIRS.includes(path.basename(dir))) {
        corroborated = path.dirname(dir)
      } else {
        for (const marker of PACK_MARKER_DIRS) {
          if (hasExactChildDir(dir, marker)) {
            corroborated = dir
            break
          }
        }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // reached filesystem root
    dir = parent
  }
  if (corroborated !== null) return corroborated
  throw new PackRootError(
    `"${filePath}" does not look like it's inside a behaviour pack -- no ancestor directory has a manifest.json, and none contains a features/, structures/, feature_rules/, biomes/ or blocks/ subdirectory`,
  )
}
