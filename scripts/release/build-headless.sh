#!/usr/bin/env bash
# build-headless.sh -- cross-compiles cmd/featurelab (the headless engine binary: generate,
# serve, check, types) for one GOOS/GOARCH target and packages it into a release archive.
#
# cmd/featurelab is pure Go (no cgo) so this cross-compiles cleanly from any host -- verified
# locally on Windows for linux/amd64, darwin/amd64, darwin/arm64 and windows/amd64 before this
# script was wired into CI. That's why the release workflow builds every headless-binary matrix
# leg on a single ubuntu-latest runner instead of needing native macOS/Windows runners for this
# job -- unlike apps/desktop (Wails, cgo, needs a real per-OS toolchain) or apps/vscode's
# packaging step, which reuses this same binary but doesn't need it built on the vsix
# workflow's own runner either.
#
# Usage: build-headless.sh <goos> <goarch> <version> <outdir>
#   goos/goarch -- standard Go cross-compile target, e.g. "linux amd64"
#   version     -- release version string (e.g. the git tag), embedded in the archive name only
#   outdir      -- directory the finished archive is written into (created if missing)
set -euo pipefail

goos="${1:?usage: build-headless.sh <goos> <goarch> <version> <outdir>}"
goarch="${2:?usage: build-headless.sh <goos> <goarch> <version> <outdir>}"
version="${3:?usage: build-headless.sh <goos> <goarch> <version> <outdir>}"
outdir="${4:?usage: build-headless.sh <goos> <goarch> <version> <outdir>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

repo_root="$(cd "$script_dir/../.." && pwd)"
cd "$repo_root"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

binname="featurelab"
if [ "$goos" = "windows" ]; then
  binname="featurelab.exe"
fi

echo "build-headless: GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go build -o $work/$binname ./cmd/featurelab"
GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath -o "$work/$binname" ./cmd/featurelab

mkdir -p "$outdir"
archive_base="featurelab-${version}-${goos}-${goarch}"

if [ "$goos" = "windows" ]; then
  archive="$outdir/${archive_base}.zip"
  zip_dir "$work" "$archive"
else
  archive="$outdir/${archive_base}.tar.gz"
  tar -C "$work" -czf "$archive" "$binname"
fi

echo "build-headless: wrote $archive"
