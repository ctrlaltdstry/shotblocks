/** Magnetic-snap pull distance in screen pixels. Mirrors Python's
 *  SNAP_PIXEL_RADIUS = 8 (sb_canvas.py:229). Shared by every snap
 *  gesture — clip body drag, trim, roll, playhead scrub, razor — so
 *  they all feel identical. Callers convert to a frame count via the
 *  current pxPerFrame. */
export const SNAP_PIXEL_RADIUS = 8;

/** Track-headers column width bounds (px). The minimum is the
 *  original fixed width — the column can be widened, never narrowed
 *  below it. */
export const HEADERS_MIN_W = 200;
export const HEADERS_MAX_W = 600;

/** Natural / floor lane heights (px). Video tracks render at the
 *  natural height (fixed); audio tracks zoom between natural and the
 *  floor. Below the floor the icon-above-label header layout stops
 *  being readable. */
export const NATURAL_TRACK_PX = 65;
export const MIN_TRACK_PX = 48;

/** Pixel hit zone at each clip edge that is reserved for trim / roll.
 *  Mirrors Python's EDGE_HIT_PX = 24 (sb_canvas.py:217). Lane's
 *  edge-hover detection and useClipDrag's body-drag reserve must agree
 *  on the formula — both route through clipEdgeZonePx() below. */
export const EDGE_HIT_PX = 24;

/** Minimum pixel width at which a clip exposes trim/roll edge zones.
 *  3 × EDGE_HIT_PX = the seam-overlap model (trim-left / roll / trim-
 *  right thirds) needs at least one full edge-zone per third to stay
 *  reachable. Below this, the clip is body-only: edge-area clicks fall
 *  through to body drag, the cursor never enters trim/roll mode, and
 *  the clip is still selectable, draggable, and razorable. Standard
 *  NLE behaviour — Premiere/FCP/Resolve all gate edge handles on a
 *  pixel threshold rather than auto-clamping clip width. The clip
 *  itself stays geometrically truthful (1 frame = 1 frame on screen);
 *  to trim a too-narrow clip the user zooms in. */
export const EDGE_INTERACTIVE_MIN_PX = EDGE_HIT_PX * 3;

/** Per-clip trim/roll edge-zone width. Returns the full EDGE_HIT_PX
 *  when the clip is wide enough to host all three modes, otherwise 0
 *  to disable edge affordance entirely (body-only mode). */
export function clipEdgeZonePx(clipWidthPx: number): number {
  if (clipWidthPx < EDGE_INTERACTIVE_MIN_PX) return 0;
  return EDGE_HIT_PX;
}

/** Minimum legal clip duration in frames. Mirrors Python's
 *  MIN_SHOT_FRAMES=1 (sb_shot_model.py:16) — a pure data-level minimum.
 *  Below-threshold pixel width is handled separately by clipEdgeZonePx
 *  above (clip becomes body-only; user zooms in to access edge handles).
 *  Used by resizeClip, rollEdit, splitClip, and replaceOverlap to drop
 *  trimmed remainders that would be degenerate. */
export const MIN_CLIP_FRAMES = 1;

/** Pen-tool: a click within this many media audio-frames of an
 *  existing level keyframe moves that node instead of adding a
 *  duplicate. Mirrors Python's MERGE_AF_TOL. */
export const LEVEL_MERGE_AF = 8;
