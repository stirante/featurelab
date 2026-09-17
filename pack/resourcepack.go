package pack

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stirante/featurelab/jsonc"
)

// ---------------------------------------------------------------------------
// Finding the pack's OWN resource pack
//
// Everything this package loaded before now lives in the BEHAVIOUR pack:
// features/, structures/, feature_rules/, biomes/, blocks/. But a block's
// APPEARANCE does not. blocks/**/*.json names texture KEYS
// ("mypack:limestone"), and the file that says which image a key means --
// textures/terrain_texture.json -- lives in a completely separate directory,
// the add-on's resource pack. Nothing in this repository located one before
// this file: internal/gencolors reads a VANILLA resource pack whose path the
// caller passes in, and the pack loader had no notion of an RP at all.
//
// The two packs of an add-on are linked by UUID, not by path, and that is the
// only link the format actually guarantees: the behaviour pack's
// manifest.json lists the resource pack's header UUID under "dependencies",
// and the resource pack declares that UUID under "header"."uuid" plus a
// module of type "resources". So the search is: look at every plausible
// neighbouring directory, read its manifest, and take the one this pack says
// it depends on.
//
// Two on-disk layouts cover essentially every real add-on:
//
//	<something>/MyAddon_bp/          <- behaviour pack
//	<something>/MyAddon_rp/          <- resource pack, a SIBLING
//
//	com.mojang/development_behavior_packs/MyAddon/
//	com.mojang/development_resource_packs/MyAddon/   <- a PARENT's sibling's child
//
// Both are searched. Nothing outside them is: this is a lookup that has to
// stay cheap and predictable, and a user whose layout is neither can always
// point at the directory explicitly, which is why the override exists and is
// checked first.
// ---------------------------------------------------------------------------

// ResourcePack is a located resource pack: where it is, how it was found,
// and whether it actually carries the one file block appearance needs.
type ResourcePack struct {
	// Dir is the resource pack root -- the directory containing
	// manifest.json and textures/.
	Dir string
	// Name is the resource pack's manifest header name, when it has one
	// that is not a .lang key. Purely for saying which pack was picked.
	Name string
	// TerrainTexturePath is Dir/textures/terrain_texture.json when that
	// file exists, "" when it does not. A resource pack without one
	// resolves no texture keys at all, which is worth saying out loud
	// rather than discovering as 67 missing textures.
	TerrainTexturePath string
	// How records which rule found this pack: "explicit" (the caller named
	// it), "manifest dependency" (the behaviour pack's manifest.json
	// depends on this pack's UUID), or "name convention" (no manifest link
	// was usable and the directory name matched). Reported so a user who
	// gets the wrong pack can see why.
	How string
}

// resourcePackDirName is the conventional textures subdirectory and file
// every resource pack keeps its texture key table in.
const terrainTextureRelPath = "textures/terrain_texture.json"

// manifestJSON is the part of a manifest.json this lookup reads. Comments
// are stripped before decoding: pack manifests routinely carry them.
type manifestJSON struct {
	Header struct {
		Name string `json:"name"`
		UUID string `json:"uuid"`
	} `json:"header"`
	Modules []struct {
		Type string `json:"type"`
	} `json:"modules"`
	Dependencies []struct {
		UUID string `json:"uuid"`
	} `json:"dependencies"`
}

func readManifest(dir string) (manifestJSON, bool) {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return manifestJSON{}, false
	}
	var m manifestJSON
	if err := json.Unmarshal(jsonc.StripComments(b), &m); err != nil {
		return manifestJSON{}, false
	}
	return m, true
}

func (m manifestJSON) isResourcePack() bool {
	for _, mod := range m.Modules {
		if strings.EqualFold(mod.Type, "resources") {
			return true
		}
	}
	return false
}

// FindResourcePack locates the resource pack belonging to the behaviour
// pack rooted at packDir.
//
// override, when non-empty, is used as-is and never searched around --
// someone who names a directory means that directory, and silently
// substituting a "better" match for it would be the worst possible
// behaviour for a flag that exists precisely to escape the search.
//
// It returns (nil, notes, nil) when no resource pack could be found: that
// is NOT an error. A behaviour pack with no resource pack is a perfectly
// ordinary thing (every pack in this repository's own fixtures is one), and
// the caller's answer is the same one the tool gives today -- draw the
// pack's blocks with their fallback colour. notes explains what was looked
// for either way, so "found nothing" never reads as "did not look".
func FindResourcePack(packDir, override string) (*ResourcePack, []string, error) {
	var notes []string

	if strings.TrimSpace(override) != "" {
		rp := &ResourcePack{Dir: override, How: "explicit"}
		st, err := os.Stat(override)
		if err != nil || !st.IsDir() {
			return nil, notes, fmt.Errorf("resource pack directory %q does not exist", override)
		}
		if m, ok := readManifest(override); ok {
			rp.Name = manifestDisplayName(m)
			if !m.isResourcePack() {
				notes = append(notes, fmt.Sprintf(
					"%s was given as the resource pack but its manifest declares no \"resources\" module -- using it anyway, as asked", override))
			}
		}
		rp.TerrainTexturePath = terrainTextureIn(override)
		if rp.TerrainTexturePath == "" {
			notes = append(notes, fmt.Sprintf(
				"resource pack %s has no %s -- no custom block texture resolves through it", override, terrainTextureRelPath))
		}
		return rp, notes, nil
	}

	if strings.TrimSpace(packDir) == "" {
		return nil, notes, nil
	}
	packDir, err := filepath.Abs(packDir)
	if err != nil {
		return nil, notes, nil
	}

	wanted := map[string]bool{}
	if m, ok := readManifest(packDir); ok {
		for _, dep := range m.Dependencies {
			if dep.UUID != "" {
				wanted[strings.ToLower(dep.UUID)] = true
			}
		}
	} else {
		notes = append(notes, fmt.Sprintf(
			"%s has no readable manifest.json, so its resource pack could not be identified by UUID -- falling back to directory naming", packDir))
	}

	candidates := resourcePackCandidates(packDir)

	// Pass 1: the manifest link, which is the only association the add-on
	// format actually guarantees.
	var byName *ResourcePack
	for _, dir := range candidates {
		m, ok := readManifest(dir)
		if !ok || !m.isResourcePack() {
			continue
		}
		if wanted[strings.ToLower(m.Header.UUID)] {
			rp := &ResourcePack{Dir: dir, Name: manifestDisplayName(m), How: "manifest dependency",
				TerrainTexturePath: terrainTextureIn(dir)}
			if rp.TerrainTexturePath == "" {
				notes = append(notes, fmt.Sprintf(
					"resource pack %s has no %s -- no custom block texture resolves through it", dir, terrainTextureRelPath))
			}
			return rp, notes, nil
		}
		// Pass 2 material: a real resource pack this behaviour pack does
		// not claim to depend on, but whose directory name pairs with it.
		if byName == nil && namesPair(filepath.Base(packDir), filepath.Base(dir)) {
			byName = &ResourcePack{Dir: dir, Name: manifestDisplayName(m), How: "name convention",
				TerrainTexturePath: terrainTextureIn(dir)}
		}
	}
	if byName != nil {
		notes = append(notes, fmt.Sprintf(
			"%s does not list %s as a manifest dependency; matched it by directory name instead", filepath.Base(packDir), byName.Dir))
		if byName.TerrainTexturePath == "" {
			notes = append(notes, fmt.Sprintf(
				"resource pack %s has no %s -- no custom block texture resolves through it", byName.Dir, terrainTextureRelPath))
		}
		return byName, notes, nil
	}

	notes = append(notes, fmt.Sprintf(
		"no resource pack found for %s (looked in %d neighbouring directories for a manifest declaring a \"resources\" module); "+
			"the pack's own blocks keep their fallback colour -- pass the resource pack directory explicitly to change that",
		packDir, len(candidates)))
	return nil, notes, nil
}

// resourcePackCandidates lists the directories a resource pack could
// plausibly be, for a behaviour pack at packDir: every sibling of packDir,
// plus every child of a sibling of packDir's PARENT whose name mentions
// resources (the com.mojang development_behavior_packs /
// development_resource_packs layout). Sorted and deduplicated so the search
// is deterministic.
func resourcePackCandidates(packDir string) []string {
	seen := map[string]bool{packDir: true}
	var out []string
	add := func(dir string) {
		if dir == "" || seen[dir] {
			return
		}
		seen[dir] = true
		out = append(out, dir)
	}

	parent := filepath.Dir(packDir)
	for _, sib := range childDirs(parent) {
		add(sib)
	}
	grandparent := filepath.Dir(parent)
	if grandparent != parent {
		for _, uncle := range childDirs(grandparent) {
			if uncle == parent || !strings.Contains(strings.ToLower(filepath.Base(uncle)), "resource") {
				continue
			}
			for _, dir := range childDirs(uncle) {
				add(dir)
			}
		}
	}
	sort.Strings(out)
	return out
}

func childDirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	return out
}

func terrainTextureIn(dir string) string {
	path := filepath.Join(dir, filepath.FromSlash(terrainTextureRelPath))
	if st, err := os.Stat(path); err == nil && !st.IsDir() {
		return path
	}
	return ""
}

// manifestDisplayName returns a manifest header name worth printing. A
// pack whose name is a .lang key ("pack.name") is not -- that string tells
// a user nothing, so it is dropped rather than shown.
func manifestDisplayName(m manifestJSON) string {
	name := strings.TrimSpace(m.Header.Name)
	if name == "" || strings.HasPrefix(name, "pack.") {
		return ""
	}
	return name
}

// bpSuffixes / rpSuffixes are the directory-name conventions add-on
// authors actually use to pair the two halves of an add-on. Longest first,
// so "_behavior_pack" is not matched as "_bp" would be.
var bpSuffixes = []string{"_behavior_packs", "_behaviour_packs", "_behavior_pack", "_behaviour_pack",
	"_behaviors", "_behaviours", "_behavior", "_behaviour", "_bp", "bp", "-bp"}
var rpSuffixes = []string{"_resource_packs", "_resource_pack", "_resources", "_resource", "_rp", "rp", "-rp"}

// namesPair reports whether bpName and rpName look like the two halves of
// one add-on -- the same stem with a behaviour-pack suffix on one and a
// resource-pack suffix on the other. Used only as a fallback when the
// manifest dependency link is missing or does not resolve.
func namesPair(bpName, rpName string) bool {
	bpStem, ok := trimAnySuffix(strings.ToLower(bpName), bpSuffixes)
	if !ok {
		return false
	}
	rpStem, ok := trimAnySuffix(strings.ToLower(rpName), rpSuffixes)
	if !ok {
		return false
	}
	return bpStem == rpStem
}

func trimAnySuffix(name string, suffixes []string) (string, bool) {
	for _, suffix := range suffixes {
		if stem, cut := strings.CutSuffix(name, suffix); cut && stem != "" {
			return stem, true
		}
	}
	return "", false
}
