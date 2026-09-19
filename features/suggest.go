// suggest.go is the "did you mean" for a DELEGATION that resolved to nothing.
//
// The suggestion machinery (internal/nearest) has been in this repo for a
// while and, until now, reached exactly one situation: the identifier a caller
// REQUESTED, through session's unresolvedFeatureDiagnostic. So
// `generate --feature wiki:rng_markr` answered "...-- did you mean
// "wiki:rng_marker"?", while the identical typo written as a
// `"places_feature"` inside a file answered "wiki:rng_markr not found" and
// nothing else -- the same mistake, the same pack, the same fix, and the help
// only on the path where the author had already typed the name themselves and
// could see it.
//
// (wire.CheckGraph has a dangling-edge suggestion too, and had no production
// caller at all -- see wire.UnresolvedTargets, which now gives it one.)
//
// It lives on the STOP rather than on the placement failure beside it because
// the stop is where the reference itself is named. A scatter whose
// places_feature does not resolve logs "No features could be placed" -- a
// sentence about the scatter, correct, and not somewhere to hang a spelling
// hint about a name it does not mention. The stop row right beside it is
// `unresolved_reference: wiki:rng_markr not found`, which is exactly the name
// that is wrong.
package features

import (
	"github.com/stirante/featurelab/internal/nearest"
	"github.com/stirante/featurelab/wgen"
)

// Identifiers returns every feature identifier this Library resolves, as each
// file declared it.
//
// Exported for the one thing that needs the whole set rather than one lookup:
// turning "this reference resolved to nothing" into "did you mean this". A
// resolver that is not a *Library simply has no candidates to offer, and the
// message is the same one it always was -- see SuggestFeatureRef.
func (l *Library) Identifiers() []string {
	out := make([]string, 0, len(l.Entries))
	for _, e := range l.Entries {
		out = append(out, e.Identifier)
	}
	return out
}

// featureIdentifierLister is what a resolver has to be for a suggestion to be
// possible: something that can list what it WOULD resolve. *Library is the
// only implementation, and the interface exists rather than a type assertion
// on *Library so that a test double, and wgen's interface-first design, are
// not quietly excluded.
type featureIdentifierLister interface {
	Identifiers() []string
}

// SuggestFeatureRef is the " -- did you mean ...?" clause for a delegation
// reference that resolved to nothing, or "" when there is nothing close enough
// to suggest (the common case, and the one that must stay cheap to say).
//
// Callers append it to the detail they already build rather than having it
// build the whole sentence, because the details are not all the same shape:
// conditional_list's says "...not found; list ended", and a clause that ends
// in a question mark has to come after that, not before it.
//
// Only ever called on a failure path that has already decided to build a
// detail string (profiler.StopCounted gates every one of them), so the walk
// over every loaded identifier is paid once per distinct broken reference, not
// once per attempted placement.
func SuggestFeatureRef(resolver wgen.IFeatureResolver, ref string) string {
	lister, ok := resolver.(featureIdentifierLister)
	if !ok {
		return ""
	}
	return nearest.Phrase(ref, lister.Identifiers())
}
