// Package playground is everything the browser playground (cmd/playground)
// does that is not JavaScript plumbing: keeping one session.Workspace alive
// across calls, decoding the request, and shaping every failure into the one
// JSON answer the page knows how to read.
//
// It lives here, free of build tags, rather than next to the syscall/js glue
// because that glue only compiles for js/wasm, and nothing that only compiles
// for js/wasm is covered by `go test ./...`. What is left in cmd/playground is
// the part that cannot be tested natively anyway -- turning a JS object into a
// Go map and installing functions on globalThis -- and it is kept small enough
// that there is nothing in it worth testing.
package playground

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/features"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/wire"
)

// Engine is one page's engine: the Workspace every generate reuses and the
// file set it was last built from. Not safe for concurrent use, and it does
// not need to be -- a Go program under js/wasm runs its exported callbacks one
// at a time on the page's single JS thread.
type Engine struct {
	ws    *session.Workspace
	files []features.SourceFile

	// vanilla is the block catalogue stacked under every run, the way
	// pack.Load stacks it under a real pack's blocks/, so tag predicates and
	// "is this a real block" checks answer as they do for a loaded pack. It
	// is read once and handed back to Workspace.Update as the very same
	// slice on every call, which is what lets Update skip it without even
	// hashing it (see session.reuseFingerprint).
	vanilla []block.SourceFile
}

// New returns an Engine with nothing built yet. The Workspace is built by the
// first Generate rather than here, so a page that loads the engine and never
// runs it pays nothing past reading the catalogue.
func New() *Engine {
	return &Engine{vanilla: block.DefaultBlocks()}
}

// Generate runs one placement over files (a file id such as "scatter.json" to
// that file's JSON text) and returns the response as JSON text: exactly the
// wire.GenerateOutput serve's "generate" answers with, or {"error": "..."}
// when there is no output to give.
//
// "No output" is narrower than "something is wrong". A feature file that does
// not parse is a pack diagnostic, reported inside a normal output the way
// serve reports it, because that is what the page's diagnostics list already
// knows how to show. {"error"} is for a request that could not be run at all:
// params that do not decode, no feature named, an unknown environment.
//
// It never panics. A panic would surface in the page as an exception thrown
// out of a Go callback, after which the Go side of a js/wasm program is dead
// and every later call fails -- so one bad input would cost the reader the
// whole playground until they reload. A recovered panic is reported instead,
// and the Workspace it happened in is dropped, since a library build that
// panicked half way is not one to reuse.
func (e *Engine) Generate(files map[string]string, paramsJSON string) (out string) {
	defer func() {
		if r := recover(); r != nil {
			e.ws, e.files = nil, nil
			out = ErrorJSON(fmt.Sprintf("internal error: %v", r))
			// Printed rather than returned: the stack is for whoever is
			// looking at the console, not for the page to show a reader.
			fmt.Fprintf(panicLog, "featurelab: recovered panic in generate: %v\n%s", r, debug.Stack())
		}
	}()

	var params wire.GenerateParams
	if err := json.Unmarshal([]byte(paramsJSON), &params); err != nil {
		// Worded as serve words it, so a message means the same thing
		// whichever host produced it.
		return ErrorJSON("malformed params: " + err.Error())
	}
	e.load(files)
	result, err := runGenerate(e.ws, params)
	if err != nil {
		return ErrorJSON(err.Error())
	}
	b, err := json.Marshal(result)
	if err != nil {
		return ErrorJSON("internal error encoding response: " + err.Error())
	}
	return string(b)
}

// runGenerate is the placement Generate runs, a variable only so a test can
// make it panic: no input is known to, and the recovery is for the one that
// eventually will.
var runGenerate = wire.RunGenerateFromWorkspace

// panicLog is where a recovered panic's stack goes: stdout, which under
// js/wasm is the browser console. A variable so the test that panics on
// purpose does not print a stack trace into every test log.
var panicLog io.Writer = os.Stdout

// load brings the Workspace up to date with files, building it on first use.
//
// An unchanged file set is handed back to Update as the previous slice rather
// than a fresh copy of the same contents. Update would reach the same answer
// either way -- it fingerprints by content -- but the same slice lets it skip
// hashing the files at all, and a page regenerating on every seed or size
// change sends the same files every time.
func (e *Engine) load(files map[string]string) {
	next := sourceFiles(files)
	if sameFiles(next, e.files) {
		next = e.files
	}
	if e.ws == nil {
		e.ws = session.NewWorkspace(next, nil, nil, nil, e.vanilla)
	} else {
		e.ws.Update(next, nil, nil, nil, e.vanilla)
	}
	e.files = next
}

// sourceFiles orders the map as pack.Load orders a features/ directory, by
// id. Map order is random, and the library build is not indifferent to order:
// diagnostics come out in file order, and two files declaring the same
// identifier resolve by which one came last.
func sourceFiles(files map[string]string) []features.SourceFile {
	out := make([]features.SourceFile, 0, len(files))
	for id, text := range files {
		// AbsPath is the id itself: there is no disk behind these files, and
		// the id is what a reader would recognise in a message that quotes it.
		out = append(out, features.SourceFile{ID: id, AbsPath: id, Text: text})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func sameFiles(a, b []features.SourceFile) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Environments is the environment preset list, in the shape serve's
// "environments" method returns and the panel's setEnvironments takes.
func Environments() string {
	b, err := json.Marshal(wire.Environments())
	if err != nil {
		// A static table of strings and numbers; this cannot fail, and if it
		// ever did an empty list is a picker with nothing in it rather than a
		// page that stops loading.
		return "[]"
	}
	return string(b)
}

// ErrorJSON is the {"error": message} answer, for a request with no output to
// give. Exported for the JS glue, which has one such case of its own:
// arguments that are not an object and a string never reach Generate.
func ErrorJSON(message string) string {
	b, _ := json.Marshal(map[string]string{"error": message})
	return string(b)
}

// Version is what this build calls itself: the version the build script
// stamped, else the module version a `go install` records, else "(devel)".
// The same rule as the featurelab binary's `version`, down to refusing a
// "+dirty" version the toolchain derives from a checkout with local changes --
// that describes the source tree, not a release.
func Version(stamped string) string {
	if stamped != "" {
		return stamped
	}
	info, ok := debug.ReadBuildInfo()
	if !ok || info == nil {
		return "unknown"
	}
	v := info.Main.Version
	if v == "" || v == "(devel)" || strings.HasSuffix(v, "+dirty") {
		return "(devel)"
	}
	return v
}
