// snap_to_surface.go is a port of minecraft:snap_to_surface_feature, targeting
// game version 1.26.50. Differences from 1.26.40 are noted where they matter.
//
// The 1.26.40 shape (a single snap search that ran an up-walk AND a down-walk
// and then selected one) is GONE. The 1.26.50 search is direction-generic:
// placement resolves the surface mode to a facing (0=down, 1=up, 2..5
// horizontal) and the search walks that one direction. The column scan
// changed with it -- it used to take a position, a range and two predicates
// and walk both ways; it now takes a facing too and walks once.
//
// surface enum: "ceiling"->0, "floor"->1, "wall"->2 (NEW), "random_horizontal"
// ->3 (was 2 in 1.26.40). An unrecognized value does NOT abort the parse: the
// game content-logs "Bad value for surface - should be 'ceiling', 'floor',
// 'random_horizontal', or `wall`" and leaves the default in place.
//
// The absent-key default is FLOOR, not ceiling -- in BOTH versions: the search
// range defaults to 0 and the surface mode to 1, i.e. floor. This port
// defaulted an absent `surface` to ceiling until 2026-08-15, which was wrong.
//
// Fields and their defaults:
//
//	int   search_range / vertical_search_range, default 0
//	int   surface mode, default 1 (floor)
//	list  allowed_surface_blocks, default empty
//	bool  allow_air_placement,        default TRUE
//	bool  allow_non_air_placement,    default false  [NEW in 1.26.50]
//	bool  allow_underwater_placement, default false
//	bool  embed_in_surface,           default false
//
// The vertical_search_range -> search_range RENAME: the schema accepts EXACTLY
// ONE of the two key names, chosen by the pack's format_version. Below 1.26.50
// "vertical_search_range" is REQUIRED; at or above it "search_range" is
// REQUIRED. Both set the same value. There is NO version at which both names
// are accepted: the other name gets the generic "this member was found in the
// input, but is not present in the Schema" diagnostic and its value is
// dropped. This port models the gate against ctx.FormatVersion via
// FormatVersion.AtLeastOrUnversioned: a DECLARED version is honoured exactly,
// matching the game's `declared < min` comparison, and an ABSENT one is read
// as unversioned -- such a file is judged on whichever spelling it actually
// wrote rather than being forced onto the pre-rename name -- see
// buildSnapToSurfaceFeature.
//
// The directional search: let startOpen = isAir(origin) || isWater(origin)
// (water only -- never lava). It is checked in placement and again inside the
// directed search.
//
//	passable(p) = startOpen ? (allowAir && isAir(p)) || (allowUnderwater && isWater(p))
//	                        : allowNonAir && !isAir(p) && !isWater(p)
//	confirm(p)  = allowed_surface_blocks non-empty ? p in allowed
//	            : startOpen ? the block's support test on p, asked about the
//	                          opposite face of dir with the any-support-type
//	                          argument
//	                        : (allowAir && isAir(p)) || (allowUnderwater && isWater(p))
//
// The column scan, given (pos, range, facing, passable, confirm):
// fail unless passable(pos); cur = pos+facing; steps = 0; while steps <
// range-1 && passable(cur) { steps++; cur += facing } (skipped entirely when
// range < 2); confirmed = confirm(cur). NOTE the walk starts at pos+1 and
// can hand confirm() the cell at distance range (untested for passability)
// -- the 1.26.40 column scan wasted its first test re-testing the origin,
// so its reach was range-1 and a range<2 scan confirmed the ORIGIN itself.
// Both are real behavioural deltas between the versions, not port choices.
//
// The snapped position:
//
//	pos stepped along facing by (steps + (embed ^ (startOpen ? 0 : 1)))
//
// startOpen, embed=false -> the last open cell (adjacent to the surface);
// embed=true -> the surface block itself. Buried start (allow_non_air),
// embed=false -> the first open cell PAST the solid run; embed=true -> the
// last solid cell. This generalizes 1.26.40's own single-flag formula.
//
// Direction resolution in placement: mode 3 (random_horizontal) first takes
// the game's boolean draw and replaces the mode with `1 & ~draw`: false/even
// -> 1 = floor, true/odd -> 0 = ceiling (unchanged from 1.26.40). Then mode 2
// (wall) dispatches to the wall snap search; otherwise facing = startOpen ?
// (ceiling ? up : down) : (ceiling ? down : up) -- the direction INVERTS for a
// buried start, because walking out of the solid reaches the same surface
// from the other side.
//
// The wall snap search: candidate directions start as [NORTH(2), EAST(5),
// SOUTH(3), WEST(4)], then an ascending Fisher-Yates shuffle takes the game's
// bounded integer draw (this port's NextIntBound) with bounds 2, 3, 4 IN THAT
// ORDER, swapping arr[i] with arr[draw(i+1)] for i = 1, 2, 3. All three draws
// happen unconditionally, BEFORE any searching. The four directions are then
// tried in shuffled order via the directed snap search; the first success
// wins.
//
// Unchanged from 1.26.40: allow_air_placement defaults TRUE;
// allow_underwater_placement defaults FALSE and means WATER only, never lava;
// embed_in_surface defaults false; feature_to_snap is required; surface /
// allow_* / allowed_surface_blocks / embed_in_surface are all optional in the
// schema; the no-allowed-list confirm is the block's support test, which this
// port MODELS per-face as of 2026-08-21 (block/support.go; it approximated it
// as IsSolid before that); and the failure/recursion-guard messages at the end
// of placement ("Could not find a surface snap position" / "Referenced feature
// could not be resolved" / "Cannot place internal feature").
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/profiler"
	"github.com/stirante/featurelab/wgen"
)

const snapToSurfaceTypeID = "minecraft:snap_to_surface_feature"

// snapSearchRangeRenameVersion is 1.26.50, the format_version at which
// vertical_search_range became search_range (see this file's header).
var snapSearchRangeRenameVersion = MustFormatVersion("1.26.50")

type snapMode int

// The game's surface enum, as of game version 1.26.50.
const (
	snapCeiling          snapMode = 0
	snapFloor            snapMode = 1 // the absent-key default
	snapWall             snapMode = 2 // new in 1.26.50
	snapRandomHorizontal snapMode = 3 // was 2 in 1.26.40
)

// snapFacing is the game's facing enum: 0 down, 1 up, 2 north (-z),
// 3 south (+z), 4 west (-x), 5 east (+x).
type snapFacing uint8

const (
	facingDown  snapFacing = 0
	facingUp    snapFacing = 1
	facingNorth snapFacing = 2
	facingSouth snapFacing = 3
	facingWest  snapFacing = 4
	facingEast  snapFacing = 5
)

// snapFacingDelta mirrors the game's one-step neighbour offset for each
// facing.
var snapFacingDelta = [6]wgen.BlockPos{
	{X: 0, Y: -1, Z: 0}, // down
	{X: 0, Y: 1, Z: 0},  // up
	{X: 0, Y: 0, Z: -1}, // north
	{X: 0, Y: 0, Z: 1},  // south
	{X: -1, Y: 0, Z: 0}, // west
	{X: 1, Y: 0, Z: 0},  // east
}

func snapStep(pos wgen.BlockPos, facing snapFacing, dist int) wgen.BlockPos {
	d := snapFacingDelta[facing]
	return wgen.BlockPos{X: pos.X + d.X*dist, Y: pos.Y + d.Y*dist, Z: pos.Z + d.Z*dist}
}

// parseSnapSurfaceMode mirrors the game's surface parse. An
// unrecognized value is NOT a load error in the game: it content-logs and
// leaves the default (floor) in place, so this returns
// (snapFloor, warning) rather than an error.
func parseSnapSurfaceMode(value any) (snapMode, string) {
	switch value {
	case nil:
		return snapFloor, "" // the default, floor, in both versions
	case "ceiling":
		return snapCeiling, ""
	case "floor":
		return snapFloor, ""
	case "wall":
		return snapWall, ""
	case "random_horizontal":
		return snapRandomHorizontal, ""
	}
	// The game's own message, verbatim (including its mixed quoting).
	return snapFloor, fmt.Sprintf(
		"Bad value for surface - should be 'ceiling', 'floor', 'random_horizontal', or `wall` (got %#v); using the default (floor)", value)
}

// SnapToSurfaceFeature is minecraft:snap_to_surface_feature.
type SnapToSurfaceFeature struct {
	identifier               string
	featureToSnap            string
	searchRange              int // search_range (>=1.26.50) / vertical_search_range (older packs)
	mode                     snapMode
	allowedIDs               block.MatchSet
	allowAirPlacement        bool
	allowNonAirPlacement     bool
	allowUnderwaterPlacement bool
	embedInSurface           bool
	resolver                 wgen.IFeatureResolver
}

func (f *SnapToSurfaceFeature) TypeID() string     { return snapToSurfaceTypeID }
func (f *SnapToSurfaceFeature) Identifier() string { return f.identifier }

// FeatureRefs exposes the single delegated feature reference for the static
// delegation-chain walk.
func (f *SnapToSurfaceFeature) FeatureRefs() []string { return []string{f.featureToSnap} }

// startOpen is the start-cell classification placement and the directed snap
// search both make: air, or WATER specifically (lava is not "open", it is a
// solid start).
func (f *SnapToSurfaceFeature) startOpen(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	id := api.GetBlock(pos)
	pal := api.Palette()
	return pal.IsAir(id) || isWaterBlock(pal, id)
}

// passableOpen is the game's walk-through predicate for a scan that
// STARTED in air/water.
func (f *SnapToSurfaceFeature) passableOpen(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	id := api.GetBlock(pos)
	pal := api.Palette()
	if f.allowAirPlacement && pal.IsAir(id) {
		return true
	}
	if !f.allowUnderwaterPlacement {
		return false
	}
	return isWaterBlock(pal, id)
}

// passableSolid is the game's walk-through predicate for a scan that
// started INSIDE a non-air, non-water block -- gated on
// allow_non_air_placement, it keeps walking while still inside the solid.
func (f *SnapToSurfaceFeature) passableSolid(api wgen.BlockWorld, pos wgen.BlockPos) bool {
	if !f.allowNonAirPlacement {
		return false
	}
	id := api.GetBlock(pos)
	pal := api.Palette()
	return !pal.IsAir(id) && !isWaterBlock(pal, id)
}

// confirms is the surface-acceptance test the column scan runs on the cell
// the walk stopped at. With allowed_surface_blocks non-empty it is allow-list
// membership regardless of the start cell; with an empty list it is the
// block's support test, asked about the opposite face of dir with the
// any-support-type argument, for an open start, or the open-cell test for a
// buried start (the exit cell must be air/water the config allows).
//
// The face is the one the WALK arrives from -- the opposite of facing -- so a
// floor scan walking down asks the floor block about its UP face. That
// mapping is ported as block.OppositeFace.
//
// Until 2026-08-21 the empty-list open-start branch was Palette.IsSolid, an
// explicitly-flagged approximation; it is now block.CanProvideSupport, which
// models the game's own per-face answer (see block/support.go for the
// dispatch and every family rule). Only this branch changed: a non-empty
// allowed_surface_blocks is still a pure match-set test.
func (f *SnapToSurfaceFeature) confirms(api wgen.BlockWorld, pos wgen.BlockPos, facing snapFacing, startOpen bool) bool {
	if !f.allowedIDs.Empty() {
		return f.allowedIDs.Contains(api.GetBlock(pos))
	}
	if startOpen {
		pal := api.Palette()
		id := api.GetBlock(pos)
		return block.CanProvideSupport(pal.NameOf(id), pal.StatesOf(id), block.OppositeFace[facing])
	}
	return f.passableOpen(api, pos)
}

// findSnapPosInDirection mirrors the feature's directed snap search plus the
// game's directional column scan:
// walk `facing` from the cell after pos while passable, up to search_range-1
// steps (none at all when the range is < 2), then confirm the cell the walk
// stopped at -- which can be the cell at distance search_range with its own
// passability never tested. On success the snapped position is
//
//	pos + facing * (steps + (embed ^ (startOpen ? 0 : 1)))
//
// -- for an open start: the last open cell, or the surface block itself with
// embed_in_surface; for a buried start (allow_non_air_placement): the first
// open cell past the solid run, or the last solid cell with embed.
func (f *SnapToSurfaceFeature) findSnapPosInDirection(api wgen.BlockWorld, pos wgen.BlockPos, facing snapFacing) *wgen.BlockPos {
	startOpen := f.startOpen(api, pos)
	passable := f.passableOpen
	if !startOpen {
		passable = f.passableSolid
	}

	// The column scan's first check runs the passable predicate on the origin
	// itself -- this is where a buried start without allow_non_air_placement
	// (or an open start without allow_air_placement) fails.
	if !passable(api, pos) {
		return nil
	}

	cur := snapStep(pos, facing, 1)
	steps := 0
	for steps < f.searchRange-1 {
		TickDeadline("walking a column as far as its search_range asks")
		if !passable(api, cur) {
			break
		}
		steps++
		cur = snapStep(cur, facing, 1)
	}
	if !f.confirms(api, cur, facing, startOpen) {
		return nil
	}

	adjust := 0
	if f.embedInSurface {
		adjust = 1
	}
	if !startOpen {
		adjust ^= 1
	}
	snapped := snapStep(pos, facing, steps+adjust)
	return &snapped
}

// findWallSnapPos mirrors the feature's wall snap search: shuffle
// [north, east, south, west] with an ascending
// Fisher-Yates (three bounded draws, ALWAYS, before any searching), then try
// each direction in shuffled order and return the first success.
func (f *SnapToSurfaceFeature) findWallSnapPos(ctx *wgen.PlacementContext) *wgen.BlockPos {
	// Initial order, as in the game: [NORTH(2), EAST(5), SOUTH(3), WEST(4)].
	dirs := [4]snapFacing{facingNorth, facingEast, facingSouth, facingWest}
	// *** RNG CALLS *** -- three bounded integer draws (NextIntBound), with
	// bounds 2, 3, 4 in that order,
	// unconditionally.
	for i := 1; i <= 3; i++ {
		r := ctx.Random.NextIntBound(i + 1)
		if r != i {
			dirs[i], dirs[r] = dirs[r], dirs[i]
		}
	}
	for _, d := range dirs {
		if p := f.findSnapPosInDirection(ctx.API, ctx.Origin, d); p != nil {
			return p
		}
	}
	return nil
}

// snapDirectionWord is where the no_surface stop looked: "above", "below" or "on any side".
func snapDirectionWord(mode snapMode) string {
	switch mode {
	case snapFloor:
		return "below"
	case snapWall:
		return "on any side"
	}
	return "above"
}

// Place mirrors the snap-to-surface feature's placement.
func (f *SnapToSurfaceFeature) Place(ctx *wgen.PlacementContext) *wgen.BlockPos {
	profiler.PushFeatureFrame(f.identifier, snapToSurfaceTypeID)
	defer profiler.PopFeatureFrame()

	mode := f.mode
	if mode == snapRandomHorizontal {
		// *** RNG CALL *** -- the game's boolean draw, taken only for
		// random_horizontal: placement replaces the mode with
		// `1 & ~draw`, so a false/even draw selects 1 = FLOOR and a true/odd
		// one 0 = CEILING. Unchanged from 1.26.40 (only the enum value that
		// triggers it moved, 2 -> 3).
		if !ctx.Random.NextBoolean() {
			mode = snapFloor
		} else {
			mode = snapCeiling
		}
	}

	var snapped *wgen.BlockPos
	if mode == snapWall {
		snapped = f.findWallSnapPos(ctx)
	} else {
		// Direction resolution: up for a ceiling, down for a floor -- INVERTED
		// when the origin cell is neither air nor water, because snapping out
		// of a solid reaches the requested surface from its other side. The
		// game's rule is startOpen ? mode==ceiling : mode!=ceiling.
		facing := facingDown
		if (mode == snapCeiling) == f.startOpen(ctx.API, ctx.Origin) {
			facing = facingUp
		}
		snapped = f.findSnapPosInDirection(ctx.API, ctx.Origin, facing)
	}

	if snapped == nil {
		// The game logs a bare "Could not find a surface snap position";
		// this port says which way it looked and what it started in, because
		// the common cause is a bench filled with solid stone (no open/solid
		// boundary to snap to) and that reads as a tool failure without the
		// starting block named.
		dirName := "up (to a ceiling)"
		switch mode {
		case snapFloor:
			dirName = "down (to a floor)"
		case snapWall:
			dirName = "horizontally (to a wall, all four directions)"
		}
		LogFailure(ctx, snapToSurfaceTypeID,
			fmt.Sprintf("no surface found searching %s from a position holding %s "+
				"(search_range %d) -- a fully solid or fully empty column has no "+
				"surface to snap to", dirName, describeBlockAt(ctx.API, ctx.Origin), f.searchRange))
		if profiler.ProfilingActive && !profiler.StopCounted(profiler.StopNoSurface, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopNoSurface,
				fmt.Sprintf("no surface %s within %d", snapDirectionWord(mode), f.searchRange), profiler.NoOrdinal)
		}
		return nil
	}

	sub := f.resolver.Resolve(f.featureToSnap)
	if sub == nil {
		LogFailure(ctx, snapToSurfaceTypeID, "Referenced feature could not be resolved")
		if profiler.ProfilingActive && !profiler.StopCounted(profiler.StopUnresolvedReference, profiler.NoOrdinal) {
			profiler.RecordStop(profiler.StopUnresolvedReference, f.featureToSnap+" not found", profiler.NoOrdinal)
		}
		return nil
	}
	if !IsAllowedToPlaceFeature(f) {
		LogFailure(ctx, snapToSurfaceTypeID, "Cannot place internal feature")
		if profiler.ProfilingActive {
			profiler.RecordStop(profiler.StopRecursionGuard, "already placing", profiler.NoOrdinal)
		}
		return nil
	}

	// Recursion guard marks/checks `f` (the wrapper), not `sub` -- see
	// shared.go. MolangScope is forwarded unchanged (childScope is an
	// identity function).
	subCtx := ctx.WithOrigin(*snapped)
	return WithRecursionGuard(f, func() *wgen.BlockPos { return sub.Place(subCtx) })
}

func buildSnapToSurfaceFeature(body map[string]any, ctx *BuildContext) (wgen.IFeature, error) {
	featureToSnap, ok := body["feature_to_snap"].(string)
	if !ok || featureToSnap == "" {
		return nil, fmt.Errorf("feature_to_snap must be a non-empty feature reference string")
	}

	// search_range / vertical_search_range: the game accepts exactly ONE
	// of the two names, picked by the file's declared format_version against
	// 1.26.50: files below it must say vertical_search_range, files at or
	// above it must say search_range, and the accepted name is REQUIRED either
	// way. The other name is not in the schema at all -- the game drops its value with a
	// member-not-in-schema diagnostic. Modeled here 1:1 against
	// ctx.FormatVersion.AtLeastOrUnversioned, so an absent version is read as
	// unversioned: an undeclared file starts on the post-rename name and then
	// falls back to whichever spelling it actually wrote -- see just below.
	activeKey, droppedKey := "vertical_search_range", "search_range"
	if ctx.FormatVersion.AtLeastOrUnversioned(snapSearchRangeRenameVersion) {
		activeKey, droppedKey = "search_range", "vertical_search_range"
	}
	// An unversioned file is judged on what it wrote rather than on a band it never picked
	// (see FormatVersion.AtLeastOrUnversioned). For a RENAME that means taking whichever
	// spelling is actually present -- warning that "search_range is not in the schema" and
	// then that "vertical_search_range is missing" would be two complaints about a file whose
	// only real problem is the absent format_version the loader has already reported.
	if !ctx.FormatVersion.Present {
		if _, hasNew := body[activeKey]; !hasNew {
			if _, hasOld := body[droppedKey]; hasOld {
				activeKey, droppedKey = droppedKey, activeKey
			}
		}
	}
	if _, ok := body[droppedKey]; ok {
		ctx.Warn(fmt.Sprintf("%s: %q was found in the input, but is not present in the schema for "+
			"format_version %s -- snap_to_surface_feature renamed \"vertical_search_range\" to "+
			"\"search_range\" at format_version 1.26.50, so this file must say %q; the engine drops "+
			"the value, and so does this tool", ctx.Identifier, droppedKey, ctx.FormatVersion, activeKey))
	}
	// The default is 0; any value below 2 walks no cells and confirms the
	// immediate neighbour, so 0 reproduces the game's default.
	searchRange := 0.0
	if rawRange, ok := body[activeKey]; ok {
		f, ok := toFloat(rawRange)
		if !ok {
			return nil, fmt.Errorf("%s must be a number", activeKey)
		}
		searchRange = f
	} else {
		// REQUIRED by the game's schema under whichever name the gate
		// picked -- see this file's header. Warn rather than reject: 0
		// reproduces the game's default behaviour (no walk, the adjacent cell is still checked), so the
		// file still loads here.
		ctx.Warn(fmt.Sprintf("%s: %q is required by the engine's schema (for format_version %s) but is "+
			"missing -- the real game would reject this file; defaulting to 0 (no column walk; only the "+
			"adjacent cell is checked)", ctx.Identifier, activeKey, ctx.FormatVersion))
	}

	mode, warn := parseSnapSurfaceMode(body["surface"])
	if warn != "" {
		// Mirrors the game: an unrecognized surface value content-logs and
		// keeps the default; it does not fail the file.
		ctx.Warn(fmt.Sprintf("%s: %s", ctx.Identifier, warn))
	}
	descs, err := AsBlockDescriptorList(body["allowed_surface_blocks"], "allowed_surface_blocks")
	if err != nil {
		return nil, err
	}
	// A {"tags": ...} entry here matches NOTHING in the real game, and it is worth saying so
	// loudly because the failure has the worst possible shape: the preview works and the feature
	// places nothing in the world.
	//
	// The game resolves each descriptor to a single block, and refuses a tag-form descriptor
	// outright -- it content-logs "It's not valid to get a block reference that is described by
	// tags" -- and then substitutes minecraft:unknown's default state, which equals no real
	// world block. So every candidate surface fails the confirm test and the snap never succeeds.
	//
	// This bench evaluates the tag predicate for real, which is the right behaviour everywhere
	// else a block descriptor appears and the wrong one here. Rather than crippling the preview
	// (which would make the field useless for authoring while telling the author nothing), the
	// predicate keeps working and the divergence is disclosed at build time.
	for _, d := range descs {
		if d.IsTags && ctx.Warn != nil {
			ctx.Warn("allowed_surface_blocks contains a {\"tags\": ...} entry. The real game cannot " +
				"resolve a tag descriptor to a block here -- it logs \"It's not valid to get a block " +
				"reference that is described by tags\" and falls back to minecraft:unknown, which " +
				"matches no real block, so EVERY snap fails and this feature places nothing in the " +
				"world. This bench evaluates the tag predicate for real, so the preview will look " +
				"like it works. List the block names explicitly if you want this to run in game.")
			break
		}
	}
	// EXACT, and the only field in this package that is. Unlike every other
	// match list, allowed_surface_blocks resolves each descriptor to one concrete
	// block and compares the hash of its full serialization id -- the name AND
	// every state at its concrete value -- so a descriptor and a candidate that
	// disagree on any state do not match. See block.MatchMode.
	//
	// Known gap, and it is this port's, not the field's: resolving a BARE
	// descriptor to a concrete block means completing it to its type's DEFAULT
	// permutation, which needs a per-block-type default-state registry this bench
	// does not consult yet. Until it does, a bare entry here matches only a cell
	// interned bare -- so a structure-placed `oak_log#pillar_axis=y` fails a bare
	// `minecraft:oak_log` even though y is the default and the game would match it.
	allowedIDs := ResolveMatchSetMode(descs, ctx, "allowed_surface_blocks", block.MatchExact)
	// allow_air_placement defaults to true in the game -- an
	// absent key must NOT be treated as "false" the way jsonTruthy(nil) would;
	// only an explicit value overrides the default. allow_non_air_placement
	// and allow_underwater_placement both default false, which jsonTruthy(nil)
	// already matches.
	allowAir := true
	if v, ok := body["allow_air_placement"]; ok {
		allowAir = jsonTruthy(v)
	}
	allowNonAir := jsonTruthy(body["allow_non_air_placement"])
	allowUnderwater := jsonTruthy(body["allow_underwater_placement"])
	// embed_in_surface: optional, default false. When set, the
	// snapped position is the surface-side cell instead of the open-side one.
	embedInSurface := jsonTruthy(body["embed_in_surface"])

	return &SnapToSurfaceFeature{
		identifier:               ctx.Identifier,
		featureToSnap:            featureToSnap,
		searchRange:              int(searchRange),
		mode:                     mode,
		allowedIDs:               allowedIDs,
		allowAirPlacement:        allowAir,
		allowNonAirPlacement:     allowNonAir,
		allowUnderwaterPlacement: allowUnderwater,
		embedInSurface:           embedInSurface,
		resolver:                 ctx.Resolver,
	}, nil
}

func init() {
	RegisterType(snapToSurfaceTypeID, buildSnapToSurfaceFeature)
}

var _ wgen.IFeature = (*SnapToSurfaceFeature)(nil)
