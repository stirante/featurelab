package noise

import (
	"math"
	"testing"

	"github.com/stirante/featurelab/random"
)

// --- draw-sequence recording -----------------------------------------------
//
// A local, self-contained recorder -- deliberately NOT reusing
// featurelab-go/random.Tracer, since that type feeds the golden digest and
// this package must not perturb TestGoldenDigest. This recorder captures
// every draw this package's construction code makes, in call order,
// distinguishing "double" (NextDouble), "intBound" (NextIntBound, with its
// bound), and "raw" (the raw NextUint32 draws consumeCount makes) so tests
// can assert the exact kind/order/count sequence, not just a total.

type drawKind int

const (
	drawDouble drawKind = iota
	drawIntBound
	drawRaw
)

type draw struct {
	kind  drawKind
	bound int
}

type recorder struct {
	inner *random.Rand
	draws []draw
}

func newRecorder(seed uint32) *recorder {
	return &recorder{inner: random.New(seed)}
}

func (r *recorder) NextDouble() float64 {
	r.draws = append(r.draws, draw{kind: drawDouble})
	return r.inner.NextDouble()
}

func (r *recorder) NextIntBound(bound int) int {
	r.draws = append(r.draws, draw{kind: drawIntBound, bound: bound})
	return r.inner.NextIntBound(bound)
}

func (r *recorder) NextUint32() uint32 {
	r.draws = append(r.draws, draw{kind: drawRaw})
	return r.inner.NextUint32()
}

var _ Random = (*recorder)(nil)

// expectSingleOctaveBuild appends the expected 259-draw sequence (3
// NextDouble, then NextIntBound(256) downto NextIntBound(1)) for one
// single improved-noise octave's construction.
func expectSingleOctaveBuild(want []draw) []draw {
	want = append(want, draw{kind: drawDouble}, draw{kind: drawDouble}, draw{kind: drawDouble})
	for bound := 256; bound >= 1; bound-- {
		want = append(want, draw{kind: drawIntBound, bound: bound})
	}
	return want
}

func expectSkip(want []draw) []draw {
	for i := 0; i < 262; i++ {
		want = append(want, draw{kind: drawRaw})
	}
	return want
}

// TestDrawSequence_SingleOctave pins NewMultiOctaveNoise(firstOctave=0,
// amplitudes=[1.0]) to EXACTLY one 259-draw build (3 NextDouble + 256
// NextIntBound, bounds 256 downto 1, in that order) and nothing else --
// this is the degenerate case where MultiOctaveNoise collapses to a bare
// single improved-noise octave (see package doc's "reference value"
// section).
func TestDrawSequence_SingleOctave(t *testing.T) {
	rec := newRecorder(1)
	NewMultiOctaveNoise(rec, 0, []float32{1.0})

	want := expectSingleOctaveBuild(nil)
	if len(rec.draws) != len(want) {
		t.Fatalf("draw count = %d, want %d", len(rec.draws), len(want))
	}
	for i, d := range want {
		if rec.draws[i] != d {
			t.Fatalf("draw[%d] = %+v, want %+v", i, rec.draws[i], d)
		}
	}
}

// TestDrawSequence_GeodeShapedConfig pins the EXACT draw sequence for
// NewMultiOctaveNoise(firstOctave=-4, amplitudes=[1.0]) -- the same
// (firstOctave, amplitudes) the geode feature's placement routine passes to
// the normal-noise constructor (features/coverage.go's
// minecraft:geode_feature entry). Per this package's doc comment, the algorithm is NOT
// "one 259-draw build" -- it is:
//
//  1. one ALWAYS-drawn 259-draw build (discarded for this config, since
//     topSlot=4 is not < len(amplitudes)=1)
//  2. three 262-raw-draw skips (octave indexes 3, 2, 1 -- all >=
//     len(amplitudes))
//  3. one REAL 259-draw build, stored at octave index 0
//
// Total: 259 + 3*262 + 259 = 1304 draws for ONE MultiOctaveNoise instance
// (geode's own NormalNoise builds two of these from the same Random, so
// 2608 total for the full NormalNoise construction -- see TestGeodeDrawTotal).
func TestDrawSequence_GeodeShapedConfig(t *testing.T) {
	rec := newRecorder(1)
	NewMultiOctaveNoise(rec, -4, []float32{1.0})

	var want []draw
	want = expectSingleOctaveBuild(want) // step 1: always-drawn, discarded
	want = expectSkip(want)              // octave index 3: skip
	want = expectSkip(want)              // octave index 2: skip
	want = expectSkip(want)              // octave index 1: skip
	want = expectSingleOctaveBuild(want) // octave index 0: real build

	if len(rec.draws) != len(want) {
		t.Fatalf("draw count = %d, want %d (259 + 3*262 + 259 = %d)",
			len(rec.draws), len(want), 259+3*262+259)
	}
	for i, d := range want {
		if rec.draws[i] != d {
			t.Fatalf("draw[%d] = %+v, want %+v", i, rec.draws[i], d)
		}
	}
}

// TestGeodeDrawTotal pins the total RNG-stream advances made by the geode
// feature's own normal-noise construction (NormalNoise(-4, [1.0])): 1036
// NextDouble/NextIntBound-shaped draws plus 1572 raw burned draws, 2608 in
// all. A byte-exact RNG-stream replay has to consume both kinds. The total is
// larger than the 2 x (3+256) = 518 that one 259-draw build per
// MultiOctaveNoise instance would give.
func TestGeodeDrawTotal(t *testing.T) {
	rec := newRecorder(1)
	New(rec, -4, []float32{1.0}) // NormalNoise: two MultiOctaveNoise builds

	total := len(rec.draws)
	const oneBuildPerInstance = 2 * (3 + 256) // 518 -- the total if each of the
	// two MultiOctaveNoise instances did exactly one 259-draw build.
	if total == oneBuildPerInstance {
		t.Fatalf("draw total %d matches the one-build-per-instance count of 518; "+
			"this construction should draw more", total)
	}

	wantedByMethodShape := 0
	wantedRaw := 0
	for _, d := range rec.draws {
		if d.kind == drawRaw {
			wantedRaw++
		} else {
			wantedByMethodShape++
		}
	}
	// Each MultiOctaveNoise instance does TWO 259-draw builds (one
	// always-drawn-and-discarded, one real) for this config, not one -- so
	// the NextDouble/NextIntBound-shaped total is double the
	// one-build-per-instance count, even before counting the raw consumeCount
	// draws.
	const wantMethodShaped = 2 * 2 * (3 + 256) // 1036
	if wantedByMethodShape != wantMethodShaped {
		t.Fatalf("NextDouble/NextIntBound-shaped draws = %d, want %d (two builds per instance)",
			wantedByMethodShape, wantMethodShaped)
	}
	const wantRaw = 2 * 3 * 262 // 2 MultiOctaveNoise instances x 3 skips x 262 = 1572
	if wantedRaw != wantRaw {
		t.Fatalf("raw consumeCount draws = %d, want %d", wantedRaw, wantRaw)
	}
	if total != wantMethodShaped+wantRaw {
		t.Fatalf("total draws = %d, want %d (=%d + %d)", total, wantMethodShaped+wantRaw, wantMethodShaped, wantRaw)
	}
	t.Logf("NormalNoise(-4,[1.0]) construction: %d NextDouble/NextIntBound-shaped draws + %d raw consumeCount draws = %d total",
		wantedByMethodShape, wantedRaw, total)
}

// --- sample-value pinning against a reference value ------------------------
//
// javaLCG is a from-scratch Go port of java.util.Random, which Bedrock's own
// simple RNG matches bit-for-bit: multiplier 0x5DEECE66D, increment 0xB, seed
// initialized to seed^0x5DEECE66D, 48-bit state. It exists ONLY to reproduce
// the reference value below -- it is
// NOT the production RNG (that is featurelab-go/random.Rand, an
// mtrand-based port of the engine's core RNG, algorithmically unrelated to
// this LCG) and must never be used outside this test file.

type javaLCG struct {
	seed uint64
}

func newJavaLCG(seed int64) *javaLCG {
	return &javaLCG{seed: (uint64(seed) ^ 0x5DEECE66D) & ((1 << 48) - 1)}
}

func (j *javaLCG) next(bits uint) int32 {
	j.seed = (j.seed*0x5DEECE66D + 0xB) & ((1 << 48) - 1)
	return int32(j.seed >> (48 - bits))
}

func (j *javaLCG) NextDouble() float64 {
	hi := int64(j.next(26))
	lo := int64(j.next(27))
	return float64((hi<<27)+lo) * (1.0 / float64(int64(1)<<53))
}

func (j *javaLCG) NextIntBound(bound int) int {
	if bound <= 0 {
		return 0
	}
	if bound&(bound-1) == 0 { // power of two
		return int((int64(bound) * int64(j.next(31))) >> 31)
	}
	for {
		bits := j.next(31)
		val := bits % int32(bound)
		if bits-val+int32(bound-1) >= 0 {
			return int(val)
		}
	}
}

func (j *javaLCG) NextUint32() uint32 {
	return uint32(j.next(32))
}

var _ Random = (*javaLCG)(nil)

// TestSampleMatchesReferenceValue reproduces the engine's reference noise
// value: the simple RNG seeded with 42, a single-octave noise (which
// NewMultiOctaveNoise(firstOctave=0, amplitudes=[1.0]) degenerates to
// exactly -- see package doc), sampled at grid point (11,11,11) (a 21x21x21
// grid indexing x,y,z each 1..21; the value is at flat index
// 4630 = 10*441+10*21+10, i.e. x=y=z=11). The engine's value is 0.131890235
// within 0.0001 -- this test uses the SAME tolerance, so it validates this
// port's construction AND its sampling math end-to-end, not merely "a
// plausible number."
func TestSampleMatchesReferenceValue(t *testing.T) {
	rng := newJavaLCG(42)
	mn := NewMultiOctaveNoise(rng, 0, []float32{1.0})

	got := mn.Sample(11, 11, 11)
	const want = 0.131890235
	const tol = 0.0001
	if math.Abs(got-want) > tol {
		t.Fatalf("Sample(11,11,11) = %v, want %v +/- %v", got, want, tol)
	}
}

// TestSample_Deterministic pins a regression value for this port's own
// production-RNG path (featurelab-go/random.Rand, seed 12345, geode-shaped
// NormalNoise(-4, [1.0])), so a future refactor cannot silently drift the
// sampling math even though no independent reference value exists for
// legacy-mode NormalNoise (see package doc's Reference value section). The
// expected value below was computed BY THIS IMPLEMENTATION, then pinned --
// it is a regression guard, not an independently-sourced reference value.
func TestSample_Deterministic(t *testing.T) {
	nn := New(random.New(12345), -4, []float32{1.0})
	got := nn.Sample(10, 20, 30)
	// Re-pinned 2026-08 when valueFactor was corrected to the engine's own
	// arithmetic (the exact float32 one-third numerator plus a
	// double-precision final divide -- see valueFactor's doc comment); the
	// previous pin 0.026472318917512894 was produced by the truncated
	// `0.5*0.33333` float32 formula this fix replaced.
	const want = 0.026472585275769234 // pinned from this implementation
	const tol = 1e-12
	if math.Abs(got-want) > tol {
		t.Fatalf("Sample(10,20,30) = %v, want %v", got, want)
	}
}

// TestValueFactorArithmetic pins valueFactor to the engine's arithmetic in the
// normal-noise constructor's tail: float32 denominator 0.1f*(1+1/(edge+1)),
// float64 numerator 0.5*(double), float64 divide, one final rounding to
// float32. Expected bit patterns below were computed from that exact
// operation sequence (and differ from a naive `float32(0.5*0.33333)/denom` in
// every row).
func TestValueFactorArithmetic(t *testing.T) {
	cases := []struct {
		amplitudes []float32
		wantBits   uint32
	}{
		{[]float32{1}, 0x3F555556},          // edge 0: 0.8333334
		{[]float32{1, 1}, 0x3F8E38E3},       // edge 1: 1.1111112
		{[]float32{1, 1, 1}, 0x3FA00000},    // edge 2: 1.25
		{[]float32{1, 0, 0, 1}, 0x3FAAAAAB}, // edge 3 (interior zeros don't shrink the span)
		{[]float32{0, 1, 1, 0}, 0x3F8E38E3}, // edge 1 (leading/trailing zeros do)
		{nil, 0x3F8E38E3},                   // no nonzero amplitude: the engine's own edge=1 fallback
	}
	for _, c := range cases {
		got := valueFactor(c.amplitudes)
		if bits := math.Float32bits(got); bits != c.wantBits {
			t.Errorf("valueFactor(%v) = %v (bits %08X), want bits %08X",
				c.amplitudes, got, bits, c.wantBits)
		}
	}
}

// TestMultiOctaveNoise_EmptyAmplitudes exercises the documented n==0
// guard: no draws, Sample always 0.
func TestMultiOctaveNoise_EmptyAmplitudes(t *testing.T) {
	rec := newRecorder(1)
	mn := NewMultiOctaveNoise(rec, -4, nil)
	if len(rec.draws) != 0 {
		t.Fatalf("draws = %d, want 0", len(rec.draws))
	}
	if got := mn.Sample(1, 2, 3); got != 0 {
		t.Fatalf("Sample = %v, want 0", got)
	}
}
