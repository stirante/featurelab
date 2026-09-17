// Package env builds the synthetic test environments features are placed
// against, including the "plains" preset the golden-digest test recipe uses.
// EnvRandom/hashNoise2D/fractalNoise2D are scenery-only RNG, deliberately
// NOT Bedrock-accurate (features under test must never draw from this; see
// EnvRandom's own doc comment below).
package env

import (
	"math"

	"github.com/stirante/featurelab/random"
)

// EnvRandom is a mulberry32 PRNG used only to dress the surrounding
// environment (terrain wobble, ore veins) — never the RNG a feature under
// test draws from.
type EnvRandom struct {
	state uint32
	// lastSeed is the value last passed to NewEnvRandom/SetSeed, for GetSeed
	// -- see random.IRandom.GetSeed's doc comment for why this can't be the
	// live state (that changes every draw).
	lastSeed uint32
}

// NewEnvRandom seeds an EnvRandom.
func NewEnvRandom(seed uint32) *EnvRandom {
	s := seed
	if s == 0 {
		s = 0x9e3779b9
	}
	return &EnvRandom{state: s, lastSeed: seed}
}

// SetSeed and GetSeed exist only to satisfy random.IRandom (widened for
// CaveFeature -- see that interface's doc comment); EnvRandom is scenery-only
// and no feature under test ever calls either.
func (r *EnvRandom) SetSeed(seed uint32) { *r = *NewEnvRandom(seed) }
func (r *EnvRandom) GetSeed() uint32     { return r.lastSeed }

func (r *EnvRandom) next32() uint32 {
	r.state += 0x6d2b79f5
	t := r.state
	t = (t ^ (t >> 15)) * (t | 1)
	t ^= t + (t^(t>>7))*(t|61)
	return t ^ (t >> 14)
}

func (r *EnvRandom) NextInt() int32 { return int32(r.next32()) }

func (r *EnvRandom) NextIntBound(bound int) int {
	if bound <= 0 {
		panic("bound must be positive")
	}
	return int(r.next32() % uint32(bound))
}

func (r *EnvRandom) NextFloat() float64  { return float64(r.next32()) / 4294967296.0 }
func (r *EnvRandom) NextDouble() float64 { return r.NextFloat() }
func (r *EnvRandom) NextBoolean() bool   { return r.next32()&1 == 1 }
func (r *EnvRandom) NextUnsignedInt(bound uint32) uint32 {
	if bound == 0 {
		// Draws and returns the raw value unreduced, matching the engine's core RNG's raw unsigned draw --
		// see random.IRandom.NextUnsignedInt's doc comment. Kept in step with
		// random.Rand deliberately: two implementations of one interface disagreeing on an input
		// neither is reachable with is how a later caller picks the wrong one.
		return r.next32()
	}
	return r.next32() % bound
}

var _ random.IRandom = (*EnvRandom)(nil)

// hashNoise2D is a position-hashed value in [0,1), stable for a given
// (seed, x, z). All arithmetic done in uint32 space (multiplication wraps
// mod 2^32, matching JS's Math.imul bit-for-bit regardless of signed/
// unsigned interpretation; right-shift is logical, matching JS's `>>>`).
func hashNoise2D(seed int32, x, z int) float64 {
	ux := uint32(int32(x))
	uz := uint32(int32(z))
	us := uint32(seed)
	h := ux*0x27d4eb2d ^ uz*0x165667b1 ^ us*0x85ebca6b
	h = (h ^ (h >> 15)) * 0x2545f491
	h ^= h >> 13
	return float64(h) / 4294967296.0
}

// fractalNoise2D is a smooth-ish fractal height in [0,1), built from
// bilinear-interpolated hash noise.
func fractalNoise2D(seed int32, x, z int, scale float64) float64 {
	fx := float64(x) / scale
	fz := float64(z) / scale
	x0 := int(math.Floor(fx))
	z0 := int(math.Floor(fz))
	tx := fx - float64(x0)
	tz := fz - float64(z0)
	sx := tx * tx * (3 - 2*tx)
	sz := tz * tz * (3 - 2*tz)
	n00 := hashNoise2D(seed, x0, z0)
	n10 := hashNoise2D(seed, x0+1, z0)
	n01 := hashNoise2D(seed, x0, z0+1)
	n11 := hashNoise2D(seed, x0+1, z0+1)
	a := n00 + (n10-n00)*sx
	b := n01 + (n11-n01)*sx
	return a + (b-a)*sz
}
