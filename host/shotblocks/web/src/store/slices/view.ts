import type { StateCreator } from 'zustand';
import type { State } from '../../store';
import type { ScrollWindow } from '../types';
import { HEADERS_MIN_W, HEADERS_MAX_W } from '../constants';

/** View / camera state — the visible windows over the timeline
 *  (horizontal h-time + per-side vertical), the V/A divider position,
 *  and the resizable track-headers column width. All purely about
 *  what's on screen; doesn't touch playback, clips, or selection. */
export interface ViewSlice {
  h: ScrollWindow;
  vVideo: ScrollWindow;
  vAudio: ScrollWindow;
  vaShare: number;
  headersWidth: number;

  setHVisible: (vMin: number, vMax: number) => void;
  setVVideoVisible: (vMin: number, vMax: number) => void;
  setVAudioVisible: (vMin: number, vMax: number) => void;
  setVaShare: (share: number) => void;
  setHeadersWidth: (w: number) => void;
}

export const createViewSlice: StateCreator<State, [], [], ViewSlice> = (set) => ({
  h:      { min: 0, max: 150, vMin: 0, vMax: 150 },
  // Vertical windows: range is 2× the track count so the default
  // (centered, span = trackCount) leaves equal headroom on each side
  // for zoom-out. With 1 track: range [0, 2], default [0.5, 1.5].
  vVideo: { min: 0, max: 2,   vMin: 0.5, vMax: 1.5 },
  vAudio: { min: 0, max: 2,   vMin: 0.5, vMax: 1.5 },
  vaShare: 0.5,
  headersWidth: HEADERS_MIN_W,

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

  setHeadersWidth: (w) => set({
    headersWidth: Math.max(HEADERS_MIN_W, Math.min(HEADERS_MAX_W, Math.round(w))),
  }),
});
