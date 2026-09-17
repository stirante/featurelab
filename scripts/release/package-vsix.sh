#!/usr/bin/env bash
# package-vsix.sh -- builds cmd/featurelab for one target platform, drops it where
# apps/vscode/src/binaryResolver.ts expects the bundled copy (bin/featurelab or
# bin/featurelab.exe -- see that file's bundledBinaryName()), and packages a
# platform-specific VSIX with `vsce package --target`.
#
# This deliberately does NOT reuse apps/vscode/scripts/build-binary.mjs: that script only
# ever builds for the host OS/ARCH (its own header comment says as much -- cross-platform
# release packaging is not its job). Rather than change a script
# owned by the extension package, this release script does the equivalent host-agnostic
# build itself, using the exact same output path convention so binaryResolver.ts needs no
# changes either.
#
# Assumes the caller has already run `npm ci` and built frontend/ + compiled apps/vscode's
# dist/ (extension.js, webview.js/css) -- those are OS/arch-independent and only need doing
# once per workflow run, not once per platform leg.
#
# Usage: package-vsix.sh <goos> <goarch> <vsce-target> <version> <outdir>
#   vsce-target -- one of vsce's --target values, e.g. win32-x64, linux-x64, linux-arm64,
#                  darwin-x64, darwin-arm64 (see `vsce package --help`)
set -euo pipefail

goos="${1:?usage: package-vsix.sh <goos> <goarch> <vsce-target> <version> <outdir>}"
goarch="${2:?usage: package-vsix.sh <goos> <goarch> <vsce-target> <version> <outdir>}"
target="${3:?usage: package-vsix.sh <goos> <goarch> <vsce-target> <version> <outdir>}"
version="${4:?usage: package-vsix.sh <goos> <goarch> <vsce-target> <version> <outdir>}"
outdir="${5:?usage: package-vsix.sh <goos> <goarch> <vsce-target> <version> <outdir>}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ext_dir="$repo_root/apps/vscode"
bin_dir="$ext_dir/bin"

binname="featurelab"
if [ "$goos" = "windows" ]; then
  binname="featurelab.exe"
fi

rm -rf "$bin_dir"
mkdir -p "$bin_dir"

echo "package-vsix: GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go build -o $bin_dir/$binname ./cmd/featurelab"
( cd "$repo_root" && GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath -o "$bin_dir/$binname" ./cmd/featurelab )

mkdir -p "$outdir"
out_abs="$(cd "$outdir" && pwd)"
vsix_name="featurelab-${version}-${target}.vsix"

# vsce asks interactively when the extension has no LICENSE, which hangs a CI runner. The
# extension ships under the repository's own licence, so that file is copied in for the
# package and removed again afterwards.
cp "$repo_root/LICENSE" "$ext_dir/LICENSE"
trap 'rm -f "$ext_dir/LICENSE"' EXIT

echo "package-vsix: vsce package --target $target -o $out_abs/$vsix_name"
( cd "$ext_dir" && npx vsce package --no-dependencies --allow-missing-repository --target "$target" -o "$out_abs/$vsix_name" )

echo "package-vsix: wrote $out_abs/$vsix_name"
