package rules

// schema.go is the loader-side contract of `minecraft:feature_rules`: the key
// set the engine's one rule schema accepts, the placement passes it knows, and
// the identifier checks it runs on every file. rules.go's parser drives all of
// it; nothing here touches placement.
//
// The whole file is written against ONE schema, defined once at the earliest
// schema version (1.12.0). There are no version bands,
// no per-key format_version gates and no legacy flat spellings here, which is
// why this file has none of the machinery features/ needs (see this package's
// header).

import (
	"fmt"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// Placement passes
// ---------------------------------------------------------------------------

// placementPasses is the engine's registered decoration-pass list, in
// the engine's own order. Chunk decoration walks exactly
// these, in exactly this order, and only visits a rule whose pass string is one
// of them -- a rule carrying anything else is attached to the biome and then
// never reached.
var placementPasses = []string{
	"first_pass",
	"before_underground_pass",
	"underground_pass",
	"after_underground_pass",
	"before_surface_pass",
	"surface_pass",
	"after_surface_pass",
	"before_sky_pass",
	"sky_pass",
	"after_sky_pass",
	"final_pass",
}

// PregenerationPass is the twelfth pass the engine accepts. It is kept in its
// own list, separate from the decoration passes, and only ONE feature type may
// run in it -- see PregenerationPassAllows.
const PregenerationPass = "pregeneration_pass"

// caveCarverTypeID is the only feature type a feature's placement-legality test
// lets through in pregeneration_pass; every other type is refused there, with a log
// line and no placement.
const caveCarverTypeID = "minecraft:cave_carver_feature"

// IsFeaturePassDefined mirrors the engine's feature-pass definition test: true for
// the eleven decoration passes plus pregeneration_pass. Anything else makes the
// engine log an "unknown pass" line -- and then keep the value as written.
func IsFeaturePassDefined(pass string) bool {
	if pass == PregenerationPass {
		return true
	}
	for _, p := range placementPasses {
		if p == pass {
			return true
		}
	}
	return false
}

// PregenerationPassAllows reports whether a feature of typeID may run in
// pregeneration_pass. Only the cave carver may.
func PregenerationPassAllows(typeID string) bool { return typeID == caveCarverTypeID }

// knownPassList renders the accepted passes for a diagnostic's "use one of"
// tail, in the engine's own registration order.
func knownPassList() string {
	return strings.Join(placementPasses, ", ") + ", " + PregenerationPass + " (cave carvers only)"
}

// ---------------------------------------------------------------------------
// The accepted key set
// ---------------------------------------------------------------------------
//
// One schema, four levels, and that is the whole of it. A key outside these
// sets is reported by name and dropped by the engine ("this member was found in
// the input, but is not present in the Schema"), so it is reported by name and
// dropped here too. Required-ness is tracked separately, at the point each key
// is read, because a missing required key does not just drop a value -- it
// fails the entire file.

var (
	// bodyKeys is `minecraft:feature_rules` itself: description and conditions
	// are required, distribution is NOT (see buildRule).
	bodyKeys = []string{"description", "conditions", "distribution"}
	// descriptionKeys: both required, and there is nothing else.
	descriptionKeys = []string{"identifier", "places_feature"}
	// conditionsKeys: placement_pass required, minecraft:biome_filter optional,
	// and there is nothing else.
	conditionsKeys = []string{"placement_pass", "minecraft:biome_filter"}
	// distributionKeys is the nested scatter-parameters object shared with
	// scatter_feature's own `distribution` object.
	distributionKeys = []string{"iterations", "x", "y", "z", "scatter_chance", "coordinate_eval_order"}
)

// reportUnknownKeys names every key of obj that the schema does not accept, at
// the level it appeared. jsonPath is the level's own path ("" for the rule
// body, whose keys read better unprefixed).
//
// Deliberately NOT applied to the FILE root: `format_version` lives there and
// is read by the loader itself, not by this schema, so scanning that level
// would report the one key every real file is required to write.
func reportUnknownKeys(obj map[string]any, accepted []string, jsonPath string, warn func(string)) {
	var unknown []string
	for k := range obj {
		known := false
		for _, a := range accepted {
			if a == k {
				known = true
				break
			}
		}
		if !known {
			unknown = append(unknown, k)
		}
	}
	// Map iteration order is random; a diagnostic list that reorders itself
	// between runs is neither comparable nor testable.
	sort.Strings(unknown)
	for _, k := range unknown {
		warn(fmt.Sprintf("%q was found in the input, but is not present in the Schema -- the engine "+
			"reports it by name and drops it unread, and so does this tool, so nothing written under it "+
			"has any effect. %s accepts only: %s.",
			qualify(jsonPath, k), levelName(jsonPath), strings.Join(accepted, ", ")))
	}
}

func qualify(jsonPath, key string) string {
	if jsonPath == "" {
		return key
	}
	return jsonPath + "." + key
}

func levelName(jsonPath string) string {
	if jsonPath == "" {
		return `"minecraft:feature_rules"`
	}
	return `"` + jsonPath + `"`
}

// ---------------------------------------------------------------------------
// description.identifier
// ---------------------------------------------------------------------------

// ruleFileName is the file's own name as the engine compares it: the last path
// segment with its extension removed. A pack's volcano_terraform.fr.json
// therefore has the name volcano_terraform.fr, which is exactly what its
// wiki:canyon_terraform.fr identifier is checked against.
func ruleFileName(fileID string) string {
	name := fileID
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	if i := strings.LastIndex(name, "."); i > 0 {
		name = name[:i]
	}
	return name
}

// checkIdentifier runs the engine's two identifier validations. BOTH are
// warnings there -- the rule is still inserted and still runs -- so both are
// warnings here too.
func checkIdentifier(identifier, fileID string, warn func(string)) {
	// The engine looks for a ':' at index >= 2: a bare name, a leading ':' and
	// a one-character namespace all fail it.
	if i := strings.Index(identifier, ":"); i < 2 {
		warn(fmt.Sprintf("Feature rule identifier '%s' does not use the appropriate namespace syntax -- "+
			"the engine logs exactly that and still loads the rule, so this is cosmetic in game; write it "+
			"as \"namespace:name\", with a namespace of at least two characters, to silence it.", identifier))
	}
	// The name half (everything after the LAST ':') is compared against the
	// file's own name. Also a warning: the rule loads either way.
	name := identifier
	if i := strings.LastIndex(identifier, ":"); i >= 0 {
		name = identifier[i+1:]
	}
	if fileName := ruleFileName(fileID); name != fileName {
		warn(fmt.Sprintf("Feature rule identifier '%s' does not match filename '%s' -- the engine logs "+
			"exactly that and still loads the rule, so nothing breaks in game; it is the usual sign that a "+
			"file was renamed and its identifier was not (or the other way round). Every other pack file "+
			"references the identifier, not the filename, so rename with that in mind.", identifier, fileName))
	}
}
