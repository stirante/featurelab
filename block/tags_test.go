package block

import "testing"

// TestLoadBlockTags_TolerateJsoncComments is the direct regression test for the jsonc.StripComments
// pre-pass LoadBlockTags now runs before parsing each blocks/*.json file: a real vanilla-style
// block file with a "//" line comment (and a "/* */" block comment) must parse cleanly instead of
// producing an "invalid JSON" diagnostic.
func TestLoadBlockTags_TolerateJsoncComments(t *testing.T) {
	p := NewPalette()
	diags := p.LoadBlockTags([]SourceFile{
		{ID: "commented.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "wiki:commented"},
				"components": {
					// a vanilla-style line comment
					"tag:wiki:commented_tag": {} /* and a block comment */
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}
	m := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "q.any_tag('wiki:commented_tag')"}}, nil, nil, nil)
	commentedID := p.Get("wiki:commented", nil)
	if !m.Contains(commentedID) {
		t.Fatal("expected wiki:commented to carry wiki:commented_tag despite the JSON comments")
	}
}

// TestResolve_ProducingPosition_UnchangedApproximateBehavior pins that
// Resolve -- the PRODUCING-position path (places_block and similar) -- is
// deliberately left exactly as it was: a negated tag expression still has
// no single representative block and still falls back to AirID, recorded
// in UnresolvedTags. This is the "leave producing positions alone" half of
// the fix; TestMatchSet_NegatedTagPredicate_DoesNotCollapseToAirOnly below
// is its predicate-position counterpart, and the two together demonstrate
// Resolve and NewMatchSet no longer being conflated: same expression,
// deliberately different (and both individually correct FOR THEIR OWN
// position kind) answers.
func TestResolve_ProducingPosition_UnchangedApproximateBehavior(t *testing.T) {
	p := NewPalette()
	got := p.Resolve(Descriptor{IsTags: true, Tags: "!q.any_tag('water')"})
	if got != AirID {
		t.Errorf("Resolve(!q.any_tag('water')) = %v, want AirID (producing-position behavior must stay unchanged)", got)
	}
	if _, ok := p.UnresolvedTags["!q.any_tag('water')"]; !ok {
		t.Errorf("expected the unresolved negated expression to be recorded in UnresolvedTags")
	}
}

// TestMatchSet_NegatedTagPredicate_DoesNotCollapseToAirOnly is the direct
// regression test for the reported bug: wiki:blast_crater.clear_block's
// may_replace is `[{"tags": "!q.any_tag('water')"}]`, meaning "replace any
// block that is not water". The old Resolve-based predicate path collapsed
// this to "replace only air" (a negated expression has no single
// representative block, so it fell back to AirID). A MatchSet must match
// everything except (the approximated) water.
func TestMatchSet_NegatedTagPredicate_DoesNotCollapseToAirOnly(t *testing.T) {
	p := NewPalette()
	stoneID := p.Get("minecraft:stone", nil)
	dirtID := p.Get("minecraft:dirt", nil)
	waterID := p.Get("minecraft:water", nil)

	m := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "!q.any_tag('water')"}}, nil, nil, nil)

	if !m.Contains(stoneID) {
		t.Error("expected the negated water predicate to match minecraft:stone (the bug: it used to match only air)")
	}
	if !m.Contains(dirtID) {
		t.Error("expected the negated water predicate to match minecraft:dirt")
	}
	if !m.Contains(AirID) {
		t.Error("expected the negated water predicate to match minecraft:air too (air is not water)")
	}
	if m.Contains(waterID) {
		t.Error("expected the negated water predicate to NOT match minecraft:water")
	}
}

// TestMatchSet_PositiveTagPredicate_ApproximateVanillaTable documents the
// curated table's known, explicit limitation for the predicate path: with
// no real vanilla tag data, `q.any_tag('stone')` can only claim ONE
// representative block (minecraft:stone) actually carries the "stone" tag,
// so a real vanilla stone-family block the table doesn't name (granite)
// does NOT match. This is the documented approximation, not a bug -- see
// tagRepresentativeBlock's doc comment in kind.go.
func TestMatchSet_PositiveTagPredicate_ApproximateVanillaTable(t *testing.T) {
	p := NewPalette()
	stoneID := p.Get("minecraft:stone", nil)
	graniteID := p.Get("minecraft:granite", nil)

	m := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "q.any_tag('stone')"}}, nil, nil, nil)

	if !m.Contains(stoneID) {
		t.Error("expected q.any_tag('stone') to match the table's representative block minecraft:stone")
	}
	if m.Contains(graniteID) {
		t.Error("expected q.any_tag('stone') to NOT match minecraft:granite -- documented approximate-table limitation")
	}
}

// TestLoadBlockTags_CustomPackTag_Authoritative is the direct regression
// test for wiki:dune_water_safe_air_shaver.f, whose may_replace is
// `[{"tags": "!q.any_tag('wiki:dune_shaver_excluded')"}]` --  a
// PACK-declared, custom-namespaced tag with no entry in (and no business
// being in) the curated vanilla table. LoadBlockTags is the only source
// that can resolve it.
func TestLoadBlockTags_CustomPackTag_Authoritative(t *testing.T) {
	p := NewPalette()
	duneCrystalID := p.Get("wiki:dune_crystal", nil)
	stoneID := p.Get("minecraft:stone", nil)

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "dunes/dune_crystal.b.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "wiki:dune_crystal"},
				"components": {
					"tag:wiki:dune_shaver_excluded": {},
					"tag:minecraft:is_pickaxe_item_destructible": {}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}

	m := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "!q.any_tag('wiki:dune_shaver_excluded')"}}, nil, nil, nil)

	if m.Contains(duneCrystalID) {
		t.Error("expected the negated custom-tag predicate to NOT match wiki:dune_crystal (it IS pack-tagged excluded)")
	}
	if !m.Contains(stoneID) {
		t.Error("expected the negated custom-tag predicate to match minecraft:stone (not pack-tagged excluded)")
	}
	if !m.Contains(AirID) {
		t.Error("expected the negated custom-tag predicate to match minecraft:air")
	}
}

// TestLoadBlockTags_LaterFileOverridesEarlierSameIdentifier is the direct
// regression test for LoadBlockTags's override contract (see its own doc
// comment): pack.Load appends the generated vanilla default catalogue
// BEFORE a pack's own blocks/ files, and a user-pack block with the same
// id must override the vanilla entry -- entirely, not merge with it,
// exactly like a higher-priority pack overriding a lower one in game. This
// simulates that ordering directly against LoadBlockTags (the one
// consumer that actually acts on []SourceFile block data) with two files
// sharing an identifier: an earlier "vanilla-like" declaration carrying a
// tag the later "user-like" declaration does not repeat, plus a tag the
// later declaration adds that the earlier one never had. A merge/union
// implementation would keep the earlier-only tag; a correct override
// implementation drops it.
func TestLoadBlockTags_LaterFileOverridesEarlierSameIdentifier(t *testing.T) {
	p := NewPalette()
	diags := p.LoadBlockTags([]SourceFile{
		{ID: "vanilla/minecraft__stone.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "minecraft:stone"},
				"components": {"tag:only_in_vanilla": {}}
			}
		}`},
		{ID: "user/stone_override.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "minecraft:stone"},
				"components": {"tag:only_in_user": {}}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}

	stoneID := p.Get("minecraft:stone", nil)

	userTag := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "q.any_tag('only_in_user')"}}, nil, nil, nil)
	if !userTag.Contains(stoneID) {
		t.Error("expected minecraft:stone to carry only_in_user -- the later (user-pack) file's own tag")
	}

	vanillaTag := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "q.any_tag('only_in_vanilla')"}}, nil, nil, nil)
	if vanillaTag.Contains(stoneID) {
		t.Error("expected minecraft:stone to NOT carry only_in_vanilla -- the later file must override, not merge with, the earlier declaration")
	}
}

// TestNewMatchSet_UnknownTag_ReportsOnceViaCallback pins the diagnostic
// contract: a tag literal that is resolvable from neither real pack data
// nor the curated approximate table must be reported through the
// unknownTag callback exactly once per distinct name, never silently
// swallowed -- and a tag that IS resolvable (from either source) must NOT
// be reported.
func TestNewMatchSet_UnknownTag_ReportsOnceViaCallback(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{
		{ID: "a.json", Text: `{"minecraft:block": {"description": {"identifier": "wiki:a"}, "components": {"tag:wiki:known": {}}}}`},
	})

	var reported []string
	p.NewMatchSet([]Descriptor{
		{IsTags: true, Tags: "q.any_tag('wiki:known')"},                   // pack-declared -- known
		{IsTags: true, Tags: "q.any_tag('water')"},                        // curated table -- known
		{IsTags: true, Tags: "q.any_tag('totally_unknown_made_up_tag')"},  // neither -- must report
		{IsTags: true, Tags: "!q.any_tag('totally_unknown_made_up_tag')"}, // same name again -- must NOT double-report
	}, func(tagName string) { reported = append(reported, tagName) }, nil, nil)

	if len(reported) != 1 || reported[0] != "totally_unknown_made_up_tag" {
		t.Errorf("reported unknown tags = %v, want exactly [\"totally_unknown_made_up_tag\"]", reported)
	}
}

// TestMatchSet_Empty mirrors the "no may_replace list -> no restriction"
// semantics every predicate-position caller in featurelab-go/features
// relies on (passesAllowList's own `len(ids) == 0` fast path before this
// change).
func TestMatchSet_Empty(t *testing.T) {
	p := NewPalette()
	if !p.NewMatchSet(nil, nil, nil, nil).Empty() {
		t.Error("NewMatchSet(nil) should be Empty")
	}
	if p.NewMatchSet([]Descriptor{{Name: "minecraft:stone"}}, nil, nil, nil).Empty() {
		t.Error("NewMatchSet with a plain descriptor should not be Empty")
	}
	if p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "q.any_tag('water')"}}, nil, nil, nil).Empty() {
		t.Error("NewMatchSet with a tag descriptor should not be Empty")
	}
}

// TestMatchSet_PlainDescriptor_StillFastSetMembership pins that a plain
// name/state descriptor's behavior (the overwhelming majority of
// may_replace/may_attach_to entries in real packs) is completely
// unaffected by this change: still exact-id set membership.
func TestMatchSet_PlainDescriptor_StillFastSetMembership(t *testing.T) {
	p := NewPalette()
	stoneID := p.Get("minecraft:stone", nil)
	dirtID := p.Get("minecraft:dirt", nil)

	m := p.NewMatchSet([]Descriptor{{Name: "minecraft:stone"}}, nil, nil, nil)
	if !m.Contains(stoneID) {
		t.Error("expected plain-name MatchSet to match minecraft:stone")
	}
	if m.Contains(dirtID) {
		t.Error("expected plain-name MatchSet to NOT match minecraft:dirt")
	}
}

// ---------------------------------------------------------------------------
// MatchMode -- the three comparisons a match list can use. See MatchMode's own
// doc comment in tags.go for which JSON field uses which and why they differ.
// ---------------------------------------------------------------------------

// TestMatchSet_BareEntryMatchesAnyStateOfTheSameBlock pins the change that
// mattered: under the default MatchPartial a descriptor written as a bare NAME
// compares the block type alone, so it matches that block in any state.
//
// This is written as a table over all three modes on purpose. The bug it
// replaces was not "one mode was wrong" but "there was only one mode", and the
// only way to state the fix is to show that the same pair of blocks answers
// differently depending on which field is asking. A test of MatchPartial alone
// would pass just as happily if MatchType and MatchExact silently became
// aliases of it.
func TestMatchSet_BareEntryMatchesAnyStateOfTheSameBlock(t *testing.T) {
	p := NewPalette()
	bare := p.Get("minecraft:oak_log", nil)
	rotated := p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "x"})
	other := p.Get("minecraft:birch_log", nil)

	if bare == rotated {
		t.Fatal("the palette interned oak_log and oak_log#pillar_axis=x as one id; this test needs them distinct")
	}

	for _, tc := range []struct {
		mode                  MatchMode
		name                  string
		wantBare, wantRotated bool
	}{
		// The engine compares the block type for a bare descriptor, and
		// every state of one block shares one block type -- so an oak log in any
		// orientation matches. This is what nearly every match list does, and
		// what this port used to get wrong in the direction that hides: it
		// placed LESS than the game, and a self-comparing digest cannot see a
		// feature that should have run and didn't.
		{MatchPartial, "partial", true, true},
		// Ore's replace_rules[].may_replace discards states outright; for a bare
		// entry that is indistinguishable from partial.
		{MatchType, "type", true, true},
		// allowed_surface_blocks compares the whole serialization id, so a
		// rotated log is a different block from a bare one.
		{MatchExact, "exact", true, false},
	} {
		m := p.NewMatchSet([]Descriptor{{Name: "minecraft:oak_log"}}, nil, nil, nil).WithMode(tc.mode)
		if got := m.Contains(bare); got != tc.wantBare {
			t.Errorf("%s: Contains(oak_log) = %v, want %v", tc.name, got, tc.wantBare)
		}
		if got := m.Contains(rotated); got != tc.wantRotated {
			t.Errorf("%s: Contains(oak_log#pillar_axis=x) = %v, want %v", tc.name, got, tc.wantRotated)
		}
		if m.Contains(other) {
			t.Errorf("%s: Contains(birch_log) = true, want false -- a different block must never match", tc.name)
		}
	}
}

// TestMatchSet_StatedEntryComparesOnlyTheStatesItWrote pins the other half of
// the partial predicate: an entry that DOES spell states out compares the name
// plus only those states, ignoring every other state the candidate carries.
//
// Rare in real packs -- but it is the case
// that separates MatchPartial from MatchType, so it is the case that proves the
// two are not the same code path.
//
// It also pins COMPLETION, which is what the state catalogue bought this file.
// `minecraft:oak_log` declares pillar_axis with a default of `y`, so a cell
// interned with no states at all IS a y-axis log and has to match an entry that
// wrote `pillar_axis: y`. Until the catalogue landed this package could not tell
// "bare" from "at its default" and answered false, which made a stated entry
// silently miss every bare-interned cell -- and terrain is interned bare
// everywhere in env/.
func TestMatchSet_StatedEntryComparesOnlyTheStatesItWrote(t *testing.T) {
	p := NewPalette()
	// The candidate carries the written state AND another one the entry says
	// nothing about; the extra state must not stop it matching.
	matching := p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "y", "some_other_state": 3})
	conflicting := p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "x"})
	// Interned with nothing: the default permutation, i.e. pillar_axis=y.
	bare := p.Get("minecraft:oak_log", nil)

	descs := []Descriptor{{Name: "minecraft:oak_log", States: map[string]StateValue{"pillar_axis": "y"}}}

	partial := p.NewMatchSet(descs, nil, nil, nil)
	if !partial.Contains(matching) {
		t.Error("partial: a candidate agreeing on the written state must match, whatever else it carries")
	}
	if partial.Contains(conflicting) {
		t.Error("partial: a candidate disagreeing on the written state must not match")
	}
	if !partial.Contains(bare) {
		t.Error("partial: a state-less candidate is that type's default permutation -- oak_log's pillar_axis default is y, so it must match")
	}

	// MatchType throws the written states away, so all three are the same block.
	byType := partial.WithMode(MatchType)
	for _, id := range []ID{matching, conflicting, bare} {
		if !byType.Contains(id) {
			t.Errorf("type: Contains(%v) = false; ore's rules keep only the block type and discard written states", p.Entry(id).CanonicalString())
		}
	}

	// MatchExact compares the whole block once BOTH sides are completed to the
	// type's defaults, which is what the engine does for allowed_surface_blocks:
	// it resolves the descriptor to one concrete Block and compares the hash of
	// its full serialization id.
	exact := partial.WithMode(MatchExact)
	if !exact.Contains(bare) {
		t.Error("exact: a bare cell completes to pillar_axis=y, which is what the entry wrote")
	}
	if !exact.Contains(p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "y"})) {
		t.Error("exact: the identically-spelled candidate must match")
	}
	if exact.Contains(conflicting) {
		t.Error("exact: pillar_axis=x is a different block from pillar_axis=y")
	}
	if exact.Contains(matching) {
		t.Error("exact: a candidate carrying a state the type does not declare is not the same block")
	}
}

// TestMatchSet_BareEntryCompletesToTheTypesDefault is the case the whole
// completion exists for, written from the side a pack author meets it: a BARE
// entry in an exact-comparison list against a cell some other feature wrote with
// its states spelled out.
//
// A structure template is the everyday source of such a cell -- an .mcstructure
// palette always carries every state at a concrete value -- so before completion
// a bare `minecraft:oak_log` in allowed_surface_blocks matched no
// structure-placed log at all, while the game matches the ones whose axis is the
// default. The two assertions below are the two halves of that: the default axis
// matches, a different axis does not.
func TestMatchSet_BareEntryCompletesToTheTypesDefault(t *testing.T) {
	p := NewPalette()
	m := p.NewMatchSet([]Descriptor{{Name: "minecraft:oak_log"}}, nil, nil, nil).WithMode(MatchExact)

	if !m.Contains(p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "y"})) {
		t.Error("a bare entry means the default permutation, and oak_log's pillar_axis default is y")
	}
	if m.Contains(p.Get("minecraft:oak_log", map[string]StateValue{"pillar_axis": "x"})) {
		t.Error("a bare entry must NOT match a non-default axis -- that is a different block")
	}

	// A type the catalogue does not know has no defaults to complete with, so
	// this falls back to comparing exactly what was written. Answering anything
	// else would mean guessing what a pack's own block carries when freshly
	// placed, and matching a list the game would refuse.
	custom := p.NewMatchSet([]Descriptor{{Name: "wiki:custom_pillar"}}, nil, nil, nil).WithMode(MatchExact)
	if !custom.Contains(p.Get("wiki:custom_pillar", nil)) {
		t.Error("unknown type, both sides bare: must still match")
	}
	if custom.Contains(p.Get("wiki:custom_pillar", map[string]StateValue{"axis": "x"})) {
		t.Error("unknown type: with no defaults to complete with, only an identical spelling may match")
	}
}

// TestMatchSet_LegacyAliasDescriptorMatchesWhatItInternedTo is a regression
// test for the worst bug the mode rewrite introduced, and the one no existing
// test could have caught: it needed a descriptor whose states are consumed by
// alias resolution, and every test here used a state that survives it.
//
// `minecraft:leaves` with `old_leaf_type: oak` is the standard vanilla spelling
// of an oak leaf in a match list. Interning resolves it to `minecraft:oak_leaves`
// with NO states, because the discriminator has been spent naming the block. The
// set recorded the interned NAME but the descriptor's ORIGINAL states, so it held
// a literal demanding `old_leaf_type` of a type that does not declare it -- and
// matched nothing at all, not even the block it had just interned to.
func TestMatchSet_LegacyAliasDescriptorMatchesWhatItInternedTo(t *testing.T) {
	p := NewPalette()
	oak := p.Get("minecraft:leaves", map[string]StateValue{"old_leaf_type": "oak"})
	if got := p.Entry(oak).CanonicalString(); got != "minecraft:oak_leaves" {
		t.Fatalf("the alias no longer resolves the way this test needs: %s", got)
	}

	m := p.NewMatchSet([]Descriptor{{Name: "minecraft:leaves",
		States: map[string]StateValue{"old_leaf_type": "oak"}}}, nil, nil, nil)
	for _, mode := range []MatchMode{MatchPartial, MatchType, MatchExact} {
		if !m.WithMode(mode).Contains(oak) {
			t.Errorf("mode %d: an aliased descriptor must match the block it interns to", mode)
		}
	}
	// And still not a different leaf.
	if m.Contains(p.Get("minecraft:leaves", map[string]StateValue{"old_leaf_type": "birch"})) {
		t.Error("an oak-leaf descriptor must not match birch leaves")
	}
}

// TestMatchSet_BooleanStateSurvivesItsTwoSpellings pins the comparison across
// the two ways this codebase produces one boolean value.
//
// The state catalogue gives a Go `bool`; NBT gives a `float64`, because a
// structure palette stores the state as TAG_Byte and the decoder widens every
// integral tag. Rendering both and comparing text gives "false" against "0",
// which never matches -- so completion silently did nothing for boolean states,
// and boolean states are exactly the ones a structure spells out and an author
// does not (`persistent_bit`, `update_bit`). Every test here used an enum state,
// which is why this shipped.
func TestMatchSet_BooleanStateSurvivesItsTwoSpellings(t *testing.T) {
	p := NewPalette()
	def, ok := LookupVanillaState("minecraft:oak_leaves", "persistent_bit")
	if !ok {
		t.Skip("catalogue does not declare persistent_bit on oak_leaves")
	}
	if _, isBool := def.Default.(bool); !isBool {
		t.Fatalf("this test exists for a bool default; got %T", def.Default)
	}

	// A cell as a structure writes it: every state spelled out, as numbers.
	atDefault := p.Get("minecraft:oak_leaves", map[string]StateValue{
		"persistent_bit": float64(0), "update_bit": float64(0)})
	flipped := p.Get("minecraft:oak_leaves", map[string]StateValue{
		"persistent_bit": float64(1), "update_bit": float64(0)})

	bare := p.NewMatchSet([]Descriptor{{Name: "minecraft:oak_leaves"}}, nil, nil, nil).WithMode(MatchExact)
	if !bare.Contains(atDefault) {
		t.Error("a bare entry completes to the type's defaults, so a cell at those defaults must match")
	}
	if bare.Contains(flipped) {
		t.Error("a cell whose boolean state is NOT the default is a different block and must not match")
	}
}

// TestMatchSet_ContainsSurvivesAForeignPaletteID guards a crash, not a
// behaviour. Comparing by NAME means looking the candidate up, and a caller
// holding two palettes can hand over an id this one never interned. Entry
// panics on that by design; Contains is a predicate run thousands of times per
// feature against whatever the world offers, so it answers false instead.
//
// Not hypothetical: this is exactly what a structure-template test was doing --
// building its allowlist against a second, empty palette and passing anyway,
// because the only id it had to recognise was air and air is a fixed id
// everywhere. It was fixed, but the guard stays.
func TestMatchSet_ContainsSurvivesAForeignPaletteID(t *testing.T) {
	p := NewPalette()
	m := p.NewMatchSet([]Descriptor{{Name: "minecraft:stone"}}, nil, nil, nil)

	other := NewPalette()
	for i := 0; i < 50; i++ {
		other.Get("minecraft:filler", map[string]StateValue{"n": i})
	}
	foreign := other.Get("minecraft:stone", nil)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Contains panicked on an id from another palette: %v", r)
		}
	}()
	if m.Contains(foreign) {
		t.Error("an id this palette never interned must not match")
	}
}

// ---------------------------------------------------------------------------
// minecraft:placement_filter -- see tags.go's own "minecraft:placement_filter"
// section for the full derivation these tests pin against.
// ---------------------------------------------------------------------------

// TestPlacementFilterAllows_AbsentComponent_AlwaysAllows pins the block's own "component
// absent -> skip the AND" shape: a block that never appeared in any loaded blocks/*.json file (or a
// palette that never called LoadBlockTags at all) must be unrestricted, regardless of face/anchor.
func TestPlacementFilterAllows_AbsentComponent_AlwaysAllows(t *testing.T) {
	p := NewPalette()
	stoneID := p.Get("minecraft:stone", nil)
	airID := AirID

	// No LoadBlockTags call at all.
	if !p.PlacementFilterAllows(stoneID, 1, airID) {
		t.Error("want true -- placementFilterData is nil, no LoadBlockTags call has ever happened")
	}

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "unrelated.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "minecraft:dirt"},
				"components": {}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none", diags)
	}
	for face := 0; face < 6; face++ {
		if !p.PlacementFilterAllows(stoneID, face, airID) {
			t.Errorf("face %d: want true -- minecraft:stone never declared minecraft:placement_filter at all", face)
		}
	}
}

// TestPlacementFilterAllows_FaceGatesCondition pins the face-matching half directly: a single
// condition scoped to "up" (per-face bit table bit 2, block.FacingDirection value 1) must allow
// when face=1 and refuse for every other face, matching a real "grass"-filtered block_filter.
func TestPlacementFilterAllows_FaceGatesCondition(t *testing.T) {
	p := NewPalette()
	customID := p.Get("addonpack:custom_bud", nil)
	grassID := p.Get("minecraft:grass_block", nil)
	stoneID := p.Get("minecraft:stone", nil)

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "custom_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:custom_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [
							{"allowed_faces": ["up"], "block_filter": ["minecraft:grass_block"]}
						]
					}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none: %+v", len(diags), diags)
	}

	const up = 1 // block.FacingDirection's own Down=0,Up=1,North=2,South=3,West=4,East=5 domain
	if !p.PlacementFilterAllows(customID, up, grassID) {
		t.Error("want true -- face=up matches allowed_faces, anchor is grass_block (matches block_filter)")
	}
	for _, face := range []int{0, 2, 3, 4, 5} { // Down, North, South, West, East
		if p.PlacementFilterAllows(customID, face, grassID) {
			t.Errorf("face %d: want false -- allowed_faces is [\"up\"] only", face)
		}
	}
	if p.PlacementFilterAllows(customID, up, stoneID) {
		t.Error("want false -- face=up matches allowed_faces, but anchor (stone) does not match block_filter ([grass_block])")
	}
}

// TestPlacementFilterAllows_TagBlockFilter pins that block_filter's {"tags": "..."} shape reuses
// this file's own MatchSet predicate machinery (NOT a narrower name-only matcher) -- block_filter's
// JSON schema is exactly a block-descriptor list, and the game's own examples mix name
// strings and {"tags": ...} entries in the same block_filter array.
func TestPlacementFilterAllows_TagBlockFilter(t *testing.T) {
	p := NewPalette()
	customID := p.Get("addonpack:custom_bud", nil)
	dirtID := p.Get("minecraft:dirt", nil)
	stoneID := p.Get("minecraft:stone", nil)

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "custom_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:custom_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [
							{"allowed_faces": ["down"], "block_filter": [{"tags": "q.any_tag('dirt')"}]}
						]
					}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none: %+v", len(diags), diags)
	}

	const down = 0
	if !p.PlacementFilterAllows(customID, down, dirtID) {
		t.Error("want true -- dirt matches the approximate vanilla \"dirt\" tag table (block/kind.go)")
	}
	if p.PlacementFilterAllows(customID, down, stoneID) {
		t.Error("want false -- stone does not match q.any_tag('dirt')")
	}
}

// TestPlacementFilterAllows_SideAndAllKeywords pins the two convenience allowed_faces values
// [CONFIRMED]: "side" = the four horizontal
// faces (north/south/west/east, NOT up/down), "all" = every one of the six.
func TestPlacementFilterAllows_SideAndAllKeywords(t *testing.T) {
	p := NewPalette()
	sideID := p.Get("addonpack:side_bud", nil)
	allID := p.Get("addonpack:all_bud", nil)
	stoneID := p.Get("minecraft:stone", nil)

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "side_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:side_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"allowed_faces": ["side"], "block_filter": ["minecraft:stone"]}]
					}
				}
			}
		}`},
		{ID: "all_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:all_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"allowed_faces": ["all"], "block_filter": ["minecraft:stone"]}]
					}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none: %+v", len(diags), diags)
	}

	// "side": north(2)/south(3)/west(4)/east(5) allowed, up(1)/down(0) refused.
	for _, face := range []int{2, 3, 4, 5} {
		if !p.PlacementFilterAllows(sideID, face, stoneID) {
			t.Errorf("side_bud face %d: want true (side = the four horizontal faces)", face)
		}
	}
	for _, face := range []int{0, 1} {
		if p.PlacementFilterAllows(sideID, face, stoneID) {
			t.Errorf("side_bud face %d: want false (side excludes up/down)", face)
		}
	}
	// "all": every one of the six faces allowed.
	for face := 0; face < 6; face++ {
		if !p.PlacementFilterAllows(allID, face, stoneID) {
			t.Errorf("all_bud face %d: want true (all = every face)", face)
		}
	}
}

// TestPlacementFilterAllows_ZeroConditionsDeniesOutright pins the placement-filter component's
// check and its empty-list behaviour directly: an empty condition list returns false --
// a component declared with an empty "conditions" array denies every placement outright, it is not
// the same as the component being absent.
func TestPlacementFilterAllows_ZeroConditionsDeniesOutright(t *testing.T) {
	p := NewPalette()
	customID := p.Get("addonpack:empty_bud", nil)
	stoneID := p.Get("minecraft:stone", nil)

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "empty_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:empty_bud"},
				"components": {
					"minecraft:placement_filter": {"conditions": []}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none: %+v", len(diags), diags)
	}
	for face := 0; face < 6; face++ {
		if p.PlacementFilterAllows(customID, face, stoneID) {
			t.Errorf("face %d: want false -- an empty conditions array denies outright (confirmed), not the same as no component", face)
		}
	}
}

// TestPlacementFilterAllows_UnknownAllowedFacesValueDiagnosed pins the diagnostic path for a
// typo'd/unsupported allowed_faces string (the game's own content log says "Unknown
// `allowed_faces` value of `%s`"): reported, contributes no bits, and any
// OTHER value in the same array still takes effect.
func TestPlacementFilterAllows_UnknownAllowedFacesValueDiagnosed(t *testing.T) {
	p := NewPalette()
	customID := p.Get("addonpack:custom_bud", nil)
	stoneID := p.Get("minecraft:stone", nil)

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "custom_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:custom_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"allowed_faces": ["up", "diagonal"], "block_filter": ["minecraft:stone"]}]
					}
				}
			}
		}`},
	})
	if len(diags) != 1 || diags[0].Level != "warning" {
		t.Fatalf("diagnostics = %+v, want exactly one warning", diags)
	}
	const up = 1
	if !p.PlacementFilterAllows(customID, up, stoneID) {
		t.Error("want true -- \"up\" is still valid despite the sibling \"diagonal\" typo")
	}
}

// TestPlacementFilterAllows_AllowedFacesAbsent_NeverFires pins this port's own INFERRED default
// for a condition with no allowed_faces key at all (a real, schema-legal shape per the game's
// own block examples -- see tags.go's header): mask stays 0, so the condition can never
// fire on any face, the conservative (never over-permissive) reading.
func TestPlacementFilterAllows_AllowedFacesAbsent_NeverFires(t *testing.T) {
	p := NewPalette()
	customID := p.Get("addonpack:custom_bud", nil)
	stoneID := p.Get("minecraft:stone", nil)

	diags := p.LoadBlockTags([]SourceFile{
		{ID: "custom_bud.json", Text: `{
			"minecraft:block": {
				"description": {"identifier": "addonpack:custom_bud"},
				"components": {
					"minecraft:placement_filter": {
						"conditions": [{"block_filter": ["minecraft:stone"]}]
					}
				}
			}
		}`},
	})
	if len(diags) != 0 {
		t.Fatalf("LoadBlockTags diagnostics = %+v, want none: %+v", len(diags), diags)
	}
	for face := 0; face < 6; face++ {
		if p.PlacementFilterAllows(customID, face, stoneID) {
			t.Errorf("face %d: want false -- allowed_faces absent infers mask=0 (never fires)", face)
		}
	}
}

// TestMatchSet_AllEntriesUnbuildableMatchesNothing pins the direction of a failure that used to
// run the wrong way round, silently.
//
// Every predicate site in this codebase reads MatchSet.Empty() as "no list was written, so
// anything matches". A {"tags": ...} entry whose Molang fails to parse contributes nothing to
// ids or programs -- so a list whose entries were ALL broken looked identical to no list at all,
// and the strictest possible restriction became the most permissive one. A feature with
// `may_replace: [{"tags": "this is not molang (("}]` carved through solid stone, and both
// `check` and `generate` exited 0.
func TestMatchSet_AllEntriesUnbuildableMatchesNothing(t *testing.T) {
	pal := NewPalette()
	stone := pal.Get("minecraft:stone", nil)

	broken := pal.NewMatchSet([]Descriptor{{IsTags: true, Tags: "this is not molang (("}}, nil, nil, nil)
	if broken.Empty() {
		t.Fatal("a list whose only entry failed to build reports Empty() -- every caller reads that " +
			"as \"no restriction, anything matches\", which is the exact inversion this guards")
	}
	if !broken.Unbuildable() {
		t.Error("Unbuildable() must be true so a caller can say so in a diagnostic")
	}
	if broken.Contains(stone) {
		t.Error("an unevaluable restriction must match nothing, not everything")
	}
	if broken.Contains(AirID) {
		t.Error("an unevaluable restriction must match nothing, not everything")
	}
	if len(pal.UnresolvedTags) == 0 {
		t.Error("the broken expression must still be recorded in UnresolvedTags")
	}

	// A genuinely absent list is still the permissive case, and must stay that way.
	none := pal.NewMatchSet(nil, nil, nil, nil)
	if !none.Empty() || none.Unbuildable() {
		t.Error("no descriptors at all is the \"no restriction\" case and must remain Empty()")
	}

	// One broken entry beside a good one leaves a working restriction: the good entry still
	// matches, the broken one adds nothing, and the set is not reported as unbuildable.
	mixed := pal.NewMatchSet([]Descriptor{
		{Name: "minecraft:stone"},
		{IsTags: true, Tags: "still not molang (("},
	}, nil, nil, nil)
	if mixed.Empty() || mixed.Unbuildable() {
		t.Error("a list with one working entry is neither empty nor unbuildable")
	}
	if !mixed.Contains(stone) {
		t.Error("the entry that DID build must still match")
	}
	if mixed.Contains(AirID) {
		t.Error("a broken entry must not widen the set")
	}
}

// TestMatchSet_ReportsAQueryABlockPredicateCannotAnswer pins the report for the quietest failure
// in this file's subject matter.
//
// A block predicate is evaluated with a two-function query set -- any_tag and all_tags. Anything
// else resolves to 0, which is faithful to the engine and is exactly what makes it dangerous
// here: the expression parses, compiles, evaluates without error, and is false for every block,
// for ever. `q.any_tags('air')` is one letter from `q.any_tag('air')`. The only message an author
// would otherwise get is a runtime "may_replace rejected this position", which points at the list
// rather than at the typo inside it.
func TestMatchSet_ReportsAQueryABlockPredicateCannotAnswer(t *testing.T) {
	collect := func(tags string) []string {
		t.Helper()
		var queries []string
		NewPalette().NewMatchSet([]Descriptor{{IsTags: true, Tags: tags}}, nil,
			func(q string) { queries = append(queries, q) }, nil)
		return queries
	}

	if got := collect("q.any_tags('air')"); len(got) != 1 || got[0] != "any_tags" {
		t.Errorf("a one-letter typo must be reported by name, got %v", got)
	}
	if got := collect("q.heightmap(0,0) > 3"); len(got) != 1 || got[0] != "heightmap" {
		t.Errorf("a real worldgen query that a BLOCK predicate cannot answer must be reported, got %v", got)
	}
	if got := collect("q.any_tag('air') || q.all_tags('stone')"); len(got) != 0 {
		t.Errorf("the two queries a block predicate does answer must stay quiet, got %v", got)
	}
	// Case-insensitively, and once per distinct name however many times it is called.
	if got := collect("q.ANY_TAGS('a') || q.any_tags('b') || q.nope(1)"); len(got) != 2 {
		t.Fatalf("want two distinct names, got %v", got)
	}
}

// TestMatchSet_APredicateThatDrawsDoesNotCrash pins the fix for the worst failure this file could
// produce. molang-go dereferences its RNG without checking, and nothing here supplied one, so a
// tag predicate containing math.random -- legal Molang that no other check rejects -- took the
// whole process down with a nil dereference. A pack author wrote a valid expression and the tool
// died without telling them anything.
func TestMatchSet_APredicateThatDrawsDoesNotCrash(t *testing.T) {
	pal := NewPalette()
	stone := pal.Get("minecraft:stone", nil)

	var reported []string
	m := pal.NewMatchSet([]Descriptor{{IsTags: true, Tags: "math.random(0,1) < 0.5"}}, nil, nil,
		func(expr string) { reported = append(reported, expr) })

	// The point of the test: this call used to panic.
	m.Contains(stone)
	m.Contains(AirID)

	if len(reported) != 1 {
		t.Fatalf("a drawing predicate must be disclosed exactly once, got %v", reported)
	}

	// Deterministic: two sets built from the same expression draw the same sequence, so a preview
	// reproduces even though the game's own source for this randomness does not.
	seq := func() []bool {
		s := pal.NewMatchSet([]Descriptor{{IsTags: true, Tags: "math.random(0,1) < 0.5"}}, nil, nil, nil)
		out := make([]bool, 8)
		for i := range out {
			out[i] = s.Contains(stone)
		}
		return out
	}
	a, b := seq(), seq()
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("draw %d differed between two sets built from the same expression: %v vs %v", i, a, b)
		}
	}

	// A predicate that does NOT draw must not be reported, and must not get a generator either.
	var quiet []string
	pal.NewMatchSet([]Descriptor{{IsTags: true, Tags: "q.any_tag('stone')"}}, nil, nil,
		func(expr string) { quiet = append(quiet, expr) })
	if len(quiet) != 0 {
		t.Errorf("an ordinary tag predicate must not be reported as drawing, got %v", quiet)
	}
}

// TestMatchSet_UnsetReadsAreFoundStaticallyAndDoNotStopThePredicate pins both
// halves of how this package handles a block predicate that reads a Molang
// scope slot.
//
// The scope Contains evaluates against is empty by construction, so such a read
// is unresolved every time, for every candidate block. In the engine that ENDS
// the expression where it stands; here it yields 0 and the rest of the
// predicate still runs, which is why the second case below matches at all. The
// divergence is reported from the AST at BUILD time (UnsetReads) rather than
// per candidate block -- a predicate is evaluated thousands of times per
// feature, and this file already has the "say it once, when the pack loads"
// shape for every other predicate diagnostic.
func TestMatchSet_UnsetReadsAreFoundStaticallyAndDoNotStopThePredicate(t *testing.T) {
	p := NewPalette()
	stoneID := p.Get("minecraft:stone", nil)

	// The read is 0, so `v.gate + 1` is truthy and the predicate matches -- in
	// the engine the expression would have stopped at the read instead.
	m := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "v.gate + 1"}}, nil, nil, nil)
	if got := m.UnsetReads(); len(got) != 1 || got[0] != "variable.gate" {
		t.Fatalf("UnsetReads() = %v, want [variable.gate]", got)
	}
	if !m.Contains(stoneID) {
		t.Error("evaluation must CONTINUE past the unresolved read (0 + 1 is truthy), not stop at it")
	}

	// A guarded read is not a divergence: `??` behaves identically here and in
	// the engine, so reporting it would cry wolf over the idiom packs write.
	// An assignment TARGET is a write, not a read, and neither is the trailing
	// `return t.x` -- the statement before it wrote the slot, so that read
	// resolves. See unguardedScopeReads for why "written anywhere in this
	// expression" is the (flow-insensitive, deliberately quiet) rule.
	guarded := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "t.x = t.x ?? 1; return t.x;"}}, nil, nil, nil)
	if got := guarded.UnsetReads(); len(got) != 0 {
		t.Errorf("UnsetReads() = %v, want none -- the read is guarded and the target is a write", got)
	}
	if !guarded.Contains(stoneID) {
		t.Error("`t.x = t.x ?? 1` must take the right-hand side and evaluate truthy")
	}

	// The guard covers its LEFT side only, so the right-hand read is still one.
	rhs := p.NewMatchSet([]Descriptor{{IsTags: true, Tags: "v.a ?? v.b"}}, nil, nil, nil)
	if got := rhs.UnsetReads(); len(got) != 1 || got[0] != "variable.b" {
		t.Errorf("UnsetReads() = %v, want [variable.b] -- `??` covers its LHS and nothing else", got)
	}
}
