// distribution.go implements the `distribution` block — the shape shared,
// byte-for-byte, between minecraft:scatter_feature and
// minecraft:feature_rules (the latter not yet implemented). Every draw kind,
// bound and order here follows the game's own scatter loop and per-axis
// coordinate evaluation, preserving RNG order rather than reinterpreting it;
// the reasoning is in the per-function comments below.
//
// Every draw kind, bound and order below holds in both supported game
// versions:
//   - both gaussian-family kinds (gaussian, inverse_gaussian) draw a bounded
//     integer minus a second bounded integer, both with the SAME bound, first
//     the draw then the subtrahend;
//   - uniform takes a single bounded draw, bound max-min;
//   - the chance gate is described in scatter.go's header.
package features

import (
	"fmt"
	"math"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"

	molang "github.com/stirante/molang-go"
	"github.com/stirante/molang-go/eval"
)

// roundf is C's round-half-away-from-zero, NOT Go's math.Round (which
// already rounds half away from zero too, actually — kept as its own named
// function because the scatter loop and the Molang-resolving per-axis
// evaluation both reach for C's rounding, and because a future reader
// comparing the two roundings should find the distinction spelled out
// rather than collapsed).
func roundf(x float64) float64 {
	if x < 0 {
		return -math.Round(-x)
	}
	return math.Round(x)
}

// MolangExpr is a resolved Molang-typed distribution field: either a
// constant (JSON number/bool — no RNG, no molang-go compile step) or a
// compiled Molang program (JSON string).
type MolangExpr struct {
	isConstant bool
	constant   float64
	program    *molang.Program
}

// IsConstant reports whether Evaluate returns without touching its context. A caller that has to
// BUILD that context can skip the work entirely when this is true -- see features/cave.go's
// caveMolangContext, where constructing one costs a fresh MT19937 per call and the carver makes
// thousands of calls per placement for a field that is usually a plain number.
func (e *MolangExpr) IsConstant() bool { return e.isConstant }

// ParseMolangValue accepts a raw JSON number/bool/string — the single entry
// point every Molang-typed field in this package parses through.
//
// A JSON NUMBER is rounded to float32 like every other value in a Molang field. It used to be
// stored and returned as a raw float64, never touching molang-go at all -- so the same field
// written as the number 0.1 and as the string "0.1" produced different values, because the game
// holds every Molang literal as a float32 (see molang-go/eval/float32.go) and the
// string path went through it while the number path did not. Two spellings of one value are not
// allowed to disagree.
func ParseMolangValue(v any) (*MolangExpr, error) {
	switch x := v.(type) {
	case float64:
		return &MolangExpr{isConstant: true, constant: eval.Round32(x)}, nil
	case bool:
		val := 0.0
		if x {
			val = 1
		}
		return &MolangExpr{isConstant: true, constant: val}, nil
	case string:
		prog, err := molang.Compile(x)
		if err != nil {
			return nil, err
		}
		return &MolangExpr{program: prog}, nil
	case nil:
		return &MolangExpr{isConstant: true, constant: 0}, nil
	default:
		return nil, fmt.Errorf("must be a number, boolean, or Molang string")
	}
}

func constMolang(v float64) *MolangExpr { return &MolangExpr{isConstant: true, constant: v} }

// Evaluate runs the expression against ctx.
func (e *MolangExpr) Evaluate(ctx *molang.Context) float64 {
	if e.isConstant {
		return e.constant
	}
	return e.program.Run(ctx)
}

// ---------------------------------------------------------------------------
// distribution.x/y/z parsing
// ---------------------------------------------------------------------------

// DistKind is the set of distribution kinds the schema accepts.
type DistKind int

const (
	DistNone DistKind = iota
	DistUniform
	DistGaussian
	DistInverseGaussian
	DistFixedGrid
	DistJitteredGrid
	DistTriangle
)

var distKindNames = map[string]DistKind{
	"uniform":          DistUniform,
	"gaussian":         DistGaussian,
	"inverse_gaussian": DistInverseGaussian,
	"fixed_grid":       DistFixedGrid,
	"jittered_grid":    DistJitteredGrid,
	"triangle":         DistTriangle,
}

// CoordinateRange is one axis's parsed distribution -- the JSON
// distribution.x/y/z. Tagged lowerCamelCase -- reachable from the wire via
// ScatterDistribution.AxisX/Y/Z; Min/Max are *MolangExpr and always serialize as `{}` (see
// featurelab-go/wire's package doc comment, "Opaque Molang values").
type CoordinateRange struct {
	Kind       DistKind    `json:"kind"`
	Min        *MolangExpr `json:"min"`
	Max        *MolangExpr `json:"max"`
	StepSize   float64     `json:"stepSize"`
	GridOffset float64     `json:"gridOffset"`
}

// ParseCoordinateRange parses one axis of a `distribution` block.
func ParseCoordinateRange(raw any, jsonPath string) (CoordinateRange, error) {
	if raw == nil {
		return CoordinateRange{Kind: DistNone, Min: constMolang(0), Max: constMolang(0)}, nil
	}
	switch v := raw.(type) {
	case float64, string, bool:
		minExpr, err := ParseMolangValue(v)
		if err != nil {
			return CoordinateRange{}, err
		}
		return CoordinateRange{Kind: DistNone, Min: minExpr, Max: constMolang(0)}, nil
	case map[string]any:
		distRaw, _ := v["distribution"].(string)
		kind, ok := distKindNames[distRaw]
		if !ok {
			return CoordinateRange{}, fmt.Errorf("%s.distribution must be a known kind (got %v)", jsonPath, v["distribution"])
		}
		extent, ok := v["extent"].([]any)
		if !ok || len(extent) != 2 {
			return CoordinateRange{}, fmt.Errorf("%s.extent must be a 2-element [min, max] array", jsonPath)
		}
		minExpr, err := ParseMolangValue(extent[0])
		if err != nil {
			return CoordinateRange{}, fmt.Errorf("%s.extent[0]: %w", jsonPath, err)
		}
		maxExpr, err := ParseMolangValue(extent[1])
		if err != nil {
			return CoordinateRange{}, fmt.Errorf("%s.extent[1]: %w", jsonPath, err)
		}
		// step_size default: unconfirmed. 1 (not 0) is the only value that
		// makes a bare fixed_grid/jittered_grid axis non-degenerate, which
		// matches how packs use it.
		stepSize := 1.0
		if sv, ok := v["step_size"]; ok {
			f, ok := toFloat(sv)
			if !ok {
				return CoordinateRange{}, fmt.Errorf("%s.step_size must be a number", jsonPath)
			}
			stepSize = f
		}
		gridOffset := 0.0
		if gv, ok := v["grid_offset"]; ok {
			f, ok := toFloat(gv)
			if !ok {
				return CoordinateRange{}, fmt.Errorf("%s.grid_offset must be a number", jsonPath)
			}
			gridOffset = f
		}
		return CoordinateRange{Kind: kind, Min: minExpr, Max: maxExpr, StepSize: stepSize, GridOffset: gridOffset}, nil
	default:
		return CoordinateRange{}, fmt.Errorf("%s must be a number, Molang string, or {distribution, extent} object", jsonPath)
	}
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	default:
		return 0, false
	}
}

// ---------------------------------------------------------------------------
// coordinate_eval_order
// ---------------------------------------------------------------------------

// Axis is one of x/y/z.
type Axis int

const (
	AxisX Axis = iota
	AxisY
	AxisZ
)

var evalOrders = map[string][3]Axis{
	"xyz": {AxisX, AxisY, AxisZ},
	"xzy": {AxisX, AxisZ, AxisY},
	"yxz": {AxisY, AxisX, AxisZ},
	"yzx": {AxisY, AxisZ, AxisX},
	"zxy": {AxisZ, AxisX, AxisY},
	"zyx": {AxisZ, AxisY, AxisX},
}

// ParseEvalOrder parses coordinate_eval_order. Absent -> xzy.
//
// The absent default is `xzy`, which is the vanilla behaviour. An earlier iteration of this code
// returned `xyz`. Mojang's published schema comment for the field agrees with `xzy`: "The order in
// which coordinates will be evaluated. Should be used when a coordinate depends on another. If
// omitted, defaults to \"xzy\"." The stated rationale is that a vertical coordinate usually
// depends on the lateral ones, so y is evaluated last.
//
// This is load-bearing, which is why it is worth a paragraph: scatter is the most common feature
// type and most files omit the key. The order permutes which random draw feeds which
// axis, so PLACEMENTS MOVE -- it is not only a Molang-visibility change. It also changes which
// variable.world{x,y,z} are already set when a later axis evaluates: under xzy an expression in
// `y` can legally read variable.worldz, which under xyz reported an unresolved read.
//
// Vanilla behaviour: the six names map to enum values in the order 0="xyz", 1="xzy", 2="yxz",
// 3="yzx", 4="zxy", 5="zyx", and the parsed value's default when the key is absent is 1, i.e.
// "xzy". The enum order happens to match the order the JSON schema lists the six values, but
// that agreement is a fact about the current version, not a rule.
//
// THE TRAP, because it is easy to fall into: the runtime scatter parameters' own eval-order
// value starts at 0 -- which would say `xyz` -- but it is always overwritten from the parsed
// JSON value before any placement reads it, so the default that governs is `xzy`.
func ParseEvalOrder(value any) ([3]Axis, error) {
	if value == nil {
		return evalOrders["xzy"], nil
	}
	s, ok := value.(string)
	if !ok {
		return [3]Axis{}, fmt.Errorf("coordinate_eval_order must be a string")
	}
	order, ok := evalOrders[s]
	if !ok {
		return [3]Axis{}, fmt.Errorf("coordinate_eval_order must be one of xyz/xzy/yxz/yzx/zxy/zyx (got %q)", s)
	}
	return order, nil
}

// ---------------------------------------------------------------------------
// scatter_chance
// ---------------------------------------------------------------------------

// ChanceKind distinguishes the two scatter_chance JSON shapes.
type ChanceKind int

const (
	ChanceFraction ChanceKind = iota
	ChancePercent
)

// ChanceSpec is the parsed `scatter_chance` field. Tagged lowerCamelCase -- reachable
// from the wire via ScatterDistribution.Chance; Expr is a *MolangExpr and always serializes as
// `{}` (see featurelab-go/wire's package doc comment, "Opaque Molang values").
type ChanceSpec struct {
	Kind ChanceKind `json:"kind"`
	// Numerator and Denominator are ints because the game's are: 32-bit integers, both
	// defaulting to 0. They used to be
	// float64 here, so `{"numerator": 1.5, "denominator": 4}` was a 2-in-4 gate in this bench
	// and a 1-in-4 gate in the game.
	Numerator   int `json:"numerator"`
	Denominator int `json:"denominator"`
	// Expr is the PERCENT field, and it is set on BOTH kinds -- on the fraction form it holds
	// the game's default of 100, because the game's fraction gate falls
	// through into the percent field rather than short-circuiting. See ShouldScatter.
	Expr *MolangExpr `json:"expr"`
}

// engineChanceInt converts a JSON number to the 32-bit int the game's numerator/denominator
// fields are, truncating toward zero and saturating at the int32 bounds rather than wrapping.
// The 32-bit width is established (see ChanceSpec). That a non-integral JSON number is truncated
// rather than rejected by the game's loader is an assumption.
func engineChanceInt(f float64) int {
	t := math.Trunc(f)
	switch {
	case math.IsNaN(t):
		return 0
	case t > math.MaxInt32:
		return math.MaxInt32
	case t < math.MinInt32:
		return math.MinInt32
	}
	return int(t)
}

// ParseScatterChance parses `scatter_chance`, following the game's own
// validation of the parsed value. Absent -> percent 100 (always scatter, no RNG).
//
// The game validates the value when it turns the parsed JSON into the scatter parameters a
// placement reads, and it REWRITES two kinds of bad input instead of refusing the file:
//
//   - a fraction with denominator <= numerator: content-logs "Bad value for scatter_chance -
//     denominator should be greater than the numerator" and stores a denominator of 1. The
//     numerator is stored either way.
//   - a CONSTANT percent outside (0, 100]: content-logs "Bad value for scatter_chance - should
//     be between 0 and 100 (exclusive)" and stores 100.0f. So `scatter_chance: 0` -- which
//     reads like "never" -- ALWAYS scatters in game. A non-constant Molang expression skips the
//     check entirely, so a runtime value of 0 still means "do not scatter"; only a compile-time
//     constant is rewritten.
//
// warn may be nil.
func ParseScatterChance(raw any, warn func(string)) (ChanceSpec, error) {
	warnf := func(format string, args ...any) {
		if warn != nil {
			warn(fmt.Sprintf(format, args...))
		}
	}
	if raw == nil {
		return ChanceSpec{Kind: ChancePercent, Expr: constMolang(100)}, nil
	}
	switch v := raw.(type) {
	case float64, string, bool:
		expr, err := ParseMolangValue(v)
		if err != nil {
			return ChanceSpec{}, err
		}
		if expr.IsConstant() && (expr.constant <= 0 || expr.constant > 100) {
			warnf("scatter_chance %v is outside the range the game accepts (above 0, up to 100) -- "+
				"the game reports it as a content error and then uses 100, which scatters every time, "+
				"so this tool does the same. A constant 0 does NOT mean \"never\": use iterations 0, "+
				"or drop the rule, for that.", expr.constant)
			expr = constMolang(100)
		}
		return ChanceSpec{Kind: ChancePercent, Expr: expr}, nil
	case map[string]any:
		_, hasNum := v["numerator"]
		_, hasDen := v["denominator"]
		if hasNum || hasDen {
			// Both conversions used to discard their `ok`, and the failure that hid was the worst
			// kind: a non-number silently became 0, and a numerator of 0 makes the whole gate pass
			// -- it falls through to the percent field, which this form never writes, so that
			// field still holds its default of 100. So `{"numerator": 1, "denominator": "4"}`
			// -- a quoted number, which is the commonest way a hand-edited JSON field goes wrong
			// -- did not scatter one time in four. It scattered EVERY time, which is the exact
			// opposite of what was written, with nothing reported anywhere.
			//
			// Reported now, like every other numeric field this parser reads (step_size,
			// grid_offset, both extents) already does -- this pair was the only one that didn't.
			// A file cannot be relying on the old always-scatter behaviour by accident: the way to spell "always" is to omit the key, whose
			// documented default is already 100%.
			num, numOK := toFloat(v["numerator"])
			if hasNum && !numOK {
				return ChanceSpec{}, fmt.Errorf("scatter_chance.numerator must be a number (got %v) -- "+
					"a value this field cannot read counts as 0, which makes the whole chance gate pass "+
					"every time instead of failing it", v["numerator"])
			}
			den, denOK := toFloat(v["denominator"])
			if hasDen && !denOK {
				return ChanceSpec{}, fmt.Errorf("scatter_chance.denominator must be a number (got %v) -- "+
					"a value this field cannot read counts as 0, which makes the whole chance gate pass "+
					"every time instead of failing it", v["denominator"])
			}
			spec := ChanceSpec{
				Kind:        ChanceFraction,
				Numerator:   engineChanceInt(num),
				Denominator: engineChanceInt(den),
				// The percent field the fraction gate falls through into. The game never writes
				// it on this path, so it keeps its default: the constant 100.0f.
				Expr: constMolang(100),
			}
			if spec.Denominator <= spec.Numerator {
				warnf("scatter_chance denominator (%d) must be greater than the numerator (%d) -- "+
					"the game reports this as a content error and then places with a denominator of 1, "+
					"so the gate passes every time; this tool does the same",
					spec.Denominator, spec.Numerator)
				spec.Denominator = 1
			}
			return spec, nil
		}
	}
	return ChanceSpec{}, fmt.Errorf("scatter_chance must be a number, Molang string, or {numerator, denominator} object")
}

// ShouldScatter mirrors the scatter feature's chance gate: the fraction form
// takes one bounded integer draw with the denominator as its bound, the
// percent form one float draw. Gates the entire scattering pass.
func ShouldScatter(chance ChanceSpec, molangCtx *molang.Context, rnd random.IRandom) bool {
	pass, _ := scatterGate(chance, molangCtx, rnd)
	return pass
}

// scatterGate is ShouldScatter plus the percent the percent gate compared against, so a rejected
// gate can say what it evaluated without evaluating the expression a second time. The percent is
// 100 on the fraction paths, which never reach that gate's comparison.
func scatterGate(chance ChanceSpec, molangCtx *molang.Context, rnd random.IRandom) (bool, float32) {
	if chance.Kind == ChanceFraction {
		num, den := chance.Numerator, chance.Denominator
		if num >= 1 && den >= 1 {
			if num == den {
				return true, 100 // 100% -- NO RNG
			}
			// *** RNG CALL ***
			return rnd.NextIntBound(den) < num, 100
		}
		// FALL THROUGH to the percent gate below -- which is what the game does, and is not
		// the same thing as returning true. A numerator or denominator below 1 continues INTO
		// the percent check, not to a "scatter" exit. It happens to answer true for a fraction
		// parsed from JSON, because ParseScatterChance gives that form the percent default of
		// 100 -- but writing the gate as an unconditional `return true` would state a
		// conclusion where the game has a branch, and hide which of the two facts the answer
		// rests on.
	}
	if chance.Expr == nil {
		// A ChanceSpec built without going through ParseScatterChance. The game's default for
		// the percent field is 100, so this is "always scatter, no draw".
		return true, 100
	}
	// The percent gate is float32 END TO END in the game: a Molang value is a float32, and a
	// constant `scatter_chance` is stored as a float32 too. Both guards below compare that same
	// float32 (against 100.0f, against 0.0), and the roll multiplies the draw by 100.0f in
	// float32 before comparing.
	//
	// molang-go already evaluates a compiled program float32-exactly, so narrowing here changes
	// nothing for a Molang string; what it closes is the plain-number case, where
	// ParseMolangValue keeps the JSON literal as a raw float64. The game's float draw
	// likewise yields a float32, so the draw is narrowed here rather than multiplied at a width
	// the game never uses.
	pct := float32(chance.Expr.Evaluate(molangCtx))
	if pct >= 100 {
		return true, pct // NO RNG
	}
	if pct <= 0 {
		return false, pct // NO RNG
	}
	// *** RNG CALL ***
	return float32(float32(rnd.NextFloat())*100) < pct, pct
}

// describeIterations is the iterations_zero stop's detail: the rounded count, and the raw value
// when rounding is what made it zero.
func describeIterations(rounded int, raw float64) string {
	if float64(rounded) == raw {
		return fmt.Sprintf("iterations = %d", rounded)
	}
	return fmt.Sprintf("iterations = %d (from %g)", rounded, raw)
}

// recordChanceStop records a rejected chance gate: chance_zero when it could never pass,
// chance_failed when it rolled and lost.
func recordChanceStop(chance ChanceSpec, pct float32) {
	fraction := chance.Kind == ChanceFraction && chance.Numerator >= 1 && chance.Denominator >= 1
	reason := profiler.StopChanceFailed
	if !fraction && pct <= 0 {
		reason = profiler.StopChanceZero
	}
	if profiler.StopCounted(reason, profiler.NoOrdinal) {
		return
	}
	var detail string
	switch {
	case fraction:
		detail = fmt.Sprintf("roll failed at %d/%d", chance.Numerator, chance.Denominator)
	case pct <= 0:
		detail = fmt.Sprintf("scatter_chance = %g%%", pct)
	default:
		detail = fmt.Sprintf("roll failed at %g%%", pct)
	}
	profiler.RecordStop(reason, detail, profiler.NoOrdinal)
}

// ---------------------------------------------------------------------------
// Per-axis coordinate evaluation
// ---------------------------------------------------------------------------

// GridState is the mutable grid index threaded across axis evaluations
// within one iteration.
type GridState struct{ Value int }

// EvalCoordinateRange evaluates one axis's distribution, with every RNG draw
// marked.
func EvalCoordinateRange(rng CoordinateRange, min, max int, grid *GridState, rnd random.IRandom) int {
	switch rng.Kind {
	case DistNone:
		return min // *** 0 draws ***

	case DistUniform:
		if max > min {
			// *** RNG CALL ***
			return min + rnd.NextIntBound(max-min)
		}
		return min // *** 0 draws when max <= min ***

	case DistGaussian:
		range_ := max - min
		if max < min {
			range_++
		}
		half := arithShiftRight1(range_)
		// *** RNG CALL x2 *** same bound, unconditionally: bounded draw
		// minus bounded draw, in that order.
		d1 := rnd.NextIntBound(half)
		d2 := rnd.NextIntBound(half)
		return min + half + d1 - d2

	case DistInverseGaussian:
		half := (max - min) / 2 // PLAIN truncating division, NOT >>1
		// *** RNG CALL x2 *** the same bounded-minus-bounded pair as the
		// gaussian case above; the tie-break boolean draw below is a
		// separate draw of its own.
		d1 := rnd.NextIntBound(half)
		d2 := rnd.NextIntBound(half)
		diff := d1 - d2
		if diff < 0 {
			return min - diff
		}
		if diff == 0 {
			// *** RNG CALL, ONLY on an exact tie ***
			if rnd.NextBoolean() {
				return max
			}
			return min
		}
		return max - diff

	case DistFixedGrid, DistJitteredGrid:
		// Vanilla behaviour, in both supported game versions: the sum of
		// index*step and gridOffset carries NO min term, and the division
		// that follows it is unsigned. Two points that are easy to get
		// wrong:
		//
		//  1. The returned coordinate DOES include min:
		//     (gridOffset + min + index*stepSize [+ jitter]) % modulus.
		//  2. The index carried to the next axis does NOT:
		//     index' = (index*stepSize + gridOffset) / modulus, computed in
		//     UNSIGNED arithmetic, with no min term anywhere. The old port
		//     folded min into that division too, which shifted the cascade
		//     for every negative-min grid axis.
		modulus := max - min + 1
		indexed := int(rng.GridOffset) + min + grid.Value*int(rng.StepSize)
		if rng.Kind == DistJitteredGrid && rng.StepSize >= 2 {
			// *** RNG CALL, ONLY for jittered_grid AND stepSize>=2 ***
			// It is a bounded integer draw with stepSize as the bound, so
			// the jitter stays inside one grid step. The old port drew an
			// UNBOUNDED integer, which after the modulo scattered the cell
			// anywhere in the extent.
			indexed += rnd.NextIntBound(int(rng.StepSize))
		}
		grid.Value = gridIndexNext(grid.Value, int(rng.StepSize), int(rng.GridOffset), modulus)
		return mod(indexed, modulus) // *** 0 or 1 draws total ***

	case DistTriangle:
		// Vanilla behaviour, identical in both supported game versions.
		// Two points that are easy to get wrong:
		//
		//  1. The draws are the game's inclusive bounded draw over
		//     (0, half), which is a bounded draw of (half - 0 + 1) plus 0 -- INCLUSIVE
		//     of half. The old port used NextIntBound(half) = [0, half),
		//     one short at the top end.
		//  2. half2 is computed from the RAW (max - min), not from the
		//     negative-corrected range: it is the plain difference minus
		//     half1, and only half1 uses the corrected range.
		diff := max - min
		corrected := diff
		if max < min {
			corrected++
		}
		half1 := arithShiftRight1(corrected)
		half2 := diff - half1
		// *** RNG CALL x2 *** nextIntInclusive(0, half) each.
		d1 := nextIntInclusive(rnd, 0, half1)
		d2 := nextIntInclusive(rnd, 0, half2)
		return min + d1 + d2
	}
	return min
}

// arithShiftRight1 mirrors the game's arithmetic shift (floors toward
// -Infinity), distinct from Go's truncating integer division for negative
// values.
func arithShiftRight1(x int) int {
	return x >> 1
}

// nextIntInclusive is the game's inclusive bounded draw, which is the
// draw the triangle distribution uses for both of its draws:
//
//	when max >= min: a bounded draw of (max - min + 1), plus min
//	otherwise: min, with no draw at all
func nextIntInclusive(rnd random.IRandom, min, max int) int {
	if max < min {
		return min
	}
	return rnd.NextIntBound(max-min+1) + min
}

// gridIndexNext is the grid index the game carries into the next axis:
// `(unsigned)(index*stepSize + gridOffset) / (unsigned)modulus`, with no min
// term. The unsigned arithmetic is load-bearing, not incidental -- the game
// carries the index as a 32-bit UNSIGNED integer, so a negative grid_offset
// wraps rather than producing a negative quotient.
// A modulus of 0 would be undefined in the game; returning 0 keeps this port crash-free. The test has
// to be 32 bits WIDE, and that is not fussiness: every other quantity in this function is already
// narrowed to 32 bits (the game's own uint32 arithmetic, per the paragraph above), so the
// divisor below is uint32(int32(modulus)) -- and uint32(int32(x)) is 0 for every nonzero multiple
// of 2^32, not just for 0. A 64-bit `modulus == 0` test therefore lets `4294967296` through to a
// divide by zero, which panics and takes the process down; `"x": {"distribution": "fixed_grid",
// "extent": [0, 4294967295]}` reaches it (modulus = max-min+1 = 2^32), as does any `extent` whose
// end is far enough outside int64 for `int(f)` to land on math.MinInt64. Same widening mistake,
// same fix, as random.Rand.NextIntBound -- see that method for the full argument.
//
// Inert for every extent that works today: the divisor and the result are unchanged for every
// modulus whose low 32 bits are nonzero, which is every modulus that divided at all before.
func gridIndexNext(index, stepSize, gridOffset, modulus int) int {
	if int32(modulus) == 0 {
		return 0
	}
	numerator := uint32(int32(index))*uint32(int32(stepSize)) + uint32(int32(gridOffset))
	return int(int32(numerator / uint32(int32(modulus))))
}

// mod mirrors JS's `%` (result takes the sign of the dividend, i.e. Go's
// native `%` for `int` — both truncate toward 0), named for clarity.
func mod(a, b int) int {
	if b == 0 {
		return 0
	}
	return a % b
}

// EvalAxis mirrors the Molang-resolving form of the game's per-axis
// evaluation: resolves possibly-Molang min/max, then defers to
// EvalCoordinateRange.
func EvalAxis(rng CoordinateRange, grid *GridState, rnd random.IRandom, molangCtx *molang.Context) int {
	min := int(roundf(rng.Min.Evaluate(molangCtx)))
	max := 0
	if rng.Kind != DistNone {
		max = int(roundf(rng.Max.Evaluate(molangCtx)))
	}
	return EvalCoordinateRange(rng, min, max, grid, rnd)
}

// ---------------------------------------------------------------------------
// Full distribution block
// ---------------------------------------------------------------------------

// ScatterDistribution is a parsed `distribution` block. Tagged lowerCamelCase --
// reachable from the wire via FeatureRule.Distribution (see featurelab-go/wire's package doc
// comment, "Opaque Molang values", for what Iterations and each axis's Min/Max serialize as).
// AxisX/Y/Z are tagged "x"/"y"/"z" to match the source JSON's own distribution.x/y/z keys,
// not the Go field names.
type ScatterDistribution struct {
	AxisX      CoordinateRange `json:"x"`
	AxisY      CoordinateRange `json:"y"`
	AxisZ      CoordinateRange `json:"z"`
	EvalOrder  [3]Axis         `json:"evalOrder"`
	Iterations *MolangExpr     `json:"iterations"`
	Chance     ChanceSpec      `json:"chance"`
}

func (d *ScatterDistribution) axis(a Axis) CoordinateRange {
	switch a {
	case AxisX:
		return d.AxisX
	case AxisY:
		return d.AxisY
	default:
		return d.AxisZ
	}
}

// ParseScatterDistribution parses a `distribution` object.
func ParseScatterDistribution(dist map[string]any, jsonPath string, warn func(string)) (ScatterDistribution, error) {
	iterRaw, ok := dist["iterations"]
	if !ok {
		return ScatterDistribution{}, fmt.Errorf("%s.iterations must be a number or Molang string", jsonPath)
	}
	iterations, err := ParseMolangValue(iterRaw)
	if err != nil {
		return ScatterDistribution{}, fmt.Errorf("%s.iterations: %w", jsonPath, err)
	}
	// The same validation step that checks scatter_chance checks iterations, and it rewrites a
	// negative CONSTANT to 1 rather than refusing the file: it content-logs "Bad value for
	// iterations - should be >= 0" and then uses 1. A non-constant expression is left alone, so a Molang string that goes negative at run time still rounds
	// to zero iterations at scatter time.
	if iterations.IsConstant() && iterations.constant < 0 {
		if warn != nil {
			warn(fmt.Sprintf("%s.iterations is %v -- the game reports a negative iteration count as a "+
				"content error and then uses 1, so this tool does the same",
				jsonPath, iterations.constant))
		}
		iterations = constMolang(1)
	}
	ax, err := ParseCoordinateRange(dist["x"], jsonPath+".x")
	if err != nil {
		return ScatterDistribution{}, err
	}
	ay, err := ParseCoordinateRange(dist["y"], jsonPath+".y")
	if err != nil {
		return ScatterDistribution{}, err
	}
	az, err := ParseCoordinateRange(dist["z"], jsonPath+".z")
	if err != nil {
		return ScatterDistribution{}, err
	}
	evalOrder, err := ParseEvalOrder(dist["coordinate_eval_order"])
	if err != nil {
		return ScatterDistribution{}, err
	}
	chance, err := ParseScatterChance(dist["scatter_chance"], warn)
	if err != nil {
		return ScatterDistribution{}, err
	}
	return ScatterDistribution{AxisX: ax, AxisY: ay, AxisZ: az, EvalOrder: evalOrder, Iterations: iterations, Chance: chance}, nil
}

// AxisOffset is a sampled x/y/z delta.
type AxisOffset struct{ X, Y, Z int }

// worldVarNames maps an Axis to the Molang variable the game writes that
// axis's absolute coordinate into after evaluating it (variable.worldx /
// worldy / worldz).
var worldVarNames = [3]string{"worldx", "worldy", "worldz"}

// WorldVarName exposes worldVarNames to other packages that run a
// distribution (rules, whose feature_rules share their scatter parameters
// with scatter_feature in the game).
func WorldVarName(a Axis) string { return worldVarNames[a] }

// ScatterOutcome says WHY a distribution produced the iteration count it did. Zero iterations
// has two completely different causes and a user can only act on one of them: a chance gate
// that did not roll this time (try another seed) versus an iterations expression that
// evaluates to zero (fix the JSON). Reporting both as an empty result cost a real user real
// time -- a rule with `scatter_chance: 1.5` (which is 1.5 PERCENT, not 150%) placed nothing
// and said only "placement returned no result", with nothing to distinguish "unlucky" from
// "broken".
type ScatterOutcome int

const (
	// ScatterRan means the chance gate passed; Iterations is whatever the expression gave.
	ScatterRan ScatterOutcome = iota
	// ScatterChanceRejected means the gate rolled against scatter_chance and lost. Nothing was
	// evaluated after it -- this is luck, not configuration, and a different seed may pass.
	ScatterChanceRejected
	// ScatterZeroIterations means the gate passed but the iterations expression rounded to <= 0.
	// A different seed will not help unless the expression itself is random.
	ScatterZeroIterations
)

// ScatterRun is one distribution run's inputs. origin and OnAxis exist
// because the game's per-axis evaluation is not pure: after each of the
// three axes it writes the axis's ABSOLUTE coordinate (the sampled offset
// plus the origin's own component) back into the Molang variables as
// variable.worldx/worldy/worldz, so a later axis's expression -- and every
// feature delegated to afterwards -- reads the coordinate this iteration just
// produced.
type ScatterRun struct {
	Dist   ScatterDistribution
	Molang *molang.Context
	Random random.IRandom
	// Origin is the scatter origin's x/y/z, indexed by Axis. Axis results are
	// absolute coordinates relative to it (the game adds the origin
	// component while computing the per-iteration position, before
	// writing the Molang variable).
	Origin [3]int
	// OnAxis, if non-nil, is called after each axis is evaluated, with that
	// axis's ABSOLUTE coordinate -- the caller writes variable.world{x,y,z}.
	OnAxis func(a Axis, absolute int)
	// OnIteration is called once per surviving iteration with the sampled
	// OFFSET from the origin, and the game's own iteration index.
	OnIteration func(offset AxisOffset, index int)
}

// RunScatterDistribution runs the chance gate followed by the
// per-iteration axis walk, calling run.OnIteration once per surviving
// iteration in RNG order. Returns the iteration count actually run.
func RunScatterDistribution(run ScatterRun) (int, ScatterOutcome) {
	iterations := 0
	outcome := ScatterRan
	if pass, pct := scatterGate(run.Dist.Chance, run.Molang, run.Random); pass {
		raw := run.Dist.Iterations.Evaluate(run.Molang)
		rounded := int(roundf(raw))
		if rounded > 0 {
			iterations = rounded
		} else {
			outcome = ScatterZeroIterations
			if profiler.ProfilingActive && !profiler.StopCounted(profiler.StopIterationsZero, profiler.NoOrdinal) {
				profiler.RecordStop(profiler.StopIterationsZero, describeIterations(rounded, raw), profiler.NoOrdinal)
			}
		}
	} else {
		outcome = ScatterChanceRejected
		if profiler.ProfilingActive {
			recordChanceStop(run.Dist.Chance, pct)
		}
	}
	for i := 0; i < iterations; i++ {
		// The game's iteration index counts DOWN: the scatter position
		// generator decrements its remaining-iteration counter and passes
		// the POST-decrement value, so successive calls see
		// iterations-1 ... 0.
		// For every non-grid distribution the index is unused and this is
		// invisible; for fixed_grid/jittered_grid it selects the cell, so an
		// ascending index (what this port used to do) walked the same set of
		// positions in reverse order -- which changes which placement wins an
		// overlapping cell and which position the scatter finally returns.
		index := iterations - 1 - i
		grid := &GridState{Value: index}
		offset := AxisOffset{}
		for _, axis := range run.Dist.EvalOrder {
			v := EvalAxis(run.Dist.axis(axis), grid, run.Random, run.Molang)
			switch axis {
			case AxisX:
				offset.X = v
			case AxisY:
				offset.Y = v
			case AxisZ:
				offset.Z = v
			}
			if run.OnAxis != nil {
				run.OnAxis(axis, run.Origin[axis]+v)
			}
		}
		run.OnIteration(offset, index)
	}
	return iterations, outcome
}
