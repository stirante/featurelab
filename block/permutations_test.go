package block

import (
	"strings"
	"testing"
)

// permBlockFile is blockFile's counterpart for a block that also declares
// states and permutations -- the two things that live BESIDE the components
// bag rather than inside it.
func permBlockFile(id, identifier, states, components, permutations string) SourceFile {
	return SourceFile{ID: id, Text: `{"format_version":"1.21.100","minecraft:block":{` +
		`"description":{"identifier":"` + identifier + `","states":{` + states + `}},` +
		`"components":{` + components + `},` +
		`"permutations":[` + permutations + `]}}`}
}

func renderOf(t *testing.T, file SourceFile, identifier string) BlockRender {
	t.Helper()
	p := NewPalette()
	if diags := p.LoadBlockTags([]SourceFile{file}); len(diags) != 0 {
		t.Fatalf("diagnostics = %+v, want none", diags)
	}
	br, ok := p.BlockRender(identifier)
	if !ok {
		t.Fatalf("BlockRender(%s) not found", identifier)
	}
	return br
}

// TestPermutations_StateSwitchesTheTopTexture is the headline case, and the
// one the user report is about: a lamp whose top face changes with a state.
// Before permutations were read, both states drew the unlit top.
func TestPermutations_StateSwitchesTheTopTexture(t *testing.T) {
	br := renderOf(t, permBlockFile("lamp.json", "test:lamp",
		`"test:lit":[false,true]`,
		`"minecraft:material_instances":{"*":{"texture":"lamp_side"},"up":{"texture":"lamp_off"}}`,
		`{"condition":"q.block_state('test:lit') == true",
		  "components":{"minecraft:material_instances":{"up":{"texture":"lamp_on"}}}}`),
		"test:lamp")

	if len(br.Permutations) != 1 {
		t.Fatalf("Permutations = %d, want 1", len(br.Permutations))
	}
	if got := br.Permutations[0].StateNames(); len(got) != 1 || got[0] != "test:lit" {
		t.Fatalf("condition state names = %v, want [test:lit]", got)
	}

	// The block's DEFAULT faces are untouched -- that is what a state set the
	// preview cannot place still draws.
	if got := br.Faces["up"].Texture; got != "lamp_off" {
		t.Errorf("default up = %q, want lamp_off", got)
	}

	off := br.ForStates(map[string]StateValue{"test:lit": false})
	if got := off.Faces["up"].Texture; got != "lamp_off" {
		t.Errorf("lit=false up = %q, want lamp_off", got)
	}
	on := br.ForStates(map[string]StateValue{"test:lit": true})
	if got := on.Faces["up"].Texture; got != "lamp_on" {
		t.Errorf("lit=true up = %q, want lamp_on", got)
	}
	// A partial override leaves the faces it does not name alone.
	if got := on.Faces["north"].Texture; got != "lamp_side" {
		t.Errorf("lit=true north = %q, want lamp_side from the top-level \"*\"", got)
	}

	// And the enumeration the table is built from: one row per declared value
	// of exactly the state the condition reads.
	variants := br.StateVariants()
	if len(variants) != 2 {
		t.Fatalf("StateVariants = %d rows, want 2", len(variants))
	}
	byKey := map[string]string{}
	for _, v := range variants {
		byKey[CanonicalKey("test:lamp", v.States)] = v.Faces["up"].Texture
	}
	for key, want := range map[string]string{
		"test:lamp#test:lit=false": "lamp_off",
		"test:lamp#test:lit=true":  "lamp_on",
	} {
		if got := byKey[key]; got != want {
			t.Errorf("%s up = %q, want %q (rows: %v)", key, got, want, byKey)
		}
	}
}

// TestPermutations_LaterPermutationWins pins the file order the engine applies
// permutations in. A pack that writes a general rule and then an exception
// renders backwards under any other reading, and nothing about the JSON says
// which way round it is -- so it is asserted rather than assumed.
func TestPermutations_LaterPermutationWins(t *testing.T) {
	br := renderOf(t, permBlockFile("stage.json", "test:stage",
		`"test:stage":[0,1,2]`,
		`"minecraft:material_instances":{"*":{"texture":"base"}}`,
		`{"condition":"q.block_state('test:stage') >= 1",
		  "components":{"minecraft:material_instances":{"*":{"texture":"grown"}}}},
		 {"condition":"q.block_state('test:stage') == 2",
		  "components":{"minecraft:material_instances":{"*":{"texture":"ripe"}}}}`),
		"test:stage")

	for _, tc := range []struct {
		stage float64
		want  string
	}{{0, "base"}, {1, "grown"}, {2, "ripe"}} {
		got := br.ForStates(map[string]StateValue{"test:stage": tc.stage}).Faces["north"].Texture
		if got != tc.want {
			t.Errorf("stage=%v -> %q, want %q", tc.stage, got, tc.want)
		}
	}

	// Three declared values, three rows, and the second one really is the
	// one both permutations matched.
	if got := len(br.StateVariants()); got != 3 {
		t.Errorf("StateVariants = %d, want 3", got)
	}
}

// TestPermutations_StringStateAndGeometryOverride covers the two things a
// hand-rolled `== 'value'` matcher would be most likely to get wrong: a string
// state value (which goes through Molang's own string interning on both sides
// of the comparison) and a permutation that swaps the MODEL rather than a
// texture.
func TestPermutations_StringStateAndGeometryOverride(t *testing.T) {
	br := renderOf(t, permBlockFile("post.json", "test:post",
		`"test:kind":["solid","plant"]`,
		`"minecraft:material_instances":{"*":{"texture":"post"}},
		 "minecraft:geometry":"minecraft:geometry.full_block"`,
		`{"condition":"query.block_state('test:kind') == 'plant'",
		  "components":{"minecraft:geometry":"minecraft:geometry.cross",
		                "minecraft:material_instances":{"*":{"texture":"post_plant","render_method":"alpha_test"}}}}`),
		"test:post")

	solid := br.ForStates(map[string]StateValue{"test:kind": "solid"})
	if solid.Geometry.Shape != ShapeFullBlock || solid.Faces["up"].Texture != "post" {
		t.Errorf("kind=solid = %+v, want a full block drawn with \"post\"", solid.Geometry)
	}
	plant := br.ForStates(map[string]StateValue{"test:kind": "plant"})
	if plant.Geometry.Shape != ShapeCross {
		t.Errorf("kind=plant shape = %q, want cross", plant.Geometry.Shape)
	}
	if plant.Faces["up"].Texture != "post_plant" {
		t.Errorf("kind=plant up = %q, want post_plant", plant.Faces["up"].Texture)
	}
	// The render class follows the faces that state set actually draws with.
	if got := plant.Render(); got != RenderCutout {
		t.Errorf("kind=plant render = %q, want cutout", got)
	}
	if got := solid.Render(); got != RenderOpaque {
		t.Errorf("kind=solid render = %q, want opaque", got)
	}

	// A state value that does not compare equal to the literal must not match
	// -- interning collisions would show up here rather than anywhere useful.
	other := br.ForStates(map[string]StateValue{"test:kind": "something_else"})
	if other.Geometry.Shape != ShapeFullBlock {
		t.Errorf("an unmatched string value applied the permutation anyway: %+v", other.Geometry)
	}
}

// TestPermutations_IntegerRangeStatesEnumerate covers description.states'
// other spelling, the {"values": {"min", "max"}} range.
func TestPermutations_IntegerRangeStatesEnumerate(t *testing.T) {
	br := renderOf(t, permBlockFile("age.json", "test:age",
		`"test:age":{"values":{"min":0,"max":3}}`,
		`"minecraft:material_instances":{"*":{"texture":"young"}}`,
		`{"condition":"q.block_state('test:age') == 3",
		  "components":{"minecraft:material_instances":{"*":{"texture":"old"}}}}`),
		"test:age")

	variants := br.StateVariants()
	if len(variants) != 4 {
		t.Fatalf("StateVariants = %d, want one per age 0..3", len(variants))
	}
	old := 0
	for _, v := range variants {
		if v.Faces["up"].Texture == "old" {
			old++
		}
	}
	if old != 1 {
		t.Errorf("%d rows drew \"old\", want exactly the age=3 one", old)
	}
}

// TestPermutations_UndeclaredStateIsNotGuessed: a condition reading a state
// the block never declared cannot be enumerated -- nothing says what values it
// takes -- so the block keeps its default faces and the author is told which
// state it was, instead of the preview inventing a domain.
func TestPermutations_UndeclaredStateIsNotGuessed(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{permBlockFile("ghost.json", "test:ghost",
		`"test:declared":[false,true]`,
		`"minecraft:material_instances":{"*":{"texture":"base"}}`,
		`{"condition":"q.block_state('test:undeclared') == true",
		  "components":{"minecraft:material_instances":{"*":{"texture":"other"}}}}`)})

	br, _ := p.BlockRender("test:ghost")
	if got := br.StateVariants(); got != nil {
		t.Errorf("StateVariants = %v, want nil for a block whose condition reads an undeclared state", got)
	}
	note, has := p.BlockRenderNote("test:ghost")
	if !has || !strings.Contains(note.Message, "test:undeclared") {
		t.Errorf("note = %+v, want one naming the undeclared state", note)
	}
	// The default row is untouched: this must draw exactly what it drew
	// before permutations were read at all.
	if got := br.Faces["up"].Texture; got != "base" {
		t.Errorf("default up = %q, want base", got)
	}
}

// TestPermutations_BadConditionIsReportedAndNeverApplies keeps a malformed
// pack a diagnostic rather than a wrong texture: a condition that is not valid
// Molang must not be treated as "true".
func TestPermutations_BadConditionIsReportedAndNeverApplies(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{permBlockFile("broken.json", "test:broken",
		`"test:lit":[false,true]`,
		`"minecraft:material_instances":{"*":{"texture":"base"}}`,
		`{"condition":"q.block_state('test:lit' ==",
		  "components":{"minecraft:material_instances":{"*":{"texture":"never"}}}}`)})

	br, _ := p.BlockRender("test:broken")
	for _, states := range []map[string]StateValue{
		{"test:lit": true}, {"test:lit": false},
	} {
		if got := br.ForStates(states).Faces["up"].Texture; got != "base" {
			t.Errorf("states %v drew %q, want base -- an uncompilable condition must never apply", states, got)
		}
	}
	note, has := p.BlockRenderNote("test:broken")
	if !has || !strings.Contains(note.Message, "not valid Molang") {
		t.Errorf("note = %+v, want one saying the condition did not parse", note)
	}
}

// TestPermutations_ProductIsBounded: a block whose conditions read several
// many-valued states is legal, and the answer is its default faces rather than
// hundreds of rows for one block.
func TestPermutations_ProductIsBounded(t *testing.T) {
	br := renderOf(t, permBlockFile("wide.json", "test:wide",
		`"test:a":{"values":{"min":0,"max":15}},"test:b":{"values":{"min":0,"max":15}}`,
		`"minecraft:material_instances":{"*":{"texture":"base"}}`,
		`{"condition":"q.block_state('test:a') == 1 && q.block_state('test:b') == 1",
		  "components":{"minecraft:material_instances":{"*":{"texture":"corner"}}}}`),
		"test:wide")

	if got := br.StateVariants(); got != nil {
		t.Errorf("StateVariants returned %d rows, want nil past the bound", len(got))
	}
	// Asked about a concrete state set directly, it still answers correctly:
	// only the ENUMERATION is bounded, not the evaluation.
	on := br.ForStates(map[string]StateValue{"test:a": 1.0, "test:b": 1.0})
	if got := on.Faces["up"].Texture; got != "corner" {
		t.Errorf("a=1,b=1 up = %q, want corner", got)
	}
}

// TestPermutations_BlockWithOnlyPermutationsIsStillIndexed: a block that
// declares its materials exclusively inside permutations used to have no
// appearance entry at all, because nothing was read outside the components
// bag.
func TestPermutations_BlockWithOnlyPermutationsIsStillIndexed(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{permBlockFile("only.json", "test:only",
		`"test:lit":[false,true]`,
		`"minecraft:collision_box":{"origin":[-8,0,-8],"size":[16,16,16]}`,
		`{"condition":"q.block_state('test:lit') == true",
		  "components":{"minecraft:material_instances":{"*":{"texture":"on"}}}},
		 {"condition":"q.block_state('test:lit') == false",
		  "components":{"minecraft:material_instances":{"*":{"texture":"off"}}}}`)})

	br, ok := p.BlockRender("test:only")
	if !ok {
		t.Fatal("a block whose only appearance is in its permutations was not indexed")
	}
	if len(br.Faces) != 0 {
		t.Errorf("default faces = %v, want none: nothing was declared at the top level", br.Faces)
	}
	variants := br.StateVariants()
	if len(variants) != 2 {
		t.Fatalf("StateVariants = %d, want 2", len(variants))
	}
	for _, v := range variants {
		want := "off"
		if v.States["test:lit"] == true {
			want = "on"
		}
		if got := v.Faces["up"].Texture; got != want {
			t.Errorf("states %v up = %q, want %q", v.States, got, want)
		}
	}
}

// TestPermutations_UnconditionalAppliesToTheDefaultRow: a permutation with no
// condition is malformed per the schema, and reading it as "never" would drop
// the pack's textures over a missing string. It applies everywhere, including
// to the default appearance -- which for such a block is the only appearance,
// since a condition that reads no states leaves nothing to enumerate.
func TestPermutations_UnconditionalAppliesToTheDefaultRow(t *testing.T) {
	br := renderOf(t, permBlockFile("always.json", "test:always",
		`"test:lit":[false,true]`,
		`"minecraft:material_instances":{"*":{"texture":"base"}}`,
		`{"components":{"minecraft:material_instances":{"up":{"texture":"cap"}},
		                "minecraft:geometry":"minecraft:geometry.cross"}}`),
		"test:always")

	if got := br.Faces["up"].Texture; got != "cap" {
		t.Errorf("default up = %q, want cap", got)
	}
	if got := br.Faces["north"].Texture; got != "base" {
		t.Errorf("default north = %q, want base", got)
	}
	if br.Geometry.Shape != ShapeCross {
		t.Errorf("default shape = %q, want cross", br.Geometry.Shape)
	}
	// And asking for a concrete state set gives the same answer rather than
	// applying it a second time to a different effect.
	if got := br.ForStates(map[string]StateValue{"test:lit": true}).Faces["up"].Texture; got != "cap" {
		t.Errorf("lit up = %q, want cap", got)
	}
}
