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
      if (s.inFrame < cursor) {
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
      if (s.outFrame > leftCursor) {
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
