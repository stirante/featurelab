// annotate.go implements serve's "annotate" method: the one way an editor
// records a directive in a pack file's comments.
//
// It is the sibling of apply.go, and it exists for the same reason that one
// does -- the hard part is already here. jsonc.SetAnnotation knows where a
// comment has to sit for ParseAnnotations to attach it back to the path it was
// written for, which is a question with four answers depending on what else is
// on the line, and it knows how to change an existing directive in place
// without disturbing the comment around it. A TypeScript reimplementation of
// that would be a second set of attachment rules, and the first time the two
// disagreed the symptom would be a directive the editor writes and then cannot
// find.
//
// WHAT WAS MISSING BEFORE THIS FILE. The whole annotation mechanism read from
// the file and wrote nothing to it. jsonc could insert a directive
// (InsertAnnotation, tested), wire carried them out to the editor, the editor
// had a change kind for asking that one be written -- and there was no method
// between the last two, so every "record this in the file" action in the
// product ended at a change event nobody could act on.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/stirante/featurelab/jsonc"
)

type annotateParams struct {
	// File is pack-relative, exactly as wire.GraphNode.File reports it.
	File string `json:"file"`
	// Path is the node or edge the directive is ABOUT, in jsonc.FormatPath's
	// dialect -- the same spelling wire.GraphEdge.JSONPath and
	// wire.Annotation.JSONPath use. It is not where the comment goes; where a
	// comment has to go so that it reads back as annotating this path is
	// jsonc.AnnotationPointFor's business.
	Path string `json:"path"`
	// Name is the directive without the `@featurelab:` prefix.
	Name string `json:"name"`
	// Args is everything after it. Whitespace-split on the way back in, so an
	// argument containing a space is refused here rather than written and
	// discovered later.
	Args []string `json:"args,omitempty"`
}

// methodAnnotate records one directive on one path and re-reads the file.
//
// Re-reading matters more than it looks: an annotation is not a value the game
// sees, but it IS part of the graph the editor draws (wire.GraphNode.Annotations),
// so a panel that wrote one and did not reload would keep showing a graph in
// which the directive it just wrote does not exist -- and the next thing the
// author did would be undone by a refresh that disagreed.
func methodAnnotate(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p annotateParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	if strings.TrimSpace(p.File) == "" {
		return nil, fmt.Errorf("malformed params: \"file\" is required -- name the file to annotate")
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, fmt.Errorf("malformed params: \"path\" is required -- name what the directive is about")
	}
	if strings.TrimSpace(p.Name) == "" {
		return nil, fmt.Errorf("malformed params: \"name\" is required -- a directive needs a name")
	}

	full, err := resolveInPack(state.loaded.Dir, p.File)
	if err != nil {
		return nil, err
	}
	src, err := os.ReadFile(full)
	if err != nil {
		return nil, fmt.Errorf("annotate: reading %s: %v", p.File, err)
	}

	out, err := jsonc.SetAnnotation(src, p.Path, p.Name, p.Args...)
	if err != nil {
		return nil, fmt.Errorf("annotate: %s: %v", p.File, err)
	}
	// Identical bytes are not written at all, for the reason applyEdits gives:
	// an mtime change is an edit to every watcher in the editor, and a toggle
	// set to the value it already had must not look like one.
	if string(out) == string(src) {
		return map[string]any{"file": p.File, "changed": false}, nil
	}
	if err := os.WriteFile(full, out, 0o644); err != nil {
		return nil, fmt.Errorf("annotate: writing %s: %v", p.File, err)
	}
	if err := state.loaded.ReloadFile(full); err != nil {
		return nil, err
	}
	state.workspace.Update(state.loaded.Features, state.loaded.Structures, state.loaded.Rules, state.loaded.Biomes, state.loaded.Blocks)
	return map[string]any{"file": p.File, "changed": true}, nil
}

// annotateOp is one step of an "annotateBatch": the same three coordinates
// "annotate" takes, plus Remove, which takes the directive OUT instead of
// writing it. Args are ignored on a removal.
type annotateOp struct {
	File   string   `json:"file"`
	Path   string   `json:"path"`
	Name   string   `json:"name"`
	Args   []string `json:"args,omitempty"`
	Remove bool     `json:"remove,omitempty"`
}

type annotateBatchParams struct {
	Ops []annotateOp `json:"ops"`
}

// methodAnnotateBatch records or removes several directives across several
// files as one operation.
//
// It exists because a feature group is one fact stated in several files: each
// member carries the group directive, and renaming, collapsing or dissolving
// the group means rewriting every one of them. Sent as N "annotate" calls that
// is N reloads, N workspace rebuilds and N graph refreshes for the editor to
// draw through -- and, worse, N chances to stop half way, leaving a group whose
// members disagree about its own name.
//
// So the batch is VALIDATED WHOLE BEFORE ANYTHING IS WRITTEN. Every file is
// read, every op applied to the bytes in memory in the order given, and only
// when all of them succeed is any file written. A refused op -- a path outside
// the pack, a file that does not scan, a comment that cannot be safely deleted
// -- leaves the pack exactly as it was. Then each changed file is written and
// reloaded once, and the workspace is updated once at the end.
//
// Ops on one file apply in sequence to the SAME bytes, so a batch may remove a
// directive and write another to the same file and get what it asked for.
// Identical bytes are not written, for the reason methodAnnotate gives.
func methodAnnotateBatch(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p annotateBatchParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	if len(p.Ops) == 0 {
		return nil, fmt.Errorf("malformed params: \"ops\" is required and must name at least one directive")
	}

	type fileWork struct {
		rel     string
		full    string
		before  []byte
		current []byte
	}
	var order []string
	work := map[string]*fileWork{}

	for i, op := range p.Ops {
		if strings.TrimSpace(op.File) == "" {
			return nil, fmt.Errorf("malformed params: ops[%d] has no \"file\"", i)
		}
		if strings.TrimSpace(op.Path) == "" {
			return nil, fmt.Errorf("malformed params: ops[%d] has no \"path\"", i)
		}
		if strings.TrimSpace(op.Name) == "" {
			return nil, fmt.Errorf("malformed params: ops[%d] has no \"name\"", i)
		}
		full, err := resolveInPack(state.loaded.Dir, op.File)
		if err != nil {
			return nil, err
		}
		fw, seen := work[full]
		if !seen {
			src, err := os.ReadFile(full)
			if err != nil {
				return nil, fmt.Errorf("annotateBatch: reading %s: %v", op.File, err)
			}
			fw = &fileWork{rel: op.File, full: full, before: src, current: src}
			work[full] = fw
			order = append(order, full)
		}
		var out []byte
		if op.Remove {
			out, err = jsonc.RemoveAnnotation(fw.current, op.Path, op.Name)
		} else {
			out, err = jsonc.SetAnnotation(fw.current, op.Path, op.Name, op.Args...)
		}
		if err != nil {
			return nil, fmt.Errorf("annotateBatch: %s: %v (nothing was written)", op.File, err)
		}
		fw.current = out
	}

	files := make([]map[string]any, 0, len(order))
	changed := 0
	for _, full := range order {
		fw := work[full]
		if string(fw.current) == string(fw.before) {
			files = append(files, map[string]any{"file": fw.rel, "changed": false})
			continue
		}
		if err := os.WriteFile(full, fw.current, 0o644); err != nil {
			return nil, fmt.Errorf("annotateBatch: writing %s: %v", fw.rel, err)
		}
		if err := state.loaded.ReloadFile(full); err != nil {
			return nil, err
		}
		files = append(files, map[string]any{"file": fw.rel, "changed": true})
		changed++
	}
	if changed > 0 {
		state.workspace.Update(state.loaded.Features, state.loaded.Structures, state.loaded.Rules, state.loaded.Biomes, state.loaded.Blocks)
	}
	return map[string]any{"files": files, "changed": changed}, nil
}
