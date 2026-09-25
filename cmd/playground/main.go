//go:build js && wasm

// Command playground is the engine the documentation site's playground runs in
// the reader's browser: the generate path, compiled to WebAssembly, behind two
// functions on globalThis. Build it with scripts/build-playground.sh, which
// also writes the content-hashed names the site loads it by.
//
// # JS API
//
// Once go.run(instance) has started the program it installs
//
//	globalThis.featurelab = {
//	  version: string,
//	  generate(files: Record<string, string>, paramsJSON: string): string,
//	  environments(): string,
//	}
//
// and then calls globalThis.featurelabOnReady() if the page defined one.
//
// generate: files maps a file id ("scatter.json") to that file's JSON text --
// the reader's feature and every feature it references, as a features/
// directory would hold them. paramsJSON is a wire.GenerateParams, the same
// request serve's "generate" takes. The return value is the wire.GenerateOutput
// JSON serve answers with, or {"error": "<message>"} when the request could not
// be run at all. A feature file that does not parse is not such a failure: it
// comes back as a pack-scoped diagnostic inside a normal output, which is also
// what happens when the feature asked for is the one that failed to parse (the
// run itself then fails to find it and says so in its own diagnostics).
//
// The params a page needs to send:
//
//	feature              the identifier to place, e.g. "demo:scatter" (required)
//	env                  an environment preset id from environments(); "" = "plains"
//	seed                 uint32 feature seed; absent = the preset default (1)
//	origin               "x,y,z"; absent = the preset's default origin
//	size                 "XxYxZ"; absent = the preset's default size
//	omitCatalogs         true: drop entries/ruleEntries/biomeEntries, which list the
//	                     files sent and cannot change between two runs over them
//	omitPackDiagnostics  true: drop the diagnostics about the files themselves (a
//	                     parse error, say), leaving those about this run. Leave it
//	                     false on the first run after the files change, or a broken
//	                     file is never reported
//
// Everything else wire.GenerateParams carries (minY, biomeTags, materials,
// repeat, profile, the budgets) works here as it does in serve. "rule" and
// "biomeId" are accepted but have nothing to name: only feature files can be
// sent.
//
// environments: the preset list as JSON, in the shape serve's "environments"
// method returns and the panel's setEnvironments takes.
//
// Both functions return strings rather than objects so that the page decodes
// the response with the same JSON.parse and the same decoder it already uses on
// serve's output; building a JS object from Go field by field would be a second
// encoding of the contract to keep in step with the first.
package main

import (
	"syscall/js"

	"github.com/stirante/featurelab/internal/playground"
)

// buildVersion is stamped by scripts/build-playground.sh with -X when it is
// given a version; empty, playground.Version falls back to the build info.
var buildVersion = ""

func main() {
	engine := playground.New()

	api := js.Global().Get("Object").New()
	api.Set("version", playground.Version(buildVersion))
	api.Set("generate", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) < 2 || args[0].Type() != js.TypeObject || args[1].Type() != js.TypeString {
			return playground.ErrorJSON("generate(files, paramsJSON) takes an object of file texts and a JSON string")
		}
		return engine.Generate(filesFromJS(args[0]), args[1].String())
	}))
	api.Set("environments", js.FuncOf(func(this js.Value, args []js.Value) any {
		return playground.Environments()
	}))
	js.Global().Set("featurelab", api)

	if ready := js.Global().Get("featurelabOnReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	// A js/wasm program's exported functions stop working the moment main
	// returns, so it never does.
	select {}
}

// filesFromJS copies a JS object of strings into a Go map. A value that is not
// a string is passed through as its String() form ("<number: 3>" and the like),
// which then fails to parse and is reported as that file's diagnostic -- the
// same place a malformed file of any other kind is reported.
func filesFromJS(obj js.Value) map[string]string {
	keys := js.Global().Get("Object").Call("keys", obj)
	files := make(map[string]string, keys.Length())
	for i := 0; i < keys.Length(); i++ {
		k := keys.Index(i).String()
		files[k] = obj.Get(k).String()
	}
	return files
}
