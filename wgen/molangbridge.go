package wgen

import (
	"github.com/stirante/featurelab/random"

	molang "github.com/stirante/molang-go"
	"github.com/stirante/molang-go/eval"
	"github.com/stirante/molang-go/worldgen"
)

// heightSource adapts a BlockWorld to molang-go/worldgen's
// HeightSource, backing query.heightmap/query.above_top_solid.
type heightSource struct{ api BlockWorld }

func (h heightSource) HeightmapAt(x, z float64) float64 {
	return float64(h.api.GetHeightmapAt(int(x), int(z)))
}

func (h heightSource) AboveTopSolidAt(x, z float64) float64 {
	return float64(h.api.GetAboveTopSolidAt(int(x), int(z)))
}

// NewScope returns an empty, ready-to-use MolangScope. There is no child-scope
// derivation: deriving a scope for a sub-feature is an identity operation (every
// composite feature shares the identical scope by reference, unconditionally), so
// Go callers just reuse the same *molang.Scope pointer directly.
func NewScope() *molang.Scope { return molang.NewScope() }

// NewMolangContext builds the molang-go Context feature Molang evaluates
// against: math.random*/math.die_roll* draw from rnd, query.noise/
// has_biome_tag/any_tag/all_tags/heightmap/above_top_solid are registered
// world_gen queries, everything else falls back to the plain scope lookup.
// world may be nil (heightmap/above_top_solid then read 0, the "no world -> 0"
// fallback); biome may be nil (tag queries then read 0, likewise).
//
// onUnresolvedRead is called with the "<namespace>.<member>" name of every
// unresolved temp./variable./context. read this context swallows -- see
// UnresolvedReadWarning below for the whole argument, and pass nil only where
// there is genuinely nobody to tell (a test, or a caller that reports the
// reads some other way). It must not be nil merely because wiring one up is
// inconvenient: swallowing these silently is the failure mode this bench
// exists to catch in other tools.
func NewMolangContext(rnd random.IRandom, scope *molang.Scope, biome *MolangBiome, world BlockWorld, onUnresolvedRead func(name string)) *molang.Context {
	ctx := &molang.Context{
		RNG: rnd, Scope: scope, QueryFuncs: make(map[string]molang.QueryFunc),
		// Opt OUT of the engine's "an unresolved read with no enclosing ?? ends
		// the program" behaviour, and say so on every read that hits it. See
		// UnresolvedReadWarning.
		ContinueOnUnresolvedRead: true,
		OnUnresolvedRead:         onUnresolvedRead,
	}

	hasTag := func(argValue float64) bool { return false }
	if biome != nil {
		tagIDs := make(map[float64]bool, len(biome.Tags))
		for t := range biome.Tags {
			tagIDs[eval.InternString(t)] = true
		}
		hasTag = func(argValue float64) bool { return tagIDs[argValue] }
	}

	var hs worldgen.HeightSource
	if world != nil {
		hs = heightSource{api: world}
	}

	worldgen.Register(ctx.QueryFuncs, hasTag, hs)
	return ctx
}

// MolangContext returns the molang-go Context for this placement context's
// (Random, MolangScope, Biome, API), building it on first use and caching it
// on ctx.Molang -- see that field's doc comment (types.go) for the sharing/
// invalidation contract. Creates ctx.MolangScope first if it is nil, exactly
// like every call site's old inline `if ctx.MolangScope == nil` prologue, so
// the scope the returned context reads is always ctx.MolangScope itself.
//
// RNG-order neutral by construction: NewMolangContext performs no draws, and
// the returned context evaluates expressions identically whether it was just
// built or cached (molang.Context is three fields of pure configuration --
// eval state lives per Run call, not on the context).
func (ctx *PlacementContext) MolangContext() *molang.Context {
	if ctx.MolangScope == nil {
		ctx.MolangScope = NewScope()
	}
	if ctx.Molang == nil || ctx.Molang.RNG != ctx.Random || ctx.Molang.Scope != ctx.MolangScope || ctx.molangSourceChanged() {
		ctx.Molang = NewMolangContext(ctx.Random, ctx.MolangScope, ctx.Biome, ctx.API, ctx.reportUnresolvedMolangRead)
		ctx.molangFromAPI, ctx.molangFromBiome, ctx.molangProvenance = ctx.API, ctx.Biome, true
	}
	return ctx.Molang
}

// molangSourceChanged reports whether the cached context was built from a
// different API/Biome than this context now carries -- the two inputs
// molang.Context cannot be asked about directly, so they are checked against the
// provenance MolangContext recorded when it built the cache (see
// PlacementContext.molangFromAPI's doc comment in types.go for the invariant and
// for the search_feature bug this closes).
//
// A context whose Molang was assigned directly has no recorded provenance and is
// taken at its word -- that assignment IS the caller asserting the invariant, and
// rebuilding on it would defeat the only reason to assign it.
func (ctx *PlacementContext) molangSourceChanged() bool {
	if !ctx.molangProvenance {
		return false
	}
	return ctx.molangFromAPI != ctx.API || ctx.molangFromBiome != ctx.Biome
}

// ---------------------------------------------------------------------------
// Unresolved Molang reads: a disclosed, bench-wide divergence
// ---------------------------------------------------------------------------
//
// Engine behaviour (molang-go's eval/unresolved.go carries the
// detail): reading a temp./variable./context. slot that holds NO VALUE,
// with no enclosing `??` to catch it, ENDS the expression where it stands. The
// read itself is 0, but nothing sequenced after it happens -- no assignments,
// no randomness, nothing.
//
// This tool opts out of that, everywhere, deliberately. The reason is not that
// the behaviour is doubted; it is that this tool cannot reproduce the input the
// behaviour depends on. It places ONE feature in isolation against a fresh
// empty scope (session.Generate's wgen.NewScope()). In a real chunk, a slot a
// sub-feature reads is very often written by a parent earlier in the delegation
// chain, or by the feature rule's own scatter walk (variable.worldx/y/z are
// written per axis -- rules.go). Placed on its own, that parent never ran, so
// the slot is unset HERE and set THERE, and the engine-faithful abort would
// stop a large share of real delegation chains at their first read: a preview that used to
// show something would show nothing, for a reason belonging to the bench rather
// than to the pack.
//
// So the read yields 0 and evaluation continues -- and every single one of them
// is reported, because a featurelab that quietly diverges from known
// engine behaviour is exactly the failure this project keeps finding and
// removing. A diagnostic naming the variable is strictly more useful to an
// author than a silent early stop: it says "the game would have stopped here
// unless something upstream sets this", which is actionable, where an empty
// preview is not.
//
// UnresolvedReadWarning is that diagnostic's one wording, shared by every site
// that swallows a read so the message a reader sees does not depend on which
// context happened to build the expression. It names the variable and nothing
// position-specific on purpose: session.Generate deduplicates placement
// diagnostics by (level, message, chain) and counts the repeats, so one read
// inside a scatter iterating a hundred thousand times becomes ONE entry with
// Count 100000 rather than a hundred thousand entries.
func UnresolvedReadWarning(name string) string {
	return name + " was read here but has never been set. In the real game an unresolved read STOPS " +
		"the expression where it stands -- the read is 0, and nothing after it runs, not the rest of " +
		"the expression, not the assignments, not the randomness -- so the game would have stopped " +
		"here. This tool substitutes 0 and keeps going instead, because it places one feature in " +
		"isolation with an empty Molang scope: a slot that a parent feature, or the feature rule's " +
		"own scatter walk, would have written before this one ran is unset here and set in a real " +
		"chunk. Treat it as a question rather than a verdict -- if something upstream really does " +
		"write " + name + ", this preview is right and the message is noise; if nothing does, the " +
		"game stops here and this feature places nothing. Writing " + name + " = <value> earlier, or " +
		"guarding the read with `?? <default>`, settles it either way."
}

// reportUnresolvedMolangRead is the OnUnresolvedRead sink MolangContext wires
// into every context it builds: one LogWarning per swallowed read, deduplicated
// and counted by the session (see UnresolvedReadWarning).
//
// pos is nil -- "not tied to one write attempt" (PlacementContext.LogWarning's
// own contract). It would be easy to pass ctx.Origin and wrong to: the cached
// context is shared BY REFERENCE down the whole delegation chain (WithOrigin
// copies it), so this method's receiver is whichever context first built it,
// whose Origin is not where the read happened. The delegation chain the session
// attaches (profiler.CurrentChain) is maintained globally and IS accurate at
// the moment of the read, so the feature that actually read the slot is named
// either way.
//
// featureType is empty for the same reason: from here the read belongs to an
// expression, not to a feature type. Callers that do know one -- cave.go's
// width_modifier context -- pass it themselves.
func (ctx *PlacementContext) reportUnresolvedMolangRead(name string) {
	if ctx.LogWarning == nil {
		return
	}
	ctx.LogWarning("", UnresolvedReadWarning(name), nil)
}
