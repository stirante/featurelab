// fixture_test.go is the placement regression baseline that runs on any
// checkout, CI included. TestFixtureDigest runs the shared digest comparison
// against the committed fixture pack at docs/wiki/tools/fixtures, pinned at
// testdata/fixture_placement_digest.json.
//
// Know what a green run means before trusting it. The comparison code is
// shared by every baseline in this package -- same InScopeEntries scope walk,
// same PlaceOne, same FNV-1a write/draw encoding, same buckets, same
// assertions -- and so are its limits: it bounds only regressions the CORPUS
// reaches, it bounds only SUBSYSTEMS the harness touches (block loading and
// block tags are invisible to it), and it is a self-comparison against this
// engine's own earlier output, never evidence of matching real Bedrock.
//
// The corpus is also small. The fixture pack is the wiki's illustration set
// -- a few dozen small features written to make documentation pages concrete
// -- not a content pack, and it pins tens of chains. So this test PRINTS its
// own coverage every run -- how many chains it compared, and which of the
// seventeen types the suite advertises it did and did not reach, with the
// chain count per type -- and those lines are not decoration. A baseline that
// covers a sliver of the behaviour but is trusted like the whole is worse than
// no baseline.
//
// In particular, do not read the type list as a coverage claim. As of writing
// this pack does reach all seventeen types, which sounds complete and is not:
// several types are reached by exactly ONE chain, and one chain through a type
// pins one path through it -- one set of field values, one delegation shape,
// one RNG trajectory. That is why the per-type counts are printed and not just
// the type names.
//
// The three carvers are also the clearest case of why the WRITE count is the
// less interesting half of a digest entry. At this suite's plains origin the
// nether and underwater carvers write nothing at all -- a plains bench has no
// netherrack, and the plains biome carries no "ocean" tag, which the
// underwater carver treats as "abandon this column" -- so their pinned write
// hash is the empty hash and always will be. What they pin is 5248 and 21398
// RNG draws in order, and both of the carver defects found in the week before
// they were added moved exactly that.
//
// Regenerating is a deliberate, one-command act, never a side effect of `go
// test`:
//
//	go run ./goldentest/cmd/goldengen -pack fixture
//
// Do that only when a change is meant to alter placement behaviour, and be
// able to name every chain that moved and why. Both the pack and the digest
// are committed, so a plain `git diff` shows the whole story.
package goldentest

import (
	"os"
	"sort"
	"testing"
)

const fixtureDigestPath = `testdata/fixture_placement_digest.json`

func setupFixtureHarness(tb testing.TB) *Harness {
	tb.Helper()
	h, err := SetupFixtureHarness()
	if err != nil {
		// Deliberately NOT a skip. A harness over FEATURELAB_PACK_DIR skips
		// when that variable is unset because the pack legitimately does not
		// exist on most machines; this pack is committed to this repo, so "not found" means
		// the checkout is broken or the fixture directory moved -- either way a
		// failure, not an excused absence. A baseline that can skip itself
		// can go green without having checked anything.
		tb.Fatalf("fixture pack: %v", err)
	}
	return h
}

func TestFixtureDigest(t *testing.T) {
	h := setupFixtureHarness(t)
	digest, err := LoadDigest(fixtureDigestPath)
	if err != nil {
		t.Fatalf("loading fixture digest %s: %v", fixtureDigestPath, err)
	}

	t.Logf("fixture pack: %s (plains preset, origin (%d, %d, %d))", FixturePackRel, h.Origin.X, h.Origin.Y, h.Origin.Z)

	r := CompareAgainst(h, digest)
	logFixtureCoverage(t, h, r)
	reportAndAssert(t, "fixture-pack digest validation (small wiki fixture pack; see coverage above)", r)
	assertNoPinnedChainDisappeared(t, h, digest)
}

// logFixtureCoverage prints what this baseline actually reaches: the chain
// count, the per-type breakdown of chains it compared, and -- explicitly, by
// name -- every advertised type it reaches zero of. When a locally generated
// digest for an external pack is present at digestPath, it also contrasts the
// count with that digest's, read out of the file itself rather than from a
// number written into this comment that nothing would ever re-check (a precise
// number, true when written, tends to be believed long after it stops being
// true).
func logFixtureCoverage(tb testing.TB, h *Harness, r *CompareReport) {
	tb.Helper()

	tb.Logf("=== fixture-pack coverage (what a green run here does and does not cover) ===")
	tb.Logf("feature files in the fixture pack: %d", len(h.Lib.Entries))
	tb.Logf("chains compared against the pinned fixture digest: %d", r.Compared())

	var reached, unreached []string
	for _, typeID := range CoveredFeatureTypes() {
		if n := r.ComparedByType[typeID]; n > 0 {
			reached = append(reached, typeID+" ("+itoa(n)+")")
		} else {
			unreached = append(unreached, typeID)
		}
	}
	total := len(reached) + len(unreached)
	tb.Logf("types REACHED, with the number of chains reaching each (%d/%d):", len(reached), total)
	for _, s := range reached {
		tb.Logf("    %s", s)
	}
	if len(unreached) == 0 {
		tb.Logf("types NOT reached: none -- every one of the %d types this suite covers has at least one chain here.", total)
		tb.Logf("  Read that as TYPE coverage, not BEHAVIOUR coverage: several of the counts above are 1, and one chain")
		tb.Logf("  through a type pins one path through it, and many shapes of each type are not in this pack at all.")
	} else {
		tb.Logf("types NOT reached by this baseline (%d/%d) -- pinned by nothing here:", len(unreached), total)
		for _, s := range unreached {
			tb.Logf("    %s", s)
		}
	}

	// The external-pack digest is optional and not part of the repository;
	// when it is absent the comparison lines are simply omitted rather than
	// guessed at.
	ext, err := LoadDigest(digestPath)
	if err != nil {
		if os.IsNotExist(err) {
			tb.Logf("no external-pack digest at %s, so the size comparison is unavailable --", digestPath)
			tb.Logf("  this fixture baseline is the only placement baseline in the tree, covering %d chains.", r.Compared())
			return
		}
		tb.Logf("could not read the external-pack digest for comparison (%v) -- size comparison skipped", err)
		return
	}

	extChains := len(ext.Features) + len(ext.NotPinnable)
	extByType := make(map[string]int, len(ext.Features))
	for _, f := range ext.Features {
		extByType[f.TypeID]++
	}
	tb.Logf("for scale: the external-pack baseline (%s) pins %d chains; this one covers %d (%.1f%%).",
		digestPath, extChains, r.Compared(), 100*float64(r.Compared())/float64(max(extChains, 1)))

	var onlyHere, onlyThere []string
	for _, typeID := range CoveredFeatureTypes() {
		switch {
		case r.ComparedByType[typeID] > 0 && extByType[typeID] == 0:
			onlyHere = append(onlyHere, typeID)
		case r.ComparedByType[typeID] == 0 && extByType[typeID] > 0:
			onlyThere = append(onlyThere, typeID)
		}
	}
	sort.Strings(onlyHere)
	sort.Strings(onlyThere)
	if len(onlyHere) > 0 {
		tb.Logf("types ONLY this baseline covers (the external pack contains none): %v", onlyHere)
	}
	if len(onlyThere) > 0 {
		tb.Logf("types ONLY the external baseline covers (absent from the fixture pack): %v", onlyThere)
	}
}

// assertNoPinnedChainDisappeared fails if the fixture digest pins a chain that
// is no longer in scope in the pack -- a feature file deleted or renamed, or a
// delegation edited so the chain now reaches an uncovered type.
//
// A baseline over an external pack cannot check this: that pack changes
// independently of this repo, so a pinned chain vanishing there is routine. Here
// both sides are committed to this repo, so a pinned chain with nothing to
// compare it to is always someone's mistake -- and silent shrinkage is exactly
// how a small baseline becomes a smaller one without anyone noticing, since
// every other counter simply reports one fewer.
func assertNoPinnedChainDisappeared(tb testing.TB, h *Harness, digest *DigestFile) {
	tb.Helper()

	inScope := make(map[string]bool)
	for _, e := range InScopeEntries(h.Lib) {
		inScope[e.Identifier] = true
	}
	var gone []string
	for _, f := range digest.Features {
		if !inScope[f.Identifier] {
			gone = append(gone, f.Identifier)
		}
	}
	for _, np := range digest.NotPinnable {
		if !inScope[np.Identifier] {
			gone = append(gone, np.Identifier)
		}
	}
	sort.Strings(gone)
	if len(gone) > 0 {
		tb.Errorf("%d chain(s) pinned in %s are no longer in scope in %s (deleted, renamed, or now delegating to an uncovered type): %v",
			len(gone), fixtureDigestPath, FixturePackRel, gone)
	}
}
