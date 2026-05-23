import type { StateCreator } from 'zustand';
import type { State } from '../../store';

/** Playback transport state — fps, current frame, play range, loop,
 *  and the optimistic scrub override. The C++ side is the source of
 *  truth for fps / docFrames / currentFrame and pushes them via
 *  `tick` / `doc-info` messages; the rest (range, loop) is v2-owned
 *  (C4D 2026 doesn't expose the loop flag — see memory
 *  `no-c4d-cycle-api`). */
export interface PlaybackSlice {
  fps: number;
  docFrames: number;
  currentFrame: number;
  playing: boolean;
  playRangeIn: number;
  playRangeOut: number;
  loopEnabled: boolean;
  scrubFrame: number | null;
  c4dAudioFollows: boolean;

  setTick: (frame: number, fps: number, playing: boolean) => void;
  setDocInfo: (fps: number, docFrames: number, playRangeIn?: number, playRangeOut?: number) => void;
  setPlayRange: (inFrame: number, outFrame: number) => void;
  setLoopEnabled: (on: boolean) => void;
  setScrubFrame: (frame: number | null) => void;
  setC4dAudioFollows: (on: boolean) => void;
}

export const createPlaybackSlice: StateCreator<State, [], [], PlaybackSlice> = (set) => ({
  fps: 30,
  docFrames: 150,
  currentFrame: 0,
  playing: false,
  playRangeIn: 0,
  playRangeOut: 150,
  loopEnabled: false,
  scrubFrame: null,
  c4dAudioFollows: true,

  setTick: (frame, fps, playing) => set((s) => ({
    currentFrame: frame,
    fps: fps > 0 ? fps : s.fps,
    playing,
    // Drop the optimistic scrub override once C++'s tick echo has
    // caught up to the EXACT seeked frame. Clearing scrubFrame on
    // pointer-release instead (the old way) dropped it BEFORE the echo
    // arrived, so the playhead briefly fell back to the stale
    // currentFrame and jumped. Strict `===`, not `>=`: a backward
    // scrub leaves currentFrame ahead of scrubFrame, and `>=` would
    // clear instantly and jump the playhead back. During an active
    // scrub drag each move re-sets scrubFrame, so a transient clear
    // here is harmless. JS frameAt and C++ both clamp to the same
    // [0, docFrames] range, so the echo always hits the exact frame.
    scrubFrame: s.scrubFrame !== null && frame === s.scrubFrame ? null : s.scrubFrame,
  })),

  setScrubFrame: (frame) => set({ scrubFrame: frame }),

  // Cross-slice write: also fixes the h-window's max when docFrames
  // changes. Conceptually this is "C++ shipped new doc info; update
  // everything that depends on doc length" — h.max is one of those.
  setDocInfo: (fps, docFrames, playRangeIn, playRangeOut) => set((s) => {
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
    if (typeof playRangeIn === 'number')  next.playRangeIn  = playRangeIn;
    if (typeof playRangeOut === 'number') next.playRangeOut = playRangeOut;
    return next;
  }),

  setPlayRange: (inFrame, outFrame) => set({
    playRangeIn:  Math.max(0, Math.floor(inFrame)),
    playRangeOut: Math.max(Math.floor(inFrame) + 1, Math.floor(outFrame)),
  }),

  setLoopEnabled: (on) => set({ loopEnabled: on }),

  setC4dAudioFollows: (on) => set({ c4dAudioFollows: on }),
});
