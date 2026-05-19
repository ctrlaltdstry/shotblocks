import { useStore } from '../store';

/** Dim overlay outside the play range. Renders two translucent-black
 *  strips spanning the full vertical height of the timeline column
 *  (ruler + lanes), one from the doc start to playRangeIn, another
 *  from playRangeOut to doc end. Pointer-events transparent so the
 *  user can still scrub, drag clips, and interact with everything
 *  underneath.
 *
 *  Hidden when the range covers the entire doc (no play-range-defined
 *  state, matches the Figma "no play range" visual). */
export function RangeDim() {
  const h = useStore((s) => s.h);
  const playRangeIn  = useStore((s) => s.playRangeIn);
  const playRangeOut = useStore((s) => s.playRangeOut);
  const docFrames    = useStore((s) => s.docFrames);

  const rangeIsFullDoc = playRangeIn <= 0 && playRangeOut >= docFrames;
  if (rangeIsFullDoc) return null;

  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  // Use percentages so the overlay tracks the timeline column's width
  // regardless of resize or pan.
  function pct(frame: number): number {
    return ((frame - h.vMin) / visibleSpan) * 100;
  }
  const inPct  = pct(playRangeIn);
  const outPct = pct(playRangeOut);

  return (
    <>
      {inPct > 0 && (
        <div
          className="range-dim range-dim--left"
          style={{ left: 0, width: `${Math.min(100, inPct)}%` }}
        />
      )}
      {outPct < 100 && (
        <div
          className="range-dim range-dim--right"
          style={{ left: `${Math.max(0, outPct)}%`, right: 0 }}
        />
      )}
    </>
  );
}
