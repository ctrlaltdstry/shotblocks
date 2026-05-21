import { useRef } from 'react';
import { useStore, audioBeatLines, audioSongPartLines } from '../store';
import { useElementSize } from '../useElementSize';

/** The detected beat grid, drawn as Final Cut Pro draws it: thin green
 *  vertical lines spanning the whole timeline height (ruler + every
 *  track), NOT painted onto the audio waveform.
 *
 *  Three tiers, matching FCP:
 *    - SONG PARTS — big structural transitions; heavy lines.
 *    - BAR downbeats (every 4th tracked beat) — solid lines.
 *    - interim beats — dashed fainter lines.
 *
 *  Shown only while `beatGridVisible` is on — the Beat Detection
 *  button toggles that flag. */
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

  return (
    <div className="beat-grid-overlay" ref={wrapRef}>
      {lines.map((ln, i) => {
        if (ln.frame < h.vMin || ln.frame > h.vMax) return null;
        const x = (ln.frame - h.vMin) * pxPerFrame;
        return (
          <div
            key={'b' + i}
            className={'beat-grid-line' + (ln.isBar ? ' is-bar' : '')}
            style={{ left: x + 'px' }}
          />
        );
      })}
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
