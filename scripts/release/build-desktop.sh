#!/usr/bin/env bash
# build-desktop.sh -- runs `wails build` for apps/desktop (the Wails v2 desktop app) and
# archives whatever it drops in apps/desktop/build/bin/ into a release artifact.
#
# Must run on a native runner matching the target platform: Wails v2's Linux/macOS/Windows
# backends all use cgo (GTK+WebKitGTK on Linux, Cocoa/WebKit on macOS, a Go-native
# WebView2Loader -- no cgo -- on Windows), so unlike scripts/release/build-headless.sh and
# package-vsix.sh (both pure Go, freely cross-compiled from one host), this cannot be built
# for linux/darwin from a Windows box. The release workflow runs this once per OS on
# windows-latest/macos-latest/ubuntu-latest.
#
# The pinned Wails CLI version matters: the working version for this repo is v2.13.0. The
# older 2.8.2 fails against Go 1.26.4 with "internal error: package \"context\" without types
# was imported". The workflow installs the CLI pinned to
# v2.13.0 (`go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0`); this script does not
# install it, only invokes whatever `wails` is first on PATH, so a version mismatch here means
# the workflow step that installs the CLI needs fixing, not this script.
#
# On Linux, Ubuntu 24.04 (the ubuntu-latest image as of this writing) dropped the
# webkit2gtk-4.0 package Wails links against by default; the workflow installs
# libwebkit2gtk-4.1-dev instead and this script must be called with tags="webkit2_41" so
# Wails' `-tags webkit2_41` build constraint picks the 4.1 cgo bindings
# (github.com/wailsapp/wails/v2@v2.13.0/pkg/assetserver/webview/webkit2_40+.go). This repo's
# CI has not been run for real yet, so this specific Linux cgo path is unverified locally
# (developed on Windows).
#
# Usage: build-desktop.sh <wails-platform> <version> <outdir> [go-build-tags]
#   wails-platform -- passed straight to `wails build -platform`, e.g. windows/amd64,
#                      darwin/universal, linux/amd64
#   go-build-tags  -- optional, passed to `wails build -tags` verbatim (space/comma separated,
#                      per wails' own -tags flag)
set -euo pipefail

platform="${1:?usage: build-desktop.sh <wails-platform> <version> <outdir> [go-build-tags]}"
version="${2:?usage: build-desktop.sh <wails-platform> <version> <outdir> [go-build-tags]}"
outdir="${3:?usage: build-desktop.sh <wails-platform> <version> <outdir> [go-build-tags]}"
tags="${4:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

repo_root="$(cd "$script_dir/../.." && pwd)"
app_dir="$repo_root/apps/desktop"
bin_dir="$app_dir/build/bin"

rm -rf "$bin_dir"

wails_args=(build -clean -platform "$platform")
if [ -n "$tags" ]; then
  wails_args+=(-tags "$tags")
fi

echo "build-desktop: (cd $app_dir && wails ${wails_args[*]})"
( cd "$app_dir" && wails "${wails_args[@]}" )

if [ ! -d "$bin_dir" ] || [ -z "$(ls -A "$bin_dir" 2>/dev/null)" ]; then
  echo "build-desktop: $bin_dir is empty after \`wails build\` -- nothing to package" >&2
  exit 1
fi

mkdir -p "$outdir"
out_abs="$(cd "$outdir" && pwd)"
slug="$(echo "$platform" | tr '/' '-')"
archive_base="featurelab-desktop-${version}-${slug}"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    archive="$out_abs/${archive_base}.zip"
    zip_dir "$bin_dir" "$archive"
    ;;
  *)
    archive="$out_abs/${archive_base}.tar.gz"
    tar -C "$bin_dir" -czf "$archive" .
    ;;
esac

echo "build-desktop: wrote $archive"
