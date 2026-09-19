package block

// unknown_names_test.go covers the block-table lookup behind the "this is not a
// block" warning: which tables KnowsBlockName consults, and that a descriptor
// resolved against a palette leaves a trace when the name is in none of them.

import (
	"testing"
)

// TestKnowsBlockName_AnswersForVanillaWithoutAnyLoaderHavingRun is the property
// the whole warning rests on. pack.Load happens to stack the vanilla catalogue
// under every pack, so the tag index usually carries it -- but a Palette built
// by hand does not, and a warning whose truth depends on load order would fire
// on minecraft:diamond_block.
func TestKnowsBlockName_AnswersForVanillaWithoutAnyLoaderHavingRun(t *testing.T) {
	p := NewPalette() // no LoadBlockTags
	for _, name := range []string{
		"minecraft:stone",
		"minecraft:diamond_block", // catalogue only; not in the built-in kind table
		"minecraft:bee_nest",      // same
		"stone",                   // unnamespaced, canonicalised before lookup
		"minecraft:log",           // legacy aggregate: a name, never a catalogue entry
	} {
		if !p.KnowsBlockName(name) {
			t.Errorf("KnowsBlockName(%q) = false, want true", name)
		}
	}
}

func TestKnowsBlockName_SaysNoToSomethingThatIsNotAnID(t *testing.T) {
	p := NewPalette()
	for _, name := range []string{"not even an id", "minecraft:definitely_not_a_block", "wiki:custom"} {
		if p.KnowsBlockName(name) {
			t.Errorf("KnowsBlockName(%q) = true, want false", name)
		}
	}
}

// TestKnowsBlockName_AcceptsABlockThePackItselfDeclares is why this is a
// warning and not an error anywhere: a pack's own blocks are real, and the only
// place they exist is the pack's blocks/ directory.
func TestKnowsBlockName_AcceptsABlockThePackItselfDeclares(t *testing.T) {
	p := NewPalette()
	p.LoadBlockTags([]SourceFile{{ID: "custom.json", Text: `{
		"format_version": "1.21.70",
		"minecraft:block": {"description": {"identifier": "wiki:custom"}, "components": {}}
	}`}})
	if !p.KnowsBlockName("wiki:custom") {
		t.Error("a block the pack declares must be known")
	}
	// And loading a pack's blocks must not cost the vanilla answers.
	if !p.KnowsBlockName("minecraft:diamond_block") {
		t.Error("loading a pack's own blocks dropped the vanilla catalogue")
	}
}

// TestTakeUnknownNames_RecordsBothDescriptorPositionsAndThenDrains: a producing
// position (Resolve) and a predicate position (NewMatchSet) both record, and the
// set drains so BuildLibrary can attribute names to the file that named them.
func TestTakeUnknownNames_RecordsBothDescriptorPositionsAndThenDrains(t *testing.T) {
	p := NewPalette()
	p.Resolve(Descriptor{Name: "wiki:made_up_places_block"})
	p.NewMatchSet([]Descriptor{{Name: "wiki:made_up_may_replace"}}, nil, nil, nil)
	p.Resolve(Descriptor{Name: "minecraft:stone"}) // real; must not be recorded

	got := p.TakeUnknownNames()
	want := []string{"wiki:made_up_may_replace", "wiki:made_up_places_block"}
	if len(got) != len(want) {
		t.Fatalf("TakeUnknownNames() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("TakeUnknownNames() = %v, want %v (sorted)", got, want)
		}
	}
	if again := p.TakeUnknownNames(); len(again) != 0 {
		t.Errorf("a second Take returned %v, want nothing -- the set must drain", again)
	}
}

// TestTakeUnknownNames_AnUnknownNameStillResolvesToARealID: recording is a
// report, not a refusal. The palette behaves exactly as it did.
func TestTakeUnknownNames_AnUnknownNameStillResolvesToARealID(t *testing.T) {
	p := NewPalette()
	id := p.Resolve(Descriptor{Name: "wiki:made_up"})
	if id == AirID {
		t.Fatal("an unknown block name must still intern as itself, not collapse to air")
	}
	if got := p.NameOf(id); got != "wiki:made_up" {
		t.Errorf("NameOf = %q, want the name as written", got)
	}
}
