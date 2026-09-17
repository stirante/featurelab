package gencolors

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stirante/featurelab/internal/rptex"
	"github.com/stirante/featurelab/jsonc"
)

// Config configures a single run of Generate. All paths are read-only
// inputs except OutputPath, which Generate overwrites.
type Config struct {
	// TextureRoot is the resource_pack directory of a bedrock-samples
	// checkout (i.e. the directory that itself contains "textures/blocks/
	// ..."). It is never vendored into this repository -- see the
	// gencolors package doc comment for how to obtain one.
	TextureRoot string
	// RPBlocksPath is scripts/vanilla-extract/rp/rp_blocks.json.
	RPBlocksPath string
	// TerrainTexturePath is scripts/vanilla-extract/rp/terrain_texture.json.
	TerrainTexturePath string
	// BlocksDir is block/vanilla/blocks: the already-generated per-block
	// catalogue this generator reads only for its list of 1238 block IDs
	// (each file's minecraft:block.description.identifier). It does not
	// read or depend on those files' resource_pack field -- this
	// generator resolves rp_blocks.json texture keys itself, including
	// tree-alias species (oak_leaves, spruce_log, ...) that the existing
	// catalogue generator does not resolve.
	BlocksDir string
	// OutputPath is the single committed colour-table JSON file this
	// generator writes, e.g. block/vanilla/colors.json.
	OutputPath string
}

// Summary reports what a Generate run found, for the CLI to print and for
// tests to assert non-degenerate behaviour on.
type Summary struct {
	Blocks              int // total block IDs considered (from BlocksDir)
	BlocksWithColor     int // blocks that got at least one face coloured
	BlocksWithoutColor  int // blocks with no resource-pack mapping or wholly unresolved textures
	UnavailableTextures int // distinct texture keys that could not be resolved to a colour
}

// resourceBlockJSON mirrors one rp_blocks.json block entry, keeping only
// the fields this generator needs.
type resourceBlockJSON struct {
	Textures        json.RawMessage `json:"textures"`
	CarriedTextures json.RawMessage `json:"carried_textures"`
}

// terrainEntryJSON mirrors one terrain_texture.json texture_data entry.
type terrainEntryJSON struct {
	Textures json.RawMessage `json:"textures"`
}

// committedBlockJSON reads only the identifier out of an already-generated
// block/vanilla/blocks/*.json file.
type committedBlockJSON struct {
	MinecraftBlock struct {
		Description struct {
			Identifier string `json:"identifier"`
		} `json:"description"`
	} `json:"minecraft:block"`
}

// generatorNotes documents, inside the committed output itself, every
// design decision the task called out as easy to get wrong: alpha
// handling, overlay handling, multi-path handling, and the carried-texture
// fallback. Keeping this next to the data means a reviewer never has to
// cross-reference the generator source to know why a colour looks the way
// it does.
var generatorNotes = []string{
	"Texture root is supplied by the caller, never vendored: point it at a sparse checkout of " +
		"https://github.com/Mojang/bedrock-samples's resource_pack/textures/blocks directory " +
		"(git clone --filter=blob:none --sparse, then git sparse-checkout set resource_pack/textures/blocks).",
	"Fully transparent pixels (alpha==0) are skipped entirely when averaging a texture; the " +
		"remaining pixels are weighted equally regardless of partial alpha, since every " +
		"non-fully-transparent alpha value measured across this texture set is either a uniform " +
		"per-texture constant (water at 240, ice at 190) or exactly opaque (255) -- there is no " +
		"antialiased-edge population that partial-alpha weighting would meaningfully change.",
	"terrain_texture.json overlay_color is applied as a per-channel multiply against the " +
		"averaged base colour (the engine's own tint blend), whenever the resolved texture " +
		"entry carries one.",
	"Multi-path texture_data entries (arrays of per-biome colour variants) always resolve to " +
		"their first array entry; nothing in rp_blocks.json or terrain_texture.json marks any " +
		"entry as the default biome, so first-entry is a deterministic, documented simplification.",
	"A face whose own texture is measurably greyscale (channel spread <= 2) and carries no " +
		"overlay_color of its own falls back to the block's carried_textures entry for the same " +
		"face, when the block declares one: Mojang bakes a fixed, non-biome-dependent tint into " +
		"the held-item texture for exactly this class of block (grass, leaves, vines, corals, " +
		"tall grass, sea pickles, ...), so this is a real colour derived from official textures, " +
		"not an invented constant. Faces where this still leaves a literal grey (e.g. stone, " +
		"which has no carried_textures at all) keep that grey; a note records which case applied.",
	"Tree-species blocks that only exist behind rp_blocks.json's legacy aggregate entries " +
		"(oak_leaves/spruce_leaves/.../leaves, oak_log/.../log, acacia_leaves/dark_oak_leaves/" +
		"leaves2, acacia_log/dark_oak_log/log2) are resolved via the same alias tables block.go " +
		"already exposes (block.GeneratedAliases), reusing that data rather than re-deriving it. " +
		"Because rp_blocks.json's multi-path arrays are always resolved to their first entry " +
		"(see above), every species behind a given legacy key currently receives that key's " +
		"first path's colour rather than a per-species one -- a known, documented simplification.",
}

// ColorTable is the schema of the committed output file.
type ColorTable struct {
	SchemaVersion int                   `json:"schema_version"`
	Notes         []string              `json:"notes"`
	Blocks        map[string]BlockColor `json:"blocks"`
	Misses        Misses                `json:"misses"`
}

// BlockColor is one block's entry in the colour table. Exactly one of
// Color or Faces is set: Color for blocks whose rp_blocks.json entry names
// a single texture key for every face, Faces for blocks with distinct
// up/down/side/north/south/east/west keys.
type BlockColor struct {
	Color string            `json:"color,omitempty"`
	Faces map[string]string `json:"faces,omitempty"`
	// Notes carries provenance for anything non-trivial: "" (flat colour)
	// or a face name maps to a note explaining a carried-texture fallback,
	// a literal unresolved grey, or (for a partially-resolved multi-face
	// block) why that particular face has no colour at all.
	Notes map[string]string `json:"notes,omitempty"`
}

// Misses records, explicitly, everything this generator could not resolve
// -- required reading alongside Blocks, since most of the 1238 vanilla
// blocks have no resource-pack entry at all (rp_blocks.json only covers
// 340 legacy names) and that is expected, not a bug to hide.
type Misses struct {
	BlocksWithoutColor  []BlockMiss   `json:"blocks_without_color"`
	UnavailableTextures []TextureMiss `json:"unavailable_textures"`
}

type BlockMiss struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type TextureMiss struct {
	Key    string `json:"texture_key"`
	Path   string `json:"path,omitempty"`
	Reason string `json:"reason"`
}

func readJSON(path string, dst any, stripComments bool) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if stripComments {
		b = jsonc.StripComments(b)
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

// buildResourceKeyFallback returns, for every block ID reachable only
// through a block.go alias (simple: minecraft:grass -> minecraft:grass_block;
// or tree-complex: minecraft:leaves --old_leaf_type=oak--> minecraft:oak_leaves),
// the rp_blocks.json resource key of the alias's SOURCE -- i.e. the key to
// look up when the target ID itself has no direct rp_blocks.json entry.
//
// This reuses block.GeneratedAliases() (the same alias data
// internal/genvanillablocks already consumes) rather than re-deriving
// wood-species or grass/leaves knowledge independently. It goes one step
// further than internal/genvanillablocks currently does: that generator
// only reverses simple (Target-only) aliases, so oak_leaves and the other
// five tree-complex species blocks (spruce/birch/jungle/acacia/dark_oak
// leaves, plus all six log species) currently get no resource_pack field
// at all in the committed catalogue. Reversing the Targets map too is what
// lets this generator give oak_leaves (explicitly one of the sanity-check
// blocks) a real colour.
//
// The table itself lives in internal/rptex, which internal/atlas resolves
// the same species through.
func buildResourceKeyFallback() map[string]string { return rptex.AliasResourceKeys() }

// blockTextureShape is internal/rptex.TextureSet under this package's
// original name: a block's (or its carried_textures') "textures" value,
// normalised to a single flat key or a per-face map. rp_blocks.json only
// ever uses those two shapes (checked against the full file: 216 flat, 122
// per-face, 0 other).
type blockTextureShape = rptex.TextureSet

func parseTextureShape(raw json.RawMessage) (blockTextureShape, bool) {
	s := rptex.ParseTextureSet(raw)
	return s, !s.Empty()
}

// carriedKeyFor returns the carried_textures key that should back up
// primaryFace: the matching per-face entry when carried is a per-face map,
// or carried's single flat key applied uniformly to every face (this
// happens for a handful of blocks, e.g. coral_fan, whose primary textures
// are directional but whose carried/held-item icon is a single texture).
func carriedKeyFor(carried blockTextureShape, hasCarried bool, primaryFace string) string {
	if !hasCarried {
		return ""
	}
	if carried.Flat != "" {
		return carried.Flat
	}
	return carried.Faces[primaryFace]
}

// Generate walks rp_blocks.json / terrain_texture.json / the texture root
// for every block ID found in cfg.BlocksDir and writes the resulting
// colour table to cfg.OutputPath. It is deterministic: identical inputs
// always produce byte-identical output (Blocks/Faces/Notes are Go maps,
// which encoding/json marshals with sorted keys; the two miss lists are
// explicitly sorted before marshalling).
func Generate(cfg Config) (Summary, error) {
	if cfg.TextureRoot == "" {
		return Summary{}, fmt.Errorf("gencolors: TextureRoot is required")
	}
	if info, err := os.Stat(cfg.TextureRoot); err != nil || !info.IsDir() {
		return Summary{}, fmt.Errorf("gencolors: TextureRoot %q is not a directory: %v", cfg.TextureRoot, err)
	}

	var rawResources map[string]json.RawMessage
	if err := readJSON(cfg.RPBlocksPath, &rawResources, true); err != nil {
		return Summary{}, err
	}
	delete(rawResources, "format_version")
	resources := make(map[string]resourceBlockJSON, len(rawResources))
	for key, raw := range rawResources {
		var res resourceBlockJSON
		if err := json.Unmarshal(raw, &res); err != nil {
			return Summary{}, fmt.Errorf("rp_blocks.json entry %q: %w", key, err)
		}
		resources[key] = res
	}

	var rawTerrainData struct {
		TextureData map[string]terrainEntryJSON `json:"texture_data"`
	}
	if err := readJSON(cfg.TerrainTexturePath, &rawTerrainData, true); err != nil {
		return Summary{}, err
	}
	terrain := make(map[string]json.RawMessage, len(rawTerrainData.TextureData))
	for key, entry := range rawTerrainData.TextureData {
		terrain[key] = entry.Textures
	}

	blockFiles, err := filepath.Glob(filepath.Join(cfg.BlocksDir, "*.json"))
	if err != nil {
		return Summary{}, err
	}
	sort.Strings(blockFiles)
	if len(blockFiles) == 0 {
		return Summary{}, fmt.Errorf("gencolors: no block files found under %s", cfg.BlocksDir)
	}
	ids := make([]string, 0, len(blockFiles))
	for _, f := range blockFiles {
		var cb committedBlockJSON
		if err := readJSON(f, &cb, false); err != nil {
			return Summary{}, err
		}
		if cb.MinecraftBlock.Description.Identifier == "" {
			return Summary{}, fmt.Errorf("%s: missing minecraft:block.description.identifier", f)
		}
		ids = append(ids, cb.MinecraftBlock.Description.Identifier)
	}
	sort.Strings(ids)

	resourceKeyFallback := buildResourceKeyFallback()
	resolver := newTextureResolver(cfg.TextureRoot, terrain)

	table := ColorTable{
		SchemaVersion: 1,
		Notes:         generatorNotes,
		Blocks:        make(map[string]BlockColor),
		Misses: Misses{
			BlocksWithoutColor:  []BlockMiss{},
			UnavailableTextures: []TextureMiss{},
		},
	}
	summary := Summary{Blocks: len(ids)}

	for _, id := range ids {
		resourceKey := strings.TrimPrefix(id, "minecraft:")
		res, ok := resources[resourceKey]
		if !ok {
			if altKey, altOK := resourceKeyFallback[id]; altOK {
				res, ok = resources[altKey]
			}
		}
		if !ok {
			table.Misses.BlocksWithoutColor = append(table.Misses.BlocksWithoutColor, BlockMiss{
				ID:     id,
				Reason: "no rp_blocks.json entry: not present directly, and not a target of any known alias in block.GeneratedAliases()",
			})
			summary.BlocksWithoutColor++
			continue
		}

		primary, hasPrimary := parseTextureShape(res.Textures)
		if !hasPrimary {
			table.Misses.BlocksWithoutColor = append(table.Misses.BlocksWithoutColor, BlockMiss{
				ID:     id,
				Reason: fmt.Sprintf("rp_blocks.json entry %q has no usable \"textures\" field", resourceKey),
			})
			summary.BlocksWithoutColor++
			continue
		}
		carried, hasCarried := parseTextureShape(res.CarriedTextures)

		bc := BlockColor{}
		if primary.Flat != "" {
			carriedKey := carriedKeyFor(carried, hasCarried, "")
			avg, note, err := resolver.resolveFace(primary.Flat, carriedKey)
			if err != nil {
				table.Misses.BlocksWithoutColor = append(table.Misses.BlocksWithoutColor, BlockMiss{
					ID:     id,
					Reason: err.Error(),
				})
				summary.BlocksWithoutColor++
				continue
			}
			bc.Color = avg.Hex()
			if note != "" {
				bc.Notes = map[string]string{"color": note}
			}
		} else {
			faces := make(map[string]string, len(primary.Faces))
			notes := make(map[string]string)
			faceNames := make([]string, 0, len(primary.Faces))
			for face := range primary.Faces {
				faceNames = append(faceNames, face)
			}
			sort.Strings(faceNames)
			for _, face := range faceNames {
				key := primary.Faces[face]
				carriedKey := carriedKeyFor(carried, hasCarried, face)
				avg, note, err := resolver.resolveFace(key, carriedKey)
				if err != nil {
					notes[face] = "unavailable: " + err.Error()
					continue
				}
				faces[face] = avg.Hex()
				if note != "" {
					notes[face] = note
				}
			}
			if len(faces) == 0 {
				table.Misses.BlocksWithoutColor = append(table.Misses.BlocksWithoutColor, BlockMiss{
					ID:     id,
					Reason: "every declared face failed to resolve; see unavailable_textures",
				})
				summary.BlocksWithoutColor++
				continue
			}
			bc.Faces = faces
			if len(notes) > 0 {
				bc.Notes = notes
			}
		}

		table.Blocks[id] = bc
		summary.BlocksWithColor++
	}

	misses := resolver.sortedMisses()
	for _, m := range misses {
		table.Misses.UnavailableTextures = append(table.Misses.UnavailableTextures, TextureMiss{
			Key:    m.Key,
			Path:   m.Path,
			Reason: m.Reason,
		})
	}
	summary.UnavailableTextures = len(misses)

	sort.Slice(table.Misses.BlocksWithoutColor, func(i, j int) bool {
		return table.Misses.BlocksWithoutColor[i].ID < table.Misses.BlocksWithoutColor[j].ID
	})

	encoded, err := json.MarshalIndent(table, "", "  ")
	if err != nil {
		return Summary{}, err
	}
	encoded = append(bytes.TrimSpace(encoded), '\n')
	if err := os.MkdirAll(filepath.Dir(cfg.OutputPath), 0o755); err != nil {
		return Summary{}, err
	}
	if err := os.WriteFile(cfg.OutputPath, encoded, 0o644); err != nil {
		return Summary{}, err
	}
	return summary, nil
}
