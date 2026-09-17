package features

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// TestCarversHaveNoFusedMultiplyAdd pins the one hazard that this machine's own
// architecture cannot show you.
//
// The Go spec lets an implementation fuse a floating-point multiply into a
// following add -- "possibly across statements" -- so that `a*b + c` is computed
// with ONE rounding instead of two. gc does exactly that on arm64, ppc64, s390x,
// riscv64 and loong64. It does NOT on amd64, which is where this repo is
// developed and where every digest in goldentest was pinned. So an arm64 build of
// featurelab can round differently from the amd64 one, silently, with no test
// noticing.
//
// The game does not fuse: every one of these computations -- the carver's
// tunnel thickness (1.18 shape, see CaveTunnelThickness1_18's own note), the ore
// feature's float32 placement geometry, the fast inverse square root, the fancy
// trunk's clear-line check and placement, the mega trunk's placement, the fancy
// canopy's layer fill and the geode's column pass -- is a separate multiply or
// divide followed by a separate add or subtract. So this list has no allow-list
// of lines that must stay fused, and a fused port is wrong wherever a product
// flows into an add.
//
// The fix at each site is an explicit float32() conversion around the product:
// the spec says a conversion rounds, and rounding is what forbids the
// contraction. Those conversions look redundant -- a float32 converted to
// float32 -- and the next reader will want to delete them. This test is what
// stops that.
//
// HOW IT CHECKS: cross-compiles the package for arm64 with -gcflags=-S and reads
// the emitted assembly. Every instruction the compiler prints carries the source
// file and line it came from, so the assertion is per-FILE rather than per
// function name -- inlining rewrites function names (a closure can appear as
// `buildCaveFeature.NewCaveEllipsoidVolume.NewCaveEllipsoidVolumeWithGate.func3`)
// but never rewrites the attribution back to the line that wrote the expression.
//
// Files not listed here are NOT audited. Everything float-parity-critical is
// listed; add a file here once its sites are closed, so the list only ever
// grows. tree.go and geode.go were the last two: 27 fused instructions across
// 19 source lines, all of them the port's own contraction of what the game
// computes as two separate operations.
var fmaFreeFiles = []string{
	"cave.go",
	"nether_cave.go",
	"underwater_cave.go",
	"enginemath.go",
	"tree.go",
	"geode.go",
}

// fmaInstruction matches gc's arm64 fused multiply-add family. FMADDS/FMSUBS and
// the negated FNMADDS/FNMSUBS are the float32 forms; the D suffixes are float64.
var fmaInstruction = regexp.MustCompile(`\b(FMADD|FMSUB|FNMADD|FNMSUB)[SD]\b`)

// srcLine pulls the "(path/to/file.go:1234)" attribution off an assembly line.
var srcLine = regexp.MustCompile(`\(([^()]*\.go):(\d+)\)`)

func TestCarversHaveNoFusedMultiplyAdd(t *testing.T) {
	if testing.Short() {
		t.Skip("cross-compiles the package; skipped under -short")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH")
	}

	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed -- cannot locate the package directory")
	}
	pkgDir := filepath.Dir(thisFile)

	// -gcflags=-S makes the compiler dump assembly to stderr. The build cache
	// replays that output on a cache hit, so this stays fast on reruns.
	cmd := exec.Command("go", "build", "-gcflags=-S", ".")
	cmd.Dir = pkgDir
	cmd.Env = append(os.Environ(), "GOOS=linux", "GOARCH=arm64", "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("GOARCH=arm64 go build -gcflags=-S failed: %v\n%s", err, out)
	}

	audited := make(map[string]bool, len(fmaFreeFiles))
	for _, f := range fmaFreeFiles {
		audited[f] = true
	}

	seen := make(map[string]int) // audited file -> instructions attributed to it
	var bad []string
	for _, line := range strings.Split(string(out), "\n") {
		m := srcLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		base := filepath.Base(filepath.ToSlash(m[1]))
		if !audited[base] {
			continue
		}
		seen[base]++
		if fmaInstruction.MatchString(line) {
			bad = append(bad, strings.TrimSpace(line))
		}
	}

	// A cache or toolchain change that stopped emitting assembly would make this
	// test pass by seeing nothing at all. Refuse that outcome.
	for _, f := range fmaFreeFiles {
		if seen[f] == 0 {
			t.Fatalf("no arm64 instructions were attributed to %s -- the assembly dump is "+
				"empty or unparseable, so this test proved nothing. Check `GOOS=linux "+
				"GOARCH=arm64 go build -gcflags=-S ./features/`.", f)
		}
	}

	if len(bad) > 0 {
		t.Errorf("%d fused multiply-add instruction(s) in float-parity-critical files.\n"+
			"Go fused a multiply into an add, giving ONE rounding where the game has two, "+
			"so an arm64 build of this port now diverges from the amd64 one and from the game. "+
			"Wrap the offending product in an explicit float32() -- a conversion rounds, and "+
			"that is what forbids the contraction. See this test's own comment.\n\t%s",
			len(bad), strings.Join(bad, "\n\t"))
	}
}
