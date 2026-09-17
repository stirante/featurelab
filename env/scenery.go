package env

import (
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/volume"
)

// solidFill sets every cell in the volume from pick(x, y, z).
func solidFill(v *volume.Volume, pick func(x, y, z int) block.ID) {
	for y := v.MinY(); y < v.MaxY(); y++ {
		for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
			for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
				v.SetBlockAt(x, y, z, pick(x, y, z))
			}
		}
	}
}

// buildPlainsColumns is the column-building loop BuildPlains and the
// "plains"/"forest" EnvironmentPreset.Build funcs all share, parameterized
// over top/mid/foundation so BuildPlains's own hardcoded native materials
// and a preset's resolved materials (which may have been overridden) drive
// the identical landform.
func buildPlainsColumns(v *volume.Volume, seed int32, b Blocks, top, mid, foundation block.ID) {
	for z := v.MinZ(); z < v.MinZ()+v.SizeZ(); z++ {
		for x := v.MinX(); x < v.MinX()+v.SizeX(); x++ {
			topY := surfaceHeight(v, seed, x, z, 63, 2)
			buildColumn(v, x, z, topY, top, mid, midMaterialDepth, func(y int) block.ID {
				return stoneOrDeepslate(seed, x, y, z, b, foundation)
			})
		}
	}
	scatterOres(v, seed, b, foundation, b.Deepslate)
}

// plantOakTree is a plain oak tree -- scenery only; the real tree features
// live in features/tree.go.
func plantOakTree(v *volume.Volume, rng *EnvRandom, x, groundY, z int, b Blocks) {
	height := 4 + rng.NextIntBound(3)
	topY := groundY + height
	if topY+2 >= v.MaxY() {
		return
	}
	for y := groundY + 1; y <= topY; y++ {
		v.SetBlockAt(x, y, z, b.Log)
	}
	for dy := -2; dy <= 1; dy++ {
		radius := 1
		if dy < 0 {
			radius = 2
		}
		for dz := -radius; dz <= radius; dz++ {
			for dx := -radius; dx <= radius; dx++ {
				if dx == 0 && dz == 0 && dy <= 0 {
					continue
				}
				if absInt(dx) == radius && absInt(dz) == radius && (dy == 1 || rng.NextBoolean()) {
					continue
				}
				y := topY + dy
				if v.GetBlockAt(x+dx, y, z+dz) == b.Air {
					v.SetBlockAt(x+dx, y, z+dz, b.Leaves)
				}
			}
		}
	}
}
