package profiler

import (
	"reflect"
	"testing"
)

// TestAppendChain_MatchesCurrentChainAndReusesBuffer pins AppendChain's two
// contracts: it must report exactly what CurrentChain reports (same frames,
// same root-first order, profiling off included -- it exists so the per-
// failure diagnostic path can read the chain without CurrentChain's fresh
// allocation), and it must append into the caller's buffer so a
// `buf = AppendChain(buf[:0])` loop reuses capacity instead of allocating.
func TestAppendChain_MatchesCurrentChainAndReusesBuffer(t *testing.T) {
	if ProfilingActive {
		t.Fatal("test assumes profiling off")
	}

	if got := AppendChain(nil); len(got) != 0 {
		t.Fatalf("AppendChain(nil) with empty stack = %v, want empty", got)
	}

	PushFeatureFrame("test:root", "minecraft:aggregate_feature")
	PushFeatureFrame("test:mid", "minecraft:scatter_feature")
	PushFeatureFrame("test:leaf", "minecraft:single_block_feature")
	defer func() {
		PopFeatureFrame()
		PopFeatureFrame()
		PopFeatureFrame()
	}()

	want := CurrentChain()
	buf := make([]ChainFrame, 0, 8)
	got := AppendChain(buf[:0])
	if !reflect.DeepEqual(got, want) {
		t.Errorf("AppendChain = %v, want CurrentChain's %v", got, want)
	}

	// Reuse: a second call on the same buffer must not grow past the
	// original capacity (3 frames fit in 8) and must yield the same frames.
	got2 := AppendChain(got[:0])
	if &got2[0] != &got[0] {
		t.Error("AppendChain reallocated despite sufficient capacity -- the reuse contract is broken")
	}
	if !reflect.DeepEqual(got2, want) {
		t.Errorf("second AppendChain = %v, want %v", got2, want)
	}
}
