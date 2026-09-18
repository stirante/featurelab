// Package blocktextures is the first run: the one place that turns "this
// machine has no block textures" into "this preview is drawing them", and the
// only place any host has to know about to offer that.
//
// Every part of the chain already existed and none of them were joined up:
//
//	vanillaassets.Resolve -> atlas.Build -> wire.AtlasDir() -> the atlas wire
//	method -> the renderer
//
// so getting textures took a person running a build command by hand, which is
// not a feature anyone has. This package is that command, minus the person:
// Check says what state a machine is in and Ensure moves it to "ready",
// including the pack's OWN blocks, which are 40% of what a real preview draws
// and would otherwise stay flat hash colours.
//
// # The ask is not optional and is not repeated
//
// Downloading is Piece A's rule, kept exactly: nothing is fetched without an
// explicit gesture, and the notice naming Mojang, the tag, the URL, the size
// and the cache path is shown BEFORE the gesture is asked for, not after it is
// made (vanillaassets.Notice exists for that). A machine that already has the
// assets -- a checkout in FEATURELAB_VANILLA_PACK, or a populated cache --
// needs no gesture at all, because the gesture is about the network and there
// is no network in that path.
//
// A "no" is remembered, in a file next to the atlas (declineFile), so the
// question is asked once per machine and not once per launch. It is remembered
// per machine rather than per host so that declining in the CLI is also a
// decline in the editor: the user said no to fetching Mojang's assets, not no
// to a particular window. Ensure with Download set clears it -- asking for the
// thing is a better answer than the last "not now".
//
// # Every state has a sentence
//
// Status.Detail is written for a person, always populated, and is what a host
// shows when textures are not on. "The preview draws flat colours" with no
// explanation is indistinguishable from the feature being broken, and that is
// the specific failure this package exists to prevent -- offline machines are
// a normal case, not an edge one.
//
// # No test here touches the network
//
// This package's own tests build against a fixture resource_pack directory on
// disk and assert that the no-assets-and-no-permission path fails rather than
// fetching. Options.Vanilla carries Piece A's BaseURL/HTTPClient seams
// straight through for a caller that wants to exercise the transport itself,
// which Piece A's own tests already do against an httptest server.
package blocktextures

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/stirante/featurelab/block"
	"github.com/stirante/featurelab/internal/atlas"
	"github.com/stirante/featurelab/internal/packrender"
	"github.com/stirante/featurelab/internal/rptex"
	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/vanillaassets"
	"github.com/stirante/featurelab/wire"
)

// State is what a host branches on. It is a string rather than an int so it
// survives the JSON trip to a webview and a Wails binding unchanged.
type State string

const (
	// StateReady means the two files are on disk, built from the tag this
	// build expects, and (when a pack was named) with that pack's own blocks
	// in them. Turn textures on.
	StateReady State = "ready"
	// StateMissing means nothing has been built here yet. This is what every
	// machine starts as, and is the state the offer exists for.
	StateMissing State = "missing"
	// StateStale means an atlas exists but was built from something else: a
	// different bedrock-samples tag (the pin moved), a different pack, or the
	// same pack with any of its block definitions or its own textures edited
	// since (compared by CONTENT -- see packhash.go). Rebuilding is the fix
	// and it needs no network if the assets are already cached, so a host may
	// simply do it.
	StateStale State = "stale"
	// StateBroken means an atlas exists and cannot be read -- a truncated
	// table, an unreadable file. Distinguished from Missing because the
	// answer is different: something went wrong, and saying "not built yet"
	// about a directory full of files sends the user looking in the wrong
	// place.
	StateBroken State = "broken"
	// StateDeclined means this machine has already been asked and said no.
	// A host does not ask again and does not warn; it simply draws flat
	// colours, which is what it drew before the question.
	StateDeclined State = "declined"
)

// Status is the whole answer to "can this preview draw textures, and if not,
// what do I say about it".
type Status struct {
	State State  `json:"state"`
	Dir   string `json:"dir"`
	// Tag is the bedrock-samples tag the atlas on disk was built from, when
	// there is one. WantTag is the tag this build expects; they differ
	// exactly when the pin has moved under an existing cache.
	Tag     string `json:"tag,omitempty"`
	WantTag string `json:"wantTag"`
	// Pack is the pack directory whose own blocks are in the atlas on disk,
	// empty for a vanilla-only atlas.
	Pack string `json:"pack,omitempty"`
	// NeedsDownload is true when building would have to reach the network:
	// no checkout is configured and the cache has nothing for WantTag. It is
	// the ONLY reason to ask the user anything.
	NeedsDownload bool `json:"needsDownload"`
	// Notice is vanillaassets' own description of that download -- what,
	// from where, how large, whose, and where it lands. Populated whenever
	// NeedsDownload is; a host shows it verbatim rather than writing its own
	// shorter, vaguer version.
	Notice string `json:"notice,omitempty"`
	// Detail is one sentence for a person, always set.
	Detail string `json:"detail"`
	// Reason carries the underlying error for StateBroken.
	Reason string `json:"reason,omitempty"`
}

// Ready reports whether textures can be drawn right now.
func (s Status) Ready() bool { return s.State == StateReady }

// Buildable reports whether Ensure would do something useful: an atlas is
// missing or stale and either the assets are here or a download is permitted.
func (s Status) Buildable() bool { return s.State == StateMissing || s.State == StateStale }

// Options configures Check, Ensure and Decline. The zero value is meaningful:
// the per-user atlas directory, the pinned tag, no pack blocks, no network.
type Options struct {
	// Dir is where the atlas lives. Empty means wire.AtlasDir() -- the same
	// directory the atlas wire method reads, which is the entire point.
	Dir string

	// Vanilla is Piece A's own options, passed through whole rather than
	// re-spelled here: Dir/Download/Tag/CacheDir/BaseURL/HTTPClient/
	// Announce/Progress all mean exactly what they mean there, and a host
	// registers Piece A's own flags for them (vanillaassets.RegisterFlags)
	// instead of inventing a second way to point at a resource pack.
	Vanilla vanillaassets.Options

	// PackDir is the behaviour pack whose own blocks should be drawn with
	// their own textures. Empty builds a vanilla-only atlas. Naming it here
	// is what makes the difference between a preview where 40% of the block
	// names are hash colours and one where they are not.
	PackDir string
	// ResourcePackDir overrides which resource pack PackDir's textures are
	// resolved through. Empty means pack.FindResourcePack's own answer (the
	// manifest UUID dependency, then directory naming), which is right
	// nearly always and reports how it decided.
	ResourcePackDir string

	// FallbackBlocksPath is handed to atlas.Build for a resource pack that
	// ships no blocks.json of its own. Empty means this repository's
	// committed extract, resolved relative to the working directory, which
	// is only useful when running from the repository -- a shipped binary
	// leaves it empty and relies on the pack's own.
	FallbackBlocksPath string

	// Progress reports what a build is doing, in whole steps ("resolving
	// vanilla assets", "packing 1207 textures"). nil discards them. This is
	// coarse on purpose: the download's own byte progress is
	// Vanilla.Progress, and this is the thing around it.
	Progress func(step string)
}

// Result is one successful Ensure.
type Result struct {
	Status Status      `json:"status"`
	Stats  atlas.Stats `json:"stats"`
	// Pack summarises what the pack under test contributed, nil when no
	// pack was named.
	Pack *PackSummary `json:"pack,omitempty"`
	// Notes are the pack's per-block "drawn as a full cube because its
	// geometry is a resource-pack model" notes, in block name order. They
	// are carried per block in the atlas table as well (atlas.Block.Note),
	// which is what lets a host show only the ones a given preview actually
	// placed rather than all of them.
	Notes []block.RenderNote `json:"notes,omitempty"`
}

// PackSummary counts what a pack contributed to the sheet.
type PackSummary struct {
	Dir string `json:"dir"`
	// ResourcePack and How are pack.FindResourcePack's answer: which
	// resource pack the textures came from and which rule found it.
	ResourcePack string `json:"resourcePack,omitempty"`
	How          string `json:"how,omitempty"`
	Blocks       int    `json:"blocks"`
	// Fully is blocks that draw exactly as declared; ShapeCube is blocks
	// whose geometry is a resource-pack model and so draw as a textured
	// cube; Untextured is blocks with at least one face whose texture key
	// resolved to no image at all.
	Fully      int `json:"fully"`
	ShapeCube  int `json:"shapeCube"`
	Untextured int `json:"untextured"`
	// Textures is how many of the pack's own texture files were packed into
	// the sheet alongside vanilla's, and Reused how many texture keys the
	// pack borrows from vanilla and therefore needed nothing packed.
	Textures int `json:"textures"`
	Reused   int `json:"reused"`
	// Unresolved says, per block face, WHY a texture key produced no image --
	// the key is absent from terrain_texture.json, or it is there and the file
	// it names is not on disk. Untextured above is the count of affected
	// blocks and was, until this field existed, the whole of what a host could
	// say: "3 blocks with an unresolved texture" and no way to find out which
	// three or what to do about them, while the preview drew those blocks as
	// flat colours indistinguishable from the tool not having textures at all.
	// Truncated to UnresolvedLimit entries; UnresolvedTotal is the real count.
	Unresolved      []UnresolvedTexture `json:"unresolved,omitempty"`
	UnresolvedTotal int                 `json:"unresolvedTotal,omitempty"`
}

// UnresolvedTexture is one block face whose texture key produced no image.
type UnresolvedTexture struct {
	Block   string `json:"block"`
	Face    string `json:"face"`
	Texture string `json:"texture"`
	Reason  string `json:"reason"`
}

// UnresolvedLimit caps PackSummary.Unresolved. A pack that ships no resource
// pack at all has one entry per face of every block it defines, which is
// hundreds of identical sentences; the count plus a readable sample is what a
// person can act on, and the full list is what `featurelab blocktable` is for.
const UnresolvedLimit = 20

// markerFile records what the atlas in a directory was built from. It sits
// beside atlas.json/atlas.png and is ignored by wire.LoadAtlas, which reads
// only those two names -- the seam between building and delivering stays
// exactly where Piece C put it.
const markerFile = ".featurelab-atlas.json"

// declineFile records that this machine was asked and said no. Its presence,
// not its contents, is the answer; the contents are there so a person who
// finds it knows what it is and how to undo it.
const declineFile = ".featurelab-textures-declined.json"

const markerVersion = 1

type marker struct {
	Version int    `json:"version"`
	Tag     string `json:"tag"`
	Built   string `json:"built"`
	Pack    string `json:"pack,omitempty"`
	// PackSources is exactly which of the pack's files went into this
	// atlas, and PackDigest is the SHA-256 over their CONTENTS. Together
	// they are what turns "ready" into "stale" after an edit -- see
	// packhash.go, which also says what is deliberately not in them.
	//
	// An atlas built before this package hashed anything has neither, and
	// is treated as stale once rather than trusted: it was checked by rules
	// this build no longer believes.
	PackSources *packSources       `json:"packSources,omitempty"`
	PackDigest  string             `json:"packDigest,omitempty"`
	Blocks      int                `json:"blocks"`
	PackBlocks  int                `json:"packBlocks,omitempty"`
	Notes       []block.RenderNote `json:"notes,omitempty"`
	Note        string             `json:"note"`
}

type declineRecord struct {
	Declined string `json:"declined"`
	Tag      string `json:"tag"`
	Note     string `json:"note"`
}

// Dir resolves where the atlas lives for these options.
func (o Options) dir() (string, error) {
	if strings.TrimSpace(o.Dir) != "" {
		return o.Dir, nil
	}
	return wire.AtlasDir()
}

func (o Options) progress(step string) {
	if o.Progress != nil {
		o.Progress(step)
	}
}

// Check reports what state this machine is in without building, downloading,
// or touching the network. It is cheap enough to call on every start-up: it
// stats a handful of files and, when a pack is named, walks that pack's block
// directory.
func Check(opts Options) Status {
	want := effectiveTag(opts)
	st := Status{State: StateMissing, WantTag: want}

	dir, err := opts.dir()
	if err != nil {
		st.State = StateBroken
		st.Reason = err.Error()
		st.Detail = "Block textures are unavailable: " + err.Error() + ". The preview draws flat block colours."
		return st
	}
	st.Dir = dir

	// Whether a download would be needed is worth knowing in EVERY state, not
	// just the missing one: it is what decides whether a stale atlas can be
	// rebuilt silently, and what a host tells someone whose atlas is broken.
	if _, ok := vanillaassets.Cached(opts.Vanilla); !ok {
		st.NeedsDownload = true
		if n, err := vanillaassets.Notice(opts.Vanilla); err == nil {
			st.Notice = n
		}
	}

	m, mErr := readMarker(dir)
	_, tableErr := os.Stat(filepath.Join(dir, wire.AtlasTableFile))
	_, imageErr := os.Stat(filepath.Join(dir, wire.AtlasImageFile))
	switch {
	case errors.Is(tableErr, fs.ErrNotExist) || errors.Is(imageErr, fs.ErrNotExist):
		// Nothing built (or a half-built directory, which reads the same and
		// is fixed the same way). A decline only matters here: once an atlas
		// exists, what to do with it is not a question anyone was asked.
		if declined(dir) {
			st.State = StateDeclined
			st.Detail = "Block textures are off: this machine was asked once and declined. " +
				"Run `featurelab textures --download` to change that."
			return st
		}
		st.Detail = detailForMissing(st)
		return st
	case tableErr != nil:
		st.State = StateBroken
		st.Reason = tableErr.Error()
		st.Detail = "The block atlas in " + dir + " could not be read (" + tableErr.Error() +
			"); the preview draws flat block colours until it is rebuilt."
		return st
	case imageErr != nil:
		st.State = StateBroken
		st.Reason = imageErr.Error()
		st.Detail = "The block atlas in " + dir + " could not be read (" + imageErr.Error() +
			"); the preview draws flat block colours until it is rebuilt."
		return st
	}

	if mErr != nil {
		// The two files are there but nothing says what they are. An atlas
		// built by `genatlas` before this package existed looks exactly like
		// this, so it is treated as usable-but-unlabelled rather than broken:
		// the table itself carries the tag, and that is what gets checked.
		if tag, err := tableTag(dir); err == nil {
			m = &marker{Tag: tag}
		} else {
			st.State = StateBroken
			st.Reason = err.Error()
			st.Detail = "The block atlas in " + dir + " could not be read (" + err.Error() +
				"); the preview draws flat block colours until it is rebuilt."
			return st
		}
	}
	st.Tag = m.Tag
	st.Pack = m.Pack

	if m.Tag != "" && m.Tag != want {
		st.State = StateStale
		st.Detail = "The block atlas on this machine was built from bedrock-samples " + m.Tag +
			" and this build expects " + want + "; rebuilding it will pick up the newer textures."
		return st
	}
	if wantPack := strings.TrimSpace(opts.PackDir); wantPack != "" {
		if !pack.SamePath(m.Pack, wantPack) {
			st.State = StateStale
			st.Detail = "The block atlas on this machine does not include this pack's own blocks; " +
				"rebuilding it will draw them with their own textures instead of flat colours."
			return st
		}
		if m.PackSources == nil {
			// An atlas from a build that compared this pack by file
			// count, size and mtime. Those miss a repainted texture,
			// which is the common edit, so the atlas is not trusted --
			// but it is said plainly rather than reported as an edit
			// nobody made.
			st.State = StateStale
			st.Detail = "The block atlas on this machine was built before featurelab compared this pack's " +
				"files by content; rebuilding it once brings it up to date."
			return st
		}
		if digest, _ := m.PackSources.digest(); digest != m.PackDigest {
			st.State = StateStale
			st.Detail = "This pack's block definitions or textures have changed since the block atlas was " +
				"built; rebuilding it will pick them up."
			return st
		}
	}

	st.State = StateReady
	st.Detail = "Block textures are ready: " + dir + ", built from bedrock-samples " + m.Tag + "."
	return st
}

// localCheckoutSuffix labels an atlas built from a resource pack the user
// pointed at rather than from the pinned release. Without it a checkout would
// be recorded under the pinned tag's name and a later Check would report an
// atlas built from something else as up to date.
const localCheckoutSuffix = " (local checkout)"

// effectiveTag is what an atlas built with these options is labelled with, and
// therefore also what Check compares an existing atlas against. One function
// for both, because the two disagreeing means either a permanent "stale" or a
// silently wrong atlas, depending on which way it drifts.
func effectiveTag(o Options) string {
	tag := o.Vanilla.Tag
	if tag == "" {
		tag = vanillaassets.PinnedTag
	}
	if strings.TrimSpace(o.Vanilla.Dir) != "" || strings.TrimSpace(os.Getenv(vanillaassets.EnvPack)) != "" {
		return tag + localCheckoutSuffix
	}
	return tag
}

func detailForMissing(st Status) string {
	if st.NeedsDownload {
		return "Block textures are not on this machine yet. Fetching Mojang's sample resource pack " +
			"(bedrock-samples " + st.WantTag + ", about 150 MB transferred, about 6 MB kept) would enable them; " +
			"until then the preview draws flat block colours, as it always has."
	}
	return "Block textures have not been built yet, but the vanilla assets are already on this machine, " +
		"so building them needs no download and takes a few seconds."
}

// Ensure builds the atlas and leaves it where the atlas wire method reads it.
//
// It resolves the vanilla assets first (which is where a download, if one was
// permitted, happens and announces itself), then -- when a pack was named --
// reads that pack's own block definitions and its own resource pack, and packs
// the pack's textures into the SAME sheet as vanilla's, so one wire method and
// one draw call cover both.
//
// Every failure is ordinary and none of them leaves a half-written atlas: the
// two files are written together by atlas.Built.WriteDir and the marker last.
// A caller that gets an error reports it once and stays on flat colours.
func Ensure(ctx context.Context, opts Options) (*Result, error) {
	dir, err := opts.dir()
	if err != nil {
		return nil, err
	}

	opts.progress("resolving Mojang's vanilla resource pack")
	root, err := vanillaassets.Resolve(ctx, opts.Vanilla)
	if err != nil {
		return nil, err
	}

	tag := effectiveTag(opts)

	buildOpts := atlas.Options{
		Root:               root,
		Tag:                tag,
		Source:             "vanilla",
		FallbackBlocksPath: opts.FallbackBlocksPath,
	}

	var summary *PackSummary
	var notes []block.RenderNote
	packDir := strings.TrimSpace(opts.PackDir)
	// sources is recorded whether or not the pack could be read: an atlas
	// whose marker names no pack files restales on every check, and a rebuild
	// loop is a worse bug than a missed edit.
	sources := packSourcesFor(packDir)
	if packDir != "" {
		opts.progress("reading this pack's own block definitions")
		table, s, src, err := packTable(packDir, opts.ResourcePackDir, root)
		if err != nil {
			// A pack that cannot be read is not a reason to have no textures
			// at all: vanilla is most of the sheet and the pack's own blocks
			// fall back to what they draw today. Say so and carry on.
			opts.progress("this pack's own blocks could not be read (" + err.Error() + "); building vanilla textures only")
		} else {
			applyPackTable(&buildOpts, table)
			summary = s
			notes = sortedNotes(table.Notes)
			sources = src
		}
	}
	// Hashed BEFORE the sheet is packed, which is the safe direction round.
	// atlas.Build is what opens the pack's texture files; an edit landing
	// during the build then produces a digest that no longer matches, i.e.
	// one extra rebuild. Hashing afterwards would record the NEW bytes
	// against an atlas holding the old ones, and that atlas would never
	// restale at all.
	packDigest := ""
	if packDir != "" {
		packDigest, _ = sources.digest()
	}

	opts.progress("packing the atlas")
	built, err := atlas.Build(buildOpts)
	if err != nil {
		return nil, err
	}
	if err := built.WriteDir(dir); err != nil {
		return nil, err
	}
	packBlocks := 0
	if summary != nil {
		packBlocks = summary.Blocks
	}
	m := marker{
		Version:    markerVersion,
		Tag:        tag,
		Built:      time.Now().UTC().Format(time.RFC3339),
		Pack:       packDir,
		Blocks:     len(built.Table.Blocks),
		PackBlocks: packBlocks,
		Notes:      notes,
		Note: "Block atlas built by featurelab from Mojang's bedrock-samples sample resource pack. " +
			"Not part of featurelab and not redistributed by it; delete this directory to remove it.",
	}
	if packDir != "" {
		m.PackSources = &sources
		m.PackDigest = packDigest
	}
	if err := writeMarker(dir, m); err != nil {
		return nil, err
	}
	// Building is the answer to the question a decline postponed.
	_ = os.Remove(filepath.Join(dir, declineFile))

	status := Check(opts)
	return &Result{Status: status, Stats: built.Stats, Pack: summary, Notes: notes}, nil
}

// Decline records that this machine was offered the download and said no, so
// that no host asks again. Undone by any successful Ensure.
func Decline(opts Options) error {
	dir, err := opts.dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("recording that block textures were declined: %w", err)
	}
	tag := opts.Vanilla.Tag
	if tag == "" {
		tag = vanillaassets.PinnedTag
	}
	buf, err := json.MarshalIndent(declineRecord{
		Declined: time.Now().UTC().Format(time.RFC3339),
		Tag:      tag,
		Note: "featurelab offered to download Mojang's sample block textures and was told no, so it will " +
			"not ask again on this machine. Delete this file, or run `featurelab textures --download`, to change that.",
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, declineFile), append(buf, '\n'), 0o644)
}

func declined(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, declineFile))
	return err == nil
}

func readMarker(dir string) (*marker, error) {
	buf, err := os.ReadFile(filepath.Join(dir, markerFile))
	if err != nil {
		return nil, err
	}
	var m marker
	if err := json.Unmarshal(buf, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func writeMarker(dir string, m marker) error {
	buf, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, markerFile), append(buf, '\n'), 0o644)
}

// tableTag reads just the tag out of an atlas.json, for an atlas written
// before this package existed (or by `genatlas -out` pointed here by hand).
func tableTag(dir string) (string, error) {
	buf, err := os.ReadFile(filepath.Join(dir, wire.AtlasTableFile))
	if err != nil {
		return "", err
	}
	var head struct {
		Tag string `json:"tag"`
	}
	if err := json.Unmarshal(buf, &head); err != nil {
		return "", fmt.Errorf("%s is not a readable atlas table: %w", wire.AtlasTableFile, err)
	}
	return head.Tag, nil
}

// packTable reads a behaviour pack's own blocks and resolves their textures --
// the same three steps `featurelab blocktable` takes, kept here rather than
// duplicated so the atlas and that command can never disagree about what a
// pack's blocks look like.
//
// It also reports which of the pack's files went into the answer, because
// this is the one place that knows: which resource pack was chosen, and which
// of its texture files each block face reached. Check re-hashes exactly that
// list without repeating any of this work.
func packTable(packDir, resourcePackDir, vanillaRoot string) (*packrender.Table, *PackSummary, packSources, error) {
	sources := packSourcesFor(packDir)
	loaded, err := pack.Load(pack.Options{Dir: packDir})
	if err != nil {
		return nil, nil, sources, err
	}
	palette := block.NewPalette()
	palette.LoadBlockTags(loaded.Blocks)

	rp, _, err := pack.FindResourcePack(loaded.Dir, resourcePackDir)
	if err != nil {
		return nil, nil, sources, err
	}

	opts := packrender.Options{Palette: palette}
	if rp != nil {
		opts.TerrainTexturePath = rp.TerrainTexturePath
		opts.TextureRoot = rp.Dir
		opts.ResourcePackDir = rp.Dir
		opts.ResourcePackName = rp.Name
		opts.ResourcePackHow = rp.How
	}
	if vanillaRoot != "" {
		// A pack's blocks commonly reuse VANILLA texture keys, so the pack
		// table and the vanilla atlas are not independent: without this,
		// those blocks lose their texture even though the atlas beside them
		// has the cell.
		opts.VanillaTerrainTexturePath = filepath.Join(vanillaRoot, filepath.FromSlash(rptex.TerrainRelPath))
		opts.VanillaTextureRoot = vanillaRoot
	}
	table, err := packrender.Build(opts)
	if err != nil {
		return nil, nil, sources, err
	}

	if rp != nil {
		// The pack's own terrain_texture.json, re-read only to recover the
		// path behind a key that resolved to NO image -- packrender records
		// why such a key failed but not where it looked, and where it looked
		// is what makes "the author finally exported that PNG" visible.
		var terrain *rptex.Terrain
		if rp.TerrainTexturePath != "" {
			terrain, _ = rptex.LoadTerrain(rp.TerrainTexturePath)
		}
		sources = sources.withResourcePack(rp.Dir, table, terrain)
	}

	s := table.Summarise()
	summary := &PackSummary{
		Dir:             loaded.Dir,
		Blocks:          s.Blocks,
		Fully:           s.Fully,
		ShapeCube:       s.ShapeCube,
		Untextured:      s.Untextured,
		UnresolvedTotal: len(table.Unresolved),
	}
	// packrender.Build already sorted these by (block, face), so the sample is
	// the same sample on every run rather than whichever map iteration order
	// this process happened to get.
	for i, u := range table.Unresolved {
		if i >= UnresolvedLimit {
			break
		}
		summary.Unresolved = append(summary.Unresolved, UnresolvedTexture{
			Block: u.Block, Face: u.Face, Texture: u.Texture, Reason: u.Reason,
		})
	}
	if rp != nil {
		summary.ResourcePack = rp.Dir
		summary.How = rp.How
	}
	for _, tex := range table.Textures {
		if tex.From == "pack" {
			summary.Textures++
		} else {
			summary.Reused++
		}
	}
	return table, summary, sources, nil
}

// applyPackTable is the whole of the E-to-B handoff: Piece B added
// ExtraTextures/BlockFaces/BlockTint/BlockRender for exactly this, and Piece E
// emits a table whose faces name texture KEYS because only the packer can
// assign a cell. This is the loop both of them said was left to whoever
// integrated the two.
func applyPackTable(opts *atlas.Options, table *packrender.Table) {
	if table == nil {
		return
	}
	extra := make(map[string]atlas.ExtraTexture)
	for key, tex := range table.Textures {
		// A key the pack borrows from vanilla is already in the sheet, with
		// the pack's own resolution of it recorded as from:"vanilla" -- not
		// re-packed, per atlas.Options.ExtraTextures' own contract.
		//
		// File OR Color: a key that resolved through a texture set whose
		// colour channel is a literal has no art to hand over, and dropping
		// it here would put exactly the block the pack took the trouble to
		// declare back on a hash colour.
		if tex.From != "pack" || (tex.File == "" && tex.Color == "") {
			continue
		}
		extra[key] = atlas.ExtraTexture{File: tex.File, Color: tex.Color, Overlay: tex.Overlay}
	}
	faces := make(map[string]map[string]string, len(table.Blocks))
	tint := make(map[string]map[string]string, len(table.Blocks))
	render := make(map[string]string, len(table.Blocks))
	shape := make(map[string]string, len(table.Blocks))
	note := make(map[string]string)
	for name, b := range table.Blocks {
		if len(b.Faces) == 0 {
			continue
		}
		faces[name] = b.Faces
		if len(b.Tint) > 0 {
			tint[name] = b.Tint
		}
		if b.Render != "" {
			render[name] = b.Render
		}
		// The pack's own geometry classification, which only its behaviour
		// pack knows. Piece E computed it and Piece D's renderer reads it;
		// this is the one line between them, and without it a pack's
		// cross-shaped block draws as a solid cube.
		if b.Shape != "" {
			shape[name] = b.Shape
		}
	}
	for name, n := range notesByBlock(table.Notes) {
		note[name] = n
	}
	opts.ExtraTextures = extra
	opts.BlockFaces = faces
	opts.BlockTint = tint
	opts.BlockRender = render
	opts.BlockShape = shape
	opts.BlockNote = note
}

func notesByBlock(notes []block.RenderNote) map[string]string {
	out := make(map[string]string, len(notes))
	for _, n := range notes {
		out[n.Block] = n.Message
	}
	return out
}

func sortedNotes(notes []block.RenderNote) []block.RenderNote {
	out := append([]block.RenderNote(nil), notes...)
	sort.Slice(out, func(i, j int) bool { return out[i].Block < out[j].Block })
	return out
}
