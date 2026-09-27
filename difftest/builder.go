package difftest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Namespace is the identifier namespace of every feature the generated pack defines.
const Namespace = "difftest"

// defaultFormatVersion is valid for every type used below; the two 1.26.40+ types and anything
// using a 1.26.50 key pass their own.
const defaultFormatVersion = "1.21.110"

// Catalog is the generated pack's content plus the tests that exercise it.
type Catalog struct {
	Files map[string][]byte // pack-relative path -> content
	Tests []*Test
}

type builder struct {
	cat      *Catalog
	repoRoot string
	errs     []string
}

func newBuilder(repoRoot string) *builder {
	return &builder{cat: &Catalog{Files: map[string][]byte{}}, repoRoot: repoRoot}
}

// feature writes features/<name>.json declaring difftest:<name> and returns the identifier.
// body is a JSON object holding the type's keys (without description).
func (b *builder) feature(typeKey, name, body string) string {
	return b.featureFV(defaultFormatVersion, typeKey, name, body)
}

func (b *builder) featureFV(formatVersion, typeKey, name, body string) string {
	id := Namespace + ":" + name
	body = strings.TrimSpace(body)
	if !strings.HasPrefix(body, "{") {
		b.errs = append(b.errs, fmt.Sprintf("%s: body must be a JSON object", name))
		return id
	}
	inner := strings.TrimSpace(body[1:])
	sep := ","
	if strings.HasPrefix(inner, "}") {
		sep = ""
	}
	text := fmt.Sprintf(`{"format_version":%q,"minecraft:%s":{"description":{"identifier":%q}%s%s}`,
		formatVersion, typeKey, id, sep, inner)
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(text), "", "  "); err != nil {
		b.errs = append(b.errs, fmt.Sprintf("%s: %v", name, err))
		return id
	}
	pretty.WriteByte('\n')
	path := "features/" + name + ".json"
	if _, dup := b.cat.Files[path]; dup {
		b.errs = append(b.errs, "duplicate feature file "+path)
	}
	b.cat.Files[path] = pretty.Bytes()
	return id
}

// test registers one test; zero fields get defaults.
func (b *builder) test(t Test) *Test {
	if t.Repeats == 0 {
		t.Repeats = 30
	}
	if t.Region == (Box{}) {
		t.Region = regionSmall
	}
	if t.FeatureID == "" {
		t.FeatureID = Namespace + ":" + t.ID
	}
	if t.Source == "" {
		t.Source = "catalog"
	}
	if len(t.Metrics) == 0 {
		t.Metrics = []string{"success", "placed", "bbox.dx", "bbox.dy", "bbox.dz", "clusters"}
	}
	if t.Setup == nil {
		t.Setup = []Op{}
	}
	tt := t
	b.cat.Tests = append(b.cat.Tests, &tt)
	return &tt
}

// importDir copies every feature file under a public directory of this repository into the pack,
// renaming each declared identifier to difftest:<prefix><name> and rewriting every reference to it
// inside the copied set. Returns old identifier -> new identifier.
func (b *builder) importDir(rel, prefix string) map[string]string {
	dir := filepath.Join(b.repoRoot, filepath.FromSlash(rel))
	entries, err := os.ReadDir(dir)
	if err != nil {
		b.errs = append(b.errs, fmt.Sprintf("import %s: %v", rel, err))
		return nil
	}
	type src struct {
		file string
		text string
	}
	var files []src
	rename := map[string]string{}
	idRe := regexp.MustCompile(`"identifier"\s*:\s*"([^"]+)"`)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			b.errs = append(b.errs, err.Error())
			continue
		}
		text := string(data)
		m := idRe.FindStringSubmatch(text)
		if m == nil {
			b.errs = append(b.errs, fmt.Sprintf("%s/%s: no identifier", rel, e.Name()))
			continue
		}
		old := m[1]
		local := old
		if i := strings.Index(old, ":"); i >= 0 {
			local = old[i+1:]
		}
		rename[old] = Namespace + ":" + prefix + local
		files = append(files, src{file: e.Name(), text: text})
	}
	olds := make([]string, 0, len(rename))
	for o := range rename {
		olds = append(olds, o)
	}
	// Longest first, so no identifier is rewritten inside a longer one.
	sort.Slice(olds, func(i, j int) bool { return len(olds[i]) > len(olds[j]) })
	for _, f := range files {
		text := f.text
		for _, o := range olds {
			text = strings.ReplaceAll(text, `"`+o+`"`, `"`+rename[o]+`"`)
		}
		name := prefix + strings.TrimSuffix(f.file, ".json")
		b.cat.Files["features/"+name+".json"] = []byte(text)
	}
	return rename
}

// copyFile copies a public repository file into the pack verbatim.
func (b *builder) copyFile(rel, packPath string) {
	data, err := os.ReadFile(filepath.Join(b.repoRoot, filepath.FromSlash(rel)))
	if err != nil {
		b.errs = append(b.errs, fmt.Sprintf("copy %s: %v", rel, err))
		return
	}
	b.cat.Files[packPath] = data
}

// raw writes an arbitrary pack file.
func (b *builder) raw(packPath, text string) {
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(text), "", "  "); err != nil {
		b.errs = append(b.errs, fmt.Sprintf("%s: %v", packPath, err))
		return
	}
	pretty.WriteByte('\n')
	b.cat.Files[packPath] = pretty.Bytes()
}

// --- setup and region helpers -------------------------------------------------------------------

func box(x0, y0, z0, x1, y1, z1 int) Box {
	return Box{Min: [3]int{x0, y0, z0}, Max: [3]int{x1, y1, z1}}
}

func fill(bx Box, block string) Op { return Op{Op: "fill", Box: bx, Block: block} }

// room is a hollow box of `wall` whose interior is air: floor top at y0, first air at y0+1,
// last air at y1-1, ceiling at y1.
func room(r, y0, y1 int, wall string) []Op {
	return []Op{
		fill(box(-r, y0-1, -r, r, y1+1, r), wall),
		fill(box(-r+2, y0+1, -r+2, r-2, y1-1, r-2), "minecraft:air"),
	}
}

var (
	regionSmall   = box(-10, -4, -10, 10, 12, 10)
	regionScatter = box(-20, -4, -20, 20, 20, 20)
	regionTree    = box(-16, -4, -16, 16, 44, 16)
	regionRoom    = box(-12, -4, -12, 12, 16, 12)
)

var (
	treeMetrics    = []string{"success", "leaves", "logs", "logTop", "top", "leafWidthX", "leafWidthZ", "leafLayers", "bbox.dx", "bbox.dz"}
	scatterMetrics = []string{"success", "placed", "clusters", "bbox.dx", "bbox.dy", "bbox.dz", "bbox.cx", "bbox.cz"}
	oreMetrics     = []string{"success", "replaced", "bbox.dx", "bbox.dy", "bbox.dz", "bbox.cx", "bbox.cz", "clusters"}
	carverMetrics  = []string{"success", "removed", "bbox.dx", "bbox.dy", "bbox.dz", "clusters"}
)
