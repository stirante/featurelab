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
//
// # Cancellation
//
// A "cancel" request, {"method":"cancel","params":{"id":<id>}}, stops the request with that id.
// It is answered immediately, out of turn, with {"cancelled":true|false} -- true meaning the
// signal reached a request that was still running. The CANCELLED request then answers, whenever
// it actually unwinds, with {"error":{"message":"request cancelled","code":"cancelled"}} and
// never with a partial result; see handleRequest. Cancelling an id that has already finished, or
// one that never existed, is a harmless {"cancelled":false}.
//
// Only the methods that can take seconds honour it -- see dispatch for which, and for why the
// pack-loading and file-writing methods deliberately do not.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/stirante/featurelab/biomes"
	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/rules"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/structures"
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

// ResponseError is the {"message":...} shape named in the contract, plus an OPTIONAL machine-
// readable code.
//
// Code is omitempty and was added after the fact, so a client that never looks at it reads
// exactly the responses it always did. It exists for one case: a request the caller itself
// cancelled. That is the only error in this protocol whose right handling is "say nothing and
// carry on" rather than "show the user what went wrong", and telling it apart by matching on
// Message would be a client keyed to an English sentence. See errCancelledCode.
type ResponseError struct {
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

// errCancelledCode is ResponseError.Code on the one error a client must NOT surface as a
// failure: the request was cancelled, by that client, on purpose.
const errCancelledCode = "cancelled"

// cancelledResponse is the single answer a cancelled request gets. One function so the wording
// and the code cannot drift between the several places that produce it.
func cancelledResponse(id any) Response {
	return Response{ID: id, Error: &ResponseError{Message: "request cancelled", Code: errCancelledCode}}
}

// serverState is what persists across requests in one `serve` session --
// today, just the one loaded pack's session.Workspace ("loadPack" builds it
// on the first call and updates it in place on every call after; "generate"
// requires it to already exist). Kept as its own type rather than package
// globals so a future test can spin up more than one independent server in
// the same process.
type serverState struct {
	// mu guards inflight/nextSeq ONLY, and nothing else on this struct. Everything below it is
	// touched by the worker goroutine alone (see runServe), which is what keeps session.
	// Workspace's "not safe for concurrent use" contract intact without a lock around the
	// pack itself.
	mu sync.Mutex
	// inflight maps a request's canonical id (see requestKey) to the cancel func of every
	// request currently running under it, so "cancel" can reach one.
	//
	// A SLICE per id, not one entry, because nothing stops a client reusing an id it has
	// already used for a request that has not finished. That is the client's own conflation,
	// and the only honest reading of "cancel 7" from a client with two 7s in flight is to
	// cancel both -- an arbitrary pick would silently leave one of them running.
	inflight map[string][]inflightRequest
	// nextSeq numbers inflight entries so one can be removed when it finishes without removing
	// a sibling that shares its id.
	nextSeq uint64

	// notify writes one out-of-band line -- see notify.go for the contract
	// that makes those safe to interleave with responses. nil when there is
	// nobody to write to (handleLine, which tests drive directly) or when the
	// caller asked for none (`serve -quiet`), and every producer treats nil as
	// "say nothing" rather than branching on it.
	notify func(Notification)

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

// inflightRequest is one running request's cancel handle -- see serverState.inflight.
type inflightRequest struct {
	seq    uint64
	cancel context.CancelFunc
}

// queued is one line on its way to the worker: either a request to dispatch, or a response that
// is already decided (a blank line, a line that is not JSON).
//
// A DECIDED response travels through the queue rather than being written the moment it is
// decided, and that is not an oversight. Responses to ordinary requests come out in the order
// the requests arrived, and a malformed line that answered itself immediately would overtake a
// generate still running ahead of it -- turning "the engine answers in order" into "the engine
// answers in order except when it doesn't", for no gain. The ONE method that deliberately jumps
// the queue is "cancel", because a cancel that waited its turn behind the request it is meant to
// cancel would do nothing at all.
type queued struct {
	req  Request
	resp *Response
	ctx  context.Context
	key  string
	seq  uint64
}

// requestQueueDepth bounds how far the reader may run ahead of the worker.
//
// It is what keeps "cancel" answerable: the reader goroutine is the one that handles cancel, so
// it must not be blocked behind a full queue while a long generate runs. One client sends one or
// two requests at a time, so this is orders of magnitude above anything real; a client that
// actually fills it has 256 requests unanswered, at which point making it wait is the correct
// answer rather than a failure.
const requestQueueDepth = 256

// runServe drives the newline-delimited request/response loop against in
// and out until in is exhausted (EOF, e.g. the driving process closed
// stdin) or a read error that isn't a clean EOF occurs. Returns nil on a
// clean EOF.
//
// TWO GOROUTINES, and exactly two. The reader parses lines; ONE worker dispatches them, in
// arrival order, one at a time. That split is what "cancel" needs and the only reason it exists:
// while a request runs, something has to be reading the next line, or the cancel for the running
// request sits unread in a pipe buffer until the work it would have stopped has finished.
//
// The worker is single, not a pool, because the state it dispatches against is not safe for
// concurrent use (session.Workspace says so itself) and because request ORDER is part of this
// protocol: a "generate" sent after a "reloadFile" must see the reloaded pack. Serialising the
// WORK was never what stood in cancellation's way -- serialising the READING was.
func runServe(in io.Reader, out io.Writer) error {
	return runServeOptions(in, out, serveOptions{})
}

// serveOptions is what the `serve` subcommand's flags set. Its zero value is
// the documented default behaviour, so a caller (including every existing
// test) that does not care passes nothing.
type serveOptions struct {
	// Quiet suppresses every notification line -- the readiness line and all
	// progress lines -- leaving stdout carrying nothing but responses, exactly
	// as it did before notify.go existed. For a client that asserts each line
	// is a response instead of checking for an "id" member.
	Quiet bool
}

func runServeOptions(in io.Reader, out io.Writer, opts serveOptions) error {
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

	// Responses are written from both goroutines -- the worker for everything it dispatches, the
	// reader for a "cancel" -- so the writer needs a lock. writeErr is sticky: once stdout has
	// failed there is nobody left to tell, and every later response is dropped rather than
	// retried against a broken pipe.
	var writeMu sync.Mutex
	var writeErr error
	emit := func(resp Response) {
		writeMu.Lock()
		defer writeMu.Unlock()
		if writeErr != nil {
			return
		}
		writeErr = writeResponse(writer, resp)
	}
	failed := func() bool {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeErr != nil
	}

	if !opts.Quiet {
		// Set BEFORE the readiness line, so a host that reacts to readiness by
		// sending loadPack immediately cannot race a state that is not yet
		// able to report progress for it.
		state.notify = func(n Notification) {
			writeMu.Lock()
			defer writeMu.Unlock()
			if writeErr != nil {
				return
			}
			writeErr = writeNotification(writer, n)
		}
		// Emitted before the first line is READ, not merely before the first
		// response: "ready" has to mean "send me something", and a line written
		// after the first request had already arrived would be saying so too
		// late to be worth saying.
		state.notify(readyNotification())
	}

	queue := make(chan queued, requestQueueDepth)
	var worker sync.WaitGroup
	worker.Add(1)
	go func() {
		defer worker.Done()
		for item := range queue {
			emit(runQueued(state, item))
		}
	}()

	for scanner.Scan() {
		item := state.accept(scanner.Bytes())
		if item.jump {
			// "cancel", and only "cancel" -- see queued's own comment.
			emit(*item.queued.resp)
		} else {
			queue <- item.queued
		}
		if failed() {
			break
		}
	}
	// Closed and waited on before either error is reported, so the worker always finishes the
	// requests it was already handed and every one of them gets its response line, even on the
	// way out.
	close(queue)
	worker.Wait()

	if writeErr != nil {
		return writeErr
	}
	return scanner.Err()
}

// accepted is what one input line turned into: the queue item, plus whether it must skip the
// queue entirely.
type accepted struct {
	queued queued
	jump   bool
}

// accept parses one input line on the READER goroutine and decides what happens to it. Cheap by
// construction -- a JSON unmarshal of one request envelope and, for "cancel", a map lookup --
// because everything it does happens while the worker may be mid-placement, and the whole point
// of that goroutine is that it stays available.
//
// The Request it produces owns all of its own memory and none of line's, which is what makes it
// safe to hand to another goroutine while this one reads the next line over the same scanner
// buffer: Method and ID are decoded values, and json.RawMessage copies rather than aliasing
// (its UnmarshalJSON appends into a fresh slice). Anything added to Request later has to keep
// that property.
func (s *serverState) accept(line []byte) accepted {
	trimmed := trimSpaceBytes(line)
	if len(trimmed) == 0 {
		// A blank line is not a request at all -- ignore it rather than
		// reporting a spurious "malformed" error for what is most likely
		// just a trailing newline.
		return accepted{queued: queued{resp: &Response{ID: nil}}}
	}
	var req Request
	if err := json.Unmarshal(trimmed, &req); err != nil {
		return accepted{queued: queued{resp: &Response{ID: nil, Error: &ResponseError{Message: "malformed request: " + err.Error()}}}}
	}
	if req.Method == "cancel" {
		resp := methodCancel(s, req)
		return accepted{queued: queued{resp: &resp}, jump: true}
	}
	ctx, key, seq := s.register(req.ID)
	return accepted{queued: queued{req: req, ctx: ctx, key: key, seq: seq}}
}

// register opens a cancellable context for one request and files its cancel func under the
// request's own id, so "cancel" can find it. An id of null cannot be addressed by a later
// cancel, so nothing is filed for it and key comes back empty -- the request still runs, it
// simply cannot be stopped, which is the only thing an unaddressable request can mean.
func (s *serverState) register(id any) (context.Context, string, uint64) {
	ctx, cancel := context.WithCancel(context.Background())
	key, ok := requestKey(id)
	if !ok {
		// Not leaked: runQueued cancels it on the way out like every other request's.
		s.mu.Lock()
		s.nextSeq++
		seq := s.nextSeq
		s.mu.Unlock()
		s.orphan(seq, cancel)
		return ctx, "", seq
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight == nil {
		s.inflight = make(map[string][]inflightRequest)
	}
	s.nextSeq++
	seq := s.nextSeq
	s.inflight[key] = append(s.inflight[key], inflightRequest{seq: seq, cancel: cancel})
	return ctx, key, seq
}

// orphan files the cancel func of a request that has no addressable id, under the reserved key
// no client id can produce. Nothing ever cancels these; they are filed only so unregister has
// exactly one thing to do and no request's context is ever dropped without being cancelled.
func (s *serverState) orphan(seq uint64, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight == nil {
		s.inflight = make(map[string][]inflightRequest)
	}
	s.inflight[unaddressableKey] = append(s.inflight[unaddressableKey], inflightRequest{seq: seq, cancel: cancel})
}

// unaddressableKey files requests with a null id. requestKey never returns it (it is not valid
// JSON for any value), so no "cancel" can ever name it.
const unaddressableKey = "\x00unaddressable"

// unregister cancels one finished request's context and drops its entry. Removing by seq rather
// than by id is what makes two in-flight requests sharing an id safe -- see serverState.inflight.
//
// Cancelling on the way out is what keeps context.WithCancel's own contract: every context it
// returns must be cancelled, whether or not anything went wrong, or the goroutine watching it
// stays alive for the life of the process. A cancel here is always AFTER the response is
// decided, so it can never turn a finished request into a cancelled one.
func (s *serverState) unregister(key string, seq uint64) {
	if key == "" {
		key = unaddressableKey
	}
	s.mu.Lock()
	entries := s.inflight[key]
	var done context.CancelFunc
	for i, e := range entries {
		if e.seq != seq {
			continue
		}
		done = e.cancel
		s.inflight[key] = append(entries[:i:i], entries[i+1:]...)
		break
	}
	if len(s.inflight[key]) == 0 {
		delete(s.inflight, key)
	}
	s.mu.Unlock()
	if done != nil {
		done()
	}
}

// requestKey canonicalises a request id into the map key "cancel" looks up.
//
// Through JSON, the id 7 arrives as float64(7) on the request and float64(7) again in a cancel's
// params, so marshalling both back to JSON text makes them the same key without this code having
// to know or care whether a client numbers its requests or names them. null is not addressable
// and reports false rather than keying on "null", which would make one id-less request
// cancellable by a cancel aimed at another.
func requestKey(id any) (string, bool) {
	if id == nil {
		return "", false
	}
	b, err := json.Marshal(id)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// runQueued executes one queue item on the worker goroutine and produces its response line.
func runQueued(state *serverState, item queued) Response {
	if item.resp != nil {
		return *item.resp
	}
	ctx := item.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	defer state.unregister(item.key, item.seq)
	return handleRequest(state, ctx, item.req)
}

// handleLine parses and dispatches exactly one request line synchronously, with no queue and no
// worker -- the shape runServe's loop used to have, kept because it is what lets a test drive one
// long-lived serverState through a sequence of requests without standing up a server.
// Cancellation is not reachable through it, for the obvious reason: there is nobody else running
// to do the cancelling.
func handleLine(state *serverState, line []byte) Response {
	return runQueued(state, state.accept(line).queued)
}

// handleRequest dispatches one parsed request, recovering from any panic in the handler (a
// malformed but JSON-valid request could otherwise reach, say, a nil-pointer deref deep in a
// builder) so one bad line can never take the whole server down.
//
// ctx is checked on BOTH sides of the dispatch. Before, so a request cancelled while it was
// still queued never starts. After, so a request cancelled part-way cannot answer with whatever
// its handler happened to be holding when it noticed -- every long method here stops by
// returning early, and more than one of them can stop early holding something that would
// serialise perfectly well and be wrong. What a client correlates against a cancelled id is
// always the cancellation, never a result.
func handleRequest(state *serverState, ctx context.Context, req Request) (resp Response) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		if ctx.Err() != nil {
			resp = cancelledResponse(req.ID)
			return
		}
		resp = Response{ID: req.ID, Error: &ResponseError{Message: fmt.Sprintf("internal error: %v", r)}}
	}()

	if ctx.Err() != nil {
		return cancelledResponse(req.ID)
	}
	result, err := dispatch(state, ctx, req)
	if ctx.Err() != nil {
		return cancelledResponse(req.ID)
	}
	if err != nil {
		return Response{ID: req.ID, Error: &ResponseError{Message: err.Error()}}
	}
	return Response{ID: req.ID, Result: result}
}

// cancelParams is "cancel"'s request shape: the id of the request to stop, spelled exactly as
// that request spelled its own id.
type cancelParams struct {
	ID any `json:"id"`
}

// cancelResult says whether anything was actually stopped. False is not an error and never
// becomes one: by the time a cancel arrives the request it names may well have finished, and a
// client that raced a response cannot know that before it sends. An unknown id, a finished id
// and an id that was never used are the same harmless false.
type cancelResult struct {
	Cancelled bool `json:"cancelled"`
}

// methodCancel implements "cancel". It runs on the READER goroutine, never the worker -- that is
// the whole mechanism: the request it cancels is what the worker is busy with.
//
// It does not wait for the cancelled request to stop, and must not. The response to THIS request
// says the signal was delivered; the response to the CANCELLED request, which comes when that
// request actually unwinds, is the one that says it stopped.
func methodCancel(state *serverState, req Request) Response {
	var p cancelParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return Response{ID: req.ID, Error: &ResponseError{Message: "malformed params: " + err.Error()}}
		}
	}
	key, ok := requestKey(p.ID)
	if !ok {
		return Response{ID: req.ID, Error: &ResponseError{Message: "malformed params: \"id\" is required -- name the request to cancel"}}
	}
	return Response{ID: req.ID, Result: cancelResult{Cancelled: state.cancelRequest(key)}}
}

// cancelRequest fires every in-flight request filed under key, and reports whether there was
// anything to fire. Firing the same context twice is harmless (a context.CancelFunc is
// idempotent), so a duplicate cancel is as much of a no-op as a cancel for an id that has
// already finished.
func (s *serverState) cancelRequest(key string) bool {
	s.mu.Lock()
	entries := s.inflight[key]
	cancels := make([]context.CancelFunc, len(entries))
	for i, e := range entries {
		cancels[i] = e.cancel
	}
	s.mu.Unlock()
	// Called outside the lock: cancel() runs whatever a context's watchers do, and holding the
	// map lock across that would put this goroutine -- the one that has to stay available to read
	// the NEXT line -- at the mercy of them.
	for _, c := range cancels {
		c()
	}
	return len(cancels) > 0
}

// dispatch routes one request to its method.
//
// ctx reaches the methods that can take SECONDS -- generate, generateGrown, graph -- and stops
// there. The rest fall into two groups, and neither is an oversight:
//
//   - Too short to be worth cancelling. "types" and "environments" return a static table and
//     "atlas" reads one already-built file; a cancel aimed at any of them has, in practice,
//     already missed.
//   - Deliberately not interruptible. "loadPack"/"reloadFile" build the session.Workspace every
//     later request reads, and the write methods (createFiles, applyEdits, annotate,
//     annotateBatch, regenerate, renameFeature, deleteFeature) change files on disk. Stopping
//     either half way leaves state nobody can describe -- a partially rebuilt library, a rename
//     applied to some of a pack's files -- which is a worse answer to "I changed my mind" than
//     waiting. They are also bounded by the pack rather than by anything a user can dial up,
//     which is what makes waiting tolerable.
func dispatch(state *serverState, ctx context.Context, req Request) (any, error) {
	switch req.Method {
	case "loadPack":
		// The two methods that get progress lines are the two that can run for
		// a minute and a half through no fault of this engine -- see notify.go.
		// startProgress returns a nil reporter when there is nobody listening,
		// and every call on one is then a no-op, so this costs nothing in the
		// -quiet and handleLine paths.
		reporter, stop := startProgress(state.notify, req.ID, "loadPack")
		defer stop()
		return methodLoadPack(state, req.Params, reporter)
	case "generate":
		return methodGenerate(ctx, state, req.Params)
	case "generateGrown":
		return methodGenerateGrown(ctx, state, req.Params)
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
		reporter, stop := startProgress(state.notify, req.ID, "graph")
		defer stop()
		return methodGraph(ctx, state, req.Params, reporter)
	case "types":
		return typesOutput(), nil
	case "environments":
		return environmentsOutput(), nil
	case "atlas":
		return methodAtlas(req.Params)
	case "":
		return nil, fmt.Errorf("malformed request: missing \"method\"")
	default:
		return nil, fmt.Errorf("unknown method %q -- expected one of loadPack, reloadFile, generate, generateGrown, graph, types, environments, atlas, cancel", req.Method)
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

// loadPackResult is what "loadPack" and "reloadFile" both answer with.
//
// The four *Count fields are how many files of each kind the pack can
// actually USE -- features that parsed into the library, not files found on
// disk. That distinction is the fix for a real bug and is worth stating
// plainly: these counts used to be len(files), so a pack with a truncated
// feature file reported the same healthy number as the same pack with that
// file intact, and the only thing that knew otherwise was a diagnostic
// nobody was shown until they ran a generate. FileCounts below keeps the
// on-disk number, so "56 files, 55 loaded" is sayable and neither half of
// it has to be inferred.
//
// Diagnostics is every pack-scoped diagnostic the loaded libraries hold --
// the same set a `check` would report, available at load time. It is what
// makes a file that cannot be parsed impossible to load in silence.
type loadPackResult struct {
	Warnings       []string `json:"warnings"`
	FeatureCount   int      `json:"featureCount"`
	StructureCount int      `json:"structureCount"`
	RuleCount      int      `json:"ruleCount"`
	BiomeCount     int      `json:"biomeCount"`

	// FileCounts is how many files of each kind were read off disk, whether
	// or not they loaded. Additive: a client that only knows the four counts
	// above keeps working, and one that reads both can show the difference.
	FileCounts loadPackFileCounts `json:"fileCounts"`

	// Diagnostics carries the pack-relative file path in fileId (the same
	// spelling `check` and the graph use, so an editor can open it) and a
	// line/column when the loader knew one.
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// loadPackFileCounts is the on-disk file count per kind -- see
// loadPackResult's own doc comment for why it sits beside the loaded
// counts rather than replacing them.
type loadPackFileCounts struct {
	Features   int `json:"features"`
	Structures int `json:"structures"`
	Rules      int `json:"rules"`
	Biomes     int `json:"biomes"`
}

func methodLoadPack(state *serverState, raw json.RawMessage, reporter *progressReporter) (any, error) {
	var p loadPackParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	opts := pack.Options{
		Dir: p.Dir, FeaturesDir: p.Features, StructuresDir: p.Structures, RulesDir: p.Rules, BiomesDir: p.Biomes,
		BlocksDir:  p.Blocks,
		OnFileRead: packProgressHook(reporter),
	}
	loaded, err := pack.Load(opts)
	if err != nil {
		return nil, err
	}
	// Reading the files is only the first half. The second -- building the libraries -- has no
	// per-file counter of its own and would otherwise leave the last progress line repeating the
	// final file count for however long the build takes, which reads exactly like the wedge these
	// lines exist to rule out.
	reporter.SetPhase("building")
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
	return packResult(loaded, state.workspace), nil
}

// packProgressHook is what pack.Load calls once per file it reads -- see
// pack.Options.OnFileRead.
//
// It is nil, not a do-nothing closure, when there is no reporter: an absent
// hook is a nil check per file inside Load, while a closure that does nothing
// is still an indirect call per file, and this runs several thousand times per
// load in the one path that has no use for it.
//
// The phase store is guarded by a plain local rather than an atomic because
// Load calls this synchronously on one goroutine, so only the reporter's
// atomics cross a goroutine boundary. What crosses per FILE is one atomic add;
// the phase changes five times in a whole pack.
func packProgressHook(reporter *progressReporter) func(string) {
	if reporter == nil {
		return nil
	}
	last := ""
	return func(kind string) {
		if kind != last {
			last = kind
			reporter.SetPhase(kind)
		}
		reporter.AddFile()
	}
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
	return packResult(state.loaded, state.workspace), nil
}

// packResult is the one place a loaded pack is turned into the wire result
// "loadPack" and "reloadFile" both answer with -- one function so the two
// cannot drift into reporting subtly different things about the same pack.
//
// It reads the COUNTS and the DIAGNOSTICS off the workspace, not off the
// file lists, because the workspace is the thing that actually tried to
// parse them: a file list can only say how many files there were, which is
// exactly the number that stayed reassuring while a feature silently
// vanished from the pack. Both calls reach here after their own
// NewWorkspace/Update, so the libraries are always current.
func packResult(loaded *pack.Pack, ws *session.Workspace) loadPackResult {
	counts := ws.Counts()
	// Same per-kind path index `check` builds, for the same reason -- a
	// SourceFile id is unique only within its kind, and a diagnostic is only
	// actionable if its fileId is a path an editor can open. See
	// packRelativeIDs.
	featurePaths := packRelativeIDs(loaded.Dir, loaded.Features, func(f features.SourceFile) (string, string) { return f.ID, f.AbsPath })
	structurePaths := packRelativeIDs(loaded.Dir, loaded.Structures, func(f structures.SourceFile) (string, string) { return f.ID, f.AbsPath })
	rulePaths := packRelativeIDs(loaded.Dir, loaded.Rules, func(f rules.SourceFile) (string, string) { return f.ID, f.AbsPath })
	biomePaths := packRelativeIDs(loaded.Dir, loaded.Biomes, func(f biomes.SourceFile) (string, string) { return f.ID, f.AbsPath })
	blockPaths := packRelativeIDs(loaded.Dir, loaded.Blocks, func(f block.SourceFile) (string, string) { return f.ID, f.AbsPath })
	byKind := ws.PackDiagnosticsByKind()
	var out []Diagnostic
	out = appendSessionDiagnostics(out, byKind.Blocks, blockPaths)
	out = appendSessionDiagnostics(out, byKind.Structures, structurePaths)
	out = appendSessionDiagnostics(out, byKind.Features, featurePaths)
	out = appendSessionDiagnostics(out, byKind.Rules, rulePaths)
	out = appendSessionDiagnostics(out, byKind.Biomes, biomePaths)

	return loadPackResult{
		Warnings:       loaded.Warnings,
		FeatureCount:   counts.Features.Loaded,
		StructureCount: counts.Structures.Loaded,
		RuleCount:      counts.Rules.Loaded,
		BiomeCount:     counts.Biomes.Loaded,
		FileCounts: loadPackFileCounts{
			Features:   len(loaded.Features),
			Structures: len(loaded.Structures),
			Rules:      len(loaded.Rules),
			Biomes:     len(loaded.Biomes),
		},
		Diagnostics: out,
	}
}

// appendSessionDiagnostics converts one asset kind's already-scoped
// session.Diagnostics into the CLI's flat wire shape, respelling each fileId
// as the pack-relative path an editor can open (packRelativeIDs). Scope,
// line and column travel through untouched -- this layer never decides
// them; the producer did.
func appendSessionDiagnostics(out []Diagnostic, in []session.Diagnostic, paths map[string]string) []Diagnostic {
	for _, d := range in {
		out = append(out, Diagnostic{
			Level: d.Level, FileID: packRelativeFileID(paths, d.FileID), Scope: d.Scope,
			Line: d.Line, Column: d.Column, Message: d.Message,
		})
	}
	return out
}

func methodGenerate(ctx context.Context, state *serverState, raw json.RawMessage) (any, error) {
	// Both halves checked, like methodGraph: this reads state.loaded for the pack root it
	// stamps on the params below, and the two are set together and never independently.
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var params wire.GenerateParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	// Set from the pack THIS SERVER has open, after the unmarshal and never from it -- see
	// wire.GenerateParams.PackDir. It is what makes a preview diagnostic name
	// "features/broken.json", the same string this server's own "loadPack" reply and the graph's
	// nodes use, instead of the loader's bare "broken.json".
	params.PackDir = state.loaded.Dir
	return wire.RunGenerateFromWorkspaceContext(ctx, state.workspace, params)
}

// methodGenerateGrown implements the "generateGrown" method -- the "grow to fit and regenerate"
// action (wire.RunGenerateGrownFromWorkspace, see wire's own package doc comment,
// "Grow-and-regenerate") over the currently loaded Workspace. Same params shape as "generate";
// the response is a wire.GrownGenerateOutput (a normal generate response plus `grown`/
// `preGrowBounds` -- see that type's own doc comment), never a silently different contract a
// caller has to special-case parsing for.
func methodGenerateGrown(ctx context.Context, state *serverState, raw json.RawMessage) (any, error) {
	// Both halves checked, like methodGraph: this reads state.loaded for the pack root it
	// stamps on the params below, and the two are set together and never independently.
	if state.workspace == nil || state.loaded == nil {
		return nil, errNoPackLoaded
	}
	var params wire.GenerateParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("malformed params: %v", err)
		}
	}
	params.PackDir = state.loaded.Dir
	return wire.RunGenerateGrownFromWorkspaceContext(ctx, state.workspace, params)
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
