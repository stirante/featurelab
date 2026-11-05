package jigsaw_test

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/jigsaw"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wire"
)

func writeTag(buf *bytes.Buffer, value any) {
	switch v := value.(type) {
	case int32:
		binary.Write(buf, binary.LittleEndian, v)
	case string:
		binary.Write(buf, binary.LittleEndian, uint16(len(v)))
		buf.WriteString(v)
	case []int32:
		binary.Write(buf, binary.LittleEndian, int32(len(v)))
		binary.Write(buf, binary.LittleEndian, v)
	case map[string]any:
		for key, item := range v {
			buf.WriteByte(tagOf(item))
			writeTag(buf, key)
			writeTag(buf, item)
		}
		buf.WriteByte(0)
	case []any:
		kind := byte(0)
		if len(v) > 0 {
			kind = tagOf(v[0])
		}
		buf.WriteByte(kind)
		binary.Write(buf, binary.LittleEndian, int32(len(v)))
		for _, item := range v {
			writeTag(buf, item)
		}
	default:
		panic(fmt.Sprintf("no tag for %T", value))
	}
}

func tagOf(value any) byte {
	switch value.(type) {
	case int32:
		return 3
	case string:
		return 8
	case []any:
		return 9
	case map[string]any:
		return 10
	case []int32:
		return 11
	}
	panic(fmt.Sprintf("no tag for %T", value))
}

type cell struct {
	name   string
	states map[string]any
	nbt    map[string]any
}

func stone() cell { return cell{name: "minecraft:stone"} }

func connector(facing int32, nbt map[string]any) cell {
	return cell{name: "minecraft:jigsaw", states: map[string]any{"facing_direction": facing}, nbt: nbt}
}

// row builds a structure file one cell high and one deep, so a cell index is its x.
func row(cells ...cell) []byte {
	indices := make([]int32, len(cells))
	second := make([]int32, len(cells))
	palette := []any{}
	positions := map[string]any{}
	for i, c := range cells {
		states := c.states
		if states == nil {
			states = map[string]any{}
		}
		palette = append(palette, map[string]any{"name": c.name, "states": states, "version": int32(1)})
		indices[i] = int32(i)
		second[i] = -1
		if c.nbt != nil {
			positions[strconv.Itoa(i)] = map[string]any{"block_entity_data": c.nbt}
		}
	}
	return structureFile(int32(len(cells)), indices, second, palette, positions)
}

func structureFile(sizeX int32, indices, second []int32, palette []any, positions map[string]any) []byte {
	root := map[string]any{
		"format_version": int32(1),
		"size":           []any{sizeX, int32(1), int32(1)},
		"structure": map[string]any{
			"block_indices": []any{toAny(indices), toAny(second)},
			"entities":      []any{},
			"palette": map[string]any{"default": map[string]any{
				"block_palette": palette, "block_position_data": positions,
			}},
		},
		"structure_world_origin": []any{int32(0), int32(0), int32(0)},
	}
	var buf bytes.Buffer
	buf.WriteByte(10)
	writeTag(&buf, "")
	writeTag(&buf, root)
	return buf.Bytes()
}

func toAny(values []int32) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

type pack struct {
	templates []structures.SourceFile
	features  []features.SourceFile
	sources   jigsaw.Sources
}

func (p *pack) template(name string, data []byte) *pack {
	p.templates = append(p.templates, structures.SourceFile{ID: "test/" + name + ".mcstructure", Data: data})
	return p
}

func (p *pack) pool(identifier string, elements ...string) *pack {
	p.sources.Pools = append(p.sources.Pools, jigsaw.SourceFile{
		ID: "worldgen/template_pools/" + identifier + ".json",
		Text: fmt.Sprintf(`{"minecraft:template_pool":{"description":{"identifier":%q},"elements":[%s]}}`,
			identifier, strings.Join(elements, ",")),
	})
	return p
}

func (p *pack) structure(extra string) *pack {
	p.sources.Structures = append(p.sources.Structures, jigsaw.SourceFile{ID: "worldgen/structures/s.json", Text: `{"minecraft:jigsaw":{
		"description":{"identifier":"t:s"},"start_pool":"t:start","max_depth":3,
		"start_height":{"type":"constant","value":{"absolute":10}}` + extra + `}}`})
	return p
}

func (p *pack) processors(body string) *pack {
	p.sources.Processors = append(p.sources.Processors, jigsaw.SourceFile{ID: "worldgen/processors/l.json",
		Text: `{"minecraft:processor_list":{"description":{"identifier":"t:list"},"processors":[` + body + `]}}`})
	return p
}

func single(name string, extra string) string {
	return fmt.Sprintf(`{"weight":1,"element":{"element_type":"minecraft:single_pool_element","location":"test:test/%s","projection":"rigid"%s}}`, name, extra)
}

func (p *pack) run(t *testing.T, identifier string) *session.Result {
	t.Helper()
	seed, minY := uint32(5), -64
	config, err := wire.BuildConfig(wire.GenerateParams{Structure: identifier, Env: "void", Seed: &seed, Size: "64x128x64", MinY: &minY})
	if err != nil {
		t.Fatal(err)
	}
	result, err := session.Generate(config, p.features, p.templates, nil, nil, nil, p.sources)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func counts(result *session.Result) map[string]int {
	names := map[block.ID]string{}
	for _, entry := range result.Palette {
		names[entry.ID] = entry.Name
	}
	out := map[string]int{}
	for _, id := range result.Blocks {
		if name := names[id]; name != "minecraft:air" {
			out[name]++
		}
	}
	return out
}

func diagnostics(result *session.Result) string {
	out := []string{}
	for _, d := range result.Diagnostics {
		out = append(out, d.Level+": "+d.Message)
	}
	return strings.Join(out, "\n")
}

func wantDiagnostic(t *testing.T, result *session.Result, want string) {
	t.Helper()
	if got := diagnostics(result); !strings.Contains(got, want) {
		t.Errorf("diagnostics:\n%s\nwant one with %q", got, want)
	}
}

func wantCounts(t *testing.T, result *session.Result, want map[string]int) {
	t.Helper()
	got := counts(result)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("blocks %v, want %v\n%s", got, want, diagnostics(result))
	}
}

func joined(target, pool, final string) map[string]any {
	return map[string]any{"name": "t:in", "target": target, "target_pool": pool, "final_state": final, "joint": "rollable"}
}

func TestTwoPiecesJoinAndConnectorsTurnIntoFinalState(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("start", "")).pool("t:child", single("child", ""))
	p.template("start", row(stone(), stone(), connector(5, joined("join", "t:child", "minecraft:oak_planks"))))
	p.template("child", row(connector(4, map[string]any{"name": "join", "target_pool": "minecraft:empty", "final_state": "minecraft:dirt"}), cell{name: "minecraft:glass"}))
	wantCounts(t, p.run(t, "t:s"), map[string]int{"minecraft:stone": 2, "minecraft:oak_planks": 1, "minecraft:dirt": 1, "minecraft:glass": 1})
}

func TestStructureBlockAndStructureVoidAreNotPlaced(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("start", ""))
	p.template("start", row(stone(), cell{name: "minecraft:structure_block"},
		connector(5, joined("x", "minecraft:empty", "minecraft:structure_void"))))
	wantCounts(t, p.run(t, "t:s"), map[string]int{"minecraft:stone": 1})
}

func TestJigsawBlockWithoutNbtStaysAndWarns(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("start", ""))
	p.template("start", row(stone(), connector(5, nil)))
	result := p.run(t, "t:s")
	wantCounts(t, result, map[string]int{"minecraft:stone": 1, "minecraft:jigsaw": 1})
	wantDiagnostic(t, result, "has no block entity data")
}

func TestBadConnectorFacingWarns(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("start", ""))
	p.template("start", row(connector(9, joined("x", "minecraft:empty", "minecraft:air"))))
	wantDiagnostic(t, p.run(t, "t:s"), "facing_direction is")
}

func TestMissingTemplateWarns(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("gone", ""))
	wantDiagnostic(t, p.run(t, "t:s"), `invalid asset path: the structure "test:test/gone" was not found`)
}

func TestMissingProcessorListWarnsAndPlaces(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("start", `,"processors":"t:gone"`))
	p.template("start", row(stone()))
	result := p.run(t, "t:s")
	wantCounts(t, result, map[string]int{"minecraft:stone": 1})
	wantDiagnostic(t, result, `processor list "t:gone" does not exist`)
}

func TestProcessors(t *testing.T) {
	input := `"input_predicate":{"predicate_type":"minecraft:block_match","block":"minecraft:stone"}`
	cases := map[string]struct {
		body string
		want map[string]int
	}{
		"rule":          {`{"processor_type":"minecraft:rule","rules":[{` + input + `,"output_state":"minecraft:dirt"}]}`, map[string]int{"minecraft:dirt": 1, "minecraft:glass": 1}},
		"tag rule":      {`{"processor_type":"minecraft:rule","rules":[{"input_predicate":{"predicate_type":"minecraft:tag_match","tag":"no_such_tag"},"output_state":"minecraft:dirt"}]}`, map[string]int{"minecraft:stone": 1, "minecraft:glass": 1}},
		"always true":   {`{"processor_type":"minecraft:rule","rules":[{"output_state":"minecraft:dirt"}]}`, map[string]int{"minecraft:dirt": 2}},
		"chance zero":   {`{"processor_type":"minecraft:rule","rules":[{"input_predicate":{"predicate_type":"minecraft:random_block_match","block":"minecraft:stone","probability":0},"output_state":"minecraft:dirt"}]}`, map[string]int{"minecraft:stone": 1, "minecraft:glass": 1}},
		"chance one":    {`{"processor_type":"minecraft:rule","rules":[{"input_predicate":{"predicate_type":"minecraft:random_block_match","block":"minecraft:stone","probability":1},"output_state":"minecraft:dirt"}]}`, map[string]int{"minecraft:dirt": 1, "minecraft:glass": 1}},
		"block ignore":  {`{"processor_type":"minecraft:block_ignore","blocks":["minecraft:stone"]}`, map[string]int{"minecraft:glass": 1}},
		"capped":        {`{"processor_type":"minecraft:capped","delegate":{"processor_type":"minecraft:block_ignore","blocks":["minecraft:glass"]}}`, map[string]int{"minecraft:stone": 1}},
		"protected":     {`{"processor_type":"minecraft:protected_blocks","value":"no_such_tag"}`, map[string]int{"minecraft:stone": 1, "minecraft:glass": 1}},
		"position miss": {`{"processor_type":"minecraft:rule","rules":[{"position_predicate":{"predicate_type":"minecraft:axis_aligned_linear_pos","axis":"y","min_distance":0,"max_distance":10,"min_chance":0,"max_chance":0},"output_state":"minecraft:dirt"}]}`, map[string]int{"minecraft:stone": 1, "minecraft:glass": 1}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p := (&pack{}).structure("").pool("t:start", single("start", `,"processors":"t:list"`)).processors(c.body)
			p.template("start", row(stone(), cell{name: "minecraft:glass"}))
			wantCounts(t, p.run(t, "t:s"), c.want)
		})
	}
}

func TestCappedSaysItHasNoLimit(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("start", `,"processors":"t:list"`)).
		processors(`{"processor_type":"minecraft:capped","delegate":{"processor_type":"minecraft:block_ignore","blocks":[]}}`)
	p.template("start", row(stone()))
	wantDiagnostic(t, p.run(t, "t:s"), "minecraft:capped has no limit here")
}

func TestUnmodelledSettingsAreSaid(t *testing.T) {
	p := (&pack{}).structure(`,"terrain_adaptation":"beard_thin","biome_filters":[],"liquid_settings":"apply_waterlogging",
		"pool_aliases":[{"type":"random","alias":"t:a","targets":[{"data":"t:b","weight":1}]}]`).pool("t:start", single("start", ""))
	p.template("start", row(stone()))
	result := p.run(t, "t:s")
	for _, want := range []string{"terrain_adaptation", "biome_filters are not evaluated", "apply_waterlogging is not modelled", "random pool aliases are not modelled"} {
		wantDiagnostic(t, result, want)
	}
}

func TestFeatureElement(t *testing.T) {
	featureElement := func(name string) string {
		return fmt.Sprintf(`{"weight":1,"element":{"element_type":"minecraft:feature_pool_element","feature":%q,"projection":"rigid"}}`, name)
	}
	p := (&pack{}).structure("").pool("t:start", single("start", "")).pool("t:feat", featureElement("t:gold"), featureElement("t:gold"))
	p.template("start", row(stone(), connector(1, joined("x", "t:feat", "minecraft:air"))))
	p.features = []features.SourceFile{{ID: "gold.json", Text: `{"format_version":"1.13.0","minecraft:single_block_feature":{
		"description":{"identifier":"t:gold"},"places_block":"minecraft:gold_block",
		"enforce_placement_rules":false,"enforce_survivability_rules":false}}`}}
	wantCounts(t, p.run(t, "t:s"), map[string]int{"minecraft:stone": 1, "minecraft:gold_block": 1})

	p.features = nil
	wantDiagnostic(t, p.run(t, "t:s"), `names "t:gold", which is not a feature`)
}

func TestNothingGenerated(t *testing.T) {
	p := (&pack{}).structure(`,"start_jigsaw_name":"nope"`).pool("t:start", single("start", ""))
	p.template("start", row(stone()))
	result := p.run(t, "t:s")
	wantCounts(t, result, map[string]int{})
	wantDiagnostic(t, result, `t:s generates nothing: couldn't find anchor named "nope"`)

	zero := &pack{templates: p.templates}
	zero.sources.Pools = p.sources.Pools
	zero.sources.Structures = []jigsaw.SourceFile{{ID: "z.json", Text: `{"minecraft:jigsaw":{"description":{"identifier":"t:s"},
		"start_pool":"t:start","max_depth":0,"start_height":{"type":"constant","value":{"absolute":10}}}}`}}
	wantDiagnostic(t, zero.run(t, "t:s"), "t:s generates nothing: max_depth is 0")
}

func TestUnknownStructure(t *testing.T) {
	p := (&pack{}).structure("").pool("t:start", single("start", ""))
	p.template("start", row(stone()))
	result := p.run(t, "t:none")
	wantDiagnostic(t, result, `no jigsaw structure "t:none"`)
	wantDiagnostic(t, result, "t:s")
}

func TestPackWithoutJigsawNamesThatInTheError(t *testing.T) {
	result := (&pack{}).run(t, "t:none")
	wantDiagnostic(t, result, `no jigsaw structure "t:none"`)
}

func TestBadStructureFilesAreReported(t *testing.T) {
	bad := structureFile(1, []int32{0}, []int32{-1}, []any{map[string]any{"name": "minecraft:stone", "states": map[string]any{}, "version": int32(1)}},
		map[string]any{"nine": map[string]any{"block_entity_data": map[string]any{}}})
	p := (&pack{}).structure("").pool("t:start", single("start", ""))
	p.template("start", bad)
	p.template("empty", nil)
	result := p.run(t, "t:s")
	wantDiagnostic(t, result, `has the key "nine", which is not a cell index`)
	wantDiagnostic(t, result, "mcstructure: the file is empty")
}

func TestCheckReportsDanglingReferences(t *testing.T) {
	palette := block.NewPalette()
	templates := structures.BuildLibrary([]structures.SourceFile{
		{ID: "test/start.mcstructure", Data: row(connector(5, joined("x", "t:gone", "minecraft:air")))},
		{ID: "test/bad.mcstructure", Data: row(connector(9, joined("x", "minecraft:empty", "minecraft:air")))},
	}, palette)
	src := jigsaw.Sources{
		Structures: []jigsaw.SourceFile{{ID: "s.json", Text: `{"minecraft:jigsaw":{"description":{"identifier":"t:s"},"start_pool":"t:none","max_depth":1,
			"start_height":{"type":"constant","value":{"absolute":0}}}}`}},
		Pools: []jigsaw.SourceFile{{ID: "p.json", Text: `{"minecraft:template_pool":{"description":{"identifier":"t:p"},"fallback":"t:nofallback","elements":[
			{"weight":1,"element":{"element_type":"minecraft:single_pool_element","location":"test:test/start","processors":"t:nolist"}},
			{"weight":1,"element":{"element_type":"minecraft:single_pool_element","location":"test:test/bad"}},
			{"weight":1,"element":{"element_type":"minecraft:single_pool_element","location":"test:test/gone"}},
			{"weight":1,"element":{"element_type":"minecraft:feature_pool_element","feature":"t:nofeature"}}]}}`}},
		Sets: []jigsaw.SourceFile{{ID: "set.json", Text: `{"minecraft:structure_set":{"description":{"identifier":"t:set"},"structures":[{"structure":"t:noset","weight":1}]}}`}},
	}
	library := jigsaw.BuildLibrary(src, palette)
	if len(library.Diagnostics) != 0 {
		t.Fatalf("load diagnostics: %+v", library.Diagnostics)
	}
	var out []string
	for _, d := range library.Check(templates, features.BuildLibrary(nil, palette, templates)) {
		out = append(out, d.Level+": "+d.Message)
	}
	got := strings.Join(out, "\n")
	for _, want := range []string{
		`error: start_pool "t:none" is not a template pool`,
		`error: fallback "t:nofallback" is not a template pool`,
		`warning: structure "test:test/start" has a jigsaw block aiming at the pool "t:gone"`,
		`error: processors "t:nolist" is not a processor list`,
		`error: location "test:test/bad": jigsaw block at cell 0: facing_direction is`,
		`error: location "test:test/gone" is not a structure file`,
		`error: feature "t:nofeature" is not a feature`,
		`error: structure "t:noset" is not a jigsaw structure`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("check output:\n%s\nwant %q", got, want)
		}
	}
}
