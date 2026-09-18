// packhash.go answers one question -- has the pack changed since the atlas was
// built -- and answers it by CONTENT rather than by a file's stats.
//
// # Why stats are not enough, and it is not a corner case
//
// The first version of this summarised the pack's block definitions as
// count/size/newest-mtime. That is a change detector for a build system, and
// it is the wrong detector for the thing an add-on author actually does:
// repainting a 16x16 texture almost always produces a file of exactly the same
// SIZE, plenty of image editors write it back preserving the mtime, and the
// count obviously does not move. The author then sees their old texture, with
// nothing said, and cannot tell whether the preview is broken or their edit
// never saved. A cache that lies silently is worse than one that rebuilds too
// often, so the pack half is hashed.
//
// The old summary did not cover textures AT ALL -- it walked the behaviour
// pack's blocks/**/*.json and nothing else -- so repainting a texture was
// missed whatever it did to the size or the mtime. That is the bigger half of
// this fix.
//
// # What is hashed, and what deliberately is not
//
// Hashed, all of it pack-side:
//
//  1. every blocks/**/*.json in the behaviour pack, found by WALKING, so a
//     block file added or deleted counts as a change and not only an edit;
//  2. the behaviour pack's and the resource pack's manifest.json -- the UUID
//     dependency between them is what decides WHICH resource pack the textures
//     come from, so editing it changes the answer;
//  3. the resource pack's textures/terrain_texture.json, which decides which
//     image each texture key names;
//  4. every texture the atlas actually consumed FROM THE PACK, recorded as the
//     extensionless pack-root-relative path terrain_texture.json writes and
//     re-probed through rptex.FindTexture -- so a .png appearing, disappearing
//     or being replaced by a .tga all register;
//  5. every texture key a pack block asked for that resolved to NO image, when
//     terrain_texture.json declared a path for it. That is the "I forgot to
//     export that PNG" case, and the fix for it is a file APPEARING where the
//     build found nothing -- which a list of files the build managed to open
//     would never see.
//
// Not hashed, and this is a measurement rather than a preference: the VANILLA
// half. Those 3,846 files come out of a tag-pinned tarball into
// <cache>/featurelab/vanilla/<tag>/, published by an atomic rename with its own
// marker written last, and the tag is already compared a few lines up in Check.
// Nobody edits them, and the cost is not small: hashing that directory measured
// 480 ms warm and 31 s on a cold OS file cache, against a whole warm-cache
// rebuild of 1.9 s. Paying that on every status check to detect an edit to a
// file the tool downloaded itself would be the wrong trade by an order of
// magnitude.
//
// Nor is the whole resource pack hashed. A typical add-on's textures/
// subtree holds roughly ten times the files its block atlas actually consumes,
// and hashing it all is roughly ten times slower; hashing the rest would additionally restale the atlas
// when an item or a mob texture -- which cannot appear in a block atlas -- is
// touched. Precision is both cheaper and more correct here, so it is what this
// does.
//
// # No stat pre-filter, and that is deliberate
//
// A count/size/mtime pre-filter can only skip the hash when it says "changed",
// and "changed" is the rare case; the common case -- nothing moved, start up --
// falls through to the hash every time and pays for both. The whole measured
// cost of the hash on a 202-block pack is about 55 ms, which is under a
// thirtieth of the rebuild it prevents, so there is nothing here worth a second
// mechanism that can disagree with the first.
package blocktextures

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/stirante/featurelab/internal/packrender"
	"github.com/stirante/featurelab/internal/rptex"
)

// packDigestScheme is mixed into every digest so that a change to WHAT is
// hashed cannot be mistaken for the pack being unchanged. Bump it when the
// rules above change; every atlas then restales once, which is the correct
// answer, because an atlas checked by the old rules was checked by rules this
// build no longer believes.
// v2 adds the <name>.texture_set.json behind each texture path: a texture can
// now be declared by a texture set rather than by an image, so a pack whose
// only change is to one of those files really has changed.
const packDigestScheme = "packcontent-v2"

// packSources is the exact set of pack files one atlas was built from. It is
// recorded in the marker beside the atlas so that a later Check can re-hash
// precisely those files without re-reading the pack, re-locating its resource
// pack or re-resolving a single texture key -- Check runs on every start-up and
// must stay cheap.
type packSources struct {
	// BlocksDir is the behaviour pack's blocks/ directory, walked rather
	// than listed so an added or deleted block file counts.
	BlocksDir string `json:"blocksDir,omitempty"`
	// Files are individual files hashed verbatim: the two manifests and the
	// resource pack's terrain_texture.json.
	Files []string `json:"files,omitempty"`
	// TextureRoot is the resource pack root Textures resolve against.
	TextureRoot string `json:"textureRoot,omitempty"`
	// Textures are extensionless, pack-root-relative texture paths exactly
	// as terrain_texture.json writes them. Extensionless on purpose: the
	// probe is what makes a texture appearing, vanishing or changing
	// container format all visible.
	Textures []string `json:"textures,omitempty"`
}

// packDigestStats is what the digest cost, for anyone measuring it.
type packDigestStats struct {
	Files int
	Bytes int64
}

// digest hashes every file these sources name, in a fixed order, and returns
// a hex SHA-256 over the lot.
//
// A file that is not there is not an error and does not abort the walk: it
// contributes the literal "absent", so a texture that disappears and a texture
// that appears are both changes, and a pack that has been deleted out from
// under the atlas produces one stable digest rather than a hard failure on a
// status check.
func (s packSources) digest() (string, packDigestStats) {
	sum := sha256.New()
	var st packDigestStats
	fmt.Fprintln(sum, packDigestScheme)

	for _, path := range s.blockFiles() {
		rel, err := filepath.Rel(s.BlocksDir, path)
		if err != nil {
			rel = filepath.Base(path)
		}
		hashInto(sum, "block "+filepath.ToSlash(rel), path, &st)
	}
	for _, path := range s.Files {
		hashInto(sum, "file "+filepath.ToSlash(path), path, &st)
	}
	if s.TextureRoot != "" {
		for _, rel := range s.Textures {
			// The texture set that MAY stand behind this path is hashed
			// whether or not it exists and whether or not it resolves --
			// absent contributes "absent", exactly as a missing image does.
			// Probing it unconditionally is what makes adding, editing,
			// breaking or deleting a <name>.texture_set.json all visible;
			// hashing it only on success would leave a pack whose texture set
			// points at a file that is not there stuck on a stale atlas even
			// after the author fixed the file.
			hashInto(sum, "textureset "+rel, filepath.Join(s.TextureRoot, filepath.FromSlash(rel))+rptex.TextureSetSuffix, &st)
			tex, err := rptex.ResolveTexture(s.TextureRoot, rel)
			if err != nil {
				fmt.Fprintf(sum, "texture %s\x00absent\n", rel)
				continue
			}
			if tex.File == "" {
				// A flat colour has no file to hash; the texture set that
				// declares it has already been hashed above, so the colour
				// itself is recorded only to keep the two cases distinct.
				fmt.Fprintf(sum, "texture %s\x00color %s\n", rel, tex.Color.Hex())
				continue
			}
			hashInto(sum, "texture "+rel+strings.ToLower(filepath.Ext(tex.File)), tex.File, &st)
		}
	}
	return hex.EncodeToString(sum.Sum(nil)), st
}

// blockFiles is the walk, sorted, so that the digest does not depend on the
// order the filesystem happened to hand the entries back.
func (s packSources) blockFiles() []string {
	if s.BlocksDir == "" {
		return nil
	}
	var out []string
	_ = filepath.WalkDir(s.BlocksDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable subtree is not worth failing a status check
			// over; it simply contributes nothing, exactly as it did
			// before this was a content hash.
			return nil
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".json") {
			return nil
		}
		out = append(out, path)
		return nil
	})
	sort.Strings(out)
	return out
}

func hashInto(sum io.Writer, label, path string, st *packDigestStats) {
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(sum, "%s\x00absent\n", label)
		return
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	st.Files++
	st.Bytes += n
	if err != nil {
		fmt.Fprintf(sum, "%s\x00unreadable\n", label)
		return
	}
	fmt.Fprintf(sum, "%s\x00%x\n", label, h.Sum(nil))
}

// packSourcesFor is the behaviour-pack half, which is all that is known when
// the pack's own resource pack could not be read at all. Recorded even then,
// so that a pack this build failed to open still gets a comparable digest
// rather than an empty one -- an atlas whose marker records no sources restales
// on every check, and a rebuild loop is a worse bug than the one this fixes.
func packSourcesFor(packDir string) packSources {
	packDir = strings.TrimSpace(packDir)
	if packDir == "" {
		return packSources{}
	}
	return packSources{
		BlocksDir: filepath.Join(packDir, "blocks"),
		Files:     []string{filepath.Join(packDir, "manifest.json")},
	}
}

// withResourcePack adds the pack's own resource-pack half: the two files that
// decide which image a key names, and the images themselves.
//
// terrain is the pack's parsed terrain_texture.json, used only to recover the
// path of a key that resolved to NO image -- packrender records the reason such
// a key failed but not the path it looked for, and the path is what makes the
// author's fix visible. nil simply drops item 5 of the list above.
func (s packSources) withResourcePack(rpDir string, table *packrender.Table, terrain *rptex.Terrain) packSources {
	if rpDir == "" || table == nil {
		return s
	}
	s.TextureRoot = rpDir
	s.Files = append(s.Files,
		filepath.Join(rpDir, "manifest.json"),
		filepath.Join(rpDir, filepath.FromSlash(rptex.TerrainRelPath)),
	)

	seen := make(map[string]bool)
	add := func(path string) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		s.Textures = append(s.Textures, path)
	}
	for _, tex := range table.Textures {
		// A key the pack merely BORROWS from vanilla resolves against the
		// vanilla root and is covered by the tag, not by this.
		if tex.From == "pack" {
			add(tex.Path)
		}
	}
	if terrain != nil {
		for _, u := range table.Unresolved {
			if variants := terrain.Keys[u.Texture]; len(variants) > 0 {
				add(variants[0].Path)
			}
		}
	}
	sort.Strings(s.Textures)
	return s
}
