// featureDefinitionProvider.ts -- ctrl+click go-to-definition for feature references: a
// reference position (featureReferences.ts decides which positions qualify -- see that file's
// header for the key-by-key derivation from the Go loaders) jumps to the file(s) whose
// description.identifier declares the referenced feature.
//
// A DefinitionProvider rather than a DocumentLinkProvider deliberately: definitions activate on
// ctrl+hover/ctrl+click and F12 with zero per-open-document work, while a link provider is
// asked to enumerate every link in every visible document eagerly -- for 3.5k-file packs that
// is exactly the kind of always-on cost this extension's startup work just removed. Definitions
// also get peek/multi-target UI for free, which matters here because duplicate identifiers
// (source pack + build output in one workspace) are a normal shape, not an error.
import * as vscode from 'vscode'
import { featureReferenceAt, findIdentifierDeclaration } from './featureReferences.js'
import { FeatureIndexData } from './featureIndex.js'

/** Where feature declarations live. The engine's pack loader reads the `features` subdirectory
 * by convention (pack.Options's resolvedDir; the CLI's override flags exist but the extension
 * never sets them), so this glob is the exact universe of files a reference can resolve
 * against -- scanning every workspace JSON would only add false declarations. */
const FEATURE_GLOB = '**/features/**/*.json'

/** Documents larger than this are never feature files (they are a few KB) -- skip them before
 * paying a parseTree on every ctrl+hover over, say, a package-lock.json. */
const MAX_DOCUMENT_BYTES = 2_000_000

export class FeatureDefinitionProvider implements vscode.DefinitionProvider, vscode.Disposable {
  /** Built lazily on the FIRST definition request, never at activation -- the full scan is
   * measured ~0.5s on a 3.5k-feature workspace (walk ~120ms + read/parse ~400ms), acceptable
   * once behind an explicit user gesture but not as an activation tax on every JSON window.
   * A promise (not the data) so concurrent first requests share one build. */
  private indexBuild: Promise<FeatureIndexData> | null = null
  private readonly watcher: vscode.FileSystemWatcher
  private readonly disposables: vscode.Disposable[] = []

  constructor() {
    // The watcher exists from construction even though the index is lazy: creating one is
    // cheap, and events arriving before the first build are no-ops (see handleFileEvent) --
    // the build itself reads the then-current state of disk.
    this.watcher = vscode.workspace.createFileSystemWatcher(FEATURE_GLOB)
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate((uri) => this.handleFileEvent(uri, 'set')),
      this.watcher.onDidChange((uri) => this.handleFileEvent(uri, 'set')),
      this.watcher.onDidDelete((uri) => this.handleFileEvent(uri, 'remove')),
    )
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[] | null> {
    const text = document.getText()
    if (text.length > MAX_DOCUMENT_BYTES) return null
    const reference = featureReferenceAt(text, document.offsetAt(position))
    if (!reference) return null

    const index = await this.ensureIndex()
    if (token.isCancellationRequested) return null
    const targetUris = index.lookup(reference.identifier)
    if (targetUris.length === 0) return null

    const originSelectionRange = new vscode.Range(
      document.positionAt(reference.start),
      document.positionAt(reference.start + reference.length),
    )
    const links: vscode.LocationLink[] = []
    for (const uriString of targetUris) {
      const uri = vscode.Uri.parse(uriString)
      let targetText: string
      try {
        targetText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8')
      } catch {
        continue // deleted between index update and click -- the watcher will catch up
      }
      // Re-locating the declaration at click time (rather than storing offsets in the index)
      // keeps the index immune to position drift from edits the watcher hasn't delivered yet;
      // worst case the declaration moved out of the file entirely and we fall back to its top.
      const span = findIdentifierDeclaration(targetText, reference.identifier)
      const targetRange = span
        ? rangeFromSpan(targetText, span.start, span.length)
        : new vscode.Range(0, 0, 0, 0)
      links.push({ originSelectionRange, targetUri: uri, targetRange, targetSelectionRange: targetRange })
    }
    return links.length > 0 ? links : null
  }

  private ensureIndex(): Promise<FeatureIndexData> {
    if (!this.indexBuild) this.indexBuild = this.buildIndex()
    return this.indexBuild
  }

  private async buildIndex(): Promise<FeatureIndexData> {
    const index = new FeatureIndexData()
    const uris = await vscode.workspace.findFiles(FEATURE_GLOB, '**/node_modules/**')
    // Bounded batches instead of one Promise.all over every file: 3.5k simultaneous readFile
    // calls through the extension-host fs proxy is a burst with no upside over a few hundred.
    const BATCH = 200
    for (let i = 0; i < uris.length; i += BATCH) {
      await Promise.all(
        uris.slice(i, i + BATCH).map(async (uri) => {
          try {
            const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8')
            index.setFile(uri.toString(), text)
          } catch {
            // Unreadable file -- simply not a definition target.
          }
        }),
      )
    }
    return index
  }

  private handleFileEvent(uri: vscode.Uri, kind: 'set' | 'remove'): void {
    // Before the first build there is nothing to patch, and dropping the event is safe: the
    // eventual build reads the file's then-current state off disk anyway. Once a build exists
    // (even still in flight), patches chain behind it so they always apply to the built index.
    // Two near-simultaneous changes to one file can in principle apply out of order (each does
    // its own readFile); the next change self-heals, so no per-uri queue here.
    if (!this.indexBuild) return
    void this.indexBuild.then(async (index) => {
      if (kind === 'remove') {
        index.removeFile(uri.toString())
        return
      }
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8')
        index.setFile(uri.toString(), text)
      } catch {
        index.removeFile(uri.toString())
      }
    })
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
  }
}

/** Converts a text offset span to a vscode.Range without a TextDocument (the target file may
 * not be open). Line/column derived by counting newlines -- feature files are small enough
 * that a scan per click is irrelevant next to the readFile beside it. */
function rangeFromSpan(text: string, start: number, length: number): vscode.Range {
  const startPos = positionAt(text, start)
  const endPos = positionAt(text, start + length)
  return new vscode.Range(startPos, endPos)
}

function positionAt(text: string, offset: number): vscode.Position {
  let line = 0
  let lastLineStart = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
      lastLineStart = i + 1
    }
  }
  return new vscode.Position(line, offset - lastLineStart)
}
