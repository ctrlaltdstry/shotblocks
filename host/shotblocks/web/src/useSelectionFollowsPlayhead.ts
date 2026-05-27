import { useEffect, useRef } from 'react';
import { useStore } from './store';
import { send } from './lib/host';
import { activeClipAt } from './useActiveClipRouter';

/** Plan 4 commit 5 — selection-follows-playhead.
 *
 *  Two parts:
 *    A. Timeline clip selection — always fires on the triggers.
 *    B. OM camera selection      — fires only when timeline dialog
 *       has focus (document.hasFocus() per R2 spike).
 *
 *  Triggers:
 *    - Playback stop (playing transitions true → false in setTick).
 *    - Scrub end (scrubFrame transitions non-null → null).
 *
 *  Never fires:
 *    - During live scrub (pointer still down, scrubFrame still set).
 *    - During continuous playback.
 *  Matches Python `_apply_selection_follows_playhead` flicker rule.
 *
 *  Gap handling:
 *    - Timeline: clears selection (port of Python).
 *    - OM: leave alone (friendlier; don't yank an unrelated selection).
 *
 *  Orphan clip:
 *    - Timeline: selects the orphan clip.
 *    - OM: skip the C++ round-trip (no live camera to select). */
export function useSelectionFollowsPlayhead(): void {
  // Track the previous values so we can detect the relevant transitions.
  const prevPlaying = useRef(false);
  const prevScrubFrame = useRef<number | null>(null);

  useEffect(() => {
    const unsub = useStore.subscribe((s) => {
      // Detect the two transitions of interest:
      const playbackJustStopped = prevPlaying.current && !s.playing;
      const scrubJustEnded = prevScrubFrame.current !== null && s.scrubFrame === null;
      prevPlaying.current = s.playing;
      prevScrubFrame.current = s.scrubFrame;
      if (!playbackJustStopped && !scrubJustEnded) return;

      // Use the COMMITTED frame (currentFrame) at the trigger moment.
      // scrubFrame is already null on scrub-end; for playback-stop the
      // last tick wrote currentFrame anyway.
      const frame = s.currentFrame;
      const active = activeClipAt(frame, s.videoTracks);

      // --- A. Timeline selection (always fires) ---
      if (active) {
        // setSelectedClip with one id replaces the selection — same
        // behavior as Python's `self._selected_ids = {clip.id}`.
        useStore.getState().setSelectedClip(active.clip.id);
      } else {
        // Gap → clear selection (port of Python).
        useStore.getState().setSelectedClip(null);
      }

      // --- B. OM selection (focus-gated) ---
      if (!document.hasFocus()) return;
      if (!active) return;  // gap: leave OM alone
      const objectId = active.clip.objectId | 0;
      if (objectId <= 0) return;  // orphan clip: skip OM
      // Skip if the camera is in our known-orphan set (camera deleted
      // mid-clip, BaseLink still present but resolves null).
      if (s.orphanObjectIds.has(objectId)) return;
      void send({ kind: 'select-in-om', objectId });
    });
    return unsub;
  }, []);
}
