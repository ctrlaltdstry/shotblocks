/** The V/A divider — a non-interactive visual line between the video
 *  and audio track stacks. It sits at the `vaShare` position and moves
 *  with the vertical MMB pan (which is now how the split is
 *  reapportioned — see useMmbPan). It is no longer a draggable handle.
 *
 *  Rendered in two places — the headers column and the lanes-area —
 *  both flex-positioned by the same `vaShare`, so the line reads as
 *  one continuous seam across the timeline. */
export function VaSplitter() {
  return <div className="stack__divider" />;
}
