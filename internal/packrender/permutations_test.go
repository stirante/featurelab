package packrender

// permutations_test.go is the table-side half of block/permutations.go: a
// block whose texture depends on a state has to arrive in Table.Blocks under
// the SAME canonical "name#k=v" key the palette interns a placed block under,
// or the renderer holding that key finds nothing and falls back to the default
// face set -- which is what it did before any of this.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/block"
)

// permutationTable builds a one-block pack whose lamp swaps its top texture
// with a state, and resolves it against a resource pack that has all three
// textures.
func permutationTable(t *testing.T) *Table {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	for _, name := range []string{"lamp_side", "lamp_off", "lamp_on"} {
		write("textures/blocks/"+name+".png", "placeholder bytes -- only the PATH is resolved here")
	}
	write("textures/terrain_texture.json", `{"texture_data":{
		"perm:lamp_side":{"textures":"textures/blocks/lamp_side"},
		"perm:lamp_off":{"textures":"textures/blocks/lamp_off"},
		"perm:lamp_on":{"textures":"textures/blocks/lamp_on"}}}`)

	palette := block.NewPalette()
	if diags := palette.LoadBlockTags([]block.SourceFile{{ID: "blocks/lamp.json", Text: `{
		"format_version": "1.21.100",
		"minecraft:block": {
			"description": {"identifier": "perm:lamp", "states": {"perm:lit": [false, true]}},
			"components": {
				"minecraft:material_instances": {
					"*":  {"texture": "perm:lamp_side"},
					"up": {"texture": "perm:lamp_off"}
				}
			},
			"permutations": [
				{"condition": "q.block_state('perm:lit') == true",
				 "components": {"minecraft:material_instances": {"up": {"texture": "perm:lamp_on"}}}}
			]
		}
	}`}}); len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}

	table, err := Build(Options{
		Palette:            palette,
		TerrainTexturePath: filepath.Join(root, filepath.FromSlash("textures/terrain_texture.json")),
		TextureRoot:        root,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return table
}

// TestBuild_StateRowsAreFiledUnderTheCanonicalKey is the contract the viewer
// depends on, spelled out.
func TestBuild_StateRowsAreFiledUnderTheCanonicalKey(t *testing.T) {
	table := permutationTable(t)

	base, ok := table.Blocks["perm:lamp"]
	if !ok {
		t.Fatal("the block's default row is missing")
	}
	if base.Faces["up"] != "perm:lamp_off" {
		t.Errorf("default up = %q, want the unlit texture", base.Faces["up"])
	}
	if base.States != nil {
		t.Errorf("default row States = %v, want nil", base.States)
	}

	lit, ok := table.Blocks["perm:lamp#perm:lit=true"]
	if !ok {
		t.Fatalf("no row for perm:lamp#perm:lit=true; table has %v", keysOf(table))
	}
	if lit.Faces["up"] != "perm:lamp_on" {
		t.Errorf("lit up = %q, want the lit texture", lit.Faces["up"])
	}
	if lit.Faces["north"] != "perm:lamp_side" {
		t.Errorf("lit north = %q, want the side texture carried over from the default", lit.Faces["north"])
	}
	if len(lit.States) != 1 || lit.States["perm:lit"] != true {
		t.Errorf("lit States = %v, want perm:lit=true", lit.States)
	}

	// The unlit row draws exactly what the default row draws, so it is not
	// emitted: it would be a wire entry that changes nothing, and there is
	// one of those per state combination a permutation does not touch.
	if _, emitted := table.Blocks["perm:lamp#perm:lit=false"]; emitted {
		t.Error("a state row identical to the default row was emitted anyway")
	}

	// And the counts stay about BLOCKS: one lamp, however many states it has.
	if s := table.Summarise(); s.Blocks != 1 || s.Fully != 1 {
		t.Errorf("Summarise = %+v, want 1 block, fully resolved", s)
	}
}

func keysOf(t *Table) []string {
	out := make([]string, 0, len(t.Blocks))
	for k := range t.Blocks {
		out = append(out, k)
	}
	return out
}
