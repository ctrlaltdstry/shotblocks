import { create } from 'zustand';

export type ToolId = 'select' | 'razor' | 'pen' | 'range';
export type ClipState = 'unselected' | 'selected' | 'orphaned' | 'orphaned-selected' | 'locked';

export interface Clip {
  id: number;
  inFrame: number;
  outFrame: number;
  /** Original C4D object name for display + future reconciliation. */
  sourceName: string;
  /** C4D type ID, e.g. 5103 (Ocamera) or 1057516 (v1 rig). */
  sourceType: number;
  /** Opaque object id assigned by C++ on OM drop. Used by C++ to
   *  resolve back to the source BaseObject when the playhead enters
   *  this clip's range and the active camera must swap. 0 means "no
   *  link" — clip exists in the timeline but no source to drive
   *  camera output (orphan / file-import audio / etc.). */
  objectId: number;
  state: ClipState;
  /** Per-clip lock (independent of track lock). */
  locked: boolean;
}

export interface Track {
  id: number;
  name: string;
  clips: Clip[];
}

/** Ghost preview of an OM drop that's being hovered. Cleared on
 *  om-cancel or after om-drop creates a real clip. */
export interface DragPreview {
  trackId: string;        // e.g. 'V1' — which track the cursor is over
  inFrame: number;        // computed from cursor X
  outFrame: number;       // inFrame + duration
  sourceName: string;     // for the label inside the ghost
}

// Authoritative app state. C++ is the source of truth for fps/frame/
// docFrames; everything else (visible window, tool, V/A share, tracks)
// lives here. Components subscribe via selectors so each one only
// re-renders when its slice changes.

export interface ScrollWindow {
  min: number;
  max: number;
  vMin: number;
  vMax: number;
}

export interface State {
  // From C++
  fps: number;
  docFrames: number;
  currentFrame: number;
  playing: boolean;

  // Optimistic scrub override. When non-null, the UI renders the
  // playhead at this frame instead of currentFrame — gives instant
  // visual feedback during scrub even though C++ tick echoes lag.
  // The store still tracks currentFrame from C++; we just don't
  // *render* it while a scrub is active.
  scrubFrame: number | null;

  // Scrollbar windows (vMin..vMax visible over min..max).
  // h = horizontal time in frames.
  // vVideo / vAudio = vertical "track slot" units. Fractional values
  // allowed — vMax - vMin < 1 means a track is zoomed beyond its
  // natural height and overflows the side region.
  h: ScrollWindow;
  vVideo: ScrollWindow;
  vAudio: ScrollWindow;

  // V/A divider position (0..1, how much of the vertical body goes
  // to the video side). 0.5 = centered. Drives both the lanes stack
  // and the headers stack via flex-grow CSS vars.
  vaShare: number;

  // Currently active tool palette tool. Drives `.is-active` styling
  // and gets sent to C++ so it can drive whatever editing semantics
  // the tool implies (none wired yet).
  activeTool: ToolId;

  // Tracks. Index 0 = closest to the V/A divider (V1 / A1). New tracks
  // are added at the outer ends. Auto-create / auto-remove on clip
  // drag rather than via explicit UI buttons (see memory
  // project_v2_auto_track_lifecycle).
  videoTracks: Track[];
  audioTracks: Track[];

  // Drop ghost shown while the user is dragging from the OM. Null when
  // no drag is in progress or the drag is outside our drop targets.
  dragPreview: DragPreview | null;

  // Clip currently being dragged for reposition. Drives the .is-dragging
  // class on the source ShotBlock (z-index lift + grabbing cursor) and
  // lets the drag-from-clip path coexist with OM-drop's dragPreview.
  dragClip: { clipId: number; fromTrackId: string } | null;

  // Currently selected clip ids. Empty set = nothing selected.
  // setSelectedClip(id, additive=false) replaces; additive=true toggles
  // the id in the set (Shift/Cmd+click semantics — matches Premiere /
  // Resolve / Python's _selected_ids in sb_canvas.py).
  selectedClipIds: Set<number>;

  // Live marquee selection rectangle. Non-null while the user is
  // drawing a marquee on empty .lanes-area space. Coordinates are in
  // lanes-area-relative pixels (origin at top-left of .lanes-area).
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;

  // Per-clip edge hover. Keyed as `${clipId}:left` / `${clipId}:right`.
  // The Lane computes this on pointermove — when the cursor is at a
  // seam where two clips meet, BOTH edges land in the set so both
  // clips render their bracket (the "double" look the user expects).
  edgeHover: Set<string>;

  // Actions
  setTick: (frame: number, fps: number, playing: boolean) => void;
  setDocInfo: (fps: number, docFrames: number) => void;
  setHVisible: (vMin: number, vMax: number) => void;
  setVVideoVisible: (vMin: number, vMax: number) => void;
  setVAudioVisible: (vMin: number, vMax: number) => void;
  setVaShare: (share: number) => void;
  setActiveTool: (tool: ToolId) => void;
  setScrubFrame: (frame: number | null) => void;

  /** Append a clip to the named track (e.g. 'V1' or 'A2'). Returns
   *  the assigned clip id, or null if the track doesn't exist. */
  addClip: (trackId: string, clip: Omit<Clip, 'id'>) => number | null;

  setDragPreview: (preview: DragPreview | null) => void;
  setEdgeHover: (edges: Set<string>) => void;
  setDragClip: (drag: { clipId: number; fromTrackId: string } | null) => void;
  /** Update the selection. additive=false replaces with just `clipId`
   *  (or clears, if null). additive=true toggles `clipId` in the set
   *  (no-op when null). */
  setSelectedClip: (clipId: number | null, additive?: boolean) => void;
  /** Replace the entire selection at once. Used for marquee select or
   *  programmatic batch (Select-All, etc.). */
  setSelectedClipIds: (ids: Set<number>) => void;

  setMarquee: (rect: { x0: number; y0: number; x1: number; y1: number } | null) => void;

  /** Move an existing clip to (possibly the same) track at a desired
   *  inFrame. Uses findFreeSlot (with the moving clip excluded from
   *  collision checks) so the resulting placement never overlaps and
   *  snaps flush to nearby clip edges within SNAP_FRAMES.
   *
   *  - If `toTrackId` doesn't exist yet (e.g. 'V2' when only V1 does),
   *    a new track is spawned. Spawning is allowed only one step past
   *    the current outermost on the same side.
   *  - After moving, any non-V1/A1 track that ends up empty is culled.
   *
   *  Returns the resolved placement, or null if the move was rejected
   *  (cross-side moves are disallowed). */
  moveClip: (
    clipId: number,
    fromTrackId: string,
    toTrackId: string,
    newInFrame: number,
    snapFrames?: number,
  ) => { trackId: string; inFrame: number; outFrame: number } | null;

  /** Group move: shift every clip in `clipIds` by the same delta,
   *  with the anchor clip moving to (`anchorToTrackId`, `anchorNewInFrame`).
   *  Mirrors Python `_resolve_group_move` (sb_shot_model.py:343):
   *   - All clips move rigidly (same dx_frames, same dy_track).
   *   - Delta clamps so no clip goes below frame 0.
   *   - Non-selected clips on destination tracks get replaceOverlap'd.
   *   - Cross-side moves rejected (V↔A).
   *   - Same-track-only constraint for v2 initial cut (vertical group
   *     drag across tracks is more complex — leave for later if needed). */
  moveClips: (
    clipIds: Set<number>,
    anchorClipId: number,
    anchorFromTrackId: string,
    anchorToTrackId: string,
    anchorNewInFrame: number,
  ) => boolean;

  /** Single-edge trim. Pulls `inFrame` (edge='left') or `outFrame`
   *  (edge='right') of the clip to `wantFrame`, clamped to keep a
   *  minimum 1-frame duration. After clamping, runs replaceOverlap
   *  against same-track neighbors — extending an edge into another
   *  clip's range trims/removes the overlapped clip (Python's
   *  "replace" mode, sb_shot_model.py:_resolve_resize). Snap is
   *  applied by the caller via magneticSnap before passing `wantFrame`
   *  in; the store action itself only clamps + overlap-resolves. */
  resizeClip: (
    clipId: number,
    trackId: string,
    edge: 'left' | 'right',
    wantFrame: number,
  ) => { inFrame: number; outFrame: number } | null;

  /** Rolling edit at a seam. `leftClipId` and `rightClipId` are two
   *  adjacent clips on the same track where leftClip.outFrame ==
   *  rightClip.inFrame. The seam moves to `wantSeamFrame`, clamped so
   *  both clips keep at least 1-frame duration on each side. Mirrors
   *  the standard NLE rolling-edit behavior (no Python source —
   *  Python's drag layer never shipped it). */
  rollEdit: (
    leftClipId: number,
    rightClipId: number,
    trackId: string,
    wantSeamFrame: number,
  ) => { seamFrame: number } | null;
}

/** Monotonic clip id. Unique across all tracks for the session.
 *  Exported via accessors so persistence can read/restore it. */
let nextClipId = 1;
export function getNextClipId(): number { return nextClipId; }
export function setNextClipId(n: number): void { nextClipId = n; }

/** Place a new clip on the timeline without overlapping existing clips.
 *  Used by the OM-drop path (new clips coming in from C++), which still
 *  wants the collision-avoid + snap-flush behavior — a drop should not
 *  silently destroy an existing clip.
 *
 *  In-timeline clip drag uses `magneticSnap` + `replaceOverlap` below
 *  (Python's "replace" mode from sb_shot_model.py:_resolve_position),
 *  which IS allowed to overwrite — the user grabbed an existing clip,
 *  and overwrites are NLE convention there.
 *
 *  Snap radius is PIXEL-based at call sites (see SNAP_PIXEL_RADIUS in
 *  the legacy Python at sb_canvas.py:229 — 8px). Callers convert px →
 *  frames using the current pxPerFrame so snap feel stays constant
 *  across zoom levels. Default snapFrames=8 is only a fallback for
 *  callers that don't know the zoom.
 *
 *  outFrame is exclusive (clip occupies [inFrame, outFrame)), so two
 *  clips can share an exact frame boundary (A.outFrame === B.inFrame)
 *  with no overlap and no gap. */
const MIN_GAP_FRAMES = 0;

/** Minimum legal clip duration in frames. Anything below this becomes
 *  unusable in the UI — handles too small to grab at high zoom. Python
 *  shipped MIN_SHOT_FRAMES=1 (sb_shot_model.py:16) which was a pure
 *  data-level minimum; v2 bumps it to 8 frames because the React UI
 *  has fixed-size hit zones that need real pixel area to remain
 *  interactive. Used by resizeClip, rollEdit, and replaceOverlap to
 *  drop trimmed remainders that would be too short to use. */
export const MIN_CLIP_FRAMES = 8;
export function findFreeSlot(
  existing: Clip[],
  desiredInFrame: number,
  duration: number,
  snapFrames: number = 8,
): { inFrame: number; outFrame: number } {
  const dur = Math.max(1, duration);
  const desiredOutFrame = desiredInFrame + dur;
  const sorted = [...existing].sort((a, b) => a.inFrame - b.inFrame);

  // Snap pass: if the proposed range puts our LEFT edge within
  // snapFrames of a clip's right edge, slam it flush. If our RIGHT
  // edge is within snapFrames of a clip's left edge, slam it flush
  // there instead. Closer snap wins.
  let bestSnap: { inFrame: number; dist: number } | null = null;
  for (const c of sorted) {
    // Snap our left edge to c's right edge (c sits to our left).
    const snapLeft = c.outFrame + MIN_GAP_FRAMES;
    const dLeft = Math.abs(desiredInFrame - snapLeft);
    if (dLeft <= snapFrames && (!bestSnap || dLeft < bestSnap.dist)) {
      bestSnap = { inFrame: snapLeft, dist: dLeft };
    }
    // Snap our right edge to c's left edge (c sits to our right).
    const snapRightInFrame = c.inFrame - MIN_GAP_FRAMES - dur;
    const dRight = Math.abs(desiredOutFrame - (c.inFrame - MIN_GAP_FRAMES));
    if (dRight <= snapFrames && (!bestSnap || dRight < bestSnap.dist)) {
      bestSnap = { inFrame: snapRightInFrame, dist: dRight };
    }
  }

  // Build candidate gaps for collision check + snap validation.
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = -Infinity;
  for (const c of sorted) {
    gaps.push({ start: cursor, end: c.inFrame - MIN_GAP_FRAMES });
    cursor = c.outFrame + MIN_GAP_FRAMES;
  }
  gaps.push({ start: cursor, end: Infinity });

  function fitsInAnyGap(inF: number): boolean {
    return gaps.some((g) => inF >= g.start && inF + dur <= g.end);
  }

  // If snap target fits, use it.
  if (bestSnap && fitsInAnyGap(bestSnap.inFrame)) {
    return { inFrame: Math.max(0, bestSnap.inFrame), outFrame: Math.max(0, bestSnap.inFrame) + dur };
  }

  // Otherwise, original "nearest free gap" placement. Closest start
  // wins; clamp inside the chosen gap.
  let bestStart = desiredInFrame;
  let bestDist = Infinity;
  let placed = false;
  for (const g of gaps) {
    if (g.end - g.start < dur) continue;
    const lo = g.start;
    const hi = g.end - dur;
    const clamped = Math.max(lo, Math.min(hi, desiredInFrame));
    const dist = Math.abs(clamped - desiredInFrame);
    if (dist < bestDist) {
      bestDist = dist;
      bestStart = clamped;
      placed = true;
    }
  }
  if (!placed && sorted.length) {
    const last = sorted[sorted.length - 1];
    bestStart = last.outFrame + MIN_GAP_FRAMES;
  }
  if (bestStart < 0) bestStart = 0;
  return { inFrame: bestStart, outFrame: bestStart + dur };
}

/** Snap-only: try to align either the moving clip's left or right edge
 *  to the nearest edit point within `snapFrames`. Does NOT collision-
 *  avoid — the clip is free to overlap others; replace-overlap below
 *  resolves overlaps at release time.
 *
 *  `editPoints` is the set of magnet targets (other clips' inFrame and
 *  outFrame on the destination track, plus optional extras like the
 *  playhead and cross-track edges). Mirrors Python's
 *  `_magnetic_snap_position` in sb_shot_model.py. */
export function magneticSnap(
  desiredInFrame: number,
  duration: number,
  editPoints: number[],
  snapFrames: number,
): number {
  if (!editPoints.length || snapFrames <= 0) return desiredInFrame;
  const desiredOutFrame = desiredInFrame + duration;
  let best: { inFrame: number; dist: number } | null = null;
  for (const p of editPoints) {
    // Try aligning left edge to this point.
    const dLeft = Math.abs(desiredInFrame - p);
    if (dLeft <= snapFrames && (!best || dLeft < best.dist)) {
      best = { inFrame: p, dist: dLeft };
    }
    // Try aligning right edge to this point.
    const dRight = Math.abs(desiredOutFrame - p);
    if (dRight <= snapFrames && (!best || dRight < best.dist)) {
      best = { inFrame: p - duration, dist: dRight };
    }
  }
  return best ? best.inFrame : desiredInFrame;
}

/** Apply Python's "replace" overlap resolution to a track's clip list.
 *  Given the placed `target` clip (inFrame/outFrame), each same-track
 *  clip whose range intersects target's range is:
 *    - Dropped entirely if fully covered.
 *    - Trimmed at its trailing edge if target covers its right end.
 *    - Trimmed at its leading edge if target covers its left end.
 *    - Trimmed at its trailing edge if target sits fully inside it
 *      (matches Python's "simpler: trim trailing" choice).
 *  Mirrors `_replace_overlap` in sb_shot_model.py:409. */
export function replaceOverlap(existing: Clip[], target: { inFrame: number; outFrame: number; id: number }): Clip[] {
  const out: Clip[] = [];
  for (const s of existing) {
    if (s.id === target.id) { out.push(s); continue; }
    // No overlap (outFrame is exclusive, so equal boundaries are OK).
    if (s.outFrame <= target.inFrame || s.inFrame >= target.outFrame) {
      out.push(s);
      continue;
    }
    // Fully covered → drop.
    if (s.inFrame >= target.inFrame && s.outFrame <= target.outFrame) {
      continue;
    }
    // Partial: trim.
    if (s.inFrame < target.inFrame && s.outFrame <= target.outFrame) {
      // Trim trailing edge.
      const trimmed = { ...s, outFrame: target.inFrame };
      if (trimmed.outFrame - trimmed.inFrame >= MIN_CLIP_FRAMES) out.push(trimmed);
    } else if (s.inFrame >= target.inFrame && s.outFrame > target.outFrame) {
      // Trim leading edge.
      const trimmed = { ...s, inFrame: target.outFrame };
      if (trimmed.outFrame - trimmed.inFrame >= MIN_CLIP_FRAMES) out.push(trimmed);
    } else {
      // Target sits inside s — trim trailing (Python's simpler path).
      const trimmed = { ...s, outFrame: target.inFrame };
      if (trimmed.outFrame - trimmed.inFrame >= MIN_CLIP_FRAMES) out.push(trimmed);
    }
  }
  return out;
}

export const useStore = create<State>((set) => ({
  fps: 30,
  docFrames: 150,
  currentFrame: 0,
  playing: false,
  scrubFrame: null,
  h:      { min: 0, max: 150, vMin: 0, vMax: 150 },
  // Vertical windows: range is 2× the track count so the default
  // (centered, span = trackCount) leaves equal headroom on each side
  // for zoom-out. With 1 track: range [0, 2], default [0.5, 1.5].
  vVideo: { min: 0, max: 2,   vMin: 0.5, vMax: 1.5 },
  vAudio: { min: 0, max: 2,   vMin: 0.5, vMax: 1.5 },
  vaShare: 0.5,
  activeTool: 'select',
  videoTracks: [{ id: 1, name: 'Video 1', clips: [] }],
  audioTracks: [{ id: 1, name: 'Audio 1', clips: [] }],
  dragPreview: null,
  dragClip: null,
  selectedClipIds: new Set<number>(),
  marquee: null,
  edgeHover: new Set<string>(),

  setTick: (frame, fps, playing) => set((s) => ({
    currentFrame: frame,
    fps: fps > 0 ? fps : s.fps,
    playing,
  })),

  setScrubFrame: (frame) => set({ scrubFrame: frame }),

  setDocInfo: (fps, docFrames) => set((s) => {
    const wasFullView = s.h.vMin === s.h.min && s.h.vMax === s.h.max;
    const next: Partial<State> = {
      fps: fps > 0 ? fps : s.fps,
      docFrames,
    };
    if (wasFullView) {
      next.h = { min: 0, max: docFrames, vMin: 0, vMax: docFrames };
    } else {
      next.h = { ...s.h, max: docFrames };
    }
    return next;
  }),

  setHVisible: (vMin, vMax) => set((s) => ({
    h: { ...s.h, vMin, vMax },
  })),

  setVVideoVisible: (vMin, vMax) => set((s) => ({
    vVideo: { ...s.vVideo, vMin, vMax },
  })),

  setVAudioVisible: (vMin, vMax) => set((s) => ({
    vAudio: { ...s.vAudio, vMin, vMax },
  })),

  setVaShare: (share) => set({ vaShare: Math.max(0, Math.min(1, share)) }),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setDragPreview: (preview) => set({ dragPreview: preview }),

  setDragClip: (drag) => set({ dragClip: drag }),

  setSelectedClip: (clipId, additive = false) => set((s) => {
    if (clipId == null) {
      // Null + non-additive = clear. Null + additive = no-op.
      return additive ? s : { selectedClipIds: new Set<number>() };
    }
    if (additive) {
      const next = new Set(s.selectedClipIds);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return { selectedClipIds: next };
    }
    // Replace with just this clip.
    return { selectedClipIds: new Set([clipId]) };
  }),

  setSelectedClipIds: (ids) => set({ selectedClipIds: ids }),

  setMarquee: (rect) => set({ marquee: rect }),

  moveClip: (clipId, fromTrackId, toTrackId, newInFrame, snapFrames) => {
    const fromSide = fromTrackId.startsWith('V') ? 'video' : fromTrackId.startsWith('A') ? 'audio' : null;
    const toSide   = toTrackId.startsWith('V')   ? 'video' : toTrackId.startsWith('A')   ? 'audio' : null;
    if (!fromSide || !toSide || fromSide !== toSide) return null;
    const side = fromSide;
    const fromNum = parseInt(fromTrackId.slice(1), 10);
    const toNum   = parseInt(toTrackId.slice(1), 10);

    let result: { trackId: string; inFrame: number; outFrame: number } | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const fromIdx = tracks.findIndex((t) => t.id === fromNum);
      if (fromIdx < 0) return s;
      const moving = tracks[fromIdx].clips.find((c) => c.id === clipId);
      if (!moving) return s;
      const duration = moving.outFrame - moving.inFrame;

      // Spawn-target case: dest track doesn't exist yet. Allow only one
      // step past the current outermost track on this side (so a single
      // drag can spawn V2 from V1 but not V42 in one go).
      let working = tracks;
      if (!working.some((t) => t.id === toNum)) {
        const maxId = working.reduce((m, t) => Math.max(m, t.id), 0);
        if (toNum !== maxId + 1) return s;
        working = [...working, { id: toNum, name: (side === 'video' ? 'Video ' : 'Audio ') + toNum, clips: [] }];
      }

      // Place on dest at the cursor-derived inFrame, clamped to >= 0.
      // No collision-avoid: overlaps get resolved by replaceOverlap
      // below (Python's "replace" mode, sb_shot_model.py:_resolve_position).
      // snapFrames is unused here on commit — live preview already
      // applied snap via magneticSnap and passes the snapped value in.
      void snapFrames;
      const placedIn = Math.max(0, newInFrame);
      const placedOut = placedIn + duration;
      const movedClip: Clip = { ...moving, inFrame: placedIn, outFrame: placedOut };

      // Remove from source, replace overlaps on dest, add moved clip.
      const fromIdxNew = working.findIndex((t) => t.id === fromNum);
      const toIdxNew   = working.findIndex((t) => t.id === toNum);
      let next = working.map((t, i) => {
        if (i === fromIdxNew && i === toIdxNew) {
          // Same-track move: drop moving from list, replace-overlap
          // against the rest, then append moved clip.
          const others = t.clips.filter((c) => c.id !== clipId);
          const after = replaceOverlap(others, { id: clipId, inFrame: placedIn, outFrame: placedOut });
          return { ...t, clips: [...after, movedClip] };
        }
        if (i === fromIdxNew) {
          return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
        }
        if (i === toIdxNew) {
          const after = replaceOverlap(t.clips, { id: clipId, inFrame: placedIn, outFrame: placedOut });
          return { ...t, clips: [...after, movedClip] };
        }
        return t;
      });

      // Cull non-base tracks that ended up empty (id > 1).
      next = next.filter((t) => t.id === 1 || t.clips.length > 0);

      result = { trackId: toTrackId, inFrame: placedIn, outFrame: placedOut };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  resizeClip: (clipId, trackId, edge, wantFrame) => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    let result: { inFrame: number; outFrame: number } | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const trackIdx = tracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      const clip = tracks[trackIdx].clips.find((c) => c.id === clipId);
      if (!clip) return s;
      let newIn = clip.inFrame;
      let newOut = clip.outFrame;
      if (edge === 'left') {
        newIn = Math.max(0, Math.min(wantFrame, clip.outFrame - MIN_CLIP_FRAMES));
      } else {
        newOut = Math.max(clip.inFrame + MIN_CLIP_FRAMES, wantFrame);
      }
      if (newIn === clip.inFrame && newOut === clip.outFrame) {
        result = { inFrame: newIn, outFrame: newOut };
        return s;
      }
      const target = { id: clipId, inFrame: newIn, outFrame: newOut };
      const resized: Clip = { ...clip, inFrame: newIn, outFrame: newOut };
      const next = tracks.map((t, i) => {
        if (i !== trackIdx) return t;
        const others = t.clips.filter((c) => c.id !== clipId);
        const after = replaceOverlap(others, target);
        return { ...t, clips: [...after, resized] };
      });
      result = { inFrame: newIn, outFrame: newOut };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  moveClips: (clipIds, anchorClipId, anchorFromTrackId, anchorToTrackId, anchorNewInFrame) => {
    const fromSide = anchorFromTrackId.startsWith('V') ? 'video' : anchorFromTrackId.startsWith('A') ? 'audio' : null;
    const toSide   = anchorToTrackId.startsWith('V')   ? 'video' : anchorToTrackId.startsWith('A')   ? 'audio' : null;
    if (!fromSide || !toSide || fromSide !== toSide) return false;
    const side = fromSide;
    const anchorFromNum = parseInt(anchorFromTrackId.slice(1), 10);
    const anchorToNum   = parseInt(anchorToTrackId.slice(1),   10);
    let ok = false;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      // Locate the anchor and gather every selected clip's current
      // (trackId, inFrame, outFrame).
      type Loc = { id: number; trackNum: number; inFrame: number; outFrame: number };
      const selectedLocs: Loc[] = [];
      let anchorLoc: Loc | null = null;
      for (const t of tracks) {
        for (const c of t.clips) {
          if (!clipIds.has(c.id)) continue;
          const loc: Loc = { id: c.id, trackNum: t.id, inFrame: c.inFrame, outFrame: c.outFrame };
          selectedLocs.push(loc);
          if (c.id === anchorClipId) anchorLoc = loc;
        }
      }
      if (!anchorLoc || selectedLocs.length === 0) return s;
      // Frame and track deltas inferred from the anchor's move.
      let dxFrames = anchorNewInFrame - anchorLoc.inFrame;
      const dtTrack = anchorToNum - anchorFromNum;
      // Clamp so no selected clip goes below frame 0.
      const minIn = Math.min(...selectedLocs.map((l) => l.inFrame));
      if (minIn + dxFrames < 0) dxFrames = -minIn;
      if (dxFrames === 0 && dtTrack === 0) {
        ok = true;
        return s;
      }
      // Spawn destination tracks if needed (each target track number
      // must exist or be spawned — but only one step past current max,
      // matching moveClip's rule). For group drag we relax this: any
      // selected clip can land on an existing track OR a freshly
      // spawned one — but we only spawn ONE new track per side per
      // call, the highest needed.
      const targetTrackNums = new Set(selectedLocs.map((l) => l.trackNum + dtTrack));
      let working = tracks;
      const existingIds = new Set(working.map((t) => t.id));
      const maxId = working.reduce((m, t) => Math.max(m, t.id), 0);
      for (const num of targetTrackNums) {
        if (num < 1) return s;                    // can't go below V1/A1
        if (existingIds.has(num)) continue;
        if (num !== maxId + 1) return s;          // only one-step spawn allowed
        working = [...working, { id: num, name: (side === 'video' ? 'Video ' : 'Audio ') + num, clips: [] }];
        existingIds.add(num);
      }
      // Build moved-clip list keyed by id for fast lookup.
      const movedById = new Map<number, { id: number; newTrackNum: number; inFrame: number; outFrame: number }>();
      for (const loc of selectedLocs) {
        movedById.set(loc.id, {
          id: loc.id,
          newTrackNum: loc.trackNum + dtTrack,
          inFrame: loc.inFrame + dxFrames,
          outFrame: loc.outFrame + dxFrames,
        });
      }
      // Rebuild each track:
      //  1. Remove selected clips that originated here.
      //  2. Add selected clips whose destination is here.
      //  3. replaceOverlap with each new arrival against non-selected
      //     clips already on this track (selected clips don't collide
      //     with each other — rigid shift preserves their original
      //     non-overlapping layout).
      const next = working.map((t) => {
        const survivors = t.clips.filter((c) => !clipIds.has(c.id));
        const arrivals: Clip[] = [];
        for (const moved of movedById.values()) {
          if (moved.newTrackNum !== t.id) continue;
          // Find original clip to clone (preserve sourceName etc.).
          let orig: Clip | undefined;
          for (const tt of tracks) {
            const f = tt.clips.find((c) => c.id === moved.id);
            if (f) { orig = f; break; }
          }
          if (!orig) continue;
          arrivals.push({ ...orig, inFrame: moved.inFrame, outFrame: moved.outFrame });
        }
        let combined = survivors;
        for (const a of arrivals) {
          combined = replaceOverlap(combined, { id: a.id, inFrame: a.inFrame, outFrame: a.outFrame });
          combined = [...combined, a];
        }
        return { ...t, clips: combined };
      }).filter((t) => t.id === 1 || t.clips.length > 0);

      ok = true;
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return ok;
  },

  rollEdit: (leftClipId, rightClipId, trackId, wantSeamFrame) => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    let result: { seamFrame: number } | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const trackIdx = tracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      const left  = tracks[trackIdx].clips.find((c) => c.id === leftClipId);
      const right = tracks[trackIdx].clips.find((c) => c.id === rightClipId);
      if (!left || !right) return s;
      // Clamp the seam between the two clips' OUTER edges, keeping
      // MIN_CLIP_FRAMES on each side. The seam can move anywhere in
      // [left.inFrame + MIN_CLIP_FRAMES, right.outFrame - MIN_CLIP_FRAMES].
      const minSeam = left.inFrame + MIN_CLIP_FRAMES;
      const maxSeam = right.outFrame - MIN_CLIP_FRAMES;
      const seam = Math.max(minSeam, Math.min(maxSeam, wantSeamFrame));
      if (seam === left.outFrame) {
        result = { seamFrame: seam };
        return s;
      }
      const next = tracks.map((t, i) => {
        if (i !== trackIdx) return t;
        return {
          ...t,
          clips: t.clips.map((c) => {
            if (c.id === leftClipId)  return { ...c, outFrame: seam };
            if (c.id === rightClipId) return { ...c, inFrame:  seam };
            return c;
          }),
        };
      });
      result = { seamFrame: seam };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  setEdgeHover: (edges) => set((s) => {
    // Cheap identity check so we don't churn renders when the set
    // didn't actually change.
    if (s.edgeHover.size === edges.size) {
      let same = true;
      for (const k of edges) if (!s.edgeHover.has(k)) { same = false; break; }
      if (same) return s;
    }
    return { edgeHover: edges };
  }),

  addClip: (trackId, clip) => {
    const id = nextClipId++;
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const num = parseInt(trackId.slice(1), 10);
    let added: number | null = null;
    set((s) => {
      const list = side === 'video' ? s.videoTracks : s.audioTracks;
      const idx = list.findIndex((t) => t.id === num);
      if (idx < 0) return s;
      const track = list[idx];
      // Find a non-overlapping placement closest to the requested
      // inFrame. Clips never overlap; a minimum 1-frame data gap is
      // enforced so even back-to-back placements render with the
      // 2px CSS gap intact.
      const placed = findFreeSlot(
        track.clips,
        clip.inFrame,
        clip.outFrame - clip.inFrame,
      );
      const newClip = { id, ...clip, inFrame: placed.inFrame, outFrame: placed.outFrame };
      const newTracks = list.map((t, i) => i === idx
        ? { ...t, clips: [...t.clips, newClip] }
        : t);
      added = id;
      return side === 'video'
        ? { videoTracks: newTracks }
        : { audioTracks: newTracks };
    });
    return added;
  },
}));
