// environment_diagnostics_test.go covers the two environment-layer
// diagnostics generate() raises straight after preset.Build: a preset that
// promised a landform and did not build it, and a sea material slot set on a
// preset that has no sea.
//
// Both defects were SILENT before, and silence is the thing being fixed --
// which is why every assertion here is about a diagnostic reaching
// Result.Diagnostics with the right level, not merely about the bench being
// odd. `--env end --origin 100,68,100` produced a 100%-air preview and a clean
// exit code; that combination is what these pin against.
package session

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/env"
)

func environmentDiagnostics(t *testing.T, config Config) []Diagnostic {
	t.Helper()
	result, err := Generate(config, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	var out []Diagnostic
	for _, d := range result.Diagnostics {
		if d.FileID == "(environment)" {
			out = append(out, d)
		}
	}
	return out
}

// TestGenerate_EndPresetAtADistantOriginReportsAnErrorDiagnostic pins the
// whole point of the landform check: the end island is measured from world
// (0,0) while the volume follows the origin, so an --origin far from there
// leaves the bench in open void. That is a legal flag combination, it produced
// an empty preview, and nothing anywhere said so.
//
// Level "error", not "warning", is part of the assertion: `generate` and
// `check` both gate their exit code on that level, so a scripted run gets a
// non-zero exit instead of mistaking an empty bench for a feature that placed
// nothing.
func TestGenerate_EndPresetAtADistantOriginReportsAnErrorDiagnostic(t *testing.T) {
	config, ok := DefaultConfig(env.EnvEnd)
	if !ok {
		t.Fatal("DefaultConfig(end) should succeed")
	}
	if diags := environmentDiagnostics(t, config); len(diags) != 0 {
		t.Fatalf("end at the default origin reported %v, want nothing -- this is the preset working", diags)
	}

	config.OriginX, config.OriginZ = 100, 100
	diags := environmentDiagnostics(t, config)
	if len(diags) != 1 {
		t.Fatalf("end at origin (100,100) reported %d environment diagnostics, want exactly 1: %v", len(diags), diags)
	}
	if diags[0].Level != "error" {
		t.Errorf("level = %q, want \"error\" -- an unusable bench must fail the exit-code gate, not scroll past as a warning", diags[0].Level)
	}
	if !strings.Contains(diags[0].Message, "--origin") {
		t.Errorf("message does not name the flag to change: %q", diags[0].Message)
	}
}

// TestGenerate_NetherPresetInAShortVolumeReportsAnErrorDiagnostic is the same
// check catching the other confirmed instance, and it is here as a separate
// test on purpose: the two degenerate in OPPOSITE directions (end loses all
// its solid, nether loses all its air), and a check written for one of them
// silently misses the other.
func TestGenerate_NetherPresetInAShortVolumeReportsAnErrorDiagnostic(t *testing.T) {
	config, ok := DefaultConfig(env.EnvNether)
	if !ok {
		t.Fatal("DefaultConfig(nether) should succeed")
	}
	if diags := environmentDiagnostics(t, config); len(diags) != 0 {
		t.Fatalf("nether at the default size reported %v, want nothing", diags)
	}

	config.SizeY = 20
	diags := environmentDiagnostics(t, config)
	if len(diags) != 1 {
		t.Fatalf("nether at sizeY=20 reported %d environment diagnostics, want exactly 1: %v", len(diags), diags)
	}
	if diags[0].Level != "error" {
		t.Errorf("level = %q, want \"error\"", diags[0].Level)
	}
	if !strings.Contains(diags[0].Message, "--size Y") {
		t.Errorf("message does not name the flag to change: %q", diags[0].Message)
	}
}

// TestGenerate_SeaFloorDepthOnAPresetWithNoSeaIsReported pins the "or warn"
// half of honouring sea_floor_depth. The slot now does something real, but
// only under the one preset that builds a sea -- and --sea-floor-depth is this
// tool's own flag, so it owes the author a word when it does nothing.
//
// Direction: the warning must fire for the preset that IGNORES the slot and
// stay silent for the one that reads it. A check that fired on both would be
// noise; one that fired on neither is where this started.
func TestGenerate_SeaFloorDepthOnAPresetWithNoSeaIsReported(t *testing.T) {
	depth := 4.0

	plains, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}
	plains.MaterialOverride = &env.MaterialOverride{SeaFloorDepth: &depth}
	diags := environmentDiagnostics(t, plains)
	if len(diags) != 1 {
		t.Fatalf("plains with --sea-floor-depth reported %d environment diagnostics, want exactly 1: %v", len(diags), diags)
	}
	if diags[0].Level != "warning" {
		t.Errorf("level = %q, want \"warning\" -- the run itself is fine, only the knob is inert", diags[0].Level)
	}
	if !strings.Contains(diags[0].Message, "sea_floor_depth") || !strings.Contains(diags[0].Message, string(env.EnvOcean)) {
		t.Errorf("message names neither the inert slot nor the preset that would honour it: %q", diags[0].Message)
	}

	ocean, ok := DefaultConfig(env.EnvOcean)
	if !ok {
		t.Fatal("DefaultConfig(ocean) should succeed")
	}
	ocean.MaterialOverride = &env.MaterialOverride{SeaFloorDepth: &depth}
	if diags := environmentDiagnostics(t, ocean); len(diags) != 0 {
		t.Errorf("ocean with --sea-floor-depth reported %v, want nothing -- ocean is the preset that reads it", diags)
	}
}

// TestGenerate_SeaFloorDepthChangesTheOceanBench is the end-to-end half of the
// same fix, at the layer the CLI and both apps actually go through: `--env
// ocean --sea-floor-depth 0` and `--sea-floor-depth 10` used to produce
// byte-identical benches, which is how a slot that is parsed, merged, rounded,
// clamped, wired to a flag and shown in two panels turned out to be read by
// nobody.
//
// It also pins the direction that matters for the golden chains: depth 0 --
// every preset's native value, so every default run -- must produce the bench
// it always did, and only a positive depth may move anything.
func TestGenerate_SeaFloorDepthChangesTheOceanBench(t *testing.T) {
	baseline, ok := DefaultConfig(env.EnvOcean)
	if !ok {
		t.Fatal("DefaultConfig(ocean) should succeed")
	}
	plain, err := Generate(baseline, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	zero := baseline
	zeroDepth := 0.0
	zero.MaterialOverride = &env.MaterialOverride{SeaFloorDepth: &zeroDepth}
	unchanged, err := Generate(zero, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if !sameBlocks(plain.Blocks, unchanged.Blocks) {
		t.Error("sea_floor_depth 0 changed the ocean bench; the preset default must still build exactly what it always built")
	}

	deep := baseline
	deepDepth := 10.0
	deep.MaterialOverride = &env.MaterialOverride{SeaFloorDepth: &deepDepth}
	banded, err := Generate(deep, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if sameBlocks(plain.Blocks, banded.Blocks) {
		t.Error("sea_floor_depth 10 produced a bench identical to depth 0 -- the slot is still being ignored")
	}
}

// sameBlocks compares two benches cell for cell -- the "byte-identical output"
// the sea_floor_depth finding was demonstrated with.
func sameBlocks(a, b []block.ID) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestGenerate_UnresolvedLegacyAliasIsReported pins the third silent failure in this file's class:
// a legacy block alias the palette refused to guess at.
//
// `minecraft:leaves` resolves to one of four flattened blocks depending on its `old_leaf_type`
// state. Written without one, the palette keeps it verbatim rather than picking a leaf species --
// correct, because guessing would be worse. But nothing in this bench ever WRITES a block named
// `minecraft:leaves`, so a list containing it matches nothing, and the author sees a feature that
// quietly does not fire.
//
// The palette had recorded every such name since it was written. Until this test's subject was
// added, the only thing that ever read that record was a unit test in the block package, so the
// record reached nobody.
func TestGenerate_UnresolvedLegacyAliasIsReported(t *testing.T) {
	palette := block.NewPalette()

	// The resolvable spelling first, as the control: with the discriminator present there is
	// nothing to report, and a test that only checks the failing case cannot tell "reported the
	// right thing" from "reports everything".
	palette.Get("minecraft:leaves", map[string]block.StateValue{"old_leaf_type": "oak"})
	if got := palette.UnresolvedAliasList(); len(got) != 0 {
		t.Fatalf("minecraft:leaves with old_leaf_type=oak recorded %v, want nothing", got)
	}

	palette.Get("minecraft:leaves", nil)
	unresolved := palette.UnresolvedAliasList()
	if len(unresolved) != 1 {
		t.Fatalf("bare minecraft:leaves recorded %v, want exactly one entry", unresolved)
	}
	if !strings.Contains(unresolved[0], "minecraft:leaves") {
		t.Fatalf("recorded entry %q does not name the block", unresolved[0])
	}
}

// TestGenerate_UnresolvedLegacyAliasReachesTheDiagnostics is the end-to-end half of the test above:
// the palette recording a refusal is only useful if the recording reaches a person.
//
// Driven through a material override, which is the shortest legal route to interning an arbitrary
// block name -- `--top-material minecraft:leaves` is something a user can type today, and it lands
// in the same palette every feature descriptor lands in.
func TestGenerate_UnresolvedLegacyAliasReachesTheDiagnostics(t *testing.T) {
	config, ok := DefaultConfig(env.EnvPlains)
	if !ok {
		t.Fatal("DefaultConfig(plains) should succeed")
	}

	// Control: the default materials intern nothing ambiguous, so a clean run must be silent on
	// this. Without it, an assertion that the warning appears cannot distinguish "the alias was
	// detected" from "this fires on every run".
	for _, d := range diagnosticsFor(t, config) {
		if d.FileID == "(blocks)" {
			t.Fatalf("the default plains materials produced a (blocks) diagnostic: %v", d)
		}
	}

	legacy := "minecraft:leaves"
	config.MaterialOverride = &env.MaterialOverride{TopMaterial: &legacy}

	var found *Diagnostic
	for _, d := range diagnosticsFor(t, config) {
		if d.FileID == "(blocks)" {
			copy := d
			found = &copy
		}
	}
	if found == nil {
		t.Fatal("interning a bare minecraft:leaves produced no (blocks) diagnostic -- the palette " +
			"records the refusal, so this is the reporting channel being disconnected again")
	}
	if found.Level != "warning" {
		t.Fatalf("level = %q, want \"warning\" -- this is a thing the author should fix, not a "+
			"reason to fail the run", found.Level)
	}
	for _, want := range []string{"minecraft:leaves", "minecraft:oak_leaves", "matches nothing"} {
		if !strings.Contains(found.Message, want) {
			t.Fatalf("diagnostic message does not mention %q, so it does not tell the author what "+
				"to do about it: %s", want, found.Message)
		}
	}
}

// diagnosticsFor is environmentDiagnostics without the "(environment)" filter -- the alias
// diagnostic is raised at the palette level and carries its own FileID.
func diagnosticsFor(t *testing.T, config Config) []Diagnostic {
	t.Helper()
	result, err := Generate(config, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	return result.Diagnostics
}
