package rptex

import (
	"testing"
)

// buildTGA24 builds a minimal, valid, uncompressed (type 2) 24-bit-per-pixel
// TGA byte buffer for the given width/height BGR pixel data. The image
// descriptor byte is left at 0, i.e. bottom-origin -- the orientation every
// .tga in bedrock-samples actually uses -- so a single-row image reads back
// unchanged while a multi-row one reads back with its stored rows reversed.
func buildTGA24(width, height int, bgr [][3]byte) []byte {
	header := make([]byte, 18)
	header[2] = 2 // image type: uncompressed true-colour
	header[12] = byte(width)
	header[13] = byte(width >> 8)
	header[14] = byte(height)
	header[15] = byte(height >> 8)
	header[16] = 24 // bits per pixel
	out := append([]byte(nil), header...)
	for _, px := range bgr {
		out = append(out, px[0], px[1], px[2])
	}
	return out
}

// buildTGA32 is buildTGA24 for 32bpp (BGRA) pixel data.
func buildTGA32(width, height int, bgra [][4]byte) []byte {
	header := make([]byte, 18)
	header[2] = 2
	header[12] = byte(width)
	header[13] = byte(width >> 8)
	header[14] = byte(height)
	header[15] = byte(height >> 8)
	header[16] = 32
	header[17] = 0x08 // 8 bits of alpha
	out := append([]byte(nil), header...)
	for _, px := range bgra {
		out = append(out, px[0], px[1], px[2], px[3])
	}
	return out
}

func TestDecodeTGA_Uncompressed24(t *testing.T) {
	// 2x1 image: pure red, pure green (stored BGR).
	data := buildTGA24(2, 1, [][3]byte{
		{0x00, 0x00, 0xff}, // B=0 G=0 R=255 -> red
		{0x00, 0xff, 0x00}, // B=0 G=255 R=0 -> green
	})
	img, err := DecodeTGA(data)
	if err != nil {
		t.Fatalf("decodeTGA: %v", err)
	}
	if got := img.Bounds(); got.Dx() != 2 || got.Dy() != 1 {
		t.Fatalf("bounds = %v, want 2x1", got)
	}
	r, g, b, a := img.At(0, 0).RGBA()
	if r>>8 != 255 || g>>8 != 0 || b>>8 != 0 || a>>8 != 255 {
		t.Fatalf("pixel(0,0) = (%d,%d,%d,%d), want (255,0,0,255)", r>>8, g>>8, b>>8, a>>8)
	}
	r, g, b, _ = img.At(1, 0).RGBA()
	if r>>8 != 0 || g>>8 != 255 || b>>8 != 0 {
		t.Fatalf("pixel(1,0) = (%d,%d,%d), want (0,255,0)", r>>8, g>>8, b>>8)
	}
}

func TestDecodeTGA_Uncompressed32PreservesAlpha(t *testing.T) {
	data := buildTGA32(2, 1, [][4]byte{
		{0x00, 0x00, 0xff, 0xff}, // opaque red
		{0x11, 0x22, 0x33, 0x00}, // fully transparent, arbitrary colour
	})
	img, err := DecodeTGA(data)
	if err != nil {
		t.Fatalf("decodeTGA: %v", err)
	}
	_, _, _, a := img.At(0, 0).RGBA()
	if a>>8 != 255 {
		t.Fatalf("pixel(0,0) alpha = %d, want 255", a>>8)
	}
	_, _, _, a = img.At(1, 0).RGBA()
	if a>>8 != 0 {
		t.Fatalf("pixel(1,0) alpha = %d, want 0", a>>8)
	}
}

// buildTGA32RLE builds a run-length-encoded (type 10) 32bpp TGA: a single
// RLE "run" packet repeating one BGRA pixel width*height times.
func buildTGA32RLE(width, height int, bgra [4]byte) []byte {
	header := make([]byte, 18)
	header[2] = 10
	header[12] = byte(width)
	header[13] = byte(width >> 8)
	header[14] = byte(height)
	header[15] = byte(height >> 8)
	header[16] = 32
	out := append([]byte(nil), header...)
	total := width * height
	for total > 0 {
		run := total
		if run > 128 {
			run = 128
		}
		out = append(out, byte(0x80|(run-1)))
		out = append(out, bgra[0], bgra[1], bgra[2], bgra[3])
		total -= run
	}
	return out
}

func TestDecodeTGA_RLE(t *testing.T) {
	data := buildTGA32RLE(3, 3, [4]byte{0x0a, 0x14, 0x1e, 0xff}) // B=10 G=20 R=30
	img, err := DecodeTGA(data)
	if err != nil {
		t.Fatalf("decodeTGA: %v", err)
	}
	if got := img.Bounds(); got.Dx() != 3 || got.Dy() != 3 {
		t.Fatalf("bounds = %v, want 3x3", got)
	}
	for y := 0; y < 3; y++ {
		for x := 0; x < 3; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			if r>>8 != 30 || g>>8 != 20 || b>>8 != 10 || a>>8 != 255 {
				t.Fatalf("pixel(%d,%d) = (%d,%d,%d,%d), want (30,20,10,255)", x, y, r>>8, g>>8, b>>8, a>>8)
			}
		}
	}
}

func TestDecodeTGA_UnsupportedColorMapped(t *testing.T) {
	header := make([]byte, 18)
	header[1] = 1 // colour-mapped
	header[2] = 1
	header[12], header[14], header[16] = 1, 1, 8
	if _, err := DecodeTGA(header); err == nil {
		t.Fatal("decodeTGA: expected error for colour-mapped TGA, got nil")
	}
}

func TestDecodeTGA_TooShort(t *testing.T) {
	if _, err := DecodeTGA([]byte{1, 2, 3}); err == nil {
		t.Fatal("decodeTGA: expected error for truncated header, got nil")
	}
}

// TestDecodeTGA_BottomOriginIsFlipped pins the fix that the atlas needed and
// the colour generator never noticed: every .tga terrain_texture.json reaches
// in bedrock-samples declares descriptor 0x08 (bottom-origin), so the first
// row in the file is the BOTTOM row of the image. A decoder that stores the
// stream in order returns all of them upside down -- grass_side included.
func TestDecodeTGA_BottomOriginIsFlipped(t *testing.T) {
	// 1x2 image: the stored stream is [red, green]; bottom-origin means red
	// is the bottom row, so the decoded image must read green at y=0.
	data := buildTGA24(1, 2, [][3]byte{
		{0x00, 0x00, 0xff}, // red   -> bottom row (y=1)
		{0x00, 0xff, 0x00}, // green -> top row    (y=0)
	})
	img, err := DecodeTGA(data)
	if err != nil {
		t.Fatalf("DecodeTGA: %v", err)
	}
	if r, g, _, _ := img.At(0, 0).RGBA(); r>>8 != 0 || g>>8 != 255 {
		t.Errorf("top pixel = (%d,%d), want green (0,255): bottom-origin flip not applied", r>>8, g>>8)
	}
	if r, g, _, _ := img.At(0, 1).RGBA(); r>>8 != 255 || g>>8 != 0 {
		t.Errorf("bottom pixel = (%d,%d), want red (255,0)", r>>8, g>>8)
	}
}

// TestDecodeTGA_TopOriginIsNotFlipped is the other half: a descriptor with
// bit 5 set means the stream already starts at the top row and must be left
// alone.
func TestDecodeTGA_TopOriginIsNotFlipped(t *testing.T) {
	data := buildTGA24(1, 2, [][3]byte{
		{0x00, 0x00, 0xff}, // red
		{0x00, 0xff, 0x00}, // green
	})
	data[17] = 0x20 // top-origin
	img, err := DecodeTGA(data)
	if err != nil {
		t.Fatalf("DecodeTGA: %v", err)
	}
	if r, _, _, _ := img.At(0, 0).RGBA(); r>>8 != 255 {
		t.Errorf("top pixel red = %d, want 255: top-origin image must not be flipped", r>>8)
	}
}
