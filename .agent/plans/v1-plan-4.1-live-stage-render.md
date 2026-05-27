# v1 Plan 4.1 — Live Stage camera switching (whole-sequence render fix)

> **Release:** v1 — see [v1-release-roadmap.md](v1-release-roadmap.md)
> **Status:** ready to start (spike validated 2026-05-27)
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

### Commit 2 — Build / rebuild the camera-link animation track from clip boundaries

**Scope:**
- `RebuildStageAnimation(doc)` C++ function. Walks the clip JSON the helper Onull stores, computes the top-track-wins camera per clip boundary, builds the `CTrack` on `STAGEOBJECT_CLINK` with one STEP `CKey` per boundary. Flushes any existing keys first.
- Hook into the existing `save-state` path so every timeline change rebuilds. Rebuild is cheap (one track, ~N keys for N clips).
- Edge case: clip has objectId 0 (orphan) → insert a key with null link (gap behavior).
- Edge case: clip ends mid-stream, next clip starts at a different frame → at the gap, insert a null-link key, then the next clip's start frame inserts that clip's camera. Same step-interpolation rule.
- The Stage's Enable flag stays OFF throughout — the animation is built but dormant.

**Files:**
- `host/shotblocks/source/main.cpp` — new `RebuildStageAnimation` private method, called from save-state handler.

**Acceptance:**
- Add a clip on V1 → Stage gets one key at clip.inFrame pointing at the clip's camera, plus one at clip.outFrame with null link.
- Add a second clip on V2 overlapping V1 → top-track-wins resolver outputs V2's camera for the overlap.
- Move / trim / delete clips → keys rebuild correctly.
- Manually toggle Stage Enable ON in the AM → scrub the timeline → viewport switches cameras at the clip boundaries.
- Render with Stage Enable ON → render output switches cameras at clip boundaries.

**Risk:** medium. The rebuild has to handle every clip-edit case correctly. Worth a careful test pass through add / move / trim / split / delete.

### Commit 3 — Render-time toggle via `MSG_MULTI_RENDERNOTIFICATION`

**Scope:**
- Register a small hidden C++ TagData plugin — "Shotblocks Stage Driver." Single purpose: receive `MSG_MULTI_RENDERNOTIFICATION` and toggle the parent Stage's enable flag. Plugin info flag set so it doesn't appear in the user-facing tag menu (similar to how the existing Python rig tag is registered — but this one is C++ + flagged hidden).
- Auto-attach this tag to the Stage helper on creation in Commit 1 (refactor Commit 1's `GetOrCreateStageHelper` to also ensure the driver tag exists).
- Tag's `Message` handler:
  - On `MSG_MULTI_RENDERNOTIFICATION` with `start = true`: set parent Stage's `ID_BASEOBJECT_GENERATOR_FLAG = true`.
  - On `MSG_MULTI_RENDERNOTIFICATION` with `start = false`: set parent Stage's `ID_BASEOBJECT_GENERATOR_FLAG = false`.
- Take-over flow: scan doc for an existing user Stage object that has animation on `STAGEOBJECT_CLINK` AND no Shotblocks marker. If found, present a modal "Shotblocks needs to manage a Stage object for sequence rendering. Take over your existing one?" → confirm: repurpose (add our marker + driver tag, replace its animation track on rebuild); cancel: skip our install, disable whole-sequence rendering until the conflict is resolved.

**Files:**
- `host/shotblocks/source/main.cpp` — `ShotblocksStageDriverTag` class + registration + take-over handling.
- New plugin ID for the tag (use the next testing-range ID — 1000001-1000010 per memory, but we're already at the rig tag at 1000001 and v2 command at another; pick the next free one).

**Acceptance:**
- With Stage helper + driver tag installed: interactive scrub leaves viewport free (Stage dormant).
- Render to Picture Viewer → Console log confirms the driver tag received `MSG_MULTI_RENDERNOTIFICATION start=true` → Stage Enable flips ON → render switches cameras → after render, driver receives `start=false` → Stage Enable flips OFF → viewport free again.
- Render via Add to Queue → C4D Render Queue → same behavior.
- User opens a scene with their own pre-existing Stage → modal appears → take-over flow works.
- After take-over: user can still see (the now-hidden) Shotblocks-owned Stage exists if they unhide it manually; behavior is identical to a fresh install.

**Risk:** medium. The C++ TagData registration is new territory in this plugin. The take-over flow needs careful UX (one prompt per session, not every doc reload).

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
