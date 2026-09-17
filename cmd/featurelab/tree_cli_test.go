package main

// tree_cli_test.go grows a REAL minecraft:tree_feature using the canopy shapes
// ("canopy", "fancy_canopy", "spruce_canopy", "random_spread_canopy", "roofed_canopy") through the
// actual `featurelab generate` CLI entry point -- not a features-package unit test calling
// simpleCanopy.place/fancyCanopy.place/spruceCanopy.place/... directly, but the full pack-load ->
// build -> place -> JSON-encode pipeline a real user/tool would drive. See
// featurelab-go/features/tree.go's header and tree_test.go for the derivation and the
// package-level unit coverage this exercises end to end.

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/session"
)

func treeCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "trunk": { "trunk_block": "minecraft:oak_log", "trunk_height": 5 },
	    "canopy": {
	      "leaf_block": "minecraft:oak_leaves",
	      "canopy_offset": { "min": -2, "max": 0 },
	      "min_width": 1
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_CanopyKey_GrowsRealTree runs `featurelab generate` against a real
// pack containing a minecraft:tree_feature using the bare "canopy" key, and
// confirms the resulting volume actually contains a trunk column of oak_log plus a step-pyramid
// canopy of oak_leaves -- the SAME shape features/tree_test.go pins directly, now proven reachable
// through the real CLI/build/place pipeline, not just a package-internal unit test.
func TestCmdGenerate_TreeFeature_CanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "oak.json"), treeCanopyFeatureJSON("test:oak"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:oak", "--env", "void",
		"--origin", "5,10,5", "--size", "16x40x16",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:oak_log")
	leafID, haveLeaf := idOf("minecraft:oak_leaves")
	if !haveLog {
		t.Fatal("minecraft:oak_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:oak_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	// Index order matches volume.Volume.index (volume/volume.go): Y-major, then Z, then X --
	// i.e. (y-MinY)*(SizeX*SizeZ) + (z-MinZ)*SizeX + (x-MinX). NOT the X-major order it's easy to
	// guess instead; verified against a real generate output before writing this.
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	// The acacia trunk leans (see tree.go header's RNG-derived lean logic), so the trunk's own
	// column can drift away from origin.X/Z -- track the topmost log cell's own (x,z) rather than
	// assuming the column stays under origin, so the cross-section below is centered on wherever
	// the real trunk (and therefore the canopy anchored to its top) actually ended up.
	logCount, leafCount := 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				case leafID:
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no oak_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no oak_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 5 {
		t.Errorf("logCount = %d, want 5 (trunk_height=5, may_replace:[air] protects every log from the canopy's own leaf gate)", logCount)
	}
	t.Logf("real CLI-grown tree: %d log cells, %d leaf cells, %d total blocksPlaced, topmost log at (%d,%d,%d)",
		logCount, leafCount, result.BlocksPlaced, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the actual
	// step-pyramid canopy silhouette (see tree_test.go's pinned shape) is visible here too, grown
	// through the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY + 1; y >= topLogY-5; y-- {
		for x := topLogX - 4; x <= topLogX+4; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeFancyCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "trunk": { "trunk_block": "minecraft:oak_log", "trunk_height": 5 },
	    "fancy_canopy": {
	      "leaf_block": "minecraft:oak_leaves",
	      "height": 4,
	      "radius": 3
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_FancyCanopyKey_GrowsRealTree runs `featurelab generate` against a
// temporary pack containing a minecraft:tree_feature using the "fancy_canopy" key,
// and confirms the resulting volume actually contains a trunk column of oak_log plus the tapered
// disc-stack canopy of oak_leaves -- the SAME shape features/tree_test.go pins directly via
// TestFancyCanopy_Place_TaperedDiscStack_CrossSections, now proven reachable through the real
// CLI/build/place pipeline, not just a package-internal unit test.
func TestCmdGenerate_TreeFeature_FancyCanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "oak_fancy.json"), treeFancyCanopyFeatureJSON("test:oak_fancy"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:oak_fancy", "--env", "void",
		"--origin", "5,10,5", "--size", "16x40x16",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:oak_log")
	leafID, haveLeaf := idOf("minecraft:oak_leaves")
	if !haveLog {
		t.Fatal("minecraft:oak_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:oak_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount := 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				case leafID:
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no oak_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no oak_leaves cells placed anywhere -- expected a canopy")
	}
	// height=4/radius=3: caps (dy=0,3) place a 5-cell plus disc each, middle layers (dy=1,2) place a
	// 21-cell rounded disc each -- 2*5 + 2*21 = 52 cells match the mask, matching
	// TestFancyCanopy_Place_TaperedDiscStack_CrossSections's own pinned per-layer counts exactly.
	//
	// [UPDATED 2026-08-22] This used to expect 51, i.e. 52 minus the bottom cap's own center cell,
	// which sat exactly on the topmost trunk log and could not be overwritten (oak_log is not in
	// may_replace:[air]). The bare `trunk` key is the simple trunk now, which anchors
	// its canopy at lastPlacedLog.Y + 1 -- one cell HIGHER than the acacia trunk's "the topmost log
	// itself". Nothing about the canopy changed; the whole stack simply sits one cell up, so no mask
	// cell collides with a log any more and all 52 land. The cross-section below shows the trunk
	// poking out below the canopy rather than into it.
	if leafCount != 52 {
		t.Errorf("leafCount = %d, want 52 (the full mask -- the canopy now anchors one cell above the topmost log, so no cell is blocked by it)", leafCount)
	}
	t.Logf("real CLI-grown fancy_canopy tree: %d log cells, %d leaf cells, %d total blocksPlaced, topmost log at (%d,%d,%d)",
		logCount, leafCount, result.BlocksPlaced, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the actual
	// tapered-blob canopy silhouette (see tree_test.go's pinned shape) is visible here too, grown
	// through the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY + 4; y >= topLogY-1; y-- {
		for x := topLogX - 4; x <= topLogX+4; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown fancy_canopy tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeSpruceCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "trunk": { "trunk_block": "minecraft:spruce_log", "trunk_height": 7 },
	    "spruce_canopy": {
	      "leaf_block": "minecraft:spruce_leaves",
	      "lower_offset": { "range_min": -6, "range_max": -2 },
	      "upper_offset": { "range_min": 0, "range_max": 2 },
	      "max_radius": { "range_min": 1, "range_max": 3 }
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_SpruceCanopyKey_GrowsRealTree runs `featurelab generate` against a
// temporary pack containing a minecraft:tree_feature using the "spruce_canopy" key,
// and confirms the resulting volume actually contains a trunk column of spruce_log plus a tiered
// canopy of spruce_leaves grown through the real CLI/build/place pipeline -- the spruce canopy draws
// real RNG (unlike fancy_canopy), so this test does not hard-pin an exact leaf count the way the
// fancy_canopy CLI test does; it proves the shape is reachable end to end and shows the actual
// alternating-tier silhouette (see features/tree_test.go's TestSpruceCanopy_Place_TieredCrossSections
// for the count-level proof this exercises).
func TestCmdGenerate_TreeFeature_SpruceCanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "spruce.json"), treeSpruceCanopyFeatureJSON("test:spruce"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:spruce", "--env", "void",
		"--origin", "5,20,5", "--size", "24x50x24", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:spruce_log")
	leafID, haveLeaf := idOf("minecraft:spruce_leaves")
	if !haveLog {
		t.Fatal("minecraft:spruce_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:spruce_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount := 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				case leafID:
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no spruce_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no spruce_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 7 {
		t.Errorf("logCount = %d, want 7 (trunk_height=7, may_replace:[air] protects every log from the canopy's own leaf gate)", logCount)
	}
	t.Logf("real CLI-grown spruce_canopy tree: %d log cells, %d leaf cells, %d total blocksPlaced, topmost log at (%d,%d,%d)",
		logCount, leafCount, result.BlocksPlaced, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the real
	// alternating-tier canopy silhouette (see features/tree_test.go's own pinned shape) is visible
	// here too, grown through the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY + 3; y >= topLogY-9; y-- {
		for x := topLogX - 5; x <= topLogX+5; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown spruce_canopy tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeRandomSpreadCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "acacia_trunk": {
	      "trunk_block": "minecraft:oak_log",
	      "trunk_width": 1,
	      "trunk_height": { "base": 7, "min_height_for_canopy": 0 },
	      "trunk_lean": {
	        "allow_diagonal_growth": true,
	        "lean_height": { "range_min": 0, "range_max": 0 },
	        "lean_steps": { "range_min": 0, "range_max": 0 }
	      }
	    },
	    "random_spread_canopy": {
	      "canopy_height": { "range_min": 2, "range_max": 4 },
	      "canopy_radius": { "range_min": 2, "range_max": 4 },
	      "leaf_placement_attempts": 4,
	      "leaf_blocks": [["minecraft:oak_leaves", 1.0]]
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_RandomSpreadCanopyKey_GrowsRealTree runs `featurelab generate`
// against a temporary pack containing a minecraft:tree_feature using the "random_spread_canopy" key,
// and confirms the resulting volume actually contains a trunk column of
// oak_log plus leaves scattered around candidates drawn from the FULL log column (not just the
// topmost position) -- the trunk-candidate-vector wiring this port added specifically for this
// shape (see features/tree.go's module header). The random-spread canopy draws real RNG (like
// spruce_canopy), so this does not hard-pin an exact leaf count; it proves the shape is reachable
// end to end and shows leaves appearing at MULTIPLE Y levels along the trunk, not clustered only
// near the top the way every other implemented canopy in this file is.
//
// [REBASED ONTO acacia_trunk 2026-08-22] This fixture used the bare `trunk` key, which was wrongly
// dispatched to an acacia-trunk-shaped path. The bare key is the simple trunk, which
// hands the canopy an EMPTY candidates vector -- and this canopy is one of the only two that READ
// that vector, early-returning with zero draws and zero blocks when it is empty. On the old fixture
// this test grew a bare pole: 7 logs, 0 leaves. That is faithful to the engine (a bare `trunk` plus
// this canopy really does grow a pole in game), but it is not a test of this canopy, so the fixture
// moves to the trunk class whose push_back builds the vector. lean_height/lean_steps are pinned
// degenerate so the column stays straight and vertical, and min_height_for_canopy is 0 so every log
// is collected, not just those above index 3.
//
// canopy_height/canopy_radius were also widened from {0,3}/{1,3} to {2,4}/{2,4}. Both still draw
// once, but they can no longer yield a radius of 1 -- and radiusVal==1 makes the X/Z jitter
// (dx1-radiusVal)+dx2+1 identically ZERO, collapsing the whole "scatter" into the trunk column
// where may_replace:[air] then rejects every cell. The old fixture only passed because its seed
// happened to draw a radius of 2 or 3; that was luck, not coverage.
func TestCmdGenerate_TreeFeature_RandomSpreadCanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "oak_spread.json"), treeRandomSpreadCanopyFeatureJSON("test:oak_spread"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:oak_spread", "--env", "void",
		"--origin", "5,20,5", "--size", "24x50x24", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:oak_log")
	leafID, haveLeaf := idOf("minecraft:oak_leaves")
	if !haveLog {
		t.Fatal("minecraft:oak_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:oak_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount := 0, 0
	topLogY, bottomLogY := b.MinY-1, b.MinY+b.SizeY
	topLogX, topLogZ := origin.X, origin.Z
	leafYSet := map[int]bool{}
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
					if y < bottomLogY {
						bottomLogY = y
					}
				case leafID:
					leafCount++
					leafYSet[y] = true
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no oak_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no oak_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 7 {
		t.Errorf("logCount = %d, want 7 (trunk_height=7, may_replace:[air] protects every log from the canopy's own leaf gate)", logCount)
	}
	// The defining property this test exists to prove: leaves must appear across MULTIPLE distinct
	// Y levels spanning a real fraction of the trunk's own height range, not clustered only near the
	// topmost log the way acacia/pine/canopy/fancy_canopy/spruce_canopy all are (each of those reads
	// only a single anchor -- see module header). A canopy that (wrongly) only received the topmost
	// candidate would still pass every other assertion in this test.
	if len(leafYSet) < 3 {
		t.Errorf("leaves appear at only %d distinct Y level(s), want >= 3 -- random_spread_canopy should scatter "+
			"leaf clusters around candidates drawn from the WHOLE log column (Y %d..%d), not just the topmost one",
			len(leafYSet), bottomLogY, topLogY)
	}
	t.Logf("real CLI-grown random_spread_canopy tree: %d log cells, %d leaf cells across %d distinct Y levels, "+
		"%d total blocksPlaced, log column Y %d..%d, topmost log at (%d,%d,%d)",
		logCount, leafCount, len(leafYSet), result.BlocksPlaced, bottomLogY, topLogY, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column spanning the
	// WHOLE log column (plus overshoot for canopy_radius) so the scattered-around-every-candidate
	// silhouette is visible here too, grown through the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY + 3; y >= bottomLogY-3; y-- {
		for x := topLogX - 5; x <= topLogX+5; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown random_spread_canopy tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeRoofedCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "trunk": { "trunk_block": "minecraft:oak_log", "trunk_height": 5 },
	    "roofed_canopy": {
	      "leaf_block": "minecraft:oak_leaves",
	      "canopy_height": 2,
	      "core_width": 1,
	      "outer_radius": 2,
	      "inner_radius": 1
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_RoofedCanopyKey_GrowsRealTree runs `featurelab generate` against a
// temporary pack containing a minecraft:tree_feature using the "roofed_canopy" key,
// and confirms the resulting volume actually contains a trunk column of oak_log plus the
// solid-floor / corner-cut-wall / chamfered-roof-cap / optional-peak hut silhouette
// features/tree_test.go pins directly via TestRoofedCanopy_Place_HutCrossSections, now proven
// reachable through the real CLI/build/place pipeline, not just a package-internal unit test.
// The roofed canopy draws exactly ONE RNG value (NextBoolean, gating the peak) -- see module header
// -- so this does not hard-pin an exact leaf count, but DOES pin the floor being fully solid (zero
// RNG there), which no seed choice can change.
func TestCmdGenerate_TreeFeature_RoofedCanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "oak_roofed.json"), treeRoofedCanopyFeatureJSON("test:oak_roofed"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:oak_roofed", "--env", "void",
		"--origin", "5,20,5", "--size", "20x40x20", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:oak_log")
	leafID, haveLeaf := idOf("minecraft:oak_leaves")
	if !haveLog {
		t.Fatal("minecraft:oak_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:oak_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount := 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				case leafID:
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no oak_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no oak_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 5 {
		t.Errorf("logCount = %d, want 5 (trunk_height=5)", logCount)
	}
	// The floor is ZERO-RNG and outer_radius=2 -- a full solid 5x5 square one Y level below the
	// canopy anchor, regardless of seed. This is the one count this test CAN hard-pin -- "solid"
	// counts as leafID OR logID: the center cell is the trunk's own topmost log, which blocks the
	// leaf gate's own IsAir check exactly the way any other non-air block would (see module header:
	// roofed_canopy's own gate has no may_replace fallback at all), so it stays a log, not a leaf --
	// still proof the floor's own placement attempt reached every one of the 25 cells.
	//
	// [UPDATED 2026-08-22] The floor probe moved from topLogY-1 to topLogY. Nothing about
	// roofed_canopy changed: the bare `trunk` key is the simple trunk now, which anchors the canopy
	// at lastPlacedLog.Y + 1 instead of the acacia trunk's "the topmost log itself", so the whole
	// canopy -- floor included -- sits one cell higher. Probing the old level found 1 solid cell
	// (the topmost log alone), which is what a stale reference point looks like.
	floorSolid := 0
	for dx := -2; dx <= 2; dx++ {
		for dz := -2; dz <= 2; dz++ {
			if v := at(topLogX+dx, topLogY, topLogZ+dz); v == leafID || v == logID {
				floorSolid++
			}
		}
	}
	if floorSolid != 25 {
		t.Errorf("floor (y=anchor-1=topLog) has %d solid (leaf or log) cells, want 25 (a full solid 5x5 square, zero RNG -- see module header)", floorSolid)
	}
	t.Logf("real CLI-grown roofed_canopy tree: %d log cells, %d leaf cells, %d total blocksPlaced, "+
		"floorSolid=%d (want 25), topmost log at (%d,%d,%d)",
		logCount, leafCount, result.BlocksPlaced, floorSolid, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the actual
	// hut silhouette (see tree_test.go's pinned shape) is visible here too, grown through the real
	// CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY + 3; y >= topLogY-1; y-- {
		for x := topLogX - 3; x <= topLogX+3; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown roofed_canopy tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeMangroveCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "acacia_trunk": {
	      "trunk_block": "minecraft:mangrove_log",
	      "trunk_width": 1,
	      "trunk_height": { "base": 7, "min_height_for_canopy": 0 },
	      "trunk_lean": {
	        "allow_diagonal_growth": true,
	        "lean_height": { "range_min": 0, "range_max": 0 },
	        "lean_steps": { "range_min": 0, "range_max": 0 }
	      }
	    },
	    "mangrove_canopy": {
	      "canopy_height": { "range_min": 2, "range_max": 4 },
	      "canopy_radius": { "range_min": 2, "range_max": 4 },
	      "leaf_placement_attempts": 6,
	      "leaf_blocks": [["minecraft:mangrove_leaves", 1.0]],
	      "hanging_block": "minecraft:mangrove_roots",
	      "hanging_block_placement_chance": 100
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_MangroveCanopyKey_GrowsRealTree runs `featurelab generate` against a
// temporary pack containing a minecraft:tree_feature using the "mangrove_canopy" key, and confirms
// the resulting volume actually contains a trunk column of
// mangrove_log, a scattered canopy of mangrove_leaves (the same propagule-jitter shape
// features/tree_test.go pins directly), AND at least one mangrove_roots hanging-root cell placed
// one cell below some leaf -- the prop-root/hash-adjacency pass this port added specifically for
// this shape (see features/tree.go's module header). hanging_block_placement_chance:100 makes every
// non-occupied, non-obstructed propagule commit a root deterministically (percent>=100 draws
// nothing and always returns true), so a void environment (guaranteed clear air below every
// propagule) should reliably produce at least one root without needing to pin an exact RNG seed.
//
// [REBASED ONTO acacia_trunk 2026-08-22] This fixture used the bare `trunk` key, which was wrongly
// dispatched to an acacia-trunk-shaped path. The bare key is the simple trunk, which
// hands the canopy an EMPTY candidates vector -- and this canopy is one of the only two that READ
// that vector, early-returning with zero draws and zero blocks when it is empty. On the old fixture
// this test grew a bare pole: 7 logs, 0 leaves. That is faithful to the engine (a bare `trunk` plus
// this canopy really does grow a pole in game), but it is not a test of this canopy, so the fixture
// moves to the trunk class whose push_back builds the vector. lean_height/lean_steps are pinned
// degenerate so the column stays straight and vertical, and min_height_for_canopy is 0 so every log
// is collected, not just those above index 3.
func TestCmdGenerate_TreeFeature_MangroveCanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "mangrove.json"), treeMangroveCanopyFeatureJSON("test:mangrove"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:mangrove", "--env", "void",
		"--origin", "5,20,5", "--size", "24x50x24", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:mangrove_log")
	leafID, haveLeaf := idOf("minecraft:mangrove_leaves")
	rootID, haveRoot := idOf("minecraft:mangrove_roots")
	if !haveLog {
		t.Fatal("minecraft:mangrove_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:mangrove_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount, rootCount := 0, 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				case leafID:
					leafCount++
				default:
					if haveRoot && at(x, y, z) == rootID {
						rootCount++
					}
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no mangrove_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no mangrove_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 7 {
		t.Errorf("logCount = %d, want 7 (trunk_height=7, may_replace:[air] protects every log from the canopy's own leaf gate)", logCount)
	}
	// hanging_block_placement_chance:100 -- every non-occupied, non-obstructed propagule commits a
	// root deterministically, and a void environment guarantees clear air below every propagule --
	// so at least one root cell is the expected, not merely hoped-for, outcome.
	if !haveRoot || rootCount == 0 {
		t.Errorf("no mangrove_roots cells placed anywhere -- want >= 1 (hanging_block_placement_chance:100 "+
			"in a void environment should always commit a root for at least one propagule); rootCount=%d", rootCount)
	}
	t.Logf("real CLI-grown mangrove_canopy tree: %d log cells, %d leaf cells, %d hanging-root cells, "+
		"%d total blocksPlaced, topmost log at (%d,%d,%d)",
		logCount, leafCount, rootCount, result.BlocksPlaced, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the scattered
	// propagule canopy plus hanging roots are visible here too, grown through the real CLI, not just
	// asserted as a count.
	var art strings.Builder
	for y := topLogY + 5; y >= topLogY-9; y-- {
		for x := topLogX - 5; x <= topLogX+5; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				if haveRoot && at(x, y, topLogZ) == rootID {
					art.WriteByte('R')
				} else {
					art.WriteByte('.')
				}
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown mangrove_canopy tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, R=hanging root, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeMegaCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "trunk": { "trunk_block": "minecraft:oak_log", "trunk_height": 5 },
	    "mega_canopy": {
	      "leaf_block": "minecraft:oak_leaves",
	      "canopy_height": { "range_min": 5, "range_max": 6 },
	      "core_width": 1,
	      "base_radius": 2
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_MegaCanopyKey_GrowsRealTree runs `featurelab generate` against a real
// pack containing a minecraft:tree_feature using the "mega_canopy" key, and
// confirms the resulting volume actually contains a trunk column of oak_log plus a wide, downward-
// flaring cone of oak_leaves (features/tree_test.go's own TestMegaCanopy_Place_ConeCrossSections
// pins the exact per-layer radii directly; this proves the same shape survives the full pack-load ->
// build -> place -> JSON-encode pipeline). canopy_height={5,6} makes canopy_height.getValue draw
// nothing (min>=max-1), so the shape is deterministic (value=5, radii 6,5,4,3,2) regardless of seed.
func TestCmdGenerate_TreeFeature_MegaCanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "oak_mega.json"), treeMegaCanopyFeatureJSON("test:oak_mega"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:oak_mega", "--env", "void",
		"--origin", "10,20,10", "--size", "30x40x30", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:oak_log")
	leafID, haveLeaf := idOf("minecraft:oak_leaves")
	if !haveLog {
		t.Fatal("minecraft:oak_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:oak_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount := 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				case leafID:
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no oak_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no oak_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 5 {
		t.Errorf("logCount = %d, want 5 (trunk_height=5)", logCount)
	}
	// canopy_height={5,6} draws nothing (min>=max-1) -- value=5, base_radius=2, core_width=1 ->
	// radii 6,5,4,3,2 across dy=-4..0 relative to the CANOPY ANCHOR (see tree_test.go's own pinned
	// cross-section). The widest layer (dy=-4, radius=6) must contain its own exact-radius cell
	// (r,0) -- may_replace:[air] means the log column itself never blocks a leaf cell.
	//
	// [UPDATED 2026-08-22] The anchor is topLogY+1, not topLogY: the bare `trunk` key is the
	// simple trunk now, which anchors the canopy one cell above the topmost log rather than on
	// it. The canopy shape is unchanged; only this probe's reference point was stale.
	anchorY := topLogY + 1
	if got := at(topLogX+6, anchorY-4, topLogZ); got != leafID {
		t.Errorf("widest layer (dy=-4, radius=6) cell (+6,0) = %d, want leafID=%d", got, leafID)
	}
	t.Logf("real CLI-grown mega_canopy tree: %d log cells, %d leaf cells, %d total blocksPlaced, "+
		"topmost log at (%d,%d,%d)",
		logCount, leafCount, result.BlocksPlaced, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the actual
	// downward-flaring cone silhouette (see tree_test.go's pinned shape) is visible here too, grown
	// through the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY; y >= topLogY-4; y-- {
		for x := topLogX - 6; x <= topLogX+6; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown mega_canopy tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeMegaPineCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "trunk": { "trunk_block": "minecraft:spruce_log", "trunk_height": 5 },
	    "mega_pine_canopy": {
	      "leaf_block": "minecraft:spruce_leaves",
	      "canopy_height": { "range_min": 8, "range_max": 9 },
	      "core_width": 1,
	      "base_radius": 2,
	      "radius_step_modifier": 3.5
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_MegaPineCanopyKey_GrowsRealTree runs `featurelab generate` against a
// temporary pack containing a minecraft:tree_feature using the "mega_pine_canopy" key, and confirms
// the resulting volume actually contains a trunk column of
// spruce_log plus a stepped-taper cone of spruce_leaves (features/tree_test.go's own
// TestMegaPineCanopy_Place_SteppedTaperCrossSections pins the exact per-layer radii directly; this
// proves the same shape survives the full pack-load -> build -> place -> JSON-encode pipeline).
// canopy_height={8,9} makes canopy_height.getValue draw nothing (min>=max-1), so the shape is
// deterministic (value=8, radii 5,5,4,4,3,3,2,2,2, modulo the anchor-Y-parity "bump" -- see
// megaPineRadiusFor) regardless of seed.
func TestCmdGenerate_TreeFeature_MegaPineCanopyKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "spruce_mega_pine.json"), treeMegaPineCanopyFeatureJSON("test:spruce_mega_pine"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:spruce_mega_pine", "--env", "void",
		"--origin", "10,20,10", "--size", "30x40x30", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:spruce_log")
	leafID, haveLeaf := idOf("minecraft:spruce_leaves")
	if !haveLog {
		t.Fatal("minecraft:spruce_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:spruce_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount := 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				case leafID:
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no spruce_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no spruce_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 5 {
		t.Errorf("logCount = %d, want 5 (trunk_height=5)", logCount)
	}
	// The topmost layer (dy=0) is ALWAYS exactly base_radius=2, with no bump (see
	// megaPineRadiusFor's own doc comment) -- the one radius this test can hard-pin regardless of
	// the real trunk-top world Y's own parity.
	if got := at(topLogX+2, topLogY, topLogZ); got != leafID {
		t.Errorf("top layer (dy=0, radius=2) cell (+2,0) = %d, want leafID=%d", got, leafID)
	}
	t.Logf("real CLI-grown mega_pine_canopy tree: %d log cells, %d leaf cells, %d total blocksPlaced, "+
		"topmost log at (%d,%d,%d)",
		logCount, leafCount, result.BlocksPlaced, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the actual
	// stepped-taper silhouette (see tree_test.go's pinned shape) is visible here too, grown through
	// the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY; y >= topLogY-8; y-- {
		for x := topLogX - 6; x <= topLogX+6; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown mega_pine_canopy tree, vertical (X/Y) cross-section through the trunk's top column (L=log, #=leaves, .=air), origin=%+v:\n%s", origin, art.String())
}

func treeCanBeSubmergedFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "trunk": {
	      "trunk_block": "minecraft:oak_log",
	      "trunk_height": 6,
	      "can_be_submerged": { "max_depth": 5 }
	    },
	    "canopy": {
	      "leaf_block": "minecraft:oak_leaves",
	      "canopy_offset": { "min": -2, "max": 0 },
	      "min_width": 1
	    },
	    "may_replace": ["minecraft:air"],
	    "may_grow_through": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_CanBeSubmerged_GrowsRealTree runs `featurelab generate` against a
// temporary pack containing a minecraft:tree_feature whose trunk sets can_be_submerged (a simple-trunk
// field -- see features/tree.go's placeSubmergedTrunk
// and module header), and confirms the resulting volume actually contains a trunk column that
// starts BELOW the requested origin -- the whole point of can_be_submerged: a tree whose base is
// underwater grows up from the floor, not from the surface. The "void" environment is uniform air,
// so may_grow_through:["minecraft:air"] makes every one of max_depth's 5 probes pass
// unconditionally, giving a fully deterministic 5-block relocation to check against, regardless of
// seed -- the same descent mechanic real water would trigger, just demonstrated with air standing
// in for "the submersible medium" since the CLI's void preset has no water column to place a tree
// in.
func TestCmdGenerate_TreeFeature_CanBeSubmerged_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "oak_submerged.json"), treeCanBeSubmergedFeatureJSON("test:oak_submerged"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:oak_submerged", "--env", "void",
		"--origin", "5,20,5", "--size", "16x40x16",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idOf := func(name string) (int, bool) {
		for i, e := range result.Palette {
			if e.Name == name {
				return i, true
			}
		}
		return 0, false
	}
	logID, haveLog := idOf("minecraft:oak_log")
	leafID, haveLeaf := idOf("minecraft:oak_leaves")
	if !haveLog {
		t.Fatal("minecraft:oak_log never appears in the output palette -- trunk was not placed")
	}
	if !haveLeaf {
		t.Fatal("minecraft:oak_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount := 0, 0
	topLogY, bottomLogY := b.MinY-1, b.MinY+b.SizeY
	topLogX, topLogZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch at(x, y, z) {
				case logID:
					logCount++
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
					if y < bottomLogY {
						bottomLogY = y
					}
				case leafID:
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no oak_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no oak_leaves cells placed anywhere -- expected a canopy")
	}
	if logCount != 6 {
		t.Errorf("logCount = %d, want 6 (trunk_height=6)", logCount)
	}
	// The defining property this test exists to prove: can_be_submerged.max_depth=5 relocates the
	// trunk's own BOTTOM log 5 cells below the requested origin.Y -- a plain acacia-trunk-shaped
	// tree (every other CLI test in this file) always starts AT origin.Y. void's uniform air plus
	// may_grow_through:["minecraft:air"] makes this exact, not merely "somewhere lower".
	if wantBottom := origin.Y - 5; bottomLogY != wantBottom {
		t.Errorf("bottommost log Y = %d, want %d (origin.Y=%d minus max_depth=5 -- can_be_submerged's own descent)",
			bottomLogY, wantBottom, origin.Y)
	}
	if topLogY != bottomLogY+5 {
		t.Errorf("topmost log Y = %d, want bottomLogY+5 = %d (trunk_height=6 -> 6 contiguous logs)", topLogY, bottomLogY+5)
	}
	t.Logf("real CLI-grown can_be_submerged tree: %d log cells, %d leaf cells, %d total blocksPlaced, "+
		"requested origin.Y=%d, log column Y %d..%d (relocated %d cells below origin), topmost log at (%d,%d,%d)",
		logCount, leafCount, result.BlocksPlaced, origin.Y, bottomLogY, topLogY, origin.Y-bottomLogY, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section spanning from the canopy above the top log down through
	// the relocated bottom log, so the "trunk starts below the marked origin, canopy sits above it as
	// usual" shape is visible here too, grown through the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := topLogY + 3; y >= bottomLogY-1; y-- {
		marker := ' '
		if y == origin.Y {
			marker = 'o' // the requested origin.Y, for reference
		}
		art.WriteByte(byte(marker))
		art.WriteByte(' ')
		for x := topLogX - 3; x <= topLogX+3; x++ {
			switch at(x, y, topLogZ) {
			case logID:
				art.WriteByte('L')
			case leafID:
				art.WriteByte('#')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown can_be_submerged tree, vertical (X/Y) cross-section through the trunk's top column "+
		"(L=log, #=leaves, .=air, 'o'=requested origin.Y), origin=%+v:\n%s", origin, art.String())
}

func treeCherryCanopyFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "cherry_trunk": {
	      "trunk_block": "minecraft:cherry_log",
	      "trunk_height": { "base": 5, "intervals": [2] },
	      "branches": {
	        "tree_type_weights": {
	          "one_branch": 1,
	          "two_branches": 1,
	          "two_branches_and_trunk": 1
	        },
	        "branch_horizontal_length": { "range_min": 2, "range_max": 4 },
	        "branch_start_offset_from_top": { "range_min": -4, "range_max": -3 },
	        "branch_end_offset_from_top": { "range_min": -1, "range_max": 0 },
	        "branch_canopy": {
	          "cherry_canopy": {
	            "leaf_block": "minecraft:cherry_leaves",
	            "height": 5,
	            "radius": 4,
	            "wide_bottom_layer_hole_chance": 25,
	            "corner_hole_chance": 25,
	            "hanging_leaves_chance": 16.6666667,
	            "hanging_leaves_extension_chance": 33.3333333
	          }
	        }
	      }
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_CherryTrunk_VanillaJSONGrowsMultipleCanopies runs `featurelab
// generate` against a temporary pack containing the vanilla-shaped top-level cherry_trunk and nested
// branches.branch_canopy.cherry_canopy objects. It requires opposing branch extents, x/z-axis logs,
// and leaves spanning the ordered tips, proving the real CLI/build/place pipeline exercises both
// trunk and multi-anchor canopy dispatch rather than the former synthetic Acacia-trunk pairing.
func TestCmdGenerate_TreeFeature_CherryTrunk_VanillaJSONGrowsMultipleCanopies(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "cherry.json"), treeCherryCanopyFeatureJSON("test:cherry"))

	args := []string{
		"generate", "--pack", root, "--feature", "test:cherry", "--env", "void",
		"--origin", "12,20,12", "--size", "28x40x28", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name   string
			States map[string]any
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idsOf := func(name string) map[int]struct{} {
		ids := map[int]struct{}{}
		for i, e := range result.Palette {
			if e.Name == name {
				ids[i] = struct{}{}
			}
		}
		return ids
	}
	logIDs := idsOf("minecraft:cherry_log")
	leafIDs := idsOf("minecraft:cherry_leaves")
	if len(logIDs) == 0 {
		t.Fatal("minecraft:cherry_log never appears in the output palette -- trunk was not placed")
	}
	if len(leafIDs) == 0 {
		t.Fatal("minecraft:cherry_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount, axisLogCount := 0, 0, 0
	topLogY := b.MinY - 1
	topLogX, topLogZ := origin.X, origin.Z
	minLogX, maxLogX, minLogZ, maxLogZ := origin.X, origin.X, origin.Z, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				id := at(x, y, z)
				if _, ok := logIDs[id]; ok {
					logCount++
					minLogX, maxLogX = min(minLogX, x), max(maxLogX, x)
					minLogZ, maxLogZ = min(minLogZ, z), max(maxLogZ, z)
					if axis, ok := result.Palette[id].States["pillar_axis"].(string); ok && (axis == "x" || axis == "z") {
						axisLogCount++
					}
					if y > topLogY {
						topLogY, topLogX, topLogZ = y, x, z
					}
				} else if _, ok := leafIDs[id]; ok {
					leafCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no cherry_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no cherry_leaves cells placed anywhere -- expected a canopy")
	}
	if axisLogCount == 0 {
		t.Error("no pillar_axis=x/z cherry logs found -- diagonal branch path was not generated")
	}
	multipleOpposingTips := minLogX < origin.X && maxLogX > origin.X || minLogZ < origin.Z && maxLogZ > origin.Z
	if !multipleOpposingTips {
		t.Fatalf("log extents X=%d..%d Z=%d..%d around origin (%d,%d): want opposing branches and multiple canopy anchors",
			minLogX, maxLogX, minLogZ, maxLogZ, origin.X, origin.Z)
	}
	t.Logf("real vanilla-shaped cherry.json: %d log cells (%d pillar-axis branch cells), %d leaf cells, %d total blocksPlaced; log extents X=%d..%d Z=%d..%d, topmost log at (%d,%d,%d)",
		logCount, axisLogCount, leafCount, result.BlocksPlaced, minLogX, maxLogX, minLogZ, maxLogZ, topLogX, topLogY, topLogZ)

	// Render a vertical (X/Y) cross-section through the trunk's own top X/Z column so the actual
	// cherry canopy silhouette (wide-bottom holes, corner holes, hanging leaves below the bottom two
	// layers) is visible here too, grown through the real CLI, not just asserted as a count.
	var art strings.Builder
	useX := maxLogX-minLogX >= maxLogZ-minLogZ
	for y := topLogY + 3; y >= topLogY-6; y-- {
		for offset := -10; offset <= 10; offset++ {
			x, z := origin.X, origin.Z
			if useX {
				x += offset
			} else {
				z += offset
			}
			id := at(x, y, z)
			if _, ok := logIDs[id]; ok {
				art.WriteByte('L')
			} else if _, ok := leafIDs[id]; ok {
				art.WriteByte('#')
			} else {
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	axis := "Z/Y"
	if useX {
		axis = "X/Y"
	}
	t.Logf("real vanilla-shaped cherry.json, vertical %s cross-section through all ordered canopy anchors (L=log, #=leaves, .=air), origin=%+v:\n%s", axis, origin, art.String())
}

func treeMegaTrunkDecorationBlocksSequenceFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "mega_trunk": {
	      "trunk_width": 2,
	      "trunk_height": { "base": 10, "intervals": [3, 20] },
	      "trunk_block": "minecraft:oak_log",
	      "trunk_decoration": {
	        "decoration_blocks_sequence": [
	          { "block": "minecraft:vine" },
	          { "block": "minecraft:moss_block", "count": { "range_min": 1, "range_max": 2 } }
	        ],
	        "decoration_chance": { "numerator": 1, "denominator": 1 }
	      }
	    },
	    "mega_canopy": {
	      "canopy_height": 3,
	      "base_radius": 2,
	      "core_width": 2,
	      "leaf_block": "minecraft:oak_leaves"
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_MegaTrunkDecorationBlocksSequence_GrowsRealTree runs `featurelab
// generate` against a temporary pack containing a minecraft:tree_feature using mega_trunk's
// trunk_decoration.decoration_blocks_sequence (a two-entry ordered sequence: vine then
// moss_block) with decoration_chance forced to ALWAYS roll (numerator=denominator=1), and confirms
// the resulting volume actually contains BOTH sequence entries' blocks stacked outward from the
// trunk column through the real CLI/build/place pipeline -- not just the pre-existing singular
// decoration_block shorthand this port already proved reachable. See features/tree.go's
// megaTrunkDecoration doc comment for the derivation of the multi-block decoration write, and
// features/tree_test.go's
// TestMegaTrunkDecoration_Place_SequenceEntriesContinuePositionAndAlwaysDrawCount for the
// package-level RNG-draw-order pin this exercises end to end.
func TestCmdGenerate_TreeFeature_MegaTrunkDecorationBlocksSequence_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "oak_mega_seq.json"), treeMegaTrunkDecorationBlocksSequenceFeatureJSON("test:oak_mega_seq"))

	// mega_trunk's own trunk_height={base:10,intervals:[3,20]} can draw up to 10+2+19=31 -- a much
	// taller volume than the default preview (see this file's own "mega_jungle needs a 96-block-tall
	// volume" precedent for the same class of clipping mistake) is required or the trunk read as
	// "could not be placed" (Y bound clipped), not a real failure.
	args := []string{
		"generate", "--pack", root, "--feature", "test:oak_mega_seq", "--env", "void",
		"--origin", "10,20,10", "--size", "30x100x30", "--seed", "1",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	// idsOf matches EVERY palette entry sharing the given block name -- vine/moss_block placed with
	// MultiFaceDirectionBits states get one palette entry PER DISTINCT state (west/east/north/south
	// each land as a separate palette index, all named "minecraft:vine"), so a single-index idOf
	// would silently undercount here.
	idsOf := func(name string) map[int]bool {
		ids := map[int]bool{}
		for i, e := range result.Palette {
			if e.Name == name {
				ids[i] = true
			}
		}
		return ids
	}
	logIDs := idsOf("minecraft:oak_log")
	leafIDs := idsOf("minecraft:oak_leaves")
	vineIDs := idsOf("minecraft:vine")
	mossIDs := idsOf("minecraft:moss_block")
	if len(logIDs) == 0 {
		t.Fatal("minecraft:oak_log never appears in the output palette -- trunk was not placed")
	}
	if len(leafIDs) == 0 {
		t.Fatal("minecraft:oak_leaves never appears in the output palette -- canopy was not placed")
	}
	if len(vineIDs) == 0 {
		t.Fatal("minecraft:vine never appears in the output palette -- decoration_blocks_sequence entry[0] was not placed")
	}
	if len(mossIDs) == 0 {
		t.Fatal("minecraft:moss_block never appears in the output palette -- decoration_blocks_sequence entry[1] was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	logCount, leafCount, vineCount, mossCount := 0, 0, 0, 0
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch id := at(x, y, z); {
				case logIDs[id]:
					logCount++
				case leafIDs[id]:
					leafCount++
				case vineIDs[id]:
					vineCount++
				case mossIDs[id]:
					mossCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no oak_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no oak_leaves cells placed anywhere -- expected a canopy")
	}
	if vineCount == 0 {
		t.Error("no vine cells placed anywhere -- decoration_blocks_sequence entry[0] should always roll (chance forced to 1/1)")
	}
	if mossCount == 0 {
		t.Error("no moss_block cells placed anywhere -- decoration_blocks_sequence entry[1] should always follow entry[0] in the same stacked sequence")
	}
	t.Logf("real CLI-grown mega_trunk decoration_blocks_sequence tree: %d log, %d leaf, %d vine, %d moss_block cells, %d total blocksPlaced",
		logCount, leafCount, vineCount, mossCount, result.BlocksPlaced)

	// Render a vertical (X/Y) cross-section through the origin's own X column so the vine-then-moss
	// stacked sequence (entry[0] closest to the trunk, entry[1] continuing outward past it) is
	// visible here too, grown through the real CLI, not just asserted as a count.
	origin := result.Origin
	var art strings.Builder
	for y := origin.Y + 12; y >= origin.Y; y-- {
		for x := origin.X - 3; x <= origin.X+9; x++ {
			switch id := at(x, y, origin.Z); {
			case logIDs[id]:
				art.WriteByte('L')
			case leafIDs[id]:
				art.WriteByte('#')
			case vineIDs[id]:
				art.WriteByte('V')
			case mossIDs[id]:
				art.WriteByte('M')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown mega_trunk decoration_blocks_sequence tree, vertical (X/Y) cross-section (L=log, #=leaves, V=vine, M=moss_block, .=air), origin=%+v:\n%s", origin, art.String())
}

// treeMangroveTrunkFeatureJSON pairs the top-level "mangrove_trunk" variant with
// its own branches (a nonzero branch_length/branch_steps range so the unconditional per-non-final-
// log coin flip has real geometry to draw when it fires), trunk_decoration (reusing the SAME
// attachable-decoration machinery mega_trunk.trunk_decoration already ships), and mangrove_canopy --
// the full, realistic vanilla mangrove trunk/canopy combination -- end to end through the real CLI.
// Deliberately does NOT also pair mangrove_roots here: the mangrove roots' own recursive/backtracking
// growth aborts the WHOLE tree if any of its 4 directions
// fails to grow even one root cell, which -- independent of seed -- happens often enough at small
// max_root_width/max_root_length that it would make this test flaky; the existing
// TestCmdGenerate_TreeFeature_MangroveCanopyKey_GrowsRealTree above follows the same precedent (no
// mangrove_roots key either). See features/tree.go's mangroveTrunk doc comment for the full
// derivation.
func treeMangroveTrunkFeatureJSON(identifier string) string {
	return `{
	  "format_version": "1.21.110",
	  "minecraft:tree_feature": {
	    "description": { "identifier": "` + identifier + `" },
	    "mangrove_trunk": {
	      "trunk_block": "minecraft:mangrove_log",
	      "trunk_height": { "base": 6, "height_rand_a": 2, "height_rand_b": 2 },
	      "branches": {
	        "branch_length": { "range_min": 1, "range_max": 3 },
	        "branch_steps": { "range_min": 2, "range_max": 4 }
	      },
	      "trunk_decoration": {
	        "decoration_block": "minecraft:vine",
	        "decoration_chance": { "numerator": 1, "denominator": 2 }
	      }
	    },
	    "mangrove_canopy": {
	      "canopy_height": { "range_min": 2, "range_max": 4 },
	      "canopy_radius": { "range_min": 2, "range_max": 4 },
	      "leaf_placement_attempts": 6,
	      "leaf_blocks": [["minecraft:mangrove_leaves", 1.0]],
	      "hanging_block": "minecraft:mangrove_roots",
	      "hanging_block_placement_chance": 100
	    },
	    "may_replace": ["minecraft:air"]
	  }
	}`
}

// TestCmdGenerate_TreeFeature_MangroveTrunkKey_GrowsRealTree runs `featurelab generate` against a
// temporary pack containing a minecraft:tree_feature using the top-level "mangrove_trunk" variant,
// paired with branches, trunk_decoration, and mangrove_canopy -- the full,
// realistic vanilla mangrove trunk/canopy combination this port newly recognizes. Confirms the
// resulting volume actually contains a mangrove_log trunk column, a scattered mangrove_leaves canopy,
// and at least one mangrove_roots cell hanging below a leaf (mangrove_canopy's own
// hanging_block_placement_chance:100 decoration pass, already shipped -- proving the new trunk and
// the existing canopy compose correctly).
func TestCmdGenerate_TreeFeature_MangroveTrunkKey_GrowsRealTree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "mangrove_trunk.json"), treeMangroveTrunkFeatureJSON("test:mangrove_trunk"))

	// treeMangroveTrunkFeatureJSON deliberately omits "may_grow_on" (same as the existing
	// mangrove_canopy CLI test's own body) -- a void environment is all air, so any non-empty
	// may_grow_on list would never match and the trunk would never place; an empty/absent
	// may_grow_on is this port's own established "no restriction" contract (passesAllowList/
	// TreeFeature.Place both skip the gate when the list is empty).
	args := []string{
		"generate", "--pack", root, "--feature", "test:mangrove_trunk", "--env", "void",
		"--origin", "5,20,5", "--size", "30x60x30", "--seed", "7",
	}
	var code int
	out := captureStdout(t, func() {
		code = run(args)
	})
	if code != 0 {
		t.Fatalf("run(%v) = %d, want 0; output: %s", args, code, out)
	}

	var result struct {
		Bounds struct{ MinX, MinY, MinZ, SizeX, SizeY, SizeZ int }
		Origin struct{ X, Y, Z int }
		// session.CellIDs, not []int: the wire array is run-length encoded (see
		// featurelab-go/rle), and this type is what decodes it back to one id per cell.
		Blocks  session.CellIDs
		Palette []struct {
			Name string
		}
		BlocksPlaced int `json:"blocksPlaced"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if result.BlocksPlaced == 0 {
		t.Fatal("blocksPlaced = 0, want > 0 (a real tree must place blocks)")
	}

	idsOf := func(name string) map[int]bool {
		ids := map[int]bool{}
		for i, e := range result.Palette {
			if e.Name == name {
				ids[i] = true
			}
		}
		return ids
	}
	logIDs := idsOf("minecraft:mangrove_log")
	leafIDs := idsOf("minecraft:mangrove_leaves")
	vineIDs := idsOf("minecraft:vine")
	rootIDs := idsOf("minecraft:mangrove_roots")
	muddyRootIDs := idsOf("minecraft:muddy_mangrove_roots")
	if len(logIDs) == 0 {
		t.Fatal("minecraft:mangrove_log never appears in the output palette -- trunk was not placed")
	}
	if len(leafIDs) == 0 {
		t.Fatal("minecraft:mangrove_leaves never appears in the output palette -- canopy was not placed")
	}

	b := result.Bounds
	layerStride := b.SizeX * b.SizeZ
	at := func(x, y, z int) int {
		if x < b.MinX || x >= b.MinX+b.SizeX || y < b.MinY || y >= b.MinY+b.SizeY || z < b.MinZ || z >= b.MinZ+b.SizeZ {
			t.Fatalf("position (%d,%d,%d) outside result bounds %+v", x, y, z, b)
		}
		idx := (y-b.MinY)*layerStride + (z-b.MinZ)*b.SizeX + (x - b.MinX)
		return int(result.Blocks[idx])
	}

	origin := result.Origin
	logCount, leafCount, vineCount, rootCount, muddyRootCount := 0, 0, 0, 0, 0
	trunkColumnX, trunkColumnZ := origin.X, origin.Z
	for x := b.MinX; x < b.MinX+b.SizeX; x++ {
		for y := b.MinY; y < b.MinY+b.SizeY; y++ {
			for z := b.MinZ; z < b.MinZ+b.SizeZ; z++ {
				switch id := at(x, y, z); {
				case logIDs[id]:
					logCount++
				case leafIDs[id]:
					leafCount++
				case vineIDs[id]:
					vineCount++
				case rootIDs[id]:
					rootCount++
				case muddyRootIDs[id]:
					muddyRootCount++
				}
			}
		}
	}
	if logCount == 0 {
		t.Error("no mangrove_log cells placed anywhere -- expected a trunk column")
	}
	if leafCount == 0 {
		t.Error("no mangrove_leaves cells placed anywhere -- expected a canopy")
	}
	if rootCount == 0 && muddyRootCount == 0 {
		t.Error("no mangrove_roots cells placed anywhere -- expected mangrove_canopy's own hanging_block_placement_chance:100 decoration to hang at least one below a leaf")
	}
	t.Logf("real CLI-grown mangrove_trunk tree: %d log cells (trunk column + branches), %d leaf cells, "+
		"%d vine (trunk_decoration) cells, %d hanging-root cells, %d total blocksPlaced",
		logCount, leafCount, vineCount, rootCount+muddyRootCount, result.BlocksPlaced)

	// Render a vertical (X/Y) cross-section through the trunk's own X column so the straight
	// (unleaning) trunk, any branch logs stepping off it, the scattered canopy, and the hanging roots
	// are all visible here too, grown through the real CLI, not just asserted as a count.
	var art strings.Builder
	for y := b.MinY + b.SizeY - 1; y >= b.MinY; y-- {
		for x := trunkColumnX - 6; x <= trunkColumnX+6; x++ {
			switch id := at(x, y, trunkColumnZ); {
			case logIDs[id]:
				art.WriteByte('L')
			case leafIDs[id]:
				art.WriteByte('#')
			case vineIDs[id]:
				art.WriteByte('V')
			case rootIDs[id], muddyRootIDs[id]:
				art.WriteByte('R')
			default:
				art.WriteByte('.')
			}
		}
		art.WriteByte('\n')
	}
	t.Logf("real CLI-grown mangrove_trunk tree, vertical (X/Y) cross-section through the trunk's own column (L=log, #=leaves, V=vine, R=root/muddy-root, .=air), origin=%+v:\n%s", origin, art.String())
}
