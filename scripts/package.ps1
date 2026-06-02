# Packages Shotblocks into a clean, standalone distributable for the beta
# release. Unlike scripts/deploy.ps1 (which mirrors straight into the live
# C4D prefs folder for the dev loop), this produces a shippable tree:
#
#   dist/shotblocks/                 <- the clean plugin folder a user drops
#                                       into their C4D plugins/ directory
#   dist/shotblocks-v<ver>-beta.zip  <- zipped tree + README for manual install
#   dist/shotblocks-v<ver>-beta.zip.sha256
#
# The .exe installer is built separately by the Inno Setup script
# (scripts/shotblocks.iss) which consumes dist/shotblocks/.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1 -Version 1.0.0-beta -SkipBuild

[CmdletBinding()]
param(
    # Version string stamped into artifact filenames. Keep in sync with the
    # manual's release-notes version ("v1.0.0 beta").
    [string]$Version = "1.0.0-beta",
    # Skip the C++ / web rebuild and package whatever is already built.
    # Useful for iterating on the packaging itself.
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
$srcPython = Join-Path $repoRoot "src"
$hostRoot = Join-Path $repoRoot "host\shotblocks"
$webRoot = Join-Path $hostRoot "web"
$docsSrc = Join-Path $hostRoot "docs"

# Release build output for the C++ plugin (NOT produced by dev-loop.ps1).
$cppBuildDir = "C:\Dev\c4d_sdk_2026\build-win64"
$cppOut = Join-Path $cppBuildDir "bin\Release\plugins\shotblocks"

$distRoot = Join-Path $repoRoot "dist"
$stage = Join-Path $distRoot "shotblocks"

Write-Host "=== Shotblocks packaging (v$Version) ===" -ForegroundColor Cyan

# --- 1. Build (unless skipped) --------------------------------------------
if (-not $SkipBuild) {
    Write-Host "Building C++ plugin (Release)..."
    & cmake --build $cppBuildDir --config Release --target shotblocks
    if ($LASTEXITCODE -ne 0) { throw "C++ build failed ($LASTEXITCODE)" }

    Write-Host "Building web UI (npm run build)..."
    Push-Location $webRoot
    try {
        # Vite writes progress to stderr; capture so PowerShell doesn't flag
        # it as failure (same pattern as deploy.ps1).
        cmd /c "npm run build 2>&1" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed ($LASTEXITCODE)" }
    }
    finally { Pop-Location }
}
else {
    Write-Host "Skipping build (-SkipBuild)." -ForegroundColor Yellow
}

# --- 2. Verify inputs exist -----------------------------------------------
$xdl64 = Join-Path $cppOut "shotblocks.xdl64"
$webDist = Join-Path $webRoot "dist"
if (-not (Test-Path $xdl64)) { throw "Missing C++ binary: $xdl64 (build first)" }
if (-not (Test-Path (Join-Path $webDist "index.html"))) { throw "Missing web build: $webDist\index.html" }
if (-not (Test-Path $srcPython)) { throw "Missing Python source: $srcPython" }
if (-not (Test-Path $docsSrc)) { throw "Missing manual: $docsSrc" }

# --- 3. Stage a clean tree ------------------------------------------------
# Wipe any previous stage so removed files don't linger.
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Python rig: shotblocks.pyp + sb_rig_*.py + res/ + vendor/ (DLL + licenses).
# Exclude __pycache__ (bytecode) and vendor/build (rebuild sources). /MIR
# into a freshly-emptied stage so the result is exactly the clean tree.
robocopy $srcPython $stage /MIR /XD __pycache__ build /XF *.pyc /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (python) failed ($LASTEXITCODE)" }

# C++ binary: the .xdl64 only. NOT the .pdb (30 MB of debug symbols).
Copy-Item $xdl64 (Join-Path $stage "shotblocks.xdl64") -Force

# Web UI: the full bundled dist/ (index.html + cursors/ + svg assets) into web/.
# Exclude dev sidecars the Vite build copies through from the source cursors/
# dir: *.cssurl.txt (notes) and .gitignore. The real .cur files stay.
$webStage = Join-Path $stage "web"
New-Item -ItemType Directory -Path $webStage -Force | Out-Null
robocopy $webDist $webStage /MIR /XF *.cssurl.txt .gitignore /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (web) failed ($LASTEXITCODE)" }

# Bundled user manual: ships inside the plugin so the Help button's
# docs/index.html resolves relative to the .xdl64. Exclude _*-prefixed
# scratch files (manual-authoring working files: _batch*.xml, _scrub.py,
# _sections_*.json, etc.) so they never leak into the shipped package.
$docsStage = Join-Path $stage "docs"
New-Item -ItemType Directory -Path $docsStage -Force | Out-Null
robocopy $docsSrc $docsStage /MIR /XF _* /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (docs) failed ($LASTEXITCODE)" }

Write-Host "Staged clean tree -> $stage"

# --- 4. README for the zip (manual-install instructions) ------------------
$readme = @"
Shotblocks v$Version (beta) - Cinema 4D 2026 plugin (Windows)

MANUAL INSTALL
  1. Copy the "shotblocks" folder (next to this README) into your
     Cinema 4D 2026 plugins folder:
       %APPDATA%\Maxon\Maxon Cinema 4D 2026_<hash>\plugins\
     (The <hash> suffix is unique to your install. Paste
      %APPDATA%\Maxon into Explorer and open the "Maxon Cinema 4D 2026_..."
      folder, then plugins\.)
  2. Restart Cinema 4D.
  3. Confirm it loaded: Extensions > Console should show
       [Shotblocks] camera rig tag loaded
  4. Open the timeline from the Shotblocks command/menu entry.

The plugin is just a folder - no registry changes, no services. To
uninstall, delete the "shotblocks" folder and restart C4D. Your timeline
data lives inside each .c4d document, so removing the plugin loses no work.

WINDOWS WARNING (.exe installer only): the beta installer is unsigned, so
Windows SmartScreen may show "Windows protected your PC". Click "More info"
then "Run anyway". The .zip (this file) avoids that prompt entirely.

User manual: open shotblocks\docs\index.html in any browser, or use the
"?" Help button inside the plugin.
"@
Set-Content -Path (Join-Path $distRoot "README.txt") -Value $readme -Encoding utf8

# --- 5. Zip + checksum ----------------------------------------------------
$zipName = "shotblocks-v$Version.zip"
$zipPath = Join-Path $distRoot $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Zip the clean folder + the README at the archive root.
$readmePath = Join-Path $distRoot "README.txt"
Compress-Archive -Path $stage, $readmePath -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "Wrote $zipName"

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
$shaLine = "$hash  $zipName"
Set-Content -Path "$zipPath.sha256" -Value $shaLine -Encoding ascii
Write-Host "SHA-256: $hash"

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "  Clean tree : $stage"
Write-Host "  Zip        : $zipPath"
Write-Host "  Checksum   : $zipPath.sha256"
Write-Host ""
Write-Host "Next: build the .exe with Inno Setup (scripts\shotblocks.iss)."
exit 0
