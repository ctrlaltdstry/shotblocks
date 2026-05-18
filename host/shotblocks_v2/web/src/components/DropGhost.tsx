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
  const areaRect = lanesArea.getBoundingClientRect();
  const visibleSpan = Math.max(1, h.vMax - h.vMin);

  let laneLeft = 0, laneWidth = 0, top = 0, height = 0;
  const laneEl = lanesArea.querySelector(`.lane[data-track="${dragPreview.trackId}"]`) as HTMLElement | null;

  if (laneEl) {
    const laneRect = laneEl.getBoundingClientRect();
    laneLeft = laneRect.left - areaRect.left;
    laneWidth = laneRect.width;
    top = laneRect.top - areaRect.top;
    height = laneRect.height;
  } else {
    // Spawn-target preview: the destination track doesn't exist yet
    // (the user is dragging past the outermost lane on this side).
    // Project the ghost into the slot where the new track would land
    // — directly above the topmost video lane or below the bottommost
    // audio lane — at the same height as the existing outermost lane.
    const side = dragPreview.trackId.startsWith('V') ? 'video'
               : dragPreview.trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const stackId = side === 'video' ? 'lanes-videos' : 'lanes-audios';
    const stack = lanesArea.querySelector('#' + stackId) as HTMLElement | null;
    if (!stack) return null;
    const stackRect = stack.getBoundingClientRect();
    const lanes = Array.from(stack.querySelectorAll<HTMLElement>('.lane'));
    if (!lanes.length) return null;
    // Video stack is rendered Vn..V1 top-to-bottom (outermost on top).
    // Audio stack is rendered A1..An top-to-bottom (outermost on bot).
    const outermost = side === 'video' ? lanes[0] : lanes[lanes.length - 1];
    const outerRect = outermost.getBoundingClientRect();
    laneLeft = outerRect.left - areaRect.left;
    laneWidth = outerRect.width;
    height = outerRect.height;
    if (side === 'video') {
      top = (stackRect.top - areaRect.top) - height;
    } else {
      top = stackRect.bottom - areaRect.top;
    }
  }

  const pxPerFrame = laneWidth / visibleSpan;
  const left   = laneLeft + (dragPreview.inFrame - h.vMin) * pxPerFrame;
  const width  = Math.max(2, (dragPreview.outFrame - dragPreview.inFrame) * pxPerFrame);

  return (
    <div
      className="drop-ghost"
      style={{ left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' }}
      title={dragPreview.sourceName}
    />
  );
}
