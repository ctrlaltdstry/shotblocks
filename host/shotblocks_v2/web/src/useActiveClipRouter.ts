import { useEffect, useRef } from 'react';
import { useStore, type Clip } from './store';
import { send } from './lib/host';

/** Resolve the "active shot" at a given frame: the highest-track-
 *  number clip whose [inFrame, outFrame) contains the frame. Tie-break
 *  by clip id (higher wins). Matches Python `_active_shot_at`
 *  (sb_shot_model.py:109).
 *
 *  Returns null when no clip covers the frame (gap). */
function activeClipAt(
  frame: number,
  videoTracks: { id: number; clips: Clip[] }[],
): { clip: Clip; trackId: number } | null {
  let best: { clip: Clip; trackId: number } | null = null;
  for (const t of videoTracks) {
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
 *  clips (gap or orphan), release the BaseDraw to its default editor
 *  camera. Audio-only clips never drive the viewport — only video
 *  tracks contribute to active-shot resolution.
 *
 *  Ports the v1 Python `_route_camera_for_frame`
 *  (sb_canvas_playback.py:268) into the v2 split-process world: JS
 *  decides "which clip is active", C++ resolves the objectId back to a
 *  BaseObject* and writes BASEDRAW_DATA_CAMERA. Dedupe is done here so
 *  we don't spam C++ when the frame ticks within the same clip. */
export function useActiveClipRouter(): void {
  const currentFrame = useStore((s) => s.scrubFrame ?? s.currentFrame);
  const videoTracks = useStore((s) => s.videoTracks);

  // Last objectId pushed to C++. Without this, the effect fires
  // `set-active-camera` on EVERY playback tick (currentFrame changes
  // each frame) — ~27 HTTP round-trips/sec that saturate the C++
  // main-thread dispatch and starve audio playback. Only send when
  // the active camera actually changes.
  const lastObjectId = useRef<number | null>(null);

  useEffect(() => {
    const active = activeClipAt(currentFrame, videoTracks);
    const objectId = active && active.clip.objectId > 0 ? active.clip.objectId : 0;
    if (objectId === lastObjectId.current) return;
    lastObjectId.current = objectId;
    void send({ kind: 'set-active-camera', objectId });
  }, [currentFrame, videoTracks]);
}
