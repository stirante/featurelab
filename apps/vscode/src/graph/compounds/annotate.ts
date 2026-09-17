// annotate.ts -- writing a compound's provenance into the file it produced.
//
// A compound is recorded by an `@featurelab:idiom` directive carrying its kind, with the
// author's parameters as JSON on the comment line beneath it. spec.ts explains why the
// parameters are written down rather than recovered: a loop's step script is folded into its
// first evaluated coordinate and a setup script is concatenated ahead of a `return`, so reading them back
// means parsing generated Molang into authorial intent, which is the inference this editor does
// not do.
//
// THIS IS THE ONLY PLACE THAT WRITES IT. Each compound could splice its own directive during
// expansion -- one of the five did -- but then provenance is five implementations of one rule
// and four of them were missing it, which is exactly what happened: four compounds wrote
// subgraphs that could never be collapsed again, and nothing failed, because a missing
// annotation is indistinguishable from a hand-written pack. Doing it once, at the point that
// already knows the kind and the parameters, is one rule with one place to be wrong.

import { COMPOUND_DIRECTIVE, encodeCompoundParams, type CompoundKind } from './spec.js'

/** Matches the `"minecraft:*"` key a feature file's body sits under, at the start of a line. */
const BODY_KEY = /^(\s*)("minecraft:[A-Za-z0-9_]+"\s*:)/m

/**
 * Returns `contents` with the compound's directive inserted above the type key.
 *
 * THE POSITION IS LOAD-BEARING and is not a matter of taste. A directive attaches to the member
 * that FOLLOWS it, so putting it at the top of the file -- which reads more naturally, and which
 * an earlier version of the contract specified -- makes it an annotation about `format_version`,
 * the string. Above the type key it lands on the body key, which is the same root every edge
 * JSONPath in that file starts from, and that shared root is the only reason an annotation and
 * an edge can be compared at all.
 *
 * Returns `contents` unchanged when no type key can be found. That is not an error worth
 * throwing: the file is still correct and still loads, it merely cannot be collapsed later, and
 * refusing to create a node because its provenance could not be recorded would trade a working
 * feature for a bookkeeping entry.
 */
export function withCompoundAnnotation(contents: string, kind: CompoundKind, params: unknown): string {
  const match = BODY_KEY.exec(contents)
  if (match === null) return contents
  const indent = match[1] ?? ''
  // One line per comment, and the parameters on their own line: `Annotation.Text` is the
  // following comment lines, and it is the only part of the mechanism that can hold spaces --
  // a directive's arguments are whitespace-split, so a Molang condition could never survive
  // as one.
  const directive = `${indent}// @featurelab:${COMPOUND_DIRECTIVE} ${kind}\n`
  const body = `${indent}// ${encodeCompoundParams(params)}\n`
  const at = match.index
  return contents.slice(0, at) + directive + body + contents.slice(at)
}

/**
 * Reports whether `contents` already carries a compound directive.
 *
 * Used to avoid writing a second one when a file is regenerated. Two directives of the same name
 * on one path is not a state the reader has an answer for, and the honest fix is not to create
 * it.
 */
export function hasCompoundAnnotation(contents: string): boolean {
  return new RegExp(`@featurelab:${COMPOUND_DIRECTIVE}\\b`).test(contents)
}
