# v1 Plan 1 — Orphan handling + edge cases

**Status: shipped.** Commits `1323fa6` → `7607233` on `main`. See the "What actually shipped" section at the end for the final commit list (the plan evolved during implementation — drag-to-relink replaced the right-click menu; the audio relink commit was dropped because audio bytes are embedded in the .c4d and external-file orphan-recovery doesn't apply).

---

Closes a set of gaps in the current timeline around what happens when external state changes (camera deleted, audio file moved, scene loaded fresh, undo past creation, etc.). Adds orphan visual states + relink flows. Nothing motion-layers depends on; pure polish of the current surface.

---

## Scope

**Orphan visuals + relink flows for two cases:**
- Camera linked to a clip is deleted from the OM
- Audio file linked to a clip is moved/renamed/missing on disk

**Edge-case audit + fixes** for known and likely-unknown issues around:
- Scene load (helper-BaseObject already present, deleted manually, from another machine)
- Undo past helper creation
- Track count = 0 on load
- Camera rename (verify label updates)
- Two cameras with the same name (verify BaseLink picks correctly)
- Save while a clip is mid-drag (verify last-known state saves cleanly)

---

## Decisions locked in (from design exploration)

- **Orphan visual** = per Mike's Figma design (provided at implementation)
- **Orphan clip is selectable**, persists across save/load
- **Orphan camera clip in playback** = treated as "no camera" (camera doesn't change at clip boundary)
- **Orphan audio in playback** = silent (no audio plays for that clip)
- **Relink for audio** = right-click clip → "Relink…" → OS file picker → clip rebinds
- **Relink for camera** = right-click clip → "Relink to camera…" → list of doc cameras → user picks
- **Camera rename** = clip label updates live (BaseLink survives; UI must re-read name on each render)
- **Track count = 0** = auto-respawn V1 + A1 on load (matches the existing "delete last track" behavior)

---

## Implementation order (commits)

Each commit independently verified. Order is chosen so the orphan visual surface lands before relink flows depend on it, and edge-case audit lands last as a cleanup pass.

### Commit 1 — `feat(orphan): camera orphan detection + state field`

- Add `orphan: boolean` field to clip data (derived per-render from BaseLink resolution: if `cameraLink.GetObject()` returns null, clip is orphan)
- Surface the orphan state in the Zustand store so components can subscribe
- No visual change yet — just data plumbing

**Verification:** open DevTools, delete a clip's camera from the OM, confirm clip's orphan field flips to true in the store. Re-create the camera (or undo deletion) — orphan flips false.

### Commit 2 — `feat(orphan): camera orphan visual treatment`

- Apply Figma-provided visual state to clip when `orphan === true` (color swap, icon, label change — exact per Mike's design)
- Clip remains selectable, draggable, trimmable
- Orphan clips visible across save/load (already true since orphan is derived from BaseLink, not stored)

**Verification:** delete a clip's camera — clip visibly changes per Figma. Save scene, close, reopen — orphan visual persists. Click clip — still selectable.

### Commit 3 — `feat(orphan): playback treats orphan camera as 'no camera change'`

- During playback, when current frame lands on an orphan clip, plugin does NOT call `SetSceneCamera` for that clip's range — viewport stays on whatever camera was active before
- Confirm camera doesn't "jump" weirdly on the transition into/out of orphan clip

**Verification:** sequence of clips A (orphan) — B (real camera). Play through. Camera should hold whatever was active at the start of A, then switch to B at B's start. No flicker, no crash.

### Commit 4 — `feat(orphan): right-click camera clip → 'Relink to camera...'`

- Right-click context menu on a clip (existing menu if any, or new) gets a "Relink to camera…" entry, enabled only when clip is orphan
- Click → submenu (or modal) shows list of all cameras in the doc
- User picks → clip's `cameraLink` rebinds to selected camera → clip flips from orphan back to normal
- Single undo step

**Verification:** orphan clip → right-click → Relink → pick camera. Clip becomes normal, name updates, playback works. Undo restores orphan state.

### Commit 5 — `feat(orphan): audio orphan detection + visual + state field`

- Audio clip orphan detection: file path stored in clip can't resolve (file missing/moved/renamed)
- Mirror Commit 1+2 for audio: detection via file resolution check on load + on each render tick (cheap path-exists), `orphan: boolean` in store, visual state per Figma
- Waveform doesn't render for orphan audio clips (placeholder visual)

**Verification:** import an audio file, save scene, move the file on disk, reopen scene → clip shows orphan visual. Wave area is blank/placeholder.

### Commit 6 — `feat(orphan): right-click audio clip → 'Relink…' → OS file picker`

- Right-click context menu on orphan audio clip gets "Relink…" entry
- Click → OS file picker opens (filtered to audio formats: mp3, wav, m4a, aiff, whatever's currently supported)
- User picks file → clip's `filePath` updates → audio re-decodes → peaks regenerate → waveform appears → orphan clears
- Single undo step
- If user cancels picker → no change

**Verification:** orphan audio clip → right-click → Relink → pick file. Waveform appears, clip becomes normal. Undo restores orphan.

### Commit 7 — `fix(timeline): camera rename updates clip label live`

- Audit current behavior: does clip label update when user renames camera in OM?
- If yes, just verify with a regression test and skip the commit
- If no, fix: clip label must re-read `cameraLink.GetObject().GetName()` per render rather than caching at create time
- Probably already works via existing BaseLink + reactive render; flag as a verify-and-skip commit if so

**Verification:** drop camera "Camera.1" on V1. Rename it to "Hero Cam" in OM. Clip label should immediately read "Hero Cam." No timeline interaction needed.

### Commit 8 — `fix(timeline): track count auto-respawn on load`

- Edge case: scene loads where the helper-BaseObject has zero video tracks or zero audio tracks
- Plugin auto-respawns V1 / A1 to match the "no track count goes to zero" invariant
- Same logic as the existing "delete last track" handler, just applied at load time

**Verification:** manually edit a scene's helper-BaseObject JSON to have zero video tracks, save, reload — V1 should appear. Test same with zero audio tracks → A1 appears.

### Commit 9 — `fix(undo): graceful undo past helper creation`

- Test: new scene → drop camera on V1 (creates helper + clip) → Cmd-Z past helper creation point
- Confirm no crash, no orphaned state, no console errors
- If broken: ensure helper creation is itself an atomic undo step; on undo, the helper is removed cleanly and re-created on next clip drop

**Verification:** the test above; should be silent success.

### Commit 10 — `chore(timeline): scene-load resilience audit`

- Run a small audit of scene-load paths:
  - Scene saved on a different machine (different C4D install hash): loads correctly?
  - Scene where helper-BaseObject was manually deleted: timeline shows empty, plugin recreates helper on first interaction?
  - Scene where helper has malformed JSON (corrupt): plugin doesn't crash, logs error, recovers with empty state?
  - Scene with helper but no tracks: V1/A1 spawn per Commit 8?
- Fix anything found; if all pass, this commit is just notes in the audit comment

**Verification:** the four scenarios above, manually exercised. Each must produce a sane state (working plugin, no crash, no data loss for valid scenes).

---

## Verification — end-to-end after all 10 commits

1. `cd host/shotblocks/web; npm run build` — clean
2. `cmake --build "C:\Dev\c4d_sdk_2026\build-win64" --config Release --target shotblocks` — clean
3. **Smoke test in C4D (`scripts/dev-loop.ps1`):**
   - Open dev-test.c4d
   - Drop a camera on V1, drop audio on A1 — both work normally
   - Delete the camera from OM → clip shows orphan visual per Figma, still selectable
   - Play through — viewport doesn't change camera during orphan clip's range
   - Right-click orphan clip → Relink to camera → pick a different camera → orphan clears, playback works
   - Cmd-Z → orphan returns
   - Move the audio file outside the scene's folder → reload scene → audio clip shows orphan, no waveform
   - Right-click → Relink → pick file → waveform appears, audio plays
   - Rename a live camera → clip label updates instantly
   - Verify undo past helper creation doesn't crash (fresh scene → drop camera → Cmd-Z several times)
   - Open a scene saved on different machine: works
   - Open a scene with manually-deleted helper: empty timeline, no crash

---

## Open questions to resolve during implementation

- **(a) Right-click context menu** — does the plugin currently have a right-click menu on clips? If yes, add to existing. If no, the first Relink commit also has to build the menu infrastructure. Inspect current Clip.tsx before Commit 4.
- **(b) Camera picker UI for relink** — submenu (compact, in-context) or modal (more readable for long camera lists). Decide when wiring Commit 4. Submenu probably right for typical case (≤10 cameras).
- **(c) Audio file path resolution timing** — checking `file://` existence on every render tick might be too frequent. Likely fine since it's just a stat call, but if perf issue surfaces, move to file-system watcher or load-time-only check.

---

## What this plan explicitly does NOT do

- **No "rebuild clip from scratch" UI** — relink only swaps the target, doesn't recreate the clip
- **No batch relink** — relink one clip at a time
- **No fuzzy match for "find similar camera"** — relink is manual picker only
- **No notification/alert when scene loads with orphans** — orphan visual itself is sufficient signal
- **No undo coalescing across multiple orphan clips** — each relink is its own undo step

---

## Hard rules (from CLAUDE.md and memory)

- C4D must be force-killed before deploy (dev-loop.ps1 handles this)
- C4D plugin must be rebuilt for any C++ changes; this plan probably has C++ changes (helper-BaseObject load resilience, undo handling)
- Verify in C4D before committing
- One atomic change per commit
- BaseContainer undo registers AT AddUndo time — every helper-container write inside StartUndo/EndUndo follows AddUndo
- No silent `except: pass` — log exceptions
- Use BaseLink for camera reference, not name (memory: `project_v2_persistence_model`)

---

## What actually shipped

The final commit list (in chronological order). The plan's Commit 6 (audio relink via OS file picker) was dropped after we recognized that audio bytes are embedded in the .c4d via the helper, so the external-file orphan model never applies — only audio corruption / out-of-band edits can produce an orphan, and those don't have a relink path that makes sense.

| Plan # | Commit | Subject |
|---|---|---|
| 1 | `1323fa6` | feat(orphan): camera orphan detection + state field |
| 2 | `72f9322` | feat(orphan): camera orphan visual treatment |
| 3 | `fc50255` | feat(orphan): playback treats orphan camera as a gap |
| 4 | `7724ab4` | feat(orphan): drag OM camera onto orphan clip to relink |
| 5 | `67e53d2` | feat(orphan): audio orphan detection + visual |
| — | (skipped) | (was: audio relink via OS file picker — see note above) |
| 7 | `31d4285` | feat(timeline): camera rename updates clip label live |
| 8 | `1373784` | fix(timeline): respawn V1 / A1 on load if persisted scene has 0 tracks |
| 9 | `42728dd` | fix(undo): undo past first save no longer leaves stuck clip on timeline |
| 10 | `7607233` | fix(persistence): recover from corrupt or missing helper JSON |

### Notable deviations from the plan

- **Commit 4 — relink via drag, not right-click menu.** Mike asked for direct manipulation. Drop an OM camera on an orphan clip → rebinds in place. No right-click menu was built.
- **Commit 7 — extended to mirror live names into clip.sourceName.** Without this, deleting a renamed camera would fall back to the original drop-time name, not the most recent.
- **Commit 9 — turned up a real bug.** Undo past the first save dropped a stuck clip on the timeline because `loadFromHost` early-returned on empty json. Fixed by treating empty json as "reset to default".
- **Commit 10 — combined with the corrupt-JSON test from the audit.** The same defensive `try/catch` around `JSON.parse` covers both "helper deleted" (load returns empty) and "helper corrupted" (load returns garbage).

### Bugs surfaced during the audit (filed for later)

Both filed in [`.agent/bugs.md`](../bugs.md):
- Scrub direction reversal during a single drag sometimes misses the camera switch. JS sends correct objectId; C++ side likely short-circuits on `bd->GetSceneCamera == cam` during a fast scrub burst.
- .c4d file size bloat (~90 MB for a near-empty scene). Suspected cause: stale audio mediaIds in the helper or large peak pyramids.

### Cross-machine load test (Commit 10 scenario 1)

Deferred until first public-release distribution; can't be tested with only one dev machine.
