// Package block is the block palette and descriptor types worldgen features
// resolve block-descriptor JSON against. Per-block colour classification is
// a rendering-only concern and is deliberately not modelled here: only the
// air/solid/liquid/plant/glass "kind" a placement actually branches on
// matters.
package block

import (
	"sort"
	"strconv"
	"strings"
)

// ID is an interned block-state handle. AirID (0) is always air.
type ID int32

// AirID is always the palette's first-interned entry (see NewPalette).
const AirID ID = 0

// StateValue mirrors the JSON union a block state value can be: string,
// float64 (JSON number), or bool.
type StateValue interface{}

// Descriptor is a block descriptor as JSON spells it: a plain name string, a
// {name, states?} object, or a {tags} Molang-tag-query object.
type Descriptor struct {
	IsTags bool
	Tags   string
	Name   string
	States map[string]StateValue
}

// NameDescriptor builds a plain-name (no states) Descriptor.
func NameDescriptor(name string) Descriptor { return Descriptor{Name: name} }

// canonicalName trims the name, and prefixes "minecraft:" when it carries no
// namespace already.
func canonicalName(name string) string {
	trimmed := strings.TrimSpace(name)
	if strings.Contains(trimmed, ":") {
		return trimmed
	}
	return "minecraft:" + trimmed
}

// renderStateValue is the value coercion stateKey uses: booleans as
// true/false, numbers via plain decimal (no trailing ".0" for integral
// values), strings as-is.
func renderStateValue(v StateValue) string {
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'g', -1, 64)
	case int:
		return strconv.Itoa(x)
	default:
		return ""
	}
}

// stateKey is the canonical state key: sorted "k=v" pairs joined by ",".
func stateKey(states map[string]StateValue) string {
	if len(states) == 0 {
		return ""
	}
	keys := make([]string, 0, len(states))
	for k := range states {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + renderStateValue(states[k])
	}
	return strings.Join(parts, ",")
}

// Entry is one interned palette entry. Tagged lowerCamelCase (id/name/states/kind) for the
// wire contract this type crosses as session.Result.Palette -- see featurelab-go/wire's
// package doc comment for the full wire spec, including Kind's numeric encoding.
type Entry struct {
	ID     ID                    `json:"id"`
	Name   string                `json:"name"` // canonical, minecraft:-prefixed
	States map[string]StateValue `json:"states"`
	Kind   Kind                  `json:"kind"`
}

// CanonicalString is this entry's canonical descriptor string exactly as
// the golden digest's write-hash encoding expects: the name alone when
// there are no states, else "name#k1=v1,k2=v2" sorted by key.
func (e Entry) CanonicalString() string {
	return CanonicalKey(e.Name, e.States)
}

// CanonicalKey renders a (name, states) pair into the same canonical
// descriptor string the canonicalName/stateKey convention (and
// the golden digest's write-hash encoding) expects — exported so a
// consumer with only an IPaletteView (NameOf/StatesOf) interface can
// reproduce it without reaching into a *Palette's private entries.
func CanonicalKey(name string, states map[string]StateValue) string {
	sk := stateKey(states)
	if sk == "" {
		return name
	}
	return name + "#" + sk
}

// Palette interns block states into small integer ids, id 0 always air.
type Palette struct {
	entries        []Entry
	byKey          map[string]ID
	UnresolvedTags map[string]struct{}
	// UnresolvedAliases contains known complex legacy aliases whose state
	// discriminator was absent or not confirmed. They are retained verbatim
	// instead of being silently approximated.
	UnresolvedAliases map[string]struct{}
	// unknownNames collects every block NAME a JSON descriptor asked for that
	// KnowsBlockName could not find in any block table this engine has -- see
	// Resolve and NewMatchSet, which record into it, and TakeUnknownNames,
	// which drains it.
	//
	// A name here is NOT an error and the palette does not treat it as one: it
	// is interned like any other, the feature builds, and the preview places a
	// block by that name. The recording exists because nothing else can see
	// the difference. "minecraft:stone" and "not even an id" are both strings
	// that intern fine, and the second one is a feature that does nothing in
	// the real game.
	unknownNames map[string]struct{}
	// tagData is the pack's own per-block tag index, populated by
	// LoadBlockTags (tags.go) -- nil until a caller loads a pack's
	// blocks/**/*.json, in which case every tag lookup just falls back to
	// the curated approximate vanilla table (see blockHasTag/tagKnown).
	tagData *blockTagData
	// placementFilterData is the pack's own per-block minecraft:placement_filter index, built by
	// the SAME LoadBlockTags walk that builds tagData -- nil until a caller loads blocks/**/*.json,
	// in which case PlacementFilterAllows treats every block as carrying no such component (matches
	// the block's own "component absent -> unrestricted" placement shape). See tags.go's
	// "minecraft:placement_filter" section for the full derivation.
	placementFilterData *blockPlacementFilterData
	// multiBlockData is the pack's own per-block minecraft:multi_block trait index, built by the
	// SAME LoadBlockTags walk (see multiblock.go) -- nil until a caller loads blocks/**/*.json,
	// in which case MultiBlockTrait treats every block as not a multi-block (matching the
	// game, where only applying the multi-block trait ever attaches the component).
	multiBlockData *blockMultiBlockData
	// renderData is the pack's own per-block APPEARANCE index -- which texture each
	// face uses, how it is drawn, what shape it is -- built by the SAME LoadBlockTags
	// walk (see render.go). nil until a caller loads blocks/**/*.json, in which case
	// BlockRender reports "not declared" for every block and the preview keeps using
	// the flat fallback colour it uses today.
	renderData *blockRenderData
}

// NewPalette returns a palette with air pre-interned as id 0.
func NewPalette() *Palette {
	p := &Palette{
		byKey:             make(map[string]ID),
		UnresolvedTags:    make(map[string]struct{}),
		UnresolvedAliases: make(map[string]struct{}),
	}
	p.intern("minecraft:air", nil)
	return p
}

func (p *Palette) intern(name string, states map[string]StateValue) ID {
	canonical, states, unresolvedAlias := resolveBlockAlias(name, states)
	if unresolvedAlias {
		p.UnresolvedAliases[CanonicalKey(canonical, states)] = struct{}{}
	}
	key := canonical + "#" + stateKey(states)
	if existing, ok := p.byKey[key]; ok {
		return existing
	}
	id := ID(len(p.entries))
	p.entries = append(p.entries, Entry{ID: id, Name: canonical, States: states, Kind: classify(canonical, states)})
	p.byKey[key] = id
	return id
}

// Get interns by plain name/states directly — used by environment building.
func (p *Palette) Get(name string, states map[string]StateValue) ID {
	return p.intern(name, states)
}

// Resolve resolves a JSON block descriptor for a PRODUCING position -- one
// that needs exactly one concrete block, e.g. places_block and similar
// "the block to place/attach" fields. A tag-form descriptor resolves
// against the small, explicitly approximate tagRepresentativeBlock table
// (block/kind.go); anything unresolved interns as air and is recorded in
// UnresolvedTags. The approximation is deliberate -- a producing
// position genuinely needs ONE block, so some representative choice is
// unavoidable.
//
// Do NOT use Resolve for a PREDICATE/match-list position (may_replace,
// may_attach_to, allowed_surface_blocks, and similar "is this candidate
// one of these" fields) -- collapsing a tag expression to one
// representative block there silently narrows "any block matching this
// tag" down to "exactly one specific block" (this is the bug: a negated
// expression like `!q.any_tag('water')`, "replace anything that isn't
// water", has no single representative block and fell back to AirID,
// i.e. "replace only air"). Use NewMatchSet (tags.go) instead: it keeps a
// tag descriptor as a real predicate, evaluated per candidate against that
// block's own tag set.
func (p *Palette) Resolve(desc Descriptor) ID {
	if desc.IsTags {
		if resolved, ok := resolveTagExpression(desc.Tags); ok {
			return p.intern(resolved, nil)
		}
		p.UnresolvedTags[desc.Tags] = struct{}{}
		return AirID
	}
	states := desc.States
	if len(states) == 0 {
		states = nil
	}
	p.noteIfUnknownName(desc.Name)
	return p.intern(desc.Name, states)
}

// KnowsBlockName reports whether name is a block this engine has heard of, in
// any of the three tables it has: the embedded vanilla catalogue
// (VanillaBlockNames), the built-in classification table -- which also carries
// the legacy aggregate ids that are block names without being catalogue
// entries, minecraft:log/minecraft:leaves and friends (IsKnownBlockName) --
// and the pack's OWN blocks/**/*.json, if LoadBlockTags has indexed one.
//
// Vanilla is answered from the embedded catalogue rather than from the tag
// index deliberately: the index only carries vanilla because pack.Load stacks
// DefaultBlocks() under every pack, so a Palette built by hand or loaded in a
// different order would otherwise report minecraft:diamond_block as a block
// that does not exist. See VanillaBlockNames.
//
// A "no" is not proof of anything, which is why the only thing built on this
// answer is a WARNING: a block another add-on in the world declares appears in
// none of these tables, is entirely real at run time, and is spelled exactly
// like a typo.
//
// The name is canonicalised first (an unnamespaced "stone" is
// "minecraft:stone"), because that is the lookup the engine itself does.
func (p *Palette) KnowsBlockName(name string) bool {
	canonical := canonicalName(name)
	if IsKnownBlockName(canonical) {
		return true
	}
	if _, ok := VanillaBlockNames()[canonical]; ok {
		return true
	}
	if p == nil || p.tagData == nil {
		return false
	}
	_, ok := p.tagData.byBlock[canonical]
	return ok
}

// noteIfUnknownName records name into unknownNames when no block table has it.
// Empty names are skipped: an empty block descriptor is refused by the parser
// long before it reaches a palette (see features.AsBlockDescriptor), so a "" in
// here would mean a caller built a Descriptor by hand, and "" is not a
// misspelled block name -- it is no name at all, which is a different finding
// with a different message.
func (p *Palette) noteIfUnknownName(name string) {
	if p == nil || strings.TrimSpace(name) == "" || p.KnowsBlockName(name) {
		return
	}
	if p.unknownNames == nil {
		p.unknownNames = make(map[string]struct{})
	}
	p.unknownNames[name] = struct{}{}
}

// TakeUnknownNames returns every block name recorded since the last call,
// sorted, and CLEARS the set.
//
// It drains rather than accumulates because the caller that wants this is
// features.BuildLibrary, which builds one file at a time against one shared
// palette and needs to say WHICH file named a block that does not exist. A set
// that kept everything would attribute the second file's typo to the first,
// and a pack where two files share a typo would be told about it once.
func (p *Palette) TakeUnknownNames() []string {
	if p == nil || len(p.unknownNames) == 0 {
		return nil
	}
	out := make([]string, 0, len(p.unknownNames))
	for name := range p.unknownNames {
		out = append(out, name)
	}
	sort.Strings(out)
	p.unknownNames = nil
	return out
}

// lookup is Entry without the panic: it reports false for an id this palette
// has never interned, instead of taking the process down.
//
// Every production caller holds one palette per session, so a foreign id means
// the caller has two and the answer is meaningless whichever way it comes back.
// The distinction that matters is what happens NEXT: Entry's panic is right for
// a caller that is indexing its own palette and can only be wrong by being
// broken, while MatchSet.Contains is a predicate evaluated against whatever
// block the world hands it, thousands of times per feature, and answering "no"
// there is survivable where a crash is not. Contains reached for this the first
// time it needed a name rather than an interned id -- and immediately found a
// test that had been building its match list against a second, empty palette
// and passing for the wrong reason.
func (p *Palette) lookup(id ID) (Entry, bool) {
	if int(id) < 0 || int(id) >= len(p.entries) {
		return Entry{}, false
	}
	return p.entries[id], true
}

func (p *Palette) Entry(id ID) Entry {
	if int(id) < 0 || int(id) >= len(p.entries) {
		panic("block id is not in the palette")
	}
	return p.entries[id]
}

func (p *Palette) NameOf(id ID) string                  { return p.Entry(id).Name }
func (p *Palette) StatesOf(id ID) map[string]StateValue { return p.Entry(id).States }
func (p *Palette) IsAir(id ID) bool                     { return p.Entry(id).Kind == KindAir }
func (p *Palette) IsLiquid(id ID) bool                  { return p.Entry(id).Kind == KindLiquid }
func (p *Palette) IsSolid(id ID) bool                   { return p.Entry(id).Kind == KindSolid }
func (p *Palette) Size() int                            { return len(p.entries) }

// Snapshot returns a copy of every interned entry, index-addressed by
// block.ID. Used by session.Result.Palette
// so a JSON consumer can decode Result.Blocks/Baseline ids into names/states
// without reaching into a *Palette directly.
func (p *Palette) Snapshot() []Entry {
	out := make([]Entry, len(p.entries))
	copy(out, p.entries)
	return out
}

// UnresolvedTagList returns the {tags: "..."} descriptor expressions that
// failed to resolve, sorted -- a JSON/report-friendly view of
// UnresolvedTags.
func (p *Palette) UnresolvedTagList() []string {
	out := make([]string, 0, len(p.UnresolvedTags))
	for t := range p.UnresolvedTags {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// UnresolvedAliasList returns known legacy aliases that could not be resolved
// without guessing, sorted for deterministic diagnostics/reporting.
func (p *Palette) UnresolvedAliasList() []string {
	out := make([]string, 0, len(p.UnresolvedAliases))
	for alias := range p.UnresolvedAliases {
		out = append(out, alias)
	}
	sort.Strings(out)
	return out
}
