package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// captureStdout redirects os.Stdout for the duration of fn and returns everything written to
// it -- cmdGenerate (see main.go) writes its JSON result straight to os.Stdout, not an injectable
// io.Writer, so this is the only way to assert on the CLI's own output rather than only on the
// wire/serve layers underneath it.
//
// Reads from the pipe in a background goroutine WHILE fn runs (not after fn returns): a
// grown-and-regenerated volume's JSON is easily tens of KB (blocks/baseline arrays plus base64
// changed/removed masks), comfortably larger than an anonymous pipe's OS buffer -- reading only
// after fn() returns deadlocks the writer (fn) against a reader that never starts, exactly the
// classic io.Pipe/os.Pipe producer-consumer trap.
func captureStdout(t *testing.T, fn func()) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = orig }()

	done := make(chan []byte, 1)
	go func() {
		out, _ := io.ReadAll(r)
		done <- out
	}()

	fn()

	if err := w.Close(); err != nil {
		t.Fatalf("closing pipe writer: %v", err)
	}
	return <-done
}

// TestCmdGenerate_GrowFlagProducesGrownGenerateOutput proves `featurelab generate --grow` is
// wired end to end: a scatter_feature placing a fixed offset outside a small bench captures that
// write on a plain `generate` call, and `--grow` produces a JSON response with grown:true plus a
// bench large enough to actually contain it -- see wire.RunGenerateGrown, which this flag calls.
func TestCmdGenerate_GrowFlagProducesGrownGenerateOutput(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "leaf.json"), singleBlockFeatureJSON("test:leaf", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "features", "root.json"), scatterFeatureFixedOffsetJSON("test:root", "test:leaf", 100, 0, 0))

	args := []string{
		"generate", "--pack", root, "--feature", "test:root", "--env", "void",
		"--origin", "0,0,0", "--size", "8x8x8", "--grow",
	}

	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if m["grown"] != true {
		t.Errorf("grown = %v, want true", m["grown"])
	}
	if m["preGrowBounds"] == nil {
		t.Error("preGrowBounds should be present when grown is true")
	}
	if m["writesOutOfBounds"].(float64) != 0 {
		t.Errorf("writesOutOfBounds = %v, want 0 (the grown bench contains the write)", m["writesOutOfBounds"])
	}

	// Without --grow, the same request must NOT carry grown/preGrowBounds at all -- the plain
	// `generate` contract stays exactly as it was before this flag existed.
	plainArgs := args[:len(args)-1] // drop --grow
	var plainCode int
	plainOut := captureStdout(t, func() {
		plainCode = run(plainArgs)
	})
	if plainCode != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", plainArgs, plainCode, plainOut)
	}
	var pm map[string]any
	if err := json.Unmarshal(plainOut, &pm); err != nil {
		t.Fatalf("plain output is not valid JSON: %v\n%s", err, plainOut)
	}
	if _, ok := pm["grown"]; ok {
		t.Errorf("plain (non-grow) generate output should not carry a \"grown\" key at all, got %v", pm["grown"])
	}
	if pm["writesOutOfBounds"].(float64) != 1 {
		t.Errorf("plain generate writesOutOfBounds = %v, want 1", pm["writesOutOfBounds"])
	}
}
