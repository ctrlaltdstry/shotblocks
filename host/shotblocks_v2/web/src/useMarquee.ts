import { useEffect, type RefObject } from 'react';
import { useStore } from './store';

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
      useStore.getState().setMarquee({ x0, y0, x1, y1 });
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
      // Click (no drag): clear selection unless additive (Shift held).
      if (!wasActive && !additive) {
        useStore.getState().setSelectedClipIds(new Set<number>());
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
      // Reject if the pointer is over a clip — clip drag/select owns
      // its own pointerdown. We only start a marquee on bare
      // lanes-area background (or empty lane space).
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.shot-block')) return;
      // Also skip if the lanes-area itself is the click target (or a
      // lane is): both are valid marquee zones. The early-return
      // above already filtered clips and their descendants.

      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      active = false;
      additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
      baseSelection = new Set(useStore.getState().selectedClipIds);
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
    const id = parseInt(clipEl.getAttribute('data-clip') || '', 10);
    if (Number.isFinite(id)) hits.push(id);
  }
  return hits;
}
