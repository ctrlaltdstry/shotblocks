import type { StateCreator } from 'zustand';
import type { State } from '../../store';
import { mintId } from '../../store';
import type { Clip, Track } from '../types';
import { TRACK_FLAG_DEFAULTS } from '../types';
import { MIN_CLIP_FRAMES } from '../constants';
import { findFreeSlot, rippleAround, replaceOverlap } from '../clipMath';

/** The timeline data slice — videoTracks / audioTracks, plus every
 *  action that mutates them. The bulk of the store lives here:
 *  clip placement (addClip), clip CRUD (moveClip, moveClips,
 *  resizeClip, slipClip, rollEdit, splitClip), track CRUD
 *  (deleteTrack, deleteEmptyTracks, setTrackFlag, setTrackName), and
 *  the peak-data patches (setClipPeaks, setClipAudioPeaks).
 *
 *  Cross-slice writes from this slice: splitClip clears
 *  selectedClipIds; deleteTrack prunes selectedClipIds of any clips
 *  on the deleted track. Both go through the shared root `set`. */
export interface TimelineSlice {
  videoTracks: Track[];
  audioTracks: Track[];

  /** ObjectIds whose C++-side BaseLink resolves to null — i.e. the
   *  source BaseObject was deleted from the OM. A clip whose
   *  objectId lives in this set is an orphan (its `clip.objectId > 0`
   *  but no live camera backs it). Pushed by C++ via the inbound
   *  `cameras` message on every EVMSG_CHANGE; derived in JS, never
   *  persisted to the helper. */
  orphanObjectIds: Set<number>;
  /** Update the orphan set from a C++ `cameras` push. `statuses` is
   *  the full snapshot for every objectId in C++'s _cameraLinks;
   *  ids absent from the snapshot are treated as not-orphan (the
   *  link no longer exists on the C++ side). */
  setCameraStatuses: (statuses: { id: number; alive: boolean }[]) => void;

  /** Audio media that couldn't be resolved — bytes missing from the
   *  C++ helper or the stored bytes failed to decode. An audio clip
   *  whose mediaId is in this set is an orphan (clip stays on the
   *  timeline; waveform doesn't render; playback is silent). Should
   *  be rare — audio bytes are embedded in the .c4d, so the only way
   *  to lose them is corruption or out-of-band helper edits. */
  orphanMediaIds: Set<number>;
  /** Mark a mediaId as orphan (or clear it). Called from the
   *  audio-fetch / decode pipeline when a media can't be loaded. */
  setAudioMediaOrphan: (mediaId: number, orphan: boolean) => void;

  addClip: (trackId: string, clip: Omit<Clip, 'id'>) => number | null;
  moveClip: (
    clipId: number,
    fromTrackId: string,
    toTrackId: string,
    newInFrame: number,
    snapFrames?: number,
    mode?: 'replace' | 'ripple',
  ) => { trackId: string; inFrame: number; outFrame: number } | null;
  moveClips: (
    clipIds: Set<number>,
    anchorClipId: number,
    anchorFromTrackId: string,
    anchorToTrackId: string,
    anchorNewInFrame: number,
  ) => boolean;
  resizeClip: (
    clipId: number,
    trackId: string,
    edge: 'left' | 'right',
    wantFrame: number,
    mode?: 'replace' | 'ripple',
  ) => { inFrame: number; outFrame: number } | null;
  slipClip: (
    clipId: number,
    trackId: string,
    wantOffset: number,
  ) => { mediaOffsetFrames: number } | null;
  rollEdit: (
    leftClipId: number,
    rightClipId: number,
    trackId: string,
    wantSeamFrame: number,
  ) => { seamFrame: number } | null;
  splitClip: (clipId: number, trackId: string, frame: number) => number | null;

  deleteTrack: (trackId: string) => boolean;
  deleteEmptyTracks: (side: 'video' | 'audio') => number;
  setTrackFlag: (
    trackId: string,
    flag: 'muted' | 'solo' | 'locked' | 'visible',
    value: boolean,
  ) => void;
  setTrackName: (trackId: string, name: string) => void;

  setClipPeaks: (
    clipId: number,
    peakLevels: { sps: number; b64: string }[],
    peakAbsMax: number,
  ) => void;

  /** Rebind an orphan video clip to a freshly OM-dropped camera. The
   *  old objectId's BaseLink stays on the C++ helper as cruft until
   *  the next save-state prune; the clip's new objectId / sourceName /
   *  sourceType drive the label + icon immediately. No-op if the clip
   *  doesn't exist. */
  relinkClipCamera: (
    clipId: number,
    objectId: number,
    sourceName: string,
    sourceType: number,
  ) => void;
  setClipAudioPeaks: (
    mediaId: number,
    audioPeaks: number[],
    audioPeaksSampleRate: number,
    audioBeatGrid: { periodSamples: number; phaseSamples: number; confidence: number; barOffset: number } | null,
    audioSongParts: number[],
  ) => void;
}

export const createTimelineSlice: StateCreator<State, [], [], TimelineSlice> = (set) => ({
  videoTracks: [{ id: 1, name: 'Video 1', clips: [], ...TRACK_FLAG_DEFAULTS }],
  audioTracks: [{ id: 1, name: 'Audio 1', clips: [], ...TRACK_FLAG_DEFAULTS }],

  orphanObjectIds: new Set<number>(),
  orphanMediaIds: new Set<number>(),
  setAudioMediaOrphan: (mediaId, orphan) => set((s) => {
    const has = s.orphanMediaIds.has(mediaId);
    if (orphan === has) return s;
    const next = new Set(s.orphanMediaIds);
    if (orphan) next.add(mediaId); else next.delete(mediaId);
    return { orphanMediaIds: next };
  }),
  setCameraStatuses: (statuses) => set((s) => {
    const next = new Set<number>();
    for (const st of statuses) {
      if (!st.alive) next.add(st.id);
    }
    // Reference-equality skip when the set hasn't changed (avoids
    // waking every ShotBlock subscriber on each EVMSG_CHANGE tick
    // when nothing flipped — most ticks are camera-stable).
    if (next.size === s.orphanObjectIds.size) {
      let same = true;
      for (const id of next) if (!s.orphanObjectIds.has(id)) { same = false; break; }
      if (same) return s;
    }
    return { orphanObjectIds: next };
  }),

  moveClip: (clipId, fromTrackId, toTrackId, newInFrame, snapFrames, mode = 'replace') => {
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
      // A locked track accepts neither outgoing nor incoming clips.
      if (tracks[fromIdx].locked) return s;
      const destTrack = tracks.find((t) => t.id === toNum);
      if (destTrack && destTrack.locked) return s;
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
        working = [...working, { id: toNum, name: (side === 'video' ? 'Video ' : 'Audio ') + toNum, clips: [], ...TRACK_FLAG_DEFAULTS }];
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
      // Ripple vs replace: ripple pushes neighbors aside, replace
      // trims/removes them. Cross-track move always uses replace on
      // the destination — there are no "neighbors to push" the moving
      // clip is leaving behind, and pushing dest-track neighbors out
      // would feel surprising when the user just dropped the clip onto
      // an unrelated track. Same-track ripple is the meaningful case.
      const resolve = mode === 'ripple' ? rippleAround : replaceOverlap;
      const next = working.map((t, i) => {
        if (i === fromIdxNew && i === toIdxNew) {
          const others = t.clips.filter((c) => c.id !== clipId);
          const after = resolve(others, { id: clipId, inFrame: placedIn, outFrame: placedOut });
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

      // Empty non-base tracks are kept (user-confirmed: empty tracks
      // are fine). Without this, dragging V2's sole clip up to spawn
      // V3 culled V2 mid-move, leaving [V1, V3] — confusing.

      result = { trackId: toTrackId, inFrame: placedIn, outFrame: placedOut };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  resizeClip: (clipId, trackId, edge, wantFrame, mode = 'replace') => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    let result: { inFrame: number; outFrame: number } | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const trackIdx = tracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      if (tracks[trackIdx].locked) return s;
      const clip = tracks[trackIdx].clips.find((c) => c.id === clipId);
      if (!clip) return s;
      let newIn = clip.inFrame;
      let newOut = clip.outFrame;
      // Audio clips are a fixed window onto their media — trimming
      // can only REVEAL media that exists, never stretch past it.
      // The visible window [mediaOffset, mediaOffset + clipDuration]
      // must stay inside [0, mediaDurationFrames]:
      //   - left edge can't move earlier than `mediaOffset` frames
      //     before the current head (that's media frame 0).
      //   - right edge can't move past the media's tail.
      let minIn = 0;
      let maxOut = Infinity;
      if (side === 'audio') {
        const mediaOffset = clip.mediaOffsetFrames ?? 0;
        const clipDur = clip.outFrame - clip.inFrame;
        const mediaDur = clip.mediaDurationFrames ?? clipDur;
        minIn = clip.inFrame - mediaOffset;
        maxOut = clip.inFrame - mediaOffset + mediaDur;
      }
      if (edge === 'left') {
        newIn = Math.max(minIn,
          Math.max(0, Math.min(wantFrame, clip.outFrame - MIN_CLIP_FRAMES)));
      } else {
        newOut = Math.min(maxOut,
          Math.max(clip.inFrame + MIN_CLIP_FRAMES, wantFrame));
      }
      if (newIn === clip.inFrame && newOut === clip.outFrame) {
        result = { inFrame: newIn, outFrame: newOut };
        return s;
      }
      const target = { id: clipId, inFrame: newIn, outFrame: newOut };
      const resized: Clip = { ...clip, inFrame: newIn, outFrame: newOut };
      // Media-window (audio only): a left-edge trim slides the
      // window's head into the media by the same delta inFrame moved,
      // so the waveform under the clip stays put — we just reveal
      // less / more of the head. A right-edge trim only moves
      // outFrame; the window start is unchanged. We establish both
      // fields even if the parent lacked them (un-migrated old clip).
      if (side === 'audio') {
        const parentOffset = clip.mediaOffsetFrames ?? 0;
        resized.mediaDurationFrames = clip.mediaDurationFrames ?? (clip.outFrame - clip.inFrame);
        resized.mediaOffsetFrames = edge === 'left'
          ? parentOffset + (newIn - clip.inFrame)
          : parentOffset;
      }
      const resolve = mode === 'ripple' ? rippleAround : replaceOverlap;
      const next = tracks.map((t, i) => {
        if (i !== trackIdx) return t;
        const others = t.clips.filter((c) => c.id !== clipId);
        const after = resolve(others, target);
        return { ...t, clips: [...after, resized] };
      });
      result = { inFrame: newIn, outFrame: newOut };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  slipClip: (clipId, trackId, wantOffset) => {
    // Slip only applies to audio (it slides the media window). Video
    // clips have no media-window — bail.
    if (!trackId.startsWith('A')) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    let result: { mediaOffsetFrames: number } | null = null;
    set((s) => {
      const trackIdx = s.audioTracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      if (s.audioTracks[trackIdx].locked) return s;
      const clip = s.audioTracks[trackIdx].clips.find((c) => c.id === clipId);
      if (!clip) return s;
      if (clip.locked || clip.state === 'locked') return s;
      const clipDur = clip.outFrame - clip.inFrame;
      const mediaDur = clip.mediaDurationFrames ?? clipDur;
      // The window [offset, offset + clipDur] must stay inside the
      // media [0, mediaDur]. Clamp accordingly — a slip past either
      // end just stalls, mirroring Python's hard clamp
      // (sb_canvas_audio.py:1790-1793).
      const maxOffset = Math.max(0, mediaDur - clipDur);
      const clamped = Math.max(0, Math.min(maxOffset, Math.round(wantOffset)));
      if (clamped === (clip.mediaOffsetFrames ?? 0)) {
        result = { mediaOffsetFrames: clamped };
        return s;
      }
      const next = s.audioTracks.map((t, i) => {
        if (i !== trackIdx) return t;
        return {
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, mediaOffsetFrames: clamped } : c),
        };
      });
      result = { mediaOffsetFrames: clamped };
      return { audioTracks: next };
    });
    return result;
  },

  moveClips: (clipIds, anchorClipId, anchorFromTrackId, anchorToTrackId, anchorNewInFrame) => {
    const fromSide = anchorFromTrackId.startsWith('V') ? 'video' : anchorFromTrackId.startsWith('A') ? 'audio' : null;
    const toSide   = anchorToTrackId.startsWith('V')   ? 'video' : anchorToTrackId.startsWith('A')   ? 'audio' : null;
    if (!fromSide || !toSide || fromSide !== toSide) return false;
    const anchorSide = fromSide;
    const anchorFromNum = parseInt(anchorFromTrackId.slice(1), 10);
    const anchorToNum   = parseInt(anchorToTrackId.slice(1),   10);
    let ok = false;
    set((s) => {
      const anchorTracks = anchorSide === 'video' ? s.videoTracks : s.audioTracks;
      const otherTracks  = anchorSide === 'video' ? s.audioTracks : s.videoTracks;
      // Locate the anchor + gather every selected clip's current
      // (trackId, inFrame, outFrame). Separate by side so the
      // anchor-side clips can shift tracks (dtTrack) while other-side
      // clips ride horizontally only (NLE convention: a mixed V+A
      // selection moves together in time; vertical shift stays
      // within the side the user is dragging).
      type Loc = { id: number; trackNum: number; inFrame: number; outFrame: number };
      const anchorLocs: Loc[] = [];
      const otherLocs: Loc[] = [];
      let anchorLoc: Loc | null = null;
      for (const t of anchorTracks) {
        for (const c of t.clips) {
          if (!clipIds.has(c.id)) continue;
          const loc: Loc = { id: c.id, trackNum: t.id, inFrame: c.inFrame, outFrame: c.outFrame };
          anchorLocs.push(loc);
          if (c.id === anchorClipId) anchorLoc = loc;
        }
      }
      for (const t of otherTracks) {
        for (const c of t.clips) {
          if (!clipIds.has(c.id)) continue;
          otherLocs.push({ id: c.id, trackNum: t.id, inFrame: c.inFrame, outFrame: c.outFrame });
        }
      }
      if (!anchorLoc || anchorLocs.length + otherLocs.length === 0) return s;
      // Frame and track deltas inferred from the anchor's move.
      let dxFrames = anchorNewInFrame - anchorLoc.inFrame;
      const dtTrack = anchorToNum - anchorFromNum;
      // Block the whole group move if any selected clip sits on a
      // locked track or would land on one. Anchor-side clips track-
      // shift by dtTrack; other-side clips stay on their current track
      // (no vertical shift across sides), so only the current-track
      // lock matters for them.
      const anchorLockedIds = new Set(
        anchorTracks.filter((t) => t.locked).map((t) => t.id));
      const otherLockedIds = new Set(
        otherTracks.filter((t) => t.locked).map((t) => t.id));
      for (const loc of anchorLocs) {
        if (anchorLockedIds.has(loc.trackNum)) return s;
        if (anchorLockedIds.has(loc.trackNum + dtTrack)) return s;
      }
      for (const loc of otherLocs) {
        if (otherLockedIds.has(loc.trackNum)) return s;
      }
      // Clamp so no selected clip — on either side — goes below
      // frame 0.
      const allLocs = [...anchorLocs, ...otherLocs];
      const minIn = Math.min(...allLocs.map((l) => l.inFrame));
      if (minIn + dxFrames < 0) dxFrames = -minIn;
      if (dxFrames === 0 && dtTrack === 0) {
        ok = true;
        return s;
      }
      // Spawn destination tracks on the ANCHOR side if needed.
      // Other-side clips stay on existing tracks, so they don't
      // contribute target track numbers here.
      const targetTrackNums = new Set(anchorLocs.map((l) => l.trackNum + dtTrack));
      let workingAnchor = anchorTracks;
      const existingIds = new Set(workingAnchor.map((t) => t.id));
      const maxId = workingAnchor.reduce((m, t) => Math.max(m, t.id), 0);
      for (const num of targetTrackNums) {
        if (num < 1) return s;                    // can't go below V1/A1
        if (existingIds.has(num)) continue;
        if (num !== maxId + 1) return s;          // only one-step spawn allowed
        workingAnchor = [...workingAnchor, { id: num, name: (anchorSide === 'video' ? 'Video ' : 'Audio ') + num, clips: [], ...TRACK_FLAG_DEFAULTS }];
        existingIds.add(num);
      }
      // Build moved-clip lookup. Anchor-side gets dx + dt; other-side
      // gets dx only (newTrackNum === current).
      const movedById = new Map<number, { id: number; newTrackNum: number; inFrame: number; outFrame: number; side: 'anchor' | 'other' }>();
      for (const loc of anchorLocs) {
        movedById.set(loc.id, {
          id: loc.id,
          newTrackNum: loc.trackNum + dtTrack,
          inFrame: loc.inFrame + dxFrames,
          outFrame: loc.outFrame + dxFrames,
          side: 'anchor',
        });
      }
      for (const loc of otherLocs) {
        movedById.set(loc.id, {
          id: loc.id,
          newTrackNum: loc.trackNum,
          inFrame: loc.inFrame + dxFrames,
          outFrame: loc.outFrame + dxFrames,
          side: 'other',
        });
      }
      // Rebuild a single side's tracks:
      //  1. Remove every selected clip that originated here.
      //  2. Add selected clips whose destination is here.
      //  3. replaceOverlap with each new arrival against non-selected
      //     clips already on this track (selected clips don't collide
      //     with each other — rigid shift preserves their layout).
      const rebuildSide = (
        sideTracks: Track[],
        sideKind: 'anchor' | 'other',
        srcTracksForOrig: Track[],
      ): Track[] => sideTracks.map((t) => {
        const survivors = t.clips.filter((c) => !clipIds.has(c.id));
        const arrivals: Clip[] = [];
        for (const moved of movedById.values()) {
          if (moved.side !== sideKind) continue;
          if (moved.newTrackNum !== t.id) continue;
          let orig: Clip | undefined;
          for (const tt of srcTracksForOrig) {
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
      });
      const nextAnchor = rebuildSide(workingAnchor, 'anchor', anchorTracks);
      const nextOther  = otherLocs.length > 0
        ? rebuildSide(otherTracks, 'other', otherTracks)
        : otherTracks;
      // Empty tracks retained — explicit delete will come via a track-
      // header button (TBD).

      ok = true;
      if (anchorSide === 'video') {
        return { videoTracks: nextAnchor, audioTracks: nextOther };
      }
      return { videoTracks: nextOther, audioTracks: nextAnchor };
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
      if (tracks[trackIdx].locked) return s;
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
            // Left clip: only outFrame moves — its media-window head
            // is unchanged, so its waveform stays put.
            if (c.id === leftClipId)  return { ...c, outFrame: seam };
            if (c.id === rightClipId) {
              // Right clip: inFrame moves by `delta`. For audio, the
              // media-window head must slide by the SAME delta so the
              // waveform reveals a different slice instead of
              // rescaling (same rule as a left-edge trim).
              const next: typeof c = { ...c, inFrame: seam };
              if (side === 'audio') {
                const delta = seam - c.inFrame;
                next.mediaOffsetFrames = (c.mediaOffsetFrames ?? 0) + delta;
              }
              return next;
            }
            return c;
          }),
        };
      });
      result = { seamFrame: seam };
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return result;
  },

  splitClip: (clipId, trackId, frame) => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return null;
    const trackNum = parseInt(trackId.slice(1), 10);
    const f = Math.round(frame);
    let newRightId: number | null = null;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const trackIdx = tracks.findIndex((t) => t.id === trackNum);
      if (trackIdx < 0) return s;
      if (tracks[trackIdx].locked) return s;
      const clip = tracks[trackIdx].clips.find((c) => c.id === clipId);
      if (!clip) return s;
      // Locked clips don't accept structural edits.
      if (clip.locked || clip.state === 'locked') return s;
      // Reject splits that don't land strictly inside the clip OR
      // would produce a half shorter than MIN_CLIP_FRAMES. Mirrors
      // Python _split_shot (sb_shot_model.py:49-54), with v2's
      // exclusive outFrame: left = [inFrame, f), right = [f, outFrame).
      if (f <= clip.inFrame || f >= clip.outFrame) return s;
      if (f - clip.inFrame < MIN_CLIP_FRAMES) return s;
      if (clip.outFrame - f < MIN_CLIP_FRAMES) return s;
      const rightId = mintId();
      const left: Clip = { ...clip, outFrame: f };
      const right: Clip = { ...clip, id: rightId, inFrame: f };
      // Media-window: split is only meaningful for audio clips (they
      // carry a waveform). For audio, the left half keeps the
      // parent's window start; the right half's window starts
      // (f - inFrame) frames deeper into the media — so both halves
      // keep showing their original slice instead of rescaling.
      // We establish BOTH fields even when the parent lacks them
      // (un-migrated old clip): a never-edited clip's full span IS
      // its media span at offset 0. Video clips: left untouched.
      if (side === 'audio') {
        const parentOffset = clip.mediaOffsetFrames ?? 0;
        const parentMediaDur = clip.mediaDurationFrames ?? (clip.outFrame - clip.inFrame);
        left.mediaOffsetFrames = parentOffset;
        left.mediaDurationFrames = parentMediaDur;
        right.mediaOffsetFrames = parentOffset + (f - clip.inFrame);
        right.mediaDurationFrames = parentMediaDur;
      }
      const next = tracks.map((t, i) => {
        if (i !== trackIdx) return t;
        return {
          ...t,
          clips: t.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])),
        };
      });
      newRightId = rightId;
      // Cross-slice write: deselect after split — standard NLE
      // behavior; the user just broke focus on the original clip.
      return {
        ...(side === 'video' ? { videoTracks: next } : { audioTracks: next }),
        selectedClipIds: new Set<number>(),
      };
    });
    return newRightId;
  },

  deleteTrack: (trackId) => {
    const side = trackId.startsWith('V') ? 'video' : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return false;
    const trackNum = parseInt(trackId.slice(1), 10);
    const namePrefix = side === 'video' ? 'Video ' : 'Audio ';
    let ok = false;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      const target = tracks.find((t) => t.id === trackNum);
      if (!target) return s;
      // Drop selection of any clips that lived on the deleted track.
      const deletedClipIds = new Set<number>(target.clips.map((c) => c.id));
      let newSel = s.selectedClipIds;
      if (deletedClipIds.size && [...s.selectedClipIds].some((id) => deletedClipIds.has(id))) {
        newSel = new Set([...s.selectedClipIds].filter((id) => !deletedClipIds.has(id)));
      }
      // Drop the target, then renumber dense from id=1. Sort by old
      // id first so the relative order of surviving tracks is
      // preserved across the renumber.
      const remaining = tracks
        .filter((t) => t.id !== trackNum)
        .sort((a, b) => a.id - b.id);
      let next: Track[];
      if (remaining.length === 0) {
        // Auto-spawn an empty base track — the side must always have
        // somewhere to drop a clip.
        next = [{ id: 1, name: namePrefix + '1', clips: [], ...TRACK_FLAG_DEFAULTS }];
      } else {
        next = remaining.map((t, i) => ({
          ...t,
          id: i + 1,
          // Renumber regenerates the auto name only for tracks the
          // user hasn't renamed; a custom name is kept verbatim.
          name: t.nameIsCustom ? t.name : namePrefix + (i + 1),
        }));
      }
      ok = true;
      return {
        ...(side === 'video' ? { videoTracks: next } : { audioTracks: next }),
        selectedClipIds: newSel,
      };
    });
    return ok;
  },

  deleteEmptyTracks: (side) => {
    let removed = 0;
    set((s) => {
      const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
      // Drop every empty track, then RENUMBER the remaining ones
      // starting at 1 so clips end up on the lowest possible track
      // id (compact-all-gaps semantics). With nothing left, leave
      // the base track behind as an empty placeholder so the user
      // always has somewhere to drop a clip.
      //
      // Sort by current id so renumbering keeps relative order
      // (the lowest-id non-empty track stays nearest the V/A
      // splitter after compaction). Each renamed track's `name`
      // ("Video 3", "Audio 2", etc.) is regenerated to match the
      // new id; the display chip + label both read from this.
      const namePrefix = side === 'video' ? 'Video ' : 'Audio ';
      const occupied = tracks
        .filter((t) => t.clips.length > 0)
        .sort((a, b) => a.id - b.id);
      let next: Track[];
      if (occupied.length === 0) {
        // No clips anywhere on this side. Keep the lowest-id track as
        // the surviving base slot (preserving its flags + custom name)
        // rather than minting a fresh one.
        const base = [...tracks].sort((a, b) => a.id - b.id)[0];
        next = [{
          ...base,
          id: 1,
          name: base.nameIsCustom ? base.name : namePrefix + '1',
          clips: [],
        }];
      } else {
        next = occupied.map((t, i) => ({
          ...t,
          id: i + 1,
          // Auto name regenerates on renumber; a custom name is kept.
          name: t.nameIsCustom ? t.name : namePrefix + (i + 1),
        }));
      }
      removed = tracks.length - next.length;
      if (removed === 0) return s;
      return side === 'video' ? { videoTracks: next } : { audioTracks: next };
    });
    return removed;
  },

  setTrackFlag: (trackId, flag, value) => set((s) => {
    const side = trackId.startsWith('V') ? 'video'
      : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return s;
    const num = parseInt(trackId.slice(1), 10);
    const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
    if (!tracks.some((t) => t.id === num)) return s;
    const next = tracks.map((t) =>
      t.id === num ? { ...t, [flag]: value } : t);
    return side === 'video' ? { videoTracks: next } : { audioTracks: next };
  }),

  setTrackName: (trackId, name) => set((s) => {
    const side = trackId.startsWith('V') ? 'video'
      : trackId.startsWith('A') ? 'audio' : null;
    if (!side) return s;
    const num = parseInt(trackId.slice(1), 10);
    const tracks = side === 'video' ? s.videoTracks : s.audioTracks;
    if (!tracks.some((t) => t.id === num)) return s;
    const trimmed = name.trim();
    const next = tracks.map((t) => {
      if (t.id !== num) return t;
      if (trimmed === '') {
        // Empty name → revert to the default, clear the custom flag.
        const prefix = side === 'video' ? 'Video ' : 'Audio ';
        return { ...t, name: prefix + t.id, nameIsCustom: false };
      }
      return { ...t, name: trimmed, nameIsCustom: true };
    });
    return side === 'video' ? { videoTracks: next } : { audioTracks: next };
  }),

  setClipPeaks: (clipId, peakLevels, peakAbsMax) => {
    set((s) => {
      const patch = (tracks: Track[]) => tracks.map((t) => {
        if (!t.clips.some((c) => c.id === clipId)) return t;
        return {
          ...t,
          clips: t.clips.map((c) => c.id === clipId ? { ...c, peakLevels, peakAbsMax } : c),
        };
      });
      return {
        videoTracks: patch(s.videoTracks),
        audioTracks: patch(s.audioTracks),
      };
    });
  },

  relinkClipCamera: (clipId, objectId, sourceName, sourceType) => {
    set((s) => ({
      videoTracks: s.videoTracks.map((t) => {
        if (!t.clips.some((c) => c.id === clipId)) return t;
        return {
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, objectId, sourceName, sourceType } : c
          ),
        };
      }),
    }));
  },

  setClipAudioPeaks: (mediaId, audioPeaks, audioPeaksSampleRate, audioBeatGrid, audioSongParts) => {
    set((s) => {
      const patch = (tracks: Track[]) => tracks.map((t) => {
        if (!t.clips.some((c) => (c.mediaId ?? c.id) === mediaId)) return t;
        return {
          ...t,
          clips: t.clips.map((c) =>
            (c.mediaId ?? c.id) === mediaId
              ? { ...c, audioPeaks, audioPeaksSampleRate,
                  audioBeatGrid: audioBeatGrid ?? undefined,
                  audioSongParts }
              : c),
        };
      });
      return {
        videoTracks: patch(s.videoTracks),
        audioTracks: patch(s.audioTracks),
      };
    });
  },

  addClip: (trackId, clip) => {
    const id = mintId();
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
});
