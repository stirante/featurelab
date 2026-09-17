package structures

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/nbt"
)

// beWriter hand-encodes big-endian NBT bytes for this test only -- nbt.go deliberately has no
// writer (see that package's own doc comment: "there is no writer"), so this mirrors nbt/
// legacy_test.go's own local beWriter rather than adding one to the nbt package for a single
// test's benefit.
type beWriter struct{ buf bytes.Buffer }

func (w *beWriter) u8(v byte) { w.buf.WriteByte(v) }
func (w *beWriter) i16(v int16) {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], uint16(v))
	w.buf.Write(b[:])
}
func (w *beWriter) i32(v int32) {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], uint32(v))
	w.buf.Write(b[:])
}
func (w *beWriter) str(s string) {
	w.i16(int16(len(s)))
	w.buf.WriteString(s)
}
func (w *beWriter) tagHeader(t nbt.TagType, name string) {
	w.u8(byte(t))
	w.str(name)
}

// buildOneBoneBlockLegacyNbt encodes a 1x1x1 structure with a single bone_block/axis=y entry at
// (0,0,0) -- gzip + big-endian, matching the real container.
func buildOneBoneBlockLegacyNbt(t *testing.T) []byte {
	t.Helper()
	w := &beWriter{}
	w.tagHeader(nbt.TagCompound, "")

	w.tagHeader(nbt.TagList, "size")
	w.u8(byte(nbt.TagInt))
	w.i32(3)
	w.i32(1)
	w.i32(1)
	w.i32(1)

	w.tagHeader(nbt.TagList, "palette")
	w.u8(byte(nbt.TagCompound))
	w.i32(1)
	w.tagHeader(nbt.TagString, "Name")
	w.str("minecraft:bone_block")
	w.tagHeader(nbt.TagCompound, "Properties")
	w.tagHeader(nbt.TagString, "axis")
	w.str("y")
	w.u8(byte(nbt.TagEnd))
	w.u8(byte(nbt.TagEnd))

	w.tagHeader(nbt.TagList, "blocks")
	w.u8(byte(nbt.TagCompound))
	w.i32(1)
	w.tagHeader(nbt.TagList, "pos")
	w.u8(byte(nbt.TagInt))
	w.i32(3)
	w.i32(0)
	w.i32(0)
	w.i32(0)
	w.tagHeader(nbt.TagInt, "state")
	w.i32(0)
	w.u8(byte(nbt.TagEnd))

	w.u8(byte(nbt.TagEnd))

	var gz bytes.Buffer
	gw := gzip.NewWriter(&gz)
	if _, err := gw.Write(w.buf.Bytes()); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return gz.Bytes()
}

func TestBuildLibrary_LegacyNbtResolvesUnnamespaced(t *testing.T) {
	pal := block.NewPalette()
	files := []SourceFile{
		{ID: "fossils/fossil_spine_01.nbt", Data: buildOneBoneBlockLegacyNbt(t)},
	}
	lib := BuildLibrary(files, pal)
	if len(lib.Diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", lib.Diagnostics)
	}

	// UNNAMESPACED -- "fossils/fossil_spine_01", NOT "fossils:fossil_spine_01" (the .mcstructure
	// convention fileIDToStructureName uses). See legacy.go's own fileIDToLegacyKey doc comment.
	rs := lib.ResolveLegacy("fossils/fossil_spine_01")
	if rs == nil {
		t.Fatal(`ResolveLegacy("fossils/fossil_spine_01") = nil, want a resolved structure`)
	}
	if rs.Size != (nbt.Vec3Int{X: 1, Y: 1, Z: 1}) {
		t.Errorf("Size = %+v, want {1 1 1}", rs.Size)
	}
	if len(rs.Palette) != 1 || rs.Palette[0].Name != "minecraft:bone_block" || rs.Palette[0].Properties["axis"] != "y" {
		t.Errorf("Palette = %+v, want one bone_block/axis=y entry", rs.Palette)
	}
	if len(rs.Blocks) != 1 || rs.Blocks[0].Palette != 0 {
		t.Errorf("Blocks = %+v, want one entry at palette index 0", rs.Blocks)
	}

	// The colon-namespaced key must NOT resolve -- proves this isn't accidentally also indexed
	// under .mcstructure's own convention.
	if lib.Resolve("fossils:fossil_spine_01") != nil {
		t.Error(`Resolve("fossils:fossil_spine_01") should be nil -- legacy files never populate the .mcstructure namespace`)
	}
}

func TestBuildLibrary_LegacyNbtMissingKeyResolvesNil(t *testing.T) {
	lib := BuildLibrary(nil, block.NewPalette())
	if lib.ResolveLegacy("fossils/fossil_spine_01") != nil {
		t.Error("expected nil for an unloaded key")
	}
	if NoLegacyStructures.ResolveLegacy("anything") != nil {
		t.Error("NoLegacyStructures must resolve everything to nil")
	}
	var nilLib *Library
	if nilLib.ResolveLegacy("x") != nil {
		t.Error("a nil *Library must resolve to nil, not panic")
	}
}

func TestBuildLibrary_DuplicateLegacyKeyIsDiagnosed(t *testing.T) {
	data := buildOneBoneBlockLegacyNbt(t)
	files := []SourceFile{
		{ID: "fossils/fossil_spine_01.nbt", Data: data},
		{ID: "fossils/fossil_spine_01.NBT", Data: data}, // same key, case-insensitive extension
	}
	lib := BuildLibrary(files, block.NewPalette())
	if len(lib.Diagnostics) != 1 {
		t.Fatalf("Diagnostics = %+v, want exactly 1 duplicate-key diagnostic", lib.Diagnostics)
	}
}
