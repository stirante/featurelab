package rptex

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"os"
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
func FindTexture(root, relPath string) (string, error) {
	base := filepath.Join(root, filepath.FromSlash(relPath))
	for _, ext := range Extensions {
		full := base + ext
		if st, err := os.Stat(full); err == nil && !st.IsDir() {
			return full, nil
		}
	}
	return "", fmt.Errorf("no %v found for %s (looked under %s)", Extensions, relPath, root)
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
func LoadImage(root, relPath string) (image.Image, string, error) {
	full, err := FindTexture(root, relPath)
	if err != nil {
		return nil, "", err
	}
	img, err := DecodeFile(full)
	if err != nil {
		return nil, "", err
	}
	return img, strings.ToLower(filepath.Ext(full)), nil
}
