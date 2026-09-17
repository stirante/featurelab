// workspaceScope.test.ts -- the panel's persisted state must not cross projects.
//
// The bug: a VS Code webview's localStorage is scoped per EXTENSION, not per panel, window or
// workspace. With one global key, two windows open on two different behaviour packs shared a
// single blob of state, so a pack biome selected in one became the selection in the other --
// where it does not exist. The user saw "biome id "wiki:crater" is not defined by any loaded
// biome file" in a window whose project was a different pack entirely, for an id they had never
// picked there.
//
// The fix has two halves and this file covers the host half: the workspace id derivation, and
// the fact that it actually reaches the DOM (frontend/src/ui/panel.ts reads it off <body> while
// constructing, before any message could arrive). The webview half -- dropping a restored biome
// the loaded pack does not define -- lives with panel.ts's own tests.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadRenderShellHtml, loadWorkspaceIdFrom, type RenderShellHtml } from './fixtures/shellHtml.js'

describe('workspace-scoped panel state', () => {
  describe('workspaceIdFrom', () => {
    let workspaceIdFrom: (paths: readonly string[]) => string
    beforeAll(async () => {
      workspaceIdFrom = await loadWorkspaceIdFrom()
    })

    it('gives different projects different ids', () => {
      expect(workspaceIdFrom(['D:\\packs\\isles_bp'])).not.toBe(workspaceIdFrom(['D:\\packs\\caves_bp']))
    })

    it('is stable for the same project', () => {
      expect(workspaceIdFrom(['D:\\packs\\isles_bp'])).toBe(workspaceIdFrom(['D:\\packs\\isles_bp']))
    })

    it('keys a multi-root workspace on its first folder', () => {
      // The panel previews one pack at a time and VS Code treats the first folder as primary;
      // adding a second root must not silently re-key (and discard) existing state.
      expect(workspaceIdFrom(['D:\\packs\\isles_bp', 'D:\\packs\\caves_bp'])).toBe(workspaceIdFrom(['D:\\packs\\isles_bp']))
    })

    it('returns empty for a window with no folder open', () => {
      expect(workspaceIdFrom([])).toBe('')
    })

    it('does not leak the raw path', () => {
      // The id lands in the DOM and in a storage key; a full filesystem path there is needless
      // exposure. Hashing also keeps the key short.
      expect(workspaceIdFrom(['D:\\packs\\isles_bp'])).not.toContain('packs')
    })
  })

  describe('the id reaches the webview', () => {
    let render: RenderShellHtml
    beforeAll(async () => {
      render = await loadRenderShellHtml()
    })

    const base = { nonce: 'n0nce', cspSource: 'vscode-webview://x', scriptUri: 's.js', styleUri: 's.css' }

    it('stamps the id onto <body> so panel.ts can read it before any message arrives', () => {
      const html = render({ ...base, workspaceId: 'abc123' })
      expect(html).toContain('<body data-fl-workspace="abc123">')
    })

    it('renders an empty attribute, never the string "undefined", when omitted', () => {
      // test/fixtures/shellHtml.ts declares its own structural copy of ShellHtmlParams, so the
      // compiler cannot force this field on every caller -- the default has to be real.
      const html = render({ ...base })
      expect(html).toContain('<body data-fl-workspace="">')
      expect(html).not.toContain('undefined')
    })
  })
})
