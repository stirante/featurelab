package wire

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/session"
)

// BuildConfig turns a GenerateParams into a session.Config, applying session.DefaultConfig
// (env)'s own defaults for everything not explicitly overridden -- mirrors how the CLI flags/
// serve params/desktop app params are all documented as "default: preset default".
func BuildConfig(p GenerateParams) (session.Config, error) {
	if p.Feature != "" && p.Rule != "" {
		return session.Config{}, fmt.Errorf("feature and rule are mutually exclusive -- pick one")
	}
	if p.Feature == "" && p.Rule == "" {
		return session.Config{}, fmt.Errorf("one of feature or rule is required")
	}

	envID := env.EnvironmentID(p.Env)
	if envID == "" {
		envID = env.EnvPlains
	}
	cfg, ok := session.DefaultConfig(envID)
	if !ok {
		return session.Config{}, fmt.Errorf("unknown environment %q", envID)
	}

	if p.Feature != "" {
		cfg.Mode = session.ModeFeature
		id := p.Feature
		cfg.FeatureIdentifier = &id
	} else {
		cfg.Mode = session.ModeRule
		id := p.Rule
		cfg.RuleIdentifier = &id
	}

	if p.Seed != nil {
		cfg.FeatureSeed = *p.Seed
	}
	if p.Origin != "" {
		x, y, z, err := ParseOrigin(p.Origin)
		if err != nil {
			return session.Config{}, err
		}
		cfg.OriginX = x
		oy := y
		cfg.OriginY = &oy
		cfg.OriginZ = z
	}
	if p.Size != "" {
		x, y, z, err := ParseSize(p.Size)
		if err != nil {
			return session.Config{}, err
		}
		cfg.SizeX, cfg.SizeY, cfg.SizeZ = x, y, z
	}
	if p.MinY != nil {
		cfg.MinY = *p.MinY
	}
	// BiomeID selects a loaded pack biome (session.Config.EnvironmentBiomeID --
	// materials + biome-identity source 2); it is a plain pass-through of the
	// request string, resolved later against whichever biomes.Library the caller
	// (RunGenerate/RunGenerateFromWorkspace) hands session.Generate/Workspace.Generate --
	// BuildConfig itself has no pack to resolve against and never did. "" means no
	// pack biome selected (preset default). See GenerateParams's own doc comment.
	cfg.EnvironmentBiomeID = p.BiomeID
	// BiomeTags, independent of BiomeID, is a tags-ONLY manual override (source 3)
	// on top of whichever of source 1 (preset)/source 2 (the selected pack biome,
	// if any) is active -- session.BiomeOverride.ID is deliberately left "" here so
	// session.generate's own per-field fallback (`if trimmed != "" { biomeID =
	// trimmed }`) keeps whichever identifier that default already resolved to.
	if len(p.BiomeTags) > 0 {
		cfg.BiomeOverride = &session.BiomeOverride{Tags: strings.Join(p.BiomeTags, ",")}
	}
	if p.Materials != nil {
		cfg.MaterialOverride = &env.MaterialOverride{
			TopMaterial:        p.Materials.TopMaterial,
			MidMaterial:        p.Materials.MidMaterial,
			FoundationMaterial: p.Materials.FoundationMaterial,
			SeaFloorMaterial:   p.Materials.SeaFloorMaterial,
			SeaMaterial:        p.Materials.SeaMaterial,
			SeaFloorDepth:      p.Materials.SeaFloorDepth,
		}
	}
	if p.Repeat > 0 {
		cfg.RepeatCount = p.Repeat
	}
	cfg.Profiling = p.Profile
	// WriteBudget/DelegationBudget/PlacementTimeLimitMs are pointers precisely so this can
	// distinguish "absent" (leave DefaultConfig's preset default alone) from "explicitly 0" (an
	// immediate-abort budget) -- see GenerateParams's own doc comment.
	if p.WriteBudget != nil {
		cfg.WriteBudget = *p.WriteBudget
	}
	if p.DelegationBudget != nil {
		cfg.DelegationBudget = *p.DelegationBudget
	}
	if p.PlacementTimeLimitMs != nil {
		cfg.PlacementTimeLimitMs = *p.PlacementTimeLimitMs
	}
	return cfg, nil
}

// ParseOrigin parses "x,y,z" (all three required, decimal integers) -- shared by generate's
// --origin flag, serve's "origin" param, and the desktop app's GenerateParams.Origin.
func ParseOrigin(s string) (x, y, z int, err error) {
	parts := strings.Split(s, ",")
	if len(parts) != 3 {
		return 0, 0, 0, fmt.Errorf("origin must be \"x,y,z\", got %q", s)
	}
	vals := make([]int, 3)
	for i, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return 0, 0, 0, fmt.Errorf("origin: %q is not an integer", p)
		}
		vals[i] = v
	}
	return vals[0], vals[1], vals[2], nil
}

// ParseSize parses "XxYxZ" (all three required, positive decimal integers) -- shared by
// generate's --size flag, serve's "size" param, and the desktop app's GenerateParams.Size.
func ParseSize(s string) (x, y, z int, err error) {
	parts := strings.Split(strings.ToLower(s), "x")
	if len(parts) != 3 {
		return 0, 0, 0, fmt.Errorf("size must be \"XxYxZ\", got %q", s)
	}
	vals := make([]int, 3)
	for i, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return 0, 0, 0, fmt.Errorf("size: %q is not an integer", p)
		}
		if v <= 0 {
			return 0, 0, 0, fmt.Errorf("size: %q must be positive", p)
		}
		vals[i] = v
	}
	return vals[0], vals[1], vals[2], nil
}
