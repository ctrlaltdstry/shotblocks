import { useStore } from '../../store';
import { setSlipPreview, clearSlipPreview } from '../../lib/slipPreview';

/** Slip drag (audio only) — self-contained: own pointer listeners, no
 *  CSS transform, commits live to the store via slipClip. The clip
 *  does NOT move on the timeline — only mediaOffsetFrames changes, so
 *  the waveform slides under a fixed clip box. Direction follows
 *  Python / Premiere: drag RIGHT → media moves backward → earlier
 *  audio plays under the clip → mediaOffsetFrames DECREASES
 *  (sb_canvas_audio.py:1788).
 *
 *  CRITICAL: during the drag we do NOT commit to the store —
 *  committing per move re-renders the audio clip + WaveformCanvas,
 *  and that React re-render is what makes WebView2 drop the native
 *  cursor mid-gesture (proven by diagnosis). Instead we push the
 *  in-flight offset to the slip-preview module, which repaints the
 *  waveform IMPERATIVELY (no React). The real slipClip commit
 *  happens once, on release. */
export function startSlipDrag(
  downEv: PointerEvent,
  el: HTMLElement,
  clipId: number,
  trackId: string,
): void {
  const laneEl = el.closest('.lane') as HTMLElement | null;
  if (!laneEl) return;
  const laneRect = laneEl.getBoundingClientRect();
  const st0 = useStore.getState();
  const span = Math.max(1, st0.h.vMax - st0.h.vMin);
  const pxPerFrame = laneRect.width / span;
  if (pxPerFrame <= 0) return;

  // Snapshot the clip's starting offset + media bounds from the
  // live store so the preview can clamp the same way slipClip does.
  let startOffset = 0;
  let clipDur = 1;
  let mediaDur = 1;
  for (const t of st0.audioTracks) {
    const c = t.clips.find((cc) => cc.id === clipId);
    if (c) {
      startOffset = c.mediaOffsetFrames ?? 0;
      clipDur = Math.max(1, c.outFrame - c.inFrame);
      mediaDur = c.mediaDurationFrames ?? clipDur;
      break;
    }
  }
  const maxOffset = Math.max(0, mediaDur - clipDur);
  const startClientX = downEv.clientX;
  const pointerId = downEv.pointerId;
  // Flag the slip so the Lane stops running edge-hover detection
  // for the duration.
  useStore.getState().setSlipDragging(true);

  function previewAt(ev: PointerEvent): number {
    const dxFrames = Math.round((ev.clientX - startClientX) / pxPerFrame);
    // Drag right → earlier audio → offset decreases. Clamp to the
    // legal window range, same as slipClip.
    const want = startOffset - dxFrames;
    return Math.max(0, Math.min(maxOffset, want));
  }
  function onSlipMove(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return;
    setSlipPreview(clipId, previewAt(ev));
  }
  function endSlip(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', onSlipMove);
    window.removeEventListener('pointerup', endSlip);
    window.removeEventListener('pointercancel', endSlip);
    // Commit the final offset to the store, clear the preview.
    const finalOffset = previewAt(ev);
    useStore.getState().slipClip(clipId, trackId, finalOffset);
    clearSlipPreview();
    useStore.getState().setSlipDragging(false);
    // Cursor: the C++ host owns it (WM_SETCURSOR subclass on the
    // C4D dialog window). useSlipCursor keeps the host's cursor
    // mode in sync with tool + pointer position — nothing to do
    // here.
  }
  window.addEventListener('pointermove', onSlipMove);
  window.addEventListener('pointerup', endSlip);
  window.addEventListener('pointercancel', endSlip);
}
