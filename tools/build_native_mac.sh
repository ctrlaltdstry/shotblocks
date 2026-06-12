#!/bin/zsh
# Build + install the native shotblocks module for macOS, and refresh the
# repo-committed binary under native/builds/macos_arm64/shotblocks/.
# Mac counterpart of the Windows C++ build feeding scripts/deploy.ps1.
#
# Prereqs (see MAC_CROSSPLATFORM_HANDOFF.md):
#   - Xcode Command Line Tools (full Xcode NOT required — Ninja generator)
#   - SDK extracted from "/Applications/Maxon Cinema 4D 2026/sdk.zip" to
#     $C4D_SDK with this module registered in its custom_paths.txt:
#       MODULE <repo>/host/shotblocks
#   - cmake >= 3.30 + ninja under ~/Dev/tools (no Homebrew needed)
#
# The SDK's cmake/sdk_compiler_helper.cmake needs one local patch for Ninja
# (split the compound "-Xarch_x86_64 -msse4.2" flag); already applied to the
# extract at $C4D_SDK. Re-extracting sdk.zip requires re-applying it.

set -e

C4D_SDK="${SB_C4D_SDK:-$HOME/Dev/c4d_sdk_2026}"
TOOLS="$HOME/Dev/tools"
export PATH="$TOOLS:$TOOLS/cmake-3.31.10-macos-universal/CMake.app/Contents/bin:$PATH"

# System frameworks the Maxon static libs (and warp_cursor_mac.cpp)
# reference. The SDK's maxon_linkFrameworks plumbing emits -l<name> under
# the Ninja generator, so pass real -framework flags globally instead.
FW="-framework CoreFoundation -framework Foundation -framework CoreServices \
-framework AppKit -framework CoreGraphics -framework IOKit -framework Security \
-framework SystemConfiguration"

cmake -S "$C4D_SDK" -B "$C4D_SDK/_build_ninja" -G "Ninja Multi-Config" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_SHARED_LINKER_FLAGS="$FW" -DCMAKE_MODULE_LINKER_FLAGS="$FW"
cmake --build "$C4D_SDK/_build_ninja" --config Release --target shotblocks

OUT="$C4D_SDK/_build_ninja/bin/Release/plugins/shotblocks"
[[ -f "$OUT/shotblocks.xlib" ]] || { echo "Build output missing: $OUT" >&2; exit 1; }

# Install the binary into the local C4D plugins folder (per-machine hash
# suffix on the prefs dir). Override with SB_C4D_ROOT. The rest of the
# plugin folder (pyp, res, web, docs) deploys via scripts/deploy-mac.sh.
if [[ -n "$SB_C4D_ROOT" && -d "$SB_C4D_ROOT" ]]; then
  C4D_ROOT="$SB_C4D_ROOT"
else
  C4D_ROOT=$(ls -dt "$HOME/Library/Preferences/Maxon/Maxon Cinema 4D 2026"*/ 2>/dev/null | head -1)
  [[ -n "$C4D_ROOT" ]] || { echo "No C4D 2026 prefs folder found; set SB_C4D_ROOT" >&2; exit 1; }
fi
PLUG="$C4D_ROOT/plugins/shotblocks"
mkdir -p "$PLUG"
cp "$OUT/shotblocks.xlib" "$PLUG/"
echo "Installed: $PLUG/shotblocks.xlib"

# Refresh the repo-committed build (lets either machine package both OSes;
# tools/package_plugin.py checks the stamp and warns when it goes stale).
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/native/builds/macos_arm64/shotblocks"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$OUT/shotblocks.xlib" "$DEST/"
python3 "$REPO_ROOT/tools/native_stamp.py" write "$DEST"
echo "Committed-build refreshed: $DEST"
