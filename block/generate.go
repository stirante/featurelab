package block

import "sort"

// GeneratedAlias describes an already-known block alias for the
// vanilla-block-pack generator. Runtime code continues to consume the same
// tables, so the generated catalogue cannot drift to a separately maintained
// copy.
type GeneratedAlias struct {
	Target        string
	Discriminator string
	Targets       map[string]string
}

// GeneratedKind returns the current branch-relevant classification for a
// canonical vanilla block name. It is intentionally an export for the
// generator, not a second classification API for runtime callers.
func GeneratedKind(name string) Kind { return classify(canonicalName(name), nil) }

// GeneratedKindName renders a Kind into the stable spelling stored in the
// generated pack.
func GeneratedKindName(kind Kind) string {
	switch kind {
	case KindAir:
		return "air"
	case KindLiquid:
		return "liquid"
	case KindPlant:
		return "plant"
	case KindGlass:
		return "glass"
	default:
		return "solid"
	}
}

// GeneratedAliases returns a detached, deterministically ordered view of the
// alias data already recorded in aliases.go.
func GeneratedAliases() map[string]GeneratedAlias {
	out := make(map[string]GeneratedAlias, len(simpleBlockAliases)+len(treeComplexAliases))
	for source, target := range simpleBlockAliases {
		out[source] = GeneratedAlias{Target: target}
	}
	for source, alias := range treeComplexAliases {
		targets := make(map[string]string, len(alias.targets))
		keys := make([]string, 0, len(alias.targets))
		for value := range alias.targets {
			keys = append(keys, value)
		}
		sort.Strings(keys)
		for _, value := range keys {
			targets[value] = alias.targets[value]
		}
		out[source] = GeneratedAlias{Discriminator: alias.discriminator, Targets: targets}
	}
	return out
}
