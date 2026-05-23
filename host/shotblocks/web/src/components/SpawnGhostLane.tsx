import { useLayoutEffect, useState } from 'react';
import { useStore } from '../store';

/** Spawn-zone preview shown while dragging a clip into a track that
 *  doesn't exist yet. A subtle dashed outline appears one lane-height
 *  outside the outermost existing track on the relevant side, hinting
 *  that releasing the drag here will create that track.
 *
 *  Positioned by measuring the outermost lane (V<max> for video,
 *  A<max> for audio). Updates on every render driven by store changes;
 *  doesn't try to track scroll mid-render — fine for v1 since the
 *  drag itself fires pointermoves constantly. */
export function SpawnGhostLane() {
  const ghost = useStore((s) => s.spawnGhost);
  const videoTracks = useStore((s) => s.videoTracks);
  const audioTracks = useStore((s) => s.audioTracks);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (!ghost) { setBox(null); return; }
    // Pick the outermost lane on the relevant side.
    const tracks = ghost.side === 'video' ? videoTracks : audioTracks;
    if (!tracks.length) { setBox(null); return; }
    const maxId = tracks.reduce((m, t) => Math.max(m, t.id), 0);
    const lane = document.querySelector<HTMLElement>(`.lane[data-track="${ghost.side === 'video' ? 'V' : 'A'}${maxId}"]`);
    if (!lane) { setBox(null); return; }
    const r = lane.getBoundingClientRect();
    // For video the ghost sits ABOVE the outermost lane (V<max> is at
    // the top of the video stack); for audio it sits BELOW.
    const top = ghost.side === 'video' ? r.top - r.height : r.bottom;
    setBox({ left: r.left, top, width: r.width, height: r.height });
  }, [ghost, videoTracks, audioTracks]);

  if (!ghost || !box) return null;
  return (
    <div
      className="spawn-ghost-lane"
      style={{
        left: box.left + 'px',
        top: box.top + 'px',
        width: box.width + 'px',
        height: box.height + 'px',
      }}
    >
      <div className="spawn-ghost-lane__label">{ghost.trackId}</div>
    </div>
  );
}
