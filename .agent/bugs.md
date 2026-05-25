# Bugs to visit later

Known issues found during development that aren't blocking the current
plan. Each entry is a self-contained brief — symptoms, reproduction,
what we know, and what we've ruled out. Add new entries at the top.

When picking one up, copy the entry into a plan or task doc; don't
fix-in-place against this list (it should stay a queue of unstarted
work).

---

## .c4d file size bloat from helper persistence

**Symptoms.** A scene with one geometry object and a couple of cameras
clocks in at ~90 MB. Copy-OM-to-fresh-doc preserves the bloat. With
nothing else in the doc, expected size is 1-2 MB.

**Suspected cause.** The Shotblocks helper's BaseContainer
accumulates large blobs:
- Audio bytes per mediaId (base64-encoded WAV/MP3, often 50-100 MB).
  Mike confirmed audio bytes DO get removed when the clip is deleted
  + scene is re-saved, but stale mediaIds from earlier sessions /
  unclean delete paths may still be in the helper.
- Per-clip peak pyramids (peakLevels[].b64 stored in the clip JSON).
  5 levels per clip × variable size. A long audio clip could carry
  multiple MB just for peaks.
- Stale BaseLinks from deleted cameras (smaller, but the save-state
  prune comment mentions accumulation as "minor cruft").

**Reproduction**:
1. Open the current 90 MB scene.
2. Run a CDP eval to dump per-clip peakLevels.b64 sizes + which
   mediaIds the helper claims to hold bytes for.
3. Compare with the expected baseline.

**Likely fixes**:
- Audit `audio-remove`: confirm bytes are actually being purged on
  every clip-delete path (group delete, undo-then-redo, etc.). It
  works for the simple case but might leak on edge paths.
- Add a one-shot "compact helper" command: scan the helper for keys
  whose mediaId no longer matches any clip's mediaId, RemoveData
  them. Run on scene open or via a manual menu item.
- Re-evaluate whether peak pyramids need to be persisted in the
  clip JSON. They're recomputable from the audio bytes; persisting
  just saves the ~200-400ms decode on doc open. Could be opt-in or
  trimmed.

**Not blocking** — cosmetic bloat, doesn't break functionality. Worth
addressing before public release because 90 MB scenes are surprising
and will trigger user reports.

---

## scrub direction reversal sometimes misses camera switch

**Symptoms.** During a single mouse-drag on the ruler scrubber, if the
user scrubs forward across a gap into a clip and then reverses
direction without releasing the mouse and scrubs back into a different
clip, the viewport sometimes fails to switch to that clip's camera —
it stays on whatever camera (or default editor cam) was active. The
swap arrives only when the user nudges forward by a frame, or when the
user releases the mouse and starts a new drag.

Intermittent. Reproducible roughly 50% of the time with a fast reverse
on a clip-3 → gap → clip-4 → reverse-into-clip-3 sequence; works fine
on the other 50%.

**What we measured.**
- JS-side store always resolves the correct active clip on every
  scrubFrame tick (confirmed via a Zustand subscription dump).
- JS-side `useActiveClipRouter` sends the correct
  `set-active-camera, objectId` sequence on every transition
  (confirmed via a `window.fetch` monkey-patch capturing every
  outbound send). The send for the reversed-into clip DOES arrive at
  C++ in the failing case, with no delay relative to other sends.
- C++ side `set-active-camera` handler resolves the BaseLink, compares
  `bd->GetSceneCamera(doc) != cam`, and calls `SetSceneCamera` only
  on mismatch. We didn't instrument that branch yet.

**What we ruled out.**
- The `scrubFrame ?? currentFrame` selector flickering between values
  during fast scrubs — the value sequence is clean and monotonic.
- The setTick "clear scrubFrame on exact echo" branch leaving the
  router pinned to a stale currentFrame — currentFrame is always
  inside the destination clip during the stuck window.
- React effect-batching dropping the send — sends are timestamped and
  arrive in order.

**Best guess.** C++ side: `bd->GetSceneCamera(doc)` may return stale
data during a high-frequency scrub burst, causing the `prevCam == cam`
short-circuit to falsely skip the swap. Or C4D's BaseDraw camera state
is rolled back by an EVMSG_TIMECHANGED handler we don't see, after our
SetSceneCamera ran. Needs C++-side instrumentation to confirm — log
prevCam, cam, and whether the SetSceneCamera branch fires for every
inbound objectId.

**Predates** the orphan-handling commits (1323fa6 → 7724ab4). Likely
present since v2-owned scrub shipped; just easy to surface with the
orphan test scenes (which have explicit gaps).

**Possible fix directions** (untested):
- Drop C++'s `prevCam != cam` dedupe — let every JS send hit
  `SetSceneCamera` unconditionally. JS already dedupes on its side,
  so C++'s second dedupe is belt-and-suspenders, and the cost of an
  extra SetSceneCamera is one DrawViews call which is cheap.
- After SetSceneCamera, force a re-read with a frame advance to
  ensure C4D commits the new state before the next tick reads it.
