package random

import "testing"

// derive_test.go pins DeriveSeed/DeriveSeedAt (derive.go) against the exact historical formulas
// they replace -- env/environment.go's `seed ^ 0x7a3e`, env/plains.go's `seed ^ 0x0e5e`, and
// features/multiface.go's position-mixed multiply-xor hash -- so this scheme's own "unify the
// MECHANISM, keep the OUTPUTS identical" promise (see this file's header) is a tested claim, not
// just a doc comment.

// TestDeriveSeed_LegacyEnvDomains_MatchHistoricalXORFormula is the direct proof behind "env output
// for a given seed is unchanged by the derivation refactor": env/environment.go's forest-tree
// scatter and env/plains.go's ore scatter both now call NewEnvRandom(random.DeriveSeed(seed,
// <domain>)) in place of their own inline `seed ^ 0x....` literal. If this function's own legacy
// formula ever drifted from that literal, every seed's forest/ore placement would silently change --
// this test fails the instant that happens, independent of (and faster than) the env package's own
// full preset-block-distribution hash-fixture test (which additionally re-confirms the same claim
// transitively, at the full preset-Build level, against a pinned hash, for every preset including
// "forest" and all three underground presets).
func TestDeriveSeed_LegacyEnvDomains_MatchHistoricalXORFormula(t *testing.T) {
	seeds := []int32{0, 1, -1, 42, 12345, 999999, -999999, 2147483647, -2147483648}
	for _, seed := range seeds {
		master := uint32(seed)

		if got, want := DeriveSeed(master, DomainEnvForestTrees), master^0x7a3e; got != want {
			t.Errorf("DeriveSeed(%d, DomainEnvForestTrees) = %#x, want %#x (historical `seed ^ 0x7a3e`)", seed, got, want)
		}
		if got, want := DeriveSeed(master, DomainEnvOreScatter), master^0x0e5e; got != want {
			t.Errorf("DeriveSeed(%d, DomainEnvOreScatter) = %#x, want %#x (historical `seed ^ 0x0e5e`)", seed, got, want)
		}
	}
}

// legacyMultifaceSpreadSeedFormula is features/multiface.go's ORIGINAL multifaceSpreadSeed body,
// copied verbatim (not imported -- features imports random, so random cannot import features
// without a cycle) so this test has an independent historical reference to check DeriveSeedAt
// against, rather than checking the new code against itself.
func legacyMultifaceSpreadSeedFormula(base uint32, x, y, z int) uint32 {
	h := base
	h = h*2654435761 ^ uint32(x)
	h = h*2654435761 ^ uint32(y)
	h = h*2654435761 ^ uint32(z)
	return h
}

// TestDeriveSeedAt_LegacyMultifaceDomain_MatchesHistoricalHash is DeriveSeedAt's own version of
// TestDeriveSeed_LegacyEnvDomains_MatchHistoricalXORFormula: DomainMultifaceSpread must reproduce
// multiface.go's original position-mixed multiply-xor hash bit for bit, for every (base, x, y, z)
// tried here, including negative coordinates (a spread position can legitimately be negative in
// world space).
func TestDeriveSeedAt_LegacyMultifaceDomain_MatchesHistoricalHash(t *testing.T) {
	cases := []struct {
		base    uint32
		x, y, z int
	}{
		{0, 0, 0, 0},
		{12345, 1, 2, 3},
		{0xdeadbeef, -5, 100, -37},
		{1, -1, -1, -1},
		{4294967295, 1000, -1000, 0},
	}
	for _, c := range cases {
		got := DeriveSeedAt(c.base, DomainMultifaceSpread, c.x, c.y, c.z)
		want := legacyMultifaceSpreadSeedFormula(c.base, c.x, c.y, c.z)
		if got != want {
			t.Errorf("DeriveSeedAt(%d, DomainMultifaceSpread, %d, %d, %d) = %#x, want %#x (historical formula)",
				c.base, c.x, c.y, c.z, got, want)
		}
	}
}

// TestDeriveSeed_NewDomain_IsDeterministicAndDomainIndependent exercises DomainCaveWidthModifier --
// a domain with NO pre-existing formula to preserve, routed through the generic hash instead (see
// derive.go's own hashDomain). Two properties any new domain must have: pure-function determinism
// (same master+domain always derives the same sub-seed -- this is what makes a preview reproducible
// at all), and domain independence (two different domains sharing one master seed must not derive
// the same sub-seed, or a coincidence there would silently correlate two supposedly-independent
// sub-generators).
func TestDeriveSeed_NewDomain_IsDeterministicAndDomainIndependent(t *testing.T) {
	const master = uint32(0xC0FFEE)

	a := DeriveSeed(master, DomainCaveWidthModifier)
	b := DeriveSeed(master, DomainCaveWidthModifier)
	if a != b {
		t.Fatalf("DeriveSeed(%d, DomainCaveWidthModifier) is not deterministic: %#x then %#x", master, a, b)
	}

	other := DeriveSeed(master, DomainEnvForestTrees)
	if a == other {
		t.Errorf("DomainCaveWidthModifier and DomainEnvForestTrees derived the SAME sub-seed (%#x) from the same master -- domains are not independent", a)
	}
}

// TestDeriveSeed_DifferentMasterSeed_ChangesDerivedSeed is the seed-derivation half of "changing
// ONLY the master seed changes the preview": for a curated set of distinct master seeds, every pair
// must derive a different DomainCaveWidthModifier sub-seed. (A universal no-collision guarantee
// isn't meaningful for a 32-bit hash -- SOME distinct pair of 32-bit inputs must collide somewhere
// -- but this pins the property holding across a realistic spread of seeds, which is what a user
// actually exercises by changing the seed field.)
func TestDeriveSeed_DifferentMasterSeed_ChangesDerivedSeed(t *testing.T) {
	seeds := []uint32{0, 1, 2, 42, 12345, 999999, 0xC0FFEE, 0xDEADBEEF, 4294967295}
	seen := make(map[uint32]uint32, len(seeds))
	for _, s := range seeds {
		d := DeriveSeed(s, DomainCaveWidthModifier)
		if prevSeed, ok := seen[d]; ok {
			t.Errorf("master seeds %d and %d both derived DomainCaveWidthModifier sub-seed %#x -- expected distinct master seeds to diverge", prevSeed, s, d)
		}
		seen[d] = s
	}
}
