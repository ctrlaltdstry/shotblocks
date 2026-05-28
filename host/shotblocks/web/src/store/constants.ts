/** Magnetic-snap pull distance in screen pixels. Mirrors Python's
 *  SNAP_PIXEL_RADIUS = 8 (sb_canvas.py:229). Shared by every snap
 *  gesture — clip body drag, trim, roll, playhead scrub, razor — so
 *  they all feel identical. Callers convert to a frame count via the
 *  current pxPerFrame. */
export const SNAP_PIXEL_RADIUS = 8;

/** Track-headers column width bounds (px). The minimum is the
 *  original fixed width — the column can be widened, never narrowed
 *  below it. */
export const HEADERS_MIN_W = 250;
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

/** Absolute floor (px) below which a clip is body-only: too narrow to
 *  host even a scaled-down trim/roll split, so edge-area clicks fall
 *  through to body drag and the cursor never enters trim/roll mode. The
 *  clip stays selectable, draggable, and razorable. Standard NLE
 *  behaviour — Premiere/FCP/Resolve gate edge handles on width rather
 *  than auto-clamping clip duration. The clip stays geometrically
 *  truthful (1 frame = 1 frame on screen); to trim below the floor the
 *  user zooms in. Each edge zone needs ~6px to be grabbable, ×3 = 18. */
export const EDGE_INTERACTIVE_MIN_PX = 18;

/** Per-clip trim/roll edge-zone width. Scales each of the three edge
 *  thirds (trim-left / roll / trim-right) down proportionally on narrow
 *  clips — clipWidth/3, capped at the full EDGE_HIT_PX — so handles stay
 *  reachable as the clip shrinks instead of vanishing at a hard cutoff.
 *  Returns 0 (body-only) only below EDGE_INTERACTIVE_MIN_PX. */
export function clipEdgeZonePx(clipWidthPx: number): number {
  if (clipWidthPx < EDGE_INTERACTIVE_MIN_PX) return 0;
  return Math.min(EDGE_HIT_PX, clipWidthPx / 3);
}

/** Minimum clip width (px) to show the label. Distinct from edge-handle
 *  reachability: a clip can be too narrow to fit a readable label while
 *  still being wide enough to trim. Below this the label + title tooltip
 *  are hidden (NLE convention). */
export const LABEL_MIN_PX = EDGE_HIT_PX * 3;

/** Minimum clip width (px) to render the yellow edge brackets. The
 *  bracket visual is 13px wide (see .shot-block__bracket in App.css);
 *  two of them need ~2× that or they overflow past the clip body and
 *  overlap each other. Below this the brackets are hidden so a handle
 *  never renders wider than its own clip, including mid-trim. Edge
 *  *interaction* (clipEdgeZonePx) can still be active below this — the
 *  user just trims without the bracket chrome. */
export const BRACKET_MIN_PX = 26;

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
