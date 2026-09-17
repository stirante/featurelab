package session

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

// TestAppendFailureKey_MatchesLegacyConstruction pins appendFailureKey's
// equivalence classes to the exact byte layout the old inline construction
// produced (level + "\x00" + identifier + "\x00" + typeID + "\x00" + message
// + "\x00" + strings.Join(chainIDs, ">")): if the reused-buffer version ever
// drifts -- a separator dropped, the empty-chain shape changed -- previously
// distinct diagnostics would silently merge (or identical ones stop merging),
// changing Count totals on the wire.
func TestAppendFailureKey_MatchesLegacyConstruction(t *testing.T) {
	legacy := func(level, message string, chain []profiler.ChainFrame) string {
		var identifier, typeID string
		chainIDs := make([]string, len(chain))
		for i, f := range chain {
			chainIDs[i] = f.Identifier
		}
		if len(chain) > 0 {
			last := chain[len(chain)-1]
			identifier, typeID = last.Identifier, last.TypeID
		}
		return level + "\x00" + identifier + "\x00" + typeID + "\x00" + message + "\x00" + strings.Join(chainIDs, ">")
	}

	cases := []struct {
		name    string
		level   string
		message string
		chain   []profiler.ChainFrame
	}{
		{"empty chain", "warning", "iterations evaluated to zero", nil},
		{"one frame", "warning", "Block could not attach", []profiler.ChainFrame{
			{Identifier: "test:leaf", TypeID: "minecraft:single_block_feature"},
		}},
		{"three frames", "error", "budget hit", []profiler.ChainFrame{
			{Identifier: "test:root", TypeID: "minecraft:aggregate_feature"},
			{Identifier: "test:mid", TypeID: "minecraft:scatter_feature"},
			{Identifier: "test:leaf", TypeID: "minecraft:single_block_feature"},
		}},
		{"empty message", "warning", "", []profiler.ChainFrame{
			{Identifier: "a:b", TypeID: "t"},
		}},
	}

	var buf []byte
	for _, tc := range cases {
		buf = appendFailureKey(buf[:0], tc.level, tc.message, tc.chain)
		if got, want := string(buf), legacy(tc.level, tc.message, tc.chain); got != want {
			t.Errorf("%s: appendFailureKey = %q, want legacy layout %q", tc.name, got, want)
		}
	}

	// The reuse contract itself: a second call on the same buffer must not
	// leak bytes from the first.
	buf = appendFailureKey(buf[:0], "warning", "second", nil)
	if got, want := string(buf), legacy("warning", "second", nil); got != want {
		t.Errorf("buffer reuse: appendFailureKey = %q, want %q", got, want)
	}
}

// TestGenerate_DeduplicatesRepeatedIdenticalFailures pins the dedup-hit path
// of addPlacementFailure end to end: a zero-offset scatter running the SAME
// failing leaf 5 times must produce ONE diagnostic for the leaf with
// Count == 5 (not five entries, not Count 1), still carrying the first
// occurrence's chain and position. This is the path a pathological pack
// drives ~1M times per generation, so it is exactly the code the
// reused-buffer rewrite touched.
func TestGenerate_DeduplicatesRepeatedIdenticalFailures(t *testing.T) {
	config, ok := DefaultConfig(env.EnvUndergroundStone)
	if !ok {
		t.Fatal("DefaultConfig(underground_stone) should succeed")
	}
	config.FeatureIdentifier = strPtr("test:scatter5")

	scatterText := `{"format_version":"1.21.110","minecraft:scatter_feature":{"description":{"identifier":"test:scatter5"},` +
		`"places_feature":"test:leaf","distribution":{"iterations":5,"x":0,"y":0,"z":0}}}`
	// may_replace lists a block that is never present in the underground
	// stone environment, so every one of the 5 iterations fails identically.
	leafText := `{"format_version":"1.21.110","minecraft:single_block_feature":{"description":{"identifier":"test:leaf"},` +
		`"places_block":"minecraft:diamond_block","may_replace":["minecraft:obsidian"]}}`
	files := []features.SourceFile{
		{ID: "scatter5.json", AbsPath: "scatter5.json", Text: scatterText},
		{ID: "leaf.json", AbsPath: "leaf.json", Text: leafText},
	}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	var leafDiags []Diagnostic
	for _, d := range result.Diagnostics {
		if d.Identifier == "test:leaf" {
			leafDiags = append(leafDiags, d)
		}
	}
	if len(leafDiags) != 1 {
		t.Fatalf("got %d diagnostics for test:leaf, want exactly 1 deduplicated entry: %+v", len(leafDiags), leafDiags)
	}
	got := leafDiags[0]
	if got.Count != 5 {
		t.Errorf("Count = %d, want 5 (one per identical failed iteration)", got.Count)
	}
	wantChain := []string{"test:scatter5", "test:leaf"}
	if len(got.Chain) != len(wantChain) || got.Chain[0] != wantChain[0] || got.Chain[1] != wantChain[1] {
		t.Errorf("Chain = %v, want %v", got.Chain, wantChain)
	}
	if got.Position == nil {
		t.Error("Position = nil, want the first occurrence's position")
	} else if want := (wgen.BlockPos{X: config.OriginX, Y: result.Origin.Y, Z: config.OriginZ}); *got.Position != want {
		t.Errorf("Position = %+v, want %+v (zero-offset scatter over the origin)", *got.Position, want)
	}
	// Byte-exact message: single_block.go builds this by plain concatenation
	// (it used to be an fmt.Sprintf -- the message must not have drifted),
	// and it names the actual blocking block, which in the underground_stone
	// environment's origin cell is stone.
	if want := "may_replace rejected this position: it holds minecraft:stone, which is not in the replace list"; got.Message != want {
		t.Errorf("Message = %q, want %q", got.Message, want)
	}
}

// TestGenerate_LeafDeadlineAbortIsAPartialResultNotAStackTrace is the session-level half of
// features.TestLeafFeatureIsBoundedByThePlacementDeadline. That test proves the leaf loop stops;
// this one proves it stops the way the other budgets stop -- because "stops" is only half the
// contract a caller depends on.
//
// generate()'s recover switch turns four panic types into a partial result and RE-PANICS anything
// else. Before the leaf half of the deadline existed there was nothing to recover here at all: a
// geode with an enormous max_radius simply never returned, so the CLI hung, `serve` never answered
// and the VS Code panel sat on its spinner until its own client-side timeout fired and told the
// user, wrongly, that the engine was stale. What this pins is that the abort now arrives as:
// Partial true, an "error" diagnostic naming what was running, and whatever was written before the
// clock ran out still in the volume.
func TestGenerate_LeafDeadlineAbortIsAPartialResultNotAStackTrace(t *testing.T) {
	const geode = `{"format_version":"1.26.50","minecraft:geode_feature":{
		"description":{"identifier":"test:runaway_geode"},
		"filler":"minecraft:air","inner_layer":"minecraft:amethyst_block",
		"alternate_inner_layer":"minecraft:calcite","middle_layer":"minecraft:calcite",
		"outer_layer":"minecraft:smooth_basalt","inner_placements":["minecraft:amethyst_cluster"],
		"min_outer_wall_distance":4,"max_outer_wall_distance":6,"min_distribution_points":3,
		"max_distribution_points":4,"min_point_offset":1,"max_point_offset":2,
		"max_radius":2000000000,"crack_point_offset":2,"generate_crack_chance":0.95,
		"base_crack_size":2,"noise_multiplier":0.05,"use_potential_placements_chance":0.35,
		"use_alternate_layer0_chance":0.083,"placements_require_layer0_alternate":true,
		"invalid_blocks_threshold":1}}`

	config, ok := DefaultConfig(env.EnvUndergroundStone)
	if !ok {
		t.Fatal("DefaultConfig(underground_stone) should succeed")
	}
	id := "test:runaway_geode"
	config.FeatureIdentifier = &id
	config.PlacementTimeLimitMs = 100 // short so the test is fast; nothing else is lowered

	files := []features.SourceFile{{ID: "geode.json", AbsPath: "geode.json", Text: geode}}

	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if !result.Partial {
		t.Error("Partial = false, want true -- a run the clock cut short has not finished, and a caller " +
			"that cannot tell will present a truncated preview as the finished feature")
	}

	var found *Diagnostic
	for i := range result.Diagnostics {
		if strings.Contains(result.Diagnostics[i].Message, "wall-clock time limit") {
			found = &result.Diagnostics[i]
			break
		}
	}
	if found == nil {
		var got []string
		for _, d := range result.Diagnostics {
			got = append(got, d.Level+": "+d.Message)
		}
		t.Fatalf("no deadline diagnostic among %d: %s", len(result.Diagnostics), strings.Join(got, " | "))
	}
	if found.Level != "error" {
		t.Errorf("diagnostic level = %q, want \"error\" -- same level the other budget aborts report at", found.Level)
	}
	if !strings.Contains(found.Message, "max_radius") {
		t.Errorf("diagnostic = %q, want it to name the field driving the loop; \"placement time limit "+
			"exceeded\" on its own tells an author to raise the limit, which is the wrong move here",
			found.Message)
	}
	if !strings.Contains(found.Message, "partial result") {
		t.Errorf("diagnostic = %q, want the same partial-result framing the delegation-budget abort gives", found.Message)
	}
	if found.Identifier != id {
		t.Errorf("diagnostic identifier = %q, want %q -- the chain is captured at the raise site so the "+
			"feature that actually ran out of time is named", found.Identifier, id)
	}
	// Nothing was written before the abort in THIS case, and that is not a gap in the contract --
	// it is what the input asks for. The geode's column scan begins at origin.Z - max_radius, two
	// billion columns before it reaches the geode's own core, so a hundred milliseconds does not
	// buy a single write. The "whatever was written so far survives" half of the contract is
	// pinned by the growing-plant case below, which writes from its first iteration.
	if result.BlocksChanged != 0 {
		t.Logf("BlocksChanged = %d (informational -- see comment)", result.BlocksChanged)
	}
}

// TestGenerate_LeafDeadlineAbortKeepsWhatWasAlreadyWritten is the other half of the partial-result
// contract, on an input whose loop writes as it goes rather than scanning for two billion cells
// first: a growing_plant asked for a column two billion blocks tall. A truncation that threw away
// the partial volume would leave the preview blank and tell the author nothing about what their
// feature actually builds, which is the difference between a useful abort and a useless one.
func TestGenerate_LeafDeadlineAbortKeepsWhatWasAlreadyWritten(t *testing.T) {
	const plant = `{"format_version":"1.26.50","minecraft:growing_plant_feature":{
		"description":{"identifier":"test:runaway_plant"},
		"height_distribution":[[2000000000,1]],
		"growth_direction":"UP",
		"body_blocks":[["minecraft:oak_leaves",1]],
		"head_blocks":[["minecraft:oak_leaves",1]]}}`

	config, ok := DefaultConfig(env.EnvVoid) // all air, so every layer places
	if !ok {
		t.Fatal("DefaultConfig(void) should succeed")
	}
	id := "test:runaway_plant"
	config.FeatureIdentifier = &id
	config.PlacementTimeLimitMs = 100

	files := []features.SourceFile{{ID: "plant.json", AbsPath: "plant.json", Text: plant}}
	result, err := Generate(config, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if !result.Partial {
		t.Error("Partial = false, want true")
	}
	if result.BlocksChanged == 0 {
		t.Error("BlocksChanged = 0 -- the blocks written before the clock ran out must survive the abort")
	}
	var messages []string
	for _, d := range result.Diagnostics {
		messages = append(messages, d.Message)
	}
	joined := strings.Join(messages, " | ")
	if !strings.Contains(joined, "wall-clock time limit") || !strings.Contains(joined, "height_distribution") {
		t.Errorf("diagnostics = %s, want a wall-clock abort naming height_distribution", joined)
	}
}
