import type { StateCreator } from 'zustand';
import type { State } from '../../store';
import type { LevelInterp, LevelKeyframe, LevelTangent } from '../types';
import { LEVEL_DEFAULT_TANGENT, LEVEL_PRESET_TANGENTS } from '../types';
import { LEVEL_MERGE_AF } from '../constants';
import { patchAudioClip } from '../clipMath';

/** Pen-tool level-keyframe slice. Owns the per-node CRUD on the
 *  Clip.levelKeyframes list, the keyframe selection set, and the
 *  dragging flag the cursor system reads.
 *
 *  Cross-slice writes: every action here writes into `audioTracks`
 *  (timeline slice) via the `patchAudioClip` helper. That's fine —
 *  Zustand's `set` writes to the root, so any slice can mutate any
 *  field of State. The split is about *file colocation*, not data
 *  ownership. */
export interface LevelKfSlice {
  levelKfSelection: { clipId: number; indices: number[] } | null;
  levelCurveDragging: boolean;

  setLevelKfSelection: (sel: { clipId: number; indices: number[] } | null) => void;
  setLevelCurveDragging: (on: boolean) => void;

  addLevelKeyframe: (clipId: number, af: number, gain: number) => number | null;
  moveLevelKeyframe: (clipId: number, index: number, af: number, gain: number) => void;
  removeLevelKeyframe: (clipId: number, index: number) => void;
  removeLevelKeyframes: (clipId: number, indices: number[]) => void;
  moveLevelKeyframesBy: (clipId: number, indices: number[], dAf: number, dGain: number) => void;
  setLevelKeyframesInterp: (clipId: number, indices: number[], interp: LevelInterp) => void;
  setLevelKeyframeInterp: (clipId: number, index: number, interp: LevelInterp) => void;
  setLevelKeyframeTangent: (
    clipId: number, index: number, side: 'in' | 'out', tan: LevelTangent,
  ) => void;
}

export const createLevelKfSlice: StateCreator<State, [], [], LevelKfSlice> = (set) => ({
  levelKfSelection: null,
  levelCurveDragging: false,

  setLevelKfSelection: (sel) => set({ levelKfSelection: sel }),
  setLevelCurveDragging: (on) => set({ levelCurveDragging: on }),

  addLevelKeyframe: (clipId, af, gain) => {
    let idx: number | null = null;
    set((s) => {
      const next = patchAudioClip(s.audioTracks, clipId, (c) => {
        const kfs = [...(c.levelKeyframes ?? [])];
        const a = Math.round(af);
        const g = Math.max(0, Math.min(1, gain));
        // A click within MERGE_AF of an existing node moves that node
        // rather than adding a duplicate (Python's MERGE_AF_TOL = 8).
        const hit = kfs.findIndex((k) => Math.abs(k.af - a) <= LEVEL_MERGE_AF);
        if (hit >= 0) {
          kfs[hit] = { ...kfs[hit], af: a, gain: g };
          kfs.sort((p, q) => p.af - q.af);
          idx = kfs.findIndex((k) => k.af === a && k.gain === g);
          return { ...c, levelKeyframes: kfs };
        }
        // New nodes default to a smooth ease (horizontal tangents) —
        // a fresh segment curves gently rather than ramping linearly.
        const node: LevelKeyframe = {
          af: a, gain: g, interp: 'ease-in-out',
          inTan: { ...LEVEL_DEFAULT_TANGENT },
          outTan: { ...LEVEL_DEFAULT_TANGENT },
        };
        kfs.push(node);
        kfs.sort((p, q) => p.af - q.af);
        idx = kfs.indexOf(node);
        return { ...c, levelKeyframes: kfs };
      });
      return next ? { audioTracks: next } : s;
    });
    return idx;
  },

  moveLevelKeyframe: (clipId, index, af, gain) => set((s) => {
    const next = patchAudioClip(s.audioTracks, clipId, (c) => {
      const kfs = c.levelKeyframes;
      if (!kfs || index < 0 || index >= kfs.length) return c;
      // Clamp af strictly between the neighbours so nodes can't cross.
      const lo = index > 0 ? kfs[index - 1].af + 1 : -Infinity;
      const hi = index < kfs.length - 1 ? kfs[index + 1].af - 1 : Infinity;
      const a = Math.max(lo, Math.min(hi, Math.round(af)));
      const g = Math.max(0, Math.min(1, gain));
      const out = kfs.map((k, i) => i === index ? { ...k, af: a, gain: g } : k);
      return { ...c, levelKeyframes: out };
    });
    return next ? { audioTracks: next } : s;
  }),

  removeLevelKeyframe: (clipId, index) => set((s) => {
    const next = patchAudioClip(s.audioTracks, clipId, (c) => {
      const kfs = c.levelKeyframes;
      if (!kfs || index < 0 || index >= kfs.length) return c;
      return { ...c, levelKeyframes: kfs.filter((_, i) => i !== index) };
    });
    return next ? { audioTracks: next } : s;
  }),

  removeLevelKeyframes: (clipId, indices) => set((s) => {
    const drop = new Set(indices);
    const next = patchAudioClip(s.audioTracks, clipId, (c) => {
      const kfs = c.levelKeyframes;
      if (!kfs) return c;
      return { ...c, levelKeyframes: kfs.filter((_, i) => !drop.has(i)) };
    });
    return next ? { audioTracks: next } : s;
  }),

  moveLevelKeyframesBy: (clipId, indices, dAf, dGain) => set((s) => {
    const sel = new Set(indices);
    const next = patchAudioClip(s.audioTracks, clipId, (c) => {
      const kfs = c.levelKeyframes;
      if (!kfs || sel.size === 0) return c;
      const mediaDur = c.mediaDurationFrames ?? (c.outFrame - c.inFrame);
      // Clamp the af delta so no SELECTED node crosses an UN-selected
      // neighbour or leaves [0, mediaDur]. Walk every selected node
      // and tighten the delta to the most restrictive bound.
      let dA = Math.round(dAf);
      for (let i = 0; i < kfs.length; i++) {
        if (!sel.has(i)) continue;
        const prevFree = i > 0 && !sel.has(i - 1) ? kfs[i - 1].af + 1 : 0;
        const nextFree = i < kfs.length - 1 && !sel.has(i + 1)
          ? kfs[i + 1].af - 1 : mediaDur;
        dA = Math.max(prevFree - kfs[i].af, Math.min(nextFree - kfs[i].af, dA));
      }
      const out = kfs.map((k, i) => sel.has(i)
        ? {
            ...k,
            af: k.af + dA,
            gain: Math.max(0, Math.min(1, k.gain + dGain)),
          }
        : k);
      return { ...c, levelKeyframes: out };
    });
    return next ? { audioTracks: next } : s;
  }),

  setLevelKeyframesInterp: (clipId, indices, interp) => set((s) => {
    const sel = new Set(indices);
    const preset = LEVEL_PRESET_TANGENTS[interp];
    const next = patchAudioClip(s.audioTracks, clipId, (c) => {
      const kfs = c.levelKeyframes;
      if (!kfs) return c;
      const out = kfs.map((k, i) => {
        if (sel.has(i)) {
          return { ...k, interp, outTan: preset ? { ...preset.out } : k.outTan };
        }
        if (preset && sel.has(i - 1)) {
          return { ...k, inTan: { ...preset.nextIn } };
        }
        return k;
      });
      return { ...c, levelKeyframes: out };
    });
    return next ? { audioTracks: next } : s;
  }),

  setLevelKeyframeInterp: (clipId, index, interp) => set((s) => {
    const next = patchAudioClip(s.audioTracks, clipId, (c) => {
      const kfs = c.levelKeyframes;
      if (!kfs || index < 0 || index >= kfs.length) return c;
      // A named preset seeds this node's OUTGOING tangent + the next
      // node's INCOMING tangent (the preset shapes the whole segment).
      // 'hold' / 'custom' carry no preset tangents.
      const preset = LEVEL_PRESET_TANGENTS[interp];
      const out = kfs.map((k, i) => {
        if (i === index) {
          return {
            ...k,
            interp,
            outTan: preset ? { ...preset.out } : k.outTan,
          };
        }
        if (i === index + 1 && preset) {
          return { ...k, inTan: { ...preset.nextIn } };
        }
        return k;
      });
      return { ...c, levelKeyframes: out };
    });
    return next ? { audioTracks: next } : s;
  }),

  setLevelKeyframeTangent: (clipId, index, side, tan) => set((s) => {
    const next = patchAudioClip(s.audioTracks, clipId, (c) => {
      const kfs = c.levelKeyframes;
      if (!kfs || index < 0 || index >= kfs.length) return c;
      const out = kfs.map((k, i) => i === index
        ? {
            ...k,
            // Dragging a handle makes the node 'custom'.
            interp: 'custom' as const,
            ...(side === 'in' ? { inTan: tan } : { outTan: tan }),
          }
        : k);
      return { ...c, levelKeyframes: out };
    });
    return next ? { audioTracks: next } : s;
  }),
});
