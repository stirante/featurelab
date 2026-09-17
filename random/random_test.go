package random

import (
	"math"
	"testing"

	"github.com/stirante/molang-go/mtrand"
)

// TestGetSeedReturnsConstructedSeed pins GetSeed()'s basic contract: it
// returns whatever New was constructed with, unaffected by subsequent draws
// -- it models the engine's stored seed field, not anything derived
// from the live twister state (which starts as a copy of the seed but is
// immediately overwritten by drawing).
func TestGetSeedReturnsConstructedSeed(t *testing.T) {
	r := New(12345)
	if got := r.GetSeed(); got != 12345 {
		t.Fatalf("GetSeed() after New(12345) = %d, want 12345", got)
	}
	// Drawing must NOT change GetSeed's answer -- if it did, GetSeed would be
	// reading the twister state, not the stored seed field.
	for i := 0; i < 50; i++ {
		r.NextInt()
	}
	if got := r.GetSeed(); got != 12345 {
		t.Fatalf("GetSeed() after 50 draws = %d, want unchanged 12345", got)
	}
}

// TestSetSeedUpdatesGetSeed pins that SetSeed both reseeds the generator AND
// updates GetSeed, matching the engine's reseed writing both the stored seed
// field and the first word of the twister state from the same value (as the
// cave carver's reseed loop relies on).
func TestSetSeedUpdatesGetSeed(t *testing.T) {
	r := New(1)
	r.NextInt() // move off the constructed seed so a no-op SetSeed would be detectable
	r.SetSeed(999)
	if got := r.GetSeed(); got != 999 {
		t.Fatalf("GetSeed() after SetSeed(999) = %d, want 999", got)
	}
}

// TestSetSeedInPlaceMatchesFreshRand is the crux of why SetSeed had to be
// widened onto IRandom instead of every caller just constructing a fresh
// Rand: the real engine reseeds the SAME Random object CaveFeature was
// handed, in place, and draws further from it -- so after a SetSeed, this
// Rand's OWN subsequent draw sequence must be byte-identical to a brand new
// Rand constructed with that same seed. This test pins exactly that: reseed
// an already-drawn-from Rand mid-stream and confirm its next N draws match
// New(seed) from scratch, across all five draw kinds.
func TestSetSeedInPlaceMatchesFreshRand(t *testing.T) {
	const reseedTo = 0xC0FFEE

	reused := New(42)
	for i := 0; i < 17; i++ { // dirty the state before reseeding
		reused.NextInt()
	}
	reused.SetSeed(reseedTo)

	fresh := New(reseedTo)

	for i := 0; i < 32; i++ {
		if a, b := reused.NextInt(), fresh.NextInt(); a != b {
			t.Fatalf("NextInt() draw %d after SetSeed: reused=%d fresh=%d", i, a, b)
		}
	}
	if a, b := reused.NextIntBound(1000), fresh.NextIntBound(1000); a != b {
		t.Fatalf("NextIntBound(1000): reused=%d fresh=%d", a, b)
	}
	if a, b := reused.NextFloat(), fresh.NextFloat(); a != b {
		t.Fatalf("NextFloat(): reused=%v fresh=%v", a, b)
	}
	if a, b := reused.NextDouble(), fresh.NextDouble(); a != b {
		t.Fatalf("NextDouble(): reused=%v fresh=%v", a, b)
	}
	if a, b := reused.NextBoolean(), fresh.NextBoolean(); a != b {
		t.Fatalf("NextBoolean(): reused=%v fresh=%v", a, b)
	}
}

// TestSetSeedRepeatable pins that reseeding to the same value twice (as
// CaveFeature's own multi-neighbour reseed loop does whenever two distinct
// neighbours happen to compute the same salted seed) produces the same draw
// sequence both times -- SetSeed has no hidden dependence on prior state.
func TestSetSeedRepeatable(t *testing.T) {
	r := New(7)
	r.SetSeed(555)
	first := [5]int32{}
	for i := range first {
		first[i] = r.NextInt()
	}
	r.SetSeed(555)
	for i := range first {
		if got := r.NextInt(); got != first[i] {
			t.Fatalf("draw %d after re-SetSeed(555): got %d, want %d (first pass)", i, got, first[i])
		}
	}
}

// TestIRandomWidenedMethodsOnInterface is a compile-time-flavored guard: it
// exercises SetSeed/GetSeed exclusively through the IRandom interface (not
// the concrete *Rand type), so a future refactor that accidentally drops one
// of these two methods back off the interface -- or off Rand -- fails a test
// immediately instead of silently only breaking whatever feature package
// happens to need it.
func TestIRandomWidenedMethodsOnInterface(t *testing.T) {
	var r IRandom = New(1)
	r.SetSeed(2)
	if got := r.GetSeed(); got != 2 {
		t.Fatalf("via IRandom: GetSeed() after SetSeed(2) = %d, want 2", got)
	}
}

// TestNextIntBoundZeroBoundDoesNotDraw pins the two halves of Rand.NextIntBound that mirror the
// engine's bounded integer draw: that a bound whose low 32 bits are zero returns 0 WITHOUT
// advancing the generator, and that the 32-bit test costs nothing for every bound that worked
// before it existed.
//
// The second half is the load-bearing one. This function sits on the RNG surface every feature
// places through, so "no digest moved" is only worth anything if the values are provably unchanged
// rather than merely observed unchanged on the packs we happen to have.
func TestNextIntBoundZeroBoundDoesNotDraw(t *testing.T) {
	for _, bound := range []int{1, 2, 3, 7, 16, 255, 256, 1000, 65536, 1 << 30, math.MaxInt32} {
		got := New(12345)
		want := mtrand.New(12345)
		for i := 0; i < 64; i++ {
			g, w := got.NextIntBound(bound), want.NextIntBound(bound)
			if g != w {
				t.Fatalf("bound %d, draw %d: shadowed %d, unshadowed %d -- the 32-bit zero test is "+
					"supposed to be inert for every bound that drew before it existed", bound, i, g, w)
			}
			if g < 0 || g >= bound {
				t.Fatalf("bound %d, draw %d: %d is outside [0, bound)", bound, i, g)
			}
		}
	}

	// A bound whose low 32 bits are zero returns 0 and leaves the generator where it was. The
	// engine returns from the zero-check without ever reaching the raw draw, so this is engine
	// behaviour and not only a guard against mtrand's modulus dividing by zero.
	// Verified by POSITION, not just by the returned value.
	baseline := New(99).NextIntBound(1000)
	r := New(99)
	if v := r.NextIntBound(math.MinInt64); v != 0 {
		t.Fatalf("NextIntBound(MinInt64) = %d, want 0", v)
	}
	if after := r.NextIntBound(1000); after != baseline {
		t.Fatalf("the zero-bound call consumed a draw: %d then %d", baseline, after)
	}

	// A negative bound still DRAWS -- only exactly zero skips. This is the half of
	// the engine's bounded integer draw that reports a non-fatal "n >= 0" assertion and then
	// carries on to the draw. The RETURN WIDTH of that path is a separate question this port
	// has not settled; see Rand.NextIntBound. What is pinned here is only that the draw happens.
	neg := New(7)
	before := neg.NextIntBound(-2)
	after := neg.NextIntBound(-2)
	if before == after {
		t.Fatalf("two draws with bound -2 returned the same value %d twice -- a negative bound "+
			"must still advance the generator", before)
	}
	unshadowed := mtrand.New(7)
	if v := neg.NextIntBound(-2); v != func() int {
		unshadowed.NextIntBound(-2)
		unshadowed.NextIntBound(-2)
		return unshadowed.NextIntBound(-2)
	}() {
		t.Fatalf("negative bound diverged from mtrand at the third draw: %d", v)
	}
}
