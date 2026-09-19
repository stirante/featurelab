// height_difference_filter.go implements minecraft:height_difference_filter_feature,
// a new root type as of game version 1.26.40. Neither its placement nor its
// placement decision makes any RNG calls. Behaviour is unchanged in 1.26.50.
//
// Schema, the exact key names, in declaration order:
//
//	places_feature                       a feature reference, REQUIRED
//	min_required_upward_height_diff      int, optional
//	min_required_downward_height_diff    int, optional
//	max_allowed_upward_height_diff       int, optional
//	max_allowed_downward_height_diff     int, optional
//	search_radius                        int, REQUIRED
//
// The four optional diff fields each carry a runtime "hasValue" flag beside
// their value; the two required keys do not, and the schema's own required
// flags line up with that split exactly.
//
// place, exact control flow:
//
//  1. Resolve places_feature through the game's optional-feature presence test -- an absent
//     feature is not an error in itself. If it does not resolve, content-log the literal string
//     "`height_difference_filter_feature` could not find feature `places_feature`." and fail.
//     That string is exact, byte for byte.
//  2. Else run the placement decision on ctx. If false, fail silently -- the game logs nothing for this
//     branch (same "gate fails quietly" shape as surface_relative_threshold_feature.go).
//  3. Else delegate: call the resolved feature's place() with the SAME, unmodified context (no
//     position substitution) and return its result directly.
//
// This port additionally routes the delegated call through WithRecursionGuard/
// IsAllowedToPlaceFeature, matching every other composite in this codebase -- the game applies
// no explicit guard for this type (unlike conditional_list.go/surface_relative_threshold.go),
// but this is deliberate port-level plumbing for consistent recursion guarding, profiler frames,
// and diagnostics chains across every delegation path this tool has, not a claim about the
// game's behaviour for this one type.
//
// The placement decision, exact algorithm:
//
// If search_radius < 1: result = (min_required_upward_height_diff absent) AND
// (max_allowed_upward_height_diff absent) -- i.e. trivially true unless one of those two fields was
// actually configured, in which case a radius < 1 can never satisfy it.
//
// Otherwise, walk outward from origin along the four HORIZONTAL cardinal directions only (Bedrock's
// facing enum, checked in this exact order: North=2, East=5, South=3, West=4), each for
// i = 1..search_radius steps, sampling h := ctx.API.GetHeight(origin.x + stepX*i,
// origin.z + stepZ*i) at each step (the same height query
// surface_relative_threshold_feature.go's "preliminary surface provider" stands in for). Two
// hard-fail checks run BEFORE the accumulation below, in this order, and either
// one failing returns false immediately (aborting the whole scan, not just this direction):
//
//   - if min_required_downward_height_diff is set AND (that value + origin.y) < h: fail.
//   - if max_allowed_downward_height_diff is set AND (origin.y - that value) > h: fail.
//
// Two OR-accumulated flags, seeded true when their corresponding field is ABSENT (so an unconfigured
// requirement is auto-satisfied and never fails the gate) and OR'd with a per-step test whenever
// still false:
//
//   - upSatisfied      |= (min_required_upward_height_diff-or-0 + origin.y) <= h
//   - upBoundSatisfied |= (origin.y - max_allowed_upward_height_diff-or-0) >= h
//
// After scanning every step of every direction (or failing hard partway through), the final result
// is upSatisfied AND upBoundSatisfied.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const heightDifferenceFilterTypeID = "minecraft:height_difference_filter_feature"

// heightDiffDirections is the four-horizontal-cardinal scan order
// the placement decision uses -- facings 2, 5, 3, 4, in that exact order. Bedrock's facing enum:
// Down=0, Up=1, North=2, South=3, West=4, East=5 (this codebase's own
// established convention -- see sculk_patch.go's sculkFacingOffsets).
var heightDiffDirections = [4]struct{ dx, dz int }{
	{0, -1}, // North (facing 2)
	{1, 0},  // East (facing 5)
	{0, 1},  // South (facing 3)
	{-1, 0}, // West (facing 4)
}

// HeightDifferenceFilterFeature is minecraft:height_difference_filter_feature.
type HeightDifferenceFilterFeature struct {
	identifier string
	featureRef string
	resolver   wgen.IFeatureResolver

	hasMinUp, hasMinDown, hasMaxUp, hasMaxDown bool
	minUp, minDown, maxUp, maxDown             int
	searchRadius                               int
}

func (f *HeightDifferenceFilterFeature) TypeID() string     { return heightDifferenceFilterTypeID }
func (f *HeightDifferenceFilterFeature) Identifier() string { return f.identifier }

// FeatureRefs exposes the single delegated feature reference for the static
// delegation-chain walk.
func (f *HeightDifferenceFilterFeature) FeatureRefs() []string { return []string{f.featureRef} }

// shouldPlace mirrors the height-difference-filter feature's placement decision exactly --
// see the header for the full algorithm.
func (f *HeightDifferenceFilterFeature) shouldPlace(ctx *wgen.PlacementContext) bool {
	if f.searchRadius < 1 {
		return !f.hasMinUp && !f.hasMaxUp
	}

	originY := ctx.Origin.Y

	minDown := f.minDown
	if !f.hasMinDown {
		minDown = 2147483647
	}
	maxDown := f.maxDown
	if !f.hasMaxDown {
		maxDown = 2147483647
	}
	minUp := f.minUp
	if !f.hasMinUp {
		minUp = 0
	}
	maxUp := f.maxUp
	if !f.hasMaxUp {
		maxUp = 0
	}

	ceilThreshold := minDown + originY
	floorThreshold := originY - maxDown
	upThreshold := minUp + originY
	upBoundThreshold := originY - maxUp

	upSatisfied := !f.hasMinUp
	upBoundSatisfied := !f.hasMaxUp

	for _, dir := range heightDiffDirections {
		for i := 1; i <= f.searchRadius; i++ {
			TickDeadline("scanning outward as far as its search_radius asks")
			x := ctx.Origin.X + dir.dx*i
			z := ctx.Origin.Z + dir.dz*i
			h := ctx.API.GetHeight(x, z)

			if f.hasMinDown && ceilThreshold < h {
				return false
			}
			if f.hasMaxDown && floorThreshold > h {
				return false
			}
			upSatisfied = upSatisfied || upThreshold <= h
			upBoundSatisfied = upBoundSatisfied || upBoundThreshold >= h
		}
	}
	return upSatisfied && upBoundSatisfied
}

// describeRejection names the check shouldPlace failed on, for the profiler. It repeats the same
// pure height scan (no RNG, no writes) and is only called with profiling on, after shouldPlace
// has already said no, so the normal path is untouched.
func (f *HeightDifferenceFilterFeature) describeRejection(ctx *wgen.PlacementContext) string {
	if f.searchRadius < 1 {
		return fmt.Sprintf("search_radius = %d", f.searchRadius)
	}
	originY := ctx.Origin.Y
	for _, dir := range heightDiffDirections {
		for i := 1; i <= f.searchRadius; i++ {
			h := ctx.API.GetHeight(ctx.Origin.X+dir.dx*i, ctx.Origin.Z+dir.dz*i)
			if f.hasMinDown && f.minDown+originY < h {
				return fmt.Sprintf("surface %d above, min_required_downward_height_diff %d", h-originY, f.minDown)
			}
			if f.hasMaxDown && originY-f.maxDown > h {
				return fmt.Sprintf("surface %d below, max_allowed_downward_height_diff %d", originY-h, f.maxDown)
			}
		}
	}
	if f.hasMinUp {
		upThreshold := f.minUp + originY
		met := false
		for _, dir := range heightDiffDirections {
			for i := 1; i <= f.searchRadius; i++ {
				if upThreshold <= ctx.API.GetHeight(ctx.Origin.X+dir.dx*i, ctx.Origin.Z+dir.dz*i) {
					met = true
				}
			}
		}
		if !met {
			return fmt.Sprintf("min_required_upward_height_diff %d not met within %d", f.minUp, f.searchRadius)
		}
	}
	return fmt.Sprintf("max_allowed_upward_height_diff %d not met within %d", f.maxUp, f.searchRadius)
}

// Place mirrors the height-difference-filter feature's placement.
func (f *HeightDifferenceFilterFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, heightDifferenceFilterTypeID)
	defer profiler.PopFeatureFrame()

	sub := f.resolver.Resolve(f.featureRef)
	if sub == nil {
		LogFailure(ctx, heightDifferenceFilterTypeID,
			"`height_difference_filter_feature` could not find feature `places_feature`.")
		if profiler.StopsActive && !profiler.StopCounted(profiler.StopUnresolvedReference, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopUnresolvedReference, f.featureRef+" not found"+SuggestFeatureRef(f.resolver, f.featureRef), profiler.NoOrdinal)
		}
		return nil
	}

	if !f.shouldPlace(ctx) {
		// The game logs nothing for this branch -- gate fails silently.
		if profiler.StopsActive && !profiler.StopCounted(profiler.StopHeightDifferenceRejected, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopHeightDifferenceRejected, f.describeRejection(ctx), profiler.NoOrdinal)
		}
		return nil
	}

	if !IsAllowedToPlaceFeature(f) {
		if profiler.StopsActive {
			profiler.RecordStop(profiler.StopRecursionGuard, "already placing", profiler.NoOrdinal)
		}
		return nil
	}
	return WithRecursionGuard(f, func() *wgen.BlockPos { return sub.Place(ctx) })
}

func optionalIntField(body map[string]any, key string) (int, bool, error) {
	raw, ok := body[key]
	if !ok || raw == nil {
		return 0, false, nil
	}
	f, ok := toFloat(raw)
	if !ok {
		return 0, false, fmt.Errorf("%s must be a number", key)
	}
	return int(f), true, nil
}

func buildHeightDifferenceFilterFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	refRaw := FirstOf(body, "places_feature")
	ref, ok := refRaw.(string)
	if !ok || ref == "" {
		return nil, fmt.Errorf("places_feature must be a non-empty feature reference string")
	}

	radiusRaw, ok := body["search_radius"]
	if !ok || radiusRaw == nil {
		return nil, fmt.Errorf("search_radius is required")
	}
	radiusF, ok := toFloat(radiusRaw)
	if !ok {
		return nil, fmt.Errorf("search_radius must be a number")
	}

	f := &HeightDifferenceFilterFeature{
		identifier:   ctx.Identifier,
		featureRef:   ref,
		resolver:     ctx.Resolver,
		searchRadius: int(radiusF),
	}

	var err error
	if f.minUp, f.hasMinUp, err = optionalIntField(body, "min_required_upward_height_diff"); err != nil {
		return nil, err
	}
	if f.minDown, f.hasMinDown, err = optionalIntField(body, "min_required_downward_height_diff"); err != nil {
		return nil, err
	}
	if f.maxUp, f.hasMaxUp, err = optionalIntField(body, "max_allowed_upward_height_diff"); err != nil {
		return nil, err
	}
	if f.maxDown, f.hasMaxDown, err = optionalIntField(body, "max_allowed_downward_height_diff"); err != nil {
		return nil, err
	}

	return f, nil
}

func init() {
	RegisterType(heightDifferenceFilterTypeID, buildHeightDifferenceFilterFeature)
}

var _ wgen.IFeature = (*HeightDifferenceFilterFeature)(nil)
