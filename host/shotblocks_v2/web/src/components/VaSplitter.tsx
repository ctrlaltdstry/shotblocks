import { useRef } from 'react';
import { useStore } from '../store';

const SNAP_PX = 6;

/** Draggable V/A divider. Used in 3 places — headers column,
 *  lanes-area, v-gutter — all share the same `vaShare` store value so
 *  hovering or dragging any one of them updates all. */
export function VaSplitter({
  /** Ref to the parent stack element. Used to derive the available
   *  height (the stack's height) for percentage math. */
  stackRef,
  /** Ref to the videos side element, for the drag start measurement. */
  videosRef,
}: {
  stackRef: React.RefObject<HTMLDivElement | null>;
  videosRef: React.RefObject<HTMLDivElement | null>;
}) {
  const setVaShare = useStore((s) => s.setVaShare);
  const drag = useRef({
    active: false,
    startClientY: 0,
    startVideoPx: 0,
    regionPx: 0,
  });

  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    const divider = ev.currentTarget;
    const stack = stackRef.current;
    const videos = videosRef.current;
    if (!stack || !videos) return;
    const dividerRect = divider.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    drag.current = {
      active: true,
      startClientY: ev.clientY,
      startVideoPx: videos.getBoundingClientRect().height,
      regionPx: Math.max(1, stackRect.height - dividerRect.height),
    };
    setHover(true);
    try { divider.setPointerCapture(ev.pointerId); } catch { /* noop */ }
    ev.preventDefault();
  }
  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d.active) return;
    let videoPx = d.startVideoPx + (ev.clientY - d.startClientY);
    videoPx = Math.max(0, Math.min(d.regionPx, videoPx));
    // Snap to dead center within SNAP_PX.
    const center = d.regionPx / 2;
    if (Math.abs(videoPx - center) <= SNAP_PX) videoPx = center;
    setVaShare(videoPx / d.regionPx);
  }
  function onPointerEnd(ev: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.active) return;
    drag.current.active = false;
    setHover(false);
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  }

  return (
    <div
      className="stack__divider is-grabbable"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => { if (!drag.current.active) setHover(false); }}
    />
  );
}

// Shared "any splitter is hovered" class on body. Used by CSS to light
// up ALL the splitter spans together rather than just the one under
// the cursor — the V/A seam should read as one continuous handle.
function setHover(on: boolean) {
  document.body.classList.toggle('va-splitter-hover', on);
}
