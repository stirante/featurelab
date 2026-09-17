// Package gencolors derives a per-block, per-face colour table for the
// voxel preview renderer from the official vanilla resource-pack data
// (rp_blocks.json + terrain_texture.json) and the actual texture PNGs/TGAs
// shipped in Mojang's bedrock-samples repository. It does not vendor any
// texture: the texture root is always a caller-supplied filesystem path.
//
// The reading of that data -- terrain_texture.json's keys, blocks.json's
// per-face texture sets, the PNG/TGA decoding -- lives in
// internal/rptex, which internal/atlas shares. This package is only the
// averaging-to-one-swatch layer on top.
//
// To obtain a texture root locally:
//
//	git clone --filter=blob:none --sparse https://github.com/Mojang/bedrock-samples
//	cd bedrock-samples
//	git sparse-checkout set resource_pack/textures/blocks
//
// then pass the resulting .../bedrock-samples/resource_pack directory as
// Config.TextureRoot (or cmd/gencolors's -texture-root flag).
package gencolors
