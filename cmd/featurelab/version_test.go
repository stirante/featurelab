package main

import (
	"bytes"
	"encoding/json"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
)

// The VS Code extension runs `featurelab version --json` before its first
// request and reports "the engine would not run" when it cannot. So the two
// things these tests hold are the two that failure mode depends on: the JSON
// has a `version` string in it, and it is never empty -- an unstamped local
// build has to answer "(devel)" (or "unknown", with no build info at all)
// rather than "", or a host cannot tell "answered" from "said nothing".
func TestVersionJSONAlwaysNamesAVersion(t *testing.T) {
	var out bytes.Buffer
	if err := writeVersionJSON(&out); err != nil {
		t.Fatalf("writeVersionJSON: %v", err)
	}
	var parsed VersionOutput
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("version --json did not produce JSON: %v (%q)", err, out.String())
	}
	if parsed.Version == "" {
		t.Error("version is empty; a host cannot tell that from a binary that printed nothing")
	}
	if parsed.Go != runtime.Version() {
		t.Errorf("go = %q, want %q", parsed.Go, runtime.Version())
	}
	if parsed.OS != runtime.GOOS || parsed.Arch != runtime.GOARCH {
		t.Errorf("os/arch = %q/%q, want %q/%q", parsed.OS, parsed.Arch, runtime.GOOS, runtime.GOARCH)
	}
}

func TestVersionLineNamesTheBinary(t *testing.T) {
	var out bytes.Buffer
	writeVersionLine(&out)
	line := out.String()
	if !strings.HasPrefix(line, "featurelab ") {
		t.Errorf("version line = %q, want it to start with %q", line, "featurelab ")
	}
	if !strings.Contains(line, runtime.GOOS) {
		t.Errorf("version line = %q, want it to name the platform %q", line, runtime.GOOS)
	}
}

// `version` has to be reachable from the argument vector a host actually
// passes, exit 0, and write to stdout -- the subcommand switch is the part
// that decides that and it is easy to add a case to the wrong place.
func TestVersionSubcommandExitsZero(t *testing.T) {
	for _, args := range [][]string{{"version"}, {"version", "--json"}, {"--version"}} {
		if code := run(args); code != 0 {
			t.Errorf("run(%q) = %d, want 0", args, code)
		}
	}
}

// TestResolveVersion covers the rule the VS Code extension's staleness check
// depends on, and that nothing else could reach: what this binary calls itself
// when -ldflags stamped nothing.
//
// It used to answer with whatever debug.ReadBuildInfo put in Main.Version,
// which since Go 1.24 is derived from the VCS checkout -- "v0.1.1+dirty" in
// this repository, from the nearest tag plus a dirty-tree marker. The
// extension filters "unknown" and "(devel)" out before comparing an engine's
// version with its own, so that string sailed past a filter written to catch
// exactly this case and an unstamped `go build` was reported as a leftover
// engine from some other release -- a true-sounding message about a thing that
// had not happened, pointing at a fix that was not the fix.
func TestResolveVersion(t *testing.T) {
	buildInfo := func(mainVersion string) *debug.BuildInfo {
		return &debug.BuildInfo{Main: debug.Module{Path: "github.com/stirante/featurelab", Version: mainVersion}}
	}
	for _, tc := range []struct {
		name     string
		stamped  string
		info     *debug.BuildInfo
		haveInfo bool
		want     string
	}{
		// The release build, and the only case that may report a version:
		// scripts/build-binary.mjs passes -X main.buildVersion=<package.json
		// version>, and the extension requires that exact string back.
		{"a stamped release build reports its stamp", "0.1.1", buildInfo("v0.1.1+dirty"), true, "0.1.1"},
		// The case the extension's filter was written for, which nothing could
		// produce until this rule existed.
		{"an unstamped build in a dirty checkout is a devel build", "", buildInfo("v0.1.1+dirty"), true, develVersion},
		{"an unstamped build with no module version at all is a devel build", "", buildInfo(""), true, develVersion},
		{"Go's own devel marker is passed through unchanged", "", buildInfo(develVersion), true, develVersion},
		// A real module version, which a `go install module@version` binary
		// genuinely has. Not the same claim as a VCS-derived one and not
		// thrown away with it.
		{"a real module version is kept", "", buildInfo("v0.1.1"), true, "v0.1.1"},
		{"a pseudo-version is kept", "", buildInfo("v0.1.2-0.20250101000000-abcdef012345"), true, "v0.1.2-0.20250101000000-abcdef012345"},
		// Distinct from (devel) on purpose: not "this is a dev build" but
		// "this binary cannot tell you what it is".
		{"no build information at all is unknown", "", nil, false, unknownVersion},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveVersion(tc.stamped, tc.info, tc.haveInfo); got != tc.want {
				t.Errorf("resolveVersion(%q, %+v, %v) = %q, want %q", tc.stamped, tc.info, tc.haveInfo, got, tc.want)
			}
		})
	}
}

// The two strings above are named constants because apps/vscode/src/
// engineCheck.ts matches on them literally. This is the assertion that fails
// if either is reworded here without the filter there being changed to match --
// a rename that would otherwise break nothing until an unstamped engine
// claimed, quietly, to be a version.
func TestVersion_TheTwoNoVersionSpellingsAreWhatTheExtensionFiltersOn(t *testing.T) {
	if develVersion != "(devel)" {
		t.Errorf("develVersion = %q, want %q -- engineCheck.ts's readRawVersion matches this literal", develVersion, "(devel)")
	}
	if unknownVersion != "unknown" {
		t.Errorf("unknownVersion = %q, want %q -- engineCheck.ts's readRawVersion matches this literal", unknownVersion, "unknown")
	}
}
