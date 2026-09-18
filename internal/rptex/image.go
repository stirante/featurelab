package rptex

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Extensions are the container formats a terrain_texture.json "path" may
// resolve to, in the order they are probed. Vanilla ships both: 1230 of the
// 1281 paths terrain_texture.json reaches in bedrock-samples v1.26.30.5 are
// .png and 51 are .tga, so a PNG-only loader silently loses grass_side and
// every double-plant.
var Extensions = []string{".png", ".tga"}

// FindTexture resolves relPath (a terrain_texture.json path such as
// "textures/blocks/grass_side", written WITHOUT an extension) against root
// and returns the real file on disk, extension and all.
//
// Separate from LoadImage because more than one caller wants the PATH and not
// the pixels -- internal/packrender records where each of a pack's texture
// keys lives so the atlas builder can open it later. Probing the extensions
// in two places is exactly the kind of split that drifts.
//
// A path written WITH its extension ("textures/blocks/limestone.png") is also
// accepted. The extensionless spelling is the documented convention and every
// vanilla entry uses it, but the game loads the other one too and packs in the
// wild write it, so probing only stem+".png" loses exactly those blocks to a
// flat colour with no way for the author to tell why. The extra probes run
// only where the plain ones found nothing, so nothing that resolves today
// resolves to a different file.
//
// A stem with no image behind it may still be a TEXTURE SET
// (<path>.texture_set.json, see textureset.go), and one whose colour channel
// names another texture resolves through it to that texture's file. A path
// written as the texture set file itself -- suffix and all -- names that same
// file and is accepted as it stands. A texture
// set whose colour is a literal is not a file at all, and FindTexture --
// which answers "where are the pixels" with a path -- reports it as such;
// ResolveTexture is the caller-facing form that carries the colour.
func FindTexture(root, relPath string) (string, error) {
	tex, err := ResolveTexture(root, relPath)
	if err != nil {
		return "", err
	}
	if tex.File == "" {
		return "", fmt.Errorf("%s resolves through %s to the flat colour %s, which is not a file",
			relPath, strings.Join(tex.Sets, " -> "), tex.Color.Hex())
	}
	return tex.File, nil
}

// Texture is where one resolved texture path's pixels come from: a file on
// disk, or a flat colour a texture set spelled out instead of shipping art.
// Exactly one of File and Color is set.
type Texture struct {
	// File is the real file found on disk, extension and all.
	File string
	// Color is a texture set's literal colour channel, nil when File is set.
	// A consumer draws it as a single texel -- see internal/atlas, which
	// synthesises a 1x1 cell and lets its ordinary upscale take it the rest
	// of the way.
	Color *RGBA
	// Sets is every <name>.texture_set.json walked to get here, in order,
	// empty when the path resolved straight to a file. It is what lets a
	// staleness check hash the indirection as well as its target.
	Sets []string
}

// maxTextureSetHops bounds how many texture sets one path may chase. A texture
// set's colour naming another texture set is already unusual; two in a row is
// not a thing real packs do, and the bound is what keeps a malformed pack a
// reported failure rather than a hang. The cycle guard below catches the
// circular case even inside the bound.
const maxTextureSetHops = 2

// ResolveTexture is FindTexture's full answer: the image file, or the flat
// colour a texture set declared in place of one, plus the texture sets walked
// on the way.
func ResolveTexture(root, relPath string) (Texture, error) {
	return resolveTexture(root, relPath, 0, map[string]bool{})
}

func resolveTexture(root, relPath string, hop int, seen map[string]bool) (Texture, error) {
	// A path that already NAMES the texture set file is taken as itself. The
	// documented spelling is the bare stem ("textures/blocks/limestone", with
	// limestone.texture_set.json sitting beside it), but terrain_texture.json
	// entries in the wild write the whole file name, which means the same file.
	// Appending the suffix a second time would look for
	// "limestone.texture_set.json.texture_set.json", find nothing, and lose the
	// texture over a spelling the author had every reason to think was fine.
	explicitSet := hasTextureSetSuffix(relPath)
	setFile := filepath.Join(root, filepath.FromSlash(relPath))
	if !explicitSet {
		if file, ok := findImageFile(root, relPath); ok {
			return Texture{File: file}, nil
		}
		setFile += TextureSetSuffix
	}
	if st, err := os.Stat(setFile); err != nil || st.IsDir() {
		if explicitSet {
			return Texture{}, fmt.Errorf("no %s found at %s (looked under %s)", TextureSetSuffix, relPath, root)
		}
		return Texture{}, fmt.Errorf("no %v and no %s found for %s (looked under %s)",
			Extensions, TextureSetSuffix, relPath, root)
	}
	if seen[setFile] {
		return Texture{}, fmt.Errorf("%s is reached again while resolving its own minecraft:texture_set color -- a cycle", setFile)
	}
	seen[setFile] = true

	set, err := LoadTextureSet(setFile)
	if err != nil {
		return Texture{Sets: []string{setFile}}, err
	}
	if set.Color != nil {
		return Texture{Color: set.Color, Sets: []string{setFile}}, nil
	}
	if hop+1 > maxTextureSetHops {
		return Texture{Sets: []string{setFile}}, fmt.Errorf(
			"%s: minecraft:texture_set color chases more than %d texture sets", setFile, maxTextureSetHops)
	}

	// "Sibling first, then pack root". A texture set's colour is nearly
	// always a bare name meant as the file next to it ("limestone_base"
	// beside "limestone.texture_set.json"); the pack-root-relative reading is
	// the one terrain_texture.json itself uses and some packs write here too.
	// Trying the sibling first is what makes the common spelling resolve to
	// the file the author meant rather than to a same-named texture elsewhere
	// in the pack.
	var reasons []string
	for _, candidate := range colorPathCandidates(relPath, set.Path) {
		tex, err := resolveTexture(root, candidate, hop+1, seen)
		if err != nil {
			reasons = append(reasons, err.Error())
			continue
		}
		tex.Sets = append([]string{setFile}, tex.Sets...)
		return tex, nil
	}
	return Texture{Sets: []string{setFile}}, fmt.Errorf(
		"%s: minecraft:texture_set color %q resolves to no texture (%s)",
		setFile, set.Path, strings.Join(reasons, "; "))
}

// colorPathCandidates is the sibling-then-pack-root order, deduplicated (a
// texture set at the pack root has the same two candidates).
func colorPathCandidates(setRelPath, color string) []string {
	color = path.Clean(filepath.ToSlash(color))
	out := make([]string, 0, 2)
	if dir := path.Dir(filepath.ToSlash(setRelPath)); dir != "." && dir != "/" {
		out = append(out, path.Join(dir, color))
	}
	for _, existing := range out {
		if existing == color {
			return out
		}
	}
	return append(out, color)
}

// findImageFile is the plain image probe FindTexture has always run: the
// extensionless stem under each container, then the written-with-its-extension
// spellings.
func findImageFile(root, relPath string) (string, bool) {
	base := filepath.Join(root, filepath.FromSlash(relPath))
	for _, ext := range Extensions {
		full := base + ext
		if st, err := os.Stat(full); err == nil && !st.IsDir() {
			return full, true
		}
	}
	if hasTextureExt(base) {
		if st, err := os.Stat(base); err == nil && !st.IsDir() {
			return base, true
		}
		// The same stem under the OTHER container: a pack that renamed a .tga
		// to .png without touching terrain_texture.json, which is a real and
		// otherwise silent way to lose a texture.
		stem := strings.TrimSuffix(base, filepath.Ext(base))
		for _, ext := range Extensions {
			full := stem + ext
			if st, err := os.Stat(full); err == nil && !st.IsDir() {
				return full, true
			}
		}
	}
	return "", false
}

// hasTextureSetSuffix reports whether relPath is already written as a texture
// set file name rather than as the stem one sits beside.
func hasTextureSetSuffix(relPath string) bool {
	return strings.HasSuffix(strings.ToLower(filepath.ToSlash(relPath)), TextureSetSuffix)
}

// hasTextureExt reports whether path already ends in one of the container
// extensions, case-insensitively. A path whose last dot introduces something
// else ("textures/blocks/v1.2/stone") is not one, and is left to the ordinary
// stem-plus-extension probe.
func hasTextureExt(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	for _, known := range Extensions {
		if ext == known {
			return true
		}
	}
	return false
}

// DecodeFile decodes one texture file, choosing the decoder by extension.
func DecodeFile(path string) (image.Image, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var img image.Image
	if strings.EqualFold(filepath.Ext(path), ".tga") {
		img, err = DecodeTGA(data)
	} else {
		img, err = png.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return img, nil
}

// LoadImage finds relPath under root and decodes it, returning the image and
// the extension it came from.
//
// A path that resolves to a texture set's flat COLOUR has no file and no
// extension: it comes back as the 1x1 image that colour describes, which every
// consumer here already knows how to enlarge (internal/atlas's normalise
// upscales any square whose edge divides the cell), and the reported extension
// is TextureSetSuffix so a caller can still tell where the pixels came from.
func LoadImage(root, relPath string) (image.Image, string, error) {
	tex, err := ResolveTexture(root, relPath)
	if err != nil {
		return nil, "", err
	}
	if tex.File == "" {
		return ColorImage(*tex.Color), TextureSetSuffix, nil
	}
	img, err := DecodeFile(tex.File)
	if err != nil {
		return nil, "", err
	}
	return img, strings.ToLower(filepath.Ext(tex.File)), nil
}

// ColorImage is one texel of a flat colour: what a texture set that declares a
// literal colour instead of shipping art actually describes.
func ColorImage(c RGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	img.Pix[0], img.Pix[1], img.Pix[2], img.Pix[3] = c.R, c.G, c.B, c.A
	return img
}
