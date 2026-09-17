package rptex

import (
	"fmt"
	"image"
	"strconv"
	"strings"
)

// RGB is an 8-bit-per-channel colour with no alpha: alpha, where it matters,
// is consumed by the caller (as a per-pixel averaging weight in Average, or
// as a render-method classification in internal/atlas) rather than carried
// through here.
type RGB struct{ R, G, B uint8 }

// Hex renders c as "#rrggbb".
func (c RGB) Hex() string { return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B) }

// Achromatic reports whether c is close enough to neutral grey that it is
// almost certainly an un-tinted greyscale texture (vanilla bakes grass and
// leaves textures as grey, to be multiplied by a runtime biome colour)
// rather than a genuinely grey material such as stone or gravel.
//
// The threshold (2) comes from measurement, not guesswork: every grey
// pre-tint texture actually checked in bedrock-samples (grass_top,
// grass_side, leaves_oak, leaves_oak_opaque, ...) averages to channels
// equal or within 1-2 levels of each other (integer-division rounding),
// while every genuinely-coloured texture checked (dirt, sand, oak_planks)
// differs by tens of levels between its largest and smallest channel.
func (c RGB) Achromatic() bool {
	max, min := c.R, c.R
	if c.G > max {
		max = c.G
	}
	if c.G < min {
		min = c.G
	}
	if c.B > max {
		max = c.B
	}
	if c.B < min {
		min = c.B
	}
	return max-min <= 2
}

// ParseHex parses "#rrggbb" (the "#" is optional), the form
// terrain_texture.json writes overlay_color in.
func ParseHex(s string) (RGB, error) {
	s = strings.TrimPrefix(s, "#")
	if len(s) != 6 {
		return RGB{}, fmt.Errorf("invalid hex colour %q", s)
	}
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return RGB{}, fmt.Errorf("invalid hex colour %q: %w", s, err)
	}
	return RGB{uint8(v >> 16), uint8(v >> 8), uint8(v)}, nil
}

// Multiply reproduces the engine's own tint blend: a per-channel multiply of
// the (greyscale, in practice) base texture by the overlay colour, matching
// how terrain_texture.json's own "overlay_color" is documented to behave and
// how Bedrock renders biome-tinted blocks.
func Multiply(base, overlay RGB) RGB {
	return RGB{
		uint8(int(base.R) * int(overlay.R) / 255),
		uint8(int(base.G) * int(overlay.G) / 255),
		uint8(int(base.B) * int(overlay.B) / 255),
	}
}

// TintFactor is the inverse of Multiply: the colour that, multiplied into
// base, lands on target. It is how a measured pre-tinted texture (vanilla's
// carried/held-item art, or the non-grey twin of a _grey texture) is turned
// into the multiplier a renderer applies to the greyscale texture actually
// shipped for the block face.
//
// Channels saturate at 255 rather than wrapping: a base channel darker than
// the target it must reach cannot be scaled there by a multiply, and the
// honest answer is "as bright as a multiply can get".
func TintFactor(base, target RGB) RGB {
	scale := func(b, t uint8) uint8 {
		if b == 0 {
			return 255
		}
		v := (int(t)*255 + int(b)/2) / int(b)
		if v > 255 {
			return 255
		}
		return uint8(v)
	}
	return RGB{scale(base.R, target.R), scale(base.G, target.G), scale(base.B, target.B)}
}

// Average returns the mean colour of img, skipping fully transparent pixels
// (alpha==0) entirely rather than folding them into the average as black,
// along with the number of pixels that contributed. The remaining pixels are
// weighted equally regardless of partial alpha: every texture actually
// measured in this data set (water at a uniform alpha 240, ice at a uniform
// 190, cutout foliage/rails/glass at a hard 0-or-255 split) carries alpha
// values that are either a uniform per-texture constant or exactly opaque,
// with no meaningful population of partially-transparent antialiased edge
// pixels -- so weighting by partial alpha would add complexity without
// changing the result.
func Average(img image.Image) (RGB, int) {
	b := img.Bounds()
	var rs, gs, bs, n int
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}
			rs += int(r >> 8)
			gs += int(g >> 8)
			bs += int(bl >> 8)
			n++
		}
	}
	if n == 0 {
		return RGB{}, 0
	}
	return RGB{uint8(rs / n), uint8(gs / n), uint8(bs / n)}, n
}
