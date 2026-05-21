import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useElementSize } from '../useElementSize';
import { computeBeatGridLayout } from '../lib/beatGridLayout';

/** The detected beat grid — thin vertical lines spanning the stage,
 *  drawn BEHIND the clips (the connector dots that go ON TOP of the
 *  clips are children of the ShotBlock — see BeatDots).
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
  const dragClip = useStore((s) => s.dragClip);
  void h; void audioTracks; void fps;

  // While a clip is dragged it moves via CSS transform — no store
  // commit — so its committed `inFrame` is stale and its beat lines
  // would freeze until release. Re-render per frame for the duration
  // of the drag; the override below re-derives the dragged clip's
  // live position from its measured DOM rect each render.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!dragClip) return;
    let raf = 0;
    const loop = () => { setTick((t) => t + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [dragClip]);

  if (!visible) return <div className="beat-grid-overlay" ref={wrapRef} />;

  // Live-position override for the clip currently being dragged:
  // measure its DOM left edge and convert to a doc-frame so its beat
  // lines travel with it during the drag.
  let inFrameOverride: Map<number, number> | undefined;
  const overlayEl = wrapRef.current;
  if (dragClip && overlayEl && width > 0) {
    const clipEl = document.querySelector(
      `.shot-block[data-clip="${dragClip.clipId}"]`) as HTMLElement | null;
    if (clipEl) {
      const oR = overlayEl.getBoundingClientRect();
      const cR = clipEl.getBoundingClientRect();
      const visibleSpan = Math.max(1, h.vMax - h.vMin);
      const pxPerFrame = width / visibleSpan;
      const liveInFrame = h.vMin + (cR.left - oR.left) / pxPerFrame;
      inFrameOverride = new Map([[dragClip.clipId, liveInFrame]]);
    }
  }

  const { lines, songParts } = computeBeatGridLayout(
    useStore.getState(), width, inFrameOverride);

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
