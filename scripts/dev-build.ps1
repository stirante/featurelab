<#
.SYNOPSIS
  Local Windows development build: headless CLI, VS Code extension, Wails desktop app.

.DESCRIPTION
  This is the DEVELOPMENT counterpart to scripts/release/*.sh. Those produce release
  artifacts (archives, a signed-ish vsix, per-OS matrix legs) and assume CI; this one
  produces things you can run immediately on this machine, and nothing else.

  Each target is independent. A failure in one is reported and the others still run, so
  a missing Wails CLI doesn't stop you getting a CLI binary. The exit code is non-zero
  if any selected target failed.

.PARAMETER Target
  What to build: cli, vscode, desktop, or all (default).

.PARAMETER Vsix
  With -Target vscode, also package featurelab.vsix (needs vsce). Off by default:
  for development you normally want F5-in-VS-Code, which uses dist/ + bin/ directly.

.PARAMETER SkipTests
  Skip `go test ./...`. The default runs it, because this repo's whole value is
  fidelity and the placement digest is the tripwire.

.EXAMPLE
  .\scripts\dev-build.ps1
  .\scripts\dev-build.ps1 -Target cli -SkipTests
  .\scripts\dev-build.ps1 -Target vscode -Vsix
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'cli', 'vscode', 'desktop')]
    [string]$Target = 'all',
    [switch]$Vsix,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$failures = @()
$built = @()

function Step($name) { Write-Host "`n=== $name ===" -ForegroundColor Cyan }

# Runs a command in a directory; records a failure instead of throwing, so one broken
# target never hides the others.
function Invoke-Step {
    param([string]$Label, [string]$Dir, [string]$Exe, [string[]]$CmdArgs)
    Push-Location $Dir
    # With $ErrorActionPreference = 'Stop', ANY line a native command writes to stderr
    # is turned into a terminating error -- esbuild and npm write progress there on a
    # perfectly successful run, which showed up as a bogus RemoteException failure.
    # Judge these by exit code only.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Out-Host, not a bare call: anything a command writes to the pipeline would
        # otherwise be collected into this function's return value, so `return $false`
        # becomes a non-empty array and every `if ($ok)` reads as true.
        # No 2>&1: redirecting a native command's stderr wraps every line in an
        # ErrorRecord and prints a NativeCommandError banner on healthy builds.
        & $Exe @CmdArgs | Out-Host
        if ($LASTEXITCODE -ne 0) {
            $script:failures += "$Label (exit $LASTEXITCODE)"
            return $false
        }
        return $true
    } catch {
        $script:failures += "$Label ($_)"
        return $false
    } finally {
        $ErrorActionPreference = $prevEAP
        Pop-Location
    }
}

function Require-Tool {
    param([string]$Name, [string]$Hint)
    if (Get-Command $Name -ErrorAction SilentlyContinue) { return $true }
    $script:failures += "$Name not on PATH  --  $Hint"
    return $false
}

# Node-installed tools ship a .ps1 shim alongside a .cmd. The .ps1 one re-splits
# arguments and mangles them -- `npm run build:binary` arrives as an unknown command
# "pm". Always prefer the .cmd. (Same failure shape as other Node CLI shims here.)
function Resolve-NodeTool {
    param([string]$Name)
    $cmd = Get-Command "$Name.cmd" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $Name
}

# --- sanity ------------------------------------------------------------------
# molang-go is a sibling checkout, not a published module (see go.mod's replace
# directive). Without it nothing here builds, and the Go error is unhelpful.
if (-not (Test-Path (Join-Path (Split-Path -Parent $repo) 'molang-go'))) {
    Write-Host "molang-go is missing." -ForegroundColor Red
    Write-Host "go.mod replaces it with ../molang-go  --  clone it next to this repo." -ForegroundColor Red
    exit 1
}

if (-not (Require-Tool 'go' 'install Go 1.26+')) { exit 1 }

# --- tests -------------------------------------------------------------------
if (-not $SkipTests) {
    Step 'go test ./...'
    if (Invoke-Step 'go test' $repo 'go' @('test', './...', '-count=1')) {
        Write-Host 'tests ok' -ForegroundColor Green
    } else {
        # Keep going: a red test shouldn't stop you producing a binary to debug with.
        Write-Host 'tests FAILED  --  continuing so you still get artifacts' -ForegroundColor Yellow
    }
}

# --- cli ---------------------------------------------------------------------
if ($Target -in @('all', 'cli')) {
    Step 'headless CLI'
    $out = Join-Path $repo 'bin\featurelab.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
    if (Invoke-Step 'go build cmd/featurelab' $repo 'go' @('build', '-o', $out, './cmd/featurelab')) {
        $built += $out
        Write-Host "built $out" -ForegroundColor Green
    }
}

# --- frontend ----------------------------------------------------------------
# BOTH the extension and the desktop app consume featurelab-frontend as a BUILT package
# (frontend/package.json's main is ./dist/index.js), not as source. Skipping this step is how a
# freshly packaged vsix silently shipped a days-old panel: esbuild happily bundled the stale
# frontend/dist and every check passed, because nothing in the extension's own build depends on
# frontend/src at all.
function Build-Frontend {
    if (-not (Require-Tool 'npm' 'install Node.js')) { return $false }
    $fe = Join-Path $repo 'frontend'
    $npmExe = Resolve-NodeTool 'npm'
    if (-not (Test-Path (Join-Path $fe 'node_modules'))) {
        Invoke-Step 'npm install (frontend)' $fe $npmExe @('install') | Out-Null
    }
    return (Invoke-Step 'frontend build' $fe $npmExe @('run', 'build'))
}

if ($Target -in @('all', 'vscode', 'desktop')) {
    Step 'frontend (shared UI package)'
    if (Build-Frontend) {
        $built += (Join-Path $repo 'frontend\dist')
        Write-Host 'frontend built' -ForegroundColor Green
    }
}

# --- vscode extension --------------------------------------------------------
# apps/vscode's own build:binary drops a fresh cmd/featurelab into apps/vscode/bin/,
# which is where binaryResolver.ts looks when featurelab.binaryPath is unset. The
# binary is deliberately never committed.
if ($Target -in @('all', 'vscode')) {
    Step 'VS Code extension'
    $ext = Join-Path $repo 'apps\vscode'
    if (Require-Tool 'npm' 'install Node.js') {
        $npm = Resolve-NodeTool 'npm'
        if (-not (Test-Path (Join-Path $ext 'node_modules'))) {
            Invoke-Step 'npm install (apps/vscode)' $ext $npm @('install') | Out-Null
        }
        $ok = Invoke-Step 'vscode build:binary' $ext $npm @('run', 'build:binary')
        if ($ok) { $ok = Invoke-Step 'vscode compile' $ext $npm @('run', 'compile') }
        if ($ok -and $Vsix) {
            if (Require-Tool 'vsce' 'npm i -g @vscode/vsce') {
                $vsce = Resolve-NodeTool 'vsce'
                $ok = Invoke-Step 'vsce package' $ext $vsce @(
                    'package', '--no-dependencies', '--allow-missing-repository',
                    '-o', 'featurelab.vsix')
                if ($ok) { $built += (Join-Path $ext 'featurelab.vsix') }
            }
        }
        if ($ok) {
            $built += (Join-Path $ext 'dist')
            Write-Host 'extension ready  --  press F5 in VS Code with apps/vscode open' -ForegroundColor Green
        }
    }
}

# --- desktop -----------------------------------------------------------------
# Wails v2 needs a native toolchain per OS; on Windows it uses a Go-native WebView2
# loader (no cgo). The version matters: v2.13.0 works with Go 1.26; 2.8.2 fails with
# 'package "context" without types was imported'. This script invokes whatever wails
# is first on PATH rather than installing one.
if ($Target -in @('all', 'desktop')) {
    Step 'desktop app (Wails)'
    $desk = Join-Path $repo 'apps\desktop'
    if (Require-Tool 'wails' 'go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0') {
        if (Invoke-Step 'wails build' $desk 'wails' @('build', '-devtools')) {
            $exe = Join-Path $desk 'build\bin\featurelab-desktop.exe'
            if (Test-Path $exe) {
                $built += $exe
                Write-Host "built $exe" -ForegroundColor Green
            } else {
                # Wails renames output per config; don't claim a path that isn't there.
                $built += (Join-Path $desk 'build\bin')
                Write-Host "built into $desk\build\bin" -ForegroundColor Green
            }
        }
    }
}

# --- summary -----------------------------------------------------------------
Write-Host "`n=== summary ===" -ForegroundColor Cyan
foreach ($b in $built) { Write-Host "  ok   $b" -ForegroundColor Green }
foreach ($f in $failures) { Write-Host "  FAIL $f" -ForegroundColor Red }

if ($failures.Count -gt 0) {
    Write-Host "`n$($failures.Count) step(s) failed." -ForegroundColor Red
    exit 1
}
Write-Host "`nall selected targets built." -ForegroundColor Green
