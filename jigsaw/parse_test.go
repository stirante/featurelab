package jigsaw

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
)

func messages(l *Library) string {
	out := []string{}
	for _, d := range l.Diagnostics {
		out = append(out, d.Level+": "+d.Message)
	}
	return strings.Join(out, "\n")
}

func wrap(root, body string) string {
	return `{"` + root + `":{"description":{"identifier":"t:x"}` + body + `}}`
}

func TestMalformedFilesAreReported(t *testing.T) {
	pool := func(body string) Sources {
		return Sources{Pools: []SourceFile{{ID: "p.json", Text: wrap("minecraft:template_pool", body)}}}
	}
	element := func(inner string) Sources {
		return pool(`,"elements":[{"weight":1,"element":` + inner + `}]`)
	}
	structure := func(body string) Sources {
		return Sources{Structures: []SourceFile{{ID: "s.json", Text: wrap("minecraft:jigsaw", body)}}}
	}
	withStart := func(body string) Sources { return structure(`,"start_pool":"t:p"` + body) }
	const height = `,"start_height":{"type":"constant","value":{"absolute":0}}`
	set := func(body string) Sources {
		return Sources{Sets: []SourceFile{{ID: "set.json", Text: wrap("minecraft:structure_set", body)}}}
	}
	list := func(body string) Sources {
		return Sources{Processors: []SourceFile{{ID: "l.json", Text: wrap("minecraft:processor_list", body)}}}
	}
	rule := func(body string) Sources {
		return list(`,"processors":[{"processor_type":"minecraft:rule","rules":[` + body + `]}]`)
	}
	output := `"output_state":"minecraft:stone"`

	cases := map[string]struct {
		src  Sources
		want string
	}{
		"not json":            {Sources{Pools: []SourceFile{{ID: "p.json", Text: "{"}}}, ""},
		"wrong root":          {Sources{Pools: []SourceFile{{ID: "p.json", Text: "{}"}}}, `the root key "minecraft:template_pool" is missing`},
		"no identifier":       {Sources{Pools: []SourceFile{{ID: "p.json", Text: `{"minecraft:template_pool":{}}`}}}, "description.identifier is missing"},
		"fallback type":       {pool(`,"fallback":1,"elements":[]`), "fallback must name a template pool"},
		"no elements":         {pool(``), "has no elements list"},
		"element not object":  {pool(`,"elements":[1]`), "elements[0] is not an object"},
		"weight type":         {pool(`,"elements":[{"weight":"x","element":{}}]`), "weight must be a number"},
		"inner not object":    {pool(`,"elements":[{"weight":1,"element":1}]`), "elements[0].element is not an object"},
		"unknown element":     {element(`{"element_type":"minecraft:list_pool_element"}`), "unknown element_type"},
		"no location":         {element(`{"element_type":"minecraft:single_pool_element"}`), "location is missing"},
		"processors type":     {element(`{"element_type":"minecraft:single_pool_element","location":"a","processors":1}`), "processors must name"},
		"no feature":          {element(`{"element_type":"minecraft:feature_pool_element"}`), "feature is missing"},
		"unknown projection":  {element(`{"element_type":"minecraft:single_pool_element","location":"a","projection":"moon"}`), "unknown projection"},
		"no start pool":       {structure(height), "start_pool is missing"},
		"depth type":          {withStart(`,"max_depth":"x"` + height), "max_depth must be a number"},
		"height not object":   {withStart(`,"start_height":1`), "start_height: must be an object"},
		"height type":         {withStart(`,"start_height":{"type":"moon"}`), "start_height: unknown type"},
		"constant anchor":     {withStart(`,"start_height":{"type":"constant","value":1}`), "start_height: value: must be an object"},
		"anchor key":          {withStart(`,"start_height":{"type":"constant","value":{"x":1}}`), "needs absolute, above_bottom or below_top"},
		"uniform min":         {withStart(`,"start_height":{"type":"uniform","max":{"absolute":1}}`), "start_height: min"},
		"uniform max":         {withStart(`,"start_height":{"type":"uniform","min":{"absolute":1}}`), "start_height: max"},
		"heightmap":           {withStart(height + `,"heightmap_projection":"sea_floor"`), "unknown heightmap_projection"},
		"padding type":        {withStart(height + `,"dimension_padding":"x"`), "dimension_padding must be a number or an object"},
		"padding bottom":      {withStart(height + `,"dimension_padding":{"bottom":"x"}`), "dimension_padding: bottom"},
		"padding top":         {withStart(height + `,"dimension_padding":{"top":"x"}`), "dimension_padding: top"},
		"distance type":       {withStart(height + `,"max_distance_from_center":"x"`), "max_distance_from_center must be"},
		"distance horizontal": {withStart(height + `,"max_distance_from_center":{"horizontal":"x"}`), "max_distance_from_center: horizontal"},
		"distance vertical":   {withStart(height + `,"max_distance_from_center":{"vertical":"x"}`), "max_distance_from_center: vertical"},
		"aliases type":        {withStart(height + `,"pool_aliases":1`), "pool_aliases must be a list"},
		"alias not object":    {withStart(height + `,"pool_aliases":[1]`), "pool_aliases[0] is not an object"},
		"set no list":         {set(``), "has no structures list"},
		"set entry":           {set(`,"structures":[1]`), "structures[0] is not an object"},
		"set no structure":    {set(`,"structures":[{}]`), "structures[0].structure is missing"},
		"list no processors":  {list(``), "has no processors list"},
		"processor object":    {list(`,"processors":[1]`), "processors[0] is not an object"},
		"unknown processor":   {list(`,"processors":[{"processor_type":"minecraft:gravity"}]`), "unknown processor_type"},
		"ignore not list":     {list(`,"processors":[{"processor_type":"minecraft:block_ignore","blocks":1}]`), "blocks must be a list"},
		"ignore entry":        {list(`,"processors":[{"processor_type":"minecraft:block_ignore","blocks":[1]}]`), "blocks[0]: block must be a name or an object"},
		"ignore no name":      {list(`,"processors":[{"processor_type":"minecraft:block_ignore","blocks":[{}]}]`), "block name is missing"},
		"protected value":     {list(`,"processors":[{"processor_type":"minecraft:protected_blocks"}]`), "value must name a block tag"},
		"capped delegate":     {list(`,"processors":[{"processor_type":"minecraft:capped"}]`), "delegate must be a processor object"},
		"capped inner":        {list(`,"processors":[{"processor_type":"minecraft:capped","delegate":{"processor_type":"moon"}}]`), "delegate: unknown processor_type"},
		"rules not list":      {list(`,"processors":[{"processor_type":"minecraft:rule"}]`), "rules must be a list"},
		"rule not object":     {rule(`1`), "rules[0] is not an object"},
		"input predicate":     {rule(`{"input_predicate":1,` + output + `}`), "input_predicate: must be an object"},
		"location predicate":  {rule(`{"location_predicate":{"predicate_type":"moon"},` + output + `}`), "location_predicate: unknown predicate_type"},
		"position predicate":  {rule(`{"position_predicate":1,` + output + `}`), "position_predicate: must be an object"},
		"position type":       {rule(`{"position_predicate":{"predicate_type":"moon"},` + output + `}`), "unknown predicate_type"},
		"position axis":       {rule(`{"position_predicate":{"predicate_type":"minecraft:axis_aligned_linear_pos","axis":"w"},` + output + `}`), "unknown axis"},
		"output":              {rule(`{"output_state":1}`), "output_state: block must be a name or an object"},
		"block match":         {rule(`{"input_predicate":{"predicate_type":"minecraft:block_match","block":1},` + output + `}`), "block must be a name"},
		"state match":         {rule(`{"input_predicate":{"predicate_type":"minecraft:blockstate_match","block_state":1},` + output + `}`), "block must be a name"},
		"random block":        {rule(`{"input_predicate":{"predicate_type":"minecraft:random_block_match","block":1},` + output + `}`), "block must be a name"},
		"random probability":  {rule(`{"input_predicate":{"predicate_type":"minecraft:random_block_match","block":"a"},` + output + `}`), "probability must be a number"},
		"random state":        {rule(`{"input_predicate":{"predicate_type":"minecraft:random_blockstate_match","block_state":1},` + output + `}`), "block must be a name"},
		"random state chance": {rule(`{"input_predicate":{"predicate_type":"minecraft:random_blockstate_match","block_state":"a"},` + output + `}`), "probability must be a number"},
		"tag":                 {rule(`{"input_predicate":{"predicate_type":"minecraft:tag_match"},` + output + `}`), "tag must be a string"},
	}
	for name, c := range cases {
		got := messages(BuildLibrary(c.src, block.NewPalette()))
		if got == "" || !strings.Contains(got, "error: ") || !strings.Contains(got, c.want) {
			t.Errorf("%s: diagnostics %q, want an error with %q", name, got, c.want)
		}
	}
}

func TestDuplicatesKeepTheFirstPool(t *testing.T) {
	first := poolJSON("t:p", "", "first")
	first.ID = "a.json"
	second := poolJSON("t:p", "", "second")
	second.ID = "b.json"
	l := BuildLibrary(Sources{Pools: []SourceFile{first, second}}, block.NewPalette())
	if len(l.Diagnostics) != 1 || l.Diagnostics[0].Level != "warning" || l.Diagnostics[0].FileID != "b.json" {
		t.Fatalf("diagnostics %+v, want one warning on b.json", l.Diagnostics)
	}
	if got := l.pools["t:p"].elements[0].location; got != "first" {
		t.Errorf("kept %q, want the first pool", got)
	}
}

func TestDuplicateStructureAndProcessorListAreErrors(t *testing.T) {
	structure := SourceFile{ID: "s.json", Text: wrap("minecraft:jigsaw", `,"start_pool":"t:p","start_height":{"type":"constant","value":{"absolute":0}}`)}
	list := SourceFile{ID: "l.json", Text: wrap("minecraft:processor_list", `,"processors":[]`)}
	got := messages(BuildLibrary(Sources{Structures: []SourceFile{structure, structure}, Processors: []SourceFile{list, list}}, block.NewPalette()))
	for _, want := range []string{`jigsaw structure "t:x" is declared in more than one file`, `processor list "t:x" is declared in more than one file`} {
		if !strings.Contains(got, want) {
			t.Errorf("diagnostics %q, want %q", got, want)
		}
	}
}

func TestPoolWithCapitalsRegistersLowercase(t *testing.T) {
	l := BuildLibrary(Sources{Pools: []SourceFile{poolJSON("T:Pool", "", "a")}}, block.NewPalette())
	if l.pools["t:pool"] == nil || l.pools["T:Pool"] != nil {
		t.Error("the pool must be keyed by its lowercase name only")
	}
	if !strings.Contains(messages(l), "registered as") {
		t.Errorf("diagnostics %q, want the capitals warning", messages(l))
	}
}

func TestPoolDefaults(t *testing.T) {
	l := BuildLibrary(Sources{Pools: []SourceFile{poolJSON("t:p", "", "a")}}, block.NewPalette())
	if got := l.pools["t:p"].fallback; got != "minecraft:empty" {
		t.Errorf("fallback = %q, want DEFAULT_FALLBACK", got)
	}
}

func TestWeightExpandsElements(t *testing.T) {
	text := wrap("minecraft:template_pool", `,"elements":[{"weight":3,"element":{"element_type":"minecraft:empty_pool_element"}}]`)
	l := BuildLibrary(Sources{Pools: []SourceFile{{ID: "p.json", Text: text}}}, block.NewPalette())
	if got := len(l.pools["t:x"].elements); got != 3 {
		t.Errorf("%d elements, want weight 3 to give 3", got)
	}
}

func TestRandomAliasesAreWarned(t *testing.T) {
	text := wrap("minecraft:jigsaw", `,"start_pool":"t:p","start_height":{"type":"constant","value":{"absolute":0}},
		"pool_aliases":[{"type":"random","alias":"t:a","targets":[{"data":"t:b","weight":1}]}]`)
	l := BuildLibrary(Sources{Structures: []SourceFile{{ID: "s.json", Text: text}}}, block.NewPalette())
	if !strings.Contains(messages(l), "random pool aliases are not modelled") {
		t.Errorf("diagnostics %q", messages(l))
	}
}
