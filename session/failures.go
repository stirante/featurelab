// failures.go -- allocation-free dedup-key construction for placement
// diagnostics. Split out of session.go's generate() both for focus and so the
// hot-path helper can be tested (and benchmarked) on its own: a pathological
// pack can raise the SAME failure diagnostic once per failed placement
// attempt -- measured at ~1M calls in a single si.main generation -- so the
// repeat path (dedup hit) must not allocate. The previous shape (five string
// concatenations plus a strings.Join of a freshly-copied chain per call) was
// ~19% of that run's CPU samples before GC costs.
package session

import "github.com/stirante/featurelab/profiler"

// appendFailureKey appends the placement-failure dedup key for
// (level, message, chain) to dst and returns the extended slice. The key's
// equivalence classes are exactly the old inline construction's:
//
//	level \x00 identifier \x00 typeID \x00 message \x00 id0>id1>...
//
// where identifier/typeID are the LAST chain frame's (the feature that
// actually failed -- empty when the chain is empty) and the trailing section
// is every frame's identifier root-first joined by ">". Callers reuse dst
// across calls (appendFailureKey(keyBuf[:0], ...)) so a dedup-hit lookup via
// failureIndex[string(key)] costs zero allocations -- Go's
// map-index-with-string-conversion optimization never materializes the
// string, and the buffer's capacity is retained for the next call.
func appendFailureKey(dst []byte, level, message string, chain []profiler.ChainFrame) []byte {
	dst = append(dst, level...)
	dst = append(dst, 0)
	if len(chain) > 0 {
		last := chain[len(chain)-1]
		dst = append(dst, last.Identifier...)
		dst = append(dst, 0)
		dst = append(dst, last.TypeID...)
	} else {
		dst = append(dst, 0)
	}
	dst = append(dst, 0)
	dst = append(dst, message...)
	dst = append(dst, 0)
	for i, f := range chain {
		if i > 0 {
			dst = append(dst, '>')
		}
		dst = append(dst, f.Identifier...)
	}
	return dst
}
