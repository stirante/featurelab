package rptex

import (
	"image"
	"image/color"
	"testing"
)

func TestAchromatic(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    RGB
		want bool
	}{
		{"a measured grass_top average", RGB{154, 154, 154}, true},
		{"one level of integer-division drift", RGB{154, 153, 155}, true},
		{"two levels, the documented edge of the threshold", RGB{154, 152, 154}, true},
		{"three levels is a colour", RGB{154, 151, 154}, false},
		{"dirt", RGB{134, 96, 67}, false},
	} {
		if got := tc.c.Achromatic(); got != tc.want {
			t.Errorf("%s: %v.Achromatic() = %v, want %v", tc.name, tc.c, got, tc.want)
		}
	}
}

func TestParseHexAndHex(t *testing.T) {
	c, err := ParseHex("#79c05a")
	if err != nil {
		t.Fatal(err)
	}
	if c != (RGB{0x79, 0xc0, 0x5a}) {
		t.Fatalf("ParseHex = %v", c)
	}
	if got := c.Hex(); got != "#79c05a" {
		t.Fatalf("Hex round trip = %q", got)
	}
	if _, err := ParseHex("#nope"); err == nil {
		t.Error("ParseHex accepted a non-hex string")
	}
	if _, err := ParseHex("#abc"); err == nil {
		t.Error("ParseHex accepted a three-digit shorthand it does not support")
	}
}

// TestTintFactorRoundTrips is the property the whole tint channel rests on:
// multiplying the greyscale texture by the factor lands on the colour the
// pre-tinted art measures at.
func TestTintFactorRoundTrips(t *testing.T) {
	base := RGB{140, 140, 140}
	target := RGB{70, 130, 40}
	factor := TintFactor(base, target)
	got := Multiply(base, factor)
	for i, pair := range [][2]uint8{{got.R, target.R}, {got.G, target.G}, {got.B, target.B}} {
		if diff := int(pair[0]) - int(pair[1]); diff < -1 || diff > 1 {
			t.Errorf("channel %d: base*factor = %d, want %d", i, pair[0], pair[1])
		}
	}
}

// TestTintFactorSaturates: a multiply cannot brighten, so a target above the
// base saturates at 255 rather than wrapping into a wrong dark colour.
func TestTintFactorSaturates(t *testing.T) {
	f := TintFactor(RGB{140, 140, 140}, RGB{255, 200, 139})
	if f.R != 255 || f.G != 255 {
		t.Errorf("TintFactor = %v, want the unreachable channels pinned to 255", f)
	}
	if f.B == 255 {
		t.Errorf("TintFactor = %v: a barely-reachable channel should not have saturated", f)
	}
	if got := TintFactor(RGB{0, 0, 0}, RGB{1, 2, 3}); got != (RGB{255, 255, 255}) {
		t.Errorf("TintFactor from black = %v, want white rather than a divide by zero", got)
	}
}

// TestAverageSkipsFullyTransparentPixels: folding a cutout's transparent
// pixels in as black is how every leaf and every pane ends up too dark.
func TestAverageSkipsFullyTransparentPixels(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			if x < 2 {
				img.SetNRGBA(x, y, color.NRGBA{0, 0, 0, 0})
				continue
			}
			img.SetNRGBA(x, y, color.NRGBA{100, 200, 50, 255})
		}
	}
	avg, n := Average(img)
	if n != 8 {
		t.Fatalf("counted %d contributing pixels, want 8", n)
	}
	if avg != (RGB{100, 200, 50}) {
		t.Fatalf("Average = %v, want the opaque colour untouched", avg)
	}

	empty := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	if _, n := Average(empty); n != 0 {
		t.Fatalf("a fully transparent image contributed %d pixels", n)
	}
}
