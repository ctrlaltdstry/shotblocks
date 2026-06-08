import type { StateCreator } from 'zustand';
import type { State } from '../../store';
import { mintId } from '../../store';
import type { Clip, ClipboardEntry, Track } from '../types';
import { replaceOverlap } from '../clipMath';

/** Selection / clipboard / cross-clip operations. Owns the selected
 *  clip set, marquee rectangle, drag-clip transient, edge-hover set,
 *  and the timeline-local clipboard. Cross-slice writes are common
 *  here: cut/paste/split/lockSelection all touch timeline-slice
 *  fields (videoTracks/audioTracks) via the shared `set` and the
 *  cross-slice `get`. */
export interface SelectionSlice {
  selectedClipIds: Set<number>;
  marquee: { x0: number; y0: number; x1: number; y1: number; mode?: 'clip' | 'keyframe' } | null;
  dragClip: { clipId: number; fromTrackId: string } | null;
  edgeHover: Set<string>;
  clipboard: ClipboardEntry[];

  setSelectedClip: (clipId: number | null, additive?: boolean) => void;
  setSelectedClipIds: (ids: Set<number>) => void;
  setMarquee: (rect: { x0: number; y0: number; x1: number; y1: number; mode?: 'clip' | 'keyframe' } | null) => void;
  setDragClip: (drag: { clipId: number; fromTrackId: string } | null) => void;
  setEdgeHover: (edges: Set<string>) => void;

  copyClips: (clipIds: Set<number>) => void;
  cutClips: (clipIds: Set<number>) => void;
  pasteClips: () => number[];
  toggleLockSelection: (clipIds: Set<number>) => void;
  splitSelectionAtPlayhead: (clipIds: Set<number>) => void;
}

export const createSelectionSlice: StateCreator<State, [], [], SelectionSlice> = (set, get) => ({
  selectedClipIds: new Set<number>(),
  marquee: null,
  dragClip: null,
  edgeHover: new Set<string>(),
  clipboard: [],

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
  setDragClip: (drag) => set({ dragClip: drag }),

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

  copyClips: (clipIds) => {
    if (clipIds.size === 0) return;
    const s = get();
    const entries: ClipboardEntry[] = [];
    const captureFromTracks = (tracks: Track[], side: 'V' | 'A') => {
      for (const t of tracks) {
        for (const c of t.clips) {
          if (!clipIds.has(c.id)) continue;
          // Strip id; paste mints fresh ones.
          const { id: _id, ...rest } = c;
          void _id;
          entries.push({ clip: rest, trackId: side + t.id });
        }
      }
    };
    captureFromTracks(s.videoTracks, 'V');
    captureFromTracks(s.audioTracks, 'A');
    set({ clipboard: entries });
  },

  cutClips: (clipIds) => {
    if (clipIds.size === 0) return;
    get().copyClips(clipIds);
    // Inline delete (same shape as useKeyboard.deleteSelection so we
    // don't depend on it). Empty non-base tracks get culled.
    set((s) => {
      const filterTrack = (t: Track) => ({
        ...t,
        clips: t.clips.filter((c) => !clipIds.has(c.id)),
      });
      return {
        videoTracks: s.videoTracks.map(filterTrack),
        audioTracks: s.audioTracks.map(filterTrack),
        selectedClipIds: new Set<number>(),
      };
    });
  },

  pasteClips: () => {
    const s = get();
    if (s.clipboard.length === 0) return [];
    // Anchor on the earliest inFrame across copied clips, so multi-
    // clip pastes preserve relative spacing with the earliest clip
    // landing AT the playhead.
    const anchor = s.clipboard.reduce(
      (m, e) => Math.min(m, e.clip.inFrame),
      Infinity,
    );
    if (!Number.isFinite(anchor)) return [];
    const playhead = s.scrubFrame ?? s.currentFrame;
    const delta = playhead - anchor;
    const newIds: number[] = [];

    // Group clipboard entries by destination track. The active V/A
    // chip is the write target for paste (plan-4 commit 4), so every
    // entry routes to activeVChip / activeAChip based on its side
    // regardless of where it was copied from. The chip is guaranteed
    // to point at an existing track (deleteTrack reconciles it), so
    // no further fallback needed.
    type Pending = { trackId: string; clip: Clip };
    const pending: Pending[] = [];
    for (const e of s.clipboard) {
      const side = e.trackId.startsWith('V') ? 'video' : 'audio';
      const destTrackId = side === 'video' ? s.activeVChip : s.activeAChip;
      const id = mintId();
      newIds.push(id);
      pending.push({
        trackId: destTrackId,
        clip: {
          ...e.clip,
          id,
          // Floor on the doc start (docMin; absolute frames, can be
          // negative — v2 mirrors C4D's ruler).
          inFrame: Math.max(s.docMin, e.clip.inFrame + delta),
          outFrame: Math.max(s.docMin + 1, e.clip.outFrame + delta),
        },
      });
    }

    // Apply replaceOverlap per destination track so existing clips
    // get trimmed/removed by the incoming pastes (same convention as
    // in-timeline drag / OM drop with the active "replace" mode).
    set((s2) => {
      const apply = (tracks: Track[], side: 'V' | 'A'): Track[] => {
        return tracks.map((t) => {
          const arrivals = pending
            .filter((p) => p.trackId === side + t.id)
            .map((p) => p.clip);
          if (arrivals.length === 0) return t;
          let combined = t.clips;
          for (const a of arrivals) {
            combined = replaceOverlap(combined, { id: a.id, inFrame: a.inFrame, outFrame: a.outFrame });
            combined = [...combined, a];
          }
          return { ...t, clips: combined };
        });
      };
      return {
        videoTracks: apply(s2.videoTracks, 'V'),
        audioTracks: apply(s2.audioTracks, 'A'),
        selectedClipIds: new Set<number>(newIds),
      };
    });
    return newIds;
  },

  toggleLockSelection: (clipIds) => {
    if (clipIds.size === 0) return;
    set((s) => {
      // If any selected clip is unlocked, lock all; otherwise unlock all.
      let anyUnlocked = false;
      for (const t of [...s.videoTracks, ...s.audioTracks]) {
        for (const c of t.clips) {
          if (clipIds.has(c.id) && !c.locked) { anyUnlocked = true; break; }
        }
        if (anyUnlocked) break;
      }
      const nextLocked = anyUnlocked;
      const apply = (t: Track): Track => ({
        ...t,
        clips: t.clips.map((c) => clipIds.has(c.id) ? { ...c, locked: nextLocked } : c),
      });
      return {
        videoTracks: s.videoTracks.map(apply),
        audioTracks: s.audioTracks.map(apply),
      };
    });
  },

  splitSelectionAtPlayhead: (clipIds) => {
    if (clipIds.size === 0) return;
    const s = get();
    const playhead = s.scrubFrame ?? s.currentFrame;
    // Capture a snapshot so we don't iterate while the store mutates;
    // splitClip rejects out-of-range frames silently per Python.
    const targets: Array<{ id: number; trackId: string }> = [];
    for (const t of s.videoTracks) {
      for (const c of t.clips) {
        if (clipIds.has(c.id) && c.inFrame < playhead && playhead < c.outFrame) {
          targets.push({ id: c.id, trackId: 'V' + t.id });
        }
      }
    }
    for (const t of s.audioTracks) {
      for (const c of t.clips) {
        if (clipIds.has(c.id) && c.inFrame < playhead && playhead < c.outFrame) {
          targets.push({ id: c.id, trackId: 'A' + t.id });
        }
      }
    }
    for (const tgt of targets) {
      get().splitClip(tgt.id, tgt.trackId, playhead);
    }
  },
});
