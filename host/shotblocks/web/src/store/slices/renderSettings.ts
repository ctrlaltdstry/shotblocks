import type { StateCreator } from 'zustand';
import type { State } from '../../store';

/** Render mode — how shots get added to C4D's Render Queue when the
 *  user hits Add to Queue.
 *
 *  - `whole-sequence`: one queue entry for the whole .c4d doc as-is.
 *    C4D's Render Settings (range, camera, output) is the source of
 *    truth. No per-shot Takes; no overrides.
 *  - `individual-shots`: one Take + queue entry per non-orphan video
 *    clip. Each Take overrides the active camera + the master
 *    RenderData's frame range. Output naming uses C4D's existing
 *    `<take>` token if the user wants per-shot files. */
export type RenderMode = 'whole-sequence' | 'individual-shots';

/** Render workflow settings. Persisted alongside markers in the
 *  helper-BaseObject JSON. v1 ships with just `renderMode`; future
 *  additions land here. */
export interface RenderSettingsSlice {
  renderMode: RenderMode;
  setRenderMode: (mode: RenderMode) => void;
  /** Mirror of C++ state: master Render Settings has drifted from the
   *  Shotblocks_* clones since the last Add-to-Queue / Sync. C++ pushes
   *  on EVMSG_CHANGE; not persisted. */
  renderSettingsStale: boolean;
  setRenderSettingsStale: (stale: boolean) => void;
}

export const createRenderSettingsSlice: StateCreator<State, [], [], RenderSettingsSlice> = (set) => ({
  renderMode: 'individual-shots',
  setRenderMode: (mode) => set((s) => (
    s.renderMode === mode ? s : { renderMode: mode }
  )),
  renderSettingsStale: false,
  setRenderSettingsStale: (stale) => set((s) => (
    s.renderSettingsStale === stale ? s : { renderSettingsStale: stale }
  )),
});
