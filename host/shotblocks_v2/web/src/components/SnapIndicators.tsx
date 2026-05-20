import { useRef } from 'react';
import { useStore } from '../store';
import { useElementSize } from '../useElementSize';

/** Yellow vertical indicator lines drawn while a drag is in flight and
 *  the moved clip's edge has been pulled to one or more edit points by
 *  magnetic snap. Mirrors Python's `_snap_indicator_frames` rendering
 *  (sb_canvas.py:1630-1638, COL_SNAP_INDICATOR = "#ffd60a").
 *
 *  Spans ruler row (row 1) + stage (row 2), col 3, so the line reads
 *  on every track AND through the ruler — matches the Python canvas
 *  which paints from y=0 to y=canvas_height. pointer-events: none. */
export function SnapIndicators() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(wrapRef);
  const h = useStore((s) => s.h);
  const frames = useStore((s) => s.snapIndicatorFrames);

  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const pxPerFrame = width / visibleSpan;

  return (
    <div className="snap-indicators-overlay" ref={wrapRef}>
      {frames.map((f) => {
        if (f < h.vMin || f > h.vMax) return null;
        const x = (f - h.vMin) * pxPerFrame;
        return <div key={f} className="snap-indicator-line" style={{ left: x + 'px' }} />;
      })}
    </div>
  );
}
