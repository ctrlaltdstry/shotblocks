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
 *  Mirrors Python's EDGE_HIT_PX = 24 (sb_canvas.py:217). Scales down
 *  on narrow clips via clipEdgeZonePx() below so trim zones never
 *  fully consume the clip and very narrow clips still expose a
 *  grabbable handle. Lane's edge-hover detection and useClipDrag's
 *  body-drag reserve must agree on the formula. */
export const EDGE_HIT_PX = 24;
export const EDGE_HIT_PX_FLOOR = 6;

/** Per-clip trim/roll edge-zone width, scaled to clip width.
 *  Lane's edge-hover detection and useClipDrag's body-drag reserve
 *  call this so the two stay in sync — without it they drifted apart
 *  during Round 13. */
export function clipEdgeZonePx(clipWidthPx: number): number {
  return Math.min(
    EDGE_HIT_PX,
    Math.max(EDGE_HIT_PX_FLOOR, Math.floor(clipWidthPx / 3)),
    Math.floor(clipWidthPx / 2),
  );
}

/** Minimum legal clip duration in frames. Python shipped MIN_SHOT_FRAMES=1
 *  (sb_shot_model.py:16) which was a pure data-level minimum; v2 bumps
 *  it to 8 frames because the React UI has fixed-size hit zones that
 *  need real pixel area to remain interactive. Used by resizeClip,
 *  rollEdit, splitClip, and replaceOverlap to drop trimmed remainders
 *  that would be too short to use. */
export const MIN_CLIP_FRAMES = 8;

/** Pen-tool: a click within this many media audio-frames of an
 *  existing level keyframe moves that node instead of adding a
 *  duplicate. Mirrors Python's MERGE_AF_TOL. */
export const LEVEL_MERGE_AF = 8;
