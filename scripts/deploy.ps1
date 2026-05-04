# Mirrors src/ into the C4D plugins folder.
# Run before each Cinema 4D restart during the deploy-and-test loop.

$ErrorActionPreference = "Stop"

$source = "Z:\02_MKE\2026\shotblocks\src"

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
# /NFL /NDL suppress per-file/dir output
# /NJH /NJS suppress job header/summary
# /NP no progress percentage
robocopy $source $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

# robocopy exit codes 0-7 are success; 8+ are failures
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

Write-Host "Deployed shotblocks -> $dest"
exit 0
