// textures.go -- the first run, in the desktop app.
//
// The flow itself is blocktextures' (Check, then the ask, then Ensure, then
// the atlas over the same binding it always travelled): this file is only the
// desktop's way of ASKING. A window has no terminal to answer a question on,
// so the question is a native dialog -- and the words in it are
// vanillaassets' own notice, not a shorter paraphrase written here, because
// the whole point of that notice is that a user is told what is being fetched,
// from where, how large it is and whose it is BEFORE agreeing to it.
//
// Nothing here is on the critical path of the app working. Every method fails
// by returning an error the frontend turns into a notice line, and the preview
// carries on drawing flat block colours, which is what it drew before.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/stirante/featurelab/blocktextures"
)

// EnvBlockTextures is the desktop app's own on/off switch for textured
// rendering, the twin of the VS Code extension's featurelab.blockTextures
// setting.
//
// UNSET MEANS ON, which is a deliberate change from how this shipped: a
// feature nobody can find is not a feature. What must not depend on whether a
// machine happens to have an atlas is a COMMITTED IMAGE, and no committed
// image is produced by this app or by any host -- docs/wiki/tools/ drives
// frontend/'s VoxelViewer directly and pins textures off explicitly, which is
// where that guarantee belongs. Setting this to "0" turns textures off for
// someone who wants the flat-colour preview back.
const EnvBlockTextures = "FEATURELAB_BLOCK_TEXTURES"

// BlockTexturesEnabled reports whether this app should draw blocks with real
// textures when an atlas is available. See EnvBlockTextures.
func (a *App) BlockTexturesEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(EnvBlockTextures))) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

// textureOptions builds the shared first-run options for the pack this app
// currently has open, so the atlas that gets built contains that pack's own
// blocks and not only vanilla's.
func (a *App) textureOptions() blocktextures.Options {
	a.mu.Lock()
	dir := a.packDir
	a.mu.Unlock()
	return blocktextures.Options{PackDir: dir}
}

// TextureStatus reports whether block textures can be drawn right now, as the
// JSON of a blocktextures.Status: which state this machine is in, whether
// enabling them would need a download, the notice describing that download,
// and a sentence to show a person in every case.
//
// Cheap enough to call on start-up and again whenever a pack is opened -- it
// stats a few files and walks the pack's blocks directory. It never downloads
// and never builds.
func (a *App) TextureStatus() (string, error) {
	return marshalString(blocktextures.Check(a.textureOptions()))
}

// AskForTextureDownload puts the question a GUI cannot put on a terminal:
// a native dialog carrying vanillaassets' own notice verbatim. Returns true
// only for an explicit yes -- a closed dialog, a cancel, or any error is a no,
// because this is permission to use someone's network connection.
//
// Only ever called when TextureStatus says a download would be needed. A
// machine that already has the assets is not being asked for anything and is
// not interrupted.
func (a *App) AskForTextureDownload() (bool, error) {
	status := blocktextures.Check(a.textureOptions())
	if !status.NeedsDownload {
		return true, nil
	}
	if a.ctx == nil {
		// No window (a test, a headless run): there is nobody to ask, and
		// "nobody answered" is a no.
		return false, nil
	}
	answer, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Download Mojang's block textures?",
		Message:       status.Notice,
		Buttons:       []string{"Download", "Not now"},
		DefaultButton: "Download",
		CancelButton:  "Not now",
	})
	if err != nil {
		return false, err
	}
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "download", "yes", "ok":
		return true, nil
	default:
		return false, nil
	}
}

// EnsureTextures builds the atlas -- downloading Mojang's sample resource pack
// first if `download` says that was agreed to -- and returns the resulting
// blocktextures.Result as JSON.
//
// Can take minutes on a first run over a slow line. Wails runs each bound call
// on its own goroutine and this one takes no lock the rest of the app needs
// (textureOptions releases a.mu before returning), so the window stays live and
// a generate during a download is not blocked behind it.
func (a *App) EnsureTextures(download bool) (string, error) {
	opts := a.textureOptions()
	opts.Vanilla.Download = download
	// The desktop app has no stderr anyone reads, so route Piece A's own
	// announcement into the frontend as an event instead of letting it default
	// to a stream nobody sees.
	opts.Vanilla.Announce = func(notice string) { a.emit(TextureProgressEvent, notice) }
	opts.Vanilla.Progress = func(n int64) {
		a.emit(TextureProgressEvent, fmt.Sprintf("Downloading Mojang's block textures: %d MB received…", n>>20))
	}
	opts.Progress = func(step string) { a.emit(TextureProgressEvent, capitalise(step)+"…") }

	result, err := blocktextures.Ensure(context.Background(), opts)
	if err != nil {
		return "", err
	}
	return marshalString(result)
}

// DeclineTextures records that this machine was offered the download and said
// no, so neither this app nor any other host asks again.
func (a *App) DeclineTextures() error {
	return blocktextures.Decline(a.textureOptions())
}

// TextureProgressEvent is the Wails runtime event carrying one line about what
// the texture build is doing -- the download notice, byte counts, and the
// coarse steps around them. The frontend shows the latest one in its notice
// bar; a download with no sign of life reads as a hang.
const TextureProgressEvent = "textures:progress"

func marshalString(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("encoding block texture status: %w", err)
	}
	return string(b), nil
}

func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
