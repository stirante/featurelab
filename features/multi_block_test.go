// multi_block_test.go exercises MultiBlockFeature end to end: the required-key/type errors,
// every parse-time diagnostic path (not-a-multi-block, non-start part, randomize_rotation
// downgrade, trait validation in blocks/**/*.json), each default, the part expansion along the
// trait direction, the replace-list and multi-block-overlap rejections, the out-of-bounds
// rollback, and the RNG draw sequence explicitly (method + bound + count via random.Tracer, on
// success and on the failure paths). This type is brand-new in 1.26.50.24 and has no
// golden-dump differential coverage: these tests are the only thing standing between
// a wrong implementation and a caller. See multi_block.go's header for the algorithm this is
// checking against.
package features

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

var mbTestOrigin = wgen.BlockPos{X: 0, Y: 60, Z: 0}

// mbBlockJSON builds one blocks/*.json definition carrying the minecraft:multi_block trait
// (and optionally the placement_direction trait enabling cardinal_direction).
func mbBlockJSON(identifier, traitBody string, withCardinal bool) string {
	pd := ""
	if withCardinal {
		pd = `"minecraft:placement_direction": { "enabled_states": ["minecraft:cardinal_direction"] },`
	}
	return fmt.Sprintf(`{
	  "format_version": "1.26.50",
	  "minecraft:block": {
	    "description": {
	      "identifier": %q,
	      "traits": { %s "minecraft:multi_block": %s }
	    },
	    "components": {}
	  }
	}`, identifier, pd, traitBody)
}

// newMBTestPalette loads the given block definitions into a fresh palette and returns the
// LoadBlockTags diagnostics for the trait-validation tests.
func newMBTestPalette(t *testing.T, blockJSON ...string) (*block.Palette, []block.Diagnostic) {
	t.Helper()
	pal := block.NewPalette()
	files := make([]block.SourceFile, len(blockJSON))
	for i, text := range blockJSON {
		files[i] = block.SourceFile{ID: fmt.Sprintf("blocks/test_%d.json", i), Text: text}
	}
	diags := pal.LoadBlockTags(files)
	return pal, diags
}

func newMBTestVolume(pal *block.Palette) *volume.Volume {
	// y in [55, 66) -- small enough that a 3-part column from y=64 runs out the top.
	bounds := volume.Bounds{MinX: -8, MinY: 55, MinZ: -8, SizeX: 17, SizeY: 11, SizeZ: 17}
	return volume.New(bounds, pal, block.AirID)
}

func buildMB(t *testing.T, pal *block.Palette, body map[string]any) (wgen.IFeature, []string) {
	t.Helper()
	var warnings []string
	ctx := &BuildContext{
		Palette:    pal,
		Identifier: "test:mb",
		FileID:     "test:mb",
		Warn:       func(msg string) { warnings = append(warnings, msg) },
	}
	f, err := buildMultiBlockFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildMultiBlockFeature: %v", err)
	}
	return f, warnings
}

func placeMB(f wgen.IFeature, v *volume.Volume, origin wgen.BlockPos, rnd random.IRandom) (*wgen.BlockPos, []string) {
	var failures []string
	ctx := &wgen.PlacementContext{
		API:         v,
		Origin:      origin,
		Random:      rnd,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure: func(featureType, message string, pos wgen.BlockPos) {
			failures = append(failures, message)
		},
		LogWarning: func(featureType, message string, pos *wgen.BlockPos) {},
	}
	pos := f.Place(ctx)
	return pos, failures
}

// mbPartAt asserts the block at pos is name with minecraft:multi_block_part == part.
func mbPartAt(t *testing.T, pal *block.Palette, v *volume.Volume, pos wgen.BlockPos, name string, part int) {
	t.Helper()
	id := v.GetBlock(pos)
	if got := pal.NameOf(id); got != name {
		t.Fatalf("block at %v = %s, want %s", pos, got, name)
	}
	states := pal.StatesOf(id)
	got, ok := states[block.MultiBlockPartState]
	if !ok {
		t.Fatalf("block at %v carries no %s state: %v", pos, block.MultiBlockPartState, states)
	}
	if got != float64(part) {
		t.Fatalf("block at %v has %s = %v, want %d", pos, block.MultiBlockPartState, got, part)
	}
}

const mbPillar3Up = `{ "enabled_states": ["minecraft:multi_block_part"], "parts": 3, "direction": "up" }`

// TestMultiBlock_SchemaErrors pins the one REQUIRED key (places_block)
// and the optional keys' type checks.
func TestMultiBlock_SchemaErrors(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	ctx := &BuildContext{Palette: pal, Identifier: "test:mb", FileID: "test:mb", Warn: func(string) {}}

	if _, err := buildMultiBlockFeature(map[string]any{}, ctx); err == nil || !strings.Contains(err.Error(), "places_block") {
		t.Fatalf("missing places_block: err = %v, want places_block-is-required error", err)
	}
	if _, err := buildMultiBlockFeature(map[string]any{
		"places_block":            "test:pillar",
		"enforce_placement_rules": "yes",
	}, ctx); err == nil || !strings.Contains(err.Error(), "enforce_placement_rules") {
		t.Fatalf("non-bool enforce_placement_rules: err = %v, want type error", err)
	}
	if _, err := buildMultiBlockFeature(map[string]any{
		"places_block":       "test:pillar",
		"randomize_rotation": float64(1),
	}, ctx); err == nil || !strings.Contains(err.Error(), "randomize_rotation") {
		t.Fatalf("non-bool randomize_rotation: err = %v, want type error", err)
	}
	if _, err := buildMultiBlockFeature(map[string]any{
		"places_block": "test:pillar",
		"may_replace":  "minecraft:air",
	}, ctx); err == nil || !strings.Contains(err.Error(), "may_replace") {
		t.Fatalf("non-array may_replace: err = %v, want type error", err)
	}
}

// TestMultiBlock_NotAMultiBlockWarnsAndFailsPlacement pins the places_block parse's Air-fallback
// shape: a places_block without the trait still BUILDS (the engine only content-logs),
// but every placement fails with "Invalid 'places_block'" and draws nothing.
func TestMultiBlock_NotAMultiBlockWarnsAndFailsPlacement(t *testing.T) {
	pal, _ := newMBTestPalette(t) // no blocks loaded at all
	v := newMBTestVolume(pal)
	f, warnings := buildMB(t, pal, map[string]any{"places_block": "minecraft:stone"})
	if len(warnings) != 1 || !strings.Contains(warnings[0], "Must place a multi-block") {
		t.Fatalf("warnings = %v, want the engine's Must-place-a-multi-block line", warnings)
	}

	tracer := random.NewTracer(random.New(1))
	pos, failures := placeMB(f, v, mbTestOrigin, tracer)
	if pos != nil {
		t.Fatalf("place succeeded (%v), want failure", pos)
	}
	if len(failures) != 1 || failures[0] != "Invalid 'places_block'" {
		t.Fatalf("failures = %v, want exactly [Invalid 'places_block']", failures)
	}
	if len(tracer.Draws) != 0 {
		t.Fatalf("invalid places_block must draw nothing, drew %v", tracer.Draws)
	}
	if got := v.GetBlock(mbTestOrigin); got != block.AirID {
		t.Fatalf("volume was written on the failure path: %v", got)
	}
}

// TestMultiBlock_NonStartPartRejected pins the engine's multi-block-start test: an explicit
// minecraft:multi_block_part != 0 in places_block is the "only the starting part" diagnostic
// and the same always-failing fallback.
func TestMultiBlock_NonStartPartRejected(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	v := newMBTestVolume(pal)
	f, warnings := buildMB(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "test:pillar",
			"states": map[string]any{block.MultiBlockPartState: float64(1)},
		},
	})
	if len(warnings) != 1 || !strings.Contains(warnings[0], "only the starting part") {
		t.Fatalf("warnings = %v, want the only-the-starting-part line", warnings)
	}
	pos, failures := placeMB(f, v, mbTestOrigin, random.New(1))
	if pos != nil || len(failures) != 1 || failures[0] != "Invalid 'places_block'" {
		t.Fatalf("pos = %v, failures = %v, want nil + [Invalid 'places_block']", pos, failures)
	}

	// An EXPLICIT part 0 is the starting part and must be accepted.
	f2, warnings2 := buildMB(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "test:pillar",
			"states": map[string]any{block.MultiBlockPartState: float64(0)},
		},
	})
	if len(warnings2) != 0 {
		t.Fatalf("explicit part 0 warned: %v", warnings2)
	}
	if pos, failures := placeMB(f2, v, mbTestOrigin, random.New(1)); pos == nil || len(failures) != 0 {
		t.Fatalf("explicit part 0 failed to place: pos = %v, failures = %v", pos, failures)
	}
}

// TestMultiBlock_PlacesAllPartsUp pins the core expansion: parts extend from the origin along
// the trait direction, each cell the same permutation with multi_block_part = its index
// (the engine's write loop, writing the part state per part), returning the origin, drawing
// nothing when randomize_rotation is off.
func TestMultiBlock_PlacesAllPartsUp(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	v := newMBTestVolume(pal)
	f, warnings := buildMB(t, pal, map[string]any{"places_block": "test:pillar"})
	if len(warnings) != 0 {
		t.Fatalf("unexpected build warnings: %v", warnings)
	}

	tracer := random.NewTracer(random.New(7))
	pos, failures := placeMB(f, v, mbTestOrigin, tracer)
	if pos == nil || *pos != mbTestOrigin {
		t.Fatalf("pos = %v, want origin %v", pos, mbTestOrigin)
	}
	if len(failures) != 0 {
		t.Fatalf("unexpected failures: %v", failures)
	}
	if len(tracer.Draws) != 0 {
		t.Fatalf("randomize_rotation off must draw nothing, drew %v", tracer.Draws)
	}
	for i := 0; i < 3; i++ {
		mbPartAt(t, pal, v, wgen.BlockPos{X: 0, Y: 60 + i, Z: 0}, "test:pillar", i)
	}
	// The cell past the last part stays untouched.
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 63, Z: 0}); got != block.AirID {
		t.Fatalf("cell past the last part was written: %v", got)
	}
	// No rotation in play: parts must NOT carry a cardinal_direction state.
	if states := pal.StatesOf(v.GetBlock(mbTestOrigin)); states[block.CardinalDirectionState] != nil {
		t.Fatalf("unrotated part carries cardinal_direction: %v", states)
	}
}

// TestMultiBlock_DirectionWest pins the engine's per-face offset table for a horizontal
// direction: "west" extends parts toward -X.
func TestMultiBlock_DirectionWest(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:beam",
		`{ "enabled_states": ["minecraft:multi_block_part"], "parts": 4, "direction": "west" }`, false))
	v := newMBTestVolume(pal)
	f, _ := buildMB(t, pal, map[string]any{"places_block": "test:beam"})
	pos, failures := placeMB(f, v, mbTestOrigin, random.New(7))
	if pos == nil || len(failures) != 0 {
		t.Fatalf("pos = %v, failures = %v", pos, failures)
	}
	for i := 0; i < 4; i++ {
		mbPartAt(t, pal, v, wgen.BlockPos{X: -i, Y: 60, Z: 0}, "test:beam", i)
	}
	if got := v.GetBlock(wgen.BlockPos{X: 1, Y: 60, Z: 0}); got != block.AirID {
		t.Fatalf("east neighbor was written: %v", got)
	}
}

// TestMultiBlock_TraitDefaults pins the trait defaults (parts 2, direction "up" -- the game's
// declared defaults, see block/multiblock.go).
func TestMultiBlock_TraitDefaults(t *testing.T) {
	pal, diags := newMBTestPalette(t, mbBlockJSON("test:duo",
		`{ "enabled_states": ["minecraft:multi_block_part"] }`, false))
	if len(diags) != 0 {
		t.Fatalf("unexpected block diagnostics: %v", diags)
	}
	v := newMBTestVolume(pal)
	f, _ := buildMB(t, pal, map[string]any{"places_block": "test:duo"})
	pos, failures := placeMB(f, v, mbTestOrigin, random.New(7))
	if pos == nil || len(failures) != 0 {
		t.Fatalf("pos = %v, failures = %v", pos, failures)
	}
	mbPartAt(t, pal, v, wgen.BlockPos{X: 0, Y: 60, Z: 0}, "test:duo", 0)
	mbPartAt(t, pal, v, wgen.BlockPos{X: 0, Y: 61, Z: 0}, "test:duo", 1)
	if got := v.GetBlock(wgen.BlockPos{X: 0, Y: 62, Z: 0}); got != block.AirID {
		t.Fatalf("default parts must be 2, but a third cell was written: %v", got)
	}
}

// TestMultiBlock_TraitValidation pins the trait's own validation (block/multiblock.go,
// mirroring the trait's enabled-states string-list parse and the direction parse's
// disable-on-invalid behaviour): each invalid form leaves the block NOT a multi-block.
func TestMultiBlock_TraitValidation(t *testing.T) {
	cases := []struct {
		name     string
		trait    string
		wantDiag string
	}{
		{"missing enabled_states", `{ "parts": 3 }`, "requires exactly one"},
		{"wrong enabled_states entry", `{ "enabled_states": ["minecraft:cardinal_direction"] }`, "Invalid state option"},
		{"two enabled_states entries", `{ "enabled_states": ["minecraft:multi_block_part", "minecraft:multi_block_part"] }`, "requires exactly one"},
		{"invalid direction", `{ "enabled_states": ["minecraft:multi_block_part"], "direction": "sideways" }`, "Invalid value for 'direction'"},
		{"parts too small", `{ "enabled_states": ["minecraft:multi_block_part"], "parts": 1 }`, "[2, 4]"},
		{"parts too large", `{ "enabled_states": ["minecraft:multi_block_part"], "parts": 5 }`, "[2, 4]"},
		{"fractional parts", `{ "enabled_states": ["minecraft:multi_block_part"], "parts": 2.5 }`, "[2, 4]"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pal, diags := newMBTestPalette(t, mbBlockJSON("test:bad", c.trait, false))
			found := false
			for _, d := range diags {
				if strings.Contains(d.Message, c.wantDiag) {
					found = true
				}
			}
			if !found {
				t.Fatalf("diagnostics = %v, want one containing %q", diags, c.wantDiag)
			}
			if _, _, ok := pal.MultiBlockTrait("test:bad"); ok {
				t.Fatal("an invalid trait must not enable the block as a multi-block")
			}
			// And the feature built against it is the always-failing fallback.
			f, warnings := buildMB(t, pal, map[string]any{"places_block": "test:bad"})
			if len(warnings) != 1 || !strings.Contains(warnings[0], "Must place a multi-block") {
				t.Fatalf("warnings = %v, want the Must-place-a-multi-block line", warnings)
			}
			v := newMBTestVolume(pal)
			if pos, failures := placeMB(f, v, mbTestOrigin, random.New(1)); pos != nil || len(failures) != 1 || failures[0] != "Invalid 'places_block'" {
				t.Fatalf("pos = %v, failures = %v", pos, failures)
			}
		})
	}
}

// TestMultiBlock_MayReplace pins the replace check over EVERY part cell (place() step 5): a
// deny anywhere along the line fails the whole placement before any write; an empty
// may_replace passes everything (the engine's placement allow-list check returns true
// immediately for an empty list).
func TestMultiBlock_MayReplace(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	stone := pal.Get("minecraft:stone", nil)

	// Deny: stone sits at part cell 1; may_replace allows only air.
	v := newMBTestVolume(pal)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, stone)
	f, _ := buildMB(t, pal, map[string]any{
		"places_block": "test:pillar",
		"may_replace":  []any{"minecraft:air"},
	})
	pos, failures := placeMB(f, v, mbTestOrigin, random.New(1))
	if pos != nil {
		t.Fatalf("place succeeded (%v), want replace-list failure", pos)
	}
	if len(failures) != 1 || failures[0] != "Target location does not contain a block from the replace list" {
		t.Fatalf("failures = %v, want the replace-list line", failures)
	}
	// The check runs before any write: part cell 0 must still be air.
	if got := v.GetBlock(mbTestOrigin); got != block.AirID {
		t.Fatalf("replace-list failure wrote part 0 anyway: %v", got)
	}

	// Empty may_replace: no constraint -- the stone is simply overwritten.
	v2 := newMBTestVolume(pal)
	v2.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, stone)
	f2, _ := buildMB(t, pal, map[string]any{"places_block": "test:pillar"})
	if pos, failures := placeMB(f2, v2, mbTestOrigin, random.New(1)); pos == nil || len(failures) != 0 {
		t.Fatalf("empty may_replace must pass: pos = %v, failures = %v", pos, failures)
	}
	mbPartAt(t, pal, v2, wgen.BlockPos{X: 0, Y: 61, Z: 0}, "test:pillar", 1)
}

// TestMultiBlock_OverlapWithMultiBlockFails pins the multi-block-state overlap rule (the engine
// step 5's FIRST disjunct): a cell already holding any multi-block part fails placement EVEN
// WHEN may_replace explicitly allows that block -- deleting the overlap check and relying on
// the allow list alone would pass this configuration.
func TestMultiBlock_OverlapWithMultiBlockFails(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	v := newMBTestVolume(pal)
	existingPart := pal.Get("test:pillar", map[string]block.StateValue{block.MultiBlockPartState: float64(1)})
	v.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, existingPart)

	f, _ := buildMB(t, pal, map[string]any{
		"places_block": "test:pillar",
		"may_replace": []any{ // explicitly allows the occupant's EXACT permutation
			map[string]any{
				"name":   "test:pillar",
				"states": map[string]any{block.MultiBlockPartState: float64(1)},
			},
			"minecraft:air",
		},
	})
	pos, failures := placeMB(f, v, mbTestOrigin, random.New(1))
	if pos != nil {
		t.Fatalf("place over an existing multi-block succeeded (%v), want failure", pos)
	}
	if len(failures) != 1 || failures[0] != "Target location does not contain a block from the replace list" {
		t.Fatalf("failures = %v, want the replace-list line (the engine reuses it for overlap)", failures)
	}
}

// TestMultiBlock_OutOfBoundsRollsBack pins the write loop's rollback (place() step 6): a part
// past the volume's bounds fails the placement AND erases the parts already written -- to AIR,
// not back to what stood there before (the engine writes the registry's index-0 default state
// over them, it does not snapshot/restore).
func TestMultiBlock_OutOfBoundsRollsBack(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	v := newMBTestVolume(pal) // y < 66
	stone := pal.Get("minecraft:stone", nil)
	origin := wgen.BlockPos{X: 0, Y: 64, Z: 0} // parts at y=64,65,66 -- 66 is out of bounds
	v.SetBlock(origin, stone)                  // proves rollback overwrites, not restores

	f, _ := buildMB(t, pal, map[string]any{"places_block": "test:pillar"})
	pos, failures := placeMB(f, v, origin, random.New(1))
	if pos != nil {
		t.Fatalf("out-of-bounds placement succeeded: %v", pos)
	}
	if len(failures) != 1 || failures[0] != "Block could not be placed" {
		t.Fatalf("failures = %v, want [Block could not be placed]", failures)
	}
	for _, y := range []int{64, 65} {
		if got := v.GetBlock(wgen.BlockPos{X: 0, Y: y, Z: 0}); got != block.AirID {
			t.Fatalf("part at y=%d was not rolled back to air: %s", y, pal.NameOf(got))
		}
	}
}

// mbSeedForRotation scans for a seed whose FIRST NextUnsignedInt(4) draw yields r, so the
// rotation tests can pin the draw->cardinal_direction mapping without touching the
// implementation.
func mbSeedForRotation(t *testing.T, r uint32) uint32 {
	t.Helper()
	for seed := uint32(0); seed < 10000; seed++ {
		if random.New(seed).NextUnsignedInt(4) == r {
			return seed
		}
	}
	t.Fatalf("no seed under 10000 yields rotation %d", r)
	return 0
}

// TestMultiBlock_RandomizeRotationDrawsAndRotates pins the RNG contract (exactly one
// the raw unsigned draw of 4) and the draw-to-cardinal_direction mapping
// (0->north, 1->east, 2->south, 3->west)
// for ALL FOUR draw values, on every part of the placed line.
func TestMultiBlock_RandomizeRotationDrawsAndRotates(t *testing.T) {
	wantCardinal := [4]string{"north", "east", "south", "west"}
	for r := uint32(0); r < 4; r++ {
		t.Run(wantCardinal[r], func(t *testing.T) {
			pal, _ := newMBTestPalette(t, mbBlockJSON("test:rot", mbPillar3Up, true))
			v := newMBTestVolume(pal)
			f, warnings := buildMB(t, pal, map[string]any{
				"places_block":       "test:rot",
				"randomize_rotation": true,
			})
			if len(warnings) != 0 {
				t.Fatalf("unexpected build warnings: %v", warnings)
			}

			tracer := random.NewTracer(random.New(mbSeedForRotation(t, r)))
			pos, failures := placeMB(f, v, mbTestOrigin, tracer)
			if pos == nil || len(failures) != 0 {
				t.Fatalf("pos = %v, failures = %v", pos, failures)
			}
			if len(tracer.Draws) != 1 {
				t.Fatalf("draw count = %d (%v), want exactly 1", len(tracer.Draws), tracer.Draws)
			}
			d := tracer.Draws[0]
			if d.Method != random.MethodNextUnsignedInt || d.Bound != 4 {
				t.Fatalf("draw = %+v, want NextUnsignedInt(4)", d)
			}
			for i := 0; i < 3; i++ {
				p := wgen.BlockPos{X: 0, Y: 60 + i, Z: 0}
				mbPartAt(t, pal, v, p, "test:rot", i)
				states := pal.StatesOf(v.GetBlock(p))
				if got := states[block.CardinalDirectionState]; got != wantCardinal[r] {
					t.Fatalf("part %d cardinal_direction = %v, want %q", i, got, wantCardinal[r])
				}
			}
		})
	}
}

// TestMultiBlock_RandomizeDrawPrecedesFailure pins the draw's POSITION in the sequence: it
// happens before the replace check (place() step 2 vs step 5), so a placement that fails the
// replace check has still consumed exactly one draw.
func TestMultiBlock_RandomizeDrawPrecedesFailure(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:rot", mbPillar3Up, true))
	v := newMBTestVolume(pal)
	v.SetBlock(wgen.BlockPos{X: 0, Y: 61, Z: 0}, pal.Get("minecraft:stone", nil))
	f, _ := buildMB(t, pal, map[string]any{
		"places_block":       "test:rot",
		"randomize_rotation": true,
		"may_replace":        []any{"minecraft:air"},
	})
	tracer := random.NewTracer(random.New(3))
	pos, failures := placeMB(f, v, mbTestOrigin, tracer)
	if pos != nil || len(failures) != 1 {
		t.Fatalf("pos = %v, failures = %v, want a replace-list failure", pos, failures)
	}
	if len(tracer.Draws) != 1 || tracer.Draws[0].Method != random.MethodNextUnsignedInt {
		t.Fatalf("a failing rotated placement must still consume its one draw, got %v", tracer.Draws)
	}
}

// TestMultiBlock_RandomizeWithoutCardinalDowngraded pins the randomize_rotation parse-time
// downgrade: randomize_rotation on a block without the cardinal_direction state warns with
// the engine's line and stores FALSE -- placement then succeeds, draws NOTHING, and writes no
// cardinal state.
func TestMultiBlock_RandomizeWithoutCardinalDowngraded(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	v := newMBTestVolume(pal)
	f, warnings := buildMB(t, pal, map[string]any{
		"places_block":       "test:pillar",
		"randomize_rotation": true,
	})
	if len(warnings) != 1 || !strings.Contains(warnings[0], "does not have a cardinal direction state") {
		t.Fatalf("warnings = %v, want the no-cardinal-direction line", warnings)
	}
	tracer := random.NewTracer(random.New(5))
	pos, failures := placeMB(f, v, mbTestOrigin, tracer)
	if pos == nil || len(failures) != 0 {
		t.Fatalf("pos = %v, failures = %v", pos, failures)
	}
	if len(tracer.Draws) != 0 {
		t.Fatalf("downgraded randomize_rotation must draw nothing, drew %v", tracer.Draws)
	}
	if states := pal.StatesOf(v.GetBlock(mbTestOrigin)); states[block.CardinalDirectionState] != nil {
		t.Fatalf("downgraded rotation still wrote a cardinal state: %v", states)
	}
}

// TestMultiBlock_EnforcePlacementRulesIsANoOp pins the worldgen no-op conclusion (the volume
// write target's placement check and its placement-filter check both just return
// true): enabling the key changes nothing observable -- same result, same writes,
// same zero draws.
func TestMultiBlock_EnforcePlacementRulesIsANoOp(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:pillar", mbPillar3Up, false))
	v := newMBTestVolume(pal)
	f, warnings := buildMB(t, pal, map[string]any{
		"places_block":            "test:pillar",
		"enforce_placement_rules": true,
	})
	if len(warnings) != 0 {
		t.Fatalf("unexpected build warnings: %v", warnings)
	}
	tracer := random.NewTracer(random.New(9))
	pos, failures := placeMB(f, v, mbTestOrigin, tracer)
	if pos == nil || *pos != mbTestOrigin || len(failures) != 0 || len(tracer.Draws) != 0 {
		t.Fatalf("enforce_placement_rules=true diverged: pos = %v, failures = %v, draws = %v",
			pos, failures, tracer.Draws)
	}
	for i := 0; i < 3; i++ {
		mbPartAt(t, pal, v, wgen.BlockPos{X: 0, Y: 60 + i, Z: 0}, "test:pillar", i)
	}
}

// TestMultiBlock_RotatesEveryTransformFamily is the regression test for the bug this file's
// rotation wiring used to have: the builder set minecraft:cardinal_direction from a local
// four-entry table and touched nothing else, so a places_block permutation carrying any of
// the rotation's other fifteen states came out unrotated and unwarned.
// the engine's block-rotation entry point has no dispatch — every arm whose state the
// block carries fires, cumulatively (block/rotate.go) — so pillar_axis and facing_direction
// must be rewritten by the same draw that rewrites cardinal_direction.
func TestMultiBlock_RotatesEveryTransformFamily(t *testing.T) {
	// Rows are CommonDirection 0/1/2/3 = north/east/south/west, from
	// block/rotate.go's transformBlockArms. cardinal_direction's row is the cross-check the
	// old local table used to hold; pillar_axis is CONFIRMED; facing_direction is one of the
	// ten INFERRED spellings and is here to pin the warning below too.
	wantCardinal := [4]block.StateValue{"north", "east", "south", "west"}
	wantPillar := [4]block.StateValue{"z", "x", "z", "x"}
	wantFacing := [4]block.StateValue{float64(2), float64(5), float64(3), float64(4)}

	for r := uint32(0); r < 4; r++ {
		t.Run(fmt.Sprint(wantCardinal[r]), func(t *testing.T) {
			pal, _ := newMBTestPalette(t, mbBlockJSON("test:rot", mbPillar3Up, true))
			v := newMBTestVolume(pal)
			f, warnings := buildMB(t, pal, map[string]any{
				"places_block": map[string]any{
					"name": "test:rot",
					// pillar_axis "y" and facing_direction 0 are deliberately values the
					// transform must overwrite for every one of the four directions, so a
					// no-op arm cannot pass by coincidence.
					"states": map[string]any{"pillar_axis": "y", "facing_direction": float64(0)},
				},
				"randomize_rotation": true,
			})
			// One warning, and only one: the INFERRED-spelling notice for facing_direction.
			// pillar_axis and cardinal_direction are CONFIRMED families and must not warn.
			if len(warnings) != 1 || !strings.Contains(warnings[0], `"facing_direction"`) ||
				!strings.Contains(warnings[0], "may be wrong in spelling") {
				t.Fatalf("warnings = %v, want exactly one INFERRED-spelling notice naming facing_direction", warnings)
			}
			if strings.Contains(warnings[0], "pillar_axis") || strings.Contains(warnings[0], "cardinal_direction") {
				t.Fatalf("confirmed families must not be warned about: %q", warnings[0])
			}

			tracer := random.NewTracer(random.New(mbSeedForRotation(t, r)))
			pos, failures := placeMB(f, v, mbTestOrigin, tracer)
			if pos == nil || len(failures) != 0 {
				t.Fatalf("pos = %v, failures = %v", pos, failures)
			}
			for i := 0; i < 3; i++ {
				p := wgen.BlockPos{X: 0, Y: 60 + i, Z: 0}
				// The part index this port sets itself is NOT one of the sixteen arms and
				// must survive the transform untouched.
				mbPartAt(t, pal, v, p, "test:rot", i)
				states := pal.StatesOf(v.GetBlock(p))
				for _, c := range []struct {
					key  string
					want block.StateValue
				}{
					{block.CardinalDirectionState, wantCardinal[r]},
					{"pillar_axis", wantPillar[r]},
					{"facing_direction", wantFacing[r]},
				} {
					if got := states[c.key]; got != c.want {
						t.Fatalf("part %d %s = %v, want %v (draw %d)", i, c.key, got, c.want, r)
					}
				}
			}
		})
	}
}

// TestMultiBlock_NoRotationLeavesStatesAlone pins the other side of the wiring: with
// randomize_rotation off there is exactly one row, no transform runs, and the descriptor's own
// directional states are written through verbatim. In particular the cardinal seed the builder
// uses to make the rotation arm fire must NOT appear on a block that never rotates.
func TestMultiBlock_NoRotationLeavesStatesAlone(t *testing.T) {
	pal, _ := newMBTestPalette(t, mbBlockJSON("test:rot", mbPillar3Up, true))
	v := newMBTestVolume(pal)
	f, warnings := buildMB(t, pal, map[string]any{
		"places_block": map[string]any{
			"name":   "test:rot",
			"states": map[string]any{"pillar_axis": "y", "facing_direction": float64(0)},
		},
	})
	if len(warnings) != 0 {
		t.Fatalf("a file that cannot rotate must not be warned about spellings it never writes: %v", warnings)
	}
	tracer := random.NewTracer(random.New(7))
	pos, failures := placeMB(f, v, mbTestOrigin, tracer)
	if pos == nil || len(failures) != 0 {
		t.Fatalf("pos = %v, failures = %v", pos, failures)
	}
	if len(tracer.Draws) != 0 {
		t.Fatalf("draws = %v, want none", tracer.Draws)
	}
	for i := 0; i < 3; i++ {
		p := wgen.BlockPos{X: 0, Y: 60 + i, Z: 0}
		mbPartAt(t, pal, v, p, "test:rot", i)
		states := pal.StatesOf(v.GetBlock(p))
		if states["pillar_axis"] != "y" || states["facing_direction"] != float64(0) {
			t.Fatalf("part %d states rewritten without rotation: %v", i, states)
		}
		if _, seeded := states[block.CardinalDirectionState]; seeded {
			t.Fatalf("part %d gained a cardinal_direction it never asked for: %v", i, states)
		}
	}
}
