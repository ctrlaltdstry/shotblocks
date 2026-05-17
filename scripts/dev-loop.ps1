# Canonical Shotblocks dev iteration: deploy, force-restart C4D, open dev-test scene.
# Run this after every code change. The user takes over from C4D's UI to verify.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here

# 1. Force-close any running C4D first. The running process locks the
#    v2 plugin DLL, so deploy must happen AFTER the kill or robocopy
#    silently fails to overwrite the .xdl64.
$proc = Get-Process -Name "Cinema 4D" -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "Stopping Cinema 4D (PID $($proc.Id))..."
    Stop-Process -Id $proc.Id -Force
    while (Get-Process -Name "Cinema 4D" -ErrorAction SilentlyContinue) {
        Start-Sleep -Milliseconds 200
    }
}

# 2. Deploy
& "$here\deploy.ps1"

# 3. Relaunch with dev-test scene
$exe = "C:\Program Files\Maxon Cinema 4D 2026\Cinema 4D.exe"
$scene = Join-Path $repoRoot "scenes\dev-test.c4d"

if (-not (Test-Path $exe))   { throw "C4D exe not found: $exe" }
if (-not (Test-Path $scene)) { throw "Scene not found: $scene" }

Write-Host "Launching C4D with $scene..."
Start-Process -FilePath $exe -ArgumentList "`"$scene`""
Write-Host "Done. Cinema 4D is starting; check the dialog and console once it's up."
