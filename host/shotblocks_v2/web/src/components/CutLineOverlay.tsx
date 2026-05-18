import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';

/** Razor-tool cut-line preview. Vertical line spanning the ruler row
 *  and the lanes-area at the cursor X, shown when the razor tool is
 *  active and the cursor is over a clip. Lets the user see exactly
 *  which frame they'll cut on every track at once.
 *
 *  Positioned by grid into row 1 (ruler) through row 2 (stage), col 3
 *  via .cut-line-overlay. The store carries a viewport-relative
 *  clientX (set by ShotBlock pointermove); we measure the overlay's
 *  own left edge each render and subtract to get a local X for the
 *  inner line. pointer-events: none so it never blocks clicks. */
export function CutLineOverlay() {
  const activeTool = useStore((s) => s.activeTool);
  const razorHoverX = useStore((s) => s.razorHoverX);
  const ref = useRef<HTMLDivElement | null>(null);
  const [originX, setOriginX] = useState(0);
  // Measure on mount + every razorHoverX tick — cheap getBoundingClientRect.
  useLayoutEffect(() => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      if (r.left !== originX) setOriginX(r.left);
    }
  }, [razorHoverX, originX]);
  if (activeTool !== 'razor' || razorHoverX == null) return null;
  return (
    <div className="cut-line-overlay" ref={ref}>
      <div className="cut-line" style={{ left: (razorHoverX - originX) + 'px' }} />
    </div>
  );
}
