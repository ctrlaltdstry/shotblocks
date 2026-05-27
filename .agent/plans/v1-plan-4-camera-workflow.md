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

### R1. Camera type plugin IDs — RESOLVED (2026-05-27)

**Result: hardcoded IDs from Maxon SDK headers. Runtime enumeration not needed.**

Both interesting IDs are documented constants in `frameworks/cinema.framework/source/ge_prepass.h`:

```cpp
#define Ocamera       5103       // Standard camera (CameraObject)
#define Orscamera     1057516    // Redshift "New Camera Object"
```

Verified via spike: `FindPlugin(id, PLUGINTYPE::OBJECT)` resolves both (when Redshift is loaded). `BaseObject::Alloc(id)` returns the correctly-typed object — `GetName()` on the allocated object returns "Camera" / "RS Camera" (the localized UI strings, matching the OM display).

**Note on naming:** earlier enumeration via `FilterPluginList(OBJECT, true)` showed 493 plugins, zero matched "camera" via `BasePlugin::GetName()`. That suggests `BasePlugin::GetName()` returns the symbolic / internal name, not the localized UI label. The same plugins return the right localized name from `BaseObject::Alloc(id)->GetName()`. Doesn't matter for our purposes since we work from known IDs.

**Physical camera is NOT a separate object type.** The "Physical" branding in C4D is a render-side concept; physical params live on `Ocamera` and activate when the Physical renderer is selected. So our dropdown has Standard, Redshift, and (later) other vendor types — no Physical entry.

**Octane / Arnold / other vendors:** not shipped with C4D, so no SDK constant. Add IDs as they become known; one new entry per vendor in the candidates array.

**Implementation for commit 1:**

1. C++ defines a candidates array:
   ```cpp
   struct CameraType { Int32 id; const char* defaultLabel; };
   constexpr CameraType kCameraCandidates[] = {
     { 5103,    "Camera" },        // Standard — always present
     { 1057516, "RS Camera" },     // Redshift — present if loaded
   };
   ```
2. On `C4DPL_PROGRAM_STARTED`, walk the array. For each, `FindPlugin(id, PLUGINTYPE::OBJECT)`; if non-null, add to an available-types list (with the label from the actual `BasePlugin::GetName()` if non-empty, else the default).
3. New handler `get-camera-types` returns the list to JS on Settings panel open.
4. Settings dropdown populates from that list. Default = first entry (always Standard).
5. Persisted setting stores the camera-type ID, not the label.
6. On scene load, if persisted ID is no longer available (e.g. user uninstalled Redshift), fall back to Standard and toast/log it.

### R2. Timeline-dialog focus state — RESOLVED (2026-05-27)

**Result: focus detection is trivial; pure JS-side gate.**

Spike instrumented both C++ `Message` (BFM_GOTFOCUS / BFM_LOSTFOCUS / BFM_ACTIVATE_WINDOW) and JS (`window.focus`, `window.blur`, `document.hasFocus()`). Ran 8-step repro: Shotblocks click ↔ OM click ↔ Attribute Manager click ↔ scrub while unfocused.

**Findings:**
- `BFM_GOTFOCUS` / `BFM_LOSTFOCUS` fire in lockstep with JS `window` focus / blur. Neither layer leads or lags. No missed events, no bursts.
- `document.hasFocus()` is reliable and canonical: `true` iff the user has clicked into the Shotblocks dialog and hasn't clicked into another C4D panel since.
- Once the user clicks into another C4D panel, `hasFocus` stays `false` across subsequent scrubs / interactions until they click back to Shotblocks. Exactly the gate we need.
- No flicker. No edge cases.

**Implementation:**
- Plan 4 commit 5's focus gate is one line: `if (document.hasFocus()) { send({ kind: 'select-in-om', objectId }) }`.
- No C++ dialog hook needed for focus. C++ side gets only the `select-in-om` handler that does `SetActiveObject + EventAdd`.
- Listen to `window.focus`/`window.blur` only if we need to react TO focus changes (we don't — we sample `hasFocus()` at the trigger moment).

### R3. Atomic undo for camera-create + clip-add — RESOLVED (2026-05-27)

**Result: two-undo-step approach (option A). One Cmd-Z reverts the clip; second Cmd-Z reverts the camera.**

Answered from SDK documentation alone — no live spike needed. Findings:

**1. Canonical SDK pattern for object creation** (`example.main/source/microsdk/user_interface.cpp:63-69`):
```cpp
doc->StartUndo();
doc->InsertObject(cube, nullptr, nullptr);
doc->AddUndo(UNDOTYPE::NEWOBJ, cube);
doc->EndUndo();
EventAdd();
```
Note: `AddUndo(NEWOBJ)` is called AFTER `InsertObject`, unlike other undo types (`c4d_basedocument.h:1107-1114` documents this exception).

**2. `SetActiveObject` participates in undo automatically.** Per `c4d_basedocument.h:1109`: *"In the case of the creation of a new object the call is done afterwards, after insertion into the document/object/track/sequence but before calling subsequent functions like SetActiveObject() **which creates another undo**."* Inside the same StartUndo/EndUndo block, this means OM selection state reverts atomically with the camera creation — exactly the behavior we want for "Cmd-Z undoes the Add Camera click."

**3. `SetSceneCamera` (viewport routing) does NOT need undo wrapping.** It's view state, not document state. After Cmd-Z reverts the camera object, the playhead-router will re-resolve naturally on the next tick.

**4. Atomic undo across camera-create + JS-side clip-add: NOT achievable cheaply.** The clip-add side flows through the existing `save-state` HTTP handler which has its own `AddUndo(CHANGE_SMALL, helper)` on the helper-BC clip JSON. Each `StartUndo`/`EndUndo` pair = one user-visible undo step. So: camera-create = one undo step, clip-add = a second undo step. Cmd-Z to undo a "click Add Camera" is two presses, not one.

The architectural alternative (move clip-add into C++ to share the same StartUndo block) breaks the current "JS owns clip data, C++ is a passthrough" model and isn't worth the complexity for v1.

**Implementation sequence for Plan 4 commit 2:**

```cpp
// Inside HandleCreateCamera (HTTP body has typeId + cameraIndex if any):
doc->StartUndo();
BaseObject* cam = BaseObject::Alloc(typeId);     // 5103 (Std) or 1057516 (RS)
// Copy pose + lens params from the editor camera:
BaseDraw* bd = doc->GetActiveBaseDraw();
CameraObject* editor = bd ? bd->GetEditorCamera() : nullptr;
if (editor) {
  cam->SetMl(editor->GetMl());
  // Copy lens params (focal length, film offset, sensor size, etc.)
  // via BaseContainer Get/SetData on documented camera params.
}
doc->InsertObject(cam, nullptr, nullptr);        // OM root, top
doc->AddUndo(UNDOTYPE::NEWOBJ, cam);
doc->SetActiveObject(cam, SELECTION_NEW);        // own undo entry, inside block — reverts atomically
doc->EndUndo();

// View state — no undo wrapping:
bd->SetParameter(DescID(BASEDRAW_DATA_CAMERA), GeData(cam, false), DESCFLAGS_SET::NONE);
// + the cache-invalidation recipe from memory c4d-setscenecamera-bypasses-cache-invalidation

EventAdd(EVENT::ANIMATIONFLAGS);

// Respond to JS with { ok: true, objectId, sourceName, sourceType }
// JS then calls existing addClip() which fires save-state → C++ save-state
// handler does its own StartUndo/AddUndo(CHANGE_SMALL, helper)/EndUndo on
// the clip JSON. Second undo step.
```

**Cmd-Z UX:**
- 1× Cmd-Z → clip disappears from timeline (helper BC clip JSON reverts)
- 2× Cmd-Z → camera disappears from OM, AM selection reverts, viewport returns to previous camera (router re-resolves on next tick now that the clip is gone)
- Cmd-Shift-Z does the reverse in two steps

If user feedback says "two undos feels wrong, want one" post-ship, the architectural change (clip-add atop the camera-create's StartUndo block via a new combined handler) is a separate ticket. Not in v1.

### R4. Chip visual design — RESOLVED (2026-05-27)

**Result: minimal flat pill in the existing track header, two-token swap on activation.**

Mike provided Figma frames:
- Inactive chip — node `478:3133` (full row node `357:1045`)
- Active chip — node `478:3144` (full row node `478:3140`)

**Chip spec:**
- 36×63, 4px radius, no border / shadow / glow
- Inactive: `bg: var(--color-grey-16)` (`#292929`), `text: var(--color-grey-24)` (`#3d3d3d`) — sits nearly invisible against the row's grey-12 background; reads as a faint plate
- Active: `bg: var(--color-timeline-primary-highlight)` (`#007aff` Maxon blue), `text: white`
- Text: Inter Semi-Bold 10px, -0.1px letter-spacing, centered both axes
- Content: track ID short form — `V1`, `V2`, `A1`, `A2`, …
- **Only two CSS tokens swap on activation** (background-color + color). No size, radius, border, shadow, or position change.

**Placement (per the captured row design):**
- Inside `.track-header__row`, between the lock button (left) and the eye/MS controls (right).
- Current `TrackHeader.tsx` already has the lock + eye/MS + label layout; chip is a new element inserted as the lock's right-sibling.

**Default state — implicit V1/A1 active:**
- V1 and A1 always render as ACTIVE on first scene load.
- There is no "no chip selected" empty state. Inactive means "this track isn't the current target," not "nothing is targeted."
- Effect: as soon as the user opens a scene with at least one V track and one A track, exactly one V chip and one A chip are blue.

**Click behavior:**
- Click an inactive chip → it becomes active for its side; the previously-active chip on that side becomes inactive.
- Click the already-active chip → no-op (exactly one chip is always active per side; nowhere for the state to go).
- Hover state: not specified in the Figma — recommend a subtle background brightening (`grey-16` → `grey-24` for inactive chips on hover) to give a click affordance. Locked in at implementation if Mike doesn't object.

**Surrounding row context (informational, no changes needed):**
- Row container: `bg: grey-12`, `border: 0.5px grey-16`, 4px radius, 8px horizontal padding, height 65px.
- Items left-to-right inside the row: lock icon (19×20) — **chip (36×63)** — eye (28×30) — label "Video N" / "Audio N" right-aligned, Inter 400 12px in grey-50.
- All matches the existing `TrackHeader.tsx` except for the chip insertion.

**SVG assets:** none needed for the chip. It's a flat colored rect with text. (The lock/eye SVGs in the row are unchanged.)

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
- Cmd-Z reverts in two steps (per R3): 1× Cmd-Z removes the clip; 2× Cmd-Z removes the camera + reverts OM selection + viewport returns to previous camera. Cmd-Shift-Z re-does in two steps.
- Repeated clicks create "Camera", "Camera.1", "Camera.2" (C4D's name-uniquifier handles this for free).
- Settings dropdown set to "RS Camera" (id 1057516) → new camera is a Redshift camera (verified in OM as RS-icon). Dropdown only shows "RS Camera" when Redshift is loaded.
- Save scene → reopen → if previously-selected camera type is no longer available (e.g. Redshift uninstalled), Settings falls back to Standard with a toast/log.

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
