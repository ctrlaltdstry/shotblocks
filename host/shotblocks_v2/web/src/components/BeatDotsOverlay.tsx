import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useElementSize } from '../useElementSize';
import { computeBeatGridLayout } from '../lib/beatGridLayout';

/** Beat-grid connector dots — drawn at the BOTTOM of the audio-lanes
 *  region, on each grid line where it meets the audio clips:
 *    - solid dot per (LOD-surviving) BAR line.
 *    - hollow ring per SONG-PART line (FCP-style — distinct from the
 *      bar dots).
 *
 *  Separate from BeatGrid because the LINES sit behind the clips
 *  (showing through the gutters) while the DOTS must sit ON TOP of
 *  the clips — a dot behind an opaque clip would be invisible. Both
 *  use `computeBeatGridLayout`, so dot X + LOD stride match the grid
 *  lines exactly: every dot sits on its line, none are orphaned.
 *
 *  Mounted as a high-z overlay inside the stage (after the lanes). */
export function BeatDotsOverlay() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(wrapRef);
  const visible = useStore((s) => s.beatGridVisible);
  // Subscribe so dots recompute on zoom / clip / detection change.
  const h = useStore((s) => s.h);
  const audioTracks = useStore((s) => s.audioTracks);
  const fps = useStore((s) => s.fps);
  void h; void audioTracks; void fps;

  // The dot positions are measured from the live audio-clip boxes.
  // Those boxes are NOT at their final size on first render — lane
  // heights settle a frame later via the vertical-zoom CSS vars — so
  // an initial measure places the dots wrong (floating above the
  // clip) until a zoom forces a re-render. A ResizeObserver on the
  // stage bumps this tick whenever any clip/lane resizes, forcing a
  // fresh measure once layout settles.
  const [, setTick] = useState(0);
  useEffect(() => {
    const stage = wrapRef.current?.parentElement;
    if (!stage) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(stage);
    for (const el of stage.querySelectorAll('.lane, .shot-block')) {
      ro.observe(el);
    }
    // One post-mount re-measure for the initial layout settle.
    const raf = requestAnimationFrame(() => setTick((t) => t + 1));
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [audioTracks]);

  if (!visible) return <div className="beat-dots-overlay" ref={wrapRef} />;

  const { barXs, songParts } = computeBeatGridLayout(useStore.getState(), width);

  // Each dot sits on the BOTTOM EDGE of whichever audio clip it falls
  // over — not the bottom of the whole audio-lanes region (that runs
  // to the foot of the timeline). Measure every audio clip's box; for
  // a dot's X, find the clip whose horizontal span contains it and
  // anchor the dot to that clip's bottom. A dot over no clip (a gap)
  // is dropped — there's nothing for it to connect to.
  const overlayEl = wrapRef.current;
  const clipBoxes: { left: number; right: number; bottom: number }[] = [];
  if (overlayEl) {
    const oR = overlayEl.getBoundingClientRect();
    const clips = document.querySelectorAll(
      '.lane[data-side="audio"] .shot-block');
    for (const el of clips) {
      const r = el.getBoundingClientRect();
      clipBoxes.push({
        left: r.left - oR.left,
        right: r.right - oR.left,
        bottom: r.bottom - oR.top,
      });
    }
  }
  /** Bottom-edge Y for a dot at overlay-x `x`, or null if no clip. */
  const dotY = (x: number): number | null => {
    for (const b of clipBoxes) {
      if (x >= b.left && x <= b.right) return b.bottom;
    }
    return null;
  };

  return (
    <div className="beat-dots-overlay" ref={wrapRef}>
      {barXs.map((x, i) => {
        const y = dotY(x);
        if (y == null) return null;
        return (
          <span
            key={'b' + i}
            className="beat-dot"
            style={{ left: x + 'px', top: y + 'px' }}
          />
        );
      })}
      {songParts.map((x, i) => {
        const y = dotY(x);
        if (y == null) return null;
        return (
          <span
            key={'sp' + i}
            className="beat-dot beat-dot--songpart"
            style={{ left: x + 'px', top: y + 'px' }}
          />
        );
      })}
    </div>
  );
}
