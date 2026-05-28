# v1 Plan 4.1 — Live Stage camera switching (whole-sequence render fix)

> **Release:** v1 — see [v1-release-roadmap.md](v1-release-roadmap.md)
> **Status:** shipped (`b7d17bb`..`a8e61d3`) — render-time camera switching verified 2026-05-28
> **Plan owner:** Mike + Claude

A live, hidden Stage object in the scene flips the active camera at every Shotblocks clip boundary during render — so any C4D render path (Render to Picture Viewer, Add to Render Queue from C4D's menu, batch render, network render) correctly switches cameras mid-sequence without the Shotblocks dialog being open.

The Stage is **dormant** during interactive use (its Enable flag is off) so it doesn't conflict with the user's freedom to navigate the viewport via any camera. It activates **only for the duration of a render** via `MSG_MULTI_RENDERNOTIFICATION` and deactivates immediately when the render ends.

---

## Why this exists

**Current state (before Plan 4.1):**
- "Individual shots" render mode: works correctly via per-shot Take overrides. One queue entry per clip; each Take overrides the active camera for its frame range.
- "Whole sequence" render mode: produces ONE camera's output across the entire render. Whatever camera is active when the user clicks Add to Queue (or hits Render to Picture Viewer) wins for every frame.
- **Native C4D render paths (Render to Picture Viewer, Render Queue menu) ignore Shotblocks entirely** — the user can't get a multi-camera sequence render unless they go through Shotblocks's "Individual shots" queue path.

**What users expect:**
- Hit Render to Picture Viewer → see the Shotblocks-sequenced cameras in the output, just like the live timeline plays back.
- Don't have to remember to use a specific button to get multi-camera renders.

**Why a Stage object solves this:**
- C4D's Stage object's `STAGEOBJECT_CLINK` parameter is the canonical "override the active camera" mechanism. Animating it produces camera switches that all C4D render paths respect natively.
- We can build the Stage's animation from the Shotblocks clip boundaries automatically — the user doesn't author keyframes.

---

## Spike validation (2026-05-27)

Before designing the build, a spike verified the critical API behaviors:

| Test | Result |
|------|--------|
| Animate `STAGEOBJECT_CLINK` via `CTrack` / `CKey::SetGeData` with `CINTERPOLATION::STEP` | ✓ Works — keys land, cameras flip discretely at frame boundaries |
| Stage Enable OFF (`ID_BASEOBJECT_GENERATOR_FLAG = false`) suppresses camera-switch effect in interactive viewport | ✓ Viewport ignores the Stage entirely; active camera comes from elsewhere |
| Stage Enable OFF suppresses effect during render to Picture Viewer | ✓ Render uses whatever camera was active when render started — Stage is dormant |
| Stage Enable ON during render switches cameras at keyframe boundaries | ✓ Render output flips cameras at the frame the keyframe is on |

**Key validated finding:** `ID_BASEOBJECT_GENERATOR_FLAG = false` correctly suppresses the Stage at BOTH viewport and render evaluation. Toggle pattern is viable.

**Spike side-finding (out of scope):** Renders of cameras using the Shotblocks rig tag produce a single frozen / black frame because the rig's spring-damper / fBm state isn't initialized cold at render time. The renderer doesn't tick `Execute` the way live playback does. This is a separate bug to file against the rig tag — relates to v2 motion-layers Plan 10 "Bake to keyframes," which already plans to address this for the procedural-animation pills. Track as: **rig tag needs bake-to-keyframes for renders** (deferred, v2 territory).

---

## Cross-plan decisions (locked in up-front)

- **Stage is hidden via `NBIT_OHIDE`.** User never sees it in the OM. Reachable from code via a BC marker on the object itself (similar to existing helper Onull pattern with `BCKEY_HELPER_MARKER`).
- **Stage is dormant by default** — `ID_BASEOBJECT_GENERATOR_FLAG = false`. Interactive viewport is owned by Shotblocks's existing per-playhead camera router. The Stage doesn't compete.
- **Stage activates on `MSG_MULTI_RENDERNOTIFICATION` with `start = true`** and deactivates on `start = false`. Both editor renders (`external = false`) and Picture Viewer / Render Queue renders (`external = true`) activate it — by default, all renders honor Shotblocks sequencing.
- **Stage's animation is rebuilt on every timeline change.** Piggybacks on the existing 250ms-debounced `save-state` path. One `CKey` per clip boundary with `CINTERPOLATION::STEP`, value = `BaseLink` to that clip's camera. Gaps insert a key with null link (renderer falls back).
- **Top-track-wins** at any frame, matching the existing `activeClipAt` resolver. Same rule as Shotblocks's live routing.
- **Coexistence with Individual-shots render mode:** the Stage exists in the scene regardless of render mode. Individual-shots Takes still apply their per-shot camera overrides during render — Take overrides win over the Stage in their frame range. So both modes keep working; render mode is a queue-side decision.
- **Take-over of existing user Stage object:** on first install (or on doc load that surfaces one), if the user already has a Stage with `STAGEOBJECT_CLINK` set, prompt "Shotblocks needs to manage a Stage object for sequence rendering. Take over the existing one?" → on confirm, repurpose; on cancel, refuse to install (whole-sequence native renders won't switch cameras until user removes their Stage).
- **`Ostage` is the only Stage type Shotblocks supports.** Renderer-specific stage variants (if any vendor ships one) aren't on the v1 roadmap.

---

## Open research items

None — spike resolved the unknowns. The build can proceed without further validation.

The one thing worth instrumenting briefly during build: confirm `MSG_MULTI_RENDERNOTIFICATION` is reliably received by a tag attached to the hidden Stage object on both editor and external renders. (Per SDK docs it's "sent to the document and all its elements," but worth a `GePrint` confirmation on first build.)

---

## Commit plan

Three commits. Each verifiable in isolation. Each ships building.

### Commit 1 — Hidden helper Stage + dormant state

**Scope:**
- New `BCKEY_STAGE_HELPER_MARKER` constant. Store as a `String` on the Stage object's `BaseContainer` so we can recognize it on doc reopen / undo / reload.
- `GetOrCreateStageHelper(doc)` C++ helper — mirrors the existing `GetOrCreateV2Helper`. Finds the marked Stage if present, else allocs `Ostage`, sets `NBIT_OHIDE`, sets `ID_BASEOBJECT_GENERATOR_FLAG = false`, inserts at OM root, writes the BC marker.
- `FindStageHelper(doc)` — non-creating lookup.
- On plugin startup / doc-open / save-state path: ensure the helper exists (idempotent).
- No animation track yet. No render-time toggle yet. Just the empty hidden Stage in dormant mode.

**Files:**
- `host/shotblocks/source/main.cpp` — new constants + helpers.

**Acceptance:**
- Open a doc → Stage object exists in the doc but is invisible in the OM (NBIT_OHIDE).
- Save + reopen the doc → same Stage is found (BC marker preserves identity).
- Render to Picture Viewer → no effect from the Stage (it's dormant + has no animation).
- Stage's Enable checkbox is unchecked in AM if user manually unhides it.

**Risk:** low. Mirrors a well-tested pattern (`GetOrCreateV2Helper`).

### Commit 2 — Cache per-boundary camera events in C++ (architectural pivot)

**Originally planned:** build a `CTrack` on `STAGEOBJECT_CLINK` with one STEP `CKey` per clip boundary. Three implementation attempts failed silently — keys appeared in the timeline at the right frames but their camera-link fields stayed empty and the render didn't switch:

1. `AutoAlloc<BaseLink> link; link->SetLink(cam); GeData ld; ld.SetBaseLink(*link); k->SetGeData(curve, ld);` — empty link.
2. `GeData ld; ld.SetBaseList2D(cam); k->SetGeData(curve, ld);` — empty link.
3. Same as #2 but with `DescID(DescLevel(STAGEOBJECT_CLINK, DTYPE_BASELISTLINK, 0))` to mark the track as `CTRACK_CATEGORY_DATA` (per Maxon CTrack manual + a research agent's findings) — STILL empty link.

After three failed attempts the band-aid rule kicks in. Pivoted to a different mechanism per Plan 4.1's architectural alternatives section.

**New approach:** the Stage doesn't get an animation track at all. Commit 2 just caches the per-boundary event list in a C++ in-memory `std::vector<StageCameraEvent>` on the dialog. Commit 3 (driver tag) reads this cache each render-frame and writes the Stage's STATIC `STAGEOBJECT_CLINK` parameter directly — the same write that works when the user sets the field manually (verified during diagnosis).

**Scope (revised):**
- `_stageEvents: std::vector<{frame, objectId}>` member on the dialog.
- `HandleSetStageCameras(body)` parses the JS-sent events array into `_stageEvents`. No track creation, no keyframe writes.
- The JS-side `computeStageEvents(videoTracks)` helper + `set-stage-cameras` send wire unchanged — same payload, different receiver.

**Files:**
- `host/shotblocks/source/main.cpp` — `StageCameraEvent` struct + `_stageEvents` member + simplified `HandleSetStageCameras`.
- `host/shotblocks/web/src/lib/stageCameras.ts` — unchanged from the original commit 2.
- `host/shotblocks/web/src/usePersistence.ts` — unchanged from the original commit 2.

**Acceptance:**
- Add / move / trim / delete clips → C++ side receives `set-stage-cameras` payloads; `_stageEvents` reflects the latest event list. No user-visible behavior change (the cache is consumed in Commit 3).

**Risk:** low. Cache is just a vector copy.

### Commit 3 — Driver tag: render-time Enable toggle (WIP, render still broken)

**Shipped (`5fb799f`):**
- `ShotblocksStageDriverTag` (`g_shotblocks_stage_driver_id = 1000008`) — hidden TagData plugin with `PLUGINFLAG_HIDE | PLUGINFLAG_HIDEPLUGINMENU | TAG_EXPRESSION`.
- Auto-attached to the helper Onull in `GetOrCreateV2Helper` (idempotent).
- Message handler toggles `_shotblocks_stage`'s `ID_BASEOBJECT_GENERATOR_FLAG` on `MSG_MULTI_RENDERNOTIFICATION`. Verified via SetParameter readback: ok=1, readback=1 during render, readback=0 after.
- Execute is intentionally a no-op (was per-frame BaseDraw write — pulled by user request because it forced the viewport onto the Shotblocks-active camera and prevented manual camera selection).
- HandleSetStageCameras rewrites the Stage's animation track on every save-state with the **correct DescID** (creator=Ostage). The Stage's keyframes accurately reflect the timeline.

**Render still doesn't switch cameras despite:**
- Stage Enable=ON during render (logged + readback-confirmed)
- Keyframes present with correct DescID, types, and link resolution (Dump matches working hand-keyed reference structurally)
- User-built reference scene (`scenes/test stage animation.c4d`) renders correctly with cameras switching → confirms Stage CAN render-switch in this C4D 2026 install; it's not a Maxon-side breakage.

**Investigation trail (today, all dead ends):**

1. **Keyframe write — three failed attempts** all produced visually-valid keys with empty link fields:
   - `AutoAlloc<BaseLink> + SetBaseLink(*link)` → empty
   - `SetBaseList2D(cam)` → empty
   - Both above with `DescID(DescLevel(STAGEOBJECT_CLINK, DTYPE_BASELISTLINK, 0))` → still empty

   Root cause found by dumping a working hand-keyed Stage: **DescID needed `creator=Ostage` (5136), not `creator=0`**. With the corrected DescID, the keyframes now write with correct link data.

2. **Per-frame parameter write from tag's Execute** (alternative when keyframes seemed dead): `SetParameter(STAGEOBJECT_CLINK)` returned ok=1, but readback showed null. Per-frame writes don't persist on the Stage from a tag context. (Doesn't matter anymore now that keyframes work; documenting for posterity.)

3. **`BaseDraw::SetSceneCamera` per frame from tag's Execute** (pivot 2): worked for interactive native scrub — viewport switched cameras with our dialog closed. But pulled because it also forced the viewport onto Shotblocks's camera at all times, preventing manual camera selection.

4. **Render with Stage Enable=ON + correct keyframes still doesn't switch.** Even though Mike's reference scene renders correctly, our auto-built Stage doesn't. We've ruled out keyframe correctness and Enable state.

**RESOLVED 2026-05-28 (`a8e61d3`).** The table below was a red herring — the
NBIT_OHIDE / interp differences did not matter. The actual blocker was a
**BaseContainer marker-key collision**: the Stage helper stamped its identity
marker on BC key `1100`, which on an `Ostage` IS `STAGEOBJECT_CLINK` (the
camera-link parameter). The marker-string write and the camera-link write
fought over the same slot, so:

1. `FindStageHelper` never matched (the marker string was gone) → a new Stage
   was allocated on every `GetOrCreateStageHelper` call (the "duplicate Stage
   per Add Camera" symptom).
2. The surviving Stage's camera link was clobbered → empty Camera field → no
   render switch.

Fix: moved the Stage marker to a private key (`1000900`) clear of all Stage
params; seeded the static `STAGEOBJECT_CLINK` + forced `SetKeyDirty` /
`SetDirty` / `AnimateObject` so the link populates; kept Enable dormant during
editing and toggled ON via `MSG_MULTI_RENDERNOTIFICATION` (with a dirty-force)
only for the render snapshot; re-applied `NBIT_OHIDE` (visibility is
independent of render eval). Editing viewport stays free; render switches
cameras across native paths; Stage is invisible in the OM.

**Original open question (kept for the record) — what's different between ours and the working reference?**

| | Working reference | Our auto-built |
|---|---|---|
| Stage name | `Stage` | `_shotblocks_stage` |
| Visibility | Visible in OM | `NBIT_OHIDE` (hidden) |
| Position in OM | Root | Root |
| Enable during render | ON | ON (confirmed) |
| Track DescID | depth=1, id=1100, dtype=133, creator=5136 | depth=1, id=1100, dtype=133, creator=5136 (matches) |
| Key dtype | 133 | 133 (matches) |
| Key interp | 2 (LINEAR — auto-key default) | 3 (STEP) |
| Key links resolve | yes | yes |
| Render-switches? | YES | NO |

**Top suspects (in order of likelihood):**

1. **`NBIT_OHIDE` excludes the Stage from render evaluation entirely.** Most plausible. Hidden objects might be skipped by the render scene walk. Easy to test — temporarily skip the OHIDE flag and re-render.
2. **The `MSG_MULTI_RENDERNOTIFICATION` Enable=ON write happens too late.** The renderer snapshots scene state at render-start; if Enable was OFF at snapshot time and we flip it after, the render uses the snapshot. Easy to test — check if Enable=ON BEFORE render starts (e.g., set it persistently OR via JS pre-render hook).
3. **Some other parameter difference** between visible-Stage and our hidden-Stage that affects renderer participation (the OM has small icons that probably correspond to flags — `OBJECT_VISIBILITY_RENDER`, `OBJECT_VISIBILITY_EDITOR`, etc.).
4. **Animation eval ordering** — our keys may have a different evaluation order than Maxon's recorded keys. Long shot.

**Files modified this commit (`5fb799f`):**
- `host/shotblocks/source/main.cpp` — Stage Driver tag class + registration + Message handler + Execute no-op
- `host/shotblocks/web/src/components/AddCameraButton.tsx` — Dump stage button (spike, kept for next session)
- `host/shotblocks/web/src/lib/host.ts` — `dump-stage` outbound type
- `scenes/test stage animation.c4d` — ground-truth reference for what a working Stage looks like

---

### Next-session queue

In order of recommended attempt:

1. **Test the `NBIT_OHIDE` hypothesis** — temporarily skip the OHIDE bit in `GetOrCreateStageHelper`, render, see if cameras switch. ~5 min. Already had the diff queued in working tree when we stopped.
2. **If unhiding works:** decide UX. Option A — leave Stage visible (1 extra row in OM, but functional). Option B — find a different hide mechanism that doesn't exclude from render (try `OBJECT_VISIBILITY_RENDER=OBJECT_ON` + display-off via Layer system).
3. **If unhiding doesn't work:** test whether Enable=ON BEFORE render makes a difference. Add a pre-render hook in JS (Inspector "Render to Picture Viewer" button that pre-toggles, OR a Timer-based check that flips Enable when it detects render about to start).
4. **If neither works:** A/B test interp value — change our writes from STEP to LINEAR (match the reference). Less likely but cheap.
5. **Last resort:** rebuild from scratch instead of finding-or-creating the Stage. Maybe there's stale state on a Stage created during earlier failed attempts that survives across sessions. (We tested fresh-scene many times — unlikely.)

**Don't repeat what we already know:**
- Keyframe writes work (with correct DescID). Don't go back to debugging CKey writes.
- Stage Enable toggle from Message works (readback verified). Don't re-instrument that.
- The reference scene renders correctly in this C4D install. Don't go down the "maybe Maxon broke Stage rendering" path again.

**Validation method going forward:**
- After every code change, render a 2-camera scene and visually confirm output switches cameras.
- If unsure whether keys are correct, click Dump stage and compare to the reference (both should have identical DescID + key structure).

**Don't deploy `NBIT_OHIDE` removal as final** — even if it fixes render, the unhidden Stage clutters the OM. Need a UX-acceptable hiding mechanism.

---

## What Plan 4.1 does NOT do

- **No fix for the rig tag render bug** (single frozen frame on render). That's a separate ticket — relates to v2 motion-layers Plan 10 bake-to-keyframes. Filed but deferred.
- **No per-renderer Stage variants.** Only standard `Ostage`. Vendor-specific stage objects (if any exist) aren't supported in v1.
- **No live editing of the auto-generated keyframes from inside C4D.** User shouldn't edit them; if they do, our next timeline change overwrites their edits. The Stage is plugin-owned data.
- **No "show me what Shotblocks will render" preview** beyond the existing live viewport behavior. The render IS the preview.
- **No Stage object Inspector tab in our UI.** The Stage is invisible to the user; they shouldn't think about it. (Future enhancement: a "Sequence render setup" Inspector pane that lets them inspect what the Stage will do.)

---

## Files touched (estimated)

**Modified:**
- `host/shotblocks/source/main.cpp` (Stage helper + driver tag + rebuild + take-over)

**Possibly new:**
- A separate `ShotblocksStageDriverTag.cpp` if the tag's code gets large; otherwise inline in main.cpp.

---

## Memories that apply

- `c4d-setscenecamera-bypasses-cache-invalidation` — not directly used (Stage drives camera via the description framework, which is what the recipe relies on), but worth re-reading.
- `maxon-sourceprocessor-function-line-limit` — Dispatch is near the 600-line cap. Stage helper handlers extract to private methods.
- `mine-python-for-constants` — applies to anything porting from v1 Python rig. Not heavily relevant here since v1 Python didn't use a Stage object for sequencing.
- `v2-js-to-cpp-via-loopback-http` — no new JS↔C++ commands needed for Plan 4.1 itself (the Stage is purely server-side); but if Commit 3's take-over flow needs a modal dialog, that's a JS-side prompt.
- `c4d-2026-renderdata-overrides-blocked` — relates to per-Take render overrides (Individual-shots mode). Not relevant to Stage-level camera switching.

---

## Verification across commits

After Commit 3 ships, the full end-to-end smoke:

1. Open empty doc → Stage helper auto-created, hidden in OM, dormant.
2. Drop a camera on V1 (or Add Camera). Scrub → viewport switches camera as expected (live routing).
3. Render to Picture Viewer for the clip's range → render output uses the clip's camera throughout.
4. Add a second clip on V1 with a different camera, after frame 100. Scrub → viewport switches at frame 100 (live).
5. Render → render output also switches at frame 100. Output matches what scrubbing shows.
6. Add overlapping V2 clip → top-track-wins applies in both live + render.
7. Delete all clips → Stage's animation track flushes; render falls back to whatever the user has as the active scene camera.
8. Open a doc that has its own user Stage → prompt fires → take-over works.
9. Cmd-Z anywhere in the flow → undo state remains coherent (Stage rebuild is a non-undoable side effect of the user's clip edit, like audio-bytes writes).

---

## Living document

When the build reveals new ambiguity, edit this plan. When the plan ships, change Status to "shipped (`<hash>`..`<hash>`)" and link the commit range here + in `v1-release-roadmap.md`.
