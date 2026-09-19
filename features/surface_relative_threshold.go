// surface_relative_threshold.go implements
// minecraft:surface_relative_threshold_feature. Its placement makes no RNG
// calls, in both targeted game versions.
//
// JSON surface, in both versions: exactly two keys, `feature_to_place`
// (REQUIRED) and `minimum_distance_below_surface` (optional). The defensive
// aliases an earlier revision of this port accepted
// (`feature`, `wrapped_feature`, `places_feature`,
// `min_distance_below_surface`) do NOT exist in the game and are no longer
// accepted -- a file using one of them would not load in the game, so this
// port now says so instead of quietly working.
//
// The threshold test is `surfaceLevel - minimum_distance_below_surface <=
// origin.y  ->  FAIL`, i.e. the origin must be strictly more than
// minimum_distance_below_surface below the surface. The game stores that field
// as an int32, so a fractional JSON value truncates.
//
// The surface level itself comes from a "preliminary surface level" provider
// the context exposes, queried at **(x >> 2, z >> 2)** -- a QUARTER-RESOLUTION
// grid, so one surface value covers each 4x4 column block. See the lookup in
// Place for how this port stands in for it.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const surfaceRelativeThresholdTypeID = "minecraft:surface_relative_threshold_feature"

// SurfaceRelativeThresholdFeature is minecraft:surface_relative_threshold_feature.
type SurfaceRelativeThresholdFeature struct {
	identifier              string
	featureRef              string
	minDistanceBelowSurface int
	resolver                wgen.IFeatureResolver
}

func (f *SurfaceRelativeThresholdFeature) TypeID() string     { return surfaceRelativeThresholdTypeID }
func (f *SurfaceRelativeThresholdFeature) Identifier() string { return f.identifier }

// FeatureRefs exposes the single delegated feature reference for the static
// delegation-chain walk.
func (f *SurfaceRelativeThresholdFeature) FeatureRefs() []string { return []string{f.featureRef} }

// Place mirrors the surface-relative-threshold feature's placement.
func (f *SurfaceRelativeThresholdFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, surfaceRelativeThresholdTypeID)
	defer profiler.PopFeatureFrame()

	// The game asks a "preliminary surface level" provider for the height at
	// (x >> 2, z >> 2) -- a quarter-resolution grid built during terrain
	// generation, which this bench has no equivalent of. GetHeight (the
	// volume's own "Y of the first free cell above the column's topmost
	// non-air block") stands in for the value, but it is sampled at the
	// enclosing 4x4 cell's ANCHOR rather than at the origin's own column, so
	// that -- as in the game -- one surface value covers each 4x4 block of
	// columns instead of varying per column. Go's >> on a signed int is
	// arithmetic, matching the game's shift for negative coordinates.
	anchorX := (ctx.Origin.X >> 2) << 2
	anchorZ := (ctx.Origin.Z >> 2) << 2
	surfaceY := ctx.API.GetHeight(anchorX, anchorZ)

	// threshold = surfaceHeight - minDistanceBelowSurface; fail if origin.y
	// is at or above that threshold (must be strictly below
	// surfaceHeight - minDistance). Integer arithmetic, like the game's.
	failsThreshold := surfaceY-f.minDistanceBelowSurface <= ctx.Origin.Y
	if failsThreshold {
		LogFailure(ctx, surfaceRelativeThresholdTypeID, "Target location is not within the minimum distance to surface")
		if profiler.StopsActive && !profiler.StopCounted(profiler.StopSurfaceThresholdRejected, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopSurfaceThresholdRejected,
				fmt.Sprintf("surface %d blocks above, needs more than %d", surfaceY-ctx.Origin.Y, f.minDistanceBelowSurface),
				profiler.NoOrdinal)
		}
		return nil
	}

	sub := f.resolver.Resolve(f.featureRef)
	if sub == nil {
		LogFailure(ctx, surfaceRelativeThresholdTypeID, "Target location is not within the minimum distance to surface")
		if profiler.StopsActive {
			profiler.RecordStop(profiler.StopUnresolvedReference, f.featureRef+" not found"+SuggestFeatureRef(f.resolver, f.featureRef), profiler.NoOrdinal)
		}
		return nil
	}

	// The game logs nothing on this specific gate either (an empty
	// return only). Recursion guard marks/checks `f` (the wrapper), not
	// `sub` -- see shared.go.
	if !IsAllowedToPlaceFeature(f) {
		if profiler.StopsActive {
			profiler.RecordStop(profiler.StopRecursionGuard, "already placing", profiler.NoOrdinal)
		}
		return nil
	}

	// Delegate with the SAME, unmodified context -- no position
	// substitution, MolangScope propagates unchanged.
	return WithRecursionGuard(f, func() *wgen.BlockPos { return sub.Place(ctx) })
}

func buildSurfaceRelativeThresholdFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	// Only the two real schema keys are accepted. If a file uses one of the
	// aliases an earlier revision of this port invented, name the real key
	// rather than silently working -- the game would reject that file.
	for _, alias := range []string{"feature", "wrapped_feature", "places_feature"} {
		if _, present := body[alias]; present {
			return nil, fmt.Errorf("%q is not a field of this feature type; the feature reference key is "+
				"\"feature_to_place\"", alias)
		}
	}
	if _, present := body["min_distance_below_surface"]; present {
		return nil, fmt.Errorf("\"min_distance_below_surface\" is not a field of this feature type; the real " +
			"key is \"minimum_distance_below_surface\"")
	}
	ref, ok := body["feature_to_place"].(string)
	if !ok || ref == "" {
		return nil, fmt.Errorf("feature_to_place must be a non-empty feature reference string")
	}
	// The game stores this as an int32, so a fractional value truncates.
	minDist := 0
	if raw, present := body["minimum_distance_below_surface"]; present {
		v, ok := toFloat(raw)
		if !ok {
			return nil, fmt.Errorf("minimum_distance_below_surface must be a number")
		}
		minDist = int(v)
	}
	return &SurfaceRelativeThresholdFeature{
		identifier:              ctx.Identifier,
		featureRef:              ref,
		minDistanceBelowSurface: minDist,
		resolver:                ctx.Resolver,
	}, nil
}

func init() {
	RegisterType(surfaceRelativeThresholdTypeID, buildSurfaceRelativeThresholdFeature)
}

var _ wgen.IFeature = (*SurfaceRelativeThresholdFeature)(nil)
