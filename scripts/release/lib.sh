#!/usr/bin/env bash
# lib.sh -- shared helpers for the release scripts in this directory. Not a standalone
# script; sourced by build-headless.sh and build-desktop.sh.

# zip_dir <src-dir> <dest-zip-path>
#
# Zips the CONTENTS of src-dir (not the directory itself) into dest-zip-path. Tries, in
# order: `zip` (present on GitHub-hosted ubuntu/macos runners and most Linux/macOS dev
# machines), PowerShell's Compress-Archive (ships with every Windows install since
# PowerShell 5.1 -- present on GitHub-hosted windows-latest runners and any Windows dev
# machine without requiring a separate install, which is why it's the primary fallback
# rather than `7z`), then `7z` (also present on GitHub's windows-latest image). Exits
# non-zero with a clear message if none of the three are available.
zip_dir() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  # Absolute from here on: every branch below runs the packer from inside $src, so a relative
  # dest (dist/x.zip, as the workflow passes) would be resolved against the wrong directory and
  # the packer would fail with "could not create output file".
  dest="$(cd "$(dirname "$dest")" && pwd)/$(basename "$dest")"
  rm -f "$dest"

  if command -v zip >/dev/null 2>&1; then
    ( cd "$src" && zip -q -X -r "$dest" . )
    return 0
  fi

  if command -v powershell.exe >/dev/null 2>&1; then
    local win_src win_dest
    if ! win_src="$(cd "$src" && pwd -W 2>/dev/null)"; then
      win_src="$(cd "$src" && pwd)"
    fi
    if ! win_dest="$(cd "$(dirname "$dest")" && pwd -W 2>/dev/null)"; then
      win_dest="$(cd "$(dirname "$dest")" && pwd)"
    fi
    win_dest="$win_dest/$(basename "$dest")"
    powershell.exe -NoProfile -NonInteractive -Command \
      "Compress-Archive -Path '$win_src/*' -DestinationPath '$win_dest' -Force"
    return 0
  fi

  if command -v 7z >/dev/null 2>&1; then
    ( cd "$src" && 7z a -y "$dest" . >/dev/null )
    return 0
  fi

  echo "zip_dir: none of zip, powershell.exe, or 7z is available -- cannot create $dest" >&2
  return 1
}
