// multi_block.go implements minecraft:multi_block_feature — a type that does NOT exist in
// game version 1.26.40 at all (one of three feature types new in 1.26.50).
// multi_block_test.go's tests are the only check on this implementation.
//
// Behaviour summary: the four keys below are the COMPLETE key list. The places_block parse is
// where the three parse diagnostics and the Air fallback live; enforce_placement_rules is a
// plain store with no validation. A block is a multi-block start when "the type carries the
// multi-block state AND the block's part index is 0". The placement allow-list check returns
// true immediately for an empty list — the same "empty may_replace = no constraint" as
// single_block. Block rotation is implemented IN FULL in block/rotate.go (all sixteen arms,
// cumulative, absolute SET, identity pass-through). The arm this feature is guaranteed to hit
// is the cardinal-direction one, whose direction mapping pairs (value,key) are
// (2,0),(3,1),(0,2),(1,3).
//
// The block-side machinery (the minecraft:multi_block BLOCK TRAIT, the
// "minecraft:multi_block_part" state, part count/direction, and why the placement-direction
// behavior byte is always 0 for JSON-defined blocks) lives in block/multiblock.go — its
// header describes that behaviour; this file only refers to it.
//
// SCHEMA, in declaration order. The ENTIRE schema is wrapped in one format_version gate:
// the game uses feature schema version 5, whose minimum format version is
// 1.26.40, and skips ALL FOUR keys when the pack's format_version is below that. (The
// version comparison is a real comparison, not a string match.) That branch is unreachable in
// practice and this builder does not test for it: the TYPE itself is only registered into the
// 1.26.40 and 1.26.50 bands, so a file old enough to lose the keys cannot name the type in
// the first place. features/typeavailability.go enforces that coarser gate, and registry.go
// refuses the file before any builder runs.
//
//	places_block            block descriptor            REQUIRED
//	enforce_placement_rules bool                        optional, default false
//	randomize_rotation      bool                        optional, default false
//	may_replace             array of block descriptors  optional (unbounded, elements not
//	                          required)
//
// Defaults: everything starts zeroed — so enforce_placement_rules and randomize_rotation
// default false and may_replace defaults empty.
//
// The places_block parse:
//
//  1. resolve the descriptor to a block; nothing there -> content-log "Block '%s' is
//     invalid." and fall to the Air fallback below.
//  2. look for the multi-block component, first on the block's own component storage and then
//     on its type's; neither -> content-log "Must place a multi-block in a
//     'minecraft:multi_block_feature'" -> Air fallback.
//  3. the multi-block-start test fails, i.e. the block's minecraft:multi_block_part state is
//     not zero -> content-log "If trying to place a multi-block in a
//     'minecraft:multi_block_feature' only the starting part may be used in field
//     'places_block'" -> Air fallback.
//  4. Success: the descriptor and its resolved block are both stored on the feature. The AIR
//     FALLBACK stores a descriptor for air instead — the file still PARSES; the feature then
//     fails every placement with "Invalid 'places_block'" (air's type has no multi_block
//     state). These content logs are parse-time diagnostics, not schema errors, so this
//     builder mirrors them as ctx.Warn + an always-failing feature, not as build errors.
//
// The randomize_rotation parse: a value of true resolves the descriptor's block and asks
// whether its type carries the cardinal-direction state; missing -> content-log "Block '%s'
// does not have a cardinal direction state and cannot be randomly rotated." and store FALSE —
// the flag is DOWNGRADED at parse time. The placement routine's own re-check of the same
// state ("Block doesn't contain the 'minecraft:cardinal_direction' state, cannot randomly
// rotate it.") is therefore unreachable through the JSON path, and this port mirrors the
// downgrade rather than the dead re-check.
//
// The placement ALGORITHM:
//
//  1. block := the cached resolved block. If absent OR its type does not carry the built-in
//     multi-block state: logFailure "Invalid 'places_block'", return nothing. ZERO RNG. (A
//     second sanity path — component missing while the state exists — treats a block carrying
//     the multi-block state without its component as invalid, and logs "Invalid multi-block";
//     unreachable for trait-built blocks, not modeled.)
//  2. If randomize_rotation: *** RNG CALL — the engine's raw unsigned draw with a bound of
//     4 — *** then block = the engine's block rotation of that draw, which for this feature's
//     guaranteed cardinal_direction state maps the drawn CommonDirection to a
//     cardinal-direction value via the (2,0),(3,1),(0,2),(1,3) table: draw 0 -> north(2),
//     1 -> east(3), 2 -> south(0), 3 -> west(1). The draw happens BEFORE every placement
//     check, so a placement that later fails has still consumed it. (The routine re-checks
//     the state first and fails without drawing if absent — unreachable, see above.)
//     The rotation is NOT cardinal-only. It is a flat sequence of sixteen independent arms
//     and EVERY arm whose state the block carries fires, cumulatively — so a places_block
//     descriptor that also writes pillar_axis, facing_direction, orientation or any of the
//     other thirteen has those rewritten by the same draw. randomize_rotation's parse-time
//     gate on the cardinal-direction state decides only whether the flag survives; it does
//     not narrow what the rotation then touches. This builder calls block/rotate.go's full
//     port rather than rewriting the one state (it used to rewrite only cardinal_direction,
//     which silently under-rotated every other family), and carries single_block.go's
//     unconfirmed-spelling warning for the ten families whose integer-to-JSON-token
//     step is taken from vanilla state definitions rather than from the game's own table.
//  3. dir := the multi-block component's direction query: with the placement-direction
//     behavior byte 0 (always, for JSON-defined blocks — see block/multiblock.go)
//     this is the trait's fixed direction; partCount := the component's part-count query.
//     Part i's position is origin + the per-face offset for dir, times i.
//  4. enforce_placement_rules: for each part, calls the worldgen target's placement check and
//     its placement-filter check. BOTH are literally "return true" on the volume write
//     target, and the only other exit (the block type's state write coming back empty) cannot
//     fire for a part index inside the state's own registered value count, so the loop and
//     its failure message ("Block could not be placed given the enforced placement rules")
//     are worldgen NO-OPS: parsed, stored, never rejects. Same conclusion as single_block's
//     enforce keys, and unchanged in the later game version.
//  5. Replace check, per part in order: existing := the block read at pos_i. If existing's
//     type carries the multi-block state — i.e. the cell already belongs to ANY multi-block —
//     OR the allow-list check against may_replace fails: logFailure "Target location does not
//     contain a block from the replace list", return nothing. Note the overlap rule uses the
//     SAME message as the replace-list rule, and it fires even when may_replace would have
//     allowed the block.
//  6. Write loop, per part in order: partBlock := the block's permutation with the part state
//     written to i — the same permutation as places_block (including a step-2 rotation) with
//     only the part index changed; then a block write at pos_i with flag 3. The volume write
//     target's block write is a plain bounds-checked volume write returning whether the
//     position was in bounds — NO component on-place hook, and none of the delayed-placement
//     queue (that queue is the live-world gameplay path, reached from the component's
//     on-place hook, never from this feature). On a failed write the engine rolls BACK every
//     already-written part (writing the block-type registry's index-0 block in its default
//     state — taken to be air, which is what index 0 is; this port writes its own air id 0,
//     same invariant) and fails with "Block could not be placed".
//  7. Success returns origin (the START part's position; parts extend from it along dir).
//
// RNG contract: exactly one raw unsigned draw of bound 4 iff randomize_rotation survived parse,
// zero draws otherwise — on success AND on every failure path except invalid-places_block
// (step 1 fails before the draw).
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const multiBlockTypeID = "minecraft:multi_block_feature"

// multiBlockCardinalSeed is the placeholder minecraft:cardinal_direction value this builder
// writes onto the places_block permutation before rotating it, in the one case where the
// block's placement_direction trait enables the state but the JSON descriptor wrote no value
// for it. It exists only to make block.TransformBlock's per-entry "does this block carry the
// state" gate agree with the engine's type-level non-legacy-state query; every one of
// the four rotation rows then overwrites it, so it never reaches a placement. The value is
// the cardinal-direction enum's zero, "south" (the direction-name table's entry 0) — the
// state's own default rather than an invented token. The draw-to-token table is NOT duplicated here:
// it lives once, in block/rotate.go's transformBlockArms, and this file's tests pin
// the observable (draw 0 north, 1 east, 2 south, 3 west) against it.
var multiBlockCardinalSeed block.StateValue = "south"

// MultiBlockFeature is minecraft:multi_block_feature — places a pack-defined multi-block
// (a custom block carrying the minecraft:multi_block trait) as its full straight line of
// parts, starting from the trait's start part at the origin. A leaf type: no delegation.
type MultiBlockFeature struct {
	identifier string

	// valid is false when places_block did not resolve to the START part of an enabled
	// multi-block — the engine's Air-fallback state, in which every placement fails with
	// "Invalid 'places_block'" (see this file's header, places_block parse step 4).
	valid      bool
	placesName string
	partCount  int
	dirOffset  wgen.BlockPos
	// partIDs[r][i] is the interned block for part i under rotation row r. Row layout:
	// when randomizeRotation is false there is exactly ONE row (index 0, no cardinal
	// rewrite); when true there are FOUR rows indexed by the raw unsigned draw of 4, each
	// carrying minecraft:cardinal_direction = multiBlockRotationCardinal[r]. Pre-interned at
	// build time — the permutations are a property of the block type, not of world state.
	partIDs [][]block.ID

	mayReplace        block.MatchSet
	enforcePlacement  bool // parsed, stored, never rejects in worldgen (header step 4)
	randomizeRotation bool // post-downgrade value (header, randomize_rotation parse)

	pal *block.Palette
}

func (f *MultiBlockFeature) TypeID() string     { return multiBlockTypeID }
func (f *MultiBlockFeature) Identifier() string { return f.identifier }

// isMultiBlockCell mirrors the placement routine's per-cell overlap test on the built-in
// multi-block state: does the existing block's TYPE carry the multi_block_part state, i.e. is
// it any enabled multi-block's part (start or not). Name-keyed, this codebase's established
// block-type-identity stand-in.
func (f *MultiBlockFeature) isMultiBlockCell(existing block.ID) bool {
	_, _, ok := f.pal.MultiBlockTrait(f.pal.NameOf(existing))
	return ok
}

// Place mirrors the multi-block feature's placement step by step — see this file's
// header for the full algorithm.
func (f *MultiBlockFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, multiBlockTypeID)
	defer profiler.PopFeatureFrame()

	api, origin, rnd := ctx.API, ctx.Origin, ctx.Random

	// Step 1: the Air-fallback / not-a-multi-block gate. ZERO RNG, zero writes.
	if !f.valid {
		LogFailure(ctx, multiBlockTypeID, "Invalid 'places_block'")
		return nil
	}

	// Step 2: *** RNG CALL — the raw unsigned draw of 4, only when randomize_rotation survived
	// parse; drawn BEFORE any placement check, so later failures still consume it. ***
	row := 0
	if f.randomizeRotation {
		row = int(rnd.NextUnsignedInt(4))
	}
	parts := f.partIDs[row]

	// Step 4 (enforce_placement_rules): worldgen no-op — the volume write target's placement
	// check and its placement-filter check both just return true (header step 4), so the
	// engine's per-part loop can never reject here. Parsed and stored only.

	// Step 5: replace check over every part cell, in part order.
	for i := 0; i < f.partCount; i++ {
		pos := wgen.BlockPos{
			X: origin.X + f.dirOffset.X*i,
			Y: origin.Y + f.dirOffset.Y*i,
			Z: origin.Z + f.dirOffset.Z*i,
		}
		existing := api.GetBlock(pos)
		if f.isMultiBlockCell(existing) || !(f.mayReplace.Empty() || f.mayReplace.Contains(existing)) {
			LogFailure(ctx, multiBlockTypeID, "Target location does not contain a block from the replace list")
			return nil
		}
	}

	// Step 6: write every part; roll back on a failed (out-of-bounds) write.
	for i := 0; i < f.partCount; i++ {
		pos := wgen.BlockPos{
			X: origin.X + f.dirOffset.X*i,
			Y: origin.Y + f.dirOffset.Y*i,
			Z: origin.Z + f.dirOffset.Z*i,
		}
		if !api.SetBlock(pos, parts[i]) {
			for j := i - 1; j >= 0; j-- {
				undo := wgen.BlockPos{
					X: origin.X + f.dirOffset.X*j,
					Y: origin.Y + f.dirOffset.Y*j,
					Z: origin.Z + f.dirOffset.Z*j,
				}
				api.SetBlock(undo, block.AirID)
			}
			LogFailure(ctx, multiBlockTypeID, "Block could not be placed")
			return nil
		}
	}

	// Step 7: success — the start part's position.
	result := origin
	return &result
}

func buildMultiBlockFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	placesRaw, ok := body["places_block"]
	if !ok {
		// The one schema-REQUIRED key — a missing key is a schema error, so it IS a build
		// error here, unlike the content-log diagnostics below.
		return nil, fmt.Errorf("places_block is required")
	}
	desc, err := AsBlockDescriptor(placesRaw, "places_block")
	if err != nil {
		return nil, err
	}

	optBool := func(key string) (bool, error) {
		raw, present := body[key]
		if !present {
			return false, nil // zeroed default (header, Defaults)
		}
		b, ok := raw.(bool)
		if !ok {
			return false, fmt.Errorf("%s must be a boolean", key)
		}
		return b, nil
	}
	enforcePlacement, err := optBool("enforce_placement_rules")
	if err != nil {
		return nil, err
	}
	randomizeRotation, err := optBool("randomize_rotation")
	if err != nil {
		return nil, err
	}

	mayReplaceList, err := AsBlockDescriptorList(body["may_replace"], "may_replace")
	if err != nil {
		return nil, err
	}

	f := &MultiBlockFeature{
		identifier:        ctx.Identifier,
		mayReplace:        ResolveMatchSet(mayReplaceList, ctx, "may_replace"),
		enforcePlacement:  enforcePlacement,
		randomizeRotation: randomizeRotation,
		pal:               ctx.Palette,
	}

	// places_block validation, mirroring the engine's own parse (header): each failure is the
	// engine's own content-log line (the file still loads there, so a WARNING here, and the
	// feature is left in its always-failing Air-fallback state rather than rejected).
	resolvedID := ctx.Palette.Resolve(desc)
	entry := ctx.Palette.Entry(resolvedID)
	f.placesName = entry.Name

	parts, direction, isMulti := ctx.Palette.MultiBlockTrait(entry.Name)
	if !isMulti {
		// Folds the engine's "Block '%s' is invalid." case (a name that resolves to no block
		// at all) into this one: this palette interns any name, so the observable outcome —
		// an always-failing feature — is the same either way, and the engine's own message
		// for the common case (a real block without the trait) is the one echoed.
		ctx.Warn(fmt.Sprintf(
			"%s: places_block %q is not a multi-block -- the engine logs \"Must place a multi-block in a "+
				"'minecraft:multi_block_feature'\" (the block needs the minecraft:multi_block trait in the pack's "+
				"blocks/**/*.json) and every placement of this feature will fail with \"Invalid 'places_block'\"",
			ctx.Identifier, entry.Name))
		return f, nil
	}
	if pv, present := entry.States[block.MultiBlockPartState]; present {
		if pf, isNum := pv.(float64); !isNum || pf != 0 {
			ctx.Warn(fmt.Sprintf(
				"%s: If trying to place a multi-block in a 'minecraft:multi_block_feature' only the starting part "+
					"may be used in field 'places_block' (got %s=%v); every placement of this feature will fail with "+
					"\"Invalid 'places_block'\"",
				ctx.Identifier, block.MultiBlockPartState, pv))
			return f, nil
		}
	}

	// randomize_rotation downgrade, mirroring the engine's own parse (header): true on a block
	// without the cardinal_direction state warns and stores FALSE.
	if f.randomizeRotation && !ctx.Palette.HasCardinalDirectionState(entry.Name) {
		ctx.Warn(fmt.Sprintf(
			"%s: Block '%s' does not have a cardinal direction state and cannot be randomly rotated. "+
				"(randomize_rotation is ignored; give the block the minecraft:placement_direction trait with "+
				"\"minecraft:cardinal_direction\" in enabled_states)",
			ctx.Identifier, entry.Name))
		f.randomizeRotation = false
	}

	f.valid = true
	f.partCount = parts
	off := block.FacingOffset[direction]
	f.dirOffset = wgen.BlockPos{X: off[0], Y: off[1], Z: off[2]}

	// Pre-intern every part permutation. Two engine steps compose here, in the engine's own
	// order: step 2's block rotation on the whole block, then step 6's per-part write of the
	// part state onto that (possibly rotated) permutation.
	//
	// The transform is block/rotate.go — ALL SIXTEEN arms, not just the cardinal one. That
	// matters here even though randomize_rotation's parse-time gate is specifically the
	// cardinal-direction state: the gate only decides whether the flag survives, and once
	// it has, the rotation still fires every arm whose state the block carries. A custom
	// multi-block whose places_block descriptor also writes pillar_axis or facing_direction
	// gets those rewritten too, cumulatively, each an absolute SET keyed only on the draw.
	rows := 1
	if f.randomizeRotation {
		rows = 4
	}

	// The block the transform is applied to. TransformBlock's stand-in for the engine's
	// type-level non-legacy-state query is "the interned entry carries a value for this key"
	// (block/rotate.go's doc comment states that limitation), and a places_block written as a
	// bare name interns with no states at all — so the cardinal arm would not fire even
	// though the TYPE carries the state. Here, unlike the general case, the type-level answer
	// IS available: HasCardinalDirectionState reads the block's own placement_direction
	// trait, and it already gated the downgrade above. So seed the key when the trait enables
	// it and the descriptor left it unwritten. The seeded value never reaches a placement:
	// rows are four only when randomize_rotation is live, and every one of the four then
	// overwrites this key (each arm is an absolute SET). It is the cardinal-direction enum's
	// zero value, "south" (the direction-name table's entry 0, derived in block/rotate.go), so
	// that even as a transient it is the state's own default rather than an invented token.
	base := resolvedID
	if f.randomizeRotation {
		if _, present := entry.States[block.CardinalDirectionState]; !present {
			seeded := make(map[string]block.StateValue, len(entry.States)+1)
			for k, v := range entry.States {
				seeded[k] = v
			}
			seeded[block.CardinalDirectionState] = multiBlockCardinalSeed
			base = ctx.Palette.Get(entry.Name, seeded)
		}
	}

	f.partIDs = make([][]block.ID, rows)
	for r := 0; r < rows; r++ {
		rotated := base
		if f.randomizeRotation {
			rotated = ctx.Palette.TransformBlock(base, block.CommonDirection(r))
		}
		rotatedStates := ctx.Palette.Entry(rotated).States
		f.partIDs[r] = make([]block.ID, parts)
		for i := 0; i < parts; i++ {
			// minecraft:multi_block_part is written LAST and is not one of the sixteen
			// transform arms, so the part index this port sets itself survives the rotation.
			states := make(map[string]block.StateValue, len(rotatedStates)+1)
			for k, v := range rotatedStates {
				states[k] = v
			}
			states[block.MultiBlockPartState] = float64(i)
			f.partIDs[r][i] = ctx.Palette.Get(entry.Name, states)
		}
	}

	// Unconfirmed-spelling warning, the same one features/single_block.go emits for
	// the same reason (block/rotate.go's "Integer -> JSON token" section): every integer the
	// transform writes matches the game, but for ten of the sixteen families the step
	// from that integer to the token a pack writes is taken from vanilla state
	// definitions rather than from the game's own table. minecraft:cardinal_direction — the
	// one family this feature is guaranteed to rotate — is established and never trips this;
	// it fires only for an extra directional state the pack's own descriptor wrote.
	if f.randomizeRotation {
		for _, state := range block.InferredTransformStates(ctx.Palette.NameOf(base), ctx.Palette.StatesOf(base)) {
			ctx.Warn(fmt.Sprintf(
				"%s: places_block carries directional state %q, which rotation (randomize_rotation) rewrites. The rotation is applied, and the value it selects matches the game, but the name that value is written under is inferred from vanilla block-state definitions and not confirmed against the game -- so the rotated block is right in direction and may be wrong in spelling",
				ctx.Identifier, state))
		}
	}

	return f, nil
}

func init() {
	RegisterType(multiBlockTypeID, buildMultiBlockFeature)
}

var _ wgen.IFeature = (*MultiBlockFeature)(nil)
