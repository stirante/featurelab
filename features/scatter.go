// scatter.go implements minecraft:scatter_feature, the single highest-priority
// feature type in this port. The RNG-order contract for the scatter loop lives
// in distribution.go, which this file calls into unchanged.
//
// Vanilla behaviour of the chance gate: a proper fraction takes one bounded
// integer draw with the denominator as its bound and accepts iff the draw is
// below the numerator; numerator == denominator accepts with no draw; the
// percent form takes no draw at >= 100 or <= 0, and otherwise one float draw,
// accepting iff draw * 100 < pct. `iterations` is evaluated, rounded, then
// checked > 0.
//
// The placement order is: resolve the target / permission gate /
// project-to-floor scan / scatter loop / next-position loop / "No features
// could be placed" tail. See the per-claim comments below, and
// distribution.go's header for the per-axis evaluation.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const scatterTypeID = "minecraft:scatter_feature"

// ScatterFeature is minecraft:scatter_feature.
type ScatterFeature struct {
	identifier          string
	placesFeatureRef    string
	distribution        ScatterDistribution
	projectInputToFloor bool
	resolver            wgen.IFeatureResolver
}

func (f *ScatterFeature) TypeID() string     { return scatterTypeID }
func (f *ScatterFeature) Identifier() string { return f.identifier }

// PlacesFeatureRef is the "namespace:id" this scatter delegates to —
// exposed so a test harness can statically walk a delegation chain without
// needing to place anything.
func (f *ScatterFeature) PlacesFeatureRef() string { return f.placesFeatureRef }

// Place mirrors the game's scatter placement exactly, step for step in the
// game's own order.
func (f *ScatterFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, scatterTypeID)
	defer profiler.PopFeatureFrame()

	target := f.resolver.Resolve(f.placesFeatureRef)
	if target == nil {
		LogFailure(ctx, scatterTypeID, "No features could be placed")
		if profiler.ProfilingActive && !profiler.StopCounted(profiler.StopUnresolvedReference, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopUnresolvedReference, f.placesFeatureRef+" not found", profiler.NoOrdinal)
		}
		return nil
	}
	// Keyed on `f` (this), not `target`: see shared.go's IsAllowedToPlaceFeature.
	if !IsAllowedToPlaceFeature(f) {
		LogFailure(ctx, scatterTypeID, "Cannot place internal feature")
		if profiler.ProfilingActive {
			profiler.RecordStop(profiler.StopRecursionGuard, "already placing", profiler.NoOrdinal)
		}
		return nil
	}

	origin := ctx.Origin
	if f.projectInputToFloor {
		// Descend one block at a time while the block one below the
		// current Y is air, down to api.MinY(). Pure GetBlock scan --
		// *** NO RNG ***.
		y := origin.Y
		for y > ctx.API.MinY() {
			below := ctx.API.GetBlock(wgen.BlockPos{X: origin.X, Y: y - 1, Z: origin.Z})
			if !ctx.API.Palette().IsAir(below) {
				break
			}
			y--
		}
		origin = wgen.BlockPos{X: origin.X, Y: y, Z: origin.Z}
	}

	// childScope() is an identity function (see the MolangScope doc
	// comment) -- every composite feature shares the identical scope by
	// reference, unconditionally. MolangContext() creates ctx.MolangScope if
	// nil (same as the old inline prologue here) and returns the chain's
	// cached bridge context instead of rebuilding it per Place -- see
	// wgen.PlacementContext.Molang's doc comment. *** NO RNG *** either way.
	molangCtx := ctx.MolangContext()
	scope := ctx.MolangScope
	// The scatter feature's Molang parameter setup -- exactly three Molang
	// variable writes, origin-only -- *** NO RNG ***. It writes
	// variable.originx/originy/originz from the scatter origin,
	// and NOTHING else: variable.worldx/worldy/worldz are written per axis,
	// per iteration, inside the per-iteration position (see the OnAxis hook below). This port
	// used to do the opposite -- seed world* from the origin here and never
	// set origin* at all -- so `iterations`/`scatter_chance` expressions saw a
	// world* that the engine leaves holding whatever the enclosing
	// distribution last wrote, and any expression reading v.originx read 0.
	scope.Variable["originx"] = float64(origin.X)
	scope.Variable["originy"] = float64(origin.Y)
	scope.Variable["originz"] = float64(origin.Z)

	// One sub-context and one delegation closure for the whole loop, with
	// only Origin rewritten per iteration -- behaviorally identical to the
	// old per-iteration ctx.WithOrigin copy (nothing below retains the
	// context or mutates any other field of it: the recursion guard means
	// this exact ScatterFeature instance is never re-entered while its own
	// loop is running, and Place implementations only read their ctx
	// synchronously), but a scatter that runs hundreds of thousands of
	// iterations no longer allocates a context copy plus a fresh closure
	// per iteration.
	subCtx := ctx.WithOrigin(origin)
	subCtx.MolangScope = scope
	place := func() *wgen.BlockPos { return target.Place(subCtx) }

	var lastResult *wgen.BlockPos
	_, outcome := RunScatterDistribution(ScatterRun{
		Dist:   f.distribution,
		Molang: molangCtx,
		Random: ctx.Random,
		Origin: [3]int{origin.X, origin.Y, origin.Z},
		OnAxis: func(a Axis, absolute int) {
			// the game writes the axis's absolute coordinate into
			// variable.world{x,y,z} right after evaluating it, so the next
			// axis's expression (and every delegate placed afterwards) reads
			// this iteration's own coordinate.
			scope.Variable[worldVarNames[a]] = float64(absolute)
		},
		OnIteration: func(offset AxisOffset, _ int) {
			subCtx.Origin = wgen.BlockPos{X: origin.X + offset.X, Y: origin.Y + offset.Y, Z: origin.Z + offset.Z}
			result := WithRecursionGuard(f, place)
			// Overwrites, does not stop early -- every iteration always runs to
			// completion, matching the game's scatter loop.
			if result != nil {
				lastResult = result
			}
		},
	})

	// Say WHY nothing happened. "Placed nothing" has two causes a user acts on differently,
	// and reporting neither is what made a real rule with `scatter_chance: 1.5` (1.5 PERCENT,
	// not 150%) look broken rather than unlucky.
	// The game logs "No features could be placed" whenever no iteration
	// produced a result -- it is the placement's final test, and it uses
	// the same message as the unresolved-target path. Our two
	// warnings below are strictly more informative for the chance-rejected and
	// zero-iterations cases, so the game's generic line is emitted only for
	// the remaining case: the distribution ran and every delegate declined.
	if outcome == ScatterRan && lastResult == nil {
		LogFailure(ctx, scatterTypeID, "No features could be placed")
	}

	switch outcome {
	case ScatterChanceRejected:
		LogWarning(ctx, scatterTypeID,
			"scatter_chance did not roll this time, so nothing was placed -- this is luck, not "+
				"configuration. A different seed may place. Note a bare number is a PERCENT: "+
				"scatter_chance 1.5 means 1.5%, not 150%.", &origin)
	case ScatterZeroIterations:
		LogWarning(ctx, scatterTypeID,
			"iterations evaluated to zero, so nothing was placed. Unlike a chance rejection this "+
				"is not luck -- a different seed will not help unless the expression is itself random.",
			&origin)
	}

	return lastResult
}

// scatterNestedDistributionVersion is the minimum format version for feature schema version 3,
// i.e. 1.21.10 -- the
// version at which scatter_feature's parameters moved from flat keys on the feature body into
// a nested `distribution` object.
//
// The game's scatter schema branches on this threshold:
//
//   - below it: the legacy flat shape, whose complete key list is `iterations` (REQUIRED, a
//     Molang expression), `scatter_chance` (optional; accepts both the 1.21.10 scatter-chance
//     object form and a Molang expression), `coordinate_eval_order`, and `x`/`y`/`z` (each
//     accepting both a Molang expression and the 1.21.10 coordinate-range object). So the
//     legacy shape accepts exactly the same VALUE forms per key as the modern nested one; only
//     their position in the document differs.
//   - at or above it: one required nested "distribution" object.
//
// `places_feature` and `project_input_to_floor` sit outside the gate and mean the same thing
// on both sides.
var scatterNestedDistributionVersion = MustFormatVersion("1.21.10")

// plural picks between two verb forms so a diagnostic reads as English for one key and for
// several -- "x was found" against "x, y were found". Trivial, and worth it: these messages are
// the whole product surface a pack author sees when something is wrong with their file.
func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// legacyScatterParamKeys are the flat keys of the game's legacy scatter-parameter schema, in
// the game's declaration order. Used to lift a legacy body into the nested shape the rest of this
// port speaks, and to tell an author which keys were understood.
var legacyScatterParamKeys = []string{"iterations", "scatter_chance", "coordinate_eval_order", "x", "y", "z"}

func buildScatterFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	placesFeature, ok := body["places_feature"].(string)
	if !ok || placesFeature == "" {
		return nil, fmt.Errorf("places_feature must be a non-empty feature reference string")
	}

	// Which of the two shapes this file is allowed to use is decided by its own declared
	// format_version, not by which keys it happens to carry. A file that declares an old
	// version and writes `distribution` anyway is writing a key its schema does not have --
	// the engine drops it with a member-not-in-schema diagnostic and then fails the REQUIRED
	// legacy `iterations`, so the file does not load. Saying that plainly is the entire point
	// of modelling the gate; silently accepting it would send the author away believing a
	// bench run proved something about their pack that it did not.
	//
	// An ABSENT format_version is the one case where neither side is the engine's answer (it
	// requires the key and would refuse the file; registry.go has already said so). Rather
	// than pick a shape and delete the author's feature over a diagnostic they have already
	// been given, both shapes are accepted here, preferring `distribution` when present.
	distRaw, hasNested := body["distribution"].(map[string]any)
	useNested := ctx.FormatVersion.AtLeastOrUnversioned(scatterNestedDistributionVersion)
	if !ctx.FormatVersion.Present && !hasNested {
		// Unversioned and written in the flat shape: read it that way rather than demanding a
		// key the author had no schema telling them to write.
		useNested = false
	}

	jsonPath := "distribution"
	if !useNested {
		// Lift the flat keys into the nested shape. Nothing about the values changes -- the
		// legacy schema accepts the same value types per key (see above) -- so the same
		// parser reads both, and every diagnostic it emits is re-pathed to the flat spelling.
		// The legacy keys sit on the feature body itself, so that is the path diagnostics quote.
		jsonPath = scatterTypeID
		if _, present := body["distribution"]; present {
			ctx.Warn(fmt.Sprintf("%s: \"distribution\" was found in the input, but is not present in the "+
				"schema for format_version %s — scatter_feature only gained the nested distribution object "+
				"at format_version %s; below that the game reads flat %v keys on the feature body and drops "+
				"\"distribution\" unread",
				ctx.Identifier, ctx.FormatVersion, scatterNestedDistributionVersion, legacyScatterParamKeys))
		}
		lifted := make(map[string]any, len(legacyScatterParamKeys))
		for _, k := range legacyScatterParamKeys {
			if v, present := body[k]; present {
				lifted[k] = v
			}
		}
		distRaw = lifted
	} else {
		// The modern side of the same gate. A file at or above the split writes `distribution`;
		// the flat keys are not in its schema, so the game reads them as unrecognized members
		// and drops them. Saying so matters more here than on the legacy side, because the
		// failure is otherwise mute: a file that carries ONLY the flat keys gets "distribution
		// must be an object" and no hint that the six keys it did write were seen and ignored.
		var stray []string
		for _, k := range legacyScatterParamKeys {
			if _, present := body[k]; present {
				stray = append(stray, k)
			}
		}
		if len(stray) > 0 {
			ctx.Warn(fmt.Sprintf("%s: %v %s found in the input, but the flat scatter keys are not present "+
				"in the schema for format_version %s — scatter_feature moved them inside the nested "+
				"\"distribution\" object at format_version %s; the game drops them unread, and so does this "+
				"tool",
				ctx.Identifier, stray, plural(len(stray), "was", "were"), ctx.FormatVersion,
				scatterNestedDistributionVersion))
		}
		if !hasNested {
			return nil, fmt.Errorf("distribution must be an object")
		}
	}
	distribution, err := ParseScatterDistribution(distRaw, jsonPath, ctx.Warn)
	if err != nil {
		return nil, err
	}
	projectInputToFloor := jsonTruthy(body["project_input_to_floor"])

	return &ScatterFeature{
		identifier:          ctx.Identifier,
		placesFeatureRef:    placesFeature,
		distribution:        distribution,
		projectInputToFloor: projectInputToFloor,
		resolver:            ctx.Resolver,
	}, nil
}

func init() {
	RegisterType(scatterTypeID, buildScatterFeature)
}

var _ wgen.IFeature = (*ScatterFeature)(nil)
