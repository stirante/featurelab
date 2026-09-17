// Package rules implements `minecraft:feature_rules`: it loads
// `feature_rules/*.json` (mirroring featurelab-go/features's SourceFile/
// BuildLibrary shape and diagnostics convention), and runs one rule's
// placement.
//
// # Feature rules do NOT load like features do
//
// Read this before extending anything here by analogy with features/. A feature
// rule never goes near the feature schema machinery: there is no
// feature-type factory, no per-type registration, no version bands, no per-key
// format_version gate, and no legacy flat `distribution` spelling. The engine
// uses ONE schema for the whole document, defined once at the earliest
// schema version (1.12.0). Every rule file, whatever
// format_version it declares, is read by that one schema with that one key set,
// so `format_version` here selects nothing: it is read by the loader and then
// has no effect on which keys are accepted. The format-version gating
// established elsewhere applies to the FEATURE loader, not to this package.
//
// The accepted keys, and which of them are required, live in schema.go, which
// is the only place this contract is written down. Two consequences a pack
// author feels directly: a missing REQUIRED key fails the WHOLE file ("missing
// required field") and the rule is never inserted, so this package reports it
// as an error and builds no rule; an unknown key is reported by name and
// dropped ("this member was found in the input, but is not present in the
// Schema"), so this package reports it by name too and carries on. `conditions`
// and `conditions.placement_pass` are both required; `distribution` is NOT (see
// buildRule for what a rule without one actually does).
//
// # What a feature rule IS, mechanically
//
// The engine's feature-rule placement step copies the rule's own data into a
// fresh set of scatter parameters, wraps that (distribution,
// feature-name-hash, places_feature) triple into a synthetic single-entry
// biome-decoration list, resolves the chunk containing the supplied
// origin, and hands everything to the per-biome decoration pass —
// the exact same per-chunk decoration driver a biome's own static features
// list goes through. A feature rule is not a different runtime concept from
// scatter; it is a `{distribution, places_feature}` pair placed through the
// identical scatter machinery, just rooted at a chunk corner instead of an
// arbitrary placement origin. This is why distribution/coordinate sampling
// is shared verbatim with featurelab-go/features's distribution.go/scatter.go
// — reusing it here isn't a convenience, it's what the game actually does.
//
// # Origin / Y computation
//
// Every BiomeDecorationFeature entry in a chunk — including a rule's
// synthetic one — is scattered from the SAME base origin: the chunk's
// minimum corner, computed once per chunk. X/Z are chunk-relative; Y is
// conventionally 0 (the same chunk-relative position with y=0 convention a
// sibling type uses, and consistent with how packs author their rules).
// Computing that origin from a session's chunk/
// volume state is a session-level concern and deliberately NOT done in this
// package: PlaceFeatureRule takes origin as a plain wgen.BlockPos supplied
// by the caller.
//
// # Per-chunk / per-rule RNG seeding
//
// The engine gives each chunk a decoration seed derived from the world seed and the chunk
// coordinates, then gives each decoration entry in that chunk its own seed by combining the
// chunk seed with the entry's name hash — and then builds TWO independent generators from that
// entry seed: one the distribution draws positions with, one every delegated feature draws
// from. All three steps are spelled out in random/decorationseed.go, which is also where the
// "which name is hashed" rule lives.
//
// This package does not derive any of that itself: it takes the generators it is given
// (PlaceContext.Random for the distribution, PlaceContext.PlaceRandom for the delegates) and
// leaves the seeding to the caller, the same way every feature type here takes a random.IRandom
// rather than making one. session.go is the caller that applies the real derivation.
//
// # placement_pass / minecraft:biome_filter
//
// `placement_pass` selects which of several passes over a chunk a rule's
// entry gets attached to for REAL world generation ordering. This package
// has no multi-pass pipeline, so it is parsed and exposed (FeatureRule.
// PlacementPass) but never used to gate placement. It IS required and IS
// validated at load time, though: the engine refuses a file that omits it, and
// keeps — without substituting anything — a value that names no registered
// pass, which leaves the rule attached to a pass chunk decoration never visits.
// Both of those are diagnosed here; see schema.go's placementPasses and
// buildRule.
//
// `minecraft:biome_filter` (shapes seen in practice: `{}` = always matches,
// `{"test": "has_biome_tag", "value": "..."}`, and nested `{"any_of": [...]}`
// / `all_of`/`none_of`) IS enforced: it is evaluated against the caller's
// active biome, and a rejection is reported via the caller's LogFailure
// callback (never silent) — see EvaluateBiomeFilter/DescribeBiomeFilter and
// PlaceFeatureRule's use of them. A rule that would not apply must say so
// explicitly; an unfiltered "nothing happened" is indistinguishable from a
// bug.
package rules

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/jsonc"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/wgen"

	molang "github.com/stirante/molang-go"
)

// ---------------------------------------------------------------------------
// minecraft:biome_filter — a small filter tree. Shapes seen in practice: `{}`
// (always matches), `{"test": "has_biome_tag",
// "value": "..."}` (the common case), and `{"any_of": [{"test":
// "has_biome_tag", ...}, ...]}` (two has_biome_tag
// tests OR'd together). all_of/none_of are less common but are the
// same generic Bedrock filter-tree shape, so parsed identically for
// forward-compatibility rather than restricted to what happens to appear in
// one pack.
// ---------------------------------------------------------------------------

// FilterKind is a parsed biome-filter node's discriminant.
type FilterKind int

const (
	FilterEmpty FilterKind = iota
	FilterTest
	FilterAllOf
	FilterAnyOf
	FilterNoneOf
)

// BiomeFilterNode is one node of a parsed biome filter tree. Tagged lowerCamelCase --
// reachable from the wire via FeatureRule.BiomeFilter.
type BiomeFilterNode struct {
	Kind     FilterKind        `json:"kind"`
	Test     string            `json:"test"`
	Value    string            `json:"value"`
	Children []BiomeFilterNode `json:"children"`
}

var combinatorKinds = map[string]FilterKind{
	"all_of":  FilterAllOf,
	"any_of":  FilterAnyOf,
	"none_of": FilterNoneOf,
}

// combinatorOrder is the order in which a multi-keyed filter object is
// checked for a combinator key: the first one present wins.
var combinatorOrder = []string{"all_of", "any_of", "none_of"}

// parseBiomeFilter parses a minecraft:biome_filter value. raw == nil covers
// both "key absent" (the common case) and a JSON explicit `null` value --
// telling those two apart isn't representable via a plain Go `any` without
// inspecting the parent map's key presence separately, and no pack seen in practice
// (nor this package's test suite) ever sets minecraft:biome_filter to a
// literal JSON null, so both fold into the "empty -> always matches" case
// rather than adding an unused error path.
func parseBiomeFilter(raw any, jsonPath string) (BiomeFilterNode, error) {
	if raw == nil {
		return BiomeFilterNode{Kind: FilterEmpty}, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return BiomeFilterNode{}, fmt.Errorf("%s must be an object", jsonPath)
	}
	if len(obj) == 0 {
		return BiomeFilterNode{Kind: FilterEmpty}, nil
	}
	for _, combinator := range combinatorOrder {
		v, present := obj[combinator]
		if !present {
			continue
		}
		arr, ok := v.([]any)
		if !ok {
			return BiomeFilterNode{}, fmt.Errorf("%s.%s must be an array", jsonPath, combinator)
		}
		children := make([]BiomeFilterNode, len(arr))
		for i, c := range arr {
			child, err := parseBiomeFilter(c, fmt.Sprintf("%s.%s[%d]", jsonPath, combinator, i))
			if err != nil {
				return BiomeFilterNode{}, err
			}
			children[i] = child
		}
		return BiomeFilterNode{Kind: combinatorKinds[combinator], Children: children}, nil
	}
	if test, ok := obj["test"].(string); ok {
		value, ok := obj["value"].(string)
		if !ok {
			return BiomeFilterNode{}, fmt.Errorf("%s.value must be a string", jsonPath)
		}
		return BiomeFilterNode{Kind: FilterTest, Test: test, Value: value}, nil
	}
	return BiomeFilterNode{}, fmt.Errorf("%s must be {}, {test, value}, or {all_of|any_of|none_of: [...]}", jsonPath)
}

// EvaluateBiomeFilter evaluates a parsed filter tree against the caller's
// active biome. Only test: "has_biome_tag" is supported;
// any other test name evaluates to non-matching (false)
// rather than erroring, keeping this package's general "unrecognised ->
// report, don't crash" posture. biome == nil (no active biome) is
// non-matching too.
func EvaluateBiomeFilter(node BiomeFilterNode, biome *wgen.MolangBiome) bool {
	switch node.Kind {
	case FilterEmpty:
		return true
	case FilterTest:
		if node.Test != "has_biome_tag" {
			return false
		}
		if biome == nil {
			return false
		}
		_, ok := biome.Tags[node.Value]
		return ok
	case FilterAllOf:
		for _, c := range node.Children {
			if !EvaluateBiomeFilter(c, biome) {
				return false
			}
		}
		return true
	case FilterAnyOf:
		for _, c := range node.Children {
			if EvaluateBiomeFilter(c, biome) {
				return true
			}
		}
		return false
	case FilterNoneOf:
		for _, c := range node.Children {
			if EvaluateBiomeFilter(c, biome) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// DescribeBiomeFilter renders a human-readable form for diagnostics.
func DescribeBiomeFilter(node BiomeFilterNode) string {
	switch node.Kind {
	case FilterEmpty:
		return "(none — always matches)"
	case FilterTest:
		return fmt.Sprintf("%s('%s')", node.Test, node.Value)
	case FilterAllOf:
		return combinatorString("all_of", node.Children)
	case FilterAnyOf:
		return combinatorString("any_of", node.Children)
	case FilterNoneOf:
		return combinatorString("none_of", node.Children)
	default:
		return ""
	}
}

func combinatorString(name string, children []BiomeFilterNode) string {
	parts := make([]string, len(children))
	for i, c := range children {
		parts[i] = DescribeBiomeFilter(c)
	}
	return name + "(" + strings.Join(parts, ", ") + ")"
}

// ---------------------------------------------------------------------------
// Rule parsing — mirrors featurelab-go/features's parseFile/BuildLibrary
// shape, and reuses that package's Diagnostic type rather than declaring
// one of its own (unlike featurelab-go/biomes, which does declare its own
// -- see biomes.go's Diagnostic doc comment for that contrast).
// ---------------------------------------------------------------------------

// SourceFile is a feature_rules/*.json file as delivered by the pack loader.
type SourceFile struct {
	ID      string
	AbsPath string
	Text    string
}

// FeatureRule is one parsed feature rule. Tagged lowerCamelCase for the wire
// contract this type crosses as session.Result.ActiveRule/RuleEntries[].Rule -- see
// featurelab-go/wire's package doc comment ("Opaque Molang values") for what Distribution
// actually serializes as.
type FeatureRule struct {
	Identifier    string                       `json:"identifier"`
	PlacesFeature string                       `json:"placesFeature"`
	PlacementPass *string                      `json:"placementPass"`
	BiomeFilter   BiomeFilterNode              `json:"biomeFilter"`
	Distribution  features.ScatterDistribution `json:"distribution"`
}

// FeatureRuleEntry is one parsed (or failed-to-parse) rule file. Rule is
// nil when the file failed to parse/build.
type FeatureRuleEntry struct {
	FileID     string       `json:"fileId"`
	Identifier string       `json:"identifier"`
	Rule       *FeatureRule `json:"rule"`
}

// FeatureRuleLibrary is a resolvable set of parsed rules.
type FeatureRuleLibrary struct {
	Entries      []FeatureRuleEntry
	Diagnostics  []features.Diagnostic
	byIdentifier map[string]*FeatureRule
}

// Resolve returns the rule declared under identifier, or nil.
func (l *FeatureRuleLibrary) Resolve(identifier string) *FeatureRule {
	if l == nil {
		return nil
	}
	return l.byIdentifier[identifier]
}

// Note: FeatureRuleLibrary deliberately does NOT implement
// wgen.IFeatureResolver (unlike features.Library) -- it resolves rule
// IDENTIFIERS to FeatureRule values, not "namespace:id" references to
// placeable wgen.IFeature instances. A rule's own places_feature reference
// is resolved through a separate wgen.IFeatureResolver (typically a
// features.Library) supplied by the caller via RulePlacementOptions.Resolver.

// buildRule reads one `minecraft:feature_rules` body against the single schema
// described in this package's header. identifier is already validated by the
// caller and is used only to quote the engine's own log wording; warn raises a
// non-fatal diagnostic (the engine logged and carried on), while an error means
// the engine would refuse the whole file.
func buildRule(body map[string]any, description map[string]any, identifier string, warn func(string)) (*FeatureRule, error) {
	placesFeature, ok := description["places_feature"].(string)
	if !ok || placesFeature == "" {
		return nil, fmt.Errorf("description.places_feature is required by the engine's schema and must be a " +
			"non-empty feature reference string -- without it the game reports a missing required field and " +
			"refuses the whole file, so this rule is never inserted and places nothing")
	}

	// `conditions` is REQUIRED at the rule body, and `placement_pass` is
	// REQUIRED inside it. Both are hard failures in the engine (the file does
	// not load at all), so both are errors here rather than defaults.
	conditionsRaw, hasConditions := body["conditions"]
	if !hasConditions || conditionsRaw == nil {
		return nil, fmt.Errorf(`"conditions" is required by the engine's schema but is missing -- the game ` +
			`reports a missing required field and refuses the whole file, so this rule is never inserted and ` +
			`nothing it would place appears in game. It needs at least {"placement_pass": "..."}`)
	}
	conditions, ok := conditionsRaw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("conditions must be an object")
	}
	reportUnknownKeys(conditions, conditionsKeys, "conditions", warn)

	passRaw, hasPass := conditions["placement_pass"]
	if !hasPass || passRaw == nil {
		return nil, fmt.Errorf("conditions.placement_pass is required by the engine's schema but is missing "+
			"-- the game reports a missing required field and refuses the whole file, so this rule is never "+
			"inserted, never attached to a biome, and places nothing. Give it one of: %s", knownPassList())
	}
	pass, ok := passRaw.(string)
	if !ok {
		return nil, fmt.Errorf("conditions.placement_pass must be a string -- the schema reads it as one, "+
			"so a value of any other type fails the field and the game refuses the whole file, inserting no "+
			"rule at all. Name one of: %s", knownPassList())
	}
	if !IsFeaturePassDefined(pass) {
		// The engine's own wording, then the half it does not say. It keeps
		// the unknown string verbatim -- no substitution, no fallback to a
		// default pass -- and chunk decoration only ever visits entries whose
		// pass is one of the registered ones, so the rule is attached to the
		// biome and then never reached.
		warn(fmt.Sprintf("Feature rule identifier '%s' specifies unknown pass '%s'. -- the engine logs "+
			"exactly that and then KEEPS the value: it does not substitute a default. Chunk decoration only "+
			"visits the passes it knows, so this rule loads, attaches to every biome it matches, and then "+
			"never runs -- it places nothing, in every chunk, forever. Use one of: %s.",
			identifier, pass, knownPassList()))
	}
	placementPass := &pass

	biomeFilter, err := parseBiomeFilter(conditions["minecraft:biome_filter"], "conditions.minecraft:biome_filter")
	if err != nil {
		return nil, err
	}

	// `distribution` is OPTIONAL in the engine's schema. A file
	// without one LOADS: the scatter parameters stay default-constructed, which means
	// iterations = 0 and scatter_chance = 100. Refusing the file here -- which
	// this package used to do -- reported a parse error for something the game
	// accepts, and hid the far more useful fact that the rule is live and inert.
	distRaw, hasDist := body["distribution"]
	var distribution features.ScatterDistribution
	if !hasDist || distRaw == nil {
		warn(`no "distribution" object -- the engine's schema marks it optional, so the game LOADS this ` +
			`rule with default-constructed scatter parameters: iterations is 0 and scatter_chance is 100. The ` +
			`rule is inserted, attached to its pass and its biomes, and then places nothing every single ` +
			`chunk. Add a "distribution" with iterations/x/y/z for it to place anything.`)
		// Exactly the default-constructed scatter parameters: iterations 0, no axis
		// offsets, scatter_chance 100 (the two absent keys default to that in
		// features's own parser, so the defaults live in ONE place).
		distribution, err = features.ParseScatterDistribution(map[string]any{"iterations": 0.0}, "distribution", warn)
		if err != nil {
			return nil, err
		}
	} else {
		distObj, ok := distRaw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("distribution must be an object")
		}
		reportUnknownKeys(distObj, distributionKeys, "distribution", warn)
		distribution, err = features.ParseScatterDistribution(distObj, "distribution", warn)
		if err != nil {
			return nil, err
		}
	}

	return &FeatureRule{
		PlacesFeature: placesFeature,
		PlacementPass: placementPass,
		BiomeFilter:   biomeFilter,
		Distribution:  distribution,
	}, nil
}

func parseRuleFile(f SourceFile, diags *[]features.Diagnostic) *FeatureRuleEntry {
	var raw any
	if err := json.Unmarshal(jsonc.StripComments([]byte(f.Text)), &raw); err != nil {
		*diags = append(*diags, features.Diagnostic{Level: "error", FileID: f.ID, Message: "invalid JSON: " + err.Error()})
		return nil
	}
	root, ok := raw.(map[string]any)
	if !ok {
		*diags = append(*diags, features.Diagnostic{Level: "error", FileID: f.ID, Message: "root must be an object"})
		return nil
	}
	body, ok := root["minecraft:feature_rules"].(map[string]any)
	if !ok {
		*diags = append(*diags, features.Diagnostic{Level: "error", FileID: f.ID, Message: `"minecraft:feature_rules" must be an object`})
		return nil
	}
	// Every non-fatal finding below goes through this: the engine logged it and
	// carried on, so the rule still builds and the author still gets told.
	warn := func(message string) {
		*diags = append(*diags, features.Diagnostic{Level: "warning", FileID: f.ID, Message: message})
	}
	reportUnknownKeys(body, bodyKeys, "", warn)

	description, ok := body["description"].(map[string]any)
	if !ok {
		*diags = append(*diags, features.Diagnostic{Level: "error", FileID: f.ID, Message: `"description" is required ` +
			`by the engine's schema and must be an object -- without it the game reports a missing required ` +
			`field and refuses the whole file, so no rule is inserted`})
		return nil
	}
	reportUnknownKeys(description, descriptionKeys, "description", warn)
	identifier, _ := description["identifier"].(string)
	if identifier == "" {
		*diags = append(*diags, features.Diagnostic{Level: "error", FileID: f.ID, Message: `description.identifier ` +
			`is required by the engine's schema but is missing -- the game reports a missing required field ` +
			`and refuses the whole file, so no rule is inserted`})
		return nil
	}
	// Both engine-side identifier checks are warnings THERE -- the rule is
	// inserted either way -- so they are warnings here, raised before the build
	// so they are reported even for a file that then fails to load.
	checkIdentifier(identifier, f.ID, warn)

	rule, err := buildRule(body, description, identifier, warn)
	if err != nil {
		*diags = append(*diags, features.Diagnostic{Level: "error", FileID: f.ID, Message: err.Error()})
		return &FeatureRuleEntry{FileID: f.ID, Identifier: identifier, Rule: nil}
	}
	rule.Identifier = identifier
	return &FeatureRuleEntry{FileID: f.ID, Identifier: identifier, Rule: rule}
}

// ruleSlot is one occupied cell of the engine's map[pass][identifier] rule
// store: the rule that won the cell, and the file it came from (which the
// dedup diagnostic names).
type ruleSlot struct {
	rule   *FeatureRule
	fileID string
}

// BuildFeatureRuleLibrary builds every rule in files as one library, under
// the same per-file failure-and-continue convention featurelab-go/features
// uses: one bad file never stops the rest from loading.
//
// Duplicate identifiers follow the engine's store, which is keyed
// map[placement_pass][identifier]: a second rule with the same identifier is
// dropped ONLY if it lands in the same pass, and the FIRST one wins. Two rules
// sharing an identifier across two different passes are both kept and both run,
// so this function must not (and no longer does) treat that as a collision.
// Both cases are silent in the engine; saying which of the two happened is
// exactly what this tool is for.
func BuildFeatureRuleLibrary(files []SourceFile) *FeatureRuleLibrary {
	var diagnostics []features.Diagnostic
	var entries []FeatureRuleEntry
	byIdentifier := make(map[string]*FeatureRule)
	// The engine's own two-level store, kept only to reproduce its dedup
	// decision; each slot remembers the file that claimed it so a diagnostic
	// can point at the rule that won. identifierFile/identifierPass do the same
	// for byIdentifier, which is flat and therefore first-wins across passes.
	byPass := make(map[string]map[string]ruleSlot)
	identifierFile := make(map[string]string)
	identifierPass := make(map[string]string)

	for _, f := range files {
		entry := parseRuleFile(f, &diagnostics)
		if entry == nil {
			continue
		}
		entries = append(entries, *entry)
		if entry.Rule == nil {
			continue
		}
		// placement_pass is required, so a built rule always has one; the
		// empty-string fallback only exists so this cannot panic if that ever
		// changes.
		pass := ""
		if entry.Rule.PlacementPass != nil {
			pass = *entry.Rule.PlacementPass
		}
		inPass := byPass[pass]
		if inPass == nil {
			inPass = make(map[string]ruleSlot)
			byPass[pass] = inPass
		}
		if won, exists := inPass[entry.Identifier]; exists {
			diagnostics = append(diagnostics, features.Diagnostic{
				Level:  "warning",
				FileID: entry.FileID,
				Message: fmt.Sprintf("identifier %q is already declared for placement pass %q, by %s -- the "+
					"engine keys its rule store by pass and then by identifier and keeps the FIRST insert, "+
					"silently, so this file's rule is dropped at load and never runs. Rename one of the two, "+
					"or move this one to a different pass (a pass of its own keeps both).",
					entry.Identifier, pass, won.fileID),
			})
			continue
		}
		inPass[entry.Identifier] = ruleSlot{rule: entry.Rule, fileID: entry.FileID}
		if _, exists := byIdentifier[entry.Identifier]; exists {
			diagnostics = append(diagnostics, features.Diagnostic{
				Level:  "warning",
				FileID: entry.FileID,
				Message: fmt.Sprintf("identifier %q is also declared by %s, in placement pass %q -- the engine "+
					"keys its rule store by pass first, so it keeps BOTH rules and runs BOTH, once per pass. "+
					"That is legal; it is flagged because this tool resolves a rule by identifier alone, so "+
					"selecting %q here previews the %q one and there is no way to ask for this file's rule in "+
					"pass %q. Rename one of the two if you need to preview both.",
					entry.Identifier, identifierFile[entry.Identifier], identifierPass[entry.Identifier],
					entry.Identifier, identifierPass[entry.Identifier], pass),
			})
			continue
		}
		byIdentifier[entry.Identifier] = entry.Rule
		identifierFile[entry.Identifier] = entry.FileID
		identifierPass[entry.Identifier] = pass
	}

	return &FeatureRuleLibrary{Entries: entries, Diagnostics: diagnostics, byIdentifier: byIdentifier}
}

// ---------------------------------------------------------------------------
// Running a rule
// ---------------------------------------------------------------------------

// PlaceContext is everything PlaceFeatureRule needs besides the rule/
// resolver/origin themselves: the caller supplies origin and this function
// owns constructing the MolangScope (see
// RulePlacementResult.Scope's doc comment for why).
type PlaceContext struct {
	API    wgen.BlockWorld
	Random random.IRandom
	// PlaceRandom is the generator every DELEGATED feature draws from, which the engine keeps
	// separate from the one the distribution draws positions with -- see this package's
	// "Per-chunk / per-rule RNG seeding" header section and random/decorationseed.go for the
	// derivation. Both start from the same per-entry seed and advance independently, so a
	// feature's own draws never shift the positions it is placed at.
	//
	// Optional: nil means "use Random for both", which is the single-stream behaviour every
	// caller had before the two-generator seeding was modelled, and is what a test that only cares about
	// distribution order should keep passing.
	PlaceRandom random.IRandom
	Biome       *wgen.MolangBiome
	// LogFailure mirrors wgen.PlacementContext.LogFailure's signature exactly -- the same closure
	// is handed to both (session.go builds one and assigns it to each), so the two must stay in
	// sync.
	LogFailure func(featureType, message string, pos wgen.BlockPos)
	// LogWarning mirrors wgen.PlacementContext.LogWarning's signature exactly -- same sync
	// contract as LogFailure above, so a rule-delegated feature (target.Place below) can raise a
	// non-refusing diagnostic exactly like a directly-placed one does.
	LogWarning func(featureType, message string, pos *wgen.BlockPos)
}

// RulePlacementOptions is one PlaceFeatureRule call's inputs.
type RulePlacementOptions struct {
	Rule     *FeatureRule
	Resolver wgen.IFeatureResolver
	// Origin is the chunk-corner analog this rule's distribution offsets
	// are added to — see this package's header for how a caller should
	// compute it ({x: chunkX*16, y: 0, z: chunkZ*16}, standing in for the
	// real engine's own level-chunk minimum corner).
	Origin wgen.BlockPos
	Ctx    PlaceContext
}

// Placement is one scatter iteration's outcome.
type Placement struct {
	Origin   wgen.BlockPos
	Returned *wgen.BlockPos
}

// RulePlacementResult is one PlaceFeatureRule call's outcome.
type RulePlacementResult struct {
	// BiomeMatched is false when the biome filter rejected the current
	// biome — nothing was placed and no RNG was drawn.
	BiomeMatched bool
	// Iterations is the number of scatter iterations actually run (0 if
	// the filter rejected, the RNG chance gate rejected the whole pass, or
	// places_feature didn't resolve).
	Iterations int
	Placements []Placement
	// Scope is the MolangScope this rule's placement chain ran with —
	// created up front (before either early-out) so every return path,
	// including a biome-filter rejection or an unresolved places_feature
	// (neither of which ever touch Molang), still hands the caller a real
	// (if empty) scope rather than requiring a nil-check. Exposed so a
	// caller can surface the final temp./variable. state for inspection —
	// see wgen/types.go's MolangScope doc comment for why this is the one
	// shared bag for the whole placement tree.
	Scope *molang.Scope
}

func logFailure(fn func(featureType, message string, pos wgen.BlockPos), featureType, message string, pos wgen.BlockPos) {
	if fn != nil {
		fn(featureType, message, pos)
	}
}

// logWarning is logFailure's non-refusing twin: the placement still happens,
// the caller still hears about it. Mirrors features.LogWarning's nil-check.
func logWarning(fn func(featureType, message string, pos *wgen.BlockPos), featureType, message string, pos *wgen.BlockPos) {
	if fn != nil {
		fn(featureType, message, pos)
	}
}

// PlaceFeatureRule runs one feature rule's full distribution against
// origin, exactly like ScatterFeature.Place runs a scatter_feature's
// distribution against its own origin — see this package's header for why
// that's not a coincidence. Biome-filter rejection is reported via
// ctx.LogFailure, never silent (a rule whose filter doesn't match the
// caller's biome must say so, not just produce a suspiciously-empty
// result).
func PlaceFeatureRule(opts RulePlacementOptions) RulePlacementResult {
	rule, resolver, origin, ctx := opts.Rule, opts.Resolver, opts.Origin, opts.Ctx
	var placements []Placement
	// Created up front -- see RulePlacementResult.Scope's doc comment.
	scope := wgen.NewScope()

	if !EvaluateBiomeFilter(rule.BiomeFilter, ctx.Biome) {
		biomeID := "(none)"
		if ctx.Biome != nil {
			biomeID = ctx.Biome.ID
		}
		logFailure(ctx.LogFailure, "minecraft:feature_rules",
			fmt.Sprintf("biome filter rejected biome %q — %s", biomeID, DescribeBiomeFilter(rule.BiomeFilter)), origin)
		if profiler.ProfilingActive && !profiler.StopCounted(profiler.StopBiomeFilterRejected, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopBiomeFilterRejected, fmt.Sprintf("biome %s rejected by filter", biomeID), profiler.NoOrdinal)
		}
		return RulePlacementResult{BiomeMatched: false, Iterations: 0, Placements: placements, Scope: scope}
	}

	// FEATURE REFERENCES ARE CASE-INSENSITIVE IN THE ENGINE.
	// Resolution is case-insensitive, because the engine's own feature registry lower-cases both
	// the key it stores and the key it looks up -- a reference that differs from its target only
	// in case resolves in game. That fold now lives where the library is BUILT
	// (features.BuildLibrary's own key, see featureKey there), which is the only place it can be
	// consistent: doing it here would have fixed a mixed-case reference to a lower-case feature
	// and still missed a reference to a feature whose own identifier carries capitals.
	target := resolver.Resolve(rule.PlacesFeature)
	if target == nil {
		logFailure(ctx.LogFailure, "minecraft:feature_rules",
			fmt.Sprintf("places_feature %q could not be resolved -- check the spelling. Case is not the "+
				"problem: identifiers are matched without regard to it here, exactly as the game matches "+
				"them, so a reference that differs only in case does resolve.", rule.PlacesFeature), origin)
		if profiler.ProfilingActive && !profiler.StopCounted(profiler.StopUnresolvedReference, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopUnresolvedReference, rule.PlacesFeature+" not found", profiler.NoOrdinal)
		}
		return RulePlacementResult{BiomeMatched: true, Iterations: 0, Placements: placements, Scope: scope}
	}

	// pregeneration_pass admits ONE feature type. A feature's placement-legality
	// test refuses everything else in that pass, logging as it goes, so a rule
	// pairing it with anything but a cave carver is a guaranteed no-op in game
	// -- and silently so, because the rule itself loads fine. Diagnosed, not
	// enforced: this is a loading/diagnostics change, and refusing to run the
	// rule here would take away the one view the author has of what it would
	// have placed.
	if rule.PlacementPass != nil && *rule.PlacementPass == PregenerationPass && !PregenerationPassAllows(target.TypeID()) {
		logWarning(ctx.LogWarning, "minecraft:feature_rules",
			fmt.Sprintf("placement_pass is %q but places_feature %q is a %s -- the engine logs "+
				"\"cave_carver_feature\" is the only valid feature in \"pregeneration_pass\" placement pass. "+
				"and places nothing, so in game this rule is a guaranteed no-op however well its distribution "+
				"and biome filter are written. This tool still runs it, so what you see below is what the "+
				"game would NOT place; move the rule to a decoration pass (first_pass ... final_pass) to make "+
				"it real.", PregenerationPass, rule.PlacesFeature, target.TypeID()), &origin)
	}

	// The scatter feature's Molang parameter setup writes variable.originx/
	// originy/originz from the chunk-corner origin, and NOTHING else -- *** NO
	// RNG ***. variable.worldx/y/z are written per axis inside the distribution
	// walk (OnAxis below), exactly as in ScatterFeature.Place; feature_rules and
	// scatter_feature share the same scatter code in the engine, so they
	// share this behaviour too.
	// The delegate stream, defaulting to the distribution's own -- see PlaceContext.PlaceRandom.
	placeRandom := ctx.PlaceRandom
	if placeRandom == nil {
		placeRandom = ctx.Random
	}

	scope.Variable["originx"] = float64(origin.X)
	scope.Variable["originy"] = float64(origin.Y)
	scope.Variable["originz"] = float64(origin.Z)
	molangCtx := wgen.NewMolangContext(ctx.Random, scope, ctx.Biome, ctx.API, func(name string) {
		// Swallowed-and-reported, like every other unresolved read in this tool
		// -- see wgen.UnresolvedReadWarning. This context is the one seeded into
		// every sub-context below, so a read anywhere in the rule's delegation
		// chain that has not yet built its own context reports through here.
		logWarning(ctx.LogWarning, "minecraft:feature_rules", wgen.UnresolvedReadWarning(name), nil)
	})

	iterations, outcome := features.RunScatterDistribution(features.ScatterRun{
		Dist:   rule.Distribution,
		Molang: molangCtx,
		Random: ctx.Random,
		Origin: [3]int{origin.X, origin.Y, origin.Z},
		OnAxis: func(a features.Axis, absolute int) {
			scope.Variable[features.WorldVarName(a)] = float64(absolute)
		},
		OnIteration: func(offset features.AxisOffset, _ int) {
			pos := wgen.BlockPos{X: origin.X + offset.X, Y: origin.Y + offset.Y, Z: origin.Z + offset.Z}
			subCtx := &wgen.PlacementContext{
				API: ctx.API, Origin: pos, Random: placeRandom, MolangScope: scope, Biome: ctx.Biome,
				LogFailure: ctx.LogFailure, LogWarning: ctx.LogWarning,
				// Molang: the context built above from exactly this literal's
				// (Random, scope, Biome, API) tuple -- seeds the whole delegation
				// chain's cache so the first nested Molang-evaluating feature
				// reuses it instead of rebuilding. See
				// wgen.PlacementContext.Molang's invariant.
				Molang: molangCtx,
			}
			returned := target.Place(subCtx)
			placements = append(placements, Placement{Origin: pos, Returned: returned})
		},
	})

	// Say WHY a rule produced nothing. Silence here is what made a real rule with
	// scatter_chance 1.5 (a PERCENT -- 1.5%, not 150%) read as broken rather than unlucky:
	// the only diagnostic was "placement returned no result and wrote no blocks".
	switch outcome {
	case features.ScatterChanceRejected:
		logFailure(ctx.LogFailure, "minecraft:feature_rules",
			"scatter_chance did not roll this time, so this rule placed nothing -- luck, not "+
				"configuration. A different seed may place. A bare number here is a PERCENT: "+
				"scatter_chance 1.5 means 1.5%, not 150%.", origin)
	case features.ScatterZeroIterations:
		logFailure(ctx.LogFailure, "minecraft:feature_rules",
			"distribution.iterations evaluated to zero, so this rule placed nothing. Unlike a "+
				"chance rejection this is not luck -- a different seed will not help unless the "+
				"expression is itself random.", origin)
	}

	return RulePlacementResult{BiomeMatched: true, Iterations: iterations, Placements: placements, Scope: scope}
}
