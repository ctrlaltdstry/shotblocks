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
 *   3. JS adds a 72-frame clip on the active V-chip's track. Placement:
 *      at the playhead if that span is clear, otherwise flush against the
 *      colliding clip on whichever side has more open space. addClip's
 *      findFreeSlot is the final safety net.
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

    // Placement rule:
    //   1. Try the 72-frame span AT the playhead. If it's clear (no
    //      overlap with an existing clip on the target track), use it.
    //   2. If it overlaps, snap the new clip flush against the colliding
    //      clip on whichever side — left or right — has more open space.
    // addClip's findFreeSlot is still the final safety net (it nudges to
    // the nearest free spot if our computed frame somehow doesn't fit).
    const ph = Math.max(0, s.scrubFrame ?? s.currentFrame);
    const num = parseInt(targetTrackId.slice(1), 10);
    const track = s.videoTracks.find((t) => t.id === num);
    const clips = track ? [...track.clips].sort((a, b) => a.inFrame - b.inFrame) : [];
    const DUR = DEFAULT_CLIP_FRAMES;

    const overlaps = (inF: number) => {
      const outF = inF + DUR;
      return clips.some((c) => inF < c.outFrame && outF > c.inFrame);
    };

    let inFrame = ph;
    if (clips.length > 0 && overlaps(ph)) {
      // The clip the playhead sits over (or the nearest one the span hits).
      const hit = clips.find((c) => ph < c.outFrame && ph + DUR > c.inFrame) ?? clips[0];
      const hitIdx = clips.indexOf(hit);
      // Open space to the LEFT of `hit`: from the previous clip's end
      // (or doc start) up to hit.inFrame.
      const prev = clips[hitIdx - 1];
      const leftStart = prev ? prev.outFrame : 0;
      const leftSpace = hit.inFrame - leftStart;
      // Open space to the RIGHT of `hit`: from hit.outFrame up to the
      // next clip's start (or doc end).
      const next = clips[hitIdx + 1];
      const rightEnd = next ? next.inFrame : s.docFrames;
      const rightSpace = rightEnd - hit.outFrame;
      // Place flush on the side with more room. Ties go right.
      if (leftSpace > rightSpace) {
        inFrame = Math.max(leftStart, hit.inFrame - DUR);
      } else {
        inFrame = hit.outFrame;
      }
    }

    inFrame = Math.max(0, inFrame);
    // Clamp the clip end to doc end so we don't extend the doc. If
    // there's less than DEFAULT_CLIP_FRAMES of room remaining, the new
    // clip is shorter. (Doc must have at least 1 frame of room.)
    const maxOut = Math.max(inFrame + 1, s.docFrames);
    const outFrame = Math.min(inFrame + DUR, maxOut);

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
