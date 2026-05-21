import { useRef } from 'react';
import { useStore, audioBeatLines, audioSongPartLines } from '../store';
import { useElementSize } from '../useElementSize';

// Level-of-detail — the minimum on-screen spacing (CSS px) a tier's
// lines must keep. Below it the tier thins: interim beats drop out
// entirely; bars decimate by powers of 2 (every 2nd, 4th, 8th …) so
// the grid keeps a comfortable gap at any zoom. Mirrors FCP.
const MIN_INTERIM_SPACING_PX = 9;
const MIN_BAR_SPACING_PX     = 22;

/** The detected beat grid, drawn as Final Cut Pro draws it: thin green
 *  vertical lines spanning the whole timeline height (ruler + every
 *  track), NOT painted onto the audio waveform.
 *
 *  Three tiers, matching FCP:
 *    - SONG PARTS — big structural transitions; heavy lines.
 *    - BAR downbeats (every 4th tracked beat) — solid lines.
 *    - interim beats — dashed fainter lines.
 *
 *  Level-of-detail: the finer tiers drop out as you zoom out so the
 *  grid never becomes a dense wall. Song parts always show; bars and
 *  interim beats appear only when there's enough pixel room between
 *  them. Shown only while `beatGridVisible` is on. */
export function BeatGrid() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { width } = useElementSize(wrapRef);
  const h = useStore((s) => s.h);
  const visible = useStore((s) => s.beatGridVisible);
  // Subscribe to the track arrays so the grid recomputes when audio
  // clips (and their detected peaks) change.
  const audioTracks = useStore((s) => s.audioTracks);
  const fps = useStore((s) => s.fps);

  if (!visible) return <div className="beat-grid-overlay" ref={wrapRef} />;

  // The collectors read the live state; audioTracks/fps in the deps
  // above are only here to retrigger the render.
  void audioTracks; void fps;
  const lines = audioBeatLines(useStore.getState());
  const songParts = audioSongPartLines(useStore.getState());

  const visibleSpan = Math.max(1, h.vMax - h.vMin);
  const pxPerFrame = width / visibleSpan;

  // On-screen spacing of one beat — drives the LOD gates. Measured
  // from the first two beat frames (beats are ~uniform).
  let beatSpacingPx = Infinity;
  if (lines.length >= 2) {
    beatSpacingPx = Math.abs(lines[1].frame - lines[0].frame) * pxPerFrame;
  }
  // Interim beats: shown only when their gap clears the threshold.
  const showInterim = beatSpacingPx >= MIN_INTERIM_SPACING_PX;
  // Bars: decimate by a power of 2 until the *displayed* bar gap
  // clears MIN_BAR_SPACING_PX. Bars are every 4th beat, so the base
  // bar spacing is 4x the beat spacing; barStride doubles (1,2,4,…)
  // until barSpacing*stride is comfortable. A bar shows when its
  // bar-index is a multiple of the stride.
  let barStride = 1;
  const baseBarSpacing = beatSpacingPx * 4;
  while (baseBarSpacing * barStride < MIN_BAR_SPACING_PX && barStride < 1024) {
    barStride *= 2;
  }

  return (
    <div className="beat-grid-overlay" ref={wrapRef}>
      {(() => {
        let barIndex = -1;
        return lines.map((ln, i) => {
          if (ln.isBar) barIndex++;
          if (ln.frame < h.vMin || ln.frame > h.vMax) return null;
          // LOD: interim beats drop out when dense; bars decimate by
          // barStride so only every Nth bar draws.
          if (ln.isBar) {
            if (barIndex % barStride !== 0) return null;
          } else if (!showInterim) {
            return null;
          }
          const x = (ln.frame - h.vMin) * pxPerFrame;
          return (
            <div
              key={'b' + i}
              className={'beat-grid-line' + (ln.isBar ? ' is-bar' : '')}
              style={{ left: x + 'px' }}
            />
          );
        });
      })()}
      {songParts.map((frame, i) => {
        if (frame < h.vMin || frame > h.vMax) return null;
        const x = (frame - h.vMin) * pxPerFrame;
        return (
          <div
            key={'sp' + i}
            className="beat-grid-line is-songpart"
            style={{ left: x + 'px' }}
          />
        );
      })}
    </div>
  );
}
