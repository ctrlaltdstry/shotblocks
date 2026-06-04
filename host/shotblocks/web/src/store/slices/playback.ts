import type { StateCreator } from 'zustand';
import type { State } from '../../store';

/** Monotonic-ish wall clock for the scrub grace window. */
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** How long after a click/scrub-set to keep showing the optimistic
 *  scrubFrame during playback, so stale in-flight ticks from the old
 *  transport position don't flick the playhead before the resume lands. */
const SCRUB_GRACE_MS = 120;

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
  /** Wall-clock ms when scrubFrame was last set — drives the playback
   *  grace window in setTick. */
  scrubFrameAtMs: number;
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
  scrubFrameAtMs: 0,
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
    //
    // BUT during PLAYBACK the transport keeps advancing through (and
    // past) the seeked frame, so the echo never reports `=== scrubFrame`
    // — leaving scrubFrame stuck and the playhead frozen at it while
    // C4D plays on (the click-to-jump-during-playback desync bug). When
    // playing, a live transport makes the optimistic hold obsolete, so
    // clear it and let the playhead follow the live frame — EXCEPT for a
    // brief grace window right after the click: the old transport has one
    // or two in-flight ticks still reporting its pre-click position, and
    // clearing immediately would flick the playhead forward to that stale
    // frame before the re-anchored resume kicks in (the visible "jump
    // forward then back" blip). Holding scrubFrame for ~120ms lets those
    // stale ticks pass; by then the resume ticks reflect the clicked
    // frame and clearing is seamless.
    scrubFrame:
      s.scrubFrame === null ? null
      : playing
        ? (nowMs() - s.scrubFrameAtMs > SCRUB_GRACE_MS ? null : s.scrubFrame)
        : (frame === s.scrubFrame ? null : s.scrubFrame),
  })),

  setScrubFrame: (frame) => set({ scrubFrame: frame, scrubFrameAtMs: nowMs() }),

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
