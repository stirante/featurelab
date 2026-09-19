package blocktextures

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/stirante/featurelab/vanillaassets"
	"github.com/stirante/featurelab/wire"
)

// isolate makes every test in this file blind to whatever the machine running
// it happens to have: no inherited FEATURELAB_VANILLA_PACK checkout, no
// populated user cache, no atlas anyone built by hand. Without it a developer
// with textures already set up would see these tests pass for the wrong
// reason.
func isolate(t *testing.T) Options {
	t.Helper()
	t.Setenv(vanillaassets.EnvPack, "")
	t.Setenv(vanillaassets.EnvDownload, "")
	t.Setenv(vanillaassets.EnvCache, t.TempDir())
	t.Setenv(wire.AtlasEnvVar, "")
	return Options{
		Dir:     filepath.Join(t.TempDir(), "atlas"),
		Vanilla: vanillaassets.Options{CacheDir: t.TempDir()},
	}
}

// vanillaFixture is a minimal resource_pack root: a few block textures, a
// terrain_texture.json naming them and a blocks.json binding two vanilla block
// ids to them. Enough for a real atlas.Build, and it never touches the network
// -- which is Piece A's rule and applies here too.
func vanillaFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writePNG(t, root, "textures/blocks/stone", color.NRGBA{140, 140, 140, 255})
	writePNG(t, root, "textures/blocks/dirt", color.NRGBA{134, 96, 67, 255})
	writePNG(t, root, "textures/blocks/slate", color.NRGBA{60, 60, 70, 255})

	write(t, filepath.Join(root, "textures", "terrain_texture.json"), `{
  "resource_pack_name": "fixture",
  "texture_data": {
    "stone": { "textures": "textures/blocks/stone" },
    "dirt": { "textures": "textures/blocks/dirt" }
  }
}`)
	write(t, filepath.Join(root, "blocks.json"), `{
  "format_version": [1, 1, 0],
  "stone": { "textures": "stone" },
  "dirt": { "textures": "dirt" }
}`)
	return root
}

func writePNG(t *testing.T, root, rel string, c color.NRGBA) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.SetNRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(root, filepath.FromSlash(rel))+".png", buf.String())
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A machine that has never run this has one state and it is not an error.
func TestCheckOnAFreshMachine(t *testing.T) {
	opts := isolate(t)
	st := Check(opts)
	if st.State != StateMissing {
		t.Fatalf("state = %q, want %q", st.State, StateMissing)
	}
	if !st.NeedsDownload {
		t.Fatal("NeedsDownload = false on a machine with nothing cached and no checkout")
	}
	if st.Notice == "" {
		t.Fatal("no download notice: a GUI has nothing to put in front of the user before asking")
	}
	// The notice is the one place the user is told what is being fetched. If
	// it ever stops naming the source or the tag, the ask has become "may we
	// download something?", which is exactly what Piece A forbids.
	for _, want := range []string{"bedrock-samples", vanillaassets.PinnedTag, "Mojang"} {
		if !contains(st.Notice, want) {
			t.Errorf("notice does not mention %q:\n%s", want, st.Notice)
		}
	}
	if st.Detail == "" {
		t.Fatal("no Detail: every state has to have a sentence a host can show")
	}
}

// The ask exists because of the network. A machine that already has the assets
// is not being asked for anything.
func TestNoDownloadNeededWithALocalCheckout(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	if st := Check(opts); st.NeedsDownload {
		t.Fatal("NeedsDownload = true with a local resource_pack directory supplied")
	}
}

func TestEnsureBuildsAndCheckThenSaysReady(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)

	result, err := Ensure(context.Background(), opts)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if result.Status.State != StateReady {
		t.Fatalf("state after Ensure = %q, want %q", result.Status.State, StateReady)
	}
	if result.Stats.CellsPacked == 0 {
		t.Fatal("nothing was packed")
	}

	// The two files land exactly where the atlas wire method reads them --
	// that directory layout IS the seam between building and delivering.
	if _, err := wire.LoadAtlas(opts.Dir); err != nil {
		t.Fatalf("wire.LoadAtlas after Ensure: %v", err)
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("Check after Ensure = %q, want %q", st.State, StateReady)
	}
}

// The pin moving is not a broken atlas and is not a missing one: it is an
// atlas that no longer matches the build, and rebuilding is the answer.
func TestAnAtlasFromAnotherTagIsStale(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	opts.Vanilla.Tag = "v0.0.1-fixture"
	if _, err := Ensure(context.Background(), opts); err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	moved := opts
	moved.Vanilla.Tag = "v0.0.2-fixture"
	st := Check(moved)
	if st.State != StateStale {
		t.Fatalf("state = %q, want %q", st.State, StateStale)
	}
	if !contains(st.Detail, "v0.0.1-fixture") || !contains(st.Detail, "v0.0.2-fixture") {
		t.Errorf("Detail does not name both tags: %s", st.Detail)
	}
}

// "Not now" has to be remembered, or it is asked again every launch -- which
// is the same as not respecting it.
func TestDeclineIsRememberedAndUndoneByBuilding(t *testing.T) {
	opts := isolate(t)
	if err := Decline(opts); err != nil {
		t.Fatalf("Decline: %v", err)
	}
	if st := Check(opts); st.State != StateDeclined {
		t.Fatalf("state after Decline = %q, want %q", st.State, StateDeclined)
	}

	opts.Vanilla.Dir = vanillaFixture(t)
	if _, err := Ensure(context.Background(), opts); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("state after Ensure = %q, want %q", st.State, StateReady)
	}
	if _, err := os.Stat(filepath.Join(opts.Dir, declineFile)); !os.IsNotExist(err) {
		t.Fatal("the decline marker survived a successful build; asking for the thing is a better answer than the last no")
	}
}

// Nothing is fetched without being asked, and the failure is ordinary.
func TestEnsureWithoutAssetsOrPermissionFails(t *testing.T) {
	opts := isolate(t)
	if _, err := Ensure(context.Background(), opts); err == nil {
		t.Fatal("Ensure succeeded with nothing cached and downloading not permitted")
	}
	if _, err := os.Stat(filepath.Join(opts.Dir, wire.AtlasTableFile)); !os.IsNotExist(err) {
		t.Fatal("a failed Ensure left an atlas table behind")
	}
}

// The whole point of item 4: a pack's own blocks reach the same sheet and the
// same table as vanilla's, through Piece B's ExtraTextures/BlockFaces seam.
func TestAPacksOwnBlocksReachTheAtlas(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	opts.PackDir = filepath.Join("..", "pack", "testdata", "addon", "MyAddon_bp")

	result, err := Ensure(context.Background(), opts)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if result.Pack == nil {
		t.Fatal("no pack summary: the pack under test contributed nothing")
	}
	if result.Pack.Blocks == 0 {
		t.Fatal("the pack's own blocks were not read")
	}
	if result.Stats.ExtraCells == 0 {
		t.Fatal("none of the pack's own textures were packed into the sheet")
	}

	out, err := wire.LoadAtlas(opts.Dir)
	if err != nil {
		t.Fatalf("wire.LoadAtlas: %v", err)
	}
	var table struct {
		Blocks map[string]struct {
			Faces map[string]int `json:"faces"`
			Note  string         `json:"note"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(out.Table, &table); err != nil {
		t.Fatal(err)
	}
	slate, ok := table.Blocks["myaddon:slate"]
	if !ok {
		t.Fatal("myaddon:slate is not in the delivered table; a pack block would render as a hash colour")
	}
	if len(slate.Faces) == 0 {
		t.Fatal("myaddon:slate has no faces")
	}
	// A block whose geometry is a resource-pack model still draws -- as a
	// textured cube -- and the table says so, per block, so a host can tell
	// someone about the blocks their preview actually placed.
	lamp, ok := table.Blocks["myaddon:sculpted_lamp"]
	if !ok {
		t.Fatal("myaddon:sculpted_lamp is not in the delivered table")
	}
	if lamp.Note == "" {
		t.Fatal("no note on a block drawn as a cube because its geometry is a model")
	}
	if len(result.Notes) == 0 {
		t.Fatal("Result carries no notes")
	}
}

// A block whose textures did not resolve draws as a flat colour, which is
// exactly what a machine with no atlas at all draws. The count alone cannot
// tell those two apart, so the summary has to say which faces and why -- and
// the two reasons have two different fixes, so it has to distinguish them.
func TestPackSummaryExplainsEachUnresolvedTexture(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	opts.PackDir = filepath.Join("..", "pack", "testdata", "addon", "MyAddon_bp")

	result, err := Ensure(context.Background(), opts)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if result.Pack == nil {
		t.Fatal("no pack summary")
	}
	if result.Pack.Untextured == 0 {
		t.Fatal("the fixture pack defines a block with unresolvable textures; the summary counted none")
	}
	if result.Pack.UnresolvedTotal == 0 || len(result.Pack.Unresolved) == 0 {
		t.Fatalf("Untextured = %d but nothing was listed: an author is told a number they cannot act on",
			result.Pack.Untextured)
	}
	if len(result.Pack.Unresolved) > UnresolvedLimit {
		t.Fatalf("listed %d entries, past the %d cap", len(result.Pack.Unresolved), UnresolvedLimit)
	}

	byKey := map[string]string{}
	for _, u := range result.Pack.Unresolved {
		if u.Block == "" || u.Face == "" || u.Texture == "" || u.Reason == "" {
			t.Fatalf("incomplete entry %+v: every field is part of the sentence a host prints", u)
		}
		byKey[u.Texture] = u.Reason
	}
	// The key IS declared but its file is not on disk -- the fix is to export
	// the image.
	missingImage, ok := byKey["myaddon:missing_image"]
	if !ok {
		t.Fatalf("no entry for a declared key whose image is absent; got %v", byKey)
	}
	// The key is not declared at all -- the fix is to add it to
	// terrain_texture.json. The two must not share one sentence.
	neverDeclared, ok := byKey["myaddon:never_declared"]
	if !ok {
		t.Fatalf("no entry for a key that terrain_texture.json never declares; got %v", byKey)
	}
	if missingImage == neverDeclared {
		t.Fatalf("both failures explained identically (%q): they have different fixes", missingImage)
	}
}

// An atlas built by `genatlas` before any of this existed has no marker of its
// own. It is still an atlas, and its own table says which tag it came from.
func TestAnUnmarkedAtlasIsReadThroughItsTable(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	if _, err := Ensure(context.Background(), opts); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if err := os.Remove(filepath.Join(opts.Dir, markerFile)); err != nil {
		t.Fatal(err)
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("state = %q, want %q", st.State, StateReady)
	}
}

func TestABrokenTableIsNotAMissingOne(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	if _, err := Ensure(context.Background(), opts); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if err := os.Remove(filepath.Join(opts.Dir, markerFile)); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(opts.Dir, wire.AtlasTableFile), "{ this is not json")
	st := Check(opts)
	if st.State != StateBroken {
		t.Fatalf("state = %q, want %q", st.State, StateBroken)
	}
	if st.Detail == "" {
		t.Fatal("a broken atlas has to say so")
	}
}

func contains(haystack, needle string) bool {
	return bytes.Contains([]byte(haystack), []byte(needle))
}

// TestWhatCouldNotBeTexturedSurvivesTheProcessThatBuiltIt is the writer's half of the contract
// wire/atlas_test.go tests the reader's half of.
//
// "3 blocks with an unresolved texture" used to live exactly as long as the `textures` process
// that printed it. A host loading the atlas afterwards read two files off disk and had nothing
// to say about why a block draws as a flat colour -- which is the one question someone looking
// at a flat-coloured block actually has. The rows are recorded in the build marker, and
// wire.LoadAtlas reads them back; "unresolved" and "unresolvedTotal" are the only two fields of
// that marker another package decodes, so this asserts on them together rather than trusting
// two structs that happen to have matching tags today.
func TestWhatCouldNotBeTexturedSurvivesTheProcessThatBuiltIt(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	opts.PackDir = filepath.Join("..", "pack", "testdata", "addon", "MyAddon_bp")

	result, err := Ensure(context.Background(), opts)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if result.Pack == nil || result.Pack.UnresolvedTotal == 0 {
		t.Skip("this fixture pack textured everything; there is nothing for this test to carry")
	}

	out, err := wire.LoadAtlas(opts.Dir)
	if err != nil {
		t.Fatalf("wire.LoadAtlas: %v", err)
	}
	// The TOTAL is the real count; the rows are capped at UnresolvedLimit. A host must not
	// compute one from the other.
	if out.UnresolvedTotal != result.Pack.UnresolvedTotal {
		t.Errorf("delivered UnresolvedTotal = %d, built %d", out.UnresolvedTotal, result.Pack.UnresolvedTotal)
	}
	if len(out.Unresolved) != len(result.Pack.Unresolved) {
		t.Fatalf("delivered %d rows, built %d", len(out.Unresolved), len(result.Pack.Unresolved))
	}
	if len(out.Unresolved) > UnresolvedLimit {
		t.Errorf("delivered %d rows, above the %d cap", len(out.Unresolved), UnresolvedLimit)
	}
	for i, built := range result.Pack.Unresolved {
		got := out.Unresolved[i]
		if got.Block != built.Block || got.Face != built.Face || got.Texture != built.Texture ||
			got.Reason != built.Reason || got.Code != built.Code {
			t.Errorf("row %d: delivered %+v, built %+v", i, got, built)
		}
	}
}
