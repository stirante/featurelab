package goldentest

import (
	"fmt"
	"strconv"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/wgen"
)

// ---------------------------------------------------------------------------
// Digest comparison -- the single implementation both baselines use.
//
// A digest can be pinned for any pack: the committed fixture-pack one
// (TestFixtureDigest, testdata/fixture_placement_digest.json) or one generated
// locally for the pack at FEATURELAB_PACK_DIR
// (testdata/feature_placement_digest.json). Baselines differ in exactly two
// things -- which pack the harness loads and which file it is compared
// against -- and in nothing else. CompareAgainst is where
// that "nothing else" is enforced: the same scope walk, the same PlaceOne, the
// same FNV-1a write/draw encoding, the same bucket rules. A second suite that
// hashed a chain even slightly differently would look like a check and be one
// only by coincidence.
// ---------------------------------------------------------------------------

// CompareReport is the outcome of comparing every in-scope chain in a
// harness's library against a pinned digest. Every in-scope chain lands in
// exactly one bucket -- see Accounted, which the callers assert on, because
// a `continue` added without a counter would quietly shrink what the
// headline number claims was verified.
type CompareReport struct {
	InScope     int
	BuildFailed int
	// MissingFromDigest: in scope here, absent from the digest, and not
	// listed in its notPinnable block either -- i.e. silently unchecked.
	MissingFromDigest int
	// RefExcluded: chains the pinned baseline itself excludes (budget), so
	// there is nothing to compare against. Counted rather than dropped:
	// without this the bucket totals fall short of InScope and the summary
	// reads as if every in-scope chain had been checked.
	RefExcluded    int
	BudgetMismatch int
	BothMatch      int
	// WriteOnlyMatch and DrawOnlyMatch are named for what MATCHED, not for what moved, and the
	// two readings are opposites. WriteOnlyMatch means the write hash matched and the DRAW hash
	// moved -- an RNG change, the alarm condition. DrawOnlyMatch means the draws are identical
	// and only the written blocks differ -- a geometry change. Anything printed from these has
	// to say which, because "draw-only" reads as the first and is the second.
	WriteOnlyMatch   int
	DrawOnlyMatch    int
	NeitherMatch     int
	ReturnedMismatch int
	ScopeMismatch    int

	// FirstMismatches is capped at 20 entries (a wholesale divergence would
	// otherwise bury the summary); ScopeMismatches is not, since a scope
	// divergence is both rarer and useless when truncated.
	FirstMismatches []string
	ScopeMismatches []string

	// ComparedByType counts, per feature type, the chains that were actually
	// placed and compared -- not merely present in the pack. This is what the
	// fixture suite's coverage report is built from, and the distinction
	// matters: a chain whose delegation reaches an uncovered type is in the
	// pack but pinned by nothing.
	ComparedByType map[string]int
}

// Compared is the number of chains that were actually placed and hashed
// against a pinned entry.
func (r *CompareReport) Compared() int {
	return r.BothMatch + r.WriteOnlyMatch + r.DrawOnlyMatch + r.NeitherMatch
}

// Failed is the number of compared chains whose writes or draws diverge.
func (r *CompareReport) Failed() int {
	return r.WriteOnlyMatch + r.DrawOnlyMatch + r.NeitherMatch
}

// Accounted is the total across every bucket; it must equal InScope.
func (r *CompareReport) Accounted() int {
	return r.Compared() + r.BuildFailed + r.MissingFromDigest + r.RefExcluded + r.BudgetMismatch
}

// CompareAgainst places every in-scope chain in h's library (InScopeEntries
// -- the same definition goldentest/cmd/goldengen uses to decide what to
// pin, so the two can never silently disagree about which chains are being
// compared) and compares each against digest's pinned entry: write hash and
// count, draw hash and count, returned position, and final Molang scope.
//
// It reports; it does not assert. Turning a report into a pass or a fail is
// the caller's job -- see reportAndAssert in report_test.go, which every
// suite shares.
func CompareAgainst(h *Harness, digest *DigestFile) *CompareReport {
	notPinnable := make(map[string]string, len(digest.NotPinnable))
	for _, np := range digest.NotPinnable {
		notPinnable[np.Identifier] = np.Reason
	}
	digestByID := make(map[string]*DigestFeature, len(digest.Features))
	for i := range digest.Features {
		digestByID[digest.Features[i].Identifier] = &digest.Features[i]
	}

	r := &CompareReport{ComparedByType: make(map[string]int)}

	for _, e := range InScopeEntries(h.Lib) {
		r.InScope++
		if e.Feature == nil {
			r.BuildFailed++
			continue
		}

		dg, ok := digestByID[e.Identifier]
		if !ok {
			if _, excluded := notPinnable[e.Identifier]; excluded {
				r.RefExcluded++ // baseline itself excluded this one (budget) -- not comparable
				continue
			}
			r.MissingFromDigest++
			continue
		}

		result := PlaceOne(e.Feature, h.Proto, h.Baseline, h.Origin, h.Biome)
		if result.BudgetError != "" {
			r.BudgetMismatch++
			if len(r.FirstMismatches) < 20 {
				r.FirstMismatches = append(r.FirstMismatches, e.Identifier+": Go hit "+result.BudgetError+" but golden has a pinned digest entry")
			}
			continue
		}

		writeHash := fnv1a64Hex(EncodeWrites(result.Writes))
		drawHash := fnv1a64Hex(EncodeDraws(result.Draws))

		writeOK := writeHash == dg.WriteHash && len(result.Writes) == dg.WriteCount
		drawOK := drawHash == dg.DrawHash && len(result.Draws) == dg.DrawCount

		r.ComparedByType[e.TypeID]++

		switch {
		case writeOK && drawOK:
			r.BothMatch++
		case writeOK && !drawOK:
			r.WriteOnlyMatch++
		case !writeOK && drawOK:
			r.DrawOnlyMatch++
		default:
			r.NeitherMatch++
		}
		if !(writeOK && drawOK) && len(r.FirstMismatches) < 20 {
			r.FirstMismatches = append(r.FirstMismatches, mismatchDetail(e, dg, result, writeHash, drawHash))
		}

		if !posEqual(result.Returned, dg.Returned) {
			r.ReturnedMismatch++
		}
		if !ScopeEqual(result.Scope, dg.Scope) {
			r.ScopeMismatch++
			r.ScopeMismatches = append(r.ScopeMismatches, scopeMismatchDetail(e, dg, result))
		}
	}

	return r
}

func mismatchDetail(e features.Entry, dg *DigestFeature, r PlacementOutcome, writeHash, drawHash string) string {
	msg := e.Identifier + " (" + e.TypeID + ", " + e.FileID + "): "
	if writeHash != dg.WriteHash || len(r.Writes) != dg.WriteCount {
		msg += "writes " + itoa(len(r.Writes)) + "/" + writeHash + " vs golden " + itoa(dg.WriteCount) + "/" + dg.WriteHash + "; "
	}
	if drawHash != dg.DrawHash || len(r.Draws) != dg.DrawCount {
		msg += "draws " + itoa(len(r.Draws)) + "/" + drawHash + " vs golden " + itoa(dg.DrawCount) + "/" + dg.DrawHash + "; "
	}
	if r.OtherError != "" {
		msg += "go error: " + r.OtherError + "; "
	}
	if dg.Error != nil {
		msg += "golden error: " + *dg.Error + "; "
	}
	return msg
}

// scopeMismatchDetail names the feature and, for every differing (ns, key),
// prints the Go value and the golden value side by side -- so a scope
// divergence is diagnosable from the test log alone instead of just being
// counted.
func scopeMismatchDetail(e features.Entry, dg *DigestFeature, r PlacementOutcome) string {
	diffs := ScopeDiff(r.Scope, dg.Scope)
	msg := e.Identifier + " (" + e.TypeID + ", " + e.FileID + "): "
	for i, d := range diffs {
		if i > 0 {
			msg += ", "
		}
		msg += d.NS + "." + d.Key + ": go="
		if d.GotHas {
			msg += fmtScopeValue(d.Got)
		} else {
			msg += "<missing>"
		}
		msg += " golden="
		if d.WantHas {
			msg += fmtScopeValue(d.Want)
		} else {
			msg += "<missing>"
		}
	}
	return msg
}

func fmtScopeValue(v any) string {
	if f, ok := v.(float64); ok {
		return strconv.FormatFloat(f, 'g', -1, 64)
	}
	return fmt.Sprintf("%v", v)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func posEqual(got *wgen.BlockPos, want *Pos) bool {
	if got == nil && want == nil {
		return true
	}
	if got == nil || want == nil {
		return false
	}
	return got.X == want.X && got.Y == want.Y && got.Z == want.Z
}
