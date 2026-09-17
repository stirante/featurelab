package block

import (
	"strings"
	"testing"
)

// blockFile is the boilerplate every test here would otherwise repeat: a
// minimal blocks/*.json carrying one identifier and one components bag.
func blockFile(id, identifier, components string) SourceFile {
	return SourceFile{ID: id, Text: `{"format_version":"1.21.100","minecraft:block":{` +
		`"description":{"identifier":"` + identifier + `"},"components":{` + components + `}}}`}
}

// TestBlockRender_StarAndSideAndFacePrecedence pins the three material_instances
// key forms and, more importantly, the ORDER they resolve in: a specific face
// beats "side", which beats "*". Get that order wrong and declaring a face
// explicitly has no effect, which is silent and looks like a texture bug.
func TestBlockRender_StarAndSideAndFacePrecedence(t *testing.T) {
	p := NewPalette()
	diags := p.LoadBlockTags([]SourceFile{blockFile("p.json", "test:p", `
		"minecraft:material_instances": {
			"*":    {"texture": "star"},
			"side": {"texture": "side"},
			"up":   {"texture": "up"}
		}`)})
	if len(diags) != 0 {
		t.Fatalf("diagnostics = %+v, want none", diags)
	}
	br, ok := p.BlockRender("test:p")
	if !ok {
		t.Fatal("BlockRender(test:p) not found")
	}
	want := map[string]string{
		"up": "up", "down": "star",
		"north": "side", "south": "side", "west": "side", "east": "side",
	}
	for face, texture := range want {
		if got := br.Faces[face].Texture; got != texture {
			t.Errorf("face %s texture = %q, want %q", face, got, texture)
		}
	}
}

// TestBlockRender_StringAliasIndirection is the case the contract calls out as
// easy to miss and as producing MISSING TEXTURES rather than an error: a face's
// value is a bare string naming another instance in the same map.
func TestBlockRender_StringAliasIndirection(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("a.json", "test:a", `
		"minecraft:material_instances": {
			"bark":  {"texture": "log_side", "render_method": "opaque"},
			"rings": {"texture": "log_top"},
			"*":     "bark",
			"up":    "rings",
			"down":  "up"
		}`)})
	br, _ := p.BlockRender("test:a")
	for _, face := range [...]string{"north", "south", "west", "east"} {
		if got := br.Faces[face].Texture; got != "log_side" {
			t.Errorf("face %s texture = %q, want log_side (via the \"*\" -> \"bark\" alias)", face, got)
		}
	}
	if got := br.Faces["up"].Texture; got != "log_top" {
		t.Errorf("up texture = %q, want log_top (via the \"up\" -> \"rings\" alias)", got)
	}
	// A chain of aliases: down -> up -> rings.
	if got := br.Faces["down"].Texture; got != "log_top" {
		t.Errorf("down texture = %q, want log_top (via a two-hop alias chain)", got)
	}
	if got := br.Faces["up"].Instance; got != "rings" {
		t.Errorf("up instance = %q, want rings -- the instance an alias landed on, not the alias", got)
	}
}

// TestBlockRender_AliasCycleIsNotedNotHung pins that a circular alias produces a
// note and an untextured face rather than looping forever.
func TestBlockRender_AliasCycleIsNotedNotHung(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("c.json", "test:c", `
		"minecraft:material_instances": {"*": "a", "a": "b", "b": "a"}`)})
	br, ok := p.BlockRender("test:c")
	if !ok {
		t.Fatal("BlockRender(test:c) not found")
	}
	if len(br.Faces) != 0 {
		t.Errorf("faces = %+v, want none -- a cyclic alias textures nothing", br.Faces)
	}
	if _, has := p.BlockRenderNote("test:c"); !has {
		t.Error("want a note about the alias cycle")
	}
}

// TestBlockRender_AliasToMissingInstance is the other half of the alias risk: an
// alias that names an instance the block never declares must be REPORTED, since
// its whole symptom is an untextured face and no error.
func TestBlockRender_AliasToMissingInstance(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("m.json", "test:m", `
		"minecraft:material_instances": {"*": {"texture": "base"}, "up": "nope"}`)})
	br, _ := p.BlockRender("test:m")
	if got := br.Faces["up"].Texture; got != "base" {
		t.Errorf("up texture = %q, want the \"*\" material -- a broken alias must not erase the default", got)
	}
	note, has := p.BlockRenderNote("test:m")
	if !has {
		t.Fatal("want a note naming the missing instance")
	}
	if !strings.Contains(note.Message, `"nope"`) {
		t.Errorf("note = %q, want it to name the missing instance", note.Message)
	}
}

// TestBlockRender_RenderMethods pins the render_method mapping, including the
// "_to_opaque" distance variants and the alpha_test/alpha_test_single_sided
// back-face split.
func TestBlockRender_RenderMethods(t *testing.T) {
	cases := []struct {
		method      string
		render      string
		doubleSided bool
		known       bool
	}{
		{"", RenderOpaque, false, true},
		{"opaque", RenderOpaque, false, true},
		{"double_sided", RenderOpaque, true, true},
		{"alpha_test", RenderCutout, true, true},
		{"alpha_test_single_sided", RenderCutout, false, true},
		{"blend", RenderTranslucent, false, true},
		{"alpha_test_to_opaque", RenderCutout, true, true},
		{"alpha_test_single_sided_to_opaque", RenderCutout, false, true},
		{"blend_to_opaque", RenderTranslucent, false, true},
		{"there_is_no_such_method", RenderOpaque, false, false},
	}
	for _, c := range cases {
		render, doubleSided, known := normaliseRenderMethod(c.method)
		if render != c.render || doubleSided != c.doubleSided || known != c.known {
			t.Errorf("normaliseRenderMethod(%q) = (%q, %v, %v), want (%q, %v, %v)",
				c.method, render, doubleSided, known, c.render, c.doubleSided, c.known)
		}
	}
}

// TestBlockRender_SchemaDefaults pins that the optional material fields come out
// as their SCHEMA defaults rather than their Go zero values -- face_dimming and
// ambient_occlusion default TRUE, and a zero-valued bool would silently mean the
// opposite of what the pack said by saying nothing.
func TestBlockRender_SchemaDefaults(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("d.json", "test:d", `
		"minecraft:material_instances": {"*": {"texture": "t"}}`)})
	br, _ := p.BlockRender("test:d")
	inst := br.Faces["up"]
	if !inst.FaceDimming || !inst.AmbientOcclusion {
		t.Errorf("face_dimming/ambient_occlusion = %v/%v, want true/true", inst.FaceDimming, inst.AmbientOcclusion)
	}
	if inst.Isotropic {
		t.Error("isotropic = true, want false")
	}
	if inst.Render != RenderOpaque {
		t.Errorf("render = %q, want opaque for an absent render_method", inst.Render)
	}
}

// TestBlockRender_TintMethodBecomesTheTintChannel pins that tint_method survives
// verbatim. A greyscale texture rendered untinted looks grey and wrong, so this
// is the field that decides whether a custom grass block is green.
func TestBlockRender_TintMethodBecomesTheTintChannel(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("t.json", "test:t", `
		"minecraft:material_instances": {"*": {"texture": "g", "tint_method": "grass"}}`)})
	br, _ := p.BlockRender("test:t")
	if got := br.Faces["up"].Tint; got != "grass" {
		t.Errorf("tint = %q, want grass", got)
	}
}

// TestBlockRender_Geometry covers every shape minecraft:geometry takes, plus the
// legacy minecraft:block_shape and the both-absent default.
func TestBlockRender_Geometry(t *testing.T) {
	cases := []struct {
		name       string
		components string
		shape      string
		identifier string
		source     string
		wantNote   bool
	}{
		{"builtin full block", `"minecraft:geometry": "minecraft:geometry.full_block"`,
			ShapeFullBlock, "minecraft:geometry.full_block", "minecraft:geometry", false},
		{"builtin cross", `"minecraft:geometry": "minecraft:geometry.cross"`,
			ShapeCross, "minecraft:geometry.cross", "minecraft:geometry", false},
		{"object form", `"minecraft:geometry": {"identifier": "minecraft:geometry.full_block"}`,
			ShapeFullBlock, "minecraft:geometry.full_block", "minecraft:geometry", false},
		{"object form with bone_visibility", `"minecraft:geometry": {"identifier": "geometry.p.thing",
			"bone_visibility": {"bone": true}, "uv_lock": true}`,
			ShapeUnsupported, "geometry.p.thing", "minecraft:geometry", true},
		{"model", `"minecraft:geometry": "geometry.p.sculpted"`,
			ShapeUnsupported, "geometry.p.sculpted", "minecraft:geometry", true},
		{"legacy block", `"minecraft:block_shape": "block"`,
			ShapeFullBlock, "block", "minecraft:block_shape", false},
		{"legacy cross_texture", `"minecraft:block_shape": "cross_texture"`,
			ShapeCross, "cross_texture", "minecraft:block_shape", false},
		{"legacy unrecognised", `"minecraft:block_shape": "chest"`,
			ShapeUnsupported, "chest", "minecraft:block_shape", true},
		{"neither, but a material", `"minecraft:material_instances": {"*": {"texture": "t"}}`,
			ShapeFullBlock, "", "default", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := NewPalette()
			p.LoadBlockTags([]SourceFile{blockFile("g.json", "test:g", c.components)})
			br, ok := p.BlockRender("test:g")
			if !ok {
				t.Fatal("BlockRender(test:g) not found")
			}
			if br.Geometry.Shape != c.shape || br.Geometry.Identifier != c.identifier || br.Geometry.Source != c.source {
				t.Errorf("geometry = %+v, want shape %q identifier %q source %q",
					br.Geometry, c.shape, c.identifier, c.source)
			}
			note, has := p.BlockRenderNote("test:g")
			if has != c.wantNote {
				t.Fatalf("note present = %v (%q), want %v", has, note.Message, c.wantNote)
			}
			if c.wantNote && !strings.Contains(note.Message, c.identifier) {
				t.Errorf("note = %q, want it to name the geometry %q", note.Message, c.identifier)
			}
		})
	}
}

// TestBlockRender_UnsupportedGeometryKeepsItsTextures is the whole point of the
// fallback: a block whose model this preview cannot draw still gets its real
// textures on a cube, which is strictly better than the hash colour it gets
// today -- and is told, once, why it is a cube.
func TestBlockRender_UnsupportedGeometryKeepsItsTextures(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("u.json", "test:u", `
		"minecraft:geometry": "geometry.p.sculpted",
		"minecraft:material_instances": {"*": {"texture": "sculpted", "render_method": "alpha_test"}}`)})
	br, _ := p.BlockRender("test:u")
	if len(br.Faces) != len(RenderFaces) {
		t.Fatalf("faces = %d, want all %d textured despite the unsupported geometry", len(br.Faces), len(RenderFaces))
	}
	if br.Render() != RenderCutout {
		t.Errorf("render = %q, want cutout", br.Render())
	}
	note, has := p.BlockRenderNote("test:u")
	if !has {
		t.Fatal("want a note")
	}
	for _, want := range []string{"geometry.p.sculpted", "full cube", "minecraft:geometry.cross"} {
		if !strings.Contains(note.Message, want) {
			t.Errorf("note = %q, want it to mention %q", note.Message, want)
		}
	}
}

// TestBlockRender_OneNotePerBlock pins the "once per block" rule: a block with
// several unhappy faces still contributes exactly one note, because the same
// custom block can fill thousands of preview cells.
func TestBlockRender_OneNotePerBlock(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("n.json", "test:n", `
		"minecraft:geometry": "geometry.p.sculpted",
		"minecraft:material_instances": {"up": "gone", "down": "alsogone"}`)})
	notes := p.BlockRenderNotes()
	if len(notes) != 1 {
		t.Fatalf("notes = %d (%+v), want exactly 1", len(notes), notes)
	}
	if notes[0].Block != "test:n" || notes[0].FileID != "n.json" {
		t.Errorf("note = %+v, want it attributed to test:n in n.json", notes[0])
	}
}

// TestBlockRender_NoComponentsMeansNoEntry pins the "component absent ->
// nothing to say" default LoadBlockTags' other indexes use. It is also what
// keeps the generated vanilla catalogue -- an empty components bag on every one
// of its blocks -- out of this index entirely.
func TestBlockRender_NoComponentsMeansNoEntry(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("e.json", "test:e", `"tag:dirt": {}`)})
	if _, ok := p.BlockRender("test:e"); ok {
		t.Error("BlockRender(test:e) found an entry for a block that declares no appearance component")
	}
	if names := p.BlockRenderNames(); len(names) != 0 {
		t.Errorf("BlockRenderNames = %v, want none", names)
	}
	vanillaLoaded := 0
	for _, f := range DefaultBlocks() {
		vanillaLoaded++
		_ = f
	}
	if vanillaLoaded == 0 {
		t.Fatal("DefaultBlocks() is empty -- this test's premise no longer holds")
	}
	p2 := NewPalette()
	p2.LoadBlockTags(DefaultBlocks())
	if names := p2.BlockRenderNames(); len(names) != 0 {
		t.Errorf("the generated vanilla catalogue contributed %d render entries, want 0", len(names))
	}
}

// TestBlockRender_NilIndexFallsBack pins the "no pack loaded, fall back" shape
// every pack-fed index in this package uses: never a zero value that reads as
// "the pack declared a block with no textures".
func TestBlockRender_NilIndexFallsBack(t *testing.T) {
	p := NewPalette()
	if _, ok := p.BlockRender("test:anything"); ok {
		t.Error("BlockRender returned ok with no LoadBlockTags call ever made")
	}
	if p.BlockRenderNames() != nil || p.BlockRenderNotes() != nil {
		t.Error("want nil name/note lists before any pack is loaded")
	}
	if _, ok := p.BlockRenderNote("test:anything"); ok {
		t.Error("BlockRenderNote returned ok with no LoadBlockTags call ever made")
	}
}

// TestBlockRender_LaterFileWinsOutright mirrors LoadBlockTags' own documented
// rule for tags: a later file declaring the same identifier REPLACES the
// earlier one, including replacing its note with no note.
func TestBlockRender_LaterFileWinsOutright(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{
		blockFile("first.json", "test:w", `"minecraft:geometry": "geometry.p.model",
			"minecraft:material_instances": {"*": {"texture": "old"}}`),
		blockFile("second.json", "test:w", `"minecraft:geometry": "minecraft:geometry.cross",
			"minecraft:material_instances": {"*": {"texture": "new"}}`),
	})
	br, _ := p.BlockRender("test:w")
	if br.Geometry.Shape != ShapeCross || br.Faces["up"].Texture != "new" {
		t.Errorf("block = %+v, want the second file's cross geometry and \"new\" texture", br)
	}
	if note, has := p.BlockRenderNote("test:w"); has {
		t.Errorf("note = %q, want none -- the later file's geometry is drawable", note.Message)
	}
}

// TestBlockRender_UserDefinedInstancesAreKeptNotDropped pins that a named
// instance which is not a face (a geometry model's bone material) is recorded
// in Extra rather than silently discarded.
func TestBlockRender_UserDefinedInstancesAreKeptNotDropped(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("x.json", "test:x", `
		"minecraft:material_instances": {"*": {"texture": "shell"}, "yolk": {"texture": "yolk"}}`)})
	br, _ := p.BlockRender("test:x")
	if got := br.Extra["yolk"].Texture; got != "yolk" {
		t.Errorf("Extra[yolk] = %q, want the yolk texture", got)
	}
	if len(br.Faces) != len(RenderFaces) {
		t.Errorf("faces = %d, want the six cube faces untouched by the named instance", len(br.Faces))
	}
}

// TestBlockRender_RenderIsTheStrongestFace pins the per-block draw class: one
// translucent face makes the block translucent, one cutout face makes it cutout.
func TestBlockRender_RenderIsTheStrongestFace(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{blockFile("s.json", "test:s", `
		"minecraft:material_instances": {
			"*":  {"texture": "solid", "render_method": "opaque"},
			"up": {"texture": "glass", "render_method": "blend"}
		}`)})
	br, _ := p.BlockRender("test:s")
	if br.Render() != RenderTranslucent {
		t.Errorf("render = %q, want translucent", br.Render())
	}
}
