// aggregate.go implements minecraft:aggregate_feature and
// minecraft:sequence_feature — both JSON ids map to ONE engine type,
// parameterised by a composite kind and instantiated twice: the aggregate
// kind for "aggregate_feature" and the sequence kind for "sequence_feature".
//
// The two variants share every part of the algorithm below except two
// things: how the context is built for each sub-feature call (step 2c,
// inside the loop) — aggregate_feature always re-targets every sub-feature
// at the original, unmodified origin; sequence_feature threads the
// *previous* sub-feature's own successful result forward as the next
// sub-feature's origin, falling back to the original origin until the
// first success — and where early_out comes from: aggregate_feature reads
// an optional "early_out" JSON key (default none); sequence_feature has NO
// such key in its schema and always uses first_failure (unchanged in the
// later game version). No RNG call happens
// directly in either variant — all randomness is delegated to whichever
// sub-features get placed.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const (
	aggregateTypeID = "minecraft:aggregate_feature"
	sequenceTypeID  = "minecraft:sequence_feature"
)

type earlyOut string

const (
	earlyOutNone         earlyOut = "none"
	earlyOutFirstSuccess earlyOut = "first_success"
	earlyOutFirstFailure earlyOut = "first_failure"
)

func parseEarlyOut(value any) (earlyOut, error) {
	if value == nil {
		return earlyOutNone, nil
	}
	s, ok := value.(string)
	if ok {
		switch earlyOut(s) {
		case earlyOutFirstSuccess, earlyOutFirstFailure, earlyOutNone:
			return earlyOut(s), nil
		}
	}
	return "", fmt.Errorf(`early_out must be "first_success", "first_failure", or "none" (got %#v)`, value)
}

// AggregateFeature is minecraft:aggregate_feature / minecraft:sequence_feature.
type AggregateFeature struct {
	typeID     string
	identifier string
	refs       []string
	earlyOut   earlyOut
	resolver   wgen.IFeatureResolver
	sequence   bool
}

func (f *AggregateFeature) TypeID() string     { return f.typeID }
func (f *AggregateFeature) Identifier() string { return f.identifier }

// FeatureRefs is the "namespace:id" list this aggregate/sequence delegates
// to, in order — exposed so a test harness can statically walk a
// delegation chain without needing to place anything (see goldentest's
// scope determination).
func (f *AggregateFeature) FeatureRefs() []string { return f.refs }

// Place mirrors the game's composite placement exactly, step for step.
func (f *AggregateFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, f.typeID)
	defer profiler.PopFeatureFrame()

	// Step 1: empty sub-feature list -> no value, immediately.
	//
	// UNREACHABLE from JSON. `features` is not merely required, it must hold at least one
	// element: the game's schema for both the aggregate and the sequence kind sets a minimum
	// array size of 1. An empty array fails validation with the content log "Array too small
	// (0 < 1)", so no loaded feature can reach this line. It is KEPT because it is the game's
	// own first step and this file follows the placement step for step.
	if len(f.refs) == 0 {
		return nil
	}

	// The whole running state is ONE value — the result, present or absent
	// (nil here is the engine's absent). It is simultaneously the return
	// value, the "has anything succeeded yet" flag the first_failure tail
	// test reads, and (sequence_feature only) the chained origin. The engine
	// has no separate success boolean or chain origin.
	var result *wgen.BlockPos

	for i, ref := range f.refs {
		target := f.resolver.Resolve(ref)
		if target == nil && profiler.StopsActive {
			profiler.RecordStop(profiler.StopUnresolvedReference, ref+" not found"+SuggestFeatureRef(f.resolver, ref), i)
		}

		if target != nil {
			// Recursion guard — keyed on `f` (this, the AggregateFeature
			// instance doing the delegating), gated by target's own flag —
			// not from target's in-progress state. See shared.go's
			// IsAllowedToPlaceFeature.
			if IsAllowedToPlaceFeature(f) {
				// Molang scope propagation: both variants forward the SAME
				// scope by reference -- for aggregate_feature, target.Place(ctx)
				// reuses ctx verbatim (no new context at all); for
				// sequence_feature, only Origin changes, MolangScope is still
				// the identical pointer (childScope is an identity function --
				// see wgen's NewScope comment).
				subCtx := ctx
				if f.sequence && result != nil {
					subCtx = ctx.WithOrigin(*result)
				}
				if r := WithRecursionGuard(f, func() *wgen.BlockPos { return target.Place(subCtx) }); r != nil {
					result = r
					if f.earlyOut == earlyOutFirstSuccess {
						break // stop-on-success
					}
				}
				// Deliberately no else here: a resolved sub-feature's own
				// placement failure (r == nil) leaves the running optional
				// ALONE — it is sticky (the failure path in
				// 1.26.40.26 touches no state). A child's failure therefore does not
				// shorten a first_failure loop that already had a success;
				// what makes a sequence stop is the tail test below, which
				// only fires while nothing has succeeded yet.
			} else {
				LogFailure(ctx, f.typeID, "Cannot place internal feature")
				if profiler.StopsActive {
					profiler.RecordStop(profiler.StopRecursionGuard, "already placing", i)
				}
				// The denial clears the running result UNCONDITIONALLY --
				// the game zeroes it -- so the stale position is
				// never returned, and the next child is called with the
				// original context again (the chained origin resets with it).
				// The loop-tail test below then breaks under first_failure.
				result = nil
			}
		}

		if f.earlyOut == earlyOutFirstFailure && result == nil {
			if profiler.StopsActive && i < len(f.refs)-1 && !profiler.StopCounted(profiler.StopSequenceFirstFailure, i) {
				profiler.RecordStop(profiler.StopSequenceFirstFailure,
					fmt.Sprintf("%s placed nothing; %d later entries skipped", ref, len(f.refs)-1-i), i)
			}
			break // stop-on-failure ("nothing has succeeded yet")
		}
	}

	return result
}

func buildAggregateFeature(sequence bool) Builder {
	return func(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
		// Refusing an EMPTY array is the engine's behaviour, not a house rule -- checked
		// because this is the same shape as ore_feature's replace_rules, where the port used to
		// report an error the game does not. Here it does: the schema sets a minimum array
		// size of 1 -- for the aggregate kind and the sequence kind alike -- and the schema's
		// array validation fails a shorter array with "Array too small
		// (0 < 1)". ore_feature differs in the OTHER flag: its replace_rules key is
		// optional, so an absent key loads -- but an explicitly empty one is refused there too.
		featuresRaw, ok := body["features"].([]any)
		if !ok || len(featuresRaw) == 0 {
			return nil, fmt.Errorf("features must be a non-empty array of feature references")
		}
		refs := make([]string, len(featuresRaw))
		for i, v := range featuresRaw {
			s, ok := v.(string)
			if !ok || s == "" {
				return nil, fmt.Errorf("features[%d] must be a feature reference string", i)
			}
			refs[i] = s
		}
		// sequence_feature's schema has no "early_out" key at all — the
		// game always uses first_failure and never consults JSON: the
		// sequence kind's schema has only "features", in both game versions.
		// A pack that supplies the key on a sequence is supplying a key the
		// real schema does not have; ignoring it is what the engine does.
		eo := earlyOutFirstFailure
		if !sequence {
			var err error
			eo, err = parseEarlyOut(body["early_out"])
			if err != nil {
				return nil, err
			}
		}
		typeID := aggregateTypeID
		if sequence {
			typeID = sequenceTypeID
		}
		return &AggregateFeature{
			typeID:     typeID,
			identifier: ctx.Identifier,
			refs:       refs,
			earlyOut:   eo,
			resolver:   ctx.Resolver,
			sequence:   sequence,
		}, nil
	}
}

func init() {
	RegisterType(aggregateTypeID, buildAggregateFeature(false))
	RegisterType(sequenceTypeID, buildAggregateFeature(true))
}

var _ wgen.IFeature = (*AggregateFeature)(nil)
