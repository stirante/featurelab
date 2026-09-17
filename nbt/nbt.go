// Package nbt is a minimal little-endian, uncompressed Bedrock NBT reader,
// plus a `.mcstructure` parser built on top of it.
//
// The shape here comes from parsing real `.mcstructure` files produced by
// the game, read-only, and cross-checking every file's tag stream
// byte-for-byte, plus the format's well-known public shape (used identically
// by every third-party Bedrock structure tool). "[FORMAT-VERIFIED]" in this
// package means "checked against real files".
//
// This is intentionally NOT a general-purpose NBT library: only the tag
// types actually observed (or trivially adjacent) are implemented, there is
// no writer, and there is no gzip/zlib framing support — `.mcstructure`
// files are raw, uncompressed tag streams (every checked file's first byte is
// 0x0A, TAG_Compound, not a gzip magic).
package nbt

import (
	"encoding/binary"
	"fmt"
	"math"
)

// TagType is one NBT tag's type byte.
type TagType byte

const (
	TagEnd       TagType = 0
	TagByte      TagType = 1
	TagShort     TagType = 2
	TagInt       TagType = 3
	TagLong      TagType = 4
	TagFloat     TagType = 5
	TagDouble    TagType = 6
	TagByteArray TagType = 7
	TagString    TagType = 8
	TagList      TagType = 9
	TagCompound  TagType = 10
	TagIntArray  TagType = 11
	TagLongArray TagType = 12
)

// Compound is a decoded TAG_Compound: name -> value. Values are one of:
// float64 (Byte/Short/Int/Float/Double all collapse into this one numeric
// type), int64 (Long, deliberately kept distinct from float64 so a 64-bit
// value survives exactly), string (String), []int8 (ByteArray), []int32
// (IntArray), []int64 (LongArray), []any (List), or Compound (nested).
type Compound map[string]any

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

// reader reads primitive NBT payloads in a configurable byte order. order is
// binary.ByteOrder so the SAME reader/readPayload logic below serves both
// this package's original little-endian, uncompressed `.mcstructure` format
// AND the big-endian, gzip-framed legacy Java-style structure format added
// in legacy.go (see that file's doc comment for why the two formats share
// this reader instead of legacy.go reimplementing tag parsing itself). A
// zero-value reader (order == nil) is never constructed directly -- every
// entry point below (ReadNbt, readLegacyNbt) sets order explicitly.
type reader struct {
	data   []byte
	offset int
	order  binary.ByteOrder
}

func (r *reader) u8() byte {
	v := r.data[r.offset]
	r.offset++
	return v
}

func (r *reader) i16() int16 {
	v := int16(r.order.Uint16(r.data[r.offset:]))
	r.offset += 2
	return v
}

func (r *reader) i32() int32 {
	v := int32(r.order.Uint32(r.data[r.offset:]))
	r.offset += 4
	return v
}

func (r *reader) i64() int64 {
	v := int64(r.order.Uint64(r.data[r.offset:]))
	r.offset += 8
	return v
}

func (r *reader) f32() float32 {
	v := math.Float32frombits(r.order.Uint32(r.data[r.offset:]))
	r.offset += 4
	return v
}

func (r *reader) f64() float64 {
	v := math.Float64frombits(r.order.Uint64(r.data[r.offset:]))
	r.offset += 8
	return v
}

// str reads an NBT string: length-prefixed (u16, in the reader's own byte
// order) bytes, never null-terminated. Decoded as plain UTF-8 -- Java NBT
// technically uses "Modified UTF-8", which differs from standard UTF-8 only
// for embedded NUL bytes and characters outside the Basic Multilingual
// Plane, neither of which any block/property name in this format uses.
func (r *reader) str() string {
	n := int(r.order.Uint16(r.data[r.offset:]))
	r.offset += 2
	b := r.data[r.offset : r.offset+n]
	r.offset += n
	return string(b)
}

func readPayload(r *reader, t TagType) any {
	switch t {
	case TagByte:
		return float64(int8(r.u8())) // sign-extend to a normal numeric value
	case TagShort:
		return float64(r.i16())
	case TagInt:
		return float64(r.i32())
	case TagLong:
		return r.i64()
	case TagFloat:
		return float64(r.f32())
	case TagDouble:
		return r.f64()
	case TagByteArray:
		n := int(r.i32())
		out := make([]int8, n)
		for i := range out {
			out[i] = int8(r.u8())
		}
		return out
	case TagString:
		return r.str()
	case TagList:
		elemType := TagType(r.u8())
		n := int(r.i32())
		// elemType is only End for a genuinely empty list (n == 0 in every
		// real encoder) -- the loop body below is unreachable when
		// elemType == End, but readPayload has no End case, so guard it
		// explicitly rather than assert.
		out := make([]any, n)
		for i := 0; i < n; i++ {
			if elemType == TagEnd {
				panic(fmt.Errorf("nbt: non-empty TAG_List with element type End"))
			}
			out[i] = readPayload(r, elemType)
		}
		return out
	case TagCompound:
		out := make(Compound)
		for {
			tt := TagType(r.u8())
			if tt == TagEnd {
				break
			}
			name := r.str()
			out[name] = readPayload(r, tt)
		}
		return out
	case TagIntArray:
		n := int(r.i32())
		out := make([]int32, n)
		for i := range out {
			out[i] = r.i32()
		}
		return out
	case TagLongArray:
		n := int(r.i32())
		out := make([]int64, n)
		for i := range out {
			out[i] = r.i64()
		}
		return out
	default:
		panic(fmt.Errorf("nbt: unsupported tag type %d at byte offset %d", t, r.offset))
	}
}

// ReadNbt parses one root TAG_Compound from a little-endian, uncompressed
// NBT byte stream. Malformed input (truncated data, an unsupported tag, a
// non-Compound root) is reported as an error rather than a panic escaping
// to the caller.
func ReadNbt(data []byte) (name string, value Compound, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			if e, ok := rec.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("nbt: %v", rec)
			}
		}
	}()
	r := &reader{data: data, order: binary.LittleEndian}
	rootType := TagType(r.u8())
	if rootType != TagCompound {
		return "", nil, fmt.Errorf("nbt: expected a root TAG_Compound (10), got tag type %d", rootType)
	}
	name = r.str()
	value = readPayload(r, TagCompound).(Compound)
	return name, value, nil
}

// ---------------------------------------------------------------------------
// .mcstructure
// ---------------------------------------------------------------------------

// Vec3Int is an integer 3-vector, e.g. a structure's size or world origin.
type Vec3Int struct{ X, Y, Z int }

// BlockState is one `structure.palette.default.block_palette` entry.
type BlockState struct {
	Name string
	// States values are string or float64 -- NBT block-state values are
	// typed per Bedrock's own convention (booleans as TAG_Byte, integers as
	// TAG_Int, enum-like values as TAG_String) but are reproduced verbatim
	// here rather than coerced to bool: stateValue never returns a boolean,
	// only a string or a float64.
	States map[string]any
}

// ParsedMcStructure is a parsed `.mcstructure` file's contents.
// [FORMAT-VERIFIED] against real files -- see the package doc comment.
type ParsedMcStructure struct {
	Size                 Vec3Int
	StructureWorldOrigin Vec3Int
	// Palette is `structure.palette.default.block_palette`, index-addressed.
	Palette []BlockState
	// Layer0 is `structure.block_indices[0]` -- the primary block layer,
	// index-addressed the same way as Palette. -1 means "no block here" (a
	// void cell -- `.mcstructure`'s convention for "don't touch this cell on
	// placement", distinct from an explicit air block). Linearized
	// x*(sizeY*sizeZ) + y*sizeZ + z -- the publicly documented
	// `.mcstructure` iteration order (X outermost, then Y, then Z),
	// self-consistent with every checked
	// file's block_indices length equalling size.x*size.y*size.z exactly.
	Layer0 []int32
	// Layer1 is `structure.block_indices[1]` -- the secondary/waterlogging
	// layer, same indexing and -1 convention as Layer0. Present in every
	// checked file even when unused (all -1).
	Layer1 []int32
}

func asCompound(v any, path string) (Compound, error) {
	c, ok := v.(Compound)
	if !ok {
		return nil, fmt.Errorf("mcstructure: %s must be a Compound", path)
	}
	return c, nil
}

func asList(v any, path string) ([]any, error) {
	l, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("mcstructure: %s must be a List", path)
	}
	return l, nil
}

func asInt(v any, path string) (int, error) {
	f, ok := v.(float64)
	if !ok {
		return 0, fmt.Errorf("mcstructure: %s must be a numeric tag", path)
	}
	return int(f), nil
}

func asString(v any, path string) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("mcstructure: %s must be a String", path)
	}
	return s, nil
}

// stateValue normalises one decoded block-state value: strings pass through,
// numeric tags (float64) pass through, Long (int64) converts to float64 --
// nothing else is a legal block-state value.
func stateValue(v any) (any, error) {
	switch x := v.(type) {
	case string:
		return x, nil
	case float64:
		return x, nil
	case int64:
		return float64(x), nil
	default:
		return nil, fmt.Errorf("mcstructure: unexpected block-state value type %T", v)
	}
}

func vec3Int(v any, path string) (Vec3Int, error) {
	list, err := asList(v, path)
	if err != nil {
		return Vec3Int{}, err
	}
	if len(list) != 3 {
		return Vec3Int{}, fmt.Errorf("mcstructure: %s must have exactly 3 elements", path)
	}
	x, err := asInt(list[0], path+"[0]")
	if err != nil {
		return Vec3Int{}, err
	}
	y, err := asInt(list[1], path+"[1]")
	if err != nil {
		return Vec3Int{}, err
	}
	z, err := asInt(list[2], path+"[2]")
	if err != nil {
		return Vec3Int{}, err
	}
	return Vec3Int{X: x, Y: y, Z: z}, nil
}

func toInt32Array(v any, path string, expectedLength int) ([]int32, error) {
	list, err := asList(v, path)
	if err != nil {
		return nil, err
	}
	if len(list) != expectedLength {
		return nil, fmt.Errorf("mcstructure: %s has %d entries, expected %d", path, len(list), expectedLength)
	}
	out := make([]int32, len(list))
	for i, e := range list {
		// Inline asInt with the "%s[%d]" label built only on failure: the old
		// shape Sprintf'd the label for every element unconditionally, and a
		// structure-heavy pack runs this loop over every cell of every
		// .mcstructure -- measured as the single largest cost of library
		// build. The failure message bytes are identical to asInt's.
		f, ok := e.(float64)
		if !ok {
			return nil, fmt.Errorf("mcstructure: %s[%d] must be a numeric tag", path, i)
		}
		out[i] = int32(f)
	}
	return out, nil
}

// ParseMcStructure parses a raw `.mcstructure` file's bytes into a
// ParsedMcStructure. Returns a descriptive error (never silently drops
// data) on anything not matching the shape every real file in the pack was
// found to have.
func ParseMcStructure(data []byte) (*ParsedMcStructure, error) {
	_, root, err := ReadNbt(data)
	if err != nil {
		return nil, err
	}

	size, err := vec3Int(root["size"], "size")
	if err != nil {
		return nil, err
	}
	structureWorldOrigin, err := vec3Int(root["structure_world_origin"], "structure_world_origin")
	if err != nil {
		return nil, err
	}
	cellCount := size.X * size.Y * size.Z

	structure, err := asCompound(root["structure"], "structure")
	if err != nil {
		return nil, err
	}
	blockIndices, err := asList(structure["block_indices"], "structure.block_indices")
	if err != nil {
		return nil, err
	}
	if len(blockIndices) != 2 {
		return nil, fmt.Errorf("mcstructure: structure.block_indices must have exactly 2 layers, got %d", len(blockIndices))
	}
	layer0, err := toInt32Array(blockIndices[0], "structure.block_indices[0]", cellCount)
	if err != nil {
		return nil, err
	}
	layer1, err := toInt32Array(blockIndices[1], "structure.block_indices[1]", cellCount)
	if err != nil {
		return nil, err
	}

	paletteRoot, err := asCompound(structure["palette"], "structure.palette")
	if err != nil {
		return nil, err
	}
	defaultPalette, err := asCompound(paletteRoot["default"], "structure.palette.default")
	if err != nil {
		return nil, err
	}
	blockPaletteList, err := asList(defaultPalette["block_palette"], "structure.palette.default.block_palette")
	if err != nil {
		return nil, err
	}

	palette := make([]BlockState, len(blockPaletteList))
	for i, entry := range blockPaletteList {
		path := fmt.Sprintf("structure.palette.default.block_palette[%d]", i)
		c, err := asCompound(entry, path)
		if err != nil {
			return nil, err
		}
		name, err := asString(c["name"], path+".name")
		if err != nil {
			return nil, err
		}
		states := make(map[string]any)
		if statesTag, ok := c["states"]; ok {
			statesCompound, err := asCompound(statesTag, path+".states")
			if err != nil {
				return nil, err
			}
			for k, v := range statesCompound {
				sv, err := stateValue(v)
				if err != nil {
					return nil, err
				}
				states[k] = sv
			}
		}
		palette[i] = BlockState{Name: name, States: states}
	}

	return &ParsedMcStructure{
		Size:                 size,
		StructureWorldOrigin: structureWorldOrigin,
		Palette:              palette,
		Layer0:               layer0,
		Layer1:               layer1,
	}, nil
}
