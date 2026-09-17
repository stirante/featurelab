package main

import "github.com/stirante/featurelab/env"

// EnvironmentDefaultsOutput is env.EnvironmentDefaults promoted onto the wire with explicit
// lowerCamelCase tags (env.EnvironmentDefaults itself carries none -- it was only ever
// consumed Go-side before this method existed).
type EnvironmentDefaultsOutput struct {
	SizeX int `json:"sizeX"`
	SizeY int `json:"sizeY"`
	SizeZ int `json:"sizeZ"`
	MinY  int `json:"minY"`
}

// EnvironmentMaterialsOutput is env.MaterialSlots promoted onto the wire -- a preset's own
// NATIVE material identity (source 1 of the "material slots -> terrain builder" pipeline, see
// env.MaterialSlots's own doc comment), the same six fields wire.Materials lets a `generate`
// request override.
type EnvironmentMaterialsOutput struct {
	TopMaterial        string  `json:"topMaterial"`
	MidMaterial        string  `json:"midMaterial"`
	FoundationMaterial string  `json:"foundationMaterial"`
	SeaFloorMaterial   string  `json:"seaFloorMaterial"`
	SeaMaterial        string  `json:"seaMaterial"`
	SeaFloorDepth      float64 `json:"seaFloorDepth"`
}

// EnvironmentOption is the JSON-friendly, wire-facing projection of one env.EnvironmentPreset --
// EnvironmentPreset itself carries a Build func value and other non-serializable fields, so it
// cannot go on the wire as-is. This is the `environments` method's per-preset response shape:
// the "environments" method itself exists so a `serve` client (the VS Code extension, and any
// future non-Wails host) can populate its own Preset picker from the engine's real, live
// env.ENVIRONMENTS table instead of a hand-transcribed copy that can silently drift out of sync
// (see frontend/src/ui/environments.ts, deleted by the same change that added this method, for
// what that copy used to cost).
//
// TWO PROJECTIONS OF ONE SOURCE. This type and apps/desktop/app.go's own EnvironmentOption are
// both hand-written projections of the SAME env.EnvironmentPreset, for two hosts that reach the
// engine differently (`serve` JSON-RPC here, a Wails binding there). They are deliberately
// distinct types rather than one shared one -- this one additionally carries Materials/Biome/
// BiomeTags, which the desktop app's picker has never needed (its Materials/Biome sections are
// driven differently -- see that file) -- but any field that describes what a preset IS, rather
// than what one host happens to render, belongs in BOTH. A field added to only one of them is a
// picker in one app that knows something the picker in the other does not. Change both.
type EnvironmentOption struct {
	ID          string                     `json:"id"`
	Label       string                     `json:"label"`
	Description string                     `json:"description"`
	Defaults    EnvironmentDefaultsOutput  `json:"defaults"`
	Materials   EnvironmentMaterialsOutput `json:"materials"`
	// BuildsSea is env.EnvironmentPreset.BuildsSea: whether this preset's Build actually models a
	// sea, and so whether the seaFloorMaterial/seaMaterial/seaFloorDepth slots above mean anything
	// under it ("ocean" alone, today). On the wire so a client can DISABLE those three
	// controls under a preset that ignores them, instead of leaving three live-looking inputs that
	// do nothing until the run comes back with env.InertSeaSlotOverrides' warning -- see
	// frontend/src/ui/panel.ts's Materials section, and session.go for the warning itself. The
	// engine stays the single source of truth for which presets those are: a client reads this
	// flag rather than hardcoding "ocean" a second time.
	BuildsSea bool `json:"buildsSea"`
	// Biome/BiomeTags are this preset's default query.has_biome_tag/any_tag/all_tags identity
	// (env.EnvironmentPreset.Biome/BiomeTags) -- shown by a client as the Biome section's
	// placeholder/prefill until the user opts into an explicit override, exactly what the
	// deleted STOPGAP_ENVIRONMENTS mirror used to hand-copy.
	Biome     string   `json:"biome"`
	BiomeTags []string `json:"biomeTags"`
}

// environmentsOutput builds the `environments` method's response: every preset env.ENVIRONMENTS
// defines, in the same order, projected onto the wire. Static, pack-independent data -- unlike
// "generate", this method needs no pack loaded first and never will (env.ENVIRONMENTS is a
// fixed built-in table, not something a pack can add to).
func environmentsOutput() []EnvironmentOption {
	out := make([]EnvironmentOption, 0, len(env.ENVIRONMENTS))
	for _, preset := range env.ENVIRONMENTS {
		out = append(out, EnvironmentOption{
			ID:          string(preset.ID),
			Label:       preset.Label,
			Description: preset.Description,
			Defaults: EnvironmentDefaultsOutput{
				SizeX: preset.Defaults.SizeX,
				SizeY: preset.Defaults.SizeY,
				SizeZ: preset.Defaults.SizeZ,
				MinY:  preset.Defaults.MinY,
			},
			Materials: EnvironmentMaterialsOutput{
				TopMaterial:        preset.Materials.TopMaterial,
				MidMaterial:        preset.Materials.MidMaterial,
				FoundationMaterial: preset.Materials.FoundationMaterial,
				SeaFloorMaterial:   preset.Materials.SeaFloorMaterial,
				SeaMaterial:        preset.Materials.SeaMaterial,
				SeaFloorDepth:      preset.Materials.SeaFloorDepth,
			},
			BuildsSea: preset.BuildsSea,
			Biome:     preset.Biome,
			BiomeTags: preset.BiomeTags,
		})
	}
	return out
}
