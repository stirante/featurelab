package main

// Shared test fixtures for this package's own test files (serve_test.go, check.go's tests,
// etc.) -- generate_test.go used to declare these before its buildConfig/GenerateParams/
// GenerateOutput coverage moved to featurelab-go/wire (see wire/wire_test.go), so they live
// here now, independent of any one _test.go file's own subject.

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func singleBlockFeatureJSON(identifier, placesBlock string) string {
	return `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"` +
		identifier + `"},"enforce_placement_rules":false,"enforce_survivability_rules":false,"places_block":"` + placesBlock + `"}}`
}

// scatterFeatureFixedOffsetJSON builds a minecraft:scatter_feature body that places exactly once,
// at a FIXED (non-random) offset from origin -- a plain number for a distribution axis is a
// constant offset, not a range (see session/profiler_test.go's own scatterFeatureFile) -- so the
// resulting write position is deterministic. Used by this package's out-of-bounds/grow tests to
// write somewhere predictably outside a small bench.
func scatterFeatureFixedOffsetJSON(identifier, placesFeature string, dx, dy, dz int) string {
	return `{"format_version":"1.21.110","minecraft:scatter_feature":{"description":{"identifier":"` + identifier +
		`"},"places_feature":"` + placesFeature + `","distribution":{"iterations":1,"x":` + itoaHelper(dx) + `,"y":` + itoaHelper(dy) + `,"z":` + itoaHelper(dz) + `}}}`
}

func itoaHelper(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [24]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
