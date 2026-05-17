import { useStore } from '../store';

/** Drop ghost overlay. Rendered as a sibling of the lane stack inside
 *  .lanes-area so its blue glow is not clipped by an individual lane's
 *  overflow:hidden. Position is computed by looking up the target
 *  lane's rect on every render (cheap; only renders when dragging). */
export function DropGhost({
  lanesAreaRef,
}: {
  lanesAreaRef: React.RefObject<HTMLDivElement | null>;
}) {
  const dragPreview = useStore((s) => s.dragPreview);
  const h = useStore((s) => s.h);
  if (!dragPreview) return null;

  const lanesArea = lanesAreaRef.current;
  if (!lanesArea) return null;
  const laneEl = lanesArea.querySelector(`.lane[data-track="${dragPreview.trackId}"]`) as HTMLElement | null;
  if (!laneEl) return null;

  const areaRect = lanesArea.getBoundingClientRect();
  const laneRect = laneEl.getBoundingClientRect();
  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const pxPerFrame = laneRect.width / visibleSpan;
  const left   = (laneRect.left - areaRect.left) + (dragPreview.inFrame - h.vMin) * pxPerFrame;
  const width  = Math.max(2, (dragPreview.outFrame - dragPreview.inFrame) * pxPerFrame);
  const top    = laneRect.top - areaRect.top;
  const height = laneRect.height;

  return (
    <div
      className="drop-ghost"
      style={{ left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' }}
      title={dragPreview.sourceName}
    />
  );
}
