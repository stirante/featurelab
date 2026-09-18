// Package packrender turns what block/render.go read out of a behaviour
// pack's blocks/**/*.json into the block table the renderer consumes --
// resolving each face's texture KEY through the pack's OWN resource pack,
// and saying plainly, per block, what could not be drawn faithfully.
//
// It is the pack-side half of one table, not a second table. The vanilla
// half publishes
// atlas.json with the same per-block shape: a face->texture map, a per-face
// tint channel, and a render class. The one deliberate difference is that a
// face here names a texture KEY rather than an atlas CELL INDEX, because
// only the atlas builder can assign a cell, and it cannot assign one to an
// image it has not been handed yet. Table.Textures is exactly that handoff:
// texture key -> the image file on disk. An atlas builder ingests it, adds
// each image as a cell, and from then on a pack block and a vanilla block
// resolve through the identical key->cell map. The renderer never learns
// which pack a block came from, which is the entire point of the table.
package packrender

import (
	"fmt"
	"sort"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/internal/rptex"
)

// Version is Table's schema version, mirroring atlas.json's own "version".
const Version = 1

// Options is everything Build needs. Every path is optional: a behaviour
// pack with no resource pack is an ordinary thing, and Build's answer then
// is a table of blocks whose shapes and render methods are known but whose
// textures are not -- which is still strictly more than the tool has today.
type Options struct {
	// Palette must already have had LoadBlockTags called on the pack's
	// blocks/**/*.json (that walk is what fills the render index).
	Palette *block.Palette

	// TerrainTexturePath is the PACK's own textures/terrain_texture.json.
	// TextureRoot is the resource pack root its relative paths resolve
	// against -- the resource pack directory itself, since a
	// terrain_texture.json path is written pack-root-relative
	// ("textures/blocks/x"), not relative to the file's own directory.
	TerrainTexturePath string
	TextureRoot        string

	// VanillaTerrainTexturePath is a vanilla terrain_texture.json to fall
	// back to for keys the pack does not declare. Custom blocks reuse
	// vanilla texture keys freely ("stone", "dirt"), and a key found here
	// needs no image handed over at all: the vanilla atlas already has a
	// cell for it. Optional -- when empty, such a key is simply reported
	// unresolved.
	VanillaTerrainTexturePath string
	VanillaTextureRoot        string

	// ResourcePackDir / ResourcePackHow / ResourcePackName are recorded
	// verbatim into the table so a reader can see which resource pack was
	// used and by what rule it was picked.
	ResourcePackDir  string
	ResourcePackHow  string
	ResourcePackName string
}

// Table is the pack's block table.
type Table struct {
	Version int `json:"version"`

	// ResourcePack says which resource pack the texture keys resolved
	// through, and how it was found. Zero-valued when there was none.
	ResourcePack ResourcePackInfo `json:"resourcePack"`

	// Textures maps every texture key any block face reached to where its
	// image is. This is the handoff to the atlas builder.
	Textures map[string]TextureSource `json:"textures"`

	// Blocks is the table proper, keyed by canonical block name.
	Blocks map[string]Block `json:"blocks"`

	// Unresolved is every (block, face, texture key) that could not be
	// resolved to an image, with the reason. Listed rather than silently
	// dropped: a pack author looking at an untextured block needs to know
	// whether the key is missing from terrain_texture.json or the file it
	// points at is missing from disk, because those have different fixes.
	Unresolved []Unresolved `json:"unresolved"`

	// Notes is one entry per block that this preview read but cannot draw
	// faithfully -- overwhelmingly "this geometry is a resource-pack model
	// and is drawn as a full cube". One per BLOCK, never per placed cell.
	Notes []block.RenderNote `json:"notes"`
}

// ResourcePackInfo mirrors the located resource pack.
type ResourcePackInfo struct {
	Dir  string `json:"dir,omitempty"`
	Name string `json:"name,omitempty"`
	How  string `json:"how,omitempty"`
}

// TextureSource is where one texture key's image lives.
type TextureSource struct {
	// Path is the extensionless, pack-root-relative path as written in
	// terrain_texture.json.
	Path string `json:"path"`
	// File is the real file found on disk (with its .png/.tga extension),
	// or "" when From is "vanilla" and no vanilla texture root was given
	// -- in which case the atlas already has a cell for this key and no
	// image needs handing over.
	File string `json:"file,omitempty"`
	// From is "pack" or "vanilla": which terrain_texture.json declared the
	// key. A "pack" key is one the atlas does not have yet.
	From string `json:"from"`
	// Overlay is the entry's own overlay_color, when it declares one --
	// terrain_texture.json's own way of saying "this greyscale image is
	// multiplied by this colour", i.e. the same multiply the tint channel
	// asks the renderer for, but with the colour fixed by the pack rather
	// than by the biome.
	Overlay string `json:"overlay,omitempty"`
	// Variants is true when the key's entry was an ARRAY of texture
	// variants and this is its first; the others are not represented.
	Variants bool `json:"variants,omitempty"`
	// Color is a "#rrggbb"/"#rrggbbaa" flat colour, set INSTEAD of File when
	// the path resolved to a <name>.texture_set.json whose colour channel is
	// a literal rather than a picture (see internal/rptex's textureset.go).
	// The pack has said what the face's colour is without shipping art for
	// it, and the atlas draws it as one texel -- which its own upscale then
	// fills the cell with. A key with neither File nor Color is one the
	// vanilla atlas already holds a cell for.
	Color string `json:"color,omitempty"`
	// TextureSets is every .texture_set.json walked to reach this texture,
	// so a staleness check can hash the indirection as well as its target.
	TextureSets []string `json:"textureSets,omitempty"`
}

// Block is one block's row, in the shape Piece B's atlas.json publishes for
// a vanilla block -- with faces naming texture keys, see the package doc.
type Block struct {
	// Faces maps a face name to its texture KEY. A face is absent when the
	// pack declared no material covering it.
	Faces map[string]string `json:"faces"`
	// Tint is the per-face tint channel: the block's own tint_method, or
	// "none". Present for every face Faces has, so a renderer can index
	// both with the same key and never find one without the other.
	Tint map[string]string `json:"tint"`
	// Render is the block's draw class: "opaque", "cutout" or
	// "translucent" -- the strongest of its faces'.
	Render string `json:"render"`
	// DoubleSided is true when any face's render method draws back faces.
	DoubleSided bool `json:"doubleSided,omitempty"`
	// Shape is "full_block", "cross", or "unsupported" (drawn as a full
	// cube -- see Fallback).
	Shape string `json:"shape"`
	// Geometry is the geometry identifier verbatim, for a reader who wants
	// to know which model was skipped.
	Geometry string `json:"geometry,omitempty"`
	// Fallback is the human-readable reason this block is not drawn
	// exactly as declared, or "" when it is. This is the string an
	// interface shows an author whose custom block came out square.
	Fallback string `json:"fallback,omitempty"`
	// States is set on a STATE-SPECIFIC row and nil on a block's default
	// one: the concrete block states this row's faces are for, which are
	// exactly the states the block's permutation conditions read. Such a row
	// is filed in Blocks under block.CanonicalKey(name, States) -- the same
	// "name#k=v,k=v" spelling the palette interns a placed block under -- so
	// a consumer looks one up by the key it already has. See permutations.go.
	States map[string]block.StateValue `json:"states,omitempty"`
	// FileID is the blocks/ file this block came from.
	FileID string `json:"fileId"`
}

// sameAppearanceAs reports whether two rows would draw identically: same
// faces, same tint channels, same shape and render class. Used to drop a
// state-specific row that a permutation did not actually change.
func (b Block) sameAppearanceAs(other Block) bool {
	if b.Render != other.Render || b.Shape != other.Shape ||
		b.Geometry != other.Geometry || b.DoubleSided != other.DoubleSided {
		return false
	}
	return sameStringMap(b.Faces, other.Faces) && sameStringMap(b.Tint, other.Tint)
}

func sameStringMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if other, ok := b[k]; !ok || other != v {
			return false
		}
	}
	return true
}

// Fully reports whether this block resolved completely: a shape this
// preview draws, and an image for every face it declares.
func (b Block) Fully() bool {
	return b.Fallback == "" && b.Shape != block.ShapeUnsupported && len(b.Faces) == len(block.RenderFaces)
}

// Unresolved is one face whose texture key produced no image.
type Unresolved struct {
	Block   string `json:"block"`
	Face    string `json:"face"`
	Texture string `json:"texture"`
	Reason  string `json:"reason"`
}

// Build assembles the table. It returns an error only for a
// terrain_texture.json that exists but cannot be read or parsed -- a
// genuinely broken input the caller should hear about. Everything else
// (absent resource pack, missing key, missing image file) is recorded in
// the table and is not an error.
func Build(opts Options) (*Table, error) {
	t := &Table{
		Version:      Version,
		ResourcePack: ResourcePackInfo{Dir: opts.ResourcePackDir, Name: opts.ResourcePackName, How: opts.ResourcePackHow},
		Textures:     map[string]TextureSource{},
		Blocks:       map[string]Block{},
		Unresolved:   []Unresolved{},
		Notes:        []block.RenderNote{},
	}
	if opts.Palette == nil {
		return t, nil
	}

	// Both tables are read by internal/rptex, the one answer in this
	// repository to "what does a terrain_texture.json key mean" (see that
	// package's doc comment). Nothing about a BEHAVIOUR pack's own resource
	// pack makes that question different -- the file has the same shape and
	// the same three value forms whoever shipped it -- so this resolves
	// through rptex rather than growing a second reader for pack keys.
	packTerrain, err := loadTerrain(opts.TerrainTexturePath)
	if err != nil {
		return nil, err
	}
	vanillaTerrain, err := loadTerrain(opts.VanillaTerrainTexturePath)
	if err != nil {
		return nil, err
	}
	packTable := &keyTable{terrain: packTerrain, root: opts.TextureRoot}
	vanillaTable := &keyTable{terrain: vanillaTerrain, root: opts.VanillaTextureRoot}

	// resolveKey is memoised over the whole build: a pack's blocks share
	// texture keys heavily (every ore variant of one stone type names the
	// same base texture), and each key's file probe is a stat call.
	resolved := map[string]string{} // key -> reason it failed, "" when it did not
	resolveKey := func(key string) string {
		if reason, done := resolved[key]; done {
			return reason
		}
		reason := ""
		switch {
		case packTable.has(key):
			reason = addTexture(t, packTable, key, "pack")
		case vanillaTable.has(key):
			reason = addTexture(t, vanillaTable, key, "vanilla")

		// A key the file DECLARED but rptex could not read is not the same
		// thing as a key nobody wrote down, and saying "not declared" about it
		// sends the author to add an entry that is already there. rptex now
		// skips such an entry rather than failing the whole file (see
		// rptex.Terrain.Skipped), which only helps if the reason travels the
		// last stretch to the author, and this is that stretch.
		case packTable.skipReason(key) != "":
			reason = fmt.Sprintf("texture key %q is declared in the resource pack's terrain_texture.json but was skipped: %s",
				key, packTable.skipReason(key))
		case vanillaTable.skipReason(key) != "":
			reason = fmt.Sprintf("texture key %q is declared in the vanilla terrain_texture.json but was skipped: %s",
				key, vanillaTable.skipReason(key))

		case packTerrain == nil && vanillaTerrain == nil:
			reason = "no terrain_texture.json was loaded -- the pack's resource pack was not found"
		case packTerrain == nil:
			reason = fmt.Sprintf("texture key %q is not a vanilla texture and the pack's resource pack was not found", key)
		default:
			reason = fmt.Sprintf("texture key %q is not declared in the resource pack's terrain_texture.json", key)
		}
		resolved[key] = reason
		return reason
	}

	for _, name := range opts.Palette.BlockRenderNames() {
		br, ok := opts.Palette.BlockRender(name)
		if !ok {
			continue
		}
		fallback := ""
		if note, has := opts.Palette.BlockRenderNote(name); has {
			fallback = note.Message
		}

		// One report per (face, texture key) per BLOCK, not per state row. A
		// block with permutations produces several rows over the same handful
		// of keys, and a key that cannot be resolved fails identically in all
		// of them; listing it once per row would bury every other block's
		// diagnostic under one block's state product. The report is filed
		// against the plain block name for the same reason: the fix is in
		// that one file either way.
		reported := map[string]bool{}
		buildRow := func(states map[string]block.StateValue, faces map[string]block.MaterialInstance, geom block.BlockGeometry) Block {
			row := Block{
				Faces:    map[string]string{},
				Tint:     map[string]string{},
				Render:   block.RenderClass(faces),
				Shape:    geom.Shape,
				Geometry: geom.Identifier,
				FileID:   br.FileID,
				Fallback: fallback,
				States:   states,
			}
			for _, face := range block.RenderFaces {
				inst, declared := faces[face]
				if !declared {
					continue
				}
				if inst.DoubleSided {
					row.DoubleSided = true
				}
				if reason := resolveKey(inst.Texture); reason != "" {
					if key := face + "\x00" + inst.Texture; !reported[key] {
						reported[key] = true
						t.Unresolved = append(t.Unresolved, Unresolved{Block: name, Face: face, Texture: inst.Texture, Reason: reason})
					}
					continue
				}
				row.Faces[face] = inst.Texture
				row.Tint[face] = tintChannel(inst)
			}
			return row
		}

		base := buildRow(nil, br.Faces, br.Geometry)
		t.Blocks[name] = base

		// The state-specific rows, filed under the SAME canonical
		// "name#k=v,k=v" key the palette interns a placed block under, so a
		// consumer holding a placed block's (name, states) can look one up
		// without knowing anything about permutations. A row identical to the
		// default is not emitted: it would be a wire entry that changes
		// nothing, and there is one per state combination that does not
		// happen to matter.
		for _, variant := range br.StateVariants() {
			row := buildRow(variant.States, variant.Faces, variant.Geometry)
			if row.sameAppearanceAs(base) {
				continue
			}
			t.Blocks[block.CanonicalKey(name, variant.States)] = row
		}
	}

	if notes := opts.Palette.BlockRenderNotes(); notes != nil {
		t.Notes = notes
	}
	sort.Slice(t.Unresolved, func(i, j int) bool {
		if t.Unresolved[i].Block != t.Unresolved[j].Block {
			return t.Unresolved[i].Block < t.Unresolved[j].Block
		}
		return t.Unresolved[i].Face < t.Unresolved[j].Face
	})
	return t, nil
}

// keyTable pairs a parsed terrain_texture.json with the resource-pack root
// its (root-relative, extensionless) paths resolve against. rptex.Terrain
// carries the first half and deliberately not the second -- a table can be
// read from one place and its images live somewhere else -- so the pairing
// lives here, at the one call site that needs both.
type keyTable struct {
	terrain *rptex.Terrain
	root    string
}

func (k *keyTable) has(key string) bool {
	if k == nil || k.terrain == nil {
		return false
	}
	_, ok := k.terrain.Keys[key]
	return ok
}

// skipReason is why this table's terrain_texture.json declared key and yet has
// no texture path for it, or "" when it has one or never mentioned it.
func (k *keyTable) skipReason(key string) string {
	if k == nil || k.terrain == nil {
		return ""
	}
	return k.terrain.Skipped[key]
}

func loadTerrain(path string) (*rptex.Terrain, error) {
	if path == "" {
		return nil, nil
	}
	return rptex.LoadTerrain(path)
}

// addTexture resolves one key through table and records it, returning ""
// on success or the reason it failed.
//
// Only the key's FIRST variant is taken. A multi-variant key is the engine's
// legacy per-data-value texture list, and picking between its entries needs a
// block state; a pack block's material_instances names a key with no data
// value at all, so there is nothing here to pick with. rptex.Terrain keeps
// every variant, so the ones not taken are still reachable by anything that
// later learns how to choose.
func addTexture(t *Table, table *keyTable, key, from string) string {
	variants := table.terrain.Keys[key]
	if len(variants) == 0 {
		return fmt.Sprintf("texture key %q declares no texture path", key)
	}
	v := variants[0]
	src := TextureSource{Path: v.Path, From: from, Variants: len(variants) > 1}
	if v.Overlay != nil {
		src.Overlay = v.Overlay.Hex()
	}
	if table.root != "" {
		// ResolveTexture rather than FindTexture: a path with no image
		// behind it may still be a texture set, and a texture set may answer
		// with a flat colour instead of a file. Its error strings are
		// deliberately specific -- "no image and no texture set", "that
		// texture set's color names a file that isn't there", "that colour
		// is written in a form this preview does not read" -- because they
		// end up in PackSummary.Unresolved as the author's only clue.
		tex, err := rptex.ResolveTexture(table.root, v.Path)
		if err != nil {
			// A key that IS declared but whose image is missing is a
			// different problem from a key that was never declared, and
			// gets a different sentence for that reason.
			return err.Error()
		}
		src.File, src.TextureSets = tex.File, tex.Sets
		if tex.Color != nil {
			src.Color = tex.Color.Hex()
		}
	} else if from == "pack" {
		return fmt.Sprintf("texture key %q resolves to %s but no resource pack root was given to look it up in", key, v.Path)
	}
	t.Textures[key] = src
	return ""
}

// tintChannel is the per-face tint channel the contract's table carries:
// the material's own tint_method when it declares one, "none" otherwise.
// The name is passed through verbatim rather than mapped to a small enum --
// the engine's tint methods ("grass", "water", "default_foliage",
// "birch_foliage", "evergreen_foliage") are its vocabulary, not this port's,
// and inventing a translation table here would only give a future tint
// method somewhere new to be lost.
func tintChannel(inst block.MaterialInstance) string {
	if inst.Tint == "" {
		return "none"
	}
	return inst.Tint
}

// Summary is the count a caller prints: how much of a pack actually drew.
type Summary struct {
	Blocks     int
	Fully      int
	ShapeCube  int // drawn as a full cube because the geometry is a model
	Untextured int // at least one declared face resolved to no image
}

// Summarise counts the table. Fully means "every declared face has an image
// AND the shape is one this preview draws" -- deliberately the strict
// reading, so the number never flatters the result.
// A state-specific row is NOT a block: a lamp with a lit state is one block
// the author wrote and one block the preview draws, whichever of its two face
// sets is on screen. Counting its rows would make every count in this summary
// depend on how many permutations a pack happens to use, which is exactly the
// number a reader is not asking about.
func (t *Table) Summarise() Summary {
	s := Summary{}
	untextured := map[string]bool{}
	for _, u := range t.Unresolved {
		untextured[u.Block] = true
	}
	s.Untextured = len(untextured)
	for name, b := range t.Blocks {
		if len(b.States) > 0 {
			continue
		}
		s.Blocks++
		if b.Shape == block.ShapeUnsupported {
			s.ShapeCube++
		}
		if b.Fully() && !untextured[name] {
			s.Fully++
		}
	}
	return s
}
