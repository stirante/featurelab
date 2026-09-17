package wgen

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"

	molang "github.com/stirante/molang-go"
)

func mustRun(t *testing.T, expr string, ctx *molang.Context) float64 {
	t.Helper()
	prog, err := molang.Compile(expr)
	if err != nil {
		t.Fatalf("molang.Compile(%q): %v", expr, err)
	}
	return prog.Run(ctx)
}

// TestMolangContext_CachesPerRandomAndScope pins PlacementContext.
// MolangContext's contract (see PlacementContext.Molang's doc comment): one
// build per (Random, MolangScope) pair, shared by reference across WithOrigin
// copies -- a delegation chain must not rebuild the bridge context per Place
// call (measured at ~13% of a pathological run's CPU before the cache) --
// and an automatic rebuild when either input is swapped, so a caller that
// substitutes a different RNG (cave.go's width RNG pattern) can never
// evaluate against a stale context.
func TestMolangContext_CachesPerRandomAndScope(t *testing.T) {
	rnd := random.New(1)
	ctx := &PlacementContext{Random: rnd}

	first := ctx.MolangContext()
	if first == nil {
		t.Fatal("MolangContext returned nil")
	}
	if ctx.MolangScope == nil {
		t.Fatal("MolangContext must create MolangScope when nil (the old call sites' inline prologue)")
	}
	if first.Scope != ctx.MolangScope {
		t.Error("built context's Scope is not ctx.MolangScope")
	}
	if second := ctx.MolangContext(); second != first {
		t.Error("second MolangContext call rebuilt the context despite unchanged inputs")
	}

	// WithOrigin copies the cache by reference: the child must reuse it.
	child := ctx.WithOrigin(BlockPos{X: 1, Y: 2, Z: 3})
	if got := child.MolangContext(); got != first {
		t.Error("WithOrigin child rebuilt the context instead of reusing the cached one")
	}

	// Swapping the RNG invalidates the cache...
	other := random.New(2)
	child.Random = other
	rebuilt := child.MolangContext()
	if rebuilt == first {
		t.Error("MolangContext reused a context built for a different Random")
	}
	if rebuilt.RNG != other {
		t.Error("rebuilt context does not read the new Random")
	}
	// ...without touching the parent's cache (WithOrigin made a copy).
	if got := ctx.MolangContext(); got != first {
		t.Error("parent's cache was invalidated by the child's RNG swap")
	}

	// Swapping the scope invalidates too.
	ctx.MolangScope = NewScope()
	if got := ctx.MolangContext(); got == first {
		t.Error("MolangContext reused a context built for a different MolangScope")
	} else if got.Scope != ctx.MolangScope {
		t.Error("rebuilt context does not read the new MolangScope")
	}
}

// TestMolangContext_EvaluationSeesLiveScopeMutations proves the cached
// context is not a snapshot: the scope is shared by reference (scope derivation
// is an identity operation), so a variable written after the
// context was built -- scatter rewriting variable.worldx per Place -- must be
// visible to the next evaluation through the SAME cached context.
func TestMolangContext_EvaluationSeesLiveScopeMutations(t *testing.T) {
	ctx := &PlacementContext{Random: random.New(1)}
	mc := ctx.MolangContext()

	ctx.MolangScope.Variable["worldx"] = 7
	if got := mustRun(t, "variable.worldx", mc); got != 7 {
		t.Errorf("variable.worldx = %v, want 7", got)
	}
	ctx.MolangScope.Variable["worldx"] = 42
	if got := mustRun(t, "variable.worldx", mc); got != 42 {
		t.Errorf("variable.worldx after mutation = %v, want 42 through the cached context", got)
	}
}

// fixedHeightAPI is a minimal BlockWorld whose only interesting
// behaviour is that query.heightmap/query.above_top_solid report a value
// unique to this instance, so a test can say WHICH world an evaluation read.
type fixedHeightAPI struct{ height int }

func (a *fixedHeightAPI) GetBlock(BlockPos) block.ID       { return block.AirID }
func (a *fixedHeightAPI) SetBlock(BlockPos, block.ID) bool { return true }
func (a *fixedHeightAPI) GetHeight(int, int) int           { return a.height }
func (a *fixedHeightAPI) GetHeightmapAt(int, int) int      { return a.height }
func (a *fixedHeightAPI) GetAboveTopSolidAt(int, int) int  { return a.height }
func (a *fixedHeightAPI) MinY() int                        { return 0 }
func (a *fixedHeightAPI) MaxY() int                        { return 256 }
func (a *fixedHeightAPI) Contains(BlockPos) bool           { return true }
func (a *fixedHeightAPI) Palette() IPaletteView            { return block.NewPalette() }

// TestMolangContext_RebuildsWhenAPIIsSwappedAfterWithOrigin pins the exact
// shape search_feature had: inherit a cached bridge context through WithOrigin,
// then point the sub-context at a DIFFERENT world.
//
// The direction is the whole assertion. Before the provenance check,
// MolangContext re-validated Random and MolangScope only, so the swapped API
// was ignored and query.heightmap kept answering with the OUTER world's height
// -- a delegate reading the world it was NOT writing to. Asserting only "a
// context comes back" or "the value is a number" passes against that bug; this
// asserts the value is the NEW world's and would fail on the old one's.
func TestMolangContext_RebuildsWhenAPIIsSwappedAfterWithOrigin(t *testing.T) {
	outer := &fixedHeightAPI{height: 70}
	inner := &fixedHeightAPI{height: 11}

	ctx := &PlacementContext{Random: random.New(1), API: outer}
	if got := mustRun(t, "query.heightmap(0, 0)", ctx.MolangContext()); got != 70 {
		t.Fatalf("outer query.heightmap = %v, want 70 -- the premise of this test", got)
	}

	// search_feature's pattern: WithOrigin (which copies Molang by reference),
	// then swap in the transactional wrapper.
	sub := ctx.WithOrigin(BlockPos{X: 1, Y: 2, Z: 3})
	sub.API = inner

	if got := mustRun(t, "query.heightmap(0, 0)", sub.MolangContext()); got != 11 {
		t.Errorf("sub-context query.heightmap = %v, want 11 (the API the sub-context actually holds); "+
			"70 means it is still evaluating against the outer world it no longer writes to", got)
	}
	if got := mustRun(t, "query.above_top_solid(0, 0)", sub.MolangContext()); got != 11 {
		t.Errorf("sub-context query.above_top_solid = %v, want 11 (the API the sub-context actually holds)", got)
	}
	// The parent keeps its own cache: WithOrigin made a copy, and re-validating
	// the child must not disturb the chain the parent still shares.
	if got := mustRun(t, "query.heightmap(0, 0)", ctx.MolangContext()); got != 70 {
		t.Errorf("parent query.heightmap = %v after the child rebuilt, want 70", got)
	}
}

// TestMolangContext_RebuildsWhenBiomeIsSwapped is the Biome half of the same
// gap: query.has_biome_tag is baked into the bridge context at build time, so a
// context that inherits a cached one and then swaps Biome used to answer tag
// queries for the PREVIOUS biome -- the one direction that silently turns a
// filtered feature into an unfiltered one.
func TestMolangContext_RebuildsWhenBiomeIsSwapped(t *testing.T) {
	plains := &MolangBiome{ID: "plains", Tags: map[string]struct{}{"plains": {}}}
	nether := &MolangBiome{ID: "hell", Tags: map[string]struct{}{"nether": {}}}

	ctx := &PlacementContext{Random: random.New(1), Biome: plains}
	if got := mustRun(t, "query.has_biome_tag('plains')", ctx.MolangContext()); got != 1 {
		t.Fatalf("has_biome_tag('plains') = %v under the plains biome, want 1 -- the premise of this test", got)
	}

	sub := ctx.WithOrigin(BlockPos{})
	sub.Biome = nether

	if got := mustRun(t, "query.has_biome_tag('plains')", sub.MolangContext()); got != 0 {
		t.Errorf("has_biome_tag('plains') = %v after swapping to the nether biome, want 0 -- "+
			"1 means the cached context is still answering for the biome it was built with", got)
	}
	if got := mustRun(t, "query.has_biome_tag('nether')", sub.MolangContext()); got != 1 {
		t.Errorf("has_biome_tag('nether') = %v under the nether biome, want 1", got)
	}
}

// TestMolangContext_DirectlyAssignedContextIsNotRebuilt pins the deliberate
// exception: a caller that builds a context via NewMolangContext and assigns it
// straight onto PlacementContext.Molang (rules/rules.go's per-iteration
// sub-context, the one production site) is asserting the invariant itself, and
// must NOT have its seed thrown away -- that assignment exists precisely so the
// first nested Molang-evaluating feature reuses it instead of rebuilding, and a
// rebuild per scatter iteration is what the cache was added to avoid.
func TestMolangContext_DirectlyAssignedContextIsNotRebuilt(t *testing.T) {
	api := &fixedHeightAPI{height: 5}
	scope := NewScope()
	rnd := random.New(1)
	seeded := NewMolangContext(rnd, scope, nil, api, nil)

	ctx := &PlacementContext{API: api, Random: rnd, MolangScope: scope, Molang: seeded}
	if got := ctx.MolangContext(); got != seeded {
		t.Error("a directly assigned Molang context was rebuilt; the rules.go cache seed is wasted")
	}
}

// TestMolangContext_SwallowsAndReportsUnresolvedReads pins the bench-wide
// divergence documented on UnresolvedReadWarning: an unresolved
// temp./variable./context. read ENDS the expression in the engine, and here it
// yields 0, lets evaluation continue, and is reported by name.
//
// The RNG draw is the load-bearing half. "the read is 0" was true before this
// tool opted out and is true after; what the opt-out changes is that everything
// sequenced AFTER the read still happens, which is exactly what the engine
// skips.
func TestMolangContext_SwallowsAndReportsUnresolvedReads(t *testing.T) {
	var reported []string
	ctx := &PlacementContext{
		Random:     random.New(1),
		LogWarning: func(featureType, message string, pos *BlockPos) { reported = append(reported, message) },
	}
	mc := ctx.MolangContext()

	if got := mustRun(t, "v.never_written + 7", mc); got != 7 {
		t.Errorf("v.never_written + 7 = %v, want 7 (the read is 0 and the sum still happens)", got)
	}
	if got := mustRun(t, "v.never_written; t.after = 3; return t.after;", mc); got != 3 {
		t.Errorf("statements after an unresolved read = %v, want 3 -- the engine skips them, this tool must not", got)
	}
	if len(reported) != 2 {
		t.Fatalf("reported %d reads, want 2 (one per occurrence, deduplicated later by the session): %v", len(reported), reported)
	}
	for _, m := range reported {
		if m != UnresolvedReadWarning("variable.never_written") {
			t.Errorf("diagnostic does not name the variable through the shared wording: %q", m)
		}
	}

	// `??` is NOT part of the opt-out: a guarded read is ordinary control flow,
	// takes the right-hand side exactly as the engine does, and is not reported.
	reported = nil
	if got := mustRun(t, "t.chance = t.chance ?? 0.5; return t.chance;", mc); got != 0.5 {
		t.Errorf("t.chance = t.chance ?? 0.5 = %v, want 0.5", got)
	}
	if len(reported) != 0 {
		t.Errorf("a `??`-guarded read must not be reported, got %v", reported)
	}
}
