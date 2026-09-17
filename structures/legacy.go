// legacy.go extends this package's `.mcstructure` loading with the second, unrelated structure
// container `minecraft:fossil_feature` reads -- a gzip + big-endian, Java-style structure-block
// NBT file (nbt/legacy.go's ParseLegacyStructure), addressed by an UNNAMESPACED key
// ("fossils/fossil_spine_01", never "ns:fossils/fossil_spine_01" -- see fileIDToLegacyKey below,
// and features/fossil.go's own doc comment for the full behaviour this file only cites). Kept in this package (not a new one) because it is the same shape of problem
// (`.mcstructure`'s already solves): parse an external structure asset once, intern what needs
// interning, and hand back a lookup-by-key resolver a feature builder consults at BuildLibrary
// time -- BuildLibrary below now recognizes BOTH `.mcstructure` and `.nbt` files in the same
// []SourceFile list, exactly mirroring how a real behaviour pack's own structures/ directory holds
// both kinds side by side (`.mcstructure` under a namespaced subfolder, this format directly under
// e.g. `fossils/`).
package structures

import (
	"strings"

	"github.com/stirante/featurelab/nbt"
)

// LegacyPaletteEntry is one `palette` list entry from a legacy structure file, kept UN-interned
// (raw name + properties, not a block.ID) -- unlike ResolvedStructure.PaletteIDs above. This
// format's only real user, fossil_feature's bone_block/axis palette, needs the axis PROPERTY
// remapped per-placement (rotated to match the draw's own rotation -- see features/fossil.go)
// before it can be interned into a concrete block.ID; interning here, before that remap exists,
// would bake in the WRONG (unrotated) axis for 3 of every 4 draws. Properties values mirror
// nbt.LegacyPaletteEntry's own domain (string or float64 -- see nbt/legacy.go's legacyStateValue).
type LegacyPaletteEntry struct {
	Name       string
	Properties map[string]any
}

// LegacyBlockRef is one `blocks` list entry: a local position plus an index into
// ResolvedLegacyStructure.Palette (mirrors nbt.LegacyBlockEntry.State exactly -- see that type's
// own doc comment for why the real file's misleadingly-named `state` field is a palette index, not
// a Bedrock block-state id).
type LegacyBlockRef struct {
	Pos     nbt.Vec3Int
	Palette int
}

// ResolvedLegacyStructure is a parsed legacy Java-style structure file (see nbt/legacy.go's own
// doc comment for the on-disk format this was read from, [FORMAT-VERIFIED] against the eight real
// vanilla fossil files).
type ResolvedLegacyStructure struct {
	Size    nbt.Vec3Int
	Palette []LegacyPaletteEntry
	Blocks  []LegacyBlockRef
}

// ILegacyResolver resolves an UNNAMESPACED structure key to its parsed legacy structure data --
// the counterpart of IResolver for THIS format, deliberately a separate interface (not a second
// method bolted onto IResolver) so every existing IResolver implementer -- including a test's own
// minimal hand-written one -- keeps compiling unchanged. A caller that wants both looks up
// ILegacyResolver via a type assertion on whatever IResolver it already has (see
// features/registry.go's BuildLibrary, which does exactly this against the *Library BuildLibrary
// below returns).
type ILegacyResolver interface {
	// ResolveLegacy returns nil when key has no loaded file -- never a zero-value struct standing
	// in for "not found" (mirrors IResolver.Resolve's own nil-means-absent contract).
	ResolveLegacy(key string) *ResolvedLegacyStructure
}

type noLegacyStructures struct{}

func (noLegacyStructures) ResolveLegacy(string) *ResolvedLegacyStructure { return nil }

// NoLegacyStructures is the zero-legacy-structures resolver -- see noStructures/NoStructures above,
// same shape, same reason (every ResolveLegacy call reports "not found" cleanly, no nil-Library
// special case needed at any call site).
var NoLegacyStructures ILegacyResolver = noLegacyStructures{}

// fileIDToLegacyKey strips ONLY the `.nbt` extension -- deliberately NOT
// fileIDToStructureName's "first path separator becomes a namespace colon" transform.
// The game looks a legacy structure up at "<behavior pack>/structures/" plus the name with its
// namespace stripped plus ".nbt": the key is namespace-free ON THE ENGINE'S OWN SIDE already, so
// "fossils/fossil_spine_01.nbt" resolves to "fossils/fossil_spine_01", not
// "fossils:fossil_spine_01".
func fileIDToLegacyKey(id string) string {
	if strings.HasSuffix(strings.ToLower(id), ".nbt") {
		return id[:len(id)-len(".nbt")]
	}
	return id
}

func legacyPropertiesFrom(entries []nbt.LegacyPaletteEntry) []LegacyPaletteEntry {
	out := make([]LegacyPaletteEntry, len(entries))
	for i, e := range entries {
		out[i] = LegacyPaletteEntry{Name: e.Name, Properties: e.Properties}
	}
	return out
}

func legacyBlocksFrom(entries []nbt.LegacyBlockEntry) []LegacyBlockRef {
	out := make([]LegacyBlockRef, len(entries))
	for i, e := range entries {
		out[i] = LegacyBlockRef{Pos: e.Pos, Palette: e.State}
	}
	return out
}
