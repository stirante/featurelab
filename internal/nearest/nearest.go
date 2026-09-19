// Package nearest turns "that identifier resolved to nothing" into "did you
// mean this one?".
//
// It exists because every "not defined by the loaded pack" message in this
// repo -- features, feature rules, structures, biome references, and the
// graph's dangling-edge check -- has the same failure behind it and the same
// commonest cause, and each of them used to answer with a COUNT instead. A
// count is bookkeeping: "55 feature(s) loaded, 55 built successfully" tells a
// pack author nothing they can act on, while the pack they are looking at
// almost always contains the thing they asked for under a namespace they
// forgot to type.
//
// Two passes, deliberately in this order:
//
//  1. EXACT IGNORING NAMESPACE. `rng_marker` against a pack holding
//     `wiki:rng_marker` is not a typo, it is a forgotten namespace, and it is
//     by a wide margin the commonest way this message is reached. A namespace
//     match is a near-certainty rather than a guess, so when there is one it
//     is the whole answer and no edit-distance candidate is mixed in beside
//     it -- one confident suggestion reads very differently from three
//     hedged ones.
//
//  2. A SMALL EDIT DISTANCE. Only when nothing matched by name: candidates
//     within a flat 2 edits of what was asked for, which covers one typo, one
//     transposition, one missing or extra character, and nothing else.
//
// Both passes fold case the way the game's own feature registry does (see
// features.Resolve): `wiki:Rock` and `wiki:rock` are one name there, so a
// suggestion engine that treated them as two would offer a "correction" that
// changes nothing.
package nearest

import (
	"fmt"
	"sort"
	"strings"
)

// Limit is how many candidates are ever named. Three is the point past which
// a suggestion list stops being a suggestion: a reader scanning four or more
// names is doing the search themselves, which is what the message was
// supposed to save them.
const Limit = 3

// threshold is the edit distance pass-2 accepts, flat rather than scaled by
// length.
//
// A distance-proportional threshold was tried first and rejected. Against a
// typical identifier set, "wiki:hl.mian" (a deliberate typo of "wiki:hl.main")
// matched BOTH "wiki:hl.main" (distance 2, obviously the intended one) and
// "wiki:hl.plant" (distance 3, not remotely what anyone meant) under a
// length-scaled threshold -- a clear error turned into guesswork. A flat 2
// keeps only the former.
//
// It also means a multi-character rename ("overworld.main" -> "ow.main", edit
// distance 7) never surfaces here. That is deliberate: a rename that large is
// a real design decision for a caller to notice via the loaded count beside
// this, not a guess this tool should make for them.
const threshold = 2

// Names returns up to Limit identifiers from candidates that target was
// plausibly meant to be, best first. Empty when nothing is close enough --
// which is the common case and must stay cheap to say, because a message that
// always ends in a guess is a message whose guesses stop being read.
//
// Ties break alphabetically so the same pack always produces the same
// sentence; a suggestion list that reordered between runs would show up as a
// spurious diff in every consumer that stores diagnostics.
func Names(target string, candidates []string) []string {
	want := fold(target)
	wantBare := bare(want)

	seen := make(map[string]bool, len(candidates))
	var byNamespace []string
	type scored struct {
		id   string
		dist int
	}
	var byDistance []scored

	for _, c := range candidates {
		if c == "" {
			continue
		}
		folded := fold(c)
		if folded == want || seen[folded] {
			continue
		}
		seen[folded] = true
		if wantBare != "" && bare(folded) == wantBare {
			byNamespace = append(byNamespace, c)
			continue
		}
		// Only worth computing when pass 1 has not already won, but the loop
		// is single-pass on purpose: the candidate list is every identifier in
		// the pack, and walking it twice to save a distance computation on a
		// failure-only path is the wrong trade.
		if d := distance(want, folded); d <= threshold {
			byDistance = append(byDistance, scored{c, d})
		}
	}

	if len(byNamespace) > 0 {
		sort.Strings(byNamespace)
		return cap3(byNamespace)
	}
	sort.Slice(byDistance, func(i, j int) bool {
		if byDistance[i].dist != byDistance[j].dist {
			return byDistance[i].dist < byDistance[j].dist
		}
		return byDistance[i].id < byDistance[j].id
	})
	out := make([]string, 0, len(byDistance))
	for _, m := range byDistance {
		out = append(out, m.id)
	}
	return cap3(out)
}

// Phrase is Names rendered as the clause every caller appends, or "" when
// there is nothing to suggest. One function so the wording cannot drift
// between the five messages that use it -- a reader who learns to recognise
// it in one command should recognise it in all of them.
func Phrase(target string, candidates []string) string {
	near := Names(target, candidates)
	if len(near) == 0 {
		return ""
	}
	quoted := make([]string, len(near))
	for i, id := range near {
		quoted[i] = fmt.Sprintf("%q", id)
	}
	return " -- did you mean " + strings.Join(quoted, ", ") + "?"
}

func cap3(in []string) []string {
	if len(in) > Limit {
		return in[:Limit]
	}
	return in
}

// bare is the identifier without its namespace -- everything after the first
// ':'. Bedrock identifiers are `namespace:name` and a name may itself contain
// dots and slashes but not a second colon, so the first colon is the split.
// An identifier with no colon is already bare.
func bare(id string) string {
	if i := strings.Index(id, ":"); i >= 0 {
		return id[i+1:]
	}
	return id
}

// fold lower-cases ASCII only, matching features.featureKey: identifiers are
// namespace:name pairs over a small character set in every pack anyone
// writes, and strings.ToLower's Unicode folding would introduce equivalences
// the game itself does not have.
func fold(s string) string {
	out := []byte(s)
	changed := false
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + ('a' - 'A')
			changed = true
		}
	}
	if !changed {
		return s
	}
	return string(out)
}

// distance is a plain iterative-DP Levenshtein over runes with two rows of
// O(len(b)) state. Cheap enough to run against every loaded identifier on the
// (rare, failure-only) path that reaches it, even for a pack with several
// thousand features.
//
// It short-circuits on a length gap wider than the threshold, which no amount
// of substitution can close -- that alone skips most of a real pack's
// identifier list before any DP table is touched.
func distance(a, b string) int {
	if n := len(a) - len(b); n > threshold || n < -threshold {
		// Byte lengths, not rune lengths: a byte gap is always >= the rune
		// gap, so this can only ever reject a pair the full computation would
		// also reject.
		return threshold + 1
	}
	ar, br := []rune(a), []rune(b)
	la, lb := len(ar), len(br)
	prev := make([]int, lb+1)
	cur := make([]int, lb+1)
	for j := 0; j <= lb; j++ {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		cur[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			m := prev[j] + 1
			if ins := cur[j-1] + 1; ins < m {
				m = ins
			}
			if sub := prev[j-1] + cost; sub < m {
				m = sub
			}
			cur[j] = m
		}
		prev, cur = cur, prev
	}
	return prev[lb]
}
