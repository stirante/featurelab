// Package rle is the run-length encoding a `generate` response uses for its per-cell arrays.
//
// # Why
//
// A response carries five arrays with one entry per cell: blocks, baseline, changed, removed
// and (when profiling is on) profile.touchCounts. At the default 32x48x32 bench that is 49k
// entries and nobody notices. At 96x384x96 it is 3.5 million EACH, and the response stops being
// a message and becomes a file: measured on this repo's own engine, a profiled run at that size
// produced 26 MB of compact JSON, of which blocks and baseline were 8.2 MB each, the two masks
// 4.7 MB each and touchCounts 10.6 MB. Every byte of that is serialised by the engine, pushed
// through a pipe, and parsed again by a webview that then throws almost all of it away -- which
// is why the VS Code extension stayed far slower than the CLI even after the placement itself
// got 2.8x faster.
//
// The arrays are extraordinarily repetitive, because a bench volume is mostly untouched
// environment: long runs of air, long runs of stone, and -- for the masks and touch counts --
// long runs of zero. The same measurement run-length encodes to 29 009 runs for blocks (8.2 MB
// -> 175 KB, a 47x reduction), and to a SINGLE run for each mask and for touchCounts. A run that
// carves 9 219 cells out of 3.5 million still only reaches 9 813 runs. The encoding is exact,
// not lossy: it is the same array, spelled differently.
//
// # The wire shape
//
// An encoded array is an object with one key, holding value/run-length pairs:
//
//	{"rle": [0, 40960, 5, 1024, 0, 3496960]}
//
// -- "40960 cells of 0, then 1024 of 5, then 3496960 of 0". Run lengths are always >= 1 and the
// pairs are exhaustive, so the cell count is the sum of every second element; a decoder that
// knows the volume's own cell count should check that sum against it, since a mismatch means a
// truncated or hand-edited response rather than a small volume.
//
// The object wrapper is what makes the change safe to roll out. A bare array of numbers cannot
// be told apart from the DENSE array this format replaces -- same JSON type, same element type,
// and both plausible lengths -- so a decoder handed one would have to guess. With the wrapper,
// dense arrays, base64 mask strings (the old encoding for changed/removed) and RLE objects are
// three distinct JSON shapes, and a decoder can accept all three without ambiguity. This repo's
// own captured-response test fixtures predate the change and still decode unmodified, which is
// the point: they exist to prove the decoder handles what the engine really emits, and rewriting
// them to match a new encoder would have quietly removed that proof.
package rle

import (
	"encoding/json"
	"fmt"
)

// wireForm is the encoded shape. Kept unexported: callers hand this package whole JSON
// documents, never this struct, so that the wire spelling stays a fact about this file alone.
type wireForm struct {
	Pairs []int64 `json:"rle"`
}

// Marshal run-length encodes n values, read through at, into the wire shape. The indirection
// through a getter avoids forcing every caller to copy its slice into a []int64 first -- the
// arrays this is used on are the very ones whose size is the problem.
//
// An empty input encodes as {"rle":[]}, which decodes back to an empty slice rather than to nil.
// That distinction does not survive JSON anyway, and no consumer of these arrays distinguishes
// "no cells" from "no array".
func Marshal(n int, at func(i int) int64) ([]byte, error) {
	if n == 0 {
		return json.Marshal(wireForm{Pairs: []int64{}})
	}
	// Two entries per run; a handful of runs is the norm, so this initial capacity is a
	// deliberate under-estimate that grows rather than a worst-case allocation of 2n.
	pairs := make([]int64, 0, 64)
	current := at(0)
	run := int64(1)
	for i := 1; i < n; i++ {
		v := at(i)
		if v == current {
			run++
			continue
		}
		pairs = append(pairs, current, run)
		current = v
		run = 1
	}
	pairs = append(pairs, current, run)
	return json.Marshal(wireForm{Pairs: pairs})
}

// Unmarshal decodes a per-cell array in any of the three shapes this project has emitted, and
// returns the DENSE values -- callers convert to their own element type from there.
//
//   - {"rle": [v, run, ...]} -- what the engine emits now.
//   - [v, v, v, ...] -- the dense array it emitted before, still accepted so an older captured
//     response (this repo keeps several as test fixtures) decodes unchanged.
//   - "base64" -- the old encoding for the changed/removed masks, one byte per cell.
//
// JSON null decodes to a nil slice with no error: an absent array is a legitimate state for the
// optional ones (profile.touchCounts on an unprofiled run), and the caller's own cell-count
// check is the right place to reject a missing array that should have been there.
func Unmarshal(data []byte) ([]int64, error) {
	trimmed := trimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	switch trimmed[0] {
	case '{':
		var w wireForm
		if err := json.Unmarshal(trimmed, &w); err != nil {
			return nil, err
		}
		return expand(w.Pairs)
	case '[':
		var dense []int64
		if err := json.Unmarshal(trimmed, &dense); err != nil {
			return nil, err
		}
		return dense, nil
	case '"':
		var b64 []byte
		// A Go []byte round-trips through encoding/json as a base64 string, which is exactly
		// the old mask encoding -- so this case is the standard decoder, not a hand-rolled one.
		if err := json.Unmarshal(trimmed, &b64); err != nil {
			return nil, err
		}
		out := make([]int64, len(b64))
		for i, v := range b64 {
			out[i] = int64(v)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("rle: expected an object, an array or a base64 string, got %q", firstBytes(trimmed))
	}
}

// maxCells bounds what a decoder will allocate from run lengths it was handed. The encoding's
// whole point is that a few dozen bytes can expand into millions of cells, which is also what
// makes a corrupt or hand-edited document dangerous: `{"rle":[0,999999999999]}` is nine bytes
// that would otherwise ask for eight terabytes. The cap is far above any real volume -- 2^28
// cells is a 640x640x640 bench, an order of magnitude past the largest anything here generates --
// so it can only ever fire on input that was already wrong.
const maxCells = 1 << 28

// expand turns value/run pairs back into the dense array.
func expand(pairs []int64) ([]int64, error) {
	if len(pairs)%2 != 0 {
		return nil, fmt.Errorf("rle: %d pair elements, which is not a whole number of value/run pairs", len(pairs))
	}
	total := int64(0)
	for i := 1; i < len(pairs); i += 2 {
		if pairs[i] < 1 {
			return nil, fmt.Errorf("rle: run length %d at pair %d must be at least 1", pairs[i], i/2)
		}
		total += pairs[i]
		if total > maxCells {
			return nil, fmt.Errorf("rle: run lengths sum past %d cells, which is more than any real volume -- refusing to allocate", maxCells)
		}
	}
	if total == 0 {
		return []int64{}, nil
	}
	out := make([]int64, 0, total)
	for i := 0; i < len(pairs); i += 2 {
		for n := int64(0); n < pairs[i+1]; n++ {
			out = append(out, pairs[i])
		}
	}
	return out, nil
}

func trimSpace(b []byte) []byte {
	start := 0
	for start < len(b) && isSpace(b[start]) {
		start++
	}
	end := len(b)
	for end > start && isSpace(b[end-1]) {
		end--
	}
	return b[start:end]
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func firstBytes(b []byte) string {
	if len(b) > 16 {
		return string(b[:16]) + "..."
	}
	return string(b)
}
