package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"
)

// waitForChange blocks until ch receives a batch or timeout elapses, failing the test on
// timeout -- the shared helper every PackWatcher test below uses instead of a fixed sleep, so
// these tests are not flaky under a slow CI machine (they wait up to the timeout, not exactly
// packWatchDebounce).
func waitForChange(t *testing.T, ch <-chan PackChange, timeout time.Duration) PackChange {
	t.Helper()
	select {
	case change := <-ch:
		return change
	case <-time.After(timeout):
		t.Fatal("timed out waiting for PackWatcher's onChange callback")
		return PackChange{}
	}
}

// startWatcher starts a PackWatcher on dir delivering its batches to the returned channel.
func startWatcher(t *testing.T, dir string, buffer int) (*PackWatcher, chan PackChange) {
	t.Helper()
	changed := make(chan PackChange, buffer)
	w, err := NewPackWatcher(dir, func(c PackChange) { changed <- c })
	if err != nil {
		t.Fatalf("NewPackWatcher: %v", err)
	}
	return w, changed
}

func TestPackWatcher_FiresOnFileWrite(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)
	t.Cleanup(func() { _ = w.Close() })

	path := filepath.Join(dir, "feature.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	change := waitForChange(t, changed, 2*time.Second)

	// The batch has to NAME the file, not just report that something happened: App.
	// handlePackChanged reloads the paths it is given and falls back to a full pack.Load for
	// anything it is not.
	if !change.Complete {
		t.Errorf("batch for one write reported itself incomplete: %+v", change)
	}
	if len(change.Paths) != 1 || change.Paths[0] != path {
		t.Errorf("batch paths = %v, want exactly [%s]", change.Paths, path)
	}
}

func TestPackWatcher_DebouncesRapidWrites(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 32)
	t.Cleanup(func() { _ = w.Close() })

	// Five saves in immediate succession -- a real editor writing a feature file this fast
	// (or a pack author saving several related files back to back) must still collapse into
	// exactly one onChange call, not five, per this app's core loop requirement ("regenerate
	// when a file is saved" -- not "regenerate five times for one logical save").
	//
	// recordChange is driven DIRECTLY rather than by writing files, for exactly the reason
	// TestPackWatcher_OversizedBatchReportsItselfIncomplete below already records. This test's
	// subject is the DEBOUNCE, and going through the filesystem makes it additionally depend on
	// the OS delivering all five events inside one 250ms window. Under load it does not: this
	// failed on a busy machine with a second onChange arriving after the first, which is not the
	// debounce being wrong, it is the fifth write's event landing after the timer had already
	// fired. A test that fails for a reason unrelated to its subject teaches the next reader to
	// re-run rather than to look, which is how a real failure gets waved through.
	path := filepath.Join(dir, "feature.json")
	for i := 0; i < 5; i++ {
		w.recordChange(path)
	}
	change := waitForChange(t, changed, 2*time.Second)
	if len(change.Paths) != 1 || change.Paths[0] != path {
		t.Errorf("five writes to one file produced batch paths %v, want exactly [%s]", change.Paths, path)
	}

	// Give any (incorrect) extra debounced fires a chance to arrive before asserting there
	// were none -- packWatchDebounce is 250ms, so 800ms of quiet is generous headroom.
	select {
	case extra := <-changed:
		t.Fatalf("expected exactly one onChange call for five rapid writes to the same file, got a second one: %+v", extra)
	case <-time.After(800 * time.Millisecond):
	}

	// A sixth change AFTER the batch fired must produce a SECOND batch. Without this the test
	// passes just as happily against a watcher that fires once and then never again, which is a
	// worse bug than firing five times: the app would go quiet and the author would think their
	// edits were being ignored. Deterministic -- it depends on the timer re-arming, not on how
	// long anything takes.
	w.recordChange(path)
	again := waitForChange(t, changed, 2*time.Second)
	if len(again.Paths) != 1 || again.Paths[0] != path {
		t.Errorf("a change after the first batch produced %v, want exactly [%s] -- the debounce "+
			"timer has to re-arm, not fire once for the life of the watcher", again.Paths, path)
	}
}

// What the test above does NOT catch, stated rather than left for someone to discover: a debounce
// that still exists but is absurdly short. Recording five times in a tight loop and then firing
// coalesces either way, so a one-nanosecond window passes. It catches the failure that actually
// gets written -- firing on every change with no debounce at all -- and it catches a timer that
// never re-arms. Driving the filesystem instead would catch the short-window case too, because
// real writes are milliseconds apart; that is the version this test used to be, and it failed on a
// busy machine for a reason unrelated to its subject, which is the worse trade.

// TestPackWatcher_BatchesEveryChangedPath is the multi-file save: one debounced batch has to
// carry every path that changed inside the window, since the reload it drives handles them
// together (see App.reloadChangedLocked) and a path missing from the batch is a file that
// silently keeps its stale preview.
func TestPackWatcher_BatchesEveryChangedPath(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)
	t.Cleanup(func() { _ = w.Close() })

	first := filepath.Join(dir, "feature.json")
	second := filepath.Join(dir, "rule.json")
	for _, p := range []string{first, second} {
		if err := os.WriteFile(p, []byte(`{}`), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}

	change := waitForChange(t, changed, 2*time.Second)
	if !change.Complete {
		t.Errorf("batch for two writes reported itself incomplete: %+v", change)
	}
	// Sorted, so this comparison is against the batch itself and not against whichever order
	// the watcher's map happened to iterate in.
	if len(change.Paths) != 2 || change.Paths[0] != first || change.Paths[1] != second {
		t.Errorf("batch paths = %v, want [%s %s]", change.Paths, first, second)
	}
}

// TestPackWatcher_OversizedBatchReportsItselfIncomplete pins the other half of the batching
// decision: past maxWatchBatch the watcher stops claiming to know what changed. It still
// fires -- the app must still reload -- but the batch says it is not the whole set, which is
// what makes App.handlePackChanged re-read the entire pack instead of the paths it was handed.
func TestPackWatcher_OversizedBatchReportsItselfIncomplete(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)
	t.Cleanup(func() { _ = w.Close() })

	// recordChange is driven DIRECTLY rather than by writing files, for the same reason the
	// error-channel test does it: this test's subject is the cap, and going through the
	// filesystem makes it depend on the OS delivering all 72 events inside one debounce window.
	// Under load it does not -- this failed on a busy machine with "a batch of 59 paths claimed
	// to be complete", which is not the cap being wrong, it is 13 events arriving late. A test
	// that fails for a reason unrelated to its subject teaches the next reader to re-run rather
	// than to look, which is how a real failure gets waved through.
	for i := 0; i < maxWatchBatch+8; i++ {
		w.recordChange(filepath.Join(dir, fmt.Sprintf("feature_%03d.json", i)))
	}

	change := waitForChange(t, changed, 5*time.Second)
	if change.Complete {
		t.Fatalf("a batch of %d paths claimed to be complete (cap is %d)", len(change.Paths), maxWatchBatch)
	}
	if len(change.Paths) > maxWatchBatch {
		t.Errorf("batch kept %d paths, more than the %d cap", len(change.Paths), maxWatchBatch)
	}

	// The next batch must start clean: one oversized batch is not a reason for every later
	// save to take the slow road forever.
	if err := os.WriteFile(filepath.Join(dir, "after.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	next := waitForChange(t, changed, 5*time.Second)
	for !next.Complete && len(next.Paths) >= maxWatchBatch {
		// The writes above can straddle the debounce window on a slow machine, producing more
		// than one oversized batch; keep reading until the tail of them is through.
		next = waitForChange(t, changed, 5*time.Second)
	}
	if !next.Complete {
		t.Errorf("the batch after an oversized one still reported itself incomplete: %+v", next)
	}
}

func TestPackWatcher_WatchesNewlyCreatedSubdirectories(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)
	t.Cleanup(func() { _ = w.Close() })

	subdir := filepath.Join(dir, "new_category")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	waitForChange(t, changed, 2*time.Second) // the Create event for the directory itself

	// A pack author adding features/new_category/ and immediately saving a file inside it --
	// the watcher must have picked up the new directory in time to see this write too.
	inside := filepath.Join(subdir, "feature.json")
	if err := os.WriteFile(inside, []byte(`{}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	change := waitForChange(t, changed, 2*time.Second)
	found := false
	for _, p := range change.Paths {
		if p == inside {
			found = true
		}
	}
	if !found {
		t.Errorf("batch paths = %v, want them to include %s", change.Paths, inside)
	}
}

func TestPackWatcher_CloseStopsFurtherCallbacks(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// A second Close must be a safe no-op (app.go's shutdown may race a LoadPack replacing
	// the watcher -- see app.go's own doc comment).
	if err := w.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}

	if err := os.WriteFile(filepath.Join(dir, "feature.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	select {
	case change := <-changed:
		t.Fatalf("expected no onChange call after Close, got %+v", change)
	case <-time.After(600 * time.Millisecond):
	}
}

// TestPackWatcher_AnUnattributablEventMarksTheBatchIncomplete covers the
// watcher's other truncation signal. maxWatchBatch is one way a batch stops
// being the whole set; the other is an fsnotify error, which loop() reports
// by recording the empty path (see recordChange's own comment) -- an error
// there means events were or could have been lost, so the batch it belongs
// to is no longer the answer either.
//
// Nothing else exercises this: fsnotify's Errors channel cannot be made to
// fire on demand from a test, so recordChange is driven directly, exactly
// as loop() drives it. Without the truncation the batch would claim to be
// complete, App.handlePackChanged would take the incremental route, and it
// would reload the handful of paths that did get through while everything
// lost with the error silently kept its stale preview.
func TestPackWatcher_AnUnattributableEventMarksTheBatchIncomplete(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)
	t.Cleanup(func() { _ = w.Close() })

	known := filepath.Join(dir, "feature.json")
	w.recordChange(known)
	w.recordChange("") // what loop() does for an fsnotify error

	change := waitForChange(t, changed, 2*time.Second)
	if change.Complete {
		t.Errorf("batch = %+v, want Complete false -- an error means events may have been lost, so the paths it names are a subset and not the batch", change)
	}
	// It still fires, and still names what it does know: the app must still
	// reload, it just has to reload everything.
	if len(change.Paths) != 1 || change.Paths[0] != known {
		t.Errorf("batch paths = %v, want the one path that did get through (%s)", change.Paths, known)
	}
}

// TestPackWatcher_FireDropsABatchWhoseTimerRacedClose pins Close's contract
// -- "no callback follows it" -- for the one case that can break it. Close
// stops the debounce timer, so the ordinary path never reaches fire at all;
// the race the guard inside fire exists for is a timer that had ALREADY
// expired and was waiting on the mutex when Close took it. Only a direct
// call reproduces that, so this makes one, exactly as the expired timer
// would.
//
// Without the guard the callback runs after shutdown has torn the app down:
// App.handlePackChanged would reload against a closed app and emit
// "pack:changed" through a Wails context that is no longer running, which
// that runtime answers with log.Fatalf (see App.emitEvent's own comment).
func TestPackWatcher_FireDropsABatchWhoseTimerRacedClose(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)

	w.recordChange(filepath.Join(dir, "feature.json"))
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// The timer that expired just before Close acquired the lock, arriving
	// now that Close has released it.
	w.fire()

	select {
	case change := <-changed:
		t.Fatalf("onChange ran after Close: %+v -- Close promises no callback follows it", change)
	default:
	}
}

// TestPackWatcher_BatchIsSortedNotInWhateverOrderTheMapIterated is
// TestPackWatcher_BatchesEveryChangedPath's ordering half, made decisive.
// That test compares two paths, so a batch left in map order matches the
// sorted one about half the time and the assertion passes or fails by luck.
// Eight paths, recorded in exactly the reverse of their sorted order, make
// the answer the code's rather than the map's.
//
// The order is load-bearing rather than cosmetic: App.reloadChangedLocked
// splices a batch's paths one after another into a copy of the pack, so a
// batch that arrives in a different order each time is a reload that cannot
// be reproduced -- and neither can a test of one.
func TestPackWatcher_BatchIsSortedNotInWhateverOrderTheMapIterated(t *testing.T) {
	dir := t.TempDir()
	w, changed := startWatcher(t, dir, 8)
	t.Cleanup(func() { _ = w.Close() })

	var want []string
	for i := 7; i >= 0; i-- {
		p := filepath.Join(dir, fmt.Sprintf("feature_%d.json", i))
		w.recordChange(p)
		want = append(want, p)
	}
	sort.Strings(want)

	change := waitForChange(t, changed, 2*time.Second)
	if !reflect.DeepEqual(change.Paths, want) {
		t.Errorf("batch paths =\n%v\nwant them sorted:\n%v", change.Paths, want)
	}
}
