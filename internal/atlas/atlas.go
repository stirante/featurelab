// Package atlas turns a resource pack into the two artifacts a textured
// renderer consumes: one RGBA sheet holding every block texture the pack's
// terrain_texture.json reaches, and a table saying which cell of that sheet
// each block's each face is drawn from.
//
// It resolves textures through internal/rptex, the one place in this
// repository that reads terrain_texture.json and blocks.json, so the atlas
// and block/vanilla/colors.json can never disagree about which texture
// belongs to which block.
//
// Nothing here is a build step and nothing it produces is committed. The
// pixels are Mojang's, not this project's -- the same reason the asset
// download exists rather than a vendored copy -- so Build runs at runtime
// against whatever resource-pack root the caller resolved, and the result is
// cached outside the repository. That also makes a pack's OWN blocks nearly
// free: the same Build, pointed at the pack's own resource pack, produces the
// same two artifacts with no second code path.
package atlas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"sort"

	"github.com/stirante/featurelab/internal/rptex"
)

// Options configures one Build.
type Options struct {
	// Root is a resource_pack directory: the only thing Piece A's
	// vanillaassets.Resolve guarantees, and the only thing this needs.
	Root string
	// Tag labels the provenance of Root (a bedrock-samples tag, a pack
	// version) and is copied into the table verbatim.
	Tag string
	// Source is "vanilla" or "pack"; defaults to "vanilla".
	Source string

	// TerrainPath and BlocksPath override where the two metadata files are
	// read from. Both default to their standard place inside Root.
	TerrainPath string
	BlocksPath  string
	// FallbackBlocksPath is used when Root has no blocks.json of its own --
	// a texture-only sparse checkout, or a pack that ships textures but no
	// block bindings. Point it at this repository's committed extract.
	FallbackBlocksPath string

	// BlockIDs is the set of block IDs to emit entries for. Defaults to the
	// generated vanilla catalogue.
	BlockIDs []string

	// ExtraTextures packs texture files this Build would not otherwise
	// reach, keyed by the texture key they answer to. It is how a pack's own
	// textures get into the same sheet as vanilla's: internal/packrender
	// resolves a behaviour pack's blocks against the pack's OWN
	// terrain_texture.json and reports where each key's file lives, and
	// those files are handed here rather than this package learning to walk
	// a second resource pack. A key already present in Root's
	// terrain_texture.json is NOT overridden -- vanilla keys a pack merely
	// reuses resolve normally, and only genuinely new keys come through
	// here.
	ExtraTextures map[string]ExtraTexture

	// BlockFaces supplies per-block face-to-texture-key bindings for blocks
	// that appear in no blocks.json at all. A behaviour pack's custom blocks
	// are exactly that case: their faces come from
	// minecraft:material_instances, which only the behaviour pack declares.
	// Keys are namespaced block IDs; values use the same face names as
	// blocks.json ("up", "down", "side", the four cardinals) plus "*" for
	// every face at once. An entry here wins over blocks.json.
	BlockFaces map[string]map[string]string

	// BlockTint and BlockRender override, per block, what this package would
	// otherwise measure. A pack that declares a tint_method or a
	// render_method for a face has said what it wants, and a measurement of
	// its pixels is not entitled to disagree. Both are optional and both are
	// only consulted for blocks named in BlockFaces.
	BlockTint   map[string]map[string]string
	BlockRender map[string]string

	// BlockShape carries, per block, the geometry classification the pack's
	// own behaviour pack declared ("full_block", "cross", "unsupported").
	// Copied verbatim into Block.Shape; consulted, like BlockTint and
	// BlockRender, only for blocks named in BlockFaces -- a vanilla block's
	// shape is not a resource pack's to declare.
	BlockShape map[string]string

	// BlockNote carries, per block, one sentence about a difference between
	// what the pack declared and what a cube-only renderer can draw -- a
	// geometry that is a resource-pack model, most of all. Copied verbatim
	// into Block.Note; consulted, like BlockTint and BlockRender, only for
	// blocks named in BlockFaces.
	BlockNote map[string]string

	// Cell is the edge length in texels of one atlas cell; 0 means 16.
	Cell int
	// Border is the duplicated-edge padding around each cell; 0 means the
	// default of 1, and a negative value means none.
	Border int
}

// ExtraTexture is one texture handed to Build directly rather than found
// through Root's terrain_texture.json.
type ExtraTexture struct {
	// File is a real file on disk, extension and all -- what
	// rptex.FindTexture returns.
	File string
	// Overlay, when non-empty, is the "#rrggbb" the pack's own
	// terrain_texture.json entry declared, and is treated exactly as
	// vanilla's overlay_color is.
	Overlay string
}

// Stats reports what a Build found, for a caller to print and a test to
// assert non-degenerate behaviour on.
type Stats struct {
	TextureKeys  int // terrain_texture.json keys seen
	TexturePaths int // distinct texture paths those keys reach
	// CellsPacked counts only the VANILLA pass -- the texture paths reachable from the resource
	// pack's own terrain_texture.json. It is read before any caller-supplied texture is appended,
	// which is deliberate (cmd/genatlas reports it next to TexturePathsBad, and those two are
	// about the same pass), but it means CellsPacked is NOT the size of the finished sheet. A
	// caller reporting "N textures packed" from this field alone will understate a build that
	// included a pack's own textures -- add ExtraCells, or read len(Table.Cells).
	CellsPacked     int
	ExtraCells      int // caller-supplied textures packed alongside them
	TexturePathsBad int // paths that did not (missing file, unusable shape)
	TextureKeysBad  int // terrain keys left with no packed path at all
	Blocks          int // block IDs considered
	BlocksFull      int // blocks that got all six faces
	BlocksPartial   int // blocks that got some but not all six
	BlocksMissing   int // blocks with no resource-pack binding at all
	GreyCells       int // cells measuring greyscale, i.e. awaiting a tint
	TintedFaces     int // block faces given a named tint channel
	UntintedGrey    int // block faces measuring grey with no tint source
}

// Built is one Build's output: the sheet, the table, and the counts.
type Built struct {
	PNG   []byte
	Table Table
	Stats Stats
}

// Build reads opts.Root and produces the atlas and its table.
func Build(opts Options) (*Built, error) {
	if opts.Root == "" {
		return nil, fmt.Errorf("atlas: Root is required")
	}
	if info, err := os.Stat(opts.Root); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("atlas: Root %q is not a directory: %v", opts.Root, err)
	}
	cell := opts.Cell
	if cell <= 0 {
		cell = 16
	}
	border := opts.Border
	switch {
	case border == 0:
		border = 1
	case border < 0:
		border = 0
	}
	source := opts.Source
	if source == "" {
		source = "vanilla"
	}

	terrainPath := opts.TerrainPath
	if terrainPath == "" {
		terrainPath = filepath.Join(opts.Root, filepath.FromSlash(rptex.TerrainRelPath))
	}
	terrain, err := rptex.LoadTerrain(terrainPath)
	if err != nil {
		return nil, fmt.Errorf("atlas: terrain_texture.json: %w", err)
	}

	blocksPath := opts.BlocksPath
	if blocksPath == "" {
		blocksPath = filepath.Join(opts.Root, rptex.BlocksRelPath)
		if _, statErr := os.Stat(blocksPath); statErr != nil && opts.FallbackBlocksPath != "" {
			blocksPath = opts.FallbackBlocksPath
		}
	}
	blocks, err := rptex.LoadBlocks(blocksPath)
	if err != nil {
		return nil, fmt.Errorf("atlas: blocks.json: %w", err)
	}

	ids := opts.BlockIDs
	if ids == nil {
		ids, err = rptex.VanillaBlockIDs()
		if err != nil {
			return nil, fmt.Errorf("atlas: %w", err)
		}
	}

	b := &builder{
		opts:    opts,
		cell:    cell,
		border:  border,
		terrain: terrain,
		blocks:  blocks,
		byPath:  make(map[string]int),
	}
	b.packTextures()
	sheet, err := b.compose()
	if err != nil {
		return nil, err
	}
	b.buildBlocks(ids)

	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, sheet); err != nil {
		return nil, fmt.Errorf("atlas: encode png: %w", err)
	}

	b.table.Version = Version
	b.table.Tag = opts.Tag
	b.table.Source = source
	b.table.Cell = cell
	b.table.Border = border
	b.table.Stride = cell + 2*border
	b.table.Inset = 0.5
	b.table.Notes = notes(terrainPath, blocksPath)
	b.stats.TextureKeys = len(terrain.Keys)

	return &Built{PNG: buf.Bytes(), Table: b.table, Stats: b.stats}, nil
}

// WriteDir writes atlas.png and atlas.json into dir, creating it if needed.
func (b *Built) WriteDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "atlas.png"), b.PNG, 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "atlas.json"), b.TableJSON(), 0o644)
}

// TableJSON renders the table the way WriteDir writes it: indented, with a
// trailing newline, and deterministic (encoding/json emits every map
// key-sorted, and every slice here is built in an explicitly sorted order).
func (b *Built) TableJSON() []byte {
	encoded, err := json.MarshalIndent(b.Table, "", "  ")
	if err != nil {
		// Table is plain data with no unencodable field, so a failure here
		// would mean the struct had changed into something unmarshallable:
		// a programming error, not a runtime condition.
		panic("atlas: table is not encodable: " + err.Error())
	}
	return append(bytes.TrimSpace(encoded), '\n')
}

// builder carries one Build's mutable state.
type builder struct {
	opts    Options
	cell    int
	border  int
	terrain *rptex.Terrain
	blocks  *rptex.Blocks

	table  Table
	stats  Stats
	images []*image.NRGBA // parallel to table.Cells
	avg    []rptex.RGB    // parallel to table.Cells
	byPath map[string]int // texture path -> cell index
}

// packTextures decodes every distinct texture path terrain_texture.json
// reaches, one cell each, in sorted path order so the layout is reproducible.
func (b *builder) packTextures() {
	paths := map[string]bool{}
	for _, key := range b.terrain.SortedKeys() {
		for _, v := range b.terrain.Keys[key] {
			paths[v.Path] = true
		}
	}
	sorted := make([]string, 0, len(paths))
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	b.stats.TexturePaths = len(sorted)

	b.table.Misses.Textures = []TextureMiss{}
	for _, p := range sorted {
		src, _, err := rptex.LoadImage(b.opts.Root, p)
		if err != nil {
			b.miss(p, err.Error())
			continue
		}
		img, frames, scaled, err := normalise(src, b.cell)
		if err != nil {
			b.miss(p, err.Error())
			continue
		}
		colour, opaquePixels := rptex.Average(img)
		c := Cell{
			Path:   p,
			Render: classifyRender(img),
			Color:  colour.Hex(),
			Grey:   opaquePixels > 0 && colour.Achromatic(),
		}
		if frames > 1 {
			c.Frames = frames
		}
		if scaled != 0 {
			c.Scaled = scaled
		}
		if c.Grey {
			b.stats.GreyCells++
		}
		b.byPath[p] = len(b.table.Cells)
		b.table.Cells = append(b.table.Cells, c)
		b.images = append(b.images, img)
		b.avg = append(b.avg, colour)
	}
	b.stats.CellsPacked = len(b.table.Cells)

	// The key tables are built from the packed cells, so a key whose only
	// path failed to load simply has no entry -- and is already recorded as
	// a texture miss above.
	b.table.Textures = map[string]int{}
	b.table.Variants = map[string][]int{}
	for _, key := range b.terrain.SortedKeys() {
		vs := b.terrain.Keys[key]
		idxs := make([]int, 0, len(vs))
		distinct := map[int]bool{}
		for _, v := range vs {
			i, ok := b.byPath[v.Path]
			if !ok {
				continue
			}
			idxs = append(idxs, i)
			distinct[i] = true
		}
		if len(idxs) == 0 {
			continue
		}
		b.table.Textures[key] = idxs[0]
		if len(distinct) > 1 {
			b.table.Variants[key] = idxs
		}
	}
	b.packExtraTextures()
	b.appendWhiteCell()
}

// packExtraTextures packs the caller-supplied texture files, which is how a
// behaviour pack's own block textures reach the same sheet as vanilla's
// without this package having to walk a second resource pack. See
// Options.ExtraTextures.
func (b *builder) packExtraTextures() {
	keys := make([]string, 0, len(b.opts.ExtraTextures))
	for k := range b.opts.ExtraTextures {
		if _, taken := b.table.Textures[k]; taken {
			// A vanilla key the pack merely reuses. The sheet already has
			// the cell, and the pack has not said anything new about it.
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		extra := b.opts.ExtraTextures[key]
		if extra.File == "" {
			b.missKey(key, "no texture file was supplied for this key")
			continue
		}
		src, err := rptex.DecodeFile(extra.File)
		if err != nil {
			b.missKey(key, err.Error())
			continue
		}
		img, frames, scaled, err := normalise(src, b.cell)
		if err != nil {
			b.missKey(key, err.Error())
			continue
		}
		if extra.Overlay != "" {
			overlay, err := rptex.ParseHex(extra.Overlay)
			if err != nil {
				b.missKey(key, fmt.Sprintf("overlay_color %q: %v", extra.Overlay, err))
				continue
			}
			// A pack-declared overlay_color is baked here, unlike vanilla's.
			// The rule the contract sets is that no BIOME tint may be baked,
			// because a biome tint is chosen at draw time and an atlas cannot
			// know it. A pack that writes one overlay_color against one
			// texture key has instead declared a fixed constant, and carrying
			// it as a runtime channel would mean inventing a channel name the
			// renderer has never heard of -- which resolves to white, i.e. to
			// the overlay being lost.
			bakeOverlay(img, overlay)
		}
		colour, opaquePixels := rptex.Average(img)
		c := Cell{
			Path:   filepath.ToSlash(extra.File),
			Render: classifyRender(img),
			Color:  colour.Hex(),
			Grey:   opaquePixels > 0 && colour.Achromatic(),
		}
		if frames > 1 {
			c.Frames = frames
		}
		if scaled != 0 {
			c.Scaled = scaled
		}
		if c.Grey {
			b.stats.GreyCells++
		}
		c.Overlay = extra.Overlay
		b.table.Textures[key] = len(b.table.Cells)
		b.table.Cells = append(b.table.Cells, c)
		b.images = append(b.images, img)
		b.avg = append(b.avg, colour)
		b.stats.ExtraCells++
	}
}

// bakeOverlay multiplies img's colour channels by overlay in place, leaving
// alpha alone -- the same per-channel multiply the engine applies for
// terrain_texture.json's overlay_color.
func bakeOverlay(img *image.NRGBA, overlay rptex.RGB) {
	for i := 0; i+3 < len(img.Pix); i += 4 {
		img.Pix[i] = uint8(int(img.Pix[i]) * int(overlay.R) / 255)
		img.Pix[i+1] = uint8(int(img.Pix[i+1]) * int(overlay.G) / 255)
		img.Pix[i+2] = uint8(int(img.Pix[i+2]) * int(overlay.B) / 255)
	}
}

func (b *builder) missKey(key, reason string) {
	b.stats.TextureKeysBad++
	b.table.Misses.Textures = append(b.table.Misses.Textures, TextureMiss{Key: key, Reason: reason})
}

func (b *builder) miss(path, reason string) {
	b.stats.TexturePathsBad++
	b.table.Misses.Textures = append(b.table.Misses.Textures, TextureMiss{Path: path, Reason: reason})
}

// appendWhiteCell adds one all-white, fully opaque cell and records its index
// as Table.White.
//
// It is the one cell in the sheet that is ours rather than the pack's, and it
// is load-bearing rather than decorative: it lets a block the table says
// nothing about -- a pack's own custom block, an id newer than the atlas --
// be drawn in the SAME textured draw call as everything else, sampling white
// and multiplying by its flat palette colour, which reproduces flat-colour
// mode exactly for that block. Without it the renderer needs a second,
// untextured mesh purely to carry the leftovers. The requirement comes from
// frontend/src/protocol.ts's decodeAtlas, which refuses a table without it.
func (b *builder) appendWhiteCell() {
	white := image.NewNRGBA(image.Rect(0, 0, b.cell, b.cell))
	for i := range white.Pix {
		white.Pix[i] = 0xff
	}
	b.table.White = len(b.table.Cells)
	b.table.Cells = append(b.table.Cells, Cell{
		Path:   whiteCellPath,
		Render: RenderOpaque,
		Color:  "#ffffff",
	})
	b.images = append(b.images, white)
	b.avg = append(b.avg, rptex.RGB{R: 0xff, G: 0xff, B: 0xff})
}

// whiteCellPath names the synthetic white cell in place of a texture path, so
// nothing reading Cells has to special-case an empty string.
const whiteCellPath = "(featurelab:white)"

// compose lays the packed cells out on the smallest power-of-two sheet they
// fit on and draws each one with its border of duplicated edge pixels.
func (b *builder) compose() (*image.NRGBA, error) {
	stride := b.cell + 2*b.border
	w, h, cols, err := fitSheet(len(b.table.Cells), stride)
	if err != nil {
		return nil, err
	}
	b.table.Width, b.table.Height, b.table.Cols = w, h, cols
	b.table.Rows = (len(b.table.Cells) + cols - 1) / cols

	sheet := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := range b.table.Cells {
		x := (i%cols)*stride + b.border
		y := (i/cols)*stride + b.border
		b.table.Cells[i].X, b.table.Cells[i].Y = x, y
		drawWithBorder(sheet, b.images[i], x, y, b.border)
	}
	return sheet, nil
}

// fitSheet lays count cells of the given stride out on the squarest grid that
// holds them and returns the sheet's exact pixel size.
//
// The sheet is NOT padded up to a power of two, and that is a deliberate
// departure from the first sketch of this contract. The renderer that
// consumes it (frontend/src/viewer.ts) checks that the image is exactly
// cols*stride by rows*stride and derives every UV from those two numbers, so
// slack pixels would make the table describe an image that is not the one it
// ships. Powers of two buy nothing here either: the target is WebGL2, which
// has no non-power-of-two restriction for a clamped, non-mipmapped texture,
// and this atlas is both -- Minecraft textures are pixel art and the renderer
// samples them nearest-neighbour.
//
// The grid is squarest rather than widest so the sheet stays inside the
// 4096-texel dimension limit the weakest plausible GL implementation
// guarantees; 1276 cells of 18 texels are 648x648 square but 22968x18 wide.
func fitSheet(count, stride int) (width, height, cols int, err error) {
	if count <= 0 {
		return 0, 0, 0, fmt.Errorf("atlas: no textures to pack")
	}
	cols = int(math.Ceil(math.Sqrt(float64(count))))
	rows := (count + cols - 1) / cols
	width, height = cols*stride, rows*stride
	if width > maxSheetEdge || height > maxSheetEdge {
		return 0, 0, 0, fmt.Errorf("atlas: %d cells of %d texels need a %dx%d sheet, past the %d-texel limit",
			count, stride, width, height, maxSheetEdge)
	}
	return width, height, cols, nil
}

// maxSheetEdge is the largest sheet dimension this will produce: the
// GL_MAX_TEXTURE_SIZE every WebGL2 implementation is required to support.
const maxSheetEdge = 4096

// drawWithBorder blits one cell at (x,y) and extends its outermost row and
// column outward by border texels.
//
// Without this the atlas looks right at 1:1 and falls apart everywhere else:
// linear filtering samples across a cell edge and pulls in whichever
// unrelated texture was packed next door, and the first mip level averages
// the two together permanently. A duplicated border makes both sample the
// cell's own edge instead. (The half-texel inset Table.Inset also provides
// protects the 1:1 and linear cases but not the mipmapped one -- hence
// both.)
func drawWithBorder(dst, src *image.NRGBA, x, y, border int) {
	n := src.Bounds().Dx()
	draw.Draw(dst, image.Rect(x, y, x+n, y+n), src, src.Bounds().Min, draw.Src)
	if border == 0 {
		return
	}
	clamp := func(v int) int {
		if v < 0 {
			return 0
		}
		if v >= n {
			return n - 1
		}
		return v
	}
	for dy := -border; dy < n+border; dy++ {
		for dx := -border; dx < n+border; dx++ {
			if dx >= 0 && dx < n && dy >= 0 && dy < n {
				continue
			}
			dst.SetNRGBA(x+dx, y+dy, src.NRGBAAt(clamp(dx), clamp(dy)))
		}
	}
}

func notes(terrainPath, blocksPath string) []string {
	return []string{
		"Nothing in this file or its atlas.png is committed to the repository: the pixels belong to " +
			"Mojang, and are read from a resource pack the user supplied or the tool downloaded, " +
			"never vendored.",
		"Texture bindings were read from " + filepath.ToSlash(blocksPath) + " and " +
			filepath.ToSlash(terrainPath) + ".",
		"Cells are laid out in sorted texture-path order, so the same pack always produces the same " +
			"atlas byte for byte.",
		"Each cell carries a border of duplicated edge texels (see \"border\") so linear filtering " +
			"and the first mip level cannot sample a neighbouring cell. Deeper mip levels would need " +
			"the 8-texel padding vanilla's own terrain_texture.json declares, and a sheet four times " +
			"the area; the renderer this feeds samples nearest-neighbour, because Minecraft textures " +
			"are pixel art and linear filtering makes them mush.",
		"\"render\" is measured from each texture's alpha, not declared: a vanilla resource pack " +
			"names no render method for a vanilla block (only a pack's own blocks do, in " +
			"minecraft:material_instances). All-255 alpha is opaque, a hard 0-or-255 split is cutout, " +
			"anything in between is translucent.",
		"\"grey\" marks a texture measurably close to neutral, which in vanilla means it is baked " +
			"greyscale to be multiplied by a runtime biome colour. Rendering one untinted looks grey " +
			"and obviously wrong, so every block face over such a texture carries a tint channel and, " +
			"where one could be measured, a concrete multiplier in \"tint_color\". No tint is ever " +
			"baked into the atlas.",
		"Flipbook textures (a strip of square frames) contribute frame 0 only; \"frames\" records how " +
			"many the source held so an animated renderer can find the rest.",
		"terrain_texture.json's multi-entry keys are the engine's legacy per-data-value texture " +
			"lists. Every entry is packed and listed in \"variants\" in file order; \"textures\" names " +
			"the first. Choosing between them is a block-state question this table deliberately does " +
			"not answer.",
	}
}
