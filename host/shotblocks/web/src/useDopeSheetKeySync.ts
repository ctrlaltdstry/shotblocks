import { useEffect, useRef } from 'react';
import { useStore } from './store';
import { send } from './lib/host';

/** Keep the C4D Timeline / dope-sheet key highlight in sync with the
 *  TIMELINE's clip selection — so the camera you've selected in
 *  Shotblocks has its keyframes highlighted in the dope sheet, with no
 *  hunting. Driven by the clip selection (not the playhead), so a plain
 *  clip click highlights immediately; and when the selection goes empty
 *  (or lands on a gap / a non-camera / multiple clips), it CLEARS the
 *  highlight instead of leaving the last camera's keys stuck on.
 *
 *  Resolution rule: highlight only when exactly ONE clip is selected and
 *  it has a live (non-orphan) camera. Otherwise send objectId=0 to clear.
 *  Multi-select clears too — there's no single "the selected camera" then.
 *
 *  Deduped on the resolved objectId (like useActiveClipRouter) so we only
 *  round-trip to C++ when the highlighted camera actually changes. */
export function useDopeSheetKeySync(): void {
  const selectedClipIds = useStore((s) => s.selectedClipIds);
  const videoTracks = useStore((s) => s.videoTracks);
  const orphanObjectIds = useStore((s) => s.orphanObjectIds);

  // Last objectId pushed to C++ (0 = cleared). Avoids re-sending on every
  // unrelated store change.
  const lastSent = useRef<number | null>(null);

  useEffect(() => {
    let objectId = 0;
    if (selectedClipIds.size === 1) {
      const onlyId = selectedClipIds.values().next().value;
      outer: for (const t of videoTracks) {
        for (const c of t.clips) {
          if (c.id === onlyId) {
            if (c.objectId > 0 && !orphanObjectIds.has(c.objectId)) {
              objectId = c.objectId;
            }
            break outer;
          }
        }
      }
    }
    if (objectId === lastSent.current) return;
    lastSent.current = objectId;
    void send({ kind: 'sync-dope-keys', objectId });
  }, [selectedClipIds, videoTracks, orphanObjectIds]);
}
