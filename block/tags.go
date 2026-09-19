// tags.go is the PREDICATE half of block descriptor resolution: a
// {"tags": "..."} descriptor used in a match/allow-list position (
// may_replace, may_attach_to, allowed_surface_blocks, replaceable_blocks,
// constraints.block_intersection.block_allowlist, tree's
// may_grow_on/may_replace, ...) is a predicate over the CANDIDATE block's
// own tag set, not a request for one concrete block -- see MatchSet.
//
// This is the fix for the bug block.go's Resolve doc comment now calls
// out explicitly: collapsing a tag expression to one representative block
// (which Resolve still does, deliberately, for PRODUCING positions --
// places_block and similar, which really do need exactly one concrete
// block) is wrong for a predicate, because it silently narrows "any block
// tagged X" down to "exactly one specific block". `may_replace: [{"tags":
// "!q.any_tag('water')"}]` -- "replace anything that isn't water" -- was
// being resolved as "replace only air", because a negated expression has
// no single representative block and fell back to AirID.
//
// Two data sources feed a predicate's tag membership test, and they are
// NOT interchangeable:
//
//   - Pack blocks are authoritative. <pack>/blocks/**/*.json declares tags
//     as zero-value components named "tag:<name>" (e.g. "tag:dirt",
//     "tag:wiki:dune_shaver_excluded") directly under
//     minecraft:block.components. LoadBlockTags reads exactly this. This is
//     the ONLY source of truth for a pack's own tags, including every
//     custom-namespaced one -- there is no attempt to guess what a custom
//     tag means.
//   - Vanilla (built-in) block tags are NOT data the pack declares
//     anywhere, and this tool has no copy of the game's own tag
//     tables. tagRepresentativeBlock (block/kind.go) is kept as a SMALL,
//     EXPLICITLY approximate fallback -- one representative block per
//     vanilla tag name -- reused here for predicate matching exactly as
//     it already was for Resolve's producing-position use. It is not
//     extended: a vanilla tag this table doesn't know is diagnosed, never
//     silently guessed into a bigger table.
package block

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/stirante/featurelab/jsonc"

	molang "github.com/stirante/molang-go"
	"github.com/stirante/molang-go/ast"
	"github.com/stirante/molang-go/eval"
	"github.com/stirante/molang-go/mtrand"
	"github.com/stirante/molang-go/worldgen"
)

// SourceFile is a blocks/**/*.json file as delivered by the pack loader --
// mirrors features.SourceFile/structures.SourceFile/rules.SourceFile/
// biomes.SourceFile's own shape and "id is the path relative to the pack's
// blocks/ dir, forward-slashed" convention.
type SourceFile struct {
	ID      string
	AbsPath string
	Text    string
}

// Diagnostic mirrors features.Diagnostic/biomes.Diagnostic's own shape --
// see rules.go's header for why every loader in this codebase declares its
// own copy of this tiny type instead of sharing one (this package cannot
// import featurelab-go/features without creating an import cycle: features
// already imports block).
type Diagnostic struct {
	Level  string // "error" | "warning"
	FileID string
	// Line and Column are the 1-based place in FileID this message is about,
	// or both 0 when there is none -- same contract as features.Diagnostic's
	// own pair, filled in from jsonc.ErrorPosition where the parser knows it.
	Line    int
	Column  int
	Message string
}

// blockTagData is the pack's own authoritative per-block tag membership,
// built by LoadBlockTags from every "tag:<name>": {} component found under
// blocks/**/*.json.
type blockTagData struct {
	// byBlock maps a canonical (minecraft:-prefixed where the source name
	// carried no namespace) block name to the set of tag names declared
	// directly on it, exactly as written after "tag:" -- NOT normalized
	// (a pack author who wrote "tag:minecraft:is_pickaxe_item_destructible"
	// meant that exact string, distinct from a bare "tag:pickaxe").
	byBlock map[string]map[string]struct{}
	// known is the set of every distinct tag name declared ANYWHERE in the
	// pack -- lets tagKnown tell "declared, but not on THIS block" (a real,
	// negative answer) apart from "never declared anywhere, we have no
	// idea what this name even means" (diagnostic-worthy).
	known map[string]struct{}
}

// LoadBlockTags (re)builds this Palette's pack-tag index from files,
// replacing whatever was loaded before -- safe to call again after a pack
// reload (session.Workspace's per-kind invalidation calls this whenever the
// blocks/ file set changes, mirroring how structures/features are
// rebuilt). Returns one Diagnostic per file that could not be attributed
// to a block (malformed JSON, or minecraft:block.description.identifier
// missing) -- tolerated, not fatal, matching every other loader in this
// codebase's "best effort, report, keep going" convention.
//
// files is processed in order, and when two files declare the SAME block
// identifier, the LATER file's own tag:* components entirely REPLACE the
// earlier file's for that identifier -- never unioned. This is what makes
// "a user-pack block overrides the vanilla entry of the same id" (pack.
// Load appends the generated vanilla default catalogue before a pack's own
// blocks/ files) behave the way a higher-priority pack overriding a lower
// one does in game: the later declaration wins outright, including
// dropping a tag the earlier declaration had that the later one omits, not
// just adding whatever new tags the later declaration introduces.
//
// For TAGS, only the top-level minecraft:block.components bag is read. Real
// Bedrock blocks can also declare components per "permutations" entry; tag
// components in practice sit at the top level rather than inside a
// permutation, so that shape is not handled here -- a permutation-scoped tag would need per-state
// resolution this port's Descriptor.States plumbing doesn't carry into tag
// matching in the first place. A file shaped that way is silently not
// mined for tags rather than erroring, consistent with "this loader reads
// what real pack files use, not the full schema". This SAME walk does read
// permutations for a block's APPEARANCE, where the same shape is common and
// per-state resolution has an answer -- see render.go and permutations.go.
func (p *Palette) LoadBlockTags(files []SourceFile) []Diagnostic {
	var diags []Diagnostic
	data := &blockTagData{byBlock: make(map[string]map[string]struct{}), known: make(map[string]struct{})}
	pfData := &blockPlacementFilterData{byBlock: make(map[string]blockPlacementFilterEntry)}
	mbData := &blockMultiBlockData{byBlock: make(map[string]multiBlockTraitEntry)}
	rdData := &blockRenderData{byBlock: make(map[string]BlockRender), notes: make(map[string]RenderNote)}

	for _, f := range files {
		if jsonc.HasUTF8BOM([]byte(f.Text)) {
			diags = append(diags, Diagnostic{Level: "warning", FileID: f.ID, Message: jsonc.UTF8BOMWarning})
		}
		stripped := jsonc.StripComments([]byte(f.Text))
		var root map[string]any
		if err := json.Unmarshal(stripped, &root); err != nil {
			pos, _ := jsonc.ErrorPosition(stripped, err)
			diags = append(diags, Diagnostic{Level: "error", FileID: f.ID, Line: pos.Line, Column: pos.Column,
				Message: jsonc.InvalidJSONMessage(stripped, err)})
			continue
		}
		blockBody, ok := root["minecraft:block"].(map[string]any)
		if !ok {
			// Not every *.json under blocks/ is necessarily a block
			// definition in every real pack layout (e.g. an item file
			// filed under the wrong directory) -- skip rather than error,
			// mirroring pack.Load's own general tolerance.
			continue
		}
		desc, _ := blockBody["description"].(map[string]any)
		identifier, _ := desc["identifier"].(string)
		if identifier == "" {
			diags = append(diags, Diagnostic{Level: "warning", FileID: f.ID,
				Message: "minecraft:block.description.identifier is missing -- tags in this file are not attributable to a block and were skipped"})
			continue
		}
		canonical := canonicalName(identifier)
		components, _ := blockBody["components"].(map[string]any)
		// Built fresh per file and assigned wholesale (not merged into
		// whatever data.byBlock[canonical] already held) -- see this
		// function's doc comment: a later file for the same identifier
		// must entirely REPLACE an earlier one's tag set, including
		// dropping tags the later file doesn't repeat, not just add to it.
		tagSet := make(map[string]struct{}, len(components))
		for key := range components {
			tag, ok := strings.CutPrefix(key, "tag:")
			if !ok || tag == "" {
				continue
			}
			tagSet[tag] = struct{}{}
			data.known[tag] = struct{}{}
		}
		data.byBlock[canonical] = tagSet

		// minecraft:placement_filter -- parsed from the SAME already-decoded components map,
		// not a second walk over files. See this file's "minecraft:placement_filter" section
		// below for the full derivation; assigned unconditionally per file (even when the
		// component is absent from THIS file), mirroring tagSet immediately above: a later
		// file's own declaration for the same block id entirely REPLACES an earlier one's,
		// including replacing a presence with an absence.
		pfEntry, pfDiags := p.parsePlacementFilterEntry(components, f.ID)
		diags = append(diags, pfDiags...)
		pfData.byBlock[canonical] = pfEntry

		// minecraft:multi_block / minecraft:placement_direction traits -- parsed from the SAME
		// already-decoded description map, not a second walk over files (see multiblock.go).
		// Assigned unconditionally per file, the same later-file-wins-outright rule as above.
		mbEntry, mbDiags := parseMultiBlockTraitEntry(desc, f.ID)
		diags = append(diags, mbDiags...)
		mbData.byBlock[canonical] = mbEntry

		// minecraft:material_instances / minecraft:geometry / minecraft:block_shape --
		// how the block LOOKS, parsed from the SAME already-decoded components map (see
		// render.go). Unlike the three indexes above this one is assigned only when the
		// file actually declares one of those components: a block that declares none has
		// nothing to say about its appearance, which is not the same as declaring that it
		// is untextured, and the generated vanilla catalogue stacked underneath every pack
		// load declares an empty components bag for all of its blocks. The later-file-wins
		// rule still holds for a block that DOES declare them -- a pack file overriding a
		// vanilla id replaces the earlier entry outright.
		// The whole block body, not just its components: unlike the three
		// indexes above, appearance is also declared per "permutations"
		// entry, and enumerating those needs description.states as well (see
		// permutations.go).
		if br, brNotes, ok := parseBlockRender(canonical, f.ID, blockBody); ok {
			rdData.byBlock[canonical] = br
			delete(rdData.notes, canonical)
			for _, note := range brNotes {
				// One note per BLOCK: a block with several unhappy faces reports the
				// first, not one line per face. See RenderNote's doc comment.
				if _, already := rdData.notes[canonical]; !already {
					rdData.notes[canonical] = note
				}
			}
		}
	}

	p.tagData = data
	p.placementFilterData = pfData
	p.multiBlockData = mbData
	p.renderData = rdData
	return diags
}

// ---------------------------------------------------------------------------
// minecraft:placement_filter -- the placement-filter component's own
// data-driven JSON component, parsed by the SAME per-file walk LoadBlockTags
// already runs for "tag:*" components above (see LoadBlockTags's own doc
// comment for why a later file's declaration for the same block id entirely
// REPLACES an earlier one's -- the identical "later pack layer wins
// outright" rule applies here too, for the identical reason).
//
// ---- Why this exists: closing featurelab-go/features/geode.go's last open gap ----
//
// The block's face-taking placement check is the real dispatcher geode.go's
// Place() calls (indirectly, via geodeMayPlace + this file's PlacementFilterAllows below -- see
// geode.go's header, "GAP 2 CLOSED"/"SIXTH PASS"). Its shape:
//
//	allowed = the per-block-type placement rule           // geodeMayPlace already models this
//	if the block carries a placement-filter component:
//	    allowed &= the placement-filter component's check    // <- this section's addition
//	if the block carries a multi-block component and allowed:
//	    allowed &= the per-part walk                         // still open -- see geode.go header
//
// i.e. the per-block-type result is ANDed with the placement-filter component's own verdict ONLY
// when the component is present at all (component absent -> that AND is skipped outright), then
// (if still true) further ANDed with the multi-block component's own verdict, same "present ->
// AND, absent -> skip" shape.
//
// The placement-filter component's face-taking check (there is also a form without a face,
// which the block's placement check does not use):
//
//	if (conditions is empty) return false;                       // a component with ZERO conditions denies outright
//	faceBit = the per-face bit table[face];                      // {1,2,4,8,16,32}, Down..East
//	for each condition (an allowed-faces mask plus a block_filter descriptor list):
//	    if (faceBit & condition.allowedFacesMask) == 0: continue // this condition's allowed_faces excludes this face
//	    anchor = the neighbour at the opposite-face table[face]
//	    primary = the block at the anchor
//	    if condition.block_filter matches primary: return true
//	    liquid = the liquid-layer block at the anchor
//	    if liquid != primary && condition.block_filter matches liquid: return true
//	return false
//
// In geode.go's own calling shape (the placement-filter component's check called on the SAME
// neighbor/face pair the amethyst cluster block's placement check already receives), `anchor`
// cancels back to
// `pos` itself for the identical reason geode.go's own "FIFTH PASS CORRECTION" section already
// derives for the per-block-type check -- so this, too, is checkable once per potential position
// (using the already-picked face), not once per candidate face.
//
// This port's world model has no separate liquid/legacy block layer at a position (the SAME
// established precedent features/geode.go's own canSupportGeode doc comment and
// features/partially_exposed_blob.go cite for the identical primary/legacy-layer collapse) -- so
// the second (liquid-block) query, tried only when it differs from the first, has
// no second source to differ from here; PlacementFilterAllows below matches block_filter against
// the anchor's one and only block.
//
// allowed_faces STRING TABLE [CONFIRMED]: "down"=1, "up"=2, "north"=4, "south"=8, "west"=16,
// "east"=32 (an exact match for the per-face bit table's own bit-per-index encoding above),
// "side"=60 (=north|south|west|east, the four horizontal faces), "all"=63 (all six). An
// unrecognized string is diagnosed by the game (its content log carries "Unknown
// `allowed_faces` value of `%s`") and contributes no bits; this port's own parser does the same
// (a warning diagnostic, contributes no bits). The game's own block examples show the
// surrounding schema shape directly:
// `"minecraft:placement_filter": {"conditions": [{"allowed_faces":
// ["up","side"], "block_filter": [...]}]}`, and that block_filter accepts the SAME three shapes this
// codebase's own features.AsBlockDescriptor already normalizes (bare name string, {"name","states"},
// {"tags"}) -- one example mixes all three in one array.
//
// allowed_faces ABSENT from a condition entirely (a real, schema-legal shape -- the game's own
// examples show `"conditions": [{"block_filter": [...]}]` with no allowed_faces key at all) is
// INFERRED (not itself pinned for the "key absent" case specifically, as opposed to "key present
// with an empty/unknown array", which IS pinned above at mask=0) to
// mean mask=0 -- i.e. that condition can never fire on any face -- the safe, conservative
// reading: it can only make this port STRICTER than the game on an already-degenerate config,
// never wrongly ALLOW a placement the game would refuse.
//
// The multi-block component [NOT reachable from this port without a genuinely new
// subsystem -- see geode.go's own header for the full account and geode.go's warning text]: its
// own placement check requires the candidate block to carry a multi-block-part state and then
// walks the structure's OTHER parts, testing each computed part's own
// position -- none of which (part geometry, a multi-block-part-shaped state, part traversal) this
// codebase's block/state.go or pack JSON parsing represents anywhere. Left OPEN.
// ---------------------------------------------------------------------------

// placementFilterFaceMasks is the allowed_faces string->bitmask table [CONFIRMED -- see this
// section's header].
var placementFilterFaceMasks = map[string]uint8{
	"down": 1, "up": 2, "north": 4, "south": 8, "west": 16, "east": 32,
	"side": 60, "all": 63,
}

// placementFilterCondition is one minecraft:placement_filter "conditions[]" entry: allowedFaces is a
// bitmask in the per-face bit table's encoding (see placementFilterFaceMasks), blockFilter is matched against
// the anchor block via the SAME MatchSet predicate machinery every other "is this candidate block
// one of these" field in this codebase already uses -- block_filter's JSON shape (name string /
// {name, states} / {tags}) is exactly a block-descriptor list, so it gets the SAME name/tag matching,
// not a narrower one.
type placementFilterCondition struct {
	allowedFaces uint8
	blockFilter  MatchSet
}

// blockPlacementFilterEntry is one block's own minecraft:placement_filter state: present
// distinguishes "this block declares the component at all" (false -> PlacementFilterAllows is
// unrestricted, matching the block's own "component absent -> skip the AND" placement shape) from
// "declares it with zero conditions" (denies outright -- CONFIRMED, see this section's header).
type blockPlacementFilterEntry struct {
	present    bool
	conditions []placementFilterCondition
}

// blockPlacementFilterData is the pack's own authoritative per-block minecraft:placement_filter
// index, built by LoadBlockTags's SAME per-file walk that already builds blockTagData.
type blockPlacementFilterData struct {
	byBlock map[string]blockPlacementFilterEntry
}

// parsePlacementFilterEntry parses one file's own "minecraft:placement_filter" component (if
// present) out of the SAME already-decoded components map LoadBlockTags's tag loop reads --
// deliberately not a second walk over files, per this port's standard.
func (p *Palette) parsePlacementFilterEntry(components map[string]any, fileID string) (blockPlacementFilterEntry, []Diagnostic) {
	raw, ok := components["minecraft:placement_filter"].(map[string]any)
	if !ok {
		return blockPlacementFilterEntry{}, nil
	}
	var diags []Diagnostic
	rawConds, ok := raw["conditions"].([]any)
	if !ok {
		// Component present but "conditions" missing/malformed: treated as zero conditions,
		// matching the game's own empty-conditions behaviour (denies outright) rather than
		// silently ignored.
		return blockPlacementFilterEntry{present: true}, diags
	}
	var conds []placementFilterCondition
	for i, rc := range rawConds {
		cm, ok := rc.(map[string]any)
		if !ok {
			diags = append(diags, Diagnostic{Level: "warning", FileID: fileID,
				Message: fmt.Sprintf("minecraft:placement_filter.conditions[%d] must be an object -- skipped", i)})
			continue
		}
		var mask uint8
		if rawFaces, ok := cm["allowed_faces"].([]any); ok {
			for _, rf := range rawFaces {
				name, _ := rf.(string)
				bits, known := placementFilterFaceMasks[name]
				if !known {
					diags = append(diags, Diagnostic{Level: "warning", FileID: fileID,
						Message: fmt.Sprintf("minecraft:placement_filter.conditions[%d].allowed_faces: unknown value %q", i, name)})
					continue
				}
				mask |= bits
			}
		}
		// allowed_faces entirely absent from this condition -> mask stays 0 -- INFERRED, see
		// this section's header.
		descs, err := placementFilterDescriptorList(cm["block_filter"])
		if err != nil {
			diags = append(diags, Diagnostic{Level: "error", FileID: fileID,
				Message: fmt.Sprintf("minecraft:placement_filter.conditions[%d].block_filter: %v", i, err)})
			continue
		}
		condIndex := i
		ms := p.NewMatchSet(descs, func(tagName string) {
			diags = append(diags, Diagnostic{Level: "warning", FileID: fileID,
				Message: fmt.Sprintf("minecraft:placement_filter.conditions[%d].block_filter references unknown tag %q", condIndex, tagName)})
		}, func(queryName string) {
			diags = append(diags, Diagnostic{Level: "warning", FileID: fileID,
				Message: fmt.Sprintf("minecraft:placement_filter.conditions[%d].block_filter calls query.%s, which is "+
					"not a query a block filter can answer -- it evaluates to 0 for every block, so this condition "+
					"matches nothing. Only query.any_tag and query.all_tags are available here", condIndex, queryName)})
		}, func(expr string) {
			diags = append(diags, Diagnostic{Level: "warning", FileID: fileID,
				Message: fmt.Sprintf("minecraft:placement_filter.conditions[%d].block_filter draws randomness "+
					"(math.random and friends). This tool evaluates it against a generator seeded from the "+
					"expression itself, so a run is reproducible -- but the real game draws from a "+
					"process-global source with no connection to the world seed, so it will not agree, and it "+
					"will not agree with itself between two runs either", condIndex)})
		})
		for _, name := range ms.UnsetReads() {
			diags = append(diags, Diagnostic{Level: "warning", FileID: fileID,
				Message: fmt.Sprintf("minecraft:placement_filter.conditions[%d].block_filter reads %s, and a block "+
					"filter has no Molang scope to read it from -- nothing here ever sets it. In game an "+
					"unresolved read STOPS the expression where it stands, so this condition would be false for "+
					"every block; this tool reads it as 0 and evaluates the rest, which may not agree. Guard it "+
					"with `%s ?? <default>`, or drop it -- only query.any_tag and query.all_tags carry "+
					"information here", condIndex, name, name)})
		}
		conds = append(conds, placementFilterCondition{allowedFaces: mask, blockFilter: ms})
	}
	return blockPlacementFilterEntry{present: true, conditions: conds}, diags
}

// placementFilterDescriptor/placementFilterDescriptorList are a minimal, block-package-local mirror
// of features.AsBlockDescriptor/AsBlockDescriptorList's exact normalization (string / {name,
// states} / {tags}) -- duplicated rather than shared because this package cannot import
// featurelab-go/features (features already imports block -- see this file's Diagnostic doc comment
// above for the identical constraint already documented there).
func placementFilterDescriptor(value any) (Descriptor, error) {
	switch v := value.(type) {
	case string:
		return Descriptor{Name: v}, nil
	case map[string]any:
		if tags, ok := v["tags"].(string); ok {
			return Descriptor{IsTags: true, Tags: tags}, nil
		}
		if name, ok := v["name"].(string); ok {
			var states map[string]StateValue
			if rawStates, ok := v["states"]; ok && rawStates != nil {
				m, ok := rawStates.(map[string]any)
				if !ok {
					return Descriptor{}, fmt.Errorf("states must be an object")
				}
				states = make(map[string]StateValue, len(m))
				for k, sv := range m {
					states[k] = StateValue(sv)
				}
			}
			return Descriptor{Name: name, States: states}, nil
		}
	}
	return Descriptor{}, fmt.Errorf("must be a block name string, {name, states?}, or {tags}")
}

func placementFilterDescriptorList(value any) ([]Descriptor, error) {
	if value == nil {
		return nil, nil
	}
	arr, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("must be an array")
	}
	out := make([]Descriptor, 0, len(arr))
	for i, v := range arr {
		d, err := placementFilterDescriptor(v)
		if err != nil {
			return nil, fmt.Errorf("[%d]: %w", i, err)
		}
		out = append(out, d)
	}
	return out, nil
}

// PlacementFilterAllows mirrors the placement-filter component's check and its own role in the
// block's placement dispatcher -- see this file's "minecraft:placement_filter" section header for the full
// derivation. id is the block being placed (already resolved to a concrete ID); face is
// block.FacingDirection's own domain (0-5, Down/Up/North/South/West/East); anchorID is the block
// already queried at the anchor position (the SAME position geodeMayPlace's own per-block-type check
// already uses for this exact calling shape -- see features/geode.go). Returns true when id carries
// no minecraft:placement_filter component at all, mirroring the block's own "component absent
// -> skip the AND" placement shape -- the caller ANDs this into whatever else it has already
// computed, exactly like the real dispatcher does. Makes no RNG calls (matches the placement-filter
// component's check, whose own signature takes no generator either).
func (p *Palette) PlacementFilterAllows(id ID, face int, anchorID ID) bool {
	if p.placementFilterData == nil {
		return true
	}
	entry, ok := p.placementFilterData.byBlock[p.Entry(id).Name]
	if !ok || !entry.present {
		return true
	}
	if len(entry.conditions) == 0 {
		return false // a component with zero conditions denies outright -- CONFIRMED, see header
	}
	faceBit := uint8(1) << uint(face)
	for _, c := range entry.conditions {
		if c.allowedFaces&faceBit == 0 {
			continue
		}
		if c.blockFilter.Contains(anchorID) {
			return true
		}
	}
	return false
}

// blockHasTag reports whether canonical (already canonicalName-normalized)
// carries tagName -- the pack's own declaration first (authoritative), then
// the curated approximate vanilla table as a last resort (see this file's
// header). The approximate table only ever claims ONE representative block
// per tag, so it can produce false negatives for other real members of a
// vanilla tag (e.g. "water" only matches minecraft:water, never
// minecraft:flowing_water) -- an explicit, documented limitation of having
// no real vanilla tag data, not a bug in the matching logic itself.
func (p *Palette) blockHasTag(canonical, tagName string) bool {
	if p.tagData != nil {
		if tags, ok := p.tagData.byBlock[canonical]; ok {
			if _, ok := tags[tagName]; ok {
				return true
			}
		}
	}
	if rep, ok := tagRepresentativeBlock[strings.TrimPrefix(tagName, "minecraft:")]; ok {
		return canonical == rep
	}
	return false
}

// tagKnown reports whether tagName is resolvable from SOME real source --
// declared anywhere in the loaded pack, or covered by the curated
// approximate vanilla table -- as opposed to a name this port has zero
// information about. Used at MatchSet build time to decide whether an
// unmatched tag literal needs a diagnostic (see NewMatchSet's unknownTag
// callback) rather than being silently treated as "never present".
func (p *Palette) tagKnown(tagName string) bool {
	if p.tagData != nil {
		if _, ok := p.tagData.known[tagName]; ok {
			return true
		}
	}
	_, ok := tagRepresentativeBlock[strings.TrimPrefix(tagName, "minecraft:")]
	return ok
}

// ---------------------------------------------------------------------------
// MatchSet -- the predicate-position counterpart to Resolve.
// ---------------------------------------------------------------------------

// MatchSet is a predicate over palette-interned blocks, built from a list of
// Descriptors used in a PREDICATE position: may_replace, may_attach_to,
// allowed_surface_blocks, replaceable_blocks,
// constraints.block_intersection.block_allowlist, tree's
// may_grow_on/may_replace -- every "is this candidate block one of these"
// match list. This is distinct from Resolve, which is for a
// PRODUCING position that needs exactly one concrete block (places_block
// and similar).
//
// A plain name/state descriptor resolves once, at build time, to a
// concrete ID and is tested by fast set membership. A {"tags": "..."}
// descriptor is NOT collapsed to one representative block: it stays a
// compiled Molang program (parsed and evaluated through molang-go itself,
// not a hand-rolled call-shape parser, so arbitrary expressions --
// negation, boolean combinations of several any_tag/all_tags calls, etc.
// -- all work, not just the one narrow shape a bespoke parser would
// recognize) and is run per candidate against that SPECIFIC block's own
// real tag set (blockHasTag) every time Contains is called.
// MatchMode selects WHICH of the engine's block comparisons a match list uses.
// There are three, they disagree with each other, and which one applies is a
// property of the JSON FIELD, not of this type -- which is why this port's
// single shared MatchSet was wrong for almost every field until 2026-09-04.
//
// What the engine actually does:
//
//   - MatchPartial -- a block descriptor's match against a placed block. A
//     descriptor written as a BARE NAME compares the block type, i.e. the name
//     alone: `minecraft:oak_log` matches an oak log in ANY orientation. A
//     descriptor written WITH states compares the name plus ONLY the states it
//     wrote, ignoring every other state the candidate carries. This is a
//     partial predicate, and it is what nearly every field uses:
//     single_block's may_replace/may_attach_to/may_not_attach_to, multi_block's
//     may_replace, every tree list (may_grow_on, may_replace, base_block,
//     roots), multipart_block_column, vegetation_patch's replaceable_blocks,
//     structure block_intersection.block_allowlist, multiface, sculk_patch and
//     no_surface_ore.
//
//   - MatchType -- ore's `replace_rules[].may_replace` only. The comparison
//     keeps the block type and DISCARDS the states even when the author
//     wrote them, so a stated entry there behaves exactly like a bare one.
//
//   - MatchExact -- scatter's `allowed_surface_blocks` only. It resolves each
//     descriptor to one concrete Block and compares the hash of the full
//     serialization id: name AND every state at its concrete value. This is
//     the only field for which this port's original behaviour was the right
//     SHAPE.
//
// The direction of the old bug is worth keeping, because it is the direction
// that hides: exact-ID membership is STRICTER than the engine everywhere except
// allowed_surface_blocks, so the port PLACED LESS than the game rather than
// more, and a self-comparing digest cannot see "a feature that should have run
// and didn't". It only bit where the two sides were spelled differently, but
// that is not rare: the overwhelming majority of descriptors packs write are
// bare names, while structures, fossils, multi_block, horizontal_tree_decoration and
// anything auto-rotated write cells with every state spelled out. A tree's
// `may_replace: ["minecraft:oak_leaves"]` refused to replace a structure's
// `oak_leaves#persistent_bit=false`.
type MatchMode int

const (
	// MatchPartial is the default because it is what almost every field uses;
	// the two exceptions name themselves at their own call sites.
	MatchPartial MatchMode = iota
	MatchType
	MatchExact
)

// matchLiteral is one non-tag descriptor kept as the author WROTE it -- name
// plus only the states spelled out -- rather than collapsed into an interned
// ID. Collapsing was the old behaviour and is what made every list exact.
type matchLiteral struct {
	name   string
	states map[string]StateValue
}

type MatchSet struct {
	palette *Palette
	mode    MatchMode
	ids     map[ID]struct{}
	// bareNames holds the canonical name of every descriptor written WITHOUT
	// states. Under both MatchPartial and MatchType such an entry is satisfied
	// by name alone, so this is the whole comparison for nearly every entry
	// and deserves to be a map lookup rather than a scan.
	bareNames map[string]struct{}
	// aliasSplitTargets holds every block type that a bare PRE-FLATTENING name
	// in this set was split into. `minecraft:log` written with no states does
	// not name a block any more -- nothing is called that -- but the engine
	// still accepts every log type for it. Consulted under MatchPartial only:
	// the type-only and exact comparisons resolve such a descriptor to one
	// concrete block instead and never look at this list.
	aliasSplitTargets map[string]struct{}
	// statedLiterals holds the descriptors that DID spell states out -- rare in
	// practice. Kept as a slice because the count is tiny and the comparison is
	// per-state anyway.
	statedLiterals []matchLiteral
	// rng backs any program that draws. Non-nil only when at least one descriptor's expression can
	// reach math.random/math.random_integer/math.die_roll/math.die_roll_integer -- see Contains for
	// why it exists at all and why it is not the placement stream.
	rng *mtrand.Rand
	// dropped counts descriptors that were WRITTEN and could not be built into
	// anything testable -- today, a {"tags": ...} expression that fails to parse
	// or compile. It exists so Empty() can tell "the author wrote no list" from
	// "the author wrote a list and every entry in it was broken", which are the
	// same value in ids/programs and mean opposite things.
	//
	// Getting that wrong is not theoretical: every predicate site in this
	// codebase reads Empty() as "no restriction -> anything matches", so a
	// single typo'd tag expression in a may_replace list used to turn the
	// STRICTEST possible list into the MOST PERMISSIVE one, and a feature
	// written to leave terrain alone would carve straight through it, with
	// `check` and `generate` both exiting 0.
	dropped int
	// programs holds one compiled program per {"tags": ...} descriptor;
	// tagIntern maps every literal tag name any of them references to its
	// interned float64 id (molang-go has no string type -- a
	// query.any_tag('water') call arrives at the registered QueryFunc with
	// 'water' already reduced to that id, see eval.InternString), so
	// Contains can build one hasTag closure per call shared by every
	// program instead of recompiling anything.
	programs  []*molang.Program
	tagIntern map[float64]string
	// unsetReads is every temp./variable./context. name any of these programs
	// reads without a `??` to guard it, sorted and de-duplicated -- see
	// UnsetReads() and Contains's own context construction.
	unsetReads []string
}

// Empty reports whether this MatchSet imposes no restriction at all (the
// JSON field was absent/empty) -- the "no may_replace list -> anything
// matches" case every predicate position in this codebase special-cases.
//
// A set whose descriptors were all DROPPED as unbuildable is deliberately NOT
// empty. It has nothing to match against, so Contains returns false for every
// block, which is the safe direction: the author wrote a restriction and this
// tool could not read it, so nothing passes and they get a diagnostic, instead
// of everything passing and the preview quietly disagreeing with their file.
func (m MatchSet) Empty() bool {
	return len(m.ids) == 0 && len(m.programs) == 0 && m.dropped == 0
}

// Unbuildable reports that every descriptor written here was dropped -- the
// predicate exists and cannot be evaluated. Callers that want to say so in a
// diagnostic can ask; the matching behaviour (nothing passes) is already
// handled by Empty and Contains.
func (m MatchSet) Unbuildable() bool {
	return m.dropped > 0 && len(m.ids) == 0 && len(m.programs) == 0
}

// NewMatchSet builds a MatchSet from descs. unknownTag, if non-nil, is
// called once per distinct tag literal referenced by any {"tags": ...}
// descriptor in descs that tagKnown could not resolve from any real
// source -- NewMatchSet itself has no notion of "which feature" or "which
// JSON field", so turning that into a build diagnostic naming both is the
// caller's job (see features.ResolveMatchSet). A malformed Molang
// expression (fails to parse/compile) is recorded into UnresolvedTags,
// exactly like Resolve already does for an unresolvable producing-position
// tag expression, and counted into `dropped` so that a list whose entries were
// ALL dropped stays a restriction that nothing satisfies rather than
// collapsing into "no list at all". See MatchSet.dropped for why that
// distinction is load-bearing.
func (p *Palette) NewMatchSet(descs []Descriptor, unknownTag func(tagName string), unknownQuery func(queryName string), drawingTag func(expr string)) MatchSet {
	m := MatchSet{palette: p, ids: make(map[ID]struct{}), bareNames: make(map[string]struct{})}
	reportedUnknown := make(map[string]bool)

	for _, d := range descs {
		if !d.IsTags {
			states := d.States
			if len(states) == 0 {
				states = nil
			}
			// The interned ID is still recorded: MatchExact compares on it, and
			// Empty/Unbuildable count it. What is NEW is keeping the descriptor as
			// written as well, because the other two modes compare against the
			// author's spelling and cannot recover it from an ID.
			// Recorded the same way a PRODUCING position is (see
			// Palette.Resolve): a may_replace naming a block that does not
			// exist is a predicate that matches nothing, which costs an author
			// exactly as much as a places_block that places nothing, and is
			// just as invisible.
			p.noteIfUnknownName(d.Name)
			id := p.intern(d.Name, states)
			m.ids[id] = struct{}{}
			// Take BOTH the name and the states from the interned entry, never
			// from the descriptor as written. intern canonicalises the namespace
			// AND resolves the legacy aggregate aliases, and that second part
			// rewrites the states as well as the name: `minecraft:leaves` with
			// `old_leaf_type: oak` becomes `minecraft:oak_leaves` with NO states,
			// because the discriminator has been spent naming the block.
			//
			// Reading the name from the entry and the states from the descriptor
			// -- which is what this did until it was caught in review -- left a
			// literal demanding `old_leaf_type` of a block type that does not
			// declare it, so the standard vanilla spelling of a leaf descriptor
			// matched NOTHING, not even the block it had just interned to. Both
			// sides of every comparison are canonical; the descriptor's own
			// spelling is not.
			entry := p.Entry(id)
			if len(entry.States) == 0 {
				m.bareNames[entry.Name] = struct{}{}
				// A bare pre-flattening name interns to itself, because the
				// alias could not pick a target without its discriminator. Keep
				// what it was split into so a MatchPartial comparison can accept
				// any of them, which is what the engine does with the same
				// descriptor.
				if targets, ok := complexAliasPostSplitNames(entry.Name); ok {
					if m.aliasSplitTargets == nil {
						m.aliasSplitTargets = make(map[string]struct{}, len(targets))
					}
					for _, target := range targets {
						m.aliasSplitTargets[target] = struct{}{}
					}
				}
			} else {
				m.statedLiterals = append(m.statedLiterals, matchLiteral{name: entry.Name, states: entry.States})
			}
			continue
		}

		tree, err := molang.Parse(d.Tags)
		if err != nil {
			p.UnresolvedTags[d.Tags] = struct{}{}
			m.dropped++
			continue
		}
		program, err := molang.CompileAST(tree)
		if err != nil {
			p.UnresolvedTags[d.Tags] = struct{}{}
			m.dropped++
			continue
		}

		for _, name := range tagLiteralNames(tree) {
			if m.tagIntern == nil {
				m.tagIntern = make(map[float64]string)
			}
			m.tagIntern[eval.InternString(name)] = name
			if !p.tagKnown(name) && !reportedUnknown[name] {
				reportedUnknown[name] = true
				if unknownTag != nil {
					unknownTag(name)
				}
			}
		}
		// A query this predicate cannot answer is not an error to molang-go -- an unregistered
		// member resolves to 0, faithfully to the engine -- but for a predicate that means the
		// expression is false for every block, for ever. One letter is enough: `q.any_tags`
		// parses, compiles, and silently matches nothing.
		for _, name := range unregisteredQueryNames(tree) {
			if reportedUnknown["query."+name] {
				continue
			}
			reportedUnknown["query."+name] = true
			if unknownQuery != nil {
				unknownQuery(name)
			}
		}
		// A read of a slot nothing writes. Unlike the two loops above this is not
		// about a name being misspelled: `variable.x` is a perfectly good read
		// that simply has nowhere to read from in a block predicate, and in game
		// it would END the expression where it stands (see molang-go's
		// eval/unresolved.go, and wgen.UnresolvedReadWarning for why this tool
		// swallows it instead). Found here, from the AST, rather than at
		// evaluation time: the scope Contains builds is empty by construction, so
		// which reads are unresolved does not depend on the candidate block, and
		// saying so once per expression beats saying it once per block tested.
		for _, name := range unguardedScopeReads(tree) {
			if reportedUnknown["read."+name] {
				continue
			}
			reportedUnknown["read."+name] = true
			m.unsetReads = append(m.unsetReads, name)
		}
		// A predicate that draws is legal Molang and nothing else here refuses it, so it must not
		// be able to crash the evaluator. Give the set a deterministic generator the first time
		// one appears, seeded from the expression text so the same pack always draws the same
		// sequence, and say out loud that this is a substitution rather than the game's behaviour.
		if matchSetProgramDraws(tree) {
			if m.rng == nil {
				m.rng = mtrand.New(uint32(fnv32(d.Tags)))
			}
			if drawingTag != nil {
				drawingTag(d.Tags)
			}
		}
		m.programs = append(m.programs, program)
	}

	sort.Strings(m.unsetReads)
	return m
}

// UnsetReads returns every temp./variable./context. name this MatchSet's
// predicates read without a `??` guard, sorted -- names that are unresolved in
// a block predicate by construction, because the scope Contains evaluates
// against is always empty (see Contains). Callers turn them into build
// diagnostics naming the feature and field, exactly as they already do for
// Unbuildable() -- NewMatchSet has no notion of either.
func (m MatchSet) UnsetReads() []string { return m.unsetReads }

// unguardedScopeReads returns every temp./variable./context. read in tree that
// no enclosing `??` covers -- i.e. exactly the reads that would end a program
// run against a scope not holding them (molang-go's eval/unresolved.go), with
// the ones an author has already guarded left out.
//
// Three things are deliberately NOT reported.
//
//   - An AssignExpr's Target is a WRITE (`t.x = 1` sets the slot, it does not
//     consult it), and ast.Walk visits it as an ordinary Ident, so targets are
//     collected and skipped.
//   - The entire LEFT-HAND subtree of a `??` is guarded. The catch frame covers
//     the LHS and only the LHS, so a read in the RIGHT-hand side is still
//     reported (`v.a ?? v.b` really does leave v.b uncaught).
//   - Any name this expression ITSELF assigns, anywhere. That is deliberately
//     flow-INSENSITIVE, and deliberately errs towards silence: the idiom real
//     packs write is `t.x = t.x ?? 0.35; return t.x;`, whose final read is
//     unguarded and always resolves, because the statement before it wrote the
//     slot. Warning about it would cry wolf over the one shape everyone gets
//     right. The cost is a missed report when an expression reads a name BEFORE
//     writing it, which is rarer and much less harmful than the false alarm.
func unguardedScopeReads(tree *ast.Program) []string {
	// Keyed by node identity, and by *ast.Ident specifically: every AST node is
	// a pointer, but narrowing the key type to the one kind that is ever looked
	// up keeps this from depending on that.
	guarded := make(map[*ast.Ident]bool)
	written := make(map[string]bool)
	ast.Walk(tree, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.BinaryExpr:
			if v.Op == ast.NullCoalesce {
				ast.Walk(v.X, func(inner ast.Node) bool {
					if id, ok := inner.(*ast.Ident); ok {
						guarded[id] = true
					}
					return true
				})
			}
		case *ast.AssignExpr:
			guarded[v.Target] = true
			written[scopeReadName(v.Target)] = true
		}
		return true
	})

	var names []string
	seen := make(map[string]bool)
	ast.Walk(tree, func(n ast.Node) bool {
		id, ok := n.(*ast.Ident)
		if !ok || guarded[id] {
			return true
		}
		switch id.Namespace {
		case ast.Variable, ast.Temp, ast.Context:
		default:
			return true
		}
		name := scopeReadName(id)
		if seen[name] || written[name] {
			return true
		}
		seen[name] = true
		names = append(names, name)
		return true
	})
	return names
}

// scopeReadName is the "<namespace>.<member>" spelling molang-go itself reports
// an unresolved read under -- lower-cased, since member lookups are
// case-insensitive and `v.X` and `v.x` are one slot.
func scopeReadName(id *ast.Ident) string {
	return id.Namespace.String() + "." + strings.ToLower(id.Member)
}

// WithMode returns a copy of m comparing under mode. Building is independent of
// the comparison, so a caller that knows which JSON field it is resolving can
// set the mode after the fact -- see MatchMode for which field is which, and
// features.ResolveMatchSet for where that decision is actually made.
func (m MatchSet) WithMode(mode MatchMode) MatchSet {
	m.mode = mode
	return m
}

// literalsNamed returns every descriptor in this set naming block type name,
// bare ones included -- a bare entry is not "no states", it is "every state at
// its default", which is exactly what MatchExact has to compare against.
func (m MatchSet) literalsNamed(name string) []matchLiteral {
	var out []matchLiteral
	if _, ok := m.bareNames[name]; ok {
		out = append(out, matchLiteral{name: name})
	}
	for _, lit := range m.statedLiterals {
		if lit.name == name {
			out = append(out, lit)
		}
	}
	return out
}

// HasStatedEntries reports whether any descriptor here spelled states out. Only
// interesting to a caller building a diagnostic: under MatchPartial such an
// entry is the one case this port still cannot always decide (see
// statesSatisfied), and under MatchType it is the one case where the engine
// ignores what the author wrote.
func (m MatchSet) HasStatedEntries() bool { return len(m.statedLiterals) > 0 }

// effectiveValue is what a block interned as (name, states) actually carries
// for state key: the value written into the palette entry if there is one, and
// otherwise the value the type gives a freshly-placed block. ok is false only
// when neither is available -- the state was not written AND the type is not in
// the catalogue (a pack's own block, an alias, something added to the game
// since) or does not declare the state at all.
//
// This is the whole of what the state catalogue buys the match lists. An
// interned entry is not the same object as a placed Block: a Block always has
// every state at a concrete value, while an entry carries only what somebody
// wrote. Terrain is interned bare everywhere in env/, so before the catalogue
// existed "bare" and "at its default" were indistinguishable here and every
// comparison involving one had to decline to answer.
func effectiveValue(name string, states map[string]StateValue, key string) (StateValue, bool) {
	if v, ok := states[key]; ok {
		return v, true
	}
	if state, ok := LookupVanillaState(name, key); ok {
		return state.Default, true
	}
	return nil, false
}

// statesSatisfied reports whether a candidate of type name, carrying `have`,
// satisfies the states a descriptor `wrote`. Only the written states are
// examined; every other state the candidate carries is irrelevant, which is the
// whole point of a partial predicate.
//
// A candidate with no value written for one of those states stands for its
// type's default permutation, and since 2026-09-04 that is answerable: the
// catalogue supplies the default and the comparison proceeds. It used to return
// false there -- the stricter direction, chosen so nothing became more
// permissive than it could justify -- which made a stated entry silently miss
// every bare-interned cell.
//
// It still returns false when the type is unknown to the catalogue, and that is
// the honest answer rather than a fallback: for a pack's own block this package
// has no idea what a freshly-placed one carries, and guessing would make a
// custom block match a list the game would refuse.
func statesSatisfied(name string, wrote, have map[string]StateValue) bool {
	for k, want := range wrote {
		got, ok := effectiveValue(name, have, k)
		if !ok {
			return false
		}
		if !sameStateValue(got, want) {
			return false
		}
	}
	return true
}

// sameStateValue compares two values of the SAME state, across the spellings
// this codebase's two sources produce for one value.
//
// A boolean state arrives as a Go `bool` from the state catalogue and as a
// `float64` from NBT, because a structure palette stores it as TAG_Byte and
// nbt.stateValue widens every integral tag to float64. Comparing their rendered
// forms gives "false" against "0" and they never match -- which silently defeated
// the whole point of completion, since persistent_bit and update_bit are exactly
// the states an .mcstructure spells out and a pack author does not. Caught in
// review, not by a test: every test here used an enum state.
//
// Only bool-versus-number is coerced. Two numbers, or two strings, still have to
// render identically, so nothing here makes an enum token equal to an index.
func sameStateValue(a, b StateValue) bool {
	ab, aIsBool := a.(bool)
	bb, bIsBool := b.(bool)
	switch {
	case aIsBool && bIsBool:
		return ab == bb
	case aIsBool:
		return ab == truthyStateValue(b)
	case bIsBool:
		return bb == truthyStateValue(a)
	}
	return renderStateValue(a) == renderStateValue(b)
}

// truthyStateValue reads a non-bool spelling of a boolean state. Only 1 and the
// literal "true" count as set; anything else is false, so a malformed value
// fails to match rather than matching everything.
func truthyStateValue(v StateValue) bool {
	switch x := v.(type) {
	case float64:
		return x != 0
	case int:
		return x != 0
	case string:
		return x == "true" || x == "1"
	}
	return false
}

// sameCompletedBlock reports whether a descriptor written as (name, wrote) and a
// candidate of the same type carrying `have` are the SAME concrete block once
// both are completed to their type's defaults -- the comparison
// allowed_surface_blocks makes, where the engine resolves the descriptor to one
// real Block and compares the hash of its full serialization id.
//
// The completion is the point. A bare `minecraft:oak_log` in that list means the
// log's default permutation, so it must match a cell holding pillar_axis=y (the
// default) and must NOT match one holding pillar_axis=x -- a distinction the
// port could not make while it compared interned ids, because a bare entry only
// ever matched a bare cell. Structures are where this bites: an .mcstructure
// palette spells every state out, so every structure-placed cell was invisible
// to a bare entry.
//
// Falls back to exact equality of what was written when the type is unknown,
// which is the pre-catalogue behaviour and the only defensible answer for a
// block whose defaults nobody here knows.
func sameCompletedBlock(name string, wrote, have map[string]StateValue) bool {
	if !VanillaBlockKnown(name) {
		return stateKey(wrote) == stateKey(have)
	}
	// Every state that could distinguish the two: the ones the type declares,
	// plus anything either side wrote that it does not (a typo, or a state from
	// a build this catalogue predates -- either way a real difference if only
	// one side has it).
	keys := make(map[string]struct{}, len(wrote)+len(have))
	for _, state := range VanillaBlockStates(name) {
		keys[state.Key] = struct{}{}
	}
	for k := range wrote {
		keys[k] = struct{}{}
	}
	for k := range have {
		keys[k] = struct{}{}
	}
	for k := range keys {
		a, aok := effectiveValue(name, wrote, k)
		b, bok := effectiveValue(name, have, k)
		if aok != bok {
			return false
		}
		if aok && !sameStateValue(a, b) {
			return false
		}
	}
	return true
}

// Contains reports whether id matches this MatchSet, under this set's MatchMode
// (see MatchMode -- the three modes are three different engine comparisons, and
// the default is the one nearly every field uses), or -- for a {"tags": ...}
// descriptor -- by running its compiled Molang predicate with
// query.any_tag/all_tags backed by id's own real tag set. Any literal or any
// program matching makes the whole MatchSet match, matching how a JSON array of
// block descriptors already means "one of these" everywhere else here.
func (m MatchSet) Contains(id ID) bool {
	// A zero-value MatchSet is a real thing callers hold -- an unset map entry, a
	// `var x block.MatchSet` that a JSON field never filled -- and it used to
	// answer false harmlessly because the whole comparison was a map lookup.
	// Comparing by NAME means reaching for the palette, which a zero value does
	// not have, so without this the same callers get a nil dereference. Every
	// current one happens to test Empty() first, which is luck rather than a
	// documented precondition.
	if m.palette == nil {
		return false
	}
	if m.mode == MatchExact {
		// Identical spelling is the common case and settles it without touching
		// the catalogue; only a spelling difference needs completing.
		if _, ok := m.ids[id]; ok {
			return true
		}
		if e, ok := m.palette.lookup(id); ok {
			for _, lit := range m.literalsNamed(e.Name) {
				if sameCompletedBlock(e.Name, lit.states, e.States) {
					return true
				}
			}
		}
	} else if e, ok := m.palette.lookup(id); ok && (len(m.bareNames) > 0 || len(m.statedLiterals) > 0) {
		name := e.Name
		if _, ok := m.bareNames[name]; ok {
			return true
		}
		if m.mode == MatchPartial && len(m.aliasSplitTargets) > 0 {
			if _, ok := m.aliasSplitTargets[name]; ok {
				return true
			}
		}
		if len(m.statedLiterals) > 0 {
			have := e.States
			for _, lit := range m.statedLiterals {
				if lit.name != name {
					continue
				}
				// MatchType discards the states the author wrote, so reaching the
				// right name is the whole test.
				if m.mode == MatchType || statesSatisfied(name, lit.states, have) {
					return true
				}
			}
		}
	}
	if len(m.programs) == 0 {
		return false
	}
	canonical := m.palette.Entry(id).Name
	hasTag := func(argValue float64) bool {
		name, ok := m.tagIntern[argValue]
		if !ok {
			return false
		}
		return m.palette.blockHasTag(canonical, name)
	}
	funcs := worldgen.BiomeTagFuncs(hasTag)
	// RNG must be non-nil whenever any program here can draw. molang-go dereferences it without
	// checking, so a predicate containing math.random -- which is legal Molang and which nothing
	// else here rejects -- used to take down the whole process with a nil dereference. That is the
	// worst failure this file can produce: a pack author writes a legal expression and the tool
	// crashes instead of telling them anything.
	//
	// The generator is per-MatchSet and seeded from the expression text (see NewMatchSet), so the
	// same predicate draws the same sequence on every run of the same pack. It is deliberately NOT
	// the placement stream: a predicate is evaluated once per candidate block, thousands of times
	// per feature, and threading the placement RNG through would let a may_replace list move every
	// later placement. The engine's own source for math.* randomness in a non-actor context is a
	// process-global generator with no world seed anyway (see features/cave.go's header, PHASE 13),
	// so there is no reproducible behaviour to converge on -- and this project's standing policy,
	// set there, is that determinism from our own seed beats imitating something the game itself
	// cannot repeat. NewMatchSet warns when a predicate reaches this path.
	// A block predicate's scope is EMPTY here, always -- this literal builds a
	// fresh one on every call and nothing ever writes into it -- so any
	// temp./variable./context. read in a predicate is unresolved by
	// construction, not by circumstance. The engine would end the expression at
	// that read; this tool substitutes 0 and carries on for the reason
	// wgen.UnresolvedReadWarning gives at length. OnUnresolvedRead is
	// deliberately nil: which names those are is decided by the expression
	// alone, so NewMatchSet has already found them by reading the AST
	// (unsetReads) and reported them ONCE at build time, where this package's
	// diagnostics live -- rather than once per candidate block, which is what
	// this callback would mean in a predicate evaluated thousands of times per
	// feature.
	ctx := &molang.Context{Scope: molang.NewScope(), RNG: m.rng, ContinueOnUnresolvedRead: true,
		QueryFuncs: map[string]molang.QueryFunc{
			"any_tag":  funcs["any_tag"],
			"all_tags": funcs["all_tags"],
		}}
	for _, program := range m.programs {
		if program.Run(ctx) != 0 {
			return true
		}
	}
	return false
}

// tagLiteralNames returns every distinct string literal passed to a
// query.any_tag/all_tags (or q.any_tag/q.all_tags) call anywhere in tree,
// depth-first, via molang-go's own AST walker -- not a re-implementation of
// call-shape parsing, just picking the literal tag names back out of an
// already-real parse so NewMatchSet knows which names to intern/diagnose.
// matchSetProgramDraws reports whether this expression can reach one of Molang's four
// RNG-drawing math functions. Same walk shape as features/cave.go's own check on width_modifier.
func matchSetProgramDraws(tree *ast.Program) bool {
	found := false
	ast.Walk(tree, func(n ast.Node) bool {
		if found {
			return false
		}
		if call, ok := n.(*ast.CallExpr); ok && call.Callee != nil && call.Callee.Namespace == ast.Math {
			if eval.RandomFnNames[strings.ToLower(call.Callee.Member)] {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

// fnv32 is FNV-1a over the expression text, used only to seed the stand-in generator above. Any
// stable hash would do; this one is here so the seed is reproducible across runs and machines.
func fnv32(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}

// matchSetQueryNames is every `query.*` this port registers for a MatchSet's tag expression.
// A tag predicate is evaluated with the BLOCK-tag query set, not the full worldgen one -- there
// is no biome and no world here -- so this list is deliberately shorter than the one a feature's
// own Molang sees.
//
// It exists so a call to a name that is NOT in it can be reported. molang-go resolves an
// unregistered member to 0 rather than failing, which is faithful to the engine, and for a
// predicate that means the expression is false for every block, for ever. `q.any_tags('air')`
// -- one letter from `any_tag` -- parses, compiles, and silently matches nothing, and the only
// message the author gets is a runtime "may_replace rejected this position", which points at
// the list rather than at the typo in it.
var matchSetQueryNames = map[string]bool{
	"any_tag":  true,
	"all_tags": true,
}

// unregisteredQueryNames returns the `query.*` members this expression calls that a MatchSet
// cannot answer, lowercased and sorted. Empty for an expression that only calls known ones.
func unregisteredQueryNames(tree *ast.Program) []string {
	var names []string
	seen := make(map[string]bool)
	ast.Walk(tree, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || call.Callee == nil || call.Callee.Namespace != ast.Query {
			return true
		}
		member := strings.ToLower(call.Callee.Member)
		if matchSetQueryNames[member] || seen[member] {
			return true
		}
		seen[member] = true
		names = append(names, member)
		return true
	})
	sort.Strings(names)
	return names
}

func tagLiteralNames(tree *ast.Program) []string {
	var names []string
	seen := make(map[string]bool)
	ast.Walk(tree, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || call.Callee == nil || call.Callee.Namespace != ast.Query {
			return true
		}
		member := strings.ToLower(call.Callee.Member)
		if member != "any_tag" && member != "all_tags" {
			return true
		}
		for _, a := range call.Args {
			if s, ok := a.(*ast.StringLit); ok && !seen[s.Value] {
				seen[s.Value] = true
				names = append(names, s.Value)
			}
		}
		return true
	})
	sort.Strings(names)
	return names
}
