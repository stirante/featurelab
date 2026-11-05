package nbt

import (
	"bytes"
	"compress/zlib"
	"strings"
	"testing"
)

func zlibBytes(t *testing.T, data []byte) []byte {
	t.Helper()
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	if _, err := zw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return z.Bytes()
}

func compressedFile(structure []byte, writeCompression func(w *leWriter)) []byte {
	w := &leWriter{}
	w.tagHeader(TagCompound, "")
	w.tagHeader(TagInt, "format_version")
	w.i32(2)
	w.intList("size", 1, 1, 2)
	w.intList("structure_world_origin", 0, 0, 0)
	writeCompression(w)
	w.tagHeader(TagByteArray, "structure")
	w.i32(int32(len(structure)))
	w.buf.Write(structure)
	w.u8(byte(TagEnd))
	return w.buf.Bytes()
}

func compressionInt(value int32) func(w *leWriter) {
	return func(w *leWriter) {
		w.tagHeader(TagInt, "compression")
		w.i32(value)
	}
}

func namedStructure() []byte {
	w := &leWriter{}
	w.tagHeader(TagCompound, "")
	writeStructurePayload(w)
	return w.buf.Bytes()
}

func TestParseMcStructure_CompressedShapesTheGameRefuses(t *testing.T) {
	wrapped := &leWriter{}
	wrapped.tagHeader(TagCompound, "")
	wrapped.tagHeader(TagCompound, "structure")
	writeStructurePayload(wrapped)
	wrapped.u8(byte(TagEnd))

	bare := &leWriter{}
	writeStructurePayload(bare)

	cases := map[string]struct {
		file []byte
		want string
	}{
		"wrapped in structure": {compressedFile(zlibBytes(t, wrapped.buf.Bytes()), compressionInt(1)), "block_indices"},
		"bare payload":         {compressedFile(zlibBytes(t, bare.buf.Bytes()), compressionInt(1)), "valid NBT compound"},
		"trailing bytes":       {compressedFile(zlibBytes(t, append(namedStructure(), 0, 0, 0)), compressionInt(1)), "after its NBT compound"},
		"empty array":          {compressedFile(nil, compressionInt(1)), "empty"},
		"not zlib":             {compressedFile([]byte{1, 2, 3, 4}, compressionInt(1)), "compressed structure"},
		"empty after inflate":  {compressedFile(zlibBytes(t, nil), compressionInt(1)), "valid NBT compound"},
		"unknown compression":  {compressedFile(zlibBytes(t, namedStructure()), compressionInt(2)), "compression"},
		"non-integer compression": {compressedFile(zlibBytes(t, namedStructure()), func(w *leWriter) {
			w.tagHeader(TagString, "compression")
			w.str("zlib")
		}), "compression"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseMcStructure(tc.file)
			if err == nil {
				t.Fatal("want an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}
