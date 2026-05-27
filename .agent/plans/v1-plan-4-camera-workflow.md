# v1 Plan 4 — Camera workflow: chips + creation + selection-follows-playhead

> **Release:** v1 — see [v1-release-roadmap.md](v1-release-roadmap.md)
> **Status:** ready to start (after Plan 2.9 wraps)
> **Plan owner:** Mike + Claude

Three tightly-related camera-workflow features that ship in one plan because they share the chip UI and the dialog-focus plumbing. Splitting forces premature decoupling.

---

## Summary

1. **A/V track chips** — one active chip per side (V or A); the chip is the write target for *cursorless* clip inserts (button, paste). Cursor-driven inserts (OM drag) ignore the chip.
2. **In-timeline camera creation** — "Add Camera" button in two places (empty-state CTA + persistent bottom-right near Inspector). Click creates a camera in the OM, copies editor view + lens params, inserts a 72-frame clip on the active V chip's track at the playhead, switches the viewport. Atomic undo. User-pref camera type (Standard / Physical / Redshift / Octane) detected at runtime, configured in a new Settings → Defaults group.
3. **Selection-follows-playhead** — on scrub-end and playback-stop, select the under-playhead clip in the timeline AND select its camera in the OM (the latter gated on timeline-dialog focus). Direction is one-way: clip → OM, never OM → playhead.

---

## Why these three together

- Chips define "where does the next write land?" Camera creation is the first cursorless writer that needs the answer. Paste was always going to want it too. Wiring chips without a writer that uses them ships dead infrastructure.
- Selection-follows-playhead doesn't share UI with chips but DOES share the dialog-focus plumbing (OM-select fires only when timeline has focus). Building that focus state once for both keeps it consistent.
- These features collectively complete the "Shotblocks-as-shot-creation-tool" story. Without them v1 is "Shotblocks-as-shot-sequencing-tool": user has to leave the timeline to create cameras and find them in the OM.

---

## Open research items (resolve before commits start)

These are real unknowns. Don't draft commit bodies until they're answered. Each is small enough for a ~30min spike.

### R1. Camera type plugin IDs

We need to enumerate which camera object types are installed and present them in the Settings dropdown. Known unknowns:

- `Ocamera` (Standard) — `c4d_objectinfo.h` constant, always available.
- Physical camera — is it a separate object type ID, or just a render flag on `Ocamera`? Need to check.
- Redshift camera — vendor-defined type ID. Either find the documented constant (RS SDK header) or detect at runtime via `FindPlugin(id, PLUGINTYPE_OBJECT)`. Probably easier: scan registered plugins for ones whose name matches `*camera*` or check a few known IDs.
- Octane camera — same shape as Redshift.

**Spike:** in C++, walk `FilterPluginList(PLUGINTYPE_OBJECT, true)` (or equivalent), filter by name containing "camera", log the IDs. Test with Redshift installed and not installed.

**Output:** decide between hardcoded ID list with fallback vs runtime detection. Document the answer in `.agent/context/c4d-plugin-development.md`.

### R2. Timeline-dialog focus state

The OM-select-on-stop behavior is gated on "user is actively in the timeline." Definitions in tension:

- C4D dialog focus (`GeDialog::Activated` / `Deactivated`)
- WebView2 document focus (DOM focus inside the HtmlViewer)
- Window-manager mouse hover

These behave differently and can be out of sync (dialog focused but user clicked into the OM is the failure case we care about).

**Spike:** add temporary `GePrint` logging on every `GeDialog::Message` ID and every WebView2 focus event. Reproduce: user opens Shotblocks, then clicks the OM. What fires? Then clicks back to the timeline. What fires? Then scrubs while the OM is focused. What fires?

**Output:** pick one signal as canonical. My prior: WebView2 document focus (since dialog focus is too permissive — a focused dialog with the user clicking through to the OM still reports focused). Confirm or revise based on the data.

### R3. Atomic undo for camera-create + clip-add

`StartUndo` / `EndUndo` wraps must include every state change for the undo to be atomic. Open questions:

- Does `SetActiveObject` (OM selection) participate in undo? Or is selection state outside the undo system?
- Does `SetSceneCamera` (viewport routing) need undo? Probably not (it's view state, not doc state) but worth confirming.
- The clip-add side currently goes through the `save-state` HTTP handler which has its own AddUndo on the clip JSON. Camera-create needs to land BEFORE the clip-add so the AddUndo sequence is: NEWOBJ (camera) → CHANGE_SMALL (helper BC for clip). Verify the order works correctly under undo+redo.

**Spike:** prototype the create-camera handler with a TODO clip-add stub, do create + ⌘Z and see if both pieces revert atomically. If selection doesn't revert that's a problem (the AM will show the dead camera's params).

**Output:** confirm the right `AddUndo` calls, document in the v1 cross-plan decisions block.

### R4. Chip visual design

There is no Python precedent (Python had no chips). Design is genuinely new. Needs Figma exploration:

- Where does the chip live? Track header? Above the lane? Inside the lane gutter? My read: inline with the track header on the left, so it reads as "this track is the target."
- Active vs inactive visual: highlight color? Underline? Pill fill swap?
- Click behavior: click chip = activate. Click active chip = no-op? Toggle off? My read: clicking the already-active chip is a no-op (active state has nowhere else to go — exactly one chip is always active per side).

**Spike:** Mike provides Figma. Before Figma, sketch options to discuss.

**Output:** Figma node ID + design lock-in, captured in v1 cross-plan decisions.

---

## Commit plan

Five commits, in this order. Each verifiable in isolation. Each ships building.

### Commit 1 — Settings → Defaults group + camera-type dropdown

**Scope:** new "Defaults" section in `SettingsPanel.tsx` above "Audio". One row: "Default camera type" with `InspectorDropdown`. Options derived from R1's outcome. State key in store: `defaultCameraType: 'standard' | 'physical' | 'redshift' | 'octane'`. Persisted to helper BC as a new BCKEY. Wired to nothing yet (commit 2 reads it).

**Files:**
- `host/shotblocks/web/src/components/SettingsPanel.tsx` — new section, new row.
- `host/shotblocks/web/src/store/slices/ui.ts` (or wherever settings state lives) — new state key + setter.
- `host/shotblocks/web/src/usePersistence.ts` — write the new key into save payload; read on load.
- `host/shotblocks/source/main.cpp` — new BCKEY constant; load/store in save-state / load-state handlers.

**Acceptance:**
- Open Settings → see new "Defaults" section above "Audio."
- Dropdown shows available camera types (matches R1 outcome).
- Pick a type → close Settings → reopen → selection persists.
- Save scene → reopen scene → selection persists.
- No other behavior wired yet.

**Risk:** low. Pure UI + persistence; no C4D-side object operations.

### Commit 2 — Add Camera button + create-camera C++ handler

**Scope:** new button in two locations:
- Bottom-right of the timeline area, near the Inspector. Always visible.
- Empty-state CTA: a button inside the empty-state placeholder graphic (the dashed rectangle with "drop a camera from the OM" copy).

Click either → JS sends `create-camera` to C++. C++ handler:
1. Allocate camera of user-pref type from commit 1's `defaultCameraType`.
2. Copy editor camera matrix (`cam->SetMl(bd->GetEditorCamera()->GetMl())`) AND lens params (focal length, film offset, sensor size; copy via `cam->GetData()->SetData(...)` from editor cam).
3. Wrap in `StartUndo` / `AddUndo(UNDOTYPE_NEWOBJ, cam)` / `InsertObject(cam, nullptr, nullptr)` / `EndUndo` so the camera lands at the OM root top with a real undo entry.
4. Route viewport to the new camera via the `SetParameter(BASEDRAW_DATA_CAMERA)` recipe — see memory `c4d-setscenecamera-bypasses-cache-invalidation`.
5. Return `{ ok: true, objectId, sourceName }` ack to JS.

JS on ack: call existing `addClip(targetTrackId, sourceName, 'camera', objectId, playheadFrame, playheadFrame + 72)`. For commit 2 the target track is HARDCODED to V1. Chips come in commit 4.

Edge handling:
- Playhead near doc end (less than 72 frames of room): clamp clip end to `docFrames - 1`. Don't extend doc.
- Playhead inside existing clip: use the existing `replace` mode (same as drop). The route is in addClip already.

**Files:**
- `host/shotblocks/web/src/components/AddCameraButton.tsx` — new component (or two: persistent + empty-state variant).
- `host/shotblocks/web/src/components/EmptyStateOverlay.tsx` — add the CTA button.
- `host/shotblocks/web/src/App.tsx` — render persistent button bottom-right.
- `host/shotblocks/web/src/App.css` — button styles.
- `host/shotblocks/source/main.cpp` — new `create-camera` handler. Extract to `HandleCreateCamera` private method (memory `maxon-sourceprocessor-function-line-limit` — Dispatch is near the 600-line cap).

**Acceptance:**
- Empty timeline → empty-state CTA visible. Click → camera appears in OM, new clip on V1 at frame 0, viewport switches to new camera (nothing visually changes because the new camera inherited the editor view).
- Timeline with clips → persistent bottom-right button visible. Click at frame 100 → new camera in OM, new clip at 100-172 on V1, viewport switches.
- Cmd-Z reverts everything: clip disappears, camera disappears from OM, viewport returns to previous camera. Cmd-Shift-Z re-does atomically.
- Repeated clicks create "Camera", "Camera.1", "Camera.2" (C4D's name-uniquifier handles this for free).
- Settings dropdown set to "Redshift" → new camera is a Redshift camera (verified in OM as `RScamera` icon).

**Risk:** medium. Camera-side is well-tested SDK territory. The lens-param copy is the most likely source of off-by-one bugs (some params live on the camera object, some on a sub-tag). The reverse-scrub fix recipe must be applied correctly.

### Commit 3 — A/V chip UI + targeting state

**Scope:** chip UI based on R4 Figma. State in store: `activeVChip: trackId` and `activeAChip: trackId`. Default to V1/A1 on doc load.

Chip click → updates active state. Active chip has the highlighted visual treatment.

When a track is deleted:
- If it was the active chip target → reassign to the next existing track on that side. If no tracks remain (empty side), the chip state defaults to "what V1/A1 will be when the next auto-spawn happens."

When a new track is auto-spawned by an OM drop (existing v2 spawn-on-locked / drop-past-outermost behavior): the new track does NOT become the chip target. The user explicitly clicks to retarget. Reason: spawning a track is a side-effect of a drop, not an explicit "I want to work here" signal.

No writers honor the chip yet — commit 2's hardcoded V1 stays. Commit 4 wires creation + paste.

**Files:**
- `host/shotblocks/web/src/components/TrackChip.tsx` — new component.
- `host/shotblocks/web/src/components/TrackHeader.tsx` — render the chip.
- `host/shotblocks/web/src/store/slices/ui.ts` — `activeVChip`/`activeAChip` state + setters.
- `host/shotblocks/web/src/usePersistence.ts` — persist + load.
- `host/shotblocks/web/src/App.css` — chip styles.

**Acceptance:**
- Default state: V1 and A1 chips visible as "active"; other tracks have unhighlighted chips.
- Click V2's chip → V2 becomes active, V1 deactivates. A side unaffected.
- Delete V1 (right-click → Delete Track on a renumbered V1) → if V1 was active, active jumps to the new V1 (formerly V2, renumbered).
- Save + reopen scene → chip targets persist.

**Risk:** low. Pure UI state plus a small persistence add. The track-delete reassignment logic is the only behavioral subtlety.

### Commit 4 — Wire chips into camera-create + paste

**Scope:** swap commit 2's hardcoded V1 for `useStore.getState().activeVChip`. Paste handler (already exists in store) re-targets the active chip's track instead of "same track as source."

OM drag is explicitly NOT wired to the chip — cursor wins, per locked-in decision.

**Files:**
- `host/shotblocks/web/src/components/AddCameraButton.tsx` — read active chip from store, pass to addClip.
- `host/shotblocks/web/src/store/slices/timeline.ts` (or wherever paste lives) — honor active chip.

**Acceptance:**
- Click V2 chip → click Add Camera → new clip appears on V2 (not V1). Camera lands at OM top regardless.
- Copy clip from V1 → click V3 chip → paste → clip lands on V3.
- Drop OM camera onto V2 lane → clip lands on V2 (cursor won; chip ignored).
- Drop OM camera while cursor hovers no specific lane (e.g. cursor over the spawn-band) → spawn behavior unchanged (chip is not used as a fallback for OM-drag because the spawn-band already has a target).

**Risk:** low. Plumbing change, two write paths. Read commit 2 + 3's tests still pass.

### Commit 5 — Selection-follows-playhead (timeline + OM, focus-gated)

**Scope:** two parts.

**Part A — timeline clip selection.** Port of Python `_apply_selection_follows_playhead`. Triggers:
- Playback stop (transport handler).
- Scrub end (pointer-up on the playhead/ruler).

On trigger, find the top-track-wins clip at playhead. If found, select it in the timeline (`setSelectedClip(clipId)`). If playhead in gap, clear selection (`clearClipSelection()`).

**Part B — OM camera selection.** Same triggers. ADDITIONAL gate: timeline-dialog focus per R2.

On trigger, if focused:
- Found a clip with a live `objectId` → JS sends `select-in-om` with `{ objectId }`; C++ does `doc->SetActiveObject(cam, SELECTION_NEW)`.
- Orphan clip (objectId invalid or camera deleted) → skip the OM step. Timeline selection still happens.
- Gap → leave OM alone. Do NOT clear OM selection.

If not focused: skip the entire OM step. Timeline selection still happens.

**Never fires:**
- During live scrub (pointer still down). Same flicker rule as Python.
- During continuous playback. (Only on stop.)

**Files:**
- `host/shotblocks/web/src/useKeyboard.ts` or playback handler — trigger on playback stop.
- `host/shotblocks/web/src/components/Playhead.tsx` or scrub handler — trigger on pointer-up.
- `host/shotblocks/web/src/store/slices/timeline.ts` — selection helper if needed.
- `host/shotblocks/web/src/lib/host.ts` — `select-in-om` command.
- `host/shotblocks/source/main.cpp` — `select-in-om` handler; dialog focus message handling per R2 outcome.

**Acceptance:**
- Click in OM to select a light (not a camera). Scrub the timeline → light stays selected (no focus on Shotblocks). Click into the Shotblocks timeline → scrub → camera under playhead becomes OM-selected on release.
- Play timeline → stop → under-playhead clip selected in Shotblocks; if focused, under-playhead camera selected in OM. AM updates.
- Scrub across a gap → release in the gap → timeline selection clears, OM selection unchanged.
- Scrub across an orphan clip → release on the orphan → timeline selects the orphan clip, OM unchanged.
- During live scrub: timeline + OM selection do NOT update mid-scrub. Only on release.

**Risk:** medium. The focus gate is the trickiest piece — R2's spike output drives the design. Worth a manual smoke test pass across the four focus scenarios (dialog focused + WebView2 focused + OM focused + a different C4D dialog focused).

---

## What this plan does NOT do

- **No keyboard shortcut for "Add Camera"** — button-only in v1. Hotkey can come later if needed.
- **No "Add Audio" button** — out of scope. Audio is added by file drag-drop already; no equivalent ask exists.
- **No chip-based gesture menu** — chip is a tap-to-activate, not a click-and-hold menu.
- **No "auto-add camera at playhead when timeline empty" gesture** — explicit button only. The empty-state CTA is discoverable enough.
- **No OM → timeline reverse selection** — explicitly one-way per locked-in decision.

---

## Files touched (estimated)

**New files:**
- `host/shotblocks/web/src/components/AddCameraButton.tsx`
- `host/shotblocks/web/src/components/TrackChip.tsx`

**Modified files:**
- `host/shotblocks/web/src/components/SettingsPanel.tsx`
- `host/shotblocks/web/src/components/EmptyStateOverlay.tsx`
- `host/shotblocks/web/src/components/TrackHeader.tsx`
- `host/shotblocks/web/src/components/Playhead.tsx` (or scrub handler)
- `host/shotblocks/web/src/App.tsx`
- `host/shotblocks/web/src/App.css`
- `host/shotblocks/web/src/store/slices/ui.ts` (or wherever settings + chip state lives)
- `host/shotblocks/web/src/store/slices/timeline.ts`
- `host/shotblocks/web/src/usePersistence.ts`
- `host/shotblocks/web/src/lib/host.ts`
- `host/shotblocks/web/src/useKeyboard.ts`
- `host/shotblocks/source/main.cpp` (HandleCreateCamera + HandleSelectInOm + focus state)

---

## Memories that apply

- `c4d-setscenecamera-bypasses-cache-invalidation` — viewport routing on commit 2 MUST use the SetParameter recipe.
- `maxon-sourceprocessor-function-line-limit` — Dispatch is near 600 lines; extract HandleCreateCamera + HandleSelectInOm as private methods.
- `v2-js-to-cpp-via-loopback-http` — JS→C++ for create-camera + select-in-om is the existing HTTP path.
- `mine-python-for-constants` — Part A of commit 5 is a port of Python's `_apply_selection_follows_playhead`; read the source first. (Already done in conversation: triggers are stop+scrub-end-only, gap clears, no flicker on live scrub.)
- `inspector-section-pattern` / `inspector-dropdown-component` — reuse `InspectorDropdown` for the Settings Defaults dropdown.
- `propose-architectural-fix-when-bandaiding` — applies always. If R2 (focus state) hits a third blind fix, stop and surface the alternative (e.g. always-OM-select regardless of focus, or never-OM-select with a manual hotkey).

---

## Verification across commits

After Commit 5 ships, the full end-to-end smoke test:

1. Open empty timeline → empty-state CTA visible.
2. Click "Add Camera" CTA → camera in OM, clip on V1 at frame 0–71, viewport unchanged visually (because new cam inherited editor view).
3. Scrub to frame 100 → click persistent Add Camera button → second camera in OM, clip on V1 at 100–171 (overlapping is replaced-or-trimmed via addClip's replace mode).
4. Click V2's chip → click Add Camera → third camera, clip on V2 starting at playhead.
5. Settings → Defaults → change camera type → click Add Camera → new camera is the new type.
6. Play through → stop on a clip → both timeline and OM select that clip's camera (AM populates).
7. Click into the OM (focus leaves timeline) → scrub through the timeline → timeline clip selection updates, OM selection unchanged.
8. Cmd-Z six times → undo unwinds in inverse order. No orphans, no stale OM selection.

---

## Living document

Update this plan as the open research items resolve. R1–R4 outcomes get folded into the commit-by-commit details before the corresponding commit starts.

When the plan ships (commit 5 lands), change its status in `v1-release-roadmap.md` from "not started" to "shipped (`<hash>`..`<hash>`)" and link the commit range here too.
