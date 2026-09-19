package session

// failedfile_test.go covers, at the session layer, what a file that could not be PARSED does --
// as opposed to one that parsed and then failed to build, which the library entries already
// described. The two used to be indistinguishable from outside: a failed build leaves an entry
// with a nil feature, a failed parse leaves nothing at all, and "nothing at all" was reported
// as "the loaded pack does not define that".

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/rules"
	"github.com/stirante/featurelab/structures"
)

const truncatedRuleJSON = `{
  "format_version": "1.21.110",
  "minecraft:feature_rules": {
    "description": {
      "identifier": "test:broken_rule",
      "places_feature": "test:good"
    },
    "conditions":`

func workspaceWithBrokenFiles(t *testing.T) *Workspace {
	t.Helper()
	return NewWorkspace(
		[]features.SourceFile{
			{ID: "good.json", Text: `{"format_version":"1.21.110","minecraft:single_block_feature":{` +
				`"description":{"identifier":"test:good"},"places_block":"minecraft:stone"}}`},
			{ID: "broken.json", Text: "{\n  \"format_version\": \"1.21.110\",\n  \"minecraft:single_block_feature\": {\n" +
				"    \"description\": {\"identifier\": \"test:broken\"},\n    \"places_block\":"},
		},
		[]structures.SourceFile{},
		[]rules.SourceFile{{ID: "broken_rule.json", Text: truncatedRuleJSON}},
		[]biomes.SourceFile{},
		nil,
	)
}

// TestWorkspace_CountsSeparateFilesFromLoaded is the count half of the silent-broken-file bug:
// the number a caller reports must be what the pack can use, with the on-disk number still
// available beside it rather than replacing it.
func TestWorkspace_CountsSeparateFilesFromLoaded(t *testing.T) {
	ws := workspaceWithBrokenFiles(t)
	counts := ws.Counts()

	if counts.Features.Files != 2 || counts.Features.Loaded != 1 {
		t.Errorf("feature counts = %+v, want {Files:2 Loaded:1}", counts.Features)
	}
	if counts.Rules.Files != 1 || counts.Rules.Loaded != 0 {
		t.Errorf("rule counts = %+v, want {Files:1 Loaded:0}", counts.Rules)
	}
}

// TestWorkspace_PackDiagnosticsNameTheUnreadableFile pins that the diagnostics exist at LOAD
// time, name the file, carry a position, and are all pack-scoped -- none of which required
// running a placement.
func TestWorkspace_PackDiagnosticsNameTheUnreadableFile(t *testing.T) {
	ws := workspaceWithBrokenFiles(t)

	var named []string
	for _, d := range ws.PackDiagnostics() {
		if d.Scope != ScopePack {
			t.Errorf("diagnostic from a library build is scoped %q, want %q: %+v", d.Scope, ScopePack, d)
		}
		if d.Level != "error" || !strings.Contains(d.Message, "invalid JSON") {
			continue
		}
		named = append(named, d.FileID)
		if d.Line == 0 || d.Column == 0 {
			t.Errorf("invalid-JSON diagnostic for %s carries no position: %+v", d.FileID, d)
		}
	}
	for _, want := range []string{"broken.json", "broken_rule.json"} {
		found := false
		for _, got := range named {
			if got == want {
				found = true
			}
		}
		if !found {
			t.Errorf("no invalid-JSON diagnostic names %s; got %v", want, named)
		}
	}
}

// TestGenerate_NamingAFeatureWhoseFileFailedToParse is the run-scoped half. The identifier is
// recoverable from the broken file's own text, so the message says outright that this is that
// feature's file -- rather than the old wording, which asserted the pack does not define it.
func TestGenerate_NamingAFeatureWhoseFileFailedToParse(t *testing.T) {
	ws := workspaceWithBrokenFiles(t)
	cfg, ok := DefaultConfig("void")
	if !ok {
		t.Fatal("void preset missing")
	}
	id := "test:broken"
	cfg.FeatureIdentifier = &id

	result, err := ws.Generate(cfg)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	var runErrors []Diagnostic
	for _, d := range result.Diagnostics {
		if d.Scope == ScopeRun && d.Level == "error" {
			runErrors = append(runErrors, d)
		}
	}
	if len(runErrors) != 1 {
		t.Fatalf("run-scoped errors = %+v, want exactly one explaining this run", runErrors)
	}
	msg := runErrors[0].Message
	for _, want := range []string{`"test:broken"`, "broken.json", "could not be loaded"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message = %q, want it to mention %q", msg, want)
		}
	}
}

// TestGenerate_NamingARuleWhoseFileFailedToParse is the same for rule mode, where the truncated
// file's identifier is also still readable.
func TestGenerate_NamingARuleWhoseFileFailedToParse(t *testing.T) {
	ws := workspaceWithBrokenFiles(t)
	cfg, ok := DefaultConfig("void")
	if !ok {
		t.Fatal("void preset missing")
	}
	cfg.Mode = ModeRule
	id := "test:broken_rule"
	cfg.RuleIdentifier = &id

	result, err := ws.Generate(cfg)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	found := ""
	for _, d := range result.Diagnostics {
		if d.Scope == ScopeRun && d.Level == "error" {
			found = d.Message
		}
	}
	if !strings.Contains(found, "broken_rule.json") || !strings.Contains(found, "could not be loaded") {
		t.Errorf("rule-mode message = %q, want it to name the unreadable file", found)
	}
}

// TestGenerate_UnknownIdentifierStillSaysNotDefined guards the wording that must NOT change:
// with every file in the pack readable, an identifier that is genuinely absent still gets the
// plain "not defined by the loaded pack", not a broken-file story borrowed from somewhere else.
func TestGenerate_UnknownIdentifierStillSaysNotDefined(t *testing.T) {
	ws := NewWorkspace(
		[]features.SourceFile{{ID: "good.json", Text: `{"format_version":"1.21.110","minecraft:single_block_feature":{` +
			`"description":{"identifier":"test:good"},"places_block":"minecraft:stone"}}`}},
		nil, nil, nil, nil,
	)
	cfg, _ := DefaultConfig("void")
	id := "test:nowhere"
	cfg.FeatureIdentifier = &id

	result, err := ws.Generate(cfg)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	found := ""
	for _, d := range result.Diagnostics {
		if d.Scope == ScopeRun && d.Level == "error" {
			found = d.Message
		}
	}
	if !strings.Contains(found, "is not defined by the loaded pack") {
		t.Errorf("message = %q, want the plain not-defined wording when no file failed to load", found)
	}
}
