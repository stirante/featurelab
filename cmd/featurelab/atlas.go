// atlas.go implements the `serve` "atlas" method: the block-texture atlas,
// delivered over the same newline-delimited JSON-RPC channel every other
// piece of engine data travels on. See wire/atlas.go for why delivery goes
// over the wire rather than through a per-host asset path, and for the
// atlas.json/atlas.png directory layout this reads.
//
// Pack-independent, like "environments" and "types" -- a client may call it
// before or without ever calling "loadPack".
package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/stirante/featurelab/wire"
)

// atlasParams is the method's optional params. An absent/empty dir means
// wire.AtlasDir() -- FEATURELAB_ATLAS_DIR, else the per-user cache
// directory. A client that manages its own atlas location (a test, a
// second checkout) names it here rather than having to set an environment
// variable on a process it did not start.
type atlasParams struct {
	Dir string `json:"dir"`
}

// methodAtlas implements "atlas". "No atlas has been built" comes back as
// an ordinary error response, NOT as a null result: the frontend's recovery
// is the same either way (stay in flat-colour mode) but a client that wants
// to say WHY once needs the sentence, and an error response is how every
// other method on this contract says something is unavailable.
func methodAtlas(raw json.RawMessage) (any, error) {
	var params atlasParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("malformed atlas params: %w", err)
		}
	}
	out, err := wire.LoadAtlas(params.Dir)
	if err != nil {
		if errors.Is(err, wire.ErrNoAtlas) {
			// Reworded rather than passed through: this is the one error a
			// user is likely to see, and it should say what to do about it.
			return nil, fmt.Errorf("%w -- the preview stays on flat block colours until one is", err)
		}
		return nil, err
	}
	return out, nil
}
