// cellarrays.go — the per-cell arrays a Result carries, and how they cross the wire.
//
// Blocks, Baseline, Changed and Removed all have exactly one entry per cell of the bench
// volume, which is fine at the default 32x48x32 (49k entries) and ruinous at 96x384x96 (3.5
// million, each): a profiled response at that size measured 26 MB of compact JSON, most of it
// these four arrays plus profile.touchCounts. They are also extremely repetitive -- a bench
// volume is mostly untouched environment -- so they are run-length encoded on the wire, which
// took blocks from 8.2 MB to 175 KB in that same measurement. See package featurelab-go/rle for
// the encoding, the numbers behind it, and why the encoded shape is an object rather than a bare
// array.
//
// The named types exist only to carry that MarshalJSON/UnmarshalJSON pair. In Go they behave as
// their underlying slice types: a []block.ID is assignable to CellIDs and vice versa, so
// producing and consuming code needs no conversions and reads exactly as it did before.
//
// Deliberately NOT done as a MarshalJSON on Result itself: wire.GenerateOutput embeds
// *session.Result, so a marshaller here would be promoted to that type and would silently drop
// GenerateOutput's own bounds/seed fields from every `generate` response.
package session

import (
	"fmt"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/rle"
)

// CellIDs is one block id per cell (Result.Blocks and Result.Baseline).
type CellIDs []block.ID

// MarshalJSON run-length encodes the ids. See featurelab-go/rle.
func (c CellIDs) MarshalJSON() ([]byte, error) {
	return rle.Marshal(len(c), func(i int) int64 { return int64(c[i]) })
}

// UnmarshalJSON accepts the encoded shape and the dense array older responses carry.
func (c *CellIDs) UnmarshalJSON(data []byte) error {
	values, err := rle.Unmarshal(data)
	if err != nil {
		return fmt.Errorf("blocks/baseline: %w", err)
	}
	if values == nil {
		*c = nil
		return nil
	}
	out := make(CellIDs, len(values))
	for i, v := range values {
		out[i] = block.ID(v)
	}
	*c = out
	return nil
}

// CellMask is one 0/1 byte per cell (Result.Changed and Result.Removed).
type CellMask []byte

// MarshalJSON run-length encodes the mask. Note this replaces encoding/json's own treatment of
// a []byte, which renders as a base64 string -- an encoding that spends one byte per cell no
// matter how uniform the mask is, and these masks are usually a single run.
func (m CellMask) MarshalJSON() ([]byte, error) {
	return rle.Marshal(len(m), func(i int) int64 { return int64(m[i]) })
}

// UnmarshalJSON accepts the encoded shape, a dense array, and the base64 string a []byte used to
// produce -- see rle.Unmarshal.
func (m *CellMask) UnmarshalJSON(data []byte) error {
	values, err := rle.Unmarshal(data)
	if err != nil {
		return fmt.Errorf("changed/removed mask: %w", err)
	}
	if values == nil {
		*m = nil
		return nil
	}
	out := make(CellMask, len(values))
	for i, v := range values {
		out[i] = byte(v)
	}
	*m = out
	return nil
}
