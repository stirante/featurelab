// scan_surface.go implements minecraft:scan_surface. Registered id:
// minecraft:scan_surface ONLY -- the game does not accept a
// "minecraft:scan_surface_feature" spelling (the game uses
// "scan_surface_feature" only as an internal log label, not as a JSON type
// id), so no alias is registered here.
//
// Placement behaviour is the same in both targeted game versions and makes
// no RNG calls.
//
// JSON: the exact schema key names are unconfirmed -- the only field
// placement needs is the single wrapped feature reference. Named
// places_feature for consistency with scatter_feature's identical-purpose
// field.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const scanSurfaceTypeID = "minecraft:scan_surface"

// ScanSurfaceFeature is minecraft:scan_surface.
type ScanSurfaceFeature struct {
	identifier string
	featureRef string
	resolver   wgen.IFeatureResolver
}

func (f *ScanSurfaceFeature) TypeID() string     { return scanSurfaceTypeID }
func (f *ScanSurfaceFeature) Identifier() string { return f.identifier }

// FeatureRefs exposes the single delegated feature reference for the static
// delegation-chain walk.
func (f *ScanSurfaceFeature) FeatureRefs() []string { return []string{f.featureRef} }

// floorDiv mirrors JS's Math.floor(a/b) for integers, distinct from Go's
// native truncating `/` for negative dividends.
func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// Place mirrors the scan-surface feature's placement: every column in the containing
// 16x16 chunk gets a real placement attempt with real side effects; only the
// LAST valid result is remembered (overwrite, not accumulate).
func (f *ScanSurfaceFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, scanSurfaceTypeID)
	defer profiler.PopFeatureFrame()

	sub := f.resolver.Resolve(f.featureRef)
	if sub == nil {
		return nil
	}
	// Recursion guard marks/checks `f` (the wrapper), not `sub` -- see
	// shared.go.
	if !IsAllowedToPlaceFeature(f) {
		return nil
	}

	chunkX := floorDiv(ctx.Origin.X, 16)
	chunkZ := floorDiv(ctx.Origin.Z, 16)
	minX := chunkX * 16
	minZ := chunkZ * 16
	maxX := minX + 16
	maxZ := minZ + 16

	var lastValid *wgen.BlockPos
	// Outer = X, inner = Z, no skipping, no early exit.
	for x := minX; x < maxX; x++ {
		for z := minZ; z < maxZ; z++ {
			y := ctx.API.GetHeight(x, z) // stand-in for the context's height/column query
			// MolangScope: the SAME scope is forwarded into every column's
			// context (childScope is an identity function), not forked.
			subCtx := ctx.WithOrigin(wgen.BlockPos{X: x, Y: y, Z: z})
			result := WithRecursionGuard(f, func() *wgen.BlockPos { return sub.Place(subCtx) })
			if result != nil {
				lastValid = result
			}
		}
	}
	return lastValid
}

func buildScanSurfaceFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	refRaw := FirstOf(body, "places_feature", "feature", "feature_to_scan")
	ref, ok := refRaw.(string)
	if !ok || ref == "" {
		return nil, fmt.Errorf("places_feature must be a non-empty feature reference string")
	}
	return &ScanSurfaceFeature{identifier: ctx.Identifier, featureRef: ref, resolver: ctx.Resolver}, nil
}

func init() {
	RegisterType(scanSurfaceTypeID, buildScanSurfaceFeature)
}

var _ wgen.IFeature = (*ScanSurfaceFeature)(nil)
