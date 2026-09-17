package blocktextures

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// copyAddon copies the shared behaviour+resource pack fixture somewhere
// writable. The fixture itself is read by several packages' tests and must
// stay untouched; every test in this file edits the pack, which is the whole
// subject.
func copyAddon(t *testing.T) string {
	t.Helper()
	src := filepath.Join("..", "pack", "testdata", "addon")
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		buf, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, buf, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

// copiedPack copies the fixture and points an isolated Options at it, without
// building anything yet -- for a test that has to arrange the pack before the
// atlas is made from it.
func copiedPack(t *testing.T) (Options, string) {
	t.Helper()
	addon := copyAddon(t)
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	opts.PackDir = filepath.Join(addon, "MyAddon_bp")
	return opts, addon
}

// buildAndConfirmReady is the precondition every test here shares: an atlas
// that exists and that Check is happy with, so that a later "stale" is
// attributable to the edit and to nothing else.
func buildAndConfirmReady(t *testing.T, opts Options) {
	t.Helper()
	if _, err := Ensure(context.Background(), opts); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("state straight after Ensure = %q (%s), want %q", st.State, st.Detail, StateReady)
	}
}

// builtAgainstACopiedPack builds an atlas from the copied fixture and returns
// the options plus the pack root, ready for a test to edit something and ask
// Check what it thinks.
func builtAgainstACopiedPack(t *testing.T) (Options, string) {
	t.Helper()
	opts, addon := copiedPack(t)
	buildAndConfirmReady(t, opts)
	return opts, addon
}

// solidPNG returns a valid 16x16 PNG of one colour, padded with trailing bytes
// to exactly size. Everything after IEND is ignored by every PNG decoder, so
// the result decodes normally -- which is what lets a test produce a repaint
// whose file is byte-for-byte the same LENGTH as the one it replaces.
func solidPNG(t *testing.T, c color.NRGBA, size int) []byte {
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
	out := buf.Bytes()
	if len(out) > size {
		t.Fatalf("encoded PNG is %d bytes, cannot be padded down to %d", len(out), size)
	}
	return append(out, make([]byte, size-len(out))...)
}

// THE BUG THIS FILE EXISTS FOR. Repainting a 16x16 texture almost always
// produces a file of exactly the same size, and plenty of editors write it
// back with the mtime preserved. Under count/size/mtime that edit was
// invisible: the block kept drawing its old texture and nothing was said.
func TestARepaintedTextureOfTheSameSizeAndMtimeIsStale(t *testing.T) {
	opts, addon := copiedPack(t)
	slate := filepath.Join(addon, "MyAddon_rp", "textures", "blocks", "slate.png")

	// The pack's own texture, laid down at a fixed size so that the repaint
	// below can match it exactly. A real 16x16 repaint matches by itself --
	// PNG of a hand-drawn tile is dominated by its fixed chunk headers -- but
	// a test that relies on two encodings coming out the same length is a
	// test that fails the day the encoder changes.
	const size = 256
	if err := os.WriteFile(slate, solidPNG(t, color.NRGBA{90, 90, 100, 255}, size), 0o644); err != nil {
		t.Fatal(err)
	}
	buildAndConfirmReady(t, opts)

	before, err := os.Stat(slate)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(slate, solidPNG(t, color.NRGBA{200, 40, 40, 255}, size), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(slate, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}

	// Proving the edit really is invisible to the old detector, so that this
	// test cannot pass for the wrong reason -- a repaint that happened to
	// change the size would restale even without a content hash.
	after, err := os.Stat(slate)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() != before.Size() {
		t.Fatalf("the repaint changed the file size (%d -> %d); this test is not exercising the bug", before.Size(), after.Size())
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("the repaint changed the mtime (%v -> %v); this test is not exercising the bug", before.ModTime(), after.ModTime())
	}

	st := Check(opts)
	if st.State != StateStale {
		t.Fatalf("state after repainting a pack texture = %q (%s), want %q", st.State, st.Detail, StateStale)
	}
	if st.Detail == "" {
		t.Fatal("a stale atlas has to say why")
	}
}

// The other half of the trade, and the reason this is a hash rather than a
// stricter stat comparison: a file whose timestamp moved but whose bytes did
// not is not a change, and rebuilding on it would make every `git checkout`
// and every backup restore cost an atlas.
func TestTouchingAPackFileWithoutChangingItIsNotStale(t *testing.T) {
	opts, addon := builtAgainstACopiedPack(t)
	later := time.Now().Add(2 * time.Hour)
	for _, rel := range []string{
		filepath.Join("MyAddon_rp", "textures", "blocks", "slate.png"),
		filepath.Join("MyAddon_rp", "textures", "terrain_texture.json"),
		filepath.Join("MyAddon_bp", "blocks", "slate.json"),
		filepath.Join("MyAddon_bp", "manifest.json"),
	} {
		if err := os.Chtimes(filepath.Join(addon, rel), later, later); err != nil {
			t.Fatal(err)
		}
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("state after touching four unchanged files = %q (%s), want %q", st.State, st.Detail, StateReady)
	}
}

// The behaviour-pack half still restales, and now for the same reason as the
// texture half rather than by a second mechanism.
func TestEditingABlockDefinitionIsStale(t *testing.T) {
	opts, addon := builtAgainstACopiedPack(t)
	slate := filepath.Join(addon, "MyAddon_bp", "blocks", "slate.json")
	before, err := os.Stat(slate)
	if err != nil {
		t.Fatal(err)
	}
	buf, err := os.ReadFile(slate)
	if err != nil {
		t.Fatal(err)
	}
	// A one-character edit that keeps the length: "slate_top" -> "slate_tob"
	// is nonsense as a texture key, and nonsense is exactly what a preview
	// should show the author rather than the old picture.
	edited := bytes.Replace(buf, []byte("slate_top"), []byte("slate_tob"), 1)
	if bytes.Equal(edited, buf) {
		t.Fatal("the fixture no longer contains the string this test edits")
	}
	if err := os.WriteFile(slate, edited, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(slate, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	if st := Check(opts); st.State != StateStale {
		t.Fatalf("state after editing a block definition = %q (%s), want %q", st.State, st.Detail, StateStale)
	}
}

// A block file appearing or disappearing is a change too, which is why the
// behaviour pack's blocks/ is WALKED rather than listed in the marker.
func TestAddingABlockDefinitionIsStale(t *testing.T) {
	opts, addon := builtAgainstACopiedPack(t)
	added := filepath.Join(addon, "MyAddon_bp", "blocks", "another.json")
	write(t, added, `{
  "format_version": "1.21.100",
  "minecraft:block": {
    "description": { "identifier": "myaddon:another" },
    "components": { "minecraft:material_instances": { "*": { "texture": "myaddon:slate" } } }
  }
}`)
	if st := Check(opts); st.State != StateStale {
		t.Fatalf("state after adding a block definition = %q (%s), want %q", st.State, st.Detail, StateStale)
	}
}

// The case a list of "files the build opened" cannot see. myaddon:missing_image
// is declared in the fixture's terrain_texture.json and its PNG is not on disk,
// so the build resolved it to nothing. The author's fix is to export the file --
// and a file APPEARING where the build found none has to count, or the very
// next thing that person does after being told their texture is missing has no
// effect.
func TestATextureAppearingWhereTheBuildFoundNoneIsStale(t *testing.T) {
	opts, addon := builtAgainstACopiedPack(t)
	missing := filepath.Join(addon, "MyAddon_rp", "textures", "blocks", "not_on_disk.png")
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("the fixture already has %s; this test is not exercising the case", missing)
	}
	if err := os.WriteFile(missing, solidPNG(t, color.NRGBA{20, 90, 200, 255}, 0x200), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := Check(opts); st.State != StateStale {
		t.Fatalf("state after exporting a texture the build could not find = %q (%s), want %q", st.State, st.Detail, StateStale)
	}
}

func TestDeletingAPackTextureIsStale(t *testing.T) {
	opts, addon := builtAgainstACopiedPack(t)
	if err := os.Remove(filepath.Join(addon, "MyAddon_rp", "textures", "blocks", "fern.png")); err != nil {
		t.Fatal(err)
	}
	if st := Check(opts); st.State != StateStale {
		t.Fatalf("state after deleting a pack texture = %q (%s), want %q", st.State, st.Detail, StateStale)
	}
}

// An atlas built by a version that compared count/size/mtime is not trusted --
// it was checked by rules this build no longer believes -- but it says so
// rather than reporting an edit nobody made.
func TestAnAtlasFromBeforeContentHashingIsStaleOnce(t *testing.T) {
	opts, _ := builtAgainstACopiedPack(t)
	m, err := readMarker(opts.Dir)
	if err != nil {
		t.Fatal(err)
	}
	m.PackSources = nil
	m.PackDigest = ""
	if err := writeMarker(opts.Dir, *m); err != nil {
		t.Fatal(err)
	}
	st := Check(opts)
	if st.State != StateStale {
		t.Fatalf("state = %q (%s), want %q", st.State, st.Detail, StateStale)
	}
	if !contains(st.Detail, "by content") {
		t.Errorf("Detail blames the pack for an edit nobody made: %s", st.Detail)
	}
	// And it settles: rebuilding writes the sources, and the next check is
	// ready rather than stale again.
	if _, err := Ensure(context.Background(), opts); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("state after the one rebuild = %q (%s), want %q", st.State, st.Detail, StateReady)
	}
}

// A pack whose blocks could not be read at all still gets sources recorded,
// or every check would restale it and the tool would rebuild the atlas on
// every start-up forever.
func TestAnUnreadablePackDoesNotRebuildForever(t *testing.T) {
	opts := isolate(t)
	opts.Vanilla.Dir = vanillaFixture(t)
	opts.PackDir = filepath.Join(t.TempDir(), "no_such_pack")

	if _, err := Ensure(context.Background(), opts); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("state = %q (%s), want %q", st.State, st.Detail, StateReady)
	}
	if st := Check(opts); st.State != StateReady {
		t.Fatalf("second check = %q (%s), want %q", st.State, st.Detail, StateReady)
	}
}
