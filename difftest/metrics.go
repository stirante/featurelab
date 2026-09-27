package difftest

import (
	"fmt"
	"sort"
	"strings"
)

// Region is one dumped box of blocks, before or after a placement, in the same layout the game's
// region dump answer uses: x fastest, then z, then y. Cells hold indexes into Names. Both sides of
// the comparison (the engine's volume and the game's dump) are converted into this one shape so
// every metric is computed by exactly one piece of code.
type Region struct {
	Min   [3]int   // absolute world coordinates of the box's minimum corner
	Size  [3]int   // sx, sy, sz
	Names []string // palette: block names (no states)
	Cells []int32  // len = sx*sy*sz
}

func (r *Region) index(x, y, z int) int {
	return ((y-r.Min[1])*r.Size[2]+(z-r.Min[2]))*r.Size[0] + (x - r.Min[0])
}

// NameAt returns the block name at an absolute position inside the region.
func (r *Region) NameAt(x, y, z int) string {
	return r.Names[r.Cells[r.index(x, y, z)]]
}

// NormalizeName gives a block name the minecraft: namespace when it has none, so an engine name
// and a game name for the same block compare equal.
func NormalizeName(n string) string {
	n = strings.TrimSpace(n)
	if n == "" {
		return "minecraft:air"
	}
	if !strings.Contains(n, ":") {
		return "minecraft:" + n
	}
	return n
}

func isAir(n string) bool {
	return n == "minecraft:air" || n == "minecraft:cave_air" || n == "minecraft:void_air"
}

func isLeaves(n string) bool { return strings.Contains(n, "leaves") }

func isLog(n string) bool {
	return strings.HasSuffix(n, "_log") || strings.HasSuffix(n, "_wood") || strings.HasSuffix(n, "_stem") ||
		n == "minecraft:log" || n == "minecraft:log2" || n == "minecraft:wood"
}

// Metrics is one placement's scalar measurements, keyed by metric name. A metric a placement did
// not produce (no leaves on layer +7, say) is simply absent and reads as 0 when distributions are
// assembled -- see Samples.
type Metrics map[string]float64

// ComputeMetrics measures one placement: before and after are the same box, origin is the
// absolute placement position the relative metrics (layers, extents, bbox) are measured from.
//
// Metric names (all counts are cells):
//
//	success        1 if anything in the box changed, else 0
//	changed        cells whose block name differs
//	placed         changed cells that are not air afterwards
//	removed        non-air cells that became air (carvers)
//	replaced       non-air cells that became a different non-air block
//	block:<name>   changed cells that are <name> afterwards
//	bbox.dx/dy/dz  size of the box around every changed cell (0 when nothing changed)
//	bbox.minY/maxY bottom/top of that box relative to the origin
//	bbox.cx/cz     centre of that box relative to the origin, horizontally
//	top            highest non-air changed cell relative to the origin
//	layer[dy]      non-air changed cells on layer dy (relative to the origin)
//	removedLayer[dy] cells carved to air on layer dy
//	leaves         changed cells whose name contains "leaves"
//	leafExtent[dy] largest Chebyshev distance of a leaf on layer dy from the origin column
//	leafWidthX/Z   horizontal size of the leaf box
//	leafLayers     number of layers holding at least one leaf
//	logs, logTop   log/wood/stem cells placed, and the highest one relative to the origin
//	clusters       26-connected groups of changed cells
//	largestCluster size of the biggest of those groups
func ComputeMetrics(before, after *Region, origin [3]int) (Metrics, error) {
	if before.Size != after.Size || before.Min != after.Min {
		return nil, fmt.Errorf("before/after boxes differ: %v%v vs %v%v", before.Min, before.Size, after.Min, after.Size)
	}
	sx, sy, sz := after.Size[0], after.Size[1], after.Size[2]
	n := sx * sy * sz
	if len(before.Cells) != n || len(after.Cells) != n {
		return nil, fmt.Errorf("cell count mismatch: %d/%d, want %d", len(before.Cells), len(after.Cells), n)
	}
	bNames := make([]string, len(before.Names))
	for i, s := range before.Names {
		bNames[i] = NormalizeName(s)
	}
	aNames := make([]string, len(after.Names))
	for i, s := range after.Names {
		aNames[i] = NormalizeName(s)
	}

	m := Metrics{}
	changedMask := make([]bool, n)
	var changed, placed, removed, replaced, leaves, logs int
	minP := [3]int{1 << 30, 1 << 30, 1 << 30}
	maxP := [3]int{-(1 << 30), -(1 << 30), -(1 << 30)}
	top := -(1 << 30)
	logTop := -(1 << 30)
	leafMin := [2]int{1 << 30, 1 << 30}
	leafMax := [2]int{-(1 << 30), -(1 << 30)}
	leafLayer := map[int]int{}

	for y := 0; y < sy; y++ {
		for z := 0; z < sz; z++ {
			for x := 0; x < sx; x++ {
				i := (y*sz+z)*sx + x
				b := bNames[before.Cells[i]]
				a := aNames[after.Cells[i]]
				if a == b {
					continue
				}
				changedMask[i] = true
				changed++
				wx, wy, wz := before.Min[0]+x, before.Min[1]+y, before.Min[2]+z
				dx, dy, dz := wx-origin[0], wy-origin[1], wz-origin[2]
				rel := [3]int{dx, dy, dz}
				for k := 0; k < 3; k++ {
					if rel[k] < minP[k] {
						minP[k] = rel[k]
					}
					if rel[k] > maxP[k] {
						maxP[k] = rel[k]
					}
				}
				if isAir(a) {
					if !isAir(b) {
						removed++
						m[fmt.Sprintf("removedLayer[%+d]", dy)]++
					}
					continue
				}
				placed++
				if !isAir(b) {
					replaced++
				}
				m["block:"+a]++
				m[fmt.Sprintf("layer[%+d]", dy)]++
				if dy > top {
					top = dy
				}
				if isLeaves(a) {
					leaves++
					ext := absInt(dx)
					if absInt(dz) > ext {
						ext = absInt(dz)
					}
					key := fmt.Sprintf("leafExtent[%+d]", dy)
					if float64(ext) > m[key] || leafLayer[dy] == 0 {
						m[key] = float64(ext)
					}
					leafLayer[dy]++
					if dx < leafMin[0] {
						leafMin[0] = dx
					}
					if dx > leafMax[0] {
						leafMax[0] = dx
					}
					if dz < leafMin[1] {
						leafMin[1] = dz
					}
					if dz > leafMax[1] {
						leafMax[1] = dz
					}
				}
				if isLog(a) {
					logs++
					if dy > logTop {
						logTop = dy
					}
				}
			}
		}
	}

	m["changed"] = float64(changed)
	m["placed"] = float64(placed)
	m["removed"] = float64(removed)
	m["replaced"] = float64(replaced)
	if changed > 0 {
		m["success"] = 1
		m["bbox.dx"] = float64(maxP[0] - minP[0] + 1)
		m["bbox.dy"] = float64(maxP[1] - minP[1] + 1)
		m["bbox.dz"] = float64(maxP[2] - minP[2] + 1)
		m["bbox.minY"] = float64(minP[1])
		m["bbox.maxY"] = float64(maxP[1])
		m["bbox.cx"] = float64(minP[0]+maxP[0]) / 2
		m["bbox.cz"] = float64(minP[2]+maxP[2]) / 2
	} else {
		m["success"] = 0
	}
	if placed > 0 {
		m["top"] = float64(top)
	}
	if leaves > 0 {
		m["leaves"] = float64(leaves)
		m["leafWidthX"] = float64(leafMax[0] - leafMin[0] + 1)
		m["leafWidthZ"] = float64(leafMax[1] - leafMin[1] + 1)
		m["leafLayers"] = float64(len(leafLayer))
	}
	if logs > 0 {
		m["logs"] = float64(logs)
		m["logTop"] = float64(logTop)
	}
	clusters, largest := countClusters(changedMask, sx, sy, sz)
	m["clusters"] = float64(clusters)
	m["largestCluster"] = float64(largest)
	return m, nil
}

// countClusters counts 26-connected components of the mask with an explicit stack.
func countClusters(mask []bool, sx, sy, sz int) (count, largest int) {
	seen := make([]bool, len(mask))
	stack := make([]int, 0, 64)
	for start, on := range mask {
		if !on || seen[start] {
			continue
		}
		count++
		size := 0
		seen[start] = true
		stack = append(stack[:0], start)
		for len(stack) > 0 {
			i := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			size++
			x := i % sx
			z := (i / sx) % sz
			y := i / (sx * sz)
			for ddy := -1; ddy <= 1; ddy++ {
				ny := y + ddy
				if ny < 0 || ny >= sy {
					continue
				}
				for ddz := -1; ddz <= 1; ddz++ {
					nz := z + ddz
					if nz < 0 || nz >= sz {
						continue
					}
					for ddx := -1; ddx <= 1; ddx++ {
						nx := x + ddx
						if nx < 0 || nx >= sx {
							continue
						}
						j := (ny*sz+nz)*sx + nx
						if mask[j] && !seen[j] {
							seen[j] = true
							stack = append(stack, j)
						}
					}
				}
			}
		}
		if size > largest {
			largest = size
		}
	}
	return count, largest
}

func absInt(a int) int {
	if a < 0 {
		return -a
	}
	return a
}

// Samples turns per-placement metrics into per-metric series of equal length: a metric missing
// from a placement contributes 0.
func Samples(placements []Metrics) map[string][]float64 {
	keys := map[string]bool{}
	for _, p := range placements {
		for k := range p {
			keys[k] = true
		}
	}
	out := make(map[string][]float64, len(keys))
	for k := range keys {
		s := make([]float64, len(placements))
		for i, p := range placements {
			s[i] = p[k]
		}
		out[k] = s
	}
	return out
}

// SortedKeys returns a map's keys in order.
func SortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
