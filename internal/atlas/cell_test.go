package atlas

import (
	"image"
	"image/color"
	"testing"
)

// solid builds a w x h NRGBA filled by paint(x, y).
func solid(w, h int, paint func(x, y int) color.NRGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, paint(x, y))
		}
	}
	return img
}

func TestNormalise_ExactCellIsUnchanged(t *testing.T) {
	src := solid(16, 16, func(x, y int) color.NRGBA { return color.NRGBA{uint8(x * 16), uint8(y * 16), 0, 255} })
	out, frames, scaled, err := normalise(src, 16)
	if err != nil {
		t.Fatalf("normalise: %v", err)
	}
	if frames != 1 || scaled != 0 {
		t.Fatalf("frames=%d scaled=%d, want 1 and 0", frames, scaled)
	}
	if got := out.NRGBAAt(3, 5); got != (color.NRGBA{48, 80, 0, 255}) {
		t.Fatalf("pixel(3,5) = %v, want the source pixel unchanged", got)
	}
}

// TestNormalise_FlipbookTakesFirstFrame pins the choice made for the 72
// animated strips terrain_texture.json reaches: the atlas gets frame 0 and
// the frame count, not a stretched whole strip.
func TestNormalise_FlipbookTakesFirstFrame(t *testing.T) {
	// 16x64: four frames, each a flat shade of red numbered by frame.
	src := solid(16, 64, func(_, y int) color.NRGBA { return color.NRGBA{uint8(y / 16), 0, 0, 255} })
	out, frames, scaled, err := normalise(src, 16)
	if err != nil {
		t.Fatalf("normalise: %v", err)
	}
	if frames != 4 {
		t.Fatalf("frames = %d, want 4", frames)
	}
	if scaled != 0 {
		t.Fatalf("scaled = %d, want 0 (a 16-wide flipbook needs no rescale)", scaled)
	}
	if got := out.NRGBAAt(8, 8).R; got != 0 {
		t.Fatalf("frame pixel R = %d, want 0: the atlas must hold frame 0, not a later one", got)
	}
	if out.Bounds().Dy() != 16 {
		t.Fatalf("height = %d, want 16", out.Bounds().Dy())
	}
}

// TestNormalise_DownscaleAveragesAndKeepsCutoutEdgesClean covers the 33
// oversized textures in the vanilla set, and the premultiplied averaging that
// keeps a transparent black pixel from darkening its opaque neighbours.
func TestNormalise_DownscaleAveragesAndKeepsCutoutEdgesClean(t *testing.T) {
	// 32x32 where every 2x2 block is three opaque white pixels and one
	// fully-transparent BLACK one. Averaged straight, each output pixel
	// would come out at 3/4 brightness; averaged premultiplied it stays
	// white with 3/4 alpha.
	src := solid(32, 32, func(x, y int) color.NRGBA {
		if x%2 == 0 && y%2 == 0 {
			return color.NRGBA{0, 0, 0, 0}
		}
		return color.NRGBA{255, 255, 255, 255}
	})
	out, _, scaled, err := normalise(src, 16)
	if err != nil {
		t.Fatalf("normalise: %v", err)
	}
	if scaled != 32 {
		t.Fatalf("scaled = %d, want 32", scaled)
	}
	if out.Bounds().Dx() != 16 {
		t.Fatalf("width = %d, want 16", out.Bounds().Dx())
	}
	got := out.NRGBAAt(4, 4)
	if got.R != 255 || got.G != 255 || got.B != 255 {
		t.Errorf("downscaled pixel = %v: transparent black bled into the colour, which is the dark fringe premultiplied averaging exists to prevent", got)
	}
	if got.A != 191 {
		t.Errorf("downscaled alpha = %d, want 191 (three of four source pixels opaque)", got.A)
	}
}

func TestNormalise_RejectsUnfittableShapes(t *testing.T) {
	for _, tc := range []struct{ w, h int }{{16, 17}, {24, 12}, {17, 17}} {
		if _, _, _, err := normalise(solid(tc.w, tc.h, func(int, int) color.NRGBA { return color.NRGBA{A: 255} }), 16); err == nil {
			t.Errorf("normalise(%dx%d): expected a rejection, got none -- silently rescaling is how a plausible wrong cell gets into the sheet", tc.w, tc.h)
		}
	}
}

// TestNormalise_UpscalesSubCellTextures covers a pack's own art at a lower
// resolution than the cell. Vanilla has none, so this used to be rejected with
// the same sentence a 16x17 gets -- which dropped the block to a flat colour
// while every vanilla block beside it kept its picture.
func TestNormalise_UpscalesSubCellTextures(t *testing.T) {
	// 8x8 with a distinct colour per texel, so a misindexed upscale shows up
	// as a wrong colour rather than as a plausible blur.
	src := solid(8, 8, func(x, y int) color.NRGBA { return color.NRGBA{uint8(x * 8), uint8(y * 8), 9, 255} })
	out, frames, scaled, err := normalise(src, 16)
	if err != nil {
		t.Fatalf("normalise: %v", err)
	}
	if frames != 1 {
		t.Fatalf("frames = %d, want 1", frames)
	}
	if scaled != 8 {
		t.Fatalf("scaled = %d, want 8 (the source edge)", scaled)
	}
	if out.Bounds().Dx() != 16 || out.Bounds().Dy() != 16 {
		t.Fatalf("size = %v, want 16x16", out.Bounds().Size())
	}
	// Each source texel covers a 2x2 block, so both members of a block must be
	// the source texel exactly -- nearest-neighbour, not an interpolation.
	for _, p := range []struct{ x, y, sx, sy int }{{0, 0, 0, 0}, {1, 1, 0, 0}, {6, 3, 3, 1}, {15, 15, 7, 7}} {
		want := src.NRGBAAt(p.sx, p.sy)
		if got := out.NRGBAAt(p.x, p.y); got != want {
			t.Errorf("out(%d,%d) = %v, want source texel (%d,%d) = %v", p.x, p.y, got, p.sx, p.sy, want)
		}
	}
	// A 1x1 texture is the degenerate end of the same case and is a perfectly
	// ordinary way to declare a solid-colour block.
	one, _, oneScaled, err := normalise(solid(1, 1, func(int, int) color.NRGBA { return color.NRGBA{4, 5, 6, 255} }), 16)
	if err != nil {
		t.Fatalf("normalise(1x1): %v", err)
	}
	if oneScaled != 1 {
		t.Fatalf("scaled = %d, want 1", oneScaled)
	}
	if got, want := one.NRGBAAt(9, 2), (color.NRGBA{4, 5, 6, 255}); got != want {
		t.Fatalf("1x1 upscale pixel = %v, want %v", got, want)
	}
}

func TestClassifyRender(t *testing.T) {
	opaque := solid(4, 4, func(int, int) color.NRGBA { return color.NRGBA{1, 2, 3, 255} })
	cutout := solid(4, 4, func(x, _ int) color.NRGBA {
		if x == 0 {
			return color.NRGBA{}
		}
		return color.NRGBA{1, 2, 3, 255}
	})
	translucent := solid(4, 4, func(int, int) color.NRGBA { return color.NRGBA{1, 2, 3, 240} })
	for _, tc := range []struct {
		name string
		img  *image.NRGBA
		want string
	}{
		{"all opaque", opaque, RenderOpaque},
		{"hard 0/255 split", cutout, RenderCutout},
		{"uniform partial alpha", translucent, RenderTranslucent},
	} {
		if got := classifyRender(tc.img); got != tc.want {
			t.Errorf("%s: classifyRender = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// TestDrawWithBorder checks the anti-bleed border actually duplicates the
// cell's own edge rather than leaving the neighbouring pixels at zero, which
// would look identical at 1:1 and wrong under any filtering.
func TestDrawWithBorder(t *testing.T) {
	sheet := image.NewNRGBA(image.Rect(0, 0, 18, 18))
	src := solid(16, 16, func(x, y int) color.NRGBA { return color.NRGBA{uint8(x), uint8(y), 7, 255} })
	drawWithBorder(sheet, src, 1, 1, 1)

	if got, want := sheet.NRGBAAt(0, 1), (color.NRGBA{0, 0, 7, 255}); got != want {
		t.Errorf("left border = %v, want a copy of the leftmost column %v", got, want)
	}
	if got, want := sheet.NRGBAAt(17, 5), (color.NRGBA{15, 4, 7, 255}); got != want {
		t.Errorf("right border = %v, want a copy of the rightmost column %v", got, want)
	}
	if got, want := sheet.NRGBAAt(0, 0), (color.NRGBA{0, 0, 7, 255}); got != want {
		t.Errorf("corner = %v, want a copy of the corner texel %v", got, want)
	}
	if got, want := sheet.NRGBAAt(9, 17), (color.NRGBA{8, 15, 7, 255}); got != want {
		t.Errorf("bottom border = %v, want a copy of the bottom row %v", got, want)
	}
}

// TestFitSheet pins the exact-grid decision: the sheet is cols*stride by
// rows*stride with no slack, because frontend/src/viewer.ts checks precisely
// that and derives every UV from it.
func TestFitSheet(t *testing.T) {
	for _, tc := range []struct{ count, stride, wantW, wantH, wantCols int }{
		{1, 18, 18, 18, 1},
		{4, 18, 36, 36, 2},
		{5, 18, 54, 36, 3},
		{1276, 18, 648, 648, 36},
	} {
		w, h, cols, err := fitSheet(tc.count, tc.stride)
		if err != nil {
			t.Fatalf("fitSheet(%d,%d): %v", tc.count, tc.stride, err)
		}
		if w != tc.wantW || h != tc.wantH || cols != tc.wantCols {
			t.Errorf("fitSheet(%d,%d) = %dx%d cols=%d, want %dx%d cols=%d",
				tc.count, tc.stride, w, h, cols, tc.wantW, tc.wantH, tc.wantCols)
		}
		if rows := (tc.count + cols - 1) / cols; h != rows*tc.stride {
			t.Errorf("fitSheet(%d,%d): height %d is not rows*stride", tc.count, tc.stride, h)
		}
	}
	if _, _, _, err := fitSheet(1<<20, 18); err == nil {
		t.Error("fitSheet: expected an error past the 4096-texel limit, got none")
	}
}
