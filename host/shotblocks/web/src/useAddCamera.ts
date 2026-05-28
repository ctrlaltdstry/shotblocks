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
 *   3. JS adds a clip on the active V-chip's track at the playhead, span
 *      72 frames (clamped to doc end). addClip's findFreeSlot resolves
 *      any overlap by snapping to the nearest free spot.
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

    // Place the new clip at the PLAYHEAD on the target track. If that
    // position overlaps an existing clip, addClip's findFreeSlot snaps it
    // to the nearest free spot. Use the optimistic scrub frame when a
    // scrub is in flight so it matches what the playhead shows.
    const inFrame = Math.max(0, s.scrubFrame ?? s.currentFrame);
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
