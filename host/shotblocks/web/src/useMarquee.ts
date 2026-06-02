import { useEffect, type RefObject } from 'react';
import { useStore, isTrackLocked, keyColKey } from './store';

/** Pixel slop before pointerdown becomes a marquee drag. Below this
 *  we treat the gesture as a click (which clears selection). Matches
 *  DRAG_THRESHOLD_PX in useClipDrag. */
const DRAG_THRESHOLD_PX = 3;

/** Marquee selection on the .lanes-area. Pointer-down on the
 *  lanes-area background (NOT on a clip) starts the gesture:
 *    - drag past threshold → marquee rectangle, live updates selection
 *    - click (release before threshold) → clears selection
 *  Shift held while dragging is additive — clips inside the rect get
 *  unioned with the prior selection rather than replacing it. Mirrors
 *  Python _drag_marquee (sb_canvas_drag.py:396). */
export function useMarquee(lanesAreaRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const el = lanesAreaRef.current;
    if (!el) return;

    let active = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let baseSelection: Set<number> = new Set();
    let additive = false;
    // 'clip' = the normal background marquee (selects clips). 'keyframe' =
    // an Alt+drag started over a video clip body, which rubber-bands the
    // keyframe DOTS instead (cross-clip). Both reuse this rect machinery.
    let mode: 'clip' | 'keyframe' = 'clip';
    let baseKeyCols: Set<string> = new Set();

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      const rect = el!.getBoundingClientRect();
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        active = true;
      }
      const x0 = startX - rect.left;
      const y0 = startY - rect.top;
      useStore.getState().setMarquee({ x0, y0, x1, y1, mode });
      if (mode === 'keyframe') {
        const hits = keyDotsInRect(el!, x0, y0, x1, y1);
        const next = additive ? new Set(baseKeyCols) : new Set<string>();
        for (const k of hits) next.add(k);
        useStore.getState().setSelectedKeyColumns(next);
        return;
      }
      const hits = clipsInRect(el!, x0, y0, x1, y1);
      const next = additive ? new Set(baseSelection) : new Set<number>();
      for (const id of hits) next.add(id);
      useStore.getState().setSelectedClipIds(next);
    }

    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      const wasActive = active;
      active = false;
      pointerId = -1;
      useStore.getState().setMarquee(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      // Click (no drag): clear selection unless additive (Shift held). In
      // keyframe mode (Alt over a clip) a no-drag click is an Alt-click on
      // the clip body — don't wipe the clip selection; just leave things
      // as-is. In clip mode, an empty-canvas click deselects everything.
      if (!wasActive && !additive && mode === 'clip') {
        useStore.getState().setSelectedClipIds(new Set<number>());
        useStore.getState().setLevelKfSelection(null);
        useStore.getState().setSelectedKeyColumns(new Set<string>());
      }
      try { el!.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
    }
    function onCancel(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      active = false;
      pointerId = -1;
      useStore.getState().setMarquee(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    }

    function onDown(ev: PointerEvent) {
      if (ev.button !== 0) return;
      // Hand and Zoom tools own left-click on the canvas — Hand for
      // panning, Zoom for drag-rect zoom. Don't start a marquee while
      // either is active. (Hand-LMB pan is handled by useMmbPan
      // capture-phase; Zoom drag-rect lands in Commit 2.)
      const tool = useStore.getState().activeTool;
      if (tool === 'hand' || tool === 'zoom') return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      // Alt + press over a VIDEO clip body → keyframe-dot marquee. (A press
      // directly on a dot is handled by the dot itself, which stops the
      // event, so it never reaches here.) Plain press over a clip is the
      // clip's own drag/select — bail so we don't fight it.
      //
      // Alt+Ctrl is the RETIME combo (Alt+Ctrl+edge-drag), NOT a marquee —
      // exclude it so an Alt+Ctrl press on a clip edge doesn't also draw a
      // marquee on top of the retime. Plain Alt stays the marquee; additive
      // keyframe-marquee select uses Shift (not Ctrl).
      const videoClip = target.closest('.shot-block.is-video');
      const isRetimeCombo = ev.altKey && (ev.ctrlKey || ev.metaKey);
      if (ev.altKey && !isRetimeCombo && videoClip) {
        mode = 'keyframe';
      } else if (target.closest('.shot-block')) {
        return;
      } else if (isRetimeCombo) {
        // Alt+Ctrl over empty canvas has no meaning — don't start a clip
        // marquee either (keeps the combo exclusively a clip-edge gesture).
        return;
      } else {
        mode = 'clip';
      }
      // Reject the V/A splitter — it owns its own up/down drag. It lives
      // inside the lanes-area, and its React stopPropagation can't block
      // this native listener on an ancestor DOM node.
      if (target.closest('.stack__divider')) return;

      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      active = false;
      additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
      baseSelection = new Set(useStore.getState().selectedClipIds);
      baseKeyCols = new Set(useStore.getState().selectedKeyColumns);
      try { el!.setPointerCapture(ev.pointerId); } catch { /* noop */ }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      ev.preventDefault();
    }

    el.addEventListener('pointerdown', onDown);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [lanesAreaRef]);
}

/** Compute the set of clip ids whose rendered bounding boxes
 *  intersect the marquee rectangle. Uses DOM bounding rects so it
 *  picks up exactly what the user sees on screen regardless of zoom
 *  level or scrub state. */
function clipsInRect(
  lanesArea: HTMLElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  const rx1 = Math.min(x0, x1);
  const ry1 = Math.min(y0, y1);
  const rx2 = Math.max(x0, x1);
  const ry2 = Math.max(y0, y1);
  const areaRect = lanesArea.getBoundingClientRect();
  const hits: number[] = [];
  const clipEls = lanesArea.querySelectorAll<HTMLElement>('.shot-block[data-clip]');
  for (const clipEl of clipEls) {
    const cr = clipEl.getBoundingClientRect();
    const cx1 = cr.left - areaRect.left;
    const cy1 = cr.top  - areaRect.top;
    const cx2 = cr.right - areaRect.left;
    const cy2 = cr.bottom - areaRect.top;
    if (cx2 < rx1 || cx1 > rx2) continue;
    if (cy2 < ry1 || cy1 > ry2) continue;
    // Skip clips on a locked track — a locked track's clips can't be
    // selected (and so can't be edited via the selection).
    const laneTrack = clipEl.closest('.lane')?.getAttribute('data-track');
    if (laneTrack && isTrackLocked(laneTrack)) continue;
    const id = parseInt(clipEl.getAttribute('data-clip') || '', 10);
    if (Number.isFinite(id)) hits.push(id);
  }
  return hits;
}

/** Keyframe-dot keys ("objectId:frame") whose rendered dots intersect the
 *  marquee rectangle, across ALL clips. Reads the data-kf-obj / data-kf-
 *  frame attributes the dots carry. Locked-track clips are skipped (their
 *  keys can't be edited). */
function keyDotsInRect(
  lanesArea: HTMLElement,
  x0: number, y0: number, x1: number, y1: number,
): string[] {
  const rx1 = Math.min(x0, x1);
  const ry1 = Math.min(y0, y1);
  const rx2 = Math.max(x0, x1);
  const ry2 = Math.max(y0, y1);
  const areaRect = lanesArea.getBoundingClientRect();
  const hits: string[] = [];
  const dots = lanesArea.querySelectorAll<HTMLElement>('.keyframe-dot[data-kf-frame]');
  for (const dot of dots) {
    const dr = dot.getBoundingClientRect();
    const cx = (dr.left + dr.right) / 2 - areaRect.left;
    const cy = (dr.top + dr.bottom) / 2 - areaRect.top;
    // Hit by the dot's CENTRE — a thin strip of dots reads better when the
    // box has to actually cover the dot, not just graze its hit-pad.
    if (cx < rx1 || cx > rx2 || cy < ry1 || cy > ry2) continue;
    const laneTrack = dot.closest('.lane')?.getAttribute('data-track');
    if (laneTrack && isTrackLocked(laneTrack)) continue;
    const obj = parseInt(dot.getAttribute('data-kf-obj') || '', 10);
    const frame = parseInt(dot.getAttribute('data-kf-frame') || '', 10);
    if (Number.isFinite(obj) && Number.isFinite(frame)) hits.push(keyColKey(obj, frame));
  }
  return hits;
}
