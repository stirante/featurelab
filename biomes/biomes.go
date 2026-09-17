// Package biomes loads a behaviour pack's own `biomes/*.biome.json`
// (`minecraft:biome`) definitions into an in-memory library, keyed by
// `description.identifier`, under the per-file failure-and-continue
// diagnostics convention -- the same "external file -> in-memory asset"
// shape featurelab-go/features and featurelab-go/structures already use.
//
// Only the components this tool actually consumes are parsed:
//   - `minecraft:surface_builder` -> MaterialSlots — feeds the "material
//     slots -> terrain builder" pipeline (featurelab-go/env) so a session
//     can build real terrain out of a biome's own materials instead of only
//     a synthetic preset's; this
//     package only produces the MaterialSlots value; wiring it into an
//     environment builder is a session-level concern, deliberately left
//     out of this package's surface (see this package's own doc for why).
//   - `minecraft:climate` -> read-only informational data.
//   - `minecraft:tags` -> the biome's query.has_biome_tag/any_tag/all_tags
//     identity (see wgen.MolangBiome), the same role
//     session.Config.BiomeOverride plays manually.
//   - `minecraft:replace_biomes` -> informational only.
//
// Every OTHER component (there are dozens in a real biome file — mob
// spawning, fog, ambient sounds, etc.) is silently ignored, not rejected: a
// real pack's `.biome.json` will always carry components this tool has no
// use for, and the file must still load.
package biomes

import (
	"encoding/json"
	"fmt"

	"github.com/stirante/featurelab/jsonc"
)

// SourceFile is a biomes/*.json file as delivered by the pack loader — the
// same shape features.SourceFile/structures.SourceFile use, different root
// key.
type SourceFile struct {
	ID      string
	AbsPath string
	Text    string
}

// Diagnostic is this package's own diagnostic type — deliberately distinct
// from featurelab-go/features's Diagnostic even though the shape is
// identical, unlike featurelab-go/rules, which reuses that one (see
// rules.go's own doc comment).
type Diagnostic struct {
	Level   string // "error" | "warning"
	FileID  string
	Message string
}

// Climate is a biome's minecraft:climate component. A nil pointer field
// means the biome declares no value for it. JSON tags are explicit
// lowerCamelCase --
// this type crosses the wire directly (session.Result.EnvironmentBiome/
// BiomeEntries[].Biome.Climate), so an untagged field here would silently
// serialize under Go's exported-field capitalization instead (the same
// wgen.BlockPos/block.Entry defect this package's own tags now avoid).
type Climate struct {
	Temperature      *float64    `json:"temperature"`
	SnowAccumulation *[2]float64 `json:"snowAccumulation"`
	Downfall         *float64    `json:"downfall"`
}

// Replacement is one entry of `minecraft:replace_biomes.replacements`.
// See Climate's doc comment for
// why every field here is explicitly, lowerCamelCase JSON-tagged.
type Replacement struct {
	Targets             []string `json:"targets"`
	Dimension           *string  `json:"dimension"`
	Amount              *float64 `json:"amount"`
	NoiseFrequencyScale *float64 `json:"noiseFrequencyScale"`
}

// MaterialSlots is the six fields Bedrock's `minecraft:surface_builder`
// component exposes — the same six env.MaterialSlots carries (see that
// type's doc comment for the full "material slots -> terrain builder"
// pipeline this feeds). Deliberately declared HERE, not imported from an
// env-style package: it is a plain data shape with no behaviour of its own (uninterned block-name strings — interning
// into a real block.ID happens downstream, in whatever builds terrain from
// it), and this package must stay independent of any one terrain-building
// implementation so a session can map these fields onto its own environment
// representation. See Climate's doc comment for why every field here is
// explicitly, lowerCamelCase JSON-tagged.
type MaterialSlots struct {
	TopMaterial        string  `json:"topMaterial"`
	MidMaterial        string  `json:"midMaterial"`
	FoundationMaterial string  `json:"foundationMaterial"`
	SeaFloorMaterial   string  `json:"seaFloorMaterial"`
	SeaMaterial        string  `json:"seaMaterial"`
	SeaFloorDepth      float64 `json:"seaFloorDepth"`
}

// ResolvedBiome is one fully parsed biome. See Climate's doc comment
// for why every field here is explicitly, lowerCamelCase JSON-tagged --
// this is the type session.Result.EnvironmentBiome/BiomeEntries[].Biome
// exposes directly on the wire (see wire.GenerateOutput's own doc comment).
type ResolvedBiome struct {
	Identifier string `json:"identifier"`
	FileID     string `json:"fileId"`
	// Tags is minecraft:tags, exactly as declared — see wgen.MolangBiome /
	// EnvironmentPreset.biomeTags.
	Tags []string `json:"tags"`
	// SurfaceBuilder is minecraft:surface_builder, resolved to the six
	// fields a terrain builder consumes. Nil when the biome declares no
	// minecraft:surface_builder component at all.
	SurfaceBuilder *MaterialSlots `json:"surfaceBuilder"`
	// SurfaceBuilderType is the surface builder's declared `type` (e.g.
	// "minecraft:overworld"), kept alongside SurfaceBuilder for display
	// only: this tool's terrain layering is applied uniformly to any builder
	// type.
	SurfaceBuilderType *string       `json:"surfaceBuilderType"`
	Climate            *Climate      `json:"climate"`
	ReplaceBiomes      []Replacement `json:"replaceBiomes"`
}

// Entry is one parsed (or failed-to-parse) biome file. Biome is nil when
// the file failed to parse/build. See
// Climate's doc comment for why every field here is explicitly,
// lowerCamelCase JSON-tagged.
type Entry struct {
	FileID     string         `json:"fileId"`
	Identifier string         `json:"identifier"`
	Biome      *ResolvedBiome `json:"biome"`
}

// Library is a resolvable set of parsed biomes.
type Library struct {
	Entries      []Entry
	Diagnostics  []Diagnostic
	byIdentifier map[string]*ResolvedBiome
}

// Resolve returns the biome declared under identifier, or nil.
func (l *Library) Resolve(identifier string) *ResolvedBiome {
	if l == nil {
		return nil
	}
	return l.byIdentifier[identifier]
}

func asStringDefault(v any, def string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return def
}

func asNumberDefault(v any, def float64) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return def
}

// parseSurfaceBuilder reads a minecraft:surface_builder component:
// unrecognized/missing fields fall back to minecraft:stone/minecraft:water/0 rather than
// failing — a biome missing one field (e.g. no sea_floor_material) is still
// usable, just with a plain default for that one slot.
func parseSurfaceBuilder(raw any) (*MaterialSlots, *string) {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, nil
	}
	b, ok := obj["builder"].(map[string]any)
	if !ok {
		return nil, nil
	}
	slots := &MaterialSlots{
		TopMaterial:        asStringDefault(b["top_material"], "minecraft:stone"),
		MidMaterial:        asStringDefault(b["mid_material"], "minecraft:stone"),
		FoundationMaterial: asStringDefault(b["foundation_material"], "minecraft:stone"),
		SeaFloorMaterial:   asStringDefault(b["sea_floor_material"], "minecraft:gravel"),
		SeaMaterial:        asStringDefault(b["sea_material"], "minecraft:water"),
		SeaFloorDepth:      asNumberDefault(b["sea_floor_depth"], 0),
	}
	var builderType *string
	if s, ok := b["type"].(string); ok {
		builderType = &s
	}
	return slots, builderType
}

func parseClimate(raw any) *Climate {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	climate := &Climate{}
	if f, ok := obj["temperature"].(float64); ok {
		climate.Temperature = &f
	}
	if arr, ok := obj["snow_accumulation"].([]any); ok && len(arr) == 2 {
		if a, ok := arr[0].(float64); ok {
			if bb, ok := arr[1].(float64); ok {
				climate.SnowAccumulation = &[2]float64{a, bb}
			}
		}
	}
	if f, ok := obj["downfall"].(float64); ok {
		climate.Downfall = &f
	}
	return climate
}

func parseReplaceBiomes(raw any) []Replacement {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	replacementsRaw, ok := obj["replacements"].([]any)
	if !ok {
		return nil
	}
	out := make([]Replacement, 0, len(replacementsRaw))
	for _, item := range replacementsRaw {
		e, ok := item.(map[string]any)
		if !ok {
			continue
		}
		var targets []string
		if arr, ok := e["targets"].([]any); ok {
			for _, t := range arr {
				if s, ok := t.(string); ok {
					targets = append(targets, s)
				}
			}
		}
		rep := Replacement{Targets: targets}
		if s, ok := e["dimension"].(string); ok {
			rep.Dimension = &s
		}
		if f, ok := e["amount"].(float64); ok {
			rep.Amount = &f
		}
		if f, ok := e["noise_frequency_scale"].(float64); ok {
			rep.NoiseFrequencyScale = &f
		}
		out = append(out, rep)
	}
	return out
}

// parseTags reads a minecraft:tags component. Real pack files contain stray
// blank array slots (a real biome file's minecraft:tags.tags with several
// empty/null positions, apparently from whatever generated it) -- filtered
// rather than kept as
// empty-string tags. JSON `null` array entries decode to a nil interface{}
// in Go, which the `t.(string)` type assertion below already rejects, so no
// separate nil check is needed.
func parseTags(raw any) []string {
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	arr, ok := obj["tags"].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, t := range arr {
		if s, ok := t.(string); ok && len(s) > 0 {
			out = append(out, s)
		}
	}
	return out
}

func parseBiomeFile(f SourceFile, diags *[]Diagnostic) *Entry {
	var raw any
	if err := json.Unmarshal(jsonc.StripComments([]byte(f.Text)), &raw); err != nil {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: "invalid JSON: " + err.Error()})
		return nil
	}
	root, ok := raw.(map[string]any)
	if !ok {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: "root must be an object"})
		return nil
	}
	body, ok := root["minecraft:biome"].(map[string]any)
	if !ok {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: `"minecraft:biome" must be an object`})
		return nil
	}
	description, _ := body["description"].(map[string]any)
	var identifier string
	if description != nil {
		identifier, _ = description["identifier"].(string)
	}
	if identifier == "" {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: "description.identifier is missing"})
		return nil
	}

	components, _ := body["components"].(map[string]any)
	surfaceBuilder, surfaceBuilderType := parseSurfaceBuilder(components["minecraft:surface_builder"])

	biome := &ResolvedBiome{
		Identifier:         identifier,
		FileID:             f.ID,
		Tags:               parseTags(components["minecraft:tags"]),
		SurfaceBuilder:     surfaceBuilder,
		SurfaceBuilderType: surfaceBuilderType,
		Climate:            parseClimate(components["minecraft:climate"]),
		ReplaceBiomes:      parseReplaceBiomes(components["minecraft:replace_biomes"]),
	}
	return &Entry{FileID: f.ID, Identifier: identifier, Biome: biome}
}

// BuildLibrary builds every biome in files as one library, under the
// per-file failure-and-continue convention: parseBiomeFile only ever fails
// via the diagnostic-and-nil-return path above, so one bad file never stops
// the rest from loading.
func BuildLibrary(files []SourceFile) *Library {
	var diagnostics []Diagnostic
	var entries []Entry
	byIdentifier := make(map[string]*ResolvedBiome)

	for _, f := range files {
		entry := parseBiomeFile(f, &diagnostics)
		if entry == nil {
			continue
		}
		entries = append(entries, *entry)
		if entry.Biome != nil {
			if _, exists := byIdentifier[entry.Identifier]; exists {
				diagnostics = append(diagnostics, Diagnostic{
					Level:   "warning",
					FileID:  entry.FileID,
					Message: fmt.Sprintf("identifier %q is declared in more than one file", entry.Identifier),
				})
			} else {
				byIdentifier[entry.Identifier] = entry.Biome
			}
		}
	}

	return &Library{Entries: entries, Diagnostics: diagnostics, byIdentifier: byIdentifier}
}

// TagSet converts a ResolvedBiome's Tags into the set shape wgen.MolangBiome
// consumes for query.has_biome_tag/any_tag/all_tags — the join point
// documented in this package's own header. Kept as a tiny, dependency-free
// helper (map[string]struct{}, not a wgen import) so this package doesn't
// have to depend on wgen just to hand its tags to a caller that does.
func (b *ResolvedBiome) TagSet() map[string]struct{} {
	if b == nil {
		return nil
	}
	out := make(map[string]struct{}, len(b.Tags))
	for _, t := range b.Tags {
		out[t] = struct{}{}
	}
	return out
}
