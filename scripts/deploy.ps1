# Deploys the Shotblocks plugin to C4D's plugins folder. The plugin
# is two parts that live in ONE deployed folder (plugins/shotblocks/):
#   1. Python rig tag (src/shotblocks.pyp + sb_rig_*.py)
#   2. C++ timeline (host/shotblocks/ builds shotblocks.xdl64 + web/)
# C4D loads .pyp and .xdl64 from the same folder without issue.
# Run before each Cinema 4D restart during the deploy-and-test loop.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
$source = Join-Path $repoRoot "src"

# C4D 2026's prefs folder on this machine. The build-hash suffix
# (_1ABCDC12) is install-specific; if the prefs folder name changes
# (e.g. C4D update reissues it), update this path.
$c4dPrefs = "$env:APPDATA\Maxon\Maxon Cinema 4D 2026_1ABCDC12"
$dest = Join-Path $c4dPrefs "plugins\shotblocks"

if (-not (Test-Path $source)) {
    throw "Source not found: $source"
}
if (-not (Test-Path $c4dPrefs)) {
    throw "C4D 2026 prefs folder not found: $c4dPrefs"
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null

# /MIR mirrors source to dest (deletes orphaned files in dest)
# /XD build  excludes the vendor build directory (rebuild sources kept
#            under version control but not needed at runtime)
# /XD web    excludes the C++ plugin's web/ subfolder so /MIR doesn't
#            delete the web bundle on the Python deploy. Both plugins
#            now live in one shotblocks/ folder under C4D plugins/;
#            the C++ side adds shotblocks.xdl64 + web/ via a second
#            robocopy below.
# /XF shotblocks.xdl64
#            same reason: don't delete the C++ binary on Python deploy.
# /NFL /NDL suppress per-file/dir output
# /NJH /NJS suppress job header/summary
# /NP no progress percentage
robocopy $source $dest /MIR /XD build web /XF shotblocks.xdl64 /NFL /NDL /NJH /NJS /NP | Out-Null

# robocopy exit codes 0-7 are success; 8+ are failures
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

Write-Host "Deployed shotblocks (Python tag) -> $dest"

# --- Shotblocks C++ plugin -------------------------------------------------
# Copy shotblocks.xdl64 + web/ INTO the same plugins/shotblocks/ folder
# the Python deploy already populated. C4D loads .pyp and .xdl64 from
# the same folder happily; the unified layout means there's one
# "Shotblocks" folder under plugins/, not two.
$cppBuildDir = "C:\Dev\c4d_sdk_2026\build-win64\bin\Release\plugins\shotblocks"

if (Test-Path $cppBuildDir) {
    # The .xdl64 lands directly in $dest alongside the .pyp.
    robocopy $cppBuildDir $dest shotblocks.xdl64 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy (cpp) failed with exit code $LASTEXITCODE"
    }
    # Web app: React + TypeScript + Vite. We build via `npm run build`
    # (output in web/dist) and copy dist/ into the plugin's web/ folder.
    # The C++ side loads web/index.html.
    $webSrc = Join-Path $repoRoot "host\shotblocks\web"
    if (Test-Path (Join-Path $webSrc "package.json")) {
        Write-Host "Building shotblocks web (npm run build)..."
        Push-Location $webSrc
        try {
            # Vite writes progress to stderr. PowerShell would flag that
            # as a failure; capture and re-emit so we only fail on real
            # non-zero exits.
            cmd /c "npm run build 2>&1" | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }
        $distSrc = Join-Path $webSrc "dist"
        if (-not (Test-Path $distSrc)) {
            throw "Vite build produced no dist/ at $distSrc"
        }
        $webDest = Join-Path $dest "web"
        New-Item -ItemType Directory -Path $webDest -Force | Out-Null
        robocopy $distSrc $webDest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy (web dist) failed with exit code $LASTEXITCODE"
        }
    }
    Write-Host "Deployed shotblocks (C++ timeline) -> $dest"
} else {
    Write-Host "Skipping shotblocks C++ (no build at $cppBuildDir)"
}

exit 0
