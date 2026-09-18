package block

// permutations.go is the STATE half of what blocks/**/*.json says about a
// block's appearance. render.go reads the top-level components bag -- the
// block's default look -- and used to stop there, which its own header said
// out loud: a block whose texture or model depends on a block state always
// drew its default face set, so a custom lamp was dark in every preview and a
// pack author's state-specific art never appeared at all.
//
// ---- What the game does ----
//
// A block definition may carry a "permutations" array beside its components:
//
//	"permutations": [
//	  {"condition": "q.block_state('mypack:lit') == true",
//	   "components": {"minecraft:material_instances": {"up": {"texture": "lamp_on"}}}}
//	]
//
// Each entry is a Molang CONDITION and its own components bag. For a given
// block state, the engine starts from the top-level components and then
// applies every permutation whose condition holds, IN FILE ORDER, each one
// overriding what came before. Two permutations that both match are not a
// conflict: the later one wins. That ordering is reproduced exactly below,
// because a pack that writes a general rule first and a specific exception
// after it renders backwards under any other reading.
//
// ---- How the condition is evaluated ----
//
// Through molang-go, the same real parser/compiler this package already runs a
// {"tags": ...} block predicate through (see tags.go's MatchSet). A
// hand-rolled matcher for `query.block_state('x') == 'y'` would cover the
// shape almost every real condition takes and silently mis-read the rest --
// `!q.block_state('x')`, `q.block_state('a') == 1 && q.block_state('b')`,
// anything with arithmetic in it -- and mis-reading a condition means drawing
// the wrong texture with no diagnostic, which is the failure this whole change
// exists to remove. The one query registered is `block_state`, reading the
// state map handed in; every other query resolves to 0 exactly as it does in
// the engine, and a condition that reads one is reported as a note rather than
// quietly evaluating to something.
//
// String arguments and string state VALUES both go through molang-go's own
// string interning, so `q.block_state('axis') == 'y'` compares the same two
// numbers the engine's own evaluator compares. Booleans are 1/0, which is what
// Molang's `true`/`false` literals compile to.
//
// ---- Which state sets are enumerated ----
//
// Drawing needs a face map per CONCRETE state set, and nothing here is handed
// one: this runs when the pack is loaded, long before any block is placed. So
// the state sets are enumerated from the block's own declaration -- the cross
// product of the domains description.states gives for exactly those states the
// permutation conditions actually READ. States no condition looks at cannot
// change the answer and are left out of the product, which is what keeps it
// small; a block whose conditions read states it never declared cannot be
// enumerated at all and keeps its default faces, with a note saying so.

import (
	"fmt"
	"sort"
	"strings"

	molang "github.com/stirante/molang-go"
	"github.com/stirante/molang-go/ast"
	"github.com/stirante/molang-go/eval"
)

// maxStateVariants bounds the cross product one block may be expanded into.
// The product is already restricted to the states the conditions read, so a
// block that reaches this bound is reading four or more many-valued states in
// its conditions -- which is legal, and which this preview answers by drawing
// the block's default faces and saying so, rather than by putting hundreds of
// rows on the wire for one block.
const maxStateVariants = 64

// BlockPermutation is one entry of a block's "permutations" array: a condition
// and the appearance components it applies when the condition holds.
type BlockPermutation struct {
	// Condition is the Molang source verbatim, for a diagnostic to quote.
	Condition string `json:"condition"`
	// Faces is the permutation's own minecraft:material_instances resolved
	// onto the six cube faces, empty when it declares none. A face present
	// here REPLACES whatever the block had for that face; a face absent here
	// is left alone, which is how the engine applies a partial override.
	Faces map[string]MaterialInstance `json:"faces,omitempty"`
	// Extra is its non-face material instances, as BlockRender.Extra.
	Extra map[string]MaterialInstance `json:"extra,omitempty"`
	// Geometry is the permutation's own minecraft:geometry /
	// minecraft:block_shape, nil when it declares neither.
	Geometry *BlockGeometry `json:"geometry,omitempty"`

	// program is the compiled condition, nil when it did not compile (which
	// is reported as a note and makes the permutation never apply -- the safe
	// direction, since the alternative is applying an override the pack did
	// not ask for).
	program *molang.Program
	// stateNames is every block state the condition reads, sorted.
	stateNames []string
}

// StateNames is every block state this permutation's condition reads.
func (p BlockPermutation) StateNames() []string { return p.stateNames }

// Matches evaluates this permutation's condition against one concrete state
// set. A permutation whose condition did not compile never matches.
//
// A state the condition reads but states does not carry reads 0, which is what
// an unregistered query resolves to in the engine's evaluator too. It is not
// an error here for the same reason: this port is asked about state sets a
// feature actually wrote, and a feature that wrote only some of a block's
// states left the rest at their defaults.
func (p BlockPermutation) Matches(states map[string]StateValue) bool {
	if p.program == nil {
		return false
	}
	// The argument arrives already interned (molang-go has no string type),
	// so the lookup is built the same way round: interned name -> value.
	byIntern := make(map[float64]StateValue, len(states))
	for name, value := range states {
		byIntern[eval.InternString(name)] = value
	}
	ctx := &molang.Context{
		Scope:                    molang.NewScope(),
		ContinueOnUnresolvedRead: true,
		QueryFuncs: map[string]molang.QueryFunc{
			"block_state": func(args []float64, _ *eval.Context) float64 {
				if len(args) == 0 {
					return 0
				}
				value, ok := byIntern[args[0]]
				if !ok {
					return 0
				}
				return stateQueryValue(value)
			},
		},
	}
	return p.program.Run(ctx) != 0
}

// stateQueryValue is how one block state value reaches a Molang comparison:
// the same number the engine's own evaluator would compare against the other
// side of the `==`. Booleans are Molang's 1/0, numbers are themselves, and a
// string goes through molang-go's interning so that it compares equal to the
// identical string literal in the condition and to nothing else.
func stateQueryValue(v StateValue) float64 {
	switch x := v.(type) {
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case string:
		return eval.InternString(x)
	default:
		return 0
	}
}

// BlockStateRender is one block's appearance for one concrete set of block
// states: the top-level declaration with every matching permutation applied
// over it, in file order.
type BlockStateRender struct {
	// States is the state set this row is for -- exactly the states the
	// block's permutation conditions read, at one assignment of their
	// declared values. Its canonical rendering (CanonicalKey) is the key the
	// rest of the pipeline files this row under.
	States map[string]StateValue `json:"states"`
	// Faces is the resolved per-face material for that state set.
	Faces map[string]MaterialInstance `json:"faces"`
	// Geometry is the shape for that state set -- a permutation may swap the
	// model as well as the textures.
	Geometry BlockGeometry `json:"geometry"`
}

// ForStates resolves this block's appearance for one concrete state set: the
// top-level faces and geometry with every matching permutation applied over
// them, later permutations overriding earlier ones.
func (b BlockRender) ForStates(states map[string]StateValue) BlockStateRender {
	out := BlockStateRender{States: states, Geometry: b.Geometry}
	out.Faces = make(map[string]MaterialInstance, len(b.Faces))
	for face, inst := range b.Faces {
		out.Faces[face] = inst
	}
	for _, perm := range b.Permutations {
		if !perm.Matches(states) {
			continue
		}
		for face, inst := range perm.Faces {
			out.Faces[face] = inst
		}
		if perm.Geometry != nil {
			out.Geometry = *perm.Geometry
		}
	}
	return out
}

// StateVariants is every state set this block's permutations can tell apart,
// each with the faces and geometry it draws with.
//
// It returns nil -- not an empty slice, and not a single default row -- for a
// block with no permutations, or one whose conditions read states it does not
// declare, or one whose product would exceed maxStateVariants. Every caller's
// answer to nil is the same: use the block's default row, which is exactly
// what it drew before this existed.
//
// Rows are returned in a stable order (the cross product taken with the state
// names sorted), so a table built from them is byte-identical run to run.
func (b BlockRender) StateVariants() []BlockStateRender {
	names := b.conditionStateNames()
	if len(names) == 0 {
		return nil
	}
	domains := make([][]StateValue, len(names))
	total := 1
	for i, name := range names {
		values, declared := b.States[name]
		if !declared || len(values) == 0 {
			// A condition reading a state the block never declared cannot be
			// enumerated: nothing says what values that state can take. The
			// block keeps its default faces and parseBlockRender has already
			// recorded a note naming the state.
			return nil
		}
		domains[i] = values
		total *= len(values)
		if total > maxStateVariants {
			return nil
		}
	}

	out := make([]BlockStateRender, 0, total)
	assignment := make([]int, len(names))
	for {
		states := make(map[string]StateValue, len(names))
		for i, name := range names {
			states[name] = domains[i][assignment[i]]
		}
		out = append(out, b.ForStates(states))

		// Odometer, last index fastest, so the order is the plain nested-loop
		// order over the sorted names.
		i := len(names) - 1
		for i >= 0 {
			assignment[i]++
			if assignment[i] < len(domains[i]) {
				break
			}
			assignment[i] = 0
			i--
		}
		if i < 0 {
			return out
		}
	}
}

// applyUnconditional folds every permutation with a BLANK condition into the
// block's default faces and geometry, in file order.
//
// The schema asks for a condition and packs write one, so this is the
// malformed-but-recoverable case; reading a missing condition as "always"
// keeps the pack's textures rather than dropping them over a missing string.
// It has to happen on the DEFAULT row and not only inside ForStates, because
// the default row is what a block draws when its state set cannot be
// enumerated -- which, for a block whose only permutations are unconditional,
// is always (they read no states, so there is nothing to enumerate).
//
// Applying them here AND leaving them in Permutations is not double work with
// a different answer: a permutation applied twice sets the same face to the
// same material, and the second application happens at the permutation's own
// position in the order, so anything later still wins.
func (b *BlockRender) applyUnconditional() {
	for _, perm := range b.Permutations {
		if strings.TrimSpace(perm.Condition) != "" {
			continue
		}
		if len(perm.Faces) > 0 && b.Faces == nil {
			b.Faces = make(map[string]MaterialInstance, len(perm.Faces))
		}
		for face, inst := range perm.Faces {
			b.Faces[face] = inst
		}
		if perm.Geometry != nil {
			b.Geometry = *perm.Geometry
		}
	}
}

// conditionStateNames is the union of every state any permutation condition
// reads, sorted and deduplicated.
func (b BlockRender) conditionStateNames() []string {
	if len(b.Permutations) == 0 {
		return nil
	}
	seen := map[string]bool{}
	var names []string
	for _, perm := range b.Permutations {
		for _, name := range perm.stateNames {
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
	}
	sort.Strings(names)
	return names
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// parseDeclaredStates reads minecraft:block.description.states -- the block's
// own declaration of which states it has and what values each may take.
//
// Two forms are read, both of which real packs write: a plain ARRAY of the
// legal values, and the {"values": {"min": a, "max": b}} integer RANGE. A
// third thing entirely -- a state declared with something that is neither --
// is dropped rather than guessed at, which makes the block un-enumerable and
// leaves it drawing its default faces.
func parseDeclaredStates(raw any) map[string][]StateValue {
	table, _ := raw.(map[string]any)
	if len(table) == 0 {
		return nil
	}
	out := make(map[string][]StateValue, len(table))
	for name, value := range table {
		if values, ok := value.([]any); ok {
			domain := make([]StateValue, 0, len(values))
			for _, v := range values {
				domain = append(domain, StateValue(v))
			}
			if len(domain) > 0 {
				out[name] = domain
			}
			continue
		}
		obj, isObject := value.(map[string]any)
		if !isObject {
			continue
		}
		rangeObj, hasRange := obj["values"].(map[string]any)
		if !hasRange {
			continue
		}
		min, minOK := rangeObj["min"].(float64)
		max, maxOK := rangeObj["max"].(float64)
		if !minOK || !maxOK || max < min || max-min+1 > maxStateVariants {
			continue
		}
		domain := make([]StateValue, 0, int(max-min)+1)
		for v := min; v <= max; v++ {
			domain = append(domain, StateValue(v))
		}
		out[name] = domain
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parsePermutations reads the "permutations" array beside a block's
// components, in file order.
//
// A permutation that declares neither material_instances nor geometry is
// dropped: it says nothing about appearance, and keeping it would only mean
// compiling and evaluating a condition whose answer cannot change a face.
func parsePermutations(canonical, fileID string, raw any, declaredStates map[string][]StateValue) ([]BlockPermutation, []RenderNote) {
	list, _ := raw.([]any)
	if len(list) == 0 {
		return nil, nil
	}
	var out []BlockPermutation
	var notes []RenderNote
	reported := map[string]bool{}

	for i, entry := range list {
		obj, isObject := entry.(map[string]any)
		if !isObject {
			continue
		}
		components, _ := obj["components"].(map[string]any)
		rawMaterials, hasMaterials := components["minecraft:material_instances"]
		rawGeometry, hasGeometry := components["minecraft:geometry"]
		rawShape, hasShape := components["minecraft:block_shape"]
		if !hasMaterials && !hasGeometry && !hasShape {
			continue
		}

		condition, _ := obj["condition"].(string)
		perm := BlockPermutation{Condition: condition}
		if strings.TrimSpace(condition) == "" {
			// A permutation with no condition applies unconditionally, which
			// is a real (if unusual) way to write "this is always on top".
			// Give it a program that is always true rather than a special
			// case downstream.
			perm.program = alwaysTrue()
		} else {
			tree, err := molang.Parse(condition)
			if err == nil {
				perm.program, err = molang.CompileAST(tree)
			}
			if err != nil {
				notes = append(notes, RenderNote{Block: canonical, FileID: fileID, Message: fmt.Sprintf(
					"permutations[%d] condition %q is not valid Molang (%v) -- that permutation's textures are not applied",
					i, condition, err)})
				continue
			}
			perm.stateNames = blockStateNames(tree)
			for _, name := range unreadableConditionStates(tree, perm.stateNames, declaredStates) {
				if reported[name] {
					continue
				}
				reported[name] = true
				notes = append(notes, RenderNote{Block: canonical, FileID: fileID, Message: fmt.Sprintf(
					"permutations[%d] condition reads %s, which this block's description.states does not declare -- this preview cannot work out which values that state takes, so the block draws its default textures",
					i, name)})
			}
		}

		faces, extra, matNotes := parseMaterialInstances(canonical, fileID, rawMaterials)
		perm.Faces, perm.Extra = faces, extra
		notes = append(notes, matNotes...)
		if hasGeometry || hasShape {
			geom, geomNote := parseGeometry(canonical, fileID, rawGeometry, hasGeometry, rawShape, hasShape)
			perm.Geometry = &geom
			if geomNote != nil {
				notes = append(notes, *geomNote)
			}
		}
		out = append(out, perm)
	}
	return out, notes
}

// alwaysTrue is the compiled program a conditionless permutation gets.
func alwaysTrue() *molang.Program {
	program, err := molang.Compile("1")
	if err != nil {
		// "1" compiles. A nil program simply never matches, which is the
		// same safe direction every other compile failure here takes.
		return nil
	}
	return program
}

// blockStateNames returns every distinct state name this condition reads
// through query.block_state / q.block_state, sorted. Read from the AST rather
// than from the source text: an expression that mentions the same state twice,
// or that spells the query `q.` rather than `query.`, or that nests the call
// inside arithmetic, all have to come out the same.
//
// Only literal names are recoverable. A condition that computes the state name
// it reads is legal Molang and nothing here can enumerate it; it contributes no
// name, which leaves the block un-enumerable and drawing its default faces --
// visibly today's behaviour rather than a guess.
func blockStateNames(tree *ast.Program) []string {
	var names []string
	seen := map[string]bool{}
	ast.Walk(tree, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || call.Callee == nil || call.Callee.Namespace != ast.Query {
			return true
		}
		if strings.ToLower(call.Callee.Member) != "block_state" {
			return true
		}
		for _, a := range call.Args {
			if s, ok := a.(*ast.StringLit); ok && !seen[s.Value] {
				seen[s.Value] = true
				names = append(names, s.Value)
			}
		}
		return true
	})
	sort.Strings(names)
	return names
}

// unreadableConditionStates is every state this condition reads that the block
// does not declare a domain for -- the reason a block with real permutations
// can still come out un-enumerable, and the one thing an author can act on.
func unreadableConditionStates(tree *ast.Program, names []string, declared map[string][]StateValue) []string {
	var out []string
	for _, name := range names {
		if _, ok := declared[name]; !ok {
			out = append(out, name)
		}
	}
	if len(names) == 0 {
		// A condition that calls block_state with something other than a
		// string literal, or that reads the block through some other query.
		// Worth one note, because it is why the block did not get state rows.
		if readsBlockState(tree) {
			out = append(out, "a block state whose name is not a literal")
		}
	}
	return out
}

// readsBlockState reports whether the condition calls block_state at all.
func readsBlockState(tree *ast.Program) bool {
	found := false
	ast.Walk(tree, func(n ast.Node) bool {
		if found {
			return false
		}
		if call, ok := n.(*ast.CallExpr); ok && call.Callee != nil &&
			call.Callee.Namespace == ast.Query && strings.ToLower(call.Callee.Member) == "block_state" {
			found = true
			return false
		}
		return true
	})
	return found
}
