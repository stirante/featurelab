package atlas

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
)

// normalise turns a decoded source texture into one Cell-sized RGBA square,
// and reports what it had to do to get there.
//
// Three things are true of vanilla's block textures and all three have to be
// handled, because measuring them is a five-minute job and guessing is how a
// whole family of textures goes missing. Across the 1281 paths
// terrain_texture.json reaches in bedrock-samples v1.26.30.5:
//
//   - 1173 are exactly 16x16 and need nothing.
//   - 72 are flipbook strips: height an exact multiple of width, one animation
//     frame per row-block (water_still is 16x512, i.e. 32 frames; lava_flow is
//     32x512). Frame 0 is taken and the frame count recorded. A static preview
//     has no animation clock, and cropping to the first frame is what vanilla
//     itself shows on the first tick.
//   - 33 are 32x32 (the light_block item icons and a few others). These are
//     box-downscaled by an exact integer factor, which for a 2:1 reduction is
//     an average of four pixels and loses nothing a 16-texel cell could have
//     shown.
//
// Everything else is REJECTED with a reason rather than stretched to fit:
// exactly three paths in the whole set (end_portal and end_gateway at 16x17,
// conduit_base at 24x12) are neither square-multiple nor flipbook, and all
// three belong to blocks whose real rendering is a custom shader or model
// that this atlas could not drive anyway. Silently rescaling them would put
// three plausible-looking wrong cells in the sheet.
func normalise(src image.Image, cell int) (out *image.NRGBA, frames, scaled int, err error) {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, 0, 0, fmt.Errorf("empty image %dx%d", w, h)
	}

	frames = 1
	if h > w && h%w == 0 {
		frames = h / w
		h = w
	}
	if w != h {
		return nil, 0, 0, fmt.Errorf("texture is %dx%d: neither square nor a whole number of square flipbook frames, so there is no honest way to fit it in a %d-texel cell", w, b.Dy(), cell)
	}
	if w%cell != 0 {
		return nil, 0, 0, fmt.Errorf("texture is %dx%d, not a whole multiple of the %d-texel cell size", w, b.Dy(), cell)
	}

	// Copy frame 0 out at its source resolution first: src may be paletted,
	// NRGBA, grey, or anything else image/png produces, and sampling it once
	// into RGBA keeps the downscale below reading a single representation.
	frame := image.NewNRGBA(image.Rect(0, 0, w, w))
	draw.Draw(frame, frame.Bounds(), src, b.Min, draw.Src)
	if w == cell {
		return frame, frames, 0, nil
	}
	return boxDownscale(frame, cell), frames, w, nil
}

// boxDownscale reduces src (whose edge is an exact integer multiple of size)
// to size x size by averaging each source block.
//
// The average is taken in PREMULTIPLIED alpha. Averaging straight RGB across
// a cutout edge would fold the colour of fully transparent pixels -- which in
// Minecraft's art is frequently black -- into the visible result and leave a
// dark fringe around every leaf and every pane.
func boxDownscale(src *image.NRGBA, size int) *image.NRGBA {
	factor := src.Bounds().Dx() / size
	out := image.NewNRGBA(image.Rect(0, 0, size, size))
	n := factor * factor
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var pr, pg, pb, pa int
			for dy := 0; dy < factor; dy++ {
				for dx := 0; dx < factor; dx++ {
					c := src.NRGBAAt(x*factor+dx, y*factor+dy)
					a := int(c.A)
					pr += int(c.R) * a / 255
					pg += int(c.G) * a / 255
					pb += int(c.B) * a / 255
					pa += a
				}
			}
			pr, pg, pb, pa = pr/n, pg/n, pb/n, pa/n
			if pa == 0 {
				out.SetNRGBA(x, y, color.NRGBA{})
				continue
			}
			unmul := func(v int) uint8 {
				u := v * 255 / pa
				if u > 255 {
					u = 255
				}
				return uint8(u)
			}
			out.SetNRGBA(x, y, color.NRGBA{R: unmul(pr), G: unmul(pg), B: unmul(pb), A: uint8(pa)})
		}
	}
	return out
}

// classifyRender reports how img's alpha says it has to be drawn. See
// Cell.Render for why this is measured and not read out of the pack.
func classifyRender(img *image.NRGBA) string {
	sawZero := false
	for i := 3; i < len(img.Pix); i += 4 {
		switch img.Pix[i] {
		case 255:
		case 0:
			sawZero = true
		default:
			return RenderTranslucent
		}
	}
	if sawZero {
		return RenderCutout
	}
	return RenderOpaque
}
