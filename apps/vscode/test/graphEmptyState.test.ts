// graphEmptyState.test.ts -- the words on an empty canvas.
//
// An empty canvas is what four different situations look like: a pack with nothing in it, a pack
// whose files all failed to load, a webview whose script never ran, and a broken editor. Those
// have four different fixes, and the appearance they share is the one that got reported as "I
// could not get the node editor to open".
//
// These are sentences somebody reads at the worst possible moment, so they are asserted directly
// rather than through a browser, where the assertion ends up being about layout. The journey
// suite covers the other half -- that the real webview actually puts one of them on the real
// canvas.
import { describe, expect, it, vi } from 'vitest'

// renderGraphShellHtml is a pure function, but it lives in a module that imports `vscode` for
// the panel class beside it -- so the module needs a stand-in to load at all. Nothing in this
// file touches the API.
vi.mock('vscode', () => import('./fixtures/vscodeMock.js'))

import { emptyGraphMessage, graphErrorMessage } from '../src/graph/emptyState.js'
import { renderGraphShellHtml } from '../src/graphPanel.js'

describe('a graph with no nodes', () => {
  it('tells a new pack how to get its first node', () => {
    const message = emptyGraphMessage(0, 0)
    expect(message).not.toBeNull()
    // The two things a person needs: that this is empty rather than broken, and the gesture that
    // fixes it.
    expect(message).toMatch(/no features and no feature rules/i)
    expect(message).toMatch(/right-click/i)
  })

  it('says a broken pack is broken, and how many files, rather than calling it empty', () => {
    const message = emptyGraphMessage(0, 4)
    expect(message).toContain('4 file(s)')
    expect(message).toMatch(/could not be read/i)
    // A message about files you cannot reach from the message is most of the way to no message.
    expect(message).toMatch(/list beside this canvas/i)
    // And it must NOT be the "your pack is empty" sentence: the pack is not empty, and telling
    // somebody to create a feature when four of theirs failed to parse is worse than silence.
    expect(message).not.toMatch(/no features and no feature rules/i)
  })

  it('tells a wrong path that it is a wrong path, rather than calling it a new pack', () => {
    // What the engine actually says, verbatim in shape: pack.Load warns once per asset kind, KIND
    // FIRST, with the path spelled exactly once. It used to spell the path twice -- raw, then
    // again Go-quoted with every separator doubled -- which on Windows read as two different
    // paths, one of which exists on no disk. Refreshed here because these samples are the input
    // this module is matched against, and a fixture pinned to a format the engine no longer emits
    // proves only that the old format still works.
    const warnings = [
      'features directory "/packs/wrong/features" does not exist -- 0 features files loaded (fine if this pack has none)',
      'feature_rules directory "/packs/wrong/feature_rules" does not exist -- 0 feature_rules files loaded (fine if this pack has none)',
      'biomes directory "/packs/wrong/biomes" does not exist -- 0 biomes files loaded (fine if this pack has none)',
    ]
    const message = emptyGraphMessage(0, 0, warnings)
    expect(message).toMatch(/no features\/ directory and no feature_rules\/ directory/i)
    expect(message).toMatch(/check that the path/i)
    // And it must NOT be the new-pack sentence: inviting somebody to create their first feature
    // in a directory that is not a pack is how a file ends up somewhere nothing will read it.
    expect(message).not.toMatch(/no features and no feature rules yet/i)
    expect(message).not.toMatch(/right-click/i)
  })

  it("recognises the HOST's wording for the same fact, not only the engine's", () => {
    // Two different writers produce these warnings and neither of them is emptyState.ts. Pinning
    // one spelling exactly would mean the other quietly stopped being recognised -- and the
    // symptom of that is not an error, it is the wrong sentence on the canvas.
    const message = emptyGraphMessage(0, 0, [
      'There is no "features" directory under /packs/wrong, so no feature could be read from this pack. ' +
        'If you expected features here, the path is probably not the pack you meant.',
    ])
    expect(message).toMatch(/no features\/ directory/i)
    expect(message).toMatch(/check that the path/i)
    expect(message).not.toMatch(/no features and no feature rules yet/i)
  })

  it('still calls a real new pack a new pack when only one directory is missing', () => {
    // A pack with features/ and no feature_rules/ yet is the commonest shape of a young pack.
    // Telling its author to check the path would be worse than the bug being fixed.
    const message = emptyGraphMessage(0, 0, [
      'feature_rules directory "/packs/new/feature_rules" does not exist -- 0 feature_rules files loaded (fine if this pack has none)',
    ])
    expect(message).toMatch(/no features and no feature rules yet/i)
  })

  it('still recognises the wording the engine used BEFORE the reformat', () => {
    // Not nostalgia: the extension runs whatever `featurelab` binary it resolves, which can be
    // older than the extension. The match is on the kind and on a phrase meaning "not there", and
    // both spellings carry both -- which is the whole reason it was never pinned to a sentence.
    const message = emptyGraphMessage(0, 0, [
      '/packs/wrong/features directory "/packs/wrong/features" does not exist -- 0 features files loaded (fine if this pack has none)',
    ])
    expect(message).toMatch(/no features\/ directory/i)
    expect(message).toMatch(/check that the path/i)
  })

  it('reads the explicitly-named-directory wording too', () => {
    // pack.Load has a second sentence for a directory the caller NAMED and that is not there. It
    // is the one an author who set featurelab.featuresDir by hand will see.
    const message = emptyGraphMessage(0, 0, [
      'features directory "/packs/wrong/elsewhere" was given explicitly but does not exist -- 0 features files loaded',
    ])
    expect(message).toMatch(/no features\/ directory/i)
    expect(message).toMatch(/check that the path/i)
  })

  it('answers exactly as it always did when the host sends no warnings at all', () => {
    // An older host, or one mid-change, simply does not send the field. The absence of warnings
    // is not evidence of anything, so it must not change the answer.
    expect(emptyGraphMessage(0, 0)).toMatch(/no features and no feature rules yet/i)
    expect(emptyGraphMessage(0, 0, [])).toMatch(/no features and no feature rules yet/i)
  })

  it('does not read "features" out of the middle of "feature_rules"', () => {
    // The two warnings are one underscore apart, and a substring test on the shorter one would
    // see both directories missing whenever only the rules directory was.
    expect(
      emptyGraphMessage(0, 0, [
        'feature_rules directory "/p/feature_rules" does not exist -- 0 feature_rules files loaded (fine if this pack has none)',
      ]),
    ).toMatch(/no features and no feature rules yet/i)
  })

  it('leaves the broken-pack sentence in front, because a refused file outranks a missing folder', () => {
    const message = emptyGraphMessage(0, 2, [
      'features directory "/p/features" does not exist -- 0 features files loaded (fine if this pack has none)',
      'feature_rules directory "/p/feature_rules" does not exist -- 0 feature_rules files loaded (fine if this pack has none)',
    ])
    expect(message).toContain('2 file(s)')
  })

  it('says nothing at all when there is something drawn', () => {
    expect(emptyGraphMessage(1, 0)).toBeNull()
    expect(emptyGraphMessage(57, 3)).toBeNull()
  })
})

describe('an empty canvas, with what the LOAD said about the pack', () => {
  // The engine now answers a load with fileCounts (files READ off disk) and the pack-scoped
  // diagnostics naming every file it then refused, positions included. Those are better evidence
  // than a count of diagnostics and far better than prose matching, so the branches that can use
  // them do.

  it('names the broken file and where in it the problem is, not just how many', () => {
    // The behaviour being replaced: a file that would not parse inflated a count by one and
    // produced nothing else anywhere in the extension. A count on its own is that same silence
    // with a number in front of it -- the reader still cannot get to the file.
    const message = emptyGraphMessage(0, 1, [], {
      fileCounts: { features: 56, structures: 0, rules: 0, biomes: 0 },
      diagnostics: [
        {
          level: 'error',
          fileId: 'features/poplar_tree.json',
          scope: 'pack',
          line: 4,
          column: 57,
          message: 'invalid JSON at line 4, column 57: unexpected end of JSON input',
        },
      ],
    })
    expect(message).toContain('features/poplar_tree.json 4:57')
    expect(message).toContain('1 file(s)')
    expect(message).toMatch(/could not be read/i)
    expect(message).not.toMatch(/no features and no feature rules/i)
  })

  it('caps the naming without capping the count', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      level: 'error',
      fileId: `features/broken_${String(i)}.json`,
      scope: 'pack',
      message: 'invalid JSON: unexpected end of JSON input',
    }))
    const message = emptyGraphMessage(0, 7, [], { diagnostics: many })
    expect(message).toContain('7 file(s)')
    expect(message).toContain('features/broken_0.json')
    expect(message).toContain('and 3 more')
  })

  it('counts one broken FILE once, however many diagnostics it raised', () => {
    const message = emptyGraphMessage(0, 3, [], {
      diagnostics: [
        { level: 'error', fileId: 'features/a.json', scope: 'pack', line: 2, column: 3, message: 'invalid JSON' },
        { level: 'error', fileId: 'features/a.json', scope: 'pack', message: 'nothing in this file built' },
        { level: 'warning', fileId: 'features/b.json', scope: 'pack', message: 'places_block[0] carries a directional state' },
      ],
    })
    // One file, not two and not three: a warning is about a file that LOADED, and a second
    // diagnostic about the same file is still one file to go and fix.
    expect(message).toContain('1 file(s)')
    expect(message).toContain('features/a.json 2:3')
    expect(message).not.toContain('features/b.json')
  })

  it('does not call a refused PLACEMENT a broken file', () => {
    // A run-scoped error is a placement the engine declined -- the file is fine and sending
    // somebody to go and fix it is worse than saying nothing.
    const message = emptyGraphMessage(0, 0, [], {
      fileCounts: { features: 0, structures: 0, rules: 0, biomes: 0 },
      diagnostics: [{ level: 'error', fileId: 'wiki:pumpkin_patch', scope: 'run', message: 'iterations evaluated to zero' }],
    })
    expect(message).toMatch(/no features and no feature rules yet/i)
  })

  it('stops calling a pack full of files an empty pack', () => {
    // Files were read, nothing was refused, and still nothing drew. Inviting this author to
    // right-click and create their first feature tells them their own directory is empty.
    const message = emptyGraphMessage(0, 0, [], {
      fileCounts: { features: 0, structures: 12, rules: 0, biomes: 4 },
      diagnostics: [],
    })
    expect(message).toMatch(/were read, but none of them defines a feature/i)
    expect(message).not.toMatch(/right-click/i)
  })

  it('still calls a genuinely new pack a new pack', () => {
    // features/ exists and is empty: every fileCount is zero, nothing was refused, no directory
    // is missing. This is the one case the encouraging sentence is actually for.
    const message = emptyGraphMessage(0, 0, [], {
      fileCounts: { features: 0, structures: 0, rules: 0, biomes: 0 },
      diagnostics: [],
    })
    expect(message).toMatch(/no features and no feature rules yet/i)
    expect(message).toMatch(/right-click/i)
  })

  it('lets a missing features/ directory outrank "files were read"', () => {
    // A pack root with structures/ and no features/ at all. The path is still the thing worth
    // checking, and this is the branch that has always said so.
    const message = emptyGraphMessage(
      0,
      0,
      ['features directory "/packs/wrong/features" does not exist -- 0 features files loaded (fine if this pack has none)'],
      { fileCounts: { features: 0, structures: 3, rules: 0, biomes: 0 }, diagnostics: [] },
    )
    expect(message).toMatch(/no features\/ directory/i)
    expect(message).toMatch(/check that the path/i)
  })

  it('answers exactly as before for an engine that sends neither field', () => {
    // The extension resolves whatever binary it finds. An engine with no fileCounts and no load
    // diagnostics must cost the better sentence and never produce a wrong one.
    expect(emptyGraphMessage(0, 0, [], {})).toMatch(/no features and no feature rules yet/i)
    expect(emptyGraphMessage(0, 3, [], {})).toContain('3 file(s)')
    expect(emptyGraphMessage(0, 3, [], { diagnostics: [] })).toContain('3 file(s)')
  })
})

describe('a pack that could not be read', () => {
  it('repeats the engine verbatim and names the command that opens the full detail', () => {
    const message = graphErrorMessage('loadPack: no manifest.json in /tmp/whatever')
    expect(message).toContain('loadPack: no manifest.json in /tmp/whatever')
    expect(message).toContain('Feature Lab: Show Log')
  })

  it('does not double the engine\'s own full stop', () => {
    expect(graphErrorMessage('The pack could not be read.')).not.toContain('read..')
  })

  it('still says something for an engine that gave no reason', () => {
    expect(graphErrorMessage('   ')).toMatch(/could not be built/i)
  })
})

describe('the panel shell', () => {
  it('ships the element the empty state is written into, hidden and out of the way', () => {
    const html = renderGraphShellHtml({
      nonce: 'n0nce',
      cspSource: 'vscode-webview://test',
      scriptUri: 'https://example.invalid/graph.js',
      styleUri: 'https://example.invalid/graph.css',
      packLabel: '/packs/demo',
    })
    expect(html).toContain('id="flg-empty"')
    // Inside the canvas, so it is centred over the drawing rather than beside it.
    expect(html).toMatch(/<div id="flg-canvas"><div id="flg-empty"/)
    // NOT hidden, and carrying a sentence already. This is the one message webview/graph.ts
    // cannot write, because it covers the case where webview/graph.ts never ran -- a bundle
    // missing from the package, a CSP that rejects it, a corrupted install. All of those open a
    // panel that is a blank grey rectangle forever.
    expect(html).not.toMatch(/id="flg-empty"[^>]*hidden/)
    expect(html).toMatch(/Starting the feature graph/)
    expect(html).toMatch(/script did not load/)
    expect(html).toContain('Feature Lab: Show Log')
    // Announced, because this is the one thing on screen when there is nothing on screen.
    expect(html).toMatch(/id="flg-empty"[^>]*aria-live="polite"/)
    // And it must never eat the right-click the message itself tells the reader to make.
    expect(html).toContain('pointer-events: none')
  })
})
