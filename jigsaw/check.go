package jigsaw

import (
	"fmt"

	"github.com/stirante/featurelab/structures"
	"github.com/stirante/featurelab/wgen"
)

// Check reports references the game would log or silently fail on at generation time: pools,
// processor lists, structure files, features and structures that do not exist.
func (l *Library) Check(templates *structures.Library, features wgen.FeatureResolver) []Diagnostic {
	if l == nil {
		return nil
	}
	var out []Diagnostic
	report := func(fileID, message string) {
		out = append(out, Diagnostic{Level: "error", FileID: fileID, Message: message})
	}
	for _, s := range l.Structures() {
		if l.pools[aliasedName(s, s.StartPool)] == nil {
			report(s.FileID, fmt.Sprintf("start_pool %q is not a template pool", s.StartPool))
		}
	}
	for _, pool := range l.sortedPools() {
		if l.pools[pool.fallback] == nil && !isEmptyPoolName(pool.fallback) {
			report(pool.fileID, fmt.Sprintf("fallback %q is not a template pool", pool.fallback))
		}
		seen := map[*poolElement]bool{}
		for _, element := range pool.elements {
			if seen[element] {
				continue
			}
			seen[element] = true
			out = append(out, l.checkElement(pool, element, templates, features)...)
		}
	}
	for _, set := range l.sets {
		for _, name := range set.structures {
			if l.structures[name] == nil {
				report(set.fileID, fmt.Sprintf("structure %q is not a jigsaw structure", name))
			}
		}
	}
	return out
}

func (l *Library) checkElement(pool *templatePool, element *poolElement, templates *structures.Library, features wgen.FeatureResolver) []Diagnostic {
	var out []Diagnostic
	report := func(message string) {
		out = append(out, Diagnostic{Level: "error", FileID: pool.fileID, Message: message})
	}
	switch element.kind {
	case elementSingle:
		resolved := templates.Resolve(structureNameFromLocation(element.location))
		if resolved == nil {
			report(fmt.Sprintf("location %q is not a structure file: the path after the namespace is looked up under structures/", element.location))
		} else if built, err := buildTemplate(resolved, l.palette); err != nil {
			report(fmt.Sprintf("location %q: %v", element.location, err))
		} else {
			out = append(out, l.checkConnectorPools(pool, element, built)...)
		}
		if element.processorList != "" && !isEmptyProcessorName(element.processorList) && l.processors[element.processorList] == nil {
			report(fmt.Sprintf("processors %q is not a processor list", element.processorList))
		}
	case elementFeature:
		if features != nil && features.Resolve(element.feature) == nil {
			report(fmt.Sprintf("feature %q is not a feature", element.feature))
		}
	}
	return out
}

func (l *Library) checkConnectorPools(pool *templatePool, element *poolElement, built *template) []Diagnostic {
	var out []Diagnostic
	for _, c := range built.connectors {
		if l.pools[c.pool] != nil || isEmptyPoolName(c.pool) || l.isAliasName(c.pool) {
			continue
		}
		out = append(out, Diagnostic{Level: "warning", FileID: pool.fileID, Message: fmt.Sprintf(
			"structure %q has a jigsaw block aiming at the pool %q, which does not exist: the game logs it and skips the block", element.location, c.pool)})
	}
	return out
}

func (l *Library) isAliasName(name string) bool {
	for _, s := range l.structures {
		if _, ok := s.Aliases[name]; ok {
			return true
		}
	}
	return false
}

func aliasedName(s *Structure, pool string) string {
	if target, ok := s.Aliases[pool]; ok {
		return target
	}
	return pool
}
