# Mirrors src/ into the C4D plugins folder, and copies the C++ host
# plugin DLL if a build exists. Run before each Cinema 4D restart
# during the deploy-and-test loop.

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
# /XD build excludes the vendor build directory (rebuild sources kept
#     under version control but not needed at runtime)
# /NFL /NDL suppress per-file/dir output
# /NJH /NJS suppress job header/summary
# /NP no progress percentage
robocopy $source $dest /MIR /XD build /NFL /NDL /NJH /NJS /NP | Out-Null

# robocopy exit codes 0-7 are success; 8+ are failures
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

Write-Host "Deployed shotblocks -> $dest"

# --- Shotblocks v2 (C++ plugin) --------------------------------------------
# Copy shotblocks_v2.xdl64 from the SDK build output into the C4D prefs
# plugins folder. Optional: only deploys if the build artifact exists.
$v2BuildDir = "C:\Dev\c4d_sdk_2026\build-win64\bin\Release\plugins\shotblocks_v2"
$v2Dest = Join-Path $c4dPrefs "plugins\shotblocks_v2"

if (Test-Path $v2BuildDir) {
    New-Item -ItemType Directory -Path $v2Dest -Force | Out-Null
    robocopy $v2BuildDir $v2Dest shotblocks_v2.xdl64 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy (v2) failed with exit code $LASTEXITCODE"
    }
    # Web assets (demo.html etc.) live next to the DLL so the C++ plugin
    # can build a file:// URL relative to its own module location.
    $v2WebSrc = Join-Path $repoRoot "host\shotblocks_v2\web"
    if (Test-Path $v2WebSrc) {
        $v2WebDest = Join-Path $v2Dest "web"
        New-Item -ItemType Directory -Path $v2WebDest -Force | Out-Null
        robocopy $v2WebSrc $v2WebDest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy (v2 web) failed with exit code $LASTEXITCODE"
        }
    }
    Write-Host "Deployed shotblocks_v2 -> $v2Dest"
} else {
    Write-Host "Skipping shotblocks_v2 (no build at $v2BuildDir)"
}

exit 0
