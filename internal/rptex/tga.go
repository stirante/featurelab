package rptex

import (
	"errors"
	"fmt"
	"image"
	"image/color"
)

// DecodeTGA decodes the subset of the Truevision TGA format actually present
// among bedrock-samples' block textures: image type 2 (uncompressed
// true-colour) and image type 10 (run-length-encoded true-colour), at 24 or
// 32 bits per pixel.
//
// Row and column order ARE honoured, via bits 4 and 5 of the image
// descriptor byte. That is not defensive coding: every one of the 51 .tga
// files terrain_texture.json reaches in bedrock-samples v1.26.30.5 has
// descriptor 0x08 -- bottom-origin, left-to-right -- so a decoder that
// ignores the bit returns all 51 of them upside down. grass_side is one of
// them, so ignoring it renders grass blocks with the grass at the bottom of
// their sides and the dirt at the top.
//
// (This decoder's first caller, internal/gencolors, averages every pixel of
// the image and is therefore insensitive to the flip; that is why it went
// unnoticed there, and why fixing it moves no colour in block/vanilla/
// colors.json.)
//
// Colour-mapped (type 1) and other exotic TGA variants are unsupported and
// return an error. This is a real, checked limitation, not a theoretical
// one: a full scan of bedrock-samples' textures/blocks directory found
// exactly two colour-mapped .tga files (water_still_grey_normal.tga,
// water_flow_grey_normal.tga) and both are normal maps, never referenced by
// terrain_texture.json's diffuse "path" entries -- so it does not cost any
// caller a texture in practice, but it is still surfaced as an explicit
// error (and, by callers, as a recorded miss) rather than silently producing
// a wrong result.
func DecodeTGA(data []byte) (*image.NRGBA, error) {
	if len(data) < 18 {
		return nil, errors.New("tga: header too short")
	}
	idLen := int(data[0])
	colorMapType := data[1]
	imgType := data[2]
	width := int(data[12]) | int(data[13])<<8
	height := int(data[14]) | int(data[15])<<8
	bpp := int(data[16])
	descriptor := data[17]

	if colorMapType != 0 {
		return nil, fmt.Errorf("tga: colour-mapped images unsupported (colorMapType=%d)", colorMapType)
	}
	if bpp != 24 && bpp != 32 {
		return nil, fmt.Errorf("tga: unsupported bit depth %d", bpp)
	}
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("tga: invalid dimensions %dx%d", width, height)
	}

	// Image descriptor bits 4 and 5 give the origin corner of the stored
	// pixel stream. Bit 5 clear (the common case, and the only one present
	// in bedrock-samples) means the first stored row is the BOTTOM row.
	topOrigin := descriptor&0x20 != 0
	rightOrigin := descriptor&0x10 != 0

	bytesPerPixel := bpp / 8
	off := 18 + idLen
	if off > len(data) {
		return nil, errors.New("tga: image ID overruns file")
	}
	total := width * height
	img := image.NewNRGBA(image.Rect(0, 0, width, height))

	readPixel := func(b []byte) color.NRGBA {
		bl, g, r := b[0], b[1], b[2]
		a := byte(255)
		if bytesPerPixel == 4 {
			a = b[3]
		}
		return color.NRGBA{R: r, G: g, B: bl, A: a}
	}
	// set places the i'th pixel of the stored stream at its image position,
	// undoing whatever origin corner the descriptor declared.
	set := func(i int, p color.NRGBA) {
		x, y := i%width, i/width
		if !topOrigin {
			y = height - 1 - y
		}
		if rightOrigin {
			x = width - 1 - x
		}
		img.SetNRGBA(x, y, p)
	}

	switch imgType {
	case 2: // uncompressed true-colour
		need := off + total*bytesPerPixel
		if len(data) < need {
			return nil, fmt.Errorf("tga: truncated pixel data (need %d bytes, have %d)", need, len(data))
		}
		for i := 0; i < total; i++ {
			set(i, readPixel(data[off+i*bytesPerPixel:off+(i+1)*bytesPerPixel]))
		}
	case 10: // run-length-encoded true-colour
		i := off
		px := 0
		for px < total {
			if i >= len(data) {
				return nil, errors.New("tga: truncated RLE stream")
			}
			packet := data[i]
			i++
			count := int(packet&0x7f) + 1
			if packet&0x80 != 0 {
				if i+bytesPerPixel > len(data) {
					return nil, errors.New("tga: truncated RLE run packet")
				}
				p := readPixel(data[i : i+bytesPerPixel])
				i += bytesPerPixel
				for k := 0; k < count && px < total; k++ {
					set(px, p)
					px++
				}
			} else {
				for k := 0; k < count && px < total; k++ {
					if i+bytesPerPixel > len(data) {
						return nil, errors.New("tga: truncated raw packet")
					}
					p := readPixel(data[i : i+bytesPerPixel])
					i += bytesPerPixel
					set(px, p)
					px++
				}
			}
		}
	default:
		return nil, fmt.Errorf("tga: unsupported image type %d", imgType)
	}
	return img, nil
}
