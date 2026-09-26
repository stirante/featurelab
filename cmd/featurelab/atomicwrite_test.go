package main

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A reader polling the file while it is rewritten must only ever see a
// complete version -- the old bytes or the new ones, never an empty or partial
// file. This is the failure os.WriteFile produced for the editor's watcher.
func TestWriteFileAtomicNeverShowsAPartialFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "feature.json")
	a := []byte(`{"format_version":"1.21.0","minecraft:single_block_feature":{"description":{"identifier":"t:a"}}}`)
	b := []byte(`{"format_version":"1.21.0","minecraft:single_block_feature":{"description":{"identifier":"t:bbbbbbbbbbbbbbbb"}}}`)
	if err := os.WriteFile(path, a, 0o644); err != nil {
		t.Fatal(err)
	}

	var stop atomic.Bool
	var bad atomic.Int64
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for !stop.Load() {
			got, err := os.ReadFile(path)
			if err != nil {
				// A reader can lose a race with the rename on Windows; that is
				// a failed read, not a partial one, and it retries.
				continue
			}
			if string(got) != string(a) && string(got) != string(b) {
				bad.Add(1)
			}
			// A watcher reads once per change, not in a tight loop; a loop
			// that never lets go would hold the file open on Windows for the
			// whole run and push every save onto the in-place fallback.
			time.Sleep(200 * time.Microsecond)
		}
	}()
	for i := 0; i < 300; i++ {
		data := a
		if i%2 == 0 {
			data = b
		}
		if err := writeFileAtomic(path, data, 0o644); err != nil {
			stop.Store(true)
			wg.Wait()
			t.Fatalf("write %d: %v", i, err)
		}
	}
	stop.Store(true)
	wg.Wait()
	if n := bad.Load(); n != 0 {
		t.Fatalf("a reader saw %d partial or empty versions of the file", n)
	}
}

// A successful save leaves exactly the target behind: no temporary files in
// the pack directory, which a user would otherwise find next to their feature.
func TestWriteFileAtomicLeavesNoTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new.json")
	if err := writeFileAtomic(path, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []byte(`{"a":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "new.json" {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("directory holds %v, want only new.json", names)
	}
	got, _ := os.ReadFile(path)
	if string(got) != `{"a":1}` {
		t.Fatalf("contents = %q", got)
	}
}

// A failed save must not leave its temporary file behind either.
func TestWriteFileAtomicCleansUpOnFailure(t *testing.T) {
	dir := t.TempDir()
	// The target is a directory, so the final rename cannot replace it.
	target := filepath.Join(dir, "occupied")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "keep"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(target, []byte("x"), 0o644); err == nil {
		t.Fatal("expected replacing a non-empty directory to fail")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("directory holds %d entries after a failed save, want 1", len(entries))
	}
}

// On Windows a reader that never lets go of the file blocks the rename for
// good. The save must still land, through the in-place fallback, rather than
// fail the user's edit.
func TestWriteFileAtomicFallsBackWhenTheTargetStaysOpen(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows refuses to rename over an open file")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "held.json")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	held, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	if err := writeFileAtomic(path, []byte("new"), 0o644); err != nil {
		t.Fatalf("save failed while the file was held open: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "new" {
		t.Fatalf("contents = %q, want new", got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("directory holds %d entries, want 1 (no leftover temporary file)", len(entries))
	}
}
