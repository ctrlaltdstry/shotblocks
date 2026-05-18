import { useRef, type CSSProperties } from 'react';
import { useElementSize } from '../useElementSize';
import type { ScrollWindow } from '../store';

export interface ScrollbarProps {
  axis: 'x' | 'y';
  window: ScrollWindow;
  /** Minimum visible span — clamp on zoom-in so the window can't collapse. */
  minSpan: number;
  /** Optional maximum visible span — clamp on zoom-out so the window
   *  can't grow beyond a useful range. Used for vertical zoom where
   *  past a certain span the lanes hit their MIN height and further
   *  zoom-out has no visual effect; capping the span keeps the
   *  scrollbar's pan/zoom math sensible. */
  maxSpan?: number;
  onChange: (vMin: number, vMax: number) => void;
  /** Optional inset for the dot center relative to the track end (in
   *  addition to the dot's radius). 0 = dot outer edge flush with the
   *  track end. */
  extraInset?: number;
  /** Flip the mapping between scrollbar position and window range.
   *  Default: thumb-top  ↔ vMin, thumb-bottom ↔ vMax.
   *  Inverted: thumb-top ↔ vMax, thumb-bottom ↔ vMin.
   *  The video stack pile is bottom-up (V1 at the bottom, V<max> at
   *  the top) so its scrollbar reads naturally only with invert=true:
   *  thumb-top maps to the visually-top track. Audio + horizontal
   *  scrollbars stay default. */
  invert?: boolean;
}

const DOT_RADIUS = 7.5;     // matches --scrollbar-end-sz / 2 (15 / 2)

export function Scrollbar({ axis, window: win, minSpan, maxSpan, onChange, extraInset = 0, invert = false }: ScrollbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(trackRef);
  const length = axis === 'x' ? width : height;

  const range = Math.max(1, win.max - win.min);
  const inset = DOT_RADIUS + extraInset;
  const usable = Math.max(1, length - inset * 2);
  // Inverted: vMax sits at the visual top/left of the track instead
  // of vMin. Each scrollbar end-dot still represents one window edge,
  // but the geometry flips so the thumb-position reads naturally.
  const lowFrac  = (win.vMin - win.min) / range;
  const highFrac = (win.vMax - win.min) / range;
  const startFrac = invert ? 1 - highFrac : lowFrac;
  const endFrac   = invert ? 1 - lowFrac  : highFrac;
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
    // Maintain max span (when provided).
    if (maxSpan != null && vMax - vMin > maxSpan) {
      const c = (vMin + vMax) / 2;
      vMin = c - maxSpan / 2;
      vMax = c + maxSpan / 2;
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
    const rawDelta = (getCoord(ev) - d.startCoord) * unitsPerPx();
    // With invert=true the visual position-to-window mapping flips,
    // so cursor delta needs to negate too — dragging the thumb DOWN
    // on an inverted bar should shift the window TOWARD vMin, not
    // away from it.
    const panSign = invert ? -1 : 1;
    let vMin = d.startMin;
    let vMax = d.startMax;
    if (d.active === 'thumb') {
      // Pan: both edges shift together.
      const dp = rawDelta * panSign;
      vMin += dp;
      vMax += dp;
    } else {
      // End-dot drag: mirrored from the window's CENTER. Dragging
      // either dot toward the center shrinks the window symmetrically
      // (zoom in); dragging away expands symmetrically (zoom out).
      //
      // The 'start' dot is always the visual top/left dot (its CSS
      // `top` / `left` is the smaller of the two). Dragging it
      // DOWN/RIGHT (rawDelta > 0) is always "toward center." The
      // 'end' dot is the bottom/right one — dragging it UP/LEFT
      // (rawDelta < 0) is "toward center."
      //
      // Either way, zoom-in = window shrinks. We don't care which
      // data edge each dot represents — the window shrinks by the
      // same amount on both sides about the midpoint.
      const towardCenter = d.active === 'start' ? rawDelta : -rawDelta;
      let nMin = d.startMin + towardCenter;
      let nMax = d.startMax - towardCenter;
      // Past-center clamp: lock to min span around the midpoint.
      if (nMax - nMin < minSpan) {
        const c = (d.startMin + d.startMax) / 2;
        nMin = c - minSpan / 2;
        nMax = c + minSpan / 2;
      }
      // Cap zoom-out at maxSpan when provided.
      if (maxSpan != null && nMax - nMin > maxSpan) {
        const c = (d.startMin + d.startMax) / 2;
        nMin = c - maxSpan / 2;
        nMax = c + maxSpan / 2;
      }
      vMin = nMin;
      vMax = nMax;
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
