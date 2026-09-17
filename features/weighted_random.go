// weighted_random.go implements minecraft:weighted_random_feature
// (behaviour unchanged across both targeted game versions).
// `features` is an array of [featureReference, weight] 2-tuples
// (the shape vanilla and real packs use); an object-shaped
// {feature|places_feature, weight} entry is tolerated defensively but not
// confirmed to load in the game.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const weightedRandomTypeID = "minecraft:weighted_random_feature"

type weightedRandomEntry struct {
	ref    string
	weight float64
}

func parseWeightedRandomEntries(raw any) ([]weightedRandomEntry, error) {
	// Non-empty is the game's own rule: the schema sets a minimum size of 1 on the `features`
	// array, and the schema's array validation fails a shorter array with "Array too small
	// (0 < 1)". The per-entry tuple is pinned the same way, one level down: the nested array has
	// both a minimum and a maximum size of 2, which is why a tuple of any other length is
	// refused below.
	arr, ok := raw.([]any)
	if !ok || len(arr) == 0 {
		return nil, fmt.Errorf("features must be a non-empty array")
	}
	out := make([]weightedRandomEntry, len(arr))
	for i, v := range arr {
		p := fmt.Sprintf("features[%d]", i)
		switch e := v.(type) {
		case []any:
			if len(e) != 2 {
				return nil, fmt.Errorf("%s must be a [featureReference, weight] tuple", p)
			}
			ref, ok := e[0].(string)
			if !ok {
				return nil, fmt.Errorf("%s must be a [featureReference, weight] tuple", p)
			}
			weight, ok := toFloat(e[1])
			if !ok || weight < 0 {
				return nil, fmt.Errorf("%s[1] (weight) must be a non-negative number", p)
			}
			out[i] = weightedRandomEntry{ref: ref, weight: weight}
		case map[string]any:
			refRaw := FirstOf(e, "feature", "places_feature")
			ref, ok := refRaw.(string)
			if !ok {
				return nil, fmt.Errorf("%s must be a [featureReference, weight] tuple", p)
			}
			weight := 1.0
			if wv, ok := e["weight"]; ok {
				f, ok := toFloat(wv)
				if !ok || f < 0 {
					return nil, fmt.Errorf("%s.weight must be a non-negative number", p)
				}
				weight = f
			}
			out[i] = weightedRandomEntry{ref: ref, weight: weight}
		default:
			return nil, fmt.Errorf("%s must be a [featureReference, weight] tuple", p)
		}
	}
	return out, nil
}

// WeightedRandomFeature is minecraft:weighted_random_feature.
type WeightedRandomFeature struct {
	identifier string
	entries    []weightedRandomEntry
	resolver   wgen.IFeatureResolver
}

func (f *WeightedRandomFeature) TypeID() string     { return weightedRandomTypeID }
func (f *WeightedRandomFeature) Identifier() string { return f.identifier }

// FeatureRefs returns every entry's feature reference -- exposed for the
// static delegation-chain walk (goldentest's scope determination). At
// place-time only ONE entry is ever delegated to (the weighted pick), but
// which one is runtime-random, so the walker requires the WHOLE list to be
// in scope to guarantee comparability regardless of the draw.
func (f *WeightedRandomFeature) FeatureRefs() []string {
	out := make([]string, len(f.entries))
	for i, e := range f.entries {
		out[i] = e.ref
	}
	return out
}

// Place mirrors the weighted-random feature's placement: one weighted-pick draw, then
// delegation to the chosen entry only, with the original context.
func (f *WeightedRandomFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, weightedRandomTypeID)
	defer profiler.PopFeatureFrame()

	weights := make([]float64, len(f.entries))
	for i, e := range f.entries {
		weights[i] = e.weight
	}
	// *** RNG CALL *** -- single weighted-pick draw (shared.WeightedPick),
	// identical shape to SingleBlockFeature's own weighted pick.
	pickIndex := WeightedPick(weights, ctx.Random)
	if pickIndex == -1 {
		LogFailure(ctx, weightedRandomTypeID, "Feature could not be selected")
		if profiler.ProfilingActive {
			profiler.RecordStop(profiler.StopNoSelection, "no entry has a weight above 0", profiler.NoOrdinal)
		}
		return nil
	}

	resolved := f.resolver.Resolve(f.entries[pickIndex].ref)
	if resolved == nil {
		LogFailure(ctx, weightedRandomTypeID, "Feature could not be selected")
		if profiler.ProfilingActive && !profiler.StopCounted(profiler.StopUnresolvedReference, pickIndex) {
			profiler.RecordStop(profiler.StopUnresolvedReference, f.entries[pickIndex].ref+" not found", pickIndex)
		}
		return nil
	}

	if !IsAllowedToPlaceFeature(f) {
		LogFailure(ctx, weightedRandomTypeID, "Cannot place internal feature")
		if profiler.ProfilingActive {
			profiler.RecordStop(profiler.StopRecursionGuard, "already placing", profiler.NoOrdinal)
		}
		return nil
	}

	// Delegate once, with the SAME original context, returning its result
	// verbatim -- including MolangScope unchanged. Recursion guard marks/
	// checks `f` (the wrapper), not `resolved` -- see shared.go.
	return WithRecursionGuard(f, func() *wgen.BlockPos { return resolved.Place(ctx) })
}

func buildWeightedRandomFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	entries, err := parseWeightedRandomEntries(body["features"])
	if err != nil {
		return nil, err
	}
	return &WeightedRandomFeature{identifier: ctx.Identifier, entries: entries, resolver: ctx.Resolver}, nil
}

func init() {
	RegisterType(weightedRandomTypeID, buildWeightedRandomFeature)
}

var _ wgen.IFeature = (*WeightedRandomFeature)(nil)
