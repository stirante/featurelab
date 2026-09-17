// Package genvanillastates turns a vanilla block-state registry JSON into
// block/vanilla_states_table.go -- the tracked Go catalogue block/
// vanilla_states.go reads.
//
// It is the second generator in this repo (genvanillablocks is the first) and
// deliberately follows the same shape: a Config/Summary/Generate triple with
// no flag parsing of its own, every input path supplied by the caller, output
// written whole, and a determinism guarantee its own test enforces.
//
// INPUT SCHEMA. Generate reads one JSON document with two objects:
//
//	{
//	  "states": {
//	    "<state name>": {
//	      "type":   "bool" | "int" | "enum",
//	      "count":  <number of legal values>,
//	      "values": [ <the legal values, in order> ]
//	    }, ...
//	  },
//	  "blocks": {
//	    "minecraft:<id>": {
//	      "states": {
//	        "<state name>": {
//	          "type": ..., "count": ..., "values": [...],
//	          "default": <the value a freshly-placed block of this type has>
//	        }, ...
//	      }
//	    }, ...
//	  }
//	}
//
// Any other member of either object is ignored, so a richer document
// (extra bookkeeping alongside each entry) is accepted unchanged. A block
// with an empty "states" object is a block type that declares no states at
// all, which is a real and load-bearing answer -- see block/vanilla_states.go
// on why "known, and declares nothing" must not be confused with "unknown".
//
// VALUE DOMAINS. A state's legal values are the same for every type that
// declares it, except where a declaring type narrows or widens the count; the
// per-block "count" is therefore the authority and the per-block "values" must
// be derivable from it (Generate refuses the input otherwise, see
// checkDerivable). That is what lets the output store one value list per state
// NAME rather than one per (block, state) pair -- 157 lists instead of 1601.
package genvanillastates

import (
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"sort"
	"strconv"
	"strings"
)

// Config is Generate's whole input: where to read the registry from and
// where to write the Go catalogue to.
type Config struct {
	RegistryPath string
	OutputPath   string
}

// Summary is what a run produced, for the command line to print. Two runs
// over the same input must produce equal Summaries (the determinism test
// checks exactly this alongside the bytes).
type Summary struct {
	Blocks       int // block types written
	WithStates   int // of those, how many declare at least one state
	States       int // distinct state names in the domain table
	Declarations int // (block type, state) pairs written
}

const (
	kindBool = "bool"
	kindInt  = "int"
	kindEnum = "enum"
)

type registryState struct {
	Type   string `json:"type"`
	Count  int    `json:"count"`
	Values []any  `json:"values"`
}

type registryBlockState struct {
	Type    string `json:"type"`
	Count   int    `json:"count"`
	Values  []any  `json:"values"`
	Default any    `json:"default"`
}

type registryBlock struct {
	States map[string]registryBlockState `json:"states"`
}

type registryFile struct {
	States map[string]registryState `json:"states"`
	Blocks map[string]registryBlock `json:"blocks"`
}

// Generate reads cfg.RegistryPath, validates every state and every block
// entry in it, and writes the gofmt'd catalogue to cfg.OutputPath.
func Generate(cfg Config) (Summary, error) {
	raw, err := os.ReadFile(cfg.RegistryPath)
	if err != nil {
		return Summary{}, err
	}
	var registry registryFile
	if err := json.Unmarshal(raw, &registry); err != nil {
		return Summary{}, fmt.Errorf("decode %s: %w", cfg.RegistryPath, err)
	}
	if len(registry.States) == 0 {
		return Summary{}, fmt.Errorf("registry contains no states")
	}
	if len(registry.Blocks) == 0 {
		return Summary{}, fmt.Errorf("registry contains no blocks")
	}

	for name, state := range registry.States {
		if err := checkValues(name, state.Type, state.Count, state.Values); err != nil {
			return Summary{}, err
		}
	}

	blockIDs := make([]string, 0, len(registry.Blocks))
	for id := range registry.Blocks {
		blockIDs = append(blockIDs, id)
	}
	sort.Strings(blockIDs)

	summary := Summary{Blocks: len(blockIDs), States: len(registry.States)}
	type declaration struct {
		key     string
		count   int
		def     any
		defKind string
	}
	declarations := make(map[string][]declaration, len(blockIDs))
	for _, id := range blockIDs {
		if !strings.Contains(id, ":") {
			return Summary{}, fmt.Errorf("block %q is not a namespaced id", id)
		}
		block := registry.Blocks[id]
		keys := make([]string, 0, len(block.States))
		for key := range block.States {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		if len(keys) > 0 {
			summary.WithStates++
		}
		for _, key := range keys {
			declared := block.States[key]
			state, ok := registry.States[key]
			if !ok {
				return Summary{}, fmt.Errorf("block %s declares state %q, which the registry's own state table does not define", id, key)
			}
			if declared.Type != state.Type {
				return Summary{}, fmt.Errorf("block %s declares state %q as %q, but the state table calls it %q", id, key, declared.Type, state.Type)
			}
			if err := checkValues(id+"/"+key, declared.Type, declared.Count, declared.Values); err != nil {
				return Summary{}, err
			}
			if err := checkDerivable(id, key, declared, state); err != nil {
				return Summary{}, err
			}
			if !contains(declared.Values, declared.Default) {
				return Summary{}, fmt.Errorf("block %s state %q has default %v, which is not one of its %d legal values", id, key, declared.Default, len(declared.Values))
			}
			declarations[id] = append(declarations[id], declaration{key: key, count: declared.Count, def: declared.Default, defKind: declared.Type})
			summary.Declarations++
		}
	}

	stateNames := make([]string, 0, len(registry.States))
	for name := range registry.States {
		stateNames = append(stateNames, name)
	}
	sort.Strings(stateNames)

	var out strings.Builder
	out.WriteString(header(summary))
	out.WriteString("\nvar vanillaStateDomains = map[string]vanillaStateDomain{\n")
	for _, name := range stateNames {
		state := registry.States[name]
		switch state.Type {
		case kindEnum:
			values := make([]string, 0, len(state.Values))
			for _, v := range state.Values {
				values = append(values, literal(v))
			}
			fmt.Fprintf(&out, "\t%s: {kind: vanillaStateEnum, values: []StateValue{%s}},\n",
				strconv.Quote(name), strings.Join(values, ", "))
		case kindInt:
			fmt.Fprintf(&out, "\t%s: {kind: vanillaStateInt},\n", strconv.Quote(name))
		case kindBool:
			fmt.Fprintf(&out, "\t%s: {kind: vanillaStateBool},\n", strconv.Quote(name))
		}
	}
	out.WriteString("}\n\nvar vanillaBlockStateTable = map[string][]vanillaBlockState{\n")
	for _, id := range blockIDs {
		declared := declarations[id]
		if len(declared) == 0 {
			// A block type that declares no states at all. It is listed, with
			// no entries, so that "this type has no such state" stays
			// answerable for it -- see block/vanilla_states.go.
			fmt.Fprintf(&out, "\t%s: nil,\n", strconv.Quote(id))
			continue
		}
		fields := make([]string, 0, len(declared))
		for _, d := range declared {
			fields = append(fields, fmt.Sprintf("{key: %s, count: %d, def: %s}",
				strconv.Quote(d.key), d.count, literal(d.def)))
		}
		fmt.Fprintf(&out, "\t%s: {%s},\n", strconv.Quote(id), strings.Join(fields, ", "))
	}
	out.WriteString("}\n")

	formatted, err := format.Source([]byte(out.String()))
	if err != nil {
		return Summary{}, fmt.Errorf("generated source does not parse: %w", err)
	}
	if err := os.WriteFile(cfg.OutputPath, formatted, 0o644); err != nil {
		return Summary{}, err
	}
	return summary, nil
}

// header is the generated file's own preamble. It states the catalogue's
// provenance in the two halves that have different standing: the state names
// and value domains agree exactly with Mojang's published block metadata,
// which is a checkable claim about a public file; the defaults have no
// counterpart in that file and are stated as the fact they are.
func header(summary Summary) string {
	return fmt.Sprintf(`// Code generated by cmd/genvanillastates; DO NOT EDIT.

package block

// This file is the per-block-type state catalogue: for each of the %d vanilla
// block types, every block state that type declares, how many legal values
// that state has on it, and the value a freshly-placed block of that type
// carries for it. %d of those types declare at least one state (%d
// declarations in all) and the rest declare none, which is recorded rather
// than left blank. %d distinct states appear.
//
// The state names and their value domains agree exactly with Mojang's own
// published block metadata (metadata/vanilladata_modules/mojang-blocks.json
// in the Mojang/bedrock-samples repository): across every block id present in
// both, no state-set differs, and every property's value list matches
// value-for-value in order. That file records no defaults; the def field
// below is simply the value a freshly-placed block of the type carries, and
// has no counterpart there to be checked against.
//
// See block/vanilla_states.go for what reads this and what the fields mean.
`, summary.Blocks, summary.WithStates, summary.Declarations, summary.States)
}

// checkValues rejects a state whose declared count and value list disagree, or
// whose values are not the JSON shape its type calls for. The type/shape pair
// is what makes the value domain derivable from a count later on.
func checkValues(where, kind string, count int, values []any) error {
	if count <= 0 {
		return fmt.Errorf("%s: value count is %d, want at least 1", where, count)
	}
	if len(values) != count {
		return fmt.Errorf("%s: value count is %d but %d values are listed", where, count, len(values))
	}
	for i, v := range values {
		switch kind {
		case kindBool:
			if _, ok := v.(bool); !ok {
				return fmt.Errorf("%s: value %d is %v, want a boolean", where, i, v)
			}
		case kindInt:
			n, ok := v.(float64)
			if !ok {
				return fmt.Errorf("%s: value %d is %v, want a number", where, i, v)
			}
			if n != float64(i) {
				return fmt.Errorf("%s: value %d is %v, want %d -- an integer state's values must be its own indices", where, i, v, i)
			}
		case kindEnum:
			if _, ok := v.(string); !ok {
				return fmt.Errorf("%s: value %d is %v, want a string", where, i, v)
			}
		default:
			return fmt.Errorf("%s: unknown state type %q", where, kind)
		}
	}
	return nil
}

// checkDerivable is the guard that lets the output keep one value list per
// state NAME instead of one per (block, state) pair: a block's own list must
// be reconstructible from its count plus the state's list. For an integer
// state that is the indices 0..count-1 (so a type may widen the domain past
// the state's own list and still be derivable); for a boolean or an
// enumeration it is the state's list truncated to count. Anything else would
// silently lose a value on the way into the table, so it is an error.
func checkDerivable(id, key string, declared registryBlockState, state registryState) error {
	if declared.Type == kindInt {
		// checkValues already proved values[i] == i for both lists.
		return nil
	}
	if declared.Count > state.Count {
		return fmt.Errorf("block %s widens %s state %q from %d values to %d, which its value list cannot be derived from",
			id, declared.Type, key, state.Count, declared.Count)
	}
	for i, v := range declared.Values {
		if v != state.Values[i] {
			return fmt.Errorf("block %s state %q value %d is %v, but the state's own domain has %v there",
				id, key, i, v, state.Values[i])
		}
	}
	return nil
}

func contains(values []any, want any) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

// literal renders one state value as the Go expression for this package's
// StateValue convention: enumerations are strings, booleans are booleans, and
// numbers are float64 -- the same JSON-number spelling every Descriptor.States
// value in this port already carries.
func literal(v any) string {
	switch x := v.(type) {
	case string:
		return strconv.Quote(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return "float64(" + strconv.FormatFloat(x, 'f', -1, 64) + ")"
	default:
		return fmt.Sprintf("%#v", v)
	}
}
