// Package features is the feature-type registry/builder and the two
// implemented `minecraft:*_feature` types (scatter_feature,
// single_block_feature) plus the shared machinery (weighted pick,
// recursion guard, scatter distribution sampling) they and the rest
// of this package grow on.
package features

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/jsonc"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wgen"
)

// SourceFile is a features/*.json file as delivered by the pack loader.
type SourceFile struct {
	ID      string
	AbsPath string
	Text    string
}

// BuildContext is everything a builder needs: block interning plus lazy
// sibling lookup.
type BuildContext struct {
	Palette  *block.Palette
	Resolver wgen.IFeatureResolver
	// Structures resolves a structure_name to its parsed/interned
	// .mcstructure data. Structures are static assets loaded up front (like
	// the palette), so -- unlike feature refs -- this is resolved eagerly
	// at build time, not deferred to place-time. Never nil: BuildLibrary
	// defaults it to structures.NoStructures when the caller passes nil.
	Structures structures.IResolver
	// LegacyStructures resolves fossil_feature's own unnamespaced legacy structure keys
	// ("fossils/fossil_spine_01") -- see features/fossil.go's own doc comment and
	// structures/legacy.go. Never nil: BuildLibrary derives it from Structures via a type
	// assertion (structures.BuildLibrary's own *Library implements both IResolver and
	// ILegacyResolver), defaulting to structures.NoLegacyStructures when Structures doesn't
	// implement it (e.g. a test's own minimal hand-written IResolver) -- so a builder never needs
	// its own nil check any more than Structures itself does.
	LegacyStructures structures.ILegacyResolver
	Identifier       string
	FileID           string
	Warn             func(message string)
	// FormatVersion is the file's own declared `format_version`, parsed by the loader via
	// ParseFormatVersion (see formatversion.go). The zero value means the file declared none --
	// and an absent version is read as UNVERSIONED rather than as "older than everything", so a
	// builder comparing against a gate minimum via FormatVersion.AtLeastOrUnversioned (the
	// predicate every gate here should use, and where that choice is argued in full) gets the
	// modern branch for files that don't say. FormatVersion.AtLeast is the strict form, kept for
	// the rare site that genuinely wants absence to satisfy nothing. First consumer:
	// snap_to_surface's vertical_search_range -> search_range rename, gated at 1.26.50.
	FormatVersion FormatVersion
}

// Builder builds one minecraft:*_feature JSON body into an IFeature.
type Builder func(body map[string]any, ctx *BuildContext) (wgen.IFeature, error)

var builders = map[string]Builder{}

// RegisterType registers the builder for one minecraft:*_feature JSON type.
// Panics if typeID is already registered: a duplicate registration is a
// programming error, not a pack error, and must not be silently resolved.
func RegisterType(typeID string, b Builder) {
	if _, ok := builders[typeID]; ok {
		panic(fmt.Sprintf("feature type %q is already registered", typeID))
	}
	builders[typeID] = b
}

// RegisteredTypes returns every registered typeId, sorted.
func RegisteredTypes() []string {
	out := make([]string, 0, len(builders))
	for k := range builders {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Diagnostic is one build-time message about a pack.
type Diagnostic struct {
	Level   string // "error" | "warning"
	FileID  string
	Message string
}

// Entry is one built (or failed-to-build) feature —
// FeatureEntry. Feature is nil when the type has no builder yet, or the
// JSON failed to build.
//
// Feature is tagged json:"-": it is a wgen.IFeature interface over one of this package's
// concrete *XxxFeature types, every one of which holds only unexported fields (by design --
// see each type's own definition), so marshaling it would always produce an uninformative `{}`
// regardless of what the feature actually does. Rather than let that opaque placeholder look
// like real data, it is left off the wire entirely; a consumer that needs to know what a
// feature does should read TypeID plus the pack's own features/*.json file.
type Entry struct {
	FileID     string        `json:"fileId"`
	Identifier string        `json:"identifier"`
	TypeID     string        `json:"typeId"`
	Feature    wgen.IFeature `json:"-"`
}

// Library is a resolvable set of built features —
// FeatureLibrary.
type Library struct {
	Entries     []Entry
	Diagnostics []Diagnostic
	// byIdentifier is keyed by the LOWER-CASED identifier -- see Resolve, and featureKey for why.
	byIdentifier map[string]wgen.IFeature
}

// featureKey folds a feature identifier the way the game's own feature registry does. The game
// lower-cases the name both when a feature is registered and when it is looked up, so
// `wiki:Rock` and `wiki:rock` are the SAME feature there -- a reference that differs from its
// target only in case resolves in game. This port compared exactly until now, which meant a pack
// that works in the game could show "places_feature could not be resolved" here, and (worse) a
// pack that quietly relies on the folding could be "fixed" against a bench that was wrong.
//
// The fold is ASCII-only on purpose: identifiers are namespace:name pairs over [a-z0-9_.-] in
// every pack anyone writes, and strings.ToLower's Unicode folding would introduce cases the
// game does not have.
func featureKey(identifier string) string {
	out := []byte(identifier)
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + ('a' - 'A')
		}
	}
	return string(out)
}

// Resolve implements wgen.IFeatureResolver.
func (l *Library) Resolve(identifier string) wgen.IFeature {
	return l.byIdentifier[featureKey(identifier)]
}

var _ wgen.IFeatureResolver = (*Library)(nil)

type parsedFile struct {
	fileID     string
	typeID     string
	identifier string
	body       map[string]any
	// formatVersion is the file's own declared `format_version`. It used to be read only to
	// be skipped over while looking for the type key beside it; as of the 1.26.50.24 retarget
	// it decides which JSON keys exist at all for this file -- see BuildContext.FormatVersion.
	formatVersion FormatVersion
}

func parseFile(f SourceFile, diags *[]Diagnostic) *parsedFile {
	var root map[string]any
	if err := json.Unmarshal(jsonc.StripComments([]byte(f.Text)), &root); err != nil {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: "invalid JSON: " + err.Error()})
		return nil
	}
	var typeID string
	for k := range root {
		if k != "format_version" {
			typeID = k
			break
		}
	}
	if typeID == "" {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: "no feature type key alongside format_version"})
		return nil
	}
	body, ok := root[typeID].(map[string]any)
	if !ok {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: fmt.Sprintf("%q must be an object", typeID)})
		return nil
	}
	identifier := ""
	if desc, ok := body["description"].(map[string]any); ok {
		if id, ok := desc["identifier"].(string); ok {
			identifier = id
		}
	}
	if identifier == "" {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: "description.identifier is missing"})
		return nil
	}

	// `format_version` is no longer just the key to skip past while hunting for the type key
	// beside it. As of 1.26.50.24 the game gates individual JSON keys on the file's declared
	// version, so this value decides which keys
	// the file is even allowed to use -- notably snap_to_surface_feature's
	// vertical_search_range/search_range pair, where the two names are the same key on either
	// side of 1.26.50 and neither is accepted on the wrong side.
	//
	// A malformed version is an error: the file cannot be interpreted at all without knowing
	// which schema applies to it, so guessing would be worse than refusing. A MISSING version
	// is reported as a warning rather than an error, which is a deliberate, disclosed
	// divergence: the engine makes format_version a required child of the schema root and
	// would reject the file outright, but downgrading it here means one omitted key does not
	// silently remove a feature from a bench run and leave the author hunting for why nothing
	// placed. The warning says what the game would do; see FormatVersion.AtLeastOrUnversioned
	// for how builders then treat an absent version (as UNVERSIONED -- every key is judged on
	// its own terms, so the omission is reported once here and never punished a second time by
	// quietly closing gates the author never opted out of).
	formatVersion, err := ParseFormatVersion(root["format_version"])
	if err != nil {
		*diags = append(*diags, Diagnostic{Level: "error", FileID: f.ID, Message: err.Error()})
		return nil
	}
	if !formatVersion.Present {
		*diags = append(*diags, Diagnostic{Level: "warning", FileID: f.ID, Message: "format_version is missing — the game requires it and would refuse to load this file; " +
			"this tool treats the file as unversioned and judges every key on its own terms, so keys from later format versions still work here"})
	}

	return &parsedFile{fileID: f.ID, typeID: typeID, identifier: identifier, body: body, formatVersion: formatVersion}
}

// BuildLibrary builds every feature in files as one library, so features
// can reference each other by identifier the way a behaviour pack does —
// structureLib resolves
// structure_name for minecraft:structure_template_feature; pass nil to
// build a library with no structures loaded (
// NO_STRUCTURES default), which is fine for callers that never exercise
// that feature type.
func BuildLibrary(files []SourceFile, palette *block.Palette, structureLib structures.IResolver) *Library {
	if structureLib == nil {
		structureLib = structures.NoStructures
	}
	// See BuildContext.LegacyStructures' own doc comment for why this is a type assertion, not a
	// second parameter on this already-widely-called function.
	legacyStructureLib := structures.NoLegacyStructures
	if lr, ok := structureLib.(structures.ILegacyResolver); ok {
		legacyStructureLib = lr
	}
	var diags []Diagnostic
	parsed := make([]*parsedFile, 0, len(files))
	for _, f := range files {
		if p := parseFile(f, &diags); p != nil {
			parsed = append(parsed, p)
		}
	}

	lib := &Library{byIdentifier: make(map[string]wgen.IFeature)}

	entries := make([]Entry, 0, len(parsed))
	for _, p := range parsed {
		// Two gates before the builder ever runs, both about the file's declared
		// format_version deciding what SCHEMA exists rather than what a key means. See
		// typeavailability.go for the details.
		//
		// (1) A version below the oldest schema band matches no band at all, so the engine
		// has nothing to validate the file against and refuses it outright. That is a whole-
		// file failure, not a per-key one, and it is reported as an error for the same reason
		// invalid JSON is.
		if p.formatVersion.Present && p.formatVersion.Compare(FeatureSchemaFloor) < 0 {
			diags = append(diags, Diagnostic{Level: "error", FileID: p.fileID, Message: fmt.Sprintf(
				"format_version %s is below %s, the oldest version any feature schema covers — "+
					"the game matches this file to no schema at all and refuses to load it",
				p.formatVersion, FeatureSchemaFloor)})
			entries = append(entries, Entry{FileID: p.fileID, Identifier: p.identifier, TypeID: p.typeID})
			continue
		}
		// (2) A type is only a child of the schemas for its own band and later ones. Naming a
		// newer type from an older file is therefore not "a key with a newer meaning" — the
		// type id is not in that schema, so the file does not load.
		if !TypeAvailableAt(p.typeID, p.formatVersion) {
			diags = append(diags, Diagnostic{Level: "error", FileID: p.fileID, Message: fmt.Sprintf(
				"%q was introduced at format_version %s, but this file declares %s — the game's "+
					"schema for that version does not have this type, so the file does not load; "+
					"raise format_version to use it",
				p.typeID, MinFormatVersionForType(p.typeID), p.formatVersion)})
			entries = append(entries, Entry{FileID: p.fileID, Identifier: p.identifier, TypeID: p.typeID})
			continue
		}

		// A sweep for block names that do not exist on this engine, before the builder runs.
		// It is here rather than inside each parser because a block name can appear in a dozen
		// differently-shaped fields -- see blocknames.go.
		checkBlockNames(p.fileID, p.identifier, p.body, &diags)

		builder, ok := builders[p.typeID]
		if !ok {
			// Two very different failures wear the same shape here, and conflating them
			// sends you looking in the wrong place: a type the engine really has and we
			// have not ported, versus an id the engine would reject too. Say which.
			var message string
			if known, ok := CoverageFor(p.typeID); ok {
				message = fmt.Sprintf("%q is a real feature type but is not implemented in this tool yet", p.typeID)
				if known.Note != "" {
					message += " — " + known.Note
				}
			} else {
				message = fmt.Sprintf("%q is not a feature type this engine build registers — check the spelling", p.typeID)
			}
			diags = append(diags, Diagnostic{Level: "error", FileID: p.fileID, Message: message})
			entries = append(entries, Entry{FileID: p.fileID, Identifier: p.identifier, TypeID: p.typeID})
			continue
		}
		ctx := &BuildContext{
			Palette:          palette,
			Resolver:         lib,
			Structures:       structureLib,
			LegacyStructures: legacyStructureLib,
			Identifier:       p.identifier,
			FileID:           p.fileID,
			FormatVersion:    p.formatVersion,
			Warn: func(message string) {
				diags = append(diags, Diagnostic{Level: "warning", FileID: p.fileID, Message: message})
			},
		}
		feature, err := builder(p.body, ctx)
		if err != nil {
			diags = append(diags, Diagnostic{Level: "error", FileID: p.fileID, Message: err.Error()})
			entries = append(entries, Entry{FileID: p.fileID, Identifier: p.identifier, TypeID: p.typeID})
			continue
		}
		// Case-folded key, matching the engine (see featureKey). Two files whose identifiers
		// differ only in case therefore collide here exactly as they do there -- and since the
		// engine's registry keeps what it already has, the FIRST one wins rather than the last.
		key := featureKey(p.identifier)
		if existing, taken := lib.byIdentifier[key]; taken {
			diags = append(diags, Diagnostic{Level: "warning", FileID: p.fileID, Message: fmt.Sprintf(
				"%q collides with the already-loaded %q -- feature identifiers are matched without "+
					"regard to case, so these two are the same name as far as the game is concerned. "+
					"The first one loaded keeps the name and this one is unreachable: nothing can "+
					"place it, however correct the file is. Rename one of them.",
				p.identifier, existing.Identifier())})
		} else {
			lib.byIdentifier[key] = feature
		}
		entries = append(entries, Entry{FileID: p.fileID, Identifier: p.identifier, TypeID: p.typeID, Feature: feature})
	}

	lib.Entries = entries
	lib.Diagnostics = diags
	return lib
}
