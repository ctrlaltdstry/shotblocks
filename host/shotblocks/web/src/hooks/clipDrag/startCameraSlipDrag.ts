import { useStore } from '../../store';
import { flushKeyframeShifts } from '../../usePersistence';
import { setKeyframeSlipPreview, clearKeyframeSlipPreview } from '../../lib/keyframeSlipPreview';
import { seekToHost } from '../../lib/host';

/** Camera slip drag (video clips) — the sibling of startSlipDrag, which
 *  slips an audio clip's MEDIA window. Here the clip stays put and the
 *  camera's whole keyframe ANIMATION slides under the fixed window: a
 *  body drag shifts ALL the camera's keys by a frame delta. This is the
 *  one-gesture way to reposition an entire animation in time without
 *  marquee-selecting every dot.
 *
 *  Direction: drag RIGHT → the dots follow the cursor → keys move LATER
 *  (positive delta). Direct manipulation (you grab the animation, it
 *  goes where you drag), unlike audio slip's inverted media-under-window
 *  convention.
 *
 *  Bounded by the WINDOW EDGES against the END KEYS (resolved with Mike
 *  2026-06-02): the animation can slide only until an end-key reaches
 *  the matching window edge —
 *    slip right → stop when the FIRST key hits the window LEFT edge.
 *    slip left  → stop when the LAST  key hits the window RIGHT edge.
 *  One clamp covers every case: window < anim → real range; window ==
 *  anim → range collapses to 0 (no-op); window > anim → the short
 *  animation roams freely between the edges.
 *
 *  Same WebView2 cursor-drop avoidance as audio slip: NO per-move store
 *  commit. The live delta goes to the keyframe-slip-preview module,
 *  which repaints the dots imperatively; the real flushKeyframeShifts
 *  commit fires once on release, and the dots' echo-hold bridges the
 *  C++ round-trip. */
export function startCameraSlipDrag(
  downEv: PointerEvent,
  el: HTMLElement,
  clipId: number,
): void {
  const laneEl = el.closest('.lane') as HTMLElement | null;
  if (!laneEl) return;
  const laneRect = laneEl.getBoundingClientRect();
  const st0 = useStore.getState();
  const span = Math.max(1, st0.h.vMax - st0.h.vMin);
  const pxPerFrame = laneRect.width / span;
  if (pxPerFrame <= 0) return;

  // Snapshot the clip window + this camera's key extent so the clamp is
  // fixed for the gesture. A camera with no keys (or keys all outside
  // the window) has nothing to slip — bail.
  let objectId = 0;
  let clipIn = 0;
  let clipOut = 1;
  for (const t of st0.videoTracks) {
    const c = t.clips.find((cc) => cc.id === clipId);
    if (c) { objectId = c.objectId; clipIn = c.inFrame; clipOut = c.outFrame; break; }
  }
  if (objectId <= 0) return;
  const keys = st0.cameraKeyTimes.get(objectId);
  if (!keys || keys.length === 0) return;
  // keyTimes arrives sorted from C++, but don't assume — derive the
  // extent directly so a future change to the array can't silently break
  // the clamp.
  let firstKey = keys[0];
  let lastKey = keys[0];
  for (const f of keys) { if (f < firstKey) firstKey = f; if (f > lastKey) lastKey = f; }

  // The clamp window for the shift delta. Two endpoints, one per end key:
  //   a = clipIn  - firstKey  → first key sits on the clip's LEFT edge.
  //   b = clipOut - lastKey   → last  key sits on the clip's RIGHT edge.
  // The legal range is [min(a,b), max(a,b)], which covers every case the
  // way Mike specced it:
  //   window > anim span → a<0, b>0 → range straddles 0 → animation roams
  //                        freely between the edges.
  //   window == anim span → a==b → range collapses to a point → no-op
  //                        (the "slip has no purpose" case).
  //   window < anim span → a>0, b<0 → range straddles 0 → slide to choose
  //                        which slice of the longer animation shows.
  // A single (a,b) ordering can't express all three; min/max can.
  const a = clipIn - firstKey;
  const b = clipOut - lastKey;
  const loDelta = Math.min(a, b);
  const hiDelta = Math.max(a, b);

  const startClientX = downEv.clientX;
  const pointerId = downEv.pointerId;
  useStore.getState().setSlipDragging(true);

  // Live viewport preview: if the playhead sits INSIDE this clip, the
  // camera is live there, so we can show — in the C4D viewport — what the
  // SLIPPED animation looks like at the playhead, in real time as you
  // drag. The keys don't actually move until release, so we fake the
  // shift by SEEKING C4D to (playhead - delta): the unmoved keys
  // evaluated there equal what the +delta-shifted keys would show at the
  // playhead. Gated to inside-the-clip (resolved with Mike): outside the
  // clip a different camera is live, so slipping this one wouldn't change
  // that view. seekToHost coalesces, so per-move spam is fine.
  //
  // CRITICAL — pin the displayed playhead: a seek echoes a tick that sets
  // currentFrame = (playhead - delta). The playhead shows scrubFrame ??
  // currentFrame, and useActiveClipRouter routes on the same — so without
  // a pin the playhead would TRAVEL to (playhead - delta) and, once it
  // crosses the clip edge, the router releases THIS camera and the
  // viewport goes blank. Fix: hold scrubFrame = P for the whole drag. The
  // playhead stays at P, the router stays on this clip's camera, and the
  // seek still drives the viewport pose. On release we DON'T clear
  // scrubFrame — the final seekToHost(P) echoes frame === P === scrubFrame
  // which auto-clears it (playback.ts setTick), the designed echo-handoff.
  const playhead = useStore.getState().scrubFrame ?? useStore.getState().currentFrame;
  const previewSeek = playhead >= clipIn && playhead < clipOut;
  if (previewSeek) useStore.getState().setScrubFrame(playhead);

  function deltaAt(ev: PointerEvent): number {
    const raw = Math.round((ev.clientX - startClientX) / pxPerFrame);
    return Math.max(loDelta, Math.min(hiDelta, raw));
  }
  function onSlipMove(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return;
    const delta = deltaAt(ev);
    setKeyframeSlipPreview(clipId, delta);
    if (previewSeek) {
      // Re-pin each move: a prior 0-delta echo could have cleared the pin.
      useStore.getState().setScrubFrame(playhead);
      seekToHost(playhead - delta);
    }
  }
  function endSlip(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', onSlipMove);
    window.removeEventListener('pointerup', endSlip);
    window.removeEventListener('pointercancel', endSlip);
    const delta = deltaAt(ev);
    clearKeyframeSlipPreview();
    useStore.getState().setSlipDragging(false);
    if (delta !== 0) {
      // refCount across all video clips — a shared camera is skipped by
      // C++ (slipping would warp the other clip's animation). Video clips
      // can't actually share a camera today, so this never fires, but it
      // mirrors move/retime/delete and is cheap insurance.
      const st = useStore.getState();
      let refCount = 0;
      for (const t of st.videoTracks)
        for (const c of t.clips)
          if (c.objectId === objectId) refCount++;
      flushKeyframeShifts([{ objectId, deltaFrames: delta, refCount }]);
    }
    // Restore the viewport to the true playhead AFTER firing the commit,
    // so this seek is queued behind the save-state that shifts the keys —
    // it then evaluates at P against the now-shifted animation (the final
    // result). If delta is 0 it just undoes any preview seek. seekToHost
    // coalesces, so this is the one seek that wins on release.
    if (previewSeek) seekToHost(playhead);
  }
  window.addEventListener('pointermove', onSlipMove);
  window.addEventListener('pointerup', endSlip);
  window.addEventListener('pointercancel', endSlip);
}
