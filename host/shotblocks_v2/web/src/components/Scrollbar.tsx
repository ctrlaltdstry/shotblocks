import { useRef, type CSSProperties } from 'react';
import { useElementSize } from '../useElementSize';
import type { ScrollWindow } from '../store';

export interface ScrollbarProps {
  axis: 'x' | 'y';
  window: ScrollWindow;
  /** Minimum visible span — clamp on zoom-in so the window can't collapse. */
  minSpan: number;
  onChange: (vMin: number, vMax: number) => void;
  /** Optional inset for the dot center relative to the track end (in
   *  addition to the dot's radius). 0 = dot outer edge flush with the
   *  track end. */
  extraInset?: number;
}

const DOT_RADIUS = 7.5;     // matches --scrollbar-end-sz / 2 (15 / 2)

export function Scrollbar({ axis, window: win, minSpan, onChange, extraInset = 0 }: ScrollbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(trackRef);
  const length = axis === 'x' ? width : height;

  const range = Math.max(1, win.max - win.min);
  const inset = DOT_RADIUS + extraInset;
  const usable = Math.max(1, length - inset * 2);
  const startFrac = (win.vMin - win.min) / range;
  const endFrac = (win.vMax - win.min) / range;
  const dotStart = inset + startFrac * usable;
  const dotEnd = inset + endFrac * usable;
  const thumbStart = Math.max(0, dotStart - DOT_RADIUS);
  const thumbEnd = Math.min(length, dotEnd + DOT_RADIUS);

  const thumbStyle: CSSProperties = axis === 'x'
    ? { left: thumbStart + 'px', right: (length - thumbEnd) + 'px' }
    : { top: thumbStart + 'px', bottom: (length - thumbEnd) + 'px' };
  const dotStartStyle: CSSProperties = axis === 'x' ? { left: dotStart + 'px' } : { top: dotStart + 'px' };
  const dotEndStyle: CSSProperties = axis === 'x' ? { left: dotEnd + 'px' } : { top: dotEnd + 'px' };

  // Shared drag state for thumb + both end-dots. Lives in a ref because
  // the component re-renders on every store change.
  const drag = useRef<{ active: 'thumb' | 'start' | 'end' | null; startCoord: number; startMin: number; startMax: number }>({
    active: null, startCoord: 0, startMin: 0, startMax: 0,
  });

  function getCoord(ev: React.PointerEvent): number {
    return axis === 'x' ? ev.clientX : ev.clientY;
  }
  function unitsPerPx(): number {
    return range / usable;
  }
  function clamp(vMin: number, vMax: number) {
    // Maintain min span; clamp to range.
    if (vMax - vMin < minSpan) {
      const c = (vMin + vMax) / 2;
      vMin = c - minSpan / 2;
      vMax = c + minSpan / 2;
    }
    if (vMin < win.min) { vMax += win.min - vMin; vMin = win.min; }
    if (vMax > win.max) { vMin -= vMax - win.max; vMax = win.max; }
    if (vMin < win.min) vMin = win.min;
    if (vMax > win.max) vMax = win.max;
    return { vMin, vMax };
  }
  function start(which: 'thumb' | 'start' | 'end') {
    return (ev: React.PointerEvent<HTMLDivElement>) => {
      if (ev.button !== 0) return;
      drag.current = {
        active: which,
        startCoord: getCoord(ev),
        startMin: win.vMin,
        startMax: win.vMax,
      };
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* noop */ }
      ev.preventDefault();
      ev.stopPropagation();
    };
  }
  function move(ev: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d.active) return;
    const deltaUnits = (getCoord(ev) - d.startCoord) * unitsPerPx();
    let vMin = d.startMin;
    let vMax = d.startMax;
    if (d.active === 'thumb') {
      // Pan: both edges shift together.
      vMin += deltaUnits;
      vMax += deltaUnits;
    } else if (d.active === 'start') {
      // Top/left dot moves with the cursor. Visible window shrinks
      // from the top.
      vMin += deltaUnits;
      if (vMin > vMax - minSpan) vMin = vMax - minSpan;
    } else {
      // Bottom/right dot moves with the cursor. Window shrinks from
      // the bottom.
      vMax += deltaUnits;
      if (vMax < vMin + minSpan) vMax = vMin + minSpan;
    }
    const clamped = clamp(vMin, vMax);
    onChange(clamped.vMin, clamped.vMax);
  }
  function end(ev: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.active) return;
    drag.current.active = null;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  const trackClass = axis === 'x' ? 'scrollbar-track' : 'v-scroll__track';
  const thumbClass = axis === 'x' ? 'scrollbar-thumb' : 'v-scroll__thumb';
  const endClass = axis === 'x' ? 'scrollbar-end' : 'v-scroll__end';

  return (
    <div ref={trackRef} className={trackClass}>
      <div
        className={thumbClass}
        style={thumbStyle}
        onPointerDown={start('thumb')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className={endClass}
        style={dotStartStyle}
        onPointerDown={start('start')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className={endClass}
        style={dotEndStyle}
        onPointerDown={start('end')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  );
}
