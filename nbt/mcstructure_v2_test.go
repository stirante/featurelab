package nbt

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"os"
	"testing"
)

// TestParseMcStructure_V2Export reads a file the game exported from a
// structure block (testdata/v2_export.mcstructure, 5x5x5: a 3x3x3 stone cube
// with one oak plank, the structure block itself, and air). Version 2 stores
// block_indices as a List of IntArrays and left the empty second layer out --
// the shape that failed with "must have exactly 2 layers, got 1".
func TestParseMcStructure_V2Export(t *testing.T) {
	data, err := os.ReadFile("testdata/v2_export.mcstructure")
	if err != nil {
		t.Fatal(err)
	}
	s, err := ParseMcStructure(data)
	if err != nil {
		t.Fatalf("ParseMcStructure: %v", err)
	}
	if s.Size != (Vec3Int{5, 5, 5}) {
		t.Errorf("Size = %v, want 5x5x5", s.Size)
	}
	if len(s.Layer0) != 125 || len(s.Layer1) != 125 {
		t.Fatalf("layers = %d/%d cells, want 125/125", len(s.Layer0), len(s.Layer1))
	}
	for i, v := range s.Layer1 {
		if v != -1 {
			t.Fatalf("Layer1[%d] = %d, want -1 for the omitted layer", i, v)
		}
	}
	counts := map[string]int{}
	for _, idx := range s.Layer0 {
		counts[s.Palette[idx].Name]++
	}
	if counts["minecraft:stone"] != 26 || counts["minecraft:oak_planks"] != 1 || counts["minecraft:structure_block"] != 1 {
		t.Errorf("block counts = %v, want 26 stone, 1 oak_planks, 1 structure_block", counts)
	}
}

type leWriter struct{ buf bytes.Buffer }

func (w *leWriter) u8(v byte) { w.buf.WriteByte(v) }
func (w *leWriter) i32(v int32) {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], uint32(v))
	w.buf.Write(b[:])
}
func (w *leWriter) str(s string) {
	var b [2]byte
	binary.LittleEndian.PutUint16(b[:], uint16(len(s)))
	w.buf.Write(b[:])
	w.buf.WriteString(s)
}
func (w *leWriter) tagHeader(t TagType, name string) {
	w.u8(byte(t))
	w.str(name)
}
func (w *leWriter) intList(name string, values ...int32) {
	w.tagHeader(TagList, name)
	w.u8(byte(TagInt))
	w.i32(int32(len(values)))
	for _, v := range values {
		w.i32(v)
	}
}

// writeStructurePayload writes the payload of a 1x1x2 version 2 structure
// compound: stone over a waterlogged-style second layer holding water.
func writeStructurePayload(w *leWriter) {
	w.tagHeader(TagList, "block_indices")
	w.u8(byte(TagIntArray))
	w.i32(2)
	for _, layer := range [][]int32{{0, 0}, {-1, 1}} {
		w.i32(int32(len(layer)))
		for _, v := range layer {
			w.i32(v)
		}
	}
	w.tagHeader(TagCompound, "palette")
	w.tagHeader(TagCompound, "default")
	w.tagHeader(TagList, "block_palette")
	w.u8(byte(TagCompound))
	w.i32(2)
	for _, name := range []string{"minecraft:stone", "minecraft:water"} {
		w.tagHeader(TagString, "name")
		w.str(name)
		w.u8(byte(TagEnd))
	}
	w.u8(byte(TagEnd)) // default
	w.u8(byte(TagEnd)) // palette
	w.u8(byte(TagEnd)) // structure
}

func buildV2Structure(t *testing.T, compressed bool) []byte {
	t.Helper()
	w := &leWriter{}
	w.tagHeader(TagCompound, "")
	w.tagHeader(TagInt, "format_version")
	w.i32(2)
	w.intList("size", 1, 1, 2)
	w.intList("structure_world_origin", 0, 0, 0)
	if !compressed {
		w.tagHeader(TagCompound, "structure")
		writeStructurePayload(w)
	} else {
		w.tagHeader(TagInt, "compression")
		w.i32(1)
		inner := &leWriter{}
		inner.tagHeader(TagCompound, "")
		writeStructurePayload(inner)
		var z bytes.Buffer
		zw := zlib.NewWriter(&z)
		if _, err := zw.Write(inner.buf.Bytes()); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		w.tagHeader(TagByteArray, "structure")
		w.i32(int32(z.Len()))
		w.buf.Write(z.Bytes())
	}
	w.u8(byte(TagEnd))
	return w.buf.Bytes()
}

// TestParseMcStructure_V2TwoLayersAndZlib covers the two version 2 shapes the
// exported sample does not: a second IntArray layer, and the zlib-compressed
// structure compound added in Preview 26.60.29 (root `compression: 1`).
func TestParseMcStructure_V2TwoLayersAndZlib(t *testing.T) {
	for _, compressed := range []bool{false, true} {
		s, err := ParseMcStructure(buildV2Structure(t, compressed))
		if err != nil {
			t.Fatalf("compressed=%v: %v", compressed, err)
		}
		if got := s.Layer1; len(got) != 2 || got[0] != -1 || got[1] != 1 {
			t.Errorf("compressed=%v: Layer1 = %v, want [-1 1]", compressed, got)
		}
		if len(s.Palette) != 2 || s.Palette[1].Name != "minecraft:water" {
			t.Errorf("compressed=%v: Palette = %v", compressed, s.Palette)
		}
	}
}
