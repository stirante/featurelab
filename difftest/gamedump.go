package difftest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// GameDumpLine is one line of the game runner's JSONL output: one placement of one test, with
// the dump box read before and after /place feature.
type GameDumpLine struct {
	Test    string    `json:"test"`
	Repeat  int       `json:"repeat"`
	OK      bool      `json:"ok"`
	Error   string    `json:"error,omitempty"`
	PlaceAt [3]int    `json:"placeAt"`
	Box     DumpBox   `json:"box"`
	Before  *DumpData `json:"before"`
	After   *DumpData `json:"after"`
	Place   string    `json:"placeResult,omitempty"` // the /place command's status message
}

// DumpBox is the dumped box (min corner and size), as the pipe reports it.
type DumpBox struct {
	Min  [3]int `json:"min"`
	Size [3]int `json:"size"`
}

// DumpData is one region dump answer reduced to what the metrics need: palette names and the
// run-length encoded cells (flat pairs paletteIndex, runLength; x fastest, then z, then y).
type DumpData struct {
	Palette []string `json:"palette"`
	RLE     []int    `json:"rle"`
}

// Region decodes a dump into a Region.
func (d *DumpData) Region(b DumpBox) (*Region, error) {
	n := b.Size[0] * b.Size[1] * b.Size[2]
	r := &Region{Min: b.Min, Size: b.Size, Names: d.Palette, Cells: make([]int32, 0, n)}
	if len(d.RLE)%2 != 0 {
		return nil, fmt.Errorf("odd RLE length %d", len(d.RLE))
	}
	for i := 0; i < len(d.RLE); i += 2 {
		idx, run := d.RLE[i], d.RLE[i+1]
		if idx < 0 || idx >= len(d.Palette) {
			return nil, fmt.Errorf("palette index %d out of range (%d entries)", idx, len(d.Palette))
		}
		for k := 0; k < run; k++ {
			r.Cells = append(r.Cells, int32(idx))
		}
	}
	if len(r.Cells) != n {
		return nil, fmt.Errorf("RLE decodes to %d cells, box holds %d", len(r.Cells), n)
	}
	return r, nil
}

// setupMismatch is the fraction of cells in the before-dump that differ from the expected
// superflat + setup. A healthy cell reads 0; an unloaded chunk reads (nearly) all air.
func setupMismatch(t *Test, before *Region) float64 {
	bad, n := 0, 0
	for y := 0; y < before.Size[1]; y++ {
		for z := 0; z < before.Size[2]; z++ {
			for x := 0; x < before.Size[0]; x++ {
				wx, wy, wz := before.Min[0]+x, before.Min[1]+y, before.Min[2]+z
				rel := [3]int{wx - t.Anchor[0], wy - t.Anchor[1], wz - t.Anchor[2]}
				want := ExpectedBlock(t, rel)
				got := NormalizeName(before.Names[before.Cells[(y*before.Size[2]+z)*before.Size[0]+x]])
				n++
				if got != want && !(isAir(got) && isAir(want)) {
					bad++
				}
			}
		}
	}
	if n == 0 {
		return 1
	}
	return float64(bad) / float64(n)
}

// MaxSetupMismatch is the largest fraction of unexpected cells a before-dump may have and still
// be trusted.
const MaxSetupMismatch = 0.002

// GameResults turns the runner's JSONL into Results, measuring each placement with the same
// ComputeMetrics the engine side uses.
func GameResults(m *Manifest, path string) (*Results, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	byID := map[string]*Test{}
	for _, t := range m.Tests {
		byID[t.ID] = t
	}
	res := &Results{Side: "game", Meta: map[string]any{"dumps": path}, Tests: map[string]*TestResult{}}
	// A test re-run appends to the same file; the last line for a (test, repeat) wins.
	collected := map[string]map[int]Metrics{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<30)
	lines := 0
	for sc.Scan() {
		if len(sc.Bytes()) == 0 {
			continue
		}
		lines++
		var l GameDumpLine
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			return nil, fmt.Errorf("%s line %d: %w", path, lines, err)
		}
		t := byID[l.Test]
		if t == nil {
			continue
		}
		tr := res.Tests[t.ID]
		if tr == nil {
			tr = &TestResult{ID: t.ID, Type: t.Type, Group: t.Group, FeatureID: t.FeatureID, GameCaveat: t.GameCaveat}
			res.Tests[t.ID] = tr
		}
		if !l.OK || l.Before == nil || l.After == nil {
			tr.Notes = append(tr.Notes, fmt.Sprintf("repeat %d: %s", l.Repeat, l.Error))
			continue
		}
		before, err := l.Before.Region(l.Box)
		if err != nil {
			return nil, fmt.Errorf("%s repeat %d before: %w", t.ID, l.Repeat, err)
		}
		after, err := l.After.Region(l.Box)
		if err != nil {
			return nil, fmt.Errorf("%s repeat %d after: %w", t.ID, l.Repeat, err)
		}
		if frac := setupMismatch(t, before); frac > MaxSetupMismatch {
			tr.SetupMismatches++
			tr.Notes = append(tr.Notes, fmt.Sprintf("repeat %d dropped: %.1f%% of the before-dump differs from the expected setup", l.Repeat, 100*frac))
			continue
		}
		metrics, err := ComputeMetrics(before, after, l.PlaceAt)
		if err != nil {
			return nil, fmt.Errorf("%s repeat %d: %w", t.ID, l.Repeat, err)
		}
		if collected[t.ID] == nil {
			collected[t.ID] = map[int]Metrics{}
		}
		collected[t.ID][l.Repeat] = metrics
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	for id, byRepeat := range collected {
		repeats := make([]int, 0, len(byRepeat))
		for r := range byRepeat {
			repeats = append(repeats, r)
		}
		sort.Ints(repeats)
		for _, r := range repeats {
			res.Tests[id].Placements = append(res.Tests[id].Placements, byRepeat[r])
		}
	}
	res.Meta["lines"] = lines
	return res, nil
}
