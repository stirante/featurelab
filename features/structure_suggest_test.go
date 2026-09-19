package features

import (
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/structures"
)

// namedStructures is a resolver that also knows what it holds -- the optional half of
// structures.IResolver that the diagnostic type-asserts for.
type namedStructures struct {
	names map[string]*structures.ResolvedStructure
}

func (n namedStructures) Resolve(name string) *structures.ResolvedStructure { return n.names[name] }

func (n namedStructures) Names() []string {
	out := make([]string, 0, len(n.names))
	for k := range n.names {
		out = append(out, k)
	}
	return out
}

// anonymousStructures resolves and cannot enumerate -- the shape a minimal test double (or a
// future lazy resolver) has. The diagnostic must still work, just with less to say.
type anonymousStructures struct{}

func (anonymousStructures) Resolve(string) *structures.ResolvedStructure { return nil }

func structureTemplateBody(name string) map[string]any {
	return map[string]any{
		"description":    map[string]any{"identifier": "wiki:s"},
		"structure_name": name,
	}
}

// The same forgotten-namespace failure as everywhere else: structures are keyed
// "namespace:path" off their directory layout, and a pack author writing the bare name gets a
// refusal that used to name nothing they could act on.
func TestStructureTemplate_UnknownNameOffersTheNamespacedMatch(t *testing.T) {
	ctx := &BuildContext{
		Palette: block.NewPalette(),
		Structures: namedStructures{names: map[string]*structures.ResolvedStructure{
			"wiki:fallen_log": {},
		}},
		Warn: func(string) {},
	}
	_, err := buildStructureTemplateFeature(structureTemplateBody("fallen_log"), ctx)
	if err == nil {
		t.Fatal("expected an error for a structure_name the library does not hold")
	}
	if !strings.Contains(err.Error(), "was not found in the loaded structures") {
		t.Errorf("error = %q, want the existing sentence kept", err)
	}
	if !strings.Contains(err.Error(), `did you mean "wiki:fallen_log"`) {
		t.Errorf("error = %q, want the namespaced structure offered", err)
	}
}

func TestStructureTemplate_NoSuggestionWhenNothingIsClose(t *testing.T) {
	ctx := &BuildContext{
		Palette: block.NewPalette(),
		Structures: namedStructures{names: map[string]*structures.ResolvedStructure{
			"wiki:completely_unrelated": {},
		}},
		Warn: func(string) {},
	}
	_, err := buildStructureTemplateFeature(structureTemplateBody("fallen_log"), ctx)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "did you mean") {
		t.Errorf("error = %q, want no guess when nothing is close", err)
	}
}

// A resolver that cannot enumerate produces the message with nothing on the end rather than
// failing -- which is why this is an optional interface and not a method on IResolver.
func TestStructureTemplate_ResolverThatCannotListStillReports(t *testing.T) {
	ctx := &BuildContext{Palette: block.NewPalette(), Structures: anonymousStructures{}, Warn: func(string) {}}
	_, err := buildStructureTemplateFeature(structureTemplateBody("fallen_log"), ctx)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "was not found in the loaded structures") {
		t.Errorf("error = %q", err)
	}
	if strings.Contains(err.Error(), "did you mean") {
		t.Errorf("error = %q, want no suggestion from a resolver that cannot list", err)
	}
}
