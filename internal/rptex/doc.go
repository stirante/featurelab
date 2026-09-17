// Package rptex reads a Bedrock resource pack's texture metadata and the
// texture files themselves: terrain_texture.json's texture keys, blocks.json's
// per-block per-face texture assignments, and the PNG/TGA pixels both point
// at.
//
// It exists so there is exactly ONE answer in this repository to "which
// texture belongs to which block face". internal/gencolors asked that
// question first (to average each texture down to a preview colour) and
// internal/atlas asks it again (to pack every texture into an atlas and
// emit per-face cell indices); both read this package rather than each
// parsing terrain_texture.json their own way.
//
// Nothing here vendors a texture. Every entry point takes a resource-pack
// root supplied by the caller -- Mojang's bedrock-samples checkout for the
// vanilla tables, or the pack under test for its own blocks. To obtain a
// vanilla root locally:
//
//	git clone --filter=blob:none --sparse https://github.com/Mojang/bedrock-samples
//	cd bedrock-samples
//	git sparse-checkout set resource_pack/textures/blocks
package rptex
