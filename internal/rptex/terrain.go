package rptex

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

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

	// Skipped is every texture key the file DECLARED but this reader could not
	// turn into a texture path, mapped to the reason -- "unrecognised textures
	// shape", "empty textures array", and so on.
	//
	// It exists because one entry a reader does not understand used to fail the
	// WHOLE file: a pack that wrote a single shape this port had not
	// implemented lost every texture it shipped, and the author saw a preview
	// with no pack textures at all and no sentence anywhere naming the entry
	// that did it. That is the worst possible trade for the one block actually
	// affected. A key in here is absent from Keys, and every consumer already
	// knows what to do with a key it cannot find; what none of them had was the
	// REASON, which is what this map carries to PackSummary.Unresolved.
	Skipped map[string]string
}

// TerrainRelPath is where a resource pack keeps terrain_texture.json,
// relative to its root.
const TerrainRelPath = "textures/terrain_texture.json"

// LoadTerrain parses a terrain_texture.json file. The file is JSON with
// comments in every vanilla release, so comments are stripped first.
//
// An error means the FILE is unusable: unreadable, or not JSON once the
// comments are off. A single texture_data entry this reader cannot make sense
// of is not that -- it lands in Terrain.Skipped with its reason and the rest of
// the file loads normally. One entry must never cost a pack its other twelve
// hundred, and the entry that was dropped is named rather than swallowed.
func LoadTerrain(path string) (*Terrain, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	// Each texture_data entry is held raw and decoded on its own, so that an
	// entry which is not even an OBJECT ("stone": "textures/blocks/stone", a
	// shape this reader does not take) fails by itself rather than failing the
	// map -- and with it the file -- as a single whole-document Unmarshal into
	// a typed map would.
	var doc struct {
		TextureData map[string]json.RawMessage `json:"texture_data"`
	}
	if err := json.Unmarshal(jsonc.StripComments(raw), &doc); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	t := &Terrain{Keys: make(map[string][]Variant, len(doc.TextureData)), Skipped: map[string]string{}}
	for key, rawEntry := range doc.TextureData {
		var entry struct {
			Textures json.RawMessage `json:"textures"`
		}
		if err := json.Unmarshal(rawEntry, &entry); err != nil {
			t.Skipped[key] = fmt.Sprintf("texture_data entry is not an object with a \"textures\" value: %v", err)
			continue
		}
		vs, err := parseVariants(entry.Textures)
		if err != nil {
			t.Skipped[key] = err.Error()
			continue
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

// parseVariants normalises a terrain_texture.json "textures" value. Real packs
// write it in five shapes, and all five are taken here:
//
//	"textures": "textures/blocks/stone"
//	"textures": ["textures/blocks/stone", "textures/blocks/granite"]
//	"textures": {"path": "textures/blocks/grass_side", "overlay_color": "#79c05a"}
//	"textures": [{"path": "..."}, {"path": "...", "overlay_color": "#..."}]
//	"textures": [{"variations": [{"path": "...", "weight": 1}, ...]}]
//
// plus the wrapper-less {"variations": [...]} -- see parseVariations. The
// object forms and the string form mix freely inside an array.
//
// An array entry this reader cannot make sense of is DROPPED and the others
// kept; only an array with nothing usable left in it is an error. The cost is
// that a legacy per-data-value list with a bad entry in the middle has its
// later entries shift down an index; the alternative is losing every texture
// the key had, which is much worse and is the bug this resilience is for.
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
		reasons := make([]string, 0, len(arr))
		for i, e := range arr {
			v, err := parseVariant(e, 0)
			if err != nil {
				reasons = append(reasons, fmt.Sprintf("array entry %d: %v", i, err))
				continue
			}
			out = append(out, v)
		}
		if len(out) == 0 {
			return nil, errors.New(strings.Join(reasons, "; "))
		}
		return out, nil
	}
	v, err := parseVariant(raw, 0)
	if err != nil {
		return nil, err
	}
	return []Variant{v}, nil
}

// maxVariationDepth bounds how deep nested "variations" may go. One level is
// the shape the format describes and the only one packs write; a variations
// entry that is itself a variations list is a hand-written oddity, and the
// bound is what keeps it a reported skip rather than unbounded recursion.
const maxVariationDepth = 4

func parseVariant(raw json.RawMessage, depth int) (Variant, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if s == "" {
			return Variant{}, fmt.Errorf("empty textures path string")
		}
		return Variant{Path: s}, nil
	}
	var obj struct {
		Path         string            `json:"path"`
		OverlayColor string            `json:"overlay_color"`
		Variations   []json.RawMessage `json:"variations"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		if obj.Path == "" && obj.Variations != nil {
			return parseVariations(obj.Variations, obj.OverlayColor, depth)
		}
		if obj.Path != "" {
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
	}
	return Variant{}, fmt.Errorf("unrecognised textures shape: %s", raw)
}

// parseVariations reads the "variations" list -- several textures the engine
// picks BETWEEN for one texture key, so that a field of the same block is not
// a field of the same picture:
//
//	{"variations": [
//	    {"path": "textures/blocks/my_block_0", "weight": 1},
//	    {"path": "textures/blocks/my_block_1", "weight": 1}]}
//
// The game chooses one per placed block, at random, weighted by "weight". This
// preview takes the FIRST entry and ignores every weight. That is deliberate:
// a preview whose blocks came up a different texture on each reload would be
// showing its own dice rolls rather than the pack, and nothing downstream --
// the atlas, the block table, the staleness hash -- has anywhere to put a
// per-placement choice. The entries not taken are not represented at all.
//
// The list is also accepted WITHOUT the usual array wrapper, i.e. "textures"
// being the {"variations": [...]} object itself rather than a one-element
// array holding it. Whether the engine takes that spelling is not settled
// here; accepting it costs nothing, because the only packs it can affect are
// ones that would otherwise have lost the key entirely.
func parseVariations(entries []json.RawMessage, overlay string, depth int) (Variant, error) {
	if depth >= maxVariationDepth {
		return Variant{}, fmt.Errorf("\"variations\" nested more than %d deep", maxVariationDepth)
	}
	if len(entries) == 0 {
		return Variant{}, fmt.Errorf("empty \"variations\" list")
	}
	// Strictly the first, never "the first one that happens to parse". Falling
	// through to a later entry would make which texture the preview draws
	// depend on a typo somewhere above it, and would hide the typo as well.
	v, err := parseVariant(entries[0], depth+1)
	if err != nil {
		return Variant{}, fmt.Errorf("first \"variations\" entry: %w", err)
	}
	// An overlay_color written beside the variations list applies to whichever
	// variation was picked, unless the variation set its own.
	if v.Overlay == nil && overlay != "" {
		c, err := ParseHex(overlay)
		if err != nil {
			return Variant{}, err
		}
		v.Overlay = &c
	}
	return v, nil
}

// ParseVariants is parseVariants exported for callers that hold a raw
// terrain_texture.json "textures" value rather than a whole file.
func ParseVariants(raw json.RawMessage) ([]Variant, error) { return parseVariants(raw) }
