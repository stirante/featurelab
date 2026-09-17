package session

import (
	"fmt"
	"sort"
	"strings"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/rules"
)

// unresolvedFeatureDiagnostic and unresolvedRuleDiagnostic build the "error" Diagnostic for a
// request that named a feature/rule identifier the loaded pack does not resolve -- the fix for
// a silent-failure bug: `generate --rule "wiki:highland.main"` against a pack that had
// renamed every rule identifier to a short prefix produced activeRule: null, diagnostics: [],
// blocksChanged: 0, exit 0 -- a completely silent empty result indistinguishable from "the rule
// exists and legitimately placed nothing". The cause was structural: every diagnostic-producing
// branch in generate() below lived inside `if feature != nil || activeRule != nil`, so a request
// that failed to resolve at all never reached any of them. These two functions are called from
// OUTSIDE that block, specifically when resolution failed, so the silence is closed for both
// modes the same way.
//
// Both distinguish two different failures that Library.Resolve/FeatureRuleLibrary.Resolve collapse
// into the same nil:
//
//   - the identifier names no loaded file at all ("not defined by the loaded pack") -- the
//     renamed-rule case, most often a rename or typo (see closestIdentifiers below for the
//     near-match this case gets).
//   - the identifier IS declared by a loaded file, but that file failed to build (bad JSON, unknown
//     feature type, a builder error) -- Library/FeatureRuleLibrary never add a failed build to
//     byIdentifier, so Resolve(id) is nil for a completely different reason. The underlying build
//     diagnostic is already folded into this result's own Diagnostics (lib.Diagnostics/
//     ruleLib.Diagnostics, appended unconditionally further down in generate()), but it is keyed by
//     the file's own fileId, not the identifier a caller asked for -- a caller has no way to connect
//     the two without this explicit pointer.
//
// Both also report how many features/rules the pack actually loaded (built + failed-to-build
// counted separately) so "not found" reads distinguishably from "the pack loaded nothing at all" --
// two very different problems that otherwise look identical from the caller's side.
func unresolvedFeatureDiagnostic(identifier string, lib *features.Library) Diagnostic {
	total := len(lib.Entries)
	built := 0
	for _, e := range lib.Entries {
		if e.Feature != nil {
			built++
		}
		if e.Identifier == identifier {
			return Diagnostic{
				Level: "error", FileID: identifier, Count: 1,
				Message: fmt.Sprintf(
					"feature %q is declared by the loaded pack (in %s) but failed to build -- see that file's own diagnostic for why",
					identifier, e.FileID),
			}
		}
	}
	message := fmt.Sprintf(
		"feature %q is not defined by the loaded pack (%d feature(s) loaded, %d built successfully)",
		identifier, total, built)
	if near := closestIdentifiers(identifier, featureEntryIdentifiers(lib.Entries)); len(near) > 0 {
		message += " -- did you mean " + joinQuoted(near) + "?"
	}
	return Diagnostic{Level: "error", FileID: identifier, Count: 1, Message: message}
}

func unresolvedRuleDiagnostic(identifier string, ruleLib *rules.FeatureRuleLibrary) Diagnostic {
	var entries []rules.FeatureRuleEntry
	if ruleLib != nil {
		entries = ruleLib.Entries
	}
	total := len(entries)
	built := 0
	for _, e := range entries {
		if e.Rule != nil {
			built++
		}
		if e.Identifier == identifier {
			return Diagnostic{
				Level: "error", FileID: identifier, Count: 1,
				Message: fmt.Sprintf(
					"rule %q is declared by the loaded pack (in %s) but failed to build -- see that file's own diagnostic for why",
					identifier, e.FileID),
			}
		}
	}
	message := fmt.Sprintf(
		"rule %q is not defined by the loaded pack (%d rule(s) loaded, %d built successfully)",
		identifier, total, built)
	if near := closestIdentifiers(identifier, ruleEntryIdentifiers(entries)); len(near) > 0 {
		message += " -- did you mean " + joinQuoted(near) + "?"
	}
	return Diagnostic{Level: "error", FileID: identifier, Count: 1, Message: message}
}

func featureEntryIdentifiers(entries []features.Entry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Identifier
	}
	return out
}

func ruleEntryIdentifiers(entries []rules.FeatureRuleEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Identifier
	}
	return out
}

// closestIdentifiers returns up to 3 candidates whose Levenshtein distance from target is within
// a cheap, deliberately tight, flat threshold -- 2 edits -- so this only ever surfaces a genuine
// near-miss (a single typo, a transposition, one missing/extra character), never a guess dressed
// up as one. A distance-proportional threshold was tried first and rejected: against a typical
// identifier set, "wiki:hl.mian" (a deliberate typo of "wiki:hl.main") matched BOTH
// "wiki:hl.main" (distance 2, obviously the intended one) and "wiki:hl.plant" (distance 3, not
// remotely what anyone meant) under a length-scaled threshold -- a clear error turned
// into guesswork. A flat 2 keeps only the former. It also means a
// multi-character rename (e.g. "overworld.main" -> "ow.main", edit distance 7) never
// surfaces here -- deliberately: that is a real design decision for a caller to notice via the
// loaded feature/rule count, not a guess this tool should make for them.
// Ties break alphabetically for deterministic output.
func closestIdentifiers(target string, candidates []string) []string {
	const threshold = 2
	type scored struct {
		id   string
		dist int
	}
	var matches []scored
	for _, c := range candidates {
		if c == "" || c == target {
			continue
		}
		if d := levenshteinDistance(target, c); d <= threshold {
			matches = append(matches, scored{c, d})
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].dist != matches[j].dist {
			return matches[i].dist < matches[j].dist
		}
		return matches[i].id < matches[j].id
	})
	const limit = 3
	if len(matches) > limit {
		matches = matches[:limit]
	}
	out := make([]string, len(matches))
	for i, m := range matches {
		out[i] = m.id
	}
	return out
}

func joinQuoted(ids []string) string {
	quoted := make([]string, len(ids))
	for i, id := range ids {
		quoted[i] = fmt.Sprintf("%q", id)
	}
	return strings.Join(quoted, ", ")
}

// levenshteinDistance is a plain iterative-DP edit distance over runes, two rows of O(len(b))
// state -- cheap enough to run against every loaded identifier on the (rare, failure-only) path
// that reaches it, even for a pack with several thousand features.
func levenshteinDistance(a, b string) int {
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
			del := prev[j] + 1
			ins := cur[j-1] + 1
			sub := prev[j-1] + cost
			m := del
			if ins < m {
				m = ins
			}
			if sub < m {
				m = sub
			}
			cur[j] = m
		}
		prev, cur = cur, prev
	}
	return prev[lb]
}
