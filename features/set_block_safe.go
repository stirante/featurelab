package features

import (
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/wgen"
)

// setBlockSafe writes a block, but no write goes over
// a block with the not_feature_replaceable tag. Only the crevasse and geode features use them; the
// tag has no effect on other features.
func setBlockSafe(api wgen.BlockWorld, pal *block.Palette, pos wgen.BlockPos, id block.ID) bool {
	if pal.BlockHasTag(api.GetBlock(pos), "not_feature_replaceable") {
		return false
	}
	return api.SetBlock(pos, id)
}
