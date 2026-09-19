package main

// packnotices_test.go covers printPackNotices: the prose half of the levelling `check` already
// does on its diagnostic rows.
//
// The gap it closes is one tool telling two stories about one fact. `check` calls "structures
// directory does not exist -- 0 structures files loaded (fine if this pack has none)" an info
// row; `generate` and `graph` printed the identical sentence prefixed "featurelab: warning:".
// Four of them, on a pack with features/ and nothing else, which is a perfectly ordinary pack.
// A reader had no way to tell which of the two levels was the truth, and a warning whose own
// text ends "(fine if this pack has none)" is how a tool teaches people to skip its warnings.

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/pack"
)

// captureStderr is captureStdout's twin -- these notices are written straight to os.Stderr by
// the commands that print them, which is the whole point of them going there (stdout is a JSON
// document a caller pipes somewhere). Reads in a background goroutine while fn runs for the
// same reason captureStdout does; see there.
func captureStderr(t *testing.T, fn func()) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = orig }()

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

// ordinaryPack is a pack with features/ and nothing else: no structures, no feature_rules, no
// biomes, no blocks. Nothing is wrong with it, and pack.Load says so four times.
func ordinaryPack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "gold.json"),
		singleBlockFeatureJSON("wiki:gold_block", "minecraft:gold_block"))
	return root
}

func TestPrintPackNotices_ConventionalDirectoryAPackLacksIsANote(t *testing.T) {
	loaded, err := pack.Load(pack.Options{Dir: ordinaryPack(t)})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	printPackNotices(&buf, loaded)

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("printed %d lines, want 4 (structures, feature_rules, biomes, blocks):\n%s", len(lines), buf.String())
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, "featurelab: note: ") {
			t.Errorf("line %q is not a note -- a directory this pack simply does not have is not a warning", line)
		}
	}
	// Still SAID, at every level. Dropping them is how a mistyped --features starts looking
	// like a pack with no features.
	if !strings.Contains(buf.String(), "biomes") {
		t.Errorf("the biomes notice went missing entirely:\n%s", buf.String())
	}
}

// The other half of the same decision, and the reason it is taken from pack.MissingDir.Explicit
// rather than from the sentence: a directory someone TYPED and that is not there is a typo.
func TestPrintPackNotices_ExplicitlyNamedMissingDirectoryStaysAWarning(t *testing.T) {
	root := ordinaryPack(t)
	loaded, err := pack.Load(pack.Options{Dir: root, BiomesDir: filepath.Join(root, "not_biomes_at_all")})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	printPackNotices(&buf, loaded)

	var found bool
	for _, line := range strings.Split(buf.String(), "\n") {
		if !strings.Contains(line, "not_biomes_at_all") {
			continue
		}
		found = true
		if !strings.HasPrefix(line, "featurelab: warning: ") {
			t.Errorf("line %q, want it still printed as a warning", line)
		}
	}
	if !found {
		t.Fatalf("nothing named the explicitly given biomes directory:\n%s", buf.String())
	}
}

// TestPrintPackNotices_AgreesWithTheLevelCheckGives is the anti-drift assertion, and the reason
// this prints through packWarningLevel rather than through a rule of its own. One tool, one
// level per fact: whatever `check` calls a notice in its LEVEL column is what a terminal line
// about it has to be labelled.
func TestPrintPackNotices_AgreesWithTheLevelCheckGives(t *testing.T) {
	root := ordinaryPack(t)
	loaded, err := pack.Load(pack.Options{Dir: root, BiomesDir: filepath.Join(root, "not_biomes_at_all")})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	printPackNotices(&buf, loaded)
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != len(loaded.Warnings) {
		t.Fatalf("printed %d lines for %d notices", len(lines), len(loaded.Warnings))
	}
	for i, notice := range loaded.Warnings {
		want := "featurelab: warning: "
		if packWarningLevel(loaded, notice) == LevelInfo {
			want = "featurelab: note: "
		}
		if !strings.HasPrefix(lines[i], want) {
			t.Errorf("line %q, want prefix %q -- check levels this notice %q",
				lines[i], want, packWarningLevel(loaded, notice))
		}
	}
}

// The two commands that actually print them, asserted from where a person reads them. These
// used to be the only place in the tool that still called these notices warnings.
func TestGenerateAndGraph_DoNotCallAnOrdinaryPackAWarning(t *testing.T) {
	root := ordinaryPack(t)
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"generate", []string{"generate", "--pack", root, "--feature", "wiki:gold_block", "--env", "void", "--size", "4x4x4"}},
		{"graph", []string{"graph", "--pack", root}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var stderr []byte
			// stdout is a JSON document either way; swallow it so the test output stays readable.
			captureStdout(t, func() {
				stderr = captureStderr(t, func() { run(tc.args) })
			})
			text := string(stderr)
			if strings.Contains(text, "warning:") {
				t.Errorf("%s called an ordinary pack's missing conventional directories warnings:\n%s", tc.name, text)
			}
			if !strings.Contains(text, "featurelab: note: ") {
				t.Errorf("%s printed no notices at all -- they must still be said, just not as warnings:\n%s", tc.name, text)
			}
		})
	}
}
