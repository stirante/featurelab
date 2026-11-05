package jigsaw

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/jsonc"
)

// SourceFile is one JSON file from a worldgen folder.
type SourceFile struct {
	ID      string
	AbsPath string
	Text    string
}

// Sources are the four worldgen folders of a pack.
type Sources struct {
	Processors []SourceFile
	Pools      []SourceFile
	Structures []SourceFile
	Sets       []SourceFile
}

// Diagnostic is one problem found while loading or checking definitions.
type Diagnostic struct {
	Level   string
	FileID  string
	Message string
}

// Library holds every jigsaw definition of a pack.
type Library struct {
	Diagnostics []Diagnostic
	structures  map[string]*Structure
	pools       map[string]*templatePool
	processors  map[string][]processor
	sets        []*structureSet
	unmodelled  map[string][]string
	palette     *block.Palette
}

type fileKind struct {
	rootKey string
	load    func(l *Library, f SourceFile, body map[string]any, identifier string) error
}

var fileKinds = []struct {
	files func(Sources) []SourceFile
	kind  fileKind
}{
	{func(s Sources) []SourceFile { return s.Processors }, fileKind{"minecraft:processor_list", (*Library).loadProcessorList}},
	{func(s Sources) []SourceFile { return s.Pools }, fileKind{"minecraft:template_pool", (*Library).loadPool}},
	{func(s Sources) []SourceFile { return s.Structures }, fileKind{"minecraft:jigsaw", (*Library).loadStructure}},
	{func(s Sources) []SourceFile { return s.Sets }, fileKind{"minecraft:structure_set", (*Library).loadSet}},
}

// BuildLibrary parses every definition. A file that fails is skipped with a diagnostic.
func BuildLibrary(src Sources, palette *block.Palette) *Library {
	l := &Library{
		structures: map[string]*Structure{},
		pools:      map[string]*templatePool{},
		processors: map[string][]processor{},
		unmodelled: map[string][]string{},
		palette:    palette,
	}
	for _, entry := range fileKinds {
		for _, f := range entry.files(src) {
			l.loadFile(f, entry.kind)
		}
	}
	return l
}

func (l *Library) loadFile(f SourceFile, kind fileKind) {
	stripped := jsonc.StripComments([]byte(f.Text))
	var root map[string]any
	if err := json.Unmarshal(stripped, &root); err != nil {
		l.fail(f.ID, jsonc.InvalidJSONMessage(stripped, err))
		return
	}
	body, ok := root[kind.rootKey].(map[string]any)
	if !ok {
		l.fail(f.ID, fmt.Sprintf("the root key %q is missing", kind.rootKey))
		return
	}
	description, _ := body["description"].(map[string]any)
	identifier, _ := description["identifier"].(string)
	if identifier == "" {
		l.fail(f.ID, "description.identifier is missing")
		return
	}
	if err := kind.load(l, f, body, identifier); err != nil {
		l.fail(f.ID, err.Error())
	}
}

func (l *Library) fail(fileID, message string) {
	l.Diagnostics = append(l.Diagnostics, Diagnostic{Level: "error", FileID: fileID, Message: message})
}

func (l *Library) warnAt(fileID, message string) {
	l.Diagnostics = append(l.Diagnostics, Diagnostic{Level: "warning", FileID: fileID, Message: message})
}

// Resolve finds a structure by its identifier.
func (l *Library) Resolve(identifier string) *Structure {
	if l == nil {
		return nil
	}
	return l.structures[identifier]
}

// Identifiers lists every structure identifier, sorted.
func (l *Library) Identifiers() []string {
	if l == nil {
		return nil
	}
	out := make([]string, 0, len(l.structures))
	for identifier := range l.structures {
		out = append(out, identifier)
	}
	sort.Strings(out)
	return out
}

func (l *Library) sortedPools() []*templatePool {
	out := make([]*templatePool, 0, len(l.pools))
	for _, pool := range l.pools {
		out = append(out, pool)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].identifier < out[j].identifier })
	return out
}

// Structures lists every structure in identifier order.
func (l *Library) Structures() []*Structure {
	identifiers := l.Identifiers()
	out := make([]*Structure, len(identifiers))
	for i, identifier := range identifiers {
		out[i] = l.structures[identifier]
	}
	return out
}
