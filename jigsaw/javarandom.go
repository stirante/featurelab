package jigsaw

const (
	lcgMultiplier = 0x5DEECE66D
	lcgAddend     = 11
	lcgMask       = (1 << 48) - 1
)

// javaRandom is a java.util.Random LCG. Jigsaw assembly draws from it,
// not from the Mersenne twister the feature code uses.
type javaRandom struct {
	seed uint64
}

func newJavaRandom(seed int64) *javaRandom {
	r := &javaRandom{}
	r.setSeed(seed)
	return r
}

func (r *javaRandom) setSeed(seed int64) {
	r.seed = (uint64(seed) ^ lcgMultiplier) & lcgMask
}

func (r *javaRandom) next(bits uint) int32 {
	r.seed = (r.seed*lcgMultiplier + lcgAddend) & lcgMask
	return int32(r.seed >> (48 - bits))
}

func (r *javaRandom) nextInt(bound int) int {
	if bound <= 0 {
		panic("jigsaw: nextInt bound must be positive")
	}
	bound32 := int32(bound)
	if bound32&-bound32 == bound32 {
		return int((int64(bound32) * int64(r.next(31))) >> 31)
	}
	for {
		bits := r.next(31)
		value := bits % bound32
		if bits-value+(bound32-1) >= 0 {
			return int(value)
		}
	}
}

func (r *javaRandom) nextLong() int64 {
	high := int64(r.next(32))
	low := int64(r.next(32))
	return high<<32 + low
}

func (r *javaRandom) nextFloat() float32 {
	return float32(r.next(24)) / float32(1<<24)
}

// setLargeFeatureSeed seeds the generator for a chunk.
func (r *javaRandom) setLargeFeatureSeed(seed int64, chunkX, chunkZ int) {
	r.setSeed(seed)
	a := r.nextLong()
	b := r.nextLong()
	r.setSeed((a * int64(chunkX)) ^ (b * int64(chunkZ)) ^ seed)
}

// blockPosSeed is a position's own random seed.
func blockPosSeed(x, y, z int) int64 {
	v := (116129781 * int64(z)) ^ (3129871 * int64(x)) ^ int64(y)
	return ((42317861*v + 11) * v) >> 16
}
