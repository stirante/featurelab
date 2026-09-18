package rptex

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("not really an image"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// TestFindTexture_ExtensionlessPathIsStillFirst pins the documented
// convention: the extensionless spelling every vanilla entry uses resolves
// through the plain probe, .png ahead of .tga.
func TestFindTexture_ExtensionlessPathIsStillFirst(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "textures", "blocks", "stone.png"))
	writeFile(t, filepath.Join(root, "textures", "blocks", "stone.tga"))

	got, err := FindTexture(root, "textures/blocks/stone")
	if err != nil {
		t.Fatalf("FindTexture: %v", err)
	}
	if want := filepath.Join(root, "textures", "blocks", "stone.png"); got != want {
		t.Fatalf("FindTexture = %q, want %q", got, want)
	}
}

// TestFindTexture_PathWrittenWithItsExtension is the pack-authoring variant
// that used to lose a block to a flat colour: terrain_texture.json naming
// "textures/blocks/limestone.png", which the game loads and the old probe
// turned into a search for "limestone.png.png".
func TestFindTexture_PathWrittenWithItsExtension(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "textures", "blocks", "limestone.png"))

	got, err := FindTexture(root, "textures/blocks/limestone.png")
	if err != nil {
		t.Fatalf("FindTexture: %v", err)
	}
	if want := filepath.Join(root, "textures", "blocks", "limestone.png"); got != want {
		t.Fatalf("FindTexture = %q, want %q", got, want)
	}
}

// TestFindTexture_ExtensionWrittenButFileIsTheOther covers a pack that changed
// container without editing terrain_texture.json.
func TestFindTexture_ExtensionWrittenButFileIsTheOther(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "textures", "blocks", "fern.tga"))

	got, err := FindTexture(root, "textures/blocks/fern.png")
	if err != nil {
		t.Fatalf("FindTexture: %v", err)
	}
	if want := filepath.Join(root, "textures", "blocks", "fern.tga"); got != want {
		t.Fatalf("FindTexture = %q, want %q", got, want)
	}
}

// TestFindTexture_DotInAnExtensionlessPath checks the extension test is not
// fooled by a directory or stem that merely contains a dot: ".2" is not a
// container extension, so only the ordinary stem-plus-extension probe applies.
func TestFindTexture_DotInAnExtensionlessPath(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "textures", "blocks", "slab_v1.2.png"))

	got, err := FindTexture(root, "textures/blocks/slab_v1.2")
	if err != nil {
		t.Fatalf("FindTexture: %v", err)
	}
	if want := filepath.Join(root, "textures", "blocks", "slab_v1.2.png"); got != want {
		t.Fatalf("FindTexture = %q, want %q", got, want)
	}
}

// TestFindTexture_MissingStillReportsWhereItLooked keeps the not-found answer
// an explanation rather than a bare false.
func TestFindTexture_MissingStillReportsWhereItLooked(t *testing.T) {
	root := t.TempDir()
	if _, err := FindTexture(root, "textures/blocks/absent"); err == nil {
		t.Fatal("FindTexture: expected an error for a path with no file behind it")
	}
	// A directory is not a texture, whichever way the path is spelled.
	if err := os.MkdirAll(filepath.Join(root, "textures", "blocks", "dir.png"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := FindTexture(root, "textures/blocks/dir.png"); err == nil {
		t.Fatal("FindTexture: a directory named like a texture must not resolve")
	}
}
