#!/bin/zsh
# Sign + notarize the macOS Shotblocks binary so it installs with NO
# Gatekeeper "cannot verify malware" warning -- plain drag-and-drop works.
#
# Prerequisites (one-time, see SIGNING_SETUP.md). The cert + notary
# credential are ACCOUNT-level, so the same ones used for Cubit work here:
#   1. A "Developer ID Application" certificate for team 87DC46P9EQ in the
#      login keychain (codesign uses it).
#   2. A stored notarytool credential profile (default "shotblocks-notary",
#      override with SB_NOTARY_PROFILE):
#        xcrun notarytool store-credentials shotblocks-notary \
#          --apple-id <your-apple-id-email> --team-id 87DC46P9EQ \
#          --password <app-specific-password>
#
# Usage:
#   tools/sign_notarize_mac.sh "dist/Shotblocks <version>/MacOS/shotblocks"
# (Called automatically by package_plugin.py --sign.)

set -e

TEAM_ID="87DC46P9EQ"
NOTARY_PROFILE="${SB_NOTARY_PROFILE:-shotblocks-notary}"
TARGET="${1:?Usage: sign_notarize_mac.sh <path-to-shotblocks-folder>}"

if [[ ! -d "$TARGET" ]]; then
  echo "ERROR: not a folder: $TARGET" >&2; exit 1
fi

# --- 1. Locate the Developer ID Application signing identity -----------------
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | grep "$TEAM_ID" | head -1 \
  | sed -E 's/.*\) ([0-9A-F]+) ".*/\1/')

if [[ -z "$IDENTITY" ]]; then
  cat >&2 <<EOF
ERROR: No "Developer ID Application" certificate for team $TEAM_ID found.
Create it first (see SIGNING_SETUP.md). Until then, ship the unsigned package;
users strip quarantine manually (xattr -dr com.apple.quarantine <plugin>).
EOF
  exit 1
fi
echo "Signing identity: $IDENTITY"

# --- 2. Sign every Mach-O ---------------------------------------------------
# Hardened runtime (--options runtime) + secure timestamp are required for
# notarization. Shotblocks ships a single Mach-O (shotblocks.xlib); the loop
# stays generic in case a future build bundles .dylib/.so dependencies.
sign_one() {
  codesign --force --timestamp --options runtime --sign "$IDENTITY" "$1"
}

echo "Signing dylibs..."
find "$TARGET" -name "*.dylib" -type f -print0 | while IFS= read -r -d '' f; do sign_one "$f"; done
echo "Signing Python extensions (.so)..."
find "$TARGET" -name "*.so" -type f -print0 | while IFS= read -r -d '' f; do sign_one "$f"; done
echo "Signing the native plugin (.xlib)..."
find "$TARGET" -name "*.xlib" -type f -print0 | while IFS= read -r -d '' f; do sign_one "$f"; done

# --- 3. Verify --------------------------------------------------------------
echo "Verifying signatures..."
XLIB=$(find "$TARGET" -name "*.xlib" -type f | head -1)
[[ -n "$XLIB" ]] && codesign --verify --strict --verbose=1 "$XLIB"

# --- 4. Notarize ------------------------------------------------------------
# notarytool wants a zip of the signed payload. Apple records each signed
# binary's identity, so Gatekeeper approves them on the user's Mac (online
# check) even though loose plugin files can't have a ticket stapled into them.
ZIP="${TARGET:h}/shotblocks_notarize_payload.zip"
echo "Zipping signed payload for notarization..."
/usr/bin/ditto -c -k --keepParent "$TARGET" "$ZIP"

echo "Submitting to Apple notary service (this can take a few minutes)..."
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait

rm -f "$ZIP"
echo
echo "Done. The signed Shotblocks folder at:"
echo "  $TARGET"
echo "is notarized. Re-zip the distribution (package_plugin.py does this) and"
echo "users can drag-and-drop install with no Gatekeeper warning."
