import { useRef } from 'react';
import { useStore } from '../store';
import { useElementSize } from '../useElementSize';

/** Red vertical line through the lanes. The blue triangle handle is
 *  rendered separately by the Ruler component (it needs to be clipped
 *  by the ruler's overflow, not the lanes-area). */
export function Playhead({
  lanesAreaRef,
}: {
  lanesAreaRef: React.RefObject<HTMLDivElement | null>;
}) {
  const lineRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(lanesAreaRef);
  const h = useStore((s) => s.h);
  const currentFrame = useStore((s) => s.currentFrame);
  const scrubFrame = useStore((s) => s.scrubFrame);
  const displayFrame = scrubFrame ?? currentFrame;

  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const pxPerFrame = width / visibleSpan;
  const visible = displayFrame >= h.vMin && displayFrame <= h.vMax;
  // Clamp to width-1 so the 1px line stays on-screen at the last frame.
  // Without this, x === width puts the line flush against the canvas's
  // right edge (under the Inspector) and it visually disappears.
  const x = Math.min((displayFrame - h.vMin) * pxPerFrame, Math.max(0, width - 1));

  return (
    <div
      ref={lineRef}
      className="playhead-line"
      style={{ left: x + 'px', display: visible ? '' : 'none' }}
    />
  );
}
