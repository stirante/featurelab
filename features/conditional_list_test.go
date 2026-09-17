// conditional_list_test.go exercises ConditionalListFeature's 1.26.50.24
// contract: the default early_out_scheme is "none" (evaluate every entry,
// return the LAST successful placement), condition_success ends the list at
// the first true condition whether or not that placement succeeds,
// placement_success walks past failed placements and returns the first
// engaged result. Also covers the whole-list abort on an unresolved entry
// (new in 1.26.50.24 -- 1.26.40.26 skipped the entry), the optional
// condition defaulting to constant-true, the worldx/worldy/worldz AND
// originx/originy/originz Molang wiring, and the parse-level requirements
// (conditional_features, the early_out_scheme enum, the legacy-key migration
// hint). No golden regression scene exercises this type, so these tests are
// the only thing standing between a wrong port and a caller. See
// conditional_list.go's header for the behaviour.
package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/wgen"
)

// condStub is a delegate that records calls and returns a fixed result
// (nil = placement failure).
type condStub struct {
	id     string
	called int
	result *wgen.BlockPos
}

func (s *condStub) TypeID() string     { return "test:cond_stub" }
func (s *condStub) Identifier() string { return s.id }
func (s *condStub) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	s.called++
	return s.result
}

// condResolver resolves by id from a fixed map.
type condResolver map[string]wgen.IFeature

func (r condResolver) Resolve(identifier string) wgen.IFeature { return r[identifier] }

func buildTestConditionalList(t *testing.T, resolver wgen.IFeatureResolver, body map[string]any) wgen.IFeature {
	t.Helper()
	ctx := &BuildContext{Palette: block.NewPalette(), Resolver: resolver, Identifier: "test:cond_list", FileID: "test:cond_list", Warn: func(string) {}}
	f, err := buildConditionalListFeature(body, ctx)
	if err != nil {
		t.Fatalf("buildConditionalListFeature: %v", err)
	}
	return f
}

func condCtx(origin wgen.BlockPos) *wgen.PlacementContext {
	return &wgen.PlacementContext{
		Origin:      origin,
		MolangScope: wgen.NewScope(),
		Biome:       &wgen.MolangBiome{ID: "test:biome", Tags: map[string]struct{}{}},
		LogFailure:  func(featureType, message string, pos wgen.BlockPos) {},
	}
}

func entry(ref string, cond any) map[string]any {
	return map[string]any{"places_feature": ref, "condition": cond}
}

// TestConditionalListDefaultEvaluatesAllEntries pins the 1.26.50.24 default:
// early_out_scheme defaults to "none", so EVERY true-condition entry places
// and the feature returns the LAST successful placement's position.
func TestConditionalListDefaultEvaluatesAllEntries(t *testing.T) {
	pos1 := wgen.BlockPos{X: 1, Y: 2, Z: 3}
	pos2 := wgen.BlockPos{X: 4, Y: 5, Z: 6}
	first := &condStub{id: "test:first", result: &pos1}
	second := &condStub{id: "test:second", result: &pos2}
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second}, map[string]any{
		"conditional_features": []any{entry("test:first", true), entry("test:second", true)},
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got == nil || *got != pos2 {
		t.Fatalf("expected the LAST successful entry's result %v, got %v", pos2, got)
	}
	if first.called != 1 || second.called != 1 {
		t.Fatalf("expected BOTH entries to place under the default none scheme (got first=%d second=%d)", first.called, second.called)
	}
}

// TestConditionalListNoneKeepsWalkingPastFailures: under none, a failed
// placement neither stops the walk nor clears an earlier success.
func TestConditionalListNoneKeepsWalkingPastFailures(t *testing.T) {
	pos := wgen.BlockPos{X: 7, Y: 8, Z: 9}
	first := &condStub{id: "test:first", result: &pos}
	second := &condStub{id: "test:second", result: nil} // placement fails
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second}, map[string]any{
		"conditional_features": []any{entry("test:first", true), entry("test:second", true)},
		"early_out_scheme":     "none",
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got == nil || *got != pos {
		t.Fatalf("expected the earlier success %v to survive the later failure, got %v", pos, got)
	}
	if first.called != 1 || second.called != 1 {
		t.Fatalf("expected both entries attempted (got first=%d second=%d)", first.called, second.called)
	}
}

// TestConditionalListNoneAllFail: none with no successful placement returns
// nil.
func TestConditionalListNoneAllFail(t *testing.T) {
	first := &condStub{id: "test:first", result: nil}
	second := &condStub{id: "test:second", result: nil}
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second}, map[string]any{
		"conditional_features": []any{entry("test:first", true), entry("test:second", true)},
	})
	if got := f.Place(condCtx(wgen.BlockPos{})); got != nil {
		t.Fatalf("expected nil when every placement fails, got %v", got)
	}
	if first.called != 1 || second.called != 1 {
		t.Fatalf("expected both entries attempted (got first=%d second=%d)", first.called, second.called)
	}
}

func TestConditionalListConditionSuccessStopsAtFirstTrueCondition(t *testing.T) {
	pos := wgen.BlockPos{X: 1, Y: 2, Z: 3}
	first := &condStub{id: "test:first", result: &pos}
	second := &condStub{id: "test:second", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second}, map[string]any{
		"conditional_features": []any{entry("test:first", true), entry("test:second", true)},
		"early_out_scheme":     "condition_success",
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got == nil || *got != pos {
		t.Fatalf("expected first entry's result %v, got %v", pos, got)
	}
	if first.called != 1 || second.called != 0 {
		t.Fatalf("expected only the first entry to place (got first=%d second=%d)", first.called, second.called)
	}
}

func TestConditionalListFalseConditionSkipsEntry(t *testing.T) {
	pos := wgen.BlockPos{X: 4, Y: 5, Z: 6}
	first := &condStub{id: "test:first", result: &pos}
	second := &condStub{id: "test:second", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second}, map[string]any{
		"conditional_features": []any{entry("test:first", false), entry("test:second", float64(1))},
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got == nil {
		t.Fatal("expected the second entry's result, got nil")
	}
	if first.called != 0 || second.called != 1 {
		t.Fatalf("expected only the second entry to place (got first=%d second=%d)", first.called, second.called)
	}
}

// TestConditionalListOmittedConditionAlwaysPlaces: condition is optional as
// of 1.26.50.24 -- an absent condition is a constant-true expression.
func TestConditionalListOmittedConditionAlwaysPlaces(t *testing.T) {
	pos := wgen.BlockPos{X: 4, Y: 5, Z: 6}
	first := &condStub{id: "test:first", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:first": first}, map[string]any{
		"conditional_features": []any{map[string]any{"places_feature": "test:first"}},
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got == nil || *got != pos {
		t.Fatalf("expected the condition-less entry to place, got %v", got)
	}
	if first.called != 1 {
		t.Fatalf("expected exactly one placement, got %d", first.called)
	}
}

func TestConditionalListConditionSuccessEndsOnFailedPlacement(t *testing.T) {
	pos := wgen.BlockPos{X: 7, Y: 8, Z: 9}
	first := &condStub{id: "test:first", result: nil} // placement fails
	second := &condStub{id: "test:second", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second}, map[string]any{
		"conditional_features": []any{entry("test:first", true), entry("test:second", true)},
		"early_out_scheme":     "condition_success",
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got != nil {
		t.Fatalf("expected nil (first true condition's placement failed, list ends), got %v", got)
	}
	if first.called != 1 || second.called != 0 {
		t.Fatalf("expected the failed first attempt to end the list (got first=%d second=%d)", first.called, second.called)
	}
}

func TestConditionalListPlacementSuccessWalksPastFailedPlacement(t *testing.T) {
	pos := wgen.BlockPos{X: 10, Y: 11, Z: 12}
	first := &condStub{id: "test:first", result: nil} // placement fails
	second := &condStub{id: "test:second", result: &pos}
	third := &condStub{id: "test:third", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second, "test:third": third}, map[string]any{
		"conditional_features": []any{entry("test:first", true), entry("test:second", true), entry("test:third", true)},
		"early_out_scheme":     "placement_success",
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got == nil || *got != pos {
		t.Fatalf("expected the second entry's result %v, got %v", pos, got)
	}
	if first.called != 1 || second.called != 1 || third.called != 0 {
		t.Fatalf("expected first (failed) then second (success), third never (got %d/%d/%d)", first.called, second.called, third.called)
	}
}

// TestConditionalListUnresolvedEntryAbortsList pins the 1.26.50.24 change:
// an unresolved places_feature reference ends the WHOLE list ("Feature not
// found!"), it no longer skips just the entry the way 1.26.40.26 did.
func TestConditionalListUnresolvedEntryAbortsList(t *testing.T) {
	pos := wgen.BlockPos{X: 13, Y: 14, Z: 15}
	second := &condStub{id: "test:second", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:second": second}, map[string]any{
		"conditional_features": []any{entry("test:missing", true), entry("test:second", true)},
	})
	var logged []string
	ctx := condCtx(wgen.BlockPos{})
	ctx.LogFailure = func(featureType, message string, pos wgen.BlockPos) { logged = append(logged, message) }
	got := f.Place(ctx)
	if got != nil {
		t.Fatalf("expected nil (unresolved first entry aborts the list before anything places), got %v", got)
	}
	if second.called != 0 {
		t.Fatalf("expected the entry after the unresolved one to never run, got %d calls", second.called)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "not found") {
		t.Fatalf("expected one 'Feature not found!' failure log, got %v", logged)
	}
}

// TestConditionalListUnresolvedAbortKeepsEarlierNoneSuccess: the abort
// returns the accumulated result, so a success recorded before the
// unresolved entry survives it under the default none scheme.
func TestConditionalListUnresolvedAbortKeepsEarlierNoneSuccess(t *testing.T) {
	pos := wgen.BlockPos{X: 16, Y: 17, Z: 18}
	first := &condStub{id: "test:first", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:first": first}, map[string]any{
		"conditional_features": []any{entry("test:first", true), entry("test:missing", true)},
	})
	got := f.Place(condCtx(wgen.BlockPos{}))
	if got == nil || *got != pos {
		t.Fatalf("expected the pre-abort success %v to be returned, got %v", pos, got)
	}
	if first.called != 1 {
		t.Fatalf("expected the first entry to have placed once, got %d", first.called)
	}
}

func TestConditionalListWorldAndOriginPositionVisibleToCondition(t *testing.T) {
	pos := wgen.BlockPos{X: 16, Y: 17, Z: 18}
	first := &condStub{id: "test:first", result: &pos}
	second := &condStub{id: "test:second", result: &pos}
	third := &condStub{id: "test:third", result: &pos}
	f := buildTestConditionalList(t, condResolver{"test:first": first, "test:second": second, "test:third": third}, map[string]any{
		"conditional_features": []any{
			entry("test:first", "variable.worldx > 100"),
			entry("test:second", "variable.worldx == 7 && variable.worldz == -2"),
			// originx/originy/originz (new in 1.26.50.24) carry the same
			// origin values as worldx/worldy/worldz.
			entry("test:third", "variable.originx == 7 && variable.originz == -2 && variable.originy == variable.worldy"),
		},
	})
	got := f.Place(condCtx(wgen.BlockPos{X: 7, Y: 0, Z: -2}))
	if got == nil {
		t.Fatal("expected the position-gated entries to place, got nil")
	}
	if first.called != 0 || second.called != 1 || third.called != 1 {
		t.Fatalf("expected the second and third entries only (got first=%d second=%d third=%d)", first.called, second.called, third.called)
	}
}

func TestConditionalListParseErrors(t *testing.T) {
	ctx := &BuildContext{Palette: block.NewPalette(), Resolver: condResolver{}, Identifier: "test:cond_list", FileID: "test:cond_list", Warn: func(string) {}}

	if _, err := buildConditionalListFeature(map[string]any{}, ctx); err == nil || !strings.Contains(err.Error(), "conditional_features is required") {
		t.Fatalf("expected missing-key error, got %v", err)
	}
	if _, err := buildConditionalListFeature(map[string]any{"conditional_list": []any{}}, ctx); err == nil || !strings.Contains(err.Error(), "earlier guess") {
		t.Fatalf("expected legacy-key migration hint, got %v", err)
	}
	// condition is optional (1.26.50.24) -- an entry with only
	// places_feature must parse.
	if _, err := buildConditionalListFeature(map[string]any{
		"conditional_features": []any{map[string]any{"places_feature": "test:x"}},
	}, ctx); err != nil {
		t.Fatalf("expected condition-less entry to parse, got %v", err)
	}
	// ...but a present condition of the wrong type still errors.
	if _, err := buildConditionalListFeature(map[string]any{
		"conditional_features": []any{map[string]any{"places_feature": "test:x", "condition": []any{}}},
	}, ctx); err == nil || !strings.Contains(err.Error(), "condition must be") {
		t.Fatalf("expected condition-type error, got %v", err)
	}
	// "none" is a real enum value now; the retired guess "first_success"
	// still is not.
	if _, err := buildConditionalListFeature(map[string]any{
		"conditional_features": []any{entry("test:x", true)},
		"early_out_scheme":     "none",
	}, ctx); err != nil {
		t.Fatalf(`expected early_out_scheme "none" to parse, got %v`, err)
	}
	if _, err := buildConditionalListFeature(map[string]any{
		"conditional_features": []any{entry("test:x", true)},
		"early_out_scheme":     "first_success",
	}, ctx); err == nil || !strings.Contains(err.Error(), "early_out_scheme") {
		t.Fatalf("expected early_out_scheme enum error, got %v", err)
	}
}
