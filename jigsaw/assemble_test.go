package jigsaw

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/nbt"
)

type bench struct {
	library   *Library
	templates map[string]*template
	warnings  []string
}

func poolJSON(identifier, fallback string, locations ...string) SourceFile {
	elements := make([]string, len(locations))
	for i, location := range locations {
		elements[i] = fmt.Sprintf(`{"weight":1,"element":{"element_type":"minecraft:single_pool_element","location":%q,"projection":"rigid"}}`, location)
	}
	fallbackField := ""
	if fallback != "" {
		fallbackField = fmt.Sprintf(`"fallback":%q,`, fallback)
	}
	return SourceFile{ID: "worldgen/template_pools/" + identifier + ".json", Text: fmt.Sprintf(
		`{"minecraft:template_pool":{"description":{"identifier":%q},%s"elements":[%s]}}`,
		identifier, fallbackField, strings.Join(elements, ","))}
}

func structureJSON(extra string) SourceFile {
	return SourceFile{ID: "worldgen/structures/s.json", Text: `{"minecraft:jigsaw":{"description":{"identifier":"t:s"},
		"start_pool":"t:start","start_height":{"type":"constant","value":{"absolute":10}},` + extra + `}}`}
}

func newBench(t *testing.T, structureExtra string, pools ...SourceFile) *bench {
	t.Helper()
	library := BuildLibrary(Sources{Pools: pools, Structures: []SourceFile{structureJSON(structureExtra)}}, block.NewPalette())
	for _, d := range library.Diagnostics {
		if d.Level == "error" {
			t.Fatalf("fixture does not load: %s: %s", d.FileID, d.Message)
		}
	}
	return &bench{library: library, templates: map[string]*template{}}
}

func (b *bench) assemble(seed int64) (*assembly, error) {
	rng := newJavaRandom(0)
	rng.setLargeFeatureSeed(seed, 0, 0)
	a := &assembly{
		library: b.library, structure: b.library.Resolve("t:s"), rng: rng, minY: -64, maxY: 320,
		heightAt: func(int, int, int) int { return 64 },
		warn:     func(message string) { b.warnings = append(b.warnings, message) },
		resolve:  func(element *poolElement) *template { return b.templates[element.location] },
	}
	return a, a.assemble(0, 0)
}

func cube(size int, connectors ...connector) *template {
	return &template{size: nbt.Vec3Int{X: size, Y: size, Z: size}, connectors: connectors}
}

func eastOut(target, pool string) connector {
	return connector{pos: [3]int{2, 1, 1}, target: target, pool: pool, facing: facingEast}
}

func westIn(name string) connector {
	return connector{pos: [3]int{0, 1, 1}, name: name, pool: "minecraft:empty", facing: facingWest}
}

func worldOf(p piece, c connector) [3]int {
	return addPos(rotatedLocal(c.pos, p.rotation), p.pos)
}

func TestChildConnectorSitsInFrontOfParent(t *testing.T) {
	for seed := int64(1); seed <= 40; seed++ {
		b := newBench(t, `"max_depth":2`, poolJSON("t:start", "", "start"), poolJSON("t:child", "", "child"))
		parentConnector, childConnector := eastOut("join", "t:child"), westIn("join")
		b.templates["start"], b.templates["child"] = cube(3, parentConnector), cube(3, childConnector)
		a, err := b.assemble(seed)
		if err != nil {
			t.Fatal(err)
		}
		if len(a.pieces) != 2 {
			t.Fatalf("seed %d: %d pieces, want 2", seed, len(a.pieces))
		}
		parent, child := a.pieces[0], a.pieces[1]
		front := rotatedFacing(parentConnector.facing, parent.rotation)
		want := addPos(worldOf(parent, parentConnector), facingStep[front])
		if got := worldOf(child, childConnector); got != want {
			t.Errorf("seed %d: child connector at %v, want %v", seed, got, want)
		}
		if parent.box.intersects(child.box) {
			t.Errorf("seed %d: pieces overlap: %+v %+v", seed, parent.box, child.box)
		}
	}
}

func TestAssemblyReplaysForOneSeedAndVariesAcrossSeeds(t *testing.T) {
	build := func(seed int64) string {
		b := newBench(t, `"max_depth":4`, poolJSON("t:start", "", "start"), poolJSON("t:child", "", "a", "b", "c"))
		b.templates["start"] = cube(3, eastOut("join", "t:child"))
		for _, name := range []string{"a", "b", "c"} {
			b.templates[name] = cube(3, westIn("join"), eastOut("join", "t:child"))
		}
		a, err := b.assemble(seed)
		if err != nil {
			t.Fatal(err)
		}
		out := ""
		for _, p := range a.pieces {
			out += fmt.Sprintf("%s%v%d;", p.element.location, p.pos, p.rotation)
		}
		return out
	}
	if build(7) != build(7) {
		t.Error("the same seed built two different structures")
	}
	seen := map[string]bool{}
	for seed := int64(0); seed < 8; seed++ {
		seen[build(seed)] = true
	}
	if len(seen) < 2 {
		t.Error("eight seeds built one layout")
	}
}

func TestMaxDepthZeroGeneratesNothing(t *testing.T) {
	b := newBench(t, `"max_depth":0`, poolJSON("t:start", "", "start"))
	b.templates["start"] = cube(3)
	a, err := b.assemble(1)
	if err != nil || len(a.pieces) != 0 {
		t.Fatalf("err %v, %d pieces, want no error and no pieces", err, len(a.pieces))
	}
}

func TestMaxDepthStopsAtFallback(t *testing.T) {
	b := newBench(t, `"max_depth":1`, poolJSON("t:start", "", "start"),
		poolJSON("t:child", "t:cap", "child"), poolJSON("t:deep", "t:cap", "deep"), poolJSON("t:cap", "", "cap"))
	b.templates["start"] = cube(3, eastOut("join", "t:child"))
	b.templates["child"] = cube(3, westIn("join"), eastOut("join", "t:deep"))
	b.templates["deep"] = cube(3, westIn("join"))
	b.templates["cap"] = cube(3, westIn("join"))
	a, err := b.assemble(1)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, p := range a.pieces {
		names = append(names, p.element.location)
	}
	if strings.Join(names, ",") != "start,child,cap" {
		t.Errorf("pieces %v, want start,child,cap", names)
	}
}

func TestChildOutsideMaxDistanceIsRefused(t *testing.T) {
	b := newBench(t, `"max_depth":3,"max_distance_from_center":2`, poolJSON("t:start", "", "start"), poolJSON("t:child", "", "child"))
	b.templates["start"] = cube(3, eastOut("join", "t:child"))
	b.templates["child"] = cube(3, westIn("join"))
	a, err := b.assemble(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.pieces) != 1 {
		t.Errorf("%d pieces, want only the start", len(a.pieces))
	}
}

func TestNonMatchingTargetIsNotAttached(t *testing.T) {
	b := newBench(t, `"max_depth":3`, poolJSON("t:start", "", "start"), poolJSON("t:child", "", "child"))
	b.templates["start"] = cube(3, eastOut("wanted", "t:child"))
	b.templates["child"] = cube(3, westIn("other"))
	a, err := b.assemble(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.pieces) != 1 {
		t.Errorf("%d pieces, want only the start", len(a.pieces))
	}
}

func TestStartFailures(t *testing.T) {
	cases := map[string]struct {
		extra string
		pools []SourceFile
		want  string
	}{
		"no pool":       {`"max_depth":1`, nil, `no pool named "t:start"`},
		"empty pool":    {`"max_depth":1`, []SourceFile{poolJSON("t:start", "")}, `start pool "t:start" has no elements`},
		"no anchor":     {`"max_depth":1,"start_jigsaw_name":"nope"`, []SourceFile{poolJSON("t:start", "", "start")}, `couldn't find anchor named "nope"`},
		"above padding": {`"max_depth":1,"dimension_padding":{"bottom":0,"top":315}`, []SourceFile{poolJSON("t:start", "", "start")}, "does not fit between the dimension padding"},
	}
	for name, c := range cases {
		b := newBench(t, c.extra, c.pools...)
		b.templates["start"] = cube(3)
		_, err := b.assemble(1)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: error %v, want it to mention %q", name, err, c.want)
		}
	}
}

func TestNamedAnchorPutsItsCellAtTheStartPosition(t *testing.T) {
	b := newBench(t, `"max_depth":1,"start_jigsaw_name":"door"`, poolJSON("t:start", "", "start"))
	door := connector{pos: [3]int{2, 0, 2}, name: "door", facing: facingNorth}
	b.templates["start"] = cube(3, door)
	a, err := b.assemble(3)
	if err != nil {
		t.Fatal(err)
	}
	got := worldOf(a.pieces[0], door)
	if got[0] != 0 || got[2] != 0 {
		t.Errorf("anchor at %v, want x and z 0", got)
	}
}

func TestStartHeightAndProjection(t *testing.T) {
	b := newBench(t, `"max_depth":1,"heightmap_projection":"world_surface"`, poolJSON("t:start", "", "start"))
	b.templates["start"] = cube(3)
	a, err := b.assemble(1)
	if err != nil {
		t.Fatal(err)
	}
	if got := a.pieces[0].box.minY; got != 64+10-1 {
		t.Errorf("minY = %d, want height 64 + start_height 10 - 1", got)
	}
}

func TestBrokenPoolReferencesWarnAndContinue(t *testing.T) {
	cases := map[string]struct {
		pools []SourceFile
		want  string
	}{
		"missing pool":     {[]SourceFile{poolJSON("t:start", "", "start")}, `empty or non-existent pool: "t:child"`},
		"empty pool":       {[]SourceFile{poolJSON("t:start", "", "start"), poolJSON("t:child", "")}, `empty or non-existent pool: "t:child"`},
		"missing fallback": {[]SourceFile{poolJSON("t:start", "", "start"), poolJSON("t:child", "t:gone", "child")}, `non-existent fallback pool: "t:gone"`},
		"empty fallback":   {[]SourceFile{poolJSON("t:start", "", "start"), poolJSON("t:child", "t:none", "child"), poolJSON("t:none", "")}, `empty fallback pool: "t:none"`},
	}
	for name, c := range cases {
		b := newBench(t, `"max_depth":3`, c.pools...)
		b.templates["start"] = cube(3, eastOut("join", "t:child"))
		b.templates["child"] = cube(3, westIn("join"))
		a, err := b.assemble(1)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(a.pieces) != 1 {
			t.Errorf("%s: %d pieces, want only the start", name, len(a.pieces))
		}
		if !strings.Contains(strings.Join(b.warnings, "\n"), c.want) {
			t.Errorf("%s: warnings %v, want %q", name, b.warnings, c.want)
		}
	}
}

func TestPoolWithoutFallbackAttachesAndEndsAtEmpty(t *testing.T) {
	b := newBench(t, `"max_depth":3`, poolJSON("t:start", "", "start"), poolJSON("t:child", "", "child"))
	b.templates["start"] = cube(3, eastOut("join", "t:child"))
	b.templates["child"] = cube(3, westIn("join"), connector{pos: [3]int{2, 1, 1}, target: "x", pool: "minecraft:empty", facing: facingEast})
	a, err := b.assemble(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.pieces) != 2 || len(b.warnings) != 0 {
		t.Errorf("%d pieces, warnings %v; want 2 pieces, no warnings", len(a.pieces), b.warnings)
	}
}

func TestPopTakesHighestPriorityThenOldest(t *testing.T) {
	a := &assembly{}
	a.push(0, 1, 0, 0)
	a.push(5, 2, 0, 0)
	a.push(5, 3, 0, 0)
	order := []int{a.pop().piece, a.pop().piece, a.pop().piece}
	if order[0] != 2 || order[1] != 3 || order[2] != 1 {
		t.Errorf("pop order %v, want [2 3 1]", order)
	}
}

func TestCanAttach(t *testing.T) {
	north := connector{target: "a", facing: facingNorth}
	south := connector{name: "a", facing: facingSouth}
	if !canAttach(north, 0, facingNorth, south, 0, false) {
		t.Error("opposite faces with matching names must attach")
	}
	if canAttach(north, 0, facingNorth, connector{name: "b", facing: facingSouth}, 0, false) {
		t.Error("a different name must not attach")
	}
	if !canAttach(north, 0, facingNorth, connector{name: "b", facing: facingSouth}, 0, true) {
		t.Error("a feature element ignores the name")
	}
	if canAttach(north, 0, facingNorth, south, 1, false) {
		t.Error("a rotation that turns the face away must not attach")
	}
	up := connector{target: "a", facing: facingUp, aligned: true, top: 0}
	if !canAttach(up, 0, facingUp, connector{name: "a", facing: facingDown, top: 0}, 0, false) {
		t.Error("aligned connectors with one top must attach")
	}
	if canAttach(up, 0, facingUp, connector{name: "a", facing: facingDown, top: 1}, 0, false) {
		t.Error("aligned connectors with different tops must not attach")
	}
	rollable := connector{target: "a", facing: facingUp, top: 0}
	if !canAttach(rollable, 0, facingUp, connector{name: "a", facing: facingDown, top: 1}, 0, false) {
		t.Error("a rollable connector ignores the top")
	}
}

func TestStructureNameFromLocation(t *testing.T) {
	cases := map[string]string{"ns:ns/a/b": "ns:a/b", "ns/a": "ns:a", "plain": "plain", "ignored:plain": "plain"}
	for location, want := range cases {
		if got := structureNameFromLocation(location); got != want {
			t.Errorf("%q -> %q, want %q", location, got, want)
		}
	}
}

func TestHeightAnchors(t *testing.T) {
	cases := []struct {
		anchor heightAnchor
		want   int
	}{
		{heightAnchor{kind: "absolute", value: 7}, 7},
		{heightAnchor{kind: "above_bottom", value: 7}, -57},
		{heightAnchor{kind: "below_top", value: 7}, 312},
	}
	for _, c := range cases {
		if got := c.anchor.resolve(-64, 320); got != c.want {
			t.Errorf("%+v = %d, want %d", c.anchor, got, c.want)
		}
	}
}

func TestUniformHeightStaysInItsRange(t *testing.T) {
	provider := heightProvider{uniform: true, min: heightAnchor{kind: "absolute", value: 5}, max: heightAnchor{kind: "absolute", value: 8}}
	rng := newJavaRandom(1)
	seen := map[int]bool{}
	for i := 0; i < 200; i++ {
		y := provider.sample(rng, -64, 320)
		if y < 5 || y > 8 {
			t.Fatalf("y = %d, outside 5..8", y)
		}
		seen[y] = true
	}
	if len(seen) != 4 {
		t.Errorf("drew %v, want all of 5..8", seen)
	}
	inverted := heightProvider{uniform: true, min: heightAnchor{kind: "absolute", value: 8}, max: heightAnchor{kind: "absolute", value: 5}}
	if got := inverted.sample(rng, -64, 320); got != 8 {
		t.Errorf("inverted range = %d, want the minimum 8", got)
	}
}

func TestDirectAliasRedirectsThePool(t *testing.T) {
	b := newBench(t, `"max_depth":2,"pool_aliases":[{"type":"direct","alias":"t:named","target":"t:real"}]`,
		poolJSON("t:start", "", "start"), poolJSON("t:real", "", "child"))
	b.templates["start"] = cube(3, eastOut("join", "t:named"))
	b.templates["child"] = cube(3, westIn("join"))
	a, err := b.assemble(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.pieces) != 2 || len(b.warnings) != 0 {
		t.Errorf("%d pieces, warnings %v; want 2 pieces and no warnings", len(a.pieces), b.warnings)
	}
}

func TestRotatedLocal(t *testing.T) {
	cases := map[int][3]int{0: {1, 2, 3}, 1: {-3, 2, 1}, 2: {-1, 2, -3}, 3: {3, 2, -1}}
	for rotation, want := range cases {
		if got := rotatedLocal([3]int{1, 2, 3}, rotation); got != want {
			t.Errorf("rotation %d = %v, want %v", rotation, got, want)
		}
	}
}
