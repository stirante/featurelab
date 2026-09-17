package nbt

import "testing"

// TestToInt32Array pins the loop's behavior after the error-path Sprintf was
// made lazy (the label used to be built eagerly for EVERY element, which was
// the single largest cost of parsing a structure-heavy pack): values still
// convert, and a non-numeric element still fails with asInt's exact
// "<path>[<i>] must be a numeric tag" message.
func TestToInt32Array(t *testing.T) {
	got, err := toInt32Array([]any{float64(1), float64(-2), float64(3)}, "structure.block_indices[0]", 3)
	if err != nil {
		t.Fatalf("toInt32Array: %v", err)
	}
	if len(got) != 3 || got[0] != 1 || got[1] != -2 || got[2] != 3 {
		t.Errorf("toInt32Array = %v, want [1 -2 3]", got)
	}

	_, err = toInt32Array([]any{float64(1), "oops"}, "structure.block_indices[0]", 2)
	if err == nil {
		t.Fatal("expected an error for a non-numeric element")
	}
	want := "mcstructure: structure.block_indices[0][1] must be a numeric tag"
	if err.Error() != want {
		t.Errorf("error = %q, want %q (must stay byte-identical to asInt's own message)", err.Error(), want)
	}

	_, err = toInt32Array([]any{float64(1)}, "p", 2)
	if err == nil {
		t.Fatal("expected a length-mismatch error")
	}
}
