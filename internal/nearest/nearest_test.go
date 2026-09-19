package nearest

import (
	"reflect"
	"strings"
	"testing"
)

func TestNames_MissingNamespaceIsAnExactMatch(t *testing.T) {
	// The commonest way "not defined by the loaded pack" is reached at all:
	// the author typed the name and forgot the namespace in front of it.
	got := Names("rng_marker", []string{"wiki:rock", "wiki:rng_marker", "wiki:tree"})
	want := []string{"wiki:rng_marker"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Names = %v, want %v", got, want)
	}
}

func TestNames_WrongNamespaceIsAnExactMatch(t *testing.T) {
	got := Names("mypack:rng_marker", []string{"wiki:rng_marker"})
	want := []string{"wiki:rng_marker"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Names = %v, want %v", got, want)
	}
}

func TestNames_NamespaceMatchWinsOverTypoMatch(t *testing.T) {
	// "wiki:rng_marker" is the right answer and "test:rng_marker2" is within
	// the edit-distance threshold of the request. Mixing the two would turn
	// one confident suggestion into a list the reader has to choose from.
	got := Names("rng_marker", []string{"wiki:rng_marker", "rng_marker2"})
	want := []string{"wiki:rng_marker"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Names = %v, want %v -- a namespace match must not be diluted with edit-distance guesses", got, want)
	}
}

func TestNames_TypoWithinThreshold(t *testing.T) {
	got := Names("test:palce_diamond", []string{"test:place_diamond", "test:other"})
	want := []string{"test:place_diamond"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Names = %v, want %v", got, want)
	}
}

func TestNames_RenameTooFarIsNotGuessedAt(t *testing.T) {
	// "wiki:highland.main" -> "wiki:hl.main" is a plausible real rename, and
	// at edit distance 6 it must not be offered as a typo correction.
	if got := Names("wiki:highland.main", []string{"wiki:hl.main"}); len(got) != 0 {
		t.Errorf("Names = %v, want none -- an edit distance this large is a rename, not a typo", got)
	}
}

func TestNames_AtMostThree(t *testing.T) {
	got := Names("rock", []string{"a:rock", "b:rock", "c:rock", "d:rock", "e:rock"})
	if len(got) != Limit {
		t.Fatalf("Names returned %d candidates (%v), want at most %d", len(got), got, Limit)
	}
	want := []string{"a:rock", "b:rock", "c:rock"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Names = %v, want %v -- ties break alphabetically so the sentence is stable run to run", got, want)
	}
}

func TestNames_CaseFoldsLikeTheGameRegistry(t *testing.T) {
	got := Names("RNG_Marker", []string{"wiki:rng_marker"})
	want := []string{"wiki:rng_marker"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Names = %v, want %v", got, want)
	}
}

func TestNames_SkipsTheIdentifierItself(t *testing.T) {
	// A candidate that differs only in case IS the identifier as far as the
	// game is concerned, so offering it would be a correction that changes
	// nothing.
	if got := Names("wiki:rock", []string{"wiki:Rock"}); len(got) != 0 {
		t.Errorf("Names = %v, want none", got)
	}
}

func TestNames_DeduplicatesCandidates(t *testing.T) {
	got := Names("rock", []string{"wiki:rock", "wiki:rock", "wiki:ROCK"})
	want := []string{"wiki:rock"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Names = %v, want %v", got, want)
	}
}

func TestNames_EmptyCandidateList(t *testing.T) {
	if got := Names("wiki:rock", nil); len(got) != 0 {
		t.Errorf("Names = %v, want none", got)
	}
}

func TestPhrase(t *testing.T) {
	if got := Phrase("rng_marker", []string{"wiki:rng_marker"}); got != ` -- did you mean "wiki:rng_marker"?` {
		t.Errorf("Phrase = %q", got)
	}
	if got := Phrase("rock", []string{"a:rock", "b:rock"}); got != ` -- did you mean "a:rock", "b:rock"?` {
		t.Errorf("Phrase = %q", got)
	}
	if got := Phrase("wiki:rock", []string{"wiki:completely_different_thing"}); got != "" {
		t.Errorf("Phrase = %q, want empty when there is nothing to suggest", got)
	}
}

func TestPhrase_NeverEndsWithoutAQuestionMark(t *testing.T) {
	got := Phrase("rock", []string{"a:rock"})
	if !strings.HasPrefix(got, " -- did you mean ") || !strings.HasSuffix(got, "?") {
		t.Errorf("Phrase = %q, want the shared clause shape", got)
	}
}

func TestDistance(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"", "", 0},
		{"abc", "abc", 0},
		{"abc", "abd", 1},
		{"palce", "place", 2},
		{"abc", "abcd", 1},
		{"kitten", "sitting", 3},
	}
	for _, c := range cases {
		if got := distance(c.a, c.b); got != c.want && !(c.want > threshold && got > threshold) {
			t.Errorf("distance(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestDistance_LengthGapShortCircuitAgreesWithTheFullComputation(t *testing.T) {
	// The byte-length short-circuit is only safe if it can never reject a
	// pair the DP would have accepted.
	if got := distance("a", "aaaaaaaaaa"); got <= threshold {
		t.Errorf("distance = %d, want above the threshold", got)
	}
}

func TestNames_UnicodeIdentifierDoesNotPanic(t *testing.T) {
	// Not a shape any real pack uses, but the fold is ASCII-only and the DP
	// walks runes, so the two must not disagree about what a string is.
	if got := Names("wiki:rÖck", []string{"wiki:rock", "wiki:röck"}); len(got) > Limit {
		t.Errorf("Names = %v", got)
	}
}
