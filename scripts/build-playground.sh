#!/usr/bin/env bash
# build-playground.sh -- builds the browser playground's engine (cmd/playground) to WebAssembly
# and writes it, the matching wasm_exec.js and a manifest.json into an output directory for the
# documentation site to serve.
#
# Both files are written under content-hashed names (featurelab.<sha256-12>.wasm,
# wasm_exec.<sha256-12>.js) because the site caches them by name: a new build is a new name,
# so a reader's cache can never pair a new page with an old engine. manifest.json is the one
# unhashed file, and it is how the page finds the other two.
#
# wasm_exec.js is copied from the same GOROOT that compiled the .wasm, never from anywhere
# else. It is the other half of the Go runtime's JS ABI and it changes between Go releases; a
# mismatched pair fails at start-up with an error that says nothing about versions.
#
# Usage: build-playground.sh <outdir> [version]
#   outdir  -- directory to write into (created if missing)
#   version -- optional; what featurelab.version reports (e.g. the release tag). Without it the
#              engine reports what the build info says, which for a local build is "(devel)".
set -euo pipefail

outdir="${1:?usage: build-playground.sh <outdir> [version]}"
version="${2:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

# go env prints a native path. On Windows that is C:\..., which Git Bash's own tools accept
# as it is -- converting it with cygpath would be the one step here that differs between Git
# Bash, MSYS2 and Cygwin, which each spell the drive differently.
goroot="$(go env GOROOT)"
go_version="$(go env GOVERSION)"

# lib/wasm is where Go 1.24 and later keep it; misc/wasm is where every earlier release did.
wasm_exec=""
for candidate in "$goroot/lib/wasm/wasm_exec.js" "$goroot/misc/wasm/wasm_exec.js"; do
  if [ -f "$candidate" ]; then
    wasm_exec="$candidate"
    break
  fi
done
if [ -z "$wasm_exec" ]; then
  echo "build-playground: no wasm_exec.js under $goroot (looked in lib/wasm and misc/wasm)" >&2
  exit 1
fi

# Hashed from stdin, not by name: given a name with a backslash in it (any Windows GOROOT),
# sha256sum escapes the line by prefixing it with one, and the first twelve characters are no
# longer the hash.
sha12() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum <"$1" | cut -c1-12
  else
    shasum -a 256 <"$1" | cut -c1-12
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ldflags="-s -w"
if [ -n "$version" ]; then
  ldflags="$ldflags -X main.buildVersion=${version#v}"
fi
echo "build-playground: GOOS=js GOARCH=wasm go build ./cmd/playground ($go_version)"
GOOS=js GOARCH=wasm go build -trimpath -ldflags="$ldflags" -o "$work/featurelab.wasm" ./cmd/playground

wasm_name="featurelab.$(sha12 "$work/featurelab.wasm").wasm"
exec_name="wasm_exec.$(sha12 "$wasm_exec").js"
size="$(wc -c <"$work/featurelab.wasm" | tr -d ' ')"

mkdir -p "$outdir"
# Earlier builds' files are removed rather than left to pile up: nothing names them any more
# once the manifest below is replaced, so nothing can load them.
rm -f "$outdir"/featurelab.*.wasm "$outdir"/wasm_exec.*.js
cp "$work/featurelab.wasm" "$outdir/$wasm_name"
cp "$wasm_exec" "$outdir/$exec_name"
cat >"$outdir/manifest.json" <<EOF
{
  "wasm": "$wasm_name",
  "wasmExec": "$exec_name",
  "goVersion": "$go_version",
  "size": $size
}
EOF

echo "build-playground: wrote $outdir/$wasm_name ($size bytes), $exec_name, manifest.json"
