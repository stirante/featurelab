package features

import (
	"math"
	"sync"
)

// enginemath.go holds the game's own trigonometry, which is NOT libm.
//
// The game's sine and cosine are a 65536-entry float32 sine LOOKUP
// TABLE with no interpolation. A result is therefore snapped to one of
// 65536 samples per turn -- an error of order 1e-4 against a
// correctly-rounded sine, which is four orders of magnitude larger than
// every float-width question in the port.
//
// Not every trig use in the game goes through the table, and which ones
// do is not guessable from the algorithm. The table at the bottom of this
// file says which features use which; cave.go is the carver that
// deliberately does NOT use this file.
//
// ---------------------------------------------------------------------
// The lookup, step by step
// ---------------------------------------------------------------------
//
// The game's sine does exactly four things to its argument:
//
//  1. multiply by 10430.3779296875, the float32 with bit pattern
//     0x4622F983, IN FLOAT32 -- this is the scaled table index;
//  2. convert that float to an integer, TRUNCATING TOWARD ZERO;
//  3. mask the integer with 0xFFFF to wrap it into the table;
//  4. load that entry. No interpolation, no neighbour blend.
//
// The game's cosine is the identical sequence with one extra step
// between (1) and (2): add 16384.0f. 16384/65536 of a turn is pi/2, so
// cosine reads the sine table a quarter turn further on. The addition
// happens in float32 AFTER the scale multiply and BEFORE the truncation.
// Both facts matter: the order changes which entry is read.
//
// The three points a port gets wrong if it assumes:
//
//   - Step 2 truncates TOWARD ZERO. For a negative angle that is not
//     floor: -1.5 becomes -1, not -2. Combined with the mask it means a
//     negative angle is read from the far end of the table one entry
//     nearer to zero than a floor would give. Carver pitch and yaw both
//     go negative, so this is live, not theoretical.
//   - The mask applies to the two's-complement 32-bit result, so the
//     wrap is free and total: any index, however large or negative,
//     lands somewhere in the table. The float-to-int conversion itself
//     SATURATES rather than wrapping on overflow, which fcvtzs below
//     reproduces.
//   - There is NO interpolation. The load is a plain indexed read.
//
// ---------------------------------------------------------------------
// The table's CONTENTS
// ---------------------------------------------------------------------
//
// The table is filled at startup: for i = 0..65535 it computes
// (float32)i, DIVIDES by the same float32 10430.3779296875, and takes
// the single-precision sine (sinf) of the result.
//
// So SIN[i] == sinf(float32(i) / 10430.3779296875f).
//
// That is NOT sin(i * 2*pi / 65536), which is the natural guess. The game
// DIVIDES by the same float32 constant it later MULTIPLIES by, and
// 0x4622F983 is 65536/2pi only to float32 precision -- it is smaller than
// the exact value by about 4.0e-8 relative. Building the table with the
// exact turn instead skews every entry's angle by that ratio, worth up to
// ~2.5e-7 in the value near the end of the turn.
//
// The reciprocal-consistency is the point. Because the same constant
// builds and indexes the table, the game's sine of x is exactly
// `sinf(trunc(x*K)/K)` -- the argument is snapped to a grid defined by K
// itself, not to a grid defined by 2*pi.
//
// (A sibling project implements this same quantisation for Molang's sine
// and elastic easings, with the same index arithmetic but the
// `i * 2*pi / 65536` contents. Its table should be corrected the same
// way, and the two really ought to be one shared implementation -- this
// file is a deliberate local copy so that fixing featurelab did not
// require editing a sibling checkout mid-flight.)

// engineSinScale is 0x4622F983 = 10430.3779296875, the float32 constant
// the game both divides by to BUILD the table and multiplies by to
// INDEX it.
var engineSinScale = math.Float32frombits(0x4622F983)

const (
	engineSinTableSize = 1 << 16
	engineSinTableMask = engineSinTableSize - 1

	// engineCosQuarterTurn is the 16384.0f cos adds to the scaled index:
	// 16384/65536 of a turn is pi/2.
	engineCosQuarterTurn float32 = 16384
)

// engineSinTable is the game's sine table, built the way the game
// builds it.
//
// Built lazily. 65536 sines is around a millisecond, and a run that
// touches no nether carver, no fancy tree, no mega tree and no ore vein
// never needs it at all.
var engineSinTable = sync.OnceValue(func() []float32 {
	t := make([]float32, engineSinTableSize)
	for i := range t {
		// float32(i) / engineSinScale is the integer-to-float convert
		// followed by the divide, both in float32; math.Sin of the
		// widened result then narrowed models sinf, which is correctly rounded to well under an ulp.
		t[i] = float32(math.Sin(float64(float32(i) / engineSinScale)))
	}
	return t
})

// fcvtzs models the game's float-to-int32 conversion: round toward
// zero, NaN to 0, and SATURATE at the int32 limits rather than wrapping.
//
// Saturation is architecture-defined, not a guess. It is reachable here:
// a Molang-driven width modifier or a pathological JSON number can push
// an angle past 2^31/10430 ~= 2.06e5 radians, and the difference between
// saturating and wrapping is which table entry gets read.
func fcvtzs(v float32) int32 {
	switch {
	case math.IsNaN(float64(v)):
		return 0
	case float64(v) >= 2147483648:
		return math.MaxInt32
	case float64(v) < -2147483648:
		return math.MinInt32
	}
	return int32(v)
}

// engineSinTableAt performs the mask + indexed load on an already-scaled
// index. The mask is what makes a negative angle work: it is a 32-bit
// two's-complement mask, so -1 reads entry 65535.
func engineSinTableAt(index float32) float32 {
	return engineSinTable()[uint32(fcvtzs(index))&engineSinTableMask]
}

// EngineSin is the game's own sine: sin(radians) read out of the
// game's 65536-entry table. It is deliberately NOT math.Sin -- see this
// file's header, and the table below for which features reach it.
//
// The explicit float32() around the product is not decoration: Go is
// permitted to fuse a multiply into a following add "possibly across
// statements", and gc does exactly that on arm64. The game computes the
// multiply and the add separately, so a fused build would round
// differently. An explicit conversion forbids the fusion.
func EngineSin(radians float32) float32 {
	return engineSinTableAt(float32(radians * engineSinScale))
}

// EngineCos is the game's own cosine: the same table read a quarter
// turn further along, with the 16384 added in float32 after the scale
// multiply and before the truncation.
func EngineCos(radians float32) float32 {
	return engineSinTableAt(float32(radians*engineSinScale) + engineCosQuarterTurn)
}

// WHICH FEATURES REACH THE TABLE, AND WHICH REACH LIBM.
//
// The split is per-feature and cannot be guessed from the shape of the
// algorithm -- the overworld cave carver and the nether cave carver
// compute their tunnel walk with the SAME arithmetic and use different
// sines. Only these worldgen features use the table:
//
//	TABLE (the game's own sine/cosine)
//	  the nether cave carver's tunnel step
//	      three sines (one of them the taper) and two cosines
//	  the fancy trunk's placement      one sine, one cosine
//	  the mega trunk's placement       one sine, one cosine
//	  the ore feature's placement      two sines, one cosine
//
//	LIBM (sinf/cosf)
//	  the cave carver's room step      one sinf
//	  the cave carver's tunnel step
//	      three sinf (one of them the taper) and two cosf
//
// The split holds in the current target game version.
//
// No other feature type computes a sine at all.
