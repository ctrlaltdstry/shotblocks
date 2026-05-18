import { useStore } from '../store';

/** Marquee selection rectangle. 1px primary-highlight-blue outline,
 *  drawn in lanes-area-relative coordinates. Only renders while the
 *  user is actively dragging. */
export function MarqueeOverlay() {
  const m = useStore((s) => s.marquee);
  if (!m) return null;
  const left   = Math.min(m.x0, m.x1);
  const top    = Math.min(m.y0, m.y1);
  const width  = Math.abs(m.x1 - m.x0);
  const height = Math.abs(m.y1 - m.y0);
  return (
    <div
      className="marquee-rect"
      style={{ left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' }}
    />
  );
}
