#!/bin/zsh
# Mac counterpart of scripts/deploy.ps1: deploy the Shotblocks plugin into
# C4D's plugins folder. Same unified layout — Python rig tag + C++ timeline
# + web bundle + docs in ONE plugins/shotblocks/ folder.
#
# The native .xlib deploys via tools/build_native_mac.sh (or from the
# committed native/builds/macos_arm64). The web bundle comes from
# host/shotblocks/web/dist (npm run build) when present; this script does
# NOT run npm (no node on this machine yet).

set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"

if [[ -n "$SB_C4D_ROOT" && -d "$SB_C4D_ROOT" ]]; then
  C4D_ROOT="$SB_C4D_ROOT"
else
  C4D_ROOT=$(ls -dt "$HOME/Library/Preferences/Maxon/Maxon Cinema 4D 2026"*/ 2>/dev/null | head -1)
  [[ -n "$C4D_ROOT" ]] || { echo "No C4D 2026 prefs folder found; set SB_C4D_ROOT" >&2; exit 1; }
fi
DEST="$C4D_ROOT/plugins/shotblocks"
mkdir -p "$DEST"

# Python plugin (src/ minus vendor — minimp3.dll is Windows-only and unused
# by the Python side). --delete mirrors like robocopy /MIR; the exclusions
# protect the C++-side artifacts living in the same folder.
rsync -a --delete \
  --exclude 'vendor' --exclude '__pycache__' \
  --exclude 'web' --exclude 'docs' --exclude 'shotblocks.xlib' \
  "$REPO_ROOT/src/" "$DEST/"
echo "Deployed shotblocks (Python tag) -> $DEST"

# Bundled user manual.
if [[ -d "$REPO_ROOT/host/shotblocks/docs" ]]; then
  rsync -a --delete "$REPO_ROOT/host/shotblocks/docs/" "$DEST/docs/"
  echo "Deployed shotblocks (user manual) -> $DEST/docs"
fi

# Web bundle, if built.
if [[ -f "$REPO_ROOT/host/shotblocks/web/dist/index.html" ]]; then
  rsync -a --delete --exclude 'url-override.txt' \
    "$REPO_ROOT/host/shotblocks/web/dist/" "$DEST/web/"
  echo "Deployed shotblocks (web bundle) -> $DEST/web"
fi

# Native module from the committed build if the local SDK build is absent.
XLIB="$HOME/Dev/c4d_sdk_2026/_build_ninja/bin/Release/plugins/shotblocks/shotblocks.xlib"
[[ -f "$XLIB" ]] || XLIB="$REPO_ROOT/native/builds/macos_arm64/shotblocks/shotblocks.xlib"
if [[ -f "$XLIB" ]]; then
  cp "$XLIB" "$DEST/"
  echo "Deployed shotblocks (C++ timeline) -> $DEST/shotblocks.xlib"
else
  echo "Skipping shotblocks C++ (no .xlib built — run tools/build_native_mac.sh)"
fi
