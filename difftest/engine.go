package difftest

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/random"
	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/volume"
	"github.com/stirante/featurelab/wgen"
)

// Results is one side's measurements: per test, one Metrics per placement. The engine side and
// the game side write the same shape, and the comparator reads two of them.
type Results struct {
	Side  string                 `json:"side"`
	Meta  map[string]any         `json:"meta"`
	Tests map[string]*TestResult `json:"tests"`
}

// TestResult is one test's placements.
type TestResult struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	Group      string    `json:"group"`
	FeatureID  string    `json:"featureId"`
	GameCaveat string    `json:"gameCaveat,omitempty"`
	Placements []Metrics `json:"placements"`
	// Notes are side-specific remarks: engine diagnostics, writes that left the dump region,
	// or a game cell whose setup did not verify.
	Notes []string `json:"notes,omitempty"`
	// SetupMismatches counts game placements whose before-dump did not match the expected
	// reset+setup (unloaded chunk, failed /fill); those placements are dropped.
	SetupMismatches int     `json:"setupMismatches,omitempty"`
	DurationMs      float64 `json:"durationMs"`
}

// EngineOptions configures RunEngine.
type EngineOptions struct {
	PackDir string
	// ExtraStructures is an optional directory of vanilla structures (the fossil_feature
	// templates live in structures/fossils/ of a vanilla behaviour pack).
	ExtraStructures string
	SeedBase        uint32
	Repeats         int // 0 = each test's own
	Log             func(format string, args ...any)
	// Dump, when set, receives every placement's before and after regions in the game runner's
	// JSONL line shape, so one tool can look at placements from either side.
	Dump func(GameDumpLine)
}

// engineVolumeMargin is how much wider than the reset box the engine's bench volume is, so
// features that read past the dumped region see superflat ground the way the game does.
const engineVolumeMargin = 16

// RunEngine places every test's feature Repeats times, each on a freshly restored copy of the
// cell (superflat + setup), and measures each placement.
func RunEngine(m *Manifest, tests []*Test, opts EngineOptions) (*Results, error) {
	logf := opts.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	started := time.Now()
	loaded, err := pack.Load(pack.Options{Dir: opts.PackDir})
	if err != nil {
		return nil, err
	}
	structFiles := loaded.Structures
	if opts.ExtraStructures != "" {
		if _, err := os.Stat(opts.ExtraStructures); err == nil {
			extra, err := pack.Load(pack.Options{StructuresDir: opts.ExtraStructures})
			if err != nil {
				return nil, err
			}
			structFiles = append(structFiles, extra.Structures...)
		} else {
			logf("extra structures %s not found; fossil tests will not build", opts.ExtraStructures)
		}
	}
	palette := block.NewPalette()
	for _, d := range palette.LoadBlockTags(loaded.Blocks) {
		logf("blocks: %v", d)
	}
	structLib := structures.BuildLibrary(structFiles, palette)
	lib := features.BuildLibrary(loaded.Features, palette, structLib)
	buildNotes := map[string][]string{}
	for _, d := range lib.Diagnostics {
		msg := fmt.Sprintf("[%s] %s: %s", d.Level, d.FileID, d.Message)
		buildNotes[d.FileID] = append(buildNotes[d.FileID], msg)
		if d.Level == "error" {
			logf("%s", msg)
		}
	}
	for _, f := range lib.Failed {
		logf("failed to load %s", f.FileID)
	}
	libBuilt := time.Since(started)

	biome := &wgen.MolangBiome{ID: "plains", Tags: map[string]struct{}{
		"animal": {}, "monster": {}, "overworld": {}, "plains": {}, "bee_habitat": {},
	}}
	ids := map[string]block.ID{}
	get := func(name string) block.ID {
		if id, ok := ids[name]; ok {
			return id
		}
		id := palette.Get(name, nil)
		ids[name] = id
		return id
	}

	res := &Results{Side: "engine", Meta: map[string]any{}, Tests: map[string]*TestResult{}}
	for _, t := range tests {
		tStart := time.Now()
		tr := &TestResult{ID: t.ID, Type: t.Type, Group: t.Group, FeatureID: t.FeatureID, GameCaveat: t.GameCaveat}
		res.Tests[t.ID] = tr
		feature := lib.Resolve(t.FeatureID)
		if feature == nil {
			tr.Notes = append(tr.Notes, "feature did not resolve in the engine")
			logf("%s: %s did not resolve", t.ID, t.FeatureID)
			continue
		}
		for _, e := range lib.Entries {
			if e.Identifier == t.FeatureID {
				tr.Notes = append(tr.Notes, buildNotes[e.FileID]...)
			}
		}

		reset := t.ResetBoxRel().Offset(t.Anchor)
		bounds := volume.Bounds{
			MinX: reset.Min[0] - engineVolumeMargin, MinY: WorldFloorY, MinZ: reset.Min[2] - engineVolumeMargin,
			SizeX: reset.Size()[0] + 2*engineVolumeMargin,
			SizeY: minInt(reset.Max[1]+engineVolumeMargin, WorldTopY) - WorldFloorY + 1,
			SizeZ: reset.Size()[2] + 2*engineVolumeMargin,
		}
		vol := volume.New(bounds, palette, block.AirID)
		for z := bounds.MinZ; z < bounds.MinZ+bounds.SizeZ; z++ {
			for x := bounds.MinX; x < bounds.MinX+bounds.SizeX; x++ {
				for _, l := range superflatLayers {
					vol.SetBlockAt(x, l.Y, z, get(l.Block))
				}
			}
		}
		for _, op := range t.Setup {
			bx := op.Box.normalized().Offset(t.Anchor)
			id := get(op.Block)
			for y := bx.Min[1]; y <= bx.Max[1]; y++ {
				for z := bx.Min[2]; z <= bx.Max[2]; z++ {
					for x := bx.Min[0]; x <= bx.Max[0]; x++ {
						vol.SetBlockAt(x, y, z, id)
					}
				}
			}
		}
		vol.ResetOutOfBoundsAccounting()
		baseline := vol.Snapshot()
		dump := t.Region.Offset(t.Anchor)
		before := regionFromVolume(vol, dump)
		place := t.Game.PlaceAt
		origin := wgen.BlockPos{X: place[0], Y: place[1], Z: place[2]}

		repeats := t.Repeats
		if opts.Repeats > 0 {
			repeats = opts.Repeats
		}
		outside, oob, budget := 0, 0, 0
		for i := 0; i < repeats; i++ {
			vol.Restore(baseline)
			vol.ResetOutOfBoundsAccounting()
			if err := placeOnce(feature, vol, origin, biome, opts.SeedBase+uint32(i)*7919+1); err != "" {
				budget++
				if budget == 1 {
					tr.Notes = append(tr.Notes, "placement stopped: "+err)
				}
			}
			oob += vol.WritesOutOfBounds
			after := regionFromVolume(vol, dump)
			metrics, err := ComputeMetrics(before, after, place)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", t.ID, err)
			}
			if opts.Dump != nil {
				opts.Dump(GameDumpLine{Test: t.ID, Repeat: i, OK: true, PlaceAt: place,
					Box:    DumpBox{Min: dump.Min, Size: dump.Size()},
					Before: before.dumpData(), After: after.dumpData()})
			}
			outside += changesOutside(vol, baseline, dump)
			tr.Placements = append(tr.Placements, metrics)
		}
		if outside > 0 {
			tr.Notes = append(tr.Notes, fmt.Sprintf("%d changed cells fell outside the dump region over %d placements (widen the region)", outside, repeats))
		}
		if oob > 0 {
			tr.Notes = append(tr.Notes, fmt.Sprintf("%d writes left the engine volume over %d placements", oob, repeats))
		}
		tr.DurationMs = float64(time.Since(tStart).Microseconds()) / 1000
	}
	res.Meta["seedBase"] = opts.SeedBase
	res.Meta["libraryBuildMs"] = libBuilt.Milliseconds()
	res.Meta["totalMs"] = time.Since(started).Milliseconds()
	res.Meta["tests"] = len(tests)
	res.Meta["pack"] = filepath.ToSlash(opts.PackDir)
	return res, nil
}

// placeOnce runs one placement under the same budgets a `generate` run uses, turning a budget
// panic into a returned message.
func placeOnce(feature wgen.IFeature, vol *volume.Volume, origin wgen.BlockPos, biome *wgen.MolangBiome, seed uint32) (stopped string) {
	wb := 4_000_000
	vol.WriteBudget = &wb
	vol.WritesAttempted = 0
	db := 2_000_000
	ms := 8_000
	features.SetDelegationBudgetMs(&db, &ms)
	defer features.SetDelegationBudgetMs(nil, nil)
	defer func() {
		if r := recover(); r != nil {
			switch e := r.(type) {
			case *volume.WriteBudgetExceeded:
				stopped = e.Error()
			case *features.DelegationBudgetExceeded:
				stopped = e.Error()
			case *features.PlacementDeadlineExceeded:
				stopped = e.Error()
			case *features.MalformedRangeRefusal:
				stopped = e.Error()
			default:
				panic(r)
			}
		}
	}()
	ctx := &wgen.PlacementContext{API: vol, Origin: origin, Random: random.New(seed), MolangScope: wgen.NewScope(), Biome: biome}
	feature.Place(ctx)
	return ""
}

// regionFromVolume copies a box out of the volume into a Region (block names only).
func regionFromVolume(vol *volume.Volume, bx Box) *Region {
	size := bx.Size()
	r := &Region{Min: bx.Min, Size: size, Cells: make([]int32, size[0]*size[1]*size[2])}
	palette := vol.RawPalette()
	nameIdx := map[string]int32{}
	idIdx := map[block.ID]int32{}
	i := 0
	for y := bx.Min[1]; y <= bx.Max[1]; y++ {
		for z := bx.Min[2]; z <= bx.Max[2]; z++ {
			for x := bx.Min[0]; x <= bx.Max[0]; x++ {
				id := vol.GetBlockAt(x, y, z)
				k, ok := idIdx[id]
				if !ok {
					name := NormalizeName(palette.NameOf(id))
					k, ok = nameIdx[name]
					if !ok {
						k = int32(len(r.Names))
						r.Names = append(r.Names, name)
						nameIdx[name] = k
					}
					idIdx[id] = k
				}
				r.Cells[i] = k
				i++
			}
		}
	}
	return r
}

// dumpData run-length encodes a region the way the game's region dump answers.
func (r *Region) dumpData() *DumpData {
	d := &DumpData{Palette: r.Names}
	for i, c := range r.Cells {
		if i > 0 && d.RLE[len(d.RLE)-2] == int(c) {
			d.RLE[len(d.RLE)-1]++
			continue
		}
		d.RLE = append(d.RLE, int(c), 1)
	}
	return d
}

// changesOutside counts cells of the volume that changed by name but lie outside the dump box.
func changesOutside(vol *volume.Volume, baseline volume.Snapshot, bx Box) int {
	cur := vol.Data()
	base := baseline.Data()
	palette := vol.RawPalette()
	sx, sz := vol.SizeX(), vol.SizeZ()
	n := 0
	for i := range cur {
		if cur[i] == base[i] || palette.NameOf(cur[i]) == palette.NameOf(base[i]) {
			continue
		}
		x := vol.MinX() + i%sx
		z := vol.MinZ() + (i/sx)%sz
		y := vol.MinY() + i/(sx*sz)
		if !bx.Contains([3]int{x, y, z}) {
			n++
		}
	}
	return n
}

// SummarizeResults prints a one-line-per-type digest.
func SummarizeResults(r *Results) string {
	byType := map[string][]*TestResult{}
	for _, t := range r.Tests {
		byType[t.Type] = append(byType[t.Type], t)
	}
	types := make([]string, 0, len(byType))
	for k := range byType {
		types = append(types, k)
	}
	sort.Strings(types)
	var sb strings.Builder
	for _, ty := range types {
		ts := byType[ty]
		succ, n := 0.0, 0
		for _, t := range ts {
			for _, p := range t.Placements {
				succ += p["success"]
				n++
			}
		}
		rate := 0.0
		if n > 0 {
			rate = succ / float64(n)
		}
		fmt.Fprintf(&sb, "  %-46s %3d tests  %5d placements  %5.1f%% changed something\n", ty, len(ts), n, 100*rate)
	}
	return sb.String()
}
