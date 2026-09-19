package session

import (
	"fmt"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/internal/nearest"
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
//     renamed-rule case, most often a forgotten namespace, a rename or a typo (see
//     internal/nearest for the near-match this case gets).
//
//   - the identifier IS declared by a loaded file, but that file failed to build (an unknown
//     feature type, a builder error) -- Library/FeatureRuleLibrary never add a failed build to
//     byIdentifier, so Resolve(id) is nil for a completely different reason. The underlying build
//     diagnostic is already folded into this result's own Diagnostics (lib.Diagnostics/
//     ruleLib.Diagnostics, appended unconditionally further down in generate()), but it is keyed by
//     the file's own fileId, not the identifier a caller asked for -- a caller has no way to connect
//     the two without this explicit pointer.
//
//   - a file in the pack could not be PARSED at all (truncated JSON, a missing comma), so it
//     produced no entry for anything and the loader never learned which identifier it declares.
//     This one used to be indistinguishable from the first: `generate` against a pack with one
//     truncated feature file answered "not defined by the loaded pack (55 loaded, 55 built)",
//     which is a confident, wrong statement about a feature the author can see spelled out in
//     the file in front of them. See matchFailedFile/failedFileMessage.
//
// Both also report how many features/rules the pack loaded, so "not found" reads distinguishably
// from "the pack loaded nothing at all" -- two very different problems that otherwise look
// identical from the caller's side. They report ONLY that one number. The message used to end
// "(55 feature(s) loaded, 55 built successfully)", and the second half of that is this tool's
// internal bookkeeping: a pack author cannot act on it, it is the same number as the first in
// every healthy pack, and it took the place of the thing they can act on -- see nearest.Phrase,
// which is what ends these sentences now.
//
// Every diagnostic here is ScopeRun: it is about the identifier THIS call asked for, and it says
// nothing about the pack that would be true of a run that asked for something else. The
// underlying "this file is broken" diagnostic remains separately reported, ScopePack, by
// whichever library build raised it.
// spell is the function that turns a loader-side file id into the path a client opens -- see
// packpaths.go. Both of these quote a FILE at the reader ("is declared by X, but that file
// could not be loaded"), and a message that names a file by a different string than the
// diagnostic beside it names the same file by is a message that reads as being about a
// different file.
func unresolvedFeatureDiagnostic(identifier string, lib *features.Library, spell func(string) string) Diagnostic {
	total := len(lib.Entries)
	for _, e := range lib.Entries {
		if e.Identifier == identifier {
			return Diagnostic{
				Level: "error", FileID: identifier, Scope: ScopeRun, Count: 1,
				Message: fmt.Sprintf(
					"feature %q is declared by the loaded pack (in %s) but failed to build -- see that file's own diagnostic for why",
					identifier, spell(e.FileID)),
			}
		}
	}
	// A file that never PARSED has no Entry to match above -- that is the whole difference
	// between "failed to build" and "failed to load", and the reason a truncated feature file
	// used to produce the flatly wrong "not defined by the loaded pack" for an identifier the
	// author can see written in the file in front of them. lib.Failed is that third case.
	if failed, exact := matchFailedFile(identifier, lib.Failed); failed != nil {
		return Diagnostic{
			Level: "error", FileID: identifier, Scope: ScopeRun, Count: 1,
			Message: failedFileMessage("feature", identifier, *failed, exact, spell),
		}
	}
	message := fmt.Sprintf("feature %q is not defined by the loaded pack (%d feature(s) loaded)", identifier, total) +
		nearest.Phrase(identifier, featureEntryIdentifiers(lib.Entries))
	return Diagnostic{Level: "error", FileID: identifier, Scope: ScopeRun, Count: 1, Message: message}
}

// matchFailedFile picks the unreadable file to blame for an identifier that resolved to
// nothing. exact is true when that file's own text actually spells the identifier asked for
// (features.FailedFile.Identifier), which lets the caller say "this is your feature's file"
// rather than "one of these files failed to load".
//
// With no exact match it returns the FIRST failed file, if there is one at all. That is
// deliberately a weaker claim and is worded as one: the identifier a pack author asked for has
// to be declared SOMEWHERE, and a file that could not be read is the only candidate the loader
// cannot see inside -- so naming it is the single most useful thing to say, while "not defined
// by this pack" (the wording without this) is a statement the loader is in no position to make
// while any file in the pack is unreadable.
func matchFailedFile(identifier string, failed []features.FailedFile) (*features.FailedFile, bool) {
	for i := range failed {
		if failed[i].Identifier == identifier {
			return &failed[i], true
		}
	}
	if len(failed) > 0 {
		return &failed[0], false
	}
	return nil, false
}

// failedFileMessage words the two cases matchFailedFile distinguishes. kind is "feature" or
// "rule" so the two callers read naturally without either of them owning a copy of this text.
func failedFileMessage(kind, identifier string, failed features.FailedFile, exact bool, spell func(string) string) string {
	if exact {
		return fmt.Sprintf(
			"%s %q is declared by %s, but that file could not be loaded at all, so the %s does not exist in this "+
				"pack: %s",
			kind, identifier, spell(failed.FileID), kind, failed.Message)
	}
	return fmt.Sprintf(
		"%s %q did not resolve, and %s could not be loaded at all (%s) -- fix that file first: until it loads, "+
			"nothing it declares exists in this pack",
		kind, identifier, spell(failed.FileID), failed.Message)
}

func unresolvedRuleDiagnostic(identifier string, ruleLib *rules.FeatureRuleLibrary, spell func(string) string) Diagnostic {
	var entries []rules.FeatureRuleEntry
	var failedFiles []features.FailedFile
	if ruleLib != nil {
		entries = ruleLib.Entries
		failedFiles = ruleLib.Failed
	}
	total := len(entries)
	for _, e := range entries {
		if e.Identifier == identifier {
			return Diagnostic{
				Level: "error", FileID: identifier, Scope: ScopeRun, Count: 1,
				Message: fmt.Sprintf(
					"rule %q is declared by the loaded pack (in %s) but failed to build -- see that file's own diagnostic for why",
					identifier, spell(e.FileID)),
			}
		}
	}
	// Same third case as features above: a rule file that never parsed has no Entry at all.
	if failed, exact := matchFailedFile(identifier, failedFiles); failed != nil {
		return Diagnostic{
			Level: "error", FileID: identifier, Scope: ScopeRun, Count: 1,
			Message: failedFileMessage("rule", identifier, *failed, exact, spell),
		}
	}
	message := fmt.Sprintf("rule %q is not defined by the loaded pack (%d rule(s) loaded)", identifier, total) +
		nearest.Phrase(identifier, ruleEntryIdentifiers(entries))
	return Diagnostic{Level: "error", FileID: identifier, Scope: ScopeRun, Count: 1, Message: message}
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

// biomeEntryIdentifiers feeds the same near-match machinery from the biome library, for the
// --biome-id case. A mistyped biome id is not merely "not found": it falls back to the
// environment preset's own materials and then generates perfectly happily, so the ONLY thing
// that distinguishes it from a deliberate choice is this sentence.
func biomeEntryIdentifiers(entries []biomes.Entry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Identifier
	}
	return out
}
