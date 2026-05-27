# Bugs to visit later

Known issues found during development that aren't blocking the current
plan. Each entry is a self-contained brief — symptoms, reproduction,
what we know, and what we've ruled out. Add new entries at the top.

When picking one up, copy the entry into a plan or task doc; don't
fix-in-place against this list (it should stay a queue of unstarted
work).

---

## clip minimum size scales with timeline length (small-clip handles break)

**Symptoms.** With a long timeline (e.g. 2000 frames), a clip can
be shrunk down to a very small pixel width — so small that the edge
hit zones (trim-left / roll / trim-right thirds) overlap and stop
working correctly. With a short timeline the same physical pixel
floor is enforced by the natural frame-to-pixel ratio.

**Root cause (suspected).** Clip width is computed in *frames* then
converted to pixels via `pxPerFrame = visibleWidth / (vMax - vMin)`.
The current minimum is enforced in frames (probably 1), so at high
zoom-out 1 frame = a few pixels and the hit zones collide.

**Fix direction.** Enforce the minimum in *pixels* (the hit zone
geometry is pixel-defined). Memory `mine-python-for-constants` says
`EDGE_HIT_PX = 24` in v1; the three modes need ~72px minimum to all
be reachable. Or convert per-zone widths to fraction-of-clip so all
three are always reachable proportionally.

---

## new-track spawn ghost: needs a different visual treatment

**Status.** Design tweak. The spawn-ghost dashed outline now sits
correctly above V<max> (position fix shipped 2026-05-26), but Mike
still wants a different visual style for it. Specifics TBD; fetch
Figma when ready to implement.

**Files.** `host/shotblocks/web/src/components/SpawnGhostLane.tsx`
+ its CSS in `App.css` (search `.spawn-ghost-lane`).

---

## inspector help button: launch user manual on click

**Status.** Feature add, blocks Plan 3. A `?` glyph button needs
to land in the inspector header area. On click it launches the
user manual document (which Plan 3 will produce). Launch mechanism
TBD — system browser? HtmlViewer dialog? Coordinate with the
manual format decision.

**Files.** Inspector component; new IPC command if launching from
C++ via shell.

---

## new razor + slip icons + razor highlight tweak

**Status.** Asset swap + small CSS tweak. Mike has new SVGs for
both the razor and slip tool. The razor's hover/active highlight
also needs adjustment (specifics TBD; fetch the Figma node when
ready).

**Files.** Tool palette icon SVGs in `host/shotblocks/web/src/
icons/`; tool palette state CSS for the highlight states.

---

## ~~.c4d file size bloat from helper persistence~~ FIXED 2026-05-26

**RESOLUTION.** Root cause: `audio-add` and `audio-remove` wrapped
their helper-BC writes in `StartUndo / AddUndo(CHANGE_SMALL, helper) /
EndUndo`. `AddUndo(CHANGE_SMALL, helper)` snapshots the ENTIRE helper
BC including any already-stored audio bytes. The undo stack is
persisted with the doc, so even after deleting the audio clip (which
correctly removes bytes from the live BC), the undo snapshot retained
them — permanently. A 30MB audio clip survived as ~80MB of UTF-16
base64 in the .c4d file.

**Fix:** Don't wrap audio-add / audio-remove in undo. Audio binaries
are media, not undoable user state. The clip metadata (size, position,
mediaId reference) IS still undoable via save-state's own AddUndo on
the clip JSON. See `host/shotblocks/source/main.cpp` audio-add (~1530)
and audio-remove (~1594) for the working pattern.

**To compact an existing bloated scene:** open + close the bloated
clip in C4D (drop audio, then delete it again, then save) — once the
remove path runs without re-snapshotting, the bytes drop. There's
also a `helper-compact` command kept in the code as a future debug
tool (calls `doc->FlushUndoBuffer()`), reachable via CDP eval
`window.__SHOTBLOCKS_SEND__({ kind: 'helper-compact' })`.

**Verified 2026-05-26:** 272KB → 85MB on audio drop (bug) → 272KB
after delete + reopen + save (new behavior).

---

## ~~scrub direction reversal misses camera switch (backward-scrub bug)~~ FIXED 2026-05-26

**RESOLUTION.** Root cause: `bd->SetSceneCamera(cam)` bypasses
`MSG_DESCRIPTION_POSTSETPARAMETER`, which is the message the BaseDraw's
draw-side scene snapshot listens to for cache invalidation. The Object
Manager updates because the camera-link write itself succeeds, but the
viewport renders from a stale evaluation cache that's never invalidated.
Forward scrub works because the cache is naturally evicted by forward
time advance.

**Fix:** route the camera change through the description framework
(the same path the Take System uses internally on take-camera swaps),
combined with explicit cache-dirty + ExecutePasses + synchronous
DrawViews + animation-flagged EventAdd. See
[host/shotblocks/source/main.cpp](../host/shotblocks/source/main.cpp)
set-active-camera handler, ~line 1238, for the working pattern, and
the Claude-only memory `feedback_c4d_setscenecamera_bypasses_cache_invalidation`
for the full recipe.

Six failed-fix attempts and the full historical investigation kept
below for the file's "lessons learned" value.

---

**Symptoms (originally filed; preserved for record).** Direction-gated
and 100% reproducible. Exact repro:

1. Click + drag the playhead forward across clip boundaries — viewport
   updates correctly to each new camera.
2. Without releasing, scrub backward — viewport does NOT update; it
   keeps showing the last-forward camera, even though `set-active-
   camera` is called with the correct objectId for each backward frame.
3. Release the mouse — viewport still does not update.
4. Click again, scrub backward (or scrub-in-place) — viewport still
   does not update.
5. Click again, scrub FORWARD — viewport finally catches up to the
   new camera.

So: **C4D's viewport only honors `SetSceneCamera` calls that are
accompanied by a forward time advance.** Backward scrub leaves the
viewport reading from a per-frame cache populated during the forward
pass, with no documented way to invalidate it.

**What we measured (2026-05-26 diag pass).**
Added temporary `GePrint` logging inside the C++ `set-active-camera`
handler — log every call's `objectId`, `prevCam ptr`, `cam ptr`,
`lastOid`, and whether `prevCam == cam` (dedupe match). Sample log:

```
oid=58 prevCam=08CC0 cam=068C0 lastOid=0  match=0  ← branch FIRES
oid=0  prevCam=068C0 cam=0     lastOid=58 match=0  ← branch FIRES
oid=58 prevCam=08CC0 cam=068C0 lastOid=0  match=0  ← branch FIRES (reverse)
```

Every backward-reverse line shows `match=0` (branch fires correctly),
`SetSceneCamera` runs with the right `cam` pointer, `DrawViews(FORCEFULL
REDRAW)` runs, `EventAdd()` runs. The C++ side is doing every documented
thing right. Viewport still does not repaint until the user scrubs
forward.

**Fixes ATTEMPTED and confirmed not working (2026-05-26).**

1. **Drop the C++ dedupe (`prevCam != cam`).** Not applicable — diag
   shows `match=0` on every failing line, so the dedupe never fires
   falsely. The original bugs.md hypothesis was wrong.

2. **Debounce `objectId=0` (gap) sends in JS** by ~80ms via setTimeout,
   theory being "flash-through-gap releases the camera and C4D
   throttles redraws during interactive scrub." Regressed the forward-
   scrub-into-gap case: viewport kept rendering the previous camera
   after the playhead had clearly left the clip. Reverted.

3. **Maxon staff-endorsed combo** (researched on developers.maxon.net
   forum threads from `i_mazlov`): `DrawViews(NO_THREAD |
   FORCEFULLREDRAW)` + `GeSyncMessage(EVMSG_CHANGE)`. This is the
   strongest documented "interactive scene state changed, paint right
   now" combo Maxon publishes. No effect — backward scrub still
   doesn't repaint.

**What we did NOT measure yet.**
- After `SetSceneCamera(cam)` runs, what does `bd->GetSceneCamera(doc)`
  return ON THE NEXT TICK? Does C4D actually persist our write, or is
  EVMSG_TIMECHANGED rolling it back between our calls? The diag's
  `prevCam` is read at the START of each new call, but we never logged
  a read-back IMMEDIATELY after our write within the same call.
- Does calling `bd->Message(MSG_CHANGE)` or any other BaseDraw-level
  message change behavior? Not documented as a cache-invalidate primitive.

**Best current theory** (unproven): C4D's viewport draw pipeline caches
per-frame evaluation results during forward animation playback. When
the user scrubs backward across already-visited frames, C4D serves the
cached pixels rather than re-evaluating the scene at the new (frame,
camera) tuple. The cache key may not include the active scene camera,
so changing `SetSceneCamera` mid-backward-scrub doesn't invalidate the
cache. There is no documented BaseDraw cache-invalidation API.

**Research summary.** A focused investigation searched Maxon's
2026.2.0 docs, the C++ + Python SDK manuals, Maxon-Computer's GitHub
SDK examples, and the developers.maxon.net forum. No prior public
report of this exact symptom (backward scrub doesn't honor
`SetSceneCamera`, forward does). `EVENT::FORCEREDRAW` is officially
"Currently not used." There is no documented `BaseDraw::Invalidate` or
similar cache-flush API. Maxon's only-active-view + no-thread +
staticbreak combo is for general "paint right now" but doesn't address
direction-dependent caching.

**Possible fix directions** (still untested):
- After our `SetSceneCamera`, log `bd->GetSceneCamera(doc)` immediately
  to confirm whether C4D actually committed the write.
- Call `doc->ExecutePasses` directly with `BUILDFLAGS::EXTERNALRENDERER`
  or specific `ANIMATEFLAGS` to force animation re-evaluation at the
  current frame.
- Try `bd->SetEditCamera` / re-asserting some BaseDraw state.
- Forward the question to Maxon SDK support since the symptom is novel
  to public documentation. May be a known C4D viewport-cache bug.

**Workaround (none currently).** Users must release the mouse and
re-scrub forward to land on the correct camera. Predates orphan-
handling commits; likely present since v2-owned scrub shipped.

**Predates** the orphan-handling commits (1323fa6 → 7724ab4). Likely
present since v2-owned scrub shipped.

**Not blocking v1.** Documented, contained, has a clear workaround
(scrub forward to commit). Revisit after Plan 3 (user manual) ships,
ideally with a Maxon SDK support ticket.

**Update (Codex pass, 2026-05-26).**
- Added same-tick readbacks around camera writes in C++:
  `before set`, `after set`, `after draw` with millisecond timestamps.
- User repro log shows `SetSceneCamera` commits immediately on every
  failing reverse-scrub call, and remains committed after `DrawViews`.
  Example pattern repeats for all `oid` transitions:
  `before set ... target=<camX>` ->
  `after set ... readback=<camX>` ->
  `after draw ... readback=<camX>`.
- For `oid=0`, readback consistently becomes the editor camera pointer
  (expected fallback). For non-zero objectIds, readback consistently
  becomes that clip camera pointer.
- Conclusion: **H1 ("C4D rolls back SetSceneCamera within the same
  tick") is falsified** by measurement. The write sticks in C++ while
  the viewport still displays the wrong view during reverse scrub.
- Next single hypothesis attempt in progress: force scene evaluation via
  `doc->ExecutePasses(nullptr, true, true, true, BUILDFLAGS::INTERNALRENDERER | BUILDFLAGS::INTERACTIVEEDITOR)`
  after `SetSceneCamera`, then retest the same repro.

**Update (Codex pass, 2026-05-26, follow-up).**
- User ran the same repro with `after pass` instrumentation enabled.
- Result: camera readback is still always correct after `SetSceneCamera`,
  after `ExecutePasses`, and after `DrawViews`, while the viewport bug
  still reproduces during reverse scrub.
- `ExecutePasses` therefore did not provide a behavioral fix in this
  path (H2 workaround attempt failed).
- Next single attempt: replace `ExecutePasses` with a BaseDraw-level
  `bd->Message(MSG_UPDATE)` after `SetSceneCamera`, keep the same
  readback diagnostics, and retest.

**Update (Codex pass, 2026-05-26, MSG_UPDATE result).**
- User ran the same repro with `bd->Message(MSG_UPDATE)` instrumentation
  (`after upd ... ok=1`) between `SetSceneCamera` and `DrawViews`.
- Result: `MSG_UPDATE` always returns success, camera readbacks are still
  correct after set/update/draw, and the reverse-scrub viewport bug
  still reproduces.
- Conclusion: this H3 attempt did not fix behavior.
- Per debug rules, behavior changes were reverted before the next step.
- Next step is pure instrumentation (no new fix attempt): add `seekdiag`
  lines and enrich `camdiag before set` with current doc frame,
  last-seek frame, seek direction, and seek-age milliseconds to test
  whether message ordering/timing explains the direction-gated viewport
  stick.

**Update (Codex pass, 2026-05-26, seek/camera ordering instrumentation).**
- Added `seekdiag` for each seek dispatch:
  `rel`, `abs`, `prevAbs`, `dir`, and timestamp.
- Added enriched `camdiag before set` fields:
  `docAbs`, `lastSeekAbs`, `lastSeekDir`, `seekAgeMs`.
- User repro capture shows:
  - forward scrub: `seekdiag dir=1`, then camera switches with
    `lastSeekDir=1`.
  - reverse scrub: `seekdiag dir=-1`, then camera switches with
    `lastSeekDir=-1`.
  - camera-switch calls land within ~3-10ms of most recent seek
    (`seekAgeMs` around single-digit ms).
  - camera switches happen at expected boundaries in both directions
    (e.g., `oid=58` near abs~496 on forward and `oid=0`/`oid=56`
    near abs~494/356 on reverse).
- Conclusion: this data does **not** support a JS->C++ queue-order or
  stale-frame race. Dispatch order/direction is coherent.
- Combined with earlier readback evidence (SetSceneCamera sticks), this
  strongly points to a viewport-side cache/draw pipeline issue during
  reverse interactive scrub (likely outside SDK-level invalidation
  control).

**Update (Codex pass, 2026-05-26, workaround hack trial).**
- Implemented a targeted workaround in `set-active-camera`:
  when a camera switch occurs shortly after a backward seek (`lastSeekDir < 0`
  and recent seek age), pulse document time by one frame and
  immediately restore (`t±1 -> t`) before redraw.
- Removed temporary seek/camera diagnostic logging for cleaner behavior
  testing and to keep `Dispatch` under the 600-line source-processor cap.
- Build + deploy completed; awaiting user repro confirmation.

**Update (Codex pass, 2026-05-26, workaround result).**
- User confirmed workaround did not fix behavior: Object Manager camera
  selection/state updates correctly, but the viewport still does not
  refresh on reverse scrub.
- This further supports viewport draw/cache behavior as the failing
  subsystem, not camera routing.
- Per debugging rule, the workaround hack was reverted in C++ (baseline
  `SetSceneCamera` + `DrawViews(FORCEFULLREDRAW)` + `EventAdd()` path).
- Formal return handoff for Claude is in
  `HANDOFF-CLAUDE-SCRUB-BUG-2026-05-26.md`.

**Update (Claude second pass, 2026-05-26, post-Codex).**
- User insight: this bug did NOT exist in the Python v1 implementation
  of the timeline. So whatever v1 did differently is the answer.
- Inspected Python v1's `_route_camera_for_frame` at
  `git show c8113d0~1:src/sb_canvas_playback.py` (the commit
  immediately before the strip-down). Two differences from v2:
  1. **Order:** v1 explicitly set the camera BEFORE `SetTime` in
     `_playback_tick`, with a leading comment warning:
     *"Order matters: set camera FIRST, then time. If we set time
     before camera, C4D can render the next frame with the new time
     but the previous camera (the redraw races our camera write).
     Setting camera first guarantees the very next render reflects
     both changes together."*
  2. **API:** v1 used `bd[c4d.BASEDRAW_DATA_CAMERA] = cam` (the
     BaseContainer-link parameter write), not `bd.SetSceneCamera`.
- **Fix attempt 5 (combined seek+camera, camera-before-time):**
  Extended the `seek` HTTP message to accept an optional `objectId`;
  C++ applies `SetSceneCamera` before `doc->SetTime` in one handler
  call. Effect: **no change** — backward scrub still doesn't update
  viewport. Reverted. This rules out the time/camera race as the
  cause in v2.
- **Fix attempt 6 (BaseContainer-link write via SetLink):**
  Replaced `bd->SetSceneCamera(cam)` with
  `bd->GetDataInstance()->SetLink(BASEDRAW_DATA_CAMERA, cam)`.
  Effect: **worse** — the viewport NEVER updates, not even forward.
  The first-loaded camera holds permanently. The Object Manager
  doesn't show the link change either. Reverted.
- Conclusion from fix 6: `bd->GetDataInstance()->SetLink(BASEDRAW_DATA_CAMERA, ...)`
  is effectively a no-op in C4D 2026's C++ SDK. Python's
  `bd[c4d.BASEDRAW_DATA_CAMERA] = cam` operator must internally
  route through `SetSceneCamera` (Python syntactic sugar that
  doesn't map cleanly to a direct BaseContainer write in C++). So
  v1 and v2 were calling functionally the same API; difference (1)
  above (the ordering) is the only real one.
- **Why v1 worked despite using the same API as v2:** because v1
  ran the camera-write and SetTime in the SAME main-thread function
  call (`_playback_tick`), they always landed in a single
  EVMSG_TIMECHANGED batch. V2 splits them into two HTTP messages
  that drain independently, so even when we put them in the same
  C++ handler (fix attempt 5), there are still OTHER `set-active-
  camera` messages arriving outside any `seek` (e.g. when the active
  clip changes due to a clip edit, or when orphan state changes).
  However, attempt 5 should have still fixed THE SCRUB case
  specifically — and it didn't. So even atomic camera-then-time
  doesn't repair the reverse-scrub viewport miss.
- **What's now strongly evidenced:**
  - C4D's camera state DOES update on reverse scrub (Object Manager
    visible).
  - The viewport draw cache is what's stale, not the camera state.
  - No documented SDK path forces invalidation of that cache during
    interactive scrub (we've tried every documented path Maxon
    publishes plus three undocumented ones).
- **Recommended next step:** file a Maxon SDK support ticket. The
  Codex handoff document recommends the same. This is a C4D engine
  bug or a deeply undocumented API requirement; six attempted fixes
  have ruled out everything callable from the SDK.
