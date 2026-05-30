# v1 Plan 6 — Beta installer + distributable package

> **Release:** v1 — see [v1-release-roadmap.md](v1-release-roadmap.md)
> **Status:** SHIPPED 2026-05-30. Commits `450580e` (package.ps1),
> `5178110` (Inno Setup .iss), `dbff0af` (manual install section).
> **Plan owner:** Mike + Claude

> **Shipped artifacts** (produced into the gitignored `dist/`, not committed):
> - `scripts/package.ps1` → clean `dist/shotblocks/` tree (47 files) +
>   `shotblocks-v1.0.0-beta.zip` + `.sha256` + `README.txt`. Verified: the
>   packaged tree loads in C4D (HTTP listener, web bundle, all 9 cursors).
> - `scripts/shotblocks.iss` → `shotblocks-v1.0.0-beta-setup.exe` via Inno
>   Setup 6.7.3 (installed via winget `JRSoftware.InnoSetup`). Per-user
>   install, globs the `Maxon Cinema 4D 2026_*` hash for the plugins folder,
>   registers an uninstaller + Start-menu manual shortcut. Verified: compiles;
>   silent install extracts all 47 files with uninstaller registered.
>
> **Build sequence to cut a release:**
> 1. `powershell -ExecutionPolicy Bypass -File scripts\package.ps1`
> 2. `"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" scripts\shotblocks.iss`
>
> **Still open before public release:** code-signing cert (Tier 2 EV), where
> downloads are hosted (GitHub Releases — see open question (d)), and wiring
> the .zip into the website's email-gate (website-plan-1 Phase 3).

Package Shotblocks as a one-click Windows installer for the beta
release, instead of the "copy the folder into your plugins directory"
manual install. The plugin is **just a folder** (no registry, no
service, no COM), so an installer's only real job is "assemble a clean
plugin folder and drop it in the right place" — the work is in (a)
producing a clean distributable tree from the dev repo, (b) detecting
the correct C4D 2026 plugins folder on an arbitrary machine, and (c)
managing the Windows trust / SmartScreen story.

---

## Decisions locked in (2026-05-29, with Mike)

- **Installer tech: Inno Setup** (`.exe` wizard). Free, industry-
  standard, auto-detects the install location, offers uninstall, and is
  trivially code-signable later. Chosen over a zip+script for polish and
  over MSI for simplicity.
- **Also ship a plain `.zip`** as the primary/fallback download for
  power users and anyone whose C4D folder we can't auto-detect. The zip
  contains just the clean `shotblocks/` folder + a `README.txt` with
  manual-install steps.
- **Beta is UNSIGNED.** No code-signing certificate for the beta. Buy
  one only at public/paid release. Rationale below ("Trust").
- **Sequenced after Plan 5.** The manual ships on its own; the manual's
  install chapter will document the unsigned-warning click-through, so
  the two are coupled in *content* but not in *commits*.

---

## The trust / SmartScreen problem (the crux)

The Windows "Windows protected your PC" blue warning (SmartScreen) is
driven by **code-signing**, not by the installer file format. An
unsigned `.exe` and an unsigned `.msi` trip the same warning. So the
decision tree is about certificates, not installer tech:

| Tier | Cost | SmartScreen behavior |
|---|---|---|
| **0 — Unsigned** | $0 | One-time warning; user clicks "More info → Run anyway". Common for beta plugins. **← beta choice** |
| **1 — OV cert** | ~$200–400/yr | Signed with identity, but reputation builds per-cert over weeks/downloads; early downloads still warned. |
| **2 — EV cert** | ~$300–700/yr + HW token + business vetting | Only option that clears SmartScreen from download #1. |

**For the beta: Tier 0.** Spending $400+ and going through business
vetting for a closed/known-audience beta is premature, and the EV
reputation benefit only matters at download volume. Revisit at public
release — when we do sign, the Inno Setup `.exe` and the staged tree are
both ready to sign with zero rework.

**Free friction-reducers to ship even while unsigned:**
- Offer the **zip as the primary download** so cautious users skip the
  `.exe` entirely.
- Publish a **SHA-256 checksum** of each artifact so users can verify
  integrity.
- A clear "you'll see a one-time Windows warning, here's why and how to
  proceed" note in both the README and the manual's install section.

---

## The two genuinely fiddly bits

### 1. The distributable tree differs from the dev-deploy tree

`scripts/deploy.ps1` mirrors `src/` straight into the live C4D prefs
folder and excludes things via `robocopy` flags — it does NOT produce a
clean, standalone, shippable folder. A new **`scripts/package.ps1`**
must:
- Release-build the C++ plugin
  (`cmake --build "C:\Dev\c4d_sdk_2026\build-win64" --config Release
  --target shotblocks` — note dev-loop.ps1 does NOT build C++, memory
  `feedback_dev_loop_does_not_build_cpp`).
- `npm run build` the web UI (`host/shotblocks/web` → `dist/`).
- Stage a clean `shotblocks/` tree:
  - Python: `shotblocks.pyp`, `sb_rig_*.py`, `res/`, `vendor/` (DLLs +
    license files) — but **exclude** `__pycache__/`, `vendor/build/`
    (rebuild sources).
  - C++: `shotblocks.xdl64` — **exclude** `shotblocks.pdb` (debug
    symbols, 30 MB).
  - `web/` (the bundled `dist/index.html`).
  - `docs/` — the Plan 5 user manual, so it ships *inside* the plugin.
  - **exclude** all `HANDOFF*.md`, `.agent/`, dev scenes, scripts.
- Emit version-stamped artifacts:
  `shotblocks-v1.0.0-beta.exe` + `shotblocks-v1.0.0-beta.zip` + their
  `.sha256` files.

### 2. Detecting the C4D 2026 plugins folder on an arbitrary machine

The dev path (`%APPDATA%\Maxon\Maxon Cinema 4D 2026_1ABCDC12\plugins`)
has an **install-specific build-hash suffix** (`_1ABCDC12`) that differs
per machine — the installer CANNOT hardcode it. Valid install targets:
- **Per-user prefs plugins folder:** `%APPDATA%\Maxon\Maxon Cinema 4D
  2026_<hash>\plugins\` — the hash is discoverable by globbing
  `%APPDATA%\Maxon\Maxon Cinema 4D 2026_*`. This is where dev deploys.
- **Global install plugins folder:** under the C4D install dir
  (e.g. `C:\Program Files\Maxon Cinema 4D 2026\plugins\`), discoverable
  via the Maxon registry key / common Program Files paths.

Inno Setup approach: probe both, present the detected folder(s), let the
user confirm or browse. Default to the per-user prefs folder (no admin
elevation needed, matches Maxon's own recommendation for third-party
plugins). **This detection is the one real engineering task in the plan**
— validate it against a clean machine / VM if possible, since the dev
machine's layout isn't representative.

---

## Implementation order (commits)

1. `chore(packaging): scripts/package.ps1 builds a clean distributable tree`
   — produces `dist/shotblocks/` clean tree + version-stamped `.zip` +
   `.sha256`. Verifiable on the dev machine (unzip → drop into a test
   C4D folder → confirm it loads). No Inno Setup yet.
2. `chore(packaging): Inno Setup script + C4D folder detection`
   — `.iss` that wraps the staged tree, detects/confirms the plugins
   folder, installs + registers an uninstaller. Build the `.exe`.
3. `docs: installer + unsigned-warning section in the manual`
   — extend the Plan 5 manual's install chapter (and the zip README)
   with installer steps, the SmartScreen click-through, and checksum
   verification. (May land as part of Plan 5 content if timing aligns.)

---

## Open questions to resolve during implementation

- **(a) Admin vs per-user install.** Per-user prefs folder needs no
  elevation and is the safer default; global install needs admin. Offer
  both or default per-user only? Lean per-user-only for beta.
- **(b) C4D version detection.** Sole target is 2026.2.0. Should the
  installer hard-block on not finding a 2026 folder, or just warn? Lean
  warn-and-let-the-user-browse (don't trap a valid non-standard layout).
- **(c) Uninstall completeness.** Inno's uninstaller removes the
  installed folder. Does it leave the user's per-document data? Yes —
  Shotblocks state lives in the `.c4d` doc (hidden helper null), not in
  the plugin folder, so uninstall is clean and loses no user work.
  Document this.
- **(d) Where do beta downloads live?** GitHub Releases on the private
  repo is the obvious host (checksums + release notes built in).
  Confirm with Mike at ship time.

---

## What this plan explicitly does NOT do

- **No code-signing certificate** (deferred to public release).
- **No auto-update mechanism** — beta users re-download + reinstall.
- **No macOS installer** — Windows-only target (CLAUDE.md scope).
- **No license-key / activation gate** — beta is unrestricted.
- **No Maxon "Asset/Capsule" or App-Store-style packaging** — out of
  scope; a folder-drop installer is the goal.

---

## Living document

When the installer ships, link the artifacts + commit range. When the
public-release signing decision is revisited, record which cert tier was
chosen here.
