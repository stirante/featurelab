package rules

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/features"
)

func ruleDiagnosticsFor(t *testing.T, id, text string) []features.Diagnostic {
	t.Helper()
	var diags []features.Diagnostic
	var failed []features.FailedFile
	parseRuleFile(SourceFile{ID: id, Text: text}, &diags, &failed)
	return diags
}

func findRuleDiag(t *testing.T, diags []features.Diagnostic, contains string) features.Diagnostic {
	t.Helper()
	for _, d := range diags {
		if strings.Contains(d.Message, contains) {
			return d
		}
	}
	t.Fatalf("no diagnostic containing %q, got %+v", contains, diags)
	return features.Diagnostic{}
}

// The rule loader makes the same "this key must be an object" check the feature loader does, and
// had the same 0,0 position for it.
func TestParseRuleFile_WrongTypeForTheBodyKeyPointsAtTheValue(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:feature_rules\": 7\n}\n"
	d := findRuleDiag(t, ruleDiagnosticsFor(t, "r.json", text), "must be an object")
	if d.Line != 3 {
		t.Errorf("Line = %d, want 3", d.Line)
	}
	if d.Column == 0 {
		t.Errorf("Column = %d, want the value's column", d.Column)
	}
}

func TestParseRuleFile_MissingDescriptionPointsAtTheBody(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:feature_rules\": {\n    \"conditions\": {}\n  }\n}\n"
	d := findRuleDiag(t, ruleDiagnosticsFor(t, "r.json", text), `"description" is required`)
	if d.Line != 3 {
		t.Errorf("Line = %d, want 3 (the body, since there is no description to point at)", d.Line)
	}
}

func TestParseRuleFile_MissingIdentifierPointsAtTheDescription(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:feature_rules\": {\n    \"description\": {\n    }\n  }\n}\n"
	d := findRuleDiag(t, ruleDiagnosticsFor(t, "r.json", text), "description.identifier")
	if d.Line != 4 {
		t.Errorf("Line = %d, want 4 (the description object)", d.Line)
	}
}

// Same shared wording and the same warning level as the feature loader -- one finding, one
// sentence, whichever kind of file it is in.
func TestParseRuleFile_DuplicateKeyIsAPositionedWarning(t *testing.T) {
	text := "{\n  \"format_version\": \"1.21.10\",\n  \"minecraft:feature_rules\": {\n" +
		"    \"description\": {\n      \"identifier\": \"wiki:r\",\n      \"identifier\": \"wiki:r2\",\n" +
		"      \"places_feature\": \"wiki:f\"\n    },\n" +
		"    \"conditions\": { \"placement_pass\": \"surface_pass\" },\n" +
		"    \"distribution\": { \"iterations\": 1, \"x\": 0, \"y\": 0, \"z\": 0 }\n  }\n}\n"
	diags := ruleDiagnosticsFor(t, "r.json", text)
	d := findRuleDiag(t, diags, "written twice")
	if d.Level != "warning" {
		t.Errorf("Level = %q, want warning", d.Level)
	}
	if d.Line != 5 {
		t.Errorf("Line = %d, want 5 (the occurrence that has no effect)", d.Line)
	}
	if !strings.Contains(d.Message, "keeps the last one") {
		t.Errorf("message = %q", d.Message)
	}
}
