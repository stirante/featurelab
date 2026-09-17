package vanillaassets

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// NOTHING IN THIS FILE TOUCHES THE NETWORK. Every "download" is served by an
// httptest server on the loopback interface from a tarball built in memory,
// and the one test that needs a broken network uses a transport that refuses
// to dial rather than a hostname that might resolve. A test that depends on
// GitHub being reachable is worse than no test: it fails in CI, where there is
// no network, and it fails on a laptop on a train, and each time it does the
// person reading the failure learns nothing about this package.

const testTag = "v0.0.0-test"

// clearEnv makes a test independent of whatever the developer's machine has
// set. Without it, a machine with FEATURELAB_VANILLA_PACK exported would run a
// different code path than CI does.
func clearEnv(t *testing.T) {
	t.Helper()
	t.Setenv(EnvPack, "")
	t.Setenv(EnvDownload, "")
	t.Setenv(EnvCache, "")
}

// sampleArchive builds a tarball shaped like GitHub's: one wrapping directory,
// a resource_pack and a behavior_pack inside it. It includes enough block
// textures to clear minKeptFiles, plus the decoys this package must drop.
func sampleArchive(t *testing.T, extra func(tw *tar.Writer)) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	prefix := "bedrock-samples-" + strings.TrimPrefix(testTag, "v") + "/"

	write := func(name string, body []byte) {
		t.Helper()
		if err := tw.WriteHeader(&tar.Header{Name: prefix + name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}

	if err := tw.WriteHeader(&tar.Header{Name: prefix + "resource_pack/textures/blocks/", Mode: 0o755, Typeflag: tar.TypeDir}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < minKeptFiles+10; i++ {
		write(fmt.Sprintf("resource_pack/textures/blocks/block_%03d.png", i), []byte("png-bytes"))
	}
	write("resource_pack/textures/terrain_texture.json", []byte(`{"texture_data":{}}`))
	write("resource_pack/textures/colormap/grass.png", []byte("colormap"))
	write("resource_pack/blocks.json", []byte(`{"format_version":"1.1.0"}`))

	// Decoys: everything below must be left on the wire, not written to disk.
	write("resource_pack/pack_icon.png", []byte("icon"))
	write("resource_pack/textures/entity/creeper.png", []byte("entity"))
	write("resource_pack/textures/ui/button.png", []byte("ui"))
	write("behavior_pack/blocks/stone.json", []byte(`{}`))
	write("README.md", []byte("readme"))

	if extra != nil {
		extra(tw)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// archiveServer serves one archive and counts how many times it was asked for
// it -- the count is how "the second run does no network I/O" is proved rather
// than asserted.
func archiveServer(t *testing.T, body []byte) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		want := "/Mojang/bedrock-samples/tar.gz/refs/tags/" + testTag
		if r.URL.Path != want {
			t.Errorf("archive requested at %q, want %q", r.URL.Path, want)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/x-gzip")
		w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// localCheckout writes the smallest thing that satisfies this package's
// promise: a directory with textures/blocks in it.
func localCheckout(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "textures", "blocks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "textures", "blocks", "stone.png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestResolveUsesLocalCheckout(t *testing.T) {
	clearEnv(t)
	dir := localCheckout(t)
	// A cache directory that cannot possibly work, so a resolve that reached
	// for it would fail rather than quietly succeed.
	root, err := Resolve(context.Background(), Options{Dir: dir, CacheDir: filepath.Join(t.TempDir(), "nope"), Download: true, Tag: testTag, BaseURL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatalf("Resolve with a local checkout: %v", err)
	}
	if want, _ := filepath.Abs(dir); root != want {
		t.Fatalf("root = %q, want %q", root, want)
	}
}

func TestResolveUsesLocalCheckoutFromEnv(t *testing.T) {
	clearEnv(t)
	dir := localCheckout(t)
	t.Setenv(EnvPack, dir)
	root, err := Resolve(context.Background(), Options{CacheDir: t.TempDir(), Tag: testTag})
	if err != nil {
		t.Fatalf("Resolve with %s set: %v", EnvPack, err)
	}
	if want, _ := filepath.Abs(dir); root != want {
		t.Fatalf("root = %q, want %q", root, want)
	}
}

func TestResolveRejectsLocalDirWithoutBlockTextures(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir() // no textures/blocks
	_, err := Resolve(context.Background(), Options{Dir: dir, CacheDir: t.TempDir(), Tag: testTag})
	if err == nil {
		t.Fatal("Resolve accepted a directory with no textures/blocks")
	}
	if !strings.Contains(err.Error(), "resource_pack") {
		t.Fatalf("error does not say what was wrong: %v", err)
	}
}

func TestResolveWithoutPermissionDoesNotDownload(t *testing.T) {
	clearEnv(t)
	srv, hits := archiveServer(t, sampleArchive(t, nil))
	_, err := Resolve(context.Background(), Options{CacheDir: t.TempDir(), Tag: testTag, BaseURL: srv.URL})
	if !errors.Is(err, ErrNotCached) {
		t.Fatalf("err = %v, want ErrNotCached", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests made without permission to download", n)
	}
	if !strings.Contains(err.Error(), EnvPack) {
		t.Fatalf("error does not say how to fix it: %v", err)
	}
}

func TestEnvDownloadForbidsOverridesCaller(t *testing.T) {
	clearEnv(t)
	t.Setenv(EnvDownload, "0")
	srv, hits := archiveServer(t, sampleArchive(t, nil))
	_, err := Resolve(context.Background(), Options{CacheDir: t.TempDir(), Tag: testTag, BaseURL: srv.URL, Download: true})
	if !errors.Is(err, ErrNotCached) {
		t.Fatalf("err = %v, want ErrNotCached", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%s=0 did not stop the download: %d requests", EnvDownload, n)
	}
}

func TestEnvDownloadPermitsWithoutCaller(t *testing.T) {
	clearEnv(t)
	t.Setenv(EnvDownload, "true")
	srv, hits := archiveServer(t, sampleArchive(t, nil))
	_, err := Resolve(context.Background(), Options{CacheDir: t.TempDir(), Tag: testTag, BaseURL: srv.URL,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err != nil {
		t.Fatalf("Resolve with %s=true: %v", EnvDownload, err)
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("%d requests, want 1", n)
	}
}

func TestResolveDownloadsExtractsAndCaches(t *testing.T) {
	clearEnv(t)
	srv, hits := archiveServer(t, sampleArchive(t, nil))
	cache := t.TempDir()

	var notices []string
	opts := Options{
		CacheDir: cache, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(n string) { notices = append(notices, n) },
		Progress: func(int64) {},
	}
	root, err := Resolve(context.Background(), opts)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if want := filepath.Join(cache, "vanilla", testTag); root != want {
		t.Fatalf("root = %q, want %q", root, want)
	}
	// The one thing this package promises.
	if _, err := os.Stat(filepath.Join(root, "textures", "blocks", "block_000.png")); err != nil {
		t.Fatalf("block texture missing from the extract: %v", err)
	}
	// What Piece B needs alongside it.
	for _, rel := range []string{
		filepath.Join("textures", "terrain_texture.json"),
		filepath.Join("textures", "colormap", "grass.png"),
		"blocks.json",
		markerName,
	} {
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			t.Errorf("%s missing from the extract: %v", rel, err)
		}
	}
	// What must NOT have been extracted: the archive is ~120 MB and only
	// ~14 MB of it is wanted, so this is the whole point of the filter.
	for _, rel := range []string{
		filepath.Join("textures", "entity", "creeper.png"),
		filepath.Join("textures", "ui", "button.png"),
		"pack_icon.png",
		filepath.Join("..", "behavior_pack"),
		"README.md",
	} {
		if _, err := os.Stat(filepath.Join(root, rel)); err == nil {
			t.Errorf("%s was extracted and should not have been", rel)
		}
	}

	if len(notices) != 1 {
		t.Fatalf("%d notices before the download, want exactly 1", len(notices))
	}
	// The first run has to say what it is doing and whose the assets are.
	for _, want := range []string{"bedrock-samples", srv.URL, "Mojang", "MB", EnvPack} {
		if !strings.Contains(notices[0], want) {
			t.Errorf("notice does not mention %q:\n%s", want, notices[0])
		}
	}

	// The second run must do no network I/O at all. Counting requests is the
	// only way to know that; a passing Resolve proves nothing on its own.
	notices = nil
	root2, err := Resolve(context.Background(), opts)
	if err != nil {
		t.Fatalf("second Resolve: %v", err)
	}
	if root2 != root {
		t.Fatalf("second root = %q, want %q", root2, root)
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("%d requests after two Resolves, want 1 -- the cache was not used", n)
	}
	if len(notices) != 0 {
		t.Fatalf("cache hit announced a download: %v", notices)
	}

	// And a cached entry does not even need permission to download.
	if _, err := Resolve(context.Background(), Options{CacheDir: cache, Tag: testTag, BaseURL: srv.URL}); err != nil {
		t.Fatalf("cached Resolve without Download: %v", err)
	}
	if n := hits.Load(); n != 1 {
		t.Fatalf("%d requests after three Resolves, want 1", n)
	}
}

func TestResolveTruncatedArchiveLeavesNoCacheEntry(t *testing.T) {
	clearEnv(t)
	full := sampleArchive(t, nil)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(full[:len(full)/2]) // an interrupted transfer
	}))
	t.Cleanup(srv.Close)

	cache := t.TempDir()
	_, err := Resolve(context.Background(), Options{CacheDir: cache, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err == nil {
		t.Fatal("a truncated archive was accepted")
	}
	assertCacheUnpoisoned(t, cache)
}

func TestResolveCorruptArchiveLeavesNoCacheEntry(t *testing.T) {
	clearEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("this is an error page, not a gzip stream"))
	}))
	t.Cleanup(srv.Close)

	cache := t.TempDir()
	_, err := Resolve(context.Background(), Options{CacheDir: cache, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err == nil {
		t.Fatal("a corrupt archive was accepted")
	}
	assertCacheUnpoisoned(t, cache)
}

// TestResolveThinArchiveIsRejected covers the archive that unpacks cleanly and
// simply is not a resource pack -- a redirect to the wrong tag, a proxy's
// captive-portal tarball, a repository that moved.
func TestResolveThinArchiveIsRejected(t *testing.T) {
	clearEnv(t)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("x")
	tw.WriteHeader(&tar.Header{Name: "bedrock-samples-x/resource_pack/textures/blocks/a.png", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
	tw.Write(body)
	tw.Close()
	gz.Close()

	srv, _ := archiveServer(t, buf.Bytes())
	cache := t.TempDir()
	_, err := Resolve(context.Background(), Options{CacheDir: cache, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err == nil {
		t.Fatal("an archive with one texture in it was cached")
	}
	assertCacheUnpoisoned(t, cache)
}

func TestResolveHTTPErrorIsClear(t *testing.T) {
	clearEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Not Found", http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)

	cache := t.TempDir()
	_, err := Resolve(context.Background(), Options{CacheDir: cache, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err == nil {
		t.Fatal("a 404 was accepted")
	}
	for _, want := range []string{"404", testTag} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q: %v", want, err)
		}
	}
	assertCacheUnpoisoned(t, cache)
}

// TestResolveNoNetworkIsSurvivable is the offline case: every dial fails, and
// the caller gets one error it can report once and fall back from.
func TestResolveNoNetworkIsSurvivable(t *testing.T) {
	clearEnv(t)
	client := &http.Client{Transport: &refusingTransport{}}
	cache := t.TempDir()
	_, err := Resolve(context.Background(), Options{CacheDir: cache, Tag: testTag,
		BaseURL: "http://offline.invalid", Download: true, HTTPClient: client,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err == nil {
		t.Fatal("Resolve succeeded with no network")
	}
	if !strings.Contains(err.Error(), "offline.invalid") {
		t.Fatalf("error does not say what it failed to reach: %v", err)
	}
	assertCacheUnpoisoned(t, cache)
}

type refusingTransport struct{}

func (refusingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
}

func TestResolveUnwritableCacheIsSurvivable(t *testing.T) {
	clearEnv(t)
	// A file where the cache directory should be: MkdirAll fails, which is
	// the portable stand-in for a read-only or full disk (chmod is a no-op
	// for directories on Windows, so a read-only directory is not testable
	// the same way everywhere).
	blocked := filepath.Join(t.TempDir(), "cache")
	if err := os.WriteFile(blocked, []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv, hits := archiveServer(t, sampleArchive(t, nil))
	_, err := Resolve(context.Background(), Options{CacheDir: blocked, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err == nil {
		t.Fatal("Resolve succeeded with an unwritable cache")
	}
	if !strings.Contains(err.Error(), "cache") {
		t.Fatalf("error does not say the cache was the problem: %v", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("downloaded %d times before discovering the cache was unwritable", n)
	}
}

func TestResolveCancelledContext(t *testing.T) {
	clearEnv(t)
	srv, hits := archiveServer(t, sampleArchive(t, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cache := t.TempDir()
	_, err := Resolve(ctx, Options{CacheDir: cache, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(string) {}, Progress: func(int64) {}})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("%d requests after the context was cancelled", n)
	}
	assertCacheUnpoisoned(t, cache)
}

// TestExtractRejectsEscapingPaths is the archive-unpacking classic: an entry
// whose name climbs out of the destination. Extraction happens into a
// temporary directory that is thrown away on failure, so the damage from
// getting this wrong would be silent rather than visible -- hence a direct
// test of the filter.
func TestExtractRejectsEscapingPaths(t *testing.T) {
	for _, name := range []string{
		"bedrock-samples-x/resource_pack/../../evil.png",
		"bedrock-samples-x/resource_pack/textures/blocks/../../../../evil.png",
		"/etc/passwd",
		"../evil.png",
		`bedrock-samples-x\resource_pack\..\..\evil.png`,
	} {
		if rel, ok := keep(name); ok {
			t.Errorf("keep(%q) = %q, true; want false", name, rel)
		}
	}
}

func TestKeepSelectsOnlyWhatIsNeeded(t *testing.T) {
	kept := map[string]string{
		"bedrock-samples-1.2.3/resource_pack/textures/blocks/stone.png":     "textures/blocks/stone.png",
		"bedrock-samples-1.2.3/resource_pack/textures/blocks/log/oak.tga":   "textures/blocks/log/oak.tga",
		"bedrock-samples-1.2.3/resource_pack/textures/colormap/grass.png":   "textures/colormap/grass.png",
		"bedrock-samples-1.2.3/resource_pack/textures/terrain_texture.json": "textures/terrain_texture.json",
		"bedrock-samples-1.2.3/resource_pack/blocks.json":                   "blocks.json",
	}
	for name, want := range kept {
		got, ok := keep(name)
		if !ok || got != want {
			t.Errorf("keep(%q) = %q, %v; want %q, true", name, got, ok, want)
		}
	}
	for _, name := range []string{
		"bedrock-samples-1.2.3/resource_pack/textures/entity/creeper.png",
		"bedrock-samples-1.2.3/resource_pack/pack_icon.png",
		"bedrock-samples-1.2.3/behavior_pack/blocks/stone.json",
		"bedrock-samples-1.2.3/README.md",
		"bedrock-samples-1.2.3/resource_pack/",
		"bedrock-samples-1.2.3",
	} {
		if got, ok := keep(name); ok {
			t.Errorf("keep(%q) = %q, true; want false", name, got)
		}
	}
}

// TestExtractIgnoresSymlinks: a symlink in the archive is a way out of the
// destination that path checking alone does not catch.
func TestExtractIgnoresSymlinks(t *testing.T) {
	archive := sampleArchive(t, func(tw *tar.Writer) {
		hdr := &tar.Header{
			Name:     "bedrock-samples-x/resource_pack/textures/blocks/escape.png",
			Typeflag: tar.TypeSymlink,
			Linkname: "../../../../../../etc/passwd",
			Mode:     0o777,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
	})
	srv, _ := archiveServer(t, archive)
	cache := t.TempDir()
	root, err := Resolve(context.Background(), Options{CacheDir: cache, Tag: testTag, BaseURL: srv.URL, Download: true,
		Announce: func(string) {}, Progress: func(int64) {}})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "textures", "blocks", "escape.png")); err == nil {
		t.Fatal("a symlink entry was extracted")
	}
}

func TestArchiveURLIsTagPinned(t *testing.T) {
	got := archiveURL("https://codeload.github.com", PinnedTag)
	want := "https://codeload.github.com/Mojang/bedrock-samples/tar.gz/refs/tags/" + PinnedTag
	if got != want {
		t.Fatalf("archiveURL = %q, want %q", got, want)
	}
	if strings.Contains(got, "main") || strings.Contains(got, "heads") {
		t.Fatalf("the pin is not a tag: %q", got)
	}
}

func TestInvalidTagIsRejected(t *testing.T) {
	for _, tag := range []string{"..", "../../etc", `a\b`, "a/b"} {
		if _, err := Resolve(context.Background(), Options{Tag: tag, CacheDir: t.TempDir()}); err == nil ||
			!strings.Contains(err.Error(), "invalid tag") {
			t.Errorf("Resolve with tag %q: err = %v, want an invalid-tag error", tag, err)
		}
	}
}

// assertCacheUnpoisoned is the partial-download rule: a failed run leaves
// nothing under the cache that a later run would trust, and no temporary
// directory behind either.
func assertCacheUnpoisoned(t *testing.T, cache string) {
	t.Helper()
	final := filepath.Join(cache, "vanilla", testTag)
	if _, err := os.Stat(final); err == nil {
		t.Errorf("a failed run left a cache entry at %q", final)
	}
	entries, err := os.ReadDir(filepath.Join(cache, "vanilla"))
	if err != nil {
		return // never created: also fine
	}
	for _, e := range entries {
		t.Errorf("a failed run left %q behind in the cache", e.Name())
	}
}

func TestRegisterFlags(t *testing.T) {
	clearEnv(t)
	var opts Options
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	RegisterFlags(fs, &opts)
	if err := fs.Parse([]string{"-vanilla-pack", "/tmp/rp", "-vanilla-download", "-vanilla-tag", "v1.2.3"}); err != nil {
		t.Fatal(err)
	}
	if opts.Dir != "/tmp/rp" || !opts.Download || opts.Tag != "v1.2.3" {
		t.Fatalf("flags did not land in Options: %+v", opts)
	}
}
