package nbt

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"os"
	"testing"
)

// ---------------------------------------------------------------------------
// Synthetic byte-level round trip -- does NOT need the real vanilla files, so
// it runs everywhere (CI included). Hand-encodes a minimal big-endian NBT
// compound in the exact shape ParseLegacyStructure expects, independent of
// this package's own reader, so a bug in the reader can't hide behind a bug
// in the test's own construction of the bytes.
// ---------------------------------------------------------------------------

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
func (w *beWriter) tagHeader(t TagType, name string) {
	w.u8(byte(t))
	w.str(name)
}

// buildTestLegacyStructureNbt hand-encodes:
//
//	TAG_Compound "" {
//	  TAG_String "author" = "test"
//	  TAG_List   "size" = [TAG_Int; 2, 3, 4]
//	  TAG_List   "palette" = [TAG_Compound;
//	    { TAG_String "Name" = "minecraft:bone_block", TAG_Compound "Properties" = { TAG_String "axis" = "y" } },
//	    { TAG_String "Name" = "minecraft:bone_block", TAG_Compound "Properties" = { TAG_String "axis" = "x" } },
//	  ]
//	  TAG_List   "blocks" = [TAG_Compound;
//	    { TAG_List "pos" = [TAG_Int; 0,0,0], TAG_Int "state" = 0 },
//	    { TAG_List "pos" = [TAG_Int; 1,2,3], TAG_Int "state" = 1 },
//	  ]
//	  TAG_List   "entities" = [TAG_Compound; ] (empty)
//	}
//
// gzipped, matching the real container -- see legacy.go's own header.
func buildTestLegacyStructureNbt(t *testing.T) []byte {
	t.Helper()
	w := &beWriter{}
	w.tagHeader(TagCompound, "") // root

	w.tagHeader(TagString, "author")
	w.str("test")

	w.tagHeader(TagList, "size")
	w.u8(byte(TagInt))
	w.i32(3)
	w.i32(2)
	w.i32(3)
	w.i32(4)

	w.tagHeader(TagList, "palette")
	w.u8(byte(TagCompound))
	w.i32(2)
	for _, axis := range []string{"y", "x"} {
		w.tagHeader(TagString, "Name")
		w.str("minecraft:bone_block")
		w.tagHeader(TagCompound, "Properties")
		w.tagHeader(TagString, "axis")
		w.str(axis)
		w.u8(byte(TagEnd)) // end Properties
		w.u8(byte(TagEnd)) // end this palette entry compound
	}

	w.tagHeader(TagList, "blocks")
	w.u8(byte(TagCompound))
	w.i32(2)
	positions := [][3]int32{{0, 0, 0}, {1, 2, 3}}
	states := []int32{0, 1}
	for i := range positions {
		w.tagHeader(TagList, "pos")
		w.u8(byte(TagInt))
		w.i32(3)
		w.i32(positions[i][0])
		w.i32(positions[i][1])
		w.i32(positions[i][2])
		w.tagHeader(TagInt, "state")
		w.i32(states[i])
		w.u8(byte(TagEnd)) // end this block entry compound
	}

	w.tagHeader(TagList, "entities")
	w.u8(byte(TagCompound))
	w.i32(0)

	w.u8(byte(TagEnd)) // end root

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

func TestParseLegacyStructure_SyntheticRoundTrip(t *testing.T) {
	data := buildTestLegacyStructureNbt(t)
	ls, err := ParseLegacyStructure(data)
	if err != nil {
		t.Fatalf("ParseLegacyStructure: %v", err)
	}
	if ls.Size != (Vec3Int{X: 2, Y: 3, Z: 4}) {
		t.Errorf("Size = %+v, want {2 3 4}", ls.Size)
	}
	if len(ls.Palette) != 2 {
		t.Fatalf("len(Palette) = %d, want 2", len(ls.Palette))
	}
	if ls.Palette[0].Name != "minecraft:bone_block" || ls.Palette[0].Properties["axis"] != "y" {
		t.Errorf("Palette[0] = %+v, want Name=minecraft:bone_block Properties[axis]=y", ls.Palette[0])
	}
	if ls.Palette[1].Properties["axis"] != "x" {
		t.Errorf("Palette[1].Properties[axis] = %v, want x", ls.Palette[1].Properties["axis"])
	}
	if len(ls.Blocks) != 2 {
		t.Fatalf("len(Blocks) = %d, want 2", len(ls.Blocks))
	}
	if ls.Blocks[0].Pos != (Vec3Int{0, 0, 0}) || ls.Blocks[0].State != 0 {
		t.Errorf("Blocks[0] = %+v, want {Pos:{0 0 0} State:0}", ls.Blocks[0])
	}
	if ls.Blocks[1].Pos != (Vec3Int{1, 2, 3}) || ls.Blocks[1].State != 1 {
		t.Errorf("Blocks[1] = %+v, want {Pos:{1 2 3} State:1}", ls.Blocks[1])
	}
}

func TestReadNbtBigEndianGzip_RejectsNonCompoundRoot(t *testing.T) {
	w := &beWriter{}
	w.u8(byte(TagInt)) // not a compound
	w.str("")
	w.i32(1)
	var gz bytes.Buffer
	gw := gzip.NewWriter(&gz)
	gw.Write(w.buf.Bytes())
	gw.Close()

	if _, _, err := ReadNbtBigEndianGzip(gz.Bytes()); err == nil {
		t.Fatal("expected an error for a non-Compound root, got nil")
	}
}

func TestReadNbtBigEndianGzip_RejectsNonGzipInput(t *testing.T) {
	if _, _, err := ReadNbtBigEndianGzip([]byte{0x0A, 0x00, 0x00}); err == nil {
		t.Fatal("expected an error for non-gzip input, got nil")
	}
}

// ---------------------------------------------------------------------------
// Real vanilla data -- [FORMAT-VERIFIED], see legacy.go's header. Skips
// cleanly when the vanilla files aren't available locally, the same
// convention internal/gencolors's realTextureRoot uses for its own external,
// unvendored asset dependency.
// ---------------------------------------------------------------------------

// fossilStructuresRoot is a directory of vanilla .mcstructure files, which this
// repository does not vendor -- they are Mojang's. Point
// FEATURELAB_FOSSIL_STRUCTURES at an extracted
// behavior_packs/vanilla/structures/fossils to run these; unset, they skip.
var fossilStructuresRoot = os.Getenv("FEATURELAB_FOSSIL_STRUCTURES")

var realFossilFileNames = []string{
	"fossil_spine_01", "fossil_spine_02", "fossil_spine_03", "fossil_spine_04",
	"fossil_skull_01", "fossil_skull_02", "fossil_skull_03", "fossil_skull_04",
}

func realFossilStructuresRoot(t *testing.T) string {
	t.Helper()
	if info, err := os.Stat(fossilStructuresRoot); err != nil || !info.IsDir() {
		t.Skipf("pack not available at %s: %v", fossilStructuresRoot, err)
	}
	return fossilStructuresRoot
}

// TestParseLegacyStructure_RealVanillaFiles parses all eight real vanilla fossil structure files
// and checks the shape this package's own header claims: bone_block-
// only palettes, every palette entry has an axis property in x/y/z, sizes fit under 16 on X and Z.
func TestParseLegacyStructure_RealVanillaFiles(t *testing.T) {
	dir := realFossilStructuresRoot(t)
	for _, name := range realFossilFileNames {
		name := name
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(dir + `\` + name + ".nbt")
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			ls, err := ParseLegacyStructure(data)
			if err != nil {
				t.Fatalf("ParseLegacyStructure: %v", err)
			}
			if ls.Size.X <= 0 || ls.Size.Y <= 0 || ls.Size.Z <= 0 {
				t.Fatalf("size %+v has a non-positive dimension", ls.Size)
			}
			if ls.Size.X >= 16 || ls.Size.Z >= 16 {
				t.Errorf("size %+v has X or Z >= 16 -- would break the engine's own nextInt(16-size) draw", ls.Size)
			}
			if len(ls.Blocks) == 0 {
				t.Fatal("0 blocks parsed")
			}
			for i, p := range ls.Palette {
				if p.Name != "minecraft:bone_block" {
					t.Errorf("palette[%d].Name = %q, want minecraft:bone_block", i, p.Name)
				}
				axis, ok := p.Properties["axis"].(string)
				if !ok || (axis != "x" && axis != "y" && axis != "z") {
					t.Errorf("palette[%d].Properties[axis] = %#v, want one of x/y/z", i, p.Properties["axis"])
				}
			}
			for i, b := range ls.Blocks {
				if b.State < 0 || b.State >= len(ls.Palette) {
					t.Errorf("blocks[%d].State = %d out of range for a %d-entry palette", i, b.State, len(ls.Palette))
				}
			}
			t.Logf("%s: size=%+v palette=%d blocks=%d", name, ls.Size, len(ls.Palette), len(ls.Blocks))
		})
	}
}
