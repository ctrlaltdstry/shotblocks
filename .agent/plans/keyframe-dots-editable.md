# Plan: selectable / editable keyframe dots

Status: **SHIPPED** (commits `57aa0eb` selection, `4a43e54` delete+shift).
Built as planned: select → delete → drag-shift, reusing the move/retime
plumbing; dots are deduped COLUMNS (column-granular edits). Notes: the
drag-release needed the same echo-hold as the clip-move (hold the dot at
its new position until the shifted-keys `cameras` echo lands, else it
flickers back); video clips can no longer share a camera (split is
audio-only), so the refCount guard never fires but stays as insurance;
dots keep the default cursor (no custom cursor, per user). Single-select
only — multi-select / marquee deferred, never requested.

## Marquee multi-select — SHIPPED

Built: multi-select via click / Shift-click / Alt-drag marquee; delete +
drag operate on the whole set. Selection model is `selectedKeyColumns:
Set<"objectId:frame">` (was a single column). **Modifier split that landed
(differs from the first attempt below):** Alt+edge-drag competed with the
old Alt-retime, so RETIME moved to **Alt+Ctrl+edge-drag**, and **plain Alt
is the marquee** (Alt+drag over a video clip body). `useClipDrag` bails on
Alt+video so the press reaches `useMarquee`; trim's Ctrl-ripple is
suppressed during a retime so Alt+Ctrl doesn't double-fire. Added a
mirrored `ctrlHeld` store flag (like `altHeld`) for the retime cursor's
hover check. Group-drag is per-camera (the grabbed clip's selected
columns); cross-clip simultaneous drag not done (rarely the intent).

Original marquee plan below (trigger differs — see above).

**Decisions made with the user:**
- **Scope:** cross-clip — the marquee selects every dot the box touches
  across ALL clips/cameras, not just one clip (like the clip marquee).
- **Trigger:** **Alt + left-drag over a video clip body** rubber-bands a
  keyframe marquee. Verified free: `useClipDrag` ignores altKey (clip-move
  unaffected — plain drag still moves the clip), the pen Alt-invite is
  audio-only (`.shot-block.is-audio`), and retime Alt is on clip EDGES not
  the body. So plain drag = move clip; Alt+drag = marquee keyframes. No
  lost grab area.

**Build:**
- **Selection model:** replace single `selectedKeyColumn {objectId,
  frame}` with `selectedKeyColumns` — a Set of `objectId:frame` keys (or
  `{objectId, frame}[]`). Keep single-click selection working (selects
  one; Shift-click adds). Update KeyframeTicks' `selectedFrame` check, the
  Esc / click-away / keys-changed clears, and the `is-selected` render.
- **Marquee gesture:** mirror `LevelCurve.tsx` (pending → marquee-drag,
  `baseSet` for additive Shift, rubber-band rect). But the rect is in
  TIMELINE space (spans clips), not one clip's SVG — hit-test every
  rendered dot's screen rect against the box. A timeline-level overlay
  (like `MarqueeOverlay`/`useMarquee` for clips) is the right host, gated
  to fire only on Alt+drag started over a video clip body.
- **Multi delete:** Delete with N columns selected → `flushKeyframeDeletes`
  already takes an array; pass one entry per selected column. C++ loops.
- **Multi drag:** dragging any selected dot moves the WHOLE set by the same
  frame delta (group drag). `flushKeyframeColumnShifts` takes an array;
  send one entry per column with the shared delta. The echo-hold +
  re-anchor logic must handle N held dots (extend `pendingShift` to a
  list, or hold by a shared px offset keyed by the moved frames).
- **Reuse:** the column delete/shift C++ + JS flush plumbing is already
  array-shaped — multi-select is mostly a JS selection-model + gesture
  change, little/no new C++.

**Open Qs:** group-drag clamp when columns span clips with different
windows (clamp each to its own clip? or block the drag if any would leave
its clip?). Recommend: clamp each column to its own clip independently.

---

Original plan below (for reference).

---

Status: **designed, not started.** Follow-up to the read-only keyframe
dots (commit `20adcb2`) and the keyframe move/retime plumbing
(`9ba7d3b`, `fc963ff`). This makes the dots interactive: click to select,
Delete to remove, drag to shift — all editing the camera's *real*
keyframes in C4D and round-tripping back to the dots.

## What exists today (read these first)

- **Read-only dots:** `web/src/components/KeyframeTicks.tsx` renders one
  dot per DOCUMENT frame where the clip's camera (or any tag) has a key.
  A child of `ShotBlock`. Frames come from `cameraKeyTimes`
  (`Map<objectId, number[]>`) in the store, pushed by C++ `PostCameras`.
- **The dot is a COLUMN, not a key.** C++ `GatherKeyTimes`
  (`main.cpp`) dedupes every track's keys at the same frame into one
  entry (6 params keyed at f30 → one dot). So a dot represents *all*
  keys at that frame across the camera + all its tags.
- **Refresh:** `PostCameras` on `EVMSG_CHANGE` + a `KeyframeSignature`
  poll on the dialog Timer (catches edits made while backgrounded / before
  C4D's tracks settle). Any edit we make must let this re-push pick it up.
- **The write template (REUSE THIS):** move/retime already do JS→C++
  keyframe edits inside the save-state undo block:
  - JS queues an op + fires an immediate save (cancel-debounce):
    `flushKeyframeShifts` / `flushKeyframeRetimes` in `usePersistence.ts`.
  - Rides `save-state` as a payload array (`keyframeShifts` /
    `keyframeRetimes`), typed in `lib/host.ts`.
  - C++ applies it INSIDE `HandleSaveState`'s `StartUndo/EndUndo` so one
    Ctrl+Z undoes the edit: `ApplyKeyframeShift` / `ApplyKeyframeRetime`
    (no own undo block; `AddUndo(CHANGE)` per cam+tag; **shared-camera
    guard: skip if refCount>1**).
  - 600-line Dispatch cap: new C++ handlers go in separate `Handle*` /
    `Apply*` methods, parsed from the body like the existing arrays.

## Semantics (decide with the user before/while building)

1. **A dot edit is a COLUMN operation.** Deleting a dot deletes *every*
   track's key at that frame (cam object tracks + every tag track).
   Shifting a dot shifts every key at that frame by the same delta. This
   is coherent ("operate on this keyframe column") and matches how the
   dot is computed. Confirm the user wants column granularity (the dot
   can't address a single param — that's what the dope sheet is for).
2. **Selection model.** Click a dot = select that column (one clip's
   camera). Decisions: multi-select (shift/marquee) or single only for
   v1? Does selecting a dot also select the clip, or are they independent
   selections? Recommend: dot-selection is its OWN lightweight state
   (`selectedKeyColumns`?), single-select for v1, independent of clip
   selection (clicking a dot doesn't reshuffle clip selection).
3. **Shift granularity.** Dragging a dot shifts the whole column. Snap to
   frames (integer) — reuse the trim/scrub snap feel. Clamp so a shifted
   column can't cross another column (or allow it and re-dedupe? recommend
   clamp for v1). One drag = one undo.
4. **Shared camera (refCount>1).** Same guard as move/retime: a camera in
   two clips can't have its keys edited from a dot (would corrupt the
   other clip). Either skip silently with a log, or grey-out / no-hit the
   dots on shared-camera clips. Recommend: make those dots non-interactive
   + a tooltip ("shared camera — edit in the dope sheet").
5. **Round-trip.** After the edit, C++ re-pushes cameras (the signature
   poll already does this) so the dots reflect the new state. Verify no
   double-update / flicker.

## Implementation steps (suggested)

1. **Hit-testing + selection (JS only, no C++):** make `.keyframe-dot`
   hit-testable (it's `pointer-events:none` today — flip on, but guard so
   it doesn't steal clip-body drags; dots are a thin bottom strip so the
   zone is small). Add `selectedKeyColumns` (or single `selectedKeyColumn:
   {objectId, frame} | null`) to the ui slice. Click selects; render a
   selected dot state (brighter / ring). Esc / click-away clears. NO edit
   yet — ship + verify selection feel first.
2. **Delete (JS→C++):** Delete/Backspace with a dot selected →
   `flushKeyframeDeletes([{objectId, frame, refCount}])` (mirror
   `flushKeyframeShifts`). Payload `keyframeDeletes` on save-state. C++
   `ApplyKeyframeDelete(doc, objectId, frame, refCount)`: walk cam + tag
   tracks, remove the key whose `GetTime().GetFrame(fps) == frame` from
   each curve (`CCurve::DelKey` by index), inside the save-state undo
   block, shared guard, `AddUndo` per cam+tag. The signature poll
   re-pushes the dots. Verify one Ctrl+Z restores the column + the dope
   sheet agrees.
3. **Shift (JS→C++):** drag a selected dot horizontally → frame delta →
   `flushKeyframeColumnShift([{objectId, frame, deltaFrames, refCount}])`.
   This is NARROWER than the existing `ApplyKeyframeShift` (which shifts
   ALL keys): here only the keys AT `frame` move. New
   `ApplyKeyframeColumnShift(doc, objectId, frame, deltaFrames, refCount)`
   — for each track, find the key at `frame`, `SetTime` it by the delta
   (safe-iteration direction like the existing shift). Clamp/guard against
   landing on another column. Live preview during the drag (optional;
   reuse the retime-preview `retimingClipId`-style flag if wanted).
4. **Cursor / affordance:** a hover cursor over a dot (the move/grab
   cursor) via the `useToolCursor` + C++ `.cur` recipe, OR keep it simple
   (no custom cursor for v1 — selection ring is enough).

## Reuse map (don't reinvent)

- Immediate-save + cancel-debounce: `flushKeyframeShifts` pattern,
  `usePersistence.ts`.
- In-block undo + shared guard + safe key iteration: `ApplyKeyframeShift`
  / `ApplyKeyframeRetime`, `main.cpp`.
- Dot→frame mapping + edge containment: `KeyframeTicks.tsx`.
- Round-trip refresh: `KeyframeSignature` Timer poll + `PostCameras`.
- Selection-handoff / no-snap-back pattern (if live preview): the retime
  `retimingClipId` + cameras-echo clear in `setCameraStatuses`.

## Open questions

- Multi-select + marquee, or single-select for v1? (Recommend single.)
- Does deleting a column that's a clip's in/out boundary key need special
  handling (the boundary dot is edge-anchored)? Probably not — it's just
  a key like any other.
- Should dot editing be gated behind a mode/tool (like the pen tool for
  audio), or always-on when the Select tool is active? (Recommend
  always-on under Select, since the dots are small + read-only-looking;
  but watch for stealing clip clicks.)

## Don't repeat

- The dots are deduped COLUMNS — there is no single-key addressing from
  the timeline. If the user wants per-param key editing, that's the dope
  sheet's job; don't try to surface 6 overlapping dots.
- C++ keyframe edits MUST ride the save-state undo block (not their own),
  or the clip edit + key edit become two undo steps. See the move commit.
