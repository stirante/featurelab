package rptex

// textureset.go reads <name>.texture_set.json -- the OTHER way a resource pack
// can declare a block texture.
//
// A terrain_texture.json path names a texture by stem, with no extension, and
// the usual thing behind that stem is an image file (see FindTexture). It may
// instead be a texture SET: a small JSON document that names the block's
// several material channels at once. Only one of them is a colour a preview
// can draw:
//
//	{
//	  "format_version": "1.16.100",
//	  "minecraft:texture_set": {
//	    "color": "limestone_base",
//	    "metalness_emissive_roughness": [0, 0, 255],
//	    "normal": "limestone_normal"
//	  }
//	}
//
// "color" is the albedo, and it takes three forms:
//
//   - a file NAME, extensionless, resolved exactly like any other texture path
//     -- overwhelmingly a SIBLING of the texture set itself ("limestone_base"
//     next to "limestone.texture_set.json"), occasionally written
//     pack-root-relative;
//   - an RGB/RGBA ARRAY of 0-255 channel values;
//   - a "#rrggbb" / "#rrggbbaa" STRING.
//
// The other channels describe how light behaves on the surface, which this
// preview does not model at all, so they are read past rather than
// interpreted. metalness_emissive_roughness / mer / normal / heightmap are
// named here only so it is clear they were considered and skipped, not missed.
//
// Why this file exists: a block whose texture is declared this way resolved to
// NO image, its face was dropped from the block table, and the viewer drew the
// block as a flat hash-derived colour -- the "my custom blocks render as
// simplified colours" report. The pack was correct; the resolver only knew one
// of the two spellings.

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/stirante/featurelab/jsonc"
)

// TextureSetSuffix is what a texture set file is called: the same stem the
// terrain_texture.json path names, plus this.
const TextureSetSuffix = ".texture_set.json"

// RGBA is an 8-bit-per-channel colour WITH alpha -- distinct from RGB, which
// deliberately carries none (see color.go). A texture set's colour is the only
// place in this package where alpha is part of the declaration rather than of
// the pixels, and dropping it would silently turn a pack's intentionally
// see-through flat colour into an opaque one.
type RGBA struct{ R, G, B, A uint8 }

// RGB drops the alpha, for the callers that measure and average in RGB.
func (c RGBA) RGB() RGB { return RGB{c.R, c.G, c.B} }

// Hex renders c as "#rrggbb", or "#rrggbbaa" when it is not fully opaque.
func (c RGBA) Hex() string {
	if c.A == 0xff {
		return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B)
	}
	return fmt.Sprintf("#%02x%02x%02x%02x", c.R, c.G, c.B, c.A)
}

// TextureSetDoc is the one thing a texture set says that this preview can use:
// where its colour channel comes from. Exactly one of the two fields is set.
type TextureSetDoc struct {
	// Path is a texture path to resolve, written exactly as the file wrote
	// it -- extensionless, and usually a bare sibling name rather than a
	// pack-root-relative path. Resolving it is ResolveTexture's job, because
	// "sibling first, then pack root" needs to know where the set file was.
	Path string
	// Color is a literal colour the file spelled out, nil when Path is set.
	Color *RGBA
}

// LoadTextureSet reads one <name>.texture_set.json.
//
// It returns an error, with the file named, for every way the document can
// fail to yield a colour: unreadable, not JSON, no "minecraft:texture_set"
// bag, no "color" in it, or a "color" in a form that is not one of the three
// (an object, a bare number, an array of the wrong length). Those messages are
// the point -- they travel to PackSummary.Unresolved, where the difference
// between "that file isn't there" and "that colour is written in a way this
// preview does not read" is the difference between two different fixes.
func LoadTextureSet(file string) (TextureSetDoc, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return TextureSetDoc{}, fmt.Errorf("read %s: %w", file, err)
	}
	// Pack JSON carries comments as a matter of course, exactly as
	// terrain_texture.json does, so they come off first.
	var doc struct {
		Set json.RawMessage `json:"minecraft:texture_set"`
	}
	if err := json.Unmarshal(jsonc.StripComments(raw), &doc); err != nil {
		return TextureSetDoc{}, fmt.Errorf("parse %s: %w", file, err)
	}
	if len(doc.Set) == 0 {
		return TextureSetDoc{}, fmt.Errorf("%s declares no \"minecraft:texture_set\"", file)
	}
	var body struct {
		Color json.RawMessage `json:"color"`
	}
	if err := json.Unmarshal(doc.Set, &body); err != nil {
		return TextureSetDoc{}, fmt.Errorf("parse %s minecraft:texture_set: %w", file, err)
	}
	if len(body.Color) == 0 {
		return TextureSetDoc{}, fmt.Errorf("%s declares no \"color\" channel -- only a texture set's color is a texture this preview can draw", file)
	}
	set, err := parseTextureSetColor(body.Color)
	if err != nil {
		return TextureSetDoc{}, fmt.Errorf("%s: %w", file, err)
	}
	return set, nil
}

// parseTextureSetColor reads the "color" value's three legal forms.
func parseTextureSetColor(raw json.RawMessage) (TextureSetDoc, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		s = strings.TrimSpace(s)
		if s == "" {
			return TextureSetDoc{}, fmt.Errorf("minecraft:texture_set color is an empty string")
		}
		if strings.HasPrefix(s, "#") {
			c, err := parseHexRGBA(s)
			if err != nil {
				return TextureSetDoc{}, err
			}
			return TextureSetDoc{Color: &c}, nil
		}
		return TextureSetDoc{Path: s}, nil
	}

	var arr []json.Number
	if err := json.Unmarshal(raw, &arr); err == nil {
		c, err := parseArrayRGBA(arr)
		if err != nil {
			return TextureSetDoc{}, err
		}
		return TextureSetDoc{Color: &c}, nil
	}

	return TextureSetDoc{}, fmt.Errorf(
		"minecraft:texture_set color %s is neither a texture name, a \"#rrggbb\"/\"#rrggbbaa\" string, nor an RGB/RGBA array", string(raw))
}

// parseHexRGBA reads "#rrggbb" or "#rrggbbaa". The alpha-less form is opaque,
// which is what the engine does with it.
func parseHexRGBA(s string) (RGBA, error) {
	hex := strings.TrimPrefix(s, "#")
	if len(hex) != 6 && len(hex) != 8 {
		return RGBA{}, fmt.Errorf("minecraft:texture_set color %q is not a 6- or 8-digit hex colour", s)
	}
	v, err := strconv.ParseUint(hex, 16, 64)
	if err != nil {
		return RGBA{}, fmt.Errorf("minecraft:texture_set color %q is not a hex colour: %w", s, err)
	}
	if len(hex) == 6 {
		return RGBA{uint8(v >> 16), uint8(v >> 8), uint8(v), 0xff}, nil
	}
	return RGBA{uint8(v >> 24), uint8(v >> 16), uint8(v >> 8), uint8(v)}, nil
}

// parseArrayRGBA reads the [r, g, b] / [r, g, b, a] form.
//
// The channels are 0-255, which is how the format writes them and how the
// engine reads them. A value outside that range is CLAMPED rather than
// rejected: a pack that wrote 300 meant "as bright as it goes", and refusing
// the whole texture over it would put the block back to a hash colour, which
// is strictly less like what the author asked for. A fractional value is
// rounded for the same reason.
func parseArrayRGBA(arr []json.Number) (RGBA, error) {
	if len(arr) != 3 && len(arr) != 4 {
		return RGBA{}, fmt.Errorf("minecraft:texture_set color array has %d entries; an RGB colour has 3 and an RGBA colour has 4", len(arr))
	}
	out := RGBA{A: 0xff}
	channels := [4]*uint8{&out.R, &out.G, &out.B, &out.A}
	for i, n := range arr {
		f, err := n.Float64()
		if err != nil {
			return RGBA{}, fmt.Errorf("minecraft:texture_set color array entry %d (%q) is not a number", i, n.String())
		}
		*channels[i] = clamp255(f)
	}
	return out, nil
}

func clamp255(f float64) uint8 {
	switch {
	case f <= 0:
		return 0
	case f >= 255:
		return 0xff
	default:
		return uint8(f + 0.5)
	}
}
