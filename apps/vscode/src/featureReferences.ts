// featureReferences.ts -- position-aware detection of feature REFERENCES inside a feature/
// feature_rules JSON document, plus location of a feature's own declaration, for the
// go-to-definition provider (featureDefinitionProvider.ts). Pure text+offset functions with no
// dependency on the vscode API, so the whole decision surface is unit-testable in vitest.
//
// "Reference" here is not "any string that looks like namespace:id" -- it is exactly the set of
// JSON positions featurelab's own loaders resolve against the feature registry, verified key
// by key against the Go source rather than guessed from packs:
//
//   places_feature          scatter.go / search_feature.go / scan_surface.go (FirstOf alias) /
//                           height_difference_filter.go / rules.go (description.places_feature) /
//                           conditional_list.go (each conditional_features entry)
//   feature, feature_to_scan  scan_surface.go's other two FirstOf aliases
//   feature_to_snap         snap_to_surface.go
//   feature_to_place        surface_relative_threshold.go
//   vegetation_feature      vegetation_patch.go
//   log_decoration_feature  tree.go (fallen-trunk decoration WeakRef)
//   features[i]             aggregate.go (aggregate + sequence: plain string elements)
//   features[i][0]          weighted_random.go ([featureReference, weight] tuples)
//
// Structure references (structure_template.go's structure_name) resolve against .mcstructure
// files, not JSON with a description.identifier, so they are deliberately NOT covered here.
import { findNodeAtOffset, getNodePath, parseTree, type Node } from 'jsonc-parser'

const FEATURE_REFERENCE_KEYS = new Set([
  'places_feature',
  'feature',
  'feature_to_scan',
  'feature_to_snap',
  'feature_to_place',
  'vegetation_feature',
  'log_decoration_feature',
])

export interface FeatureReferenceHit {
  identifier: string
  /** Offset/length of the string's CONTENT (quotes excluded) -- what a provider should
   * underline as the origin of the link. */
  start: number
  length: number
}

/** True when the top-level type key `rootKey` marks a document whose reference keys this module
 * understands. This is the false-positive gate: a random JSON (package.json, tsconfig) can
 * legally contain a "feature" or "features" key, but never under one of these wrappers. The
 * suffix rules cover 22 of the 24 type ids features/registry.go registers plus
 * minecraft:feature_rules; the two exact names are the registered ids that do NOT end in
 * `_feature` (see conditionalListTypeID / scan_surface.go's own type constants). */
function isFeatureDocumentKey(rootKey: unknown): boolean {
  if (typeof rootKey !== 'string') return false
  return (
    rootKey.endsWith('_feature') ||
    rootKey.endsWith('feature_rules') ||
    rootKey === 'minecraft:conditional_list' ||
    rootKey === 'minecraft:scan_surface'
  )
}

/** The feature reference whose string literal contains `offset`, or null when the position is
 * not on one (not a string, a property key, a string under some unrelated key, a weight in a
 * weighted_random tuple, ...). Tolerant of comments/trailing commas via jsonc-parser -- Bedrock
 * pack JSON frequently carries both. */
export function featureReferenceAt(text: string, offset: number): FeatureReferenceHit | null {
  const root = parseTree(text)
  if (!root) return null
  const node = findNodeAtOffset(root, offset)
  if (!node || node.type !== 'string' || typeof node.value !== 'string') return null
  if (isPropertyKey(node)) return null

  const path = getNodePath(node)
  if (path.length < 2 || !isFeatureDocumentKey(path[0])) return null

  const last = path[path.length - 1]
  const secondLast = path[path.length - 2]
  const thirdLast = path[path.length - 3]

  const isRefKeyValue = typeof last === 'string' && FEATURE_REFERENCE_KEYS.has(last)
  // aggregate/sequence: "features": ["a:b", ...] -- a string element directly in a `features`
  // array. weighted_random's elements are arrays, so a string node can't be one of them here.
  const isFeaturesArrayElement = typeof last === 'number' && secondLast === 'features'
  // weighted_random: "features": [["a:b", 1], ...] -- the FIRST element of a tuple in a
  // `features` array. Element 1 is the weight; a numeric literal there can never be a string
  // node, but a pack author who quotes the weight shouldn't get a bogus link either, hence
  // last === 0 exactly.
  const isWeightedTupleRef = last === 0 && typeof secondLast === 'number' && thirdLast === 'features'

  if (!isRefKeyValue && !isFeaturesArrayElement && !isWeightedTupleRef) return null
  // node.offset/node.length include the surrounding quotes; the link origin is the content.
  return { identifier: node.value, start: node.offset + 1, length: Math.max(0, node.length - 2) }
}

function isPropertyKey(node: Node): boolean {
  return node.parent?.type === 'property' && node.parent.children?.[0] === node
}

export interface DeclarationSpan {
  start: number
  length: number
}

/** Offset/length (quotes excluded) of `identifier`'s own declaration -- the string value of
 * `<typeKey>.description.identifier` -- inside a feature file's text, or null when this text
 * does not declare that identifier. Walked through the parse tree rather than a regex so an
 * identifier that also appears elsewhere in the file (self-references are legal) can never
 * steal the jump target. */
export function findIdentifierDeclaration(text: string, identifier: string): DeclarationSpan | null {
  const root = parseTree(text)
  if (root?.type !== 'object') return null
  for (const property of root.children ?? []) {
    const keyNode = property.children?.[0]
    const valueNode = property.children?.[1]
    if (keyNode?.value === 'format_version' || valueNode?.type !== 'object') continue
    const description = childValue(valueNode, 'description')
    const identifierNode = description ? childValue(description, 'identifier') : undefined
    if (identifierNode?.type === 'string' && identifierNode.value === identifier) {
      return { start: identifierNode.offset + 1, length: Math.max(0, identifierNode.length - 2) }
    }
  }
  return null
}

function childValue(objectNode: Node, key: string): Node | undefined {
  for (const property of objectNode.children ?? []) {
    if (property.children?.[0]?.value === key) return property.children?.[1]
  }
  return undefined
}
