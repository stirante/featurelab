// Package random is the Bedrock RNG surface features place through — the
// engine's core RNG, as a thin wrapper around molang-go/mtrand.Rand (already a
// byte-exact implementation of the same generator) that adds the two output
// methods mtrand.Rand doesn't need for its own purposes (NextDouble,
// NextBoolean) so this type covers the whole IRandom surface below.
//
// mtrand.Rand already satisfies molang-go/eval.RNG (NextFloat/NextIntBound),
// so a *Rand here can be passed directly as a molang-go Context's RNG field
// — math.random*/math.die_roll* draw from the exact same generator instance
// features place through, honouring the "math.random* MUST draw from
// ctx.Random" contract.
package random

import "github.com/stirante/molang-go/mtrand"

// IRandom is the RNG surface a feature is allowed to touch — the ordinary
// draw methods, PLUS SetSeed/GetSeed (widened for the cave carver -- see
// below; every other feature in this codebase still just constructs a fresh
// Rand instead of reseeding one in place, and is completely unaffected by this
// widening).
//
// Widening history: this interface deliberately had no SetSeed/GetSeed until
// the cave carver's placement routine needed both: it reads its OWN
// ctx.Random's current seed (a stored scalar field -- NOT derivable from the
// twister state, and costing no draw), draws two ordinary unbounded integer
// draws (the same no-bound draw NextInt() already models) from that SAME
// generator, then reseeds that SAME generator object in place, once per
// neighbour chunk it visits, through the engine's reseed (already byte-exact
// in mtrand.Rand.SetSeed -- see that method's doc comment for the
// seeding recurrence). Because the real engine mutates
// the CALLER's generator object (not a throwaway copy), and further draws
// happen against it afterward
// (either later in the same place() call or a subsequent RepeatCount
// iteration sharing the same rnd -- see session.go), constructing a fresh
// random.New(seed) per neighbour is NOT equivalent: it would leave the
// original ctx.Random's state wrong after place() returns. Hence SetSeed
// belongs on the interface, not just on the concrete type.
//
// No world seed or chunk-coordinate field was needed on wgen.PlacementContext:
// the per-neighbour seed formula derives entirely from ctx.Random's own
// current seed plus two further draws from that same generator, and the
// current chunk's coordinates are already recoverable from ctx.Origin
// (floor-divide by 16) -- see cave.go's header for the full formula.
type IRandom interface {
	// NextInt is the engine's unbounded integer draw: a full [0, 2^31-1] draw.
	NextInt() int32
	// NextIntBound is the engine's bounded integer draw: [0, bound). A bound whose
	// low 32 bits are zero returns 0 WITHOUT drawing -- the engine's
	// parameter is a 32-bit int and its zero-check is made on that 32-bit
	// value, so the test is 32-bit here too. See Rand.NextIntBound,
	// which is where this port has to say so explicitly because Go's `int`
	// is 64 bits wide.
	NextIntBound(bound int) int
	NextFloat() float64
	NextDouble() float64
	NextBoolean() bool
	// NextUnsignedInt is the engine's raw unsigned draw over n: a RAW 32-bit
	// twister draw modulo n, NOT the 31-bit integer draw's value: it is one raw
	// draw modulo the argument. Added for single_block_feature's
	// randomize_rotation, which asks for a bound of 4.
	//
	// n == 0 DRAWS and returns the raw draw unreduced. A zero argument trips
	// the engine's "n > 0" assertion, which is not fatal: execution continues
	// into the same draw-and-remainder step every other bound takes, and the
	// engine's unsigned remainder by zero leaves the drawn value untouched.
	// There is no crash to avoid, and skipping the draw would be a DRAW-COUNT
	// divergence rather than a value one.
	//
	// Note this is the opposite of the sibling: the bounded integer draw with a
	// bound of 0 returns 0 without drawing. The two are otherwise the same
	// function and they disagree on exactly this input, so neither answer may be
	// carried across to the other by analogy.
	NextUnsignedInt(bound uint32) uint32
	// SetSeed reseeds the generator IN PLACE -- the engine's reseed. Added for
	// the cave carver's per-neighbour-chunk reseed; see this interface's own doc
	// comment. Every existing feature is unaffected: none of them call it.
	SetSeed(seed uint32)
	// GetSeed is the engine's stored-seed read: returns the seed last passed to
	// New/SetSeed, NOT anything derived from the current twister state (the real
	// engine stores it as a separate scalar field -- see this interface's own
	// doc comment). Added for the same reason as SetSeed.
	GetSeed() uint32
}

// Rand is Bedrock's core RNG, as consumed by feature
// placement. Embeds *mtrand.Rand for NextInt/NextIntBound/NextFloat/
// NextUint32/SetSeed, and adds NextDouble/NextBoolean on top. NextDouble is
// NOT a wider-precision draw (it uses the same single-draw * 2^-32 formula as
// NextFloat) and NextBoolean reads bit 27 of one raw 32-bit draw.
type Rand struct {
	*mtrand.Rand
	// seed is the value last passed to New/SetSeed -- mirrors the engine's
	// stored seed field, which the cave carver reads; see IRandom.GetSeed's doc
	// comment. mtrand.Rand itself has no way to
	// recover this once the twister state has advanced, so it has to be tracked
	// here, alongside it.
	seed uint32
}

// New returns a Rand seeded with seed, ready to draw from.
func New(seed uint32) *Rand {
	return &Rand{Rand: mtrand.New(seed), seed: seed}
}

// SetSeed reseeds the generator in place -- the engine's reseed.
// Shadows the embedded *mtrand.Rand.SetSeed (which does the actual
// reseeding, already byte-exact) purely to additionally remember seed for
// GetSeed.
func (r *Rand) SetSeed(seed uint32) {
	r.Rand.SetSeed(seed)
	r.seed = seed
}

// GetSeed is the engine's stored-seed read -- see IRandom.GetSeed's doc comment.
func (r *Rand) GetSeed() uint32 { return r.seed }

// NextIntBound is the engine's bounded integer draw. Shadows the embedded *mtrand.Rand.NextIntBound
// to make the "is the bound zero" test 32 bits wide, the way the engine's own is.
//
// mtrand's body is `if bound == 0 { return 0 }; return int(NextUint32() % uint32(bound))`. The
// guard reads all 64 bits of Go's `int`; the modulus reads the low 32. For any bound that is a
// nonzero multiple of 2^32 those two disagree -- uint32(4294967296) is 0, and so is
// uint32(math.MinInt64) -- and the modulus divides by zero, which is
// `panic: runtime error: integer divide by zero` and takes the whole process down. Neither the
// CLI's nor serve's recover path can turn that into a diagnostic: session.go's recover re-panics
// anything that is not one of its three budget errors.
//
// This was not hard to reach from a pack. Go's `int(f)` on a float64 outside int64's range is
// implementation-defined and yields math.MinInt64 on amd64, so EVERY out-of-range number a pack
// author can write -- 1e19, 1e300, -1e300 -- arrives here as MinInt64, whose low 32 bits are
// zero. The observed reproductions were `"skip_carve_chance": -9223372036854775808` and
// `"height_limit": -9223372036854775808` on a cave carver, and the same shape reaches this
// function from single_block_feature's `places_block[].weight` (via WeightedPick), from
// growing_plant_feature's `height_distribution` and `age`, and from scatter_feature's
// `scatter_chance` denominator, `extent` and `step_size`.
//
// The 32-bit test is what the engine does, not a repair invented here: the engine's bound is a
// 32-bit int, and the zero-check is made on that 32-bit value. A value of 4294967296 has already
// been truncated to 0 before the draw ever runs. Go's wider `int` is what let a value the engine
// cannot even hold get as far as the modulus.
//
// It is also engine behaviour, not merely this port's contract, that **a zero bound returns 0 and
// does NOT draw.** The zero-check returns zero without reaching the raw draw. So
// `skip_carve_chance: 0` and `skip_carve_chance: 1` really do leave the generator in different
// positions in the game too, exactly as they do here. The engine's raw unsigned draw does the
// OPPOSITE on zero -- see IRandom.NextUnsignedInt's doc comment.
//
// PROVABLY INERT for every bound that works today, and that is worth spelling out because it is a
// change to the RNG: uint32(bound) == uint32(int32(bound)) for every int, so the DRAWN VALUE this
// returns is bit-identical to what mtrand returned before, for every bound where mtrand returned
// at all. The only inputs whose behaviour changes are the ones that used to panic. In particular
// the deliberate negative-bound wrap tree.go's random_spread_canopy header argues for (a negative
// canopy_radius wrapping to a huge uint32, kept because the engine wraps the same way) still
// draws and still wraps: int32(-2) is not 0.
//
// The SIGN of that wrap is a SECOND narrowing this function does NOT do, deliberately, and the
// reason is worth having here. tree.go's header inferred that the engine's bounded integer draw
// "almost certainly does the identical (unsigned)bound idiom", and it does: the divide and the
// remainder are unsigned throughout, which is precisely mtrand's
// `NextUint32() % uint32(bound)`. But the engine then returns the result as a 32-bit SIGNED int,
// while mtrand returns `int(<uint32>)` into Go's 64-bit int, which ZERO-EXTENDS. For every non-negative
// bound those are the same number (the remainder is below the bound and so below 2^31). For a
// negative bound they are not: uint32(-2) wraps to 2^32-2, the remainder is very nearly the raw
// draw, and its top bit is set about half the time -- where the engine's caller would see -16,
// this hands back 4294967280.
//
// Adding `int(int32(...))` here was written, measured and REVERTED, which is the useful part. It
// is inert for every non-negative bound, so nothing a feature does moves. It moves 13 golden
// chains, and all 13 are Molang: scatter features whose `x_offset` expression is
// `math.random_integer(-<width>+1, -1)` with `<width>` unset in this bench, so the bound is
// `high-low+1` = -1. In other words the change re-pins the baseline entirely on the half of the
// claim that was then unsettled -- whether the engine's Molang `math.random_integer` reaches the
// bounded integer draw, returning a signed int, or the raw unsigned draw, returning an unsigned
// 32-bit value and converting it as unsigned. The golden digest this project is pinned against
// produces the 4-billion value, which reads like weak evidence for the unsigned route.
//
// UPDATE, and it retires both halves of that question: the engine's Molang math.random_integer
// reaches NEITHER draw. It takes a FLOAT draw and does arithmetic on it --
// floor((1-r)*lo + r*(hi + (1 - hi*2^-23))), with lo/hi the min/max of the two arguments and a
// final upper-bound-first clamp. For math.random_integer(1, -1), the shape those 13 chains
// actually contain, that yields a value in [-1, 1]. The engine never produces a 4-billion value
// there, so the digest's agreement with the unsigned route is evidence about this project's own
// output and nothing else.
//
// Not acted on here, on purpose. Switching molang-go to a float draw changes WHICH draw is
// consumed, so every placement downstream of one moves, and those chains re-pin. That is a
// decision with a cost, not a cleanup, and should be weighed before spending that cost.
func (r *Rand) NextIntBound(bound int) int {
	if int32(bound) == 0 {
		return 0
	}
	return r.Rand.NextIntBound(bound)
}

// NextDouble is the double draw in the engine's core RNG — it uses the exact same single-draw, *2^-32 formula as the float draw (not a 53-bit
// two-draw scheme), despite the wider return type.
func (r *Rand) NextDouble() float64 {
	return float64(r.NextUint32()) * invTwo32
}

// NextBoolean is the engine's boolean draw = (one raw draw >> 27) & 1.
func (r *Rand) NextBoolean() bool {
	return (r.NextUint32()>>27)&1 == 1
}

// NextUnsignedInt is the engine's raw unsigned draw over n = one raw 32-bit draw % n -- see
// IRandom.NextUnsignedInt's doc comment for what n == 0 does and why the zero case is written the
// way it is rather than simply falling into the modulus.
func (r *Rand) NextUnsignedInt(bound uint32) uint32 {
	if bound == 0 {
		// In the engine the remainder by zero leaves the dividend unchanged, so the draw is
		// returned unreduced. Go has no
		// such definition -- `% 0` panics -- so the arithmetic is spelled out instead of
		// performed.
		// Provably unreachable today: both production callers pass a literal 4
		// (features/single_block.go and features/multi_block.go, randomize_rotation).
		return r.NextUint32()
	}
	return r.NextUint32() % bound
}

const invTwo32 = 2.3283064365386963e-10

var _ IRandom = (*Rand)(nil)
