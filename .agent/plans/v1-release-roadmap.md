# v1 Release Roadmap

The work to get Shotblocks to a shippable v1. After this lands, object-visibility clips become the v1.5 release; motion-layers becomes the v2 release. See [release-roadmap.md](release-roadmap.md) for the cross-version index.

**v1 scope:** the timeline tool, complete and polished. Camera shot sequencing, audio scrubbing, basic editor ergonomics, render workflow, the camera workflow (chips + in-timeline camera creation + selection-follows-playhead), and the bundled user manual. No procedural camera animation (that's v2). No object-visibility clips (that's v1.5).

**Why this comes before v1.5 and v2:** the timeline has accumulated edge cases (orphan handling, scene-load races, render integration gaps) that should be closed before layering new conceptual primitives on top. A v1 release also produces a natural "stable foundation" that v1.5 and v2 can build against.

---

## Plan sequence

| # | Plan | Status | Spec | One-liner |
|---|---|---|---|---|
| 1 | **Edge cases + orphan handling** | shipped (`1323fa6`..`7607233`) | [v1-plan-1-orphan-and-edge-cases.md](v1-plan-1-orphan-and-edge-cases.md) | Orphan visuals for deleted cameras + audio, relink flows, edge-case audit across scene-load/rename/undo |
| 2 | **Markers + render workflow** | shipped (`0f363cf`..`723fc29`) | [v1-plan-2-markers-and-render.md](v1-plan-2-markers-and-render.md) | Timeline markers (M hotkey, ruler toggle, persist), inspector with render mode dropdown + Add-to-Queue (Whole sequence + Individual shots) + Sync Settings |
| 2.5 | **UI refinement + Hand/Zoom tools** | shipped (`96e6d2f`..`897d346`) | [v1-plan-2.5-ui-refinement.md](v1-plan-2.5-ui-refinement.md) | Floating tool-palette + dB-meter cards, rounded track headers, JetBrains Mono timecode, new Hand + Zoom tools with H/Z hotkeys, Selection tool gains keyframe edit parity with Pen, progressive empty state, drag-clamp bug fix, full chrome layout pass, motion library button, inspector full-height, drop-ceremony animation |
| 2.9 | **Final bug-fix + polish pass** | in progress | [HANDOFF.md](../../HANDOFF.md) | Triage `.agent/bugs.md`. Shipped today (2026-05-27): NLE-style edge-zone gating + label hide on tiny clips (`8dd5325`). Still open: razor + slip icons + razor highlight tweak (no plan doc — asset swap + CSS tweak). Help button moved to Plan 5 (coupled to manual). |
| 4 | **Camera workflow: chips + creation + selection-follows-playhead** | ready to start | [v1-plan-4-camera-workflow.md](v1-plan-4-camera-workflow.md) | A/V chip targeting (write-target for cursorless inserts: button, paste). In-timeline "Add Camera" button — empty-state CTA + persistent bottom-right near Inspector. Creates camera at playhead, 72-frame default, inheriting editor-view pose + lens params, atomic undo, viewport auto-switches. User-pref camera type (Standard / Physical / Redshift / Octane) detected at runtime, set in new Settings "Defaults" group using Inspector's dropdown component. Selection-follows-playhead: on scrub-end / playback-stop, select the under-playhead clip in timeline AND its camera in OM (OM step gated on timeline-dialog focus). Gap = clear timeline selection, leave OM alone. |
| 5 | **User manual + docs (incl. help button)** | not started | [v1-plan-3-user-manual.md](v1-plan-3-user-manual.md) | Bundled HTML manual covering every plugin feature, opens in default browser, written from plugin audit. Includes the Inspector `?` help button that launches the manual. (Plan file still named `v1-plan-3-*` for stability; renumbered to Plan 5 here to reflect ship order.) |

Six plans. v1 ships when all six land verified.

---

## Order rationale

**Plan 1 (orphans + edges) first** because it's pure cleanup against the current surface — closing known gaps without adding new concepts. Done before render because render touches data that orphan handling will reshape (a deleted camera's clip needs to behave sanely when render iterates over it).

**Plan 2 (markers + render) second** because both are net-new feature surface. Markers are small and self-contained; render is the bigger piece. Bundled because they share the utility-strip area (markers toggle lives there, render gear lives there).

**Plan 4 (camera workflow) before docs** because the manual needs to document the final shipping shape of camera creation. Writing the manual first means rewriting the camera-creation chapter once chips and the Add-Camera button land. The three sub-features (chips, creation, selection-follows-playhead) bundle into one plan because they share the chip UI and the dialog-focus plumbing — splitting them forces premature decoupling.

**Plan 5 (docs + help button) last** because the docs document what shipped — writing them before the rest means rewriting them after. Help button is bundled in because it has no purpose without the manual it launches. Plan 5 also gives a natural reason to do a full feature audit at the end (what does the plugin actually do today? — answering that = the manual).

---

## What v1 is NOT

- **No motion layers / pills / sub-lanes** — v2.
- **No procedural camera animation beyond the rig tag** — v2.
- **No object-visibility clips** — v1.5. v1 V-tracks hold camera clips only.
- **No per-shot inspector** — by your call. Render config is the only "inspector-shaped" thing v1 ships, and it lives in a popover.
- **No color tagging of shots** — deferred. Easy add later if useful.
- **No shot list export** — deferred.
- **No public release mechanism** — v1 means "feature-complete and stable." Distribution is a separate concern.

---

## Cross-plan decisions already locked in

(So they don't drift as plans get drafted.)

### Plan 4 — camera workflow (chips + creation + selection-follows-playhead)

- **Chip role:** "write target" for cursorless inserts. Camera-creation button and paste both honor the active chip. OM drag still drops on whichever lane the cursor is over (cursor wins; chip is the cursorless fallback).
- **Chip UI:** one active chip per side (V or A). Default V1 / A1. Click chip to make it active. Active chip has a highlighted state.
- **Add Camera button:** two entry points — empty-state CTA and a persistent button bottom-right near the Inspector. Same handler.
- **New camera defaults:**
  - Type: user pref from Settings → Defaults. Default "Standard" (`Ocamera`). Other options detected at runtime from registered plugin IDs (Physical / Redshift / Octane); fall back to Standard if previously-chosen type is no longer available.
  - Position + lens params: copied from the editor camera (`SetMl` from `bd->GetEditorCamera()->GetMl()`, plus focal length / film offset / etc.) so the new view looks identical to what's currently in the viewport.
  - Inserted at top of OM root (`InsertObject(cam, nullptr, nullptr)`) — matches C4D's own "New Camera" command behavior.
  - Naming: C4D's standard "Camera", "Camera.1", … via the doc's name-uniquifier (free).
- **New clip defaults:**
  - Span: playhead → playhead + 72 frames.
  - Target track: active chip on the V side.
  - Edge: playhead near doc end → clamp the clip to doc end (don't extend doc).
  - Edge: playhead inside existing clip → existing `replace` mode (same as a drop).
- **Atomic undo:** create camera + InsertObject + addClip + viewport-camera-switch all under one `StartUndo`/`EndUndo`.
- **Viewport routing:** new camera becomes the active scene camera (free — the playhead-driven router picks it up automatically because a clip now exists at the playhead). Use the `SetParameter(BASEDRAW_DATA_CAMERA)` recipe to avoid the reverse-scrub cache miss — see memory `c4d-setscenecamera-bypasses-cache-invalidation`.
- **Settings panel:** new "Defaults" group at the top of the Settings panel. First control: default camera type dropdown. Uses the Inspector's existing dropdown component for consistency.
- **Selection-follows-playhead:**
  - Triggers: playback stop, scrub end (pointer-up on playhead/ruler/clip-scrub). Never during live scrub or continuous playback (flicker).
  - Timeline clip selection: always fires on the triggers (it's our own UI).
  - OM camera selection: fires on the triggers ONLY when the timeline dialog has focus. WebView2 document focus is the canonical "user is in the timeline" signal.
  - Gap behavior: timeline = clear selection (port of Python); OM = leave alone (friendlier — don't yank an unrelated selection).
  - Orphan clip: select timeline clip; skip OM step.
  - Direction: clip → OM only. Never OM → playhead. (One-way; selecting in the OM does not move the playhead.)

### Plan 5 — manual + help button

- **Orphan camera clip = visual treatment per Figma** (Mike provides design at implementation). Selectable, persists, playback treats it as "no camera" (black or unchanged).
- **Orphan audio = right-click → Relink** → OS file picker.
- **Orphan camera = right-click → Relink to camera** → list of doc cameras to pick.
- **Camera rename:** clip label re-reads `cameraLink.GetObject().GetName()` per render. BaseLink already survives renames; just confirm the UI is reactive.
- **Two cameras with same name:** non-issue, BaseLink resolves by object identity, not name.
- **Markers:** `M` hotkey drops at playhead. Ruler shows them. Right-click marker → delete. Right-click empty ruler → "Delete all markers." Toggle visibility from utility strip. Persist with scene. No properties — just frame number.
- **Render:** popover in render gear. Two modes: Current shot / All shots. Adds entries to C4D Render Queue — does NOT fire render. User fires from C4D's Queue UI.
- **Render output path:** popover has a base path field, default `<docfolder>/<docname>_<shot>.exr`. Plugin substitutes `<shot>` token per entry; auto-appends `_<shot>` if token missing.
- **Audio:** never rendered. Editor-preview only.
- **In/Out range:** plugin's I/O points don't push to C4D render settings. Render range = the shot's range per queue entry.
- **Renderer:** plugin doesn't touch renderer setting. Whatever the user has in C4D render settings (Redshift, Standard, Octane) is what each queue entry inherits.
- **Docs:** HTML files bundled in plugin folder. Opens in OS default browser. Sidebar nav. Mike's call on visual style at implementation.

---

## After v1 ships

[v1.5-release-roadmap.md](v1.5-release-roadmap.md) (object-visibility clips) becomes the next release. Motion-layers (`motion-layers-roadmap.md`) follows as v2.

This roadmap goes to "shipped" status; no further plans land here. v1.x maintenance (bugfixes, polish) doesn't need plan files — those are commits straight to main.

---

## Living document

Like the motion-layers roadmap, this is expected to change. If a plan reveals new scope or surfaces blockers, add or rewrite. When a plan is shipped, change Status to "shipped" and link the final commit range.
