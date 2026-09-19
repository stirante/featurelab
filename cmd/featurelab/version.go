package main

import (
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"runtime/debug"
	"strings"
)

// buildVersion is what this binary calls itself. Empty in an ordinary `go
// build`, which is the case `resolveVersion` falls back from; a release build
// sets it with -ldflags "-X main.buildVersion=..." (apps/vscode/scripts/
// build-binary.mjs does exactly that, with the extension's own version).
var buildVersion = ""

// VersionOutput is the `version --json` response shape.
//
// It exists for a caller that has to decide whether the executable it found
// is one it can drive -- the VS Code extension's own start-up check, which
// runs this before its first request and writes the answer into its log. So
// every field is something that distinguishes one featurelab build from
// another, and the whole thing is printed whether or not the build recorded
// a version: "which binary is this" must still have an answer for the
// locally built one a developer is actually running.
type VersionOutput struct {
	Version  string `json:"version"`
	Revision string `json:"revision,omitempty"`
	Go       string `json:"go"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
}

// develVersion and unknownVersion are the two things this binary says when it
// is NOT a build that was given a version, and they are two different things.
//
//   - develVersion: there is build information, and no release version in it.
//     A plain `go build`. This is what a development build calls itself, and
//     it is Go's own spelling for exactly that.
//   - unknownVersion: there is no build information at all -- debug.
//     ReadBuildInfo said so. Rare, and genuinely a different answer: not "this
//     is a dev build" but "this binary cannot tell you what it is".
//
// THESE TWO STRINGS ARE A CONTRACT, not decoration. The VS Code extension
// filters both out before comparing an engine's version against its own
// manifest (apps/vscode/src/engineCheck.ts, readRawVersion), because a build
// with no version must not be able to pass a check that a version is what
// passes. Rename either of them here and that filter silently stops matching,
// which is the failure the filter exists to prevent.
const (
	develVersion   = "(devel)"
	unknownVersion = "unknown"
)

func versionInfo() VersionOutput {
	info, ok := debug.ReadBuildInfo()
	out := VersionOutput{Version: resolveVersion(buildVersion, info, ok), Go: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH}
	if !ok {
		return out
	}
	for _, setting := range info.Settings {
		if setting.Key == "vcs.revision" {
			out.Revision = setting.Value
			break
		}
	}
	return out
}

// resolveVersion decides what this binary calls itself, from the ldflags stamp
// and the build info, and nothing else. Split out from versionInfo because
// neither of its two inputs can be arranged inside a test binary -- the stamp
// is set at link time and the build info describes the test binary, not a
// release -- so the rule below would otherwise be the one thing here with no
// test at all.
//
// WHY info.Main.Version IS NOT TAKEN AT FACE VALUE. Since Go 1.24 the toolchain
// derives a version for an unstamped `go build` from the enclosing VCS
// checkout: in this repository that is "v0.1.1+dirty" -- the nearest tag, plus
// a suffix meaning the working tree has uncommitted changes. That string is the
// toolchain describing the SOURCE TREE, not this binary claiming to be a
// release, and the difference matters to the one caller that reads it. The
// extension's rule is that a bundled engine must report the extension's own
// version, and its "this build was never stamped" message -- the accurate one,
// telling a developer to run `npm run build:binary` -- is keyed to the absence
// of a version. Let "v0.1.1+dirty" through as a version and an unstamped build
// gets told instead that bin/ holds a leftover from some other release, which
// is not what happened and not what fixes it.
//
// A version with no "+dirty" IS taken: `go install ...@v0.1.1` records a real
// module version in exactly this field, and that binary genuinely is v0.1.1.
func resolveVersion(stamped string, info *debug.BuildInfo, haveInfo bool) string {
	if stamped != "" {
		return stamped
	}
	if !haveInfo || info == nil {
		return unknownVersion
	}
	v := info.Main.Version
	if v == "" || v == develVersion || strings.HasSuffix(v, "+dirty") {
		return develVersion
	}
	return v
}

func writeVersionJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	return enc.Encode(versionInfo())
}

func writeVersionLine(w io.Writer) {
	v := versionInfo()
	if v.Revision != "" {
		fmt.Fprintf(w, "featurelab %s (%s) %s %s/%s\n", v.Version, v.Revision, v.Go, v.OS, v.Arch)
		return
	}
	fmt.Fprintf(w, "featurelab %s %s %s/%s\n", v.Version, v.Go, v.OS, v.Arch)
}
