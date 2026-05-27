import { useEffect, useRef } from 'react';
import { useStore, type Clip } from './store';
import { send } from './lib/host';

/** Resolve the "active shot" at a given frame: the highest-track-
 *  number clip whose [inFrame, outFrame) contains the frame. Tie-break
 *  by clip id (higher wins). Matches Python `_active_shot_at`
 *  (sb_shot_model.py:109).
 *
 *  Returns null when no clip covers the frame (gap). */
export function activeClipAt(
  frame: number,
  videoTracks: { id: number; clips: Clip[]; visible: boolean }[],
): { clip: Clip; trackId: number } | null {
  let best: { clip: Clip; trackId: number } | null = null;
  for (const t of videoTracks) {
    // An eye-off (hidden) track never wins camera routing — its clips
    // stay on the timeline but won't drive the C4D viewport camera.
    if (!t.visible) continue;
    for (const c of t.clips) {
      if (frame < c.inFrame || frame >= c.outFrame) continue;
      if (!best
          || t.id > best.trackId
          || (t.id === best.trackId && c.id > best.clip.id)) {
        best = { clip: c, trackId: t.id };
      }
    }
  }
  return best;
}

/** When the playhead enters a clip's range, route that clip's source
 *  camera into C4D's pinned BaseDraw. When the playhead leaves all
 *  clips (gap), release the BaseDraw to its default editor camera.
 *  Audio-only clips never drive the viewport — only video tracks
 *  contribute to active-shot resolution.
 *
 *  Orphan clips are treated identically to a gap: send objectId=0 so
 *  C++ releases the BaseDraw to the default editor camera. We send 0
 *  rather than the clip's stale objectId because C++'s dedupe (the
 *  prevCam == cam check) would otherwise see "no change" — the
 *  previous send for this clip already established `nullptr`, but
 *  if the user JUST deleted the camera mid-clip, C++ may still be
 *  pointing at the now-stale BaseObject*. Sending 0 makes the
 *  release explicit.
 *
 *  Ports the v1 Python `_route_camera_for_frame`
 *  (sb_canvas_playback.py:268) into the v2 split-process world: JS
 *  decides "which clip is active", C++ resolves the objectId back to a
 *  BaseObject* and writes BASEDRAW_DATA_CAMERA. Dedupe is done here so
 *  we don't spam C++ when the frame ticks within the same clip. */
export function useActiveClipRouter(): void {
  const currentFrame = useStore((s) => s.scrubFrame ?? s.currentFrame);
  const videoTracks = useStore((s) => s.videoTracks);
  // Subscribe so the effect re-fires when a camera is deleted /
  // restored mid-clip — without this, the objectId we send doesn't
  // change but the routing decision (orphan vs not) does.
  const orphanObjectIds = useStore((s) => s.orphanObjectIds);

  // Last objectId pushed to C++. Without this, the effect fires
  // `set-active-camera` on EVERY playback tick (currentFrame changes
  // each frame) — ~27 HTTP round-trips/sec that saturate the C++
  // main-thread dispatch and starve audio playback. Only send when
  // the active camera actually changes.
  const lastObjectId = useRef<number | null>(null);

  useEffect(() => {
    const active = activeClipAt(currentFrame, videoTracks);
    let objectId = 0;
    if (active && active.clip.objectId > 0
        && !orphanObjectIds.has(active.clip.objectId)) {
      objectId = active.clip.objectId;
    }
    if (objectId === lastObjectId.current) return;
    lastObjectId.current = objectId;
    void send({ kind: 'set-active-camera', objectId });
  }, [currentFrame, videoTracks, orphanObjectIds]);
}
