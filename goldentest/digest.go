// Package goldentest pins placement behaviour against digest baselines -- a
// regression baseline regenerated from this repo's own Go engine by
// goldentest/cmd/goldengen, and from no external authority.
//
// Each in-scope feature chain is placed once in a fixed plains environment
// (see harness.go) and recorded as: an FNV-1a 64-bit hash and count of its
// successful block writes, an FNV-1a hash and count of its RNG draws, the
// position Place returned, and the final Molang scope. The exact byte
// encodings are spelled out in the digest file's meta.hash block (see
// buildDigestMeta). A match means this engine still produces what it produced
// when the baseline was pinned -- nothing more.
//
// The committed baseline is testdata/fixture_placement_digest.json over the
// wiki fixture pack (fixture_test.go). The same harness can also be pointed at
// any other pack through FEATURELAB_PACK_DIR.
package goldentest

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/random"
	molang "github.com/stirante/molang-go"

	"github.com/stirante/featurelab/wgen"
)

// ---------------------------------------------------------------------------
// FNV-1a 64-bit — offset basis 0xcbf29ce484222325, prime 0x100000001b3.
// ---------------------------------------------------------------------------

func fnv1a64Hex(b []byte) string {
	h := uint64(0xcbf29ce484222325)
	for _, c := range b {
		h ^= uint64(c)
		h *= 0x100000001b3
	}
	return fmt.Sprintf("%016x", h)
}

// WriteRecord is one successful setBlock call, in call order.
type WriteRecord struct {
	X, Y, Z  int
	BlockKey string
}

// EncodeWrites serialises writes for hashing: per write, a 16-byte
// little-endian header (x, y, z, block-key byte length) followed by the raw
// block-key bytes.
func EncodeWrites(writes []WriteRecord) []byte {
	buf := make([]byte, 0, len(writes)*20)
	var head [16]byte
	for _, w := range writes {
		binary.LittleEndian.PutUint32(head[0:4], uint32(int32(w.X)))
		binary.LittleEndian.PutUint32(head[4:8], uint32(int32(w.Y)))
		binary.LittleEndian.PutUint32(head[8:12], uint32(int32(w.Z)))
		nameBytes := []byte(w.BlockKey)
		binary.LittleEndian.PutUint32(head[12:16], uint32(len(nameBytes)))
		buf = append(buf, head[:]...)
		buf = append(buf, nameBytes...)
	}
	return buf
}

// EncodeDraws serialises draws for hashing: per draw, a fixed 13-byte record
// (method byte, little-endian int32 bound, little-endian float64 value).
func EncodeDraws(draws []random.DrawRecord) []byte {
	buf := make([]byte, len(draws)*13)
	for i, d := range draws {
		off := i * 13
		buf[off] = byte(d.Method)
		binary.LittleEndian.PutUint32(buf[off+1:off+5], uint32(d.Bound))
		binary.LittleEndian.PutUint64(buf[off+5:off+13], math.Float64bits(d.Value))
	}
	return buf
}

// ---------------------------------------------------------------------------
// Recording volume decorator — mirrors the golden-dump generator's
// RecordingVolume: wraps a BlockWorld, recording every SUCCESSFUL
// SetBlock without changing behaviour.
// ---------------------------------------------------------------------------

type RecordingVolume struct {
	Inner  wgen.BlockWorld
	Writes []WriteRecord
}

func (r *RecordingVolume) GetBlock(p wgen.BlockPos) block.ID { return r.Inner.GetBlock(p) }

func (r *RecordingVolume) SetBlock(p wgen.BlockPos, id block.ID) bool {
	ok := r.Inner.SetBlock(p, id)
	if ok {
		pal := r.Inner.Palette()
		key := block.CanonicalKey(pal.NameOf(id), pal.StatesOf(id))
		r.Writes = append(r.Writes, WriteRecord{X: p.X, Y: p.Y, Z: p.Z, BlockKey: key})
	}
	return ok
}

func (r *RecordingVolume) GetHeight(x, z int) int          { return r.Inner.GetHeight(x, z) }
func (r *RecordingVolume) GetHeightmapAt(x, z int) int     { return r.Inner.GetHeightmapAt(x, z) }
func (r *RecordingVolume) GetAboveTopSolidAt(x, z int) int { return r.Inner.GetAboveTopSolidAt(x, z) }
func (r *RecordingVolume) MinY() int                       { return r.Inner.MinY() }
func (r *RecordingVolume) MaxY() int                       { return r.Inner.MaxY() }
func (r *RecordingVolume) Contains(p wgen.BlockPos) bool   { return r.Inner.Contains(p) }
func (r *RecordingVolume) Palette() wgen.IPaletteView      { return r.Inner.Palette() }

var _ wgen.BlockWorld = (*RecordingVolume)(nil)

// ---------------------------------------------------------------------------
// Scope entries — sorted by (ns, key) as plain strings ("query" < "temp" <
// "variable"), NaN/±Infinity as sentinel strings.
// ---------------------------------------------------------------------------

type ScopeEntry struct {
	NS    string
	Key   string
	Value any // float64, or "NaN"/"Infinity"/"-Infinity"
}

// jsonSafeNumber renders one Molang scope value for the digest file. NaN and the infinities become
// strings because JSON has no spelling for them.
//
// Negative zero is FOLDED to positive zero, and that is the interesting case. The generator can
// produce -0 for scope values where a committed digest has 0. Nothing is wrong with either --
// scopeValueEqual compares with `==`, and IEEE 754 says -0.0 == 0.0, so the test passes against a
// file that disagrees with what regeneration writes.
//
// That is a trap rather than a curiosity. It is invisible to every test, so it accumulates silently,
// and the first person to regenerate the baseline wholesale for an unrelated reason sweeps those
// lines of somebody else's change into their commit.
//
// Folding costs nothing the comparison had. It could not distinguish the two before this change and
// still cannot; what changes is only that the file on disk now matches what the tool writes. If a
// future digest ever needs to catch a sign-of-zero flip as a real divergence, the place to fix it is
// scopeValueEqual (with math.Signbit), and this fold has to come out at the same time -- doing one
// without the other gets you a test that can fail on a difference the file cannot record.
func jsonSafeNumber(v float64) any {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	case v == 0:
		return 0.0 // folds -0 to +0; see this function's own doc comment
	default:
		return v
	}
}

func ScopeEntries(scope *molang.Scope) []ScopeEntry {
	var out []ScopeEntry
	add := func(ns string, m map[string]float64) {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out = append(out, ScopeEntry{NS: ns, Key: k, Value: jsonSafeNumber(m[k])})
		}
	}
	add("temp", scope.Temp)
	add("variable", scope.Variable)
	add("query", scope.Query)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].NS != out[j].NS {
			return out[i].NS < out[j].NS
		}
		return out[i].Key < out[j].Key
	})
	return out
}

// ---------------------------------------------------------------------------
// Golden digest file shapes.
// ---------------------------------------------------------------------------

type Pos struct {
	X int `json:"x"`
	Y int `json:"y"`
	Z int `json:"z"`
}

type DigestFeature struct {
	FileID     string     `json:"fileId"`
	Identifier string     `json:"identifier"`
	TypeID     string     `json:"typeId"`
	WriteCount int        `json:"writeCount"`
	WriteHash  string     `json:"writeHash"`
	DrawCount  int        `json:"drawCount"`
	DrawHash   string     `json:"drawHash"`
	Returned   *Pos       `json:"returned"`
	Scope      []rawScope `json:"scope"`
	Error      *string    `json:"error"`
	Detail     bool       `json:"detail"`
}

type rawScope struct {
	NS    string `json:"ns"`
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type NotPinnable struct {
	FileID     string `json:"fileId"`
	Identifier string `json:"identifier"`
	TypeID     string `json:"typeId"`
	Reason     string `json:"reason"`
	Message    string `json:"message"`
}

type DigestFile struct {
	Meta        json.RawMessage `json:"meta"`
	NotPinnable []NotPinnable   `json:"notPinnable"`
	Features    []DigestFeature `json:"features"`
}

func LoadDigest(path string) (*DigestFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var d DigestFile
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// ScopeEqual compares Go-computed scope entries against a digest entry's
// raw JSON scope, value-for-value.
func ScopeEqual(got []ScopeEntry, want []rawScope) bool {
	return len(ScopeDiff(got, want)) == 0 && len(got) == len(want)
}

// ScopeDiffEntry describes one key where the Go-computed scope and the
// golden digest disagree (present with different values, or present on
// only one side).
type ScopeDiffEntry struct {
	NS      string
	Key     string
	Got     any // nil if the key is missing from the Go side
	Want    any // nil if the key is missing from the golden side
	GotHas  bool
	WantHas bool
}

// ScopeDiff reports every key where the Go-computed scope and the golden
// digest disagree, by (ns, key). Unlike ScopeEqual it does not short-circuit
// on a length mismatch, so a single missing/extra key doesn't hide value
// differences elsewhere.
func ScopeDiff(got []ScopeEntry, want []rawScope) []ScopeDiffEntry {
	type nk struct{ ns, key string }
	gotByKey := make(map[nk]any, len(got))
	for _, g := range got {
		gotByKey[nk{g.NS, g.Key}] = g.Value
	}
	wantByKey := make(map[nk]any, len(want))
	for _, w := range want {
		wantByKey[nk{w.NS, w.Key}] = w.Value
	}

	keys := make(map[nk]bool, len(gotByKey)+len(wantByKey))
	for k := range gotByKey {
		keys[k] = true
	}
	for k := range wantByKey {
		keys[k] = true
	}

	var out []ScopeDiffEntry
	for k := range keys {
		gv, gHas := gotByKey[k]
		wv, wHas := wantByKey[k]
		if gHas && wHas && scopeValueEqual(gv, wv) {
			continue
		}
		out = append(out, ScopeDiffEntry{NS: k.ns, Key: k.key, Got: gv, Want: wv, GotHas: gHas, WantHas: wHas})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].NS != out[j].NS {
			return out[i].NS < out[j].NS
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func scopeValueEqual(g, w any) bool {
	gf, gIsFloat := g.(float64)
	wf, wIsFloat := w.(float64)
	if gIsFloat != wIsFloat {
		return false
	}
	if gIsFloat {
		return gf == wf
	}
	return g == w
}
