#!/bin/zsh
# Canonical Shotblocks Mac dev iteration: force-restart C4D, rebuild +
# deploy, reopen the dev-test scene. Mac counterpart of dev-loop.ps1 — run
# it after every code change; the user takes over from C4D's UI to verify.
#
# Steps: force-kill C4D -> build web bundle (if node is found) -> build +
# install the native module -> deploy -> relaunch with the test scene.
#
# Flags / env:
#   --no-native        skip the native rebuild (web / Python-only changes).
#                      Faster, and avoids the per-build churn in
#                      native/builds/ that build_native_mac.sh produces.
#   SB_DEV_SCENE=...   absolute path to the scene to reopen (overrides the
#                      default scene pick below).
#   SB_C4D_ROOT=...    C4D prefs/plugins root (forwarded to deploy-mac.sh).
#
# Unlike Windows (where the running process locks the plugin DLL, so the
# kill MUST precede deploy), macOS lets you replace a loaded .xlib — but we
# still kill first so the relaunch loads the fresh build cleanly.

set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"

BUILD_NATIVE=1
for arg in "$@"; do
  case "$arg" in
    --no-native) BUILD_NATIVE=0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Matches ONLY the main C4D process — not the MXAI_ImageSense /
# QuickLookThumbnailing helpers, which live under different paths.
C4D_MATCH="Cinema 4D.app/Contents/MacOS/Cinema 4D"
APP="/Applications/Maxon Cinema 4D 2026/Cinema 4D.app"

# 1. Force-kill any running C4D and wait for it to actually exit.
if pgrep -f "$C4D_MATCH" >/dev/null 2>&1; then
  echo "Force-stopping Cinema 4D..."
  pkill -9 -f "$C4D_MATCH" || true
  for i in {1..50}; do
    pgrep -f "$C4D_MATCH" >/dev/null 2>&1 || break
    sleep 0.2
  done
fi

# 2. Build the web bundle so UI changes are picked up. deploy-mac.sh only
#    COPIES web/dist; it doesn't build. node isn't on the default PATH, so
#    find the toolchain under ~/Dev/tools the same way the dev shell does.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(dirname "$(command -v node)")"
else
  NODE_BIN="$(find "$HOME/Dev/tools" -maxdepth 2 -type d -name bin -path '*node-*' 2>/dev/null | head -1)"
fi
if [[ -n "$NODE_BIN" && -x "$NODE_BIN/npm" ]]; then
  echo "Building web bundle..."
  ( cd "$REPO_ROOT/host/shotblocks/web" && PATH="$NODE_BIN:$PATH" npm run build )
else
  echo "node not found - skipping web build (deploy will use existing web/dist)."
fi

# 3. Build + install the native module (also refreshes the committed
#    binary). Skip with --no-native.
if [[ "$BUILD_NATIVE" == "1" ]]; then
  "$REPO_ROOT/tools/build_native_mac.sh"
fi

# 4. Deploy Python tag + web bundle + docs + native module.
"$HERE/deploy-mac.sh"

# 5. Relaunch with the dev-test scene. Prefer the canonical (gitignored)
#    dev-test.c4d; else the newest scene in scenes/; SB_DEV_SCENE overrides.
SCENE=""
if [[ -n "$SB_DEV_SCENE" ]]; then
  SCENE="$SB_DEV_SCENE"
elif [[ -f "$REPO_ROOT/scenes/dev-test.c4d" ]]; then
  SCENE="$REPO_ROOT/scenes/dev-test.c4d"
else
  SCENE="$(ls -t "$REPO_ROOT"/scenes/*.c4d 2>/dev/null | head -1)"
fi

[[ -d "$APP" ]] || { echo "C4D app not found: $APP" >&2; exit 1; }
if [[ -n "$SCENE" && -f "$SCENE" ]]; then
  echo "Launching C4D with $SCENE..."
  open -a "$APP" "$SCENE"
else
  echo "No scene found; launching C4D without one."
  open -a "$APP"
fi
echo "Done. Cinema 4D is starting; check the dialog and console once it's up."
