// app.go -- the Wails-bound App struct. Every exported method on *App is callable from the
// frontend via the generated frontend/wailsjs/go/main/App bindings.
//
// Owns exactly one loaded pack.Pack at a time (like previewController.ts's "one live engine
// process, one loaded pack" policy, minus the process: the desktop app links the engine
// in-process), the session.Workspace holding the libraries built from it, and the
// PackWatcher for whichever directory that pack was loaded from. A file save under the
// watched root reloads what actually changed (see handlePackChanged -- one file where that
// can be answered for, the whole pack where it cannot) and then emits "pack:changed" for the
// frontend to react to; this Go side never decides what to regenerate or touches any
// camera/view state, which is what keeps "regenerate on save without losing camera position"
// true (that state lives entirely in the shared frontend/ package, same as it does for the
// VS Code extension's webview).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/stirante/featurelab/env"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"
	"github.com/stirante/featurelab/wire"
)

// PackChangedEvent is the Wails runtime event name emitted whenever the watched pack
// directory changes on disk, after this app has already reloaded it from disk -- a frontend
// handler for this event can immediately call Generate again with its own last-used params
// and be guaranteed to see the edit, no separate "reload" round trip required.
const PackChangedEvent = "pack:changed"

// EnvironmentOption is the JSON-friendly projection of env.EnvironmentPreset this app's
// environment picker needs -- EnvironmentPreset itself carries a Build func value and other
// non-serializable fields, so it cannot be handed to the frontend as-is.
//
// TWO PROJECTIONS OF ONE SOURCE. This type and cmd/featurelab/environments.go's own
// EnvironmentOption are both hand-written projections of the SAME env.EnvironmentPreset, for two
// hosts that reach the engine differently (a Wails binding here, `serve` JSON-RPC there). The
// field NAMES differ where each host's picker wants them flattened differently (defaultSizeX
// here vs a nested defaults object there), and that one carries Materials/Biome/BiomeTags this
// one has never needed -- but any field that describes what a preset IS, rather than what one
// host happens to render, belongs in BOTH. A field added to only one of them is a picker in one
// app that knows something the picker in the other does not. Change both.
type EnvironmentOption struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Description  string `json:"description"`
	DefaultSizeX int    `json:"defaultSizeX"`
	DefaultSizeY int    `json:"defaultSizeY"`
	DefaultSizeZ int    `json:"defaultSizeZ"`
	DefaultMinY  int    `json:"defaultMinY"`
	// BuildsSea is env.EnvironmentPreset.BuildsSea: whether this preset's Build actually models a
	// sea, and so whether the sea_floor_material/sea_material/sea_floor_depth material slots mean
	// anything under it ("ocean" alone, in this port). Carried so this app's Materials controls can
	// DISABLE those three under a preset that ignores them rather than leaving three live-looking
	// inputs that do nothing until the run comes back with env.InertSeaSlotOverrides' warning --
	// same use the `serve` projection carries it for (see frontend/src/ui/panel.ts's Materials
	// section). The engine stays the single source of truth for which presets those are: a client
	// reads this flag rather than hardcoding "ocean" a second time.
	BuildsSea bool `json:"buildsSea"`
}

// LoadPackResult is OpenPack's return shape: warnings (mirrors pack.Pack.Warnings -- e.g. no
// feature_rules/ directory in this pack) plus every feature/rule this app found and could
// identify, for the picker.
type LoadPackResult struct {
	Dir      string     `json:"dir"`
	Warnings []string   `json:"warnings"`
	Items    []PackItem `json:"items"`
}

// App is the bound Wails application struct.
//
// mu guards everything below it and is held for the WHOLE of a Generate call, not just long
// enough to read a pointer out. session.Workspace is explicitly not safe for concurrent use
// (see its doc comment) and the watcher's reload goroutine mutates it, so a generate that
// merely borrowed the pointer could be reading half-rebuilt libraries while a save spliced
// the other half. Holding the lock costs nothing worth counting now that a generate against
// a warm Workspace is single-digit milliseconds rather than the ~300ms a from-scratch
// library build used to take.
type App struct {
	ctx context.Context

	mu     sync.Mutex
	loaded *pack.Pack
	// workspace holds the libraries built from loaded, so a regenerate does not re-parse
	// every source file (measured: ~300ms per generate on a large pack when each call built
	// its own throwaway workspace, ~4ms against this one). Built lazily on the first generate
	// rather than inside LoadPack: the full build is ~370ms on that pack and LoadPack's
	// caller is a user waiting for the feature picker to appear, which does not need it.
	// nil means "not built yet", which the save path handles rather than forcing.
	workspace *session.Workspace
	packDir   string
	watcher   *PackWatcher

	// emitEvent, when non-nil, replaces runtime.EventsEmit. Only tests set it: the Wails
	// runtime's event emitter calls log.Fatalf when handed a context that did not come from
	// a running Wails app, so without this seam nothing that emits an event -- which is the
	// whole save path -- could be exercised in-process at all.
	emitEvent func(name string, data ...any)
}

// NewApp constructs an unstarted App -- see startup for what needs the Wails context.
func NewApp() *App {
	return &App{}
}

// startup is called by Wails once the native window/context exists -- saved so bound methods
// can call runtime functions (dialogs, event emission) that require it.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// emit sends one Wails runtime event to the frontend -- through App.emitEvent when a test
// has installed one, through the real runtime otherwise. Never call this while holding
// a.mu: a frontend handler for "pack:changed" calls straight back into Generate, and making
// it wait behind the lock the emitter itself is under is pure added latency on exactly the
// path this app cares about.
func (a *App) emit(name string, data ...any) {
	if a.emitEvent != nil {
		a.emitEvent(name, data...)
		return
	}
	runtime.EventsEmit(a.ctx, name, data...)
}

// shutdown is called by Wails as the application is closing -- stops the file watcher so its
// goroutine doesn't outlive the window.
func (a *App) shutdown(_ context.Context) {
	a.mu.Lock()
	w := a.watcher
	a.watcher = nil
	a.mu.Unlock()
	if w != nil {
		_ = w.Close()
	}
}

// SelectPackDirectory opens a native "choose a folder" dialog and returns the chosen path, or
// "" if the user cancelled -- the desktop app's equivalent of the VS Code extension reading
// packRoot off whichever document is open, since a standalone app has no editor to ask.
func (a *App) SelectPackDirectory() (string, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select a behaviour pack directory",
	})
	if err != nil {
		return "", err
	}
	return dir, nil
}

// LoadPack loads dir as a behaviour pack (pack.Load's own features/structures/feature_rules/
// biomes convention), replaces whichever pack was previously loaded, and (re)starts the file
// watcher on dir. Mirrors previewController.ts's ensurePackLoaded, except there is no
// "already loaded, skip" shortcut here: LoadPack is only ever called in response to an
// explicit user action (picking a directory), never on every regenerate -- see
// handlePackChanged for the save-triggered path, which reloads without going through this
// method's watcher (re)start.
func (a *App) LoadPack(dir string) (*LoadPackResult, error) {
	if dir == "" {
		return nil, fmt.Errorf("no directory given")
	}
	loaded, err := pack.Load(pack.Options{Dir: dir})
	if err != nil {
		return nil, err
	}

	watcher, err := NewPackWatcher(dir, a.handlePackChanged)
	if err != nil {
		return nil, fmt.Errorf("watching %s: %w", dir, err)
	}

	a.mu.Lock()
	if a.watcher != nil {
		_ = a.watcher.Close()
	}
	a.loaded = loaded
	// A new pack gets a new Workspace, built on demand by the next generate. Updating the
	// old one in place would work (session.Workspace.Update is content-fingerprinted and
	// cmd/featurelab/serve.go does reuse one across packs), but every kind's fingerprint
	// differs between two unrelated packs anyway, so reuse would save nothing and would keep
	// the previous pack's interned block ids alive for as long as the app runs.
	a.workspace = nil
	a.packDir = dir
	a.watcher = watcher
	a.mu.Unlock()

	warnings := loaded.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	return &LoadPackResult{Dir: dir, Warnings: warnings, Items: listPackItems(loaded)}, nil
}

// ListPackItems returns the currently loaded pack's feature/rule identifiers again, without
// touching disk or the watcher -- lets the frontend refresh its picker after a "pack:changed"
// event picks up a renamed/added/removed identifier, without a full LoadPack (which would
// restart the watcher).
func (a *App) ListPackItems() ([]PackItem, error) {
	a.mu.Lock()
	loaded := a.loaded
	a.mu.Unlock()
	if loaded == nil {
		return nil, fmt.Errorf("no pack loaded -- call LoadPack first")
	}
	return listPackItems(loaded), nil
}

// ListEnvironments returns every environment preset id (env.ENVIRONMENTS), for the
// environment picker control.
func (a *App) ListEnvironments() []EnvironmentOption {
	out := make([]EnvironmentOption, 0, len(env.ENVIRONMENTS))
	for _, preset := range env.ENVIRONMENTS {
		out = append(out, EnvironmentOption{
			ID:           string(preset.ID),
			Label:        preset.Label,
			Description:  preset.Description,
			DefaultSizeX: preset.Defaults.SizeX,
			DefaultSizeY: preset.Defaults.SizeY,
			DefaultSizeZ: preset.Defaults.SizeZ,
			DefaultMinY:  preset.Defaults.MinY,
			BuildsSea:    preset.BuildsSea,
		})
	}
	return out
}

// LoadAtlas returns the block-texture atlas as JSON -- the same {table, png} envelope
// cmd/featurelab's `atlas` serve method returns and frontend/src/protocol.ts's decodeAtlas
// consumes, delivered over this app's Wails bindings instead of over JSON-RPC. See
// wire/atlas.go for why the atlas travels the engine's own channel on every host rather than
// through three separate asset paths.
//
// Returns an error (a rejected JS promise) when no atlas has been built, which is the state
// every machine starts in. The frontend's recovery is to stay on flat block colours, which is
// what it draws by default anyway. Marshalled to a string like Generate above, so this needs no
// generated model type of its own.
func (a *App) LoadAtlas() (string, error) {
	out, err := wire.LoadAtlas("")
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("encoding block atlas: %w", err)
	}
	return string(b), nil
}

// Generate runs one feature/rule placement against the currently loaded pack's Workspace --
// see featurelab-go/wire's RunGenerateFromWorkspace (the shared `generate` request/response
// contract this app, cmd/featurelab, and serve all now import instead of each declaring their
// own copy; the from-Workspace half of it is the one `serve` uses too, for the same reason
// this app now does -- a long-lived process regenerating repeatedly). Returns
// an error (which Wails turns into a rejected JS promise) rather than a partial/zero result
// when no pack is loaded yet, so the frontend never mistakes "nothing to show because nothing
// is loaded" for "generation ran and produced nothing" -- exactly the "never leave a silently
// frozen preview" requirement.
//
// Returns the ALREADY JSON-ENCODED result (a string), not *wire.GenerateOutput directly, for a
// concrete, verified reason: GenerateOutput embeds *session.Result, which promotes fields
// from half a dozen other packages (block.Entry, session.Placement/Diagnostic,
// features.Entry, rules.FeatureRule/FeatureRuleEntry, molang.Scope, profiler.ProfileResult).
// Wails v2's TS codegen (`wails generate module`) does not fully resolve that cross-package
// object graph -- it emits references to `block`/`session`/`features`/`rules` namespaces in
// frontend/wailsjs/go/models.ts without ever generating them, which fails to typecheck. Since
// frontend/src/protocol.ts's decodeGenerateResult already treats its input as `unknown` and
// validates it itself at runtime (it does not need or want a generated TS class for this
// shape), returning the same bytes encoding/json.Marshal would produce -- exactly what
// cmd/featurelab's own `generate` subcommand prints -- and letting the frontend JSON.parse
// them sidesteps the broken codegen path entirely rather than fighting it.
func (a *App) Generate(params wire.GenerateParams) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ws, err := a.ensureWorkspaceLocked()
	if err != nil {
		return "", err
	}
	out, err := wire.RunGenerateFromWorkspace(ws, params)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("encoding generate result: %w", err)
	}
	return string(b), nil
}

// ensureWorkspaceLocked returns the Workspace for the currently loaded pack, building it on
// first use. Caller must hold a.mu.
//
// The one-shot wire.RunGenerate this replaced built a throwaway Workspace per call, which is
// right for `featurelab generate` (one placement, then the process exits) and wrong for a
// window the user regenerates in all afternoon: on a large pack it re-parsed hundreds of
// .mcstructure files and thousands of feature files on every single regenerate, ~300ms of it,
// to produce libraries byte-identical to the ones the previous call threw away.
func (a *App) ensureWorkspaceLocked() (*session.Workspace, error) {
	if a.loaded == nil {
		return nil, fmt.Errorf("no pack loaded -- open a pack directory first")
	}
	if a.workspace == nil {
		a.workspace = session.NewWorkspace(a.loaded.Features, a.loaded.Structures, a.loaded.Rules, a.loaded.Biomes, a.loaded.Blocks)
	}
	return a.workspace, nil
}

// GenerateGrown is Generate's "grow to fit and regenerate" counterpart (wire.RunGenerateGrownFromWorkspace --
// see that package's doc comment, "Grow-and-regenerate"): runs one placement, and, only if it
// captured any out-of-bounds writes, expands the bench to contain them and places AGAIN at the
// larger size -- a genuinely different run, not a wider view of the same one. Same params shape,
// same "already JSON-encoded string" return convention as Generate above, for the same reason
// (see Generate's own doc comment on why: Wails' TS codegen cannot fully resolve
// GenerateOutput's cross-package embedded fields, and GrownGenerateOutput embeds one). The
// decoded JSON carries `grown`/`preGrowBounds` alongside every field Generate's own response
// has -- frontend/src/protocol.ts's decodeGenerateResult reads both.
func (a *App) GenerateGrown(params wire.GenerateParams) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ws, err := a.ensureWorkspaceLocked()
	if err != nil {
		return "", err
	}
	out, err := wire.RunGenerateGrownFromWorkspace(ws, params)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("encoding generate result: %w", err)
	}
	return string(b), nil
}

// handlePackChanged is the PackWatcher callback (see watcher.go): brings the loaded pack back
// in step with disk -- so the save that just happened is actually reflected in the next
// Generate call -- and only then emits PackChangedEvent, guaranteeing no race where the
// frontend regenerates against stale data. A reload failure (e.g. a transient read during a
// multi-file save, or the directory itself was removed) is reported via a separate event
// rather than silently keeping the old pack around and pretending nothing happened.
//
// It tries the changed files first and re-reads the whole pack when it cannot (see
// reloadChangedLocked). Getting that choice wrong in the "reload everything" direction costs
// one full pack.Load, measured 475-594ms on the real 3,493-feature pack; getting it wrong in
// the other direction shows the user a preview of a file they no longer have. So every
// refusal, every error, and every path this app cannot account for takes the slow road, and
// the fast one is taken only when the whole batch was accounted for.
func (a *App) handlePackChanged(change PackChange) {
	a.mu.Lock()
	dir := a.packDir
	if dir == "" {
		a.mu.Unlock()
		return
	}
	if a.reloadChangedLocked(change) {
		a.mu.Unlock()
		a.emit(PackChangedEvent)
		return
	}
	loaded, err := pack.Load(pack.Options{Dir: dir})
	if err != nil {
		// Deliberately keeps the previously loaded pack: a pack that momentarily cannot be
		// read is not a reason to leave the window with nothing to generate from.
		a.mu.Unlock()
		a.emit("pack:reloadError", err.Error())
		return
	}
	a.loaded = loaded
	if a.workspace != nil {
		a.workspace.Update(loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	}
	a.mu.Unlock()
	a.emit(PackChangedEvent)
}

// reloadChangedLocked re-reads exactly the files this batch named, reporting whether it could
// account for the whole batch. false means the caller must do a full pack.Load; it is never
// a failure, only "this route cannot answer for that batch". Caller must hold a.mu.
//
// The batch is all-or-nothing, and that is the decision worth spelling out: one path in a
// batch that pack.Pack.ReloadFile refuses (a directory that was just created, an editor's
// temp file, a manifest.json outside every asset directory) does NOT mean the other paths in
// that batch are dropped -- it means the full reload takes over and re-reads them along with
// everything else. That is why the splices go into a COPY of the Pack: a batch abandoned
// half-way leaves a.loaded exactly as it was, so what the caller then falls back to is a
// clean full load rather than a load layered over a partial splice.
//
// The copy is also what keeps session.Workspace's no-in-place-mutation obligation (see
// reuseFingerprint) intact from this side. Pack is a struct of slice headers and
// ReloadFile/spliceSorted only ever REPLACE those headers, never write through them, so the
// slices a.workspace is still holding as "the files I last built from" are untouched by a
// splice that gets abandoned -- and, for a kind the batch did not touch at all, the very same
// slice comes back out the other side, which is what lets Update skip re-hashing it (~19MB of
// structure files on a large pack) instead of re-fingerprinting the whole pack per save.
func (a *App) reloadChangedLocked(change PackChange) bool {
	if a.loaded == nil {
		return false
	}
	// An incomplete batch is a batch whose membership is unknown, not a small one -- see
	// PackChange.Complete. An empty complete batch should not reach here at all (the watcher
	// only fires after an event), but "reload nothing" is not an answer this can give, so it
	// takes the slow road too rather than emitting a change that changed nothing.
	if !change.Complete || len(change.Paths) == 0 {
		return false
	}
	next := *a.loaded
	for _, path := range change.Paths {
		if err := next.ReloadFile(path); err != nil {
			// Matched by the fact that there IS an error, never by what it says -- the
			// message is a diagnostic, not a protocol, and a reworded one must not be able
			// to quietly turn the fallback off.
			return false
		}
	}
	a.loaded = &next
	if a.workspace != nil {
		a.workspace.Update(next.Features, next.Structures, next.Rules, next.Biomes, next.Blocks)
	}
	return true
}
