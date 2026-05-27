import { useCallback } from 'react';
import { useStore } from './store';
import { send } from './lib/host';

/** Plan 4 commit 2 — the click handler shared by the empty-state CTA
 *  and the persistent bottom-right Add Camera button.
 *
 *  Flow:
 *   1. JS sends create-camera with the user's defaultCameraType (per
 *      Settings → Defaults).
 *   2. C++ allocates the camera, copies editor cam pose + lens, inserts
 *      in OM at root top, selects it, returns { objectId, typeId, name }.
 *   3. JS adds a clip on V1 at playhead, span 72 frames (clamped to doc
 *      end). The targetTrackId is hardcoded to V1 for commit 2 — commit
 *      4 swaps in the active V-chip.
 *   4. The existing playhead-driven router (useActiveClipRouter) detects
 *      the new clip and fires set-active-camera, which switches the
 *      viewport via the SetParameter cache-invalidation recipe.
 *
 *  Undo: two steps (per R3). 1× Ctrl-Z removes the clip; 2× removes
 *  the camera + reverts OM selection + router routes back. */
const DEFAULT_CLIP_FRAMES = 72;

export function useAddCamera(): () => Promise<void> {
  return useCallback(async () => {
    const s = useStore.getState();
    const typeId = s.defaultCameraType;

    type Ack = { ok?: boolean; objectId?: number; typeId?: number; name?: string };
    let ack: Ack;
    try {
      ack = await send({ kind: 'create-camera', typeId }) as Ack;
    } catch {
      // Network error — silent. C++ couldn't be reached; nothing to do.
      return;
    }
    if (!ack || !ack.ok || !ack.objectId || !ack.name) return;

    // Target = the active V chip. Default V1 on fresh docs; user can
    // click another V chip to retarget. Chip is reconciled against
    // existing tracks on delete + load, so it always points at a real
    // track. (Plan-4 commit 4 wired this — commit 2 hardcoded V1.)
    const targetTrackId = s.activeVChip;

    // Append at the end of the target track — the rightmost edge of the
    // last clip, or frame 0 if the track is empty. Ignores the playhead
    // entirely; predictable per click, no overlap arithmetic. Three
    // clicks in a row produce three back-to-back cameras at the tail
    // (Mike's choice for plan-4 commit 2 click semantics).
    const num = parseInt(targetTrackId.slice(1), 10);
    const track = s.videoTracks.find((t) => t.id === num);
    let inFrame = 0;
    if (track && track.clips.length > 0) {
      // outFrame is exclusive; the next clip starts right where the
      // previous one ends. No gap inserted — clips touch edge-to-edge.
      inFrame = track.clips.reduce((m, c) => Math.max(m, c.outFrame), 0);
    }
    // Clamp the clip end to doc end so we don't extend the doc. If
    // there's less than DEFAULT_CLIP_FRAMES of room remaining, the new
    // clip is shorter. (Doc must have at least 1 frame of room.)
    const maxOut = Math.max(inFrame + 1, s.docFrames);
    const outFrame = Math.min(inFrame + DEFAULT_CLIP_FRAMES, maxOut);

    useStore.getState().addClip(targetTrackId, {
      inFrame,
      outFrame,
      sourceName: ack.name,
      sourceType: ack.typeId ?? typeId,
      objectId: ack.objectId,
      state: 'unselected',
      locked: false,
    });
  }, []);
}
