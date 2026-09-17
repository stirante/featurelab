package rptex

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/jsonc"
)

// CubeFaces are the six faces a full block is drawn with, in the order this
// package and internal/atlas always emit them.
var CubeFaces = []string{"up", "down", "north", "south", "east", "west"}

// TextureSet is a blocks.json "textures" (or "carried_textures") value,
// normalised to one of two shapes: a single flat key applied to every face,
// or a per-face map.
//
// The per-face map's key set is NOT assumed. Enumerated from the two real
// files this repository reads, it is exactly three combinations:
// {up,down,side} (73 in the committed legacy extract, 171 in bedrock-samples
// v1.26.30.5's own blocks.json), {up,down,north,south,east,west} (49 / 125),
// and {up,down,side,north,south,east,west} (0 / 2 -- azalea and
// flowering_azalea, which declare both a "side" and cardinals). Face
// resolution therefore has to cope with "side" and cardinals coexisting, and
// does: a cardinal wins where it is present, "side" fills the rest.
type TextureSet struct {
	Flat  string
	Faces map[string]string // nil when Flat != ""
}

// Empty reports whether the set carries nothing at all.
func (s TextureSet) Empty() bool { return s.Flat == "" && len(s.Faces) == 0 }

// Key returns the texture key for one of the six cube faces, and whether
// there is one. The lookup order is: the face's own entry, then "side" for a
// horizontal face (and, for the two-key {up,side}-style declarations vanilla
// never actually writes, "side" for up/down too), then the flat key.
func (s TextureSet) Key(face string) (string, bool) {
	if s.Flat != "" {
		return s.Flat, true
	}
	if k, ok := s.Faces[face]; ok && k != "" {
		return k, true
	}
	if k, ok := s.Faces["side"]; ok && k != "" {
		return k, true
	}
	return "", false
}

// DeclaredFaces returns the per-face map's keys, sorted; nil for a flat set.
func (s TextureSet) DeclaredFaces() []string {
	if len(s.Faces) == 0 {
		return nil
	}
	out := make([]string, 0, len(s.Faces))
	for f := range s.Faces {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// BlockEntry is one blocks.json entry, keeping only the fields anything in
// this repository reads.
type BlockEntry struct {
	Textures TextureSet
	Carried  TextureSet
}

// Blocks is a parsed blocks.json: resource key (the unnamespaced, often
// legacy, name blocks.json is keyed by) -> entry.
type Blocks struct {
	Entries map[string]BlockEntry
}

// BlocksRelPath is where a resource pack keeps blocks.json, relative to its
// root.
const BlocksRelPath = "blocks.json"

// LoadBlocks parses a blocks.json file (JSON with comments, as vanilla ships
// it).
func LoadBlocks(path string) (*Blocks, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(jsonc.StripComments(raw), &doc); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	delete(doc, "format_version")
	b := &Blocks{Entries: make(map[string]BlockEntry, len(doc))}
	for key, rawEntry := range doc {
		var e struct {
			Textures        json.RawMessage `json:"textures"`
			CarriedTextures json.RawMessage `json:"carried_textures"`
		}
		if err := json.Unmarshal(rawEntry, &e); err != nil {
			return nil, fmt.Errorf("%s: entry %q: %w", path, key, err)
		}
		b.Entries[key] = BlockEntry{
			Textures: ParseTextureSet(e.Textures),
			Carried:  ParseTextureSet(e.CarriedTextures),
		}
	}
	return b, nil
}

// ParseTextureSet normalises a raw "textures"/"carried_textures" value. An
// absent, empty or unrecognised value yields the zero TextureSet, for which
// Empty reports true.
func ParseTextureSet(raw json.RawMessage) TextureSet {
	if len(raw) == 0 {
		return TextureSet{}
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if s == "" {
			return TextureSet{}
		}
		return TextureSet{Flat: s}
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err == nil && len(m) > 0 {
		return TextureSet{Faces: m}
	}
	return TextureSet{}
}

// Lookup finds the blocks.json entry for a namespaced block ID such as
// "minecraft:oak_leaves": directly under its unnamespaced name, and failing
// that under the resource key of whichever alias points at it (see
// AliasResourceKeys). It returns the entry and the resource key it was found
// under.
func (b *Blocks) Lookup(id string, aliases map[string]string) (BlockEntry, string, bool) {
	key := strings.TrimPrefix(id, "minecraft:")
	if e, ok := b.Entries[key]; ok {
		return e, key, true
	}
	if alt, ok := aliases[id]; ok {
		if e, ok := b.Entries[alt]; ok {
			return e, alt, true
		}
	}
	return BlockEntry{}, "", false
}

// AliasResourceKeys returns, for every block ID reachable only through a
// block-package alias (simple: minecraft:grass -> minecraft:grass_block; or
// tree-complex: minecraft:leaves --old_leaf_type=oak--> minecraft:oak_leaves),
// the blocks.json resource key of the alias's SOURCE -- i.e. the key to look
// up when the target ID itself has no direct blocks.json entry.
//
// This reuses block.GeneratedAliases() (the same alias data
// internal/genvanillablocks already consumes) rather than re-deriving
// wood-species or grass/leaves knowledge independently. It goes one step
// further than internal/genvanillablocks currently does: that generator only
// reverses simple (Target-only) aliases, so oak_leaves and the other
// tree-complex species blocks currently get no resource_pack field at all in
// the committed catalogue.
func AliasResourceKeys() map[string]string {
	fallback := make(map[string]string)
	for source, alias := range block.GeneratedAliases() {
		sourceKey := strings.TrimPrefix(source, "minecraft:")
		if alias.Target != "" {
			fallback[alias.Target] = sourceKey
		}
		for _, target := range alias.Targets {
			fallback[target] = sourceKey
		}
	}
	return fallback
}

// VanillaBlockIDs returns every block ID in the generated vanilla catalogue
// block.DefaultBlocks() embeds, sorted. This is the set of IDs the engine can
// actually place, and therefore the set an atlas or colour table is worth
// having an entry for.
func VanillaBlockIDs() ([]string, error) {
	files := block.DefaultBlocks()
	out := make([]string, 0, len(files))
	for _, f := range files {
		var doc struct {
			MinecraftBlock struct {
				Description struct {
					Identifier string `json:"identifier"`
				} `json:"description"`
			} `json:"minecraft:block"`
		}
		if err := json.Unmarshal([]byte(f.Text), &doc); err != nil {
			return nil, fmt.Errorf("vanilla catalogue %s: %w", f.ID, err)
		}
		if doc.MinecraftBlock.Description.Identifier == "" {
			return nil, fmt.Errorf("vanilla catalogue %s: missing minecraft:block.description.identifier", f.ID)
		}
		out = append(out, doc.MinecraftBlock.Description.Identifier)
	}
	sort.Strings(out)
	return out, nil
}
