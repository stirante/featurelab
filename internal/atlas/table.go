package atlas

// Version is atlas.json's schema version. Bump it when a consumer that
// understood the previous shape would misread the new one.
const Version = 1

// Table is atlas.json: everything a renderer needs to draw a vanilla (or
// pack-defined) block with real textures, given atlas.png beside it.
//
// The atlas is a grid of fixed-size cells. Every cell is Cell texels square
// and is surrounded by Border texels of duplicated edge pixels, so cells sit
// Stride = Cell + 2*Border apart. A cell's recorded X/Y is the origin of its
// INNER Cell x Cell area, border excluded.
//
// UVs are not stored per cell -- they are four floats that any consumer can
// derive, and storing 4 x len(Cells) of them would be the largest thing in
// the file. Derive them with the half-texel inset this table names:
//
//	u0 = (X + Inset) / Width    u1 = (X + Cell - Inset) / Width
//	v0 = (Y + Inset) / Height   v1 = (Y + Cell - Inset) / Height
type Table struct {
	Version int    `json:"version"`
	Tag     string `json:"tag"`
	// Source is where the pixels came from: "vanilla" for a bedrock-samples
	// resource pack, "pack" for the pack under test's own resource pack.
	Source string `json:"source"`

	Cell   int     `json:"cell"`
	Border int     `json:"border"`
	Stride int     `json:"stride"`
	Inset  float64 `json:"inset"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Cols   int     `json:"cols"`
	Rows   int     `json:"rows"`

	// White is the index of an all-white, fully opaque cell. Required, and
	// the reason it is required is not cosmetic: it lets a block this table
	// says nothing about be drawn in the same textured pass as everything
	// else, sampling white and multiplying by its flat palette colour, which
	// reproduces flat-colour mode exactly for that block. It is also the one
	// cell in the sheet that this project drew rather than the pack.
	White int `json:"white"`

	// Cells is indexed by cell number: every integer anywhere else in this
	// table indexes into it.
	Cells []Cell `json:"cells"`

	// Textures maps a terrain_texture.json key to its FIRST variant's cell.
	// This is the lookup a renderer with no block-state information uses.
	Textures map[string]int `json:"textures"`

	// Variants maps a terrain_texture.json key to every variant's cell, in
	// the order terrain_texture.json lists them, for the keys that have more
	// than one distinct texture. That order is the engine's legacy
	// per-data-value texture list (terrain_texture.json's "stone" is
	// [stone, granite, granite_smooth, diorite, ...]), so this is the input
	// a block-state table needs and Textures alone cannot provide.
	Variants map[string][]int `json:"variants"`

	// Blocks maps a namespaced block ID to its per-face cells.
	Blocks map[string]Block `json:"blocks"`

	// Tints documents every tint channel Blocks' per-face tint values name.
	Tints map[string]Tint `json:"tints"`

	Misses Misses   `json:"misses"`
	Notes  []string `json:"notes"`
}

// Cell is one packed texture.
type Cell struct {
	// Path is the terrain_texture.json path, without extension, that these
	// pixels came from -- the cell's stable identity across atlas layouts.
	Path string `json:"path"`
	X    int    `json:"x"`
	Y    int    `json:"y"`

	// Render is how this texture's alpha says it must be drawn, measured
	// rather than declared (nothing in a resource pack's blocks.json or
	// terrain_texture.json names a render method for a vanilla block):
	// "opaque" when every pixel is alpha 255, "cutout" when every pixel is
	// either 0 or 255, "translucent" when any pixel is in between.
	Render string `json:"render"`

	// Color is the cell's alpha-aware average, the same measurement
	// block/vanilla/colors.json is built from. A renderer that cannot sample
	// the atlas for some reason has a per-cell flat colour here.
	Color string `json:"color"`

	// Grey marks a texture measurably close enough to neutral that it is
	// almost certainly baked greyscale awaiting a runtime tint. It is the
	// signal, not the instruction: what to multiply by is the per-face tint
	// channel in Block.
	Grey bool `json:"grey,omitempty"`

	// Frames is how many flipbook frames the source file held when it held
	// more than one. Only frame 0 is in the atlas; this records that the
	// rest exist and where to find them (the source file, Frames tall).
	Frames int `json:"frames,omitempty"`

	// Scaled is the source texture's edge length when it was not Cell and
	// had to be box-downscaled to fit; 0 when the source was already Cell.
	Scaled int `json:"scaled,omitempty"`

	// Overlay records a pack-declared overlay_color that has been MULTIPLIED
	// INTO these pixels already. It appears only on a cell supplied through
	// Options.ExtraTextures; a vanilla overlay_color is a per-biome list and
	// is carried as a runtime tint channel instead, never baked. Recorded so
	// a reader can tell a texture that looks tinted from one that is.
	Overlay string `json:"overlay,omitempty"`
}

// Block is one block's per-face lookup.
type Block struct {
	// Faces maps each of up/down/north/south/east/west to a cell index.
	// A face is absent only when its texture key could not be resolved.
	Faces map[string]int `json:"faces"`

	// Keys maps each face to the terrain_texture.json key it resolved
	// through, so a consumer that needs the key's other variants (a block
	// state table) can find them in Table.Variants.
	Keys map[string]string `json:"keys"`

	// Tint names the tint channel each face's texel must be multiplied by;
	// see Table.Tints. "none" for a face that is already the colour it
	// should be drawn in.
	Tint map[string]string `json:"tint"`

	// TintColor gives, per tinted face, a concrete measured multiplier that
	// makes the face render at the colour vanilla renders it in a default
	// biome. A renderer with no biome data multiplies by this; a renderer
	// with biome data uses the channel instead and ignores it.
	TintColor map[string]string `json:"tint_color,omitempty"`

	// Render is the strictest render method among the block's faces
	// (translucent beats cutout beats opaque), for a renderer that batches
	// per block rather than per face.
	Render string `json:"render"`

	// ResourceKey is the blocks.json key this block resolved through, which
	// is not always its own name: legacy aggregate entries ("leaves",
	// "log2") cover several species.
	ResourceKey string `json:"resource_key"`

	// Shape is the block's GEOMETRY in the vocabulary block/render.go and
	// frontend/src/shapes.ts share -- "full_block", "cross", or "unsupported"
	// (a resource-pack model, drawn as a textured cube).
	//
	// Only a PACK-defined block ever carries one. A vanilla block's shape is
	// declared nowhere in a resource pack, so the renderer resolves those from
	// its own name table; a pack block's shape is known only to its behaviour
	// pack, which is exactly what this field carries across. Without it every
	// block a pack declares as minecraft:geometry.cross draws as a solid cube
	// -- often a sizeable share of the custom blocks an add-on places.
	Shape string `json:"shape,omitempty"`

	// Note is one sentence about how this block is being drawn, when what
	// is drawn is not what the pack declared -- today, a block whose
	// minecraft:geometry names a resource-pack model, which this renderer
	// draws as a textured full cube. It rides in the table rather than in a
	// separate report because the table is what reaches the host that draws
	// the block, and a note is only worth showing for a block a given
	// preview actually placed: a pack with 202 blocks and 24 such notes puts
	// none of them on screen for a preview that placed neither.
	Note string `json:"note,omitempty"`
}

// Tint describes one tint channel.
type Tint struct {
	// Default is the multiplier to use when nothing better is known.
	Default string `json:"default"`
	// Source says, in one line, where Default was measured from.
	Source string `json:"source"`
}

// Misses records what did not make it in. It is required reading alongside
// the rest of the table: an atlas that silently drops a texture family looks
// exactly like one that never had it.
type Misses struct {
	Textures []TextureMiss `json:"textures"`
	Blocks   []BlockMiss   `json:"blocks"`
}

type TextureMiss struct {
	Key    string `json:"texture_key,omitempty"`
	Path   string `json:"path,omitempty"`
	Reason string `json:"reason"`
}

type BlockMiss struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// Render methods, strictest last.
const (
	RenderOpaque      = "opaque"
	RenderCutout      = "cutout"
	RenderTranslucent = "translucent"
)

func renderRank(r string) int {
	switch r {
	case RenderTranslucent:
		return 2
	case RenderCutout:
		return 1
	default:
		return 0
	}
}

// Tint channel names.
const (
	// TintNone: the texture is already the colour it should be drawn in.
	TintNone = "none"
	// TintGrass: the texture's terrain_texture.json entry carries
	// overlay_color, which is how vanilla marks the grass block's own
	// per-biome tint list.
	TintGrass = "grass"
	// TintWater: the texture is the _grey twin of a coloured texture, which
	// is how vanilla marks water's per-biome tint.
	TintWater = "water"
	// TintFoliage: the texture measures grey and the block ships a
	// pre-tinted carried (held-item) texture for the same face, which is
	// how vanilla bakes a default tint for leaves, vines, grass tufts and
	// the rest of the biome-coloured foliage.
	TintFoliage = "foliage"
)
