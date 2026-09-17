// derive.go is this project's ONE documented seed-derivation scheme --
// product policy, not a case-by-case judgement call: a generation run is
// seeded from exactly one MASTER SEED per subsystem (session.Config's
// EnvironmentSeed for env/'s terrain dressing, session.Config's FeatureSeed
// for the ctx.Random a feature places through), and every OTHER random
// stream a sub-generator needs -- forest trees, ore scatter, a multiface
// spread permutation, a cave width_modifier stand-in -- must be DERIVED from
// that one master seed, deterministically, rather than drawn from an
// independent, unseeded, or wall-clock-seeded source. This is what makes a
// preview reproducible: the same master seed must always produce the same
// output, and changing ONLY the master seed (not touching any code) must be
// the one thing that can change it. A change caused by a fresh unseeded
// random on every run would be indistinguishable, from the preview alone,
// from a change caused by an actual code edit -- exactly the confusion this
// scheme exists to rule out. See featurelab-go/features/cave.go's own header
// (PHASE 13) for the one place this project found a genuine engine-side
// exception (the render parameters' default non-deterministic 0..1 source, a
// process-global generator with no connection to any world seed) and chose a
// deterministic stand-in over faithfully-unreproducible engine behavior.
//
// Before this file existed, three sub-generators each invented their own
// derivation ad hoc, in three unrelated styles: env/environment.go's forest
// tree scatter xored the environment seed with the literal 0x7a3e,
// env/plains.go's ore scatter xored it with the literal 0x0e5e, and
// features/multiface.go's spread permutation combined a base seed with a
// spread position via a multiply-xor hash. Nothing tied those three together
// as one scheme, so the next sub-generator had no established pattern to
// follow and would as easily have invented a fourth. DeriveSeed/DeriveSeedAt
// are that established pattern now: every new sub-generator should call one
// of these two functions rather than inventing its own mixing formula.
//
// PRESERVING EXISTING OUTPUTS: unifying the mechanism must not change the
// numbers a sub-generator already produces for a given seed -- doing so
// would silently change terrain/spread a user has already looked at and
// treated as "this is what seed N looks like". So the three pre-existing
// formulas are registered below as domains whose DeriveSeed/DeriveSeedAt
// result is defined to be bit-for-bit identical to the historical formula
// (see legacyDomains), not rewritten to route through the generic hash this
// file introduces for every OTHER (new) domain. env/environment.go and
// env/plains.go's own NewEnvRandom call sites were updated to call
// DeriveSeed with a named Domain constant in place of the inline `seed ^
// 0x....` literal; features/multiface.go's multifaceSpreadSeed now forwards
// to DeriveSeedAt the same way. All three still compute the exact same
// arithmetic they always did -- only the constant moved from an inline magic
// number to a named, documented, single-source-of-truth registration.
//
// DOMAIN INDEPENDENCE: a Domain is an arbitrary, stable string identifying
// one sub-generator's own stream. Two different domains derived from the
// same master seed produce unrelated-looking sub-seeds (via the generic
// hash's own avalanche mixing, see hashDomain) even though they share a
// master -- so adding, removing, or reordering sub-generators never
// perturbs any OTHER sub-generator's own output, and a new domain can be
// registered without risk of colliding with an existing one's numeric
// range. This is the actual reason a per-domain STRING constant (not a
// small integer enum, and not just "whatever seed value happens to be
// convenient") is the API: string domains are self-documenting at every
// call site and cannot silently collide the way small hand-picked integer
// offsets could.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TOUCH: ctx.Random itself (the stream
// every feature's own placement draws from, and the one whose call ORDER is
// this project's entire correctness contract, per every feature file's own
// "RNG call order" standard) is never derived through this scheme -- it is
// the session's own root Random, constructed once from FeatureSeed
// (session.go: `rnd := random.New(config.FeatureSeed)`). DeriveSeed/
// DeriveSeedAt exist purely to seed SEPARATE, purpose-built generators that
// a sub-generator constructs for its own private use (random.New(derived)),
// never to reseed or otherwise touch the caller's own ctx.Random/localRnd in
// place -- reading a value like an already-drawn seed off an existing
// generator to feed in here (e.g. multifaceSpreadSeed's own base parameter,
// sourced from rnd.GetSeed()) is a non-drawing read and does not itself
// perturb that generator's own draw sequence either.
package random

// Domain identifies one independent sub-seed stream derived from a subsystem's
// own master seed -- see this file's own header for the full contract.
// Callers should use a package-qualified, stable string (e.g.
// "features.mytype.thing") so two unrelated packages can never accidentally
// register the same Domain value for two different purposes.
type Domain string

const (
	// DomainEnvForestTrees is env/environment.go's forest-preset tree scatter.
	// Pre-existing formula (`environmentSeed ^ 0x7a3e`), preserved bit for bit
	// -- see legacyDomains.
	DomainEnvForestTrees Domain = "env.forest.trees"
	// DomainEnvOreScatter is env/plains.go's scatterOres (shared by all three
	// underground presets). Pre-existing formula (`environmentSeed ^
	// 0x0e5e`), preserved bit for bit -- see legacyDomains.
	DomainEnvOreScatter Domain = "env.ore.scatter"
	// DomainMultifaceSpread is features/multiface.go's spreadRnd (the
	// multiface spreader's direction-shuffle stand-in). Pre-existing formula (a
	// position-mixed multiply-xor hash of rnd.GetSeed() and the spread
	// position), preserved bit for bit -- see legacyDomains and DeriveSeedAt.
	DomainMultifaceSpread Domain = "features.multiface.spread"
	// DomainCaveWidthModifier is features/cave.go's width_modifier stand-in
	// generator, used only for a Molang expression whose AST reaches
	// math.random/math.random_integer/math.die_roll/math.die_roll_integer --
	// a NEW domain (no pre-existing formula to preserve): the real engine's
	// own source for those four functions here, the render parameters' default
	// non-deterministic 0..1 source, is a process-global, unseeded generator
	// this project cannot reproduce (see cave.go's header, PHASE 13); this
	// domain is this project's deliberate, documented, seed-reproducible
	// stand-in instead, routed through the generic hash below like any other
	// new domain.
	DomainCaveWidthModifier Domain = "features.cave.width_modifier"
	// A DomainRuleChunk used to live here: a stand-in seed for one chunk's worth of a
	// minecraft:feature_rules run, invented before the engine's own per-chunk decoration seed
	// was modelled. It is modelled now -- see random/decorationseed.go, which derives the chunk seed and the per-entry seed the way the engine does -- so the
	// stand-in is gone rather than left registered and unused. This note is here because a
	// removed Domain is exactly the kind of thing someone re-adds by accident.
)

// legacyEntry is one pre-existing sub-generator's own formula, preserved
// bit-for-bit rather than rewritten to the generic hash -- see this file's
// header, "PRESERVING EXISTING OUTPUTS".
type legacyEntry struct {
	// xor is the historical `seed ^ xor` formula (DomainEnvForestTrees/
	// DomainEnvOreScatter). Ignored when positional is true.
	xor uint32
	// positional marks DomainMultifaceSpread: DeriveSeedAt's own `master`
	// argument IS the pre-existing formula's `base` parameter directly (no
	// domain-hash indirection), matching multifaceSpreadSeed's own historical
	// signature exactly -- see DeriveSeedAt.
	positional bool
}

// legacyDomains is the exhaustive registry of pre-existing formulas this
// scheme preserves bit-for-bit. Every OTHER Domain (including
// DomainCaveWidthModifier and any future one) is routed through this file's
// own generic hash instead -- see DeriveSeed/DeriveSeedAt.
var legacyDomains = map[Domain]legacyEntry{
	DomainEnvForestTrees:  {xor: 0x7a3e},
	DomainEnvOreScatter:   {xor: 0x0e5e},
	DomainMultifaceSpread: {positional: true},
}

// DeriveSeed derives domain's own sub-seed from master (a subsystem's master
// seed: session.Config.EnvironmentSeed for an env/ sub-generator,
// FeatureSeed or a value transitively derived from it -- e.g. ctx.Random's
// current GetSeed(), or a localRnd's own constructed seed -- for a features/
// sub-generator). The result is meant to seed a brand-new, throwaway
// generator (random.New(DeriveSeed(...))) for domain's own private use; it
// never reads or mutates any existing generator's live state.
//
// For a domain registered in legacyDomains with a plain xor formula, this
// reproduces that exact historical value. For every other domain (every
// domain this scheme was actually designed for, including any future one),
// this uses hashDomain's own generic avalanche mix, so two different domains
// sharing one master seed produce unrelated-looking sub-seeds -- see this
// file's header, "DOMAIN INDEPENDENCE".
func DeriveSeed(master uint32, domain Domain) uint32 {
	if entry, ok := legacyDomains[domain]; ok && !entry.positional {
		return master ^ entry.xor
	}
	return hashDomain(master, domain)
}

// DeriveSeedAt is DeriveSeed further refined by a 3D position -- for a
// sub-generator whose own stream should vary by WHERE it fires, not just by
// the master seed alone (features/multiface.go's own header, "spreadRnd's
// own seed is now POSITION-DEPENDENT", records the real bug this closes: a
// position-blind derivation hands every successful spread in an entire
// session the identical permutation, since ctx.Random is one long-lived
// object shared across the whole run -- not "reproducible previews" but "one
// global permutation for the whole session").
//
// For DomainMultifaceSpread, master is taken AS multifaceSpreadSeed's own
// historical `base` parameter directly (no DeriveSeed/domain-hash step in
// between), and the position mix below reproduces that function's exact
// multiply-xor formula bit for bit -- see legacyDomains' own doc comment.
// For every other domain, the position mix is applied on top of
// DeriveSeed's own generic result.
func DeriveSeedAt(master uint32, domain Domain, x, y, z int) uint32 {
	base := DeriveSeed(master, domain)
	if entry, ok := legacyDomains[domain]; ok && entry.positional {
		base = master
	}
	h := base
	h = h*2654435761 ^ uint32(x)
	h = h*2654435761 ^ uint32(y)
	h = h*2654435761 ^ uint32(z)
	return h
}

// hashDomain is the generic master-seed+domain mix every NON-legacy Domain
// (i.e. every domain this scheme was actually designed for) is routed
// through: a byte-at-a-time FNV-1a-shaped fold of domain's own bytes into
// master, finished with a splitmix32-style avalanche so nearby master seeds
// or textually-similar domain strings do not produce nearby sub-seeds.
func hashDomain(master uint32, domain Domain) uint32 {
	h := master ^ 0x9e3779b9 // golden-ratio odd constant -- decorrelates from a bare master read
	for i := 0; i < len(domain); i++ {
		h ^= uint32(domain[i])
		h *= 16777619 // FNV-1a's own 32-bit prime
	}
	// splitmix32 finisher, for avalanche across the whole 32 bits.
	h ^= h >> 16
	h *= 0x7feb352d
	h ^= h >> 15
	h *= 0x846ca68b
	h ^= h >> 16
	return h
}
