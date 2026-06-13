# macOS code-signing + notarization setup

Goal: sign + notarize Shotblocks' macOS binary so users install by plain
drag-and-drop with NO "Apple could not verify ... malware" warning.

The Developer ID Application certificate and the notarization credential are
**account-level, not per-app** — the same ones sign Cubit and Shotblocks. If
you've already finished the setup for one, you only need steps 4–5 here (store
a notary profile name + run the signed package). Team ID: **87DC46P9EQ**.

This is a ONE-TIME setup. After it's done, a signed release is one command:
`python3 tools/package_plugin.py --sign --zip`.

## State / checklist

- [x] Enrolled in Apple Developer Program (Team ID 87DC46P9EQ)
- [x] CSR generated: `~/Dev/cubit_signing/CubitDeveloperID.certSigningRequest`
      (private key `cubit_devid.key`, chmod 600, never committed — reused here
      since the cert is account-level)
- [ ] **YOU:** upload CSR → download "Developer ID Application" cert (step 1)
- [ ] Claude: import the cert into the keychain (step 2)
- [ ] **YOU:** create an app-specific password (step 3)
- [ ] Claude: store the notary credential as profile `shotblocks-notary` (step 4)
- [ ] Claude: sign + notarize + re-publish the release (step 5)

## Step 1 — create the certificate (needs your Apple login)

1. Go to <https://developer.apple.com/account/resources/certificates/add>.
2. Under **Software**, choose **Developer ID Application**. Continue.
   (If greyed out, sign in as the Account Holder — that's you.)
3. Profile Type **G2 Sub-CA** (the default) is fine.
4. Upload `~/Dev/cubit_signing/CubitDeveloperID.certSigningRequest`.
5. Click **Continue**, then **Download**. You get `developerID_application.cer`.
6. Tell Claude where it downloaded (usually `~/Downloads/`).

NOTE: an account is limited to a small number of Developer ID Application
certs. Create just ONE and reuse it for every plugin. If you already created
it for Cubit, it's in the keychain already — skip to step 3.

## Step 2 — import it (Claude does this)

```bash
security import ~/Downloads/developerID_application.cer \
  -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
security find-identity -v -p codesigning   # should list Developer ID Application
```

## Step 3 — app-specific password (needs your Apple login)

1. Go to <https://appleid.apple.com> → sign in → **Sign-In and Security** →
   **App-Specific Passwords** → **+**.
2. Name it `shotblocks-notary` (or reuse the Cubit one — the password works for
   any notarization under your Apple ID). Apple shows a 16-char password like
   `abcd-efgh-ijkl-mnop`.
3. Give that password to Claude (revocable any time from this page).

## Step 4 — store the notary credential (Claude does this)

```bash
xcrun notarytool store-credentials shotblocks-notary \
  --apple-id <your-apple-id-email> --team-id 87DC46P9EQ \
  --password <app-specific-password>
```

## Step 5 — sign, notarize, re-publish (Claude does this)

```bash
python3 tools/package_plugin.py --sign --zip
```

Then replace the asset on the GitHub release with the signed zip, install it
on a clean Mac, and confirm C4D loads the plugin with NO Gatekeeper warning.

## Notes

- Loose plugin files can't have a notarization ticket *stapled* into them, so
  approval is via Gatekeeper's online check on first load. Silent on any Mac
  with internet. (A fully offline-proof variant would wrap the release in a
  signed, stapled `.dmg`/`.pkg` — a possible later enhancement.)
- Until the cert exists, the unsigned zip still works; users strip quarantine
  once with `xattr -dr com.apple.quarantine <path-to>/plugins/shotblocks`.
