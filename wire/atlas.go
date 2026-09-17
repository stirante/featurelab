// atlas.go -- delivery of the block-texture atlas to whichever frontend is driving the engine.
//
// ONE MECHANISM FOR EVERY HOST. The three hosts do not share an asset path and cannot be made
// to: apps/desktop embeds frontend/dist with `//go:embed all:frontend/dist`, so a file that does
// not exist at build time can never be inside it; apps/vscode's webview declares
// `localResourceRoots: [dist]`, so a file in the user's cache directory is not addressable from
// it without widening that root and its Content-Security-Policy; and the atlas is by its nature
// a runtime artifact, derived from a vanilla resource pack downloaded into a per-user cache
// directory. What all three hosts DO share is a request/response channel that already carries
// structured JSON -- `serve`'s newline-delimited JSON-RPC and the Wails bindings. So the atlas
// travels that channel, once per session, like every other piece of engine data.
//
// This file owns only the DELIVERY half: finding the two files and putting them on the wire.
// Producing them -- reading a resource pack, packing the cells, resolving which texture belongs
// to which block face -- belongs to whatever builds the atlas, and is deliberately not imported
// here. The seam between the two is the directory layout documented on AtlasDir: an atlas.json
// and an atlas.png sitting next to each other. A builder that writes those two files needs to
// know nothing about hosts, and this file needs to know nothing about resource packs.
//
// EVERY FAILURE IS EXPECTED AND SURVIVABLE. No atlas built yet, a half-written directory, a
// table that is not valid JSON: all of them produce an error the host reports once and then
// carries on with flat per-block colours, which is what the preview draws by default anyway.
// Nothing here may ever be load-bearing for the tool working.
package wire

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// AtlasTableFile and AtlasImageFile are the two files that make up an atlas, and their names are
// part of the contract between whatever builds one and this package.
const (
	AtlasTableFile = "atlas.json"
	AtlasImageFile = "atlas.png"
)

// MaxAtlasImageBytes caps what this package is willing to read and base64 into a single JSON
// response. A vanilla block atlas is a few hundred kilobytes of PNG; 64 MiB is far above any
// plausible one and far below the point where encoding it would be a problem, so this is a guard
// against reading a wrong or corrupt file into memory rather than a real budget. Note the
// `serve` transport has its own 64 MiB line limit (cmd/featurelab/serve.go), which base64's 4/3
// expansion has to fit inside as well.
const MaxAtlasImageBytes = 64 << 20

// ErrNoAtlas is returned when the atlas directory does not exist or holds neither file. It is
// the ORDINARY case -- nobody has built an atlas yet -- and a host is expected to treat it as
// "stay in flat-colour mode", not as a failure worth alarming the user about. Distinguished from
// every other error precisely so a host can tell "not built" apart from "built and broken".
var ErrNoAtlas = errors.New("no block atlas has been built")

// AtlasEnvVar names an environment variable that overrides where AtlasDir looks. Someone with an
// atlas built elsewhere -- a second checkout, a shared directory, a test fixture -- should never
// have to move files to use it.
const AtlasEnvVar = "FEATURELAB_ATLAS_DIR"

// AtlasOutput is the `atlas` method's response, and the exact shape frontend/src/protocol.ts's
// decodeAtlas consumes.
//
// Table is passed through as raw JSON rather than parsed into Go structs on the way past. This
// package delivers the table; it does not interpret it, and every field it might add (a new tint
// channel, a new render mode, per-state entries) would otherwise mean editing a Go struct that
// has no opinion about any of them. The one thing a caller here can rely on is that the bytes
// are valid JSON -- LoadAtlas checks that much, so a truncated file is caught here rather than
// as an unexplained parse error inside a webview.
type AtlasOutput struct {
	Table json.RawMessage `json:"table"`
	// PNG is standard base64 of atlas.png. The ~33% expansion is paid once per session, in
	// exchange for not building three host-specific asset paths -- see this file's header.
	PNG string `json:"png"`
}

// AtlasDir reports where a built atlas lives: FEATURELAB_ATLAS_DIR when set, otherwise
// <user cache dir>/featurelab/atlas. Never inside the repository and never inside a pack -- the
// atlas is derived from Mojang's assets and belongs in the same per-user cache the assets
// themselves are fetched into.
func AtlasDir() (string, error) {
	if override := os.Getenv(AtlasEnvVar); override != "" {
		return override, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("cannot locate a user cache directory for the block atlas: %w", err)
	}
	return filepath.Join(cache, "featurelab", "atlas"), nil
}

// LoadAtlas reads the atlas in dir (AtlasDir() when dir is empty) into the wire shape.
//
// Returns ErrNoAtlas -- wrapped, so errors.Is finds it -- when the directory or either file is
// simply absent, which is the state every machine starts in. Any other error means an atlas that
// exists and is broken, which is worth reporting differently.
func LoadAtlas(dir string) (*AtlasOutput, error) {
	if dir == "" {
		resolved, err := AtlasDir()
		if err != nil {
			return nil, err
		}
		dir = resolved
	}

	tablePath := filepath.Join(dir, AtlasTableFile)
	imagePath := filepath.Join(dir, AtlasImageFile)

	table, err := os.ReadFile(tablePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w (looked in %s)", ErrNoAtlas, dir)
		}
		return nil, fmt.Errorf("reading %s: %w", tablePath, err)
	}
	// A table that is not valid JSON would otherwise reach the frontend as an unexplained
	// failure inside a webview; catching it here names the file.
	if !json.Valid(table) {
		return nil, fmt.Errorf("%s is not valid JSON", tablePath)
	}

	info, err := os.Stat(imagePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s exists but %s does not (looked in %s)", ErrNoAtlas, AtlasTableFile, AtlasImageFile, dir)
		}
		return nil, fmt.Errorf("reading %s: %w", imagePath, err)
	}
	if info.Size() > MaxAtlasImageBytes {
		return nil, fmt.Errorf("%s is %d bytes, above the %d-byte limit this contract carries", imagePath, info.Size(), MaxAtlasImageBytes)
	}

	image, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", imagePath, err)
	}

	return &AtlasOutput{Table: json.RawMessage(table), PNG: base64.StdEncoding.EncodeToString(image)}, nil
}
