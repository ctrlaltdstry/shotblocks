# macOS code-signing + notarization setup

Goal: sign + notarize Shotblocks' macOS binary so users install by plain
drag-and-drop with NO "Apple could not verify ... malware" warning.

**SETUP COMPLETE (2026-06-13).** A signed release is now one command:
`python3 tools/package_plugin.py --sign --zip`. The sections below are kept
as the record of what was done and how to redo it (e.g. on a new machine or
when the cert expires — see "Renewal").

Two pieces, with different scopes:
- The **Developer ID Application certificate** is *account-level* (Apple allows
  only a handful per account; you reuse ONE). The same cert signs Cubit and
  Shotblocks — that's correct and unavoidable, not a coupling.
- The **notary credential** is a per-profile keychain entry. Shotblocks has its
  own dedicated profile **`shotblocks-notary`** (Apple ID `legomike@mac.com`,
  team `87DC46P9EQ`), separate from Cubit's `cubit-notary`. The sign script
  defaults to `shotblocks-notary` (override with `SB_NOTARY_PROFILE`).

Team ID: **87DC46P9EQ**.

## State / checklist — all done

- [x] Enrolled in Apple Developer Program (Team ID 87DC46P9EQ)
- [x] CSR generated: `~/Dev/cubit_signing/CubitDeveloperID.certSigningRequest`
      (private key `cubit_devid.key`, chmod 600, never committed — the cert is
      account-level so the one CSR/key serves every plugin)
- [x] Created + downloaded the "Developer ID Application" cert (step 1)
- [x] Imported the cert into the login keychain (step 2) — identity
      `Developer ID Application: MICHAEL SLATER (87DC46P9EQ)`, valid to
      2027-02-01
- [x] Created a dedicated app-specific password (step 3)
- [x] Stored the notary credential as profile `shotblocks-notary` (step 4)
- [x] Signed + notarized + published the v1.2.0 release (step 5)

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
  --apple-id legomike@mac.com --team-id 87DC46P9EQ \
  --password <app-specific-password>
```

## Step 5 — sign, notarize, re-publish (Claude does this)

```bash
python3 tools/package_plugin.py --sign --zip
```

Then replace the asset on the GitHub release with the signed zip, install it
on a clean Mac, and confirm C4D loads the plugin with NO Gatekeeper warning
(`spctl -a -t install <xlib>` should report `source=Notarized Developer ID`).

## Renewal / new machine

- The cert expires **2027-02-01**. To renew: create a new Developer ID
  Application cert (steps 1–2) from the same CSR, then re-run a signed package.
- On a fresh machine you need the private key (`~/Dev/cubit_signing/
  cubit_devid.key`) imported alongside the cert, and the `shotblocks-notary`
  profile re-stored (step 4). The app-specific password is reusable, or mint a
  new one at appleid.apple.com.

## Notes

- Loose plugin files can't have a notarization ticket *stapled* into them, so
  approval is via Gatekeeper's online check on first load. Silent on any Mac
  with internet. (A fully offline-proof variant would wrap the release in a
  signed, stapled `.dmg`/`.pkg` — a possible later enhancement.)
- If the cert is ever unavailable, the unsigned zip still works; users strip
  quarantine once with
  `xattr -dr com.apple.quarantine <path-to>/plugins/shotblocks`.
