/** Pixel slop before a pointerdown becomes a real drag. Below this we
 *  treat it as a click (selection, later). */
export const DRAG_THRESHOLD_PX = 3;

/** Live state of an in-flight clip body drag. Kept in a ref (not React
 *  state) so updates don't trigger re-renders during the drag. The
 *  hook reads + mutates this on every pointermove. */
export interface DragRef {
  active: boolean;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startInFrame: number;
  startOutFrame: number;
  pxPerFrame: number;
  // The track + frame the live preview currently resolves to. Read on
  // release to commit the move via moveClip().
  previewTrackId: string;
  previewInFrame: number;
  // The clip's CURRENT track id in the store. Differs from `trackId`
  // (closure-captured original track) after a cross-track live-ripple
  // commit migrated the clip. Used as `fromTrackId` for the next
  // ripple commit so moveClip can locate the moving clip.
  currentTrackId: string;
  // dx/dy applied as a CSS transform on the clip element each move.
  // Stored so we can clear on cancel/end. lastDx is the latest
  // horizontal target (cursor-driven, written direct). lastDy is the
  // VERTICAL TARGET — the value the clip is heading toward — and may
  // differ from animatedDy mid-glide. animatedDy is what's actually
  // written to the element; gsap tweens it toward lastDy whenever a
  // track-change makes lastDy jump, giving the clip a smooth ~180ms
  // ease.out vertical glide between lanes.
  lastDx: number;
  lastDy: number;
  animatedDy: number;
  // Live Shift state. Read on every pointermove so the user can
  // toggle ripple on/off mid-drag (Premiere/Resolve UX). When the
  // mode flips, we re-anchor startClientX + startInFrame to the
  // current pointer + the dragged clip's live position so each
  // mode's delta math stays coherent across the toggle. Neighbors
  // that ripple already pushed stay pushed (user-confirmed UX call).
  //
  // Group drag ignores this — Python falls back to replace for groups
  // (sb_shot_model.py:356) and v2 mirrors that.
  rippleMode: boolean;
  // Group drag: if non-null, the drag moves every clip in this set
  // together. The anchor (= clip.id) drives snap targeting. Group
  // drags commit LIVE via moveClips on every pointermove (no CSS
  // transform), so all selected clips visually follow each other.
  groupIds: Set<number> | null;
}
