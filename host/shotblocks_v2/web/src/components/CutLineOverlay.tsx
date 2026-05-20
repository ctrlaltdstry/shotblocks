import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';

/** Razor-tool cut-line preview. Vertical line spanning the ruler row
 *  and the lanes-area at the cursor X, shown when the razor tool is
 *  active and the cursor is over a clip. Lets the user see exactly
 *  which frame they'll cut on every track at once.
 *
 *  Two layers:
 *   - `.cut-line` — faint full-height line over the whole timeline.
 *   - `.cut-line__active` — a brighter, thicker yellow segment over
 *     just the hovered clip's vertical extent. This is the part of
 *     the line that will actually slice, so it gets a distinct
 *     treatment (the rest of the line is only a frame reference).
 *
 *  Positioned by grid into row 1 (ruler) through row 2 (stage), col 3
 *  via .cut-line-overlay. The store carries a viewport-relative
 *  clientX + the hovered clip's viewport Y band; we measure the
 *  overlay's own top-left each render and subtract to get local
 *  coords. pointer-events: none so it never blocks clicks. */
export function CutLineOverlay() {
  const activeTool = useStore((s) => s.activeTool);
  const razorHoverX = useStore((s) => s.razorHoverX);
  const razorHoverClipBand = useStore((s) => s.razorHoverClipBand);
  const ref = useRef<HTMLDivElement | null>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  // Measure on mount + every hover tick — cheap getBoundingClientRect.
  useLayoutEffect(() => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      if (r.left !== origin.x || r.top !== origin.y) {
        setOrigin({ x: r.left, y: r.top });
      }
    }
  }, [razorHoverX, razorHoverClipBand, origin.x, origin.y]);
  if (activeTool !== 'razor' || razorHoverX == null) return null;
  const localX = razorHoverX - origin.x;
  return (
    <div className="cut-line-overlay" ref={ref}>
      <div className="cut-line" style={{ left: localX + 'px' }} />
      {razorHoverClipBand && (
        <div
          className="cut-line__active"
          style={{
            left: localX + 'px',
            top: (razorHoverClipBand.top - origin.y) + 'px',
            height: (razorHoverClipBand.bottom - razorHoverClipBand.top) + 'px',
          }}
        />
      )}
    </div>
  );
}
