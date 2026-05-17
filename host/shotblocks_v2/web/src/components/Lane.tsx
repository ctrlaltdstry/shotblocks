import { useRef } from 'react';
import { useStore } from '../store';
import type { Track } from '../store';
import { ShotBlock } from './ShotBlock';
import { useElementSize } from '../useElementSize';

/** A single lane row. Renders its clips using the Figma-spec
 *  <ShotBlock>, picking the thin layout when the lane is short. */
const THIN_THRESHOLD_PX = 32;

export function Lane({ track, side }: { track: Track; side: 'video' | 'audio' }) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const { height: laneHeight } = useElementSize(laneRef);
  const h = useStore((s) => s.h);
  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const thin = laneHeight > 0 && laneHeight < THIN_THRESHOLD_PX;
  const trackId = (side === 'video' ? 'V' : 'A') + track.id;

  return (
    <div
      ref={laneRef}
      className="lane"
      data-track={trackId}
      data-side={side}
    >
      {track.clips.map((clip) => {
        const lanePctLeft = ((clip.inFrame - h.vMin) / visibleSpan) * 100;
        const lanePctWidth = ((clip.outFrame - clip.inFrame) / visibleSpan) * 100;
        return (
          <ShotBlock
            key={clip.id}
            clip={clip}
            side={side}
            thin={thin}
            style={{ left: lanePctLeft + '%', width: `max(2px, ${lanePctWidth}%)` }}
          />
        );
      })}
    </div>
  );
}
