// apply.go implements serve's "applyEdits" method: the one way an editor
// changes a pack file.
//
// It exists here, in Go, rather than in the editor because the hard part is
// already here. jsonc.Apply resolves every edit against the ORIGINAL bytes
// and splices, so a file keeps its comments, its indentation and the order
// its author wrote keys in -- and a pack file's comments are not decoration,
// they carry the editor's own directives. A second implementation of that in
// TypeScript would be a second thing to get right, and the first time the two
// disagreed the symptom would be a rewritten file nobody asked for.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/stirante/featurelab/jsonc"
	"github.com/stirante/featurelab/pack"
)

type applyEditsParams struct {
	// File is pack-relative, exactly as wire.GraphNode.File reports it.
	File  string          `json:"file"`
	Edits []applyEditWire `json:"edits"`
}

type applyEditWire struct {
	// Path is jsonc.FormatPath's dialect, rooted at the FILE -- the same
	// spelling and the same root wire.GraphEdge.JSONPath uses.
	Path string `json:"path"`
	// Value is the raw JSON to write, verbatim. It is json.RawMessage and not
	// `any` on purpose: re-marshalling a decoded value hands key order to
	// encoding/json, which sorts map keys, so a round-trip through `any` would
	// silently reorder every object an editor wrote back.
	Value json.RawMessage `json:"value,omitempty"`
	// Delete removes the member instead of setting it.
	Delete bool `json:"delete,omitempty"`
}

// methodApplyEdits applies a batch of edits to one pack file and re-reads it.
//
// The batch is applied in ONE jsonc.Apply call rather than one per edit,
// because Apply resolves all spans against the original bytes: applied
// separately, the second edit's offsets would be computed against a file the
// first had already moved.
//
// The whole call is refused if any edit is bad, and nothing is written. A
// partially applied batch would leave a file in a state the editor does not
// believe in and the author did not ask for, and "some of your change was
// saved" is the hardest kind of failure to recover from by hand.
func methodApplyEdits(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p applyEditsParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	if strings.TrimSpace(p.File) == "" {
		return nil, fmt.Errorf("malformed params: \"file\" is required -- name the file to edit")
	}
	if len(p.Edits) == 0 {
		return nil, fmt.Errorf("malformed params: \"edits\" is empty -- there is nothing to apply")
	}

	full, err := resolveInPack(state.loaded.Dir, p.File)
	if err != nil {
		return nil, err
	}
	src, err := os.ReadFile(full)
	if err != nil {
		return nil, fmt.Errorf("applyEdits: reading %s: %v", p.File, err)
	}

	edits := make([]jsonc.Edit, 0, len(p.Edits))
	for i, e := range p.Edits {
		if strings.TrimSpace(e.Path) == "" {
			return nil, fmt.Errorf("applyEdits: edit %d has no path", i)
		}
		if !e.Delete && len(e.Value) == 0 {
			return nil, fmt.Errorf("applyEdits: edit %d (%s) has neither a value nor delete", i, e.Path)
		}
		edits = append(edits, jsonc.Edit{Path: e.Path, Value: []byte(e.Value), Delete: e.Delete})
	}

	out, err := jsonc.Apply(src, edits...)
	if err != nil {
		return nil, fmt.Errorf("applyEdits: %s: %v", p.File, err)
	}
	// Nothing changed: do not touch the file at all. Rewriting identical bytes
	// would update its mtime, which every watcher in the editor reads as an
	// edit, and a save-storm of no-op edits is indistinguishable from real ones.
	if string(out) == string(src) {
		return map[string]any{"file": p.File, "changed": false}, nil
	}
	if err := os.WriteFile(full, out, 0o644); err != nil {
		return nil, fmt.Errorf("applyEdits: writing %s: %v", p.File, err)
	}

	// Re-read just this file, exactly as reloadFile does, so the next graph or
	// generate sees what is now on disk instead of what was there at load.
	if err := state.loaded.ReloadFile(full); err != nil {
		return nil, err
	}
	state.workspace.Update(state.loaded.Features, state.loaded.Structures, state.loaded.Rules, state.loaded.Biomes, state.loaded.Blocks)
	return map[string]any{"file": p.File, "changed": true}, nil
}

// resolveInPack turns a pack-relative path into an absolute one and refuses
// anything that escapes the pack.
//
// Its errors name no operation, because both writing methods call it and a
// refusal that says "applyEdits" to someone who was creating a node sends
// them looking at the wrong thing.
//
// This is the only place in the server that writes a file named by a caller,
// which makes it the only place a traversal would matter. `..` is not rejected
// by spelling -- a path can contain it legitimately and still stay inside --
// so the check is on the RESOLVED location: clean both sides, then require
// that the result really is under the pack directory. Rejecting the spelling
// instead would both miss symlinked escapes and refuse honest paths.
func resolveInPack(dir, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		// An absolute path is accepted only when it already points inside the
		// loaded pack: the editor knows real paths and it is the same check.
		if pack.SamePath(filepath.Dir(rel), dir) || strings.HasPrefix(cleanCase(rel), cleanCase(dir)+string(filepath.Separator)) {
			return filepath.Clean(rel), nil
		}
		return "", fmt.Errorf("%s is outside the loaded pack %s", rel, dir)
	}
	full := filepath.Clean(filepath.Join(dir, rel))
	if !strings.HasPrefix(cleanCase(full), cleanCase(filepath.Clean(dir))+string(filepath.Separator)) {
		return "", fmt.Errorf("%q resolves outside the loaded pack", rel)
	}
	return full, nil
}

// cleanCase normalises a path for comparison. Windows paths are
// case-insensitive and this tool is developed on it, so a comparison that
// respected case would let `FEATURES\x.json` past a check on `features\`.
func cleanCase(p string) string {
	if filepath.Separator != '/' {
		return strings.ToLower(filepath.Clean(p))
	}
	return filepath.Clean(p)
}

// createFilesParams names whole files to write, for a node the editor is
// creating. Separate from applyEdits because the two must fail differently:
// an edit to a file that is not there is a mistake, and a create over a file
// that IS there is a different mistake, and one operation covering both would
// have to pick a single wrong answer.
type createFilesParams struct {
	Files []createFileWire `json:"files"`
}

type createFileWire struct {
	// Path is pack-relative, as wire.GraphNode.File reports it.
	Path string `json:"path"`
	// Contents is the complete file. It is written verbatim -- the editor
	// composed it and knows the key order it wants, and re-encoding here
	// would hand that order to a serialiser that sorts map keys.
	Contents string `json:"contents"`
}

// methodCreateFiles writes new pack files and re-reads the pack.
//
// It refuses to overwrite. A create that silently replaced a file would be
// the worst kind of data loss in an editor: the author asked for something
// NEW, so the destroyed file is one they were not even looking at, and they
// have no reason to check it afterwards. A colliding identifier is a thing to
// report, not to resolve by guessing.
//
// The whole batch is checked before anything is written, because one compound
// node expands into several files and half a compound is not a thing the
// graph can describe -- the annotation would name children that do not exist.
func methodCreateFiles(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p createFilesParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	if len(p.Files) == 0 {
		return nil, fmt.Errorf("malformed params: \"files\" is empty -- there is nothing to create")
	}

	type planned struct{ full, rel string }
	plan := make([]planned, 0, len(p.Files))
	seen := make(map[string]bool, len(p.Files))
	for i, f := range p.Files {
		if strings.TrimSpace(f.Path) == "" {
			return nil, fmt.Errorf("createFiles: file %d has no path", i)
		}
		if strings.TrimSpace(f.Contents) == "" {
			return nil, fmt.Errorf("createFiles: %s has no contents", f.Path)
		}
		full, err := resolveInPack(state.loaded.Dir, f.Path)
		if err != nil {
			return nil, err
		}
		if seen[cleanCase(full)] {
			return nil, fmt.Errorf("createFiles: %s is named twice in one batch", f.Path)
		}
		seen[cleanCase(full)] = true
		if _, err := os.Stat(full); err == nil {
			return nil, fmt.Errorf("createFiles: %s already exists -- nothing was written", f.Path)
		} else if !os.IsNotExist(err) {
			return nil, fmt.Errorf("createFiles: %s: %v", f.Path, err)
		}
		plan = append(plan, planned{full: full, rel: f.Path})
	}

	// Past this point a failure can leave a partial batch on disk, which is
	// why every check that can be made was made above. What remains is the
	// filesystem refusing a write, and the honest thing then is to say which
	// files did land rather than to delete files this process created but did
	// not verify.
	written := make([]string, 0, len(plan))
	for i, f := range plan {
		if err := os.MkdirAll(filepath.Dir(f.full), 0o755); err != nil {
			return nil, fmt.Errorf("createFiles: %s: %v (wrote %v first)", f.rel, err, written)
		}
		if err := os.WriteFile(f.full, []byte(p.Files[i].Contents), 0o644); err != nil {
			return nil, fmt.Errorf("createFiles: %s: %v (wrote %v first)", f.rel, err, written)
		}
		written = append(written, f.rel)
	}

	// A new file is not a reload of an existing one: pack.Load's own walk is
	// what discovers it, so the pack is loaded again rather than patched.
	reloaded, err := pack.Load(state.loadOpts)
	if err != nil {
		return nil, fmt.Errorf("createFiles: re-reading the pack: %v", err)
	}
	state.loaded = reloaded
	state.workspace.Update(reloaded.Features, reloaded.Structures, reloaded.Rules, reloaded.Biomes, reloaded.Blocks)
	return map[string]any{"created": written}, nil
}

// regenerateParams rewrites a set of files that already exist and deletes a
// set that no longer should.
//
// It is deliberately NOT createFiles with a flag. createFiles refuses to
// overwrite, and that refusal is the whole reason it is safe to point at a
// path the editor composed: the author asked for something new, so a file in
// the way is a collision to report rather than a thing to replace.
// Regeneration is the opposite situation and has to say so in its own name --
// it replaces files this tool generated a moment ago, from parameters the
// author just edited.
type regenerateParams struct {
	// Owner is the compound whose expansion these files are. Recorded so the
	// refusals can name it, and so a caller cannot ask this method to rewrite
	// arbitrary pack files by pretending they belong to something.
	Owner string           `json:"owner"`
	Files []createFileWire `json:"files"`
	// Delete names files the new parameters no longer produce, pack-relative.
	Delete []string `json:"delete"`
}

// methodRegenerate replaces a compound's generated files and re-reads the pack.
//
// Every path is checked before anything is written or removed, for the same
// reason createFiles checks first: one compound is several files, and half a
// regeneration is a subgraph whose annotation names children that are not
// there.
//
// Deletion is the dangerous half, so it is the narrow one. A path is removed
// only if it currently holds a feature whose identifier starts with the
// owner's own name -- which is how every generated child is named. A file
// that does not look like the owner's is left alone and reported, because the
// alternative is a caller with a wrong id deleting somebody's features and
// this method having no way to tell.
func methodRegenerate(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p regenerateParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	if strings.TrimSpace(p.Owner) == "" {
		return nil, fmt.Errorf("malformed params: \"owner\" is required -- name the compound these files belong to")
	}
	if len(p.Files) == 0 && len(p.Delete) == 0 {
		return nil, fmt.Errorf("malformed params: there is nothing to write and nothing to remove")
	}

	writes := make([]struct{ full, rel, contents string }, 0, len(p.Files))
	for i, f := range p.Files {
		if strings.TrimSpace(f.Path) == "" {
			return nil, fmt.Errorf("regenerate: file %d has no path", i)
		}
		if strings.TrimSpace(f.Contents) == "" {
			return nil, fmt.Errorf("regenerate: %s has no contents", f.Path)
		}
		full, err := resolveInPack(state.loaded.Dir, f.Path)
		if err != nil {
			return nil, err
		}
		writes = append(writes, struct{ full, rel, contents string }{full, f.Path, f.Contents})
	}

	removals := make([]struct{ full, rel string }, 0, len(p.Delete))
	for _, rel := range p.Delete {
		full, err := resolveInPack(state.loaded.Dir, rel)
		if err != nil {
			return nil, err
		}
		src, err := os.ReadFile(full)
		if os.IsNotExist(err) {
			// Already gone. Nothing to do and nothing to complain about: the
			// end state the caller asked for is the state on disk.
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("regenerate: %s: %v", rel, err)
		}
		id := featureIdentifierIn(src)
		if !belongsTo(id, p.Owner) {
			return nil, fmt.Errorf(
				"regenerate: refusing to delete %s -- it declares %q, which is not one of %s's own generated features; nothing was written",
				rel, id, p.Owner)
		}
		removals = append(removals, struct{ full, rel string }{full, rel})
	}

	for _, w := range writes {
		if err := os.MkdirAll(filepath.Dir(w.full), 0o755); err != nil {
			return nil, fmt.Errorf("regenerate: %s: %v", w.rel, err)
		}
		if err := os.WriteFile(w.full, []byte(w.contents), 0o644); err != nil {
			return nil, fmt.Errorf("regenerate: %s: %v", w.rel, err)
		}
	}
	removed := make([]string, 0, len(removals))
	for _, r := range removals {
		if err := os.Remove(r.full); err != nil {
			return nil, fmt.Errorf("regenerate: removing %s: %v", r.rel, err)
		}
		removed = append(removed, r.rel)
	}

	reloaded, err := pack.Load(state.loadOpts)
	if err != nil {
		return nil, fmt.Errorf("regenerate: re-reading the pack: %v", err)
	}
	state.loaded = reloaded
	state.workspace.Update(reloaded.Features, reloaded.Structures, reloaded.Rules, reloaded.Biomes, reloaded.Blocks)
	return map[string]any{"written": len(writes), "removed": removed}, nil
}

// belongsTo reports whether a feature identifier is the owner or one of the
// owner's generated children.
//
// The separator is the whole point. A bare prefix test says
// "demo:switchgrass" belongs to "demo:sw", which is somebody's own feature and
// not a generated anything -- and the consequence of getting this wrong is a
// deleted file the author never hears about. Every generated child is named
// "<owner>__<role>" (see the editor's CHILD_ROLES), so requiring the double
// underscore costs nothing and closes it.
//
// Case-insensitive because the engine matches identifiers that way, so two
// spellings are one feature as far as a pack is concerned.
func belongsTo(id, owner string) bool {
	if id == "" || owner == "" {
		return false
	}
	lower, lowerOwner := strings.ToLower(id), strings.ToLower(owner)
	return lower == lowerOwner || strings.HasPrefix(lower, lowerOwner+"__")
}

// featureIdentifierIn reads the identifier a feature file declares, or "" when
// the file is not one. Comments are stripped first: a generated file carries
// the editor's own directives, and the game's parser accepts them too.
func featureIdentifierIn(src []byte) string {
	var root map[string]any
	if err := json.Unmarshal(jsonc.StripComments(src), &root); err != nil {
		return ""
	}
	for key, value := range root {
		if !strings.HasPrefix(key, "minecraft:") {
			continue
		}
		body, ok := value.(map[string]any)
		if !ok {
			continue
		}
		description, ok := body["description"].(map[string]any)
		if !ok {
			continue
		}
		if id, ok := description["identifier"].(string); ok {
			return id
		}
	}
	return ""
}
