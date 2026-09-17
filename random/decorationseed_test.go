package random

import (
	"fmt"
	"testing"
)

// The engine's own arithmetic, spelled out a second time and deliberately differently from
// decorationseed.go's implementation: the point of these tests is to pin the SHAPE of each
// formula (which order, which variant, which sign behaviour), because every one of them has a
// plausible neighbour that produces different worlds. A test that just called the same helper
// twice would pin nothing.

func TestHashedStringHash_IsFNV1NotFNV1a(t *testing.T) {
	// FNV-1 multiplies first and xors the byte into the product; FNV-1a xors first, then
	// multiplies. Both are 64-bit with the same constants, and they agree on NO non-empty input,
	// so computing the 1a value here and asserting we do NOT produce it is the whole test.
	const s = "minecraft:oak_tree"
	fnv1a := hashedStringFNVOffset
	for i := 0; i < len(s); i++ {
		fnv1a = (fnv1a ^ uint64(s[i])) * hashedStringFNVPrime
	}
	got := HashedStringHash(s)
	if got == fnv1a {
		t.Fatalf("HashedStringHash produced the FNV-1a value (0x%X); the engine's string hash "+
			"multiplies before xoring, which is FNV-1", got)
	}

	fnv1 := hashedStringFNVOffset
	for i := 0; i < len(s); i++ {
		fnv1 = fnv1*hashedStringFNVPrime ^ uint64(s[i])
	}
	if got != fnv1 {
		t.Errorf("HashedStringHash(%q) = 0x%X, want the FNV-1 value 0x%X", s, got, fnv1)
	}
}

func TestHashedStringHash_EmptyStringIsZeroNotTheOffsetBasis(t *testing.T) {
	// The hash short-circuits an empty string to a literal 0 rather than leaving the
	// offset basis in place -- a difference that only shows up on an unnamed entry, which is
	// exactly the case nobody tests by hand.
	if got := HashedStringHash(""); got != 0 {
		t.Errorf("HashedStringHash(\"\") = 0x%X, want 0", got)
	}
}

func TestHashedStringHash32_IsTheLow32Bits(t *testing.T) {
	const s = "wiki:pumpkin_patch"
	if got, want := HashedStringHash32(s), uint32(HashedStringHash(s)); got != want {
		t.Errorf("HashedStringHash32 = 0x%X, want 0x%X", got, want)
	}
}

func TestOddify_IsDivideByTwoTimesTwoPlusOne_NotOrOne(t *testing.T) {
	// The multipliers must be odd, and the engine makes them odd with `v / 2 * 2 + 1`, not with
	// `v | 1`. The two agree on every non-negative value and on even negatives, and disagree on
	// odd negatives -- half the possible draws.
	cases := []struct{ in, want int32 }{
		{0, 1},
		{1, 1},
		{2, 3},
		{7, 7},
		{-1, 1},   // -1/2 = 0 -> 1;      -1|1 = -1
		{-4, -3},  // agrees with |1
		{-5, -3},  // -5/2 = -2 -> -3;    -5|1 = -5
		{-11, -9}, // -11/2 = -5 -> -9;   -11|1 = -11
	}
	for _, c := range cases {
		if got := oddify(c.in); got != c.want {
			t.Errorf("oddify(%d) = %d, want %d", c.in, got, c.want)
		}
		if got := oddify(c.in); got%2 == 0 {
			t.Errorf("oddify(%d) = %d, which is even", c.in, got)
		}
	}
}

func TestChunkDecorationSeed_MatchesTheEnginesFormula(t *testing.T) {
	// Recompute the derivation independently from the world seed, then compare.
	//
	// Several world seeds, not one: the recomputation below spells out `v/2*2+1` rather than
	// calling oddify, so it is a second opinion on that step too -- but only for the values THIS
	// seed's first two draws happen to produce. A seed whose draws are both positive cannot tell
	// `v/2*2+1` from `v|1` at all, which is exactly the difference oddify exists for.
	for _, world := range []uint32{12345, 1, 7, 4294967295} {
		r := New(world)
		m1 := r.NextInt()/2*2 + 1
		m2 := r.NextInt()/2*2 + 1

		for _, c := range []struct{ x, z int32 }{{0, 0}, {1, 0}, {0, 1}, {-1, -1}, {31, -17}} {
			want := uint32(c.x*m1+c.z*m2) ^ world
			if got := ChunkDecorationSeed(world, c.x, c.z); got != want {
				t.Errorf("ChunkDecorationSeed(%d, %d, %d) = %d, want %d", world, c.x, c.z, got, want)
			}
		}
	}
}

func TestChunkDecorationSeed_TheMultiplierDrawIsNeverNegative(t *testing.T) {
	// Worth stating, because it changes what the test above can and cannot prove. oddify's two
	// spellings -- the engine's `v/2*2+1` and the `v|1` it is easy to mistake it for -- differ
	// ONLY on odd negatives, and the draw that feeds it here is the engine's unbounded integer
	// draw, which is a
	// 31-bit non-negative value. So inside this derivation the two are interchangeable, the
	// recomputation in the formula test cannot tell them apart, and TestOddify_... is the only
	// thing that does. The port still spells it the engine's way -- a port that quietly
	// "simplifies" a formula because today's inputs cannot tell the difference is how a later
	// game version's change to that draw becomes a silent divergence.
	for _, world := range []uint32{12345, 1, 7, 4294967295} {
		r := New(world)
		for i := 0; i < 8; i++ {
			if v := r.NextInt(); v < 0 {
				t.Fatalf("NextInt() returned %d for seed %d -- it is documented as a [0, 2^31-1] "+
					"draw, and oddify's negative branch is unreachable here only because of that", v, world)
			}
		}
	}
}

func TestChunkDecorationSeed_DiffersPerChunkAndPerWorld(t *testing.T) {
	// The property a bench actually depends on: neighbouring chunks decorate differently, and
	// the same chunk in two worlds does too. (Not a uniqueness guarantee -- a 32-bit seed can
	// collide -- but a collision between two adjacent chunks would mean the derivation had
	// collapsed, e.g. by dropping one of the multipliers.)
	seen := map[uint32]string{}
	for x := int32(-2); x <= 2; x++ {
		for z := int32(-2); z <= 2; z++ {
			s := ChunkDecorationSeed(99, x, z)
			if prev, dup := seen[s]; dup {
				// Naming the PARTNER is the whole value of this failure: which pair collided says
				// which half of the derivation collapsed (both axes sharing a multiplier, an axis
				// dropped, the two swapped).
				t.Errorf("chunk (%d,%d) got the same seed as chunk %s", x, z, prev)
			}
			seen[s] = fmt.Sprintf("(%d,%d)", x, z)
		}
	}
	if ChunkDecorationSeed(1, 3, 4) == ChunkDecorationSeed(2, 3, 4) {
		t.Error("the same chunk decorates identically in two different worlds")
	}
}

func TestDecorationEntrySeed_IsBoostHashCombine(t *testing.T) {
	// Not constants: the intermediate `chunkSeed << 6` overflows uint32, which is exactly what
	// the engine's 32-bit arithmetic does -- but Go rejects an overflowing CONSTANT expression, so
	// the wrap has to happen in variables.
	chunkSeed := uint32(0xDEADBEEF)
	nameHash := uint32(0x12345678)
	want := chunkSeed ^ (nameHash + 0x9E3779B9 + (chunkSeed << 6) + (chunkSeed >> 2))
	if got := DecorationEntrySeed(chunkSeed, nameHash); got != want {
		t.Errorf("DecorationEntrySeed = 0x%X, want 0x%X", got, want)
	}
}

func TestDecorationEntrySeed_SeparatesEntriesInOneChunk(t *testing.T) {
	// Two features decorating the same chunk must not share a stream -- that is what the name
	// hash is for, and dropping it (or hashing a constant) would make every entry in a chunk
	// draw the same positions.
	chunkSeed := uint32(777)
	a := DecorationEntrySeed(chunkSeed, HashedStringHash32("wiki:pumpkin_patch"))
	b := DecorationEntrySeed(chunkSeed, HashedStringHash32("wiki:diamond_vein"))
	if a == b {
		t.Error("two differently-named entries in one chunk got the same seed")
	}
	if a == chunkSeed {
		t.Error("the entry seed is just the chunk seed; the name hash did not reach it")
	}
}

func TestDecorationEntrySeed_TwoGeneratorsFromOneSeedRunInLockstep(t *testing.T) {
	// The engine builds two generators from one entry seed -- one for the positions, one for the
	// delegated feature -- and this is the property of THIS package that the arrangement rests
	// on: constructing from the same seed twice gives the same sequence, so "seeded alike" means
	// what it says. (What it does NOT test is that anything actually builds two of them; that is
	// a fact about session.Generate, and asserting it here would only be asserting that two
	// separately-allocated Go values do not share memory. session's own tests cover the wiring.)
	seed := DecorationEntrySeed(ChunkDecorationSeed(5, 1, 1), HashedStringHash32("wiki:x"))
	a, b := New(seed), New(seed)
	for i := 0; i < 16; i++ {
		if x, y := a.NextInt(), b.NextInt(); x != y {
			t.Fatalf("draw %d differed between two generators seeded alike: %d vs %d", i, x, y)
		}
	}
	// And a different seed must not produce the same opening -- otherwise the per-entry seed
	// would be decorative.
	other := New(seed + 1)
	same := true
	c := New(seed)
	for i := 0; i < 16; i++ {
		if other.NextInt() != c.NextInt() {
			same = false
			break
		}
	}
	if same {
		t.Error("two different entry seeds produced the same first sixteen draws")
	}
}
