package jsonc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// BenchmarkDuplicateKeys measures what the duplicate-key check costs a pack load, against the
// thing it sits beside: the json.Unmarshal every loader already does on the same bytes.
//
// It is a real vanilla feature file rather than a synthetic one, because the ratio is what
// matters and the ratio depends on shape -- a document that is mostly one long string parses very
// differently from one that is thousands of small members.
//
// Read the two together. DuplicateKeys re-parses the document, so it is not free; the question a
// reviewer should be able to answer from this benchmark is whether it is a fraction of the
// existing parse or a multiple of it.
func BenchmarkDuplicateKeys(b *testing.B) {
	src := benchSource(b)
	b.SetBytes(int64(len(src)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if d := DuplicateKeys(src); len(d) != 0 {
			b.Fatalf("fixture has duplicates: %+v", d)
		}
	}
}

// BenchmarkUnmarshal is the baseline the number above is only meaningful next to.
func BenchmarkUnmarshal(b *testing.B) {
	src := benchSource(b)
	b.SetBytes(int64(len(src)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var root map[string]any
		if err := json.Unmarshal(src, &root); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkStripComments is the other pass every loader already makes, for scale.
func BenchmarkStripComments(b *testing.B) {
	raw := benchRaw(b)
	b.SetBytes(int64(len(raw)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		StripComments(raw)
	}
}

func benchRaw(b *testing.B) []byte {
	b.Helper()
	path := filepath.Join("..", "pack", "testdata", "vanilla-trees", "features", "fancy_oak_tree_feature.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		b.Skipf("fixture unavailable: %v", err)
	}
	return raw
}

func benchSource(b *testing.B) []byte {
	b.Helper()
	return StripComments(benchRaw(b))
}
