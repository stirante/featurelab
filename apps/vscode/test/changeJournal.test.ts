// changeJournal.test.ts -- the undo history, at the level where it is about BYTES.
//
// Every assertion here is about what is on disk afterwards, or about the sentence somebody reads
// when the journal will not do what they asked. That is deliberate: an undo that "ran" is worth
// nothing, and the two failure modes that matter -- putting back a stale copy over somebody else's
// newer work, and reverting half of a multi-file change -- are both invisible unless the files
// themselves are checked.
//
// The panel's half of this (which operations get journalled, what happens to the graph afterwards)
// is in graphHistory.test.ts, against the real GraphPanel.
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ChangeJournal, NOTHING_TO_REDO, NOTHING_TO_UNDO, UndoRefused, snapshot } from '../src/changeJournal.js'

const temporary: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-journal-'))
  temporary.push(dir)
  return dir
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

function read(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

/** Runs `change` between two snapshots of `files`, the way GraphPanel.journalled does. */
function around(journal: ChangeJournal, label: string, files: string[], change: () => void): void {
  const before = snapshot(files)
  change()
  journal.record(label, before, snapshot(files))
}

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('undoing one change', () => {
  it('puts the exact bytes back, including the ones a formatter would have normalised', () => {
    const dir = tempDir()
    // Trailing comment, CRLF, tab indentation: everything a round-trip writer is supposed to keep
    // and everything a naive "re-serialise the JSON" undo would quietly destroy.
    const original = '{\r\n\t"extent": 1 // as authored\r\n}\r\n'
    const file = write(path.join(dir, 'features', 'gaussian.json'), original)
    const journal = new ChangeJournal()

    around(journal, 'gaussian: extent 1', [file], () => write(file, '{"extent": 4}'))
    expect(read(file)).toBe('{"extent": 4}')

    const entry = journal.undo()

    expect(entry.label).toBe('gaussian: extent 1')
    expect(read(file)).toBe(original)
  })

  it('names what it would undo before doing it, so a menu can say so', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'one')
    const journal = new ChangeJournal()

    expect(journal.undoLabel()).toBeNull()
    around(journal, 'scatter: iterations 8', [file], () => write(file, 'two'))
    expect(journal.undoLabel()).toBe('scatter: iterations 8')
  })

  it('records nothing at all when the write was refused and the file did not move', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'one')
    const journal = new ChangeJournal()

    // The engine refusing an edit is indistinguishable from accepting it until the bytes are
    // compared -- which is why GraphPanel records in a `finally` and this has to be a no-op.
    around(journal, 'an edit the engine refused', [file], () => {})

    expect(journal.undoLabel()).toBeNull()
    expect(() => journal.undo()).toThrow(NOTHING_TO_UNDO)
  })

  it('puts back a file that was created, by removing it again', () => {
    const dir = tempDir()
    const file = path.join(dir, 'features', 'new.json')
    const journal = new ChangeJournal()

    around(journal, 'Create wiki:new', [file], () => write(file, '{}'))
    expect(read(file)).toBe('{}')

    journal.undo()

    expect(fs.existsSync(file)).toBe(false)
  })

  it('puts back a file that was removed', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'features', 'gone.json'), '{"was":"here"}')
    const journal = new ChangeJournal()

    around(journal, 'Rebuild wiki:compound', [file], () => fs.rmSync(file))

    journal.undo()

    expect(read(file)).toBe('{"was":"here"}')
  })
})

describe('an entry that spans several files', () => {
  it('reverts all of them or none of them', () => {
    const dir = tempDir()
    const a = write(path.join(dir, 'a.json'), 'a0')
    const b = write(path.join(dir, 'b.json'), 'b0')
    const c = write(path.join(dir, 'c.json'), 'c0')
    const journal = new ChangeJournal()

    around(journal, 'Annotate 3 file(s)', [a, b, c], () => {
      write(a, 'a1')
      write(b, 'b1')
      write(c, 'c1')
    })
    // Somebody else has since touched the LAST of the three. Reverting the first two and stopping
    // would leave the pack in a state no author ever wrote.
    write(c, 'c-by-hand')

    expect(() => journal.undo()).toThrow(UndoRefused)

    expect(read(a)).toBe('a1')
    expect(read(b)).toBe('b1')
    expect(read(c)).toBe('c-by-hand')
  })
})

describe('a file that changed underneath the entry', () => {
  it('refuses, names the file, and says nothing was written', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'features', 'lamp.json'), 'v1')
    const journal = new ChangeJournal()
    around(journal, 'lamp: extent 1', [file], () => write(file, 'v2'))

    write(file, 'edited in a text editor')

    expect(() => journal.undo()).toThrow(new RegExp(`lamp\\.json has changed since then`))
    expect(() => journal.undo()).toThrow(/Nothing was written/)
    expect(read(file)).toBe('edited in a text editor')
  })

  it('leaves the entry in place, so a second press says the same thing rather than skipping back', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v1')
    const journal = new ChangeJournal()
    around(journal, 'first', [file], () => write(file, 'v2'))
    around(journal, 'second', [file], () => write(file, 'v3'))
    write(file, 'somebody else')

    expect(() => journal.undo()).toThrow(/"second"/)
    // Not "first". An undo that quietly walked past a refusal would revert a change the author is
    // not looking at, which is worse than doing nothing.
    expect(() => journal.undo()).toThrow(/"second"/)
    expect(journal.undoLabel()).toBe('second')
  })

  it('refuses over an unsaved buffer even though the disk still matches', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v1')
    // The editor is holding newer text than the disk. Writing the old bytes underneath it is not
    // an undo: the next save puts the edit straight back and the AUTHOR'S typing is what is lost.
    const journal = new ChangeJournal({ isDirty: (f) => f === file })
    around(journal, 'a: field 1', [file], () => write(file, 'v2'))

    expect(() => journal.undo()).toThrow(/unsaved changes in an editor/)
    expect(read(file)).toBe('v2')
  })
})

describe('an operation that cannot be undone', () => {
  it('is refused by name, instead of letting undo reach past it', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v1')
    const journal = new ChangeJournal()
    around(journal, 'a: field 1', [file], () => write(file, 'v2'))
    // A delete rewrites files this panel cannot list, so there is no honest `before` to keep.
    journal.recordBarrier('Delete wiki:lamp')

    expect(journal.undoLabel()).toBe('Delete wiki:lamp')
    expect(() => journal.undo()).toThrow(/"Delete wiki:lamp" cannot be undone from Feature Lab/)
    // And crucially NOT the field edit from before it, which is what recording nothing would have
    // reverted -- silently, and about a node the author was no longer looking at.
    expect(read(file)).toBe('v2')
  })
})

describe('redo', () => {
  it('re-applies what undo reverted', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v1')
    const journal = new ChangeJournal()
    around(journal, 'a: field 1', [file], () => write(file, 'v2'))

    journal.undo()
    expect(read(file)).toBe('v1')
    expect(journal.redoLabel()).toBe('a: field 1')

    journal.redo()

    expect(read(file)).toBe('v2')
    expect(journal.redoLabel()).toBeNull()
    expect(journal.undoLabel()).toBe('a: field 1')
  })

  it('is dropped by a new change, because the history has forked', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v1')
    const journal = new ChangeJournal()
    around(journal, 'first', [file], () => write(file, 'v2'))
    journal.undo()

    around(journal, 'a different second', [file], () => write(file, 'v9'))

    expect(journal.redoLabel()).toBeNull()
    expect(() => journal.redo()).toThrow(NOTHING_TO_REDO)
  })

  it('refuses under the same guard as undo', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v1')
    const journal = new ChangeJournal()
    around(journal, 'a: field 1', [file], () => write(file, 'v2'))
    journal.undo()
    write(file, 'somebody else got here first')

    expect(() => journal.redo()).toThrow(/has changed since then/)
    expect(read(file)).toBe('somebody else got here first')
  })
})

describe('leaving a step out of the history', () => {
  it('takes the entry off without writing a byte, and lets undo reach what came before', () => {
    // WHY THERE HAS TO BE A WAY OUT. `undo` refuses over a file that has moved on, and it refuses
    // BEFORE popping -- correctly, because a refusal is not an undo and walking past the entry
    // would revert an older change while telling the author nothing happened. But that makes the
    // refusal permanent: the bytes it wants back are never coming, so every later press meets the
    // same wall and everything under it is unreachable for the rest of the session.
    const dir = tempDir()
    const one = write(path.join(dir, 'one.json'), 'v1')
    const two = write(path.join(dir, 'two.json'), 'w1')
    const journal = new ChangeJournal()
    around(journal, 'one: field 1', [one], () => write(one, 'v2'))
    around(journal, 'two: field 1', [two], () => write(two, 'w2'))
    write(two, 'somebody else got here first')

    expect(() => journal.undo()).toThrow(/has changed since then/)
    // Still there on the second press. That is the wall.
    expect(journal.undoLabel()).toBe('two: field 1')

    const dropped = journal.drop()

    expect(dropped?.label).toBe('two: field 1')
    // NOTHING WAS WRITTEN AND NOTHING WAS PUT BACK. Forgetting is not an undo.
    expect(read(two)).toBe('somebody else got here first')
    expect(read(one)).toBe('v2')
    // ...and the step under it is reachable again, and behaves exactly as it always did.
    expect(journal.undoLabel()).toBe('one: field 1')
    journal.undo()
    expect(read(one)).toBe('v1')
  })

  it('drops the redo stack with it, because there is no undo for it to be the other half of', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v1')
    const journal = new ChangeJournal()
    around(journal, 'first', [file], () => write(file, 'v2'))
    around(journal, 'second', [file], () => write(file, 'v3'))
    journal.undo()
    expect(journal.redoLabel()).toBe('second')

    journal.drop()

    expect(journal.redoLabel()).toBeNull()
    expect(journal.undoLabel()).toBeNull()
    expect(read(file)).toBe('v2')
  })

  it('answers null on an empty history rather than inventing something to forget', () => {
    expect(new ChangeJournal().drop()).toBeNull()
  })

  it('can forget a barrier too, which is the one entry undo can never perform', () => {
    const journal = new ChangeJournal()
    journal.recordBarrier('Delete wiki:lamp')
    expect(() => journal.undo()).toThrow(/cannot be undone from Feature Lab/)

    expect(journal.drop()?.label).toBe('Delete wiki:lamp')
    expect(journal.undoLabel()).toBeNull()
  })
})

describe('the bound on the history', () => {
  it('keeps the newest entries and drops the oldest, rather than growing forever', () => {
    const dir = tempDir()
    const file = write(path.join(dir, 'a.json'), 'v0')
    const journal = new ChangeJournal({}, 3)

    for (let i = 1; i <= 5; i++) around(journal, `step ${String(i)}`, [file], () => write(file, `v${String(i)}`))

    expect(journal.undoLabel()).toBe('step 5')
    journal.undo()
    journal.undo()
    journal.undo()
    // Three deep is all there is, and the file is back at the oldest state still remembered.
    expect(read(file)).toBe('v2')
    expect(() => journal.undo()).toThrow(NOTHING_TO_UNDO)
  })
})

describe('one sentence for an empty history', () => {
  // The panel reaches this state by two roads -- the toolbar's Undo button, which is marked
  // unavailable and explains itself in its tooltip, and Ctrl+Z, which runs the command and hits
  // the journal. They used to answer differently ("Nothing this panel has written is waiting to
  // be put back." against "There is nothing to undo in this feature graph."), which reads as two
  // states rather than one. The webview bundle cannot import this module -- it pulls in node:fs --
  // so the tooltips hold their own copies of these literals and this is what keeps them equal.
  const webview = fs.readFileSync(new URL('../webview/graph.ts', import.meta.url), 'utf8')

  it('is the sentence the Undo tooltip shows', () => {
    expect(webview).toContain(`'${NOTHING_TO_UNDO}'`)
  })

  it('is the sentence the Redo tooltip shows', () => {
    expect(webview).toContain(`'${NOTHING_TO_REDO}'`)
  })

  it('is raised as a no-op rather than as a refusal of something', () => {
    // `empty` is what stops Ctrl+Z over an untouched panel raising an error notification with a
    // Show log button. A refusal that really refused something -- a file that moved underneath --
    // is NOT marked, and still gets said out loud.
    const journal = new ChangeJournal()
    try {
      journal.undo()
      expect.unreachable('undo over an empty history must refuse')
    } catch (err) {
      expect(err).toBeInstanceOf(UndoRefused)
      expect((err as UndoRefused).empty).toBe(true)
    }
    try {
      journal.redo()
      expect.unreachable('redo over an empty history must refuse')
    } catch (err) {
      expect((err as UndoRefused).empty).toBe(true)
    }
  })
})
