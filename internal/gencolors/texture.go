package gencolors

import (
	"encoding/json"
	"fmt"
	"image"
	"sort"

	"github.com/stirante/featurelab/internal/rptex"
)

// rgb is internal/rptex.RGB under this package's original name and with
// this package's original unkeyed-literal ergonomics. The colour primitives
// themselves (achromatic detection, the overlay multiply, the alpha-aware
// average) moved to rptex when internal/atlas needed the same answers about
// the same textures; what is left here is the thin adapter that keeps one
// implementation serving both.
type rgb rptex.RGB

func (c rgb) Hex() string      { return rptex.RGB(c).Hex() }
func (c rgb) Achromatic() bool { return rptex.RGB(c).Achromatic() }
func parseHexColor(s string) (rgb, error) {
	v, err := rptex.ParseHex(s)
	return rgb(v), err
}

// applyOverlay reproduces the engine's own tint blend: a per-channel
// multiply of the (greyscale, in practice) base texture by the overlay
// colour.
func applyOverlay(base, overlay rgb) rgb {
	return rgb(rptex.Multiply(rptex.RGB(base), rptex.RGB(overlay)))
}

// averagePixels returns the mean colour of img, skipping fully transparent
// pixels; see rptex.Average for why partial alpha is not weighted.
func averagePixels(img image.Image) (rgb, int) {
	v, n := rptex.Average(img)
	return rgb(v), n
}

// resolvePathAndOverlay extracts a single (path, overlay) pair from a
// terrain_texture.json "textures" value, whose three real shapes (bare path
// string, {"path":...,"overlay_color":...} object, array mixing either form)
// rptex.ParseVariants normalises.
//
// Multi-element arrays always resolve to their FIRST entry. This is a
// deliberate simplification for a single preview swatch, not an oversight:
// nothing in blocks.json or terrain_texture.json marks any array index as
// "the default biome", so there is no principled way to pick a
// representative entry from the data itself. First-entry selection is at
// least deterministic and documented (see generatorNotes). The array's other
// entries are the engine's legacy per-data-value texture list, and
// internal/atlas keeps every one of them for the block-state table; a flat
// colour table has nowhere to put them.
func resolvePathAndOverlay(raw json.RawMessage) (path string, overlay *rgb, multi bool, err error) {
	vs, err := rptex.ParseVariants(raw)
	if err != nil {
		return "", nil, false, err
	}
	var arr []json.RawMessage
	isArray := json.Unmarshal(raw, &arr) == nil
	return vs[0].Path, (*rgb)(vs[0].Overlay), isArray, nil
}

// loadAndAverage resolves relPath (a terrain_texture.json path such as
// "textures/blocks/grass_side", without extension) against root, trying
// ".png" then ".tga" -- the only two container formats present among
// bedrock-samples' block textures -- and returns the alpha-aware average of
// whichever is found first.
func loadAndAverage(root, relPath string) (rgb, error) {
	img, _, err := rptex.LoadImage(root, relPath)
	if err != nil {
		return rgb{}, err
	}
	avg, n := averagePixels(img)
	if n == 0 {
		return rgb{}, fmt.Errorf("%s: every pixel is fully transparent, no colour to average", relPath)
	}
	return avg, nil
}

const (
	noteCarriedFallback = "carried-texture fallback: primary texture is greyscale and awaiting a runtime " +
		"biome tint this generator cannot reproduce; used the block's pre-tinted carried_textures " +
		"(held-item) texture instead, which is a real derived colour, not an invented constant"
	noteGreyscaleNoFallback = "greyscale texture with no overlay_color and no usable carried_textures " +
		"fallback; colour is a literal, untinted pixel average and may not match the tinted in-game appearance"
)

// textureResolver resolves terrain_texture.json texture keys to averaged,
// overlay-applied colours, memoising each key (a handful of keys, e.g.
// "dirt", are referenced by dozens of blocks both directly and as
// carried_textures fallbacks) and recording every failure it sees so the
// caller can surface misses explicitly instead of dropping them.
type textureResolver struct {
	root    string
	terrain map[string]json.RawMessage // texture key -> its "textures" value

	cache  map[string]resolveResult
	misses map[string]textureMiss // texture key -> miss, deduplicated
}

type resolveResult struct {
	color      rgb
	hasOverlay bool
	err        error
}

type textureMiss struct {
	Key    string
	Path   string
	Reason string
}

func newTextureResolver(root string, terrain map[string]json.RawMessage) *textureResolver {
	return &textureResolver{
		root:    root,
		terrain: terrain,
		cache:   make(map[string]resolveResult),
		misses:  make(map[string]textureMiss),
	}
}

// resolveKey resolves a single terrain_texture.json key to a colour,
// applying its overlay_color (if any) via a per-channel multiply.
func (tr *textureResolver) resolveKey(key string) (rgb, bool, error) {
	if r, ok := tr.cache[key]; ok {
		return r.color, r.hasOverlay, r.err
	}
	raw, ok := tr.terrain[key]
	if !ok {
		err := fmt.Errorf("texture key %q not present in terrain_texture.json", key)
		tr.cache[key] = resolveResult{err: err}
		tr.misses[key] = textureMiss{Key: key, Reason: err.Error()}
		return rgb{}, false, err
	}
	path, overlay, _, err := resolvePathAndOverlay(raw)
	if err != nil {
		err = fmt.Errorf("texture key %q: %w", key, err)
		tr.cache[key] = resolveResult{err: err}
		tr.misses[key] = textureMiss{Key: key, Reason: err.Error()}
		return rgb{}, false, err
	}
	avg, err := loadAndAverage(tr.root, path)
	if err != nil {
		tr.cache[key] = resolveResult{err: err}
		tr.misses[key] = textureMiss{Key: key, Path: path, Reason: err.Error()}
		return rgb{}, false, err
	}
	hasOverlay := overlay != nil
	if hasOverlay {
		avg = applyOverlay(avg, *overlay)
	}
	tr.cache[key] = resolveResult{color: avg, hasOverlay: hasOverlay}
	return avg, hasOverlay, nil
}

// resolveFace resolves one rendered face's colour: primaryKey is the
// block's own texture key for that face; carriedKey, if non-empty, is the
// matching carried_textures key to fall back to when the primary texture
// is greyscale and carries no overlay of its own (see noteCarriedFallback).
// It returns the resolved colour, an optional human-readable provenance
// note, and an error only when no colour could be produced at all.
//
// The carried-texture fallback is itself gated on the carried texture
// actually being non-achromatic. Without that check, blocks like
// dispenser/dropper -- which declare carried_textures for an unrelated
// reason (their held-item render), not biome tinting -- would swap one
// coincidentally-grey average (the block face, mostly stone with a small
// dark dispenser-hole graphic) for another coincidentally-grey average
// (the carried icon), producing a misleading "carried-texture fallback"
// note for a colour that was never awaiting a tint in the first place.
func (tr *textureResolver) resolveFace(primaryKey, carriedKey string) (rgb, string, error) {
	avg, hasOverlay, err := tr.resolveKey(primaryKey)
	if err == nil && (hasOverlay || !avg.Achromatic()) {
		return avg, "", nil
	}
	if carriedKey != "" {
		if avg2, _, err2 := tr.resolveKey(carriedKey); err2 == nil && !avg2.Achromatic() {
			return avg2, noteCarriedFallback, nil
		}
	}
	if err == nil {
		return avg, noteGreyscaleNoFallback, nil
	}
	return rgb{}, "", err
}

// sortedMisses returns every texture-level miss this resolver has recorded,
// sorted by key for deterministic output.
func (tr *textureResolver) sortedMisses() []textureMiss {
	out := make([]textureMiss, 0, len(tr.misses))
	for _, m := range tr.misses {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}
