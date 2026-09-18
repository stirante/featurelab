package rptex

import (
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTextureSet writes one <name>.texture_set.json with the given "color"
// value written verbatim, so each test spells the form it is about.
func writeTextureSet(t *testing.T, root, relStem, colorJSON string) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relStem)) + TextureSetSuffix
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := `{"format_version":"1.16.100","minecraft:texture_set":{"color":` + colorJSON +
		`,"metalness_emissive_roughness":[0,0,255],"normal":"unused_normal"}}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

// writePNG writes a real, decodable 1x1 PNG, because the texture-set path ends
// in LoadImage for at least one of these tests and a placeholder byte string
// would only prove that FindTexture stat'd something.
func writePNG(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer f.Close()
	if err := png.Encode(f, ColorImage(RGBA{R: 1, G: 2, B: 3, A: 255})); err != nil {
		t.Fatalf("encode %s: %v", path, err)
	}
}

// TestResolveTexture_TextureSetPointsAtASibling is the common real shape: the
// terrain_texture.json path names a stem that has no image of its own, and the
// texture set beside it names the actual art as a bare sibling name. Before
// this resolved, the face was dropped from the block table and the viewer drew
// the block as a hash colour.
func TestResolveTexture_TextureSetPointsAtASibling(t *testing.T) {
	root := t.TempDir()
	set := writeTextureSet(t, root, "textures/blocks/limestone", `"limestone_base"`)
	writePNG(t, filepath.Join(root, "textures", "blocks", "limestone_base.png"))

	tex, err := ResolveTexture(root, "textures/blocks/limestone")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	want := filepath.Join(root, "textures", "blocks", "limestone_base.png")
	if tex.File != want {
		t.Fatalf("File = %q, want %q", tex.File, want)
	}
	if tex.Color != nil {
		t.Fatalf("Color = %v, want nil for a texture set that names a file", tex.Color)
	}
	if len(tex.Sets) != 1 || tex.Sets[0] != set {
		t.Fatalf("Sets = %v, want exactly [%s]", tex.Sets, set)
	}
	// FindTexture, which every existing caller uses, must reach the same file.
	if got, err := FindTexture(root, "textures/blocks/limestone"); err != nil || got != want {
		t.Fatalf("FindTexture = (%q, %v), want (%q, nil)", got, err, want)
	}
}

// TestResolveTexture_TextureSetSiblingBeatsPackRoot pins the documented
// order. A bare name in a texture set means the file NEXT TO IT; a same-named
// file at the pack root must not win over the one the author was looking at.
func TestResolveTexture_TextureSetSiblingBeatsPackRoot(t *testing.T) {
	root := t.TempDir()
	writeTextureSet(t, root, "textures/blocks/limestone", `"shared"`)
	writePNG(t, filepath.Join(root, "textures", "blocks", "shared.png"))
	writePNG(t, filepath.Join(root, "shared.png"))

	tex, err := ResolveTexture(root, "textures/blocks/limestone")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	if want := filepath.Join(root, "textures", "blocks", "shared.png"); tex.File != want {
		t.Fatalf("File = %q, want the sibling %q", tex.File, want)
	}
}

// TestResolveTexture_TextureSetPackRootFallback is the other spelling: a
// colour written the way terrain_texture.json writes a path, pack-root
// relative, with nothing of that name beside the set file.
func TestResolveTexture_TextureSetPackRootFallback(t *testing.T) {
	root := t.TempDir()
	writeTextureSet(t, root, "textures/blocks/limestone", `"textures/shared/base"`)
	writePNG(t, filepath.Join(root, "textures", "shared", "base.png"))

	tex, err := ResolveTexture(root, "textures/blocks/limestone")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	if want := filepath.Join(root, "textures", "shared", "base.png"); tex.File != want {
		t.Fatalf("File = %q, want %q", tex.File, want)
	}
}

// TestResolveTexture_TextureSetHexColour covers the "#rrggbb" form and its
// alpha-carrying twin. There is no art at all here: the pack has said what the
// face's colour is, and the answer is that colour, not a failure.
func TestResolveTexture_TextureSetHexColour(t *testing.T) {
	root := t.TempDir()
	writeTextureSet(t, root, "textures/blocks/paint", `"#4080c0"`)
	writeTextureSet(t, root, "textures/blocks/glass", `"#4080c080"`)

	tex, err := ResolveTexture(root, "textures/blocks/paint")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	if tex.File != "" {
		t.Fatalf("File = %q, want none for a literal colour", tex.File)
	}
	if tex.Color == nil || *tex.Color != (RGBA{R: 0x40, G: 0x80, B: 0xc0, A: 0xff}) {
		t.Fatalf("Color = %v, want #4080c0 opaque", tex.Color)
	}

	// An unwritten alpha is opaque; a written one survives, because a pack
	// that declared a see-through flat colour meant a see-through face.
	glass, err := ResolveTexture(root, "textures/blocks/glass")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	if glass.Color == nil || glass.Color.A != 0x80 {
		t.Fatalf("Color = %v, want alpha 0x80", glass.Color)
	}
	if got := glass.Color.Hex(); got != "#4080c080" {
		t.Fatalf("Hex = %q, want %q", got, "#4080c080")
	}

	// FindTexture answers "where are the pixels" with a path, so it reports a
	// flat colour rather than inventing one -- and says what it found.
	_, err = FindTexture(root, "textures/blocks/paint")
	if err == nil || !strings.Contains(err.Error(), "#4080c0") {
		t.Fatalf("FindTexture error = %v, want one naming the flat colour", err)
	}

	// LoadImage, which wants pixels rather than a path, gets the one texel the
	// colour describes.
	img, ext, err := LoadImage(root, "textures/blocks/paint")
	if err != nil {
		t.Fatalf("LoadImage: %v", err)
	}
	if ext != TextureSetSuffix {
		t.Fatalf("LoadImage extension = %q, want %q", ext, TextureSetSuffix)
	}
	if b := img.Bounds(); b.Dx() != 1 || b.Dy() != 1 {
		t.Fatalf("LoadImage bounds = %v, want 1x1", b)
	}
	r, g, bl, a := img.At(0, 0).RGBA()
	if r>>8 != 0x40 || g>>8 != 0x80 || bl>>8 != 0xc0 || a>>8 != 0xff {
		t.Fatalf("texel = (%d,%d,%d,%d), want (64,128,192,255)", r>>8, g>>8, bl>>8, a>>8)
	}
}

// TestResolveTexture_TextureSetArrayColour covers the RGB and RGBA array
// forms, including the out-of-range value that is clamped rather than thrown
// away -- refusing the whole texture over a 300 would put the block back on a
// hash colour, which is further from what the author wrote.
func TestResolveTexture_TextureSetArrayColour(t *testing.T) {
	root := t.TempDir()
	writeTextureSet(t, root, "textures/blocks/rgb", `[10, 20, 30]`)
	writeTextureSet(t, root, "textures/blocks/rgba", `[10, 20, 30, 128]`)
	writeTextureSet(t, root, "textures/blocks/wild", `[300, -5, 30.6]`)

	rgb, err := ResolveTexture(root, "textures/blocks/rgb")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	if rgb.Color == nil || *rgb.Color != (RGBA{R: 10, G: 20, B: 30, A: 0xff}) {
		t.Fatalf("Color = %v, want (10,20,30,255)", rgb.Color)
	}

	rgba, err := ResolveTexture(root, "textures/blocks/rgba")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	if rgba.Color == nil || *rgba.Color != (RGBA{R: 10, G: 20, B: 30, A: 128}) {
		t.Fatalf("Color = %v, want (10,20,30,128)", rgba.Color)
	}

	wild, err := ResolveTexture(root, "textures/blocks/wild")
	if err != nil {
		t.Fatalf("ResolveTexture: %v", err)
	}
	if wild.Color == nil || *wild.Color != (RGBA{R: 0xff, G: 0, B: 31, A: 0xff}) {
		t.Fatalf("Color = %v, want (255,0,31,255)", wild.Color)
	}
}

// TestResolveTexture_TextureSetNamesAMissingFile is the reporting case: the
// texture set is real and readable, and the file its colour names is not
// there. That must come back as a sentence naming both, not as a crash and not
// as the same message a path with no texture set at all produces -- the two
// have different fixes.
func TestResolveTexture_TextureSetNamesAMissingFile(t *testing.T) {
	root := t.TempDir()
	set := writeTextureSet(t, root, "textures/blocks/limestone", `"limestone_base"`)

	_, err := ResolveTexture(root, "textures/blocks/limestone")
	if err == nil {
		t.Fatal("ResolveTexture: expected an error for a texture set naming a missing file")
	}
	msg := err.Error()
	for _, want := range []string{set, "limestone_base"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error %q does not name %q", msg, want)
		}
	}

	// And the plainer failure it must stay distinguishable from.
	_, err = ResolveTexture(root, "textures/blocks/nothing_at_all")
	if err == nil || !strings.Contains(err.Error(), TextureSetSuffix) {
		t.Fatalf("error = %v, want one saying no image and no texture set were found", err)
	}
}

// TestResolveTexture_PathWrittenAsTheTextureSetFile is the spelling a pack
// author reaches for once they know texture sets exist: terrain_texture.json
// naming "textures/blocks/limestone.texture_set.json" outright rather than the
// stem it sits beside. The suffix used to be appended a SECOND time, so the
// resolver looked for "limestone.texture_set.json.texture_set.json", found
// nothing, and the block fell back to a flat colour.
func TestResolveTexture_PathWrittenAsTheTextureSetFile(t *testing.T) {
	root := t.TempDir()
	set := writeTextureSet(t, root, "textures/blocks/limestone", `"limestone_base"`)
	want := filepath.Join(root, "textures", "blocks", "limestone_base.png")
	writePNG(t, want)

	const relPath = "textures/blocks/limestone.texture_set.json"
	tex, err := ResolveTexture(root, relPath)
	if err != nil {
		t.Fatalf("ResolveTexture(%q): %v", relPath, err)
	}
	if tex.File != want {
		t.Errorf("ResolveTexture(%q).File = %q, want %q", relPath, tex.File, want)
	}
	if len(tex.Sets) != 1 || tex.Sets[0] != set {
		t.Errorf("ResolveTexture(%q).Sets = %v, want the one texture set walked", relPath, tex.Sets)
	}
	// The suffix itself is recognised case-insensitively, like every other
	// extension in this package. It is checked here rather than through the
	// filesystem, which answers the question differently on Windows and Linux.
	if !hasTextureSetSuffix("textures/blocks/limestone.TEXTURE_SET.JSON") {
		t.Error("a shouted .texture_set.json suffix is not recognised")
	}
	if hasTextureSetSuffix("textures/blocks/limestone") {
		t.Error("a bare stem was mistaken for a texture set file name")
	}

	// A flat colour reached the same way, and the failure when the named file
	// is simply not there -- which must still say where it looked.
	writeTextureSet(t, root, "textures/blocks/paint", `"#102030"`)
	flat, err := ResolveTexture(root, "textures/blocks/paint.texture_set.json")
	if err != nil {
		t.Fatalf("ResolveTexture(paint.texture_set.json): %v", err)
	}
	if flat.Color == nil || flat.Color.Hex() != "#102030" {
		t.Errorf("Color = %v, want #102030", flat.Color)
	}
	_, err = ResolveTexture(root, "textures/blocks/absent.texture_set.json")
	if err == nil || !strings.Contains(err.Error(), TextureSetSuffix) {
		t.Fatalf("error = %v, want one naming the texture set it could not find", err)
	}
}

// TestResolveTexture_TextureSetCycle is the malformed pack that must not hang:
// two texture sets naming each other's stems.
func TestResolveTexture_TextureSetCycle(t *testing.T) {
	root := t.TempDir()
	writeTextureSet(t, root, "textures/blocks/a", `"b"`)
	writeTextureSet(t, root, "textures/blocks/b", `"a"`)

	_, err := ResolveTexture(root, "textures/blocks/a")
	if err == nil {
		t.Fatal("ResolveTexture: expected an error for a texture-set cycle")
	}
	// Either guard may fire first depending on how the candidates fall out;
	// what matters is that it terminates and says which file it is about.
	if !strings.Contains(err.Error(), filepath.FromSlash("textures/blocks")) {
		t.Fatalf("error %q does not name the files involved", err)
	}

	// A texture set naming its OWN stem is the degenerate one-file cycle.
	writeTextureSet(t, root, "textures/blocks/self", `"self"`)
	if _, err := ResolveTexture(root, "textures/blocks/self"); err == nil {
		t.Fatal("ResolveTexture: expected an error for a self-referential texture set")
	}
}

// TestLoadTextureSet_UnsupportedColourFormsSayWhy keeps the "missing file" and
// "colour written in a form this preview does not read" answers apart, since
// the two need different fixes from the author.
func TestLoadTextureSet_UnsupportedColourFormsSayWhy(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name  string
		color string
		want  string
	}{
		{"object", `{"r":1}`, "neither a texture name"},
		{"bare number", `7`, "neither a texture name"},
		{"two-entry array", `[1, 2]`, "has 2 entries"},
		{"short hex", `"#abc"`, "6- or 8-digit"},
		{"empty string", `""`, "empty string"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			file := writeTextureSet(t, root, "textures/blocks/"+strings.ReplaceAll(tc.name, " ", "_"), tc.color)
			_, err := LoadTextureSet(file)
			if err == nil {
				t.Fatalf("LoadTextureSet(%s): expected an error", tc.color)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
			if !strings.Contains(err.Error(), file) {
				t.Fatalf("error %q does not name the file", err)
			}
		})
	}

	// A texture set with no colour channel at all: the other channels are
	// real, and none of them is something this preview can draw.
	path := filepath.Join(root, "textures", "blocks", "mer_only"+TextureSetSuffix)
	if err := os.WriteFile(path, []byte(`{"minecraft:texture_set":{"metalness_emissive_roughness":[0,0,255]}}`), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := LoadTextureSet(path); err == nil || !strings.Contains(err.Error(), "color") {
		t.Fatalf("error = %v, want one naming the missing color channel", err)
	}
}

// TestLoadTextureSet_ToleratesComments -- pack JSON carries them as a matter
// of course, exactly as terrain_texture.json does.
func TestLoadTextureSet_ToleratesComments(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "paint"+TextureSetSuffix)
	body := "{\n // the albedo\n \"minecraft:texture_set\": { \"color\": \"#102030\" }\n}"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	set, err := LoadTextureSet(path)
	if err != nil {
		t.Fatalf("LoadTextureSet: %v", err)
	}
	if set.Color == nil || *set.Color != (RGBA{R: 0x10, G: 0x20, B: 0x30, A: 0xff}) {
		t.Fatalf("Color = %v, want #102030", set.Color)
	}
}
