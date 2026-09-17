package genvanillablocks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/jsonc"
)

const colorProvenance = "unvalidated map-colour data"

type Config struct {
	IDsPath      string
	ColorsPath   string
	PalettePath  string
	RPBlocksPath string
	OutputDir    string
}

type Summary struct {
	Blocks          int
	ResourceMatches int
	Colors          int
	AmbiguousColors int
	MissingColorRGB int
}

type extractedIDs struct {
	Names map[string]string `json:"names"`
}

type extractedColors struct {
	NameColor map[string]colorValue `json:"name_color"`
	Ambiguous map[string][]string   `json:"ambiguous"`
}

type colorValue struct {
	Color string `json:"color"`
	RGB   []int  `json:"rgb"`
}

type resourceBlock struct {
	Textures json.RawMessage `json:"textures"`
	Sound    string          `json:"sound"`
}

type aliasMetadata struct {
	Target        string            `json:"target,omitempty"`
	Discriminator string            `json:"discriminator,omitempty"`
	Targets       map[string]string `json:"targets,omitempty"`
}

type statesMetadata struct {
	Status   string `json:"status"`
	Declared bool   `json:"declared"`
	Note     string `json:"note"`
}

type resourceMetadata struct {
	Textures json.RawMessage `json:"textures,omitempty"`
	Sound    string          `json:"sound,omitempty"`
}

type untrustedColorMetadata struct {
	Status              string   `json:"status"`
	Provenance          string   `json:"provenance,omitempty"`
	PaletteName         string   `json:"palette_name,omitempty"`
	RGB                 []int    `json:"rgb,omitempty"`
	RGBUnavailable      bool     `json:"rgb_unavailable,omitempty"`
	Ambiguous           bool     `json:"ambiguous,omitempty"`
	AmbiguousCandidates []string `json:"ambiguous_candidates,omitempty"`
}

type catalogMetadata struct {
	SchemaVersion     int                    `json:"schema_version"`
	Kind              string                 `json:"kind"`
	States            statesMetadata         `json:"states"`
	ResourcePack      *resourceMetadata      `json:"resource_pack,omitempty"`
	Alias             *aliasMetadata         `json:"alias,omitempty"`
	UntrustedMapColor untrustedColorMetadata `json:"untrusted_map_color"`
}

type blockDescription struct {
	Identifier string `json:"identifier"`
}

type blockBody struct {
	Description blockDescription `json:"description"`
	Components  map[string]any   `json:"components"`
}

type generatedBlock struct {
	FormatVersion string          `json:"format_version"`
	Block         blockBody       `json:"minecraft:block"`
	Metadata      catalogMetadata `json:"featurelab:vanilla_block"`
}

func readJSON(path string, dst any, comments bool) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if comments {
		b = jsonc.StripComments(b)
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

func Generate(cfg Config) (Summary, error) {
	var ids extractedIDs
	if err := readJSON(cfg.IDsPath, &ids, false); err != nil {
		return Summary{}, err
	}
	var colors extractedColors
	if err := readJSON(cfg.ColorsPath, &colors, false); err != nil {
		return Summary{}, err
	}
	var palette map[string]json.RawMessage
	if err := readJSON(cfg.PalettePath, &palette, false); err != nil {
		return Summary{}, err
	}
	var rawResources map[string]json.RawMessage
	if err := readJSON(cfg.RPBlocksPath, &rawResources, true); err != nil {
		return Summary{}, err
	}
	delete(rawResources, "format_version")
	resources := make(map[string]resourceBlock, len(rawResources))
	for k, raw := range rawResources {
		var res resourceBlock
		if err := json.Unmarshal(raw, &res); err != nil {
			return Summary{}, fmt.Errorf("resource block %q: %w", k, err)
		}
		resources[k] = res
	}

	if len(ids.Names) == 0 {
		return Summary{}, fmt.Errorf("block id list contains no names")
	}
	seen := make(map[string]string, len(ids.Names))
	for key, id := range ids.Names {
		if previous, ok := seen[id]; ok {
			return Summary{}, fmt.Errorf("duplicate block id %q for %s and %s", id, previous, key)
		}
		seen[id] = key
	}
	if len(palette) != 78 {
		return Summary{}, fmt.Errorf("map-colour palette has %d entries, want 78", len(palette))
	}

	ambiguousByID := make(map[string][]string, len(colors.Ambiguous))
	for key, candidates := range colors.Ambiguous {
		id, ok := ids.Names[key]
		if !ok {
			return Summary{}, fmt.Errorf("ambiguous colour entry %q has no block id", key)
		}
		ambiguousByID[id] = append([]string(nil), candidates...)
	}

	aliases := block.GeneratedAliases()
	reverseSimpleAliases := make(map[string]string)
	for source, alias := range aliases {
		if alias.Target != "" {
			reverseSimpleAliases[alias.Target] = strings.TrimPrefix(source, "minecraft:")
		}
	}

	blockDir := filepath.Join(cfg.OutputDir, "blocks")
	if err := os.MkdirAll(blockDir, 0o755); err != nil {
		return Summary{}, err
	}

	ordered := make([]string, 0, len(seen))
	for id := range seen {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	summary := Summary{Blocks: len(ordered), Colors: len(colors.NameColor), AmbiguousColors: len(ambiguousByID)}
	for _, id := range ordered {
		metadata := catalogMetadata{
			SchemaVersion: 1,
			Kind:          block.GeneratedKindName(block.GeneratedKind(id)),
			States: statesMetadata{
				Status:   "not_catalogued",
				Declared: false,
				Note:     "block states are catalogued separately (block/vanilla_states_table.go); absence here does not mean this block has no states",
			},
			UntrustedMapColor: untrustedColorMetadata{Status: "not_catalogued"},
		}

		resourceKey := strings.TrimPrefix(id, "minecraft:")
		resource, ok := resources[resourceKey]
		if !ok {
			if aliasKey, aliasOK := reverseSimpleAliases[id]; aliasOK {
				resource, ok = resources[aliasKey]
			}
		}
		if ok {
			metadata.ResourcePack = &resourceMetadata{Textures: resource.Textures, Sound: resource.Sound}
			summary.ResourceMatches++
		}

		if alias, ok := aliases[id]; ok {
			metadata.Alias = &aliasMetadata{Target: alias.Target, Discriminator: alias.Discriminator, Targets: alias.Targets}
		}
		if c, ok := colors.NameColor[id]; ok {
			metadata.UntrustedMapColor = untrustedColorMetadata{
				Status:         "untrusted",
				Provenance:     colorProvenance,
				PaletteName:    c.Color,
				RGB:            c.RGB,
				RGBUnavailable: c.RGB == nil,
			}
			if c.RGB == nil {
				summary.MissingColorRGB++
			}
		}
		if candidates, ok := ambiguousByID[id]; ok {
			metadata.UntrustedMapColor.Ambiguous = true
			metadata.UntrustedMapColor.AmbiguousCandidates = candidates
		}

		out := generatedBlock{
			FormatVersion: "1.21.70",
			Block: blockBody{
				Description: blockDescription{Identifier: id},
				Components:  map[string]any{},
			},
			Metadata: metadata,
		}
		encoded, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			return Summary{}, err
		}
		encoded = append(bytes.TrimSpace(encoded), '\n')
		filename := strings.ReplaceAll(id, ":", "__") + ".json"
		if err := os.WriteFile(filepath.Join(blockDir, filename), encoded, 0o644); err != nil {
			return Summary{}, err
		}
	}

	manifest := []byte("{\n  \"format_version\": 2,\n  \"header\": {\n    \"name\": \"FeatureLab generated vanilla blocks\",\n    \"description\": \"Generated vanilla block catalogue; map colours are explicitly untrusted\",\n    \"uuid\": \"97884781-dca4-4ec9-8ec3-58c783f92f2c\",\n    \"version\": [1, 0, 0],\n    \"min_engine_version\": [1, 21, 70]\n  },\n  \"modules\": [{\n    \"type\": \"data\",\n    \"uuid\": \"38848d35-bf0b-4da6-8bed-301b47912ed9\",\n    \"version\": [1, 0, 0]\n  }]\n}\n")
	if err := os.WriteFile(filepath.Join(cfg.OutputDir, "manifest.json"), manifest, 0o644); err != nil {
		return Summary{}, err
	}
	return summary, nil
}
