package main

// delegation_cycle_cli_test.go pins what a delegation cycle does, through the real `featurelab
// generate` pipeline. The game has no recursion guard: A -> B -> A keeps recursing until a link
// declines on its own (checked in game, 1.26.60.22, with exactly the sequence + scatter pair
// below). This tool used to refuse A's second delegation and place one block where the game
// places a column. A loop that never declines is stopped by features.MaxDelegationDepth, a
// tooling limit, instead of overflowing the Go stack.

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func writeCyclePack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		// A places a gold block, then hands the gold's cell to B.
		"a.json": `{"format_version":"1.21.110","minecraft:sequence_feature":{
			"description":{"identifier":"t:a"},"features":["t:gold","t:b"]}}`,
		// B moves one block up and places A again.
		"b.json": `{"format_version":"1.21.110","minecraft:scatter_feature":{
			"description":{"identifier":"t:b"},"places_feature":"t:a",
			"distribution":{"iterations":1,"x":0,"y":1,"z":0}}}`,
		"gold.json": `{"format_version":"1.21.110","minecraft:single_block_feature":{
			"description":{"identifier":"t:gold"},"enforce_placement_rules":false,
			"enforce_survivability_rules":false,"places_block":"minecraft:gold_block",
			"may_replace":["minecraft:air"]}}`,
		// Two scatters pointing at each other at offset 0: nothing in the loop ever declines.
		"loop.json": `{"format_version":"1.21.110","minecraft:scatter_feature":{
			"description":{"identifier":"t:loop"},"places_feature":"t:loop2",
			"distribution":{"iterations":1,"x":0,"y":0,"z":0}}}`,
		"loop2.json": `{"format_version":"1.21.110","minecraft:scatter_feature":{
			"description":{"identifier":"t:loop2"},"places_feature":"t:loop",
			"distribution":{"iterations":1,"x":0,"y":0,"z":0}}}`,
	}
	for name, body := range files {
		writeTestFile(t, filepath.Join(root, "features", name), body)
	}
	return root
}

type cycleResult struct {
	BlocksPlaced int  `json:"blocksPlaced"`
	Partial      bool `json:"partial"`
	Diagnostics  []struct {
		Level   string `json:"level"`
		Message string `json:"message"`
	} `json:"diagnostics"`
}

func generateCycle(t *testing.T, root, feature string) cycleResult {
	t.Helper()
	args := []string{"generate", "--pack", root, "--feature", feature, "--env", "void",
		"--origin", "0,0,0", "--size", "8x32x8"}
	var code int
	out := captureStdout(t, func() { code = run(args) })
	var r cycleResult
	if err := json.Unmarshal(out, &r); err != nil {
		t.Fatalf("run(%v) = %d, output is not JSON: %v\n%s", args, code, err, out)
	}
	return r
}

// TestCmdGenerate_DelegationCycle_RecursesLikeTheGame: the cycle keeps going until the gold
// placement fails, which in a void bench is the top of the volume (y 0..23 of -8..23).
func TestCmdGenerate_DelegationCycle_RecursesLikeTheGame(t *testing.T) {
	r := generateCycle(t, writeCyclePack(t), "t:a")
	if r.BlocksPlaced != 24 {
		t.Fatalf("blocksPlaced = %d, want 24 (a gold column from the origin to the top of the volume; "+
			"1 means a recursion guard the game does not have refused the cycle)", r.BlocksPlaced)
	}
	for _, d := range r.Diagnostics {
		if strings.Contains(d.Message, "internal feature") {
			t.Errorf("unexpected diagnostic %q: the cycle must not be refused", d.Message)
		}
	}
}

// TestCmdGenerate_DelegationCycle_EndlessLoopStopsAtDepthLimit: a loop with no declining link
// must end as a partial result with a diagnostic, not a fatal Go stack overflow.
func TestCmdGenerate_DelegationCycle_EndlessLoopStopsAtDepthLimit(t *testing.T) {
	r := generateCycle(t, writeCyclePack(t), "t:loop")
	if !r.Partial {
		t.Error("partial = false, want true")
	}
	found := false
	for _, d := range r.Diagnostics {
		if d.Level == "error" && strings.Contains(d.Message, "delegation depth limit hit") {
			found = true
		}
	}
	if !found {
		t.Errorf("no delegation-depth error among diagnostics: %+v", r.Diagnostics)
	}
}
