// Package wgen holds the core worldgen placement contracts: BlockPos, the
// BlockWorld/IPaletteView interfaces a volume/palette implement,
// IFeature/IFeatureResolver, and PlacementContext. Kept interface-first (not
// tied to the one volume.Volume implementation) so a test harness can
// wrap BlockWorld in a write-recording decorator, which is exactly how
// the golden-dump generator captures placements.
package wgen

import (
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"

	molang "github.com/stirante/molang-go"
)

// BlockPos is a block-grid position. Tagged lowerCamelCase (x/y/z) for the wire contract this
// type crosses whenever it's embedded in a JSON-marshaled type (session.Result.Origin/
// Placement, etc.) -- see featurelab-go/wire's package doc comment for the full wire spec.
type BlockPos struct {
	X int `json:"x"`
	Y int `json:"y"`
	Z int `json:"z"`
}

// IPaletteView is the subset of block.Palette's surface a feature is
// allowed to touch.
type IPaletteView interface {
	Resolve(desc block.Descriptor) block.ID
	NameOf(id block.ID) string
	StatesOf(id block.ID) map[string]block.StateValue
	IsAir(id block.ID) bool
	IsLiquid(id block.ID) bool
	IsSolid(id block.ID) bool
}

// BlockWorld is the block world a feature writes into, including the
// distinction between GetHeight, GetHeightmapAt and GetAboveTopSolidAt (see
// volume.Volume's implementations for what each one actually scans for).
type BlockWorld interface {
	GetBlock(p BlockPos) block.ID
	SetBlock(p BlockPos, id block.ID) bool
	GetHeight(x, z int) int
	GetHeightmapAt(x, z int) int
	GetAboveTopSolidAt(x, z int) int
	MinY() int
	MaxY() int
	Contains(p BlockPos) bool
	Palette() IPaletteView
}

// MolangBiome is the active biome identity for query.has_biome_tag/any_tag/
// all_tags.
type MolangBiome struct {
	ID   string
	Tags map[string]struct{}
}

// PlacementContext is everything IFeature.Place is handed, including the
// shared, by-reference MolangScope every composite feature forwards unchanged
// — see NewScope in molangbridge.go for why that sharing is deliberate, not an
// oversight.
type PlacementContext struct {
	API         BlockWorld
	Origin      BlockPos
	Random      random.IRandom
	MolangScope *molang.Scope
	Biome       *MolangBiome
	// LogFailure reports a placement refusal -- featureType/message describe what happened, pos is
	// the position the currently-executing feature was attempting to place at (see features.
	// LogFailure, this package's own caller). nil means "no one is listening" (never called).
	LogFailure func(featureType, message string, pos BlockPos)
	// LogWarning reports a non-refusing diagnostic -- a disclosed port gap that fired, not a
	// placement failure: the feature keeps placing normally either side of the call. Unlike
	// LogFailure, pos is a pointer the CALLER decides: non-nil when the diagnostic is genuinely
	// tied to one position (mirrors session.Diagnostic.Position's own "never a zero BlockPos
	// standing in for unknown" contract), nil when it describes the feature's configuration as a
	// whole (e.g. a field that validates but never visibly fires). nil means "no one is
	// listening" (never called), same as LogFailure.
	LogWarning func(featureType, message string, pos *BlockPos)
	// Molang is the cached molang-go bridge context for (Random, MolangScope, Biome, API) --
	// see MolangContext (molangbridge.go), which every Molang-evaluating feature calls instead
	// of building a fresh context per Place. Building one is pure map/closure setup (NO RNG
	// draws, see NewMolangContext), so caching it is invisible to the draw sequence; it exists
	// because a deep delegation chain used to rebuild the identical context hundreds of
	// thousands of times per generation (measured at ~13% of a pathological run's CPU samples).
	// WithOrigin copies it by reference along with the four fields it was built from, so a
	// whole chain shares one context. Invariant for anyone setting this directly (rules.go's
	// per-iteration sub-context is the one production site): it must have been built via
	// NewMolangContext from EXACTLY this context's own Random/MolangScope/Biome/API.
	// MolangContext re-validates all four -- Random/MolangScope against the cached
	// molang.Context itself, API/Biome against the provenance recorded in
	// molangFromAPI/molangFromBiome below -- and rebuilds on mismatch.
	Molang *molang.Context

	// molangFromAPI/molangFromBiome/molangProvenance record which (API, Biome) pair
	// MolangContext built ctx.Molang from. molang.Context carries neither back (both
	// are captured inside the query closures), so without this the cache could not
	// tell "the API I was built for" from "the API this context now holds", and a
	// caller that swapped API AFTER inheriting a cached context kept evaluating
	// query.heightmap/above_top_solid against the OLD world.
	//
	// That was not hypothetical: search_feature runs its delegate against a
	// transactional wrapper (ctx.WithOrigin, then subCtx.API = wrapped), and
	// WithOrigin copies Molang by reference. It was invisible only because the
	// wrapper forwards both height queries to its inner target -- one wrapper that
	// stopped forwarding, and every search delegate would have been reading a
	// different world than it wrote to.
	//
	// molangProvenance is false for a context whose Molang was assigned DIRECTLY
	// (rules.go's per-iteration sub-context is the one production site): that caller
	// asserts the invariant above -- built via NewMolangContext from exactly this
	// context's own four fields -- so there is nothing to re-validate against, and
	// re-validating a pair we never recorded would throw away exactly the cache seed
	// that assignment exists to provide.
	molangFromAPI    BlockWorld
	molangFromBiome  *MolangBiome
	molangProvenance bool
}

// Clone returns a shallow copy of ctx with a new Origin — used by composite
// features delegating to a sub-feature at a different position. Every other
// field carries over unchanged; MolangScope in particular is copied by
// reference, not cloned.
func (ctx PlacementContext) WithOrigin(origin BlockPos) *PlacementContext {
	c := ctx
	c.Origin = origin
	return &c
}

// IFeature is a placed feature. Place returns the placement origin on
// success, nil on failure.
type IFeature interface {
	TypeID() string
	Identifier() string
	Place(ctx *PlacementContext) *BlockPos
}

// IFeatureResolver resolves "namespace:id" feature references to instances,
// for composite features.
type IFeatureResolver interface {
	Resolve(identifier string) IFeature
}
