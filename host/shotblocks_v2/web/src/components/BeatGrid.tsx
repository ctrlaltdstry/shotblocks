import { useRef } from 'react';
import { useStore } from '../store';
import { useElementSize } from '../useElementSize';
import { computeBeatGridLayout } from '../lib/beatGridLayout';

/** The detected beat grid — thin green vertical lines spanning the
 *  stage, drawn BEHIND the clips (the connector dots that go ON TOP
 *  of the clips are a separate overlay, BeatDotsOverlay).
 *
 *  Three tiers, matching FCP:
 *    - SONG PARTS — big structural transitions; heavy lines.
 *    - BAR downbeats — solid lines.
 *    - interim beats — dashed fainter lines.
 *
 *  Level-of-detail thinning (see lib/beatGridLayout) keeps the grid
 *  from becoming a dense wall when zoomed out. Shown only while
 *  `beatGridVisible` is on. */
export function BeatGrid() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(wrapRef);
  const visible = useStore((s) => s.beatGridVisible);
  // Subscribe so the grid recomputes on zoom / clip / detection change.
  const h = useStore((s) => s.h);
  const audioTracks = useStore((s) => s.audioTracks);
  const fps = useStore((s) => s.fps);
  void h; void audioTracks; void fps;

  if (!visible) return <div className="beat-grid-overlay" ref={wrapRef} />;

  const { lines, songParts } = computeBeatGridLayout(useStore.getState(), width);

  return (
    <div className="beat-grid-overlay" ref={wrapRef}>
      {lines.map((ln, i) => (
        <div
          key={'b' + i}
          className={'beat-grid-line' + (ln.isBar ? ' is-bar' : '')}
          style={{ left: ln.x + 'px' }}
        />
      ))}
      {songParts.map((x, i) => (
        <div
          key={'sp' + i}
          className="beat-grid-line is-songpart"
          style={{ left: x + 'px' }}
        />
      ))}
    </div>
  );
}
