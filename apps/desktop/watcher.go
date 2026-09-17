// watcher.go -- watches a pack directory on disk and debounces file-save storms into a
// single notification. This is the core loop the task description calls out explicitly:
// "watch the pack on disk and regenerate when a file is saved, without losing camera
// position or view settings." The watcher itself only detects and debounces change; it does
// not decide what to regenerate or touch the frontend's camera/view state at all -- that
// separation is what makes "without losing camera position" hold, the same way it holds for
// apps/vscode's PreviewPanel (see that package's previewPanel.ts: the webview's own
// viewer.ts/panel.ts never get recreated by a regenerate, only fed a fresh result).
//
// What it DOES report, since app.go started reloading one file at a time rather than the
// whole pack (see App.handlePackChanged), is WHICH paths changed -- a debounced batch is no
// longer a bare "something happened" ping but the set of paths that happened, so the reload
// can be about those files instead of about the directory they live in.
package main

import (
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// packWatchDebounce is how long the watcher waits after the last filesystem event before
// firing onChange -- editors commonly write a save as multiple events (truncate, write,
// rename a temp file into place), and a pack author saving several related files in quick
// succession (e.g. a feature and the rule that references it) should still trigger exactly
// one regenerate, not one per file.
const packWatchDebounce = 250 * time.Millisecond

// maxWatchBatch is the most individual paths one debounced batch will name. Past it the
// batch reports itself INCOMPLETE (see PackChange.Complete) rather than growing without
// bound, and the app falls back to re-reading the whole pack.
//
// The number is set where re-reading the whole pack stops being the more expensive answer,
// with a wide margin. On a large pack a full pack.Load measures roughly half a second for
// ~3,900 files, i.e. ~0.14ms per file, while one incremental path costs a single file read
// plus a slice splice; the per-batch cost that actually matters (the library rebuild inside
// Workspace.Update, ~100ms) is paid once no matter how many paths the batch names. Sixty-four
// paths is therefore still an order of magnitude cheaper than the full load it replaces, and
// well below any batch a human editing files could produce -- a batch bigger than this is a
// git checkout or a build step writing the pack, which is exactly when re-reading everything
// is both cheaper and more likely to be right.
const maxWatchBatch = 64

// PackChange is one debounced batch of filesystem activity under the watched root.
//
// Paths is every distinct path the batch saw, sorted, absolute, and cleaned -- files and
// directories alike, created, written, removed or renamed, since fsnotify does not tell the
// three apart in a way this layer could use anyway. Deciding what a given path means (a
// feature file to re-read, a directory whose creation nobody can splice, a stray editor temp
// file) is the app's job, not the watcher's -- see App.handlePackChanged.
//
// Complete is false when the batch could not be enumerated: more than maxWatchBatch distinct
// paths changed. A consumer must treat that as "everything may have changed" -- the Paths it
// does carry are then a subset, not the batch.
type PackChange struct {
	Paths    []string
	Complete bool
}

// PackWatcher recursively watches a pack root directory and calls onChange (debounced) after
// any create/write/remove/rename under it. fsnotify does not watch subdirectories
// automatically on any platform, so PackWatcher walks the tree once at construction and adds
// every directory individually, then adds newly created directories as they appear (a pack
// author adding a new features/<subdir>/ must not silently stop being watched).
type PackWatcher struct {
	watcher  *fsnotify.Watcher
	root     string
	onChange func(PackChange)

	mu sync.Mutex
	// pending is the set of paths seen since the last fire, and truncated records that it
	// stopped being the whole set (see maxWatchBatch). Both are reset by fire, so one
	// oversized batch never poisons the next one.
	pending   map[string]struct{}
	truncated bool
	timer     *time.Timer
	closed    bool
}

// NewPackWatcher starts watching root immediately. onChange is called from the watcher's own
// goroutine (after debouncing), never concurrently with itself -- a caller that needs to hop
// onto another goroutine/context (e.g. to call a Wails runtime function, which needs the
// app's context) must do that inside onChange itself.
func NewPackWatcher(root string, onChange func(PackChange)) (*PackWatcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &PackWatcher{watcher: fsw, root: root, onChange: onChange}
	if err := w.addRecursive(root); err != nil {
		fsw.Close()
		return nil, err
	}
	go w.loop()
	return w, nil
}

func (w *PackWatcher) addRecursive(dir string) error {
	return filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// A directory that vanishes mid-walk (deleted while we're watching) is not a
			// reason to fail starting the watcher on everything else under root.
			return nil
		}
		if d.IsDir() {
			_ = w.watcher.Add(path)
		}
		return nil
	})
}

func (w *PackWatcher) loop() {
	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			// A newly created directory needs to be watched too, or files saved inside it
			// later would go unnoticed -- e.g. a pack author adding features/new_category/.
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					_ = w.addRecursive(event.Name)
				}
			}
			w.recordChange(event.Name)
		case _, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			// fsnotify surfaces watch errors (e.g. a watched directory was removed out from
			// under it) on this channel -- these are not surfaced
			// to the UI specifically (the next generate call will fail loudly on its
			// own if the pack is genuinely gone), so they are swallowed here rather than
			// crashing the watcher goroutine.
			//
			// The batch is marked incomplete, though: an error here means events were or
			// could have been lost, and a consumer reloading only the paths it was told
			// about would then be reloading less than actually changed.
			w.recordChange("")
		}
	}
}

// recordChange adds one path to the pending batch and (re)arms the debounce timer. An empty
// path means "something changed but this layer cannot say what" (an fsnotify error), which
// truncates the batch rather than being dropped -- the same signal as an oversized batch,
// because it has the same consequence for the consumer.
func (w *PackWatcher) recordChange(path string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	switch {
	case path == "":
		w.truncated = true
	case len(w.pending) >= maxWatchBatch:
		// Already at the cap. Note this deliberately does not check whether the path is one
		// already in the set: at the cap the set is no longer the answer either way, and
		// pretending a duplicate keeps it complete would let a save storm over the same 64
		// files hide a 65th.
		w.truncated = true
	default:
		if w.pending == nil {
			w.pending = make(map[string]struct{}, 8)
		}
		w.pending[filepath.Clean(path)] = struct{}{}
	}
	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(packWatchDebounce, w.fire)
}

// fire hands the accumulated batch to onChange and starts a fresh one.
func (w *PackWatcher) fire() {
	w.mu.Lock()
	if w.closed {
		// Close raced this timer between it expiring and it acquiring the lock. Dropping the
		// batch is right: Close's contract is that no callback follows it.
		w.mu.Unlock()
		return
	}
	change := PackChange{Paths: make([]string, 0, len(w.pending)), Complete: !w.truncated}
	for p := range w.pending {
		change.Paths = append(change.Paths, p)
	}
	w.pending = nil
	w.truncated = false
	w.mu.Unlock()

	// Sorted so a batch is the same batch however the map happened to iterate -- the reload
	// it drives has to be reproducible, and a test asserting on a batch has to be able to.
	sort.Strings(change.Paths)
	w.onChange(change)
}

// Close stops the watcher and any pending debounced callback. Safe to call once; a second
// call is a no-op.
func (w *PackWatcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
	}
	w.mu.Unlock()
	return w.watcher.Close()
}
