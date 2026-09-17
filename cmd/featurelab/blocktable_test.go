package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stirante/featurelab/vanillaassets"
)

// TestCmdBlockTable_FixtureAddon runs the subcommand end to end against the
// fixture add-on in pack/testdata: the pack's own resource pack is found from
// the manifest, every custom block's textures resolve through it, and the one
// block whose geometry is a resource-pack model carries the sentence that says
// why it is drawn as a cube.
func TestCmdBlockTable_FixtureAddon(t *testing.T) {
	// No test may touch the network. Downloading is already off by default,
	// but the env override exists precisely to turn it on from outside the
	// process, so it is pinned off here rather than assumed.
	t.Setenv(vanillaassets.EnvDownload, "0")
	root := filepath.Join("..", "..", "pack", "testdata", "addon", "MyAddon_bp")

	var code int
	out := captureStdout(t, func() {
		code = run([]string{"blocktable", "--pack", root})
	})
	if code != 0 {
		t.Fatalf("run = %d, want 0; output: %s", code, out)
	}

	var table struct {
		Version      int `json:"version"`
		ResourcePack struct {
			Dir string `json:"dir"`
			How string `json:"how"`
		} `json:"resourcePack"`
		Blocks map[string]struct {
			Faces    map[string]string `json:"faces"`
			Shape    string            `json:"shape"`
			Render   string            `json:"render"`
			Fallback string            `json:"fallback"`
		} `json:"blocks"`
		Textures map[string]struct {
			From string `json:"from"`
			File string `json:"file"`
		} `json:"textures"`
	}
	if err := json.Unmarshal(out, &table); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if table.Version == 0 {
		t.Error("version is missing")
	}
	if table.ResourcePack.How != "manifest dependency" {
		t.Errorf("resourcePack.how = %q, want \"manifest dependency\"", table.ResourcePack.How)
	}
	if !strings.HasSuffix(filepath.ToSlash(table.ResourcePack.Dir), "MyAddon_rp") {
		t.Errorf("resourcePack.dir = %q, want the fixture's MyAddon_rp", table.ResourcePack.Dir)
	}
	slate, ok := table.Blocks["myaddon:slate"]
	if !ok {
		t.Fatalf("myaddon:slate missing; blocks = %v", table.Blocks)
	}
	if len(slate.Faces) != 6 || slate.Shape != "full_block" || slate.Render != "opaque" {
		t.Errorf("myaddon:slate = %+v, want six faces, full_block, opaque", slate)
	}
	if src := table.Textures[slate.Faces["up"]]; src.From != "pack" || src.File == "" {
		t.Errorf("the up face's texture source = %+v, want a pack image on disk", src)
	}
	if fb := table.Blocks["myaddon:sculpted_lamp"].Fallback; !strings.Contains(fb, "full cube") {
		t.Errorf("sculpted_lamp fallback = %q, want it to say what was drawn instead", fb)
	}
}

// TestCmdBlockTable_NeedsAPack pins that the subcommand refuses rather than
// printing an empty table when told nothing to read.
func TestCmdBlockTable_NeedsAPack(t *testing.T) {
	if code := run([]string{"blocktable"}); code != 2 {
		t.Errorf("run = %d, want 2 (usage error)", code)
	}
}
