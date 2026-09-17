package gencolors

import (
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestAchromatic(t *testing.T) {
	cases := []struct {
		c    rgb
		want bool
	}{
		{rgb{125, 125, 125}, true}, // stone: exactly equal
		{rgb{147, 146, 148}, true}, // rounding noise within threshold (spread 2)
		{rgb{134, 96, 67}, false},  // dirt: clearly coloured
		{rgb{78, 118, 42}, false},  // grass_carried: clearly coloured
		{rgb{100, 100, 97}, false}, // spread of 3 exceeds the threshold of 2
	}
	for _, c := range cases {
		if got := c.c.Achromatic(); got != c.want {
			t.Errorf("rgb%+v.Achromatic() = %v, want %v", c.c, got, c.want)
		}
	}
}

func TestParseHexColor(t *testing.T) {
	c, err := parseHexColor("#79c05a")
	if err != nil {
		t.Fatalf("parseHexColor: %v", err)
	}
	want := rgb{0x79, 0xc0, 0x5a}
	if c != want {
		t.Fatalf("parseHexColor(#79c05a) = %+v, want %+v", c, want)
	}
	if _, err := parseHexColor("not-a-colour"); err == nil {
		t.Fatal("parseHexColor: expected error for invalid input, got nil")
	}
}

func TestApplyOverlay(t *testing.T) {
	// A pure-grey base multiplied by the plains grass_side overlay should
	// scale each channel proportionally, matching a manual multiply.
	base := rgb{154, 154, 154}
	overlay := rgb{0x79, 0xc0, 0x5a} // 121, 192, 90
	got := applyOverlay(base, overlay)
	want := rgb{
		uint8(154 * 121 / 255),
		uint8(154 * 192 / 255),
		uint8(154 * 90 / 255),
	}
	if got != want {
		t.Fatalf("applyOverlay(%+v, %+v) = %+v, want %+v", base, overlay, got, want)
	}
	// Overlaying white must be a no-op; overlaying black must zero it out.
	if got := applyOverlay(base, rgb{255, 255, 255}); got != base {
		t.Fatalf("applyOverlay with white overlay = %+v, want unchanged %+v", got, base)
	}
	if got := applyOverlay(base, rgb{0, 0, 0}); got != (rgb{0, 0, 0}) {
		t.Fatalf("applyOverlay with black overlay = %+v, want {0,0,0}", got)
	}
}

func TestResolvePathAndOverlay(t *testing.T) {
	t.Run("bare string", func(t *testing.T) {
		path, overlay, multi, err := resolvePathAndOverlay(json.RawMessage(`"textures/blocks/stone"`))
		if err != nil {
			t.Fatal(err)
		}
		if path != "textures/blocks/stone" || overlay != nil || multi {
			t.Fatalf("got path=%q overlay=%v multi=%v", path, overlay, multi)
		}
	})
	t.Run("object with overlay", func(t *testing.T) {
		path, overlay, multi, err := resolvePathAndOverlay(json.RawMessage(`{"path":"textures/blocks/grass_side","overlay_color":"#79c05a"}`))
		if err != nil {
			t.Fatal(err)
		}
		if path != "textures/blocks/grass_side" || multi {
			t.Fatalf("got path=%q multi=%v", path, multi)
		}
		if overlay == nil || *overlay != (rgb{0x79, 0xc0, 0x5a}) {
			t.Fatalf("overlay = %v, want #79c05a", overlay)
		}
	})
	t.Run("array resolves to FIRST entry, not last", func(t *testing.T) {
		raw := json.RawMessage(`[
			{"path":"textures/blocks/first","overlay_color":"#111111"},
			{"path":"textures/blocks/second","overlay_color":"#222222"},
			"textures/blocks/third"
		]`)
		path, overlay, multi, err := resolvePathAndOverlay(raw)
		if err != nil {
			t.Fatal(err)
		}
		if !multi {
			t.Fatal("multi = false, want true for an array input")
		}
		if path != "textures/blocks/first" {
			t.Fatalf("path = %q, want the array's first entry (textures/blocks/first)", path)
		}
		if overlay == nil || *overlay != (rgb{0x11, 0x11, 0x11}) {
			t.Fatalf("overlay = %v, want the first entry's #111111", overlay)
		}
	})
	t.Run("empty array is an error", func(t *testing.T) {
		if _, _, _, err := resolvePathAndOverlay(json.RawMessage(`[]`)); err == nil {
			t.Fatal("expected error for empty array")
		}
	})
}

// writePNG writes a width x height PNG at path where pixel(x,y) is given by
// px(x,y).
func writePNG(t *testing.T, path string, width, height int, px func(x, y int) color.NRGBA) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, px(x, y))
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func solid(c color.NRGBA) func(x, y int) color.NRGBA {
	return func(x, y int) color.NRGBA { return c }
}

func TestAveragePixels_SkipsFullyTransparent(t *testing.T) {
	// 2x2: three grey opaque pixels and one wildly different, fully
	// transparent pixel. If the transparent pixel were folded into the
	// average, the result would not be pure grey.
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.SetNRGBA(0, 0, color.NRGBA{100, 100, 100, 255})
	img.SetNRGBA(1, 0, color.NRGBA{100, 100, 100, 255})
	img.SetNRGBA(0, 1, color.NRGBA{100, 100, 100, 255})
	img.SetNRGBA(1, 1, color.NRGBA{255, 0, 0, 0}) // fully transparent, must be skipped
	avg, n := averagePixels(img)
	if n != 3 {
		t.Fatalf("n = %d, want 3 (the transparent pixel must not be counted)", n)
	}
	if avg != (rgb{100, 100, 100}) {
		t.Fatalf("avg = %+v, want {100,100,100} -- the transparent red pixel leaked into the average", avg)
	}
}

func TestAveragePixels_AllTransparentYieldsZeroCount(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	_, n := averagePixels(img)
	if n != 0 {
		t.Fatalf("n = %d, want 0 for an entirely transparent image", n)
	}
}

// newFixtureResolver builds a textureResolver rooted at a temp directory
// containing hand-built textures, wired to an in-memory terrain_texture.json
// equivalent. This exercises the same resolveKey/resolveFace code path the
// real generator uses, without any dependency on a real bedrock-samples
// checkout.
func newFixtureResolver(t *testing.T) *textureResolver {
	t.Helper()
	root := t.TempDir()

	writePNG(t, filepath.Join(root, "textures/blocks/stone.png"), 4, 4, solid(color.NRGBA{125, 125, 125, 255}))
	writePNG(t, filepath.Join(root, "textures/blocks/dirt.png"), 4, 4, solid(color.NRGBA{134, 96, 67, 255}))
	writePNG(t, filepath.Join(root, "textures/blocks/grass_top.png"), 4, 4, solid(color.NRGBA{147, 147, 147, 255}))
	writePNG(t, filepath.Join(root, "textures/blocks/grass_side.png"), 4, 4, solid(color.NRGBA{154, 154, 154, 255}))
	writePNG(t, filepath.Join(root, "textures/blocks/grass_carried.png"), 4, 4, solid(color.NRGBA{78, 118, 42, 255}))
	// dispenser-like: a texture that averages to grey by coincidence, plus
	// a carried texture that is ALSO grey -- the fallback must not fire.
	writePNG(t, filepath.Join(root, "textures/blocks/dispenser_front.png"), 4, 4, solid(color.NRGBA{120, 120, 120, 255}))
	writePNG(t, filepath.Join(root, "textures/blocks/dispenser_carried.png"), 4, 4, solid(color.NRGBA{118, 118, 118, 255}))

	terrain := map[string]json.RawMessage{
		"stone":             json.RawMessage(`"textures/blocks/stone"`),
		"dirt":              json.RawMessage(`"textures/blocks/dirt"`),
		"grass_top":         json.RawMessage(`"textures/blocks/grass_top"`),
		"grass_side":        json.RawMessage(`{"path":"textures/blocks/grass_side","overlay_color":"#79c05a"}`),
		"grass_carried_top": json.RawMessage(`"textures/blocks/grass_carried"`),
		"dispenser_front":   json.RawMessage(`"textures/blocks/dispenser_front"`),
		"dispenser_carried": json.RawMessage(`"textures/blocks/dispenser_carried"`),
		"missing_on_disk":   json.RawMessage(`"textures/blocks/does_not_exist"`),
		// "missing_from_index" is deliberately NOT a key in this map, to
		// simulate a texture key a block references that terrain_texture.json
		// itself has no entry for.
	}

	return newTextureResolver(root, terrain)
}

func TestResolveFace_OwnOverlayShortCircuitsFallback(t *testing.T) {
	tr := newFixtureResolver(t)
	// grass_side is achromatic on its own but carries its own overlay_color,
	// so it must resolve directly and never consult a carried key.
	got, note, err := tr.resolveFace("grass_side", "nonexistent_carried_key_that_would_error_if_consulted")
	if err != nil {
		t.Fatalf("resolveFace: %v", err)
	}
	if note != "" {
		t.Fatalf("note = %q, want empty (own overlay should short-circuit before any fallback note)", note)
	}
	// Hand-computed (not via applyOverlay, so this is an independent oracle
	// for the multiply): 154*0x79/255=73, 154*0xc0/255=115, 154*0x5a/255=54.
	want := rgb{73, 115, 54}
	if got != want {
		t.Fatalf("got %+v, want overlay-applied %+v", got, want)
	}
}

func TestResolveFace_CarriedFallbackForGreyscaleNoOverlay(t *testing.T) {
	tr := newFixtureResolver(t)
	got, note, err := tr.resolveFace("grass_top", "grass_carried_top")
	if err != nil {
		t.Fatalf("resolveFace: %v", err)
	}
	if note != noteCarriedFallback {
		t.Fatalf("note = %q, want the carried-fallback note", note)
	}
	if got != (rgb{78, 118, 42}) {
		t.Fatalf("got %+v, want the carried texture's colour {78,118,42}", got)
	}
}

func TestResolveFace_SkipsFallbackWhenCarriedAlsoAchromatic(t *testing.T) {
	tr := newFixtureResolver(t)
	// Both dispenser_front and dispenser_carried are (independently)
	// grey: the fallback exists structurally but must not fire, since
	// swapping one grey for another grey is not a meaningful colour and
	// would produce a misleading "carried-texture fallback" note.
	got, note, err := tr.resolveFace("dispenser_front", "dispenser_carried")
	if err != nil {
		t.Fatalf("resolveFace: %v", err)
	}
	if note != noteGreyscaleNoFallback {
		t.Fatalf("note = %q, want the plain greyscale note (fallback must not fire when carried is also achromatic)", note)
	}
	if got != (rgb{120, 120, 120}) {
		t.Fatalf("got %+v, want the primary's own average {120,120,120} (unchanged by the no-op fallback)", got)
	}
}

func TestResolveFace_LiteralGreyWhenNoCarriedKey(t *testing.T) {
	tr := newFixtureResolver(t)
	got, note, err := tr.resolveFace("stone", "")
	if err != nil {
		t.Fatalf("resolveFace: %v", err)
	}
	if note != noteGreyscaleNoFallback {
		t.Fatalf("note = %q, want the plain greyscale note", note)
	}
	if got != (rgb{125, 125, 125}) {
		t.Fatalf("got %+v, want stone's own grey average", got)
	}
}

func TestResolveFace_NonAchromaticNeedsNoFallback(t *testing.T) {
	tr := newFixtureResolver(t)
	got, note, err := tr.resolveFace("dirt", "")
	if err != nil {
		t.Fatalf("resolveFace: %v", err)
	}
	if note != "" {
		t.Fatalf("note = %q, want empty for a plainly-coloured texture", note)
	}
	if got != (rgb{134, 96, 67}) {
		t.Fatalf("got %+v, want dirt's own colour", got)
	}
}

func TestResolveFace_MissingTextureIsRecordedAndReturnsError(t *testing.T) {
	tr := newFixtureResolver(t)
	if _, _, err := tr.resolveFace("missing_on_disk", ""); err == nil {
		t.Fatal("resolveFace: expected an error for a texture key whose file is not on disk")
	}
	if _, _, err := tr.resolveFace("missing_from_index", ""); err == nil {
		t.Fatal("resolveFace: expected an error for a texture key absent from the terrain index")
	}
	misses := tr.sortedMisses()
	if len(misses) != 2 {
		t.Fatalf("sortedMisses() has %d entries, want 2 (both failures must be recorded): %+v", len(misses), misses)
	}
	if misses[0].Key != "missing_from_index" || misses[1].Key != "missing_on_disk" {
		t.Fatalf("sortedMisses() = %+v, want sorted by key", misses)
	}
}
