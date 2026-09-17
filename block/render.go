// render.go is the APPEARANCE half of what a pack's blocks/**/*.json
// declares: which texture each face of a custom block uses, how that face
// should be drawn (opaque / cutout / translucent), and what shape the block
// is. tags.go reads the same files for tag membership, placement_filter and
// multi_block; this file adds to THAT walk (see LoadBlockTags) rather than
// opening every block file a second time.
//
// Why it exists: in a typical add-on a large share of the distinct block
// names actually placed are the pack's OWN blocks, not vanilla ones.
// Every one of those used to draw as a hash colour, so for an add-on
// author previewing their own pack the preview is largely noise. This is
// the data extraction that lets them be drawn properly; the atlas, the
// wire delivery and the mesher are elsewhere.
//
// ---- The three components, and what each one is for ----
//
//   - minecraft:material_instances -- a map from FACE NAME ("up", "down",
//     "north", "south", "east", "west", "side", "*") or a USER-DEFINED
//     instance name to a material: a "texture" key, a "render_method", and
//     optional "tint_method" / "face_dimming" / "ambient_occlusion" /
//     "isotropic". A value may also be a bare STRING naming another entry
//     in the same map -- an alias, resolved here (see resolveInstances).
//     The alias form is the one that quietly produces missing textures
//     rather than an error if it is not handled, which is why it is
//     handled first and tested directly.
//   - minecraft:geometry -- the block's model. Either one of the two
//     engine built-ins this port draws to shape
//     (minecraft:geometry.full_block, minecraft:geometry.cross), or a
//     resource-pack model identifier, which is NOT drawn to shape here (see
//     the scope note below). On newer format versions the value is an
//     object carrying "identifier" plus "bone_visibility"/"culling"/
//     "uv_lock" rather than a bare string; both shapes are read.
//   - minecraft:block_shape -- the pre-1.19-ish predecessor of
//     minecraft:geometry. Packs in the wild still use it, so it is read,
//     but only its two shape names that correspond to something this port
//     draws are recognised.
//
// ---- Scope: a geometry-file model renderer is NOT built here ----
//
// A block whose geometry is a resource-pack model is recorded with
// Shape == ShapeUnsupported and given a RenderNote naming the block and the
// geometry identifier, ONCE PER BLOCK. Its material_instances textures are
// still fully resolved, so it draws as a correctly-textured full cube
// rather than as a hash colour -- strictly better than today, and the note
// is what stops an author having to guess why their sculpted block came out
// square. Nothing here silently pretends a model was understood.
//
// ---- What is deliberately not read ----
//
// Only the top-level minecraft:block.components bag is read, exactly as
// LoadBlockTags already documents for tag components. Real blocks can also
// override minecraft:geometry and minecraft:material_instances per
// "permutations" entry (e.g. a multi-part multiblock that swaps geometry per
// block-state value), and resolving those needs
// per-state evaluation that this port's Descriptor.States plumbing does not
// carry into block appearance at all. A permutation-scoped override is
// therefore not seen, and the top-level declaration -- which every such
// block also carries -- is what gets drawn. In practice nearly every block
// file declares material_instances at the top level.
//
// minecraft:item_visual (the held-item render) is a different component for
// a different surface and is not read here.

package block

import (
	"fmt"
	"sort"
	"strings"
)

// faceNames is the JSON/material_instances spelling of each Face, indexed
// by the Face value itself -- so the six names used as material_instances
// keys and the engine Facing enum support.go already models stay one table,
// not two that can drift.
var faceNames = [6]string{
	FaceDown: "down", FaceUp: "up", FaceNorth: "north",
	FaceSouth: "south", FaceWest: "west", FaceEast: "east",
}

// Name is f's spelling in pack JSON -- the string a material_instances key,
// an allowed_faces entry or a block-table face name is written as.
func (f Face) Name() string {
	if int(f) >= len(faceNames) {
		return ""
	}
	return faceNames[f]
}

// RenderFaces is the six cube faces a material_instances map is resolved
// onto, in the engine's own Facing order so anything enumerating them is
// deterministic.
var RenderFaces = faceNames

// horizontalFaces is what the "side" material_instances key expands to --
// the four horizontal faces, and NOT up/down. (The same word means the same
// four faces in minecraft:placement_filter's allowed_faces, where it is a
// pinned mask of north|south|west|east; see tags.go.)
var horizontalFaces = [4]string{
	FaceNorth.Name(), FaceSouth.Name(), FaceWest.Name(), FaceEast.Name(),
}

// Shape is how a block is drawn. Only the two engine built-ins are drawn to
// shape; everything else is ShapeUnsupported and draws as a full cube.
const (
	ShapeFullBlock   = "full_block"
	ShapeCross       = "cross"
	ShapeUnsupported = "unsupported"
)

// Render vocabulary -- the "render" field's three values, shared by pack
// blocks and vanilla blocks so both arrive at the renderer in one format.
const (
	RenderOpaque      = "opaque"
	RenderCutout      = "cutout"
	RenderTranslucent = "translucent"
)

// MaterialInstance is one resolved minecraft:material_instances entry.
type MaterialInstance struct {
	// Instance is the material_instances key this face resolved through
	// ("*", "side", a face name, or a user-defined instance name reached
	// through an alias). Kept so a diagnostic can say where a texture came
	// from rather than just what it is.
	Instance string `json:"instance,omitempty"`
	// Texture is the "texture" value verbatim: a terrain_texture.json KEY
	// (e.g. "mypack:limestone"), not a file path. Resolving it needs the
	// pack's OWN resource pack -- see internal/packrender.
	Texture string `json:"texture"`
	// RenderMethod is "render_method" verbatim, "" when the entry omits it.
	RenderMethod string `json:"renderMethod,omitempty"`
	// Render is RenderMethod normalised into the three-value contract
	// vocabulary (see normaliseRenderMethod for the mapping and where each
	// mapping comes from).
	Render string `json:"render"`
	// DoubleSided is true when the render method draws back faces --
	// alpha_test and double_sided. A cross-shaped plant needs it; a solid
	// cube must not have it, or interior faces show through.
	DoubleSided bool `json:"doubleSided,omitempty"`
	// Tint is "tint_method" verbatim ("grass", "water", "default_foliage",
	// ...), "" when absent. This is the pack-block equivalent of the tint
	// CHANNEL the contract's table carries per face: a greyscale texture
	// multiplied by a runtime colour, which renders grey and wrong if the
	// multiply is skipped.
	Tint string `json:"tint,omitempty"`
	// FaceDimming is "face_dimming" (schema default true) -- whether the
	// per-face shading multiply applies to this face. The mesher's existing
	// per-face shade constants are exactly what this switches off.
	FaceDimming bool `json:"faceDimming"`
	// AmbientOcclusion is "ambient_occlusion" (schema default true).
	AmbientOcclusion bool `json:"ambientOcclusion"`
	// Isotropic is "isotropic" (schema default false) -- the texture is
	// randomly rotated per block instance to break up tiling.
	Isotropic bool `json:"isotropic,omitempty"`

	// knownMethod records whether RenderMethod was one this port
	// recognises. Unexported: it drives a note, not the drawing.
	knownMethod bool
}

// BlockGeometry is a block's resolved minecraft:geometry /
// minecraft:block_shape.
type BlockGeometry struct {
	// Identifier is the geometry identifier verbatim
	// ("minecraft:geometry.full_block", "geometry.mypack.thing"), or the
	// block_shape name for a legacy declaration, or "" when the block
	// declares neither.
	Identifier string `json:"identifier,omitempty"`
	// Shape is one of ShapeFullBlock / ShapeCross / ShapeUnsupported.
	Shape string `json:"shape"`
	// Source is which component Shape came from: "minecraft:geometry",
	// "minecraft:block_shape", or "default" when neither was declared.
	Source string `json:"source"`
}

// BlockRender is everything blocks/**/*.json says about how one block
// looks. Faces is keyed by the six RenderFaces names; a face is ABSENT
// when the block's material_instances declares nothing that covers it --
// which is a real, distinguishable state ("this pack never said"), not the
// same as a face whose texture key turns out to be missing from the
// resource pack.
type BlockRender struct {
	// Name is the canonical block name (minecraft:-prefixed when the
	// source identifier carried no namespace), matching Entry.Name.
	Name string `json:"name"`
	// Faces maps a RenderFaces name to that face's resolved material.
	Faces map[string]MaterialInstance `json:"faces"`
	// Extra holds material instances that are NOT one of the face names or
	// "*"/"side" -- user-defined instance names a geometry model's bones
	// reference by material name.
	// Recorded rather than dropped so nothing about a block is silently
	// lost, but unused until models are drawn.
	Extra map[string]MaterialInstance `json:"extra,omitempty"`
	// Geometry is the block's shape.
	Geometry BlockGeometry `json:"geometry"`
	// FileID is the blocks/ file this block was read from -- so a note
	// about it can point at a file the author can open.
	FileID string `json:"fileId"`
}

// Render is the whole block's render class: the strongest of its faces'.
// A block with any translucent face is translucent, else any cutout face
// makes it cutout, else opaque. The renderer needs one draw pass per block,
// not per face, and picking the strongest is the choice that never draws a
// transparent face as if it were solid.
func (b BlockRender) Render() string {
	render := RenderOpaque
	for _, name := range RenderFaces {
		switch b.Faces[name].Render {
		case RenderTranslucent:
			return RenderTranslucent
		case RenderCutout:
			render = RenderCutout
		}
	}
	return render
}

// RenderNote is one thing about a block's appearance that this port read
// but cannot fully draw, attributed to the block and the file it came from.
// One note per BLOCK, never one per placed cell: the same custom block can
// fill thousands of cells in one preview and repeating a note per cell
// would be an unreadable wall, exactly as session.Diagnostic's own Count
// field already exists to avoid.
type RenderNote struct {
	Block   string `json:"block"`
	FileID  string `json:"fileId"`
	Message string `json:"message"`
}

// blockRenderData is the pack's own per-block appearance index, built by
// the SAME LoadBlockTags walk that builds tagData/placementFilterData/
// multiBlockData.
//
// Only blocks that DECLARE at least one of the three components get an
// entry. That keeps the index to a pack's own textured blocks: the
// generated vanilla catalogue block.DefaultBlocks() stacks underneath every
// pack load and declares an empty components bag for all 1238 of its
// blocks, so it contributes nothing here -- vanilla appearance comes from
// the vanilla atlas, not from this index.
type blockRenderData struct {
	byBlock map[string]BlockRender
	notes   map[string]RenderNote // block name -> note, deduplicated
}

// parseBlockRender reads the three appearance components out of an
// already-decoded top-level components bag (plus the canonical block name
// and source file id for attribution) and returns the block's BlockRender
// plus any note about what could not be fully honoured.
//
// ok is false when the block declares none of the three components at all
// -- "component absent -> nothing to say", the same default shape
// LoadBlockTags' other indexes use, and the reason the vanilla catalogue
// does not fill this index with 1238 empty entries.
func parseBlockRender(canonical, fileID string, components map[string]any) (br BlockRender, notes []RenderNote, ok bool) {
	rawMaterials, hasMaterials := components["minecraft:material_instances"]
	rawGeometry, hasGeometry := components["minecraft:geometry"]
	rawShape, hasShape := components["minecraft:block_shape"]
	if !hasMaterials && !hasGeometry && !hasShape {
		return BlockRender{}, nil, false
	}

	br = BlockRender{Name: canonical, FileID: fileID}

	faces, extra, matNotes := parseMaterialInstances(canonical, fileID, rawMaterials)
	br.Faces, br.Extra = faces, extra
	if br.Faces == nil {
		br.Faces = map[string]MaterialInstance{}
	}

	geom, geomNote := parseGeometry(canonical, fileID, rawGeometry, hasGeometry, rawShape, hasShape)
	br.Geometry = geom

	// The geometry note goes FIRST, because only one note per block
	// survives (see LoadBlockTags) and "this block is a cube because its
	// model is not drawn" is the sentence a reader almost always needs:
	// it explains the whole silhouette, where a material note explains one
	// face. A block whose geometry IS drawable produces no geometry note,
	// so its material note is still the one that shows.
	if geomNote != nil {
		notes = append(notes, *geomNote)
	}
	notes = append(notes, matNotes...)
	return br, notes, true
}

// parseMaterialInstances resolves a minecraft:material_instances map onto
// the six cube faces.
//
// Precedence, most specific wins: an explicit face name beats "side", which
// beats "*". That ordering is what makes the common
// {"*": ..., "up": ..., "down": ...} shape
// come out right, and it is the only ordering under which declaring a
// specific face has any effect at all.
// A nil raw (the component is absent entirely, which some blocks do)
// resolves to no faces and no notes -- the block still gets an
// entry for its geometry, and simply says nothing about its textures.
func parseMaterialInstances(canonical, fileID string, raw any) (faces, extra map[string]MaterialInstance, notes []RenderNote) {
	table, _ := raw.(map[string]any)
	if len(table) == 0 {
		return nil, nil, nil
	}

	faces = make(map[string]MaterialInstance, len(RenderFaces))
	assign := func(key string) {
		inst, note, ok := resolveInstance(canonical, fileID, table, key)
		if note != nil {
			notes = append(notes, *note)
		}
		if !ok {
			return
		}
		switch key {
		case "*":
			for _, face := range RenderFaces {
				faces[face] = inst
			}
		case "side":
			for _, face := range horizontalFaces {
				faces[face] = inst
			}
		default:
			faces[key] = inst
		}
	}
	// Least specific first, so a later, more specific assignment overwrites.
	assign("*")
	assign("side")
	for _, face := range RenderFaces {
		if _, declared := table[face]; declared {
			assign(face)
		}
	}

	for key := range table {
		if key == "*" || key == "side" || isRenderFace(key) {
			continue
		}
		inst, note, ok := resolveInstance(canonical, fileID, table, key)
		if note != nil {
			notes = append(notes, *note)
		}
		if !ok {
			continue
		}
		if extra == nil {
			extra = map[string]MaterialInstance{}
		}
		extra[key] = inst
	}

	sortNotes(notes)
	return faces, extra, notes
}

// maxInstanceAliasHops bounds alias chasing. A material_instances value may
// be a bare string naming ANOTHER entry in the same map -- the aliasing
// form -- and nothing in the file format stops that pointing in a circle.
// The bound is what turns a malformed pack into a note instead of a hang.
const maxInstanceAliasHops = 8

// resolveInstance returns the material for one material_instances key,
// following the string-alias form ({"grass": {...}, "up": "grass"}) to the
// object it names.
//
// ok is false when the key is not declared at all -- the ordinary case for
// most keys of most blocks, and not worth a note. It is also false, WITH a
// note, when the key is declared but its alias does not lead anywhere: an
// alias naming a missing instance is the failure mode that produces a
// silently untextured face rather than an error, so it is reported.
func resolveInstance(canonical, fileID string, table map[string]any, key string) (MaterialInstance, *RenderNote, bool) {
	seen := key
	for hop := 0; hop <= maxInstanceAliasHops; hop++ {
		value, declared := table[key]
		if !declared {
			if hop == 0 {
				return MaterialInstance{}, nil, false
			}
			return MaterialInstance{}, &RenderNote{Block: canonical, FileID: fileID, Message: fmt.Sprintf(
				"minecraft:material_instances %q refers to material instance %q, which this block does not declare -- that face is left untextured",
				seen, key)}, false
		}
		if alias, isAlias := value.(string); isAlias {
			key = alias
			continue
		}
		obj, isObject := value.(map[string]any)
		if !isObject {
			return MaterialInstance{}, &RenderNote{Block: canonical, FileID: fileID, Message: fmt.Sprintf(
				"minecraft:material_instances %q is neither a material object nor the name of another instance -- that face is left untextured", seen)}, false
		}
		inst := decodeMaterialInstance(key, obj)
		if inst.Texture == "" {
			return MaterialInstance{}, &RenderNote{Block: canonical, FileID: fileID, Message: fmt.Sprintf(
				"minecraft:material_instances %q declares no \"texture\" -- that face is left untextured", key)}, false
		}
		if !inst.knownMethod {
			return inst, &RenderNote{Block: canonical, FileID: fileID, Message: fmt.Sprintf(
				"minecraft:material_instances %q declares render_method %q, which this preview does not recognise -- that face is drawn as opaque",
				key, inst.RenderMethod)}, true
		}
		return inst, nil, true
	}
	return MaterialInstance{}, &RenderNote{Block: canonical, FileID: fileID, Message: fmt.Sprintf(
		"minecraft:material_instances %q chases more than %d instance aliases -- almost certainly a cycle; that face is left untextured",
		seen, maxInstanceAliasHops)}, false
}

// decodeMaterialInstance reads one material object. Every optional field's
// default is the SCHEMA's documented default, applied here rather than left
// as a zero value, so a consumer never has to know which absent fields mean
// true: face_dimming and ambient_occlusion default TRUE (a zero-valued Go
// bool would silently mean the opposite), isotropic defaults false,
// render_method defaults to opaque.
func decodeMaterialInstance(instance string, obj map[string]any) MaterialInstance {
	inst := MaterialInstance{Instance: instance, FaceDimming: true, AmbientOcclusion: true}
	inst.Texture, _ = obj["texture"].(string)
	inst.RenderMethod, _ = obj["render_method"].(string)
	inst.Tint, _ = obj["tint_method"].(string)
	if v, ok := obj["face_dimming"].(bool); ok {
		inst.FaceDimming = v
	}
	if v, ok := obj["ambient_occlusion"].(bool); ok {
		inst.AmbientOcclusion = v
	}
	if v, ok := obj["isotropic"].(bool); ok {
		inst.Isotropic = v
	}
	inst.Render, inst.DoubleSided, inst.knownMethod = normaliseRenderMethod(inst.RenderMethod)
	return inst
}

// normaliseRenderMethod maps a render_method onto the contract table's
// three-value "render" vocabulary plus a back-face flag.
//
// The "_to_opaque" suffix (alpha_test_to_opaque, blend_to_opaque,
// alpha_test_single_sided_to_opaque) is a DISTANCE optimisation: the engine draws the cheap opaque
// variant beyond a threshold. A bounded preview volume is entirely inside
// that threshold, so the suffix is stripped and the base method used.
//
// alpha_test is treated as DOUBLE-sided and alpha_test_single_sided as
// single-sided. That follows from the pair itself: a separately-named
// "single sided" variant only earns its name if the unsuffixed one is not.
// double_sided is likewise the no-back-face-culling form of opaque.
//
// An unrecognised method is treated as opaque -- the same thing an
// unrecognised method gets today, since today nothing is textured at all --
// and reported as unrecognised so a typo does not pass silently.
func normaliseRenderMethod(method string) (render string, doubleSided, known bool) {
	base := method
	if trimmed, cut := strings.CutSuffix(base, "_to_opaque"); cut && trimmed != "" {
		base = trimmed
	}
	switch base {
	case "", "opaque":
		return RenderOpaque, false, true
	case "double_sided":
		return RenderOpaque, true, true
	case "alpha_test":
		return RenderCutout, true, true
	case "alpha_test_single_sided":
		return RenderCutout, false, true
	case "blend":
		return RenderTranslucent, false, true
	default:
		return RenderOpaque, false, false
	}
}

func isRenderFace(key string) bool {
	for _, face := range RenderFaces {
		if key == face {
			return true
		}
	}
	return false
}

// builtinGeometry is the two engine geometry identifiers this port draws to
// shape. Everything else is a resource-pack model.
var builtinGeometry = map[string]string{
	"minecraft:geometry.full_block": ShapeFullBlock,
	"minecraft:geometry.cross":      ShapeCross,
}

// legacyBlockShapes is the minecraft:block_shape names that correspond to
// something this port draws to shape. This is deliberately SHORT: the
// legacy component accepted a long list of engine shape names, and only
// these have a counterpart here. Any other legacy name is treated exactly
// like an unsupported model geometry -- textured full cube plus a note --
// rather than guessed at.
var legacyBlockShapes = map[string]string{
	"block":         ShapeFullBlock,
	"cube":          ShapeFullBlock,
	"full_block":    ShapeFullBlock,
	"cross_texture": ShapeCross,
	"cross":         ShapeCross,
}

// parseGeometry resolves minecraft:geometry, falling back to the legacy
// minecraft:block_shape when the modern component is absent, and to a full
// block when both are (which is what the engine draws for a block that
// declares no geometry at all).
func parseGeometry(canonical, fileID string, rawGeometry any, hasGeometry bool, rawShape any, hasShape bool) (BlockGeometry, *RenderNote) {
	if hasGeometry {
		identifier := geometryIdentifier(rawGeometry)
		if identifier == "" {
			return BlockGeometry{Shape: ShapeFullBlock, Source: "minecraft:geometry"}, &RenderNote{
				Block: canonical, FileID: fileID,
				Message: "minecraft:geometry declares no geometry identifier -- drawn as a full cube"}
		}
		if shape, builtin := builtinGeometry[identifier]; builtin {
			return BlockGeometry{Identifier: identifier, Shape: shape, Source: "minecraft:geometry"}, nil
		}
		return BlockGeometry{Identifier: identifier, Shape: ShapeUnsupported, Source: "minecraft:geometry"},
			&RenderNote{Block: canonical, FileID: fileID, Message: unsupportedGeometryMessage(identifier, "minecraft:geometry")}
	}
	if hasShape {
		identifier, _ := rawShape.(string)
		if shape, known := legacyBlockShapes[identifier]; known {
			return BlockGeometry{Identifier: identifier, Shape: shape, Source: "minecraft:block_shape"}, nil
		}
		return BlockGeometry{Identifier: identifier, Shape: ShapeUnsupported, Source: "minecraft:block_shape"},
			&RenderNote{Block: canonical, FileID: fileID, Message: unsupportedGeometryMessage(identifier, "minecraft:block_shape")}
	}
	return BlockGeometry{Shape: ShapeFullBlock, Source: "default"}, nil
}

// unsupportedGeometryMessage is the one thing an add-on author whose custom
// block came out square actually needs to read: which block, which
// geometry, what was drawn instead, and what IS drawn to shape. Phrased so
// it reads as a stated limit of the preview rather than as a fault in their
// pack, because it is one.
func unsupportedGeometryMessage(identifier, component string) string {
	return fmt.Sprintf(
		"%s %q is a resource-pack model; the preview does not draw model geometry and draws this block as a full cube with its own material_instances textures instead (only minecraft:geometry.full_block and minecraft:geometry.cross are drawn to shape)",
		component, identifier)
}

// geometryIdentifier reads the identifier out of either shape
// minecraft:geometry takes: a bare string, or (newer format versions) an
// object carrying "identifier" alongside "bone_visibility"/"culling"/
// "culling_layer"/"uv_lock". Those siblings are all properties of a MODEL,
// and a model is not drawn here, so reading the identifier is enough to
// classify the block -- and a block that carries them is, by construction,
// already getting the unsupported-geometry note that says so.
func geometryIdentifier(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case map[string]any:
		id, _ := v["identifier"].(string)
		return id
	default:
		return ""
	}
}

func sortNotes(notes []RenderNote) {
	sort.SliceStable(notes, func(i, j int) bool {
		if notes[i].Block != notes[j].Block {
			return notes[i].Block < notes[j].Block
		}
		return notes[i].Message < notes[j].Message
	})
}

// BlockRender returns the pack's declared appearance for a block name.
//
// A nil index (no pack blocks/ directory ever loaded) returns false, the
// same "no pack loaded, fall back to what this tool did before" shape every
// other pack-fed index in this package uses -- never a zero value that
// would read as "the pack declared a block with no textures".
func (p *Palette) BlockRender(name string) (BlockRender, bool) {
	if p.renderData == nil {
		return BlockRender{}, false
	}
	br, ok := p.renderData.byBlock[canonicalName(name)]
	return br, ok
}

// BlockRenderNames returns every block the loaded pack declares appearance
// for, sorted.
func (p *Palette) BlockRenderNames() []string {
	if p.renderData == nil {
		return nil
	}
	out := make([]string, 0, len(p.renderData.byBlock))
	for name := range p.renderData.byBlock {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// BlockRenderNotes returns every note recorded while reading the pack's
// block appearance -- one per block, sorted by block name. This is the
// user-visible answer to "why did my custom block come out as a cube?", and
// is deliberately NOT folded into LoadBlockTags' Diagnostic return: using a
// model geometry is not a defect in a pack, so it must not appear in
// `featurelab check`'s pack-health output or affect its exit code. It is
// surfaced where it is relevant instead -- alongside the block table, and
// for the blocks a given preview actually placed.
func (p *Palette) BlockRenderNotes() []RenderNote {
	if p.renderData == nil {
		return nil
	}
	out := make([]RenderNote, 0, len(p.renderData.notes))
	for _, note := range p.renderData.notes {
		out = append(out, note)
	}
	sortNotes(out)
	return out
}

// BlockRenderNote returns the note recorded for one block, if any.
func (p *Palette) BlockRenderNote(name string) (RenderNote, bool) {
	if p.renderData == nil {
		return RenderNote{}, false
	}
	note, ok := p.renderData.notes[canonicalName(name)]
	return note, ok
}
