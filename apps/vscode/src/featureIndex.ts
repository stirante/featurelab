// featureIndex.ts -- the identifier -> declaring-file map behind go-to-definition. Pure data
// structure over (uri string, file text) pairs; who scans the workspace, watches for changes
// and feeds files in is featureDefinitionProvider.ts's job, so this half is unit-testable
// without the vscode API.
import { parseDocumentIdentifier } from './identifier.js'

export class FeatureIndexData {
  /** identifier -> uris of files declaring it. A Set per identifier because duplicates are a
   * real workspace shape, not an error: the user's own layout keeps a source pack and its
   * build output side by side, so one identifier legitimately resolves to both copies -- a
   * provider should offer every declaration and let the editor's peek UI disambiguate. */
  private readonly byIdentifier = new Map<string, Set<string>>()
  /** uri -> the identifier it currently declares -- what makes removeFile/setFile cheap
   * without rescanning byIdentifier. One identifier per file, matching the engine's own
   * one-feature-per-file parse (features/registry.go's parseFile). */
  private readonly byUri = new Map<string, string>()

  /** (Re)indexes one file. Not-a-feature content (rule files, invalid JSON, missing
   * identifier) UNindexes the uri -- an edit can turn a valid feature file into garbage, and a
   * stale entry would keep offering a jump to a declaration that no longer parses. */
  setFile(uri: string, text: string): void {
    this.removeFile(uri)
    let identifier: string
    try {
      const parsed = parseDocumentIdentifier(text)
      // Rules are never the TARGET of a reference (rules reference features, nothing
      // references a rule), so indexing them would only produce wrong jump destinations for a
      // feature that happens to share a rule's identifier.
      if (parsed.kind !== 'feature') return
      identifier = parsed.identifier
    } catch {
      return
    }
    this.byUri.set(uri, identifier)
    let uris = this.byIdentifier.get(identifier)
    if (!uris) {
      uris = new Set()
      this.byIdentifier.set(identifier, uris)
    }
    uris.add(uri)
  }

  removeFile(uri: string): void {
    const identifier = this.byUri.get(uri)
    if (identifier === undefined) return
    this.byUri.delete(uri)
    const uris = this.byIdentifier.get(identifier)
    if (uris) {
      uris.delete(uri)
      if (uris.size === 0) this.byIdentifier.delete(identifier)
    }
  }

  lookup(identifier: string): string[] {
    return [...(this.byIdentifier.get(identifier) ?? [])]
  }

  get size(): number {
    return this.byUri.size
  }
}
