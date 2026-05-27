# v1 Plan 3 — User manual

Bundled HTML user manual documenting every feature of the plugin. Ships with the plugin, opens in OS default browser. Written by Claude from a full plugin audit at v1 feature-complete.

This is the last v1 plan — ships after Plans 1 + 2 are landed so the manual documents what's actually in v1.

---

## Scope

- **Bundled HTML manual** in plugin folder (`src/docs/` or `host/shotblocks/docs/` — TBD during Commit 1)
- **Opens in OS default browser** via a "Help" or "?" button in the utility strip (or menu item)
- **Sidebar navigation** with categorized sections
- **Full feature coverage** — every UI element, every gesture, every hotkey, every workflow documented
- **Static HTML** — no build pipeline, no JS framework, no server. Just HTML + CSS + maybe one tiny JS file for the sidebar nav. Hand-written or simple template.
- **Versioned with the plugin** — docs ship in the plugin folder so they're always in sync with the installed version

---

## Decisions locked in

- **HTML files bundled in plugin folder** — offline, ships with plugin, no version drift, no hosting
- **Opens in OS default browser** (not in a WebView inside the plugin) — full browser features, easy to bookmark, separate window
- **Sidebar nav layout** — categorized sections, persistent nav
- **Claude writes the docs** — Mike provides visual direction (color/typography references) if desired
- **Audit-first approach** — Claude exhaustively audits what the plugin does at v1 feature-complete, then writes from that audit

---

## Implementation order (commits)

Smaller plan than the others — most of the work is content, not code. Code surface is just the docs folder, a button, and the OS-launch wiring.

### Commit 1 — `chore(docs): bundled docs folder + Help button skeleton`

- Create docs folder: probably `host/shotblocks/docs/` so it deploys alongside the plugin (parallel to `web/`)
- Add a stub `index.html` with placeholder content ("Shotblocks User Manual — coming")
- Add Help button to utility strip (`?` icon)
- Wire button → C++ opens file via Windows `ShellExecuteW("open", "...docs/index.html", ...)` — launches default browser
- Update `deploy.ps1` to copy `host/shotblocks/docs/` into the deployed plugin folder (similar to how `web/dist/` is copied)

**Verification:** click `?` button → default browser opens the stub `index.html`. Confirm path resolution works from the deployed plugin location, not just dev path.

### Commit 2 — `chore(docs): manual chrome — HTML template, CSS, sidebar nav`

- Hand-write a single `index.html` template (no SSG, no React)
- Sidebar on the left with section list (filled with placeholder section names)
- Main content area on the right
- CSS: clean, readable, neutral. Light/dark mode support nice-to-have but not required. Match Shotblocks plugin visual style if straightforward
- Tiny JS file (or inline `<script>`) to:
  - Highlight active section in sidebar based on scroll
  - Smooth-scroll on sidebar click
  - Optionally: collapse/expand category groups
- No build step — straight HTML edited by hand

**Verification:** open `index.html` in browser, sidebar renders, click sections, scroll syncs. Looks acceptable.

### Commit 3 — `docs: write the user manual — audit + draft`

This is the big content commit. Sections to cover (subject to audit findings):

**Getting Started**
- What Shotblocks is, what it's for
- Installation (where the plugin lives in C4D 2026 plugins folder)
- Opening the timeline (Extensions > Shotblocks)
- First-time workflow: drop a camera, scrub, play

**The Timeline**
- Layout overview (tracks, headers, ruler, playhead, utility strip)
- Track types: video vs audio
- Track headers: name, mute, solo, lock, eye toggles
- Auto-track spawn / auto-collapse
- V/A divider, vertical zoom, horizontal zoom
- MMB pan, Alt+RMB zoom (matches C4D conventions)
- Scrollbars (minimal pan overlays)

**Working with Cameras**
- Dropping cameras from the Object Manager
- The Shotblocks rig tag (link to its docs — separate? Or include?)
- Cameras switching during playback (Stage object NOT used — plugin handles directly)
- Camera rename behavior
- Orphan cameras (when a camera is deleted): visual, relink workflow

**Working with Audio**
- Importing audio files (drag from OS file browser)
- Why audio can't come from Object Manager
- Waveforms (rendering, zoom-adaptive)
- dB meter (live RMS during scrub + playback)
- Beat detection + snap to beats
- Audio playback in editor (note: Windows Volume Mixer "Microsoft Edge WebView2" controls volume)
- Orphan audio (file moved/missing): visual, relink workflow

**Clip Editing**
- Drag clips (body) to move
- Trim edges
- Roll edits
- Slip tool (audio)
- Ripple drag with modifier keys
- Snap to clip edges, beats, markers (when added)
- MIN_CLIP_FRAMES enforcement
- Cross-track ripple

**Playback**
- Spacebar (plugin-owned playback)
- Loop button
- I/O range (in/out point hotkeys)
- "Audio follows C4D timeline" toggle for native C4D scrub/play
- Scrubbing
- The pen tool (level curve editing for audio clips)

**Markers** (from Plan 2)
- M hotkey to drop
- Right-click delete (single + all)
- Visibility toggle
- Persistence

**Render** (from Plan 2)
- Render gear popover
- Current shot vs All shots modes
- Output path + `<shot>` token
- Adding to C4D Render Queue
- Firing the render from C4D's UI
- Notes on Redshift/Octane (renderer-agnostic, inherits doc settings)

**Persistence**
- Saving / loading scenes
- What's stored where (helper-BaseObject — briefly, not too deep)
- Auto-save debouncing

**Keyboard Reference**
- All hotkeys in one table

**Troubleshooting**
- Audio silent? Check Windows Volume Mixer for "Microsoft Edge WebView2"
- Ctrl+Z not working in plugin? Known WebView2 quirk; plugin forwards to C4D
- Plugin not loading? Check Extensions > Console for `[Shotblocks]` lines
- Scene won't open? Try opening without plugin to isolate

**Process for the audit:**
1. Re-read CLAUDE.md, all `.agent/context/*.md`, `host/shotblocks/HANDOFF.md`, memory files
2. Open the plugin in C4D, click every button, try every gesture, write down everything observed
3. Walk the code: `web/src/components/`, `web/src/hooks/`, `web/src/store/slices/`, `source/main.cpp`
4. Cross-reference observed behavior with code to catch features not visible from UI
5. Draft the manual

Don't ship if any feature is undocumented. The whole point is "complete coverage at v1."

**Verification:** read the rendered manual cover to cover. Every utility-strip button described. Every hotkey listed. Every quirk mentioned. A user installing v1 cold can understand the tool from this doc alone.

### Commit 4 — `chore(docs): screenshots + diagrams`

- Take screenshots of the plugin in key states: empty timeline, timeline with clips, render popover, orphan clip visual, etc.
- Embed in relevant sections
- Optionally: simple diagrams for concepts (track structure, render workflow)
- All images in `docs/images/` folder, referenced relative

**Verification:** manual has visuals in every major section. Screenshots match the actual plugin (not stale).

### Commit 5 — `chore(docs): release notes section + version stamp`

- Add a "What's New" or "Release Notes" section at top of sidebar
- v1 release notes: bullet list of what v1 includes (matches the v1 release roadmap scope)
- Version number visible in manual header (`Shotblocks v1.0.0`)
- Process for updating on future releases: bump version, add new release notes entry, ship

**Verification:** manual reads as a v1 release. Version is correct. Release notes match what shipped.

---

## Verification — end-to-end after all 5 commits

1. `cd host/shotblocks/web; npm run build` — clean (probably no web changes for this plan)
2. `cmake --build "C:\Dev\c4d_sdk_2026\build-win64" --config Release --target shotblocks` — clean (only Commit 1 touches C++)
3. **Smoke test in C4D (`scripts/dev-loop.ps1`):**
   - Click `?` in utility strip → default browser opens manual
   - Manual loads cleanly, sidebar visible, content readable
   - Click each sidebar section → main content scrolls / loads
   - All sections have content (no `[TODO]` placeholders)
   - Every plugin feature is described
   - Screenshots present and current
   - Version says v1.0.0

---

## Open questions to resolve during implementation

- **(a) Help button placement** — utility strip is getting crowded. Could go in a settings/overflow menu instead. Decide when wiring Commit 1.
- **(b) Visual style of the manual** — match Shotblocks plugin colors? Or use a neutral docs style (Stripe/Linear-like)? Probably plugin colors so it feels of-a-piece. Mike can direct.
- **(c) Should the rig tag's parameters be documented in this manual, or stay separate?** Rig tag lives in the Python plugin, shows up in C4D's Attribute Manager. Probably worth a short "Camera Rig Tag" section in this manual that covers the basics (spring, damper, noise, autofocus, framing, zoom) with links to deeper rig docs if any.
- **(d) Manual format alternatives.** Single-page vs multi-page? Single-page is simpler and easier to Ctrl+F. Multi-page would need a build step. Going single-page unless content volume gets unwieldy.
- **(e) Future-proofing for v2.** The manual structure should accommodate motion-layers docs cleanly when v2 ships. Categories like "Motion Layers" can be added as a new sidebar group without restructuring. Just make sure CSS / JS scales.

---

## What this plan explicitly does NOT do

- **No interactive demos / animations in the manual** — static screenshots only
- **No video tutorials** — out of scope
- **No translations** — English only
- **No in-app contextual help** (tooltips, ?-icon-on-every-button) — separate concern, could add in v1.x
- **No search functionality in the manual** — Ctrl+F in browser is enough at v1 scale
- **No web-hosted version** — bundled-only. Could publish to a URL later if useful.

---

## Hard rules (from CLAUDE.md and memory)

- C4D must be force-killed before deploy
- C4D plugin must be rebuilt for any C++ changes (Commit 1 only)
- `deploy.ps1` update for the new docs folder must use `robocopy /MIR` consistent with how `web/` is currently deployed — careful not to delete the docs folder when re-mirroring the Python source
- Verify in C4D before committing
- One atomic change per commit (each commit here is genuinely atomic — content commit is one large diff, but it's "write the manual" as one whole change)

---

## Important note on this being the last v1 plan

After this plan ships, **v1 is feature-complete**. That means:

- The manual should match what v1 ships, not what's coming in v2
- No "coming soon" sections for motion layers in the v1 manual
- A v1 release is a real release boundary; if Mike chooses to distribute v1, this manual is the canonical user-facing description of what they get

The motion-layers manual content (Release v2) gets added later as a separate update to this same docs folder.
