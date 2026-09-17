package genvanillastates

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sampleRegistry is a registry in the documented input schema, small enough to
// read but carrying every shape the generator has to get right: an
// enumeration, a boolean, an integer, a type that narrows a state's domain, a
// type that widens one, a non-first default, and a type that declares nothing.
// It also carries members the generator must IGNORE (the "notes" fields), so
// that a richer real document keeps working.
const sampleRegistry = `{
  "notes": "ignored",
  "states": {
    "pillar_axis":   {"type": "enum", "count": 3, "values": ["y", "x", "z"], "notes": "ignored"},
    "cardinal":      {"type": "enum", "count": 4, "values": ["south", "west", "north", "east"]},
    "hanging":       {"type": "bool", "count": 2, "values": [false, true]},
    "rail_direction":{"type": "int",  "count": 10, "values": [0,1,2,3,4,5,6,7,8,9]},
    "direction":     {"type": "int",  "count": 4,  "values": [0,1,2,3]}
  },
  "blocks": {
    "minecraft:oak_log":     {"states": {"pillar_axis": {"type": "enum", "count": 3, "values": ["y","x","z"], "default": "y"}}},
    "minecraft:chest":       {"states": {"cardinal": {"type": "enum", "count": 4, "values": ["south","west","north","east"], "default": "north"}}},
    "minecraft:golden_rail": {"states": {"rail_direction": {"type": "int", "count": 6, "values": [0,1,2,3,4,5], "default": 0},
                                          "hanging": {"type": "bool", "count": 2, "values": [false,true], "default": true}}},
    "minecraft:chalkboard":  {"states": {"direction": {"type": "int", "count": 16, "values": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], "default": 0}}},
    "minecraft:stone":       {"states": {}}
  }
}`

func writeRegistry(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "registry.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("writing registry: %v", err)
	}
	return path
}

func generate(t *testing.T, body string) (Summary, string) {
	t.Helper()
	out := filepath.Join(t.TempDir(), "table.go")
	summary, err := Generate(Config{RegistryPath: writeRegistry(t, body), OutputPath: out})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("reading output: %v", err)
	}
	return summary, string(data)
}

// TestGenerate_Deterministic is this generator's determinism guarantee, the
// same one genvanillablocks makes: two runs over identical input produce
// byte-identical output. The table is checked in, so a re-run that reordered
// even one map entry would show up as unreviewable churn across 1259 lines.
func TestGenerate_Deterministic(t *testing.T) {
	summaryA, textA := generate(t, sampleRegistry)
	summaryB, textB := generate(t, sampleRegistry)
	if summaryA != summaryB {
		t.Fatalf("Summary differs between runs: A=%+v B=%+v", summaryA, summaryB)
	}
	if textA != textB {
		t.Fatal("generated source differs between two runs over identical input")
	}
	want := Summary{Blocks: 5, WithStates: 4, States: 5, Declarations: 5}
	if summaryA != want {
		t.Fatalf("Summary = %+v, want %+v", summaryA, want)
	}
}

// TestGenerate_Shape checks the rows the three call sites actually read: the
// declared key, the per-type value count (including the narrowed and widened
// ones), the default, and the stateless type being LISTED rather than omitted.
func TestGenerate_Shape(t *testing.T) {
	_, text := generate(t, sampleRegistry)
	// gofmt pads map keys into columns, so compare with runs of spaces
	// collapsed -- the alignment is not what this test is about.
	text = strings.Join(strings.Fields(text), " ")
	for _, want := range []string{
		`"minecraft:oak_log": {{key: "pillar_axis", count: 3, def: "y"}}`,
		`"minecraft:chest": {{key: "cardinal", count: 4, def: "north"}}`,
		`"minecraft:golden_rail": {{key: "hanging", count: 2, def: true}, {key: "rail_direction", count: 6, def: float64(0)}}`,
		`"minecraft:chalkboard": {{key: "direction", count: 16, def: float64(0)}}`,
		`"minecraft:stone": nil`,
		`"pillar_axis": {kind: vanillaStateEnum, values: []StateValue{"y", "x", "z"}}`,
		`"hanging": {kind: vanillaStateBool}`,
	} {
		if !strings.Contains(text, strings.Join(strings.Fields(want), " ")) {
			t.Errorf("generated source is missing:\n\t%s", want)
		}
	}
}

// TestGenerate_Rejects is the negative half: every check that stops a
// malformed registry becoming a plausible-looking table. Each case is a real
// way the input could be wrong, not a synthetic one -- a state a block
// declares that the state table never defines, a value list that disagrees
// with its own count, a default outside the domain, and an enumeration whose
// per-block list is not its own domain's prefix (the one shape that would
// silently lose values, since the table stores one list per state name).
func TestGenerate_Rejects(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "undefined state",
			body: `{"states": {"a": {"type":"bool","count":2,"values":[false,true]}},
			        "blocks": {"minecraft:x": {"states": {"b": {"type":"bool","count":2,"values":[false,true],"default":false}}}}}`,
			want: "state table does not define",
		},
		{
			name: "count disagrees with values",
			body: `{"states": {"a": {"type":"bool","count":3,"values":[false,true]}},
			        "blocks": {"minecraft:x": {"states": {}}}}`,
			want: "values are listed",
		},
		{
			name: "default outside domain",
			body: `{"states": {"a": {"type":"enum","count":2,"values":["p","q"]}},
			        "blocks": {"minecraft:x": {"states": {"a": {"type":"enum","count":2,"values":["p","q"],"default":"r"}}}}}`,
			want: "not one of its 2 legal values",
		},
		{
			name: "enum values are not the domain's prefix",
			body: `{"states": {"a": {"type":"enum","count":2,"values":["p","q"]}},
			        "blocks": {"minecraft:x": {"states": {"a": {"type":"enum","count":2,"values":["q","p"],"default":"q"}}}}}`,
			want: "the state's own domain has",
		},
		{
			name: "enum widened past its domain",
			body: `{"states": {"a": {"type":"enum","count":2,"values":["p","q"]}},
			        "blocks": {"minecraft:x": {"states": {"a": {"type":"enum","count":3,"values":["p","q","r"],"default":"p"}}}}}`,
			want: "widens",
		},
		{
			name: "type disagrees with the state table",
			body: `{"states": {"a": {"type":"bool","count":2,"values":[false,true]}},
			        "blocks": {"minecraft:x": {"states": {"a": {"type":"int","count":2,"values":[0,1],"default":0}}}}}`,
			want: "but the state table calls it",
		},
		{
			name: "un-namespaced block id",
			body: `{"states": {"a": {"type":"bool","count":2,"values":[false,true]}},
			        "blocks": {"torch": {"states": {}}}}`,
			want: "not a namespaced id",
		},
		{
			name: "empty registry",
			body: `{"states": {}, "blocks": {}}`,
			want: "no states",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "table.go")
			_, err := Generate(Config{RegistryPath: writeRegistry(t, tc.body), OutputPath: out})
			if err == nil {
				t.Fatalf("Generate accepted a malformed registry (wanted an error mentioning %q)", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Generate error = %q, want it to mention %q", err, tc.want)
			}
			if _, statErr := os.Stat(out); statErr == nil {
				t.Fatal("Generate wrote an output file for input it rejected")
			}
		})
	}
}
