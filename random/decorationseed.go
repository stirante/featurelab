// decorationseed.go — the engine's per-chunk and per-decoration-entry seeds (game version
// 1.26.50).
//
// What this replaces: this package used to derive a rule's per-chunk generator through
// DomainRuleChunk, a documented invention that gave every chunk its own reproducible stream
// without claiming to be the game's. It now follows the game's own three-step derivation below.
//
// # Step 1 — the chunk's decoration seed
//
// Before one chunk's decoration pass, the generator it hands down is seeded like this:
//
//	worldSeed = the world seed
//	reseed the generator with worldSeed
//	m1 = the engine's unbounded integer draw, made odd as "value / 2 * 2 + 1", i.e. rounding
//	     toward zero -- NOT a plain |1, which differs for odd negatives
//	     (-5|1 == -5, but -5/2*2+1 == -3)
//	m2 = a second draw, same treatment
//	x, z = the chunk position
//	chunkSeed = (x*m1 + z*m2) ^ worldSeed
//	reseed the generator with chunkSeed
//
// This is Minecraft's classic population seed, in 32-bit integers rather than Java's 64-bit
// ones. (The derivation is performed twice in a row, producing the identical value -- not a
// second seed.)
//
// # Step 2 — the decoration entry's seed
//
// The per-biome decoration pass runs each entry of the chunk's decoration list, and gives every
// one its own generator:
//
//	seed = the generator's stored seed            -- the chunk seed from step 1
//	hash = the engine's string hash of the entry name, low 32 bits
//	entrySeed = seed ^ (hash + 0x9E3779B9 + (seed << 6) + (seed >> 2))
//	                                              -- Boost's hash_combine, 32-bit
//	construct a generator from entrySeed
//
// # Step 3 — TWO generators, both from that seed
//
// The generator built above is passed to the scatter loop, which draws the positions. Then its
// seed is read back and a SECOND, INDEPENDENT generator is constructed from the same value --
// and it is that second one, not the first, that is put into the placement context every
// delegated feature placement receives. So the position stream and the placement stream both
// begin at entrySeed and advance separately: a feature's own draws never shift the positions,
// and vice versa. A port that shares one generator between the two gets different blocks in
// different places, which is why this is modelled rather than approximated.
//
// # Which name is hashed — the rule's own identifier
//
// The hashed name is the feature rule's `description.identifier`, NOT its `places_feature`.
// The rule stores the hash of its identifier alongside its placement pass string, and the
// decoration entry a rule contributes IS that rule.
//
// The practical consequence for a pack: renaming a feature rule moves everything it places, and
// renaming the FEATURE it points at does not.
package random

// hashedStringFNVOffset and hashedStringFNVPrime are the FNV 64-bit offset basis and prime the
// engine's string hash uses.
const (
	hashedStringFNVOffset = uint64(0xCBF29CE484222325)
	hashedStringFNVPrime  = uint64(0x100000001B3)
)

// HashedStringHash is Bedrock's own string hash: FNV-1 (not FNV-1a) over the bytes, with an
// empty string short-circuited to 0.
//
// The order is load-bearing and easy to get wrong from memory: the engine's loop multiplies
// FIRST and xors the byte into the product (`hash = hash*prime ^ byte`), which is FNV-1. FNV-1a,
// the variant almost every library ships, xors first and then multiplies, and the two produce
// different values for every input longer than nothing. The empty-string case is not the offset
// basis either -- it hashes to a literal zero.
func HashedStringHash(s string) uint64 {
	if len(s) == 0 {
		return 0
	}
	hash := hashedStringFNVOffset
	for i := 0; i < len(s); i++ {
		hash = hash*hashedStringFNVPrime ^ uint64(s[i])
	}
	return hash
}

// HashedStringHash32 is the low 32 bits of HashedStringHash -- what the decoration seed uses,
// since the engine consumes the hash 32 bits wide.
func HashedStringHash32(s string) uint32 {
	return uint32(HashedStringHash(s))
}

// ChunkDecorationSeed is the seed the engine gives one chunk's decoration pass, derived from the
// world seed and the chunk's own coordinates. See this file's header for the step-by-step
// derivation.
//
// The two multipliers come from a generator seeded with the world seed, so they are constant for
// a world and computed here on every call rather than cached: a bench run touches a handful of
// chunks, and a cache keyed on the seed would be a correctness risk (a stale multiplier pair
// silently misplacing everything) for no measurable gain.
func ChunkDecorationSeed(worldSeed uint32, chunkX, chunkZ int32) uint32 {
	r := New(worldSeed)
	m1 := oddify(r.NextInt())
	m2 := oddify(r.NextInt())
	return uint32(chunkX*m1+chunkZ*m2) ^ worldSeed
}

// oddify is the engine's `value / 2 * 2 + 1`. Go's integer division truncates toward zero, as the
// engine's does, so the expression carries over directly.
func oddify(v int32) int32 {
	return v/2*2 + 1
}

// DecorationEntrySeed combines a chunk's decoration seed with one entry's name hash -- the
// engine's 32-bit form of Boost's hash_combine.
//
// Every decoration entry in a chunk gets its own seed this way, which is what stops two features
// in the same chunk from sharing a stream (and what makes a feature's placement independent of
// how many entries ran before it).
func DecorationEntrySeed(chunkSeed, nameHash uint32) uint32 {
	return chunkSeed ^ (nameHash + 0x9E3779B9 + (chunkSeed << 6) + (chunkSeed >> 2))
}
