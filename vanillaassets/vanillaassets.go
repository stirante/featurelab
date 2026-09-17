// Package vanillaassets obtains Mojang's vanilla block textures and puts a
// resource_pack directory on disk for the rest of the tool to read.
//
// It publishes exactly one thing: Resolve returns the path of a directory
// that contains "textures/blocks/...". That is the whole contract. Whatever
// consumes it -- the atlas builder, the colour-table generator -- may assume
// nothing else about how the directory came to exist, and in particular must
// work identically whether it was downloaded, unpacked from a cache written
// weeks ago, or is a checkout the user already had.
//
// # Why this is a download and not a vendored directory
//
// The textures are Mojang's, not this project's. They are published in the
// Mojang/bedrock-samples repository under that repository's licence, and this
// repository does not redistribute them: it fetches them, on request, into a
// per-user cache outside the source tree, and says so out loud the first time
// it does. internal/gencolors already takes the same position for the colour
// table it generates (it reads a checkout the caller supplies and vendors no
// texture), and this package is the automated version of the manual clone its
// doc comment describes.
//
// # Failure is expected, not exceptional
//
// Textures are an enhancement. There is no network in CI, corporate proxies
// break TLS, DNS fails, disks fill, archives truncate. Every one of those ends
// here as an ordinary error and the caller falls back to flat colours. Nothing
// in the tool may stop working because this package could not produce a
// directory.
//
// Callers should call Resolve once per session and hold on to the result --
// including the error. A failure reported once at the top is information; the
// same failure reported per block is noise.
//
// # No test in this package touches the network
//
// The archive transport is exercised against an httptest server serving a
// tarball built in memory, and the local-checkout path against a temporary
// directory. Options.BaseURL and Options.HTTPClient exist for exactly that.
package vanillaassets

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// PinnedTag is the Mojang/bedrock-samples release this tool downloads.
//
// It is pinned to a tag and never to a branch: "main" would make the assets a
// moving target, so an atlas built on Tuesday and one built on Wednesday could
// differ with nothing in this repository having changed. Bumping it is a
// one-line diff, which is the point of it being a constant on its own.
//
// v1.26.40.05 is the newest non-preview tag in that repository. The game
// version this tool targets is 1.26.50, for which only *-preview sample tags
// exist so far; a preview tag is a worse pin for a shipped tool than a
// release tag, and block textures do not move between point releases the way
// worldgen internals do -- the mismatch costs nothing here. When a stable
// 1.26.50 tag appears, this line is the whole change.
const PinnedTag = "v1.26.40.05"

// Environment variables. Each exists so that a person who cannot or will not
// download -- offline, air-gapped, behind a proxy that breaks TLS, or simply
// already holding a bedrock-samples checkout -- is never forced to.
const (
	// EnvPack points at an existing resource_pack directory. When set, it is
	// used as-is and no network access happens at all, whatever else the
	// caller asked for.
	EnvPack = "FEATURELAB_VANILLA_PACK"
	// EnvDownload is a tri-state override of Options.Download: "1"/"true"/"yes"
	// permits downloading even when the caller did not, and "0"/"false"/"no"
	// forbids it even when the caller did. The forbidding half matters: it
	// lets a machine or a CI image be configured so that this tool cannot
	// reach the network no matter which host process drives it.
	EnvDownload = "FEATURELAB_VANILLA_DOWNLOAD"
	// EnvCache overrides the cache root (the directory that gets a
	// "vanilla/<tag>" beneath it), for machines where os.UserCacheDir is not
	// where large downloads belong.
	EnvCache = "FEATURELAB_VANILLA_CACHE"
)

// ErrNotCached is returned when nothing is cached, no local checkout was
// given, and downloading was not permitted. It is separated from every other
// failure because it is the one a caller can do something about: the fix is to
// pass a directory or allow the fetch, not to debug anything.
var ErrNotCached = errors.New("vanilla assets are not cached and downloading was not permitted")

// Options configures one Resolve call. The zero value is usable and does
// nothing surprising: it looks in the cache, and fails with ErrNotCached
// rather than reaching for the network on its own.
type Options struct {
	// Dir is an existing resource_pack directory to use instead of anything
	// cached or downloaded -- the directory that itself contains
	// "textures/blocks/...", i.e. ".../bedrock-samples/resource_pack". When
	// it is set, Resolve validates it and returns it, and no network access
	// is possible on that path. Empty means "consult EnvPack, then the cache".
	Dir string

	// Download is permission to fetch from the network when the cache misses.
	// It is deliberately not the default: a preview tool that reaches out to
	// the internet the first time you open a file, without being asked, is
	// not acceptable behaviour. The host sets this from an explicit user
	// gesture (a flag, a setting, a "download textures?" prompt), and even
	// then Resolve announces the fetch before making it. EnvDownload can
	// force it either way.
	Download bool

	// Tag overrides PinnedTag. Present so a caller can pick a different
	// bedrock-samples release without a rebuild, and so tests can use a tag
	// that could not collide with a real cache entry.
	Tag string

	// CacheDir overrides the cache root. Empty means EnvCache, then
	// os.UserCacheDir()/featurelab. The assets land in <CacheDir>/vanilla/<tag>.
	// Never inside this repository, never inside a pack: they are neither.
	CacheDir string

	// BaseURL overrides the archive host. Empty means codeload.github.com.
	// Tests point it at an httptest server; that is what keeps this package's
	// tests off the network.
	BaseURL string

	// HTTPClient overrides the client used for the fetch. Empty means a
	// client with a generous timeout. A caller with a corporate proxy
	// configuration, or a test that wants every dial to fail, supplies its own.
	HTTPClient *http.Client

	// Announce receives the one-off notice printed before a download starts:
	// what is being fetched, from where, how big, whose it is, and how to
	// avoid it. nil writes to stderr, which is right for the CLI and wrong
	// for a GUI -- the VS Code extension and the desktop app should route it
	// into their own UI, because a notice nobody sees is the silent download
	// this option exists to prevent.
	Announce func(notice string)

	// Progress is called as bytes arrive, at coarse intervals, with the total
	// received so far. nil prints a line to stderr every 16 MiB. A download
	// of this size with no sign of life reads as a hang.
	Progress func(bytesReceived int64)
}

// Resolve returns the path of a directory containing "textures/blocks/...".
//
// In order: an explicit local checkout (Options.Dir or EnvPack); the cache;
// then, only if downloading is permitted, a fetch into the cache. A second
// call with the cache populated does no network I/O whatsoever -- it stats two
// paths and returns. That is a property the tests assert by counting requests
// against the fixture server, not an intention.
func Resolve(ctx context.Context, opts Options) (root string, err error) {
	o, err := opts.resolve()
	if err != nil {
		return "", err
	}

	if o.Dir != "" {
		dir, err := filepath.Abs(o.Dir)
		if err != nil {
			return "", fmt.Errorf("vanilla assets: resolving %q: %w", o.Dir, err)
		}
		if err := hasBlockTextures(dir); err != nil {
			return "", fmt.Errorf("vanilla assets: %q is not a usable resource_pack directory: %w", dir, err)
		}
		return dir, nil
	}

	final := filepath.Join(o.CacheDir, "vanilla", o.Tag)
	if err := complete(final); err == nil {
		return final, nil
	}

	if !o.Download {
		return "", fmt.Errorf("%w (set %s to a bedrock-samples resource_pack directory, or allow the download)", ErrNotCached, EnvPack)
	}

	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("vanilla assets: %w", err)
	}
	if err := download(ctx, o, final); err != nil {
		return "", err
	}
	return final, nil
}

// resolved is Options with the environment applied and every default filled
// in, so that the rest of the package never has to ask "was this set?".
type resolved struct {
	Dir        string
	Download   bool
	Tag        string
	CacheDir   string
	BaseURL    string
	HTTPClient *http.Client
	Announce   func(string)
	Progress   func(int64)
}

func (o Options) resolve() (resolved, error) {
	r := resolved{
		Dir:        o.Dir,
		Download:   o.Download,
		Tag:        o.Tag,
		CacheDir:   o.CacheDir,
		BaseURL:    o.BaseURL,
		HTTPClient: o.HTTPClient,
		Announce:   o.Announce,
		Progress:   o.Progress,
	}
	if r.Dir == "" {
		r.Dir = strings.TrimSpace(os.Getenv(EnvPack))
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv(EnvDownload))) {
	case "1", "true", "yes", "on":
		r.Download = true
	case "0", "false", "no", "off":
		r.Download = false
	}
	if r.Tag == "" {
		r.Tag = PinnedTag
	}
	if strings.ContainsAny(r.Tag, `/\`) || r.Tag == "." || r.Tag == ".." || r.Tag == "" {
		// The tag becomes a path element and a URL element. It comes from a
		// constant or a caller rather than from a pack, so this is a
		// programming-error guard, not a security boundary -- but a wrong tag
		// that writes outside the cache would be a nasty way to find out.
		return resolved{}, fmt.Errorf("vanilla assets: invalid tag %q", r.Tag)
	}
	if r.CacheDir == "" {
		r.CacheDir = strings.TrimSpace(os.Getenv(EnvCache))
	}
	if r.CacheDir == "" {
		base, err := os.UserCacheDir()
		if err != nil {
			return resolved{}, fmt.Errorf("vanilla assets: no user cache directory (set %s): %w", EnvCache, err)
		}
		r.CacheDir = filepath.Join(base, "featurelab")
	}
	if r.BaseURL == "" {
		r.BaseURL = "https://codeload.github.com"
	}
	if r.HTTPClient == nil {
		// Long, because 120 MB over a slow line is legitimately slow; finite,
		// because a proxy that accepts the connection and then says nothing
		// must not hang the host process forever.
		r.HTTPClient = &http.Client{Timeout: 30 * time.Minute}
	}
	if r.Announce == nil {
		r.Announce = func(notice string) { fmt.Fprintln(os.Stderr, notice) }
	}
	if r.Progress == nil {
		r.Progress = func(n int64) { fmt.Fprintf(os.Stderr, "featurelab: vanilla textures: %d MB received\n", n>>20) }
	}
	return r, nil
}

// archiveURL is the tarball for one tag.
//
// Tarball rather than zip: a .tar.gz is a single stream, so entries can be
// filtered as they arrive and only the ~14 MB that is wanted ever touches the
// disk. A zip's central directory lives at the end, so archive/zip needs an
// io.ReaderAt -- meaning the whole ~120 MB archive on disk (or in memory)
// first, and a second pass to extract. Streaming also means a truncated
// transfer is caught by gzip's own CRC32 and length trailer rather than
// producing a plausible-looking short extract.
//
// Not a git clone: `git clone --filter=blob:none --sparse` would transfer far
// less, but it makes git a hard runtime dependency of a GUI application that
// otherwise has none, and it needs a working git credential/proxy setup on a
// machine where this tool's own HTTP client already works. The cost of the
// choice is honest, and measured: 150,505,078 bytes transferred for the
// v1.26.40.05 tag to keep 3,845 files totalling 6,048,217 bytes.
func archiveURL(baseURL, tag string) string {
	return strings.TrimSuffix(baseURL, "/") + "/Mojang/bedrock-samples/tar.gz/refs/tags/" + tag
}

// notice is the text shown before the first download. It names the source, the
// size, whose assets these are, where they land, and how to not do this.
func notice(o resolved, url string) string {
	return strings.Join([]string{
		"featurelab: vanilla block textures are not cached yet.",
		"  Fetching Mojang's sample resource pack, bedrock-samples " + o.Tag + ",",
		"  from " + url,
		"  About 150 MB is transferred, of which about 6 MB is kept: the block",
		"  textures, the biome colour maps, and the resource pack's JSON --",
		"  nothing else.",
		"  These are Mojang's sample assets, published in their bedrock-samples",
		"  repository under that repository's licence. They are not part of",
		"  featurelab and are not redistributed by it: they are cached in",
		"  " + filepath.Join(o.CacheDir, "vanilla", o.Tag),
		"  and never copied into your pack or into this tool.",
		"  To skip this entirely, point " + EnvPack + " at an existing",
		"  bedrock-samples resource_pack directory. Textures are an enhancement;",
		"  without them the preview draws flat colours, as it always has.",
	}, "\n")
}

// markerName records what a cache entry is and where it came from. Its
// presence is also what makes a cache entry trustworthy: it is written last,
// inside the temporary directory, before the atomic rename, so a directory
// that has it was complete at the moment it became visible under its final
// name.
const markerName = ".featurelab-vanilla.json"

type marker struct {
	Tag       string `json:"tag"`
	Source    string `json:"source"`
	Retrieved string `json:"retrieved"`
	Files     int    `json:"files"`
	Bytes     int64  `json:"bytes"`
	Note      string `json:"note"`
}

// hasBlockTextures is the whole of what this package promises a caller:
// a directory with textures/blocks in it.
func hasBlockTextures(root string) error {
	info, err := os.Stat(filepath.Join(root, "textures", "blocks"))
	if err != nil {
		return fmt.Errorf("no textures/blocks: %w", err)
	}
	if !info.IsDir() {
		return errors.New("textures/blocks is not a directory")
	}
	return nil
}

// complete reports whether a cache entry may be trusted. Both conditions
// matter: the marker says the extract finished, and the block-texture
// directory says it finished with the thing the caller actually wants.
func complete(root string) error {
	if err := hasBlockTextures(root); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(root, markerName)); err != nil {
		return fmt.Errorf("incomplete cache entry: %w", err)
	}
	return nil
}

// Extraction limits. The archive is Mojang's and served over TLS from GitHub,
// so these are not defending against an adversary so much as against a
// redirect to something unexpected, a proxy that injects an error page, and
// the general principle that unpacking an archive from the network should
// have a ceiling.
const (
	maxFileBytes  = 64 << 20
	maxTotalBytes = 512 << 20
	maxFiles      = 50000
	// A vanilla resource pack has well over a thousand block textures. A
	// successful extract that produced a handful of files means the archive
	// was not what we thought, and is better rejected than cached.
	minKeptFiles = 200
)

func download(ctx context.Context, o resolved, final string) error {
	url := archiveURL(o.BaseURL, o.Tag)
	o.Announce(notice(o, url))

	parent := filepath.Join(o.CacheDir, "vanilla")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		// Read-only cache directory, no permission, disk full at mkdir: all
		// arrive here, all are survivable, all say what happened.
		return fmt.Errorf("vanilla assets: preparing cache %q: %w", parent, err)
	}
	// Extract beside the final directory, on the same volume, so the rename
	// that publishes it is atomic. An interrupted run leaves a .tmp-* here
	// and never a half-populated <tag> that the next run would trust.
	tmp, err := os.MkdirTemp(parent, ".tmp-"+o.Tag+"-")
	if err != nil {
		return fmt.Errorf("vanilla assets: preparing cache %q: %w", parent, err)
	}
	defer os.RemoveAll(tmp)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("vanilla assets: %w", err)
	}
	req.Header.Set("Accept", "application/x-gzip")
	resp, err := o.HTTPClient.Do(req)
	if err != nil {
		// No network, DNS failure, connection refused, TLS rejected: one
		// error, one message, the caller falls back to flat colours.
		return fmt.Errorf("vanilla assets: fetching %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// A 404 here almost always means the tag no longer exists or was
		// mistyped, so say which tag as well as which status.
		return fmt.Errorf("vanilla assets: fetching %s: HTTP %s (is tag %q still published?)", url, resp.Status, o.Tag)
	}

	files, bytes, err := extract(ctx, &progressReader{r: resp.Body, step: 16 << 20, report: o.Progress}, tmp)
	if err != nil {
		return err
	}
	if files < minKeptFiles {
		return fmt.Errorf("vanilla assets: %s yielded only %d resource-pack files; refusing to cache it", url, files)
	}
	if err := hasBlockTextures(tmp); err != nil {
		return fmt.Errorf("vanilla assets: %s did not contain a resource pack: %w", url, err)
	}

	buf, err := json.MarshalIndent(marker{
		Tag:       o.Tag,
		Source:    url,
		Retrieved: time.Now().UTC().Format(time.RFC3339),
		Files:     files,
		Bytes:     bytes,
		Note: "Mojang sample resource-pack assets from github.com/Mojang/bedrock-samples, " +
			"cached by featurelab. Not part of featurelab and not redistributed by it.",
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("vanilla assets: %w", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, markerName), append(buf, '\n'), 0o644); err != nil {
		return fmt.Errorf("vanilla assets: %w", err)
	}

	if err := os.Rename(tmp, final); err != nil {
		// Two runs racing is the common cause, and on Windows a rename onto
		// an existing directory fails outright. If the other run won and its
		// result is sound, this run succeeded too.
		if complete(final) == nil {
			return nil
		}
		return fmt.Errorf("vanilla assets: publishing cache entry %q: %w", final, err)
	}
	return nil
}

// extract streams the gzipped tarball, keeping only the resource-pack files
// this tool needs and writing them under dst with the "resource_pack/" prefix
// removed -- so dst itself becomes the resource_pack root Resolve returns.
func extract(ctx context.Context, r io.Reader, dst string) (files int, written int64, err error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return 0, 0, fmt.Errorf("vanilla assets: reading archive: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		if err := ctx.Err(); err != nil {
			return files, written, fmt.Errorf("vanilla assets: %w", err)
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// A truncated transfer lands here, as io.ErrUnexpectedEOF from
			// the tar reader or a checksum/length complaint from gzip. That
			// is this package's integrity check; see the note on hashes below.
			return files, written, fmt.Errorf("vanilla assets: reading archive: %w", err)
		}
		if files > maxFiles || written > maxTotalBytes {
			return files, written, errors.New("vanilla assets: archive is implausibly large; refusing to extract it")
		}
		rel, ok := keep(hdr.Name)
		if !ok {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			continue // directories are created as their files arrive
		case tar.TypeReg:
		default:
			// Symlinks, hardlinks, devices. A resource pack has none, and
			// following one is how an archive escapes its destination.
			continue
		}
		if hdr.Size > maxFileBytes {
			return files, written, fmt.Errorf("vanilla assets: %q is %d bytes; refusing to extract it", hdr.Name, hdr.Size)
		}
		out := filepath.Join(dst, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return files, written, fmt.Errorf("vanilla assets: %w", err)
		}
		n, err := writeFile(out, tr)
		written += n
		if err != nil {
			// Disk full and read-only destinations both arrive here. The
			// temporary directory is removed by the caller's defer, so a
			// failure at file 900 of 1400 leaves nothing behind to trust.
			return files, written, fmt.Errorf("vanilla assets: writing %q: %w", out, err)
		}
		files++
	}
	return files, written, nil
}

func writeFile(path string, r io.Reader) (int64, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, io.LimitReader(r, maxFileBytes))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return n, err
}

// keep decides whether one archive entry is wanted, and returns its path
// relative to the resource_pack root.
//
// GitHub's tarballs wrap everything in a single "bedrock-samples-<tag>/"
// directory, so the first path element is stripped rather than matched -- the
// prefix has changed shape before and is not worth depending on.
//
// What is kept: block textures, the biome colour maps (grass and foliage
// tints are multiplied at runtime, so a renderer that ignores them draws grey
// grass), the JSON directly under textures/ (terrain_texture.json,
// flipbook_textures.json, item_texture.json), and the JSON at the resource
// pack root (blocks.json, biomes_client.json, manifest.json). Measured on
// v1.26.40.05: 3,845 files, 6.0 MB, out of a 150 MB archive. Entity, GUI,
// item, particle, painting and UI textures, the whole behaviour pack, and
// every non-JSON file at the pack root are dropped -- nothing here renders
// them, and they are most of the 80 MB that textures/ weighs in a full
// checkout.
func keep(name string) (rel string, ok bool) {
	name = path.Clean(strings.ReplaceAll(name, `\`, "/"))
	if name == "." || strings.HasPrefix(name, "/") || name == ".." || strings.HasPrefix(name, "../") {
		return "", false
	}
	_, after, found := strings.Cut(name, "/")
	if !found {
		return "", false
	}
	rest, ok := strings.CutPrefix(after, "resource_pack/")
	if !ok || rest == "" {
		return "", false
	}
	// path.Clean above has already collapsed any "a/../b", so a remaining ".."
	// element could only come from a path that escapes -- reject rather than
	// normalise.
	if rest == ".." || strings.HasPrefix(rest, "../") || strings.Contains(rest, "/../") {
		return "", false
	}
	switch {
	case strings.HasPrefix(rest, "textures/blocks/"),
		strings.HasPrefix(rest, "textures/colormap/"):
		return rest, true
	case path.Dir(rest) == "textures" && path.Ext(rest) == ".json",
		path.Dir(rest) == "." && path.Ext(rest) == ".json":
		return rest, true
	}
	return "", false
}

// progressReader reports cumulative bytes at coarse intervals.
type progressReader struct {
	r        io.Reader
	step     int64
	report   func(int64)
	total    int64
	reported int64
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.total += int64(n)
	if p.report != nil && p.total-p.reported >= p.step {
		p.reported = p.total
		p.report(p.total)
	}
	return n, err
}

// On verifying a hash of the archive.
//
// There is deliberately no pinned digest here, and the reason is worth stating
// rather than leaving as an omission. GitHub's tag tarballs are generated on
// demand; their byte content depends on the gzip implementation in use at the
// time, which has changed at least once, silently, across the whole service.
// A pinned sha256 of the archive would therefore be a check that eventually
// fails for a reason that has nothing to do with the assets -- and the
// pressure then is to "fix" it by re-pinning to whatever came down the wire,
// which is not a check at all.
//
// What is actually verified: TLS authenticates the host; gzip's trailing CRC32
// and length catch a truncated or corrupted transfer; tar's own framing
// catches a mangled one; and the extract is rejected unless it produced
// textures/blocks and at least minKeptFiles files. A cache entry only becomes
// visible under its final name after all of that, by an atomic rename.
//
// A durable digest is possible -- the tag's commit SHA is stable, so
// `git rev-parse` against a pinned tag, or hashing the extracted tree, would
// both be reproducible. Neither is done here: the first needs git, the second
// needs a hash to compare against that someone has to generate and keep
// current. If this ever matters more than it does today, hashing the extracted
// tree is the version to build.

// Notice returns the text Resolve would print before downloading, without
// downloading anything and without deciding whether a download is wanted.
//
// A terminal host can let Resolve announce for itself; a GUI cannot. A dialog
// has to say what it is about to do BEFORE the user has agreed to it, which
// means it needs this sentence one step earlier than Options.Announce delivers
// it. Same words either way -- there is exactly one description of this
// download in this repository, and this is it.
func Notice(opts Options) (string, error) {
	o, err := opts.resolve()
	if err != nil {
		return "", err
	}
	return notice(o, archiveURL(o.BaseURL, o.Tag)), nil
}

// Cached reports the directory Resolve would return with no network access at
// all, and whether there is one: an explicit checkout (Options.Dir or EnvPack)
// or a complete cache entry for the tag.
//
// This is how a host tells "asking the user to allow a download" apart from
// "just build it" -- the ask exists because of the network, so a machine that
// already has the assets should never see it. Note it can disagree with a
// later Resolve in one direction only: something can be removed between the
// two calls, which ends as an ordinary error, not as a silent download
// (Options.Download still governs that).
func Cached(opts Options) (root string, ok bool) {
	o, err := opts.resolve()
	if err != nil {
		return "", false
	}
	if o.Dir != "" {
		dir, err := filepath.Abs(o.Dir)
		if err != nil {
			return "", false
		}
		if hasBlockTextures(dir) != nil {
			return "", false
		}
		return dir, true
	}
	final := filepath.Join(o.CacheDir, "vanilla", o.Tag)
	if complete(final) != nil {
		return "", false
	}
	return final, true
}
