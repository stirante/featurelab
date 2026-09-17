// Package structures loads `.mcstructure` files (via featurelab-go/nbt) into
// a lookup keyed by `structure_name` (the string
// `minecraft:structure_template_feature`'s JSON uses, e.g.
// `"wiki:giant_lily_bud_open_f"`), and resolves each entry's block
// palette against a shared block.Palette so features/structure_template.go
// only ever deals in interned block.IDs, the same contract every other
// feature builder already has.
//
// Mirrors featurelab-go/features's registry.go / Library shape and its diagnostics
// convention deliberately, since this is the same kind of "external file ->
// in-memory asset, keyed by an id derived from its path" loader.
package structures

import (
	"fmt"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/nbt"
)

// SourceFile is a structures/*.mcstructure file as delivered by the pack
// loader, or read directly from disk in tests.
type SourceFile struct {
	// ID is the path relative to the structures root, POSIX separators,
	// including the .mcstructure extension -- mirrors features.SourceFile's
	// ID convention exactly.
	ID      string
	AbsPath string
	Data    []byte
}

// Diagnostic is one structure-loading error.
type Diagnostic struct {
	Level   string // "error"
	FileID  string
	Message string
}

// ResolvedStructure is a parsed structure with its block palette already
// interned into the shared block.Palette -- every cell value below is a
// ready-to-place block.ID.
type ResolvedStructure struct {
	Size nbt.Vec3Int
	// PaletteIDs is one block.ID per palette entry, index-addressed the
	// same way as Layer0/Layer1.
	PaletteIDs []block.ID
	// Layer0 is the primary block layer, linearized x*(sizeY*sizeZ) +
	// y*sizeZ + z (see nbt.ParsedMcStructure.Layer0's doc comment). -1 = a
	// void cell (skip on placement).
	Layer0 []int32
	// Layer1 is the secondary/waterlogging layer, same indexing/void
	// convention as Layer0. Not consumed by structure_template.go yet (no
	// evidence any placed block needs the waterlogging layer
	// specifically) but resolved here so it's available without a second
	// pass over the palette if that changes.
	Layer1 []int32
}

// IResolver resolves a structure_name to its parsed/interned data.
type IResolver interface {
	Resolve(structureName string) *ResolvedStructure
}

// noStructures is a resolver with no structures loaded -- the default when
// a caller doesn't pass one. Every Resolve call cleanly reports "not found"
// rather than needing a nil check at every call site.
type noStructures struct{}

func (noStructures) Resolve(string) *ResolvedStructure { return nil }

// NoStructures is the zero-structures resolver -- see noStructures.
var NoStructures IResolver = noStructures{}

// fileIDToStructureName maps "wiki/giant_lily_bud_open_f.mcstructure"
// -> "wiki:giant_lily_bud_open_f", matching Bedrock's own
// structures/<namespace>/<path>.mcstructure <-> namespace:path convention
// (packs conventionally place structures directly under a single
// pack-namespace folder, consistent with this mapping). Only the FIRST path separator becomes the namespace colon --
// nested paths keep their /s, as Bedrock structure names allow
// multi-segment paths after the namespace.
func fileIDToStructureName(id string) string {
	withoutExt := id
	if strings.HasSuffix(strings.ToLower(id), ".mcstructure") {
		withoutExt = id[:len(id)-len(".mcstructure")]
	}
	slash := strings.Index(withoutExt, "/")
	if slash == -1 {
		return withoutExt
	}
	return withoutExt[:slash] + ":" + withoutExt[slash+1:]
}

// Library is a resolvable set of loaded structures -- both `.mcstructure` (IResolver, namespaced
// keys) and legacy `.nbt` (ILegacyResolver, unnamespaced keys -- see legacy.go) live in the same
// Library, built from the same []SourceFile list, since a real behaviour pack's structures/
// directory holds both kinds side by side.
type Library struct {
	Diagnostics []Diagnostic
	byName      map[string]*ResolvedStructure
	legacyByKey map[string]*ResolvedLegacyStructure
}

// Resolve implements IResolver.
func (l *Library) Resolve(structureName string) *ResolvedStructure {
	if l == nil {
		return nil
	}
	return l.byName[structureName]
}

// ResolveLegacy implements ILegacyResolver -- see legacy.go's own doc comment for why this is a
// separate interface/method rather than folded into Resolve.
func (l *Library) ResolveLegacy(key string) *ResolvedLegacyStructure {
	if l == nil {
		return nil
	}
	return l.legacyByKey[key]
}

var _ IResolver = (*Library)(nil)
var _ ILegacyResolver = (*Library)(nil)

// BuildLibrary parses every supplied `.mcstructure` OR legacy `.nbt` file once (a file matching
// neither extension is silently skipped, same as before this format was added) and interns
// `.mcstructure` palettes into palette. A file that fails to parse is skipped with a diagnostic
// (mirrors features.BuildLibrary's per-file try/catch) rather than aborting the whole batch.
// Legacy `.nbt` palettes are deliberately NOT interned here -- see LegacyPaletteEntry's own doc
// comment for why that has to wait for features/fossil.go's own per-placement axis remap.
func BuildLibrary(files []SourceFile, palette *block.Palette) *Library {
	var diags []Diagnostic
	byName := make(map[string]*ResolvedStructure)
	legacyByKey := make(map[string]*ResolvedLegacyStructure)

	for _, f := range files {
		lowerID := strings.ToLower(f.ID)
		switch {
		case strings.HasSuffix(lowerID, ".mcstructure"):
			parsed, err := nbt.ParseMcStructure(f.Data)
			if err != nil {
				diags = append(diags, Diagnostic{Level: "error", FileID: f.ID, Message: err.Error()})
				continue
			}
			paletteIDs := make([]block.ID, len(parsed.Palette))
			for i, entry := range parsed.Palette {
				var states map[string]block.StateValue
				if len(entry.States) > 0 {
					states = make(map[string]block.StateValue, len(entry.States))
					for k, v := range entry.States {
						states[k] = v
					}
				}
				paletteIDs[i] = palette.Resolve(block.Descriptor{Name: entry.Name, States: states})
			}
			name := fileIDToStructureName(f.ID)
			if _, exists := byName[name]; exists {
				diags = append(diags, Diagnostic{Level: "error", FileID: f.ID, Message: fmt.Sprintf("structure name %q is declared in more than one file", name)})
				continue
			}
			byName[name] = &ResolvedStructure{Size: parsed.Size, PaletteIDs: paletteIDs, Layer0: parsed.Layer0, Layer1: parsed.Layer1}

		case strings.HasSuffix(lowerID, ".nbt"):
			parsed, err := nbt.ParseLegacyStructure(f.Data)
			if err != nil {
				diags = append(diags, Diagnostic{Level: "error", FileID: f.ID, Message: err.Error()})
				continue
			}
			key := fileIDToLegacyKey(f.ID)
			if _, exists := legacyByKey[key]; exists {
				diags = append(diags, Diagnostic{Level: "error", FileID: f.ID, Message: fmt.Sprintf("legacy structure key %q is declared in more than one file", key)})
				continue
			}
			legacyByKey[key] = &ResolvedLegacyStructure{
				Size:    parsed.Size,
				Palette: legacyPropertiesFrom(parsed.Palette),
				Blocks:  legacyBlocksFrom(parsed.Blocks),
			}
		}
	}

	return &Library{Diagnostics: diags, byName: byName, legacyByKey: legacyByKey}
}
