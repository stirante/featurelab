package rptex

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"github.com/stirante/featurelab/jsonc"
)

// Variant is one entry of a terrain_texture.json texture key: a texture path
// (no extension) and, rarely, an overlay colour to multiply it by.
//
// A key with more than one Variant is the engine's legacy per-data-value
// texture list: terrain_texture.json's "stone" is [stone, granite,
// granite_smooth, diorite, ...] and the block's data value picks the index.
// 319 of the 1300 vanilla keys are arrays and 217 of those carry more than
// one distinct path, so a resolver that keeps only the first entry (which is
// all internal/gencolors needs for a single preview swatch) throws away
// exactly the data a block-state table needs.
type Variant struct {
	Path    string
	Overlay *RGB
}

// Terrain is a parsed terrain_texture.json: texture key -> its variants, in
// file order.
type Terrain struct {
	Keys map[string][]Variant
}

// TerrainRelPath is where a resource pack keeps terrain_texture.json,
// relative to its root.
const TerrainRelPath = "textures/terrain_texture.json"

// LoadTerrain parses a terrain_texture.json file. The file is JSON with
// comments in every vanilla release, so comments are stripped first.
func LoadTerrain(path string) (*Terrain, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		TextureData map[string]struct {
			Textures json.RawMessage `json:"textures"`
		} `json:"texture_data"`
	}
	if err := json.Unmarshal(jsonc.StripComments(raw), &doc); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	t := &Terrain{Keys: make(map[string][]Variant, len(doc.TextureData))}
	for key, entry := range doc.TextureData {
		vs, err := parseVariants(entry.Textures)
		if err != nil {
			return nil, fmt.Errorf("%s: texture key %q: %w", path, key, err)
		}
		t.Keys[key] = vs
	}
	return t, nil
}

// SortedKeys returns every texture key, sorted, so callers that build
// ordered output do not have to re-sort a map themselves.
func (t *Terrain) SortedKeys() []string {
	out := make([]string, 0, len(t.Keys))
	for k := range t.Keys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// parseVariants normalises a terrain_texture.json "textures" value. That
// value takes one of three shapes in the real file: a bare path string, a
// {"path":...,"overlay_color":...} object, or an array mixing either form.
func parseVariants(raw json.RawMessage) ([]Variant, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("missing \"textures\"")
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		if len(arr) == 0 {
			return nil, fmt.Errorf("empty textures array")
		}
		out := make([]Variant, 0, len(arr))
		for i, e := range arr {
			v, err := parseVariant(e)
			if err != nil {
				return nil, fmt.Errorf("array entry %d: %w", i, err)
			}
			out = append(out, v)
		}
		return out, nil
	}
	v, err := parseVariant(raw)
	if err != nil {
		return nil, err
	}
	return []Variant{v}, nil
}

func parseVariant(raw json.RawMessage) (Variant, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if s == "" {
			return Variant{}, fmt.Errorf("empty textures path string")
		}
		return Variant{Path: s}, nil
	}
	var obj struct {
		Path         string `json:"path"`
		OverlayColor string `json:"overlay_color"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil && obj.Path != "" {
		v := Variant{Path: obj.Path}
		if obj.OverlayColor != "" {
			c, err := ParseHex(obj.OverlayColor)
			if err != nil {
				return Variant{}, err
			}
			v.Overlay = &c
		}
		return v, nil
	}
	return Variant{}, fmt.Errorf("unrecognised textures shape: %s", raw)
}

// ParseVariants is parseVariants exported for callers that hold a raw
// terrain_texture.json "textures" value rather than a whole file.
func ParseVariants(raw json.RawMessage) ([]Variant, error) { return parseVariants(raw) }
