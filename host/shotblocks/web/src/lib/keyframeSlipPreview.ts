// Live camera-slip preview — module-level, deliberately OUTSIDE the
// Zustand store and React, mirroring slipPreview.ts.
//
// A camera slip drags the whole keyframe animation under a FIXED clip
// window. The clip doesn't move; only the camera's keys shift. During
// the drag we want every in-window keyframe DOT to translate together
// by the live delta, with NO React re-render of the clip body — a
// per-move store commit re-renders the clip + its KeyframeTicks, and
// that churn is what makes WebView2 drop the native (slip) cursor
// mid-gesture (proven for audio slip; same risk here).
//
// So the in-flight delta lives here and KeyframeTicks repaints the
// affected clip's dots IMPERATIVELY via a registered callback. The real
// store commit (flushKeyframeShifts → C++ ApplyKeyframeShift) happens
// once, on pointer release; the dots' echo-hold bridges the round-trip.

interface KeyframeSlipPreview {
  clipId: number;
  deltaFrames: number;
}

let preview: KeyframeSlipPreview | null = null;

/** Per-clip imperative redraw callbacks, registered by KeyframeTicks so
 *  the slip drag can repaint a specific clip's dots without React. */
const redrawCallbacks = new Map<number, () => void>();

/** KeyframeTicks registers its imperative redraw here (keyed by clipId).
 *  Returns an unregister fn for effect cleanup. */
export function registerKeyframeSlipRedraw(clipId: number, fn: () => void): () => void {
  redrawCallbacks.set(clipId, fn);
  return () => {
    if (redrawCallbacks.get(clipId) === fn) redrawCallbacks.delete(clipId);
  };
}

/** The in-flight slip delta (frames) for `clipId`, or null if this clip
 *  isn't currently being camera-slipped. KeyframeTicks translates its
 *  in-window dots by this delta during a drag. */
export function getKeyframeSlipDelta(clipId: number): number | null {
  if (preview && preview.clipId === clipId) return preview.deltaFrames;
  return null;
}

/** Set / update the live slip preview and imperatively repaint that
 *  clip's dots. Called by the camera-slip drag on every pointermove. */
export function setKeyframeSlipPreview(clipId: number, deltaFrames: number): void {
  preview = { clipId, deltaFrames };
  const redraw = redrawCallbacks.get(clipId);
  if (redraw) redraw();
}

/** Clear the slip preview (on drag end) and repaint once more so the
 *  dots fall back to the store / echo-hold path. */
export function clearKeyframeSlipPreview(): void {
  const had = preview;
  preview = null;
  if (had) {
    const redraw = redrawCallbacks.get(had.clipId);
    if (redraw) redraw();
  }
}
