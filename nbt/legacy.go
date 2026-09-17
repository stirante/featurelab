// legacy.go adds a gzip-framed, big-endian NBT reader alongside nbt.go's
// original little-endian, uncompressed one, plus a parser for the specific
// legacy Java-style structure-file shape `minecraft:fossil_feature` reads --
// see features/fossil.go's own doc comment for the full derivation this
// file only cites.
//
// This does NOT rewrite nbt.go: readPayload/Compound and the reader type's
// primitive readers are all reused verbatim (reader now carries a
// binary.ByteOrder, defaulted to LittleEndian by ReadNbt, set to BigEndian
// here) -- the only new code is the gzip un-framing and this format's own
// root-compound shape (size/palette/blocks/entities/author), which has
// nothing in common with `.mcstructure`'s shape (structure_world_origin,
// structure.block_indices, structure.palette.default.block_palette).
//
// VERIFIED against the eight vanilla fossil structure files
// (fossil_{spine,skull}_0{1..4}.nbt, 12 KB total) -- parsed byte for
// byte, not assumed from a spec. Every one of the eight: gzip magic 1F 8B at
// byte 0; decompressed root is TAG_Compound (0x0A) with a big-endian
// zero-length name; children in file order are `author` (TAG_String,
// "ProfMobius"), `palette` (TAG_List<TAG_Compound>, each `{Name: TAG_String,
// Properties: TAG_Compound}` -- every fossil file's Properties is exactly
// `{axis: TAG_String "x"|"y"|"z"}`, every Name is "minecraft:bone_block"),
// `size` (TAG_List<TAG_Int>, 3 elements), `entities` (TAG_List<TAG_Compound>,
// always empty), `blocks` (TAG_List<TAG_Compound>, each `{pos:
// TAG_List<TAG_Int> [x,y,z], state: TAG_Int}` -- no `nbt` key on any entry in
// any of the eight files, matching the established finding that no fossil
// template block carries block-entity NBT). No DataVersion
// tag. Field ORDER in the file (author, palette, size, entities, blocks) is
// irrelevant to this parser -- Compound is a map, looked up by name, not
// positionally -- but is recorded here since it differs from the field order
// the schema description lists them in (size, author, palette, blocks,
// entities), which was schema-shape, not byte-order, and is
// unaffected by the real order found here.
package nbt

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
)

// ReadNbtBigEndianGzip gunzips data, then parses one root TAG_Compound from
// the decompressed bytes as big-endian NBT (Java's own on-disk convention,
// as opposed to Bedrock's little-endian `.mcstructure`/chunk NBT). Shares
// readPayload/Compound with ReadNbt -- see this file's header.
func ReadNbtBigEndianGzip(data []byte) (name string, value Compound, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			if e, ok := rec.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("nbt: %v", rec)
			}
		}
	}()
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", nil, fmt.Errorf("nbt: gzip: %w", err)
	}
	defer gz.Close()
	raw, err := io.ReadAll(gz)
	if err != nil {
		return "", nil, fmt.Errorf("nbt: gzip: %w", err)
	}

	r := &reader{data: raw, order: binary.BigEndian}
	rootType := TagType(r.u8())
	if rootType != TagCompound {
		return "", nil, fmt.Errorf("nbt: expected a root TAG_Compound (10), got tag type %d", rootType)
	}
	name = r.str()
	value = readPayload(r, TagCompound).(Compound)
	return name, value, nil
}

// ---------------------------------------------------------------------------
// Legacy Java-style structure file (fossil_feature's own structures/*.nbt)
// ---------------------------------------------------------------------------

// LegacyBlockEntry is one `blocks` list entry: a local position plus a
// palette index (`state`, an index into LegacyStructure.Palette -- NOT a
// Bedrock block-state id, despite the misleading field name the real files
// use; every checked file's `state` values are all within [0, len(palette))
// and nothing else fits). NBT is deliberately not modelled: no fossil file's
// `blocks` entries carry one (see this file's header, [FORMAT-VERIFIED]).
type LegacyBlockEntry struct {
	Pos   Vec3Int
	State int
}

// LegacyPaletteEntry is one `palette` list entry. Properties has the same
// value domain as stateValue (string or float64 -- see
// legacyStateValue) even though every real fossil file only ever populates
// it with `axis` -> TAG_String.
type LegacyPaletteEntry struct {
	Name       string
	Properties map[string]any
}

// LegacyStructure is a parsed legacy Java-style structure file's contents --
// [FORMAT-VERIFIED], see this file's header.
type LegacyStructure struct {
	Size    Vec3Int
	Palette []LegacyPaletteEntry
	Blocks  []LegacyBlockEntry
}

func legacyAsCompound(v any, path string) (Compound, error) {
	c, ok := v.(Compound)
	if !ok {
		return nil, fmt.Errorf("legacy structure: %s must be a Compound", path)
	}
	return c, nil
}

func legacyAsList(v any, path string) ([]any, error) {
	l, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("legacy structure: %s must be a List", path)
	}
	return l, nil
}

func legacyAsInt(v any, path string) (int, error) {
	f, ok := v.(float64)
	if !ok {
		return 0, fmt.Errorf("legacy structure: %s must be a numeric tag", path)
	}
	return int(f), nil
}

func legacyAsString(v any, path string) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("legacy structure: %s must be a String", path)
	}
	return s, nil
}

// legacyStateValue mirrors nbt.go's own stateValue for `.mcstructure`
// (string/float64/int64->float64 pass through, nothing else is legal) --
// kept as a SEPARATE function rather than reused directly because it
// operates on this format's own Properties compound, a distinct call site
// with its own error-path naming ("legacy structure:" vs "mcstructure:"),
// even though the underlying value domain is identical.
func legacyStateValue(v any) (any, error) {
	switch x := v.(type) {
	case string:
		return x, nil
	case float64:
		return x, nil
	case int64:
		return float64(x), nil
	default:
		return nil, fmt.Errorf("legacy structure: unexpected property value type %T", v)
	}
}

func legacyVec3Int(v any, path string) (Vec3Int, error) {
	list, err := legacyAsList(v, path)
	if err != nil {
		return Vec3Int{}, err
	}
	if len(list) != 3 {
		return Vec3Int{}, fmt.Errorf("legacy structure: %s must have exactly 3 elements", path)
	}
	x, err := legacyAsInt(list[0], path+"[0]")
	if err != nil {
		return Vec3Int{}, err
	}
	y, err := legacyAsInt(list[1], path+"[1]")
	if err != nil {
		return Vec3Int{}, err
	}
	z, err := legacyAsInt(list[2], path+"[2]")
	if err != nil {
		return Vec3Int{}, err
	}
	return Vec3Int{X: x, Y: y, Z: z}, nil
}

// ParseLegacyStructure parses a raw legacy structure file's bytes (gzip +
// big-endian NBT) into a LegacyStructure. Returns a descriptive error on
// anything not matching the shape every real fossil file was found to have
// (see this file's header) -- never silently drops data.
//
// Only `size`, `palette`, and `blocks` are read. `author` is ignored
// (cosmetic). `entities` is ignored: every
// checked file's own `entities` list is empty, and this port has no
// entity-placement model at all -- see features/fossil.go for the
// LogWarning this omission would need if a non-empty entities list were ever
// observed, which it has not been.
func ParseLegacyStructure(data []byte) (*LegacyStructure, error) {
	_, root, err := ReadNbtBigEndianGzip(data)
	if err != nil {
		return nil, err
	}

	size, err := legacyVec3Int(root["size"], "size")
	if err != nil {
		return nil, err
	}

	paletteList, err := legacyAsList(root["palette"], "palette")
	if err != nil {
		return nil, err
	}
	palette := make([]LegacyPaletteEntry, len(paletteList))
	for i, entry := range paletteList {
		path := fmt.Sprintf("palette[%d]", i)
		c, err := legacyAsCompound(entry, path)
		if err != nil {
			return nil, err
		}
		name, err := legacyAsString(c["Name"], path+".Name")
		if err != nil {
			return nil, err
		}
		props := make(map[string]any)
		if propsTag, ok := c["Properties"]; ok {
			propsCompound, err := legacyAsCompound(propsTag, path+".Properties")
			if err != nil {
				return nil, err
			}
			for k, v := range propsCompound {
				pv, err := legacyStateValue(v)
				if err != nil {
					return nil, err
				}
				props[k] = pv
			}
		}
		palette[i] = LegacyPaletteEntry{Name: name, Properties: props}
	}

	blocksList, err := legacyAsList(root["blocks"], "blocks")
	if err != nil {
		return nil, err
	}
	blocks := make([]LegacyBlockEntry, len(blocksList))
	for i, entry := range blocksList {
		path := fmt.Sprintf("blocks[%d]", i)
		c, err := legacyAsCompound(entry, path)
		if err != nil {
			return nil, err
		}
		pos, err := legacyVec3Int(c["pos"], path+".pos")
		if err != nil {
			return nil, err
		}
		state, err := legacyAsInt(c["state"], path+".state")
		if err != nil {
			return nil, err
		}
		blocks[i] = LegacyBlockEntry{Pos: pos, State: state}
	}

	return &LegacyStructure{Size: size, Palette: palette, Blocks: blocks}, nil
}
