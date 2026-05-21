import { useRef, type CSSProperties } from 'react';
import { useElementSize } from '../useElementSize';
import type { ScrollWindow } from '../store';

/** Minimal overlay scrollbar — a single 4px rounded thumb, pan-only.
 *
 *  Zooming is NOT done here: Alt+RMB drag zooms, MMB drag pans too.
 *  The scrollbar is purely a visible pan affordance + drag target.
 *  It renders only while the axis is zoomed in (the parent gates it);
 *  at full zoom-out there is nothing to pan and no scrollbar shows.
 *
 *  Figma node 150:1916 — grey-7 fill, 0.5px rgba(150,150,150,0.2)
 *  border, 9px radius, 4px thick. No track background, no end-dots.
 */
export interface ScrollbarProps {
  axis: 'x' | 'y';
  window: ScrollWindow;
  /** Minimum visible span — clamp so a pan can't somehow collapse it. */
  minSpan: number;
  onChange: (vMin: number, vMax: number) => void;
  /** Flip position↔window mapping. The video stack is bottom-up
   *  (V1 bottom, V<max> top), so its scrollbar reads naturally only
   *  inverted: thumb-top ↔ the visually-top track. */
  invert?: boolean;
}

export function Scrollbar({ axis, window: win, minSpan, onChange, invert = false }: ScrollbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(trackRef);
  const length = axis === 'x' ? width : height;

  const range = Math.max(1, win.max - win.min);
  const lowFrac  = (win.vMin - win.min) / range;
  const highFrac = (win.vMax - win.min) / range;
  const startFrac = invert ? 1 - highFrac : lowFrac;
  const endFrac   = invert ? 1 - lowFrac  : highFrac;
  const thumbStart = startFrac * length;
  const thumbEnd   = endFrac * length;

  const thumbStyle: CSSProperties = axis === 'x'
    ? { left: thumbStart + 'px', right: (length - thumbEnd) + 'px' }
    : { top: thumbStart + 'px', bottom: (length - thumbEnd) + 'px' };

  // Drag state in a ref — the component re-renders on every store change.
  const drag = useRef<{ active: boolean; startCoord: number; startMin: number; startMax: number }>({
    active: false, startCoord: 0, startMin: 0, startMax: 0,
  });

  function getCoord(ev: React.PointerEvent): number {
    return axis === 'x' ? ev.clientX : ev.clientY;
  }
  function unitsPerPx(): number {
    return range / Math.max(1, length);
  }
  function clampPan(vMin: number, vMax: number) {
    const span = vMax - vMin;
    if (vMin < win.min) { vMin = win.min; vMax = vMin + span; }
    if (vMax > win.max) { vMax = win.max; vMin = vMax - span; }
    if (vMin < win.min) vMin = win.min;
    if (vMax > win.max) vMax = win.max;
    return { vMin, vMax };
  }
  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    drag.current = {
      active: true,
      startCoord: getCoord(ev),
      startMin: win.vMin,
      startMax: win.vMax,
    };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d.active) return;
    // Pan: both edges shift together. invert flips cursor-delta sign so
    // dragging the thumb down on an inverted bar pans toward vMin.
    const dp = (getCoord(ev) - d.startCoord) * unitsPerPx() * (invert ? -1 : 1);
    void minSpan; // span is preserved by panning; minSpan kept for API parity
    const clamped = clampPan(d.startMin + dp, d.startMax + dp);
    onChange(clamped.vMin, clamped.vMax);
  }
  function onPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.active) return;
    drag.current.active = false;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  const trackClass = axis === 'x' ? 'scrollbar-track' : 'v-scroll__track';
  const thumbClass = axis === 'x' ? 'scrollbar-thumb' : 'v-scroll__thumb';

  return (
    <div ref={trackRef} className={trackClass}>
      <div
        className={thumbClass}
        style={thumbStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
    </div>
  );
}
