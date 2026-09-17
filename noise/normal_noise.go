// Package noise ports Bedrock's normal-noise generator and the classic
// two-octave "Perlin" (Ken Perlin's public-domain ImprovedNoise, which Bedrock
// reimplements) worldgen noise it is built from, as a standalone,
// independently testable unit. Game version 1.26.40 throughout. This is NOT
// the noise behind query.noise: molang-go/worldgen's SimplexNoise is a
// structurally different, unrelated gradient-noise class -- see that package's
// header.
//
// WHY THIS EXISTS ON ITS OWN: the geode feature's placement routine constructs
// a normal-noise generator unconditionally, before any schema-gated branch (see
// features/coverage.go's minecraft:geode_feature entry). That construction
// alone was significant enough, and structurally independent enough of geode's
// own schema, to justify porting and testing it in isolation first. Cave
// carvers, which carve noise-based tunnels, are expected to need the same
// infrastructure. This package implements ONLY the noise generator; it is not
// wired into features/ or goldentest by this change, and
// geode_feature/cave_carver_feature remain unimplemented.
//
// The normal-noise generator's normalised sample runs the IDENTICAL per-octave
// loop as the standalone multi-octave noise, so both are served by
// MultiOctaveNoise.sample here. Skipping an octave burns n RAW generator draws,
// discarded -- NOT bounded/float/double draws.
//
// CONSTRUCTION ALGORITHM (LEGACY MODE ONLY -- see below):
//
// The single-octave improved-noise constructor draws exactly 3 double draws
// for xo/yo/zo, each `float32(NextDouble() * 256.0)` (the multiply happens in
// double precision; the RESULT is immediately narrowed to float32 for storage
// -- see the Precision section below), followed by the textbook Fisher-Yates
// permutation shuffle: 256 sequential bounded integer draws with bound running
// 256,255,...,1, `j := i + nextIntBound(256-i); p[i],p[j] = p[j],p[i]`. The
// table is 256 bytes, NOT the classic doubled-to-512 table Java's
// ImprovedNoise uses -- Bedrock instead masks every intermediate
// permutation-table index with a uint8 cast at each lookup, which is
// mathematically equivalent to the doubled-table trick. That is exactly 259
// draws (3 + 256) for one octave.
//
// The multi-octave constructor's legacy mode does NOT build one octave per
// amplitude entry. It builds octaves for the octave-index range
// [0, -firstOctave] INCLUSIVE (-firstOctave+1 slots total), independent of how
// many amplitude entries were actually supplied:
//
//  1. Build ONE improved-noise octave UNCONDITIONALLY, before any amplitude
//     check -- 259 draws, always. Its candidate slot is topSlot :=
//     -firstOctave.
//  2. Walk slot i from topSlot-1 down to 0 (exactly -firstOctave
//     iterations): if i is outside [0, len(amplitudes)) OR amplitudes[i]
//     is exactly zero, burn 262 RAW draws (NOT bounded/double-shaped
//     draws), discarded, no octave stored. Otherwise build a REAL octave
//     (259 draws: 3 double + 256 bounded) and store it at slot i.
//  3. AFTER that loop, separately: if topSlot falls inside
//     [0, len(amplitudes)) and amplitudes[topSlot] is nonzero, store the
//     step-1 octave (already drawn, at zero extra cost) at slot topSlot.
//     Otherwise step 1's 259 draws are simply discarded -- consumed from
//     the RNG stream but never used for anything.
//  4. Compact the occupied slots (in ascending index order) into the final
//     octave list. No RNG draws in this step.
//
// So the shape is "one octave attempted per octave-index slot in
// [0,-firstOctave], each EITHER a real 259-draw build (if that slot maps into
// a nonzero amplitudes[] entry) OR a 262-raw-draw skip -- PLUS one extra
// always-drawn (and only SOMETIMES stored) 259-draw octave up front." For a
// length-1 amplitudes array with firstOctave < 0 (e.g. geode's [-4, {1.0}]),
// most slots are skips, not builds, and the always-drawn leading octave is
// USUALLY discarded rather than stored -- both facts a naive
// "amplitudes.length iterations" reading would miss entirely. For that config
// each multi-octave instance makes TWO 259-draw builds (one
// always-drawn-and-discarded, one real), for 2 x 259 = 518 bounded/double-shaped
// draws PER INSTANCE -- so the full normal-noise construction (two instances)
// makes 1036 such draws, not 518, BEFORE counting the additional RAW burned
// draws: 3 skips x 262 draws x 2 multi-octave instances = 1572 more raw
// generator steps. Grand total: 1036 + 1572 = 2608 RNG-stream advances that a
// byte-exact replay of the geode feature's placement RNG stream would need to
// reproduce for this config. This package's own tests pin the FULL sequence
// (kind, order, and count -- see normal_noise_test.go's
// TestDrawSequence_GeodeShapedConfig and TestGeodeDrawTotal)
// for exactly this geode-shaped config (firstOctave=-4, amplitudes=[1.0]), not
// just the total.
//
// POSITIONAL MODE IS NOT PORTED. The multi-octave constructor has a second
// mode (hash-based "octave_<n>" per-octave seeding) that is unrelated in shape
// to the legacy mode above; the geode feature uses legacy mode, which is also
// the only mode this package implements. There is deliberately no mode
// parameter on New: passing anything but legacy construction is out of scope,
// not silently approximated.
//
// PRECISION: the xo/yo/zo offset draws use a genuine double-precision draw,
// multiplied by 256.0 in double precision, and ONLY THEN narrowed to float32
// for storage. Every other operation -- permutation shuffle indices (integers,
// exact), coordinate floor/frac decomposition, the fade curve
// (t*t*t*(t*(6t-15)+10)), the gradient dot products, all lerp nesting, the
// per-octave frequency/persistence weighting, and the first+second
// normal-noise combination -- is float32 throughout (single-precision floor
// and absolute value, not their double forms). This is NOT the Molang VM's
// float32 rule leaking in by assumption -- it is a property of this noise
// family's float32 variant, which is the one the geode feature uses; a
// double-precision variant also exists for other callers and is not ported.
//
// REFERENCE VALUE: seeding a java.util.Random-algorithm RNG (multiplier
// 0x5DEECE66D, increment 11, seed^0x5DEECE66D init, 48-bit state -- NOT this
// codebase's usual mtrand-based core RNG) with 42, building a single
// improved-noise octave directly (no multi-octave wrapper) and sampling a
// 21x21x21 grid of normalised samples for x,y,z each 1..21, the sample at grid
// index (10,10,10) -- i.e. the normalised sample at (11,11,11) -- equals
// 0.131890235 (tolerance 0.0001). Since MultiOctaveNoise(firstOctave=0,
// amplitudes=[1.0]) degenerates EXACTLY to a bare improved-noise octave
// (topSlot=0, the legacy-mode skip loop never runs because firstOctave is not
// < 0, and the single always-drawn leading octave gets stored at octave index
// 0 with frequency=2^0=1 and weight=1*persistenceFactor(N=1)=1), this
// package's TestSampleMatchesReferenceValue reproduces that exact value using a
// Go port of that simple RNG, validating BOTH this port's single-octave
// construction AND its sampling math end to end. No equivalent reference value
// is known for the multi-octave or normal-noise generators in LEGACY mode, so
// the multi-octave skip/burn/compaction algorithm above, and the two-set
// normal-noise combination (inputFactor + valueFactor), are not pinned by an
// independent value -- documented here rather than silently assumed correct.
package noise

import "math"

// Random is the RNG surface NormalNoise/MultiOctaveNoise construction
// needs. featurelab-go/random.Rand satisfies this directly (NextDouble is
// defined on Rand itself; NextIntBound and NextUint32 come from its
// embedded *mtrand.Rand) -- no adapter required for production callers.
type Random interface {
	// NextDouble is the double draw in the engine's core RNG.
	NextDouble() float64
	// NextIntBound is the engine's bounded integer draw.
	NextIntBound(bound int) int
	// NextUint32 is the raw generator step, needed only for the
	// draw-burning helper's literal "call it N times, discard" behavior.
	NextUint32() uint32
}

func consumeCount(r Random, n int) {
	for i := 0; i < n; i++ {
		r.NextUint32()
	}
}

// gradient is the engine's improved-noise gradient table -- identical to the public-domain Ken Perlin "improved noise"
// 16-entry gradient table.
var gradient = [16][3]float32{
	{1, 1, 0}, {-1, 1, 0}, {1, -1, 0}, {-1, -1, 0},
	{1, 0, 1}, {-1, 0, 1}, {1, 0, -1}, {-1, 0, -1},
	{0, 1, 1}, {0, -1, 1}, {0, 1, -1}, {0, -1, -1},
	{1, 1, 0}, {0, -1, 1}, {-1, 1, 0}, {0, -1, -1},
}

func fade(t float32) float32 {
	return t * t * t * (t*(t*6-15) + 10)
}

func lerp(t, a, b float32) float32 {
	return a + t*(b-a)
}

func grad(hash int, x, y, z float32) float32 {
	g := gradient[hash&0xF]
	return g[0]*x + g[1]*y + g[2]*z
}

// improvedNoise is the engine's single improved-noise octave -- a single
// classic-Perlin ("Ken Perlin ImprovedNoise") octave: an offset triple plus a
// 256-entry shuffled permutation table.
type improvedNoise struct {
	xo, yo, zo float32
	perm       [256]byte
}

// newImprovedNoise is the improved-noise octave's constructor:
// exactly 3 double draws (xo, yo, zo, each
// float32(NextDouble()*256.0)) followed by the 256-draw Fisher-Yates
// permutation shuffle (a bounded integer draw, bound 256 downto 1).
func newImprovedNoise(r Random) *improvedNoise {
	n := &improvedNoise{
		xo: float32(r.NextDouble() * 256.0),
		yo: float32(r.NextDouble() * 256.0),
		zo: float32(r.NextDouble() * 256.0),
	}
	for i := range n.perm {
		n.perm[i] = byte(i)
	}
	for i := 0; i < 256; i++ {
		j := i + r.NextIntBound(256-i)
		n.perm[i], n.perm[j] = n.perm[j], n.perm[i]
	}
	return n
}

func (n *improvedNoise) hashAt(i int) int {
	return int(n.perm[i&0xFF])
}

// sample is the improved-noise octave's normalised sample composed with its
// gradient/fade/lerp sampling math
// -- the classic Ken Perlin ImprovedNoise algorithm (fade curve
// t*t*t*(t*(6t-15)+10), trilinear interpolation over 8 lattice corners,
// gradient dot products via the 16-entry table above). All float32, per
// this package's Precision doc comment.
func (n *improvedNoise) sample(x, y, z float32) float32 {
	xx := x + n.xo
	yy := y + n.yo
	zz := z + n.zo
	fx := float32(math.Floor(float64(xx)))
	fy := float32(math.Floor(float64(yy)))
	fz := float32(math.Floor(float64(zz)))
	X, Y, Z := int(fx), int(fy), int(fz)
	xf, yf, zf := xx-fx, yy-fy, zz-fz

	A, B := n.hashAt(X)+Y, n.hashAt(X+1)+Y
	AA, AB := n.hashAt(A)+Z, n.hashAt(A+1)+Z
	BA, BB := n.hashAt(B)+Z, n.hashAt(B+1)+Z

	u, v, w := fade(xf), fade(yf), fade(zf)

	x1 := lerp(u, grad(n.hashAt(AA), xf, yf, zf), grad(n.hashAt(BA), xf-1, yf, zf))
	x2 := lerp(u, grad(n.hashAt(AB), xf, yf-1, zf), grad(n.hashAt(BB), xf-1, yf-1, zf))
	y1 := lerp(v, x1, x2)

	x3 := lerp(u, grad(n.hashAt(AA+1), xf, yf, zf-1), grad(n.hashAt(BA+1), xf-1, yf, zf-1))
	x4 := lerp(u, grad(n.hashAt(AB+1), xf, yf-1, zf-1), grad(n.hashAt(BB+1), xf-1, yf-1, zf-1))
	y2 := lerp(v, x3, x4)

	return lerp(w, y1, y2)
}

// octave is one entry of the engine's multi-octave noise: an
// improvedNoise plus the per-octave frequency/amplitude/weight metadata
// computed at construction time.
type octave struct {
	noise     *improvedNoise
	frequency float32 // 2^(firstOctave+i), computed in double then narrowed
	weight    float32 // amplitudes[i] * persistenceFactor
}

// MultiOctaveNoise is the engine's multi-octave noise over improved-noise
// octaves, LEGACY MODE ONLY -- see this package's doc comment for why
// positional mode is out of scope. This is Bedrock's "one octave set" (what
// Java calls PerlinNoise); NormalNoise pairs two of these together.
type MultiOctaveNoise struct {
	octaves []octave
}

// NewMultiOctaveNoise is the multi-octave noise's constructor, legacy-mode
// mode only (see package doc for the full algorithm and why it is not "one
// octave per amplitude entry").
// amplitudes must be non-empty; firstOctave is normally <= 0 (the game
// reports "Positive octaves not supported at the moment" when it is not, but
// carries on; this port mirrors that rather than rejecting the call, since
// the message does not change the engine's actual behavior).
func NewMultiOctaveNoise(r Random, firstOctave int, amplitudes []float32) *MultiOctaveNoise {
	n := len(amplitudes)
	if n == 0 {
		return &MultiOctaveNoise{}
	}

	// Step 1: ALWAYS build one octave, unconditionally, before any
	// amplitude check (see package doc). Its candidate
	// slot is topSlot; it is stored ONLY if that slot is actually valid.
	discardable := newImprovedNoise(r)
	topSlot := -firstOctave

	slots := make([]*octave, n)

	// Step 2: walk slots topSlot-1 downto 0 -- exactly -firstOctave
	// iterations, independent of n.
	for i := topSlot - 1; i >= 0; i-- {
		if i >= n || amplitudes[i] == 0 {
			consumeCount(r, 262)
			continue
		}
		slots[i] = buildOctave(newImprovedNoise(r), firstOctave, i, n, amplitudes[i])
	}

	// Step 3: store the step-1 octave at topSlot, but only if that slot is
	// actually in range and its amplitude is nonzero -- otherwise its
	// draws are simply spent and discarded.
	if topSlot >= 0 && topSlot < n && amplitudes[topSlot] != 0 {
		slots[topSlot] = buildOctave(discardable, firstOctave, topSlot, n, amplitudes[topSlot])
	}

	// Step 4: compact occupied slots, in ascending index order. No draws.
	out := &MultiOctaveNoise{octaves: make([]octave, 0, n)}
	for i := 0; i < n; i++ {
		if slots[i] != nil {
			out.octaves = append(out.octaves, *slots[i])
		}
	}
	return out
}

func buildOctave(noise *improvedNoise, firstOctave, slot, n int, amplitude float32) *octave {
	octaveIndex := firstOctave + slot
	bitmaskInt := uint(1)<<uint(n) - 1
	persistenceNumInt := uint(1) << uint(n-1)
	persistence := float32(persistenceNumInt) / float32(bitmaskInt)
	return &octave{
		noise:     noise,
		frequency: float32(math.Pow(2, float64(octaveIndex))),
		weight:    amplitude * persistence,
	}
}

// Sample is the multi-octave noise's normalised sample: the sum, over every
// present octave, of
// improvedNoise.sample(x*frequency, y*frequency, z*frequency) * weight.
func (m *MultiOctaveNoise) Sample(x, y, z float64) float64 {
	return float64(m.sampleF32(float32(x), float32(y), float32(z)))
}

func (m *MultiOctaveNoise) sampleF32(x, y, z float32) float32 {
	var total float32
	for _, o := range m.octaves {
		total += o.noise.sample(x*o.frequency, y*o.frequency, z*o.frequency) * o.weight
	}
	return total
}

// inputFactor is NormalNoise's "second" octave-set coordinate scale.
// The engine uses it as a single float32 constant whose bits equal
// math.Float32bits(float32(1.0181268882175227)) exactly -- the public Java
// NormalNoise.INPUT_FACTOR, correctly rounded to float32, consistent with this
// class family being a reimplementation of it.
const inputFactor = float32(1.0181268882175227)

// NormalNoise is the engine's normal-noise generator over two multi-octave
// improved-noise sets -- Bedrock's two-octave-set classic Perlin noise
// (matches Java Edition's own NormalNoise class). See package
// doc for construction order, draw counts, precision, and validation
// status.
type NormalNoise struct {
	first, second *MultiOctaveNoise
	valueFactor   float32
}

// New is the normal-noise generator's constructor: builds "first" then
// "second" MultiOctaveNoise from the SAME Random (in that order -- both
// sub-constructions draw from one continuous stream, as the geode feature's
// placement does), then computes valueFactor from the amplitudes'
// own nonzero-index span. LEGACY MODE ONLY -- see package doc.
func New(r Random, firstOctave int, amplitudes []float32) *NormalNoise {
	first := NewMultiOctaveNoise(r, firstOctave, amplitudes)
	second := NewMultiOctaveNoise(r, firstOctave, amplitudes)
	return &NormalNoise{
		first:       first,
		second:      second,
		valueFactor: valueFactor(amplitudes),
	}
}

// oneThirdF32 is the exact IEEE-754 binary32 constant the normal-noise
// constructor uses for valueFactor's numerator -- float32(1.0/3.0), correctly
// rounded, NOT a truncated "0.33333".
var oneThirdF32 = math.Float32frombits(0x3EAAAAAB)

// valueFactor is the normal-noise constructor's tail computation, operation by
// operation:
//
//	(float)edge                  ; edge = maxIdx-minIdx, or 1 -- see below
//	edge+1                       (float32)
//	1/(edge+1)                   (float32)
//	1 + 1/(edge+1)               (float32)
//	denom = 0.1f * that          (float32; 0.1f as its exact float32 bits)
//	(double)(1/3f)               ; widened from the float32 constant above
//	0.5 * (double)(1/3f)         (float64!)
//	(double)denom
//	numerator / denom            (float64!)
//	single final rounding to float32
//
// So the denominator is float32 arithmetic, but the numerator constant and
// the final division are double precision, rounded to float32 exactly
// once. A naive `float32(0.5*0.33333) / denom` differs from this in the final
// float32 for every edge value tested -- at edge=0 by about 140 ULP.
func valueFactor(amplitudes []float32) float32 {
	minIdx, maxIdx := math.MaxInt32, math.MinInt32
	for i, a := range amplitudes {
		if a != 0 {
			if i < minIdx {
				minIdx = i
			}
			if i > maxIdx {
				maxIdx = i
			}
		}
	}
	edge := 1
	if minIdx <= maxIdx {
		edge = maxIdx - minIdx
	}
	// The minIdx > maxIdx (no nonzero amplitude) fallback of edge = 1 is the
	// engine's own. Unreached by any known real config.
	denom := float32(0.1) * (float32(1.0)/(float32(edge)+1.0) + float32(1.0))
	return float32((0.5 * float64(oneThirdF32)) / float64(denom))
}

// Sample is the normal-noise generator's normalised sample:
// (first.sample(x,y,z) + second.sample(x*inputFactor, ...)) * valueFactor.
func (n *NormalNoise) Sample(x, y, z float64) float64 {
	return float64(n.sampleF32(float32(x), float32(y), float32(z)))
}

func (n *NormalNoise) sampleF32(x, y, z float32) float32 {
	firstSum := n.first.sampleF32(x, y, z)
	secondSum := n.second.sampleF32(x*inputFactor, y*inputFactor, z*inputFactor)
	return (firstSum + secondSum) * n.valueFactor
}
