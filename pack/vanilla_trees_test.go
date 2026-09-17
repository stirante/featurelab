package pack_test

import (
	"testing"

	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"
)

// TestVanillaTreeFeaturesAllBuildAndPlace guards the complete shipped corpus:
// every source file must parse, build into a concrete feature, and change the
// plains volume. A build-only assertion is insufficient because unresolved
// legacy block aliases make a valid tree refuse its trunk at placement time.
func TestVanillaTreeFeaturesAllBuildAndPlace(t *testing.T) {
	loaded, err := pack.Load(pack.Options{FeaturesDir: "testdata/vanilla-trees/features"})
	if err != nil {
		t.Fatalf("pack.Load: %v", err)
	}
	const want = 24
	if len(loaded.Features) != want {
		t.Fatalf("loaded %d feature files from testdata/vanilla-trees/features, want %d -- did the corpus move or shrink?", len(loaded.Features), want)
	}

	config, ok := session.DefaultConfig(env.EnvironmentID("plains"))
	if !ok {
		t.Fatal("plains environment is not registered")
	}
	// The default 48-block-tall preview can reject the maximum seed-1
	// mega-jungle height at its top bound before any placement is attempted.
	// Give the corpus test headroom so it tests tree generation, not preview
	// clipping.
	config.SizeY = 96

	for _, source := range loaded.Features {
		source := source
		t.Run(source.ID, func(t *testing.T) {
			identifier := "minecraft:" + source.ID[:len(source.ID)-len(".json")]
			config.FeatureIdentifier = &identifier
			result, err := session.Generate(config, loaded.Features, nil, nil, nil, nil)
			if err != nil {
				t.Fatalf("session.Generate: %v", err)
			}

			var built bool
			for _, entry := range result.Entries {
				if entry.FileID == source.ID {
					built = entry.Feature != nil
					break
				}
			}
			if !built {
				t.Fatalf("%s did not build; diagnostics: %+v", identifier, result.Diagnostics)
			}
			if result.BlocksPlaced == 0 {
				t.Fatalf("%s placed 0 blocks; diagnostics: %+v", identifier, result.Diagnostics)
			}
			t.Logf("%s: blocksPlaced=%d", source.ID, result.BlocksPlaced)
		})
	}
}
