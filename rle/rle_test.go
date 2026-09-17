package rle

import (
	"encoding/json"
	"fmt"
	"testing"
)

func encode(t *testing.T, values []int64) string {
	t.Helper()
	b, err := Marshal(len(values), func(i int) int64 { return values[i] })
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(b)
}

func TestMarshal_Shape(t *testing.T) {
	cases := []struct {
		name   string
		values []int64
		want   string
	}{
		{"empty", nil, `{"rle":[]}`},
		{"one value", []int64{7}, `{"rle":[7,1]}`},
		{"one long run", []int64{0, 0, 0, 0}, `{"rle":[0,4]}`},
		{"alternating values never merge", []int64{1, 2, 1}, `{"rle":[1,1,2,1,1,1]}`},
		{"runs of each value", []int64{0, 0, 5, 5, 5, 0}, `{"rle":[0,2,5,3,0,1]}`},
		{"negative values survive", []int64{-1, -1, 3}, `{"rle":[-1,2,3,1]}`},
	}
	for _, c := range cases {
		if got := encode(t, c.values); got != c.want {
			t.Errorf("%s: Marshal(%v) = %s, want %s", c.name, c.values, got, c.want)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	// The case the encoding exists for: a mostly-untouched bench volume.
	values := make([]int64, 10000)
	for i := 4000; i < 4010; i++ {
		values[i] = 3
	}
	values[9999] = 1

	encoded := encode(t, values)
	if len(encoded) > 60 {
		t.Errorf("10000 cells encoded to %d bytes: %s", len(encoded), encoded)
	}
	got, err := Unmarshal([]byte(encoded))
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(got) != len(values) {
		t.Fatalf("round-trip returned %d values, want %d", len(got), len(values))
	}
	for i := range values {
		if got[i] != values[i] {
			t.Fatalf("round-trip differs at %d: got %d, want %d", i, got[i], values[i])
		}
	}
}

func TestUnmarshal_AcceptsTheOlderShapes(t *testing.T) {
	// A dense array and a base64 mask are what older captured responses carry -- this repo keeps
	// several as test fixtures, and they have to keep decoding. See this package's doc comment
	// for why the new shape is an OBJECT: a bare array cannot be told apart from a dense one.
	dense, err := Unmarshal([]byte(`[0,0,5,0]`))
	if err != nil {
		t.Fatalf("dense: %v", err)
	}
	if len(dense) != 4 || dense[2] != 5 {
		t.Errorf("dense array decoded to %v", dense)
	}

	// "AAEA" is the base64 of bytes 0x00 0x01 0x00 -- the old changed/removed mask encoding.
	mask, err := Unmarshal([]byte(`"AAEA"`))
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	if len(mask) != 3 || mask[1] != 1 {
		t.Errorf("base64 mask decoded to %v", mask)
	}
}

func TestUnmarshal_NullIsAnAbsentArray(t *testing.T) {
	got, err := Unmarshal([]byte(`null`))
	if err != nil {
		t.Fatalf("null: %v", err)
	}
	if got != nil {
		t.Errorf("null decoded to %v, want nil", got)
	}
}

func TestUnmarshal_RejectsMalformedRuns(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"odd number of elements", `{"rle":[0,4,7]}`},
		{"zero run length", `{"rle":[0,0]}`},
		{"negative run length", `{"rle":[0,-2]}`},
		{"not a JSON value this package emits", `12`},
	}
	for _, c := range cases {
		if _, err := Unmarshal([]byte(c.in)); err == nil {
			t.Errorf("%s: Unmarshal(%s) returned no error", c.name, c.in)
		}
	}
}

func TestUnmarshal_ToleratesSurroundingWhitespace(t *testing.T) {
	// A pretty-printed response (the CLI's own output) hands each field's raw bytes over with
	// indentation attached.
	got, err := Unmarshal([]byte("\n  {\"rle\":[4,2]}  "))
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(got) != 2 || got[0] != 4 {
		t.Errorf("decoded to %v", got)
	}
}

func TestMarshal_IsValidJSONInAnEnclosingDocument(t *testing.T) {
	// Guards the thing a hand-rolled encoder gets wrong: the output has to be a JSON VALUE that
	// slots into a larger object, not a fragment.
	b, err := Marshal(3, func(i int) int64 { return int64(i) })
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	doc := []byte(`{"blocks":` + string(b) + `}`)
	var parsed map[string]any
	if err := json.Unmarshal(doc, &parsed); err != nil {
		t.Fatalf("enclosing document did not parse: %v", err)
	}
}

func TestUnmarshal_RefusesAnAbsurdCellCount(t *testing.T) {
	// Nine bytes that would otherwise ask for terabytes. The encoding's leverage cuts both ways,
	// so a decoder handed a corrupt document has to refuse rather than allocate.
	if _, err := Unmarshal([]byte(`{"rle":[0,999999999999]}`)); err == nil {
		t.Error("a run length past every real volume must be refused, not allocated")
	}
	// And the cap must not touch a large-but-real volume: 96x384x96 is a bench size this repo
	// actually generates.
	big := 96 * 384 * 96
	got, err := Unmarshal([]byte(fmt.Sprintf(`{"rle":[0,%d]}`, big)))
	if err != nil {
		t.Fatalf("a real bench-sized volume was refused: %v", err)
	}
	if len(got) != big {
		t.Errorf("decoded %d cells, want %d", len(got), big)
	}
}
