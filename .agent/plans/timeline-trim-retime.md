# Plan: clip trim + Alt-retime (keyframes follow clip edits)

Status: **designed, not started.** Follow-up to the shipped "keyframes travel
with a clip on a MOVE" feature (commit `9ba7d3b`). This covers EDGE drags.

## What's already shipped (the move half)

Commit `9ba7d3b feat(timeline): camera keyframes travel with their clip on a move`
(local on `main`, **NOT pushed** as of handoff). Dragging a clip body shifts
the referenced camera's keyframes (object + all tag tracks) by the same frame
delta. Read that commit first — the trim/retime work reuses its plumbing:

- **JS** `useClipDrag.ts`: `keyframeShiftBaseline` ref snapshots each moving
  clip's pre-drag `inFrame` at pointer-down; `endDrag` diffs against the final
  store position and calls `flushKeyframeShifts([{objectId, deltaFrames, refCount}])`.
- **JS** `usePersistence.ts`: `flushKeyframeShifts` queues shifts into
  `pendingKeyframeShifts`, **cancels the debounced save** (`cancelPendingSave`)
  and fires `saveToHost()` immediately. The shifts ride in the `save-state`
  payload as `keyframeShifts`. (Module-scoped `saveTimer` + `scheduleSave` were
  added so the cancel works — don't reintroduce a local debounce timer.)
- **C++** `main.cpp`: `HandleSaveState` calls `ApplyKeyframeShiftsFromBody(doc, body)`
  INSIDE its `StartUndo/EndUndo` block → one Ctrl+Z undoes move + shift.
  `ApplyKeyframeShift(doc, objectId, deltaFrames, refCount)` does the work:
  no own undo block (caller owns it), `AddUndo(CHANGE)` per cam + tag, offsets
  keys via `CKey::SetTime`, iterates safe direction (reverse for +delta), and
  **skips when refCount > 1** (shared-camera guard — a camera can be in two
  non-overlapping shots; shifting would corrupt the other clip).
- **host.ts**: `save-state` outbound type carries optional `keyframeShifts`.

Key C4D facts learned: sourceprocessor enforces a **600-line function cap**
(Dispatch was at the edge — keep new handlers as separate `Handle*` methods).
String concat in GePrint needs **`maxon::String::IntToString`** (fully
qualified) + `_s`-suffixed literals or you get C2666 ambiguity. C++ change
needs `cmake --build C:\Dev\c4d_sdk_2026\build-win64 --config Release --target shotblocks`
BEFORE `dev-loop.ps1` (dev-loop does NOT build C++).

## The design (decided with the user)

Two different intents share the edge-drag gesture; disambiguate by modifier:

1. **Default edge-drag = window-only TRIM.** Changes which frames of the
   camera's EXISTING animation the clip shows. **Keyframes do NOT move or
   rescale.** Clip `inFrame`/`outFrame` change; the animation is a fixed thing
   the clip is a window onto. Pure NLE trim (Premiere/Resolve/AE). This is
   likely already the current behavior of `resizeClip` — verify it leaves keys
   untouched (it should; it only edits clip in/out).

2. **Alt-held edge-drag = RETIME (rescale).** Holding **Alt** while dragging an
   edge stretches/squashes the camera keyframes so the same motion fills the
   clip's new duration.
   - Math: clip duration `D_old -> D_new`. Rescale keys around the **anchor
     edge** (the edge that did NOT move): out-edge drag anchors the in-point;
     in-edge drag anchors the out-point. Each key at offset `t` from the anchor
     (in frames) maps to `t * (D_new / D_old)`. Apply to cam + all tag tracks.
   - Shared-camera guard applies (skip if refCount > 1).
   - Folds into the same save-state undo block (extend the `keyframeShifts`
     payload, or add a parallel `keyframeRetimes` array — see below).

3. **Cursor feedback:** while Alt is held over an edge, swap to a distinct
   retime/rate-stretch cursor via the existing CSS+C++ two-layer recipe
   (`set-cursor-mode` in host.ts — currently has slip/razor/pen/roll/etc.; ADD
   a `'retime'` mode + a `.cur` asset). See `useToolCursor.ts` /
   `feedback_tool_cursor_pattern` memory.

## Implementation steps (suggested)

1. **Verify defaults & wiring first (measure, don't assume):**
   - Confirm `resizeClip` (store.ts:472) leaves camera keyframes untouched
     today (default trim should already be window-only).
   - Confirm **Alt + LEFT-button edge-drag is free** — `Alt+RMB` is viewport
     zoom (`useAltRightZoom.ts`), but that's right button. Confirm the trim
     path (left button) sees `ev.altKey` cleanly and doesn't trip zoom.
   - Find where the edge-drag/trim gesture starts (ShotBlock.tsx edge press →
     useClipDrag or a sibling). The seam between two clips is split into
     trim-left / roll / trim-right thirds — decide whether retime applies only
     to OUTER edges or also composes with roll. Recommend: outer edges only for
     v1; leave roll as-is.

2. **C++ retime handler:** add `ApplyKeyframeRetime(doc, objectId, anchorFrame,
   scale, refCount)` next to `ApplyKeyframeShift` (no own undo block). For each
   key: `newTime = anchorFrame + (oldFrame - anchorFrame) * scale`. Same
   safe-iteration + shared guard + AddUndo(cam/tag) pattern. Parse a
   `keyframeRetimes` array in `HandleSaveState` (alongside `keyframeShifts`),
   apply inside the same undo block. Keep methods separate to respect the
   600-line Dispatch cap.

3. **JS:** in the edge-drag commit, if Alt was held, compute `anchorFrame`
   (the non-moving edge, in DOCUMENT frames) + `scale = D_new/D_old` and queue
   it (new `flushKeyframeRetimes` mirroring `flushKeyframeShifts`, same
   immediate-save + cancel-debounce trick). If Alt was NOT held, do nothing to
   keys (default trim).

4. **Cursor:** add `'retime'` to the `set-cursor-mode` union + a cursor asset;
   show it while Alt is held over an edge.

5. **Verify:** trim (no Alt) leaves keys put; Alt-trim rescales them to fill
   the new duration; one Ctrl+Z undoes edit + key change; shared camera is
   skipped; tags rescale too.

## Open questions to resolve while building

- Does retime rescale ONLY the keys whose frames fall within the clip window,
  or ALL the camera's keys? (Move shifted ALL — one-camera-per-clip model.
  Retime probably also all, anchored at the clip's non-moving edge. Confirm
  with the user if it feels wrong on a camera whose anim extends past the clip.)
- Sub-frame keys after rescale: `CKey::SetTime(BaseTime)` supports fractional
  time, but C4D may snap. Decide whether to round to whole frames.

## Don't repeat

- A chase first-frame fix (look-ahead seed + Set Start Position button) was
  built and REVERTED earlier — unrelated to this, but see
  `project_rig_damping_toggle_and_live_aim` note. Not part of this plan.
