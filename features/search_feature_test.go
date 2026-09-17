package features

import (
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// TestSearchFeature_InvertedSearchVolumeDoesNotCrash pins the fix for a crash that a plausible
// typo reached. The capacity expression `max-min+1` goes negative once max < min-1, and
// make([]int, 0, negative) panics -- so {"min": [0,0,0], "max": [0,-3,0]}, which is the shipped
// fixture's own downward volume with the two swapped, took the tool down with a raw Go stack
// trace while `featurelab check` passed the file in silence.
func TestSearchFeature_InvertedSearchVolumeDoesNotCrash(t *testing.T) {
	// The direct cause, at the level it lived: this call used to panic.
	if got := iterateInclusive(searchAxisRange{min: 0, max: -3}, 1); len(got) != 0 {
		t.Errorf("an inverted range must yield no positions, got %v", got)
	}
	if got := iterateInclusive(searchAxisRange{min: 0, max: -3}, -1); len(got) != 0 {
		t.Errorf("an inverted range must yield no positions descending either, got %v", got)
	}
	// The boundary that did NOT panic before, and must keep working: max == min-1 is an empty
	// range whose capacity expression is exactly 0.
	if got := iterateInclusive(searchAxisRange{min: 0, max: -1}, 1); len(got) != 0 {
		t.Errorf("max == min-1 is empty, got %v", got)
	}
	// An ordinary range is untouched.
	if got := iterateInclusive(searchAxisRange{min: -2, max: 1}, 1); len(got) != 4 || got[0] != -2 || got[3] != 1 {
		t.Errorf("ascending range = %v, want -2..1", got)
	}
	if got := iterateInclusive(searchAxisRange{min: -2, max: 1}, -1); len(got) != 4 || got[0] != 1 || got[3] != -2 {
		t.Errorf("descending range = %v, want 1..-2", got)
	}
}

// TestTransactionalTarget_MirrorsUnwrappedWriteResult pins two properties a delegate running
// inside a search must be able to rely on.
//
// First: SetBlock's bool. It used to be an unconditional true, so a delegate that keys success off
// it -- single_block.go's own "Block could not be placed" step is the one in this repo -- saw
// success inside a search where the identical call outside one saw failure. The search then
// committed and returned a position having written nothing.
//
// Second: the write budget. Buffered writes never reached the real API until apply(), so
// WritesAttempted stayed 0 across every delegate write and a runaway delegate inside a search
// reached what it could not reach outside one. Attempts are now charged when they are buffered
// and not charged again when they are replayed.
func TestTransactionalTarget_MirrorsUnwrappedWriteResult(t *testing.T) {
	newWorld := func(budget *int) *volume.Volume {
		pal := block.NewPalette()
		v := volume.New(volume.Bounds{MinX: 0, MinY: 0, MinZ: 0, SizeX: 4, SizeY: 4, SizeZ: 4}, pal, block.AirID)
		v.WriteBudget = budget
		return v
	}
	inside := wgen.BlockPos{X: 1, Y: 1, Z: 1}
	outside := wgen.BlockPos{X: 100, Y: 0, Z: 0}

	t.Run("result matches the unwrapped API", func(t *testing.T) {
		plain := newWorld(nil)
		stone := plain.RawPalette().Get("minecraft:stone", nil)
		wantInside := plain.SetBlock(inside, stone)
		wantOutside := plain.SetBlock(outside, stone)

		wrapped := newWorld(nil)
		tt := newTransactionalTarget(wrapped)
		if got := tt.SetBlock(inside, stone); got != wantInside {
			t.Errorf("wrapped SetBlock(in bounds) = %v, unwrapped = %v", got, wantInside)
		}
		if got := tt.SetBlock(outside, stone); got != wantOutside {
			t.Errorf("wrapped SetBlock(out of bounds) = %v, unwrapped = %v", got, wantOutside)
		}
		// A refused write must not be readable back through the buffer either: the real world
		// never accepted it, so GetBlock has to keep reading through.
		if tt.GetBlock(outside) != wrapped.GetBlock(outside) {
			t.Error("a refused write was readable back out of the transaction buffer")
		}
	})

	t.Run("budget is charged while buffering, once", func(t *testing.T) {
		budget := 3
		v := newWorld(&budget)
		stone := v.RawPalette().Get("minecraft:stone", nil)
		tt := newTransactionalTarget(v)

		tt.SetBlock(wgen.BlockPos{X: 0, Y: 0, Z: 0}, stone)
		tt.SetBlock(wgen.BlockPos{X: 1, Y: 0, Z: 0}, stone)
		if v.WritesAttempted != 2 {
			t.Fatalf("WritesAttempted = %d after 2 buffered writes, want 2 (the budget must not "+
				"go inert inside a search)", v.WritesAttempted)
		}

		// Committing replays them; it must NOT charge a second time.
		tt.apply()
		if v.WritesAttempted != 2 {
			t.Errorf("WritesAttempted = %d after apply(), want 2: a committed search must not be "+
				"charged twice for the same write", v.WritesAttempted)
		}

		// And the budget still fires, at the same count it would outside a search.
		func() {
			defer func() {
				if recover() == nil {
					t.Error("no WriteBudgetExceeded panic past the budget")
				}
			}()
			tt2 := newTransactionalTarget(v)
			for i := 0; i < 5; i++ {
				tt2.SetBlock(wgen.BlockPos{X: 2, Y: i, Z: 0}, stone)
			}
		}()
	})
}

// TestBuildSearchFeature_RequiredSuccessesZeroLoadsWithAWarning pins that 0 is no longer refused.
// Nothing in this repo records a schema minimum for the field, so "must be a positive integer"
// was this port being stricter than the game, and it cost the author the whole
// file. 0 now loads and warns: this port's success counter is compared for equality after being
// incremented, so it never matches 0 and the search always exhausts.
func TestBuildSearchFeature_RequiredSuccessesZeroLoadsWithAWarning(t *testing.T) {
	body := func(v any) map[string]any {
		b := map[string]any{
			"places_feature": "test:inner",
			"search_volume":  map[string]any{"min": []any{float64(0), float64(-4), float64(0)}, "max": []any{float64(0), float64(0), float64(0)}},
			"search_axis":    "-y",
		}
		if v != nil {
			b["required_successes"] = v
		}
		return b
	}

	var warnings []string
	ctx := &BuildContext{Palette: block.NewPalette(), Identifier: "t", FileID: "t",
		Warn: func(m string) { warnings = append(warnings, m) }}

	f, err := buildSearchFeature(body(float64(0)), ctx)
	if err != nil {
		t.Fatalf("required_successes 0 was refused: %v", err)
	}
	if got := f.(*SearchFeature).requiredSuccesses; got != 0 {
		t.Errorf("requiredSuccesses = %d, want 0 (kept as written, not repaired to 1)", got)
	}
	if len(warnings) == 0 {
		t.Error("required_successes 0 loaded with no warning about what it does")
	}

	if _, err := buildSearchFeature(body(float64(-1)), ctx); err == nil {
		t.Error("a negative required_successes was accepted")
	}
	if _, err := buildSearchFeature(body(float64(2.5)), ctx); err == nil {
		t.Error("a fractional required_successes was accepted")
	}
	if _, err := buildSearchFeature(body(nil), ctx); err != nil {
		t.Errorf("omitted required_successes was refused: %v", err)
	}
}
