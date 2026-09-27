package difftest

import (
	"fmt"
	"sort"
	"strings"
)

// World layout both sides share: a default Bedrock superflat world. Bedrock at y=-64, two dirt,
// grass at y=-61, so the first air block -- the natural placement Y for surface features -- is
// y=-60. Every relative coordinate in a Test is relative to its cell's anchor (ax, SurfaceY, az).
const (
	WorldFloorY = -64
	SurfaceY    = -60
	WorldTopY   = 319

	// Cells sit on a grid far enough apart that no test can reach its neighbour.
	gridOriginX = 256
	gridOriginZ = 256
	gridPitch   = 128
	gridColumns = 12

	// MaxFillVolume is the game's /fill limit per command.
	MaxFillVolume = 32768

	// resetMargin is how far past the dump region (and every setup op) each repeat's reset
	// reaches, so the ground around a cell is always pristine superflat.
	resetMargin = 4
)

// superflatLayers is the column every cell starts from, bottom up.
var superflatLayers = []struct {
	Y     int
	Block string
}{
	{-64, "minecraft:bedrock"},
	{-63, "minecraft:dirt"},
	{-62, "minecraft:dirt"},
	{-61, "minecraft:grass_block"},
}

// Box is an inclusive box of block positions.
type Box struct {
	Min [3]int `json:"min"`
	Max [3]int `json:"max"`
}

func (b Box) Offset(o [3]int) Box {
	return Box{
		Min: [3]int{b.Min[0] + o[0], b.Min[1] + o[1], b.Min[2] + o[2]},
		Max: [3]int{b.Max[0] + o[0], b.Max[1] + o[1], b.Max[2] + o[2]},
	}
}

func (b Box) Union(c Box) Box {
	out := b
	for k := 0; k < 3; k++ {
		if c.Min[k] < out.Min[k] {
			out.Min[k] = c.Min[k]
		}
		if c.Max[k] > out.Max[k] {
			out.Max[k] = c.Max[k]
		}
	}
	return out
}

func (b Box) Size() [3]int {
	return [3]int{b.Max[0] - b.Min[0] + 1, b.Max[1] - b.Min[1] + 1, b.Max[2] - b.Min[2] + 1}
}

func (b Box) Volume() int {
	s := b.Size()
	return s[0] * s[1] * s[2]
}

func (b Box) Contains(p [3]int) bool {
	for k := 0; k < 3; k++ {
		if p[k] < b.Min[k] || p[k] > b.Max[k] {
			return false
		}
	}
	return true
}

func (b Box) normalized() Box {
	out := b
	for k := 0; k < 3; k++ {
		if out.Min[k] > out.Max[k] {
			out.Min[k], out.Max[k] = out.Max[k], out.Min[k]
		}
	}
	return out
}

// Op is one setup step, applied after the superflat reset and before the placement. Only "fill"
// exists: fill the inclusive box (relative to the cell anchor) with Block. Later ops overwrite
// earlier ones, so a room is "fill stone, then fill air inside".
type Op struct {
	Op    string `json:"op"`
	Box   Box    `json:"box"`
	Block string `json:"block"`
}

// Test is one differential test: one feature, placed Repeats times on a freshly reset cell.
type Test struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	FeatureID string `json:"featureId"`
	Group     string `json:"group"`
	Note      string `json:"note,omitempty"`
	Source    string `json:"source"`

	Place   [3]int `json:"place"`   // relative to the anchor
	Setup   []Op   `json:"setup"`   // relative to the anchor
	Region  Box    `json:"region"`  // relative to the anchor; the box both sides dump
	Repeats int    `json:"repeats"` // placements per side

	// Metrics names the metrics this test is mostly about (the comparator still compares all
	// of them; these are listed first in the report).
	Metrics []string `json:"metrics"`

	// GameCaveat is set when the game may not honour /place feature for this test at all
	// (carvers) -- the comparator reports such tests separately instead of as failures.
	GameCaveat string `json:"gameCaveat,omitempty"`

	// Filled in by Layout.
	Cell   int      `json:"cell"`
	Anchor [3]int   `json:"anchor"`
	Game   GamePlan `json:"game"`
}

// GamePlan is everything the game-side runner needs for one test, in absolute coordinates and
// ready-made command lines (no leading slash).
type GamePlan struct {
	PlaceAt  [3]int      `json:"placeAt"`
	DumpBox  Box         `json:"dumpBox"`
	ResetBox Box         `json:"resetBox"`
	Teleport string      `json:"teleport"`
	Reset    []string    `json:"reset"`
	Setup    []string    `json:"setup"`
	Place    string      `json:"place"`
	Checks   []BlockTest `json:"checks"`
}

// BlockTest is one position whose block after reset+setup is known; the runner verifies a few of
// these before trusting a cell (an unloaded chunk dumps as air).
type BlockTest struct {
	Pos   [3]int `json:"pos"`
	Block string `json:"block"`
}

// Manifest is the file both runners read.
type Manifest struct {
	Version   int    `json:"version"`
	Namespace string `json:"namespace"`
	World     struct {
		Kind        string   `json:"kind"`
		SurfaceY    int      `json:"surfaceY"`
		Layers      []string `json:"layers"`
		Biome       string   `json:"biome"`
		GridPitch   int      `json:"gridPitch"`
		GridColumns int      `json:"gridColumns"`
	} `json:"world"`
	Tests []*Test `json:"tests"`
}

// ResetBoxRel is the relative box a repeat resets: the dump region plus every setup op, widened.
func (t *Test) ResetBoxRel() Box {
	b := t.Region
	for _, op := range t.Setup {
		b = b.Union(op.Box.normalized())
	}
	b.Min[0] -= resetMargin
	b.Min[2] -= resetMargin
	b.Max[0] += resetMargin
	b.Max[2] += resetMargin
	b.Max[1] += resetMargin
	if b.Min[1] > WorldFloorY-SurfaceY {
		b.Min[1] = WorldFloorY - SurfaceY
	}
	if b.Max[1] > WorldTopY-SurfaceY {
		b.Max[1] = WorldTopY - SurfaceY
	}
	return b
}

// Layout assigns every test its grid cell and renders the game plan.
func Layout(tests []*Test) {
	for i, t := range tests {
		t.Cell = i
		col, row := i%gridColumns, i/gridColumns
		t.Anchor = [3]int{gridOriginX + col*gridPitch + 8, SurfaceY, gridOriginZ + row*gridPitch + 8}
		t.Game = planGame(t)
	}
}

func planGame(t *Test) GamePlan {
	a := t.Anchor
	place := [3]int{a[0] + t.Place[0], a[1] + t.Place[1], a[2] + t.Place[2]}
	dump := t.Region.Offset(a)
	reset := t.ResetBoxRel().Offset(a)
	g := GamePlan{PlaceAt: place, DumpBox: dump, ResetBox: reset, Reset: []string{}, Setup: []string{}, Checks: []BlockTest{}}
	// Hover above and a little south of the cell, so every chunk it touches is loaded.
	tpY := SurfaceY + 40
	if dump.Max[1]+8 > tpY {
		tpY = dump.Max[1] + 8
	}
	g.Teleport = fmt.Sprintf("tp @s %d %d %d", a[0], minInt(tpY, WorldTopY), a[2]-24)

	// Reset: air above the ground, then the superflat layers, over the whole reset box.
	airFrom := reset
	if airFrom.Min[1] < SurfaceY {
		airFrom.Min[1] = SurfaceY
	}
	if airFrom.Max[1] >= airFrom.Min[1] {
		g.Reset = append(g.Reset, fillCommands(airFrom, "minecraft:air")...)
	}
	for _, l := range superflatLayers {
		layer := Box{Min: [3]int{reset.Min[0], l.Y, reset.Min[2]}, Max: [3]int{reset.Max[0], l.Y, reset.Max[2]}}
		g.Reset = append(g.Reset, fillCommands(layer, l.Block)...)
	}
	for _, op := range t.Setup {
		g.Setup = append(g.Setup, fillCommands(op.Box.normalized().Offset(a), op.Block)...)
	}
	g.Place = fmt.Sprintf("place feature %s %d %d %d", t.FeatureID, place[0], place[1], place[2])

	// Checks: the ground under the anchor, plus the centre and a corner of every setup op.
	add := func(rel [3]int) {
		p := [3]int{a[0] + rel[0], a[1] + rel[1], a[2] + rel[2]}
		if !dump.Contains(p) {
			return
		}
		for _, c := range g.Checks {
			if c.Pos == p {
				return
			}
		}
		g.Checks = append(g.Checks, BlockTest{Pos: p, Block: ExpectedBlock(t, rel)})
	}
	add([3]int{0, -1, 0})
	for _, op := range t.Setup {
		b := op.Box.normalized()
		add([3]int{(b.Min[0] + b.Max[0]) / 2, (b.Min[1] + b.Max[1]) / 2, (b.Min[2] + b.Max[2]) / 2})
		add(b.Min)
		add(b.Max)
	}
	return g
}

// ExpectedBlock is the block at a relative position after reset and setup.
func ExpectedBlock(t *Test, rel [3]int) string {
	name := "minecraft:air"
	y := SurfaceY + rel[1]
	for _, l := range superflatLayers {
		if l.Y == y {
			name = l.Block
		}
	}
	for _, op := range t.Setup {
		if op.Box.normalized().Contains(rel) {
			name = op.Block
		}
	}
	return name
}

// fillCommands splits a box into /fill commands the game accepts (at most MaxFillVolume blocks
// each), slicing along Y first and then along X.
func fillCommands(b Box, block string) []string {
	var out []string
	for _, piece := range splitBox(b.normalized()) {
		out = append(out, fmt.Sprintf("fill %d %d %d %d %d %d %s", piece.Min[0], piece.Min[1], piece.Min[2],
			piece.Max[0], piece.Max[1], piece.Max[2], block))
	}
	return out
}

func splitBox(b Box) []Box {
	if b.Volume() <= MaxFillVolume {
		return []Box{b}
	}
	s := b.Size()
	layer := s[0] * s[2]
	if layer <= MaxFillVolume {
		step := MaxFillVolume / layer
		var out []Box
		for y := b.Min[1]; y <= b.Max[1]; y += step {
			p := b
			p.Min[1] = y
			p.Max[1] = minInt(y+step-1, b.Max[1])
			out = append(out, p)
		}
		return out
	}
	// One layer is already too big: split it along X, one Y layer at a time.
	step := MaxFillVolume / s[2]
	var out []Box
	for y := b.Min[1]; y <= b.Max[1]; y++ {
		for x := b.Min[0]; x <= b.Max[0]; x += step {
			p := b
			p.Min[1], p.Max[1] = y, y
			p.Min[0] = x
			p.Max[0] = minInt(x+step-1, b.Max[0])
			out = append(out, p)
		}
	}
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// NewManifest builds the manifest around a laid-out test list.
func NewManifest(tests []*Test) *Manifest {
	m := &Manifest{Version: 1, Namespace: Namespace, Tests: tests}
	m.World.Kind = "superflat (default preset: bedrock, 2 dirt, grass; plains biome)"
	m.World.SurfaceY = SurfaceY
	for _, l := range superflatLayers {
		m.World.Layers = append(m.World.Layers, fmt.Sprintf("y=%d %s", l.Y, l.Block))
	}
	m.World.Biome = "plains"
	m.World.GridPitch = gridPitch
	m.World.GridColumns = gridColumns
	return m
}

// TypeCounts is how many tests each feature type has, for the summary.
func TypeCounts(tests []*Test) map[string]int {
	out := map[string]int{}
	for _, t := range tests {
		out[t.Type]++
	}
	return out
}

// SelectTests filters by comma-separated substrings of id, type or group ("" = all).
func SelectTests(tests []*Test, filter string) []*Test {
	if strings.TrimSpace(filter) == "" {
		return tests
	}
	var parts []string
	for _, p := range strings.Split(filter, ",") {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, p)
		}
	}
	var out []*Test
	for _, t := range tests {
		for _, p := range parts {
			if strings.Contains(t.ID, p) || strings.Contains(t.Type, p) || strings.Contains(t.Group, p) {
				out = append(out, t)
				break
			}
		}
	}
	return out
}

func sortedTypes(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
