import type { Clip, Track } from './types';
import { MIN_CLIP_FRAMES } from './constants';

/** Apply `fn` to the audio clip with id `clipId` wherever it lives.
 *  Returns a fresh audioTracks array, or null if the clip wasn't
 *  found — callers fall back to the unchanged state. Used by every
 *  level-keyframe action to surgically rewrite one clip. */
export function patchAudioClip(
  audioTracks: Track[],
  clipId: number,
  fn: (clip: Clip) => Clip,
): Track[] | null {
  let found = false;
  const next = audioTracks.map((t) => {
    if (!t.clips.some((c) => c.id === clipId)) return t;
    found = true;
    return { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) };
  });
  return found ? next : null;
}

/** Subset of State the audio-lines helpers need — keeps this file
 *  free of any direct dependency on the full store State type. */
export interface AudioLinesStateLike {
  fps: number;
  audioTracks: Track[];
}

export interface TracksStateLike {
  videoTracks: Track[];
  audioTracks: Track[];
}

/** Subset of State `cameraKeyframeSnapFrames` needs — the video tracks
 *  (to know which cameras are in play) and the per-camera key times. */
export interface CameraKeysStateLike {
  videoTracks: Track[];
  cameraKeyTimes: Map<number, number[]>;
}

const MIN_GAP_FRAMES = 0;

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
export function findFreeSlot(
  existing: Clip[],
  desiredInFrame: number,
  duration: number,
  snapFrames: number = 8,
  // Lowest legal inFrame — the document floor. Absolute frames mean this
  // is docMin (can be negative; v2 mirrors C4D's ruler), not 0.
  floorFrame: number = 0,
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
    const inF = Math.max(floorFrame, bestSnap.inFrame);
    return { inFrame: inF, outFrame: inF + dur };
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
  if (bestStart < floorFrame) bestStart = floorFrame;
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
 *  `_magnetic_snap_position` in sb_shot_model.py.
 *
 *  Returns `{ inFrame, targets }`. `targets` is the edit point(s) the
 *  snapped clip's left/right edge landed on — used by the canvas to
 *  draw yellow snap-indicator lines. Empty when no snap occurred. */
export function magneticSnap(
  desiredInFrame: number,
  duration: number,
  editPoints: number[],
  snapFrames: number,
): { inFrame: number; targets: number[] } {
  if (!editPoints.length || snapFrames <= 0) {
    return { inFrame: desiredInFrame, targets: [] };
  }
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
  if (!best) return { inFrame: desiredInFrame, targets: [] };
  // Report every edit point the snapped clip's left OR right edge
  // lands on, so the canvas can draw an indicator at each. Mirrors
  // Python `_magnetic_snap_position` (sb_shot_model.py:184).
  const snappedIn  = best.inFrame;
  const snappedOut = snappedIn + duration;
  const targets: number[] = [];
  if (editPoints.includes(snappedIn)) targets.push(snappedIn);
  if (snappedOut !== snappedIn && editPoints.includes(snappedOut)) {
    targets.push(snappedOut);
  }
  return { inFrame: snappedIn, targets };
}

/** Apply Python's "ripple" overlap resolution to a track's clip list.
 *  Push same-track shots later (or earlier) so target's range is clear,
 *  preserving each pushed shot's duration. Ports `_ripple_around` from
 *  sb_shot_model.py:296.
 *
 *  Direction policy: push-right is tried first; only if no clip got
 *  pushed right does it try pushing earlier clips left. So ripple is
 *  biased toward shoving forward in time, matching Python.
 *
 *  v2 simplification: Python uses `out + 1 + CLIP_GAP_FRAMES` for the
 *  next clip's allowed inFrame and `in - 1 - CLIP_GAP_FRAMES` for the
 *  previous clip's allowed outFrame. With v2's exclusive outFrame and
 *  CLIP_GAP_FRAMES=0, those reduce to `outFrame` and `inFrame`.
 *
 *  Group ripple is intentionally NOT supported here — Python falls
 *  back to replace for groups (sb_shot_model.py:356), so v2 does too.
 */
export function rippleAround(
  existing: Clip[],
  target: { id: number; inFrame: number; outFrame: number },
): Clip[] {
  const same = existing
    .filter((s) => s.id !== target.id)
    .sort((a, b) => a.inFrame - b.inFrame);

  // Push-right pass.
  let cursor = target.outFrame;
  let pushedRight = false;
  const rightResult: Clip[] = [];
  for (const s of same) {
    if (s.inFrame >= target.inFrame) {
      // Locked clips don't get pushed — they're walls. Keep the clip in
      // place and advance the cursor past it so later clips pile up
      // after it instead of overlapping.
      if (s.locked || s.state === 'locked') {
        rightResult.push(s);
        cursor = Math.max(cursor, s.outFrame);
      } else if (s.inFrame < cursor) {
        const dur = s.outFrame - s.inFrame;
        const shifted: Clip = { ...s, inFrame: cursor, outFrame: cursor + dur };
        rightResult.push(shifted);
        cursor = shifted.outFrame;
        pushedRight = true;
      } else {
        rightResult.push(s);
        cursor = s.outFrame;
      }
    } else {
      rightResult.push(s);
    }
  }
  if (pushedRight) return rightResult;

  // Push-left pass (only if push-right was a no-op). Cursor tracks
  // the outFrame the next earlier clip can land on.
  let leftCursor = target.inFrame;
  const leftResult: Clip[] = [];
  // Iterate earlier-to-later for stable result order; do the left-push
  // logic by walking the same list in reverse, then re-sort at end.
  const reversed = [...same].sort((a, b) => b.inFrame - a.inFrame);
  const leftShifted: Clip[] = [];
  for (const s of reversed) {
    if (s.outFrame <= target.outFrame) {
      // Locked clips are walls here too — never shift one left.
      if (s.locked || s.state === 'locked') {
        leftShifted.push(s);
        leftCursor = Math.min(leftCursor, s.inFrame);
      } else if (s.outFrame > leftCursor) {
        const dur = s.outFrame - s.inFrame;
        const newOut = leftCursor;
        const newIn = Math.max(0, newOut - dur);
        leftShifted.push({ ...s, inFrame: newIn, outFrame: newOut });
        leftCursor = newIn;
      } else {
        leftShifted.push(s);
        leftCursor = s.inFrame;
      }
    } else {
      leftShifted.push(s);
    }
  }
  // Re-sort to original-style order (inFrame ascending).
  leftShifted.sort((a, b) => a.inFrame - b.inFrame);
  for (const s of leftShifted) leftResult.push(s);
  return leftResult;
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
    // A locked clip is an immovable wall: never trim or drop it. Callers
    // clamp the incoming target against locked clips before we get here
    // (see placeAvoidingLocked / lockedResizeBound), so this should not
    // even overlap — but if it somehow does, preserve the lock intact
    // rather than destroy it.
    if (s.locked || s.state === 'locked') { out.push(s); continue; }
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

/** Locked clips are immovable walls — a moving clip (fixed duration) may
 *  butt up against one but never cross into it (which would otherwise let
 *  replaceOverlap trim/delete the lock, or ripple shove it). Clamp the
 *  clip's desired left edge so [in, in+dur) lands in a gap BETWEEN locked
 *  clips (and at/after `floor` = docMin). The moving clip is excluded by
 *  id; unlocked clips are ignored here (they get overwritten as usual).
 *
 *  Returns the clamped inFrame, or null when no gap is wide enough to
 *  hold the clip without crossing a lock — the caller treats null as a
 *  blocked move (no-op). Works for same-track and cross-track moves: the
 *  "nearest fitting gap" pick gives the solid-wall feel (the clip butts
 *  against whichever locked edge is closer to where it was dropped). */
export function placeAvoidingLocked(
  existing: Clip[],
  movingId: number,
  desiredIn: number,
  duration: number,
  floor: number,
): number | null {
  const dur = Math.max(1, duration);
  const locked = existing
    .filter((c) => c.id !== movingId && (c.locked || c.state === 'locked'))
    .sort((a, b) => a.inFrame - b.inFrame);
  if (!locked.length) return Math.max(floor, desiredIn);

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = -Infinity;
  for (const L of locked) {
    gaps.push({ start: cursor, end: L.inFrame });
    cursor = L.outFrame;
  }
  gaps.push({ start: cursor, end: Infinity });

  const desiredOut = desiredIn + dur;
  // Already clear of every wall → keep the desired position.
  for (const g of gaps) {
    if (desiredIn >= g.start && desiredOut <= g.end) return Math.max(floor, desiredIn);
  }
  // Otherwise drop into the nearest gap wide enough to hold the clip.
  let best: number | null = null;
  let bestDist = Infinity;
  for (const g of gaps) {
    const lo = Math.max(g.start, floor);
    const hi = g.end - dur;
    if (hi < lo) continue;                 // gap too small for this clip
    const clamped = Math.max(lo, Math.min(hi, desiredIn));
    const dist = Math.abs(clamped - desiredIn);
    if (dist < bestDist) { bestDist = dist; best = clamped; }
  }
  return best;
}

/** Boundary a resize edge can't cross because a locked clip sits beyond
 *  it on the same track. Right edge: the nearest locked clip's inFrame to
 *  the right (the max allowed outFrame), or +Infinity if none. Left edge:
 *  the nearest locked clip's outFrame to the left (the min allowed
 *  inFrame), or -Infinity if none. The resizing clip is excluded by id.
 *  Only growth is constrained — shrinking never crosses a wall. */
export function lockedResizeBound(
  existing: Clip[],
  movingId: number,
  clip: { inFrame: number; outFrame: number },
  edge: 'left' | 'right',
): number {
  const locked = existing.filter(
    (c) => c.id !== movingId && (c.locked || c.state === 'locked'));
  if (edge === 'right') {
    let bound = Infinity;
    for (const L of locked) if (L.inFrame >= clip.inFrame) bound = Math.min(bound, L.inFrame);
    return bound;
  }
  let bound = -Infinity;
  for (const L of locked) if (L.outFrame <= clip.outFrame) bound = Math.max(bound, L.outFrame);
  return bound;
}

/** Collect every detected audio peak as a DOC-FRAME position, across
 *  all audio clips. A peak stored in media-space audio samples maps to
 *  a doc frame via:
 *    docFrame = clip.inFrame + (peakSample/sr*fps - mediaOffsetFrames)
 *  Peaks falling outside the clip's visible [inFrame, outFrame] window
 *  are dropped — a trimmed-away transient is not a valid snap target.
 *  Used as extra snap edit-points for body/trim/roll drags. */
export function audioPeakDocFrames(state: AudioLinesStateLike): number[] {
  const out: number[] = [];
  const fps = state.fps > 0 ? state.fps : 30;
  for (const t of state.audioTracks) {
    for (const c of t.clips) {
      const peaks = c.audioPeaks;
      const sr = c.audioPeaksSampleRate;
      if (!peaks || !peaks.length || !sr || sr <= 0) continue;
      const offset = c.mediaOffsetFrames ?? 0;
      const fpr = fps / sr;
      for (let i = 0; i < peaks.length; i++) {
        const docFrame = c.inFrame + (peaks[i] * fpr - offset);
        if (docFrame >= c.inFrame && docFrame <= c.outFrame) {
          out.push(docFrame);
        }
      }
    }
  }
  return out;
}

/** Union of every video clip's camera keyframe times (DOC frames),
 *  deduped, as extra magnetic-snap edit points. Mirrors the
 *  "everything snaps to everything" spirit of clip-edge snapping: a
 *  clip edge / the playhead can latch onto ANY visible camera's
 *  keyframe dot, not just its own. Deduped because multiple clips can
 *  share one camera (and each camera's keys are already capped at 200
 *  in C++ `GatherKeyTimes`). Used as extra editPoints by body / trim /
 *  roll / playhead drags, behind the same snap gate as beats/markers. */
export function cameraKeyframeSnapFrames(state: CameraKeysStateLike): number[] {
  const seen = new Set<number>();
  for (const t of state.videoTracks) {
    for (const c of t.clips) {
      if (c.objectId <= 0) continue;
      const keys = state.cameraKeyTimes.get(c.objectId);
      if (!keys) continue;
      for (const f of keys) seen.add(f);
    }
  }
  return Array.from(seen);
}

/** Like `audioPeakDocFrames`, but tags each beat as a BAR downbeat
 *  (every 4th beat, 4/4 assumption) or an interim beat. Used by the
 *  BeatGrid overlay to draw the FCP-style two-tier grid: solid lines
 *  for bars, dashed for interim beats. Bar parity uses the grid's
 *  `barOffset` so the downbeats stay locked to the tracked beat 0.
 *
 *  `inFrameOverride` lets a caller substitute a clip's live position
 *  for its committed `inFrame` — used while a clip is being dragged
 *  (it moves via CSS transform, no store commit) so its beat lines
 *  travel with it instead of jumping on release. */
export function audioBeatLines(
  state: AudioLinesStateLike,
  inFrameOverride?: Map<number, number>,
): { frame: number; isBar: boolean }[] {
  const out: { frame: number; isBar: boolean }[] = [];
  const fps = state.fps > 0 ? state.fps : 30;
  for (const t of state.audioTracks) {
    for (const c of t.clips) {
      const peaks = c.audioPeaks;
      const sr = c.audioPeaksSampleRate;
      if (!peaks || !peaks.length || !sr || sr <= 0) continue;
      const inFrame = inFrameOverride?.get(c.id) ?? c.inFrame;
      const outFrame = inFrame + (c.outFrame - c.inFrame);
      const offset = c.mediaOffsetFrames ?? 0;
      const barOffset = c.audioBeatGrid?.barOffset ?? 0;
      const fpr = fps / sr;
      for (let i = 0; i < peaks.length; i++) {
        const docFrame = inFrame + (peaks[i] * fpr - offset);
        if (docFrame >= inFrame && docFrame <= outFrame) {
          out.push({ frame: docFrame, isBar: (i - barOffset) % 4 === 0 });
        }
      }
    }
  }
  return out;
}

/** Song-part boundary positions as DOC frames, across all audio
 *  clips. The FCP "heavy line" tier — big structural transitions.
 *  Same media-space→doc-frame mapping as the beats. `inFrameOverride`
 *  substitutes a clip's live drag position (see `audioBeatLines`). */
export function audioSongPartLines(
  state: AudioLinesStateLike,
  inFrameOverride?: Map<number, number>,
): number[] {
  const out: number[] = [];
  const fps = state.fps > 0 ? state.fps : 30;
  for (const t of state.audioTracks) {
    for (const c of t.clips) {
      const parts = c.audioSongParts;
      const sr = c.audioPeaksSampleRate;
      if (!parts || !parts.length || !sr || sr <= 0) continue;
      const inFrame = inFrameOverride?.get(c.id) ?? c.inFrame;
      const outFrame = inFrame + (c.outFrame - c.inFrame);
      const offset = c.mediaOffsetFrames ?? 0;
      const fpr = fps / sr;
      for (let i = 0; i < parts.length; i++) {
        const docFrame = inFrame + (parts[i] * fpr - offset);
        if (docFrame >= inFrame && docFrame <= outFrame) {
          out.push(docFrame);
        }
      }
    }
  }
  return out;
}

/** Pure version of isTrackLocked. Whether the track named by `trackId`
 *  ('V2' / 'A1' style) is locked. Unknown trackId → false. The store's
 *  public `isTrackLocked` wraps this against `useStore.getState()`. */
export function isTrackLockedIn(trackId: string, state: TracksStateLike): boolean {
  const side = trackId.startsWith('V') ? 'video'
    : trackId.startsWith('A') ? 'audio' : null;
  if (!side) return false;
  const num = parseInt(trackId.slice(1), 10);
  const tracks = side === 'video' ? state.videoTracks : state.audioTracks;
  return tracks.some((t) => t.id === num && t.locked);
}

/** Encode a keyframe-column selection key. The selectedKeyColumns Set
 *  holds these strings; a column is (camera objectId, document frame). */
export function keyColKey(objectId: number, frame: number): string {
  return objectId + ':' + frame;
}
/** Decode a keyframe-column key back to {objectId, frame}. */
export function parseKeyCol(key: string): { objectId: number; frame: number } {
  const i = key.indexOf(':');
  return { objectId: parseInt(key.slice(0, i), 10), frame: parseInt(key.slice(i + 1), 10) };
}
