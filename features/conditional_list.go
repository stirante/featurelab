// conditional_list.go is minecraft:conditional_list. Registered id:
// minecraft:conditional_list ONLY. The game does not accept a
// "minecraft:conditional_list_feature" spelling -- prefixed or bare -- so no
// alias is registered. (The game's placement-failure log DOES stamp its
// messages "minecraft:conditional_list_feature", but that is not a type id.)
//
// TARGET: game version 1.26.50. That version is the one that made the type
// public -- Mojang's changelog documents it as an added feature -- and it
// changed the type in three load-bearing ways versus 1.26.40:
//
//  1. early_out_scheme gained a third value "none" (=2) and THE DEFAULT
//     CHANGED from condition_success (0) to none (2). Under none the walk
//     never stops early: every entry whose condition is true places, and the
//     feature's own result is the LAST successful placement (engaged iff at
//     least one entry placed).
//  2. [].condition became OPTIONAL. Every parsed entry's condition starts as
//     a constant-true Molang expression (the literal 1.0), so an absent
//     condition means "always place". (In 1.26.40 the field was required.)
//  3. Placement now also publishes
//     variable.originx/originy/originz (same
//     values as worldx/worldy/worldz -- all six read the origin ints) and an
//     unresolved places_feature reference now ABORTS the whole list instead
//     of skipping the entry (see Place below).
//
// JSON surface, with each key's required flag:
//
//	conditional_features  an array, REQUIRED
//	  [].places_feature   a feature reference, REQUIRED
//	  [].condition        a Molang expression, OPTIONAL, in the "world_gen"
//	                      Molang namespace; absent -> constant 1.0 (always
//	                      true)
//	early_out_scheme      an enum, OPTIONAL, with valid values
//	                      condition_success=0, placement_success=1 and
//	                      none=2, in that order. Default 2 = none.
//	                      (1.26.40 defaulted to 0.)
//
// In 1.26.40 the walk terminated at the first true condition by default;
// that behaviour is now the non-default "condition_success" scheme.
//
// This is one of the feature types that evaluates Molang.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const conditionalListTypeID = "minecraft:conditional_list"

// earlyOutScheme is the conditional-list feature's early-out enum -- the
// values are the game's own enum ints.
type earlyOutScheme int

const (
	earlyOutConditionSuccess earlyOutScheme = 0
	earlyOutPlacementSuccess earlyOutScheme = 1
	// earlyOutSchemeNone is this type's own "none" -- NOT aggregate.go's
	// earlyOutNone. The engine has two unrelated enums that share the word:
	// the aggregate feature's early_out (none/first_success/first_failure) and
	// the conditional-list feature's early-out enum
	// (condition_success/placement_success/none). Different strings,
	// different ints, different fields; only the word overlaps.
	earlyOutSchemeNone earlyOutScheme = 2 // default
)

type conditionalListEntry struct {
	ref       string
	condition *MolangExpr
}

func parseConditionalFeatures(raw any) ([]conditionalListEntry, error) {
	arr, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("conditional_features must be an array")
	}
	out := make([]conditionalListEntry, len(arr))
	for i, v := range arr {
		p := fmt.Sprintf("conditional_features[%d]", i)
		e, ok := v.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s must be an object", p)
		}
		ref, ok := e["places_feature"].(string)
		if !ok || ref == "" {
			return nil, fmt.Errorf("%s.places_feature must be a feature reference string", p)
		}
		// condition is OPTIONAL as of game version 1.26.50. Every entry
		// defaults to the literal 1.0, so an absent condition is a constant true.
		condRaw, present := e["condition"]
		if !present {
			condRaw = float64(1)
		}
		switch condRaw.(type) {
		case string, float64, bool:
		default:
			return nil, fmt.Errorf("%s.condition must be a number, boolean, or Molang string", p)
		}
		cond, err := ParseMolangValue(condRaw)
		if err != nil {
			return nil, fmt.Errorf("%s.condition: %w", p, err)
		}
		out[i] = conditionalListEntry{ref: ref, condition: cond}
	}
	return out, nil
}

func parseEarlyOutScheme(value any) (earlyOutScheme, error) {
	if value == nil {
		return earlyOutSchemeNone, nil
	}
	if s, ok := value.(string); ok {
		switch s {
		case "condition_success":
			return earlyOutConditionSuccess, nil
		case "placement_success":
			return earlyOutPlacementSuccess, nil
		case "none":
			return earlyOutSchemeNone, nil
		}
	}
	return 0, fmt.Errorf(`early_out_scheme must be "condition_success", "placement_success", or "none" (got %#v)`, value)
}

// ConditionalListFeature is minecraft:conditional_list.
type ConditionalListFeature struct {
	identifier string
	entries    []conditionalListEntry
	earlyOut   earlyOutScheme
	resolver   wgen.IFeatureResolver
}

func (f *ConditionalListFeature) TypeID() string     { return conditionalListTypeID }
func (f *ConditionalListFeature) Identifier() string { return f.identifier }

// FeatureRefs returns every entry's feature reference -- exposed for the
// static delegation-chain walk. Under the default "none" scheme EVERY entry
// whose condition is true places, and under the other two schemes any entry
// CAN be the one that runs, so the whole list is always in scope.
func (f *ConditionalListFeature) FeatureRefs() []string {
	out := make([]string, len(f.entries))
	for i, e := range f.entries {
		out[i] = e.ref
	}
	return out
}

// Place mirrors the conditional-list feature's placement, as of game
// version 1.26.50. What happens after each entry, per scheme:
//
//	scheme 0 (condition_success): the first entry whose condition evaluates
//	  non-zero ends the list -- the child's result is returned verbatim,
//	  present or not.
//	scheme 1 (placement_success): a failed placement continues to the next
//	  entry; the first present result returns, and an absent one falls
//	  through to the loop.
//	scheme 2 (none, THE DEFAULT): never stops early. Each present result
//	  overwrites the recorded one and the walk
//	  continues; at the end the feature returns the LAST successful
//	  placement's position, present iff at least one entry placed
//	  (the accumulator is rebuilt and returned).
//
// Under condition_success/placement_success this type is still a selector --
// at most one entry's placement is returned -- but under the default "none"
// scheme it is an aggregate: every true-condition entry places.
func (f *ConditionalListFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, conditionalListTypeID)
	defer profiler.PopFeatureFrame()

	// Push the placement position into the shared Molang variable scope, so
	// JSON-authored condition expressions can read it. Game version 1.26.50
	// publishes SIX variables -- worldx/worldy/worldz AND, new in that
	// version, originx/originy/originz -- and all six are widened from the
	// SAME three origin integers, so worldx == originx and so on.
	// ctx.MolangScope is a single shared object
	// every derived context forwards unchanged -- mutating it here is visible
	// to every feature placed from this point forward in the chain.
	// *** NO RNG *** either way.
	molangCtx := ctx.MolangContext()
	scope := ctx.MolangScope
	scope.Variable["worldx"] = float64(ctx.Origin.X)
	scope.Variable["worldy"] = float64(ctx.Origin.Y)
	scope.Variable["worldz"] = float64(ctx.Origin.Z)
	scope.Variable["originx"] = float64(ctx.Origin.X)
	scope.Variable["originy"] = float64(ctx.Origin.Y)
	scope.Variable["originz"] = float64(ctx.Origin.Z)

	// lastSuccess is the "none" scheme's accumulator. Both abort paths below
	// return it too -- in the game an abort returns the accumulator, NOT a
	// cleared result, so successes recorded before the abort survive it (a
	// change from 1.26.40, where a denial cleared the result).
	var lastSuccess *wgen.BlockPos

	for i, entry := range f.entries {
		target := f.resolver.Resolve(entry.ref)
		if target == nil {
			// As of 1.26.50 an unresolved reference content-logs "Feature
			// not found!" and ends the WHOLE list. 1.26.40 skipped just the
			// entry -- that behaviour is gone.
			LogFailure(ctx, conditionalListTypeID, "Feature not found!")
			if profiler.StopsActive && !profiler.StopCounted(profiler.StopUnresolvedReference, i) {
				profiler.RecordStop(profiler.StopUnresolvedReference, fmt.Sprintf("%s not found; list ended%s", entry.ref, SuggestFeatureRef(f.resolver, entry.ref)), i)
			}
			return lastSuccess
		}

		// Internal-feature/recursion-guard denial also ends the whole list
		// (logs "Cannot place an internal feature!" and returns the same
		// accumulator). Guard keyed on `f`, not the callee -- see shared.go.
		if !IsAllowedToPlaceFeature(f) {
			LogFailure(ctx, conditionalListTypeID, "Cannot place an internal feature!")
			if profiler.StopsActive {
				profiler.RecordStop(profiler.StopRecursionGuard, "already placing; list ended", i)
			}
			return lastSuccess
		}

		// Condition evaluation: ParseMolangValue already treats a raw
		// number/boolean as a constant expression with no RNG/query touch
		// (the game short-circuits the same way: a constant condition is
		// used directly instead of running the expression evaluator).
		if entry.condition.Evaluate(molangCtx) == 0 {
			if profiler.StopsActive && !profiler.StopCounted(profiler.StopConditionFalse, i) {
				profiler.RecordStop(profiler.StopConditionFalse, fmt.Sprintf("condition = 0, %s skipped", entry.ref), i)
			}
			continue // an exact compare against zero, then the loop continues
		}

		result := WithRecursionGuard(f, func() *wgen.BlockPos { return target.Place(ctx) })
		switch f.earlyOut {
		case earlyOutConditionSuccess:
			// First true condition ends the list, success or not -- the
			// child's result is returned as-is.
			return result
		case earlyOutPlacementSuccess:
			if result != nil {
				return result // first engaged result returns
			}
			// failed placement: keep walking
		default: // earlyOutSchemeNone
			if result != nil {
				lastSuccess = result // overwrite -- LAST success wins
			}
			// engaged or not: keep walking
		}
	}
	return lastSuccess
}

func buildConditionalListFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	listRaw, present := body["conditional_features"]
	if !present {
		// Migration hint: an earlier revision of this tool accepted invented
		// key names; real packs authored against the actual engine schema
		// never used them, but fixtures written against this tool might have.
		if _, had := body["conditional_list"]; had {
			return nil, fmt.Errorf(`conditional_features is required ("conditional_list" is not a real key of this type -- it was this tool's own earlier guess; rename it to "conditional_features" and each entry's "feature"/"place_condition" to "places_feature"/"condition")`)
		}
		return nil, fmt.Errorf("conditional_features is required")
	}
	entries, err := parseConditionalFeatures(listRaw)
	if err != nil {
		return nil, err
	}
	eo, err := parseEarlyOutScheme(body["early_out_scheme"])
	if err != nil {
		return nil, err
	}
	return &ConditionalListFeature{
		identifier: ctx.Identifier,
		entries:    entries,
		earlyOut:   eo,
		resolver:   ctx.Resolver,
	}, nil
}

func init() {
	RegisterType(conditionalListTypeID, buildConditionalListFeature)
}

var _ wgen.IFeature = (*ConditionalListFeature)(nil)
