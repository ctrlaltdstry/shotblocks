// Live slip-drag preview — module-level, deliberately OUTSIDE the
// Zustand store and React.
//
// Why not the store: committing the slip to the store on every
// pointermove triggers a React re-render of the audio clip +
// WaveformCanvas. That rapid re-render is what makes WebView2 drop
// the native cursor mid-drag (verified by diagnosis: a slip whose
// move handler does nothing keeps the cursor; one that commits per
// move breaks it).
//
// So during a slip drag we keep the in-flight offset here and redraw
// the affected WaveformCanvas *imperatively* — no setState, no React
// re-render, cursor stays put. The real store commit (slipClip)
// happens once, on pointer release.

interface SlipPreview {
  clipId: number;
  offsetFrames: number;
}

let preview: SlipPreview | null = null;

/** Per-clip imperative redraw callbacks, registered by WaveformCanvas
 *  so the slip drag can repaint a specific clip's waveform without
 *  going through React. */
const redrawCallbacks = new Map<number, () => void>();

/** WaveformCanvas registers its imperative redraw here (keyed by
 *  clipId). Returns an unregister fn for effect cleanup. */
export function registerWaveformRedraw(clipId: number, fn: () => void): () => void {
  redrawCallbacks.set(clipId, fn);
  return () => {
    if (redrawCallbacks.get(clipId) === fn) redrawCallbacks.delete(clipId);
  };
}

/** The in-flight slip offset for `clipId`, or null if this clip isn't
 *  currently being slipped. WaveformCanvas.draw() uses this instead of
 *  the clip's committed `mediaOffsetFrames` during a drag. */
export function getSlipPreviewOffset(clipId: number): number | null {
  if (preview && preview.clipId === clipId) return preview.offsetFrames;
  return null;
}

/** Set / update the live slip preview and imperatively repaint that
 *  clip's waveform. Called by the slip drag on every pointermove. */
export function setSlipPreview(clipId: number, offsetFrames: number): void {
  preview = { clipId, offsetFrames };
  const redraw = redrawCallbacks.get(clipId);
  if (redraw) redraw();
}

/** Clear the slip preview (on drag end) and repaint once more so the
 *  canvas falls back to the now-committed store value. */
export function clearSlipPreview(): void {
  const had = preview;
  preview = null;
  if (had) {
    const redraw = redrawCallbacks.get(had.clipId);
    if (redraw) redraw();
  }
}
