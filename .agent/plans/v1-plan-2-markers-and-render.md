# v1 Plan 2 — Markers + render workflow

Two features bundled in one plan because they share related UI surface (markers toggle in the utility strip; render settings move into the persistent right-side inspector). Both are net-new feature additions.

**Markers:** lightweight timing reference points dropped at the playhead via `M` hotkey, persist with scene, no properties beyond frame number.

**Render workflow:** plugin populates C4D's Render Queue with per-shot or per-sequence entries. Plugin does NOT fire render — user fires via C4D's Render Queue UI.

---

## Inspector panel — the architectural shift from the original plan

The earlier draft put render settings in a **popover** anchored to a render-gear utility-strip icon. That's been replaced by a **persistent right-side inspector panel**:

- Inspector is **always open** in v1. The existing `inspectorOpen` toggle + gear icon are removed — there's no collapse state any more.
- Inspector has a **fixed 250px width** (per Figma node `365:668`), sitting in its own grid column on the right side of the dialog.
- A **tab strip at the top** is designed in Figma (Render / Motion) but **hidden in v1**. The Motion tab activates in v2 when motion layers ship. For v1, the render content fills the inspector top with no tabs visible.
- Future-proofs the motion-layers roadmap: when v2 adds per-shot motion settings, those drop into a second tab without restructuring the layout.

Figma reference: node `365:668` (Inspector panel). Mike's design covers the section-header pattern + a few sample fields (Render mode dropdown, Render-all-tracks toggle, Tracks-to-include dropdown, Output folder + browse icon). The rest of the fields below extend those same patterns.

---

## Scope

**Markers:**
- `M` hotkey drops marker at current playhead frame
- Markers render on the ruler (thin vertical line / icon)
- Right-click on a marker → "Delete marker"
- Right-click on empty ruler → "Delete all markers"
- Utility strip already has a Markers toggle (per CLAUDE.md notes); wire it to show/hide markers
- Persist markers with scene (helper-BaseObject JSON)

**Render workflow:**
- Render settings live in the persistent right-side inspector under the (hidden-in-v1) Render tab
- Sections, top to bottom:
  - **Render Scope** — render mode, skip orphans, render-all-tracks toggle, tracks-to-include
  - **Output** — output folder, filename template, file format, frame padding
  - **Frame range** — per-shot / doc-settings / custom; explicit start + end inputs when Custom
  - **Render settings (read-only)** — renderer / resolution / fps / "Open Render Settings…" button. Reads from C4D's active Render Settings; not editable from the inspector.
  - **Action** — Add-to-Queue primary button + status line
- Click Add-to-Queue → plugin adds entries to C4D's Render Queue
  - Current shot mode: 1 entry (active shot at playhead's camera + range + output)
  - All shots mode: N entries, one per shot in document order
- User opens C4D Render Queue (existing C4D UI) → clicks Render → C4D processes the queue
- Each entry inherits the doc's active renderer + render settings (Redshift, Standard, Octane, etc.)
- Audio is never rendered

---

## Decisions locked in

### Markers
- **Markers have no properties** — just a frame number. Used for timing reference (credits, beats, etc.).
- **`M` hotkey** at playhead drops one. (Clicking the ruler still scrubs; no marker placement there in v1.)
- **Markers toggle** in utility strip = show/hide visibility, not enable/disable creation.
- **No marker labels in v1** — could add in v2 if asked. Frame number is implicit by position.

### Render
- **Inspector always open** — no toggle, no gear icon, no popover. Removed in Commit 5.
- **Tab strip designed but hidden in v1.** Tabs activate in v2 with motion layers.
- **No "Render" button** anywhere — only "Add to Queue." Render fires from C4D's Queue UI.
- **No conditional UI hiding for "Current shot" vs "All shots"** — output / file format / filename fields always visible.
- **Default output folder** = `<docfolder>/renders/`.
- **Default filename template** = `<docname>_<shot>`. Tokens: `<docname>`, `<shot>`, `<camera>`, `<track>`, `<frame>`. Plugin auto-appends `_<shot>` for All-shots mode if no `<shot>` token present.
- **Default file format** = EXR. Dropdown lists the format set C4D's active renderer can output.
- **Default frame padding** = 4.
- **Default frame range source** = Per shot. Custom only shows explicit start/end inputs when selected.
- **Same camera, different ranges = separate Queue entries.** Each shot is its own entry, regardless of camera reuse.
- **Render-all-tracks toggle = on by default.** When on, the "Tracks to include" dropdown is hidden (the toggle gates it). When off, the dropdown lets the user pick specific video tracks.
- **Skip orphans toggle = on by default.** Off forces the user to relink orphans before Add-to-Queue succeeds.
- **In/Out range does NOT push to render settings** — render range = the shot's range per queue entry, not the plugin's I/O points.

---

## Pre-implementation verification

**The render plan depends on C4D 2026 exposing a Render Queue API reachable from the C++ plugin.** Confirm BEFORE starting the render-queue commits:

- Check C4D 2026 SDK for `RenderDataInQueue` / `BatchRender` / equivalent APIs
- Test creating a queue entry programmatically with: camera override, frame range override, output path override
- Test reading the doc's current renderer, resolution, FPS (for the read-only display section)
- If the API is gone in 2026 → fall back to writing a `.b3d` queue file directly (last-resort) or revisit the architecture

Worst case: plan needs revision; better to know early than mid-implementation.

---

## Implementation order (commits)

### Markers section

### Commit 1 — `feat(markers): marker data model + persistence`

- Add `markers: number[]` (frame numbers, sorted) to the helper-BaseObject JSON schema
- Add to Zustand store: `markers` slice or extend an existing slice
- Actions: `addMarker(frame)`, `removeMarker(frame)`, `clearAllMarkers()`, `setMarkersVisible(bool)`
- No UI yet

**Verification:** in DevTools, run `useStore.getState().addMarker(30)` — confirm marker appears in state. Save scene, reload — marker persists.

### Commit 2 — `feat(markers): M hotkey drops at playhead, ruler visual`

- Global keyboard handler: `M` (no modifiers) → calls `addMarker(currentFrame)`
- Marker visual: thin vertical line + small triangle on the ruler at the marker's frame
- Markers respect the visibility toggle (default visible)
- Marker click target: small hit zone around the line (~10px wide)

**Verification:** scrub to frame 30, press M → marker appears on ruler at frame 30. Press M again at frame 50 → second marker appears. Both survive save/load.

### Commit 3 — `feat(markers): right-click delete (marker + clear all)`

- Right-click on a marker → context menu with "Delete marker"
- Right-click on empty ruler → context menu with "Delete all markers" (disabled if no markers)
- Each is its own undo step

**Verification:** add 3 markers, right-click one → Delete → that one disappears, other two remain. Right-click empty ruler → Delete all → all gone. Cmd-Z restores.

### Commit 4 — `feat(markers): utility-strip toggle wires to visibility`

- Locate the existing Markers toggle button in utility strip (per CLAUDE.md notes — was placeholder)
- Wire button click → toggles `markersVisible` state
- When false, markers don't render but still exist in state
- Toggle's visual state (pressed/unpressed) reflects current visibility

**Verification:** add markers, toggle off → markers disappear. Toggle on → reappear. Save with toggle off, reload → toggle state persists, markers still hidden.

### Render section — architectural shift

### Commit 5 — `chore(inspector): inspector is always-open; decouple from gear icon`

- Remove `inspectorOpen` from the Zustand store, the open/close keyboard shortcut (if any), and any code that conditionally renders / animates inspector visibility.
- Inspector occupies its own fixed-width grid column at all times; the timeline grid contracts to fit.
- **Keep** the gear icon in the utility strip — it'll route to a future settings window (out of scope for v1, but the icon stays so its spot is reserved).
  - The gear's click handler currently toggles `inspectorOpen`; rewire it to a no-op stub (or a `console.log('settings TBD')` placeholder) until the settings window lands.
- Inspector renders **empty** for this commit — content lands in subsequent commits.

**Verification:** plugin loads; inspector column is visible at 250px from the right edge; timeline width reduces to match; gear icon still on the utility strip but clicking it no longer toggles the inspector.

### Commit 6 — `feat(inspector): tab strip scaffold (hidden in v1) + Render content frame`

- Add the Render / Motion tab strip to the inspector top, matching Figma node `376:1207`.
- Tab strip is in the DOM but `display: none` in v1 (a feature flag in CSS / a constant in TS — single point to flip when v2 lands).
- The Render content area fills the inspector body below where the tab strip would sit.
- No render fields yet; just the section-header pattern + an empty body.

**Verification:** DevTools confirms the tab strip is present in the DOM (`document.querySelector('.inspector__tabs')`) but `display: none`. Toggling the flag shows it in-place per Figma.

### Commit 7 — `feat(render): C4D 2026 Render Queue API reachability test`

- Audit C4D 2026 SDK Render Queue API
- Build smallest possible test: programmatically add ONE queue entry with overridden camera/range/output, verify it appears in C4D's Render Queue UI
- Also read doc's current renderer / resolution / FPS for the read-only display section
- Document findings in a comment in the main render module
- No user-facing change yet

**Verification:** test code creates an entry, user opens Render Queue in C4D, sees the entry with correct camera + range + output path.

### Commit 8 — `feat(inspector/render): Render Scope section`

Wire the first section using Figma-designed controls:
- Render mode → dropdown: Current shot / All shots (default: All shots)
- Skip orphans → toggle (default: on)
- Render all tracks → toggle (default: on; gates the next field)
- Tracks to include → dropdown (multi-select picker; only visible when "Render all tracks" is off)

Backed by store slice `renderSettings` (new slice) — persisted alongside markers in the helper JSON.

**Verification:** all four controls render per Figma; toggling Render-all-tracks shows/hides the Tracks dropdown; values persist save/load.

### Commit 9 — `feat(inspector/render): Output section`

- Output folder → path text + folder icon. Browse icon opens C4D's native folder picker. Default: `<docfolder>/renders/`.
- Filename template → text input. Token chips below the input click-insert. Default: `<docname>_<shot>`. Resolved-name preview below.
- File format → dropdown. Default: EXR.
- Frame padding → number input (3–8). Default: 4.

All four persist in `renderSettings`.

**Verification:** path field accepts edits; folder browse opens a native picker and writes the chosen path back; format dropdown lists at least EXR/PNG/TIFF/JPEG; padding accepts 3–8.

### Commit 10 — `feat(inspector/render): Frame range section`

- Frame range source → dropdown: Per shot / Doc settings / Custom (default: Per shot).
- Custom range start → number input. Only visible when Custom.
- Custom range end → number input. Only visible when Custom.

Persists in `renderSettings`.

**Verification:** switching to Custom reveals start/end; switching back hides them but preserves the values; persist survives reload.

### Commit 11 — `feat(inspector/render): Render settings (read-only display)`

- Reads from C4D's active Render Settings via the JS↔C++ bridge. Updates whenever C4D EVMSG_CHANGE fires (the existing mechanism that already pushes `cameras` snapshots).
- Renderer → text label
- Resolution → text label (e.g. "1920 × 1080")
- FPS → text label
- "Open Render Settings…" button → calls a new C++ command that opens C4D's native Render Settings dialog (`CallCommand(<RENDER_SETTINGS_DIALOG_ID>)` or equivalent).

**Verification:** all three lines reflect the doc's settings; changing them in C4D's Render Settings dialog updates the inspector live; the button opens that dialog.

### Commit 12 — `feat(inspector/render): Action section — Add to Queue button`

- Primary blue button (matches `--color-timeline-primary-highlight`).
- Disabled when no shots match the current scope (empty doc or all clips orphan with skip-orphans off).
- Below the button, a status line auto-fades in/out after each click: e.g. "Added 5 shots to Render Queue · 1 orphan skipped".
- The Add-to-Queue logic wires up the full pipeline:
  - Current shot mode → 1 entry for the active shot at playhead.
  - All shots mode → N entries iterating over video tracks in document order.
  - Skips orphan clips when skip-orphans is on.
  - Builds the output path per entry via filename-template substitution.
- Each Add-to-Queue click is one undo step (a no-op for v1 — Queue entries aren't undoable in C4D, but make sure the plugin doesn't crash on Ctrl+Z right after).

**Verification:** end-to-end smoke test below.

### Commit 13 — `chore(inspector/render): edge cases + polish`

- Empty doc → button disabled with tooltip "No shots to render"
- All-orphan doc + skip-orphans off → button enabled but Add shows error status, no queue mutation
- Output path with no `<shot>` token in All shots mode → auto-append `_<shot>` before the extension
- Path-token preview updates as user types
- Filename sanitization: spaces → underscores, drop chars that break Win32 paths (`< > : " / \ | ? *`)
- Renderer-specific format list (e.g. Redshift exposes different defaults than Standard) — render queue handles this; we just send the chosen format and let C4D validate

**Verification:** all edge cases produce sane behavior. No crashes.

---

## Verification — end-to-end after all 13 commits

1. `cd host/shotblocks/web; npm run build` — clean
2. `cmake --build "C:\Dev\c4d_sdk_2026\build-win64" --config Release --target shotblocks` — clean
3. **Smoke test in C4D (`scripts/dev-loop.ps1`):**

   **Inspector layout (Commit 5–6):**
   - Plugin opens with the inspector docked permanently to the right at 250px.
   - No gear / toggle for the inspector exists.
   - Tab strip is absent visually in v1 (verify via DevTools that it's present but `display:none`).

   **Markers (Commits 1–4):**
   - Open dev-test.c4d
   - Scrub to frame 30 → press M → marker appears on ruler
   - Press M at frame 50 → second marker
   - Right-click marker at 30 → Delete → only frame 50 marker remains
   - Right-click empty ruler → Delete all → all gone
   - Cmd-Z several times → markers restored
   - Add markers, save, close, reopen → markers persist
   - Toggle markers visibility off → invisible but still in state
   - Toggle on → visible again
   - Save with toggle off, reopen → toggle state remembered

   **Render Scope (Commit 8):**
   - Render mode dropdown changes between Current shot / All shots
   - Skip orphans toggle persists
   - Render-all-tracks toggle on → Tracks dropdown hidden; off → dropdown visible with V1/V2/etc. options

   **Output (Commit 9):**
   - Output folder field accepts edit + browse picker
   - Filename template field accepts edit; token chips insert at cursor
   - File format dropdown picks; persist survives save/load
   - Frame padding number input clamps 3–8

   **Frame range (Commit 10):**
   - Per shot / Doc settings hide the explicit start/end inputs
   - Custom shows them; values persist
   - Switching between modes preserves the Custom values when not visible

   **Render settings display (Commit 11):**
   - Resolution + FPS + renderer name match what C4D's Render Settings shows
   - Open Render Settings button opens C4D's native dialog
   - Changing resolution in that dialog updates the inspector live

   **Render — Current shot mode (Commit 12):**
   - 3 clips on V1: shot 1 (Cam A, 0–60), shot 2 (Cam B, 60–120), shot 3 (Cam A, 120–180)
   - Scrub to frame 30 (shot 1) → Render mode = Current shot → Add to Queue
   - Open Render > Render Queue in C4D → 1 entry, Cam A, frames 0–60, output contains the shot's name
   - Scrub to frame 90 → Add to Queue → 2 entries total

   **Render — All shots mode:**
   - Clear queue → Render mode = All shots → Add to Queue
   - Open Render Queue → 3 entries: Cam A 0–60, Cam B 60–120, Cam A 120–180, each with unique output path

   **Render — edge cases (Commit 13):**
   - Delete Cam B (shot 2 becomes orphan) + skip-orphans on → All shots → Add to Queue → 2 entries (orphan skipped) + status line "1 orphan skipped"
   - Skip-orphans off + same scenario → Add refused, status line warns
   - Empty doc → button disabled with tooltip
   - Filename with no `<shot>` token, All shots mode → auto-appended `_<shot>`

---

## Open questions to resolve during implementation

- **(a) Click-on-ruler marker placement.** Probably M only — clicking the ruler currently scrubs the playhead, and adding marker placement there competes. Keep M as sole drop method unless asked.
- **(b) Render Queue API surface.** Pending Commit 7 audit. If the API doesn't allow per-entry output path override, output naming has to come from the doc's Render Settings template — falls back to harder UX. Address when found.
- **(c) "Open Render Settings" command id.** Pending Commit 11 audit. There must be a CallCommand id (it's a built-in menu item); confirm it works from the plugin context.
- **(d) Renderer-specific file format list.** Each renderer (Redshift / Standard / Octane) supports a subset of formats. v1 ships a static common-denominator list (EXR / PNG / TIFF / JPEG / MOV / MP4) and lets C4D reject unsupported ones at render time. Could become renderer-aware in v2.
- **(e) `<shot>` token character sanitization.** Shot names might have spaces or special characters. Sanitize at Add-to-Queue time (spaces → underscores, drop chars that break file paths). Decide rules during Commit 13.

---

## What this plan explicitly does NOT do

- **No render trigger** — plugin only adds to queue. User fires render manually via C4D's Render Queue UI.
- **No render progress UI in plugin** — C4D's Render Queue UI handles this.
- **No marker labels, colors, or properties** — frame number is the entire data model
- **No marker snap targets** — clips don't snap to markers (could add in v2 if useful)
- **No audio render** — confirmed audio is editor-only
- **No render presets / configurations** — current per-doc settings is the full surface; preset save/load could come in v2
- **No in/out point integration with render range** — Custom range exists for that
- **No collapsible inspector** — always open in v1
- **No motion-layers content** — that's v2; v1 ships with the tab strip hidden

---

## Hard rules (from CLAUDE.md and memory)

- C4D must be force-killed before deploy (dev-loop.ps1 handles)
- C4D plugin must be rebuilt for any C++ changes (render API touches + open-render-settings command + read-only render settings reflection are all C++)
- BaseContainer undo registers AT AddUndo time — markers writes and renderSettings writes must AddUndo before write
- Markers + renderSettings live in helper-BaseObject JSON, not separate persistence
- No silent `except: pass` — log exceptions
- Verify in C4D before committing
