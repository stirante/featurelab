// serve.go implements the `serve` subcommand: newline-delimited JSON over
// stdin/stdout, one request per line, one response per line. This is the
// long-lived protocol a VS Code extension or a Wails desktop app drives --
// see this package's own charter (cmd/featurelab is the shared foundation
// for both) -- so it must survive a long session: a pack is loaded once via
// "loadPack" and every subsequent "generate" call reuses it, never
// re-reading disk. When one file changes underneath it, "reloadFile" re-reads
// THAT file and nothing else (see methodReloadFile) -- the edit-save-look
// loop, at the cost of the one file rather than the whole pack. A malformed
// request (bad JSON, unknown method, missing
// params) always produces an {"id":...,"error":{...}} response line and
// keeps the loop running -- it must never crash the process, since that
// would take down whichever long-lived UI is driving it.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/wire"
)

// Request mirrors the CLI/README-documented wire shape: {"id":...,
// "method":..., "params":{...}}. ID is `any` (not a fixed type) because a
// caller may use a number or a string for correlation -- this server only
// ever echoes it back verbatim, never interprets it.
type Request struct {
	ID     any             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// Response is either {"id":...,"result":...} or {"id":...,"error":{...}} --
// Result/Error are both omitempty so only the relevant one is ever present
// on the wire, matching the documented contract exactly.
type Response struct {
	ID     any            `json:"id"`
	Result any            `json:"result,omitempty"`
	Error  *ResponseError `json:"error,omitempty"`
}

// ResponseError is the {"message":...} shape named in the contract.
type ResponseError struct {
	Message string `json:"message"`
}

// serverState is what persists across requests in one `serve` session --
// today, just the one loaded pack's session.Workspace ("loadPack" builds it
// on the first call and updates it in place on every call after; "generate"
// requires it to already exist). Kept as its own type rather than package
// globals so a future test can spin up more than one independent server in
// the same process.
type serverState struct {
	// loadOpts is the options the current pack was loaded with, including any
	// directory overrides -- see methodLoadPack.
	loadOpts pack.Options
	// workspace owns the built feature/structure/rule libraries and the
	// palette for the currently loaded pack -- see session.Workspace's own
	// doc comment for the reuse/invalidation contract. nil until the first
	// "loadPack" call; methodGenerate reports a clear error rather than
	// dereferencing it while nil.
	workspace *session.Workspace
	// loaded is the pack the workspace was last built/updated from: the
	// same []SourceFile lists "loadPack" read off disk, kept rather than
	// dropped on the floor. That is what lets "reloadFile" re-read ONE
	// saved file and hand Update the other few thousand unchanged, instead
	// of walking the whole pack again to find the one line that moved --
	// the difference between a ~680ms save-to-preview and a ~10ms one.
	// Always non-nil exactly when workspace is: the two are set together
	// and never independently.
	loaded *pack.Pack
}

// errNoPackLoaded is the one answer every pack-dependent method gives
// before the first successful "loadPack". Shared, not re-worded per
// method, because a client keys its "load the pack, then retry" recovery
// off this exact sentence -- three near-identical spellings would be three
// chances for one of them to stop matching.
var errNoPackLoaded = errors.New("no pack loaded -- call loadPack first")

// runServe drives the newline-delimited request/response loop against in
// and out until in is exhausted (EOF, e.g. the driving process closed
// stdin) or a read error that isn't a clean EOF occurs. Returns nil on a
// clean EOF.
func runServe(in io.Reader, out io.Writer) error {
	state := &serverState{}
	scanner := bufio.NewScanner(in)
	// A generated volume's blocks/baseline arrays can be large (tens of
	// thousands of cells * several bytes of JSON each); the default 64KiB
	// scanner buffer would silently truncate a request/response line long
	// before that. 64MiB comfortably covers any volume size.Generate itself
	// bounds (session.WriteBudget's own scale).
	const maxLine = 64 * 1024 * 1024
	scanner.Buffer(make([]byte, 0, 64*1024), maxLine)

	writer := bufio.NewWriter(out)
	defer writer.Flush()

	for scanner.Scan() {
		line := scanner.Bytes()
		resp := handleLine(state, line)
		if err := writeResponse(writer, resp); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// handleLine parses and dispatches exactly one request line, recovering
// from any panic in the handler (a malformed but JSON-valid request could
// otherwise reach, say, a nil-pointer deref deep in a builder) so one bad
// line can never take the whole server down.
func handleLine(state *serverState, line []byte) (resp Response) {
	defer func() {
		if r := recover(); r != nil {
			resp = Response{ID: resp.ID, Error: &ResponseError{Message: fmt.Sprintf("internal error: %v", r)}}
		}
	}()

	var req Request
	trimmed := trimSpaceBytes(line)
	if len(trimmed) == 0 {
		// A blank line is not a request at all -- ignore it rather than
		// reporting a spurious "malformed" error for what is most likely
		// just a trailing newline.
		return Response{ID: nil}
	}
	if err := json.Unmarshal(trimmed, &req); err != nil {
		return Response{ID: nil, Error: &ResponseError{Message: "malformed request: " + err.Error()}}
	}

	result, err := dispatch(state, req)
	if err != nil {
		return Response{ID: req.ID, Error: &ResponseError{Message: err.Error()}}
	}
	return Response{ID: req.ID, Result: result}
}

func dispatch(state *serverState, req Request) (any, error) {
	switch req.Method {
	case "loadPack":
		return methodLoadPack(state, req.Params)
	case "generate":
		return methodGenerate(state, req.Params)
	case "generateGrown":
		return methodGenerateGrown(state, req.Params)
	case "reloadFile":
		return methodReloadFile(state, req.Params)
	case "regenerate":
		return methodRegenerate(state, req.Params)
	case "renameFeature":
		return methodRenameFeature(state, req.Params)
	case "deleteFeature":
		return methodDeleteFeature(state, req.Params)
	case "createFiles":
		return methodCreateFiles(state, req.Params)
	case "applyEdits":
		return methodApplyEdits(state, req.Params)
	case "annotate":
		return methodAnnotate(state, req.Params)
	case "annotateBatch":
		return methodAnnotateBatch(state, req.Params)
	case "graph":
		return methodGraph(state)
	case "types":
		return typesOutput(), nil
	case "environments":
		return environmentsOutput(), nil
	case "atlas":
		return methodAtlas(req.Params)
	case "":
		return nil, fmt.Errorf("malformed request: missing \"method\"")
	default:
		return nil, fmt.Errorf("unknown method %q -- expected one of loadPack, reloadFile, generate, generateGrown, graph, types, environments, atlas", req.Method)
	}
}

// loadPackParams mirrors packFlags -- the same four subdir overrides the
// CLI exposes as flags, here as JSON params.
type loadPackParams struct {
	Dir        string `json:"dir"`
	Features   string `json:"features"`
	Structures string `json:"structures"`
	Rules      string `json:"rules"`
	Biomes     string `json:"biomes"`
	Blocks     string `json:"blocks"`
}

type loadPackResult struct {
	Warnings       []string `json:"warnings"`
	FeatureCount   int      `json:"featureCount"`
	StructureCount int      `json:"structureCount"`
	RuleCount      int      `json:"ruleCount"`
	BiomeCount     int      `json:"biomeCount"`
}

func methodLoadPack(state *serverState, raw json.RawMessage) (any, error) {
	var p loadPackParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	opts := pack.Options{
		Dir: p.Dir, FeaturesDir: p.Features, StructuresDir: p.Structures, RulesDir: p.Rules, BiomesDir: p.Biomes,
		BlocksDir: p.Blocks,
	}
	loaded, err := pack.Load(opts)
	if err != nil {
		return nil, err
	}
	// Kept so a later whole-pack reload -- which creating a file needs, since
	// only the walk discovers a file that was not there before -- loads the
	// same pack this did. Rebuilding the options from loaded.Dir alone would
	// silently drop every directory override the caller passed, and the pack
	// would come back missing whichever kind lives outside the conventional
	// layout.
	state.loadOpts = opts
	// First loadPack of this server session builds the Workspace (pays the
	// full re-parse cost once); every loadPack after that updates it in
	// place, so a kind whose files didn't change (by content, not just
	// because this is a fresh []SourceFile off disk -- see Workspace.
	// Update's own doc comment) is never rebuilt. This is what makes the
	// edit-a-feature-file-then-reload loop cheap: only the changed kind
	// gets rebuilt, "generate" itself never rebuilds anything.
	if state.workspace == nil {
		state.workspace = session.NewWorkspace(loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	} else {
		state.workspace.Update(loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	}
	// The whole Pack is retained, not just its counts: "reloadFile" splices
	// one re-read file into these very lists -- see serverState.loaded.
	state.loaded = loaded
	return packResult(loaded), nil
}

// reloadFileParams is "reloadFile"'s request shape. Path is the one file to
// re-read (absolute, as an editor reports the document it just saved). Dir
// is optional and is a GUARD, not a selector: when given it must name the
// pack that is actually loaded, so a client with two pack roots open cannot
// quietly splice a file from one into the other's workspace and preview a
// pack that never existed on disk.
type reloadFileParams struct {
	Dir  string `json:"dir"`
	Path string `json:"path"`
}

// methodReloadFile implements "reloadFile" -- the single-file counterpart
// to "loadPack", and the reason the edit-save-look loop costs milliseconds
// instead of a second.
//
// "loadPack" re-reads and re-parses every file in the pack to discover the
// one the user just saved; on a real 3526-feature pack that is ~680ms warm
// (~1.05s cold) of which all but a few hundred microseconds is finding out
// that nothing else changed. This method reads exactly the saved file (see
// pack.Pack.ReloadFile for how it is spliced in, and for the new/deleted/
// foreign-path cases) and hands the rest of the pack to Workspace.Update
// straight out of memory. Update's per-kind content fingerprints then do
// what they always did: a kind whose files did not actually change is not
// rebuilt, so saving a feature file never re-parses the structures, and
// saving a file whose content round-tripped back to what it already was
// rebuilds nothing at all.
//
// Failure is always the caller's cue to fall back to "loadPack" -- every
// error here means "this method cannot answer for that path", never "your
// pack is broken" (a pack that fails to parse is still a successful reload
// with diagnostics, exactly as it is through "loadPack"). Callers are
// expected to treat ANY error as the fallback signal rather than matching
// on the message: an incremental reload is an optimisation, and the only
// safe thing to do when an optimisation cannot run is the slow path.
//
// The response is loadPackResult, byte-identical in shape to "loadPack"'s,
// so a client can use the two interchangeably -- including the warnings,
// which are the CURRENT pack's whole warning set, not just anything this
// one file produced. Those warnings are pack-level ("this pack has no
// biomes/ directory"), not per-file, and a client that renders them is
// rendering the state of the loaded pack; returning only this file's share
// of them would make every unrelated warning blink out of the UI on each
// save and come back on the next full reload. The one thing that can go
// stale as a result is a "directory does not exist" warning for a
// directory the user has since created -- it keeps reporting the state at
// last full load, which is exactly what it says it is.
func methodReloadFile(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var p reloadFileParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, fmt.Errorf("malformed params: \"path\" is required -- name the one file to re-read")
	}
	if dir := strings.TrimSpace(p.Dir); dir != "" && !pack.SamePath(dir, state.loaded.Dir) {
		return nil, fmt.Errorf("reloadFile: pack %s is loaded, not %s -- call loadPack for that pack instead", state.loaded.Dir, dir)
	}
	if err := state.loaded.ReloadFile(p.Path); err != nil {
		return nil, err
	}
	state.workspace.Update(state.loaded.Features, state.loaded.Structures, state.loaded.Rules, state.loaded.Biomes, state.loaded.Blocks)
	return packResult(state.loaded), nil
}

// packResult is the one place a loaded pack is turned into the wire result
// "loadPack" and "reloadFile" both answer with -- one function so the two
// cannot drift into reporting subtly different things about the same pack.
func packResult(loaded *pack.Pack) loadPackResult {
	return loadPackResult{
		Warnings:       loaded.Warnings,
		FeatureCount:   len(loaded.Features),
		StructureCount: len(loaded.Structures),
		RuleCount:      len(loaded.Rules),
		BiomeCount:     len(loaded.Biomes),
	}
}

func methodGenerate(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil {
		return nil, errNoPackLoaded
	}
	var params wire.GenerateParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	return wire.RunGenerateFromWorkspace(state.workspace, params)
}

// methodGenerateGrown implements the "generateGrown" method -- the "grow to fit and regenerate"
// action (wire.RunGenerateGrownFromWorkspace, see wire's own package doc comment,
// "Grow-and-regenerate") over the currently loaded Workspace. Same params shape as "generate";
// the response is a wire.GrownGenerateOutput (a normal generate response plus `grown`/
// `preGrowBounds` -- see that type's own doc comment), never a silently different contract a
// caller has to special-case parsing for.
func methodGenerateGrown(state *serverState, raw json.RawMessage) (any, error) {
	if state.workspace == nil {
		return nil, errNoPackLoaded
	}
	var params wire.GenerateParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	return wire.RunGenerateGrownFromWorkspace(state.workspace, params)
}

func writeResponse(w *bufio.Writer, resp Response) error {
	b, err := json.Marshal(resp)
	if err != nil {
		// json.Marshal only fails on unmarshalable values (channels,
		// funcs, cyclic structures) -- none of which this server ever
		// puts on a Response. Reported as a fresh error response rather
		// than silently dropping the line, so a caller waiting on this
		// request's id is never left hanging.
		fallback := Response{ID: resp.ID, Error: &ResponseError{Message: "internal error encoding response: " + err.Error()}}
		b, _ = json.Marshal(fallback)
	}
	if _, err := w.Write(b); err != nil {
		return err
	}
	if err := w.WriteByte('\n'); err != nil {
		return err
	}
	return w.Flush()
}

func trimSpaceBytes(b []byte) []byte {
	start, end := 0, len(b)
	for start < end && isSpace(b[start]) {
		start++
	}
	for end > start && isSpace(b[end-1]) {
		end--
	}
	return b[start:end]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}
